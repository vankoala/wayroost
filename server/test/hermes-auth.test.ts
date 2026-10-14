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
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname;
      paths.push(path);
      if (path === '/auth/password-login' || path === '/auth/native/refresh') {
        if (!holdRenewal) return session();
        renewalSignals.push(init?.signal ?? undefined);
        renewalContexts.push(deviceSignal());
        renewalStarted.resolve();
        return abortOnDevice(renewalResponse.promise, init?.signal ?? undefined);
      }
      if (path === '/api/auth/me') return Response.json({ expires_at: Date.now() / 1000 + 3600 });
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
    ['login', 'initiator'], ['login', 'joiner'], ['refresh', 'initiator'], ['refresh', 'joiner'],
  ])('keeps %s shared when the %s device is revoked', async (mode, revoked) => {
    if (mode === 'refresh') {
      holdRenewal = false;
      await auth.login();
      vi.setSystemTime(Date.now() + 3_600_000);
      holdRenewal = true;
      paths = [];
    }
    const initiator = new AbortController();
    const joiner = new AbortController();
    const archived = withDeviceSignal(initiator.signal, () => adapter.listArchived(20));
    await renewalStarted.promise;
    const listing = withDeviceSignal(joiner.signal, () => adapter.listConversations());
    const cancelled = revoked === 'initiator' ? archived : listing;
    const authorized = revoked === 'initiator' ? listing : archived;
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

    renewalResponse.resolve(mode === 'login' ? session() : Response.json({
      access_token: 'demo-refreshed-access', refresh_token: 'demo-refreshed-refresh',
      expires_at: Date.now() / 1000 + 3600,
    }));
    expect(await authorized).toEqual([]);
    await expect(cancelled).rejects.toMatchObject({ status: 403 });
    expect(paths.filter((path) => path.startsWith('/auth/'))).toEqual([
      mode === 'login' ? '/auth/password-login' : '/auth/native/refresh',
    ]);
    expect(paths.filter((path) => path === '/api/sessions')).toHaveLength(revoked === 'initiator' ? 1 : 2);
    expect(await auth.token()).toBe(mode === 'login' ? 'demo-access' : 'demo-refreshed-access');
    expect(renewalSignals).toHaveLength(1);
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
