import { MaintenanceHold } from '../src/bridge/maintenance.js';
import { Devices } from '../src/devices.js';
import { BackgroundGate } from '../src/background.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { ServerEvent } from '../../shared/protocol.js';
import { buildApp } from '../src/app.js';
import { HermesAdapter } from '../src/hermes/adapter.js';
import { HermesAuth, HermesAuthError } from '../src/hermes/auth.js';
import { HermesGateway, RpcError } from '../src/hermes/gateway.js';
import { EventHub } from '../src/hub.js';
import { createAccessVerifier } from '../src/security/access.js';
import { deviceSignal, withDeviceSignal } from '../src/security/device-signal.js';
import { SecretStore } from '../src/secrets.js';
import { FakeHermes } from './fake-hermes.js';
import { FakePaseo, ORIGIN, makeConfig, makeKeys, makeToken, postHeaders, TEST_DESKTOP, PHONE_COOKIE, type Keys } from './helpers.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// Exercise the authenticated routes, real adapter/cache and fake backend data,
// without starting any service or binding a socket.
describe('move a Hermes chat to an existing folder', () => {
  let keys: Keys;
  let token: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let fake: FakeHermes;
  let hermes: HermesAdapter;
  let paseo: FakePaseo;
  let events: ServerEvent[];
  let clients: string[][];
  let hold: MaintenanceHold;
  let devices: Devices;
  let secretsDir: string;
  let logs: string[];
  const target = '/home/me/research/new';
  const original = '/home/me/research/old';
  const NOW = 1_790_490_000_000;
  const id = FakeHermes.stored;
  beforeAll(async () => { keys = await makeKeys(); token = await makeToken(keys); });
  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    fake = new FakeHermes();
    fake.topLevel[0]!.cwd = original;
    fake.topLevel.push({ id: 'other-chat', source: 'desktop', title: 'Invented unfiled chat', message_count: 2, last_active: 1_790_490_000 });
    fake.subagentRuns = [{ id: 'delegate-run', source: 'desktop', parent_session_id: id, ended_at: 1_790_490_000, message_count: 2 }];
    const hub = new EventHub();
    events = [];
    logs = [];
    hub.observe((e) => events.push(e));
    clients = [[], []];
    for (const received of clients) hub.add({ readyState: 1, bufferedAmount: 0,
      send: (data: string) => received.push(data) } as unknown as WebSocket, 'invented@example.test');
    vi.spyOn(HermesAuth.prototype, 'json').mockImplementation(async (path, init) => {
      const url = new URL(path, 'http://fake.invalid');
      const one = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
      if (one) {
        const stored = decodeURIComponent(one[1]!);
        if (init?.method === 'PATCH') {
          fake.archived.add(stored);
          return {} as never;
        }
        if (init?.method === 'DELETE') {
          fake.topLevel = fake.topLevel.filter((r) => r.id !== stored);
          return {} as never;
        }
        const row = fake.details[stored] ?? fake.topLevel.find((r) => r.id === stored) ??
          fake.subagentRuns.find((r) => r.id === stored);
        if (!row) throw new HermesAuthError('Hermes request failed (404).', 'unavailable', 404);
        return structuredClone({ ...row, archived: fake.archived.has(stored),
          ...(fake.subagentRuns.includes(row) ? { model_config: { _delegate_from: id } } : {}) }) as never;
      }
      if (url.pathname === '/api/sessions') {
        const query = Object.fromEntries(url.searchParams);
        fake.listQueries.push(query);
        return structuredClone(fake.sessionList(query)) as never;
      }
      if (url.pathname === '/api/chat/workspaces') return { default_cwd: '/home/me' } as never;
      if (url.pathname === '/api/config/defaults') return { sessions: { show_subagents: false } } as never;
      throw new Error(`Unexpected fake HTTP request: ${path}`);
    });
    vi.spyOn(HermesGateway.prototype, 'call').mockImplementation(async (method, params) => {
      fake.calls.push({ method, params: params ?? {} });
      if (method === 'session.active_list') return { sessions: fake.live ? [{ session_key: fake.sessionKey, status: fake.status() }] : [] } as never;
      if (method === 'session.workspace.move') return fake.moveWorkspace(params ?? {}) as never;
      throw new Error(`Unexpected fake RPC: ${method}`);
    });
    secretsDir = mkdtempSync(join(tmpdir(), 'wayroost-move-'));
    hermes = new HermesAdapter('http://fake.invalid', hub,
      new SecretStore(secretsDir), { info() {}, warn() {}, error() {} }, { background: new BackgroundGate('shadow') });
    hermes['gateway'].state = 'ready';
    await hermes.listConversations();
    paseo = new FakePaseo();
    paseo.folders.add(target);
    const config = makeConfig(undefined, { rollout: { settingsPages: false, revokes: false, chatFirst: false } });
    hold = new MaintenanceHold(config.stateDir, () => 1_790_490_000_000);
    devices = new Devices(config.stateDir);
    app = await buildApp({ config, hub, devices,
      bridge: { maintenanceHold: () => hold, status: () => ({ enabled: false, paused: false, recent: { sent: 0, queued: 0, started: 0 } }), setPaused: (paused) => ({ enabled: false, paused, recent: { sent: 0, queued: 0, started: 0 } }) }, sources: { hermes, paseo }, logger: { level: 'info', stream: { write: (line: string) => { logs.push(line); } } },
      verifier: createAccessVerifier({ ...config.access!, keySource: keys.keySource }) });
    events.length = 0;
    clients.forEach((received) => { received.length = 0; });
  });
  afterEach(async () => { hermes.stop(); await app.close(); vi.useRealTimers(); vi.restoreAllMocks(); rmSync(secretsDir, { recursive: true, force: true }); });
  const post = (cwd = target, source = 'hermes', threadId = id, headers = postHeaders(token)) =>
    app.inject({ method: 'POST', url: '/api/threads/move', headers, payload: { thread: { source, id: threadId }, cwd } });
  const expectFolderEverywhere = async (cwd: string) => {
    expect(fake.topLevel.find((r) => r.id === id)?.cwd).toBe(cwd);
    expect((await hermes.listConversations()).find((c) => c.id === id)?.project?.path).toBe(cwd);
    for (const received of clients) {
      const summaries = (received.map((frame) => JSON.parse(frame)) as ServerEvent[])
        .filter((e) => e.type === 'conversation_upsert' && e.conversation.id === id);
      expect(summaries.at(-1)).toMatchObject({ conversation: { project: { path: cwd } } });
    }
  };

  it.each(['revision changed', 'native error', 'native timeout'])('reconciles stored changes after the move reply is discarded: %s', async (exit) => {
    const before = fake.listQueries.length;
    const call = vi.mocked(HermesGateway.prototype.call).getMockImplementation()!;
    vi.mocked(HermesGateway.prototype.call).mockImplementation(async (method, ...args) => {
      const result = await call(method, ...args);
      if (method === 'session.workspace.move') {
        if (exit === 'revision changed') hermes['invalidateList']();
        else throw new RpcError(exit === 'native timeout' ? -2 : -32603, 'Invented native move failure');
      }
      return result;
    });
    const res = await post();
    expect(res.statusCode).toBe(exit === 'revision changed' ? 404 : 424);
    expect(fake.listQueries.length).toBeGreaterThan(before);
    await expectFolderEverywhere(target);
  });

  it('reconciles when the native request times out after storing the new folder', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const sent = deferred<void>();
    const call = vi.mocked(HermesGateway.prototype.call).getMockImplementation()!;
    vi.mocked(HermesGateway.prototype.call).mockImplementation(async (method, params, timeout, ...args) => {
      const result = await call(method, params, timeout, ...args);
      if (method === 'session.workspace.move') {
        sent.resolve();
        return await new Promise<never>((_, reject) => {
          setTimeout(() => reject(new RpcError(-2, 'Invented native timeout')), timeout);
        });
      }
      return result;
    });
    let outcome: unknown;
    const moving = hermes.moveToFolder(id, target).catch((error: unknown) => { outcome = error; });
    await sent.promise;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await moving;
    expect(outcome).toMatchObject({ code: -2 });
    await expectFolderEverywhere(target);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('retries incomplete one-shot reconciliation after a stored move (retry fails: %s)', async (retryFails) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fake.topLevel.push({ id: 'ended-run', source: 'oneshot', cwd: original,
      ended_at: NOW / 1000 - 60, last_active: NOW / 1000 - 60, message_count: 2 });
    hermes['invalidateList']();
    await hermes.listConversations();
    const json = vi.mocked(HermesAuth.prototype.json).getMockImplementation()!;
    let failures = 0;
    vi.mocked(HermesAuth.prototype.json).mockImplementation(async (path, ...args) => {
      if (fake.workspaceMoves.length && new URL(path, 'http://fake.invalid').searchParams.get('source') === 'oneshot' &&
          (retryFails || failures === 0)) {
        failures++;
        throw new HermesAuthError('Invented rate limit', 'unavailable', 429);
      }
      return json(path, ...args);
    });
    const call = vi.mocked(HermesGateway.prototype.call).getMockImplementation()!;
    vi.mocked(HermesGateway.prototype.call).mockImplementation(async (method, ...args) => {
      const result = await call(method, ...args);
      if (method === 'session.workspace.move') throw new RpcError(-2, 'Invented native timeout');
      return result;
    });
    await expect(hermes.moveToFolder('ended-run', target)).rejects.toMatchObject({ code: -2 });
    expect(fake.topLevel.find(r => r.id === 'ended-run')?.cwd).toBe(target);
    expect(hermes['summaryFor']('ended-run').project?.path).toBe(original);
    expect(failures).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    if (retryFails) {
      for (let refresh = 0; refresh < 2; refresh++) {
        await hermes['reconcileMove']();
        expect(vi.getTimerCount()).toBe(1);
      }
      expect(failures).toBe(3);
    }
    await vi.advanceTimersByTimeAsync(800);
    if (!retryFails) {
      expect((await hermes.listConversations()).find(c => c.id === 'ended-run')?.project?.path).toBe(target);
      expect(events).toContainEqual(expect.objectContaining({ type: 'conversation_upsert',
        conversation: expect.objectContaining({ id: 'ended-run', project: expect.objectContaining({ path: target }) }) }));
    } else expect(failures).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('preserves complete reconciliation when an ordinary refresh coalesces (retry fails: %s)', async (retryFails) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fake.topLevel.push({ id: 'ended-run', source: 'oneshot', cwd: original,
      ended_at: NOW / 1000 - 60, last_active: NOW / 1000 - 60, message_count: 2 });
    hermes['invalidateList']();
    await hermes.listConversations();
    const json = vi.mocked(HermesAuth.prototype.json).getMockImplementation()!;
    let failures = 0;
    vi.mocked(HermesAuth.prototype.json).mockImplementation(async (path, ...args) => {
      if (fake.workspaceMoves.length && new URL(path, 'http://fake.invalid').searchParams.get('source') === 'oneshot' &&
          (retryFails || failures === 0)) {
        failures++;
        throw new HermesAuthError('Invented rate limit', 'unavailable', 429);
      }
      return json(path, ...args);
    });
    const call = vi.mocked(HermesGateway.prototype.call).getMockImplementation()!;
    vi.mocked(HermesGateway.prototype.call).mockImplementation(async (method, ...args) => {
      const result = await call(method, ...args);
      if (method === 'session.workspace.move') throw new RpcError(-2, 'Invented native timeout');
      return result;
    });
    await expect(hermes.moveToFolder('ended-run', target)).rejects.toMatchObject({ code: -2 });
    expect(failures).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    const list = vi.spyOn(hermes, 'listConversations');
    await hermes.restoreThreads(['other-chat']);
    await hermes.restoreThreads(['other-chat']);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledExactlyOnceWith(true);
    expect(vi.getTimerCount()).toBe(0);
    if (retryFails) {
      expect(failures).toBe(2);
      expect(hermes['summaryFor']('ended-run').project?.path).toBe(original);
    } else {
      expect(hermes['summaryFor']('ended-run').project?.path).toBe(target);
      for (const received of clients) expect(received.map((frame) => JSON.parse(frame))).toContainEqual(
        expect.objectContaining({ type: 'conversation_upsert',
          conversation: expect.objectContaining({ id: 'ended-run', project: expect.objectContaining({ path: target }) }) }));
    }
    await hermes.restoreThreads(['other-chat']);
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenLastCalledWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps ordinary inbox reads tolerant of an unavailable one-shot listing', async () => {
    const json = vi.mocked(HermesAuth.prototype.json).getMockImplementation()!;
    vi.mocked(HermesAuth.prototype.json).mockImplementation(async (path, ...args) => {
      if (new URL(path, 'http://fake.invalid').searchParams.get('source') === 'oneshot') {
        throw new HermesAuthError('Invented rate limit', 'unavailable', 429);
      }
      return json(path, ...args);
    });
    hermes['invalidateList']();
    expect((await hermes.listConversations()).some(c => c.id === id)).toBe(true);
  });

  it('refuses an overlapping move of the same chat until reconciliation finishes, then permits another move', async () => {
    const native = deferred<void>();
    const releaseNative = deferred<void>();
    const refreshing = deferred<void>();
    const releaseRefresh = deferred<void>();
    const call = vi.mocked(HermesGateway.prototype.call).getMockImplementation()!;
    vi.mocked(HermesGateway.prototype.call).mockImplementation(async (method, ...args) => {
      if (method === 'session.workspace.move' && !fake.workspaceMoves.length) {
        native.resolve();
        await releaseNative.promise;
      }
      return call(method, ...args);
    });
    const json = vi.mocked(HermesAuth.prototype.json).getMockImplementation()!;
    vi.mocked(HermesAuth.prototype.json).mockImplementation(async (path, ...args) => {
      if (fake.workspaceMoves.length === 1 && new URL(path, 'http://fake.invalid').searchParams.get('limit') === '60') {
        refreshing.resolve();
        await releaseRefresh.promise;
      }
      return json(path, ...args);
    });
    const moving = hermes.moveToFolder(id, target);
    await native.promise;
    const overlap = await hermes.moveToFolder(id, original).catch((error: unknown) => error);
    releaseNative.resolve();
    await refreshing.promise;
    const duringRefresh = await hermes.moveToFolder(id, original).catch((error: unknown) => error);
    releaseRefresh.resolve();
    await moving;
    expect(overlap).toMatchObject({ status: 409 });
    expect(duringRefresh).toMatchObject({ status: 409 });
    expect(fake.workspaceMoves).toEqual([{ session_key: id, cwd: target }]);
    await expectFolderEverywhere(target);
    await hermes.moveToFolder(id, original);
    await expectFolderEverywhere(original);
  });

  it('does not block moves of different chats', async () => {
    const native = deferred<void>();
    const release = deferred<void>();
    const call = vi.mocked(HermesGateway.prototype.call).getMockImplementation()!;
    vi.mocked(HermesGateway.prototype.call).mockImplementation(async (method, params, ...args) => {
      if (method === 'session.workspace.move' && params?.session_key === id) {
        native.resolve();
        await release.promise;
      }
      return call(method, params, ...args);
    });
    const moving = hermes.moveToFolder(id, target).catch((error: unknown) => error);
    await native.promise;
    expect((await hermes.moveToFolder('other-chat', target)).project?.path).toBe(target);
    release.resolve();
    // The other chat's refresh invalidated this reply, but its stored move is still reconciled.
    expect(await moving).toMatchObject({ status: 404 });
    await expectFolderEverywhere(target);
  });

  it('reconciles independently of a device revoked after the native request was sent', async () => {
    const controller = new AbortController();
    const call = vi.mocked(HermesGateway.prototype.call).getMockImplementation()!;
    vi.mocked(HermesGateway.prototype.call).mockImplementation(async (method, ...args) => {
      const result = await call(method, ...args);
      if (method === 'session.workspace.move') {
        controller.abort();
        throw new Error('Invented cancelled native request');
      }
      return result;
    });
    const signals: Array<AbortSignal | undefined> = [];
    const json = vi.mocked(HermesAuth.prototype.json).getMockImplementation()!;
    vi.mocked(HermesAuth.prototype.json).mockImplementation(async (path, ...args) => {
      if (fake.workspaceMoves.length) signals.push(deviceSignal());
      return json(path, ...args);
    });
    await expect(withDeviceSignal(controller.signal, () => hermes.moveToFolder(id, target))).rejects.toThrow('Invented cancelled');
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal === undefined)).toBe(true);
    await expectFolderEverywhere(target);
  });

  it.each(['success', 'native timeout'])('bounds reconciliation after %s, retries a fresh list and releases the move guard', async (exit) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const refresh = deferred<void>();
    const late = deferred<{ sessions: typeof fake.topLevel }>();
    const json = vi.mocked(HermesAuth.prototype.json).getMockImplementation()!;
    vi.mocked(HermesAuth.prototype.json).mockImplementation(async (path, ...args) => {
      if (fake.workspaceMoves.length && new URL(path, 'http://fake.invalid').searchParams.get('limit') === '60') {
        refresh.resolve();
        return await late.promise as never;
      }
      return json(path, ...args);
    });
    const call = vi.mocked(HermesGateway.prototype.call).getMockImplementation()!;
    vi.mocked(HermesGateway.prototype.call).mockImplementation(async (method, ...args) => {
      const result = await call(method, ...args);
      if (method === 'session.workspace.move' && exit === 'native timeout') throw new RpcError(-2, 'Invented native timeout');
      return result;
    });
    let outcome: unknown;
    const moving = hermes.moveToFolder(id, target).then((value) => { outcome = value; }, (error: unknown) => { outcome = error; });
    await refresh.promise;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await moving;
    expect(outcome).toMatchObject(exit === 'success' ? { project: { path: target } } : { code: -2 });
    vi.mocked(HermesAuth.prototype.json).mockImplementation(json);
    await vi.advanceTimersByTimeAsync(800);
    await expectFolderEverywhere(target);
    late.resolve({ sessions: [{ ...fake.topLevel[0]!, cwd: original }] });
    await vi.advanceTimersByTimeAsync(0);
    await expectFolderEverywhere(target);
    vi.mocked(HermesGateway.prototype.call).mockImplementation(call);
    await hermes.moveToFolder(id, original);
    await expectFolderEverywhere(original);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('calls the native RPC by stored id, refreshes the listing, and broadcasts the new folder to every client', async () => {
    const before = fake.listQueries.length;
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation.project.path).toBe(target);
    expect(paseo.calls).toContain(`folder:${target}`);
    expect(fake.workspaceMoves).toEqual([{ session_key: id, cwd: target }]);
    expect(fake.listQueries.length).toBeGreaterThan(before);
    expect((await hermes.listConversations()).find((c) => c.id === id)?.project?.path).toBe(target);
    expect(events).toContainEqual(expect.objectContaining({ type: 'conversation_upsert', conversation: expect.objectContaining({ id, project: expect.objectContaining({ path: target }) }) }));
    for (const received of clients) {
      expect(received.map((frame) => JSON.parse(frame))).toContainEqual(expect.objectContaining({ type: 'conversation_upsert',
        conversation: expect.objectContaining({ id, project: expect.objectContaining({ path: target }) }) }));
    }
    expect(fake.calls.some((c) => c.method === 'session.resume')).toBe(false);
  });

  it('refuses a missing folder without creating anything', async () => {
    const res = await post('/home/me/missing');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('does not exist');
    expect(fake.workspaceMoves).toEqual([]);
    expect(paseo.calls.some((c) => c.startsWith('mkdir:'))).toBe(false);
  });

  it('moves a chat from Other chats into a folder', async () => {
    expect((await hermes.listConversations()).find((c) => c.id === 'other-chat')?.project).toBeUndefined();
    const res = await post(target, 'hermes', 'other-chat');
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation.project.path).toBe(target);
  });

  it('requires a confirmed folder check rather than trusting an unavailable Paseo', async () => {
    vi.spyOn(paseo, 'folderStatus').mockResolvedValue('unknown');
    const res = await post();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Connect Paseo');
    expect(fake.workspaceMoves).toEqual([]);
  });

  it('keeps a successful move visible if the listing refresh fails afterwards', async () => {
    const json = vi.mocked(HermesAuth.prototype.json).getMockImplementation()!;
    vi.mocked(HermesAuth.prototype.json).mockImplementation(async (path, ...args) => {
      if (fake.workspaceMoves.length && new URL(path, 'http://fake.invalid').pathname === '/api/sessions') {
        throw new Error('fake list temporarily unavailable');
      }
      return json(path, ...args);
    });
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation.project.path).toBe(target);
    expect(events).toContainEqual(expect.objectContaining({ type: 'conversation_upsert', conversation: expect.objectContaining({ id, project: expect.objectContaining({ path: target }) }) }));
  });

  it.each(['/', '/home', '/home/me', '/root', 'relative/path', '/home/me/a/../b', '/home/me/./a', '/home/me/a/', '/home//me/a', '/home/me/a\0b', '/home/me/a..b'])('rejects bare or noncanonical path %j', async (path) => {
    expect((await post(path)).statusCode).toBe(400);
    expect(fake.workspaceMoves).toEqual([]);
    expect(paseo.calls).toEqual([]);
  });

  it('rejects Paseo and unknown threads', async () => {
    expect((await post(target, 'paseo')).statusCode).toBe(400);
    expect((await post(target, 'hermes', 'unknown-chat')).statusCode).toBe(404);
    expect(fake.workspaceMoves).toEqual([]);
  });

  it.each(['acp', 'cron'])('rejects a fetched %s session rather than moving an embedded agent or scheduled run', async (source) => {
    fake.topLevel.push({ id: 'embedded-session', source, cwd: original });
    expect((await post(target, 'hermes', 'embedded-session')).statusCode).toBe(400);
    expect(fake.workspaceMoves).toEqual([]);
  });

  it('refuses sub-agent runs', async () => {
    expect((await hermes.listConversations()).find((c) => c.id === 'delegate-run')?.subagent).toBe(true);
    const res = await post(target, 'hermes', 'delegate-run');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('sub-agent');
    expect(fake.workspaceMoves).toEqual([]);
  });

  it('rechecks live status and refuses a running chat even when the UI thought it idle', async () => {
    fake.running = true;
    const res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('finishes working');
    expect(fake.workspaceMoves).toEqual([]);
    expect(fake.topLevel[0]!.cwd).toBe(original);
  });

  it('refuses a chat waiting for approval', async () => {
    fake.openRequests.push({ id: 'approval-1', method: 'approval', params: {} });
    expect((await post()).statusCode).toBe(409);
    expect(fake.workspaceMoves).toEqual([]);
  });

  it.each(['oneshot', 'tui'])('refuses a fresh active %s row after an idle row was cached', async (source) => {
    fake.live = false;
    Object.assign(fake.topLevel[0]!, { source, is_active: true, ended_at: null });
    expect(hermes['rows'].get(id)?.is_active).not.toBe(true);
    expect((await post()).statusCode).toBe(409);
    expect(fake.workspaceMoves).toEqual([]);
  });

  it('admits the fetched idle row even when the cached row still says active', async () => {
    fake.live = false;
    hermes['rows'].get(id)!.is_active = true;
    fake.topLevel[0]!.is_active = false;
    expect((await post()).statusCode).toBe(200);
    expect(fake.workspaceMoves).toEqual([{ session_key: id, cwd: target }]);
  });

  it.each([0, 100])('fetches a fresh activity row when detail omits the recent-write flag, at offset %s', async (offset) => {
    fake.live = false;
    fake.details[id] = { id, source: 'tui', cwd: original, last_active: NOW / 1000, ended_at: null };
    Object.assign(fake.topLevel[0]!, { source: 'tui', is_active: true, ended_at: null });
    fake.topLevel.unshift(...Array.from({ length: offset }, (_, i) => ({ id: `newer-${i}`, source: 'tui', message_count: 2 })));
    expect((await post()).statusCode).toBe(409);
    expect(fake.workspaceMoves).toEqual([]);
    expect(fake.listQueries).toContainEqual({ limit: '100', order: 'recent', archived: 'include', min_messages: '0', offset: String(offset), source: 'tui' });
  });

  it('refuses when detail omits stored activity and the fresh listing read fails', async () => {
    const json = vi.mocked(HermesAuth.prototype.json).getMockImplementation()!;
    vi.mocked(HermesAuth.prototype.json).mockImplementation(async (path, ...args) => {
      const url = new URL(path, 'http://fake.invalid');
      if (url.pathname === '/api/sessions' && url.searchParams.get('archived') === 'include') throw new Error('fake listing unavailable');
      return json(path, ...args);
    });
    expect((await post()).statusCode).toBe(503);
    expect(fake.workspaceMoves).toEqual([]);
  });

  it.each(['failed', 'absent', 'archived', 'wrong id', 'delegate'])('refuses a fresh row that is %s despite an idle cached chat', async (state) => {
    const json = vi.mocked(HermesAuth.prototype.json).getMockImplementation()!;
    vi.mocked(HermesAuth.prototype.json).mockImplementation(async (path, ...args) => {
      if (path === `/api/sessions/${id}`) {
        if (state === 'failed') throw new Error('fake fetch unavailable');
        if (state === 'absent') return null as never;
        return { ...fake.topLevel[0],
          ...(state === 'archived' ? { archived: true } : {}),
          ...(state === 'wrong id' ? { id: 'different-chat' } : {}),
          ...(state === 'delegate' ? { model_config: { _delegate_from: 'parent-chat' } } : {}) } as never;
      }
      return json(path, ...args);
    });
    const res = await post();
    expect(res.statusCode).toBe(state === 'failed' || state === 'wrong id' ? 503 : state === 'delegate' ? 400 : 404);
    expect(fake.workspaceMoves).toEqual([]);
  });

  it('fetches stored activity only after joining the poll and rejects activity that starts during the fetch', async () => {
    let release!: (value: unknown) => void;
    const call = vi.mocked(HermesGateway.prototype.call).getMockImplementation()!;
    vi.mocked(HermesGateway.prototype.call).mockImplementation(async (method, ...args) => {
      if (method === 'session.active_list') return await new Promise<unknown>((resolve) => { release = resolve; }) as never;
      return call(method, ...args);
    });
    const json = vi.mocked(HermesAuth.prototype.json);
    const fetch = json.getMockImplementation()!;
    json.mockImplementation(async (path, ...args) => {
      const row = await fetch(path, ...args);
      if (path === `/api/sessions/${id}`) hermes['noteActivity'](id);
      return row;
    });
    const moving = post();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(json.mock.calls.some(([path]) => path === `/api/sessions/${id}`)).toBe(false);
    release({ sessions: [] });
    expect((await moving).statusCode).toBe(503);
    expect(fake.workspaceMoves).toEqual([]);
  });

  it('joins a poll that supersedes the fresh fetch and fetches the row again before admitting', async () => {
    let release!: () => void;
    let reads = 0;
    const json = vi.mocked(HermesAuth.prototype.json).getMockImplementation()!;
    vi.mocked(HermesAuth.prototype.json).mockImplementation(async (path, ...args) => {
      const row = await json(path, ...args);
      if (path === `/api/sessions/${id}` && ++reads === 1) await new Promise<void>((resolve) => { release = resolve; });
      return row;
    });
    const moving = post();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    fake.live = false;
    fake.topLevel[0]!.is_active = true;
    await hermes['refreshActive']();
    release();
    expect((await moving).statusCode).toBe(409);
    expect(reads).toBe(2);
    expect(fake.workspaceMoves).toEqual([]);
  });

  it.each(['oneshot', 'dashboard', 'desktop', 'tui', 'telegram'])('refuses an externally owned %s run absent from dashboard activity', async (source) => {
    fake.live = false;
    const external = `external-${source}`;
    fake.topLevel.push({ id: external, source, cwd: original, message_count: 2,
      last_active: NOW / 1000 - 3 * 86400, is_active: true, ended_at: null });
    hermes['invalidateList']();
    await hermes.listConversations();
    const res = await post(target, 'hermes', external);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('chat is running');
    expect(fake.workspaceMoves).toEqual([]);
    expect(fake.calls.some((c) => c.method === 'session.resume')).toBe(false);
  });

  it.each([
    { is_active: false, ended_at: null },
    { is_active: false },
    { is_active: true, ended_at: 1_790_490_000 },
    { is_active: false, ended_at: -1 },
  ])('refuses a recent unfinished or ambiguous one-shot %j', async (fields) => {
    fake.live = false;
    fake.topLevel.push({ id: 'unfinished-chat', source: 'oneshot', cwd: original,
      message_count: 2, last_active: NOW / 1000 - 3600, ...fields });
    hermes['invalidateList']();
    await hermes.listConversations();
    const res = await post(target, 'hermes', 'unfinished-chat');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('chat is running');
    expect(fake.workspaceMoves).toEqual([]);
  });

  it.each(['dashboard', 'desktop', 'tui', 'telegram'])('moves an open idle %s chat without an end stamp', async (source) => {
    fake.live = false;
    fake.topLevel.push({ id: 'open-chat', source, cwd: original,
      message_count: 2, last_active: NOW / 1000 - 600, is_active: false });
    hermes['invalidateList']();
    await hermes.listConversations();
    expect((await post(target, 'hermes', 'open-chat')).statusCode).toBe(200);
    expect(fake.workspaceMoves).toEqual([{ session_key: 'open-chat', cwd: target }]);
    expect(fake.calls.some((c) => c.method === 'session.resume')).toBe(false);
  });

  it('moves a crashed three-day-old one-shot without an end stamp', async () => {
    fake.live = false;
    fake.topLevel.push({ id: 'crashed-run', source: 'oneshot', cwd: original,
      message_count: 2, started_at: NOW / 1000 - 4 * 86400,
      last_active: NOW / 1000 - 3 * 86400, ended_at: null, is_active: false });
    hermes['invalidateList']();
    expect((await hermes.listConversations()).find((c) => c.id === 'crashed-run')?.status).toBe('idle');
    expect((await post(target, 'hermes', 'crashed-run')).statusCode).toBe(200);
    expect(fake.workspaceMoves).toEqual([{ session_key: 'crashed-run', cwd: target }]);
  });

  it('moves an ended one-shot absent from dashboard activity', async () => {
    fake.live = false;
    fake.topLevel.push({ id: 'ended-run', source: 'oneshot', cwd: original,
      message_count: 2, ended_at: 1_790_490_000, is_active: false });
    hermes['invalidateList']();
    await hermes.listConversations();
    expect((await post(target, 'hermes', 'ended-run')).statusCode).toBe(200);
    expect(fake.workspaceMoves).toEqual([{ session_key: 'ended-run', cwd: target }]);
  });

  it.each(['working', 'waiting', 'unavailable', 'idle'])('joins a superseding activity poll before moving: %s', async (latest) => {
    const polls: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
    const call = vi.mocked(HermesGateway.prototype.call).getMockImplementation()!;
    vi.mocked(HermesGateway.prototype.call).mockImplementation(async (method, ...args) => {
      if (method === 'session.active_list') return await new Promise<unknown>((resolve, reject) => { polls.push({ resolve, reject }); }) as never;
      return call(method, ...args);
    });
    const moving = post();
    await vi.waitFor(() => expect(polls).toHaveLength(1));
    const background = hermes['refreshActive']();
    expect(polls).toHaveLength(2);
    polls[0]!.resolve({ sessions: [{ session_key: id, status: 'working' }] });
    await vi.waitFor(() => expect(hermes['activityPoll']!.result).toBe(background));
    // Drain the discarded response while the current activity read is pending.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const movesWhilePending = [...fake.workspaceMoves];
    if (latest === 'unavailable') polls[1]!.reject(new Error('offline'));
    else polls[1]!.resolve({ sessions: [{ session_key: id, status: latest }] });
    await background;
    const res = await moving;
    expect(movesWhilePending).toEqual([]);
    expect(res.statusCode).toBe(latest === 'idle' ? 200 : latest === 'unavailable' ? 503 : 409);
    expect(fake.workspaceMoves).toEqual(latest === 'idle' ? [{ session_key: id, cwd: target }] : []);
  });

  it('refuses a poll invalidated by newer activity for the chat', async () => {
    const call = vi.mocked(HermesGateway.prototype.call).getMockImplementation()!;
    vi.mocked(HermesGateway.prototype.call).mockImplementation(async (method, ...args) => {
      const value = await call(method, ...args);
      if (method === 'session.active_list') hermes['noteActivity'](id);
      return value;
    });
    expect((await post()).statusCode).toBe(503);
    expect(fake.workspaceMoves).toEqual([]);
  });

  it.each(['poll', 'fresh fetch', 'activity row'])('expires admission while the %s never answers, without moving after a late reply', async (stage) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let release!: (value: unknown) => void;
    if (stage === 'poll') {
      vi.mocked(HermesGateway.prototype.call).mockImplementation(async () =>
        await new Promise<unknown>((resolve) => { release = resolve; }) as never);
    } else {
      const json = vi.mocked(HermesAuth.prototype.json).getMockImplementation()!;
      vi.mocked(HermesAuth.prototype.json).mockImplementation(async (path, ...args) => {
        if (stage === 'fresh fetch' && path === `/api/sessions/${id}` || stage === 'activity row' &&
            new URL(path, 'http://fake.invalid').searchParams.get('archived') === 'include') {
          return await new Promise<unknown>((resolve) => { release = resolve; }) as never;
        }
        return json(path, ...args);
      });
    }
    let outcome: unknown;
    const moving = hermes.moveToFolder(id, target).then(() => { outcome = 'moved'; }, (err: unknown) => { outcome = err; });
    await vi.advanceTimersByTimeAsync(7_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toMatchObject({ status: 503, message: expect.stringContaining("Couldn't check") });
    expect(fake.workspaceMoves).toEqual([]);
    expect(vi.mocked(HermesGateway.prototype.call).mock.calls.some(([method]) => method === 'session.workspace.move')).toBe(false);
    release(stage === 'poll' ? { sessions: [] } : stage === 'fresh fetch' ? fake.topLevel[0] : { sessions: [fake.topLevel[0]] });
    await vi.advanceTimersByTimeAsync(0);
    await moving;
    expect(fake.workspaceMoves).toEqual([]);
    expect(vi.mocked(HermesGateway.prototype.call).mock.calls.some(([method]) => method === 'session.workspace.move')).toBe(false);
  });

  it('uses one deadline across a slow poll and the subsequent fresh fetch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.mocked(HermesGateway.prototype.call).mockImplementation(async () =>
      await new Promise<unknown>((resolve) => setTimeout(() => resolve({ sessions: [] }), 6_000)) as never);
    const json = vi.mocked(HermesAuth.prototype.json).getMockImplementation()!;
    vi.mocked(HermesAuth.prototype.json).mockImplementation(async (path, ...args) => {
      if (path === `/api/sessions/${id}`) return await new Promise<unknown>(() => {}) as never;
      return json(path, ...args);
    });
    let outcome: unknown;
    void hermes.moveToFolder(id, target).then(() => { outcome = 'moved'; }, (err: unknown) => { outcome = err; });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(outcome).toMatchObject({ status: 503 });
    expect(fake.workspaceMoves).toEqual([]);
    expect(vi.mocked(HermesGateway.prototype.call).mock.calls.some(([method]) => method === 'session.workspace.move')).toBe(false);
  });

  it('checks the injected clock at final admission even before the timer callback runs', async () => {
    await expect(hermes.moveToFolder(id, target, () => {
      vi.mocked(Date.now).mockReturnValue(NOW + 8_000);
    })).rejects.toMatchObject({ status: 503 });
    expect(fake.workspaceMoves).toEqual([]);
  });

  it('returns the admission deadline error when a not-found fetch arrives after clock expiry', async () => {
    const json = vi.mocked(HermesAuth.prototype.json).getMockImplementation()!;
    vi.mocked(HermesAuth.prototype.json).mockImplementation(async (path, ...args) => {
      if (path === `/api/sessions/${id}`) {
        vi.mocked(Date.now).mockReturnValue(NOW + 8_000);
        throw new HermesAuthError('Hermes request failed (404).', 'unavailable', 404);
      }
      return json(path, ...args);
    });
    await expect(hermes.moveToFolder(id, target)).rejects.toMatchObject({ status: 503, message: expect.stringContaining("Couldn't check") });
    expect(fake.workspaceMoves).toEqual([]);
  });

  it('bounds admission when six-second polls keep being superseded every five seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const call = vi.mocked(HermesGateway.prototype.call).getMockImplementation()!;
    vi.mocked(HermesGateway.prototype.call).mockImplementation(async (method, ...args) => {
      if (method === 'session.active_list') return await new Promise<unknown>((resolve) =>
        setTimeout(() => resolve({ sessions: [] }), 6_000)) as never;
      return call(method, ...args);
    });
    const background = setInterval(() => { void hermes['refreshActive'](); }, 5_000);
    let outcome: unknown;
    void hermes.moveToFolder(id, target).then(() => { outcome = 'moved'; }, (err: unknown) => { outcome = err; });
    try {
      await vi.advanceTimersByTimeAsync(8_000);
      expect(outcome).toMatchObject({ status: 503 });
      await vi.advanceTimersByTimeAsync(142_000);
      expect(fake.workspaceMoves).toEqual([]);
    } finally { clearInterval(background); }
  });

  it('refuses after a fixed number of superseding polls even before the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const polls: Array<(value: unknown) => void> = [];
    vi.mocked(HermesGateway.prototype.call).mockImplementation(async () =>
      await new Promise<unknown>((resolve) => { polls.push(resolve); }) as never);
    let outcome: unknown;
    void hermes.moveToFolder(id, target).then(() => { outcome = 'moved'; }, (err: unknown) => { outcome = err; });
    for (let i = 0; i < 3; i++) {
      void hermes['refreshActive']();
      polls[i]!({ sessions: [] });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(outcome).toMatchObject({ status: 503 });
    expect(fake.workspaceMoves).toEqual([]);
    expect(vi.mocked(HermesGateway.prototype.call).mock.calls.some(([method]) => method === 'session.workspace.move')).toBe(false);
    polls[3]!({ sessions: [] });
  });

  it.each(['archive', 'tidy', 'delete', 'listing invalidation'])('reconciles after %s during the native move without returning a removed or invalidated reply', async (action) => {
    fake.live = false;
    const sent = deferred<void>();
    const release = deferred<void>();
    const call = vi.mocked(HermesGateway.prototype.call).getMockImplementation()!;
    vi.mocked(HermesGateway.prototype.call).mockImplementation(async (method, ...args) => {
      const result = await call(method, ...args);
      if (method === 'session.workspace.move') { sent.resolve(); await release.promise; }
      return result;
    });
    const moving = post().then((response) => response);
    await sent.promise;
    if (action === 'listing invalidation') hermes['invalidateList']();
    else if (action === 'delete') await hermes.deleteThreads([id]);
    else if (action === 'tidy') await hermes.archiveThreads(await hermes.idleThreads(NOW + 86400_000));
    else await hermes.archiveThreads([id]);
    // A background activity reply must also respect the removal while the move waits.
    hermes['activeByStored'].set(id, 'working');
    await hermes['refreshActive']();
    const before = fake.listQueries.length;
    release.resolve();
    const res = await moving;
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('no longer listed');
    expect(fake.listQueries.length).toBeGreaterThan(before);
    if (action !== 'listing invalidation') {
      const removed = events.findIndex((e) => e.type === 'conversation_removed' && e.id === id);
      expect(removed).toBeGreaterThanOrEqual(0);
      expect(events.slice(removed + 1).some((e) => e.type === 'conversation_upsert' && e.conversation.id === id)).toBe(false);
      for (const client of clients) {
        const frames: ServerEvent[] = client.map((frame) => JSON.parse(frame));
        const at = frames.findIndex((e) => e.type === 'conversation_removed' && e.id === id);
        expect(frames.slice(at + 1).some((e) => e.type === 'conversation_upsert' && e.conversation.id === id)).toBe(false);
      }
    } else {
      await expectFolderEverywhere(target);
    }
  });

  it('keeps a removal authoritative while the post-move listing refresh waits', async () => {
    const refreshing = deferred<void>();
    const release = deferred<void>();
    const json = vi.mocked(HermesAuth.prototype.json).getMockImplementation()!;
    vi.mocked(HermesAuth.prototype.json).mockImplementation(async (path, ...args) => {
      if (fake.workspaceMoves.length && new URL(path, 'http://fake.invalid').pathname === '/api/sessions') {
        refreshing.resolve();
        await release.promise;
      }
      return json(path, ...args);
    });
    const moving = post().then((response) => response);
    await refreshing.promise;
    await hermes.archiveThreads([id]);
    // Releasing this response may start one replacement GET after invalidation.
    vi.mocked(HermesAuth.prototype.json).mockImplementation(json);
    release.resolve();
    expect((await moving).statusCode).toBe(404);
    const removed = events.findIndex((e) => e.type === 'conversation_removed' && e.id === id);
    expect(removed).toBeGreaterThanOrEqual(0);
    expect(events.slice(removed + 1).some((e) => e.type === 'conversation_upsert' && e.conversation.id === id)).toBe(false);
  });

  it('fails closed when live status cannot be checked', async () => {
    vi.mocked(HermesGateway.prototype.call).mockRejectedValueOnce(new Error('offline'));
    expect((await post()).statusCode).toBe(503);
    expect(fake.workspaceMoves).toEqual([]);
  });

  it('returns Hermes refusal and leaves the listing in its original folder', async () => {
    fake.moveRefusal = 'Workspace move refused by Hermes';
    const res = await post();
    expect(res.statusCode).toBe(424);
    expect(res.json().error).toContain(fake.moveRefusal);
    expect((await hermes.listConversations()).find((c) => c.id === id)?.project?.path).toBe(original);
    expect(events.some((e) => e.type === 'conversation_upsert' && e.conversation.project?.path === target)).toBe(false);
  });

  it('allows a paired phone and does not require settings rollout flags', async () => {
    expect((await post(target, 'hermes', id, postHeaders(token, { cookie: PHONE_COOKIE }))).statusCode).toBe(200);
  });

  it.each(['before request', 'folder check', 'live status', 'fresh row'])('refuses maintenance at %s without moving or publishing a destination', async (stage) => {
    if (stage === 'before request') hold.set(true);
    if (stage === 'folder check') vi.spyOn(paseo, 'folderStatus').mockImplementation(async () => { hold.set(true); return 'exists'; });
    if (stage === 'live status') {
      const call = vi.mocked(HermesGateway.prototype.call).getMockImplementation()!;
      vi.mocked(HermesGateway.prototype.call).mockImplementation(async (method, ...args) => {
        const value = await call(method, ...args);
        if (method === 'session.active_list') hold.set(true);
        return value;
      });
    }
    if (stage === 'fresh row') {
      const json = vi.mocked(HermesAuth.prototype.json).getMockImplementation()!;
      vi.mocked(HermesAuth.prototype.json).mockImplementation(async (path, ...args) => {
        const value = await json(path, ...args);
        if (path === `/api/sessions/${id}`) hold.set(true);
        return value;
      });
    }
    const res = await post();
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain('Maintenance');
    expect(fake.workspaceMoves).toEqual([]);
    expect(fake.topLevel[0]!.cwd).toBe(original);
    expect(events.some((e) => e.type === 'conversation_upsert' && e.conversation.project?.path === target)).toBe(false);
  });

  it.each(['folder check', 'live status', 'fresh row'])('rechecks device authorization after %s', async (stage) => {
    const revoke = () => devices.revoke(TEST_DESKTOP.id);
    if (stage === 'folder check') vi.spyOn(paseo, 'folderStatus').mockImplementation(async () => { revoke(); return 'exists'; });
    else if (stage === 'live status') {
      const call = vi.mocked(HermesGateway.prototype.call).getMockImplementation()!;
      vi.mocked(HermesGateway.prototype.call).mockImplementation(async (method, ...args) => {
        const value = await call(method, ...args);
        if (method === 'session.active_list') revoke();
        return value;
      });
    } else {
      const json = vi.mocked(HermesAuth.prototype.json).getMockImplementation()!;
      vi.mocked(HermesAuth.prototype.json).mockImplementation(async (path, ...args) => {
        const value = await json(path, ...args);
        if (path === `/api/sessions/${id}`) revoke();
        return value;
      });
    }
    expect((await post()).statusCode).toBe(403);
    expect(fake.workspaceMoves).toEqual([]);
  });

  it('logs only the id and outcome even when Hermes refusal includes the destination', async () => {
    fake.moveRefusal = `Cannot move Invented private title to ${target}`;
    expect((await post()).statusCode).toBe(424);
    expect(logs.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({ msg: 'thread moved', id, ok: false }));
    expect(logs.join('')).not.toContain(target);
    expect(logs.join('')).not.toContain('Invented private title');
    fake.moveRefusal = undefined;
    expect((await post()).statusCode).toBe(200);
    expect(logs.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({ msg: 'thread moved', id, ok: true }));
    expect(logs.join('')).not.toContain(target);
  });

  it('uses the same authentication and cross-site rules as archive', async () => {
    expect((await post(target, 'hermes', id, { host: new URL(ORIGIN).host, origin: ORIGIN, 'content-type': 'application/json' })).statusCode).toBe(401);
    const headers = { ...postHeaders(token), origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
    delete (headers as Record<string, string>)['x-wayroost-request'];
    expect((await post(target, 'hermes', id, headers)).statusCode).toBe(403);
    expect(fake.workspaceMoves).toEqual([]);
  });
});
