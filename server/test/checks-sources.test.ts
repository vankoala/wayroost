import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coderProcesses, drainMarker, gatewayRoles, getJson, hermesStartedAt, socketUnitState, switchFlags, heldSocketPorts, phoneCounters, PhoneObservations, buildChecks, CHECK_PHONE_TIMEOUT_MS } from '../src/checks/sources.js';
import { collectSnapshot } from '../src/checks/snapshot.js';
import { fixtures, rowOf, DEMO_STATE, moveRecord, writtenKey } from './checks-fixtures.js';
import { DEMO_MAIN_ADDRESS, DEMO_CODER_ADDRESS, DEMO_FAST_ADDRESS, DEMO_ORIGINAL, DEMO_COPY } from './checks-fixtures.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temporary() { const path = await mkdtemp(join(tmpdir(), 'wayroost-checks-')); roots.push(path); return path; }
function systemctl(stdout: string, error: Error | null = null) {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    (args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void)(error, stdout, '');
    return {} as ReturnType<typeof execFile>;
  });
}
const marker = { action: 'drain', requested_at: '2026-10-04T09:00:00Z', principal: 'wayroost',
  epoch: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:123', suppress_notification: true };

describe('bounded HTTP probes', () => {
  it('allows bounded owner launch time and turns an unavailable owner into unknown', async () => {
    vi.useFakeTimers();
    const snapshot = collectSnapshot({ hermesStartedAt: () => new Promise(resolve => setTimeout(() => resolve(1000), 50)),
      coderProcesses: () => new Promise(() => {}) }, {}, { sourceTimeoutMs: 10, ownerTimeoutMs: 100, budgetMs: 200 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await snapshot;
    expect(result.hermesStartedAt).toEqual({ ok: true, value: 1000 });
    expect(result.coderProcesses.ok).toBe(false);
  });

  it('checks healthz independently of the backend response', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify({ status: url.endsWith('/healthz') ? 'ok' : 'up' }))));
    const gateway = await gatewayRoles({ main: DEMO_MAIN_ADDRESS, coder: DEMO_CODER_ADDRESS, fast: DEMO_FAST_ADDRESS }, 500, undefined, undefined, async () => []);
    expect(gateway.healthz).toEqual({ main: true, coder: true, fast: true });
    expect(gateway.roles.main.health).toBe('unknown');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify({ status: url.endsWith('/healthz') ? 'bad' : 'up' }))));
    expect((await gatewayRoles({ main: DEMO_MAIN_ADDRESS }, 500, undefined, undefined, async () => [])).healthz.main).toBe(false);
  });

  it('cancels an oversized stream without reading the remainder', async () => {
    let pulled = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulled++; controller.enqueue(new Uint8Array(40_000)); }, cancel,
    }, { highWaterMark: 0 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    expect(await getJson(DEMO_MAIN_ADDRESS + '/healthz', 500)).toBeUndefined();
    expect(pulled).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects redirect following', async () => {
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.redirect).toBe('error');
      throw new TypeError('redirect');
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await getJson(DEMO_MAIN_ADDRESS + '/healthz', 500)).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('unit and process observations', () => {
  it.each(['active', 'activating', 'inactive', 'failed'] as const)('preserves ActiveState=%s independently of Result', async active => {
    systemctl(`ActiveState=${active}\nResult=trigger-limit-hit\n`);
    expect(await socketUnitState('example.socket', 500)).toBe(active);
  });

  it('represents a failed unit query as unavailable', async () => {
    systemctl('', new Error('failed'));
    expect(await socketUnitState('example.socket', 500)).toBeNull();
  });

  it('parses numeric start ticks and matches the actual script argument', async () => {
    const root = await temporary();
    await writeFile(join(root, 'uptime'), '1000.00 100.00');
    const fields = Array.from({ length: 20 }, () => '0'); fields[0] = 'S'; fields[19] = '10000';
    for (const [pid, script] of [['123', DEMO_ORIGINAL], ['124', '/another/helper-mcp.py'], ['125', DEMO_COPY + '.wrong'], ['126', '/another/unrelated-tool.py']]) {
      await mkdir(join(root, pid!));
      await writeFile(join(root, pid!, 'stat'), `${pid} (example worker) ${fields.join(' ')}`);
      await writeFile(join(root, pid!, 'cmdline'), `python3\0-u\0${script}\0--note=${DEMO_COPY}\0`);
    }
    const processes = await coderProcesses({ original: DEMO_ORIGINAL, gatewayCopy: DEMO_COPY }, () => 2_000_000, root);
    expect(processes).toEqual([{ script: 'original', startedAt: 1_100_000 }, { script: 'other', startedAt: 1_100_000 }]);
    systemctl('123\n');
    expect(await hermesStartedAt('example.service', () => 2_000_000, root)).toBe(1_100_000);
    systemctl('0\n');
    await expect(hermesStartedAt('example.service', () => 2_000_000, root)).rejects.toThrow('unavailable');
  });
});

describe('configured files', () => {
  it('preserves missing, malformed, oversized and invalid switch files as failures', async () => {
    const path = join(await temporary(), 'flags.json');
    await expect(switchFlags(path)).rejects.toThrow('unavailable');
    for (const text of ['{', '{}'.repeat(10_000), '{"pi":"yes"}']) {
      await writeFile(path, text);
      await expect(switchFlags(path)).rejects.toThrow('unavailable');
    }
    await writeFile(path, '{"pi":true}');
    expect(await switchFlags(path)).toEqual({ pi: true });
  });

  it('rejects symlinked parents for marker, state and switch files', async () => {
    const root = await temporary();
    await mkdir(join(root, 'real'));
    await symlink(join(root, 'real'), join(root, 'alias'));
    await writeFile(join(root, 'real', 'marker.json'), JSON.stringify(marker));
    await writeFile(join(root, 'real', 'flags.json'), '{"pi":true}');
    expect((await drainMarker({ path: join(root, 'alias', 'marker.json') })).unreadable).toBe(true);
    await expect(switchFlags(join(root, 'alias', 'flags.json'))).rejects.toThrow('unavailable');
    await writeFile(join(root, 'marker.json'), JSON.stringify(marker));
    await writeFile(join(root, 'real', 'state.json'), JSON.stringify({ phase: 'draining', marker_requested_at: marker.requested_at, stopped_gateway: false, started_gateway: false }));
    systemctl('ActiveState=active\n');
    expect((await drainMarker({ path: join(root, 'marker.json'), stateFile: join(root, 'alias', 'state.json'), executorUnit: 'example.service' })).drainRunning).toBeNull();
  });

  it('requires valid executor state and an active associated unit', async () => {
    const root = await temporary();
    const path = join(root, 'marker.json'); const stateFile = join(root, 'state.json');
    await writeFile(path, JSON.stringify(marker));
    await writeFile(stateFile, '{}');
    systemctl('ActiveState=active\n');
    expect((await drainMarker({ path, stateFile, executorUnit: 'example.service' })).drainRunning).toBeNull();
    await writeFile(stateFile, JSON.stringify({ phase: 'draining', marker_requested_at: marker.requested_at, stopped_gateway: false, started_gateway: false }));
    expect((await drainMarker({ path, stateFile, executorUnit: 'example.service' })).drainRunning).toBe(true);
    systemctl('ActiveState=inactive\n');
    expect((await drainMarker({ path, stateFile, executorUnit: 'example.service' })).drainRunning).toBe(false);
    systemctl('', new Error('unavailable'));
    expect((await drainMarker({ path, stateFile, executorUnit: 'example.service' })).drainRunning).toBeNull();
    expect((await drainMarker({ path, stateFile })).drainRunning).toBeNull();
  });
});

describe('production source wiring', () => {
  it('maps directory preflight refusals and re-reads every page', async () => {
    const { buildChecks } = await import('../src/checks/sources.js');
    const { makeConfig } = await import('./helpers.js');
    const { FakeSettingsSupervisor } = await import('./fake-settings-supervisor.js');
    const config = makeConfig(); roots.push(config.stateDir); config.paseo.enabled = false;
    const supervisor = new FakeSettingsSupervisor();
    const status = supervisor.status.getMockImplementation()!;
    supervisor.status.mockImplementation(async () => ({ ...await status(), configVerbs: { ...await status().then(value => value.configVerbs),
      directories: [{ target: 'codex-config', storage: 'target', ok: false, code: 'unsafe_directory' }],
    } }) as never);
    const checks = buildChecks(config, supervisor)!;
    const refused = await checks.rows();
    expect(refused.rows.find(row => row.id === 'directories.walk')).toMatchObject({ state: 'fail', details: ['codex-config'] });
    supervisor.status.mockImplementation(async () => ({ ...await status(), configVerbs: { ...await status().then(value => value.configVerbs),
      directories: [{ target: 'codex-config', storage: 'target', ok: true }],
    } }) as never);
    const ready = await checks.rows();
    expect(ready.rows.find(row => row.id === 'directories.walk')!.state).toBe('ok');
    expect(ready.rows.find(row => row.id === 'supervisor.config-verbs')!.state).toBe('ok');
    supervisor.status.mockResolvedValueOnce({ overall: 'ok', sentence: 'Ready.', at: 0, components: [],
      configVerbs: { version: 1, configWrites: false, catalogue: 1, verbs: ['config.read'] } });
    expect((await checks.rows()).rows.find(row => row.id === 'supervisor.config-verbs')!.state).toBe('warn');
  });

  it('projects effective provider state and paged agent pins from the daemon API', async () => {
    const { paseoRuntime } = await import('../src/checks/paseo-source.js');
    const client = {
      connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
      getProvidersSnapshot: vi.fn(async () => ({ entries: [{ provider: 'pi', enabled: true, models: [{ id: 'wayroost-main/main' }] }] })),
      fetchAgents: vi.fn(async () => ({ entries: [{ agent: { id: 'fake-agent', provider: 'pi', model: 'wayroost-main/main' } }], pageInfo: { hasMore: false } })),
    };
    const result = await paseoRuntime('ws://127.0.0.1:8896', () => client as never);
    expect(result).toEqual({ providers: { pi: { enabled: true, models: ['wayroost-main/main'] } }, agents: [{ id: 'fake-agent', provider: 'pi', model: 'wayroost-main/main' }] });
    expect(client.close).toHaveBeenCalledOnce();
    client.fetchAgents.mockResolvedValue({ entries: [], pageInfo: { hasMore: true } });
    await expect(paseoRuntime('ws://127.0.0.1:8896', () => client as never)).rejects.toThrow('unavailable');
    await expect(paseoRuntime('ws://example.com:8896', () => client as never)).rejects.toThrow('unavailable');
  });
});


describe('complete runtime observations', () => {
  it.each([9, 16, 31])('rejects a malformed %s-digit kernel socket address', async length => {
    const root = await temporary();
    await writeFile(join(root, 'tcp'), `sl local_address rem_address st\n0: ${'0'.repeat(length)}:465A 00000000:0000 0A\n`);
    await writeFile(join(root, 'tcp6'), 'sl local_address rem_address st\n');
    expect(await heldSocketPorts(root)).toBeNull();
  });

  it('includes the full IPv4 loopback range and IPv6 loopback while excluding other interfaces', async () => {
    const root = await temporary();
    await writeFile(join(root, 'tcp'), 'sl local_address rem_address st\n'
      + '0: 0200007F:465A 00000000:0000 0A\n'
      + '1: FFFFFF7F:465B 00000000:0000 0A\n'
      + '2: 0000007F:465C 00000000:0000 0A\n'
      + '3: 0200000A:465D 00000000:0000 0A\n'
      + '4: 0200007F:465E 00000000:0000 01\n');
    await writeFile(join(root, 'tcp6'), 'sl local_address rem_address st\n'
      + '0: 00000000000000000000000001000000:465F 00000000000000000000000000000000:0000 0A\n'
      + '1: 0000000000000000FFFF00000200007F:4660 00000000000000000000000000000000:0000 0A\n');
    expect(await heldSocketPorts(root)).toEqual([18010, 18011, 18012, 18015]);
  });

  it('keeps held sockets independent of HTTP timeouts', async () => {
    const root = await temporary();
    await writeFile(join(root, 'tcp'), 'sl local_address rem_address st\n0: 0100007F:232C 00000000:0000 0A\n');
    await writeFile(join(root, 'tcp6'), 'sl local_address rem_address st\n');
    expect(await heldSocketPorts(root)).toEqual([9004]);
    systemctl('ActiveState=active\n');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout'); }));
    const source = await gatewayRoles({ main: DEMO_MAIN_ADDRESS, coder: DEMO_CODER_ADDRESS, fast: DEMO_FAST_ADDRESS }, 500,
      'example.socket', undefined, async () => [18010, 18011, 18012], async () => ({ ok: true, value: {
        unit: 'example.socket', socketUnit: 'active', roles: {
          main: { address: DEMO_MAIN_ADDRESS, state: 'held' }, coder: { address: DEMO_CODER_ADDRESS, state: 'held' },
          fast: { address: DEMO_FAST_ADDRESS, state: 'held' },
        },
      } }));
    const rows = await fixtures({ gateway: source }).rows();
    expect(rowOf(rows, 'gateway.socket-unit')).toMatchObject({ state: 'ok' });
    expect(rowOf(rows, 'gateway.health').state).toBe('fail');
    const unknown = await fixtures({ gateway: { ...source, listeningPorts: null } }).rows();
    expect(rowOf(unknown, 'gateway.socket-unit')).toMatchObject({ state: 'unknown' });
    expect(rowOf(unknown, 'gateway.socket-unit').fix).toBeUndefined();
    const unverified = await gatewayRoles({ main: DEMO_MAIN_ADDRESS, coder: DEMO_CODER_ADDRESS, fast: DEMO_FAST_ADDRESS }, 500,
      'example.socket', undefined, async () => [18010, 18011, 18012]);
    expect(rowOf(await fixtures({ gateway: unverified }).rows(), 'gateway.socket-unit').state).toBe('unknown');
    const foreign = { ...source, listeners: { ok: true as const, value: {
      unit: 'example.socket', socketUnit: 'active' as const, roles: {
        main: { address: DEMO_MAIN_ADDRESS, state: 'held' as const }, coder: { address: DEMO_CODER_ADDRESS, state: 'foreign' as const },
        fast: { address: DEMO_FAST_ADDRESS, state: 'foreign' as const },
      },
    } } };
    expect(rowOf(await fixtures({ gateway: foreign }).rows(), 'gateway.socket-unit').state).toBe('fail');
    await writeFile(join(root, 'tcp'), 'malformed');
    expect(await heldSocketPorts(root)).toBeNull();
  });

  it('does not authorize marker removal after refused executor state reads', async () => {
    const root = await temporary(); const path = join(root, 'marker.json');
    await writeFile(path, JSON.stringify(marker));
    await writeFile(join(root, 'state.json'), '{}');
    systemctl('ActiveState=active\n');
    const observation = await drainMarker({ path, stateFile: join(root, 'state.json'), executorUnit: 'example.service' });
    expect(observation.drainRunning).toBeNull();
    const row = rowOf(await fixtures({ sources: { drainMarker: async () => observation } }).rows(), 'hermes.drain-marker');
    expect(row.state).toBe('unknown'); expect(row.fix).toBeUndefined();
    systemctl('ActiveState=activating\n');
    expect((await drainMarker({ path, stateFile: join(root, 'missing.json'), executorUnit: 'example.service' })).drainRunning).toBeNull();
  });

  it('requires both zero counts and stable webhook and outbound counters', async () => {
    const observations = new PhoneObservations();
    const phone = { server: { ok: true as const, value: { activeCalls: 0, webhooks: 10, outboundCalls: 2 } },
      bridge: { ok: true as const, value: { activeCalls: 0, oldestCallMs: 0 } } };
    const check = async (snapshot: typeof phone & { quietForMs?: number | null }) => rowOf(await fixtures({ sources: { phone: async () => snapshot } }).rows(), 'phone.quiet');
    expect((await check(phone)).state).toBe('unknown');
    expect(observations.observe(phone, 1000).quietForMs).toBe(0);
    expect((await check(observations.observe(phone, 121000) as typeof phone)).state).toBe('ok');
    const arriving = { ...phone, server: { ...phone.server, value: { ...phone.server.value, webhooks: 11 } } };
    expect((await check(observations.observe(arriving, 122000) as typeof phone)).state).toBe('warn');
    const unavailable = { ...phone, bridge: { ok: false as const, failure: 'failed' as const } };
    const rows = await fixtures({ sources: { phone: async () => observations.observe(unavailable, 123000) } }).rows();
    expect(rowOf(rows, 'phone.quiet').state).toBe('unknown');
    expect(observations.observe(phone, 124000).quietForMs).toBe(0);
  });

  it('times the excess count itself and resets after an unreadable observation', async () => {
    const observations = new PhoneObservations();
    const phone = { server: { ok: true as const, value: { activeCalls: 1, webhooks: 0, outboundCalls: 0 } },
      bridge: { ok: true as const, value: { activeCalls: 2, oldestCallMs: 20 * 60_000 } } };
    const check = async (snapshot: ReturnType<PhoneObservations['observe']>) => rowOf(await fixtures({ sources: { phone: async () => snapshot } }).rows(), 'phone.stale-count');
    expect((await check(phone)).state).toBe('unknown');
    expect((await check(observations.observe(phone, 1000))).state).toBe('ok');
    for (let minute = 1; minute <= 10; minute++) observations.observe(phone, 1000 + minute * 60_000);
    expect((await check(observations.observe(phone, 602000))).state).toBe('warn');
    expect(observations.observe({ ...phone, bridge: { ok: false, failure: 'failed' } }, 603000).excessForMs).toBeNull();
    expect((await check(observations.observe(phone, 604000))).state).toBe('ok');
  });

  it('collects a nine-second phone answer concurrently with config reads', async () => {
    vi.useFakeTimers();
    const fixture = fixtures();
    const collection = collectSnapshot({ readView: async view => {
      await new Promise(resolve => setTimeout(resolve, 1900)); return fixture.sources.readView!(view);
    }, phone: async () => {
      await new Promise(resolve => setTimeout(resolve, 9000)); return fixture.sources.phone!();
    } }, {}, { views: ['hermes.safety'] });
    await vi.advanceTimersByTimeAsync(9000);
    const snapshot = await collection;
    expect(snapshot.views['hermes.safety']?.ok).toBe(true); expect(snapshot.phone.ok).toBe(true);
  });

  it('supplies the effective running pin through production phone wiring', async () => {
    const { makeConfig } = await import('./helpers.js');
    const { FakeSettingsSupervisor } = await import('./fake-settings-supervisor.js');
    const config = makeConfig(); roots.push(config.stateDir); config.paseo.enabled = false;
    config.checks = { phone: { server: 'http://127.0.0.1:8896', bridge: 'http://127.0.0.1:8897' }, roleAddresses: {
      main: DEMO_MAIN_ADDRESS, coder: DEMO_CODER_ADDRESS, fast: DEMO_FAST_ADDRESS,
    } };
    const supervisor = new FakeSettingsSupervisor();
    supervisor.documents['gateway-state'] = { state: DEMO_STATE, migration: { version: 1, consumers: { phone: {
      'phone-bridge-dropin': moveRecord([writtenKey(['Service', 'Environment'], 'old', 'new')]),
    } } } };
    for (const [model, expected] of [['main', 'ok'], ['fast', 'warn']]) {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('8897')
        ? { active_calls: 0, brains: { persona: { url: DEMO_MAIN_ADDRESS, model } } }
        : { active_calls: 0, webhooks: 0, outbound_calls: 0, status: 'ok' }))));
      expect((await buildChecks(config, supervisor, async () => [18010, 18011, 18012])!.rows()).rows.find(row => row.id === 'phone.address')!.state).toBe(expected);
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"active_calls":0}')));
    expect((await phoneCounters(config.checks.phone!, CHECK_PHONE_TIMEOUT_MS)).server.ok).toBe(false);
  });

  it.each([{}, { url: DEMO_MAIN_ADDRESS }, { url: 'https://example.com', model: 'main' },
    { url: DEMO_MAIN_ADDRESS, model: 1 }, { url: DEMO_MAIN_ADDRESS, model: 'x'.repeat(257) }])(
    'preserves unknown pins for malformed persona observations', async persona => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ active_calls: 0, webhooks: 0, outbound_calls: 0,
        brains: { persona } }))));
      expect((await phoneCounters({ server: DEMO_MAIN_ADDRESS, bridge: DEMO_CODER_ADDRESS }, 500)).pin?.ok).toBe(false);
    });
});
