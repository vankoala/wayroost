import { isSettingsPolicyRoute } from '../../shared/settings-levels.js';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeRoutes, LIVE_DEVICE_EXEMPT } from '../src/app.js';
import { FakeSupervisor } from './fake-supervisor.js';
import { HermesAdapter } from '../src/hermes/adapter.js';
import { HermesAuth } from '../src/hermes/auth.js';
import { PaseoAdapter } from '../src/paseo/adapter.js';
import { DESKTOP_COOKIE, PHONE_COOKIE, TEST_DESKTOP, TEST_PHONE, makeApp, makeKeys, makeToken, postHeaders } from './helpers.js';

// Every change re-checks its device against the live store right before the handler, after the
// body has arrived: a device revoked while its request was still uploading changes nothing.

const REFUSED = { error: 'Pair this device before controlling the PC.' };
const refusalFor = (url: string) => isSettingsPolicyRoute(url) && url !== '/api/settings/hermes' && url !== '/api/feed/settings'
  ? { status: 'refused', code: 'not_permitted' } : REFUSED;
const apps: Array<Awaited<ReturnType<typeof makeApp>>['app']> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
});

async function setup() {
  const keys = await makeKeys();
  const token = await makeToken(keys);
  const supervisor = new FakeSupervisor();
  const workerUpdates = { status: () => ({ enabled: true, defaultMinutes: 60, timeBoxes: [60] }),
    update: vi.fn(() => ({ enabled: false, defaultMinutes: 60, timeBoxes: [60] })) };
  const ctx = await makeApp(keys, { supervisor, workerUpdates });
  apps.push(ctx.app);
  return { ...ctx, token, supervisor, workerUpdates };
}

describe('pairing at the mutation', () => {
  it.each(['token', '401 retry'])('rechecks pairing after Hermes %s awaits before sending an archive', async stage => {
    const ctx = await setup();
    const auth = new HermesAuth('http://127.0.0.1:8890', () => null);
    let tokens = 0;
    vi.spyOn(auth, 'token').mockImplementation(async () => {
      await Promise.resolve(); tokens += 1;
      if (stage === 'token' || tokens === 2) ctx.devices!.revoke(TEST_DESKTOP.id);
      return 'obviously-fake-token';
    });
    const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: stage === 'token' ? 200 : 401 }));
    const backend = { auth, patchSession: HermesAdapter.prototype['patchSession'], dropFromList: vi.fn() };
    vi.spyOn(ctx.hermes, 'archiveThreads').mockImplementation((...args) =>
      HermesAdapter.prototype.archiveThreads.call(backend as never, ...args));
    const res = await ctx.app.inject({ method: 'POST', url: '/api/threads/archive', headers: postHeaders(ctx.token),
      payload: { threads: [{ source: 'hermes', id: 'demo-chat' }] } });
    expect(res.statusCode).toBe(403); expect(res.json()).toEqual(REFUSED);
    expect(send).toHaveBeenCalledTimes(stage === 'token' ? 0 : 1);
  });

  it.each(['archive', 'restore', 'delete'] as const)('stops the real Paseo %s loop after its first mutation revokes pairing', async action => {
    const ctx = await setup();
    const mutation = vi.fn(async () => { await Promise.resolve(); ctx.devices!.revoke(TEST_DESKTOP.id); });
    const backend = { requireClient: () => ({ archiveAgent: mutation, refreshAgent: mutation, deleteAgent: mutation,
      fetchAgent: async () => null }), childrenFirst: (ids: string[]) => [...ids].reverse(), forgetAgent: vi.fn() };
    const method = action === 'archive' ? 'archiveThreads' : action === 'restore' ? 'restoreThreads' : 'deleteThreads';
    vi.spyOn(ctx.paseo, method).mockImplementation((...args) => PaseoAdapter.prototype[method].call(backend as never, ...args));
    const res = await ctx.app.inject({ method: 'POST', url: `/api/threads/${action}`, headers: postHeaders(ctx.token),
      payload: { threads: [{ source: 'paseo', id: 'demo-parent' }, { source: 'paseo', id: 'demo-child' }] } });
    expect(res.statusCode).toBe(403); expect(res.json()).toEqual(REFUSED);
    expect(mutation).toHaveBeenCalledOnce();
    expect(mutation).toHaveBeenCalledWith(action === 'restore' ? 'demo-parent' : 'demo-child');
  });

  it.each(['archive', 'restore', 'delete'] as const)('stops the real Hermes %s loop after its first mutation revokes pairing', async action => {
    const ctx = await setup();
    const patch = vi.fn(async () => { await Promise.resolve(); ctx.devices!.revoke(TEST_DESKTOP.id); });
    const remove = vi.fn(async () => {});
    const backend = { patchSession: patch, auth: { json: remove }, lineageOf: async () => [], dropFromList: vi.fn(),
      tidied: new Set<string>(), scheduleListRefresh: vi.fn() };
    vi.spyOn(ctx.hermes, 'archiveThreads').mockImplementation((ids, folder, signal?: AbortSignal) =>
      HermesAdapter.prototype.archiveThreads.call(backend as never, ids, folder, signal));
    vi.spyOn(ctx.hermes, 'restoreThreads').mockImplementation((ids, signal?: AbortSignal) =>
      HermesAdapter.prototype.restoreThreads.call(backend as never, ids, signal));
    vi.spyOn(ctx.hermes, 'deleteThreads').mockImplementation((ids, signal?: AbortSignal) =>
      HermesAdapter.prototype.deleteThreads.call(backend as never, ids, signal));
    const res = await ctx.app.inject({ method: 'POST', url: `/api/threads/${action}`, headers: postHeaders(ctx.token),
      payload: { threads: [{ source: 'hermes', id: 'demo-first-chat' }, { source: 'hermes', id: 'demo-next-chat' }] } });
    expect(res.statusCode).toBe(403); expect(res.json()).toEqual(REFUSED);
    expect(patch).toHaveBeenCalledOnce(); expect(remove).not.toHaveBeenCalled();
  });

  it.each(['lineage', 'archive', 'delete', 'folder'] as const)('rechecks pairing after awaited Hermes %s work before the next mutation', async stage => {
    const ctx = await setup();
    const revoke = async () => { await Promise.resolve(); ctx.devices!.revoke(TEST_DESKTOP.id); };
    const patch = vi.fn(async () => { if (stage === 'archive') await revoke(); });
    const remove = vi.fn(async () => { if (stage === 'delete') await revoke(); });
    const backend = { patchSession: patch, auth: { json: remove }, dropFromList: vi.fn(),
      lineageOf: async () => { if (stage === 'lineage') await revoke(); return ['demo-lineage-root']; },
      chatsIn: async () => { await revoke(); return ['demo-older-chat']; } };
    if (stage === 'folder') vi.spyOn(ctx.hermes, 'archiveThreads').mockImplementation((...args) =>
      HermesAdapter.prototype.archiveThreads.call(backend as never, ...args));
    else vi.spyOn(ctx.hermes, 'deleteThreads').mockImplementation((...args) =>
      HermesAdapter.prototype.deleteThreads.call(backend as never, ...args));
    const res = await ctx.app.inject({ method: 'POST', url: `/api/threads/${stage === 'folder' ? 'archive' : 'delete'}`, headers: postHeaders(ctx.token),
      payload: stage === 'folder' ? { threads: [], folder: { path: '/home/me/demo', paseoRoots: [] } }
        : { threads: [{ source: 'hermes', id: 'demo-chat' }] } });
    expect(res.statusCode).toBe(403); expect(res.json()).toEqual(REFUSED);
    expect(patch).toHaveBeenCalledTimes(stage === 'lineage' || stage === 'folder' ? 0 : 1);
    expect(remove).toHaveBeenCalledTimes(stage === 'delete' ? 1 : 0);
  });

  it.each([
    { url: '/api/cloud-agents/codex', body: { enabled: false } },
    { url: '/api/worker-updates', body: { enabled: false } },
  ])('rechecks $url after asynchronous hooks', async ({ url, body }) => {
    const ctx = await setup();
    const cloud = vi.spyOn(ctx.paseo, 'setCloudAgentEnabled');
    ctx.app.addHook('preHandler', async () => { await Promise.resolve(); ctx.devices!.revoke(TEST_DESKTOP.id); });
    const res = await ctx.app.inject({ method: 'PUT', url, headers: postHeaders(ctx.token), payload: body });
    expect(res.statusCode).toBe(403); expect(res.json()).toEqual(refusalFor(url));
    expect(cloud).not.toHaveBeenCalled(); expect(ctx.workerUpdates.update).not.toHaveBeenCalled();
  });

  it('does not archive after pairing is revoked during the cleanup read', async () => {
    const ctx = await setup();
    const archive = vi.spyOn(ctx.hermes, 'archiveThreads');
    vi.spyOn(ctx.hermes, 'idleThreads').mockImplementation(async () => {
      await Promise.resolve(); ctx.devices!.revoke(TEST_DESKTOP.id); return ['demo-idle-chat'];
    });
    const res = await ctx.app.inject({ method: 'POST', url: '/api/cleanup', headers: postHeaders(ctx.token), payload: { idleDays: 14 } });
    expect(res.statusCode).toBe(403); expect(res.json()).toEqual(REFUSED);
    expect(archive).not.toHaveBeenCalled(); expect(ctx.paseo.tidying.calls).toEqual([]);
  });

  it.each(['archive', 'restore', 'delete'] as const)('stops a batched %s before the next backend after revocation', async action => {
    const ctx = await setup();
    const method = action === 'archive' ? 'archiveThreads' : action === 'restore' ? 'restoreThreads' : 'deleteThreads';
    const first = vi.spyOn(ctx.hermes, method).mockImplementation(async () => {
      await Promise.resolve(); ctx.devices!.revoke(TEST_DESKTOP.id); return { done: 1, failed: [] };
    });
    const next = vi.spyOn(ctx.paseo, method);
    const res = await ctx.app.inject({ method: 'POST', url: `/api/threads/${action}`, headers: postHeaders(ctx.token),
      payload: { threads: [{ source: 'hermes', id: 'demo-chat' }, { source: 'paseo', id: 'demo-agent' }] } });
    expect(res.statusCode).toBe(403); expect(res.json()).toEqual(REFUSED);
    expect(first).toHaveBeenCalledOnce(); expect(next).not.toHaveBeenCalled();
  });
});

describe('a device revoked while its body is pending', () => {
  const changes = [
    { what: 'an approval answer', method: 'POST', url: '/api/conversations/hermes/demo-chat/approvals/demo-approval', body: { optionId: 'once' } },
    { what: 'a message', method: 'POST', url: '/api/conversations/hermes/demo-chat/messages', body: { text: 'Demo message.' } },
    { what: 'an interrupt', method: 'POST', url: '/api/conversations/paseo/demo-agent/interrupt', body: {} },
    { what: 'a new folder', method: 'POST', url: '/api/folders', body: { path: '/home/me/demo-folder' } },
    { what: 'a settings write', method: 'PUT', url: '/api/settings/hermes', body: { username: 'demo-user', password: 'obviously-fake-password' } },
    { what: 'a power action', method: 'POST', url: '/api/power/actions', body: { verb: 'restart', target: 'paseo', when: 'now' } },
  ] as const;

  it.each(changes.flatMap((change) => (['desktop', 'phone'] as const).map((kind) => ({ ...change, kind }))))(
    'refuses $what from a revoked $kind', async ({ method, url, body, kind }) => {
      const ctx = await setup();
      const device = kind === 'desktop' ? TEST_DESKTOP : TEST_PHONE;
      const effects = [
        vi.spyOn(ctx.hermes, 'respondToApproval'), vi.spyOn(ctx.hermes, 'sendMessage'), vi.spyOn(ctx.paseo, 'interrupt'),
        vi.spyOn(ctx.paseo, 'createFolder'), vi.spyOn(ctx.hermes, 'setCredentials'),
      ];
      let signedIn!: (id: string | undefined) => void;
      const authenticated = new Promise<string | undefined>((resolve) => { signedIn = resolve; });
      const authenticate = ctx.devices!.authenticate.bind(ctx.devices);
      vi.spyOn(ctx.devices!, 'authenticate').mockImplementation((values) => {
        const result = authenticate(values);
        signedIn(result?.device.id);
        return result;
      });
      const payload = new PassThrough();
      const response = ctx.app.inject({ method, url, headers: postHeaders(ctx.token, { cookie: kind === 'desktop' ? DESKTOP_COOKIE : PHONE_COOKIE }), payload });
      try {
        expect(await authenticated).toBe(device.id);
        expect(ctx.devices!.revoke(device.id)).toBe(true);
      } finally {
        payload.end(JSON.stringify(body));
      }
      const res = await response;
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(REFUSED);
      for (const effect of effects) expect(effect).not.toHaveBeenCalled();
      expect(ctx.supervisor.acted).toEqual([]);
    },
  );
});

describe('the live device check covers every change', () => {
  it('exempts only redeeming a pairing code', async () => {
    const ctx = await setup();
    // Recovery runs over the pairing socket (pairing-socket.ts), not through this app.
    expect(LIVE_DEVICE_EXEMPT).toEqual(['POST /api/pair']);
    for (const route of LIVE_DEVICE_EXEMPT) expect(changeRoutes(ctx.app)).toContain(route);
  });

  it('refuses every other mutating route once the store no longer knows the device', async () => {
    const ctx = await setup();
    const routes = changeRoutes(ctx.app).filter((route) => !LIVE_DEVICE_EXEMPT.includes(route));
    // The route table, not a hand-kept list: a route added later is held to the check too.
    expect(routes.length).toBeGreaterThan(40);
    expect(routes).toEqual(expect.arrayContaining(['POST /api/conversations/:source/:id/messages', 'PUT /api/worker-approvals', 'POST /api/power/actions', 'DELETE /api/devices/:id']));
    // Signed in when the request arrived; gone from the live store by the time its body is parsed.
    vi.spyOn(ctx.devices!, 'get').mockReturnValue(undefined);
    for (const route of routes) {
      const [method, path] = route.split(' ') as [string, string];
      const url = path.replace(/:source/g, 'hermes').replace(/:[A-Za-z]+/g, 'demo-id').replace(/\*$/, 'demo');
      const res = await ctx.app.inject({ method: method as 'POST', url, headers: postHeaders(ctx.token), payload: '{}' });
      expect({ route, status: res.statusCode, body: res.json() }).toEqual({ route, status: 403, body: refusalFor(url) });
    }
  });

  it('rechecks every mutating handler after later hooks revoke the device', async () => {
    const ctx = await setup();
    ctx.app.addHook('preHandler', async () => {
      await Promise.resolve(); vi.spyOn(ctx.devices!, 'get').mockReturnValue(undefined);
    });
    for (const route of changeRoutes(ctx.app).filter(route => !LIVE_DEVICE_EXEMPT.includes(route))) {
      const [method, path] = route.split(' ') as [string, string];
      const url = path.replace(/:source/g, 'hermes').replace(/:[A-Za-z]+/g, 'demo-id').replace(/\*$/, 'demo');
      const res = await ctx.app.inject({ method: method as 'POST', url, headers: postHeaders(ctx.token), payload: '{}' });
      expect({ route, status: res.statusCode, body: res.json() }).toEqual({ route, status: 403, body: refusalFor(url) });
      vi.restoreAllMocks();
    }
  });
});
