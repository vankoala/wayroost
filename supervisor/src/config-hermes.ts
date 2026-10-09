import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { SettingsTargets } from '../../shared/settings-targets.js';
import { readViewKeys, type ReadView } from '../../shared/settings-ops.js';
import { settingComparisonJson, settingValueSchema, type SettingValue } from '../../shared/settings.js';
import { ConfigError } from './config-paths.js';
import { trustedDirectory, trustedExecutable, trustedOwnerDirectory, trustedOwnerExecutable, type Trust } from './trust.js';

// The resolver runs as the target owner. Owner-owned interpreter and source paths require a
// private ancestor, without symlinks or foreign owners; writable directories below it are allowed.
// Code files cannot be world-writable; group writes require the owner's private group.
// Any group access also requires a successful check that the file has no access ACL.
// A root-run resolver keeps the root-only trust walk. This owner rule claims no isolation.
// The effective view is Hermes' own loader output. It fails closed when that loader raises or
// returns its failed-read marker; when the guard denied a write, connection or process during the
// read; on any stat or open error other than not-found (ENOENT, or ENOTDIR: a path through a file
// can't exist either); on an exception in Hermes' named config
// readers; and on a file whose YAML root is not a mapping. Errors Hermes itself catches below
// those boundaries (a stream read after a successful open, package metadata, secret-source worker
// threads) and a file vanishing between Hermes' own existence check and its read are Hermes'
// fail-open behaviour: the view then shows what Hermes computes, as a reload of Hermes would.
const resolverScript = `
import builtins, contextlib, io, json, os, re, stat, sys, unicodedata
from pathlib import Path
module_path, config_path, templates_json, comparisons_json = sys.argv[1:5]
venv_path, python_path, walked_site_packages = sys.argv[5:] if len(sys.argv) > 5 else ("", "", "")
sys.dont_write_bytecode = True
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
def existing_mkdir(value):
    if not issubclass(value[0], FileExistsError):
        return False
    trace = value[2]
    while trace is not None:
        frame = trace.tb_frame
        if frame.f_code is Path.mkdir.__code__ and frame.f_locals.get("exist_ok") is True:
            return frame.f_locals["self"].is_dir()
        trace = trace.tb_next
    return False
def observe_reader(frame, event, value):
    global loader_failed
    if event == "call" and frame.f_code.co_name == "_cached_read":
        code = getattr(frame.f_locals.get("parse"), "__code__", None)
        if code is not None:
            reader_codes.add(code)
    if frame.f_code.co_name not in reader_names and frame.f_code not in reader_codes:
        return None
    # pathlib catches EEXIST for exist_ok mkdir calls. Even a traced reader callback may
    # re-ensure an initialized directory; that exception is not a failed config read.
    if event == "exception" and existing_mkdir(value):
        return observe_reader
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
    if event in {"os.mkdir", "os.remove", "os.rename", "os.rmdir", "os.chmod", "os.chown", "os.link", "os.symlink", "os.truncate", "os.utime", "subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "socket.connect", "fcntl.flock", "fcntl.lockf"}:
        blocked = True
        raise PermissionError("unavailable")
sys.addaudithook(readonly)
class Quiet:
    def write(self, value):
        return len(value)
    def flush(self):
        pass
with contextlib.redirect_stdout(Quiet()):
    if venv_path:
        # Read only the specified environment. Never use Hermes' dependency activation:
        # it takes runtime locks, recovers publications and acquires a generation lease.
        def read_dependency(path, limit):
            global loader_failed
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(fd, "rb") as stream:
                    info = os.fstat(stream.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
                        raise RuntimeError("unavailable")
                    data = stream.read(limit + 1)
                if len(data) > limit:
                    raise RuntimeError("unavailable")
                return data
            except Exception:
                loader_failed = True
                raise
        data = read_dependency(Path(venv_path) / "pyvenv.cfg", 16384)
        fields = {}
        for line in data.decode("utf-8").split("\\n"):
            if any(unicodedata.category(char) in {"Cc", "Cf"} for char in line):
                raise RuntimeError("unavailable")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            key, separator, value = line.partition("=")
            key, value = key.strip(), value.strip()
            if not separator or key in fields:
                raise RuntimeError("unavailable")
            fields[key] = value
        version = re.fullmatch(r"([0-9]+)\\.([0-9]+)(?:\\.[0-9]+[a-zA-Z0-9.+-]*)?", fields.get("version_info", ""))
        if fields.get("home") != os.path.dirname(python_path) or version is None or tuple(map(int, version.group(1, 2))) != sys.version_info[:2]:
            raise RuntimeError("unavailable")
        site_packages = Path(venv_path) / "lib" / ("python%d.%d" % sys.version_info[:2]) / "site-packages"
        if str(site_packages) != walked_site_packages:
            raise RuntimeError("unavailable")
        for directory in (Path(venv_path), site_packages.parent.parent, site_packages.parent, site_packages):
            if not stat.S_ISDIR(os.lstat(directory).st_mode):
                raise RuntimeError("unavailable")
        import site
        # Retain optional interpreter packages after the venv and its .pth additions.
        interpreter_packages = [entry for entry in sys.path if Path(entry).name in {"site-packages", "dist-packages"}] if fields.get("include-system-site-packages", "false").lower() == "true" else []
        sys.path[:] = [entry for entry in sys.path if Path(entry).name not in {"site-packages", "dist-packages"}]
        # addsitedir executes owner .pth code. Python reports and swallows .pth errors;
        # those must still fail closed. The audit guard also covers dependency imports.
        reader_names.update({"addpackage", "addsitedir"})
        site_io = site.io
        class SiteIO:
            # Python 3.13+ site uses _io as io; replace only site's own reference.
            def __getattr__(self, name):
                return getattr(site_io, name)
            @staticmethod
            def open_code(path):
                return io.BytesIO(read_dependency(path, 1024 * 1024))
        # site reads through open_code rather than open. Supply a bounded in-memory
        # stream so its swallowed open and stream errors cannot hide an incomplete load.
        site.io = SiteIO()
        errors = io.StringIO()
        try:
            with contextlib.redirect_stderr(errors):
                site.addsitedir(str(site_packages))
        finally:
            site.io = site_io
        if errors.getvalue() or blocked or loader_failed:
            raise RuntimeError("unavailable")
        sys.path[:] = [module_path, str(site_packages), *[entry for entry in sys.path if entry not in (module_path, str(site_packages))], *interpreter_packages]
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

/** Bounded, no-follow preflight supplies only the versioned directory for the trust walk. */
async function venvSitePackages(venv: string, python: string): Promise<string> {
  const file = await open(join(venv, 'pyvenv.cfg'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let text: string;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16_384) throw new Error();
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16_384) throw new Error();
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytesRead));
  } finally { await file.close(); }
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (/[\p{Cc}\p{Cf}]/u.test(line)) throw new Error();
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const separator = line.indexOf('=');
    const key = line.slice(0, separator).trim();
    if (separator < 0 || fields.has(key)) throw new Error();
    fields.set(key, line.slice(separator + 1).trim());
  }
  const version = /^([0-9]+)\.([0-9]+)(?:\.[0-9]+[a-zA-Z0-9.+-]*)?$/.exec(fields.get('version_info') ?? '');
  if (fields.get('home') !== dirname(python) || !version) throw new Error();
  const [major, minor] = [Number(version[1]), Number(version[2])];
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) throw new Error();
  return join(venv, 'lib', `python${major}.${minor}`, 'site-packages');
}

/** Called inside the owner's read-only, network-isolated config unit. */
export async function resolveHermesConfig(site: SettingsTargets, view: ReadView, run: HermesResolverCommand = command, trust?: Trust): Promise<unknown> {
  const target = site.targets['hermes-config'];
  if (!target) throw new ConfigError('not_configured');
  const resolver = target.resolver;
  if (!resolver) throw new ConfigError('unavailable');
  try {
    const ownerRun = process.getuid?.() === target.runAs.uid && target.runAs.uid !== 0;
    const check = trust ?? (ownerRun
      ? (path: string) => trustedOwnerExecutable(path, target.runAs.uid) : trustedExecutable);
    const python = await check(resolver.python);
    await check(join(resolver.modulePath, 'hermes_cli/config.py'));
    let sitePackages = '';
    if (resolver.venv) {
      await check(join(resolver.venv, 'pyvenv.cfg'));
      sitePackages = await venvSitePackages(resolver.venv, resolver.python);
      const checkDirectory = trust ?? (ownerRun
        ? (path: string) => trustedOwnerDirectory(path, target.runAs.uid) : trustedDirectory);
      await checkDirectory(sitePackages);
    }
    const output = await run(python, ['-c', resolverScript, resolver.modulePath, target.path, JSON.stringify(view.keys), JSON.stringify(!!view.comparisonDigests),
      ...(resolver.venv ? [resolver.venv, resolver.python, sitePackages] : [])], dirname(target.path), { ...resolver.environment,
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
