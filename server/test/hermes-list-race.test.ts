import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSummary, ServerEvent } from '../../shared/protocol.js';
import { BackgroundGate } from '../src/background.js';
import { HermesAdapter } from '../src/hermes/adapter.js';
import { HermesAuth, HermesAuthError } from '../src/hermes/auth.js';
import { HermesGateway } from '../src/hermes/gateway.js';
import type { HermesSessionRow } from '../src/hermes/normalize.js';
import { EventHub } from '../src/hub.js';
import { abortOnDevice, deviceSignal, withDeviceSignal } from '../src/security/device-signal.js';
import { SecretStore } from '../src/secrets.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

type Sessions = { sessions: HermesSessionRow[] };
const AT = 1_790_490_000;
const parent: HermesSessionRow = { id: 'demo-parent', source: 'desktop', title: 'Parent', last_active: AT };
const child: HermesSessionRow = {
  id: 'demo-run', source: 'desktop', title: 'Subagent: Check the build', parent_session_id: parent.id,
  last_active: AT, ended_at: AT,
};
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('Hermes chat lists that overlap', () => {
  let adapter: HermesAdapter;
  let gateway: HermesGateway;
  let stateDir: string;
  let published: ServerEvent[];
  let queries: URLSearchParams[];
  let runRows: HermesSessionRow[];
  let chatSignals: Array<AbortSignal | undefined>;
  let folderStarted: ReturnType<typeof deferred<void>>;
  let folderResponse: ReturnType<typeof deferred<{ default_cwd: string }>> | undefined;
  let runsStarted: ReturnType<typeof deferred<void>>;
  let runsResponse: ReturnType<typeof deferred<Sessions>> | undefined;
  let acpStarted: ReturnType<typeof deferred<void>>;
  let acpResponse: ReturnType<typeof deferred<Sessions>>;
  let acpSignals: Array<AbortSignal | undefined>;
  let requests: Array<{ started: ReturnType<typeof deferred<void>>; response: ReturnType<typeof deferred<Sessions>> }>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(AT * 1000);
    stateDir = mkdtempSync(join(tmpdir(), 'hermes-list-race-'));
    const secrets = new SecretStore(stateDir);
    secrets.writeHermes({ username: 'demo-owner', password: 'demo-password' });
    const hub = new EventHub();
    published = [];
    vi.spyOn(hub, 'publish').mockImplementation((event) => { published.push(event); });
    adapter = new HermesAdapter('http://dashboard.invalid', hub, secrets, { info() {}, warn() {}, error() {} },
      { background: new BackgroundGate('primary') });
    queries = [];
    runRows = [parent, child, child];
    chatSignals = [];
    folderStarted = deferred<void>();
    folderResponse = undefined;
    runsStarted = deferred<void>();
    runsResponse = undefined;
    acpStarted = deferred<void>();
    acpResponse = deferred<Sessions>();
    acpSignals = [];
    requests = Array.from({ length: 10 }, () => ({ started: deferred<void>(), response: deferred<Sessions>() }));

    // Stub only the HTTP/RPC boundaries. Startup, its refresh timer, caches,
    // row normalization, parent resolution and publication use production code.
    vi.spyOn(HermesGateway.prototype, 'start').mockImplementation(function (this: HermesGateway) {
      gateway = this;
      this.state = 'ready';
      this.emit('ready', { epoch: 'demo-epoch' });
    });
    vi.spyOn(HermesGateway.prototype, 'call').mockResolvedValue({ sessions: [] });
    vi.spyOn(HermesAuth.prototype, 'json').mockImplementation(async <T>(path: string, init?: RequestInit): Promise<T> => {
      const url = new URL(path, 'http://dashboard.invalid');
      if (url.pathname === `/api/sessions/${parent.id}` && init?.method === 'PATCH') return {} as T;
      if (url.pathname === '/api/sessions') {
        queries.push(url.searchParams);
        if (url.searchParams.get('limit') === '60') {
          chatSignals.push(deviceSignal());
          const request = requests[chatQueries().length - 1]!;
          request.started.resolve();
          return await abortOnDevice(request.response.promise) as T;
        }
        if (url.searchParams.get('source') === 'acp') {
          acpSignals.push(deviceSignal());
          acpStarted.resolve();
          return await abortOnDevice(acpResponse.promise) as T;
        }
        runsStarted.resolve();
        return (runsResponse ? await abortOnDevice(runsResponse.promise) : { sessions: runRows }) as T;
      }
      if (path === '/api/config/defaults') return { sessions: { show_subagents: true } } as T;
      if (path === '/api/chat/workspaces') {
        folderStarted.resolve();
        return (folderResponse ? await abortOnDevice(folderResponse.promise) : { default_cwd: '/home/me' }) as T;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
  });

  afterEach(() => {
    adapter.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  const chatQueries = () => queries.filter((query) => query.get('limit') === '60');
  const runQueries = () => queries.filter((query) => query.get('exclude_sources') === 'cron,acp,subagent');
  const acpQueries = () => queries.filter((query) => query.get('source') === 'acp');
  const upserts = () => published.flatMap((event) => event.type === 'conversation_upsert' ? [event.conversation] : []);

  async function start() {
    const lists = vi.spyOn(adapter, 'listConversations');
    adapter.start();
    await settle();
    await requests[0]!.started.promise; // the startup GET stays pending until explicitly released
    return { startup: lists.mock.results[0]!.value as Promise<ConversationSummary[]> };
  }

  async function changeSessions() {
    gateway.emit('event', { type: 'sessions.changed' });
    await vi.advanceTimersByTimeAsync(800);
  }

  function expectRows(list: ConversationSummary[], ids = [parent.id, child.id], title = parent.title) {
    expect(list.map((conversation) => conversation.id)).toEqual(ids);
    expect(list.find((conversation) => conversation.id === parent.id)).toMatchObject({ title });
    expect(list.find((conversation) => conversation.id === child.id)).toMatchObject({
      subagent: true, parent: { source: 'hermes', id: parent.id },
    });
  }

  it('shares one chat GET between startup and foreground, retaining unique rows and parentage', async () => {
    const { startup } = await start();
    const foreground = adapter.listConversations();
    expect(chatQueries()).toHaveLength(1);

    requests[0]!.response.resolve({ sessions: [parent, parent] });
    for (const list of await Promise.all([startup, foreground])) expectRows(list);
    await settle(); // the startup timer has also published its list
    expectRows(upserts());
    expectRows(await adapter.listConversations());
    expect(chatQueries()).toHaveLength(1);
    expect(runQueries()).toHaveLength(1);
    expect(new Set(queries.map((query) => query.get('limit')))).toEqual(new Set(['60', '100']));
  });

  it('retains one sub-agent GET when the initial activity poll finishes during a foreground list', async () => {
    const activity = deferred<{ sessions: never[] }>();
    vi.mocked(HermesGateway.prototype.call).mockReturnValue(activity.promise);
    runsResponse = deferred<Sessions>();
    const lists = vi.spyOn(adapter, 'listConversations');
    adapter.start();
    const foreground = adapter.listConversations();
    requests[0]!.response.resolve({ sessions: [parent, parent] });
    await runsStarted.promise;
    activity.resolve({ sessions: [] });
    await settle();
    await requests[1]!.started.promise;
    const startup = lists.mock.results[1]!.value as Promise<ConversationSummary[]>;
    requests[1]!.response.resolve({ sessions: [parent, parent] });
    await settle();
    expect(runQueries()).toHaveLength(1);
    runsResponse.resolve({ sessions: runRows });
    for (const list of await Promise.all([startup, foreground])) expectRows(list);
    expect(runQueries()).toHaveLength(1);
    expect(new Set(queries.map((query) => query.get('limit')))).toEqual(new Set(['60', '100']));
  });

  it('retains chat parents while startup invalidates the list during a sub-agent lookup', async () => {
    const activity = deferred<{ sessions: never[] }>();
    vi.mocked(HermesGateway.prototype.call).mockReturnValue(activity.promise);
    runsResponse = deferred<Sessions>();
    const lists = vi.spyOn(adapter, 'listConversations');
    adapter.start();
    const foreground = adapter.listConversations();
    requests[0]!.response.resolve({ sessions: [parent, parent] });
    await runsStarted.promise;

    activity.resolve({ sessions: [] });
    await settle();
    await requests[1]!.started.promise;
    const startup = lists.mock.results[1]!.value as Promise<ConversationSummary[]>;
    runsResponse.resolve({ sessions: runRows });
    acpResponse.resolve({ sessions: [] });
    await settle();
    expect(acpQueries()).toHaveLength(0);
    expectRows(await foreground);

    requests[1]!.response.resolve({ sessions: [parent, parent] });
    expectRows(await startup);
    expectRows(await adapter.listConversations());
    expect(chatQueries()).toHaveLength(2);
    expect(runQueries()).toHaveLength(1);
    expect(acpQueries()).toHaveLength(0);
  });

  it('completes a list while slow GETs overlap streaming session changes', async () => {
    vi.mocked(HermesAuth.prototype.json).mockImplementation(async <T>(path: string): Promise<T> => {
      const url = new URL(path, 'http://dashboard.invalid');
      let data: unknown;
      if (url.pathname === '/api/sessions') {
        queries.push(url.searchParams);
        data = { sessions: url.searchParams.get('limit') === '60' ? [parent, parent] : runRows };
      } else if (path === '/api/config/defaults') data = { sessions: { show_subagents: true } };
      else if (path === '/api/chat/workspaces') data = { default_cwd: '/home/me' };
      else throw new Error(`Unexpected request: ${path}`);
      return new Promise<T>((resolve) => setTimeout(() => resolve(data as T), 1_500));
    });
    const lists = vi.spyOn(adapter, 'listConversations');
    adapter.start();
    await vi.advanceTimersByTimeAsync(6_000);
    const startup = lists.mock.results[0]!.value as Promise<ConversationSummary[]>;
    expectRows(await startup);
    queries = [];

    const startedAt = Date.now();
    gateway.emit('event', { type: 'sessions.changed' });
    const changes = setInterval(() => gateway.emit('event', { type: 'sessions.changed' }), 2_000);
    const foreground = adapter.listConversations();
    const completed = vi.fn();
    void foreground.then(completed, completed);
    while (!completed.mock.calls.length && Date.now() - startedAt < 5_900) {
      await vi.advanceTimersByTimeAsync(100);
    }
    clearInterval(changes);
    expect(completed).toHaveBeenCalledTimes(1);
    expectRows(await foreground);
    expect(Date.now() - startedAt).toBeLessThan(6_000);
    expect(chatQueries().length).toBeLessThanOrEqual(3);
    expect(runQueries()).toHaveLength(1);
    expect(queries.length).toBeLessThanOrEqual(4);
    expect(acpQueries()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_500);
    expectRows(await adapter.listConversations());
    expect(queries.length).toBeLessThanOrEqual(4);
  });

  it.each(['stale first', 'fresh first'])('uses fresh data after invalidation during the overlap (%s)', async (order) => {
    const { startup } = await start();
    const foreground = adapter.listConversations();
    expect(chatQueries()).toHaveLength(1);

    await changeSessions();
    await requests[1]!.started.promise; // the scheduled invalidation starts a fresh GET
    const afterInvalidation = adapter.listConversations();
    expect(chatQueries()).toHaveLength(2);
    const freshParent = { ...parent, title: 'Fresh parent' };
    const added = { ...parent, id: 'demo-new-chat', title: 'New chat' };
    const stale = { sessions: [parent, parent, { ...parent, id: 'demo-retired-chat' }] };
    const fresh = { sessions: [freshParent, freshParent, added, added] };
    const ids = [parent.id, added.id, child.id];

    if (order === 'stale first') {
      requests[0]!.response.resolve(stale);
      await settle();
    } else {
      requests[1]!.response.resolve(fresh);
      expectRows(await afterInvalidation, ids, freshParent.title);
      requests[0]!.response.resolve(stale);
      await Promise.all([startup, foreground]);
    }
    // The stale request must neither fill the cache nor clear the fresh promise.
    const later = adapter.listConversations();
    expect(chatQueries()).toHaveLength(2);
    if (order === 'stale first') requests[1]!.response.resolve(fresh);
    for (const list of await Promise.all([startup, foreground, afterInvalidation, later])) {
      expectRows(list, ids, freshParent.title);
    }
    await settle();
    expectRows(upserts(), ids, freshParent.title);
    expectRows(await adapter.listConversations(), ids, freshParent.title);
    expect(chatQueries()).toHaveLength(2);
    expect(runQueries()).toHaveLength(1);
  });

  it('shares a failed GET and retries instead of caching the error', async () => {
    const { startup } = await start();
    const foreground = adapter.listConversations();
    const results = Promise.allSettled([startup, foreground]);
    expect(chatQueries()).toHaveLength(1);
    requests[0]!.response.reject(new HermesAuthError('Demo request failed', 'unavailable', 500));
    expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected']);

    const retry = adapter.listConversations();
    expect(chatQueries()).toHaveLength(2);
    requests[1]!.response.resolve({ sessions: [parent, parent] });
    expectRows(await retry);
    expectRows(await adapter.listConversations());
    expect(chatQueries()).toHaveLength(2);
  });

  it('resolves parents during overlapping ACP lookups and reuses the resulting cache', async () => {
    const root = '5f234678-9012-4abc-8def-0123456789ab';
    const acp = { ...parent, id: 'demo-acp-continuation', source: 'acp', _lineage_root_id: root, _lineage_ids: [root, 'demo-acp-continuation'] };
    runRows = [parent, { ...child, parent_session_id: acp.id }, { ...child, parent_session_id: acp.id }];
    const { startup } = await start();
    const foreground = adapter.listConversations();
    expect(chatQueries()).toHaveLength(1);
    requests[0]!.response.resolve({ sessions: [parent, parent] });
    await acpStarted.promise;
    await settle(); // both callers reach ACP before the response completes
    const acpFetches = acpQueries().length;
    expect(acpFetches).toBe(1);
    expect(runQueries()).toHaveLength(1);
    acpResponse.resolve({ sessions: [acp, acp] });

    const expectAcpParent = (list: ConversationSummary[]) => {
      expect(list.map((conversation) => conversation.id)).toEqual([parent.id, child.id]);
      expect(list[1]).toMatchObject({ subagent: true, parent: { source: 'hermes', id: root } });
    };
    for (const list of await Promise.all([startup, foreground])) expectAcpParent(list);

    await changeSessions();
    await requests[1]!.started.promise;
    const refreshed = adapter.listConversations();
    requests[1]!.response.resolve({ sessions: [parent, parent] });
    expectAcpParent(await refreshed);
    expect(runQueries()).toHaveLength(2);
    expect(acpQueries()).toHaveLength(acpFetches);
  });

  it.each(['stale first', 'fresh first'])('discards an ACP lookup invalidated before completion (%s)', async (order) => {
    const staleRoot = '11111111-1111-4111-8111-111111111111';
    const freshRoot = '22222222-2222-4222-8222-222222222222';
    const acp = { ...parent, id: 'demo-acp-parent', source: 'acp', _lineage_root_id: staleRoot };
    runRows = [{ ...child, parent_session_id: acp.id }];
    const staleAcp = acpResponse;
    const { startup } = await start();
    const foreground = adapter.listConversations();
    requests[0]!.response.resolve({ sessions: [parent, parent] });
    await acpStarted.promise;
    await settle();
    expect(acpQueries()).toHaveLength(1);

    acpStarted = deferred<void>();
    const freshAcp = acpResponse = deferred<Sessions>();
    await changeSessions();
    const afterInvalidation = adapter.listConversations();
    requests[1]!.response.resolve({ sessions: [parent, parent] });
    await acpStarted.promise;
    await settle();
    expect(acpQueries()).toHaveLength(2);
    const expectFresh = (list: ConversationSummary[]) => {
      expect(list.map((conversation) => conversation.id)).toEqual([parent.id, child.id]);
      expect(list[1]).toMatchObject({ subagent: true, parent: { source: 'hermes', id: freshRoot } });
    };
    if (order === 'stale first') {
      staleAcp.resolve({ sessions: [acp] });
      await settle();
      const later = adapter.listConversations();
      await settle();
      expect(acpQueries()).toHaveLength(2);
      freshAcp.resolve({ sessions: [{ ...acp, _lineage_root_id: freshRoot }] });
      expectFresh(await later);
    } else {
      freshAcp.resolve({ sessions: [{ ...acp, _lineage_root_id: freshRoot }] });
      expectFresh(await afterInvalidation);
      staleAcp.resolve({ sessions: [acp] });
    }
    await Promise.all([startup, foreground]);
    expectFresh(await afterInvalidation);
    expectFresh(await adapter.listConversations());
    expect(acpQueries()).toHaveLength(2);
  });

  it('retries a failed ACP lookup without caching the error', async () => {
    const root = '11111111-1111-4111-8111-111111111111';
    const acp = { ...parent, id: 'demo-acp-parent', source: 'acp', _lineage_root_id: root };
    runRows = [{ ...child, parent_session_id: acp.id }];
    const { startup } = await start();
    const foreground = adapter.listConversations();
    requests[0]!.response.resolve({ sessions: [parent, parent] });
    await acpStarted.promise;
    await settle();
    expect(acpQueries()).toHaveLength(1);
    acpResponse.reject(new HermesAuthError('Demo request failed', 'unavailable', 500));
    for (const list of await Promise.all([startup, foreground])) {
      expect(list.map((conversation) => conversation.id)).toEqual([parent.id]);
    }

    acpStarted = deferred<void>();
    acpResponse = deferred<Sessions>();
    const retry = adapter.listConversations();
    await acpStarted.promise;
    expect(acpQueries()).toHaveLength(2);
    acpResponse.resolve({ sessions: [acp] });
    expect((await retry)[1]).toMatchObject({ parent: { source: 'hermes', id: root } });
    expect((await adapter.listConversations())[1]).toMatchObject({ parent: { source: 'hermes', id: root } });
    expect(acpQueries()).toHaveLength(2);
  });

  it.each(['initiator', 'joiner'])('cancels only the revoked caller during ACP when the %s aborts', async (revoked) => {
    const root = '11111111-1111-4111-8111-111111111111';
    const acp = { ...parent, id: 'demo-acp-parent', source: 'acp', _lineage_root_id: root };
    runRows = [{ ...child, parent_session_id: acp.id }];
    const initiator = new AbortController();
    const joiner = new AbortController();
    const first = withDeviceSignal(initiator.signal, () => adapter.listConversations());
    const second = withDeviceSignal(joiner.signal, () => adapter.listConversations());
    const cancelled = revoked === 'initiator' ? first : second;
    const authorized = revoked === 'initiator' ? second : first;
    const onCancel = vi.fn();
    void cancelled.then(onCancel, onCancel);
    requests[0]!.response.resolve({ sessions: [parent, parent] });
    await acpStarted.promise;
    await settle();
    expect(acpQueries()).toHaveLength(1);

    (revoked === 'initiator' ? initiator : joiner).abort();
    await settle();
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(acpSignals).toEqual([undefined]);
    acpResponse.resolve({ sessions: [acp] });
    expect((await authorized)[1]).toMatchObject({ parent: { source: 'hermes', id: root } });
    await expect(cancelled).rejects.toMatchObject({ status: 403 });
    expect(acpQueries()).toHaveLength(1);
  });

  it.each(['stale first', 'fresh first'])('keeps an archived chat out when its pending GET completes (%s)', async (order) => {
    runRows = [];
    const { startup } = await start();
    const foreground = adapter.listConversations();
    expect(chatQueries()).toHaveLength(1);
    expect(await adapter.archiveThreads([parent.id])).toEqual({ done: 1, failed: [] });
    expect(published).toContainEqual({ type: 'conversation_removed', source: 'hermes', id: parent.id });
    const afterArchive = adapter.listConversations();
    const stale = { sessions: [parent, parent] };
    const fresh = { sessions: [] };
    let later: Promise<ConversationSummary[]> | undefined;
    if (order === 'stale first') {
      requests[0]!.response.resolve(stale);
      await settle();
      later = adapter.listConversations();
      requests[1]!.response.resolve(fresh);
    } else {
      requests[1]!.response.resolve(fresh);
      await settle();
      requests[0]!.response.resolve(stale);
    }
    for (const list of await Promise.all([startup, foreground, afterArchive, ...(later ? [later] : [])])) {
      expect(list).toEqual([]);
    }
    await settle();
    expect(await adapter.listConversations()).toEqual([]);
    expect(upserts()).toEqual([]);
    expect(chatQueries()).toHaveLength(2);
  });

  it.each(['folder', 'sub-agents'])('keeps an archived chat out while a list waits for %s', async (stage) => {
    runRows = [];
    if (stage === 'folder') folderResponse = deferred<{ default_cwd: string }>();
    else runsResponse = deferred<Sessions>();
    const kept = { ...parent, id: 'demo-kept-chat', title: 'Kept chat' };
    const { startup } = await start();
    const foreground = adapter.listConversations();
    requests[0]!.response.resolve({ sessions: [parent, parent, kept] });
    await (stage === 'folder' ? folderStarted.promise : runsStarted.promise);
    await settle(); // both lists hold the chat snapshot while the optional GET waits

    expect(await adapter.archiveThreads([parent.id])).toEqual({ done: 1, failed: [] });
    const removed = published.findIndex((event) => event.type === 'conversation_removed' && event.id === parent.id);
    expect(removed).toBeGreaterThanOrEqual(0);
    if (stage === 'folder') folderResponse!.resolve({ default_cwd: '/home/me' });
    else runsResponse!.resolve({ sessions: runRows });
    const lists = await Promise.all([startup, foreground]);
    await settle(); // the scheduled refresh has published its completed list

    expect(published.slice(removed + 1).filter((event) =>
      event.type === 'conversation_upsert' && event.conversation.id === parent.id)).toEqual([]);
    for (const list of lists) expect(list.map((conversation) => conversation.id)).toEqual([kept.id]);
    expect(upserts().map((conversation) => conversation.id)).toEqual([kept.id]);
    expect((await adapter.listConversations()).map((conversation) => conversation.id)).toEqual([kept.id]);
    expect(chatQueries()).toHaveLength(1);
  });

  it.each(['current', 'earlier'])('keeps existing runs out when their %s parent is archived during a folder lookup', async (parentage) => {
    const earlier = 'demo-earlier-parent';
    const archived = parentage === 'earlier' ? { ...parent, _lineage_ids: [earlier, parent.id] } : parent;
    const removedRun = { ...child, parent_session_id: parentage === 'earlier' ? earlier : parent.id };
    const kept = { ...parent, id: 'demo-kept-chat', title: 'Kept chat' };
    const keptRun = { ...child, id: 'demo-kept-run', parent_session_id: kept.id };
    runRows = [archived, removedRun, removedRun, keptRun, keptRun];
    acpResponse.resolve({ sessions: [] });
    const initial = adapter.listConversations();
    requests[0]!.response.resolve({ sessions: [archived, archived, kept] });
    const initialRows = await initial;
    expect(initialRows.map((conversation) => conversation.id)).toEqual([parent.id, kept.id, child.id, keptRun.id]);
    expect(initialRows.find((conversation) => conversation.id === child.id)).toMatchObject({
      subagent: true, parent: { source: 'hermes', id: parent.id },
    });

    folderStarted = deferred<void>();
    folderResponse = deferred<{ default_cwd: string }>();
    const { startup } = await start();
    const foreground = adapter.listConversations();
    requests[1]!.response.resolve({ sessions: [archived, archived, kept] });
    await folderStarted.promise;
    await settle();
    const removedAt = published.length;
    expect(await adapter.archiveThreads([parent.id])).toEqual({ done: 1, failed: [] });
    expect(published.slice(removedAt)).toEqual([
      { type: 'conversation_removed', source: 'hermes', id: parent.id },
      { type: 'conversation_removed', source: 'hermes', id: child.id },
    ]);

    folderResponse.resolve({ default_cwd: '/home/me' });
    const lists = await Promise.all([startup, foreground]);
    await settle();
    const cached = await adapter.listConversations();
    for (const list of [...lists, cached, upserts()]) {
      expect(list.map((conversation) => conversation.id)).toEqual([kept.id, keptRun.id]);
      expect(list[1]).toMatchObject({ subagent: true, parent: { source: 'hermes', id: kept.id } });
    }
    expect(published.slice(removedAt).filter((event) => event.type === 'conversation_upsert' &&
      [parent.id, child.id].includes(event.conversation.id))).toEqual([]);
    expect(chatQueries()).toHaveLength(2);
  });

  it.each(['initiator', 'joiner'])('cancels only the revoked caller when the %s aborts', async (revoked) => {
    const initiator = new AbortController();
    const joiner = new AbortController();
    const first = withDeviceSignal(initiator.signal, () => adapter.listConversations());
    const second = withDeviceSignal(joiner.signal, () => adapter.listConversations());
    const cancelled = revoked === 'initiator' ? first : second;
    const authorized = revoked === 'initiator' ? second : first;
    const onCancel = vi.fn();
    const onAuthorized = vi.fn();
    void cancelled.then(onCancel, onCancel);
    void authorized.then(onAuthorized, onAuthorized);
    expect(chatQueries()).toHaveLength(1);

    (revoked === 'initiator' ? initiator : joiner).abort();
    await settle();
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(chatSignals).toEqual([undefined]);

    requests[0]!.response.resolve({ sessions: [parent, parent] });
    expectRows(await authorized);
    await expect(cancelled).rejects.toMatchObject({ status: 403 });
    expectRows(await withDeviceSignal(new AbortController().signal, () => adapter.listConversations()));
    expect(chatQueries()).toHaveLength(1);
  });

  it('checks authorization for cached lists and while waiting for sub-agent rows', async () => {
    runsResponse = deferred<Sessions>();
    const initiator = new AbortController();
    const first = withDeviceSignal(initiator.signal, () => adapter.listConversations());
    const onCancel = vi.fn();
    void first.then(onCancel, onCancel);
    requests[0]!.response.resolve({ sessions: [parent, parent] });
    await runsStarted.promise;
    const authorized = adapter.listConversations();
    initiator.abort();
    await settle();
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    runsResponse.resolve({ sessions: runRows });
    expectRows(await authorized);
    await expect(first).rejects.toMatchObject({ status: 403 });

    // Revocation can race even a list whose HTTP data is already cached.
    const controller = new AbortController();
    const cached = withDeviceSignal(controller.signal, () => adapter.listConversations());
    controller.abort();
    await expect(cached).rejects.toMatchObject({ status: 403 });
    const revoked = new AbortController();
    await expect(withDeviceSignal(revoked.signal, () => {
      revoked.abort();
      return adapter.listConversations();
    })).rejects.toMatchObject({ status: 403 });
    expectRows(await adapter.listConversations());
    expect(chatQueries()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds repeated invalidations with one caller deadline and allows a later caller to finish', async () => {
    const { startup } = await start();
    const foreground = adapter.listConversations();
    const settled = vi.fn();
    void foreground.then(settled, settled);
    const results = Promise.allSettled([startup, foreground]);
    for (let i = 0; i < 6; i++) {
      await changeSessions();
      await requests[i + 1]!.started.promise;
      requests[i]!.response.resolve({ sessions: [{ ...parent, id: 'demo-stale-chat' }] });
      await settle();
      expect(settled).not.toHaveBeenCalled();
    }
    expect(chatQueries()).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(30_000 - 6 * 800 - 1);
    expect(settled).not.toHaveBeenCalled();
    const later = adapter.listConversations();
    const onLater = vi.fn();
    void later.then(onLater, onLater);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ status: 503 }));
    expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(onLater).not.toHaveBeenCalled();
    expect(upserts()).toEqual([]);
    expect(chatQueries()).toHaveLength(7);

    requests[6]!.response.resolve({ sessions: [parent, parent] });
    expectRows(await later);
    expectRows(await adapter.listConversations());
    expect(chatQueries()).toHaveLength(7);
  });

  it('keeps the chat snapshot while awaiting the default folder without replacing fresh cached chats', async () => {
    folderResponse = deferred<{ default_cwd: string }>();
    const { startup } = await start();
    const foreground = adapter.listConversations();
    const retired = { ...parent, id: 'demo-retired-chat' };
    requests[0]!.response.resolve({ sessions: [parent, retired] });
    await folderStarted.promise;
    await changeSessions();
    await requests[1]!.started.promise;
    const afterInvalidation = adapter.listConversations();
    const added = { ...parent, id: 'demo-new-chat' };
    requests[1]!.response.resolve({ sessions: [parent, parent, added, added] });
    await settle();
    folderResponse.resolve({ default_cwd: '/home/me' });
    for (const list of await Promise.all([startup, foreground])) expectRows(list, [parent.id, retired.id, child.id]);
    expectRows(await afterInvalidation, [parent.id, added.id, child.id]);
    expectRows(await adapter.listConversations(), [parent.id, added.id, child.id]);
    expect(chatQueries()).toHaveLength(2);
  });

  it.each(['stale first', 'fresh first'])('discards a sub-agent lookup invalidated before completion (%s)', async (order) => {
    const staleRuns = runsResponse = deferred<Sessions>();
    const { startup } = await start();
    const foreground = adapter.listConversations();
    requests[0]!.response.resolve({ sessions: [parent, parent] });
    await runsStarted.promise;
    const freshRuns = runsResponse = deferred<Sessions>();
    await changeSessions();
    const afterInvalidation = adapter.listConversations();
    requests[1]!.response.resolve({ sessions: [parent, parent] });
    await settle();
    expect(runQueries()).toHaveLength(2);
    const added = { ...child, id: 'demo-new-run' };
    const expectFresh = (list: ConversationSummary[]) => {
      expect(list.map((conversation) => conversation.id)).toEqual([parent.id, added.id]);
      expect(list[1]).toMatchObject({ subagent: true, parent: { source: 'hermes', id: parent.id } });
    };
    if (order === 'stale first') {
      staleRuns.resolve({ sessions: runRows });
      await settle();
      await Promise.all([startup, foreground]);
      const later = adapter.listConversations();
      await settle();
      expect(runQueries()).toHaveLength(2);
      freshRuns.resolve({ sessions: [parent, added, added] });
      expectFresh(await later);
    } else {
      freshRuns.resolve({ sessions: [parent, added, added] });
      expectFresh(await afterInvalidation);
      staleRuns.resolve({ sessions: runRows });
    }
    await Promise.all([startup, foreground]);
    expectFresh(await afterInvalidation);
    expectFresh(await adapter.listConversations());
    expect(runQueries()).toHaveLength(2);
  });

  it.each(['stale first', 'fresh first'])('discards pre-reconnect chat data (%s)', async (order) => {
    const { startup } = await start();
    const foreground = adapter.listConversations();
    gateway.emit('ready', { epoch: 'demo-new-epoch' });
    await settle();
    await requests[1]!.started.promise;
    const afterReconnect = adapter.listConversations();
    const freshParent = { ...parent, title: 'Reconnected parent' };
    if (order === 'stale first') {
      requests[0]!.response.resolve({ sessions: [parent, { ...parent, id: 'demo-stale-chat' }] });
      await settle();
      requests[1]!.response.resolve({ sessions: [freshParent, freshParent] });
    } else {
      requests[1]!.response.resolve({ sessions: [freshParent, freshParent] });
      expectRows(await afterReconnect, [parent.id, child.id], freshParent.title);
      requests[0]!.response.resolve({ sessions: [parent, { ...parent, id: 'demo-stale-chat' }] });
    }
    for (const list of await Promise.all([startup, foreground, afterReconnect])) {
      expectRows(list, [parent.id, child.id], freshParent.title);
    }
    expect(chatQueries()).toHaveLength(2);
  });

  it.each(['chats', 'folder', 'sub-agents', 'ACP'])('returns no data when credentials are cleared while waiting for %s', async (stage) => {
    if (stage === 'folder') folderResponse = deferred<{ default_cwd: string }>();
    if (stage === 'sub-agents') runsResponse = deferred<Sessions>();
    if (stage === 'ACP') runRows = [{ ...child, parent_session_id: 'demo-acp-parent' }];
    const { startup } = await start();
    const foreground = adapter.listConversations();
    if (stage !== 'chats') {
      requests[0]!.response.resolve({ sessions: [parent, parent] });
      if (stage === 'folder') await folderStarted.promise;
      else if (stage === 'sub-agents') await runsStarted.promise;
      else await acpStarted.promise;
    }
    await adapter.clearCredentials();
    if (stage === 'chats') requests[0]!.response.resolve({ sessions: [parent, parent] });
    else if (stage === 'folder') folderResponse!.resolve({ default_cwd: '/home/me' });
    else if (stage === 'sub-agents') runsResponse!.resolve({ sessions: runRows });
    else acpResponse.resolve({ sessions: [{ ...parent, id: 'demo-acp-parent', source: 'acp' }] });
    expect(await startup).toEqual([]);
    expect(await foreground).toEqual([]);
    expect(await adapter.listConversations()).toEqual([]);
    expect(upserts()).toEqual([]);
    expect(chatQueries()).toHaveLength(1);
  });
});
