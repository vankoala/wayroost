import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveHermesConfig, type HermesResolverCommand } from '../src/config-hermes.js';
import { executeConfig, readConfigView } from '../src/config-executor.js';
import { ConfigVerbs } from '../src/config-verbs.js';
import { ConfigError, digest } from '../src/config-paths.js';
import { settingsTargetsSchema } from '../../shared/settings-targets.js';
import { READ_VIEWS, readViewValues } from '../../shared/settings-ops.js';
import { collectSnapshot } from '../../server/src/checks/snapshot.js';
import { runChecks } from '../../server/src/checks/engine.js';
import { hashKey } from '../src/keys.js';
import { settingComparisonJson, type SettingValue } from '../../shared/settings.js';
import type { ConfigUnitRunner } from '../src/config-unit.js';

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: vi.fn() }));
vi.mock('../src/trust.js', async original => ({ ...await original<typeof import('../src/trust.js')>(), trustedExecutable: vi.fn(async (path: string) => path), trustedOwnerExecutable: vi.fn(async (path: string) => path) }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof fs>(), lstat: vi.fn() }));
const actual = await vi.importActual<typeof fs>('node:fs/promises');
const actualProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
const roots: string[] = [];
const trust = vi.fn(async (path: string) => path);
let output: string;
beforeEach(() => {
  trust.mockClear();
  output = JSON.stringify({ ok: true, document: { approvals: { mode: 'manual', cron_mode: 'deny' }, skills: { write_approval: false } } }) + '\n';
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    (args.at(-1) as (error: Error | null, stdout: string) => void)(null, output);
    return {} as ReturnType<typeof execFile>;
  });
  vi.mocked(lstat).mockImplementation(async (path, options) => {
    const stat = await actual.lstat(path, options); if (String(path) === '/') stat.uid = typeof stat.uid === 'bigint' ? 0n : 0; return stat;
  });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(source = 'model: example-model\napprovals: {mode: smart}\n') {
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), '.tmp', 'hermes-observation-')); roots.push(root);
  const home = join(root, 'home'); await mkdir(home, { mode: 0o700 });
  const path = join(home, 'config.yaml'); await writeFile(path, source, { mode: 0o600 });
  const managedPath = join(root, 'managed'); await mkdir(managedPath, { mode: 0o700 });
  await writeFile(join(managedPath, 'config.yaml'), 'approvals: {mode: manual}\n', { mode: 0o600 });
  const site = settingsTargetsSchema.parse({ version: 1, targets: { 'hermes-config': {
    path, runAs: { user: 'me', uid: process.getuid!() }, mode: 0o600, format: 'yaml', backupDir: join(root, 'backup'), auditDir: join(root, 'audit'),
    lock: { kind: 'file', path: path + '.wayroost-settings.lock' }, resolver: { python: '/opt/example/hermes/.venv/bin/python', modulePath: '/opt/example/hermes' },
  }, 'hermes-managed': { path: join(managedPath, 'config.yaml'), runAs: { user: 'me', uid: process.getuid!() }, format: 'yaml' } } });
  return { site, path, root, home, managedPath };
}

function consumerRunner(load: string, setup = ''): HermesResolverCommand {
  const bootstrap = `
import json, os, sys, types
from pathlib import Path
package = types.ModuleType("hermes_cli")
package.__path__ = []
consumer = types.ModuleType("hermes_cli.config")
class ParseError(Exception):
    pass
class FailedConfigRead(dict):
    def __init__(self, error):
        super().__init__({"agent": {"reasoning_effort": "high"}})
        self.read_error = error
consumer.FailedConfigRead = FailedConfigRead
consumer.yaml = types.SimpleNamespace(YAMLError=ParseError)
consumer.get_config_path = lambda: Path(os.environ["HERMES_HOME"]) / "config.yaml"
def ensure_hermes_home():
    home = Path(os.environ["HERMES_HOME"])
    home.mkdir(parents=True, exist_ok=True)
    (home / "SOUL.md").write_text("example initialized soul")
consumer.ensure_hermes_home = ensure_hermes_home
backups = types.ModuleType("hermes_cli.config_backups")
def backup_config(*args, **kwargs):
    home = Path(os.environ["HERMES_HOME"])
    (home / "backups").mkdir(parents=True, exist_ok=True)
    (home / "backups" / "config.yaml.good").write_text("example backup")
backups.backup_config = backup_config
def load_config():
${load.split('\n').map(line => '    ' + line).join('\n')}
consumer.load_config = load_config
package.config = consumer
env_loader = types.ModuleType("hermes_cli.env_loader")
env_loader.load_hermes_dotenv = lambda **kwargs: None
sys.modules.update({"hermes_cli": package, "hermes_cli.config": consumer, "hermes_cli.env_loader": env_loader,
                    "hermes_cli.config_backups": backups})
${setup}
`;
  return (_python, args, hermesHome) => new Promise((resolve, reject) => {
    actualProcess.execFile('/usr/bin/python3', ['-c', bootstrap + args[1], ...args.slice(2)], {
      timeout: 3000, maxBuffer: 1024 * 1024, cwd: process.cwd(),
      env: { PATH: '/usr/bin:/bin', HOME: hermesHome, HERMES_HOME: hermesHome, PYTHONDONTWRITEBYTECODE: '1' },
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

// Loader and runtime-resolver output shapes, with invented configuration values.
const consumerOutputs = [
  { name: 'scalar default model', view: 'hermes.models' as const, source: 'model: example-model\n',
    document: { model: { default: 'example-model' } }, path: ['model', 'default'], value: 'example-model' },
  { name: 'dotenv with a Latin-1 comment', view: 'hermes.models' as const, source: 'model: {default: "${EXAMPLE_MODEL}"}\n',
    document: { model: { default: 'example-latin-model' } }, path: ['model', 'default'], value: 'example-latin-model' },
  { name: 'managed model override', view: 'hermes.models' as const, source: 'model: {provider: example, default: user-model}\n',
    document: { model: { provider: 'example', default: 'managed-model', base_url: 'https://example.com/managed' } }, path: ['model', 'default'], value: 'managed-model' },
  { name: 'normalized approvals', view: 'hermes.safety' as const, source: 'approvals: {mode: false, cron_mode: " APPROVE "}\n',
    document: { approvals: { mode: 'off', cron_mode: 'approve' }, skills: { write_approval: false } }, path: ['approvals', 'mode'], value: 'off' },
  { name: 'reasoning setting', view: 'hermes.agents' as const, source: 'agent: {reasoning_effort: high}\n',
    document: { agent: { reasoning_effort: 'high' } }, path: ['agent', 'reasoning_effort'], value: 'high' },
  { name: 'expanded command list', view: 'hermes.safety' as const, source: 'command_allowlist: ["echo ${EXAMPLE_PATH}"]\n',
    document: { command_allowlist: ['echo /tmp/example'] }, path: ['command_allowlist'], value: ['echo /tmp/example'] },
];

it.each(consumerOutputs)('passes through Hermes output for $name', async example => {
  const f = await fixture(example.source);
  if (example.name.includes('Latin-1')) await writeFile(join(f.home, '.env'), Buffer.from('# café\nEXAMPLE_MODEL=example-latin-model\n', 'latin1'));
  if (example.name === 'managed model override') await writeFile(join(f.managedPath, 'config.yaml'), 'model: {default: managed-model, base_url: "https://example.com/managed"}\n');
  output = JSON.stringify({ ok: true, document: example.document }) + '\n';
  const before = await readFile(f.path, 'utf8');
  expect(await readConfigView(f.site, example.view)).toMatchObject({ ok: true, effective: true, values: expect.arrayContaining([
    { path: example.path, exists: true, value: example.value },
  ]) });
  const [, args] = vi.mocked(execFile).mock.calls[0]!;
  const script = (args as string[])[1]!;
  expect(script).toContain('from hermes_cli.env_loader import load_hermes_dotenv');
  expect(script).toContain('config = consumer.load_config()');
  expect(script).toContain('from hermes_cli.runtime_provider import _get_model_config');
  expect(script).not.toMatch(/DotEnv|encoding=|_deep_merge|DEFAULT_CONFIG|_normalize_root_model_keys|_expand_env_vars|apply_managed_overlay|unittest\.mock/);
  expect(await readFile(f.path, 'utf8')).toBe(before);
});

it('passes only site runtime paths and approved startup environment to the fixed program', async () => {
  const f = await fixture();
  const resolver = f.site.targets['hermes-config']!.resolver!;
  resolver.home = '/home/me/startup';
  resolver.environment = { EXAMPLE_MODEL: 'startup-model', HERMES_MANAGED_DIR: '/example/unused' };
  const run = vi.fn<HermesResolverCommand>(async () => output);
  await resolveHermesConfig(f.site, READ_VIEWS['hermes.safety'], run, trust);
  expect(trust.mock.calls.map(call => call[0])).toEqual([resolver.python, join(resolver.modulePath, 'hermes_cli/config.py')]);
  expect(run).toHaveBeenCalledWith(resolver.python, ['-c', expect.any(String), resolver.modulePath, f.path,
    JSON.stringify(READ_VIEWS['hermes.safety'].keys), 'false'], f.home,
  { EXAMPLE_MODEL: 'startup-model', HERMES_MANAGED_DIR: f.managedPath }, '/home/me/startup');
  await resolveHermesConfig(f.site, READ_VIEWS['hermes.safety']);
  expect(vi.mocked(execFile).mock.calls[0]![2]).toMatchObject({ timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, cwd: '/',
    env: { HOME: '/home/me/startup', HERMES_HOME: f.home, PATH: '/usr/bin:/bin', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', EXAMPLE_MODEL: 'startup-model' } });
});

it('keeps startup HOME independent of the profile directory', async () => {
  const f = await fixture();
  vi.stubEnv('HOME', '/home/me');
  const profile = join(f.home, 'profiles', 'example'); await mkdir(profile, { recursive: true });
  f.site.targets['hermes-config']!.path = join(profile, 'config.yaml');
  await resolveHermesConfig(f.site, READ_VIEWS['hermes.safety']);
  expect(vi.mocked(execFile).mock.calls[0]![2]).toMatchObject({ env: { HOME: '/home/me', HERMES_HOME: profile } });
});

it('does not fall back to system Python or persisted values when no runtime is configured', async () => {
  const f = await fixture(); delete f.site.targets['hermes-config']!.resolver;
  const run = vi.fn<HermesResolverCommand>(async () => output);
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.safety'], run, trust)).rejects.toMatchObject({ code: 'unavailable' });
  expect(run).not.toHaveBeenCalled(); expect(trust).not.toHaveBeenCalled();
  expect(await executeConfig({ site: f.site, caller: 'server', verb: 'config.read', request: { view: 'hermes.safety' } },
    { lock: async (_target, work) => work() })).toEqual({ ok: false, code: 'unavailable' });
});

it.each(['missing', 'loader error', 'timeout', 'untrusted'] as const)('leaves effective checks unknown after a %s runtime', async failure => {
  const f = await fixture();
  const run = vi.fn<HermesResolverCommand>(async () => { throw new Error(failure); });
  const checkTrust = async (path: string) => { if (failure === 'untrusted') throw new Error(); return path; };
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.models'], run, checkTrust)).rejects.toMatchObject({ code: 'unavailable' });
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    (args.at(-1) as (error: Error, stdout: string) => void)(new Error(failure), '');
    return {} as ReturnType<typeof execFile>;
  });
  const snapshot = await collectSnapshot({ readView: async view => executeConfig(
    { site: f.site, caller: 'server', verb: 'config.read', request: { view } }, { lock: async (_target, work) => work() }),
    revocations: async () => [{ entrySha256: digest('echo example'), revokedAt: 1000 }], hermesStartedAt: async () => 2000 }, {},
  { views: ['hermes.models', 'hermes.safety'] });
  expect(snapshot.views['hermes.models']).toMatchObject({ ok: false, code: 'unavailable' });
  expect(snapshot.views['hermes.safety']).toMatchObject({ ok: false, code: 'unavailable' });
  for (const id of ['hermes.reader-parse', 'hermes.model-provider', 'hermes.approval-mode', 'allowlist.revoke-back', 'allowlist.revoke-pending']) {
    expect(runChecks(snapshot).find(row => row.id === id)).toMatchObject({ state: 'unknown' });
  }
});

it.each(['{invalid', 'x'.repeat(1024 * 1024 + 1), '{"ok":true,"document":[]}', '{"ok":true,"document":{}}\n{}\n',
  '{"ok":true,"document":null}', '{"ok":true,"document":{},"extra":true}'])('refuses malformed or unbounded output %#', async output => {
  const f = await fixture();
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.models'], async () => output, trust)).rejects.toMatchObject({ code: 'unavailable' });
});

it.each(['parse_failed', 'unavailable', 'failed'])('normalizes a consumer %s response without exposing fallback values', async code => {
  const f = await fixture('model: [unterminated\n');
  output = JSON.stringify({ ok: false, code }) + '\n';
  await expect(readConfigView(f.site, 'hermes.safety')).rejects.toMatchObject({ code: 'unavailable' });
});

it('normalizes a resolver exception carrying a parse-failure code', async () => {
  const f = await fixture();
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.models'], async () => { throw new ConfigError('parse_failed'); }, trust))
    .rejects.toMatchObject({ code: 'unavailable' });
});

it.each([
  ['permission failure', 'PermissionError("example unavailable file")'],
  ['I/O failure', 'OSError(5, "example storage failure")'],
  ['missing file failure', 'FileNotFoundError("example missing file")'],
  ['unrecognized failure', 'RuntimeError("example loader failure")'],
  ['unrecognized attribute failure', 'AttributeError("example loader failure")'],
  ['unrelated attribute failure', 'AttributeError("example missing attribute", name="default", obj="example")'],
  ['runtime module attribute failure', 'AttributeError("example missing attribute", name="items", obj=consumer)'],
  ['missing failure reason', 'None'],
  ['YAML syntax failure', 'ParseError("example malformed YAML")'],
  ['configuration type failure', 'TypeError("example invalid type")'],
  ['text decoding failure', 'UnicodeDecodeError("utf-8", b"\\xff", 0, 1, "example invalid text")'],
])('leaves a consumer %s unavailable without exposing fallback values', async (_name, error) => {
  const f = await fixture();
  const run = vi.fn(consumerRunner(`return FailedConfigRead(${error})`));
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], run, trust)).rejects.toMatchObject({ code: 'unavailable' });
  expect(JSON.parse(await run.mock.results[0]!.value)).toEqual({ ok: false, code: 'unavailable' });
});

it.each(['ParseError("example malformed YAML")', 'TypeError("example invalid type")',
  'AttributeError("example missing attribute")', 'UnicodeError("example invalid text")'])('leaves an uncaught loader exception unavailable: %s', async error => {
  const f = await fixture();
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], consumerRunner(`raise ${error}`), trust))
    .rejects.toMatchObject({ code: 'unavailable' });
});

it.each(['environment', 'config', 'model', 'approvals', 'cron'] as const)('detects a swallowed exception in the %s loader stage', async stage => {
  const f = await fixture();
  const fallback = '{"agent": {"reasoning_effort": "high"}, "model": {"default": "example-model"}, "approvals": {"mode": "manual", "cron_mode": "deny"}}';
  const swallowed = `try:\n    raise RuntimeError("example failure")\nexcept Exception:\n    pass`;
  const definition = (name: string, value: string) => `def ${name}(*args, **kwargs):\n${swallowed.split('\n').map(line => '    ' + line).join('\n')}\n    return ${value}\n`;
  const setup = stage === 'environment' ? definition('load_hermes_dotenv', 'None') + 'env_loader.load_hermes_dotenv = load_hermes_dotenv'
    : stage === 'model' ? `runtime = types.ModuleType("hermes_cli.runtime_provider")\n${definition('_get_model_config', '{"default": "example-model"}')}runtime._get_model_config = _get_model_config\nsys.modules["hermes_cli.runtime_provider"] = runtime`
      : stage === 'approvals' || stage === 'cron' ? `tools = types.ModuleType("tools")\ntools.__path__ = []\napprovals = types.ModuleType("tools.approval_context")\n${definition(stage === 'cron' ? '_get_cron_approval_mode' : '_get_approval_mode', stage === 'cron' ? '"deny"' : '"manual"')}approvals._get_approval_mode = ${stage === 'approvals' ? '_get_approval_mode' : 'lambda: "manual"'}\napprovals._get_cron_approval_mode = ${stage === 'cron' ? '_get_cron_approval_mode' : 'lambda: "deny"'}\nsys.modules.update({"tools": tools, "tools.approval_context": approvals})` : '';
  const view = stage === 'model' ? 'hermes.models' : stage === 'approvals' || stage === 'cron' ? 'hermes.safety' : 'hermes.agents';
  await expect(resolveHermesConfig(f.site, READ_VIEWS[view], consumerRunner((stage === 'config' ? swallowed + '\n' : '') + `return ${fallback}`, setup), trust))
    .rejects.toMatchObject({ code: 'unavailable' });
});

it.each(['ParseError("example malformed YAML")', 'OSError("example I/O failure")', 'RuntimeError("example failure")'])('detects managed parsing failures swallowed before an ordinary dictionary is returned: %s', async error => {
  const f = await fixture();
  await writeFile(join(f.managedPath, 'config.yaml'), 'approvals: [\n');
  const setup = `def fast_safe_load(*args):\n    raise ${error}\ndef managed_config():\n    try:\n        return fast_safe_load(Path(consumer.get_config_path()).parent.parent / "managed" / "config.yaml")\n    except Exception:\n        return {}\n`;
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], consumerRunner('managed_config()\nreturn {"agent": {"reasoning_effort": "high"}}', setup), trust))
    .rejects.toMatchObject({ code: 'unavailable' });
});

it('detects a failure in a managed cached-reader callback before YAML parsing', async () => {
  const f = await fixture();
  const setup = `def read_policy(path):\n    raise OSError("example I/O failure")\ndef _cached_read(path, cache, parse):\n    try:\n        return parse(path)\n    except Exception:\n        return None\n`;
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], consumerRunner('_cached_read(consumer.get_config_path(), {}, read_policy)\nreturn {"agent": {"reasoning_effort": "high"}}', setup), trust))
    .rejects.toMatchObject({ code: 'unavailable' });
});

it.each(['["example"]', '[]', '"example"', '""', '1', '0', 'false'])('detects a malformed managed YAML root before fallback: %s', async source => {
  const f = await fixture(); delete f.site.targets['hermes-managed'];
  const policy = join(f.managedPath, 'config.yaml'); await writeFile(policy, source);
  const setup = `def safe_load(source):
    return json.loads(source)
def fast_safe_load(source):
    return safe_load(source)
def _cached_read(path, cache, parse):
    path.stat()
    return parse(path)
def load_managed_config():
    parsed = _cached_read(Path(consumer.get_config_path()).parent.parent / "managed" / "config.yaml", {}, lambda path: fast_safe_load(path.read_text()) or {})
    return parsed if isinstance(parsed, dict) else {}
`;
  const run = vi.fn(consumerRunner('load_managed_config()\nreturn {"agent": {"reasoning_effort": "high"}}', setup));
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], run, trust)).rejects.toMatchObject({ code: 'unavailable' });
  output = await run.mock.results[0]!.value;
  expect(JSON.parse(output)).toEqual({ ok: false, code: 'unavailable' });
  const snapshot = await collectSnapshot({ readView: async view => executeConfig(
    { site: f.site, caller: 'server', verb: 'config.read', request: { view } }, { lock: async (_target, work) => work() }),
    revocations: async () => [{ entrySha256: digest('echo example'), revokedAt: 1000 }], hermesStartedAt: async () => 2000 }, {},
  { views: ['hermes.models', 'hermes.safety'] });
  for (const id of ['hermes.reader-parse', 'hermes.model-provider', 'hermes.approval-mode', 'allowlist.revoke-back', 'allowlist.revoke-pending']) {
    expect(runChecks(snapshot).find(row => row.id === id)).toMatchObject({ state: 'unknown' });
  }
  expect(await readFile(policy, 'utf8')).toBe(source);
});

it.each(['{}', 'null', '{"agent":{"reasoning_effort":"high"},"command_allowlist":["echo example"]}'])('accepts a valid managed YAML root: %s', async source => {
  const f = await fixture();
  await writeFile(join(f.managedPath, 'config.yaml'), source);
  const setup = `def fast_safe_load(source):
    return json.loads(source)
def _cached_read(path, cache, parse):
    path.stat()
    return parse(path)
def load_managed_config():
    return _cached_read(Path(consumer.get_config_path()).parent.parent / "managed" / "config.yaml", {}, lambda path: fast_safe_load(path.read_text()) or {})
`;
  expect(await resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], consumerRunner('load_managed_config()\nreturn {"agent": {"reasoning_effort": "high"}}', setup), trust))
    .toEqual({ agent: { reasoning_effort: 'high' } });
});

it.each(['OSError("example storage failure")', 'PermissionError("example unreadable policy")', 'RuntimeError("example failure")'])('detects an exception swallowed by the managed cached stat reader: %s', async error => {
  const f = await fixture(); delete f.site.targets['hermes-managed'];
  const setup = `original_stat = Path.stat
policy_path = Path(consumer.get_config_path()).parent.parent / "managed" / "config.yaml"
def stat(path, *args, **kwargs):
    if path == policy_path:
        raise ${error}
    return original_stat(path, *args, **kwargs)
Path.stat = stat
def read_policy(path):
    raise AssertionError("parser must not run after stat fails")
def _cached_read(path, cache, parse):
    try:
        path.stat()
    except Exception:
        return None
    return parse(path)
def load_managed_config():
    return _cached_read(policy_path, {}, read_policy) or {}
`;
  const run = vi.fn(consumerRunner('load_managed_config()\nreturn {"agent": {"reasoning_effort": "high"}}', setup));
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], run, trust)).rejects.toMatchObject({ code: 'unavailable' });
  expect(JSON.parse(await run.mock.results[0]!.value)).toEqual({ ok: false, code: 'unavailable' });
});

const userReader = `def fast_safe_load(stream):
    text = stream.read()
    return json.loads(text) if text.strip() else None
def read_user():
    with open(consumer.get_config_path()) as stream:
        return fast_safe_load(stream) or {}
`;

it.each(['[]', '""', '0', 'false', '["example"]'])('detects a non-mapping user YAML root the loader would turn into defaults: %s', async source => {
  const f = await fixture(source);
  const run = vi.fn(consumerRunner('read_user()\nreturn {"agent": {"reasoning_effort": "high"}}', userReader));
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], run, trust)).rejects.toMatchObject({ code: 'unavailable' });
  expect(JSON.parse(await run.mock.results[0]!.value)).toEqual({ ok: false, code: 'unavailable' });
});

it.each(['', '{}', '{"agent": {"reasoning_effort": "high"}}'])('accepts an empty or mapping user YAML root: %s', async source => {
  const f = await fixture(source);
  expect(await resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], consumerRunner('read_user()\nreturn {"agent": {"reasoning_effort": "high"}}', userReader), trust))
    .toEqual({ agent: { reasoning_effort: 'high' } });
});

it('does not treat a parsed string value as a file root', async () => {
  const f = await fixture();
  const setup = `def safe_load(stream):
    return json.loads(stream)
`;
  expect(await resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], consumerRunner('safe_load(\'["echo example"]\')\nreturn {"agent": {"reasoning_effort": "high"}}', setup), trust))
    .toEqual({ agent: { reasoning_effort: 'high' } });
});

const envReader = `def load_env_file(path):
    try:
        with open(path, "rb") as handle:
            return {"EXAMPLE": handle.read().decode()}
    except OSError:
        return {}
def load_hermes_dotenv(**kwargs):
    load_env_file(Path(os.environ["HERMES_HOME"]) / ".env")
env_loader.load_hermes_dotenv = load_hermes_dotenv
`;

it('detects an I/O failure swallowed by the inner dotenv reader', async () => {
  const f = await fixture();
  await mkdir(join(f.home, '.env'));
  const run = vi.fn(consumerRunner('return {"agent": {"reasoning_effort": "high"}}', envReader));
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], run, trust)).rejects.toMatchObject({ code: 'unavailable' });
  expect(JSON.parse(await run.mock.results[0]!.value)).toEqual({ ok: false, code: 'unavailable' });
});

it('fails the view when the .env vanishes before Hermes scans its keys', async () => {
  const f = await fixture();
  await writeFile(join(f.home, '.env'), 'EXAMPLE=1\n');
  const setup = envReader + `def _env_keys_defined_in_dotenv(path):
    return set(load_env_file(path))
def load_hermes_dotenv(**kwargs):
    path = Path(os.environ["HERMES_HOME"]) / ".env"
    load_env_file(path)
    # The file is gone by the time Hermes scans its keys.
    _env_keys_defined_in_dotenv(path.with_name(".env-gone"))
env_loader.load_hermes_dotenv = load_hermes_dotenv
`;
  const run = vi.fn(consumerRunner('return {"agent": {"reasoning_effort": "high"}}', setup));
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], run, trust)).rejects.toMatchObject({ code: 'unavailable' });
});

it.each([
  ['absent at the first stat', 'missing.yaml', 'available'],
  ['gone after the first stat', 'config.yaml', 'unavailable'],
])('reads a managed file %s', async (_name, file, expected) => {
  const f = await fixture(); delete f.site.targets['hermes-managed'];
  const setup = `def read_gone(path):
    return (path.parent / "vanished.yaml").read_text()
def _cached_read(path, cache, parse):
    try:
        path.stat()
    except OSError:
        return None
    try:
        return parse(path)
    except Exception:
        return None
def load_managed_config():
    return _cached_read(Path(consumer.get_config_path()).parent.parent / "managed" / "${file}", {}, read_gone) or {}
`;
  const result = resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], consumerRunner('load_managed_config()\nreturn {"agent": {"reasoning_effort": "high"}}', setup), trust);
  if (expected === 'available') expect(await result).toEqual({ agent: { reasoning_effort: 'high' } });
  else await expect(result).rejects.toMatchObject({ code: 'unavailable' });
});

it('fails the view when the .env vanishes before Hermes sanitizes it', async () => {
  const f = await fixture();
  await writeFile(join(f.home, '.env'), 'EXAMPLE=1\n');
  const setup = `def _sanitize_env_file_if_needed(path):
    if not path.exists():
        return
    try:
        # The file is gone by the time Hermes reads it.
        path.with_name(".env-gone").read_bytes()
    except Exception:
        return
def load_hermes_dotenv(**kwargs):
    _sanitize_env_file_if_needed(Path(os.environ["HERMES_HOME"]) / ".env")
env_loader.load_hermes_dotenv = load_hermes_dotenv
`;
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], consumerRunner('return {"agent": {"reasoning_effort": "high"}}', setup), trust))
    .rejects.toMatchObject({ code: 'unavailable' });
});

it('treats a missing .env as absent in the inner dotenv reader', async () => {
  const f = await fixture();
  expect(await resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], consumerRunner('return {"agent": {"reasoning_effort": "high"}}', envReader), trust))
    .toEqual({ agent: { reasoning_effort: 'high' } });
});

it.each([
  { view: 'hermes.models' as const, value: '[]' },
  { view: 'hermes.models' as const, value: '"example"' },
  { view: 'hermes.safety' as const, value: 'None' },
  { view: 'hermes.safety' as const, value: 'False' },
])('refuses malformed runtime stage output $value for $view', async example => {
  const f = await fixture();
  const setup = example.view === 'hermes.models'
    ? `runtime = types.ModuleType("hermes_cli.runtime_provider")\nruntime._get_model_config = lambda: ${example.value}\nsys.modules["hermes_cli.runtime_provider"] = runtime`
    : `tools = types.ModuleType("tools")\ntools.__path__ = []\napprovals = types.ModuleType("tools.approval_context")\napprovals._get_approval_mode = lambda: ${example.value}\napprovals._get_cron_approval_mode = lambda: "deny"\nsys.modules.update({"tools": tools, "tools.approval_context": approvals})`;
  await expect(resolveHermesConfig(f.site, READ_VIEWS[example.view], consumerRunner('return {"agent": {"reasoning_effort": "high"}}', setup), trust))
    .rejects.toMatchObject({ code: 'unavailable' });
});

it.each(['environment', 'model', 'approvals'] as const)('detects a failed nested configuration read in the %s resolver', async stage => {
  const f = await fixture();
  const setup = `consumer.calls = 0\n` + (stage === 'environment' ? 'env_loader.load_hermes_dotenv = lambda **kwargs: consumer.load_config()'
    : stage === 'model' ? `runtime = types.ModuleType("hermes_cli.runtime_provider")\nruntime._get_model_config = lambda: consumer.load_config().get("model", {"default": "example-model"})\nsys.modules["hermes_cli.runtime_provider"] = runtime`
      : `tools = types.ModuleType("tools")\ntools.__path__ = []\napprovals = types.ModuleType("tools.approval_context")\napprovals._get_approval_mode = lambda: consumer.load_config().get("approvals", {}).get("mode", "manual")\napprovals._get_cron_approval_mode = lambda: "deny"\nsys.modules.update({"tools": tools, "tools.approval_context": approvals})`);
  const load = `consumer.calls += 1\nif consumer.calls == ${stage === 'environment' ? 1 : 2}:\n    return FailedConfigRead(RuntimeError("example failure"))\nreturn {"agent": {"reasoning_effort": "high"}, "model": {"default": "example-model"}}`;
  const view = stage === 'model' ? 'hermes.models' : stage === 'approvals' ? 'hermes.safety' : 'hermes.agents';
  await expect(resolveHermesConfig(f.site, READ_VIEWS[view], consumerRunner(load, setup), trust)).rejects.toMatchObject({ code: 'unavailable' });
});

it.each(['user', 'managed'] as const)('normalizes an invalid UTF-8 %s snapshot and leaves dependent rows unknown', async file => {
  const f = await fixture();
  await writeFile(file === 'user' ? f.path : join(f.managedPath, 'config.yaml'), Buffer.from([0xff]));
  await expect(readConfigView(f.site, 'hermes.safety')).rejects.toMatchObject({ code: 'unavailable' });
  const snapshot = await collectSnapshot({ readView: async view => executeConfig(
    { site: f.site, caller: 'server', verb: 'config.read', request: { view } }, { lock: async (_target, work) => work() }),
    revocations: async () => [{ entrySha256: digest('echo example'), revokedAt: 1000 }], hermesStartedAt: async () => 2000 }, {},
  { views: ['hermes.models', 'hermes.safety'] });
  expect(snapshot.views['hermes.safety']).toMatchObject({ ok: false, code: 'unavailable' });
  for (const id of ['hermes.reader-parse', 'hermes.model-provider', 'hermes.approval-mode', 'allowlist.revoke-back', 'allowlist.revoke-pending']) {
    expect(runChecks(snapshot).find(row => row.id === id)).toMatchObject({ state: 'unknown' });
  }
  expect(execFile).not.toHaveBeenCalled();
});

it.each(['None', '[]', '["example"]', '[["agent", {"reasoning_effort": "high"}]]', '"example"', '1'])('refuses a non-mapping loader result: %s', async value => {
  const f = await fixture();
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], consumerRunner(`return ${value}`), trust))
    .rejects.toMatchObject({ code: 'unavailable' });
});

it.each([
  { name: 'list using items', source: '[example]\n', value: '["example"]', access: 'items()' },
  { name: 'string using items', source: 'example\n', value: '"example"', access: 'items()' },
  { name: 'list using get', source: '[max_turns]\n', value: '["max_turns"]', access: 'get("max_turns")' },
  { name: 'string using get', source: 'max_turns\n', value: '"max_turns"', access: 'get("max_turns")' },
])('leaves a $name root unavailable through the consumer read-error API', async example => {
  const f = await fixture(example.source);
  const run = vi.fn(consumerRunner(`try:
    (${example.value}).${example.access}
except AttributeError as error:
    return FailedConfigRead(error)`));
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.models'], run, trust)).rejects.toMatchObject({ code: 'unavailable' });
  output = await run.mock.results[0]!.value;
  expect(JSON.parse(output)).toEqual({ ok: false, code: 'unavailable' });
  const snapshot = await collectSnapshot({ readView: async view => executeConfig(
    { site: f.site, caller: 'server', verb: 'config.read', request: { view } }, { lock: async (_target, work) => work() }),
    revocations: async () => [{ entrySha256: digest('echo example'), revokedAt: 1000 }], hermesStartedAt: async () => 2000 }, {},
  { views: ['hermes.models', 'hermes.safety'] });
  expect(snapshot.views['hermes.models']).toMatchObject({ ok: false, code: 'unavailable' });
  expect(snapshot.views['hermes.safety']).toMatchObject({ ok: false, code: 'unavailable' });
  for (const id of ['hermes.reader-parse', 'hermes.model-provider', 'hermes.approval-mode', 'allowlist.revoke-back', 'allowlist.revoke-pending']) {
    expect(runChecks(snapshot).find(row => row.id === id)).toMatchObject({ state: 'unknown' });
  }
  expect(await readFile(f.path, 'utf8')).toBe(example.source);
  expect(await readdir(f.home)).toEqual(['config.yaml']);
});

it.each([true, false])('observes consumer values with an existing read-only home and file presence %s', async present => {
  const f = await fixture();
  if (!present) await rm(f.path);
  await writeFile(join(f.home, 'SOUL.md'), 'example legacy soul', { mode: 0o400 });
  const before = await readdir(f.home);
  const run = consumerRunner(`consumer.ensure_hermes_home()
from hermes_cli.config_backups import backup_config
backup_config(consumer.get_config_path(), "good")
return {"agent": {"reasoning_effort": "high"}}`);
  await chmod(f.home, 0o500);
  try {
    expect(await resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], run, trust)).toEqual({ agent: { reasoning_effort: 'high' } });
    expect(await readdir(f.home)).toEqual(before);
    expect(await readFile(join(f.home, 'SOUL.md'), 'utf8')).toBe('example legacy soul');
    if (present) expect(await readFile(f.path, 'utf8')).toBe('model: example-model\napprovals: {mode: smart}\n');
  } finally { await chmod(f.home, 0o700); }
});

it.each(['environment', 'model', 'approvals'] as const)('suppresses housekeeping during the consumer %s resolver too', async stage => {
  const f = await fixture();
  const run = consumerRunner(`consumer.ensure_hermes_home()
from hermes_cli.config_backups import backup_config
backup_config(consumer.get_config_path(), "good")
return {"agent": {"reasoning_effort": "high"}, "model": {"default": "example-model"}, "approvals": {"mode": "manual", "cron_mode": "deny"}}`,
  stage === 'environment' ? 'env_loader.load_hermes_dotenv = lambda **kwargs: consumer.load_config()'
    : stage === 'model' ? `runtime = types.ModuleType("hermes_cli.runtime_provider")
runtime._get_model_config = lambda: consumer.load_config()["model"]
sys.modules["hermes_cli.runtime_provider"] = runtime`
      : `tools = types.ModuleType("tools")
tools.__path__ = []
approvals = types.ModuleType("tools.approval_context")
approvals._get_approval_mode = lambda: consumer.load_config()["approvals"]["mode"]
approvals._get_cron_approval_mode = lambda: consumer.load_config()["approvals"]["cron_mode"]
sys.modules.update({"tools": tools, "tools.approval_context": approvals})`);
  const view = stage === 'environment' ? 'hermes.agents' : stage === 'model' ? 'hermes.models' : 'hermes.safety';
  expect(await resolveHermesConfig(f.site, READ_VIEWS[view], run, trust)).toMatchObject(stage === 'environment'
    ? { agent: { reasoning_effort: 'high' } } : stage === 'model' ? { model: { default: 'example-model' } }
      : { approvals: { mode: 'manual', cron_mode: 'deny' } });
  expect(await readdir(f.home)).toEqual(['config.yaml']);
});

it.each([
  ['file write', 'Path(os.environ["HERMES_HOME"]).joinpath("example.txt").write_text("example")'],
  ['directory creation', 'Path(os.environ["HERMES_HOME"]).joinpath("example-folder").mkdir()'],
  ['network connection', '__import__("socket").create_connection(("127.0.0.1", 9), timeout=1)'],
  ['permission change', 'os.chmod(consumer.get_config_path(), 0o644)'],
  ['file removal', 'consumer.get_config_path().unlink()'],
  ['process launch', '__import__("subprocess").run(["/bin/true"])'],
])('rejects an unrelated %s even when the loader catches the denial', async (_name, operation) => {
  const f = await fixture();
  const run = consumerRunner(`try:
    ${operation}
except PermissionError:
    pass
return {"agent": {"reasoning_effort": "high"}}`);
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], run, trust)).rejects.toMatchObject({ code: 'unavailable' });
  expect(await readdir(f.home)).toEqual(['config.yaml']);
  expect((await actual.lstat(f.path)).mode & 0o777).toBe(0o600);
});

it.each([
  ['existing directory creation', 'Path(os.environ["HERMES_HOME"]).mkdir(parents=True, exist_ok=True)'],
  ['unchanged permission', 'os.chmod(consumer.get_config_path(), 0o600)'],
  ['loopback bind probe', 's = __import__("socket").socket()\ntry:\n    s.bind(("127.0.0.1", 0))\nfinally:\n    s.close()'],
])('lets an operation that changes and fetches nothing through: %s', async (_name, operation) => {
  const f = await fixture();
  // Outside Hermes' reader functions, as urllib3's import-time IPv6 probe is.
  const setup = `def operation():
    try:
${operation.split('\n').map(line => '        ' + line).join('\n')}
    except PermissionError:
        pass
`;
  const run = consumerRunner('operation()\nreturn {"agent": {"reasoning_effort": "high"}}', setup);
  expect(await resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], run, trust)).toEqual({ agent: { reasoning_effort: 'high' } });
  expect(await readdir(f.home)).toEqual(['config.yaml']);
  expect((await actual.lstat(f.path)).mode & 0o777).toBe(0o600);
});

it.each([
  ['os.stat', 'managed.exists()', 'OSError(errno.EIO, "example storage failure")'],
  ['os.listdir', 'bool(os.listdir(managed))', 'OSError(errno.EIO, "example storage failure")'],
])('fails the view when %s meets an error Hermes would read as absence', async (call, probe, error) => {
  const f = await fixture();
  const setup = `import errno
real = ${call}
def failing(path, *args, **kwargs):
    if str(path).endswith("managed"):
        raise ${error}
    return real(path, *args, **kwargs)
${call} = failing
`;
  const run = consumerRunner(`managed = Path(consumer.get_config_path()).parent.parent / "managed"
try:
    ${probe}
except OSError:
    pass
return {"agent": {"reasoning_effort": "high"}}`, setup);
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], run, trust)).rejects.toMatchObject({ code: 'unavailable' });
});

it('reads a path through a file as absent, as package metadata probing does in a healthy home', async () => {
  const f = await fixture();
  // Python's metadata scan probes entry_points.txt below .egg-info FILES and treats ENOTDIR as absence.
  const setup = `def scan_metadata():
    try:
        (Path(consumer.get_config_path()) / "entry_points.txt").read_text()
    except OSError:
        return None
`;
  expect(await resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'],
    consumerRunner('scan_metadata()\nreturn {"agent": {"reasoning_effort": "high"}}', setup), trust)).toEqual({ agent: { reasoning_effort: 'high' } });
});

it.each(['del consumer.ensure_hermes_home', 'backups.backup_config = None'])('leaves an unsupported consumer unknown: %s', async setup => {
  const f = await fixture();
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], consumerRunner('return {"agent": {"reasoning_effort": "high"}}', setup), trust))
    .rejects.toMatchObject({ code: 'unavailable' });
});

it('keeps the parse check unknown for a consumer I/O failure', async () => {
  const f = await fixture();
  output = '{"ok":false,"code":"unavailable"}\n';
  const snapshot = await collectSnapshot({ readView: async view => executeConfig(
    { site: f.site, caller: 'server', verb: 'config.read', request: { view } }, { lock: async (_target, work) => work() }) }, {},
  { views: ['hermes.models', 'hermes.safety'] });
  for (const id of ['hermes.reader-parse', 'hermes.model-provider', 'hermes.approval-mode']) {
    expect(runChecks(snapshot).find(row => row.id === id)).toMatchObject({ state: 'unknown' });
  }
});

it.each(['user', 'managed'] as const)('refuses a changed %s file during observation', async changed => {
  const f = await fixture();
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
    void writeFile(changed === 'user' ? f.path : join(f.managedPath, 'config.yaml'), '{}', { mode: 0o600 })
      .then(() => callback(null, output));
    return {} as ReturnType<typeof execFile>;
  });
  await expect(readConfigView(f.site, 'hermes.safety')).rejects.toMatchObject({ code: 'unavailable' });
});

it('keeps effective defaults for an absent file without creating or modifying files', async () => {
  const f = await fixture(); await rm(f.path);
  await writeFile(join(f.home, 'SOUL.md'), 'example legacy soul', { mode: 0o400 });
  const before = await readdir(f.home); await chmod(f.home, 0o500);
  try {
    const observation = await readConfigView(f.site, 'hermes.safety');
    expect(observation).toMatchObject({ ok: true, present: false, effective: true, values: expect.arrayContaining([
      { path: ['approvals', 'cron_mode'], exists: true, value: 'deny' },
    ]) });
    expect(observation).not.toHaveProperty('sha256');
    const snapshot = await collectSnapshot({ readView: async () => observation }, {}, { views: ['hermes.safety'] });
    expect(snapshot.views['hermes.safety']).toMatchObject({ ok: true, value: { present: false, document: { approvals: { mode: 'manual', cron_mode: 'deny' } } } });
    expect(await readdir(f.home)).toEqual(before);
    expect(await readFile(join(f.home, 'SOUL.md'), 'utf8')).toBe('example legacy soul');
  } finally { await chmod(f.home, 0o700); }
});

it('keeps private effective model values behind the read rules', async () => {
  const f = await fixture();
  output = JSON.stringify({ ok: true, document: { model: { default: 'example-private-model', base_url: 'https://example.com/private' } } });
  const document = await resolveHermesConfig(f.site, READ_VIEWS['hermes.models']);
  const values = await readViewValues('hermes.models', document, { scopes: ['settings'] });
  expect(JSON.stringify(values)).not.toMatch(/example-private-model|example.com\/private/);
  const [, args] = vi.mocked(execFile).mock.calls[0]!;
  expect((args as string[])[1]).toContain('else scrub(source[key])');
  expect((args as string[])[1]).toContain('"credentials"');
});

it.each(['apiKey', 'nested', 'headers', 'array'] as const)('compares the complete effective provider including %s without returning credentials', async field => {
  const f = await fixture();
  const before = { base_url: 'https://example.com/provider', apiKey: 'invented-before-key',
    nested: { credentials: { token: 'invented-before-token' } }, headers: { Authorization: 'invented-before-header' },
    array: [{ password: 'invented-before-password' }], limits: [0, 1.5, 1e-7, 1e21], label: 'example-é' };
  const after = structuredClone(before);
  if (field === 'apiKey') after.apiKey = 'invented-after-key';
  if (field === 'nested') after.nested.credentials.token = 'invented-after-token';
  if (field === 'headers') after.headers.Authorization = 'invented-after-header';
  if (field === 'array') after.array[0]!.password = 'invented-after-password';
  const expected = (value: SettingValue) => {
    const source = settingComparisonJson(value);
    return { sha256: digest(source), length: Buffer.byteLength(source) };
  };
  const resolve = async (provider: typeof before) => {
    const run = consumerRunner(`return json.loads(${JSON.stringify(JSON.stringify({ providers: { example: provider } }))})`);
    const document = await resolveHermesConfig(f.site, READ_VIEWS['hermes.providers'], run, trust);
    expect(JSON.stringify(document)).not.toMatch(/invented-(?:before|after)-|example.com\/provider/);
    const values = await readViewValues('hermes.providers', document, { scopes: ['settings', 'pc-settings'], listener: 'local', pcOnlyWrites: true });
    expect(values).toEqual([{ path: ['providers', 'example'], exists: true, value: expected(provider) }]);
    return document;
  };
  const first = await resolve(before);
  expect(await resolve(after)).not.toEqual(first);
  expect(await resolve(Object.fromEntries(Object.entries(before).reverse()) as typeof before)).toEqual(first);
  expect(await readFile(f.path, 'utf8')).toBe('model: example-model\napprovals: {mode: smart}\n');
});

it('returns complete provider digests through the owner executor and scrubs ordinary views', async () => {
  const f = await fixture();
  const provider = { base_url: 'https://example.com', nested: { api_key: 'invented-private-key' },
    models: [{ id: 'example', token: 'invented-private-token' }] };
  const run = consumerRunner(`return json.loads(${JSON.stringify(JSON.stringify({ providers: { example: provider } }))})`);
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const options = args[2] as { env: { HERMES_HOME: string } };
    const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
    void run(args[0] as string, args[1] as string[], options.env.HERMES_HOME).then(stdout => callback(null, stdout), error => callback(error, ''));
    return {} as ReturnType<typeof execFile>;
  });
  const result = await executeConfig({ site: f.site, caller: 'server', verb: 'config.read', request: { view: 'hermes.providers' } },
    { lock: async (_target, work) => work() });
  const source = settingComparisonJson(provider);
  expect(result).toMatchObject({ ok: true, effective: true,
    values: [{ path: ['providers', 'example'], exists: true, value: { sha256: digest(source), length: Buffer.byteLength(source) } }] });
  expect(JSON.stringify(result)).not.toMatch(/invented-private-|example.com/);
  expect(await resolveHermesConfig(f.site, { target: 'hermes-config', keys: [['providers', '*']] }, run, trust))
    .toEqual({ providers: { example: { base_url: 'https://example.com', nested: {}, models: [{ id: 'example' }] } } });
});

it('routes effective reads through a bounded owner unit with no network or writable paths', async () => {
  const f = await fixture();
  const runner = vi.fn<ConfigUnitRunner>(async unit => ({ code: 0, stdout: JSON.stringify(await executeConfig(JSON.parse(unit.input),
    { lock: async (_target, work) => work() })) + '\n' }));
  const verbs = new ConfigVerbs({ stateDir: join(f.root, 'state'), site: async () => f.site, runner, trust,
    executable: '/opt/example/node', entry: '/opt/example/config-entry.js' });
  expect(await verbs.read({ view: 'hermes.safety' }, { name: 'server', scope: 'server', sha256: hashKey('fake-server-key') })).toMatchObject({ ok: true, effective: true });
  expect(runner).toHaveBeenCalledOnce();
  expect(runner.mock.calls[0]![0].argv).toEqual(expect.arrayContaining(['--uid=' + f.site.targets['hermes-config']!.runAs.uid,
    '--property=PrivateNetwork=yes', '--property=ProtectSystem=strict', '--property=ProtectHome=read-only',
    '--property=RuntimeMaxSec=5', '--property=ReadWritePaths=', '--property=StandardError=null']));
  expect(await verbs.read({ view: 'hermes.safety', python: '/example/caller-python' }, { name: 'server', scope: 'server', sha256: hashKey('fake-server-key') }))
    .toEqual({ ok: false, code: 'invalid_parameters' });
  expect(runner).toHaveBeenCalledOnce();
});

it('checks root launchers before delegating resolver path trust to the owner unit', async () => {
  const f = await fixture();
  const resolver = f.site.targets['hermes-config']!.resolver!;
  resolver.python = '/home/me/.hermes/installs/example/python';
  resolver.modulePath = '/home/me/.hermes/installs/example';
  const rootTrust = vi.fn(async (path: string) => {
    if (path.startsWith('/home/me/')) throw new Error('owner-controlled');
    return path;
  });
  const { trustedOwnerExecutable } = await import('../src/trust.js');
  vi.mocked(trustedOwnerExecutable).mockClear();
  const runner = vi.fn<ConfigUnitRunner>(async unit => ({ code: 0, stdout: JSON.stringify(await executeConfig(JSON.parse(unit.input),
    { lock: async (_target, work) => work() })) + '\n' }));
  const verbs = new ConfigVerbs({ stateDir: join(f.root, 'state'), site: async () => f.site, runner, trust: rootTrust,
    executable: '/opt/example/node', entry: '/opt/example/config-entry.js' });
  const key = { name: 'server', scope: 'server' as const, sha256: hashKey('fake-server-key') };
  expect(await verbs.read({ view: 'hermes.safety' }, key)).toMatchObject({ ok: true, effective: true });
  expect(rootTrust.mock.calls.map(([path]) => path)).toEqual(['systemd-run', '/opt/example/node', '/opt/example/config-entry.js']);
  expect(runner.mock.calls[0]![0].argv).toContain('--uid=' + f.site.targets['hermes-config']!.runAs.uid);
  expect(trustedOwnerExecutable).toHaveBeenCalledWith(resolver.python, f.site.targets['hermes-config']!.runAs.uid);
  expect(trustedOwnerExecutable).toHaveBeenCalledWith(join(resolver.modulePath, 'hermes_cli/config.py'), f.site.targets['hermes-config']!.runAs.uid);
});

it.each(['systemd-run', '/opt/example/node', '/opt/example/config-entry.js'])('refuses an untrusted root launcher %s before the owner unit starts', async refused => {
  const f = await fixture();
  const runner = vi.fn<ConfigUnitRunner>();
  const verbs = new ConfigVerbs({ stateDir: join(f.root, 'state'), site: async () => f.site, runner,
    trust: async path => { if (path === refused) throw new Error('unsafe'); return path; },
    executable: '/opt/example/node', entry: '/opt/example/config-entry.js' });
  expect(await verbs.read({ view: 'hermes.safety' }, { name: 'server', scope: 'server', sha256: hashKey('fake-server-key') }))
    .toEqual({ ok: false, code: 'unavailable' });
  expect(runner).not.toHaveBeenCalled();
});

it('keeps persisted allowlist entries separate from loader output', async () => {
  const f = await fixture('command_allowlist: ["echo ${EXAMPLE_PATH}"]\n');
  output = '{"ok":true,"document":{"command_allowlist":["echo /tmp/example"]}}';
  expect(await readConfigView(f.site, 'hermes.safety')).toMatchObject({ effective: true, values: expect.arrayContaining([
    { path: ['command_allowlist'], exists: true, value: ['echo /tmp/example'] },
  ]) });
  const persisted = await readConfigView(f.site, 'hermes.allowlist');
  expect(persisted).not.toHaveProperty('effective');
  expect(persisted).toMatchObject({ ok: true, values: [{ path: ['command_allowlist'], exists: true, value: ['echo ${EXAMPLE_PATH}'] }] });
  expect(execFile).toHaveBeenCalledOnce();
  await rm(f.path);
  expect(await readConfigView(f.site, 'hermes.allowlist')).toEqual({ ok: true, view: 'hermes.allowlist', present: false, values: [] });
});

it('keeps the persisted owner view readable when a configured runtime is missing', async () => {
  const f = await fixture('command_allowlist: ["echo example"]\n');
  const runner = vi.fn<ConfigUnitRunner>(async unit => ({ code: 0, stdout: JSON.stringify(await executeConfig(JSON.parse(unit.input),
    { lock: async (_target, work) => work() })) + '\n' }));
  const { trustedOwnerExecutable } = await import('../src/trust.js');
  vi.mocked(trustedOwnerExecutable).mockRejectedValueOnce(new Error('missing'));
  const verbs = new ConfigVerbs({ stateDir: join(f.root, 'state'), site: async () => f.site, runner, trust,
    executable: '/opt/example/node', entry: '/opt/example/config-entry.js' });
  const key = { name: 'server', scope: 'server' as const, sha256: hashKey('fake-server-key') };
  expect(await verbs.read({ view: 'hermes.safety' }, key)).toEqual({ ok: false, code: 'unavailable' });
  expect(runner).toHaveBeenCalledOnce();
  expect(await verbs.read({ view: 'hermes.allowlist' }, key)).toMatchObject({ ok: true, values: [
    { path: ['command_allowlist'], exists: true, value: ['echo example'] },
  ] });
  expect(execFile).not.toHaveBeenCalled();
});

it('compares a revoked entry with the file text, not the text Hermes expands it to', async () => {
  const f = await fixture('command_allowlist: ["echo ${EXAMPLE_PATH}"]\n');
  output = '{"ok":true,"document":{"command_allowlist":["echo /tmp/example"]}}';
  const rows = async (entry: string) => runChecks(await collectSnapshot({ readView: async view => readConfigView(f.site, view),
    revocations: async () => [{ entrySha256: digest(entry), revokedAt: 1000 }], hermesStartedAt: async () => 2000 }, {},
  { views: ['hermes.allowlist'] })).find(row => row.id === 'allowlist.revoke-back');
  expect(await rows('echo ${EXAMPLE_PATH}')).toMatchObject({ state: 'fail' });
  // The expanded text is only Hermes' view of the same entry; no revoke records it.
  expect(await rows('echo /tmp/example')).toMatchObject({ state: 'ok' });
});

it.each(['home/me', '/home/me/../outside', '/home/me/', '/home/me\n'])('rejects a noncanonical startup home: %s', async home => {
  const f = await fixture(); f.site.targets['hermes-config']!.resolver!.home = home;
  expect(settingsTargetsSchema.safeParse(f.site).success).toBe(false);
});

it('confines startup variables to approved configuration data', async () => {
  const f = await fixture();
  for (const name of ['PYTHONPATH', 'HOME', 'PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'HERMES_HOME', 'EXAMPLE_TOKEN']) {
    f.site.targets['hermes-config']!.resolver!.environment = { [name]: 'obviously-fake' };
    expect(settingsTargetsSchema.safeParse(f.site).success).toBe(false);
  }
});

it('uses owner trust only when the resolver runs as its non-root target owner', async () => {
  const f = await fixture();
  f.site.targets['hermes-config']!.runAs.uid = 1234;
  const { trustedOwnerExecutable, trustedExecutable } = await import('../src/trust.js');
  vi.mocked(trustedOwnerExecutable).mockClear(); vi.mocked(trustedExecutable).mockClear();
  const uid = vi.spyOn(process, 'getuid').mockReturnValue(1234);
  await resolveHermesConfig(f.site, READ_VIEWS['hermes.safety']);
  expect(trustedOwnerExecutable).toHaveBeenCalledTimes(2);
  expect(trustedOwnerExecutable).toHaveBeenCalledWith(f.site.targets['hermes-config']!.resolver!.python, 1234);
  expect(trustedExecutable).not.toHaveBeenCalled();
  uid.mockReturnValue(0);
  await resolveHermesConfig(f.site, READ_VIEWS['hermes.safety']);
  expect(trustedExecutable).toHaveBeenCalledTimes(2);
  expect(trustedOwnerExecutable).toHaveBeenCalledTimes(2);
});
