import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request } from 'node:http';
import { appendFile, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readGatewayListeners, readGatewayPersistence, readGatewayStatus } from '../../supervisor/src/config-observations.js';
import { ConfigVerbs } from '../../supervisor/src/config-verbs.js';
import { settingsTargetsSchema } from '../../shared/settings-targets.js';
import { configReadResultSchema, configVerbsStatusSchema } from '../../shared/supervisor-config.js';
import { fixtures, rowOf } from './checks-fixtures.js';
import { readViewValues } from '../../shared/settings-ops.js';
import { gatewayListenersSchema } from '../../shared/gateway.js';
import { heldSocketPorts } from '../src/checks/sources.js';
import { DEMO_MAIN_ADDRESS, DEMO_CODER_ADDRESS, DEMO_FAST_ADDRESS } from './checks-fixtures.js';

vi.mock('node:http', () => ({ request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: vi.fn() }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), lstat: vi.fn() }));
const lookupAll = vi.mocked<(hostname: string, options: { all: true }) => Promise<LookupAddress[]>>(lookup);
const roots: string[] = [];
afterEach(async () => { vi.resetAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const site = settingsTargetsSchema.parse({ version: 1, targets: { 'gateway-role-map': {
  path: '/example/map.json', defaultMap: '/example/default-map.json', adminSocket: '/example/admin.sock',
  service: 'example.service', socket: 'example.socket',
} } });
const contract = { input: ['text'], toolCalling: true, thinkingLevels: false, maxOutputTokens: 8192, advertisedContext: 200000 };
const status = { draining: true, roles: Object.fromEntries(['main', 'coder', 'fast'].map(role => [role, {
  backend: 'example-backend', backendModel: 'example-model', contextLength: 200000, contract, health: 'owner_mismatch',
  backendPort: 18010, inFlight: 0, openConnections: 0,
}])) };
function filesystem(mode = 0o600, uid = 0) {
  owner(uid);
  vi.mocked(lstat).mockImplementation(async path => ({ uid, mode: path === '/example/admin.sock' ? mode : path === '/example/map.json' ? 0o600 : 0o755,
    isSymbolicLink: () => false, isFile: () => path === '/example/map.json', isDirectory: () => path !== '/example/admin.sock' && path !== '/example/map.json', isSocket: () => path === '/example/admin.sock',
  }) as never);
}
function owner(uid: number, dynamic = 'yes', user = 'example-gateway') {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const command = args[0];
    (args.at(-1) as (error: Error | null, stdout: string) => void)(null,
      command === 'systemctl' ? `DynamicUser=${dynamic}\nUser=${user}\n` : `${user}:x:${uid}:12345::/:/bin/false\n`);
    return {} as ReturnType<typeof execFile>;
  });
}
function response(body: unknown, statusCode = 200) {
  vi.mocked(request).mockImplementation(((options: { path: string; signal: AbortSignal }, callback: (value: EventEmitter) => void) => {
    expect(['/healthz', '/v1/status']).toContain(options.path); expect(options.signal).toBeInstanceOf(AbortSignal);
    const client = new EventEmitter();
    Object.assign(client, { end: () => {
      const stream = new EventEmitter(); Object.assign(stream, { statusCode, destroy: vi.fn() }); callback(stream);
      stream.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(options.path === '/healthz' ? { status: 'ok' } : body))); stream.emit('end');
    } });
    return client;
  }) as never);
}

async function listenersFixture(uids = [0, 0, 0], configured = [18010, 18011, 18012], held = [101, 102, 103], triggers = 'example.service') {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(lstat).mockImplementation(real.lstat);
  const root = await mkdtemp(join(process.cwd(), '.tmp/checks-listeners-')); roots.push(root);
  await mkdir(join(root, '1/net'), { recursive: true }); await mkdir(join(root, '1/fd'));
  await writeFile(join(root, '1/net/tcp'), 'sl local_address rem_address st tx_queue rx_queue tr uid timeout inode\n'
    + uids.map((uid, index) => `${index}: 0100007F:${(18010 + index).toString(16).padStart(4, '0')} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 ${uid} 0 ${101 + index}\n`).join(''));
  await writeFile(join(root, '1/net/tcp6'), 'sl local_address rem_address st\n');
  for (const [index, inode] of held.entries()) await symlink(`socket:[${inode}]`, join(root, '1/fd', String(index)));
  const output = `Id=example.socket\nLoadState=loaded\nActiveState=active\nTriggers=${triggers}\nListen=${configured.map(port => `127.0.0.1:${port} (Stream)`).join(' ')}\n`;
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    expect(args[1]).toContain('example.socket');
    (args.at(-1) as (error: Error | null, stdout: string) => void)(null, output);
    return {} as ReturnType<typeof execFile>;
  });
  const configuredSite = settingsTargetsSchema.parse({ ...site, roleAddresses: {
    main: DEMO_MAIN_ADDRESS, coder: DEMO_CODER_ADDRESS, fast: DEMO_FAST_ADDRESS,
  } });
  const result = configReadResultSchema.parse(await readGatewayListeners(configuredSite, root));
  return { root, configuredSite, output, result, value: result.ok ? gatewayListenersSchema.parse(Object.fromEntries(result.values.map(entry =>
    [entry.path[0], entry.exists && 'value' in entry ? entry.value : undefined]))) : undefined };
}

async function localhostListenersFixture(hosts = ['127.0.0.1', '::1'], listeningHosts = hosts) {
  const fixture = await listenersFixture();
  const addresses = { main: 'http://localhost:18010/v1', coder: 'http://localhost:18011/v1', fast: 'http://localhost:18012/v1' };
  fixture.configuredSite = settingsTargetsSchema.parse({ ...fixture.configuredSite, roleAddresses: addresses });
  lookupAll.mockResolvedValue(hosts.map(address => ({ address, family: address === '::1' ? 6 : 4 })));
  if (!listeningHosts.includes('127.0.0.1')) await writeFile(join(fixture.root, '1/net/tcp'), 'sl local_address rem_address st\n');
  if (listeningHosts.includes('::1')) {
    await writeFile(join(fixture.root, '1/net/tcp6'), 'sl local_address rem_address st tx_queue rx_queue tr uid timeout inode\n'
      + [18010, 18011, 18012].map((port, index) => `${index}: 00000000000000000000000001000000:${port.toString(16)} 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 ${201 + index}\n`).join(''));
    for (let index = 0; index < 3; index++) await symlink(`socket:[${201 + index}]`, join(fixture.root, '1/fd', String(10 + index)));
  }
  const output = fixture.output.replace(/Listen=.*\n/, `Listen=${[...new Set(listeningHosts)].flatMap(host => [18010, 18011, 18012]
    .map(port => `${host === '::1' ? '[::1]' : host}:${port} (Stream)`)).join(' ')}\n`);
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    (args.at(-1) as (error: Error | null, stdout: string) => void)(null, output);
    return {} as ReturnType<typeof execFile>;
  });
  return { ...fixture, addresses, output };
}

describe('socket listener ownership', () => {
  it.each([
    ['IPv4', ['127.0.0.1'], ['127.0.0.1']], ['IPv6', ['::1'], ['::1']],
    ['both families', ['127.0.0.1', '::1'], ['127.0.0.1', '::1']],
    ['duplicate resolutions', ['127.0.0.1', '127.0.0.1', '::1'], ['127.0.0.1', '::1']],
    ['dual resolution and IPv4-only listeners', ['127.0.0.1', '::1'], ['127.0.0.1']],
    ['dual resolution and IPv6-only listeners', ['127.0.0.1', '::1'], ['::1']],
  ])('verifies localhost against its exact resolved endpoints with %s', async (_name, hosts, listeningHosts) => {
    const { root, configuredSite, addresses } = await localhostListenersFixture(hosts as string[], listeningHosts as string[]);
    const result = await readGatewayListeners(configuredSite, root);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected listeners');
    const value = gatewayListenersSchema.parse(Object.fromEntries(result.values.map(entry => [entry.path[0], 'value' in entry ? entry.value : undefined])));
    expect(Object.values(value.roles).map(role => role.state)).toEqual(['held', 'held', 'held']);
    expect(lookup).toHaveBeenCalledExactlyOnceWith('localhost', { all: true });
    const row = rowOf(await fixtures({ deployment: { roleAddresses: addresses }, gateway: {
      listeningPorts: await heldSocketPorts(join(root, '1/net')), listeners: { ok: true, value },
    } }).rows(), 'gateway.socket-unit');
    expect(row.state).toBe('ok'); expect(row.fix).toBeUndefined();
  });

  it.each(['address', 'uid', 'inode', 'unit endpoint', 'service', 'duplicate socket', 'missing family', 'unconfigured listener'])
    ('refuses localhost ownership when a resolved endpoint has the wrong %s', async mismatch => {
      const { root, configuredSite, addresses, output } = await localhostListenersFixture();
      const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const path = join(root, '1/net/tcp6');
      const original = await real.readFile(path, 'utf8');
      if (mismatch === 'address') await writeFile(path, original.replaceAll('00000000000000000000000001000000', '00000000000000000000000002000000'));
      if (mismatch === 'uid') await writeFile(path, original.replace(' 0 0 202', ' 1001 0 202'));
      if (mismatch === 'inode') { await rm(join(root, '1/fd/11')); await symlink('socket:[999]', join(root, '1/fd/11')); }
      if (mismatch === 'duplicate socket') await writeFile(path, original + original.split('\n')[2]! + '\n');
      if (mismatch === 'missing family') await writeFile(path, 'sl local_address rem_address st\n');
      if (mismatch === 'unit endpoint' || mismatch === 'service' || mismatch === 'unconfigured listener') vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        (args.at(-1) as (error: Error | null, stdout: string) => void)(null, mismatch === 'service'
          ? output.replace('Triggers=example.service', 'Triggers=other.service') : mismatch === 'unconfigured listener'
            ? output.replace('[::1]:18011 (Stream)', '') : output.replace('[::1]:18011', '[::1]:18013'));
        return {} as ReturnType<typeof execFile>;
      });
      const result = await readGatewayListeners(configuredSite, root);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected listeners');
      const value = gatewayListenersSchema.parse(Object.fromEntries(result.values.map(entry => [entry.path[0], 'value' in entry ? entry.value : undefined])));
      expect(value.roles.coder.state).not.toBe('held');
      const row = rowOf(await fixtures({ deployment: { roleAddresses: addresses }, gateway: {
        listeningPorts: await heldSocketPorts(join(root, '1/net')), listeners: { ok: true, value },
      } }).rows(), 'gateway.socket-unit');
      expect(row.state).toBe('fail'); expect(row.fix).toEqual({ operation: 'gateway.socket-recover', params: {} });
    });

  it.each([
    [], [{ address: '192.0.2.1', family: 4 }], [{ address: 'localhost', family: 4 }], [{ address: '::1', family: 4 }],
    [{ address: '127.0.0.1', family: 4 }, { address: '192.0.2.1', family: 4 }],
    Array.from({ length: 17 }, () => ({ address: '127.0.0.1', family: 4 })),
  ].map(resolved => [resolved]))('preserves uncertainty for unsafe or empty localhost resolution %j', async resolved => {
    const { root, configuredSite, addresses } = await localhostListenersFixture();
    lookupAll.mockResolvedValue(resolved);
    expect(await readGatewayListeners(configuredSite, root)).toEqual({ ok: false, code: 'unavailable' });
    const row = rowOf(await fixtures({ deployment: { roleAddresses: addresses }, gateway: {
      listeners: { ok: false, failure: 'failed', code: 'unavailable' },
    } }).rows(), 'gateway.socket-unit');
    expect(row.state).toBe('unknown'); expect(row.fix).toBeUndefined();
  });

  it('preserves uncertainty when localhost resolution fails or stalls', async () => {
    const { root, configuredSite } = await localhostListenersFixture();
    lookupAll.mockRejectedValueOnce(new Error('unavailable'));
    expect(await readGatewayListeners(configuredSite, root)).toEqual({ ok: false, code: 'unavailable' });
    let started!: () => void;
    const resolving = new Promise<void>(resolve => { started = resolve; });
    lookupAll.mockImplementationOnce(() => { started(); return new Promise(() => {}); });
    vi.useFakeTimers();
    try {
      const pending = readGatewayListeners(configuredSite, root);
      await resolving;
      await vi.advanceTimersByTimeAsync(750);
      expect(await pending).toEqual({ ok: false, code: 'unavailable' });
    } finally { vi.useRealTimers(); }
  });

  it('accepts alternate loopback listeners only with exact unit, UID and descriptor ownership', async () => {
    const { root, configuredSite, output } = await listenersFixture();
    const addresses = { main: 'http://127.0.0.2:18010/v1', coder: 'http://127.0.0.2:18011/v1', fast: 'http://127.0.0.2:18012/v1' };
    configuredSite.roleAddresses = addresses;
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const path = join(root, '1/net/tcp');
    const original = await real.readFile(path, 'utf8');
    await writeFile(path, original.replaceAll('0100007F', '0200007F'));
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: Error | null, stdout: string) => void)(null, output.replaceAll('127.0.0.1', '127.0.0.2'));
      return {} as ReturnType<typeof execFile>;
    });
    const result = await readGatewayListeners(configuredSite, root);
    if (!result.ok) throw new Error('expected listeners');
    const value = gatewayListenersSchema.parse(Object.fromEntries(result.values.map(entry => [entry.path[0], 'value' in entry ? entry.value : undefined])));
    expect(Object.values(value.roles).map(role => role.state)).toEqual(['held', 'held', 'held']);
    const fixture = fixtures({ deployment: { roleAddresses: addresses }, gateway: {
      listeningPorts: await heldSocketPorts(join(root, '1/net')), listeners: { ok: true, value },
    } });
    expect(rowOf(await fixture.rows(), 'gateway.socket-unit').state).toBe('ok');
    await writeFile(path, original.replaceAll('0100007F', '0200007F').replace(' 0 0 102', ' 1001 0 102'));
    const foreign = await readGatewayListeners(configuredSite, root);
    expect(foreign).toMatchObject({ ok: true, values: expect.arrayContaining([{ path: ['roles'], exists: true,
      value: expect.objectContaining({ coder: { address: addresses.coder, state: 'foreign' } }) }]) });
  });

  it('accepts exact configured addresses held by PID 1 even when HTTP is unavailable', async () => {
    const { value } = await listenersFixture();
    expect(value?.roles.main.state).toBe('held'); expect(value?.roles.coder.state).toBe('held'); expect(value?.roles.fast.state).toBe('held');
    const rows = await fixtures({ gateway: { healthz: { main: false, coder: false, fast: false }, listeners: { ok: true, value: value! } } }).rows();
    expect(rowOf(rows, 'gateway.socket-unit').state).toBe('ok');
  });

  it.each([
    [[0, 1001, 1001], [18010], [101, 102, 103], 'example.service'],
    [[0, 1001, 1001], [18010, 18011, 18012], [101, 102, 103], 'example.service'],
    [[0, 0, 0], [18010, 18011, 18012], [101], 'example.service'],
    [[0, 0, 0], [18010, 18011, 18012], [101, 102, 103], 'other.service'],
  ])('refuses unrelated owners, descriptors and service associations', async (uids, ports, inodes, triggers) => {
    const { value } = await listenersFixture(uids as number[], ports as number[], inodes as number[], triggers as string);
    expect(rowOf(await fixtures({ gateway: { listeners: { ok: true, value: value! } } }).rows(), 'gateway.socket-unit').state).toBe('fail');
  });

  it('refuses a listener view whose observed addresses differ from this deployment', async () => {
    const { value } = await listenersFixture();
    value!.roles.coder.address = 'http://127.0.0.1:18013/v1';
    expect(rowOf(await fixtures({ gateway: { listeners: { ok: true, value: value! } } }).rows(), 'gateway.socket-unit').state).toBe('fail');
  });

  it('compares the full bound loopback address as well as the port', async () => {
    const { root, configuredSite, output } = await listenersFixture();
    configuredSite.roleAddresses!.main = 'http://127.0.0.2:18010/v1';
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: Error | null, stdout: string) => void)(null, output.replace('127.0.0.1:18010', '127.0.0.2:18010'));
      return {} as ReturnType<typeof execFile>;
    });
    const result = await readGatewayListeners(configuredSite, root);
    expect(result).toMatchObject({ ok: true, values: expect.arrayContaining([
      { path: ['roles'], exists: true, value: expect.objectContaining({ main: {
        address: 'http://127.0.0.2:18010/v1', state: 'missing',
      } }) },
    ]) });
  });

  it('rejects an unauthorized read before observing a configured socket unit', async () => {
    const verbs = new ConfigVerbs({ stateDir: '/example/state', site: async () => site });
    expect(await verbs.read({ view: 'gateway.listeners' }, { name: 'example-rescue', scope: 'rescue', sha256: 'a'.repeat(64) }))
      .toEqual({ ok: false, code: 'not_permitted' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('preserves uncertainty for incomplete or missing kernel evidence', async () => {
    const { root, configuredSite } = await listenersFixture();
    await writeFile(join(root, '1/net/tcp'), 'sl local_address rem_address st\n0: 0100007F:465A 00000000:0000 0A\n');
    expect(await readGatewayListeners(configuredSite, root)).toEqual({ ok: false, code: 'unavailable' });
    expect(await readGatewayListeners(configuredSite, join(root, 'missing'))).toEqual({ ok: false, code: 'unavailable' });
  });
});

describe('authorized gateway runtime read view', () => {
  it('projects complete provider records as digests even to a PC caller', async () => {
    const providers = { 'wayroost-main': { base_url: 'http://127.0.0.1:18010/v1', api_key: 'example-placeholder', models: [{ id: 'main' }] } };
    const values = await readViewValues('hermes.providers', { providers }, { scopes: ['settings', 'pc-settings'], listener: 'local', pcOnlyWrites: true });
    expect(values).toEqual([{ path: ['providers', 'wayroost-main'], exists: true, value: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), length: expect.any(Number) } }]);
    expect(JSON.stringify(values)).not.toMatch(/example-placeholder|api_key|base_url|models/);
  });
  it('reports managed provider and argument presence without returning values', async () => {
    for (const context of [{ scopes: ['settings'] }, { scopes: ['settings', 'pc-settings'], listener: 'local', pcOnlyWrites: true }] as const) {
      const values = await readViewValues('hermes.managed', {
        providers: { 'wayroost-main': { api_key: 'example-placeholder', models: [{ id: 'example-model' }], options: { enabled: true } } },
        mcp_servers: { coder: { args: ['/home/me/example.py'] } },
      }, { ...context, scopes: [...context.scopes] });
      expect(values).toContainEqual({ path: ['providers', 'wayroost-main'], exists: true });
      expect(values).toContainEqual({ path: ['mcp_servers', 'coder', 'args'], exists: true });
      expect(values.every(value => !('value' in value))).toBe(true);
      expect(JSON.stringify(values)).not.toMatch(/example-placeholder|example-model|example.py/);
    }
  });
  it('exposes bounded supervisor record failures alongside their parent settings change', async () => {
    filesystem();
    const root = await mkdtemp(join(process.cwd(), '.tmp/checks-outcomes-')); roots.push(root);
    const record = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', time: '2026-10-04T09:00:00Z', caller: 'example-server',
      verb: 'config.apply', operation: 'gateway.record-migration', target: 'gateway-state', keys: ['migration.consumers'],
      change: 'ch_' + 'a'.repeat(24), result: 'verify_mismatch' };
    const log = join(root, 'config-audit.jsonl');
    await writeFile(log, JSON.stringify(record) + '\n', { mode: 0o600 });
    const configured = settingsTargetsSchema.parse({ version: 1, targets: {
      'gateway-state': { directory: '/example/gateway-state', backupDir: '/example/gateway-backups' },
    } });
    const status = await new ConfigVerbs({ stateDir: root, site: async () => configured }).status();
    expect(status.gatewayPersistence).toEqual({ ok: true, failedChanges: [record.change] });
    const fixture = fixtures();
    const baseline = await fixture.sources.supervisorStatus!();
    if (!baseline) throw new Error('missing supervisor status');
    const rows = await fixture.rows({ supervisorStatus: async () => ({ ...baseline, configVerbs: status }),
      recentChanges: async () => [{ id: record.change, at: 1000, action: 'apply', operation: 'hermes.default-model', target: 'hermes-config', result: 'verify_mismatch' }],
    });
    expect(rowOf(rows, 'supervisor.gateway-state')).toMatchObject({ state: 'warn', details: [record.change] });
    await writeFile(log, JSON.stringify({ ...record, operation: 'hermes.personality', target: 'hermes-config' }) + '\n');
    expect(await readGatewayPersistence(root)).toEqual({ ok: true, failedChanges: [] });
    await writeFile(log, 'incomplete');
    expect(await readGatewayPersistence(root)).toEqual({ ok: false, code: 'unavailable' });
  });

  it('retains unresolved record failures across unrelated rows until a matching verified repair', async () => {
    filesystem();
    const root = await mkdtemp(join(process.cwd(), '.tmp/checks-outcomes-')); roots.push(root);
    const record = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', time: '2026-10-04T09:00:00Z', caller: 'example-server',
      verb: 'config.apply', operation: 'gateway.record-migration', target: 'gateway-state', keys: [],
      change: 'ch_' + 'a'.repeat(24), result: 'verify_mismatch' };
    const log = join(root, 'config-audit.jsonl');
    await writeFile(log, JSON.stringify(record) + '\n', { mode: 0o600 });
    const failure = { ok: true, failedChanges: [record.change] };
    expect(await readGatewayPersistence(root)).toEqual(failure);
    const reads = Array.from({ length: 64 }, (_, index) => JSON.stringify({ ...record,
      id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, '0')}`, verb: 'config.read',
      operation: undefined, change: undefined, result: 'ok' }) + '\n').join('');
    await appendFile(log, reads);
    expect(await readGatewayPersistence(root)).toEqual(failure);
    await appendFile(log, reads.repeat(8));
    await expect((await import('node:fs/promises')).stat(log).then(stat => stat.size)).resolves.toBeGreaterThan(65_536);
    expect(await readGatewayPersistence(root)).toEqual(failure);
    for (const repair of [
      { ...record, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', change: 'ch_' + 'b'.repeat(24), result: 'ok' },
      { ...record, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', operation: 'gateway.record-override', result: 'ok' },
      { ...record, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', result: 'outcome_unknown' },
    ]) {
      await appendFile(log, JSON.stringify(repair) + '\n');
      expect(await readGatewayPersistence(root)).toEqual(failure);
    }
    const fixture = fixtures(); const baseline = await fixture.sources.supervisorStatus!();
    if (!baseline) throw new Error('missing supervisor status');
    expect(rowOf(await fixture.rows({ supervisorStatus: async () => ({ ...baseline,
      configVerbs: { ...baseline.configVerbs!, gatewayPersistence: await readGatewayPersistence(root) },
    }) }), 'supervisor.gateway-state')).toMatchObject({ state: 'warn', details: [record.change] });
    await appendFile(log, JSON.stringify({ ...record, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', result: 'ok' }) + '\n');
    expect(await readGatewayPersistence(root)).toEqual({ ok: true, failedChanges: [] });
  });

  it('preserves failures with no parent change until their own verified result', async () => {
    filesystem();
    const root = await mkdtemp(join(process.cwd(), '.tmp/checks-outcomes-')); roots.push(root);
    const record = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', time: '2026-10-04T09:00:00Z', caller: 'example-server',
      verb: 'config.apply', operation: 'gateway.record-override', target: 'gateway-state', keys: [], result: 'verify_mismatch' };
    const log = join(root, 'config-audit.jsonl');
    await writeFile(log, JSON.stringify(record) + '\n', { mode: 0o600 });
    expect(await readGatewayPersistence(root)).toEqual({ ok: true, failedChanges: [record.id] });
    await appendFile(log, JSON.stringify({ ...record, result: 'ok' }) + '\n');
    expect(await readGatewayPersistence(root)).toEqual({ ok: true, failedChanges: [] });
  });

  it('refuses an incomplete or oversized history or a summary with too many unresolved failures', async () => {
    filesystem();
    const root = await mkdtemp(join(process.cwd(), '.tmp/checks-outcomes-')); roots.push(root);
    const record = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', time: '2026-10-04T09:00:00Z', caller: 'example-server',
      verb: 'config.apply', operation: 'gateway.record-migration', target: 'gateway-state', keys: [], result: 'verify_mismatch' };
    const log = join(root, 'config-audit.jsonl');
    await writeFile(log, Array.from({ length: 2000 }, (_, index) => JSON.stringify({ ...record,
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`, change: 'ch_' + index.toString(16).padStart(24, '0') }) + '\n').join(''), { mode: 0o600 });
    const result = await readGatewayPersistence(root);
    expect(result).toEqual({ ok: false, code: 'unavailable' });
    await writeFile(log, 'x'.repeat(70_000));
    expect(await readGatewayPersistence(root)).toEqual({ ok: false, code: 'unavailable' });
    await writeFile(log, (JSON.stringify({ ...record, result: 'ok' }) + '\n').repeat(20_000));
    expect(await readGatewayPersistence(root)).toEqual({ ok: false, code: 'unavailable' });
    const fixture = fixtures(); const baseline = await fixture.sources.supervisorStatus!();
    if (!baseline) throw new Error('missing supervisor status');
    expect(rowOf(await fixture.rows({ supervisorStatus: async () => ({ ...baseline,
      configVerbs: { ...baseline.configVerbs!, gatewayPersistence: await readGatewayPersistence(root) },
    }) }), 'supervisor.gateway-state').state).toBe('unknown');
  });
  it('preserves actual mapping, ownership failure and drain status through config.read', async () => {
    filesystem(0o600, 12345); response(status);
    const verbs = new ConfigVerbs({ stateDir: '/example/state', site: async () => site });
    const result = await verbs.read({ view: 'gateway.status' }, { name: 'example-server', scope: 'server', sha256: 'a'.repeat(64) });
    expect(configReadResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ ok: true, view: 'gateway.status', values: [
      { path: ['roles'], value: status.roles }, { path: ['draining'], value: true },
    ] });
  });

  it('refuses a rescue key before connecting to the admin socket', async () => {
    filesystem(); response(status);
    const verbs = new ConfigVerbs({ stateDir: '/example/state', site: async () => site });
    expect(await verbs.read({ view: 'gateway.status' }, { name: 'example-rescue', scope: 'rescue', sha256: 'a'.repeat(64) }))
      .toEqual({ ok: false, code: 'not_permitted' });
    expect(request).not.toHaveBeenCalled();
  });
  it('requires a healthy event loop and the configured gateway owner before reporting model telemetry', async () => {
    filesystem(0o600, 12345); owner(23456); response(status);
    expect(await readGatewayStatus(site)).toEqual({ ok: false, code: 'unsafe_target' });
    expect(request).not.toHaveBeenCalled();
    filesystem(0o600, 12345); response(status);
    const reply = vi.mocked(request).getMockImplementation()!;
    vi.mocked(request).mockImplementation(((options: { path: string }, callback: unknown) => {
      if (options.path !== '/healthz') return (reply as (...args: unknown[]) => unknown)(options, callback);
      const client = new EventEmitter();
      Object.assign(client, { end: () => {
        const stream = new EventEmitter(); Object.assign(stream, { statusCode: 503, destroy: vi.fn() });
        (callback as (stream: EventEmitter) => void)(stream); stream.emit('data', Buffer.from('{"status":"down"}')); stream.emit('end');
      } });
      return client;
    }) as never);
    expect(await readGatewayStatus(site)).toEqual({ ok: false, code: 'unavailable' });
  });

  it('rejects unsafe sockets, malformed, oversized and redirected answers', async () => {
    filesystem(0o666); response(status);
    expect(await readGatewayStatus(site)).toEqual({ ok: false, code: 'unsafe_target' });
    expect(request).not.toHaveBeenCalled();
    filesystem(0o600, 12345);
    for (const [body, code] of [[{}, 200], ['x'.repeat(70_000), 200], [status, 302]] as const) {
      response(body, code);
      expect(await readGatewayStatus(site)).toEqual({ ok: false, code: 'unavailable' });
    }
  });

  it('includes every configured target and preserves unavailable site preflights', async () => {
    filesystem(); owner(12345);
    const configured = settingsTargetsSchema.parse({ version: 1, targets: { ...site.targets,
      'codex-config': { path: '/example/unsafe/codex.toml', format: 'toml', runAs: { user: 'me', uid: 1000 } },
      'gateway-state': { directory: '/example/state', backupDir: '/example/backups' },
    } });
    vi.mocked(lstat).mockImplementation(async path => ({ uid: 0, mode: path === '/example/unsafe' ? 0o777 : 0o755,
      isSymbolicLink: () => false, isDirectory: () => true,
    }) as never);
    const verbs = new ConfigVerbs({ stateDir: '/example/audit', site: async () => configured });
    const result = await verbs.status();
    expect(result.directories).toContainEqual({ target: 'codex-config', storage: 'target', ok: false, code: 'unsafe_directory' });
    expect(result.directories).toContainEqual({ target: 'gateway-state', storage: 'backup', ok: true });
  });

  it('preflights the map with its validated dynamic owner while retaining directory restrictions', async () => {
    filesystem(0o600, 12345); owner(12345);
    const verbs = new ConfigVerbs({ stateDir: '/example/audit', site: async () => site });
    expect((await verbs.status()).directories).toEqual([{ target: 'gateway-role-map', storage: 'target', ok: true }]);
    owner(54321);
    expect((await verbs.status()).directories).toEqual([{ target: 'gateway-role-map', storage: 'target', ok: false, code: 'unsafe_directory' }]);
    owner(12345, 'no');
    expect((await verbs.status()).directories?.[0]?.ok).toBe(false);
    owner(12345);
    vi.mocked(lstat).mockResolvedValue({ uid: 12345, mode: 0o777, isSymbolicLink: () => false, isDirectory: () => true } as never);
    expect((await verbs.status()).directories?.[0]?.ok).toBe(false);
  });

  it('retains typed directory results for targets absent from check views', async () => {
    const parsed = configVerbsStatusSchema.parse({ version: 1, configWrites: true, verbs: ['config.read'], catalogue: 5,
      directories: [{ target: 'codex-config', storage: 'target', ok: false, code: 'unsafe_directory' }],
    });
    expect(parsed.directories).toEqual([{ target: 'codex-config', storage: 'target', ok: false, code: 'unsafe_directory' }]);
    expect(configVerbsStatusSchema.safeParse({ ...parsed, directories: [{ target: 'codex-config', storage: 'target', ok: false }] }).success).toBe(false);
  });
});
