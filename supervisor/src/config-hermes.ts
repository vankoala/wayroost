import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { SettingsTargets } from '../../shared/settings-targets.js';
import { readViewKeys, type ReadView } from '../../shared/settings-ops.js';
import { settingComparisonJson, settingValueSchema, type SettingValue } from '../../shared/settings.js';
import { ConfigError } from './config-paths.js';
import { trustedExecutable, type Trust } from './trust.js';

// The effective view is Hermes' own loader output. It fails closed when that loader raises or
// returns its failed-read marker; when the guard denied a write, connection or process during the
// read; on any stat or open error other than not-found (ENOENT, or ENOTDIR: a path through a file
// can't exist either); on an exception in Hermes' named config
// readers; and on a file whose YAML root is not a mapping. Errors Hermes itself catches below
// those boundaries (a stream read after a successful open, package metadata, secret-source worker
// threads) and a file vanishing between Hermes' own existence check and its read are Hermes'
// fail-open behaviour: the view then shows what Hermes computes, as a reload of Hermes would.
const resolverScript = `
import builtins, contextlib, io, json, os, re, stat, sys
from pathlib import Path
module_path, config_path, templates_json, comparisons_json = sys.argv[1:]
sys.path.insert(0, module_path)
blocked = False
loader_failed = False
observing = False
consumer = None
# Hermes reads "is it there?" through stat and treats errors as absence, or swallows read
# errors: any filesystem error other than not-found fails the view.
def observed(call):
    def wrapper(*args, **kwargs):
        global loader_failed
        try:
            return call(*args, **kwargs)
        except (FileNotFoundError, NotADirectoryError):
            raise
        except OSError:
            loader_failed = True
            raise
    return wrapper
os.stat, os.lstat, os.scandir, os.listdir = (observed(call) for call in (os.stat, os.lstat, os.scandir, os.listdir))
builtins.open = io.open = observed(io.open)
# Observe reader boundaries even when a caller catches their failures.
reader_names = {"load_hermes_dotenv", "_sanitize_env_file_if_needed", "load_env_file", "load_config", "load_config_readonly", "read_raw_config", "load_managed_config", "load_managed_env", "_cached_read", "safe_load", "fast_safe_load", "load_yaml_file_readonly", "_get_model_config", "_get_approval_mode", "_get_cron_approval_mode"}
reader_codes = set()
def observe_reader(frame, event, value):
    global loader_failed
    if event == "call" and frame.f_code.co_name == "_cached_read":
        code = getattr(frame.f_locals.get("parse"), "__code__", None)
        if code is not None:
            reader_codes.add(code)
    if frame.f_code.co_name not in reader_names and frame.f_code not in reader_codes:
        return None
    # Not-found is absence where Hermes probes for an optional file: its .env tokenizer (except in the
    # key scan Hermes runs only after finding the file) and the first stat of a managed file. Any other
    # error, or a file vanishing after it was found, is a failed read Hermes swallows.
    not_found = event == "exception" and issubclass(value[0], FileNotFoundError)
    absent = not_found and (
        (frame.f_code.co_name == "load_env_file"
         and (frame.f_back is None or frame.f_back.f_code.co_name != "_env_keys_defined_in_dotenv"))
        or (frame.f_code.co_name == "_cached_read" and value[2].tb_next is not None
            and value[2].tb_next.tb_frame.f_code.co_name == "stat"))
    if (event == "exception" and not absent) or (event == "return" and consumer is not None and isinstance(value, consumer.FailedConfigRead)):
        loader_failed = True
    if event == "return" and value is not None and not isinstance(value, dict):
        mapping_reader = frame.f_code.co_name in {"load_managed_config", "load_managed_env", "_cached_read"} or frame.f_code in reader_codes
        # A document read from a file must have a mapping root (empty is fine): Hermes' "or {}" would
        # otherwise turn [], "", 0 or false into defaults. Parsing a string value is not a file root.
        if frame.f_code.co_name == "load_yaml_file_readonly" or (frame.f_code.co_name in {"safe_load", "fast_safe_load"}
                and frame.f_code.co_argcount and hasattr(frame.f_locals.get(frame.f_code.co_varnames[0]), "read")):
            mapping_reader = True
        # Validate the YAML root before a managed callback replaces false values.
        if frame.f_code.co_name in {"safe_load", "fast_safe_load", "load_yaml_file_readonly"}:
            caller = frame.f_back
            while caller is not None:
                if caller.f_code in reader_codes or caller.f_code.co_name in {"load_managed_config", "_cached_read"}:
                    mapping_reader = True
                    break
                caller = caller.f_back
        if mapping_reader:
            loader_failed = True
    return observe_reader
sys.settrace(observe_reader)
def unchanged(event, args):
    # Hermes re-ensures its home on every load: creating a directory that exists, or setting
    # the mode a path already has, changes nothing, so it is let through.
    path, mode, dir_fd = args[:3]
    if dir_fd not in (None, -1) or not isinstance(path, (str, bytes, os.PathLike)):
        return False
    try:
        return os.path.isdir(path) if event == "os.mkdir" else stat.S_IMODE(os.stat(path).st_mode) == mode
    except OSError:
        return False
def readonly(event, args):
    global blocked
    if event in {"os.mkdir", "os.chmod"} and unchanged(event, args):
        return
    if event in {"subprocess.Popen", "os.system", "os.exec", "os.posix_spawn"} and not observing:
        # Denied, but only Hermes' modules are loading (its version probe); the read starts later.
        raise PermissionError("unavailable")
    if event == "socket.bind":
        # Denied without failing the view: a bind (urllib3's IPv6 probe) fetches nothing that is read.
        raise PermissionError("unavailable")
    if event == "open":
        mode, flags = args[1:]
        if (isinstance(mode, str) and any(char in mode for char in "wax+")) or (flags and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)):
            blocked = True
            raise PermissionError("unavailable")
        if isinstance(args[0], (str, bytes)) and Path(os.fsdecode(args[0])).name in {".env", "config.yaml"} and os.stat(args[0]).st_size > 1024 * 1024:
            blocked = True
            raise PermissionError("unavailable")
    if event in {"os.mkdir", "os.remove", "os.rename", "os.rmdir", "os.chmod", "os.chown", "os.link", "os.symlink", "os.truncate", "os.utime", "subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "socket.connect"}:
        blocked = True
        raise PermissionError("unavailable")
sys.addaudithook(readonly)
class Quiet:
    def write(self, value):
        return len(value)
    def flush(self):
        pass
with contextlib.redirect_stdout(Quiet()):
    # Suppress housekeeping only in this disposable read-only process. Hermes' config module
    # loads the config while it is imported, so the backup is replaced before that import.
    from hermes_cli import config_backups as backups
    if not callable(backups.backup_config):
        raise RuntimeError("unavailable")
    backups.backup_config = lambda *args, **kwargs: None
    from hermes_cli import config as consumer
    if not callable(consumer.ensure_hermes_home):
        raise RuntimeError("unavailable")
    consumer.ensure_hermes_home = lambda: None
    observing = True
    from hermes_cli.env_loader import load_hermes_dotenv
    load_hermes_dotenv(hermes_home=Path(config_path).parent, project_env=Path(module_path) / ".env")
    if Path(consumer.get_config_path()).resolve() != Path(config_path).resolve():
        raise RuntimeError("unavailable")
    config = consumer.load_config()
    print_error = isinstance(config, consumer.FailedConfigRead)
    if not print_error:
        if not isinstance(config, dict):
            raise RuntimeError("unavailable")
        config = dict(config)
        templates = json.loads(templates_json)
        if any(template[0] == "model" for template in templates):
            from hermes_cli.runtime_provider import _get_model_config
            config["model"] = _get_model_config()
            if not isinstance(config["model"], dict) or isinstance(config["model"], consumer.FailedConfigRead):
                raise RuntimeError("unavailable")
        if any(template[0] == "approvals" for template in templates):
            try:
                from tools import approval_context as approvals
            except ImportError:
                from tools import approval as approvals
            config["approvals"] = {"mode": approvals._get_approval_mode(), "cron_mode": approvals._get_cron_approval_mode()}
            if config["approvals"]["mode"] not in {"off", "smart", "manual"} or config["approvals"]["cron_mode"] not in {"approve", "deny"}:
                raise RuntimeError("unavailable")
sys.settrace(None)
if blocked or loader_failed or print_error:
    print(json.dumps({"ok": False, "code": "unavailable"}))
    sys.exit(0)
secret_words = {"key", "apikey", "token", "secret", "password", "passwd", "passphrase", "auth", "authorization", "bearer", "header", "headers", "cookie", "cookies", "credential", "credentials"}
def safe_key(key):
    words = re.sub(r"([a-z0-9])([A-Z])", r"\\1 \\2", str(key)).lower()
    return key != "__proto__" and not (set(re.split(r"[^a-z0-9]+", words)) & secret_words) and re.sub(r"[^a-z0-9]", "", words) not in secret_words
def scrub(value):
    if isinstance(value, dict):
        return {key: scrub(item) for key, item in value.items() if safe_key(key)}
    if isinstance(value, list):
        return [scrub(item) for item in value]
    return value
result = {}
comparisons = json.loads(comparisons_json)
def select(source, target, path):
    if not isinstance(source, dict) or not path:
        return
    keys = source.keys() if path[0] == "*" else [path[0]]
    for key in keys:
        if key not in source or not safe_key(key):
            continue
        if len(path) == 1:
            # Complete comparison entries stay inside the owner resolver until they are hashed.
            target[key] = source[key] if comparisons else scrub(source[key])
        else:
            child = target.setdefault(key, {})
            select(source[key], child, path[1:])
for template in json.loads(templates_json):
    select(config, result, template)
print(json.dumps({"ok": True, "document": result}, allow_nan=False))
`;

export type HermesResolverCommand = (python: string, args: string[], hermesHome: string, environment?: Record<string, string>, startupHome?: string) => Promise<string>;
const command: HermesResolverCommand = (python, args, hermesHome, environment, startupHome) => new Promise((resolve, reject) => {
  execFile(python, args, { timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, cwd: '/',
    env: { ...environment, PATH: '/usr/bin:/bin', HERMES_HOME: hermesHome, HOME: startupHome ?? homedir(), PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', LANG: 'C.UTF-8' } },
  (error, stdout) => error ? reject(new ConfigError('unavailable')) : resolve(stdout));
});

/** Called inside the owner's read-only, network-isolated config unit. */
export async function resolveHermesConfig(site: SettingsTargets, view: ReadView, run: HermesResolverCommand = command, trust: Trust = trustedExecutable): Promise<unknown> {
  const target = site.targets['hermes-config'];
  if (!target) throw new ConfigError('not_configured');
  const resolver = target.resolver;
  if (!resolver) throw new ConfigError('unavailable');
  try {
    const python = await trust(resolver.python);
    await trust(join(resolver.modulePath, 'hermes_cli/config.py'));
    const output = await run(python, ['-c', resolverScript, resolver.modulePath, target.path, JSON.stringify(view.keys), JSON.stringify(!!view.comparisonDigests)], dirname(target.path), { ...resolver.environment,
      ...(site.targets['hermes-managed'] ? { HERMES_MANAGED_DIR: dirname(site.targets['hermes-managed'].path) } : {}) }, resolver.home);
    if (Buffer.byteLength(output) > 1024 * 1024 || output.trim().split('\n').length !== 1) throw new Error();
    const response = z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), document: settingValueSchema }).strict(),
      z.object({ ok: z.literal(false), code: z.literal('unavailable') }).strict(),
    ]).parse(JSON.parse(output));
    if (!response.ok) throw new ConfigError(response.code);
    const document = response.document;
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error();
    if (view.comparisonDigests) for (const path of readViewKeys(view, document)) {
      let container: Record<string | number, SettingValue> = document;
      for (const segment of path.slice(0, -1)) {
        if (typeof segment === 'object') throw new Error();
        const next = container[segment];
        if (!next || typeof next !== 'object') throw new Error();
        container = next as Record<string | number, SettingValue>;
      }
      const key = path.at(-1)!;
      if (typeof key === 'object') throw new Error();
      if (!Object.hasOwn(container, key)) continue;
      const source = settingComparisonJson(container[key]!);
      container[key] = { sha256: createHash('sha256').update(source, 'utf8').digest('hex'), length: Buffer.byteLength(source) };
    }
    return document;
  } catch {
    throw new ConfigError('unavailable');
  }
}
