import { BackgroundGate } from '../src/background.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { EventHub } from '../src/hub.js';
import { PaseoAdapter } from '../src/paseo/adapter.js';
import { cloudAgentList } from '../src/paseo/normalize.js';
import { UserFacingError } from '../src/sources.js';
import { apiHeaders, makeApp, makeKeys, makeToken, ORIGIN, postHeaders, type Keys } from './helpers.js';

const quietLog = { info() {}, warn() {}, error() {} };

// ---- the mapping from Paseo's provider snapshot ------------------------------------

describe('cloudAgentList', () => {
  it('lists the cloud agents Paseo knows, in a fixed order, and leaves local agents out', () => {
    const agents = cloudAgentList([
      { provider: 'pi', status: 'ready', enabled: true },
      { provider: 'opencode', status: 'unavailable', enabled: true, error: 'opencode not found\non PATH' },
      { provider: 'hermes', status: 'ready', enabled: true, label: 'Hermes' },
      { provider: 'codex', status: 'unavailable', enabled: false, error: 'Provider is disabled' },
      { provider: 'claude', status: 'ready', enabled: true, label: 'Claude Code' },
    ]);
    expect(agents).toEqual([
      { id: 'claude', label: 'Claude Code', enabled: true, state: 'ready' },
      // Off says nothing more: Paseo doesn't check a switched-off agent.
      { id: 'codex', label: 'Codex', enabled: false, state: 'off' },
      { id: 'opencode', label: 'OpenCode', enabled: true, state: 'unavailable', detail: 'opencode not found on PATH' },
    ]);
  });

  it('counts a provider without the flag as on, and an unknown status as an error', () => {
    expect(cloudAgentList([{ provider: 'codex', status: 'ready' }])).toEqual([
      { id: 'codex', label: 'Codex', enabled: true, state: 'ready' },
    ]);
    expect(cloudAgentList([{ provider: 'claude', status: 'mystery' }])[0]).toMatchObject({ state: 'error' });
    expect(cloudAgentList([])).toEqual([]);
  });
});

// ---- the adapter: switching in Paseo's own config -------------------------------------

function fakeDaemon() {
  const enabled: Record<string, boolean> = { claude: true, codex: true, opencode: true, pi: true };
  const patches: unknown[] = [];
  const refreshed: unknown[] = [];
  const state = { failPatch: false, failRefresh: false };
  let statusListener: ((s: { status: string }) => void) | undefined;
  const client = {
    subscribeConnectionStatus: (l: (s: { status: string }) => void) => {
      statusListener = l;
      return () => {};
    },
    on: () => () => {},
    observeEvents: () => ({
      ready: Promise.resolve({ subscriptionId: 'fake-events' }),
      subscribe: () => () => {},
      release: async () => {},
    }),
    connect: async () => statusListener?.({ status: 'connected' }),
    close: async () => {},
    fetchAgents: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
    observeAgents: () => ({
      ready: client.fetchAgents().then((page) => ({ ...page, subscriptionId: 'fake-agents' })),
      subscribe: () => () => {},
      release: async () => {},
    }),
    getLastServerInfoMessage: () => null,
    getProvidersSnapshot: async () => ({
      requestId: 'p',
      entries: Object.entries(enabled).map(([provider, on]) => ({
        provider,
        enabled: on,
        status: on ? 'ready' : 'unavailable',
      })),
    }),
    patchDaemonConfig: async (patch: { providers: Record<string, { enabled: boolean }> }) => {
      if (state.failPatch) throw new Error('config is read-only');
      patches.push(patch);
      for (const [provider, change] of Object.entries(patch.providers)) enabled[provider] = change.enabled;
      return { requestId: 'c', config: {} };
    },
    refreshProvidersSnapshot: async (options: { providers: string[] }) => {
      if (state.failRefresh) throw new Error('timed out');
      refreshed.push(options.providers);
      return { requestId: 'r' };
    },
  };
  return { client, patches, refreshed, state };
}

async function connected() {
  const daemon = fakeDaemon();
  const adapter = new PaseoAdapter('ws://127.0.0.1:19007', new EventHub(), quietLog, 'cid_test', () => daemon.client as never, new BackgroundGate('primary'));
  adapter.useConfigWriter({ setCloudAgentEnabled: async (id, enabled) => { await daemon.client.patchDaemonConfig({ providers: { [id]: { enabled } } }); } });
  adapter.start();
  await expect.poll(() => adapter.status().state).toBe('connected');
  return { adapter, daemon };
}

describe('PaseoAdapter: cloud agents', () => {
  it('refuses an uncoordinated config patch when the owner helper is unavailable', async () => {
    const { adapter, daemon } = await connected();
    adapter.useConfigWriter(undefined);
    await expect(adapter.setCloudAgentEnabled('codex', false)).rejects.toMatchObject({ status: 424 });
    expect(daemon.patches).toEqual([]);
    expect(daemon.refreshed).toEqual([]);
  });

  it('preserves the unavailable-helper response and does not patch or refresh the daemon', async () => {
    const { adapter, daemon } = await connected();
    adapter.useConfigWriter({ setCloudAgentEnabled: async () => { throw new UserFacingError('Demo helper unavailable.', 424); } });
    await expect(adapter.setCloudAgentEnabled('codex', false)).rejects.toMatchObject({ status: 424 });
    expect(daemon.patches).toEqual([]);
    expect(daemon.refreshed).toEqual([]);
  });

  it('reports each cloud agent as Paseo has it', async () => {
    const { adapter } = await connected();
    const { agents } = await adapter.cloudAgents();
    expect(agents.map((a) => [a.id, a.state])).toEqual([
      ['claude', 'ready'],
      ['codex', 'ready'],
      ['opencode', 'ready'],
    ]);
  });

  it("switches an agent in Paseo's config, re-checks it and answers with the new state", async () => {
    const { adapter, daemon } = await connected();
    const off = await adapter.setCloudAgentEnabled('codex', false);
    expect(daemon.patches).toEqual([{ providers: { codex: { enabled: false } } }]);
    expect(daemon.refreshed).toEqual([['codex']]);
    expect(off.agents.find((a) => a.id === 'codex')).toMatchObject({ enabled: false, state: 'off' });

    const on = await adapter.setCloudAgentEnabled('codex', true);
    expect(daemon.patches.at(-1)).toEqual({ providers: { codex: { enabled: true } } });
    expect(on.agents.find((a) => a.id === 'codex')).toMatchObject({ enabled: true, state: 'ready' });
  });

  it("says why when Paseo won't take the change, and doesn't re-check", async () => {
    const { adapter, daemon } = await connected();
    daemon.state.failPatch = true;
    const attempt = adapter.setCloudAgentEnabled('claude', false);
    await expect(attempt).rejects.toBeInstanceOf(UserFacingError);
    await expect(attempt).rejects.toThrow('Paseo: config is read-only');
    expect(daemon.refreshed).toEqual([]);
  });

  it('still answers when only the re-check fails: the switch itself went through', async () => {
    const { adapter, daemon } = await connected();
    daemon.state.failRefresh = true;
    const { agents } = await adapter.setCloudAgentEnabled('opencode', false);
    expect(agents.find((a) => a.id === 'opencode')).toMatchObject({ enabled: false, state: 'off' });
  });
});

// ---- the app's routes ---------------------------------------------------------------------

describe('app: /api/cloud-agents', () => {
  let keys: Keys;
  let token: string;
  beforeAll(async () => {
    keys = await makeKeys();
    token = await makeToken(keys);
  });

  const put = (app: Awaited<ReturnType<typeof makeApp>>['app'], id: string, body: unknown, headers = postHeaders(token)) =>
    app.inject({ method: 'PUT', url: `/api/cloud-agents/${id}`, headers, payload: JSON.stringify(body) });

  it('lists the cloud agents', async () => {
    const { app } = await makeApp(keys);
    const res = await app.inject({ url: '/api/cloud-agents', headers: apiHeaders(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().agents.map((a: { id: string }) => a.id)).toEqual(['claude', 'codex']);
    await app.close();
  });

  it('switches one off and answers with the new list', async () => {
    const { app, paseo } = await makeApp(keys);
    const res = await put(app, 'codex', { enabled: false });
    expect(res.statusCode).toBe(200);
    expect(paseo.calls).toContain('cloud:codex:false');
    expect(res.json().agents.find((a: { id: string }) => a.id === 'codex')).toMatchObject({ enabled: false, state: 'off' });
    await app.close();
  });

  it('only switches cloud agents, and only with a plain on/off', async () => {
    const { app, paseo } = await makeApp(keys);
    expect((await put(app, 'pi', { enabled: false })).statusCode).toBe(400);
    expect((await put(app, 'hermes', { enabled: false })).statusCode).toBe(400);
    expect((await put(app, 'codex', { enabled: 'no' })).statusCode).toBe(400);
    expect((await put(app, 'codex', { enabled: false, everyone: true })).statusCode).toBe(400);
    expect(paseo.calls.filter((c) => c.startsWith('cloud:'))).toEqual([]);
    await app.close();
  });

  it('holds the switch to the same sign-in and cross-site rules as every other change', async () => {
    const { app, paseo } = await makeApp(keys);
    const host = new URL(ORIGIN).host;
    // No Access token.
    expect((await put(app, 'codex', { enabled: false }, { host, origin: ORIGIN, 'content-type': 'application/json' })).statusCode).toBe(401);
    // Signed in, but not from our own page (no request marker, another origin).
    const crossSite = { ...postHeaders(token), origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
    delete (crossSite as Record<string, string>)['x-wayroost-request'];
    expect((await put(app, 'codex', { enabled: false }, crossSite)).statusCode).toBe(403);
    expect(paseo.calls.filter((c) => c.startsWith('cloud:'))).toEqual([]);
    await app.close();
  });

  it("is a 404 where the backend can't switch agents", async () => {
    const { app, paseo } = await makeApp(keys);
    Object.assign(paseo, { cloudAgents: undefined, setCloudAgentEnabled: undefined });
    expect((await app.inject({ url: '/api/cloud-agents', headers: apiHeaders(token) })).statusCode).toBe(404);
    expect((await put(app, 'codex', { enabled: false })).statusCode).toBe(404);
    await app.close();
  });
});
