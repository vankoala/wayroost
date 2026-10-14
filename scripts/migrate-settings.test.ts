import * as fs from 'node:fs/promises';
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { migrateSettings, runMigrationCli, effectiveSettings, type MigrationDependencies, type MigrationOptions } from './migrate-settings.js';
import { settingsTargetsSchema } from '../shared/settings-targets.js';
import { WORKER_APPROVAL_TOOLS } from '../shared/safety.js';
import { wayroostSettingsSchema } from '../shared/wayroost-settings.js';
import { withConsumerLock } from '../supervisor/src/config-locks.js';
import { ConfigError, digest } from '../supervisor/src/config-paths.js';
import { NotificationSettingsStore } from '../server/src/notifications/settings.js';
import { FeedStore } from '../server/src/feed/store.js';
import { SafetyCommandsSetting } from '../server/src/hermes/safety.js';
import { WorkerUpdatesSetting } from '../server/src/tasks/setting.js';
import { VoiceSetting } from '../server/src/voice-setting.js';
import { WorkerApprovalsSetting } from '../server/src/paseo/safety-setting.js';
import { undoApprovalsToMe } from '../server/src/paseo/safety-config.js';
import { parseConfig, loadConfig } from '../server/src/config.js';

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, lstat: async (path: Parameters<typeof actual.lstat>[0], options?: unknown) => {
    const info = await actual.lstat(path, options as undefined);
    if (String(path) === '/') Object.defineProperty(info, 'uid', { value: typeof info.uid === 'bigint' ? 0n : 0 });
    return info;
  } };
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const save = async (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const savedDocument = async (f: Awaited<ReturnType<typeof fixture>>, name: string) => {
  const reference = (await read(f.receiptPath)).snapshots[name];
  return reference === null ? {} : read(join(f.options.site.targets['wayroost-settings']!.backupDir, 'migration-snapshots', reference.sha256));
};
const uid = process.getuid!();
const policy = { disabledTools: ['kill_agent', ...WORKER_APPROVAL_TOOLS], enabled: true, futurePolicy: { mode: 'example' } };
const allProviders = () => Object.fromEntries(['claude', 'codex', 'copilot', 'opencode', 'pi', 'omp', 'custom', 'coder-lead', 'coder-worker', 'reviewer'].map(id => [id, {
  ...(id === 'custom' || id.startsWith('coder-') || id === 'reviewer' ? { extends: 'pi', label: 'Example provider' } : {}),
  ...(id === 'claude' ? { enabled: false } : id === 'opencode' ? { enabled: true } : {}),
  paseoTools: id === 'coder-worker' || id === 'reviewer' ? { enabled: false, disabledTools: ['delete_agent'] } : structuredClone(policy),
}]));

async function fixture(empty = false, samePaseo = false) {
  const root = await mkdtemp(join(process.cwd(), '.migration-test-')); roots.push(root);
  const legacyDir = join(root, 'legacy'); await mkdir(legacyDir, { mode: 0o700 });
  const targets: Record<string, unknown> = {};
  for (const id of ['paseo-config', 'wayroost-settings']) {
    const path = join(root, `${id}.json`); const backupDir = join(root, `${id}-backups`); const auditDir = join(root, `${id}-audit`);
    await mkdir(backupDir, { mode: 0o700 }); await mkdir(auditDir, { mode: 0o700 });
    targets[id] = { path, backupDir, auditDir, runAs: { user: 'me', uid }, mode: 0o600, format: 'json',
      lock: { kind: id === 'paseo-config' ? 'paseo' : 'file', path: `${path}${id === 'paseo-config' ? '.wayroost.lock' : '.wayroost-settings.lock'}` },
      ...(id === 'paseo-config' ? { loader: '/opt/example/loader.js' } : {}),
    };
  }
  const site = settingsTargetsSchema.parse({ version: 1, configWrites: true, targets });
  const ownerPath = site.targets['wayroost-settings']!.path; const paseoPath = site.targets['paseo-config']!.path;
  const legacyPaseo = samePaseo ? paseoPath : join(root, 'legacy-paseo.json');
  const legacyConfig = join(root, 'legacy-config.json');
  await save(paseoPath, { unrelated: 'keep-target', agents: { other: 'keep-agent', providers: {} } });
  await save(legacyPaseo, { unrelated: 'keep-legacy', agents: { providers: empty ? {} : allProviders() } });
  await save(legacyConfig, { role: 'primary', publicOrigin: 'https://example.com', feed: { enabled: true }, notifications: empty ? {} : { timeZone: 'Etc/UTC' } });
  if (!empty) {
    await save(join(legacyDir, 'wayroost-settings.json'), { rules: [
      { event: 'agent-needs-you', source: '*', delivery: 'toast' }, { event: 'agent-finished', source: 'paseo', delivery: 'toast' },
    ], quietHours: null, push: { approvals: false, cards: true } });
    await save(join(legacyDir, 'hermes-safety-commands.json'), { enabled: true });
    await save(join(legacyDir, 'worker-updates.json'), { enabled: false, defaultMinutes: 30, untouched: 'keep-worker' });
    await save(join(legacyDir, 'voice.json'), { version: 2, voice: 'af_heart', appReadAloud: { provider: 'elevenlabs', voiceId: 'fakevoice', modelId: 'fakemodel' } });
    await save(join(legacyDir, 'feed.json'), { cards: [{ key: 'mail:fake', title: 'Example', status: 'done' }], notified: ['fake-approval'],
      settings: { level: 'low', quietHours: { start: '22:00', end: '08:00' }, push: { approvals: true, cards: false }, lessLike: [{ topic: 'Example', example: 'Invented card', at: 1 }], untouched: 'keep-feed' } });
    await save(join(legacyDir, 'worker-approvals.json'), { version: 1, enabled: true, reloadPending: false,
      backup: { claude: { entry: 'existing', before: { disabledTools: ['kill_agent', 'update_agent'] }, applied: policy } } });
  }
  const lock = vi.fn<NonNullable<MigrationDependencies['lock']>>((target, work) => withConsumerLock(target, work, async path => path));
  const validatePaseo = vi.fn(async () => {});
  const stopped = vi.fn(async () => true);
  const preflightLock = vi.fn<NonNullable<MigrationDependencies['lock']>>((target, work) => withConsumerLock(target, work, async path => path));
  const dependencies = { lock: lock as NonNullable<MigrationDependencies['lock']> & typeof lock, preflightLock: preflightLock as NonNullable<MigrationDependencies['preflightLock']> & typeof preflightLock, validatePaseo, stopped };
  const options: MigrationOptions = { mode: 'forward', site, legacyDir, legacyPaseo, legacyConfig, units: ['example-legacy.service', 'example-primary.service', 'example-paseo.service'] };
  return { root, options, dependencies, ownerPath, paseoPath, legacyDir, legacyPaseo, legacyConfig, receiptPath: join(site.targets['wayroost-settings']!.backupDir, 'migration.json') };
}

it('plans without writing and copies every preference and complete provider policy through shared locks', async () => {
  const f = await fixture();
  await migrateSettings({ ...f.options, mode: 'plan' }, f.dependencies);
  await expect(lstat(f.ownerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
  const source = await read(f.legacyPaseo);
  expect(await migrateSettings(f.options, f.dependencies)).toMatchObject({ mode: 'forward', verified: true });
  expect(await read(f.ownerPath)).toEqual({ version: 1, safetyCommandsEnabled: true, rules: (await read(join(f.legacyDir, 'wayroost-settings.json'))).rules,
    quietHours: null, push: { approvals: false, cards: true }, timeZone: 'Etc/UTC', feed: { level: 'low', lessLike: [{ topic: 'Example', example: 'Invented card', at: 1 }] },
    workerUpdates: { enabled: false, defaultMinutes: 30 }, voice: { voice: 'af_heart', appReadAloud: { provider: 'elevenlabs', voiceId: 'fakevoice', modelId: 'fakemodel' } } });
  expect((await read(f.paseoPath)).agents.providers).toEqual(source.agents.providers);
  expect((await read(f.paseoPath)).unrelated).toBe('keep-target');
  expect((await read(f.receiptPath)).selectedApprovals).toBe(true);
  expect((await savedDocument(f, 'worker-approvals.json'))).toEqual(await read(join(f.legacyDir, 'worker-approvals.json')));
  expect(f.dependencies.lock.mock.calls.some(([target]) => target.path === f.paseoPath && target.lock.path.endsWith('.wayroost.lock'))).toBe(true);
  expect(f.dependencies.lock.mock.calls.some(([target]) => target.path === f.ownerPath && target.lock.path.endsWith('.wayroost-settings.lock'))).toBe(true);
  expect(f.dependencies.validatePaseo).toHaveBeenCalled();
  const target = f.options.site.targets['wayroost-settings']!;
  expect(await readFile(join(target.auditDir, 'audit.jsonl'), 'utf8')).toContain('success');
  expect(await readdir(join(target.backupDir, 'files'))).not.toHaveLength(0);
  expect((await lstat(f.ownerPath)).mode & 0o777).toBe(0o600);
  expect((await lstat(f.ownerPath)).uid).toBe(uid);
  expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
});

it.each([false, true])('plan retains only pre-existing Paseo lock files (existing: %s)', async existing => {
  const f = await fixture();
  const path = f.options.site.targets['paseo-config']!.lock.path;
  if (existing) await writeFile(path, 'existing lock', { mode: 0o600 });
  const before = await readdir(f.root, { recursive: true });
  const metadata = existing ? await lstat(path) : undefined;
  await migrateSettings({ ...f.options, mode: 'plan' }, f.dependencies);
  expect(await readdir(f.root, { recursive: true })).toEqual(before);
  expect(f.dependencies.preflightLock).toHaveBeenCalled();
  if (existing) {
    expect(await readFile(path, 'utf8')).toBe('existing lock');
    expect((await lstat(path)).ino).toBe(metadata!.ino);
  } else await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('plan removes its new Paseo lock when a later lock check fails', async () => {
  const f = await fixture();
  const before = await readdir(f.root, { recursive: true });
  const original = f.dependencies.preflightLock.getMockImplementation()!;
  f.dependencies.preflightLock.mockImplementation((target, work) => {
    if (target.path === f.ownerPath) throw new Error('Interrupted lock check');
    return original(target, work);
  });
  await expect(migrateSettings({ ...f.options, mode: 'plan' }, f.dependencies)).rejects.toThrow('Interrupted lock check');
  expect(await readdir(f.root, { recursive: true })).toEqual(before);
});

it.each(['plan', 'forward', 'verify', 'reverse'] as const)('requires a loaded writer unit in %s mode before writes', async mode => {
  const f = await fixture();
  const before = await readdir(f.root, { recursive: true });
  for (const loaded of [{ code: 0, stdout: 'not-found\n' }, { code: 0, stdout: 'masked\n' }, { code: 1, stdout: 'loaded\n' }]) {
    const systemctl = vi.fn(async (args: string[]) => args[0] === 'show' ? loaded : { code: 3, stdout: 'inactive\n' });
    await expect(migrateSettings({ ...f.options, mode }, { ...f.dependencies, stopped: undefined, systemctl })).rejects.toThrow('stopped state');
    expect(systemctl.mock.calls[0]![0]).toEqual(['show', '-p', 'LoadState', '--value', f.options.units[0]]);
    expect(await readdir(f.root, { recursive: true })).toEqual(before);
  }
});

it('accepts only a loaded inactive writer and checks both systemctl results', async () => {
  const f = await fixture();
  const systemctl = vi.fn(async (args: string[]) => args[0] === 'show' ? { code: 0, stdout: 'loaded\n' } : { code: 3, stdout: 'inactive\n' });
  await migrateSettings({ ...f.options, mode: 'plan' }, { ...f.dependencies, stopped: undefined, systemctl });
  expect(systemctl.mock.calls.map(([args]) => args)).toEqual(f.options.units.flatMap(unit => [
    ['show', '-p', 'LoadState', '--value', unit], ['is-active', unit],
  ]));
  for (const status of [{ code: 0, stdout: 'active\n' }, { code: 3, stdout: 'failed\n' }, { code: 1, stdout: 'inactive\n' }]) {
    systemctl.mockImplementation(async args => args[0] === 'show' ? { code: 0, stdout: 'loaded\n' } : status);
    await expect(migrateSettings({ ...f.options, mode: 'plan' }, { ...f.dependencies, stopped: undefined, systemctl })).rejects.toThrow('stopped state');
  }
});

it.each(['origin', 'key', 'schema', 'storage', 'unexpected'] as const)('prints a constant CLI error without %s contents', async kind => {
  const sentinel = 'FAKE_CONFIG_CONTENT_SENTINEL';
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const previousExit = process.exitCode;
  try {
    await runMigrationCli(async () => {
      if (kind === 'unexpected') throw new Error(sentinel);
      if (kind === 'schema') wayroostSettingsSchema.parse({ version: sentinel });
      if (kind === 'storage') { const error = new ConfigError('parse_failed'); error.message = sentinel; throw error; }
      parseConfig(kind === 'key' ? { [sentinel]: true } : { publicOrigin: `https://${sentinel}.example.com`,
        origins: [`https://${sentinel}.example.com:8443`] }, { env: {}, withoutSupervisor: true });
    });
    expect(process.exitCode).toBe(1);
    const expected = kind === 'unexpected' ? 'Migration failed.\n' : kind === 'schema' ? 'Invalid settings schema.\n'
      : kind === 'storage' ? 'Configuration storage or validation failed.\n' : 'Invalid legacy configuration.\n';
    expect(stderr.mock.calls.map(([value]) => String(value)).join('')).toBe(expected);
    expect(stderr.mock.calls.map(([value]) => String(value)).join('')).not.toContain(sentinel);
  } finally { process.exitCode = previousExit; }
});

it.each(['usage', 'arguments', 'writer', 'overlap', 'writes', 'size'] as const)('prints its own %s error reason', async kind => {
  const f = await fixture();
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const previousExit = process.exitCode;
  const previousArgv = process.argv;
  let expected: string;
  try {
    if (kind === 'usage' || kind === 'arguments') {
      process.argv = ['node', 'migrate-settings', ...(kind === 'arguments' ? ['plan', '--invalid', 'fake'] : [])];
      expected = kind === 'arguments' ? 'Invalid migration arguments.'
        : 'Usage: migrate-settings plan|forward|verify|reverse --targets PATH --legacy-dir PATH --legacy-paseo PATH --legacy-config PATH --stopped-unit UNIT (repeat for every writer)';
      await runMigrationCli();
    } else {
      if (kind === 'writer') f.dependencies.stopped.mockResolvedValue(false);
      if (kind === 'overlap') f.options.legacyConfig = f.legacyPaseo;
      if (kind === 'writes') f.options.site.configWrites = false;
      if (kind === 'size') {
        const document = { ...(await read(f.paseoPath)), padding: '' };
        document.padding = 'x'.repeat(4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(document)) - 1);
        await writeFile(f.paseoPath, `${JSON.stringify(document)}\n`);
      }
      expected = kind === 'writer' ? `Writer is running or its stopped state cannot be proved: ${f.options.units[0]}`
        : kind === 'overlap' ? 'Migration paths overlap.' : kind === 'writes' ? 'configWrites is off.'
          : 'Primary Paseo write exceeds 4 MiB; reduce the stopped input before retrying.';
      await runMigrationCli(async () => { await migrateSettings(f.options, f.dependencies); });
    }
    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls.map(([value]) => String(value)).join('')).toBe(`${expected}\n`);
  } finally { process.exitCode = previousExit; process.argv = previousArgv; }
});

it.each(['worker-updates.json', 'worker-approvals.json'] as const)('keeps real oversized %s content out of the receipt', async name => {
  const f = await fixture();
  const path = join(f.legacyDir, name);
  const document = await read(path);
  if (name === 'worker-updates.json') document.pad = 'x'.repeat(5 * 1024 * 1024);
  else document.backup.claude.before.pad = 'x'.repeat(6 * 1024 * 1024);
  await save(path, document);
  if (name === 'worker-updates.json') expect(new WorkerUpdatesSetting(f.legacyDir).status().enabled).toBe(false);
  else expect(() => new WorkerApprovalsSetting(f.legacyPaseo, f.legacyDir, {
    providers: async () => [], effectiveProviders: async () => ({}),
    reload: async () => ({ appliedPaths: [], restartRequiredPaths: [], overrideControlledPaths: [] }),
  })).not.toThrow();
  await migrateSettings(f.options, f.dependencies);
  const receipt = await readFile(f.receiptPath, 'utf8');
  expect(Buffer.byteLength(receipt)).toBeLessThan(16 * 1024);
  expect(receipt).not.toContain('xxxx');
  expect(await savedDocument(f, name)).toEqual(document);
  expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
  const current = await read(f.ownerPath);
  current.workerUpdates.enabled = true;
  await save(f.ownerPath, current);
  await rm(path);
  await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies);
  const restored = await read(path);
  if (name === 'worker-updates.json') expect(restored).toMatchObject({ enabled: true, pad: document.pad });
  else expect(restored.backup.claude.before.disabledTools).toEqual(document.backup.claude.before.disabledTools);
}, 30_000);

it.each([1, 2, 3, 4, 5, 6, 7, 8])('resumes after immutable snapshot publication %i before the receipt', async step => {
  const f = await fixture();
  const rename = fs.rename;
  let publications = 0;
  const interrupt = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await rename(from, to);
    if (String(to).includes('/migration-snapshots/') && ++publications === step) throw new Error('Interrupted snapshot');
  });
  await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow('Interrupted snapshot');
  await expect(lstat(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(f.ownerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  interrupt.mockRestore();
  expect(await migrateSettings(f.options, f.dependencies)).toMatchObject({ verified: true });
  const receipt = await read(f.receiptPath);
  expect(receipt).not.toHaveProperty('legacySettings'); expect(receipt).not.toHaveProperty('providers');
  expect(receipt).not.toHaveProperty('approvalState'); expect(receipt).not.toHaveProperty('untouched');
  for (const reference of Object.values(receipt.snapshots) as Array<{ sha256: string; size: number }>) {
    const path = join(f.options.site.targets['wayroost-settings']!.backupDir, 'migration-snapshots', reference.sha256);
    const info = await lstat(path);
    expect(info.uid).toBe(uid); expect(info.mode & 0o7777).toBe(0o600); expect(info.size).toBe(reference.size);
  }
});

it.each([1, 2, 3, 4, 5, 6, 7, 8])('cleans an interrupted snapshot temporary at publication %i before resuming', async step => {
  const f = await fixture();
  const directory = join(f.options.site.targets['wayroost-settings']!.backupDir, 'migration-snapshots');
  const rename = fs.rename; const unlink = fs.unlink;
  let publications = 0;
  let interrupted: string | undefined;
  const interrupt = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).startsWith(`${directory}/`) && ++publications === step) {
      interrupted = String(from);
      throw new Error('Interrupted snapshot');
    }
    await rename(from, to);
  });
  const cleanup = vi.spyOn(fs, 'unlink').mockImplementation(async path => {
    if (String(path) === interrupted) throw new Error('Interrupted snapshot');
    await unlink(path);
  });
  await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow('Interrupted snapshot');
  interrupt.mockRestore(); cleanup.mockRestore();
  const temporary = (await readdir(directory)).filter(name => name.endsWith('.tmp'));
  expect(temporary).toHaveLength(1);
  expect((await lstat(join(directory, temporary[0]!))).mode & 0o7777).toBe(0o600);
  expect(await migrateSettings(f.options, f.dependencies)).toMatchObject({ verified: true });
  expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

it.each(['plan', 'forward', 'verify', 'reverse'] as const)('cleans only exact private regular snapshot temporaries in %s mode', async mode => {
  const f = await fixture();
  await migrateSettings(f.options, f.dependencies);
  const directory = join(f.options.site.targets['wayroost-settings']!.backupDir, 'migration-snapshots');
  const name = (index: number) => `${'a'.repeat(64)}.00000000-0000-4000-8000-${String(index).padStart(12, '0')}.tmp`;
  const eligible = join(directory, name(1)); await writeFile(eligible, 'FAKE_INTERRUPTED_BYTES\u0000', { mode: 0o600 });
  const retained = ['unrelated.tmp', `${'a'.repeat(64)}.tmp`, `${'a'.repeat(64)}.not-a-uuid.tmp`, name(2), name(3), name(4), name(5), name(6)];
  for (const file of retained.slice(0, 4)) await save(join(directory, file), { untouched: true });
  await chmod(join(directory, name(2)), 0o640);
  await mkdir(join(directory, name(3)), { mode: 0o700 });
  await symlink(f.legacyConfig, join(directory, name(4)));
  await link(join(directory, 'unrelated.tmp'), join(directory, name(5)));
  await save(join(directory, name(6)), {});
  const stat = fs.lstat;
  const metadata = vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
    const info = await stat(path, options as undefined);
    if (String(path) === join(directory, name(6))) Object.defineProperty(info, 'uid', { value: uid + 1 });
    return info;
  });
  await migrateSettings({ ...f.options, mode }, f.dependencies);
  metadata.mockRestore();
  await expect(lstat(eligible)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const file of retained) expect(await lstat(join(directory, file))).toBeDefined();
  expect(await readFile(join(directory, 'unrelated.tmp'), 'utf8')).toBe(`${JSON.stringify({ untouched: true }, null, 2)}\n`);
});

it.each((['forward', 'verify', 'reverse'] as const).flatMap(mode =>
  ['missing', 'hash', 'size', 'mode', 'symlink', 'directory-mode', 'limit'].map(kind => ({ mode, kind }))))(
  'refuses $kind snapshot artifacts without writes in $mode', async ({ mode, kind }) => {
    const f = await fixture(); await migrateSettings(f.options, f.dependencies);
    const receipt = await read(f.receiptPath);
    const directory = join(f.options.site.targets['wayroost-settings']!.backupDir, 'migration-snapshots');
    const path = join(directory, receipt.snapshots['worker-approvals.json'].sha256);
    if (kind === 'missing') await rm(path);
    else if (kind === 'hash') await writeFile(path, `${await readFile(path, 'utf8')} `);
    else if (kind === 'size') { receipt.snapshots['worker-approvals.json'].size++; await save(f.receiptPath, receipt); }
    else if (kind === 'mode') await chmod(path, 0o644);
    else if (kind === 'symlink') { await rm(path); await symlink(join(f.legacyDir, 'worker-approvals.json'), path); }
    else if (kind === 'directory-mode') await chmod(directory, 0o755);
    else await writeFile(path, 'x'.repeat(16 * 1024 * 1024 + 1));
    const before = await migrationTree(f.root);
    f.dependencies.lock.mockClear();
    await expect(migrateSettings({ ...f.options, mode }, f.dependencies)).rejects.toThrow();
    expect(await migrationTree(f.root)).toEqual(before);
    expect(f.dependencies.lock).not.toHaveBeenCalled();
  },
);

it.each(['backupDir', 'auditDir'] as const)('refuses a plan with missing %s before calling a creating validator', async directory => {
  const f = await fixture();
  const target = f.options.site.targets['paseo-config']!;
  await rm(target[directory], { recursive: true });
  f.dependencies.validatePaseo.mockImplementation(async () => {
    await mkdir(target.auditDir, { recursive: true, mode: 0o700 });
    throw new Error('Invalid provider');
  });
  const before = await readdir(f.root, { recursive: true });
  await expect(migrateSettings({ ...f.options, mode: 'plan' }, f.dependencies)).rejects.toThrow();
  expect(f.dependencies.validatePaseo).not.toHaveBeenCalled();
  expect(await readdir(f.root, { recursive: true })).toEqual(before);
});

it('reverse carries CURRENT choices, preserves unrelated keys, and builds usable legacy undo state', async () => {
  const f = await fixture(); await migrateSettings(f.options, f.dependencies);
  const changed = { version: 1, safetyCommandsEnabled: false, quietHours: { start: '23:00', end: '06:00' }, push: { approvals: true, cards: false },
    timeZone: 'Europe/London', workerUpdates: { enabled: true, defaultMinutes: 60 }, voice: { voice: 'bf_emma', appReadAloud: { provider: 'local' } }, feed: { level: 'high', lessLike: [] } };
  await save(f.ownerPath, changed);
  const now = await read(f.paseoPath);
  now.agents.providers.claude.enabled = true; now.agents.providers.codex.enabled = false;
  now.agents.providers.custom.paseoTools.disabledTools.push('create_terminal');
  await save(f.paseoPath, now);
  await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies);
  expect((await read(f.legacyPaseo)).agents.providers).toEqual(now.agents.providers);
  expect((await read(f.legacyPaseo)).unrelated).toBe('keep-legacy');
  expect(await read(join(f.legacyDir, 'hermes-safety-commands.json'))).toEqual({ enabled: false });
  expect(await read(join(f.legacyDir, 'worker-updates.json'))).toEqual({ enabled: true, defaultMinutes: 60, untouched: 'keep-worker' });
  expect(await read(join(f.legacyDir, 'voice.json'))).toMatchObject(changed.voice);
  const feed = await read(join(f.legacyDir, 'feed.json'));
  expect(feed.cards[0].status).toBe('done'); expect(feed.notified).toEqual(['fake-approval']);
  expect(feed.settings).toMatchObject({ level: 'high', quietHours: changed.quietHours, push: changed.push, untouched: 'keep-feed' });
  expect(await read(f.legacyConfig)).toMatchObject({ notifications: { timeZone: 'Europe/London' }, feed: { enabled: true } });
  const state = await read(join(f.legacyDir, 'worker-approvals.json'));
  expect(state.enabled).toBe(true);
  const undone = undoApprovalsToMe(now.agents.providers, state.backup);
  expect(undone.claude?.paseoTools?.disabledTools).toEqual(['kill_agent', 'update_agent']);
  expect(undone.custom?.paseoTools?.disabledTools).toContain('create_terminal');
  expect(undone.custom?.paseoTools?.disabledTools).toEqual(now.agents.providers.custom.paseoTools.disabledTools);
  expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
});

it('reverse supports a current all-off approval choice without applying a boolean to policies', async () => {
  const f = await fixture(); await migrateSettings(f.options, f.dependencies);
  const now = await read(f.paseoPath);
  for (const entry of Object.values(now.agents.providers) as Array<{ paseoTools: { disabledTools?: string[] } }>) {
    if (entry.paseoTools.disabledTools) entry.paseoTools.disabledTools = entry.paseoTools.disabledTools.filter(tool => !WORKER_APPROVAL_TOOLS.includes(tool as typeof WORKER_APPROVAL_TOOLS[number]));
  }
  await save(f.paseoPath, now);
  await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies);
  expect((await read(f.legacyPaseo)).agents.providers).toEqual(now.agents.providers);
  expect((await read(join(f.legacyDir, 'worker-approvals.json'))).enabled).toBe(false);
});

it('reverse retains pre-existing restrictions for a constructor provider without a saved undo record', async () => {
  const f = await fixture();
  const source = await read(f.legacyPaseo);
  source.agents.providers.constructor = { extends: 'pi', label: 'Example provider', paseoTools: structuredClone(policy) };
  await save(f.legacyPaseo, source);
  await migrateSettings(f.options, f.dependencies);
  expect(Object.hasOwn((await savedDocument(f, 'worker-approvals.json')).backup, 'constructor')).toBe(false);
  await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies);
  const current = (await read(f.legacyPaseo)).agents.providers;
  const state = await read(join(f.legacyDir, 'worker-approvals.json'));
  const undone = undoApprovalsToMe(current, state.backup);
  expect(undone['constructor']).toEqual(source.agents.providers.constructor);
  expect(state.backup.constructor.before).toEqual(policy);
});

it('preserves absent choices, materializes only changed defaults and restores current absence', async () => {
  const f = await fixture(true);
  await migrateSettings(f.options, f.dependencies);
  expect(await read(f.ownerPath)).toEqual({ version: 1, feed: { level: 'normal' }, workerUpdates: { enabled: true } });
  expect((await read(f.paseoPath)).agents.providers).toEqual({});
  await save(f.ownerPath, { version: 1 });
  await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies);
  expect(await read(join(f.legacyDir, 'hermes-safety-commands.json'))).toEqual({});
  expect(await read(join(f.legacyDir, 'wayroost-settings.json'))).toEqual({});
  expect((await read(join(f.legacyDir, 'worker-updates.json'))).enabled).toBe(false);
  expect((await read(join(f.legacyDir, 'feed.json'))).settings.level).toBe('off');
  expect((await read(f.legacyConfig)).notifications).not.toHaveProperty('timeZone');
});

it('preserves explicit false, null and empty arrays and uses pre-seeding feed notifications', async () => {
  const f = await fixture(true);
  await save(join(f.legacyDir, 'hermes-safety-commands.json'), { enabled: false });
  await save(join(f.legacyDir, 'worker-updates.json'), { enabled: false });
  await save(join(f.legacyDir, 'feed.json'), { settings: { level: 'off', quietHours: null, push: { approvals: false, cards: false }, lessLike: [] } });
  await migrateSettings(f.options, f.dependencies);
  expect(await read(f.ownerPath)).toEqual({ version: 1, safetyCommandsEnabled: false, workerUpdates: { enabled: false }, feed: { level: 'off', lessLike: [] }, quietHours: null, push: { approvals: false, cards: false } });
});

it.each([{}, { rules: [] }, { quietHours: null }, { push: { approvals: false, cards: true } }])(
  'uses the legacy notification reader defaults for an existing partial document %j', async notifications => {
    const f = await fixture(true);
    await save(join(f.legacyDir, 'wayroost-settings.json'), notifications);
    await save(join(f.legacyDir, 'feed.json'), { settings: { quietHours: null, push: { approvals: false, cards: true } } });
    const expected = new NotificationSettingsStore(f.legacyDir).settings();
    await migrateSettings(f.options, f.dependencies);
    const primary = await read(f.ownerPath);
    expect(effectiveSettings(primary)).toMatchObject({ ...expected, rules: expect.arrayContaining(expected.rules) });
    expect(primary.rules ?? expected.rules).toHaveLength(expected.rules.length);
    for (const key of ['rules', 'quietHours', 'push']) expect(Object.hasOwn(primary, key)).toBe(Object.hasOwn(notifications, key));
    expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
    if (!Object.hasOwn(notifications, 'push')) {
      await save(f.ownerPath, { ...primary, push: { approvals: false, cards: true } });
      await expect(migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).rejects.toThrow('Effective settings');
    }
  },
);

it.each([{ cards: true }, { approvals: false }, {}])(
  'refuses an existing incomplete legacy push object %j before writing', async push => {
    const f = await fixture(true);
    await save(join(f.legacyDir, 'wayroost-settings.json'), { push });
    const expected = new NotificationSettingsStore(f.legacyDir).settings();
    expect(expected.push).toEqual({ approvals: true, cards: false });
    const originalPaseo = await readFile(f.paseoPath, 'utf8');
    for (const mode of ['plan', 'forward'] as const) {
      await expect(migrateSettings({ ...f.options, mode }, f.dependencies)).rejects.toThrow();
      await expect(lstat(f.ownerPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(f.paseoPath, 'utf8')).toBe(originalPaseo);
      expect(f.dependencies.lock).not.toHaveBeenCalled();
    }
  },
);

it.each([{ cards: true }, { approvals: false }, {}])(
  'imports reader defaults for incomplete feed push settings %j', async push => {
    const f = await fixture(true);
    await save(join(f.legacyDir, 'feed.json'), { settings: { push } });
    const expected = new FeedStore(f.legacyDir).settings().push;
    const warning = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await migrateSettings(f.options, f.dependencies);
    expect((await read(f.ownerPath)).push).toEqual(expected);
    expect(warning).toHaveBeenCalledWith('Warning: legacy feed.json: invalid_value; reader defaults applied.\n');
    expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
  },
);

it.each(['BOM-prefixed', 'oversized'])(
  'refuses %s legacy notification bytes before writing or verifying normalized values', async kind => {
    const f = await fixture(true);
    const push = { approvals: false, cards: true };
    const document = JSON.stringify({ push });
    const source = kind === 'BOM-prefixed' ? `\uFEFF${document}` : `${document}${' '.repeat(128 * 1024)}`;
    await writeFile(join(f.legacyDir, 'wayroost-settings.json'), source, { mode: 0o600 });
    expect(new NotificationSettingsStore(f.legacyDir).settings().push).toEqual({ approvals: true, cards: false });
    const originalPaseo = await readFile(f.paseoPath, 'utf8');
    for (const mode of ['plan', 'forward'] as const) {
      await expect(migrateSettings({ ...f.options, mode }, f.dependencies)).rejects.toThrow('parse_failed');
      await expect(lstat(f.ownerPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(f.paseoPath, 'utf8')).toBe(originalPaseo);
      expect(f.dependencies.lock).not.toHaveBeenCalled();
    }
    await save(f.ownerPath, { version: 1, feed: { level: 'normal' }, workerUpdates: { enabled: true }, push });
    await expect(migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).rejects.toThrow('parse_failed');
  },
);

it.each(['worker-approvals.json'])(
  'refuses BOM-prefixed legacy %s before writes and after forward', async name => {
    const f = await fixture();
    const path = join(f.legacyDir, name);
    const original = await readFile(path, 'utf8');
    const source = `\uFEFF${original}`;
    await writeFile(path, source);
    if (name === 'hermes-safety-commands.json') expect(new SafetyCommandsSetting(f.legacyDir).enabled()).toBe(false);
    if (name === 'worker-updates.json') {
      const legacy = new WorkerUpdatesSetting(f.legacyDir);
      expect(legacy.enabled()).toBe(true); expect(legacy.defaultMinutes()).toBe(60);
    }
    if (name === 'voice.json') {
      const legacy = new VoiceSetting(f.legacyDir);
      expect(legacy.voice()).toBe(''); expect(legacy.appReadAloud()).toEqual({ provider: 'local' });
    }
    if (name === 'feed.json') expect(new FeedStore(f.legacyDir).settings()).toEqual({
      level: 'normal', quietHours: { start: '21:00', end: '07:00' }, push: { approvals: true, cards: false }, lessLike: [],
    });
    if (name === 'worker-approvals.json') {
      const daemon = { providers: vi.fn(), effectiveProviders: vi.fn(), reload: vi.fn() };
      expect(() => new WorkerApprovalsSetting(f.legacyPaseo, f.legacyDir, daemon)).toThrow('Safety state is invalid');
      expect(daemon.providers).not.toHaveBeenCalled();
    }
    const originalPaseo = await readFile(f.paseoPath, 'utf8');
    for (const mode of ['plan', 'forward'] as const) {
      await expect(migrateSettings({ ...f.options, mode }, f.dependencies)).rejects.toThrow('parse_failed');
      await expect(lstat(f.ownerPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(f.paseoPath, 'utf8')).toBe(originalPaseo);
      expect(await readFile(path, 'utf8')).toBe(source);
      expect(f.dependencies.lock).not.toHaveBeenCalled();
    }
    await writeFile(path, original);
    await migrateSettings(f.options, f.dependencies);
    await writeFile(path, source);
    const paths = [f.ownerPath, f.paseoPath, f.legacyPaseo, f.legacyConfig, f.receiptPath, path];
    const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
    f.dependencies.lock.mockClear();
    for (const mode of ['verify', 'reverse'] as const) {
      await expect(migrateSettings({ ...f.options, mode }, f.dependencies)).rejects.toThrow('parse_failed');
      expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(before);
      expect(f.dependencies.lock).not.toHaveBeenCalled();
    }
  },
);

it.each([0o644, 0o620, 0o660, 0o601, 0o602, 0o1600])(
  'refuses legacy notification mode %i before importing, verifying or reversing', async permissions => {
    const f = await fixture();
    const path = join(f.legacyDir, 'wayroost-settings.json');
    const source = await readFile(path, 'utf8');
    await chmod(path, permissions);
    expect(new NotificationSettingsStore(f.legacyDir).settings().push).toEqual({ approvals: true, cards: false });
    const originalPaseo = await readFile(f.paseoPath, 'utf8');
    for (const mode of ['plan', 'forward'] as const) {
      await expect(migrateSettings({ ...f.options, mode }, f.dependencies)).rejects.toThrow('unsafe_target');
      await expect(lstat(f.ownerPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(f.paseoPath, 'utf8')).toBe(originalPaseo);
      expect(f.dependencies.lock).not.toHaveBeenCalled();
    }
    await chmod(path, 0o600);
    await migrateSettings(f.options, f.dependencies);
    await chmod(path, permissions);
    const paths = [f.ownerPath, f.paseoPath, f.legacyPaseo, f.legacyConfig, f.receiptPath, path];
    const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
    f.dependencies.lock.mockClear();
    for (const mode of ['verify', 'reverse'] as const) {
      await expect(migrateSettings({ ...f.options, mode }, f.dependencies)).rejects.toThrow('unsafe_target');
      expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(before);
      expect(await readFile(path, 'utf8')).toBe(source);
      expect((await lstat(path)).mode & 0o7777).toBe(permissions);
      expect(f.dependencies.lock).not.toHaveBeenCalled();
    }
  },
);

it.each([0o600, 0o640, 0o610, 0o650, 0o700])('retains legacy-compatible notification mode %i on reverse', async permissions => {
  const f = await fixture();
  const path = join(f.legacyDir, 'wayroost-settings.json');
  await chmod(path, permissions);
  const expected = new NotificationSettingsStore(f.legacyDir).settings();
  expect(expected.push).toEqual({ approvals: false, cards: true });
  await migrateSettings(f.options, f.dependencies);
  expect(effectiveSettings(await read(f.ownerPath))).toMatchObject({ ...expected, rules: expect.arrayContaining(expected.rules) });
  const current = await read(f.ownerPath);
  current.push = { approvals: true, cards: false };
  await save(f.ownerPath, current);
  await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies);
  expect((await lstat(path)).mode & 0o7777).toBe(permissions);
  expect(new NotificationSettingsStore(f.legacyDir).settings().push).toEqual(current.push);
  expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
});

it.each(['legacyPaseo', 'legacyConfig'] as const)('refuses BOM-prefixed %s before preparing migration', async name => {
  const f = await fixture();
  const path = f[name];
  const source = `\uFEFF${await readFile(path, 'utf8')}`;
  await writeFile(path, source);
  expect(() => JSON.parse(source)).toThrow();
  const originalPaseo = await readFile(f.paseoPath, 'utf8');
  for (const mode of ['plan', 'forward'] as const) {
    await expect(migrateSettings({ ...f.options, mode }, f.dependencies)).rejects.toThrow('parse_failed');
    await expect(lstat(f.ownerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(f.paseoPath, 'utf8')).toBe(originalPaseo);
    expect(await readFile(path, 'utf8')).toBe(source);
    expect(f.dependencies.lock).not.toHaveBeenCalled();
  }
});

it('refuses unsafe saved notification permissions before restoring a missing legacy document', async () => {
  const f = await fixture();
  await migrateSettings(f.options, f.dependencies);
  const receipt = await read(f.receiptPath);
  receipt.metadata['wayroost-settings.json'].mode = 0o644;
  await save(f.receiptPath, receipt);
  const path = join(f.legacyDir, 'wayroost-settings.json');
  await rm(path);
  const paths = [f.ownerPath, f.paseoPath, f.legacyPaseo, f.legacyConfig, f.receiptPath];
  const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
  f.dependencies.lock.mockClear();
  await expect(migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies)).rejects.toThrow('unsafe_target');
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(before);
  expect(f.dependencies.lock).not.toHaveBeenCalled();
});

it('ignores incomplete feed push settings when an existing notification document supplies defaults', async () => {
  const f = await fixture(true);
  await save(join(f.legacyDir, 'wayroost-settings.json'), {});
  await save(join(f.legacyDir, 'feed.json'), { settings: { push: { cards: true } } });
  const expected = new NotificationSettingsStore(f.legacyDir).settings();
  await migrateSettings(f.options, f.dependencies);
  const primary = await read(f.ownerPath);
  expect(primary).not.toHaveProperty('push');
  expect(effectiveSettings(primary)).toMatchObject({ ...expected, rules: expect.arrayContaining(expected.rules) });
  expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
});

it('accepts notification JSON at the legacy byte limit and refuses one more byte after forward', async () => {
  const f = await fixture(true);
  const path = join(f.legacyDir, 'wayroost-settings.json');
  const document = JSON.stringify({ push: { approvals: false, cards: true } });
  const source = document.padEnd(128 * 1024, ' ');
  await writeFile(path, source, { mode: 0o600 });
  const expected = new NotificationSettingsStore(f.legacyDir).settings();
  expect(expected.push).toEqual({ approvals: false, cards: true });
  await migrateSettings(f.options, f.dependencies);
  expect(effectiveSettings(await read(f.ownerPath))).toMatchObject({ ...expected, rules: expect.arrayContaining(expected.rules) });
  expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
  const receipt = await readFile(f.receiptPath, 'utf8');
  const primary = await readFile(f.ownerPath, 'utf8');
  await writeFile(path, `${source} `, { mode: 0o600 });
  expect(new NotificationSettingsStore(f.legacyDir).settings().push).toEqual({ approvals: true, cards: false });
  for (const mode of ['verify', 'reverse'] as const) {
    await expect(migrateSettings({ ...f.options, mode }, f.dependencies)).rejects.toThrow('parse_failed');
    expect(await readFile(f.receiptPath, 'utf8')).toBe(receipt);
    expect(await readFile(f.ownerPath, 'utf8')).toBe(primary);
    expect(await readFile(path, 'utf8')).toBe(`${source} `);
  }
});

it('compares effective values with reordered JSON, tool sets and explicit defaults', async () => {
  const f = await fixture(true); await migrateSettings(f.options, f.dependencies);
  await save(f.ownerPath, { workerUpdates: { enabled: true, defaultMinutes: 60 }, feed: { level: 'normal', lessLike: [] }, safetyCommandsEnabled: false, version: 1 });
  expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
  expect(effectiveSettings(wayroostSettingsSchema.parse({ version: 1, quietHours: null }))).not.toEqual(effectiveSettings({ version: 1 }));
});

it.each(['partial', 'mixed'])('refuses unsupported %s policies before reverse writes', async shape => {
  const f = await fixture(); await migrateSettings(f.options, f.dependencies);
  const now = await read(f.paseoPath);
  now.agents.providers.custom.paseoTools.disabledTools = shape === 'partial' ? ['respond_to_permission'] : [];
  await save(f.paseoPath, now);
  const before = await readFile(f.legacyPaseo, 'utf8'); const receipt = await readFile(f.receiptPath, 'utf8');
  await expect(migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies)).rejects.toThrow('Unsupported mixed provider');
  expect(await readFile(f.legacyPaseo, 'utf8')).toBe(before); expect(await readFile(f.receiptPath, 'utf8')).toBe(receipt);
});

it('retains prepared approval backups separately and refuses an unresolved historical preparation', async () => {
  const f = await fixture();
  const state = await read(join(f.legacyDir, 'worker-approvals.json'));
  state.prepared = { beforeRevision: 'fake-before', afterRevision: 'fake-after', previousBackup: state.backup, committedBackup: {} };
  await save(join(f.legacyDir, 'worker-approvals.json'), state);
  await migrateSettings(f.options, f.dependencies);
  expect((await savedDocument(f, 'worker-approvals.json')).prepared).toEqual(state.prepared);
  await expect(migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies)).rejects.toThrow('Unresolved legacy approval');
});

it('resumes a prepared forward operation and is idempotent after completion', async () => {
  const f = await fixture(false, true);
  const originalLock = f.dependencies.lock.getMockImplementation()!;
  let calls = 0;
  f.dependencies.lock.mockImplementation((target, work) => {
    if (++calls === 2) throw new Error('Interrupted');
    return originalLock(target, work);
  });
  await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow();
  expect((await read(f.receiptPath)).phase).toBe('prepared');
  f.dependencies.lock.mockImplementation(originalLock);
  await migrateSettings(f.options, f.dependencies);
  const first = await readFile(f.ownerPath, 'utf8');
  await migrateSettings(f.options, f.dependencies);
  expect(await readFile(f.ownerPath, 'utf8')).toBe(first);
});

it.each(['receipt', 'Paseo'].flatMap(step => ['policy', 'flag'].map(edit => ({ step, edit }))))(
  'refuses a shared Paseo $edit edit after $step publication before resuming forward', async ({ step, edit }) => {
    const f = await fixture(false, true);
    const source = await read(f.paseoPath);
    source.agents.providers.codex.enabled = 'ignored';
    await save(f.paseoPath, source);
    const originalLock = f.dependencies.lock.getMockImplementation()!;
    f.dependencies.lock.mockImplementation((target, work) => {
      if (target.path === (step === 'receipt' ? f.paseoPath : f.ownerPath)) throw new Error('Interrupted forward');
      return originalLock(target, work);
    });
    await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow('Settings file operation failed.');
    const receipt = await readFile(f.receiptPath, 'utf8');
    expect(JSON.parse(receipt).phase).toBe('prepared');
    const accepted = await readFile(f.paseoPath, 'utf8');
    const changed = JSON.parse(accepted);
    if (edit === 'policy') changed.agents.providers.claude.paseoTools.disabledTools = [];
    else changed.agents.providers.claude.enabled = true;
    await save(f.paseoPath, changed);
    const before = await readFile(f.paseoPath, 'utf8');
    f.dependencies.lock.mockImplementation(originalLock);
    f.dependencies.lock.mockClear();
    f.dependencies.preflightLock.mockClear();
    for (const mode of ['forward', 'plan'] as const) {
      await expect(migrateSettings({ ...f.options, mode }, f.dependencies)).rejects.toThrow('Legacy Paseo changed since the forward snapshot.');
      expect(await readFile(f.paseoPath, 'utf8')).toBe(before);
      expect(await readFile(f.receiptPath, 'utf8')).toBe(receipt);
      await expect(lstat(f.ownerPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(f.dependencies.lock).not.toHaveBeenCalled();
      expect(f.dependencies.preflightLock).not.toHaveBeenCalled();
    }
    await writeFile(f.paseoPath, accepted);
    expect(await migrateSettings(f.options, f.dependencies)).toMatchObject({ verified: true });
    expect((await read(f.paseoPath)).agents.providers.claude).toEqual(source.agents.providers.claude);
  },
);

it.each(['receipt', 'Paseo'])('resumes the recorded shared Paseo revision after %s publication', async step => {
  const f = await fixture(false, true);
  const source = await read(f.paseoPath);
  source.agents.providers.codex.enabled = 'ignored';
  await save(f.paseoPath, source);
  const originalHash = digest(await readFile(f.paseoPath));
  const originalLock = f.dependencies.lock.getMockImplementation()!;
  f.dependencies.lock.mockImplementation((target, work) => {
    if (target.path === (step === 'receipt' ? f.paseoPath : f.ownerPath)) throw new Error('Interrupted forward');
    return originalLock(target, work);
  });
  await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow('Settings file operation failed.');
  const receipt = await read(f.receiptPath);
  expect(receipt.originalPaseoSha256).toBe(originalHash);
  expect(receipt.forwardPaseoSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.forwardPaseoSha256).not.toBe(originalHash);
  expect(digest(await readFile(f.paseoPath))).toBe(step === 'receipt' ? originalHash : receipt.forwardPaseoSha256);
  f.dependencies.lock.mockImplementation(originalLock);
  expect(await migrateSettings(f.options, f.dependencies)).toMatchObject({ verified: true });
  expect(digest(await readFile(f.paseoPath))).toBe(receipt.forwardPaseoSha256);
  const wanted = structuredClone(source.agents.providers);
  delete wanted.codex.enabled;
  expect((await read(f.paseoPath)).agents.providers).toEqual(wanted);
  expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
});

it('refuses a prepared shared Paseo receipt without an intended revision before writes', async () => {
  const f = await fixture(false, true);
  const originalLock = f.dependencies.lock.getMockImplementation()!;
  f.dependencies.lock.mockImplementation((target, work) => {
    if (target.path === f.paseoPath) throw new Error('Interrupted forward');
    return originalLock(target, work);
  });
  await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow('Settings file operation failed.');
  const receipt = await read(f.receiptPath);
  delete receipt.forwardPaseoSha256;
  await save(f.receiptPath, receipt);
  const paths = [f.receiptPath, f.paseoPath];
  const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
  f.dependencies.lock.mockImplementation(originalLock);
  f.dependencies.lock.mockClear();
  await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow('lacks the intended Paseo revision');
  expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(before);
  await expect(lstat(f.ownerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.dependencies.lock).not.toHaveBeenCalled();
});

it.each(['receipt', 'owner', 'wayroost-settings.json', 'hermes-safety-commands.json', 'worker-updates.json', 'voice.json', 'feed.json', 'worker-approvals.json'])(
  'resumes after publishing the first document for %s', async name => {
    const f = await fixture(true);
    const reversing = name !== 'receipt' && name !== 'owner';
    if (reversing) {
      await migrateSettings(f.options, f.dependencies);
      await save(f.ownerPath, { version: 1, safetyCommandsEnabled: true, rules: [], quietHours: null,
        push: { approvals: false, cards: true }, workerUpdates: { enabled: false, defaultMinutes: 30 },
        feed: { level: 'high', lessLike: [] }, voice: { voice: 'bf_emma', appReadAloud: { provider: 'local' } } });
    }
    const path = name === 'receipt' ? f.receiptPath : name === 'owner' ? f.ownerPath : join(f.legacyDir, name);
    const originalRename = fs.rename;
    let interrupted = false;
    const publication = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      await originalRename(source, destination);
      if (String(destination) === path && !interrupted) { interrupted = true; throw new Error('Interrupted after publication'); }
    });
    const options = { ...f.options, mode: reversing ? 'reverse' as const : 'forward' as const };
    await expect(migrateSettings(options, f.dependencies)).rejects.toThrow();
    expect(interrupted).toBe(true);
    expect((await lstat(path)).nlink).toBe(1);
    publication.mockRestore();
    expect(await migrateSettings(options, f.dependencies)).toMatchObject({ verified: true });
    expect((await read(f.receiptPath)).phase).toBe(options.mode);
  },
);

it('refuses a changed legacy time zone on resume before replacing either target', async () => {
  const f = await fixture();
  const originalLock = f.dependencies.lock.getMockImplementation()!;
  f.dependencies.lock.mockImplementation((target, work) => {
    if (target.path === f.paseoPath) throw new Error('Interrupted after preparation');
    return originalLock(target, work);
  });
  await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow();
  expect((await read(f.receiptPath)).phase).toBe('prepared');
  const beforePaseo = await readFile(f.paseoPath, 'utf8');
  const beforeReceipt = await readFile(f.receiptPath, 'utf8');
  const config = await read(f.legacyConfig);
  await save(f.legacyConfig, { ...config, notifications: { ...config.notifications, timeZone: 'Europe/London' } });
  f.dependencies.lock.mockImplementation(originalLock);
  await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow('Legacy configuration changed');
  expect(await readFile(f.paseoPath, 'utf8')).toBe(beforePaseo);
  expect(await readFile(f.receiptPath, 'utf8')).toBe(beforeReceipt);
  await expect(lstat(f.ownerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await save(f.legacyConfig, config);
  expect(await migrateSettings(f.options, f.dependencies)).toMatchObject({ verified: true });
});

it.each(['forward', 'reverse'] as const)('records %s completion only after semantic verification succeeds', async mode => {
  const f = await fixture();
  if (mode === 'reverse') await migrateSettings(f.options, f.dependencies);
  const primary = mode === 'reverse' ? await read(f.ownerPath) : undefined;
  let calls = 0;
  f.dependencies.stopped.mockImplementation(async () => {
    if (++calls === f.options.units.length + 1) {
      const now = await read(f.ownerPath);
      await save(f.ownerPath, { ...now, safetyCommandsEnabled: !now.safetyCommandsEnabled });
    }
    return true;
  });
  await expect(migrateSettings({ ...f.options, mode }, f.dependencies)).rejects.toThrow('Effective settings');
  expect((await read(f.receiptPath)).phase).toBe(mode === 'forward' ? 'prepared' : 'reversing');
  f.dependencies.stopped.mockImplementation(async () => true);
  if (primary) await save(f.ownerPath, primary);
  expect(await migrateSettings({ ...f.options, mode }, f.dependencies)).toMatchObject({ verified: true });
  expect((await read(f.receiptPath)).phase).toBe(mode);
});

it('refuses root, other owners, active writers, disabled writes, unsafe modes and symlinks', async () => {
  const f = await fixture();
  await expect(migrateSettings(f.options, { ...f.dependencies, uid: 0 })).rejects.toThrow('never root');
  await expect(migrateSettings(f.options, { ...f.dependencies, uid: uid + 1 })).rejects.toThrow('configured settings');
  await expect(migrateSettings(f.options, { ...f.dependencies, stopped: async () => false })).rejects.toThrow('Writer is running');
  await expect(migrateSettings({ ...f.options, units: [] }, f.dependencies)).rejects.toThrow('Name every stopped writer');
  await expect(migrateSettings({ ...f.options, site: { ...f.options.site, configWrites: false } }, f.dependencies)).rejects.toThrow('configWrites');
  await chmod(f.paseoPath, 0o644);
  await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow('unsafe_target');
  await chmod(f.paseoPath, 0o600); await rm(f.paseoPath); await symlink(f.legacyPaseo, f.paseoPath);
  await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow('unsafe_target');
});

it.each([undefined, {}, { enabled: true }, { disabledTools: [] }, { enabled: true, disabledTools: [] }])(
  'refuses a default custom policy %j when the legacy custom provider disables tools', async currentPolicy => {
    const f = await fixture(true);
    await save(f.legacyPaseo, { agents: { providers: {
      pi: { paseoTools: { enabled: false } },
      custom: { extends: 'pi', label: 'Example custom', paseoTools: { enabled: false } },
    } } });
    await migrateSettings(f.options, f.dependencies);
    const current = await read(f.paseoPath);
    delete current.agents.providers.custom.paseoTools;
    if (currentPolicy !== undefined) current.agents.providers.custom.paseoTools = currentPolicy;
    await save(f.paseoPath, current);
    await expect(migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).rejects.toThrow('Effective settings or provider policies differ');
  },
);

it.each([undefined, {}, { enabled: true }, { disabledTools: [] }])(
  'compares a custom policy %j against its own defaults regardless of its base policy', async currentPolicy => {
    const f = await fixture(true);
    await save(f.legacyPaseo, { agents: { providers: {
      pi: { paseoTools: { enabled: false, disabledTools: ['create_terminal'], futurePolicy: { mode: 'example' } } },
      custom: { extends: 'pi', label: 'Example custom', paseoTools: { enabled: true, disabledTools: [] } },
    } } });
    await migrateSettings(f.options, f.dependencies);
    const current = await read(f.paseoPath);
    delete current.agents.providers.custom.paseoTools;
    if (currentPolicy !== undefined) current.agents.providers.custom.paseoTools = currentPolicy;
    await save(f.paseoPath, current);
    expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
  },
);

it.each([false, true])('refuses mixed approval choices for a custom provider without a policy when its base tools are enabled=%s', async enabled => {
  const f = await fixture(); await migrateSettings(f.options, f.dependencies);
  const current = await read(f.paseoPath);
  current.agents.providers.pi.paseoTools.enabled = enabled;
  delete current.agents.providers.custom.paseoTools;
  await save(f.paseoPath, current);
  const paths = [f.legacyPaseo, f.legacyConfig, f.receiptPath, ...[
    'wayroost-settings.json', 'hermes-safety-commands.json', 'worker-updates.json', 'voice.json', 'feed.json', 'worker-approvals.json',
  ].map(name => join(f.legacyDir, name))];
  const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
  f.dependencies.lock.mockClear();
  await expect(migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies)).rejects.toThrow('Unsupported mixed provider approval policies');
  expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(before);
  expect(f.dependencies.lock).not.toHaveBeenCalled();
});

it('preserves an absent provider policy, explicit empty objects and flags', async () => {
  const f = await fixture(true);
  await save(f.legacyPaseo, { agents: { providers: {
    claude: { enabled: false }, codex: { paseoTools: {} }, opencode: { enabled: true, paseoTools: { enabled: false } },
    pi: { paseoTools: { enabled: false, disabledTools: ['create_terminal'] } },
    custom: { extends: 'pi', label: 'Example inherited' },
  } } });
  await migrateSettings(f.options, f.dependencies);
  expect((await read(f.paseoPath)).agents.providers).toEqual((await read(f.legacyPaseo)).agents.providers);
  expect((await read(f.paseoPath)).agents.providers.custom).not.toHaveProperty('paseoTools');
  await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies);
});

it('copies a newly added primary provider definition and retains removed providers unrelated keys', async () => {
  const f = await fixture(); await migrateSettings(f.options, f.dependencies);
  const now = await read(f.paseoPath);
  now.agents.providers['example-new'] = { extends: 'pi', label: 'Example new', paseoTools: { disabledTools: [...WORKER_APPROVAL_TOOLS, 'create_terminal'] } };
  delete now.agents.providers.custom;
  await save(f.paseoPath, now);
  await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies);
  const back = (await read(f.legacyPaseo)).agents.providers;
  expect(back['example-new']).toEqual(now.agents.providers['example-new']);
  expect(back.custom).toEqual({ extends: 'pi', label: 'Example provider' });
});

it('restores metadata and untouched preference keys from the forward snapshot when a legacy file is missing', async () => {
  const f = await fixture();
  await chmod(join(f.legacyDir, 'worker-updates.json'), 0o640);
  await migrateSettings(f.options, f.dependencies);
  await rm(join(f.legacyDir, 'worker-updates.json'));
  const now = await read(f.ownerPath); now.workerUpdates = { enabled: true, defaultMinutes: 60 };
  await save(f.ownerPath, now);
  await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies);
  expect(await read(join(f.legacyDir, 'worker-updates.json'))).toEqual({ enabled: true, defaultMinutes: 60, untouched: 'keep-worker' });
  expect((await lstat(join(f.legacyDir, 'worker-updates.json'))).mode & 0o777).toBe(0o640);
});

it('restores only feed settings when the current legacy feed is absent', async () => {
  const f = await fixture();
  const path = join(f.legacyDir, 'feed.json');
  const original = await read(path);
  original.closures = [{ key: 'mail:fake', at: 1 }]; original.dedup = ['fake-dedup']; original.unrelated = 'old-state';
  await save(path, original); await chmod(path, 0o640);
  await migrateSettings(f.options, f.dependencies);
  await rm(path);
  const current = await read(f.ownerPath);
  current.feed = { level: 'high', lessLike: [] }; current.quietHours = { start: '23:00', end: '07:00' };
  current.push = { approvals: true, cards: false };
  await save(f.ownerPath, current);
  await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies);
  expect(await read(path)).toEqual({ settings: { ...original.settings, ...current.feed, quietHours: current.quietHours, push: current.push } });
  expect((await lstat(path)).mode & 0o7777).toBe(0o640);
  expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
});

it('resolves a historical prepared backup against its original revision even when Paseo is the same target', async () => {
  const f = await fixture(false, true);
  const { createHash } = await import('node:crypto');
  const revision = createHash('sha256').update(await readFile(f.legacyPaseo)).digest('hex');
  const state = await read(join(f.legacyDir, 'worker-approvals.json'));
  state.prepared = { beforeRevision: 'fake-before', afterRevision: revision, previousBackup: {}, committedBackup: state.backup };
  await save(join(f.legacyDir, 'worker-approvals.json'), state);
  await migrateSettings(f.options, f.dependencies);
  const now = await read(f.paseoPath); now.agents.providers.claude.enabled = true;
  await save(f.paseoPath, now);
  await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies);
  const restored = await read(join(f.legacyDir, 'worker-approvals.json'));
  expect(restored).not.toHaveProperty('prepared');
  expect(restored.backup.claude.before.disabledTools).toEqual(['kill_agent', 'update_agent']);
});


it('reverse expands partial push choices for the legacy reader while retaining current hours and rules', async () => {
  const f = await fixture(); await migrateSettings(f.options, f.dependencies);
  const current = await read(f.ownerPath);
  current.push = { approvals: false }; current.quietHours = null;
  await save(f.ownerPath, current);
  await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies);
  const legacy = new NotificationSettingsStore(f.legacyDir).settings();
  expect(legacy.push).toEqual({ approvals: false, cards: false });
  expect(legacy.quietHours).toBe(null);
  expect(legacy.rules).toEqual(current.rules);
});

it('refreshes staging after opaque reverse so publishing current preferences retains current feed and voice state', async () => {
  const guide = await readFile(join(process.cwd(), 'docs/migration.md'), 'utf8');
  const refresh = guide.indexOf('Refresh the owner-readable staging inputs from the restored legacy tree');
  const ownerReverse = guide.indexOf('Run the owner tool in `reverse`', refresh);
  const publish = guide.indexOf('Publish the reversed staging preferences', ownerReverse);
  expect(refresh).toBeGreaterThan(guide.indexOf('Complete opaque reverse'));
  expect(ownerReverse).toBeGreaterThan(refresh);
  expect(publish).toBeGreaterThan(ownerReverse);

  const f = await fixture();
  const privateRoot = join(f.root, 'private'); await mkdir(privateRoot, { mode: 0o700 });
  const legacy = join(privateRoot, 'legacy'); const primary = join(privateRoot, 'primary'); const journal = join(privateRoot, 'journal');
  for (const path of [legacy, primary, journal]) await mkdir(path, { mode: 0o700 });
  for (const name of ['feed.json', 'voice.json']) await copyFile(join(f.legacyDir, name), join(legacy, name));
  const opaque = async (mode: 'forward' | 'reverse') => promisify(execFile)('python3', ['-c', `
import importlib.util
import os
from pathlib import Path
import stat
import sys
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('state_transfer', sys.argv[1])
transfer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)
legacy, primary, journal = map(Path, sys.argv[2:5])
real_lstat, real_fstat = os.lstat, os.fstat

def root_info(info):
    values = {name: getattr(info, name) for name in dir(info) if name.startswith('st_')}
    values['st_uid'] = 0
    return SimpleNamespace(**values)

def lstat(path, *args, **kwargs):
    info = real_lstat(path, *args, **kwargs)
    path = Path(path)
    if stat.S_ISDIR(info.st_mode) and path not in (legacy, primary):
        return root_info(info)
    if path.parent == journal and path.name.endswith(('.json', '.tmp', '.lock')):
        return root_info(info)
    return info

os.lstat = lstat
os.fstat = lambda fd: root_info(real_fstat(fd))
runner = lambda argv, **kwargs: SimpleNamespace(returncode=0, stdout='loaded') if argv[1] == 'show' else SimpleNamespace(returncode=3, stdout='inactive')
transfer.transfer(sys.argv[5], str(legacy), str(primary), str(journal), ['example-legacy.service', 'example-primary.service'],
                  families=['feed', 'voice'], compatible=['feed', 'voice'] if sys.argv[5] == 'reverse' else [], runner=runner, uid=0)
`, join(process.cwd(), 'deploy/state-transfer.py'), legacy, primary, journal, mode]);

  await migrateSettings(f.options, f.dependencies);
  await opaque('forward');
  const currentFeed = await read(join(primary, 'feed.json'));
  currentFeed.cards.push({ key: 'mail:current', title: 'Current example', status: 'open' });
  currentFeed.notified.push('current-approval'); currentFeed.closed = ['current-closure'];
  await save(join(primary, 'feed.json'), currentFeed);
  await save(join(primary, 'voice.json'), { version: 2, voice: 'bf_emma', currentMetadata: 'keep-current' });
  const currentSettings = await read(f.ownerPath);
  currentSettings.feed = { level: 'high', lessLike: [] };
  currentSettings.voice = { voice: 'af_heart', appReadAloud: { provider: 'local' } };
  currentSettings.quietHours = { start: '23:00', end: '06:00' };
  await save(f.ownerPath, currentSettings);

  await opaque('reverse');
  expect((await read(join(f.legacyDir, 'feed.json'))).cards).toHaveLength(1);
  for (const name of ['feed.json', 'voice.json']) await copyFile(join(legacy, name), join(f.legacyDir, name));
  await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies);
  for (const name of ['feed.json', 'voice.json']) await copyFile(join(f.legacyDir, name), join(legacy, name));
  const restoredFeed = await read(join(legacy, 'feed.json'));
  expect(restoredFeed.cards).toEqual(currentFeed.cards);
  expect(restoredFeed.notified).toEqual(currentFeed.notified);
  expect(restoredFeed.closed).toEqual(currentFeed.closed);
  expect(restoredFeed.settings).toMatchObject({ ...currentSettings.feed, quietHours: currentSettings.quietHours });
  expect(await read(join(legacy, 'voice.json'))).toMatchObject({ ...currentSettings.voice, currentMetadata: 'keep-current' });
  expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
});


it.each([0, 1, 2])('checks final notification bytes with %i bytes left at the legacy limit', async room => {
  const f = await fixture(true);
  const path = join(f.legacyDir, 'wayroost-settings.json');
  const limit = 128 * 1024;
  const document = { push: { approvals: true, cards: true } };
  const json = JSON.stringify(document);
  const source = `${json}${' '.repeat(limit - room - Buffer.byteLength(json))}`;
  await writeFile(path, source, { mode: 0o600 });
  expect((await lstat(path)).size).toBe(limit - room);
  expect(new NotificationSettingsStore(f.legacyDir).settings().push).toEqual(document.push);
  await migrateSettings(f.options, f.dependencies);
  const current = await read(f.ownerPath);
  current.push = { approvals: false, cards: false };
  await save(f.ownerPath, current);
  if (room < 2) {
    const paths = [f.ownerPath, f.paseoPath, f.legacyPaseo, f.legacyConfig, f.receiptPath, path];
    const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
    f.dependencies.lock.mockClear();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies)).rejects.toThrow('Legacy notification write exceeds 128 KiB');
      expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(before);
      expect(await readdir(f.legacyDir)).toEqual(['wayroost-settings.json']);
      expect(f.dependencies.lock).not.toHaveBeenCalled();
    }
    await save(path, document);
  }
  expect(await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies)).toMatchObject({ verified: true });
  expect(new NotificationSettingsStore(f.legacyDir).settings().push).toEqual(current.push);
  expect((await lstat(path)).size).toBeLessThanOrEqual(limit);
  if (room === 2) expect((await lstat(path)).size).toBe(limit);
  expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
});

it.each(['owner', 'Paseo'].flatMap(name => [false, true].flatMap(resume => [false, true].flatMap(indented =>
  [0, 1].map(room => ({ name, resume, indented, room })),
))))('checks final forward $name bytes (resume=$resume, indented=$indented, room=$room)', async ({ name, resume, indented, room }) => {
  const f = await fixture(true);
  const lessLike = [{ topic: 'é', example: '', at: 0 }];
  await save(f.legacyPaseo, { agents: { providers: { opencode: { enabled: false } } } });
  await save(join(f.legacyDir, 'hermes-safety-commands.json'), { enabled: false });
  await save(join(f.legacyDir, 'feed.json'), { settings: { lessLike } });
  await save(f.paseoPath, { unrelated: 'é', agents: { providers: { opencode: { enabled: true } } } });
  await save(f.ownerPath, { version: 1, safetyCommandsEnabled: true, workerUpdates: { enabled: true }, feed: { level: 'normal', lessLike } });
  const originalLock = f.dependencies.lock.getMockImplementation()!;
  if (resume) {
    f.dependencies.lock.mockImplementation((target, work) => {
      if (target.path === f.paseoPath) throw new Error('Interrupted');
      return originalLock(target, work);
    });
    await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow('Settings file operation failed.');
    expect((await read(f.receiptPath)).phase).toBe('prepared');
    f.dependencies.lock.mockImplementation(originalLock);
  }
  const path = name === 'owner' ? f.ownerPath : f.paseoPath;
  const source = `${JSON.stringify(await read(path), null, indented ? 2 : undefined)}\n`;
  const limit = 4 * 1024 * 1024;
  await writeFile(path, `${source}${' '.repeat(limit - room - Buffer.byteLength(source))}`);
  const paths = [f.ownerPath, f.paseoPath, f.legacyPaseo, f.legacyConfig,
    ...['hermes-safety-commands.json', 'feed.json'].map(name => join(f.legacyDir, name)), ...(resume ? [f.receiptPath] : [])];
  if (room === 0) {
    const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
    f.dependencies.lock.mockClear();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow(`Primary ${name === 'owner' ? 'owner settings' : 'Paseo'} write exceeds 4 MiB`);
      expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(before);
      if (!resume) await expect(lstat(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(f.dependencies.lock).not.toHaveBeenCalled();
    }
    await writeFile(path, source);
  }
  expect(await migrateSettings(f.options, f.dependencies)).toMatchObject({ verified: true });
  expect((await lstat(path)).size).toBe(room === 1 ? limit : Buffer.byteLength(source) + 1);
  expect((await read(f.paseoPath)).agents.providers.opencode.enabled).toBe(false);
  expect((await read(f.ownerPath)).safetyCommandsEnabled).toBe(false);
  expect(await migrateSettings(f.options, f.dependencies)).toMatchObject({ verified: true });
  expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
});

it.each([0, 25])('checks final forward bytes against the legacy limit for a shared Paseo path (room=%i)', async room => {
  const f = await fixture(true, true);
  const limit = 2 * 1024 * 1024;
  await writeFile(f.paseoPath, `{}${' '.repeat(limit - room - 2)}`);
  const source = await readFile(f.paseoPath, 'utf8');
  if (room === 0) {
    f.dependencies.lock.mockClear();
    await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow('Primary Paseo write exceeds 2 MiB');
    expect(await readFile(f.paseoPath, 'utf8')).toBe(source);
    await expect(lstat(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(f.ownerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.dependencies.lock).not.toHaveBeenCalled();
    await save(f.paseoPath, {});
  }
  expect(await migrateSettings(f.options, f.dependencies)).toMatchObject({ verified: true });
  expect((await lstat(f.paseoPath)).size).toBeLessThanOrEqual(limit);
  if (room === 25) expect((await lstat(f.paseoPath)).size).toBe(limit);
  expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
});

it.each(['plan', 'forward', 'verify', 'reverse'] as const)('refuses a legacy Paseo input over 2 MiB in %s mode', async mode => {
  const f = await fixture();
  await migrateSettings(f.options, f.dependencies);
  const source = await readFile(f.legacyPaseo, 'utf8');
  await writeFile(f.legacyPaseo, `${source}${' '.repeat(2 * 1024 * 1024 + 1 - Buffer.byteLength(source))}`);
  const setting = new WorkerApprovalsSetting(f.legacyPaseo, f.legacyDir, {
    providers: async () => [], effectiveProviders: async () => ({}),
    reload: async () => ({ appliedPaths: [], restartRequiredPaths: [], overrideControlledPaths: [] }),
  });
  await expect(setting.status()).rejects.toThrow('at most 2 MiB');
  const paths = [f.ownerPath, f.paseoPath, f.legacyPaseo, f.receiptPath];
  const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
  f.dependencies.lock.mockClear();
  await expect(migrateSettings({ ...f.options, mode }, f.dependencies)).rejects.toThrow('parse_failed');
  expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(before);
  expect(f.dependencies.lock).not.toHaveBeenCalled();
});

it.each([
  { name: 'hermes-safety-commands.json', growth: 1 },
  { name: 'worker-updates.json', growth: 1 },
  { name: 'voice.json', growth: 1 },
  { name: 'feed.json', growth: 1 },
  { name: 'worker-approvals.json', growth: 2 },
  { name: 'Paseo', growth: 1 },
  { name: 'configuration', growth: 1 },
].flatMap(entry => [0, entry.growth].map(room => ({ ...entry, room }))))(
  'checks final $name bytes against its legacy reader contract (room=$room)', async ({ name, growth, room }) => {
    const f = await fixture();
    if (name === 'worker-updates.json') {
      const path = join(f.legacyDir, name);
      await save(path, { ...await read(path), enabled: true });
    }
    await migrateSettings(f.options, f.dependencies);
    if (name === 'worker-approvals.json') await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies);
    const primary = await read(f.ownerPath);
    if (name === 'feed.json') {
      const path = join(f.legacyDir, name);
      const feed = await read(path);
      feed.settings.quietHours = primary.quietHours;
      feed.settings.push = primary.push;
      await save(path, feed);
    }
    const path = name === 'Paseo' ? f.legacyPaseo : name === 'configuration' ? f.legacyConfig : join(f.legacyDir, name);
    const bounded = name === 'Paseo' || name === 'worker-approvals.json';
    const limit = (name === 'Paseo' ? 2 : name === 'worker-approvals.json' ? 16 : 4) * 1024 * 1024;
    const source = await readFile(path, 'utf8');
    await writeFile(path, `${source}${' '.repeat(limit - room - Buffer.byteLength(source))}`);
    expect((await lstat(path)).size).toBe(limit - room);
    if (name === 'Paseo' || name === 'worker-approvals.json') {
      const paseo = await read(f.paseoPath);
      if (name === 'Paseo') paseo.agents.providers.opencode.enabled = false;
      else paseo.agents.providers.custom.paseoTools.futurePolicy.mode = 'éxample';
      await save(f.paseoPath, paseo);
    } else {
      if (name === 'hermes-safety-commands.json') primary.safetyCommandsEnabled = false;
      if (name === 'worker-updates.json') primary.workerUpdates.enabled = false;
      if (name === 'voice.json') primary.voice.voice = 'af_nicole';
      if (name === 'feed.json') primary.feed.level = 'high';
      if (name === 'configuration') primary.timeZone = 'Etc/GMT0';
      await save(f.ownerPath, primary);
    }
    if (bounded && room < growth) {
      const paths = [f.ownerPath, f.paseoPath, f.legacyPaseo, f.legacyConfig, f.receiptPath,
        ...['wayroost-settings.json', 'hermes-safety-commands.json', 'worker-updates.json', 'voice.json', 'feed.json', 'worker-approvals.json'].map(name => join(f.legacyDir, name))];
      const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
      const entries = await readdir(f.legacyDir);
      f.dependencies.lock.mockClear();
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies)).rejects.toThrow(`Legacy ${name} write exceeds ${name === 'Paseo' ? 2 : 16} MiB`);
        expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(before);
        expect(await readdir(f.legacyDir)).toEqual(entries);
        expect(f.dependencies.lock).not.toHaveBeenCalled();
      }
      await writeFile(path, source);
    }
    expect(await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies)).toMatchObject({ verified: true });
    if (bounded) expect((await lstat(path)).size).toBeLessThanOrEqual(limit);
    if (!bounded || room === growth) expect((await lstat(path)).size).toBe(limit - room + growth);
    expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
    if (name === 'Paseo') {
      const setting = new WorkerApprovalsSetting(f.legacyPaseo, f.legacyDir, {
        providers: async () => [], effectiveProviders: async () => ({}),
        reload: async () => ({ appliedPaths: [], restartRequiredPaths: [], overrideControlledPaths: [] }),
      });
      await expect(setting.status()).resolves.toMatchObject({ enabled: true });
    }
  },
);

it('accepts a new approval document beyond 4 MiB within its 16 MiB reader limit', async () => {
  const f = await fixture(true);
  await migrateSettings(f.options, f.dependencies);
  const paseo = await read(f.paseoPath);
  delete paseo.unrelated;
  delete paseo.agents.other;
  paseo.agents.providers = Object.fromEntries(['claude', 'codex', 'copilot', 'opencode', 'pi', 'omp'].map(id => [id, {
    paseoTools: { disabledTools: [...WORKER_APPROVAL_TOOLS], ...(id === 'pi' ? { futurePolicy: { payload: '' } } : {}) },
  }]));
  const room = 2 * 1024 * 1024 - Buffer.byteLength(`${JSON.stringify(paseo)}\n`);
  paseo.agents.providers.pi.paseoTools.futurePolicy.payload = `${'é'.repeat(Math.floor(room / 2))}${room % 2 ? 'x' : ''}`;
  await writeFile(f.paseoPath, `${JSON.stringify(paseo)}\n`);
  await writeFile(f.legacyPaseo, `${JSON.stringify({ agents: { providers: {} } })}\n`);
  expect((await lstat(f.paseoPath)).size).toBe(2 * 1024 * 1024);
  expect(await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies)).toMatchObject({ verified: true });
  const size = (await lstat(join(f.legacyDir, 'worker-approvals.json'))).size;
  expect(size).toBeGreaterThan(4 * 1024 * 1024);
  expect(size).toBeLessThan(16 * 1024 * 1024);
  expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
});

it('resumes and reverses a large policy and approval snapshot without duplicating undo state', async () => {
  const f = await fixture();
  const source = await read(f.legacyPaseo);
  const largePolicy = { ...policy, futurePolicy: { payload: 'x'.repeat(1024 * 1024) } };
  source.agents.providers.custom.paseoTools = largePolicy;
  await save(f.legacyPaseo, source);
  const approvalPath = join(f.legacyDir, 'worker-approvals.json');
  const state = await read(approvalPath);
  state.backup.custom = { entry: 'existing', before: largePolicy, applied: largePolicy };
  await save(approvalPath, state);
  const originalLock = f.dependencies.lock.getMockImplementation()!;
  let calls = 0;
  f.dependencies.lock.mockImplementation((target, work) => {
    if (++calls === 2) throw new Error('Interrupted');
    return originalLock(target, work);
  });
  await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow();
  const receipt = await read(f.receiptPath);
  expect(receipt.phase).toBe('prepared');
  expect(await savedDocument(f, 'worker-approvals.json')).toEqual(state);
  expect(receipt).not.toHaveProperty('approvalState');
  expect(receipt).not.toHaveProperty('untouched');
  expect((await lstat(f.receiptPath)).size).toBeLessThan(4 * 1024 * 1024);
  f.dependencies.lock.mockImplementation(originalLock);
  expect(await migrateSettings(f.options, f.dependencies)).toMatchObject({ verified: true });
  expect(await migrateSettings(f.options, f.dependencies)).toMatchObject({ verified: true });
  const current = await read(f.paseoPath);
  current.agents.providers.claude.enabled = true;
  await save(f.paseoPath, current);
  await rm(approvalPath);
  expect(await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies)).toMatchObject({ verified: true });
  expect((await read(f.legacyPaseo)).agents.providers).toEqual(current.agents.providers);
  expect((await read(approvalPath)).backup.custom.before).toEqual(largePolicy);
  expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
});

it('stores large untouched preferences separately and keeps their receipt readable', async () => {
  const f = await fixture();
  for (const name of ['worker-updates.json', 'voice.json']) {
    const path = join(f.legacyDir, name);
    await save(path, { ...await read(path), untouched: 'x'.repeat(2 * 1024 * 1024) });
  }
  for (let attempt = 0; attempt < 2; attempt++) expect(await migrateSettings(f.options, f.dependencies)).toMatchObject({ verified: true });
  expect((await lstat(f.receiptPath)).size).toBeLessThan(16 * 1024);
  for (const name of ['worker-updates.json', 'voice.json']) {
    expect(await savedDocument(f, name)).toEqual(await read(join(f.legacyDir, name)));
    await rm(join(f.legacyDir, name));
  }
  await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies);
  for (const name of ['worker-updates.json', 'voice.json']) expect((await read(join(f.legacyDir, name))).untouched).toHaveLength(2 * 1024 * 1024);
});

it.each(['forward', 'reverse'] as const)('reserves receipt space before %s target writes', async mode => {
  const f = await fixture();
  const originalLock = f.dependencies.lock.getMockImplementation()!;
  if (mode === 'forward') {
    let calls = 0;
    f.dependencies.lock.mockImplementation((target, work) => {
      if (++calls === 2) throw new Error('Interrupted');
      return originalLock(target, work);
    });
    await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow('Settings file operation failed.');
  } else await migrateSettings(f.options, f.dependencies);
  const receipt = await read(f.receiptPath);
  receipt.padding = '';
  const size = Buffer.byteLength(`${JSON.stringify(receipt)}\n`);
  receipt.padding = 'x'.repeat(4 * 1024 * 1024 - size - (mode === 'forward' ? 10 : 1));
  const before = `${JSON.stringify(receipt)}\n`;
  await writeFile(f.receiptPath, before);
  f.dependencies.lock.mockImplementation(originalLock);
  f.dependencies.lock.mockClear();
  const paths = [f.paseoPath, f.legacyPaseo, f.legacyConfig, ...['wayroost-settings.json', 'worker-updates.json', 'worker-approvals.json'].map(name => join(f.legacyDir, name))];
  if (mode === 'reverse') paths.push(f.ownerPath);
  const originals = await Promise.all(paths.map(path => readFile(path, 'utf8')));
  await expect(migrateSettings({ ...f.options, mode }, f.dependencies)).rejects.toThrow('Migration receipt exceeds 4 MiB');
  expect(await readFile(f.receiptPath, 'utf8')).toBe(before);
  expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(originals);
  if (mode === 'forward') await expect(lstat(f.ownerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.dependencies.lock).not.toHaveBeenCalled();
});

it.each([false, true])('keeps every phase readable at the exact receipt byte limit (indented=%s)', async indented => {
  const f = await fixture();
  const originalLock = f.dependencies.lock.getMockImplementation()!;
  f.dependencies.lock.mockImplementation((target, work) => {
    if (target.path === f.paseoPath) throw new Error('Interrupted');
    return originalLock(target, work);
  });
  await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow('Settings file operation failed.');
  const receipt = await read(f.receiptPath);
  const limit = 4 * 1024 * 1024;
  receipt.padding = '';
  const render = (value: unknown) => `${JSON.stringify(value, null, indented ? 2 : undefined)}\n`;
  const reserved = { ...receipt, phase: 'reversing', targetHashes: { owner: '0'.repeat(64), paseo: '0'.repeat(64) } };
  const room = limit - Buffer.byteLength(render(reserved));
  receipt.padding = `${'é'.repeat(Math.floor(room / 2))}${room % 2 ? 'x' : ''}`;
  expect(Buffer.byteLength(render({ ...reserved, padding: receipt.padding }))).toBe(limit);
  await writeFile(f.receiptPath, render(receipt));
  const publications: { phase: string; size: number }[] = [];
  f.dependencies.lock.mockImplementation(async (target, work) => {
    const result = await originalLock(target, work);
    if (target.path === f.receiptPath) {
      const size = (await lstat(target.path)).size;
      expect(size).toBeLessThanOrEqual(limit);
      publications.push({ phase: (await read(target.path)).phase, size });
    }
    return result;
  });
  expect(await migrateSettings(f.options, f.dependencies)).toMatchObject({ verified: true });
  expect(await migrateSettings(f.options, f.dependencies)).toMatchObject({ verified: true });
  expect(await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies)).toMatchObject({ verified: true });
  expect(publications).toContainEqual({ phase: 'reversing', size: limit });
  expect((await read(f.receiptPath)).phase).toBe('reverse');
  expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
});

it('refuses source aliases and an existing unsupported owner document before creating receipts', async () => {
  const f = await fixture();
  const path = join(f.legacyDir, 'voice.json');
  const owner = f.options.site.targets['wayroost-settings']!;
  const alias = { ...f.options, site: { ...f.options.site, targets: { ...f.options.site.targets,
    'wayroost-settings': { ...owner, path, lock: { kind: 'file' as const, path: `${path}.wayroost-settings.lock` } },
  } } };
  await expect(migrateSettings(alias, f.dependencies)).rejects.toThrow('Migration paths overlap');
  await expect(lstat(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await save(f.ownerPath, { version: 2 });
  await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow();
  expect(await read(f.ownerPath)).toEqual({ version: 2 });
  await expect(lstat(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

async function migrationTree(root: string): Promise<unknown> {
  const entries = await readdir(root, { withFileTypes: true });
  return Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async entry => {
    const path = join(root, entry.name);
    const info = await lstat(path);
    return [entry.name, info.mode, info.uid, info.gid, entry.isDirectory() ? await migrationTree(path)
      : entry.isSymbolicLink() ? await fs.readlink(path) : await readFile(path, 'hex')];
  }));
}

it.each(['paseo-config', 'wayroost-settings'] as const)(
  'refuses a legacy configuration inside %s audit storage before any write', async id => {
    const f = await fixture();
    const path = join(f.options.site.targets[id]!.auditDir, 'audit.jsonl');
    await copyFile(f.legacyConfig, path);
    const before = await migrationTree(f.root);
    await expect(migrateSettings({ ...f.options, legacyConfig: path }, f.dependencies)).rejects.toThrow('Migration paths overlap');
    expect(await migrationTree(f.root)).toEqual(before);
    expect(f.dependencies.lock).not.toHaveBeenCalled();
  },
);

it.each(['receipt', 'configured-lock', 'generated-lock', 'nested-backup', 'legacy-directory'] as const)(
  'refuses source overlap with a %s artifact before reading inputs', async kind => {
    const f = await fixture();
    const owner = f.options.site.targets['wayroost-settings']!;
    const paseo = f.options.site.targets['paseo-config']!;
    const path = kind === 'receipt' ? f.receiptPath : kind === 'configured-lock' ? paseo.lock.path
      : kind === 'generated-lock' ? `${paseo.path}.wayroost-settings.lock`
      : join(owner.backupDir, kind === 'legacy-directory' ? 'legacy' : 'files/input.json');
    if (kind === 'nested-backup') await mkdir(join(owner.backupDir, 'files'), { mode: 0o700 });
    if (kind === 'legacy-directory') await mkdir(path, { mode: 0o700 });
    else await copyFile(f.legacyConfig, path);
    const options = kind === 'legacy-directory' ? { ...f.options, legacyDir: path } : { ...f.options, legacyConfig: path };
    const before = await migrationTree(f.root);
    for (const mode of ['plan', 'forward', 'verify', 'reverse'] as const) {
      await expect(migrateSettings({ ...options, mode }, f.dependencies)).rejects.toThrow('Migration paths overlap');
      expect(await migrationTree(f.root)).toEqual(before);
      expect(f.dependencies.lock).not.toHaveBeenCalled();
      expect(f.dependencies.validatePaseo).not.toHaveBeenCalled();
    }
  },
);

it.each(['paseo-config', 'wayroost-settings'] as const)(
  'refuses legacy sources throughout %s backup and audit storage', async id => {
    const f = await fixture();
    const target = f.options.site.targets[id]!;
    for (const directory of [target.backupDir, target.auditDir]) {
      const path = join(directory, 'input.json');
      await copyFile(f.legacyPaseo, path);
      const before = await migrationTree(f.root);
      for (const mode of ['plan', 'forward'] as const) {
        await expect(migrateSettings({ ...f.options, mode, legacyPaseo: path }, f.dependencies)).rejects.toThrow('Migration paths overlap');
        expect(await migrationTree(f.root)).toEqual(before);
        expect(f.dependencies.lock).not.toHaveBeenCalled();
        expect(f.dependencies.validatePaseo).not.toHaveBeenCalled();
      }
    }
  },
);

it.each(['worker-updates.json', 'hermes-safety-commands.json', 'voice.json', 'feed.json', 'worker-approvals.json', 'legacyPaseo', 'legacyConfig'] as const)(
  'imports %s with the legacy replacement decoding contract', async name => {
  const f = await fixture();
  const path = name === 'legacyPaseo' || name === 'legacyConfig' ? f[name] : join(f.legacyDir, name);
  const document = await read(path);
  if (name === 'worker-approvals.json') document.backup.claude.before.label = '\uFFFD';
  else if (name === 'legacyConfig') document.stateDir = '/home/me/\uFFFD';
  else document.unrelated = '\uFFFD';
  const [start, end] = JSON.stringify(document).split('\uFFFD');
  const source = Buffer.concat([Buffer.from(start!), Buffer.from([0xff]), Buffer.from(end!)]);
  await writeFile(path, source);
  const worker = new WorkerUpdatesSetting(f.legacyDir);
  expect(worker.status()).toMatchObject({ enabled: false, defaultMinutes: 30 });
  const safety = new SafetyCommandsSetting(f.legacyDir);
  const voice = new VoiceSetting(f.legacyDir);
  const feed = new FeedStore(f.legacyDir).settings();
  const approvals = new WorkerApprovalsSetting(f.legacyPaseo, f.legacyDir, {
    providers: async () => [], effectiveProviders: async () => ({}),
    reload: async () => ({ appliedPaths: [], restartRequiredPaths: [], overrideControlledPaths: [] }),
  });
  expect((await approvals.status()).enabled).toBe(true);
  expect(parseConfig(JSON.parse(await readFile(f.legacyConfig, 'utf8')), { env: {}, withoutSupervisor: true }).notifications.timeZone).toBe('Etc/UTC');
  await migrateSettings(f.options, f.dependencies);
  expect(await read(f.ownerPath)).toMatchObject({ workerUpdates: { enabled: worker.enabled(), defaultMinutes: worker.defaultMinutes() },
    safetyCommandsEnabled: safety.enabled(), voice: { voice: voice.voice(), appReadAloud: voice.appReadAloud() },
    feed: { level: feed.level, lessLike: feed.lessLike }, timeZone: 'Etc/UTC' });
  if (name === 'worker-approvals.json') expect((await savedDocument(f, 'worker-approvals.json')).backup.claude.before.label).toBe('\uFFFD');
  expect(await readFile(path)).toEqual(source);
  expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
  const before = await migrationTree(f.root);
  f.dependencies.lock.mockClear();
  await expect(migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies)).rejects.toThrow('parse_failed');
  expect(await migrationTree(f.root)).toEqual(before);
  expect(f.dependencies.lock).not.toHaveBeenCalled();
});

it('refuses malformed UTF-8 in notifications before any migration write', async () => {
  const f = await fixture();
  await writeFile(join(f.legacyDir, 'wayroost-settings.json'), Buffer.concat([
    Buffer.from('{"push":{"approvals":false,"cards":true},"unrelated":"'), Buffer.from([0xff]), Buffer.from('"}'),
  ]));
  expect(new NotificationSettingsStore(f.legacyDir).settings().push).toEqual({ approvals: true, cards: false });
  const before = await migrationTree(f.root);
  await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow('parse_failed');
  expect(await migrationTree(f.root)).toEqual(before);
  expect(f.dependencies.lock).not.toHaveBeenCalled();
});

it.each([0, 1])('uses the 16 MiB approval state boundary with %i extra bytes', async extra => {
  const f = await fixture();
  const path = join(f.legacyDir, 'worker-approvals.json');
  await writeFile(path, JSON.stringify(await read(path)).padEnd(16 * 1024 * 1024 + extra, ' '));
  const setting = () => new WorkerApprovalsSetting(f.legacyPaseo, f.legacyDir, {
    providers: async () => [], effectiveProviders: async () => ({}),
    reload: async () => ({ appliedPaths: [], restartRequiredPaths: [], overrideControlledPaths: [] }),
  });
  if (extra) {
    expect(setting).toThrow('Safety state is invalid');
    const before = await migrationTree(f.root);
    await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow('parse_failed');
    expect(await migrationTree(f.root)).toEqual(before);
    expect(f.dependencies.lock).not.toHaveBeenCalled();
  } else {
    expect(setting).not.toThrow();
    expect(await migrateSettings(f.options, f.dependencies)).toMatchObject({ verified: true });
    expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
  }
});

it.each(['feed.json', 'worker-approvals.json'] as const)('imports %s beyond 4 MiB using its legacy reader limit', async name => {
  const f = await fixture();
  const path = join(f.legacyDir, name);
  const document = await read(path);
  if (name === 'feed.json') document.settings.level = 'high';
  const source = JSON.stringify(document).padEnd(4 * 1024 * 1024 + 1024, ' ');
  await writeFile(path, source);
  if (name === 'feed.json') expect(new FeedStore(f.legacyDir).settings().level).toBe('high');
  else expect(() => new WorkerApprovalsSetting(f.legacyPaseo, f.legacyDir, {
    providers: async () => [], effectiveProviders: async () => ({}),
    reload: async () => ({ appliedPaths: [], restartRequiredPaths: [], overrideControlledPaths: [] }),
  })).not.toThrow();
  await migrateSettings(f.options, f.dependencies);
  if (name === 'feed.json') expect((await read(f.ownerPath)).feed.level).toBe('high');
  else expect((await savedDocument(f, 'worker-approvals.json'))).toEqual(document);
  expect(await readFile(path, 'utf8')).toBe(source);
  expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
  const primary = await read(f.ownerPath);
  primary.feed.level = 'low';
  primary.workerUpdates.enabled = true;
  await save(f.ownerPath, primary);
  expect(await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies)).toMatchObject({ verified: true });
  expect(new FeedStore(f.legacyDir).settings().level).toBe('low');
  expect(new WorkerUpdatesSetting(f.legacyDir).enabled()).toBe(true);
  expect((await lstat(path)).size).toBeGreaterThan(4 * 1024 * 1024);
});

it('validates every reverse consumer before changing the forward receipt', async () => {
  const f = await fixture();
  await migrateSettings(f.options, f.dependencies);
  const current = await read(f.ownerPath);
  await save(f.ownerPath, { ...current, timeZone: '+05:30' });
  expect(() => wayroostSettingsSchema.parse({ ...current, timeZone: '+05:30' })).not.toThrow();
  expect(() => parseConfig({ publicOrigin: 'https://example.com', notifications: { timeZone: '+05:30' } }, { env: {}, withoutSupervisor: true })).toThrow();
  const before = await migrationTree(f.root);
  f.dependencies.lock.mockClear();
  await expect(migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies)).rejects.toThrow();
  expect(await migrationTree(f.root)).toEqual(before);
  expect(f.dependencies.lock).not.toHaveBeenCalled();
  await save(f.ownerPath, { ...current, timeZone: 'Europe/London' });
  expect(await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies)).toMatchObject({ verified: true });
  expect(parseConfig(await read(f.legacyConfig), { env: {}, withoutSupervisor: true }).notifications.timeZone).toBe('Europe/London');
});

it.each(['forward', 'reverse'] as const)('preflights the %s provider schema before receipt writes', async mode => {
  const f = await fixture();
  if (mode === 'reverse') await migrateSettings(f.options, f.dependencies);
  f.dependencies.validatePaseo.mockRejectedValue(new Error('Invented consumer rejection'));
  f.dependencies.lock.mockClear();
  const before = await migrationTree(f.root);
  await expect(migrateSettings({ ...f.options, mode }, f.dependencies)).rejects.toThrow('Invented consumer rejection');
  expect(await migrationTree(f.root)).toEqual(before);
  expect(f.dependencies.lock).not.toHaveBeenCalled();
});

it.each(['forward', 'reverse'] as const)('preflights all %s storage and lock artifacts before receipt writes', async mode => {
  const f = await fixture();
  if (mode === 'reverse') await migrateSettings(f.options, f.dependencies);
  const paseo = f.options.site.targets['paseo-config']!;
  const owner = f.options.site.targets['wayroost-settings']!;
  const paseoDestination = mode === 'reverse' ? f.legacyPaseo : paseo.path;
  const artifacts = [
    { path: paseo.auditDir, kind: 'directory' },
    { path: paseo.backupDir, kind: 'directory' },
    { path: join(owner.backupDir, 'files'), kind: 'directory' },
    { path: join(paseo.auditDir, 'audit.jsonl'), kind: 'file' },
    { path: `${paseoDestination}.wayroost.lock`, kind: 'symlink' },
    { path: `${paseoDestination}.wayroost-settings.lock`, kind: 'lock' },
    ...(mode === 'reverse' ? [{ path: `${f.legacyConfig}.wayroost-settings.lock`, kind: 'lock' }] : []),
  ];
  for (const artifact of artifacts) {
    const existing = await lstat(artifact.path).catch(() => undefined);
    if (artifact.kind === 'directory') {
      if (!existing) await mkdir(artifact.path, { mode: 0o700 });
      await chmod(artifact.path, 0o755);
    } else {
      if (existing) await rm(artifact.path);
      if (artifact.kind === 'symlink') await symlink(f.legacyConfig, artifact.path);
      else await save(artifact.path, artifact.kind === 'lock' ? { pid: process.pid } : {});
      if (artifact.kind === 'file') await chmod(artifact.path, 0o644);
    }
    f.dependencies.lock.mockClear();
    const before = await migrationTree(f.root);
    await expect(migrateSettings({ ...f.options, mode }, f.dependencies), artifact.path).rejects.toThrow();
    expect(await migrationTree(f.root)).toEqual(before);
    expect(f.dependencies.lock).not.toHaveBeenCalled();
    if (artifact.kind === 'directory') await chmod(artifact.path, existing ? existing.mode & 0o7777 : 0o700);
    else {
      await rm(artifact.path);
      if (existing) await writeFile(artifact.path, '', { mode: existing.mode & 0o7777 });
    }
  }
});

it.each([
  { enabled: false, defaultMinutes: '30' }, { enabled: 'false', defaultMinutes: [30] },
  { enabled: null, defaultMinutes: 'invalid' }, { enabled: 0, defaultMinutes: null },
])('imports worker update coercions using the legacy reader for %j', async worker => {
  const f = await fixture();
  await save(join(f.legacyDir, 'worker-updates.json'), worker);
  const legacy = new WorkerUpdatesSetting(f.legacyDir);
  await migrateSettings(f.options, f.dependencies);
  expect((await read(f.ownerPath)).workerUpdates).toEqual({ enabled: legacy.enabled(), defaultMinutes: legacy.defaultMinutes() });
  expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
});

it('imports duplicate JSON keys using the last value as the legacy safety reader does', async () => {
  const f = await fixture();
  await writeFile(join(f.legacyDir, 'hermes-safety-commands.json'), '{"enabled":false,"enabled":true}');
  expect(new SafetyCommandsSetting(f.legacyDir).enabled()).toBe(true);
  await migrateSettings(f.options, f.dependencies);
  expect((await read(f.ownerPath)).safetyCommandsEnabled).toBe(true);
});

it.each([false, 'true', 1, null])('imports safety command value %j with literal-true semantics', async enabled => {
  const f = await fixture();
  await save(join(f.legacyDir, 'hermes-safety-commands.json'), { enabled });
  await migrateSettings(f.options, f.dependencies);
  expect((await read(f.ownerPath)).safetyCommandsEnabled).toBe(new SafetyCommandsSetting(f.legacyDir).enabled());
});

it.each([
  { voice: 'invalid', appReadAloud: { provider: 'elevenlabs', voiceId: 'invalid!', modelId: 'fake' } },
  { voice: false, appReadAloud: { provider: 'other' } },
  { voice: 'af_heart', appReadAloud: { provider: 'elevenlabs', voiceId: 'fake', modelId: 'fake', extra: true } },
])('imports voice reader defaults and retained fields from %j', async voice => {
  const f = await fixture();
  await save(join(f.legacyDir, 'voice.json'), voice);
  const legacy = new VoiceSetting(f.legacyDir);
  await migrateSettings(f.options, f.dependencies);
  expect((await read(f.ownerPath)).voice).toEqual({ voice: legacy.voice(), appReadAloud: legacy.appReadAloud() });
});

it('imports feed reader defaults without discarding valid sibling preferences', async () => {
  const f = await fixture();
  const path = join(f.legacyDir, 'feed.json');
  await save(path, { ...await read(path), settings: { level: 'invalid', lessLike: false, push: { cards: true } } });
  const legacy = new FeedStore(f.legacyDir).settings();
  await migrateSettings(f.options, f.dependencies);
  expect((await read(f.ownerPath)).feed).toEqual({ level: legacy.level, lessLike: legacy.lessLike });
});

it('strips ignored feed fields before carrying pre-seeding notification choices', async () => {
  const f = await fixture();
  await rm(join(f.legacyDir, 'wayroost-settings.json'));
  await save(join(f.legacyDir, 'feed.json'), { settings: { level: 'high',
    quietHours: { start: '23:00', end: '05:00', extra: true }, push: { approvals: false, cards: true, extra: true } } });
  const legacy = new FeedStore(f.legacyDir).settings();
  await migrateSettings(f.options, f.dependencies);
  expect(await read(f.ownerPath)).toMatchObject({ quietHours: legacy.quietHours, push: legacy.push });
});

it('preflights the existing shared audit lock before any receipt writes', async () => {
  const f = await fixture();
  const paseo = f.options.site.targets['paseo-config']!;
  const audit = join(paseo.auditDir, 'audit.jsonl');
  await writeFile(audit, '', { mode: 0o600 });
  const info = await lstat(audit);
  await save(join(paseo.backupDir, `.wayroost-audit-${info.dev}-${info.ino}.lock`), { pid: process.pid });
  const before = await migrationTree(f.root);
  await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow('locked');
  expect(await migrationTree(f.root)).toEqual(before);
  expect(f.dependencies.lock).not.toHaveBeenCalled();
});

it.each([4_294_967_295, 12345])('preflights saved restoration group %i before changing files', async gid => {
  const f = await fixture();
  await migrateSettings(f.options, f.dependencies);
  const receipt = await read(f.receiptPath);
  receipt.metadata['worker-updates.json'].gid = gid;
  await save(f.receiptPath, receipt);
  await rm(join(f.legacyDir, 'worker-updates.json'));
  const before = await migrationTree(f.root);
  f.dependencies.lock.mockClear();
  await expect(migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies)).rejects.toThrow();
  expect(await migrationTree(f.root)).toEqual(before);
  expect(f.dependencies.lock).not.toHaveBeenCalled();
});


it.each(['feed.json', 'worker-updates.json', 'voice.json', 'hermes-safety-commands.json'])(
  'imports defaults for malformed %s and emits only a constant warning', async name => {
    const f = await fixture(true);
    await writeFile(join(f.legacyDir, name), '{"privateSentinel":');
    const warning = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await migrateSettings(f.options, f.dependencies);
    expect(warning.mock.calls.flat().join('')).toContain(name);
    expect(warning.mock.calls.flat().join('')).not.toContain('privateSentinel');
    expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
  },
);

it.each(['null', '[]', '"off"', '0'])('imports the feed push default for %s', async push => {
  const f = await fixture(true);
  await writeFile(join(f.legacyDir, 'feed.json'), `{"settings":{"push":${push}}}`);
  await migrateSettings(f.options, f.dependencies);
  expect((await read(f.ownerPath)).push).toEqual(new FeedStore(f.legacyDir).settings().push);
});

it.each(['[]', '"oops"', '42'])('imports defaults for feed settings %s', async settings => {
  const f = await fixture(true);
  await writeFile(join(f.legacyDir, 'feed.json'), `{"settings":${settings}}`);
  await migrateSettings(f.options, f.dependencies);
  expect((await read(f.ownerPath)).feed.level).toBe(new FeedStore(f.legacyDir).settings().level);
});

it('refuses an empty approval object before writing anything', async () => {
  const f = await fixture();
  await save(join(f.legacyDir, 'worker-approvals.json'), {});
  expect(() => new WorkerApprovalsSetting(f.legacyPaseo, f.legacyDir, { providers: vi.fn(), effectiveProviders: vi.fn(), reload: vi.fn() })).toThrow();
  const before = await migrationTree(f.root);
  await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow();
  expect(await migrationTree(f.root)).toEqual(before);
});

it.each(['{"enabled":false,"defaultMinutes":1e400}', '{"enabled":false,"unrelated":1e400}'])(
  'imports numeric defaults before validating output from %s', async source => {
    const f = await fixture();
    await writeFile(join(f.legacyDir, 'worker-updates.json'), source);
    const legacy = new WorkerUpdatesSetting(f.legacyDir);
    await migrateSettings(f.options, f.dependencies);
    expect(effectiveSettings(await read(f.ownerPath))).toMatchObject({ workerUpdates: { enabled: legacy.enabled(), defaultMinutes: legacy.defaultMinutes() } });
  },
);

it.each(['forward', 'reverse'] as const)('preflights every reaper before %s writes', async mode => {
  const f = await fixture();
  if (mode === 'reverse') await migrateSettings(f.options, f.dependencies);
  const target = mode === 'forward' ? f.ownerPath : f.legacyConfig;
  const lock = `${target}.wayroost-settings.lock`;
  await save(lock, { pid: 2_000_000_000 });
  await save(`${lock}.reap`, { pid: process.pid });
  const before = await migrationTree(f.root);
  await expect(migrateSettings({ ...f.options, mode }, f.dependencies)).rejects.toThrow('locked');
  expect(await migrationTree(f.root)).toEqual(before);
});

it('uses the application environment to validate a legacy development config', async () => {
  const f = await fixture();
  vi.stubEnv('WAYROOST_DEV_ALLOW_LOOPBACK', '1');
  try {
    await save(f.legacyConfig, { publicOrigin: 'http://127.0.0.1:19010', notifications: { timeZone: 'Etc/UTC' } });
    await migrateSettings(f.options, f.dependencies);
    expect((await read(f.ownerPath)).timeZone).toBe('Etc/UTC');
  } finally { vi.unstubAllEnvs(); }
});

it('ignores uncovered provider entries through the legacy policy reader', async () => {
  const f = await fixture(true);
  await save(f.legacyPaseo, { agents: { providers: { claude: { enabled: 'yes' }, pi: { paseoTools: { disabledTools: ['kill_agent'] } } } } });
  const warning = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  await migrateSettings(f.options, f.dependencies);
  expect(warning).toHaveBeenCalledWith('Warning: legacy Paseo configuration: invalid_value; reader defaults applied.\n');
  expect((await read(f.paseoPath)).agents.providers).toEqual({ pi: { paseoTools: { disabledTools: ['kill_agent'] } } });
});


async function parityAppReaders() {
  const baseline = process.env.WAYROOST_READER_BASELINE;
  if (!baseline) return { FeedStore, WorkerUpdatesSetting, VoiceSetting, SafetyCommandsSetting, NotificationSettingsStore, WorkerApprovalsSetting, loadConfig };
  const directory = pathToFileURL(`${resolve(baseline)}/server/src/`).href;
  const [feed, worker, voice, safety, notifications, approvals, config] = await Promise.all([
    import(`${directory}feed/store.ts`) as Promise<typeof import('../server/src/feed/store.js')>,
    import(`${directory}tasks/setting.ts`) as Promise<typeof import('../server/src/tasks/setting.js')>,
    import(`${directory}voice-setting.ts`) as Promise<typeof import('../server/src/voice-setting.js')>,
    import(`${directory}hermes/safety.ts`) as Promise<typeof import('../server/src/hermes/safety.js')>,
    import(`${directory}notifications/settings.ts`) as Promise<typeof import('../server/src/notifications/settings.js')>,
    import(`${directory}paseo/safety-setting.ts`) as Promise<typeof import('../server/src/paseo/safety-setting.js')>,
    import(`${directory}config.ts`) as Promise<typeof import('../server/src/config.js')>,
  ]);
  return { ...feed, ...worker, ...voice, ...safety, ...notifications, ...approvals, ...config };
}

const parityStores = ['feed.json', 'worker-updates.json', 'voice.json', 'hermes-safety-commands.json',
  'wayroost-settings.json', 'worker-approvals.json', 'legacyPaseo', 'legacyConfig'] as const;
const parityCases = ['valid', 'empty', 'malformed', 'wrong types', 'BOM', 'oversized', 'unknown fields', 'absent', 'empty object', 'explicit'] as const;
it.each(parityStores.flatMap(store => parityCases.map(kind => ({ store, kind }))))(
  'matches the app reader for $store: $kind', async ({ store, kind }) => {
    const app = await parityAppReaders();
    const f = await fixture(true);
    const valid: Record<typeof parityStores[number], unknown> = {
      'feed.json': { settings: { level: 'high', quietHours: null, push: { approvals: false, cards: true }, lessLike: [{ topic: 'Example', example: 'Invented', at: 1 }] } },
      'worker-updates.json': { enabled: false, defaultMinutes: '30' },
      'voice.json': { voice: 'af_heart', appReadAloud: { provider: 'elevenlabs', voiceId: 'fake', modelId: 'fake' } },
      'hermes-safety-commands.json': { enabled: true },
      'wayroost-settings.json': { quietHours: null, push: { approvals: false, cards: true } },
      'worker-approvals.json': { version: 1, enabled: false, backup: {}, reloadPending: false },
      legacyPaseo: { agents: { providers: { claude: { enabled: false, paseoTools: { enabled: false } }, custom: { extends: 'pi', label: 'Example provider', paseoTools: { disabledTools: ['kill_agent'] } } } } },
      legacyConfig: { publicOrigin: 'https://example.com', notifications: { timeZone: 'Etc/UTC' } },
    };
    const wrong: Record<typeof parityStores[number], unknown> = {
      'feed.json': { settings: [] }, 'worker-updates.json': { enabled: false, defaultMinutes: { toString: null, valueOf: null } },
      'voice.json': { voice: 0, appReadAloud: [] }, 'hermes-safety-commands.json': { enabled: 'true' },
      'wayroost-settings.json': { push: null }, 'worker-approvals.json': { version: 1, enabled: 'no', backup: {}, reloadPending: false },
      legacyPaseo: { agents: { providers: { claude: { enabled: 'yes' } } } }, legacyConfig: { notifications: { timeZone: false } },
    };
    const explicit: Record<typeof parityStores[number], unknown> = {
      'feed.json': { settings: { level: 'off', quietHours: null, push: { approvals: true, cards: false }, lessLike: [] } },
      'worker-updates.json': { enabled: true, defaultMinutes: 60 }, 'voice.json': { voice: '', appReadAloud: { provider: 'local' } },
      'hermes-safety-commands.json': { enabled: false }, 'wayroost-settings.json': { rules: [], quietHours: null, push: { approvals: true, cards: false } },
      'worker-approvals.json': { version: 1, enabled: true, backup: {}, reloadPending: true },
      legacyPaseo: { agents: { providers: { claude: { enabled: true, paseoTools: {} } } } },
      legacyConfig: { publicOrigin: 'https://example.com', notifications: { timeZone: 'Etc/UTC' } },
    };
    const path = store === 'legacyPaseo' || store === 'legacyConfig' ? f[store] : join(f.legacyDir, store);
    let source = JSON.stringify(kind === 'wrong types' ? wrong[store] : kind === 'explicit' ? explicit[store] : valid[store]);
    if (kind === 'empty') source = '';
    if (kind === 'malformed') source = '{"exampleSentinel":';
    if (kind === 'empty object') source = '{}';
    if (kind === 'BOM') source = `\uFEFF${source}`;
    if (kind === 'unknown fields') source = JSON.stringify({ ...valid[store] as object, unknown: 'Example' });
    if (kind === 'oversized') source = source.padEnd((store === 'wayroost-settings.json' ? 128 * 1024
      : store === 'worker-approvals.json' ? 16 * 1024 * 1024 : store === 'legacyPaseo' ? 2 * 1024 * 1024 : 4 * 1024 * 1024) + 1, ' ');
    if (kind === 'absent') await rm(path, { force: true });
    else await writeFile(path, source, { mode: 0o600 });
    const daemon = { providers: async () => ['claude', 'custom'], effectiveProviders: async () => ({}),
      reload: async () => ({ appliedPaths: [], restartRequiredPaths: [], overrideControlledPaths: [] }) };
    let refused = false;
    let expected: unknown;
    try {
      if (store === 'feed.json') expected = new app.FeedStore(f.legacyDir).settings();
      else if (store === 'worker-updates.json') {
        const reader = new app.WorkerUpdatesSetting(f.legacyDir); expected = { enabled: reader.enabled(), defaultMinutes: reader.defaultMinutes() };
      } else if (store === 'voice.json') {
        const reader = new app.VoiceSetting(f.legacyDir); expected = { voice: reader.voice(), appReadAloud: reader.appReadAloud() };
      } else if (store === 'hermes-safety-commands.json') expected = new app.SafetyCommandsSetting(f.legacyDir).enabled();
      else if (store === 'wayroost-settings.json') {
        const reader = new app.NotificationSettingsStore(f.legacyDir);
        if (!reader.configRead().ok) throw new Error('Refused notification input.');
        expected = reader.settings();
      } else if (store === 'worker-approvals.json') expected = (await new app.WorkerApprovalsSetting(f.legacyPaseo, f.legacyDir, daemon).status()).enabled;
      else if (store === 'legacyConfig') expected = app.loadConfig(path, { env: {}, withoutSupervisor: true }).notifications.timeZone;
      else {
        const reader = new app.WorkerApprovalsSetting(path, f.legacyDir, daemon);
        await reader.status();
        const plan = Reflect.get(reader, 'plan') as (source: string, offered: string[], choice: boolean, backup: object) => { current: Record<string, unknown>; uncovered: string[] };
        const parsed = plan(await readFile(path, 'utf8'), ['claude', 'custom'], false, {});
        expected = Object.fromEntries(Object.entries(parsed.current).filter(([id]) => !parsed.uncovered.includes(id)));
      }
    } catch { refused = true; }
    const before = await migrationTree(f.root);
    const warnings = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    if (refused) {
      await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow();
      expect(await migrationTree(f.root)).toEqual(before);
      expect(f.dependencies.lock).not.toHaveBeenCalled();
      return;
    }
    await migrateSettings(f.options, f.dependencies);
    const effective = effectiveSettings(await read(f.ownerPath)) as Record<string, unknown>;
    if (store === 'feed.json') {
      const feed = expected as ReturnType<FeedStore['settings']>;
      expect(effective.feed).toEqual({ level: feed.level, lessLike: feed.lessLike });
      expect(effective.quietHours).toEqual(feed.quietHours); expect(effective.push).toEqual(feed.push);
    } else if (store === 'worker-updates.json') expect(effective.workerUpdates).toEqual(expected);
    else if (store === 'voice.json') expect(effective.voice).toEqual(expected);
    else if (store === 'hermes-safety-commands.json') expect(effective.safetyCommandsEnabled).toEqual(expected);
    else if (store === 'wayroost-settings.json') {
      const notification = expected as ReturnType<NotificationSettingsStore['settings']>;
      expect(effective.push).toEqual(notification.push); expect(effective.quietHours).toEqual(notification.quietHours);
      expect(effective.rules).toEqual([...notification.rules].sort((a, b) => `${a.event}/${a.source}`.localeCompare(`${b.event}/${b.source}`)));
    } else if (store === 'worker-approvals.json') expect((await read(f.receiptPath)).selectedApprovals).toBe(expected);
    else if (store === 'legacyConfig') expect(effective.timeZone).toBe(expected ?? null);
    else expect((await read(f.paseoPath)).agents.providers).toEqual(expected);
    expect(warnings.mock.calls.flat().join('')).not.toContain('exampleSentinel');
    expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
  },
);

it.each([
  [{ topic: 'Example', example: 'Invented', at: 1.5 }], [{ topic: 'Example', example: 'Invented', at: -1 }],
  [{ topic: 'x'.repeat(41), example: 'Invented', at: 1 }], [{ topic: 'Example', example: 'x'.repeat(101), at: 1 }],
  Array.from({ length: 31 }, () => ({ topic: 'Example', example: 'Invented', at: 1 })),
].map(lessLike => ({ lessLike })))('refuses unrepresentable feed values $lessLike without changing files', async ({ lessLike }) => {
  const f = await fixture(true);
  await save(join(f.legacyDir, 'feed.json'), { settings: { lessLike } });
  expect(new FeedStore(f.legacyDir).settings().lessLike).toEqual(lessLike);
  expect(wayroostSettingsSchema.safeParse({ version: 1, feed: { lessLike } }).success).toBe(false);
  const before = await migrationTree(f.root);
  await expect(migrateSettings(f.options, f.dependencies)).rejects.toThrow();
  expect(await migrationTree(f.root)).toEqual(before);
});

it('imports the stripped effective less-like entries', async () => {
  const f = await fixture(true);
  await save(join(f.legacyDir, 'feed.json'), { settings: { lessLike: [{ topic: 'Example', example: 'Invented', at: 1, ignored: true }] } });
  await migrateSettings(f.options, f.dependencies);
  expect((await read(f.ownerPath)).feed.lessLike).toEqual(new FeedStore(f.legacyDir).settings().lessLike);
  expect((await read(f.ownerPath)).feed.lessLike[0]).not.toHaveProperty('ignored');
});


it.each((['forward', 'reverse'] as const).flatMap(mode =>
  ['receipt', 'paseo', 'owner', 'audit', ...(mode === 'reverse' ? ['configuration'] : [])].flatMap(target =>
    ['live', 'directory', 'nested'].map(kind => ({ mode, target, kind })))))(
  'checks $kind reapers for $target before $mode writes', async ({ mode, target, kind }) => {
    const f = await fixture();
    if (mode === 'reverse') await migrateSettings(f.options, f.dependencies);
    const owner = f.options.site.targets['wayroost-settings']!;
    let lock = `${target === 'receipt' ? f.receiptPath : target === 'paseo' ? mode === 'forward' ? f.paseoPath : f.legacyPaseo
      : target === 'configuration' ? f.legacyConfig : mode === 'forward' ? f.ownerPath : join(f.legacyDir, 'wayroost-settings.json')}.wayroost-settings.lock`;
    if (target === 'audit') {
      const auditPath = join(owner.auditDir, 'audit.jsonl');
      await writeFile(auditPath, '', { mode: 0o600 });
      const stat = await lstat(auditPath);
      lock = join(owner.backupDir, `.wayroost-audit-${stat.dev}-${stat.ino}.lock`);
    }
    await save(lock, { pid: 2_000_000_000 });
    if (kind === 'directory') await mkdir(`${lock}.reap`, { mode: 0o700 });
    else if (kind === 'nested') {
      await save(`${lock}.reap`, { pid: 2_000_000_000 });
      await save(`${lock}.reap.reap`, { pid: process.pid });
    } else await save(`${lock}.reap`, { pid: process.pid });
    const before = await migrationTree(f.root);
    f.dependencies.lock.mockClear();
    await expect(migrateSettings({ ...f.options, mode }, f.dependencies)).rejects.toThrow('locked');
    expect(await migrationTree(f.root)).toEqual(before);
    expect(f.dependencies.lock).not.toHaveBeenCalled();
  },
);

it('exercises every destination lock before publishing a migration receipt', async () => {
  const f = await fixture();
  const actual = f.dependencies.preflightLock.getMockImplementation()!;
  const calls: string[] = [];
  f.dependencies.preflightLock.mockImplementation(async (target, work) => {
    if (!await lstat(f.receiptPath).catch(() => undefined)) calls.push(target.path);
    return actual(target, work);
  });
  await migrateSettings(f.options, f.dependencies);
  expect(calls.slice(0, 3)).toEqual([f.receiptPath, f.paseoPath, f.ownerPath]);
});


it.each(['feed.json', 'worker-updates.json', 'voice.json', 'hermes-safety-commands.json'].flatMap(name =>
  ['empty', 'malformed', 'BOM', 'wrong type'].map(kind => ({ name, kind }))))(
  'reverses current choices over $kind $name while retaining its original bytes', async ({ name, kind }) => {
    const f = await fixture(true);
    const path = join(f.legacyDir, name);
    const source = kind === 'empty' ? '' : kind === 'malformed' ? '{"exampleSentinel":'
      : kind === 'BOM' ? '\uFEFF{}' : '[]';
    await writeFile(path, source, { mode: 0o600 });
    const warnings = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await migrateSettings(f.options, f.dependencies);
    await save(f.ownerPath, { version: 1, safetyCommandsEnabled: true, workerUpdates: { enabled: false, defaultMinutes: 30 },
      voice: { voice: 'bf_emma', appReadAloud: { provider: 'local' } }, feed: { level: 'off', lessLike: [] } });
    await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies);
    expect(new SafetyCommandsSetting(f.legacyDir).enabled()).toBe(true);
    expect(new WorkerUpdatesSetting(f.legacyDir).status()).toMatchObject({ enabled: false, defaultMinutes: 30 });
    expect(new VoiceSetting(f.legacyDir).voice()).toBe('bf_emma');
    expect(new FeedStore(f.legacyDir).settings().level).toBe('off');
    const backup = join(f.options.site.targets['wayroost-settings']!.backupDir, 'files', (await import('../supervisor/src/config-paths.js')).digest(path));
    const saved = await Promise.all((await readdir(backup)).filter(file => file.endsWith('.bak')).map(file => readFile(join(backup, file), 'utf8')));
    expect(saved).toContain(source);
    expect(warnings.mock.calls.flat().join('')).not.toContain('exampleSentinel');
    expect(await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies)).toMatchObject({ verified: true });
  },
);


it.each(['claude', 'custom'])(
  'carries the complete %s policy even when an unrelated provider flag is ignored', async id => {
    const f = await fixture(true);
    const entry = { ...(id === 'custom' ? { extends: 'pi', label: 'Example provider' } : {}), enabled: 'yes',
      paseoTools: { enabled: false, disabledTools: ['kill_agent'], futurePolicy: { mode: 'example' } } };
    await save(f.legacyPaseo, { agents: { providers: { [id]: entry } } });
    const reader = new WorkerApprovalsSetting(f.legacyPaseo, f.legacyDir, {
      providers: async () => [id], effectiveProviders: async () => ({}),
      reload: async () => ({ appliedPaths: [], restartRequiredPaths: [], overrideControlledPaths: [] }),
    });
    const plan = Reflect.get(reader, 'plan') as (source: string, offered: string[], choice: boolean, backup: object) => {
      providers: Record<string, { paseoTools?: unknown }>; uncovered: string[];
    };
    const legacy = plan(await readFile(f.legacyPaseo, 'utf8'), [id], false, {});
    expect(legacy.uncovered).toContain(id);
    expect(legacy.providers[id]?.paseoTools).toEqual(entry.paseoTools);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await migrateSettings(f.options, f.dependencies);
    expect((await read(f.paseoPath)).agents.providers[id].paseoTools).toEqual(legacy.providers[id]!.paseoTools);
    expect((await read(f.paseoPath)).agents.providers[id]).not.toHaveProperty('enabled');
    await migrateSettings({ ...f.options, mode: 'verify' }, f.dependencies);
    await migrateSettings({ ...f.options, mode: 'reverse' }, f.dependencies);
    expect((await read(f.legacyPaseo)).agents.providers[id].paseoTools).toEqual(entry.paseoTools);
    expect((await read(f.legacyPaseo)).agents.providers[id]).not.toHaveProperty('enabled');
  },
);
