import { createECDH } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BackgroundGate } from '../src/background.js';
import { PushSender } from '../src/feed/push.js';
import { Feed } from '../src/feed/service.js';
import { FeedStore } from '../src/feed/store.js';
import { makeApp, makeKeys, makeToken, PHONE_COOKIE, postHeaders, TEST_DESKTOP, TEST_PHONE, type Keys } from './helpers.js';

const browserApi = vi.hoisted(() => ({ pushAddDevice: vi.fn() }));
vi.mock('../../web/src/api.js', () => ({ api: browserApi }));

const log = { info() {}, warn() {} };
const message = { title: 'Approval waiting', body: 'Demo approval', url: '/', tag: 'demo', ttl: 60, urgency: 'normal' as const };
const cleanups: Array<() => Promise<unknown>> = [];
let keys: Keys;
let token: string;
let pushState: () => Promise<string>;
beforeAll(async () => {
  keys = await makeKeys(); token = await makeToken(keys);
  const webPush: string = fileURLToPath(new URL('../../web/src/push.ts', import.meta.url));
  ({ pushState } = (await import(/* @vite-ignore */ webPush)) as { pushState: typeof pushState });
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  browserApi.pushAddDevice.mockReset();
  vi.unstubAllGlobals();
});

async function setup(configExtra: Record<string, unknown> = {}, legacy = false) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 201 }));
  const browser = createECDH('prime256v1');
  browser.generateKeys();
  const subscription = (suffix: string) => ({
    endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`,
    keys: { p256dh: browser.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') },
  });
  let push!: PushSender;
  let state!: string;
  let originalKey!: string;
  const ctx = await makeApp(keys, {
    configExtra,
    feed: ({ stateDir, hub, hermes }) => {
      state = stateDir;
      push = new PushSender(state, 'https://wayroost.example.com', log, fetch as typeof globalThis.fetch, new BackgroundGate('primary'));
      originalKey = push.publicKey();
      if (legacy) {
        const input = subscription('demo-legacy');
        const path = join(state, 'push.json');
        const saved = JSON.parse(readFileSync(path, 'utf8'));
        saved.devices = [{ endpoint: input.endpoint, ...input.keys, createdAt: 1_700_000_000_000 }];
        writeFileSync(path, JSON.stringify(saved));
        push = new PushSender(state, 'https://wayroost.example.com', log, fetch as typeof globalThis.fetch, new BackgroundGate('primary'));
      }
      return new Feed({ store: new FeedStore(state), hub, hermes, push, log });
    },
  });
  cleanups.push(async () => { await ctx.app.close(); rmSync(state, { recursive: true, force: true }); });
  const subscribe = (suffix: string, cookie?: string, extra = {}) => ctx.app.inject({
    method: 'POST', url: '/api/push/devices', headers: postHeaders(token, cookie ? { cookie } : {}),
    payload: { ...subscription(suffix), ...extra },
  });
  return { ...ctx, push, fetch, state, subscription, subscribe, originalKey };
}

function browserSubscription(input: { endpoint: string; keys: { p256dh: string; auth: string } } | null, permission = 'granted') {
  const unsubscribe = vi.fn(async () => true);
  const subscribe = vi.fn();
  const requestPermission = vi.fn();
  const register = vi.fn();
  vi.stubGlobal('navigator', {
    userAgent: 'Demo browser', platform: 'Linux', maxTouchPoints: 0,
    serviceWorker: {
      getRegistration: vi.fn(async () => ({ pushManager: {
        getSubscription: vi.fn(async () => input ? { endpoint: input.endpoint, toJSON: () => input, unsubscribe } : null), subscribe,
      } })), register,
    },
  });
  vi.stubGlobal('window', { isSecureContext: true, PushManager: {}, Notification: {} });
  vi.stubGlobal('Notification', { permission, requestPermission });
  return { unsubscribe, subscribe, requestPermission, register };
}

describe('browser subscription recovery', () => {
  it('registers an existing subscription with its paired session after migration before reporting on', async () => {
    const { app, push, fetch, state, subscription, originalKey } = await setup({}, true);
    const input = subscription('demo-legacy');
    const browser = browserSubscription(input);
    expect(push.publicKey()).toBe(originalKey);
    expect(push.devices()).toBe(0);
    expect(await push.send(message)).toEqual({ sent: 0, failed: 0, removed: 0 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    browserApi.pushAddDevice.mockImplementation(async payload => {
      await gate;
      const response = await app.inject({ method: 'POST', url: '/api/push/devices', headers: postHeaders(token, { cookie: PHONE_COOKIE }), payload });
      if (response.statusCode !== 200) throw new Error('registration failed');
      return response.json();
    });
    let settled = false;
    const pending = pushState().then(state => { settled = true; return state; });
    try {
      await vi.waitFor(() => expect(browserApi.pushAddDevice).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      expect(push.devices()).toBe(0);
    } finally { release(); }
    expect(await pending).toBe('on');
    expect(JSON.parse(readFileSync(join(state, 'push.json'), 'utf8')).devices).toMatchObject([{ deviceId: TEST_PHONE.id, endpoint: input.endpoint }]);
    expect(await push.send(message)).toEqual({ sent: 1, failed: 0, removed: 0 });
    expect(fetch).toHaveBeenCalledOnce();
    for (const action of Object.values(browser)) expect(action).not.toHaveBeenCalled();
  });

  it('reports off after a failed registration and retries the existing subscription without prompting', async () => {
    const { push, subscribe, subscription } = await setup({}, true);
    const browser = browserSubscription(subscription('demo-legacy'));
    browserApi.pushAddDevice.mockRejectedValueOnce(new Error('network unavailable')).mockImplementation(async () => {
      const response = await subscribe('demo-legacy', PHONE_COOKIE);
      if (response.statusCode !== 200) throw new Error('registration failed');
      return response.json();
    });
    expect(await pushState()).toBe('off');
    expect(push.devices()).toBe(0);
    expect(await pushState()).toBe('on');
    expect(push.devices()).toBe(1);
    expect(browserApi.pushAddDevice).toHaveBeenCalledTimes(2);
    for (const action of Object.values(browser)) expect(action).not.toHaveBeenCalled();
  });

  it('reports off when the existing subscription cannot be registered by a revoked pairing', async () => {
    const { devices, push, fetch, subscribe, subscription } = await setup({}, true);
    browserSubscription(subscription('demo-legacy'));
    expect(devices!.revoke(TEST_PHONE.id)).toBe(true);
    browserApi.pushAddDevice.mockImplementation(async () => {
      const response = await subscribe('demo-legacy', PHONE_COOKIE);
      expect(response.statusCode).toBe(403);
      throw new Error('device is no longer paired');
    });
    expect(await pushState()).toBe('off');
    expect(browserApi.pushAddDevice).toHaveBeenCalledOnce();
    expect(await push.send(message)).toEqual({ sent: 0, failed: 0, removed: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['granted', 'denied'])('does not register or prompt when there is no subscription (permission %s)', async permission => {
    const browser = browserSubscription(null, permission);
    expect(await pushState()).toBe(permission === 'denied' ? 'denied' : 'off');
    expect(browserApi.pushAddDevice).not.toHaveBeenCalled();
    for (const action of Object.values(browser)) expect(action).not.toHaveBeenCalled();
  });
});

describe('push subscriptions belong to paired devices', () => {
  it.each([false, true])('forgets every subscription on revocation (self %s)', async (self) => {
    const { app, devices, push, fetch, state, subscribe, subscription } = await setup();
    expect((await subscribe('demo-phone', PHONE_COOKIE, { deviceId: TEST_DESKTOP.id })).statusCode).toBe(200);
    expect((await subscribe('demo-phone-tab', PHONE_COOKIE)).statusCode).toBe(200);
    expect((await subscribe('demo-desktop')).statusCode).toBe(200);
    const headers = postHeaders(token, self ? { cookie: PHONE_COOKIE } : {});
    delete headers['content-type'];
    const revoked = await app.inject({ method: 'DELETE', url: `/api/devices/${TEST_PHONE.id}`, headers });
    expect(revoked.statusCode).toBe(200);
    expect(devices!.get(TEST_PHONE.id)).toBeUndefined();
    expect(push.devices()).toBe(1);
    const saved = JSON.parse(readFileSync(join(state, 'push.json'), 'utf8'));
    expect(saved.devices).toMatchObject([{ deviceId: TEST_DESKTOP.id, endpoint: subscription('demo-desktop').endpoint }]);
    expect(await push.send(message)).toEqual({ sent: 1, failed: 0, removed: 0 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toBe(subscription('demo-desktop').endpoint);
  });

  it('invalidates stored subscriptions without an owner while keeping the notification key', async () => {
    const { push, fetch, state, subscribe, devices } = await setup();
    expect((await subscribe('demo-legacy', PHONE_COOKIE)).statusCode).toBe(200);
    expect((await subscribe('demo-current')).statusCode).toBe(200);
    const path = join(state, 'push.json');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    delete saved.devices[0].deviceId;
    writeFileSync(path, JSON.stringify(saved));
    const reloaded = new PushSender(state, 'https://wayroost.example.com', log, fetch as typeof globalThis.fetch, new BackgroundGate('primary'));
    reloaded.bindDevices(devices);
    expect(reloaded.publicKey()).toBe(push.publicKey());
    expect(reloaded.devices()).toBe(1);
    expect(await reloaded.send(message)).toEqual({ sent: 1, failed: 0, removed: 0 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(path, 'utf8')).devices).toMatchObject([{ deviceId: TEST_DESKTOP.id }]);
  });

  it('keeps a subscription active when revocation cannot be saved', async () => {
    const { devices, push, fetch, state, subscribe } = await setup();
    expect((await subscribe('demo-phone', PHONE_COOKIE)).statusCode).toBe(200);
    rmSync(join(state, 'devices.json'));
    mkdirSync(join(state, 'devices.json'));
    expect(() => devices!.revoke(TEST_PHONE.id)).toThrow();
    expect(devices!.get(TEST_PHONE.id)).toBeDefined();
    expect(push.devices()).toBe(1);
    expect(await push.send(message)).toEqual({ sent: 1, failed: 0, removed: 0 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('invalidates legacy subscriptions in memory even when migration cannot be saved', async () => {
    const { devices, push, fetch, state, subscribe } = await setup();
    expect((await subscribe('demo-legacy', PHONE_COOKIE)).statusCode).toBe(200);
    expect((await subscribe('demo-current')).statusCode).toBe(200);
    const path = join(state, 'push.json');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    delete saved.devices[0].deviceId;
    writeFileSync(path, JSON.stringify(saved));
    mkdirSync(join(state, 'push.json.tmp'));
    const reloaded = new PushSender(state, 'https://wayroost.example.com', log, fetch as typeof globalThis.fetch, new BackgroundGate('primary'));
    reloaded.bindDevices(devices);
    expect(reloaded.publicKey()).toBe(push.publicKey());
    expect(reloaded.devices()).toBe(1);
    expect(await reloaded.send(message)).toEqual({ sent: 1, failed: 0, removed: 0 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('filters a revoked owner after a failed cleanup write and a restart', async () => {
    const { devices, push, fetch, state, subscribe } = await setup();
    expect((await subscribe('demo-phone', PHONE_COOKIE)).statusCode).toBe(200);
    const blocker = join(state, 'push.json.tmp');
    mkdirSync(blocker);
    expect(devices!.revoke(TEST_PHONE.id)).toBe(true);
    expect(push.devices()).toBe(0);
    expect(await push.send(message)).toEqual({ sent: 0, failed: 0, removed: 0 });
    expect(JSON.parse(readFileSync(join(state, 'push.json'), 'utf8')).devices).toHaveLength(1);
    rmSync(blocker, { recursive: true });
    const reloaded = new PushSender(state, 'https://wayroost.example.com', log, fetch as typeof globalThis.fetch, new BackgroundGate('primary'));
    reloaded.bindDevices(devices);
    expect(reloaded.devices()).toBe(0);
    expect(await reloaded.send(message)).toEqual({ sent: 0, failed: 0, removed: 1 });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(state, 'push.json'), 'utf8')).devices).toEqual([]);
  });

  it('preserves a re-paired subscription while stale-owner cleanup waits for another send', async () => {
    const { devices, fetch, state, subscribe, subscription } = await setup();
    expect((await subscribe('demo-phone', PHONE_COOKIE)).statusCode).toBe(200);
    expect((await subscribe('demo-desktop')).statusCode).toBe(200);
    const blocker = join(state, 'push.json.tmp');
    mkdirSync(blocker);
    expect(devices!.revoke(TEST_PHONE.id)).toBe(true);
    expect(JSON.parse(readFileSync(join(state, 'push.json'), 'utf8')).devices).toHaveLength(2);
    rmSync(blocker, { recursive: true });
    const reloaded = new PushSender(state, 'https://wayroost.example.com', log, fetch as typeof globalThis.fetch, new BackgroundGate('primary'));
    reloaded.bindDevices(devices);
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const ready = new Promise<void>(resolve => { finish = resolve; });
    fetch.mockImplementationOnce(async () => {
      entered();
      await ready;
      return new Response(null, { status: 201 });
    });
    const pending = reloaded.send(message);
    const input = subscription('demo-phone');
    let owner!: string;
    try {
      await started;
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]![0]).toBe(subscription('demo-desktop').endpoint);
      owner = devices!.add('Demo phone', 'phone').device.id;
      expect(reloaded.add(input, owner)).toBe(2);
      finish();
      expect(await pending).toEqual({ sent: 1, failed: 0, removed: 0 });
    } finally { finish(); await pending; }
    expect(reloaded.devices()).toBe(2);
    expect(JSON.parse(readFileSync(join(state, 'push.json'), 'utf8')).devices).toMatchObject([
      { deviceId: TEST_DESKTOP.id, endpoint: subscription('demo-desktop').endpoint },
      { deviceId: owner, endpoint: input.endpoint },
    ]);
    expect(await reloaded.send(message)).toEqual({ sent: 2, failed: 0, removed: 0 });
    expect(fetch.mock.calls.map(call => call[0])).toContain(input.endpoint);
  });

  it.each([404, 410])('preserves an identical new registration when an earlier send returns %s', async status => {
    const { push, fetch, state, subscription } = await setup();
    const input = subscription('demo-phone');
    const now = 1_700_000_000_000;
    expect(push.add(input, TEST_PHONE.id, now)).toBe(1);
    const saved = JSON.parse(readFileSync(join(state, 'push.json'), 'utf8'));
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const ready = new Promise<void>(resolve => { finish = resolve; });
    fetch.mockImplementationOnce(async () => {
      entered();
      await ready;
      return new Response(null, { status });
    });
    const pending = push.send(message);
    try {
      await started;
      expect(push.add(input, TEST_PHONE.id, now)).toBe(1);
      finish();
      expect(await pending).toEqual({ sent: 0, failed: 0, removed: 0 });
    } finally { finish(); await pending; }
    expect(push.devices()).toBe(1);
    expect(JSON.parse(readFileSync(join(state, 'push.json'), 'utf8'))).toEqual(saved);
    expect(await push.send(message)).toEqual({ sent: 1, failed: 0, removed: 0 });
  });

  it('aborts a background notification when its recipient is revoked during the send', async () => {
    const { devices, push, fetch, subscribe } = await setup();
    expect((await subscribe('demo-phone', PHONE_COOKIE)).statusCode).toBe(200);
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const ready = new Promise<void>((resolve) => { finish = resolve; });
    let signal: AbortSignal | null | undefined;
    fetch.mockImplementationOnce(async (_url, init) => {
      signal = init?.signal;
      entered();
      await ready;
      return new Response(null, { status: 201 });
    });
    const pending = push.send(message);
    try {
      await started;
      expect(signal?.aborted).toBe(false);
      expect(devices!.revoke(TEST_PHONE.id)).toBe(true);
      expect(signal?.aborted).toBe(true);
      finish();
      expect(await pending).toEqual({ sent: 0, failed: 1, removed: 0 });
      expect(push.devices()).toBe(0);
    } finally { finish(); await pending; }
  });

  it('lets a browser remove only subscriptions owned by its pairing', async () => {
    const { app, subscribe, subscription, push } = await setup();
    expect((await subscribe('demo-desktop')).statusCode).toBe(200);
    const endpoint = subscription('demo-desktop').endpoint;
    const remove = (cookie?: string) => app.inject({ method: 'POST', url: '/api/push/devices/remove',
      headers: postHeaders(token, cookie ? { cookie } : {}), payload: { endpoint } });
    expect((await remove(PHONE_COOKIE)).json()).toEqual({ devices: 1 });
    expect(push.devices()).toBe(1);
    expect((await remove()).json()).toEqual({ devices: 0 });
  });

  it('refuses a subscription when device sign-in is disabled', async () => {
    const { subscribe, push } = await setup({ devices: { enabled: false } });
    expect((await subscribe('demo-unpaired')).statusCode).toBe(403);
    expect(push.devices()).toBe(0);
  });
});
