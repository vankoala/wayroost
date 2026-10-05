import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { executeConfig, configErrorCode, reserveConfigBackupId, validateInstalledPaseo, type ExecutorDependencies, type ExecutorRequest } from '../src/config-executor.js';
import { configOperations, resolveKey } from '../src/config-operations.js';
import { readConfigToml } from '../src/config-toml.js';
import { checkConfigDirectory, ConfigError, digest, loadSettingsTargets } from '../src/config-paths.js';
import { withConsumerLock, withPiConfigLock } from '../src/config-locks.js';
import { settingsTargetsSchema, type SettingsTargets } from '../../shared/settings-targets.js';
import { configWriteResultSchema, type ConfigWriteResult } from '../../shared/supervisor-config.js';
import { SettingsWriteError } from '../../server/src/settings/write-through.js';

vi.mock('../src/config-hermes.js', () => ({ resolveHermesConfig: async (site: import('../../shared/settings-targets.js').SettingsTargets) => {
  const { readFile } = await import('node:fs/promises');
  const { yamlEditor } = await import('../../server/src/settings/editors/yaml.js');
  return yamlEditor.parse(await readFile(site.targets['hermes-config']!.path, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '{}';
    throw error;
  }));
} }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const roots: string[] = [];
const uid = process.getuid!();
const lock: NonNullable<ExecutorDependencies['lock']> = (target, work) => withConsumerLock(target, work, async path => path);
const execute = (input: unknown, dependencies: ExecutorDependencies = {}) => executeConfig(input, { lock, ...dependencies });

it.each([
  '[[demo]]\n[demo]',
  '[[demo]]\n[other]\n[demo]',
  'demo = [{ nested = {} }]\n[demo.nested]',
  'demo = [{ nested = {} }]\n[[demo.nested.items]]',
  'demo = [2000-01-01]\n[demo.nested]',
  '[[demo]]\n[other]\ndemo.entry = true\n[other.demo]',
  '[demo]\n[[demo]]',
  '[[demo]]\n[demo.nested]\n[demo.nested]',
  'updated = 2000-01-01\n[updated]',
  '[demo.nested]\nflag = true\n[demo]\nnested.other = false',
])('rejects conflicting TOML table declarations: %s', source => {
  expect(() => readConfigToml('approval_policy = "never"\n' + source)).toThrow('parse_failed');
});

it.each([
  '[[demo]]\n[demo.nested]\nflag = true\n[[demo]]\n[demo.nested]\nflag = false',
  '[demo.nested]\nflag = true\n[demo]\nname = "example"',
  '[[demo]]\n[[demo.nested]]\nflag = true\n[[demo.nested]]\nflag = false',
  'demo.nested.flag = true\ndemo.nested.other = false\n[demo.sibling]\nflag = true',
])('accepts implicit parents and nested TOML table arrays: %s', source => {
  expect(readConfigToml('approval_policy = "never"\n' + source)).toEqual({ approval_policy: 'never' });
});
beforeEach(() => {
  vi.mocked(fs.open).mockImplementation(actual.open);
  vi.mocked(fs.lstat).mockImplementation(async (path, options) => {
    const stat = await actual.lstat(path, options);
    if (String(path) === '/') stat.uid = typeof stat.uid === 'bigint' ? 0n : 0;
    return stat;
  });
});
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(targetId: 'hermes-config' | 'pi-settings' | 'paseo-config' | 'pi-mcp' | 'wayroost-settings' = 'hermes-config', source?: string) {
  const root = await mkdtemp(join(process.cwd(), '.config-executor-test-'));
  roots.push(root);
  const path = join(root, targetId === 'hermes-config' ? 'config.yaml' : 'config.json');
  const format = targetId === 'hermes-config' ? 'yaml' : 'json';
  await writeFile(path, source ?? (format === 'yaml' ? '# settings\napprovals:\n  mode: smart\n' : '{"version":1}\n'), { mode: 0o600 });
  const lockKind = targetId === 'paseo-config' ? 'paseo' : targetId === 'pi-settings' ? 'pi' : 'file';
  const lockPath = path + (lockKind === 'paseo' ? '.wayroost.lock' : lockKind === 'pi' ? '.lock' : '.wayroost-settings.lock');
  const backupDir = join(root, 'backups'); const auditDir = join(root, 'audit');
  await mkdir(backupDir, { mode: 0o700 }); await mkdir(auditDir, { mode: 0o700 });
  const site = settingsTargetsSchema.parse({ version: 1, configWrites: true, targets: { [targetId]: {
    path, format, runAs: { user: 'me', uid }, mode: 0o600, backupDir, auditDir, lock: { kind: lockKind, path: lockPath },
    ...(targetId === 'paseo-config' ? { loader: '/opt/example/paseo-loader.js' } : {}),
  } } });
  const apply = (operation = 'hermes.approval-mode', params: unknown = { mode: 'manual' }, extra: object = {}): ExecutorRequest => ({
    verb: 'config.apply', caller: 'server', site, request: { requestId: randomUUID(), operation, params, ...extra },
  });
  return { root, path, site, targetId, lockPath, backupDir, auditDir, apply };
}
function written(result: ConfigWriteResult) {
  expect(configWriteResultSchema.safeParse(result).success).toBe(true);
  expect(result.ok).toBe(true);
  if (!result.ok || !('undo' in result)) throw new Error('expected an apply');
  return result;
}

describe('config executor', () => {
  it('uses the reserved backup bytes and mode through apply and undo', async () => {
    const f = await fixture(); const source = await readFile(f.path, 'utf8');
    await chmod(f.path, 0o640); f.site.targets['hermes-config']!.mode = 0o640;
    const backupId = reserveConfigBackupId(f.path); const mask = process.umask(0o077);
    try {
      const result = written(await execute({ ...f.apply(), backupId }) as ConfigWriteResult);
      expect(result.backupId).toBe(backupId); expect(result.undo.backupId).toBe(backupId);
      expect(await readFile(join(f.backupDir, 'files', backupId), 'utf8')).toBe(source);
      expect((await lstat(join(f.backupDir, 'files', backupId))).mode & 0o7777).toBe(0o640);
      const reverseId = reserveConfigBackupId(f.path);
      const undone = written(await execute({ site: f.site, caller: 'server', verb: 'config.undo', backupId: reverseId,
        request: { requestId: randomUUID(), token: result.undo }, undoProof: { ...result.undo, keys: result.keys } }) as ConfigWriteResult);
      expect(undone.backupId).toBe(reverseId); expect(undone.undo.backupId).toBe(reverseId);
      expect(await readFile(join(f.backupDir, 'files', reverseId), 'utf8')).toContain('mode: manual');
      expect(await readFile(f.path, 'utf8')).toBe(source);
      expect((await readdir(join(f.backupDir, 'files', digest(f.path)))).sort()).toEqual([basename(backupId), basename(reverseId)].sort());
    } finally { process.umask(mask); }
  });

  it.each(['other-target', 'traversal', 'existing'] as const)('refuses a reserved backup for %s before changing the target', async failure => {
    const f = await fixture(); const source = await readFile(f.path, 'utf8');
    const backupId = failure === 'other-target' ? reserveConfigBackupId('/home/me/other.yaml')
      : failure === 'traversal' ? '../backup.bak' : reserveConfigBackupId(f.path);
    if (failure === 'existing') {
      await mkdir(dirname(join(f.backupDir, 'files', backupId)), { recursive: true, mode: 0o700 });
      await writeFile(join(f.backupDir, 'files', backupId), 'existing backup', { mode: 0o600 });
    }
    expect(await execute({ ...f.apply(), backupId })).toEqual({ ok: false, code: failure === 'existing' ? 'failed' : 'invalid_parameters' });
    expect(await readFile(f.path, 'utf8')).toBe(source);
    if (failure === 'existing') expect(await readFile(join(f.backupDir, 'files', backupId), 'utf8')).toBe('existing backup');
  });

  it('retains the core backup after an audit failure without publishing an owner receipt', async () => {
    const f = await fixture();
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const file = await actual.open(path, flags, mode);
      if (basename(String(path)) === 'audit.jsonl') vi.spyOn(file, 'sync').mockRejectedValue(new Error('fake-storage-failure'));
      return file;
    });
    const result = await execute(f.apply());
    expect(result).toMatchObject({ ok: false, code: 'audit_unavailable', committed: true });
    if (result.ok || !('undo' in result)) throw new Error('expected a backup');
    expect(await readFile(join(f.backupDir, 'files', result.undo.backupId), 'utf8')).toContain('mode: smart');
    expect(await readFile(f.path, 'utf8')).toContain('mode: manual');
    expect(await readdir(f.auditDir)).toEqual(['audit.jsonl']);
  });

  it('round trips YAML with an absent key, preserving unrelated data, bytes, mode and backups', async () => {
    const source = '# settings\nterminal:\n  cwd: +.\nmodel:\n  default: example-model # keep\n';
    const f = await fixture('hermes-config', source);
    const result = written(await execute(f.apply('hermes.reasoning-effort', { effort: 'high' })) as ConfigWriteResult);
    expect(await readFile(f.path, 'utf8')).toContain('reasoning_effort: high');
    expect(await readFile(f.path, 'utf8')).toContain('default: example-model # keep');
    expect((await lstat(f.path)).mode & 0o7777).toBe(0o600);
    expect(await readFile(join(f.backupDir, 'files', result.backupId), 'utf8')).toBe(source);
    expect(result.backupSha256).toBe(digest(source));
    const proof = { ...result.undo, keys: result.keys };
    const undone = await execute({ site: f.site, verb: 'config.undo', caller: 'server', request: { requestId: randomUUID(), token: result.undo }, undoProof: proof });
    expect(undone.ok).toBe(true);
    expect(await readFile(f.path, 'utf8')).toBe(source);
    const audit = await readFile(join(f.auditDir, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('reasoning_effort');
    expect(audit).not.toContain('example-model'); expect(audit).not.toContain('"value"');
  });

  it('reads only the named view and returns content hashes even while writes are off', async () => {
    const f = await fixture('hermes-config', 'approvals:\n  mode: manual\nmcp_servers:\n  demo:\n    headers:\n      Authorization: fake-sensitive-header\n');
    f.site.configWrites = false;
    const result = await execute({ site: f.site, caller: 'server', verb: 'config.read', request: { view: 'hermes.safety' } });
    expect(result).toMatchObject({ ok: true, present: true, sha256: digest(await readFile(f.path)), values: expect.arrayContaining([{ path: ['approvals', 'mode'], exists: true, value: 'manual' }]) });
    expect(JSON.stringify(result)).not.toContain('fake-sensitive-header');
    expect(await readdir(f.backupDir)).toEqual([]); expect(await readdir(f.auditDir)).toEqual([]);
    expect(await execute(f.apply())).toEqual({ ok: false, code: 'config_writes_off' });
    expect(await execute({ site: f.site, caller: 'server', verb: 'config.undo', request: {} })).toEqual({ ok: false, code: 'config_writes_off' });
  });

  it('returns an absent target without creating it', async () => {
    const f = await fixture(); await rm(f.path);
    expect(await execute({ site: f.site, caller: 'server', verb: 'config.read', request: { view: 'hermes.safety' } })).toMatchObject({ ok: true, view: 'hermes.safety', present: false, effective: true });
    expect(await execute(f.apply())).toEqual({ ok: false, code: 'target_missing' });
  });

  it.each(['file', 'parent'] as const)('returns absent pi settings before taking a lock when the %s is missing', async missing => {
    const f = await fixture('pi-settings');
    await rm(f.path);
    const target = f.site.targets['pi-settings']!;
    if (missing === 'parent') {
      target.path = join(f.root, 'missing', 'settings.json');
      target.lock.path = target.path + '.lock';
    } else await mkdir(f.lockPath);
    const locking = vi.fn();
    expect(await execute({ site: f.site, caller: 'server', verb: 'config.read', request: { view: 'pi.settings' } },
      { lock: (target, work) => { locking(); return lock(target, work); } }))
      .toEqual({ ok: true, view: 'pi.settings', present: false, values: [] });
    expect(locking).not.toHaveBeenCalled();
    if (missing === 'parent') await expect(lstat(dirname(target.path))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['config.read', { view: 'hermes.safety', path: '/home/me/config.yaml' }],
    ['config.read', { view: 'unknown' }],
    ['config.apply', { requestId: randomUUID(), operation: 'hermes.approval-mode', params: { mode: 'manual' }, command: 'echo example' }],
    ['config.undo', { requestId: randomUUID(), token: { operation: 'hermes.approval-mode', target: 'hermes-config', backupId: '../backup', backupSha256: 'a'.repeat(64), writtenSha256: 'b'.repeat(64) } }],
  ])('refuses extra or malformed fields for %s', async (verb, request) => {
    const f = await fixture();
    expect(await execute({ site: f.site, caller: 'server', verb, request })).toEqual({ ok: false, code: 'invalid_parameters' });
  });

  it.each([
    ['not.known', {}, 'unknown_operation'], ['hermes.approval-mode', { mode: 'other' }, 'invalid_parameters'],
    ['hermes.approval-mode', { mode: 'manual', key: 'other' }, 'invalid_parameters'], ['pi.default-move', {}, 'not_permitted'],
  ])('validates the catalogue operation %s', async (operation, params, code) => {
    const f = await fixture(); expect(await execute(f.apply(operation, params))).toEqual({ ok: false, code });
  });

  it('checks file and key preconditions and ignores unrelated keys', async () => {
    const f = await fixture();
    expect(await execute(f.apply(undefined, undefined, { preconditions: { file: { sha256: '0'.repeat(64) } } }))).toEqual({ ok: false, code: 'precondition_changed' });
    expect(await execute(f.apply(undefined, undefined, { preconditions: { keys: [{ key: 0, value: 'manual' }] } }))).toEqual({ ok: false, code: 'precondition_changed' });
    expect(await execute(f.apply(undefined, undefined, { preconditions: { keys: [{ key: 1, exists: false }] } }))).toEqual({ ok: false, code: 'invalid_parameters' });
    expect((await execute(f.apply(undefined, undefined, { preconditions: { keys: [{ key: 0, value: 'smart' }] } }))).ok).toBe(true);
  });

  it('refuses undo after outside edits and checks the root audit proof and backup bytes', async () => {
    const f = await fixture(); const result = written(await execute(f.apply()) as ConfigWriteResult);
    const undo = { site: f.site, caller: 'server', verb: 'config.undo', request: { requestId: randomUUID(), token: result.undo }, undoProof: { ...result.undo, keys: result.keys } };
    expect(await execute({ ...undo, undoProof: undefined })).toEqual({ ok: false, code: 'backup_mismatch' });
    const saved = await readFile(f.path, 'utf8');
    await writeFile(f.path, 'approvals:\n  mode: off\n');
    expect(await execute(undo)).toEqual({ ok: false, code: 'undo_changed' });
    expect(await readFile(f.path, 'utf8')).toContain('mode: off');
    await writeFile(f.path, saved); await writeFile(join(f.backupDir, 'files', result.backupId), 'approvals:\n  mode: off\n');
    expect(await execute(undo)).toEqual({ ok: false, code: 'backup_mismatch' });
  });

  it('expires old completed backups under the lock while preserving unresolved recovery', async () => {
    const f = await fixture(); const result = written(await execute(f.apply()) as ConfigWriteResult);
    const folder = join(f.backupDir, 'files', dirname(result.backupId));
    const old = String(Date.now() - 31 * 24 * 60 * 60 * 1000).padStart(16, '0') + basename(result.backupId).slice(16);
    const pinned = String(Date.now() - 32 * 24 * 60 * 60 * 1000).padStart(16, '0') + basename(result.backupId).slice(16);
    await writeFile(join(folder, old), 'approvals:\n  mode: smart\n', { mode: 0o600 });
    await writeFile(join(folder, pinned), 'approvals:\n  mode: smart\n', { mode: 0o600 });
    await writeFile(join(folder, `${pinned}.recovery.json`), '{}\n', { mode: 0o600 });
    expect((await execute(f.apply(undefined, { mode: 'off' }))).ok).toBe(true);
    const names = await readdir(folder);
    expect(names).not.toContain(old); expect(names).toContain(pinned); expect(names).toContain(`${pinned}.recovery.json`);
  });

  it('uses pi\'s shared read lock and refuses moves without a record executor', async () => {
    const f = await fixture('pi-settings', '{"other":true}\n');
    const input = { ...f.apply('pi.default-move', {}), caller: 'launcher' };
    await mkdir(f.lockPath);
    expect(await execute(input)).toEqual({ ok: false, code: 'not_configured' });
    expect(await execute({ site: f.site, caller: 'server', verb: 'config.read', request: { view: 'pi.settings' } })).toEqual({ ok: false, code: 'locked' });
    await rm(f.lockPath, { recursive: true });
    expect(await execute(input)).toEqual({ ok: false, code: 'not_configured' });
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual({ other: true });
    expect(await readdir(f.backupDir)).toEqual([]);
    expect(await readdir(f.auditDir)).toEqual([]);
    expect(await lstat(f.lockPath).catch(() => undefined)).toBeUndefined();
    await expect(withPiConfigLock(f.lockPath, async () => { throw new ConfigError('consumer_refused'); })).rejects.toMatchObject({ code: 'consumer_refused' });
    expect(await lstat(f.lockPath).catch(() => undefined)).toBeUndefined();
  });

  it.each([
    ['hermes.prompt-keys-move', { toolUseEnforcement: true, executionGuidance: true, reasoningEcho: true }],
    ['hermes.coder-mcp-path', {}], ['pi.coder-mcp-path', {}], ['paseo.profile-move', { profile: 'demo' }],
  ])('refuses %s before translating edits that require durable records', async (operation, params) => {
    const f = await fixture();
    expect(() => configOperations(operation, params, 'launcher', {}, f.site)).toThrow('not_configured');
    expect(await readdir(f.backupDir)).toEqual([]);
  });

  it('reads only root Codex approval fields from configured TOML', async () => {
    const f = await fixture();
    const path = join(f.root, 'settings.toml');
    const source = 'approval_policy = "on-request" # keep\nsandbox_mode = \'workspace-write\'\nmodel = "example"\n[profiles.demo]\napproval_policy = "never"\n';
    await writeFile(path, source, { mode: 0o600 });
    const site = settingsTargetsSchema.parse({ version: 1, targets: { 'codex-config': { path, runAs: { user: 'me', uid }, format: 'toml' } } });
    const read = () => execute({ site, caller: 'server', verb: 'config.read', request: { view: 'codex.approvals' } });
    expect(await read()).toEqual({ ok: true, view: 'codex.approvals', present: true, sha256: digest(source), values: [
      { path: ['approval_policy'], exists: true, value: 'on-request' }, { path: ['sandbox_mode'], exists: true, value: 'workspace-write' },
    ] });
    await writeFile(path, 'model = "example"\n[profiles.demo]\napproval_policy = "never"\n');
    expect(await read()).toMatchObject({ ok: true, values: [{ path: ['approval_policy'], exists: false }, { path: ['sandbox_mode'], exists: false }] });
    await writeFile(path, '"approval_policy" = "never"\nmodel = """\napproval_policy = \'untrusted\'\n"""\nfeatures = { demo = true }\n[profiles.demo]\nargs = [\n"example", # keep\n"value",\n]\n');
    expect(await read()).toMatchObject({ ok: true, values: [{ path: ['approval_policy'], exists: true, value: 'never' }, { path: ['sandbox_mode'], exists: false }] });
    for (const malformed of ['approval_policy = "unterminated', 'approval_policy = "never"\napproval_policy = "untrusted"', '[broken', 'model = ["demo"', 'approval_policy = 123', 'sandbox_mode = false',
      'features = { demo = true }\n[features]\nother = true', 'updated = 2025-99-99', 'updated = 2025-01-01T25:00:00Z', 'features = []\n[[features]]']) {
      await writeFile(path, malformed);
      expect(await read()).toEqual({ ok: false, code: 'parse_failed' });
    }
    await rm(path);
    expect(await read()).toEqual({ ok: true, view: 'codex.approvals', present: false, values: [] });
  });

  it.each([
    '# comment\x00\n', '# comment\x7f\n', 'model = "example" # comment\x01',
    'args = ["example", # comment\x0b\n]\n', '# comment\r', '# comment\rnext\n',
    '\rmodel = "example"\n', 'args = [\r"example"]\n',
    'model = """example\rtext"""\n', "model = '''example\rtext'''\n",
    'model = """\rexample"""\n', 'model = """example\\\r \ntext"""\n',
  ])('refuses forbidden TOML characters and bare carriage returns: %j', async source => {
    const f = await fixture(); const path = join(f.root, 'settings.toml');
    await writeFile(path, 'approval_policy = "never"\n' + source, { mode: 0o600 });
    const site = settingsTargetsSchema.parse({ version: 1, targets: { 'codex-config': { path, runAs: { user: 'me', uid }, format: 'toml' } } });
    expect(await execute({ site, caller: 'server', verb: 'config.read', request: { view: 'codex.approvals' } })).toEqual({ ok: false, code: 'parse_failed' });
  });

  it('accepts TOML tabs, CRLFs and escaped control characters', () => {
    expect(readConfigToml('approval_policy = "never" # comment\t\r\n'
      + 'model = """\r\nexample\r\ntext\\\r\n  continued"""\r\n'
      + "literal = '''\r\nexample\r\ntext'''\r\n"
      + 'escaped = "\\u0000\\u007f\\r"\r\n'
      + 'args = [\r\n"example", # comment\t\r\n]\r\n')).toEqual({ approval_policy: 'never' });
  });

  it.each([
    ['windows-hermes', 'windows-hermes.models', true, 0o777],
    ['hermes-managed', 'hermes.managed', false, 0o644],
  ] as const)('reads the explicit root-owned %s shape through a descriptor', async (target, view, drvfs, mode) => {
    const f = await fixture();
    const site = settingsTargetsSchema.parse({ version: 1, targets: { [target]: { path: f.path, runAs: { user: 'me', uid }, format: 'yaml', drvfs } } });
    vi.mocked(fs.open).mockImplementation(async (path, flags, fileMode) => {
      const file = await actual.open(path, flags, fileMode);
      if (String(path) === f.path) {
        const original = file.stat.bind(file);
        file.stat = (async () => { const stat = await original(); stat.uid = 0; stat.gid = 0; stat.mode = 0o100000 | mode; return stat; }) as typeof file.stat;
      }
      return file;
    });
    const read = () => execute({ site, caller: 'server', verb: 'config.read', request: { view } });
    expect((await read()).ok).toBe(true);
    await rm(f.path); await symlink(join(f.root, 'elsewhere'), f.path);
    expect(await read()).toEqual({ ok: false, code: 'unsafe_target' });
  });

  it.each([
    ['windows-hermes', 'windows-hermes.models', true, uid + 1, 0, 0o777, 1],
    ['windows-hermes', 'windows-hermes.models', true, 0, uid + 1, 0o777, 1],
    ['windows-hermes', 'windows-hermes.models', true, 0, 0, 0o777, 2],
    ['windows-hermes', 'windows-hermes.models', false, 0, 0, 0o777, 1],
    ['hermes-managed', 'hermes.managed', false, 0, 0, 0o666, 1],
  ] as const)('retains read-only ownership and hard-link refusals for %s', async (target, view, drvfs, owner, group, mode, links) => {
    const f = await fixture();
    const site = settingsTargetsSchema.parse({ version: 1, targets: { [target]: { path: f.path, runAs: { user: 'me', uid }, format: 'yaml', drvfs } } });
    vi.mocked(fs.open).mockImplementation(async (path, flags, fileMode) => {
      const file = await actual.open(path, flags, fileMode);
      if (String(path) === f.path) {
        const original = file.stat.bind(file);
        file.stat = (async () => { const stat = await original(); stat.uid = owner; stat.gid = group; stat.mode = 0o100000 | mode; stat.nlink = links; return stat; }) as typeof file.stat;
      }
      return file;
    });
    expect(await execute({ site, caller: 'server', verb: 'config.read', request: { view } })).toEqual({ ok: false, code: 'unsafe_target' });
  });

  it('refuses mismatched lock locations and honors the core\'s lock', async () => {
    const f = await fixture();
    f.site.targets['hermes-config']!.lock.path += '-other';
    expect(await execute(f.apply())).toEqual({ ok: false, code: 'unsafe_target' });
    f.site.targets['hermes-config']!.lock.path = f.lockPath;
    const stat = await lstat(f.path);
    const sharedLock = `${f.path}.wayroost-settings.lock`;
    await mkdir(sharedLock);
    expect(await execute(f.apply())).toEqual({ ok: false, code: 'locked' });
    expect((await lstat(f.path)).ino).toBe(stat.ino);
  });

  it('checks uid, mode, symlinks and parse failures with fixed codes', async () => {
    const f = await fixture();
    expect(await execute(f.apply(), { uid: uid + 1 })).toEqual({ ok: false, code: 'unsafe_target' });
    await chmod(f.path, 0o644); expect(await execute(f.apply())).toEqual({ ok: false, code: 'unsafe_target' });
    await chmod(f.path, 0o600); await writeFile(f.path, 'broken: [');
    expect(await execute(f.apply())).toEqual({ ok: false, code: 'parse_failed' });
    await rm(f.path); await symlink(join(f.root, 'elsewhere'), f.path);
    expect(await execute(f.apply())).toEqual({ ok: false, code: 'unsafe_target' });
  });
});

describe('directory preflight', () => {
  it('checks target, backup and audit ancestors and permits missing private storage', async () => {
    const f = await fixture();
    await expect(checkConfigDirectory(join(f.root, 'missing', 'backup'), uid, true)).resolves.toBeUndefined();
    for (const directory of [f.root, f.backupDir, f.auditDir]) {
      await chmod(directory, 0o770);
      expect(await execute(f.apply())).toEqual({ ok: false, code: 'unsafe_directory' });
      await chmod(directory, 0o700);
    }
    await rm(f.backupDir, { recursive: true }); await symlink(f.auditDir, f.backupDir);
    expect(await execute(f.apply())).toEqual({ ok: false, code: 'unsafe_directory' });
  });

  it('walks to root and rejects a third owner even on a read', async () => {
    const f = await fixture();
    vi.mocked(fs.lstat).mockImplementation(async (path, options) => {
      const stat = await actual.lstat(path, options);
      if (String(path) === '/') stat.uid = typeof stat.uid === 'bigint' ? 0n : 0;
      if (String(path) === f.root) stat.uid = typeof stat.uid === 'bigint' ? BigInt(uid + 1) : uid + 1;
      return stat;
    });
    expect(await execute({ site: f.site, caller: 'server', verb: 'config.read', request: { view: 'hermes.safety' } })).toEqual({ ok: false, code: 'unavailable' });
    expect(vi.mocked(fs.lstat).mock.calls.map(args => args[0])).toContain(f.root);
  });
});

describe('Paseo loader and lock', () => {
  const provider = z.object({ enabled: z.boolean().optional() }).strict();
  const schema = z.object({ version: z.literal(1), providers: z.object({ local: z.object({}).strict().optional(), openai: z.object({}).strict().optional() }).strict().optional(),
    daemon: z.object({ appendSystemPrompt: z.string().optional(), agentProfiles: z.array(z.object({ id: z.string(), model: z.string() }).strict()).optional() }).strict().optional(),
    agents: z.object({ providers: z.record(z.string(), provider) }).strict().optional() }).strict();
  const faithfulValidator: ExecutorDependencies['validatePaseo'] = async source => {
    const parsed = JSON.parse(source);
    // Removed fields are stripped before the persisted document's strict schema.
    delete parsed.providers?.local?.autoDownload;
    delete parsed.providers?.openai?.voice;
    schema.parse(parsed);
  };
  it('validates the whole edited document after stripping removed fields, before any backup', async () => {
    const f = await fixture('paseo-config', '{"version":1,"providers":{"local":{"autoDownload":true},"openai":{"voice":{"model":"example"}}}}\n');
    const validate = vi.fn(faithfulValidator);
    expect((await execute(f.apply('paseo.provider-enabled', { provider: 'codex', enabled: false }), { validatePaseo: validate })).ok).toBe(true);
    expect(validate).toHaveBeenCalledTimes(1);
    await writeFile(f.path, '{"version":1,"unknown":"fake-private-text"}\n');
    const before = await readdir(f.backupDir);
    expect(await execute(f.apply('paseo.provider-enabled', { provider: 'codex', enabled: true }), { validatePaseo: validate })).toEqual({ ok: false, code: 'consumer_refused' });
    expect(await readdir(f.backupDir)).toEqual(before);
    expect(await lstat(f.lockPath)).toMatchObject({ uid });
    await expect(lock(f.site.targets['paseo-config']!, async () => 1)).resolves.toBe(1);
  });

  it('resolves profile ids once, rejects ambiguity and validates backups on undo', async () => {
    const f = await fixture('paseo-config', '{"version":1,"daemon":{"agentProfiles":[{"id":"demo","model":"example/old"}]}}\n');
    expect(resolveKey(['daemon', 'agentProfiles', { id: 'demo' }, 'model'], JSON.parse(await readFile(f.path, 'utf8')))).toEqual(['daemon', 'agentProfiles', 0, 'model']);
    expect(await execute(f.apply('paseo.profile-model', { profile: 'demo', model: 'example/new' }), { validatePaseo: faithfulValidator })).toEqual({ ok: false, code: 'not_configured' });
    const result = written(await execute(f.apply('paseo.provider-enabled', { provider: 'codex', enabled: false }), { validatePaseo: faithfulValidator }) as ConfigWriteResult);
    const validate = vi.fn(async () => { throw new Error('fake-private-text'); });
    expect(await execute({ site: f.site, caller: 'server', verb: 'config.undo', request: { requestId: randomUUID(), token: result.undo }, undoProof: { ...result.undo, keys: result.keys } }, { validatePaseo: validate })).toEqual({ ok: false, code: 'consumer_refused' });
    expect(JSON.parse(await readFile(f.path, 'utf8')).agents.providers.codex.enabled).toBe(false);
    await writeFile(f.path, '{"version":1,"daemon":{"agentProfiles":[{"id":"demo","model":"example/old"},{"id":"demo","model":"example/old"}]}}\n');
    expect(() => resolveKey(['daemon', 'agentProfiles', { id: 'demo' }, 'model'], JSON.parse('{"daemon":{"agentProfiles":[{"id":"demo"},{"id":"demo"}]}}'))).toThrow('precondition_changed');
  });

  it('does not use a protocol fallback when the installed loader is untrusted', async () => {
    const f = await fixture('paseo-config');
    await expect(validateInstalledPaseo('{}', f.site.targets['paseo-config']!)).rejects.toMatchObject({ code: 'consumer_refused' });
  });
});

describe('fixed operation translation', () => {
  it.each([
    ['hermes.reasoning-effort', { effort: 'high' }, ['agent', 'reasoning_effort'], 'high'],
    ['hermes.personality', { personality: 'concise' }, ['display', 'personality'], 'concise'],
    ['hermes.delegation-limits', { maxConcurrentChildren: 3, maxIterations: 4 }, ['delegation', 'max_concurrent_children'], 3],
    ['hermes.main-fallbacks', { chain: [] }, ['fallback_providers'], []],
    ['hermes.skill-staging', { enabled: true }, ['skills', 'write_approval'], true],
    ['wayroost.safety-commands', { enabled: true }, ['safetyCommandsEnabled'], true],
  ])('translates %s into only its catalogue keys', async (operation, params, path, value) => {
    const f = await fixture();
    expect(configOperations(operation, params, 'server', {}, f.site).operations[0]).toEqual({ type: 'set', path, value });
  });
  it.each([
    ['hermes.default-model', { provider: 'example', model: 'demo', baseUrl: 'http://127.0.0.1:8891/v1' }],
    ['hermes.delegation-model', { provider: 'example', model: 'demo' }],
    ['hermes.helper-model', { task: 'compression', provider: 'example', model: 'demo' }],
    ['hermes.delegation-fallbacks', { chain: [] }],
  ])('refuses %s until its intended state can also be recorded', async (operation, params) => {
    const f = await fixture();
    expect(await execute(f.apply(operation, params))).toEqual({ ok: false, code: 'not_configured' });
    expect(await readdir(f.backupDir)).toEqual([]);
    expect(await readdir(f.auditDir)).toEqual([]);
  });
  it('removes empty routing notes and hashes allowlist entries', async () => {
    const f = await fixture();
    expect(configOperations('paseo.routing-note', { text: '' }, 'server', {}, f.site).operations).toEqual([{ type: 'delete', path: ['daemon', 'appendSystemPrompt'] }]);
    expect(configOperations('hermes.revoke-always', { entrySha256: digest('example command') }, 'server', { command_allowlist: ['example command', 'keep'] }, f.site).operations).toEqual([{ type: 'set', path: ['command_allowlist'], value: ['keep'] }]);
  });
});

it('loads only a trusted, strictly parsed site file and defaults writes off', async () => {
  const f = await fixture(); const path = join(f.root, 'settings-targets.json');
  await writeFile(path, JSON.stringify({ version: 1, targets: {} }));
  const trust = vi.fn(async (at: string) => at);
  expect((await loadSettingsTargets(path, trust)).configWrites).toBe(false);
  expect(trust).toHaveBeenCalledWith(path);
  await writeFile(path, JSON.stringify({ version: 1, targets: {}, command: 'echo example' }));
  await expect(loadSettingsTargets(path, trust)).rejects.toMatchObject({ code: 'unsafe_target' });
});

it('maps upstream errors to fixed public codes only', () => {
  for (const [internal, code] of Object.entries({ changed_underneath: 'precondition_changed', verification_failed: 'verify_mismatch', invalid_backup: 'backup_mismatch', audit_failed: 'audit_unavailable', metadata_mismatch: 'unsafe_target', unsupported_yaml: 'parse_failed' })) {
    expect(configErrorCode(new SettingsWriteError(internal, 'fake-private-text'))).toBe(code);
  }
  expect(configErrorCode(new Error('fake-private-text'))).toBe('failed');
});


it.each(['["echo keep", "echo remove"]', '- echo keep\n- echo remove\n'])('revokes from a scalar YAML sequence and verifies its normalized list', async scalar => {
  const f = await fixture('hermes-config', `# keep\ncommand_allowlist: ${JSON.stringify(scalar)}\nunrelated: example # untouched\n`);
  const before = await readFile(f.path, 'utf8');
  const result = written(configWriteResultSchema.parse(await execute(f.apply('hermes.revoke-always', { entrySha256: digest('echo remove') }))));
  const source = await readFile(f.path, 'utf8');
  expect(source).toContain('echo keep'); expect(source).not.toContain('echo remove');
  expect(source).toContain('unrelated: example # untouched');
  expect(await execute({ site: f.site, caller: 'server', verb: 'config.read', request: { view: 'hermes.safety' } })).toMatchObject({
    ok: true, values: expect.arrayContaining([{ path: ['command_allowlist'], exists: true, value: ['echo keep'] }]),
  });
  written(configWriteResultSchema.parse(await execute({ site: f.site, caller: 'server', verb: 'config.undo', request: { requestId: randomUUID(), token: result.undo },
    undoProof: { ...result.undo, keys: result.keys } })));
  expect(await readFile(f.path, 'utf8')).toBe(before);
});

it.each(['echo example', '[1]', '{example: command}', '*missing'])('refuses an invalid scalar allowlist without touching its file: %s', async scalar => {
  const f = await fixture('hermes-config', `command_allowlist: ${JSON.stringify(scalar)}\n`);
  const before = await readFile(f.path, 'utf8');
  expect(await execute(f.apply('hermes.revoke-always', { entrySha256: digest('echo example') }))).toMatchObject({ ok: false, code: 'precondition_changed' });
  expect(await readFile(f.path, 'utf8')).toBe(before);
});

it.each([false, true])('revokes the persisted variable expression without expanding it (scalar: %s)', async scalar => {
  const entries = ['echo ${EXAMPLE_PATH}', 'echo keep'];
  const f = await fixture('hermes-config', 'command_allowlist: ' + (scalar ? JSON.stringify(JSON.stringify(entries)) : JSON.stringify(entries)) + '\n');
  const before = await readFile(f.path, 'utf8');
  expect(await execute(f.apply('hermes.revoke-always', { entrySha256: digest('echo /tmp/example') }))).toMatchObject({ ok: false, code: 'precondition_changed' });
  expect(await readFile(f.path, 'utf8')).toBe(before);
  const result = written(configWriteResultSchema.parse(await execute(f.apply('hermes.revoke-always', { entrySha256: digest('echo ${EXAMPLE_PATH}') }))));
  expect(await readFile(f.path, 'utf8')).not.toContain('EXAMPLE_PATH');
  expect(await readFile(f.path, 'utf8')).toContain('echo keep');
  written(configWriteResultSchema.parse(await execute({ site: f.site, caller: 'server', verb: 'config.undo',
    request: { requestId: randomUUID(), token: result.undo }, undoProof: { ...result.undo, keys: result.keys } })));
  expect(await readFile(f.path, 'utf8')).toBe(before);
});
