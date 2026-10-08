import type { IncomingMessage, ServerResponse } from 'node:http';
import { createSupervisor } from '../src/server.js';
import { configSchema } from '../src/config.js';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import type { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigVerbs } from '../src/config-verbs.js';
import { ConfigAudit } from '../src/config-audit.js';
import { credentialDropIn, executeCredential, prepareCredentialStorage, readImportKey } from '../src/credential-executor.js';
import { credentialUnit, prepareCredentialUnit } from '../src/service-unit.js';
import { configUnitRunner, type ConfigUnitRunner } from '../src/config-unit.js';
import { executeService } from '../src/service-entry.js';
import { drainProgressSchema, type DrainIO, type DrainState } from '../src/drain-runtime.js';
import { gatewayReading } from '../src/drain-readers.js';
import type { ConfigCommand } from '../src/config-command.js';
import { hashKey, type Key } from '../src/keys.js';
import type { SettingsTargets } from '../../shared/settings-targets.js';
import { type RoleMap } from '../../shared/gateway.js';
import { credentialWriteResultSchema, drainRestartResultSchema } from '../../shared/supervisor-config.js';

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const roots: string[] = [];
const rootOwned: string[] = [];
const uid = process.getuid!();
const server: Key = { name: 'server', scope: 'server', sha256: hashKey('fake-server-key') };
const secret = 'fake-example-api-key-$(literal);%value';
beforeEach(() => {
  rootOwned.length = 0;
  vi.mocked(fs.lstat).mockImplementation(async (path, options) => {
    const stat = await actual.lstat(path, options);
    if (!String(path).includes('/audit') && !String(path).includes('/owner')) stat.uid = typeof stat.uid === 'bigint' ? 0n : 0;
    return stat;
  });
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    if (rootOwned.some(directory => String(path).startsWith(directory + '/'))) {
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementation(async options => {
        const result = await stat(options);
        result.uid = typeof result.uid === 'bigint' ? 0n : 0;
        return result;
      });
    }
    return handle;
  });
});
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), '.credential-test-')); roots.push(root);
  const credentials = join(root, 'credentials'); const dropIn = join(root, 'drop-in/keys.conf'); const stateDir = join(root, 'audit');
  const owner = join(root, 'owner'); const pi = join(owner, '.pi/agent/models.json');
  for (const path of [credentials, dirname(dropIn), join(root, 'locks'), join(root, 'backups'), join(owner, '.pi/agent'), join(owner, 'drain'), join(owner, 'hermes')]) await mkdir(path, { recursive: true, mode: 0o700 });
  rootOwned.push(credentials, dirname(dropIn), join(root, 'locks'), join(root, 'backups'));
  const map: RoleMap = { version: 2, contracts: Object.fromEntries(['main', 'coder', 'fast'].map(role => [role, { input: ['text'], toolCalling: false, thinkingLevels: false, maxOutputTokens: 1024, advertisedContext: 4096 }])) as RoleMap['contracts'],
    backends: { example: { provider: 'example', baseUrl: 'https://example.com/v1', servedName: 'example-model', contextLength: 4096, maxOutputTokens: 1024, input: ['text'], toolCalling: false, thinkingLevels: false, acceptsReasoningEffort: false } },
    profiles: {}, roles: { main: 'example', coder: null, fast: null } };
  const mapPath = join(root, 'role-map.json'); await writeFile(mapPath, JSON.stringify(map), { mode: 0o600 });
  await writeFile(pi, JSON.stringify({ providers: { 'local-example': { apiKey: secret, models: [] } } }), { mode: 0o600 });
  const site: SettingsTargets = { version: 1, configWrites: true, keySources: [{ provider: 'example', piProvider: 'local-example' }],
    targets: {
      'gateway-credentials': { directory: credentials, dropIn, service: 'wayroost-gateway.service', lockFile: join(root, 'locks/credentials.lock'), backupDir: join(root, 'backups') },
      'gateway-role-map': { path: mapPath, defaultMap: mapPath + '.default', adminSocket: root + '/admin.sock', service: 'wayroost-gateway.service', socket: 'wayroost-gateway.socket' },
      'pi-models': { path: pi, runAs: { user: 'me', uid }, mode: 0o600, format: 'json', lock: { kind: 'file', path: pi + '.wayroost-settings.lock' }, backupDir: join(owner, 'backups'), auditDir: join(owner, 'audit') },
    }, hermes: { runAs: { user: 'me', uid }, gatewayUnit: 'hermes-gateway.service', dashboardUnit: { name: 'dashboard.service', scope: 'user' },
      stateFile: owner + '/hermes/gateway_state.json', cronJobs: owner + '/hermes/cron/jobs.json', profilesDir: owner + '/hermes/profiles', processesFile: owner + '/hermes/processes.json',
      stateDatabase: owner + '/hermes/state.db', drainStateDir: owner + '/drain', drainMarker: { path: owner + '/hermes/.drain_request.json', runAs: { user: 'me', uid } }, phoneHealth: 'http://127.0.0.1:8896/health' },
  };
  const command = vi.fn<ConfigCommand>(async () => ({ code: 0, stdout: '' }));
  const outputs: string[] = [];
  const runner = vi.fn<ConfigUnitRunner>(async unit => {
    const payload = JSON.parse(unit.input);
    for (const [, path] of unit.argv.find(arg => arg.startsWith('--property=ReadWritePaths='))!.matchAll(/"([^"]+)"/g)) {
      expect((await fs.lstat(path!)).isDirectory()).toBe(true);
    }
    if (payload.mode === 'import-read') return { code: 0, stdout: JSON.stringify({ secret: await readImportKey(payload.site, payload.provider, uid) }) + '\n' };
    let result: unknown;
    if (payload.mode === 'prepare-credential') {
      await prepareCredentialStorage(payload.site, 0); result = { ok: true };
    } else result = payload.mode === 'credential' ? await executeCredential(payload.site, payload.request, command, 0)
      : payload.mode === 'prepare-drain' ? await executeService(payload) : payload.mode === 'sweep' ? { ok: true } : { outcome: 'restarted' };
    const stdout = JSON.stringify(result) + '\n'; outputs.push(stdout); return { code: 0, stdout };
  });
  const trust = vi.fn(async (path: string) => path);
  const audit = new ConfigAudit(stateDir);
  const serviceCommand = vi.fn<ConfigCommand>(async () => ({ code: 3, stdout: 'inactive\n' }));
  const options = { stateDir, site: async () => site, runner, trust, audit, serviceCommand, executable: '/opt/example/node', serviceEntry: '/opt/example/service-entry.js' };
  const verbs = new ConfigVerbs(options);
  return { root, site, pi, credentials, dropIn, stateDir, runner, trust, audit, command, outputs, serviceCommand, options, verbs };
}
const request = (provider = 'example') => ({ requestId: randomUUID(), action: 'set' as const, provider, secret });

async function files(directory: string): Promise<string> {
  let result = '';
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    result += entry.isDirectory() ? await files(path) : await readFile(path, 'utf8');
  }
  return result;
}

describe('gateway credentials', () => {
  it.each(['write', 'import'].flatMap(mode => ['credential', 'drop-in', 'backup', 'lock', 'all'].map(storage => [mode, storage])))
  ('provisions storage for first-use %s with missing %s before the writer namespace is established', async (mode, storage) => {
    const f = await fixture(); const target = f.site.targets['gateway-credentials']!;
    const directories = { credential: target.directory, 'drop-in': dirname(target.dropIn), backup: target.backupDir, lock: dirname(target.lockFile) };
    for (const [name, path] of Object.entries(directories)) if (storage === 'all' || storage === name) await rm(path, { recursive: true });
    const input = mode === 'write' ? request() : { requestId: randomUUID() };
    const result = mode === 'write' ? await f.verbs.credential(input, server) : await f.verbs.importKeys(input, server);
    await Promise.all(f.runner.mock.results.map(call => call.value));
    expect(result).toEqual(mode === 'write' ? { ok: true, provider: 'example', timing: 'restart-when-idle:gateway' } : { ok: true, providers: ['example'] });
    expect(f.runner.mock.calls.map(([unit]) => JSON.parse(unit.input).mode))
      .toEqual(mode === 'write' ? ['prepare-credential', 'credential'] : ['import-read', 'prepare-credential', 'credential']);
    const preparation = f.runner.mock.calls.find(([unit]) => JSON.parse(unit.input).mode === 'prepare-credential')![0];
    expect(preparation.argv).toContain('--uid=0'); expect(preparation.argv).toContain('--property=PrivateNetwork=yes');
    expect(preparation.argv).toContain('--property=RuntimeMaxSec=30'); expect(preparation.argv).toContain('--property=ProtectSystem=strict');
    expect(preparation.input).not.toContain(secret); expect(JSON.parse(preparation.input)).not.toHaveProperty('request');
    for (const path of Object.values(directories)) {
      const stat = await fs.lstat(path); expect(stat.uid).toBe(0); expect(stat.mode & 0o777).toBe(0o700);
    }
    expect(await readFile(join(target.directory, 'example'), 'utf8')).toBe(secret);
    expect(JSON.stringify(f.runner.mock.calls.map(([unit]) => unit.argv))).not.toContain(secret);
    expect(f.outputs.join('')).not.toContain(secret); expect(await files(f.stateDir)).not.toContain(secret);
    expect(await f.audit.rows()).toMatchObject([{ verb: 'credential.write', keys: ['example'], result: 'ok' }]);
    const calls = f.runner.mock.calls.length;
    const repeated = new ConfigVerbs(f.options);
    expect(mode === 'write' ? await repeated.credential(input, server) : await repeated.importKeys(input, server)).toEqual(result);
    expect(f.runner).toHaveBeenCalledTimes(calls);
  });
  it.each(['write', 'import'])('creates nested storage using existing ancestors for first-use %s', async mode => {
    const f = await fixture(); const target = f.site.targets['gateway-credentials']!;
    target.directory = join(f.root, 'gateway/credentials'); target.dropIn = join(f.root, 'units/gateway.service.d/keys.conf');
    target.backupDir = join(f.root, 'archive/credentials'); target.lockFile = join(f.root, 'runtime/locks/credentials.lock');
    const directories = [target.directory, dirname(target.dropIn), target.backupDir, dirname(target.lockFile)]; rootOwned.push(...directories);
    expect(mode === 'write' ? await f.verbs.credential(request(), server) : await f.verbs.importKeys({ requestId: randomUUID() }, server))
      .toMatchObject({ ok: true });
    const preparation = f.runner.mock.calls.find(([unit]) => JSON.parse(unit.input).mode === 'prepare-credential')![0];
    expect(preparation.argv).toContain('--property=ReadWritePaths="' + f.root + '"');
    const writer = f.runner.mock.calls.at(-1)![0];
    expect(writer.argv).toContain('--property=ReadWritePaths=' + directories.map(path => '"' + path + '"').join(' '));
    for (const path of directories) {
      const stat = await fs.lstat(path); expect(stat.uid).toBe(0); expect(stat.mode & 0o777).toBe(0o700);
    }
    expect(await prepareCredentialUnit(f.site)).toBeUndefined();
  });
  it.each(['write', 'import'].flatMap(mode => ['lost-result', 'claimed-ready', 'unsafe-created'].map(failure => [mode, failure])))
  ('withholds the %s writer after %s preparation and does not repeat the request', async (mode, failure) => {
    const f = await fixture(); await rm(f.credentials, { recursive: true });
    const original = f.runner.getMockImplementation()!;
    f.runner.mockImplementation(async unit => {
      if (JSON.parse(unit.input).mode !== 'prepare-credential') return original(unit);
      if (failure === 'lost-result') return { code: 1, stdout: secret };
      if (failure === 'unsafe-created') { await original(unit); await chmod(f.credentials, 0o755); }
      return { code: 0, stdout: '{"ok":true}\n' };
    });
    const input = mode === 'write' ? request() : { requestId: randomUUID() };
    expect(mode === 'write' ? await f.verbs.credential(input, server) : await f.verbs.importKeys(input, server))
      .toEqual({ ok: false, code: 'outcome_unknown' });
    const calls = f.runner.mock.calls.length; const restarted = new ConfigVerbs(f.options);
    expect(mode === 'write' ? await restarted.credential(input, server) : await restarted.importKeys(input, server))
      .toEqual({ ok: false, code: 'outcome_unknown' });
    expect(f.runner).toHaveBeenCalledTimes(calls); expect(f.command).not.toHaveBeenCalled();
    expect(f.runner.mock.calls.some(([unit]) => JSON.parse(unit.input).mode === 'credential')).toBe(false);
    await expect(fs.lstat(join(f.credentials, 'example'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await files(f.stateDir)).not.toContain(secret);
  });
  it.each(['credential', 'drop-in', 'backup', 'lock'].flatMap(storage => ['symlink', 'file', 'writable', 'foreign-owner'].map(kind => [storage, kind])))
  ('refuses unsafe %s storage (%s) before launching any unit', async (storage, kind) => {
    const f = await fixture(); const target = f.site.targets['gateway-credentials']!;
    const directories: Record<string, string> = { credential: target.directory, 'drop-in': dirname(target.dropIn), backup: target.backupDir, lock: dirname(target.lockFile) };
    const path = directories[storage!]!;
    if (kind === 'symlink' || kind === 'file') {
      await rm(path, { recursive: true });
      if (kind === 'file') await writeFile(path, 'unchanged', { mode: 0o600 });
      else { const victim = join(f.root, 'victim'); await mkdir(victim, { mode: 0o700 }); await symlink(victim, path); }
    } else if (kind === 'writable') await chmod(path, 0o777);
    else {
      const original = vi.mocked(fs.lstat).getMockImplementation()!;
      vi.mocked(fs.lstat).mockImplementation(async (...args) => {
        const stat = await original(...args);
        if (String(args[0]) === path) stat.uid = typeof stat.uid === 'bigint' ? BigInt(uid) : uid;
        return stat;
      });
    }
    expect(await f.verbs.credential(request(), server)).toEqual({ ok: false, code: 'unsafe_directory' });
    expect(await f.verbs.importKeys({ requestId: randomUUID() }, server)).toEqual({ ok: false, code: 'unsafe_directory' });
    expect(f.runner).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
  });
  it('refuses exposed credential storage and an unsafe ancestor of missing storage', async () => {
    const f = await fixture(); await chmod(f.credentials, 0o755);
    expect(await f.verbs.credential(request(), server)).toEqual({ ok: false, code: 'unsafe_directory' });
    await chmod(f.credentials, 0o700);
    const parent = join(f.root, 'exposed'); await mkdir(parent, { mode: 0o777 }); await chmod(parent, 0o777);
    f.site.targets['gateway-credentials']!.backupDir = join(parent, 'backups');
    expect(await f.verbs.credential(request(), server)).toEqual({ ok: false, code: 'unsafe_directory' });
    expect(f.runner).not.toHaveBeenCalled(); await expect(fs.lstat(join(parent, 'backups'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['write', 'import'].flatMap(mode => ['disabled', 'caller', 'provider'].map(refusal => [mode, refusal])))
  ('requires authorization for first-use %s before provisioning storage (%s)', async (mode, refusal) => {
    const f = await fixture(); await rm(f.credentials, { recursive: true });
    if (refusal === 'disabled') f.site.configWrites = false;
    if (refusal === 'provider') f.site.keySources[0]!.provider = 'unknown';
    const caller = refusal === 'caller' ? { ...server, scope: 'rescue' as const } : server;
    const code = refusal === 'disabled' ? 'config_writes_off' : refusal === 'caller' ? 'not_permitted' : 'invalid_parameters';
    expect(mode === 'write' ? await f.verbs.credential(request(refusal === 'provider' ? 'unknown' : 'example'), caller)
      : await f.verbs.importKeys({ requestId: randomUUID() }, caller)).toEqual({ ok: false, code });
    expect(f.runner).not.toHaveBeenCalled(); await expect(fs.lstat(f.credentials)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('requires root and write enablement in the preparation executor and dispatcher', async () => {
    const f = await fixture(); await rm(f.credentials, { recursive: true });
    await expect(prepareCredentialStorage(f.site, uid)).rejects.toMatchObject({ code: 'not_permitted' });
    f.site.targets['gateway-credentials']!.dropIn = '/etc/systemd/system/wayroost-gateway.service.d/keys.conf';
    await expect(executeService({ mode: 'prepare-credential', site: f.site })).rejects.toMatchObject({ code: 'not_permitted' });
    f.site.configWrites = false;
    await expect(prepareCredentialStorage(f.site, 0)).rejects.toMatchObject({ code: 'config_writes_off' });
    await expect(executeService({ mode: 'prepare-credential', site: f.site })).rejects.toMatchObject({ code: 'config_writes_off' });
    await expect(fs.lstat(f.credentials)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['/etc/example/example', '/etc/example keys/example', '/etc/example%h/example', '/etc/example"keys/example',
    "/etc/example'keys/example", '/etc/example\\keys/example', '/etc/example:keys/example'])('parses a LoadCredential source literally at %s', path => {
    const source = credentialDropIn('[Service]\n', { action: 'set', provider: 'example' }, path);
    const value = source.split('\n').find(line => line.startsWith('LoadCredential='))!.slice('LoadCredential='.length);
    const colon = value.indexOf(':');
    const provider = value.slice(0, colon);
    // The source keeps quotes and backslashes; only specifiers are expanded after the first colon.
    const parsedPath = value.slice(colon + 1).replace(/%%|%./g, specifier => {
      expect(specifier).toBe('%%'); return '%';
    });
    expect(provider).toBe('example'); expect(parsedPath.startsWith('/')).toBe(true); expect(parsedPath).toBe(path);
  });
  it('writes a root 0600 key, a 0644 LoadCredential drop-in and reloads the manager without exposing values', async () => {
    const f = await fixture(); const result = await f.verbs.credential(request(), server);
    expect(result).toEqual({ ok: true, provider: 'example', timing: 'restart-when-idle:gateway' });
    expect(credentialWriteResultSchema.safeParse(result).success).toBe(true);
    const file = await actual.lstat(join(f.credentials, 'example')); expect(file.mode & 0o777).toBe(0o600);
    expect(await readFile(join(f.credentials, 'example'), 'utf8')).toBe(secret);
    expect((await actual.lstat(f.dropIn)).mode & 0o777).toBe(0o644);
    expect(await readFile(f.dropIn, 'utf8')).toContain('LoadCredential=example:' + f.credentials + '/example\n');
    expect(f.command.mock.calls).toEqual([[['systemctl', 'daemon-reload'], {}, 15_000]]);
    expect(JSON.stringify(f.outputs)).not.toContain(secret);
    expect(JSON.stringify(f.runner.mock.calls.map(([unit]) => unit.argv))).not.toContain(secret);
    expect(JSON.stringify(f.command.mock.calls)).not.toContain(secret);
    const audit = await files(f.stateDir); expect(audit).not.toContain(secret); expect(audit).not.toContain('fake-server-key');
    expect(await f.audit.rows()).toMatchObject([{ verb: 'credential.write', keys: ['example'], target: 'gateway-credentials', result: 'ok' }]);
  });
  it.each(['../example', '/example', 'EXAMPLE', 'not-in-map', 'example;true', 'a'.repeat(33)])('refuses provider %s without launching a unit', async provider => {
    const f = await fixture(); expect(await f.verbs.credential(request(provider), server)).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(f.runner).not.toHaveBeenCalled(); expect(await readdir(f.credentials)).toEqual([]);
  });
  it.each(['', 'a\nb', 'a b', 'a\u0000b', 'é', 'a'.repeat(4097)])('refuses a malformed secret', async value => {
    const f = await fixture(); expect(await f.verbs.credential({ ...request(), secret: value }, server)).toEqual({ ok: false, code: 'invalid_parameters' }); expect(f.runner).not.toHaveBeenCalled();
  });
  it('requires write enablement and server authority and trusts the fixed executables', async () => {
    const f = await fixture(); f.site.configWrites = false;
    expect(await f.verbs.credential(request(), server)).toEqual({ ok: false, code: 'config_writes_off' }); f.site.configWrites = true;
    expect(await f.verbs.credential(request(), { ...server, name: 'launcher' })).toEqual({ ok: false, code: 'not_permitted' });
    expect(await f.verbs.credential(request(), { ...server, scope: 'rescue' })).toEqual({ ok: false, code: 'not_permitted' });
    f.trust.mockRejectedValue(new Error()); expect(await f.verbs.credential(request(), server)).toEqual({ ok: false, code: 'unsafe_target' }); expect(f.runner).not.toHaveBeenCalled();
  });
  it('refuses a non-root writer', async () => {
    const f = await fixture(); expect(await executeCredential(f.site, request(), f.command, uid)).toEqual({ ok: false, code: 'not_permitted' });
  });
  it('never follows an existing key or drop-in symlink', async () => {
    const f = await fixture(); const victim = join(f.root, 'victim'); await writeFile(victim, 'unchanged');
    await symlink(victim, join(f.credentials, 'example'));
    expect(await f.verbs.credential(request(), server)).toEqual({ ok: false, code: 'unsafe_target' }); expect(await readFile(victim, 'utf8')).toBe('unchanged');
    await rm(join(f.credentials, 'example')); await symlink(victim, f.dropIn);
    expect(await f.verbs.credential(request(), server)).toEqual({ ok: false, code: 'unsafe_target' }); expect(await readFile(victim, 'utf8')).toBe('unchanged');
  });
  it('takes the shared lock, and refuses a busy lock without writing', async () => {
    const f = await fixture(); await writeFile(f.site.targets['gateway-credentials']!.lockFile, 'busy', { mode: 0o600 });
    expect(await f.verbs.credential(request(), server)).toEqual({ ok: false, code: 'locked' }); expect(await readdir(f.credentials)).toEqual([]);
  });
  it('replaces one key without backing up values, preserving unrelated drop-in lines', async () => {
    const f = await fixture(); await writeFile(f.dropIn, '[Service]\n# Credential wiring\nLoadCredential=other:/etc/example/other\nEnvironment=EXAMPLE=1\n', { mode: 0o644 });
    expect((await f.verbs.credential(request(), server)).ok).toBe(true);
    expect((await f.verbs.credential({ ...request(), secret: 'fake-replacement-key' }, server)).ok).toBe(true);
    const dropIn = await readFile(f.dropIn, 'utf8'); expect(dropIn.match(/LoadCredential=example:/g)).toHaveLength(1); expect(dropIn).toContain('LoadCredential=other:/etc/example/other');
    expect(dropIn).toContain('Environment=EXAMPLE=1'); expect(await files(join(f.root, 'backups'))).not.toContain(secret);
    expect(await files(join(f.root, 'backups'))).not.toContain('fake-replacement-key');
  });
  it('removes a key and only its LoadCredential line', async () => {
    const f = await fixture(); await f.verbs.credential(request(), server);
    expect(await f.verbs.credential({ requestId: randomUUID(), action: 'remove', provider: 'example' }, server)).toEqual({ ok: true, provider: 'example', timing: 'restart-when-idle:gateway' });
    expect(await readdir(f.credentials)).toEqual([]); expect(await readFile(f.dropIn, 'utf8')).not.toContain('LoadCredential=example');
  });
  it('does not repeat a write after reconnect or an uncertain result', async () => {
    const f = await fixture(); const input = request(); f.command.mockResolvedValue({ code: 1, stdout: secret });
    expect(await f.verbs.credential(input, server)).toEqual({ ok: false, code: 'outcome_unknown' });
    const restarted = new ConfigVerbs(f.options); expect(await restarted.credential(input, server)).toEqual({ ok: false, code: 'outcome_unknown' });
    expect(f.runner).toHaveBeenCalledTimes(1); expect(await files(f.stateDir)).not.toContain(secret);
  });
  it('does not repeat a successful request and refuses a changed provider or caller binding', async () => {
    const f = await fixture(); const input = request(); const result = await f.verbs.credential(input, server);
    expect(await new ConfigVerbs(f.options).credential(input, server)).toEqual(result); expect(f.runner).toHaveBeenCalledTimes(1);
    expect(await f.verbs.credential({ ...input, action: 'remove', secret: undefined }, server)).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(await f.verbs.credential(input, { ...server, name: 'another' })).toEqual({ ok: false, code: 'invalid_parameters' });
  });
  it('returns only outcome_unknown for lost or contaminated unit output', async () => {
    const f = await fixture(); f.runner.mockResolvedValue({ code: 0, stdout: JSON.stringify({ ok: true, provider: secret, timing: 'restart-when-idle:gateway' }) });
    expect(await f.verbs.credential(request(), server)).toEqual({ ok: false, code: 'outcome_unknown' }); expect(await files(f.stateDir)).not.toContain(secret);
    f.runner.mockRejectedValue(new Error(secret)); expect(await f.verbs.credential(request(), server)).toEqual({ ok: false, code: 'outcome_unknown' });
  });
  it('records an unknown outcome if the audit cannot finish, and never retries that write', async () => {
    const f = await fixture(); const input = request(); vi.spyOn(f.audit, 'append').mockRejectedValue(new Error());
    expect(await f.verbs.credential(input, server)).toEqual({ ok: false, code: 'outcome_unknown' });
    expect(await new ConfigVerbs(f.options).credential(input, server)).toEqual({ ok: false, code: 'outcome_unknown' }); expect(f.runner).toHaveBeenCalledTimes(1);
  });
  it('grants the root unit only credential, drop-in, backup and lock storage', async () => {
    const f = await fixture(); const unit = credentialUnit(f.site, request(), '/opt/example/node', '/opt/example/service-entry.js');
    expect(unit.argv).toContain('--uid=0'); expect(unit.argv).toContain('--property=PrivateNetwork=yes'); expect(unit.argv).toContain('--property=RuntimeMaxSec=30');
    const writable = unit.argv.find(arg => arg.startsWith('--property=ReadWritePaths='))!; expect(writable).not.toContain('/owner'); expect(unit.argv.join(' ')).not.toContain(secret);
    expect(JSON.parse(unit.input).request.secret).toBe(secret);
  });
});

describe('key import', () => {
  it('reads pi as its owner, sends the value through stdin to the root writer and exposes only provider names', async () => {
    const f = await fixture(); const before = await readFile(f.pi); const input = { requestId: randomUUID() };
    expect(await f.verbs.importKeys(input, server)).toEqual({ ok: true, providers: ['example'] });
    expect(f.runner.mock.calls.map(([unit]) => unit.argv.find(arg => arg.startsWith('--uid=')))).toEqual(['--uid=' + uid, '--uid=0']);
    expect(JSON.parse(f.runner.mock.calls[0]![0].input).mode).toBe('import-read');
    expect(JSON.parse(f.runner.mock.calls[1]![0].input).request.secret).toBe(secret);
    expect(await readFile(f.pi)).toEqual(before); expect(await readFile(join(f.credentials, 'example'), 'utf8')).toBe(secret);
    expect(await files(f.stateDir)).not.toContain(secret); expect(f.outputs.join('')).not.toContain(secret);
    expect(await new ConfigVerbs(f.options).importKeys(input, server)).toEqual({ ok: true, providers: ['example'] }); expect(f.runner).toHaveBeenCalledTimes(2);
    expect(await f.verbs.importKeys(input, { ...server, name: 'someone-else' })).toEqual({ ok: false, code: 'invalid_parameters' });
  });
  it('preserves a maximum-length key even when JSON escaping expands its private pipe frame', async () => {
    const f = await fixture(); const value = 'fake-' + '"'.repeat(4091);
    await writeFile(f.pi, JSON.stringify({ providers: { 'local-example': { apiKey: value } } }), { mode: 0o600 });
    expect(await f.verbs.importKeys({ requestId: randomUUID() }, server)).toEqual({ ok: true, providers: ['example'] });
    expect(await readFile(join(f.credentials, 'example'), 'utf8')).toBe(value); expect(await files(f.stateDir)).not.toContain(value);
    expect(f.outputs.join('')).not.toContain(value);
  });
  it('refuses a symlink at the key source without changing credentials', async () => {
    const f = await fixture(); const victim = join(f.root, 'victim'); await writeFile(victim, JSON.stringify({ providers: { 'local-example': { apiKey: secret } } }));
    await rm(f.pi); await symlink(victim, f.pi);
    expect((await f.verbs.importKeys({ requestId: randomUUID() }, server)).ok).toBe(false); expect(await readdir(f.credentials)).toEqual([]);
    expect(f.runner).toHaveBeenCalledTimes(1); expect(await files(f.stateDir)).not.toContain(secret); expect((await f.audit.rows())[0]?.keys).toEqual(['example']);
  });
  it('refuses an exposed or oversized source file without publishing a key', async () => {
    const f = await fixture(); await chmod(f.pi, 0o644);
    expect(await f.verbs.importKeys({ requestId: randomUUID() }, server)).toEqual({ ok: false, code: 'unsafe_target' });
    await chmod(f.pi, 0o600); await writeFile(f.pi, ' '.repeat(4 * 1024 * 1024 + 1));
    expect(await f.verbs.importKeys({ requestId: randomUUID() }, server)).toEqual({ ok: false, code: 'unsafe_target' });
    expect(await readdir(f.credentials)).toEqual([]);
  });
  it('cannot read an owner file as root or as a different uid', async () => {
    const f = await fixture(); await expect(readImportKey(f.site, 'example', 0)).rejects.toMatchObject({ code: 'not_permitted' });
    await expect(readImportKey(f.site, 'example', uid + 1)).rejects.toMatchObject({ code: 'not_permitted' });
  });
  it('rejects unknown sources and missing or malformed apiKey data', async () => {
    const f = await fixture(); f.site.keySources[0]!.provider = 'unknown';
    expect(await f.verbs.importKeys({ requestId: randomUUID() }, server)).toEqual({ ok: false, code: 'invalid_parameters' }); expect(f.runner).not.toHaveBeenCalled();
    f.site.keySources[0]!.provider = 'example'; await writeFile(f.pi, '{"providers":{"local-example":{"apiKey":null}}}');
    expect((await f.verbs.importKeys({ requestId: randomUUID() }, server)).ok).toBe(false); expect(await readdir(f.credentials)).toEqual([]);
  });
});

async function completedDrain(f: Awaited<ReturnType<typeof fixture>>, input: { requestId: string; component: string; when: string }, key: Key) {
  const accepted = await f.verbs.drainRestart(input, key);
  if (!accepted.ok || accepted.run.endedAt !== undefined) return accepted;
  let result = accepted;
  await vi.waitFor(async () => {
    const saved = (await f.audit.request(input.requestId))?.drainResult;
    expect(saved?.ok && saved.run.endedAt !== undefined || saved?.ok === false).toBe(true);
    if (saved?.ok) result = saved;
  });
  return result.run.code ? { ok: false as const, code: result.run.code } : result;
}

describe('tracked drain verb', () => {
  it.each(['drain', 'sweep'])('creates first-use storage as its owner before launching the hardened %s unit', async mode => {
    const f = await fixture(); const hermes = f.site.hermes!; const owner = join(f.root, 'owner');
    await rm(hermes.drainStateDir, { recursive: true }); await rm(join(owner, 'hermes'), { recursive: true });
    hermes.drainStateDir = join(owner, 'runtime/nested/drain');
    if (mode === 'drain') {
      expect(await completedDrain(f, { requestId: randomUUID(), component: 'hermes', when: 'idle' }, server))
        .toMatchObject({ ok: true, run: { outcome: 'restarted' } });
    } else {
      await f.verbs.initialize(); expect((await f.verbs.status()).drainSweep).toEqual({ ok: true });
    }
    expect(f.runner.mock.calls.map(([unit]) => JSON.parse(unit.input).mode)).toEqual(['prepare-drain', mode]);
    const unit = f.runner.mock.calls[0]![0];
    expect(unit.argv).toContain('--uid=' + uid);
    expect(unit.argv).toContain('--property=PrivateNetwork=yes');
    expect(unit.argv).toContain('--property=RuntimeMaxSec=30');
    expect(unit.argv).toContain('--property=ReadWritePaths="' + owner + '"');
    expect(unit.argv.some(arg => arg.startsWith('--property=ExecStopPost='))).toBe(false);
    const stat = await fs.lstat(hermes.drainStateDir);
    expect(stat.uid).toBe(uid); expect(stat.mode & 0o777).toBe(0o700);
    expect((await fs.lstat(join(owner, 'hermes'))).uid).toBe(uid);
  });
  it.each(['drain', 'sweep'])('withholds the %s unit when storage preparation has an uncertain result', async mode => {
    const f = await fixture(); await rm(f.site.hermes!.drainStateDir, { recursive: true });
    f.runner.mockResolvedValue({ code: 1, stdout: '' });
    const input = { requestId: randomUUID(), component: 'hermes', when: 'idle' };
    if (mode === 'drain') {
      expect(await completedDrain(f, input, server)).toEqual({ ok: false, code: 'outcome_unknown' });
      expect(await new ConfigVerbs(f.options).drainRestart(input, server)).toMatchObject({ ok: true, run: { state: 'failed', code: 'outcome_unknown' } });
    } else {
      await f.verbs.initialize(); expect((await f.verbs.status()).drainSweep).toEqual({ ok: false, code: 'outcome_unknown' });
    }
    expect(f.runner).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.runner.mock.calls[0]![0].input).mode).toBe('prepare-drain');
  });
  it('requires authorization before creating missing drain storage', async () => {
    const f = await fixture(); await rm(f.site.hermes!.drainStateDir, { recursive: true }); f.site.configWrites = false;
    expect(await completedDrain(f, { requestId: randomUUID(), component: 'hermes', when: 'idle' }, server))
      .toEqual({ ok: false, code: 'config_writes_off' });
    expect(f.runner).not.toHaveBeenCalled(); await expect(fs.lstat(f.site.hermes!.drainStateDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('streams executor phases, busy reasons and probe counters through the unit pipe into tracked status', async () => {
    const f = await fixture(); let clock = Date.now(); let ready = false; let restarted = false; let publications = 0;
    let marker: { principal: string; requested_at: string } | null = null; let state: DrainState | null = null;
    let resume!: () => void; const gate = new Promise<void>(resolve => { resume = resolve; });
    const io: DrainIO = {
      now: () => clock, async sleep(ms) { clock += ms; if (!ready) await gate; }, async active() { return true; },
      async gateway() {
        return gatewayReading(JSON.stringify({ gateway_state: marker && clock > Date.parse(marker.requested_at) ? 'draining' : 'running',
          active_agents: publications === 0 || marker && publications === 1 ? 1 : 0, updated_at: new Date(clock).toISOString(),
          active_work: marker && publications === 1 ? [{ kind: 'chat' }] : null, pid: restarted ? 102 : 101, start_time: restarted ? 1500 : 1000 }));
      },
      async phone() { return ready; }, async cron() { return true; }, async background() { return true; },
      async marker() { return marker; }, async publishMarker(at) { publications++; marker = { principal: 'wayroost', requested_at: at }; return true; },
      async removeMarker() { marker = null; }, async save(next) { state = next; }, async load() { return state; },
      async deleteState() { state = null; }, async stop() {}, async start() { restarted = true; },
    };
    const input = { requestId: randomUUID(), component: 'hermes', when: 'idle' };
    const observed: Promise<Awaited<ReturnType<ConfigVerbs['drainRestartRun']>>>[] = []; const output: string[] = [];
    let verbs: ConfigVerbs;
    const launch = vi.fn((command: string) => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
      let source = ''; child.stdin.on('data', chunk => { source += chunk.toString(); });
      child.stdin.once('finish', () => {
        if (command === 'systemctl') { child.stdout.end('failed\n'); child.emit('close', 0); return; }
        void executeService(JSON.parse(source), patch => {
          const line = JSON.stringify(drainProgressSchema.parse({ progress: patch })) + '\n'; output.push(line);
          const middle = Math.floor(line.length / 2); child.stdout.write(line.slice(0, middle)); child.stdout.write(line.slice(middle));
          observed.push(verbs.drainRestartRun(input.requestId));
        }, () => io).then(result => {
          const line = JSON.stringify(result) + '\n'; output.push(line); child.stdout.end(line); child.emit('close', 0);
        }, () => { child.stdout.end(); child.emit('close', 1); });
      });
      return child;
    });
    verbs = new ConfigVerbs({ ...f.options, runner: configUnitRunner(f.trust, launch as unknown as typeof spawn) });
    const pending = verbs.drainRestart(input, server);
    try {
      await vi.waitFor(async () => expect(await verbs.drainRestartRun(input.requestId)).toMatchObject({ ok: true, run: { state: 'waiting', busy: ['phone-unavailable', 'agents-running'] } }));
    } finally { ready = true; resume(); }
    await pending;
    await vi.waitFor(async () => expect((await f.audit.request(input.requestId))?.drainResult).toMatchObject({ run: { outcome: 'restarted' } }));
    const result = await verbs.drainRestartRun(input.requestId);
    expect(result).toMatchObject({ ok: true, run: { state: 'done', outcome: 'restarted', attempts: 2, probeAttempts: 1, lastRelease: 'chat-at-entry', busy: [] } });
    const snapshots = await Promise.all(observed);
    expect(snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({ run: expect.objectContaining({ state: 'probing', attempts: 1, probeAttempts: 1 }) }),
      expect.objectContaining({ run: expect.objectContaining({ state: 'waiting', lastRelease: 'chat-at-entry' }) }),
      ...['draining', 'restarting', 'clearing', 'verifying'].map(state => expect.objectContaining({ run: expect.objectContaining({ state, attempts: 2 }) })),
    ]));
    expect(await new ConfigVerbs(f.options).drainRestartRun(input.requestId)).toEqual(result);
    expect(output.join('')).not.toContain(secret); expect(await files(f.stateDir)).not.toContain(secret);
    expect(launch.mock.results[0]!.value.kill).not.toHaveBeenCalled();
  });
  it.each([
    { state: 'done' }, { busy: [secret] }, { attempts: -1 }, { attempts: 0.5 }, { probeAttempts: 1 },
    { state: 'waiting', secret }, { id: randomUUID() }, { outcome: 'restarted' }, { startedAt: 0 },
  ])('refuses invalid or content-bearing progress without publishing it: %j', async progress => {
    const f = await fixture(); f.runner.mockImplementation(async (_unit, onLine) => {
      onLine!(JSON.stringify({ progress })); return { code: 0, stdout: '{"outcome":"restarted"}\n' };
    });
    const input = { requestId: randomUUID(), component: 'hermes', when: 'idle' };
    expect(await completedDrain(f, input, server)).toEqual({ ok: false, code: 'outcome_unknown' });
    expect(await f.verbs.drainRestartRun(input.requestId)).toMatchObject({ ok: true, run: { state: 'failed', code: 'outcome_unknown' } });
    expect(await files(f.stateDir)).not.toContain(secret);
  });
  it.each(['counters', 'after-outcome'])('refuses progress with regressing %s', async kind => {
    const f = await fixture(); f.runner.mockImplementation(async (_unit, onLine) => {
      onLine!(JSON.stringify({ progress: { state: 'probing', attempts: 2, probeAttempts: 1 } }));
      if (kind === 'after-outcome') onLine!('{"outcome":"restarted"}');
      onLine!(JSON.stringify({ progress: kind === 'counters' ? { attempts: 1, probeAttempts: 0 } : { state: 'verifying' } }));
      return { code: 0, stdout: '{"outcome":"restarted"}\n' };
    });
    expect(await completedDrain(f, { requestId: randomUUID(), component: 'hermes', when: 'idle' }, server)).toEqual({ ok: false, code: 'outcome_unknown' });
  });
  it('runs independently, advertises the verbs and launches a sweep as the marker owner', async () => {
    const f = await fixture(); await f.verbs.initialize();
    expect(JSON.parse(f.runner.mock.calls[0]![0].input).mode).toBe('sweep'); expect(f.runner.mock.calls[0]![0].argv).toContain('--uid=' + uid);
    expect((await f.verbs.status()).verbs).toContain('service.drain-restart'); expect((await f.verbs.status()).verbs).toContain('credential.write');
    const input = { requestId: randomUUID(), component: 'hermes', when: 'idle' };
    const result = await completedDrain(f, input, server); expect(result).toMatchObject({ ok: true, run: { state: 'done', outcome: 'restarted' } });
    expect(drainRestartResultSchema.safeParse(result).success).toBe(true); expect(await f.verbs.drainRestartRun(input.requestId)).toEqual(result);
    expect(await new ConfigVerbs(f.options).drainRestart(input, server)).toEqual(result); expect(f.runner).toHaveBeenCalledTimes(2);
  });
  it('refuses a second drain while credential writes remain available', async () => {
    const f = await fixture(); const original = f.runner.getMockImplementation()!; let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.runner.mockImplementation(async unit => { if (JSON.parse(unit.input).mode === 'drain') await pending; return original(unit); });
    const input = { requestId: randomUUID(), component: 'hermes', when: 'idle' };
    const first = completedDrain(f, input, server);
    await vi.waitFor(() => expect(f.runner).toHaveBeenCalledTimes(1));
    expect(await completedDrain(f, { ...input, requestId: randomUUID() }, server)).toEqual({ ok: false, code: 'busy' });
    expect((await f.verbs.credential(request(), server)).ok).toBe(true); release(); expect((await first).ok).toBe(true);
  });
  it.each(['active', 'activating', 'deactivating', 'reloading'])('refuses an existing systemd unit in %s after a supervisor restart', async state => {
    const f = await fixture(); f.serviceCommand.mockResolvedValue({ code: state === 'active' || state === 'reloading' ? 0 : 3, stdout: state + '\n' });
    expect(await completedDrain(f, { requestId: randomUUID(), component: 'hermes', when: 'idle' }, server)).toEqual({ ok: false, code: 'busy' }); expect(f.runner).not.toHaveBeenCalled();
  });
  it('never reruns a drain with a missing result and reconciles the audit without a unit', async () => {
    const f = await fixture(); f.runner.mockResolvedValue({ code: 1, stdout: 'untrusted output' });
    const input = { requestId: randomUUID(), component: 'hermes', when: 'idle' };
    expect(await completedDrain(f, input, server)).toEqual({ ok: false, code: 'outcome_unknown' });
    expect(await new ConfigVerbs(f.options).drainRestart(input, server)).toMatchObject({ ok: true, run: { state: 'failed', code: 'outcome_unknown' } }); expect(f.runner).toHaveBeenCalledTimes(1);
  });
});


describe('stored credential probes', () => {
  it.each([true, false])('probes stored credentials without writes when configWrites=%s', async configWrites => {
    const f = await fixture(); f.site.configWrites = configWrites;
    await writeFile(join(f.credentials, 'example'), 'fake-stored-key', { mode: 0o600 });
    const admin = vi.fn(async () => ({ ok: true, provider: 'example', backend: 'example' }));
    const verbs = new ConfigVerbs({ ...f.options, serviceAdmin: admin });
    const request = { requestId: randomUUID(), provider: 'example', backend: 'example' };
    expect(await verbs.credentialTest(request, server)).toEqual({ ok: true, provider: 'example', backend: 'example' });
    expect(admin).toHaveBeenCalledWith(f.site.targets['gateway-role-map']!.adminSocket, '/v1/credentials/example/test',
      { backend: 'example', secret: 'fake-stored-key' }, 6000);
    expect(f.runner).not.toHaveBeenCalled();
    expect(await verbs.requestStatus({ requestId: request.requestId }, server)).toEqual({ ok: true, requestId: request.requestId, state: 'missing' });
    expect(await f.audit.rows()).toEqual([]);
    expect(await files(f.stateDir)).not.toContain('fake-stored-key');
  });

  it.each(['missing', 'symlink', 'oversized', 'public-mode'] as const)('refuses a %s stored key without contacting the admin socket', async kind => {
    const f = await fixture(); const path = join(f.credentials, 'example');
    if (kind === 'symlink') await symlink(f.pi, path);
    else if (kind !== 'missing') await writeFile(path, kind === 'oversized' ? 'x'.repeat(20000) : 'fake-stored-key', { mode: kind === 'public-mode' ? 0o644 : 0o600 });
    const admin = vi.fn(); const verbs = new ConfigVerbs({ ...f.options, serviceAdmin: admin });
    expect(await verbs.credentialTest({ requestId: randomUUID(), provider: 'example', backend: 'example' }, server)).toEqual({ ok: false, code: 'credential_missing' });
    expect(admin).not.toHaveBeenCalled(); expect(f.runner).not.toHaveBeenCalled();
  });

  it.each(['credential_rejected', 'backend_unavailable', 'malformed', 'transport'] as const)('returns a fixed code for %s without leaking upstream text', async kind => {
    const f = await fixture(); await writeFile(join(f.credentials, 'example'), 'fake-stored-key', { mode: 0o600 });
    const admin = vi.fn(async () => {
      if (kind === 'transport') throw new Error('fake-stored-key');
      return kind === 'malformed' ? { ok: false, code: 'credential_rejected', message: 'fake-stored-key' } : { ok: false, code: kind };
    });
    const verbs = new ConfigVerbs({ ...f.options, serviceAdmin: admin });
    const answer = await verbs.credentialTest({ requestId: randomUUID(), provider: 'example', backend: 'example' }, server);
    expect(answer).toEqual({ ok: false, code: kind === 'transport' ? 'backend_unavailable' : kind === 'malformed' ? 'test_failed' : kind });
    expect(JSON.stringify(answer)).not.toContain('fake-stored-key'); expect(await f.audit.rows()).toEqual([]);
  });

  it('wires read probes and tracked restarts through the supervisor HTTP server', async () => {
    const f = await fixture(); await writeFile(join(f.credentials, 'example'), 'fake-stored-key', { mode: 0o600 });
    const admin = vi.fn(async () => ({ ok: true, provider: 'example', backend: 'example' }));
    const verbs = new ConfigVerbs({ ...f.options, serviceAdmin: admin });
    const http = createSupervisor({ config: configSchema.parse({ development: true, stateDir: f.stateDir, statusOnly: true, restartWhenIdleCertified: true }), registry: [], keys: [server],
      exec: { async run() { return 0; } }, configVerbs: verbs,
      status: async () => ({ overall: 'ok', sentence: 'Everything is running.', components: [], busy: 'unknown', at: 1 }) });
    const call = async (path: string, body?: unknown, rescue = false) => {
      const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as IncomingMessage;
      req.method = body === undefined ? 'GET' : 'POST'; req.url = path; req.headers = { authorization: 'Bearer fake-server-key' };
      return new Promise<{ status: number; body: any }>(resolve => {
        const res = Object.assign(new EventEmitter(), { status: 0, headersSent: false, destroyed: false,
          writeHead(status: number) { this.status = status; return this; }, end(text: string) { resolve({ status: this.status, body: JSON.parse(text) }); }, destroy() {} });
        (rescue ? http.rescue : http.socket).emit('request', req, res as unknown as ServerResponse);
      });
    };
    const probe = { requestId: randomUUID(), provider: 'example', backend: 'example' };
    expect((await call('/v1/config/credential/test', probe)).body).toEqual({ ok: true, provider: 'example', backend: 'example' });
    expect((await call('/v1/config/credential/test', { ...probe, secret: 'fake-request-key' })).body.code).toBe('invalid_parameters');
    expect((await call('/v1/config/credential/test', probe, true)).status).toBe(403);
    expect((await call('/v1/config/request-status', { requestId: probe.requestId })).body.state).toBe('missing');
    const id = randomUUID();
    const accepted = await call('/v1/config/drain-restart', { requestId: id, protocol: 1, component: 'gateway', when: 'idle' });
    expect(accepted.status).toBe(202); expect(accepted.body.run).toMatchObject({ id, component: 'gateway', state: 'waiting' });
    await Promise.all(f.runner.mock.results.map(result => result.value));
    await vi.waitFor(async () => expect((await call('/v1/config/drain-restart/' + id)).body.run).toMatchObject({ id, state: 'done', outcome: 'restarted' }));
    expect(await files(f.stateDir)).not.toContain('fake-stored-key');
  });
});
