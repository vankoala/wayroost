import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundGate } from '../src/background.js';
import { HermesAdapter } from '../src/hermes/adapter.js';
import { HermesAuth } from '../src/hermes/auth.js';
import { EventHub } from '../src/hub.js';
import { abortOnDevice, deviceSignal, withDeviceSignal } from '../src/security/device-signal.js';
import { SecretStore } from '../src/secrets.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function session() {
  const headers = new Headers();
  headers.append('set-cookie', 'hermes_session_at=demo-access; HttpOnly; Path=/');
  headers.append('set-cookie', 'hermes_session_rt=demo-refresh; HttpOnly; Path=/');
  return Response.json({}, { headers });
}

const CHAT_QUERY = '/api/sessions?limit=60&order=recent&archived=exclude&min_messages=1&exclude_sources=cron,acp,oneshot';
const ONESHOT_QUERY = '/api/sessions?source=oneshot&limit=100&order=recent&archived=exclude&min_messages=1';
const ARCHIVED_QUERY = '/api/sessions?limit=20&order=recent&archived=only&min_messages=1&exclude_sources=cron,acp';

describe('Hermes shared authentication', () => {
  let adapter: HermesAdapter;
  let auth: HermesAuth;
  let stateDir: string;
  let renewalStarted: ReturnType<typeof deferred<void>>;
  let renewalResponse: ReturnType<typeof deferred<Response>>;
  let holdRenewal: boolean;
  let renewalSignals: Array<AbortSignal | undefined>;
  let renewalContexts: Array<AbortSignal | undefined>;
  let paths: string[];
  let requests: Array<{ path: string; token: string | null; signal: AbortSignal | undefined; context: AbortSignal | undefined }>;
  let dashboardResponse: ((url: URL, init?: RequestInit) => Response | Promise<Response> | undefined) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
    stateDir = mkdtempSync(join(tmpdir(), 'hermes-auth-'));
    const secrets = new SecretStore(stateDir);
    secrets.writeHermes({ username: 'demo-owner', password: 'demo-password' });
    adapter = new HermesAdapter('http://dashboard.invalid', new EventHub(), secrets,
      { info() {}, warn() {}, error() {} }, { background: new BackgroundGate('primary') });
    auth = adapter.dashboard()!;
    renewalStarted = deferred<void>();
    renewalResponse = deferred<Response>();
    holdRenewal = true;
    renewalSignals = [];
    renewalContexts = [];
    paths = [];
    requests = [];
    dashboardResponse = undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const path = url.pathname;
      paths.push(path);
      requests.push({ path: path + url.search, token: new Headers(init?.headers).get('authorization'),
        signal: init?.signal ?? undefined, context: deviceSignal() });
      if (path === '/auth/password-login' || path === '/auth/native/refresh') {
        if (!holdRenewal) return session();
        renewalSignals.push(init?.signal ?? undefined);
        renewalContexts.push(deviceSignal());
        renewalStarted.resolve();
        return abortOnDevice(renewalResponse.promise, init?.signal ?? undefined);
      }
      if (path === '/api/auth/me') return Response.json({ expires_at: Date.now() / 1000 + 3600 });
      const response = dashboardResponse?.(url, init);
      if (response) return response;
      if (path === '/api/sessions') return Response.json({ sessions: [] });
      if (path === '/api/config/defaults') return Response.json({ sessions: {} });
      if (path === '/api/chat/workspaces') return Response.json({ default_cwd: '/home/me' });
      throw new Error(`Unexpected request: ${path}`);
    }));
  });

  afterEach(() => {
    adapter.stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it.each([
    ['login', 'initiator', false], ['login', 'joiner', false],
    ['refresh', 'initiator', false], ['refresh', 'joiner', false],
    ['login', 'initiator', true], ['login', 'joiner', true],
    ['refresh', 'initiator', true], ['refresh', 'joiner', true],
  ])('keeps %s shared when the %s device is revoked (listing initiates: %s)', async (mode, revoked, listingInitiates) => {
    if (mode === 'refresh') {
      holdRenewal = false;
      await auth.login();
      vi.setSystemTime(Date.now() + 3_600_000);
      holdRenewal = true;
      paths = [];
      requests = [];
    }
    const initiator = new AbortController();
    const joiner = new AbortController();
    const first = withDeviceSignal(initiator.signal, () => listingInitiates ? adapter.listConversations() : adapter.listArchived(20));
    await renewalStarted.promise;
    const second = withDeviceSignal(joiner.signal, () => listingInitiates ? adapter.listArchived(20) : adapter.listConversations());
    const cancelled = revoked === 'initiator' ? first : second;
    const authorized = revoked === 'initiator' ? second : first;
    const onCancel = vi.fn();
    const onAuthorized = vi.fn();
    void cancelled.then(onCancel, onCancel);
    void authorized.then(onAuthorized, onAuthorized);

    (revoked === 'initiator' ? initiator : joiner).abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(renewalContexts).toEqual([undefined]);
    expect(renewalSignals).toHaveLength(1);
    expect(renewalSignals[0]!.aborted).toBe(false);
    expect(paths).not.toContain('/api/sessions');

    renewalResponse.resolve(mode === 'login' ? session() : Response.json({
      access_token: 'demo-refreshed-access', refresh_token: 'demo-refreshed-refresh',
      expires_at: Date.now() / 1000 + 3600,
    }));
    expect(await authorized).toEqual([]);
    await expect(cancelled).rejects.toMatchObject({ status: 403 });
    expect(paths.filter((path) => path.startsWith('/auth/'))).toEqual([
      mode === 'login' ? '/auth/password-login' : '/auth/native/refresh',
    ]);
    const token = mode === 'login' ? 'demo-access' : 'demo-refreshed-access';
    const listingCancelled = listingInitiates === (revoked === 'initiator');
    const sessions = requests.filter((request) => request.path.startsWith('/api/sessions?'));
    expect(sessions.map((request) => request.path).sort()).toEqual([
      CHAT_QUERY, listingCancelled ? ARCHIVED_QUERY : ONESHOT_QUERY,
    ].sort());
    expect(sessions.map((request) => request.token)).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
    expect(await auth.token()).toBe(token);
    expect(renewalSignals).toHaveLength(1);
  });

  it.each([
    ['chats', 'initiator'], ['chats', 'joiner'], ['one-shots', 'initiator'], ['one-shots', 'joiner'],
  ])('cancels only the revoked %s waiter when the %s device is revoked', async (stage, revoked) => {
    const started = deferred<void>();
    const response = deferred<Response>();
    const query = stage === 'chats' ? CHAT_QUERY : ONESHOT_QUERY;
    dashboardResponse = (url, init) => {
      if (url.pathname + url.search !== query) return;
      started.resolve();
      return abortOnDevice(response.promise, init?.signal ?? undefined);
    };
    const initiator = new AbortController();
    const joiner = new AbortController();
    const first = withDeviceSignal(initiator.signal, () => adapter.listConversations());
    await renewalStarted.promise;
    const second = withDeviceSignal(joiner.signal, () => adapter.listConversations());
    const cancelled = revoked === 'initiator' ? first : second;
    const authorized = revoked === 'initiator' ? second : first;
    const onCancel = vi.fn();
    const onAuthorized = vi.fn();
    void cancelled.then(onCancel, onCancel);
    void authorized.then(onAuthorized, onAuthorized);
    renewalResponse.resolve(session());
    await started.promise;
    (revoked === 'initiator' ? initiator : joiner).abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(onAuthorized).not.toHaveBeenCalled();
    const pending = requests.filter((request) => request.path === query);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.context).toBeUndefined();
    expect(pending[0]!.signal!.aborted).toBe(false);
    response.resolve(Response.json({ sessions: [{ id: 'demo-session', source: stage === 'chats' ? 'desktop' : 'oneshot',
      title: 'Example', message_count: 2, last_active: Date.now() / 1000 }] }));
    expect((await authorized).map((row) => row.id)).toEqual(['demo-session']);
    await expect(cancelled).rejects.toMatchObject({ status: 403 });
    const sessions = requests.filter((request) => request.path.startsWith('/api/sessions?'));
    expect(sessions.map((request) => request.path)).toEqual([CHAT_QUERY, ONESHOT_QUERY]);
    expect(sessions.map((request) => request.token)).toEqual(['Bearer demo-access', 'Bearer demo-access']);
    expect(renewalSignals).toHaveLength(1);
  });

  it('reuses a renewed token when a concurrent request returns a late 401', async () => {
    holdRenewal = false;
    await auth.login();
    holdRenewal = true;
    paths = [];
    requests = [];
    const lateResponse = deferred<Response>();
    const lateStarted = deferred<void>();
    dashboardResponse = (url, init) => {
      const token = new Headers(init?.headers).get('authorization');
      if (token !== 'Bearer demo-access') return;
      if (url.pathname === '/api/chat/workspaces') return Response.json({}, { status: 401 });
      if (url.searchParams.get('source') === 'oneshot') {
        lateStarted.resolve();
        return lateResponse.promise;
      }
    };
    const listing = adapter.listConversations();
    await lateStarted.promise;
    await renewalStarted.promise;
    expect(renewalSignals).toHaveLength(1);
    renewalResponse.resolve(Response.json({ access_token: 'demo-refreshed-access', refresh_token: 'demo-refreshed-refresh',
      expires_at: Date.now() / 1000 + 3600 }));
    expect(await auth.token()).toBe('demo-refreshed-access');
    await vi.advanceTimersByTimeAsync(0);
    lateResponse.resolve(Response.json({}, { status: 401 }));
    expect(await listing).toEqual([]);
    expect(paths.filter((path) => path.startsWith('/auth/'))).toEqual(['/auth/native/refresh']);
    expect(renewalSignals).toHaveLength(1);
    expect(requests.filter((request) => request.path.startsWith('/api/sessions?')).map(({ path, token }) => ({ path, token })))
      .toEqual([
        { path: CHAT_QUERY, token: 'Bearer demo-access' },
        { path: ONESHOT_QUERY, token: 'Bearer demo-access' },
        { path: ONESHOT_QUERY, token: 'Bearer demo-refreshed-access' },
      ]);
  });

  it.each(['chats', 'one-shots'])('retries the %s query once through shared refresh before finishing both listings', async (stage) => {
    holdRenewal = false;
    await auth.login();
    holdRenewal = true;
    paths = [];
    requests = [];
    const query = stage === 'chats' ? CHAT_QUERY : ONESHOT_QUERY;
    dashboardResponse = (url, init) => {
      if (url.pathname + url.search === query && new Headers(init?.headers).get('authorization') === 'Bearer demo-access') {
        return Response.json({}, { status: 401 });
      }
    };
    const first = adapter.listConversations();
    const second = adapter.listConversations();
    await renewalStarted.promise;
    const beforeRefresh = stage === 'chats' ? [CHAT_QUERY] : [CHAT_QUERY, ONESHOT_QUERY];
    expect(requests.filter((request) => request.path.startsWith('/api/sessions?')).map((request) => request.path)).toEqual(beforeRefresh);
    expect(renewalSignals).toHaveLength(1);
    renewalResponse.resolve(Response.json({ access_token: 'demo-refreshed-access', refresh_token: 'demo-refreshed-refresh',
      expires_at: Date.now() / 1000 + 3600 }));
    expect(await Promise.all([first, second])).toEqual([[], []]);
    const expected = stage === 'chats'
      ? [[CHAT_QUERY, 'demo-access'], [CHAT_QUERY, 'demo-refreshed-access'], [ONESHOT_QUERY, 'demo-refreshed-access']]
      : [[CHAT_QUERY, 'demo-access'], [ONESHOT_QUERY, 'demo-access'], [ONESHOT_QUERY, 'demo-refreshed-access']];
    expect(requests.filter((request) => request.path.startsWith('/api/sessions?')).map(({ path, token }) => [path, token]))
      .toEqual(expected.map(([path, token]) => [path, `Bearer ${token}`]));
    expect(paths.filter((path) => path.startsWith('/auth/'))).toEqual(['/auth/native/refresh']);
    expect(renewalSignals).toHaveLength(1);
  });

  it.each(['chats', 'one-shots'])('does not retry a second 401 from the %s query', async (stage) => {
    holdRenewal = false;
    await auth.login();
    holdRenewal = true;
    requests = [];
    const query = stage === 'chats' ? CHAT_QUERY : ONESHOT_QUERY;
    dashboardResponse = (url) => url.pathname + url.search === query ? Response.json({}, { status: 401 }) : undefined;
    const listing = adapter.listConversations();
    const result = stage === 'chats' ? expect(listing).rejects.toThrow() : expect(listing).resolves.toEqual([]);
    await renewalStarted.promise;
    renewalResponse.resolve(Response.json({ access_token: 'demo-refreshed-access', refresh_token: 'demo-refreshed-refresh',
      expires_at: Date.now() / 1000 + 3600 }));
    await result;
    expect(requests.filter((request) => request.path === query).map((request) => request.token))
      .toEqual(['Bearer demo-access', 'Bearer demo-refreshed-access']);
    expect(renewalSignals).toHaveLength(1);
  });

  it('shares a throttled login without starting a one-shot request or retrying the password', async () => {
    const results = Promise.allSettled([adapter.listConversations(), adapter.listConversations()]);
    await renewalStarted.promise;
    renewalResponse.resolve(Response.json({}, { status: 429 }));
    expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(paths).toEqual(['/auth/password-login']);
    expect(renewalSignals).toHaveLength(1);
  });

  it('keeps the original listing deadline while waiting for one-shots and lets a later waiter finish', async () => {
    const started = deferred<void>();
    const response = deferred<Response>();
    dashboardResponse = (url) => {
      if (url.pathname + url.search !== ONESHOT_QUERY) return;
      started.resolve();
      return response.promise;
    };
    const listing = adapter.listConversations();
    const onComplete = vi.fn();
    void listing.then(onComplete, onComplete);
    await renewalStarted.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    renewalResponse.resolve(session());
    await started.promise;
    await vi.advanceTimersByTimeAsync(24_999);
    expect(onComplete).not.toHaveBeenCalled();
    const later = adapter.listConversations();
    await vi.advanceTimersByTimeAsync(1);
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ status: 503 }));
    await expect(listing).rejects.toMatchObject({ status: 503 });
    response.resolve(Response.json({ sessions: [] }));
    expect(await later).toEqual([]);
    expect(requests.filter((request) => request.path.startsWith('/api/sessions?')).map((request) => request.path))
      .toEqual([CHAT_QUERY, ONESHOT_QUERY, CHAT_QUERY]);
    expect(renewalSignals).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an explicit device signal while authentication is pending', async () => {
    const controller = new AbortController();
    const pending = auth.json('/api/sessions?archived=only', {}, controller.signal);
    const onCancel = vi.fn();
    void pending.then(onCancel, onCancel);
    await renewalStarted.promise;
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    renewalResponse.resolve(session());
    await expect(pending).rejects.toMatchObject({ status: 403 });
    expect(await auth.token()).toBe('demo-access');
    expect(paths).not.toContain('/api/sessions');
  });

  it('checks authorization before returning a cached token', async () => {
    holdRenewal = false;
    await auth.login();
    const controller = new AbortController();
    await expect(withDeviceSignal(controller.signal, () => {
      controller.abort();
      return auth.token();
    })).rejects.toMatchObject({ status: 403 });
    expect(await auth.token()).toBe('demo-access');
  });

  it('shares a failed renewal and retries instead of caching its error', async () => {
    const results = Promise.allSettled([auth.token(), auth.token()]);
    await renewalStarted.promise;
    expect(renewalSignals).toHaveLength(1);
    renewalResponse.resolve(Response.json({}, { status: 503 }));
    expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    renewalResponse = deferred<Response>();
    const retry = auth.token();
    expect(renewalSignals).toHaveLength(2);
    renewalResponse.resolve(session());
    expect(await retry).toBe('demo-access');
  });
});
