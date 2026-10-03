import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { WS_CLOSE_DEVICE_REVOKED, type ServerEvent } from '../../shared/protocol.js';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import {
  DEVICE_COOKIE,
  Devices,
  DevicesFileError,
  PAIRING_CODE_TTL_MS,
  PairingRefused,
  deviceKind,
} from '../src/devices.js';
import { EventHub } from '../src/hub.js';
import type { SpeechService } from '../src/speech.js';
import { pairingSocketPath, requestRecoveryCode, startPairingSocket } from '../src/pairing-socket.js';
import { createAccessVerifier } from '../src/security/access.js';
import {
  AUD,
  DESKTOP_COOKIE,
  EMAIL,
  FakeHermes,
  FakePaseo,
  ISSUER,
  ORIGIN,
  PHONE_COOKIE,
  TEST_DESKTOP,
  TEST_PHONE,
  makeKeys,
  makeStaticDir,
  makeToken,
  seedDevices,
  type Keys,
} from './helpers.js';

const LOCAL = 'http://127.0.0.1:8881';
const TAILNET = 'https://box.tailnet.example';
const PUBLIC_HOST = new URL(ORIGIN).host;
const COOKIE_RE = /^wr_device=(dv_[a-f0-9]{24})\.([A-Za-z0-9_-]{43}); Max-Age=34560000; Path=\/; HttpOnly; SameSite=Strict(; Secure)?$/;

let keys: Keys;
let token: string;
const cleanups: Array<() => unknown> = [];

beforeAll(async () => {
  keys = await makeKeys();
  token = await makeToken(keys);
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A clock the tests move by hand. */
function clock() {
  let t = Date.now();
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

async function build(
  options: {
    access?: boolean;
    publicOrigin?: string;
    origins?: string[];
    now?: () => number;
    logs?: string[];
    staticDir?: string;
    speech?: SpeechService;
  } = {},
) {
  const stateDir = mkdtempSync(join(tmpdir(), 'sb-devices-'));
  seedDevices(stateDir);
  const withAccess = options.access !== false;
  const config = parseConfig({
    listen: { host: '127.0.0.1', port: 8881 },
    publicOrigin: options.publicOrigin ?? ORIGIN,
    origins: options.origins ?? [LOCAL, TAILNET],
    ...(withAccess ? { access: { teamDomain: ISSUER, aud: AUD, allowedEmails: [EMAIL] } } : {}),
    stateDir,
    ...(options.staticDir ? { staticDir: options.staticDir } : {}),
  });
  const devices = new Devices(stateDir, options.now ? { now: options.now } : {});
  const hub = new EventHub();
  const app = await buildApp({
    config,
    ...(withAccess ? { verifier: createAccessVerifier({ ...config.access!, keySource: keys.keySource }) } : {}),
    devices,
    hub,
    sources: { hermes: new FakeHermes(), paseo: new FakePaseo() },
    ...(options.speech ? { speech: options.speech } : {}),
    logger: options.logs ? { level: 'trace', stream: { write: (line: string) => void options.logs!.push(line) } } : false,
  });
  cleanups.push(() => app.close());
  return { app, config, devices, stateDir, hub };
}

/** What our frontend sends through the public origin (Cloudflare adds the token). */
function publicHeaders(cookie: string | null, extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: PUBLIC_HOST,
    'cf-access-jwt-assertion': token,
    'x-wayroost-request': '1',
    'sec-fetch-site': 'same-origin',
    ...(cookie ? { cookie } : {}),
    ...extra,
  };
}
const publicPost = (cookie: string | null, extra: Record<string, string> = {}) =>
  publicHeaders(cookie, { origin: ORIGIN, 'content-type': 'application/json', ...extra });
/** DELETE has no body, so no content type. */
const publicDelete = (cookie: string) => publicHeaders(cookie, { origin: ORIGIN });

/** What the PC's own desktop app sends on the local origin: no Access, its app header, a device cookie. */
function localHeaders(cookie: string | null, extra: Record<string, string> = {}): Record<string, string> {
  return { host: '127.0.0.1:8881', 'x-wayroost-request': '1', 'x-wayroost-app': 'desktop', ...(cookie ? { cookie } : {}), ...extra };
}
/** What a browser on the PC sends on the local origin: the same, without the desktop app's header. */
function browserLocalHeaders(cookie: string | null, extra: Record<string, string> = {}): Record<string, string> {
  const { 'x-wayroost-app': _app, ...headers } = localHeaders(cookie, extra);
  return headers;
}
const localPost = (cookie: string | null, extra: Record<string, string> = {}) =>
  localHeaders(cookie, { origin: LOCAL, 'content-type': 'application/json', ...extra });

type App = Awaited<ReturnType<typeof build>>['app'];

function pair(app: App, body: Record<string, unknown>, headers = publicPost(null)) {
  return app.inject({ method: 'POST', url: '/api/pair', headers, payload: JSON.stringify(body) });
}

function offer(app: App, kind: 'phone' | 'desktop' = 'phone', cookie = DESKTOP_COOKIE) {
  return app.inject({ method: 'POST', url: '/api/pair/offer', headers: publicPost(cookie), payload: JSON.stringify({ kind }) });
}

const cookieOf = (setCookie: unknown) => String(setCookie).split(';')[0]!;

describe('pairing', () => {
  it('pairs a phone from a desktop offer, sets a strict cookie and stores only a hash', async () => {
    const { app, stateDir } = await build();
    const made = await offer(app);
    expect(made.statusCode).toBe(200);
    const { code, url, kind, expiresAt } = made.json();
    expect(code).toMatch(/^[a-z2-7]{26}$/); // 128 bits of base32
    expect(url).toBe(`${ORIGIN}/pair#${code}`);
    expect(kind).toBe('phone');
    expect(expiresAt - Date.now()).toBeGreaterThan(PAIRING_CODE_TTL_MS - 5_000);

    const res = await pair(app, { code, name: 'Test phone two' });
    expect(res.statusCode).toBe(200);
    const match = COOKIE_RE.exec(String(res.headers['set-cookie']));
    expect(match?.[3]).toBe('; Secure'); // an https origin
    expect(res.json()).toEqual({ device: expect.objectContaining({ id: match![1], name: 'Test phone two', kind: 'phone' }) });
    expect(res.body).not.toContain(match![2]!);
    expect(res.body).not.toContain('secretHash');

    // The new cookie signs in.
    const me = await app.inject({ url: '/api/me', headers: publicHeaders(cookieOf(res.headers['set-cookie'])) });
    expect(me.json()).toMatchObject({ email: EMAIL, device: { id: match![1], kind: 'phone' } });

    // Only the hash is kept, in a private file replaced whole (no temp files left).
    const file = readFileSync(join(stateDir, 'devices.json'), 'utf8');
    expect(statSync(join(stateDir, 'devices.json')).mode & 0o777).toBe(0o600);
    expect(file).not.toContain(match![2]!);
    expect(file).toContain(createHash('sha256').update(match![2]!).digest('hex'));
    expect(readdirSync(stateDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('accepts a typed code with capitals, spaces and dashes', async () => {
    const { app, devices } = await build();
    const { code } = devices.createCode('desktop');
    const typed = code.toUpperCase().match(/.{1,4}/g)!.join(' - ');
    const res = await pair(app, { code: typed, name: 'Laptop' });
    expect(res.statusCode).toBe(200);
    expect(res.json().device.kind).toBe('desktop');
  });

  it('refuses expired, reused and wrong codes alike', async () => {
    const time = clock();
    const { app, devices } = await build({ now: time.now });
    const old = devices.createCode('phone').code;
    time.advance(PAIRING_CODE_TTL_MS + 1);
    const expired = await pair(app, { code: old, name: 'Late phone' });
    expect(expired.statusCode).toBe(403);
    expect(expired.json().error).toMatch(/isn't valid any more/);

    const once_ = devices.createCode('phone').code;
    expect((await pair(app, { code: once_, name: 'First' })).statusCode).toBe(200);
    expect((await pair(app, { code: once_, name: 'Second' })).statusCode).toBe(403);

    expect((await pair(app, { code: 'a'.repeat(26), name: 'Guess' })).statusCode).toBe(403);
    expect((await pair(app, { code: 'not a code', name: 'Guess' })).statusCode).toBe(403);
    // A phone's code can't make a desktop (and is used up by trying).
    const phoneCode = devices.createCode('phone').code;
    expect((await pair(app, { code: phoneCode, name: 'Sneaky', kind: 'desktop' })).statusCode).toBe(403);
    expect((await pair(app, { code: phoneCode, name: 'Sneaky' })).statusCode).toBe(403);
    // Bodies are checked before anything else.
    expect((await pair(app, { code: 'x', name: 'Bad\u0007name' })).statusCode).toBe(400);
    expect((await pair(app, { code: 'x', name: 'n', extra: 1 })).statusCode).toBe(400);
    expect(devices.size).toBe(3); // the two test devices and "First"
  });

  it("voids the codes a desktop asked for when it's revoked", async () => {
    const { app } = await build();
    // A second desktop, paired from the test desktop's offer.
    const second = await pair(app, { code: (await offer(app, 'desktop')).json().code, name: 'Second desktop' });
    expect(second.statusCode).toBe(200);
    const secondCookie = cookieOf(second.headers['set-cookie']);
    const secondId = second.json().device.id as string;
    const phoneCode = (await offer(app, 'phone', secondCookie)).json().code as string;
    const desktopCode = (await offer(app, 'desktop', secondCookie)).json().code as string;
    const keptCode = (await offer(app, 'phone')).json().code as string;

    const revoked = await app.inject({ method: 'DELETE', url: `/api/devices/${secondId}`, headers: publicDelete(DESKTOP_COOKIE) });
    expect(revoked.statusCode).toBe(200);
    for (const code of [desktopCode, phoneCode]) {
      const res = await pair(app, { code, name: 'Back again' });
      expect(res.statusCode, code).toBe(403);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    // Codes from other devices are untouched.
    expect((await pair(app, { code: keptCode, name: 'Kitchen phone' })).statusCode).toBe(200);
  });

  it('refuses a code whose issuing device is gone, even if it was revoked outside the store', () => {
    const store = new Devices(mkdtempSync(join(tmpdir(), 'sb-devices-')));
    const desktop = store.add('Desktop', 'desktop');
    const { code } = store.createCode('phone', { issuer: desktop.device.id });
    // Store damage or a future code path that skips revoke(): the code still checks its issuer.
    (store as unknown as { devices: Map<string, unknown> }).devices.delete(desktop.device.id);
    expect(() => store.pair(code, 'Phone')).toThrow(PairingRefused);
  });

  it('allows 10 attempts a minute', async () => {
    const time = clock();
    const { app, devices } = await build({ now: time.now });
    for (let i = 0; i < 10; i++) expect((await pair(app, { code: 'b'.repeat(26), name: 'Guess' })).statusCode).toBe(403);
    const good = devices.createCode('phone').code;
    const limited = await pair(app, { code: good, name: 'Real phone' });
    expect(limited.statusCode).toBe(429);
    time.advance(61_000);
    expect((await pair(app, { code: good, name: 'Real phone' })).statusCode).toBe(200);
  });

  it('locks after 20 failures in an hour until a paired desktop unlocks it', async () => {
    const time = clock();
    const { app, devices, stateDir } = await build({ now: time.now });
    for (let i = 0; i < 20; i++) {
      if (i && i % 10 === 0) time.advance(61_000);
      expect((await pair(app, { code: 'c'.repeat(26), name: 'Guess' })).statusCode).toBe(403);
    }
    const good = devices.createCode('phone').code;
    const locked = await pair(app, { code: good, name: 'Real phone' });
    expect(locked.statusCode).toBe(423);
    expect(locked.json().error).toMatch(/locked/);
    // The lock survives a restart.
    expect(new Devices(stateDir).pairingLocked()).toBe(true);
    const list = await app.inject({ url: '/api/devices', headers: publicHeaders(DESKTOP_COOKIE) });
    expect(list.json().pairingLocked).toBe(true);

    const unlock = (cookie: string) => app.inject({ method: 'DELETE', url: '/api/pair/lock', headers: publicDelete(cookie) });
    expect((await unlock(PHONE_COOKIE)).statusCode).toBe(403);
    expect((await unlock(DESKTOP_COOKIE)).statusCode).toBe(200);
    expect((await pair(app, { code: good, name: 'Real phone' })).statusCode).toBe(200);
  });

  it('forgets failures older than an hour, and root\'s recovery code lifts a lock', async () => {
    const time = clock();
    const store = new Devices(mkdtempSync(join(tmpdir(), 'sb-devices-')), { now: time.now });
    const fail = () => expect(() => store.pair('d'.repeat(26), 'Guess')).toThrow(PairingRefused);
    for (let i = 0; i < 19; i++) {
      if (i % 9 === 0) time.advance(61_000);
      fail();
    }
    time.advance(61 * 60_000);
    fail();
    expect(store.pairingLocked()).toBe(false);
    for (let i = 0; i < 19; i++) {
      if (i % 9 === 0) time.advance(61_000);
      fail();
    }
    expect(store.pairingLocked()).toBe(true);
    const { code } = store.createCode('desktop', { recovery: true });
    expect(store.pairingLocked()).toBe(false);
    expect(store.pair(code, 'Rescued desktop').device.kind).toBe('desktop');
  });

  it('sets Secure on https origins and leaves it off only on a loopback http origin', async () => {
    const { app, devices } = await build();
    const local = await pair(app, { code: devices.createCode('desktop').code, name: 'This PC' }, localPost(null));
    expect(local.statusCode).toBe(200);
    expect(COOKIE_RE.exec(String(local.headers['set-cookie']))?.[3]).toBeUndefined();
    const tailnet = await pair(
      app,
      { code: devices.createCode('phone').code, name: 'Tailnet phone' },
      publicPost(null, { host: new URL(TAILNET).host, origin: TAILNET }),
    );
    expect(tailnet.statusCode).toBe(200);
    expect(COOKIE_RE.exec(String(tailnet.headers['set-cookie']))?.[3]).toBe('; Secure');
  });

  it('renews the cookie on use, at most hourly, and clears a cookie that no longer works', async () => {
    const time = clock();
    const { app, devices } = await build({ now: time.now });
    const first = await app.inject({ url: '/api/me', headers: publicHeaders(DESKTOP_COOKIE) });
    expect(cookieOf(first.headers['set-cookie'])).toBe(DESKTOP_COOKIE);
    expect(String(first.headers['set-cookie'])).toContain('Max-Age=34560000');
    const again = await app.inject({ url: '/api/me', headers: publicHeaders(DESKTOP_COOKIE) });
    expect(again.headers['set-cookie']).toBeUndefined();
    time.advance(61 * 60_000);
    const later = await app.inject({ url: '/api/me', headers: publicHeaders(DESKTOP_COOKIE) });
    expect(cookieOf(later.headers['set-cookie'])).toBe(DESKTOP_COOKIE);
    expect(devices.get(TEST_DESKTOP.id)!.lastSeen).toBe(time.now());

    for (const bad of [`${TEST_DESKTOP.id}.${'x'.repeat(43)}`, `dv_${'f'.repeat(24)}.${'x'.repeat(43)}`]) {
      const res = await app.inject({ url: '/api/me', headers: publicHeaders(`${DEVICE_COOKIE}=${bad}`) });
      expect(res.statusCode, bad).toBe(401);
      expect(res.json()).toEqual({ error: 'unpaired' });
      expect(String(res.headers['set-cookie'])).toMatch(/^wr_device=; Max-Age=0;/);
    }
  });

  it('leaves the renewal to the next HTTP call when a WebSocket upgrade comes first', async () => {
    const time = clock();
    const { app, config } = await build({ now: time.now });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    config.allowedHosts.add(`127.0.0.1:${port}`);
    expect(cookieOf((await app.inject({ url: '/api/me', headers: publicHeaders(DESKTOP_COOKIE) })).headers['set-cookie'])).toBe(
      DESKTOP_COOKIE,
    );
    time.advance(61 * 60_000);
    // An hour on, the app reconnects its socket before anything else.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin: ORIGIN, 'cf-access-jwt-assertion': token, cookie: DESKTOP_COOKIE },
    });
    ws.on('error', () => {});
    cleanups.push(() => ws.terminate());
    await once(ws, 'message'); // hello
    const next = await app.inject({ url: '/api/me', headers: publicHeaders(DESKTOP_COOKIE) });
    expect(cookieOf(next.headers['set-cookie'])).toBe(DESKTOP_COOKIE);
  });

  it("clears a stale cookie only when it's the only one and has our shape", async () => {
    const { app } = await build();
    const stale = `${DEVICE_COOKIE}=${TEST_DESKTOP.id}.${'x'.repeat(43)}`;
    // Another site on the same host can add wr_device cookies with a narrower
    // Path; a Path=/ clear would then delete the real one. So: no clear.
    for (const cookie of [`${DEVICE_COOKIE}=garbage`, `${stale}; ${stale}`, `${DEVICE_COOKIE}=garbage; ${stale}`]) {
      const res = await app.inject({ url: '/api/me', headers: publicHeaders(cookie) });
      expect(res.statusCode, cookie).toBe(401);
      expect(res.headers['set-cookie'], cookie).toBeUndefined();
    }
    // Planted extras don't push the real cookie out of the ones looked at, as long as it's within the first three.
    const real = await app.inject({ url: '/api/me', headers: publicHeaders(`${stale}; ${DESKTOP_COOKIE}`) });
    expect(real.statusCode).toBe(200);
  });
});

describe('a pairing link past the QR encoder', () => {
  it('is accepted by the config, and the page gets null (its link-and-code fallback), not a crash', async () => {
    // web/src/qr.ts, loaded at run time: it follows the browser build's import rules.
    const qrModule = fileURLToPath(new URL('../../web/src/qr.ts', import.meta.url));
    const { tryEncodeQr, QR_MAX_BYTES } = (await import(/* @vite-ignore */ qrModule)) as {
      tryEncodeQr: (text: string) => unknown;
      QR_MAX_BYTES: number;
    };
    // A valid hostname: three 63-character labels under example.com.
    const longOrigin = `https://${['a', 'b', 'c'].map((c) => c.repeat(63)).join('.')}.example.com`;
    const { app } = await build({ access: false, publicOrigin: longOrigin });
    const res = await app.inject({
      method: 'POST',
      url: '/api/pair/offer',
      headers: {
        host: new URL(longOrigin).host,
        origin: longOrigin,
        'x-wayroost-request': '1',
        'content-type': 'application/json',
        cookie: DESKTOP_COOKIE,
      },
      payload: '{"kind":"phone"}',
    });
    expect(res.statusCode).toBe(200);
    const { url } = res.json() as { url: string };
    expect(new TextEncoder().encode(url).length).toBeGreaterThan(QR_MAX_BYTES);
    expect(tryEncodeQr(url)).toBeNull();
    // An ordinary link still gets its code.
    expect(tryEncodeQr(`${ORIGIN}/pair#${'a'.repeat(26)}`)).not.toBeNull();
  });
});

describe('devices', () => {
  it('lists devices without secrets, and says which one is asking', async () => {
    const { app } = await build();
    const res = await app.inject({ url: '/api/devices', headers: publicHeaders(PHONE_COOKIE) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      devices: [
        expect.objectContaining({ id: TEST_DESKTOP.id, kind: 'desktop', scopes: ['chats', 'settings', 'pc-settings', 'power', 'devices'] }),
        expect.objectContaining({ id: TEST_PHONE.id, kind: 'phone', scopes: ['chats', 'settings', 'power-confirm'] }),
      ],
      currentId: TEST_PHONE.id,
      pairingLocked: false,
    });
    expect(res.body).not.toMatch(/secret/i);
  });

  it('lets a desktop rename any device and a phone only itself', async () => {
    const { app } = await build();
    const rename = (id: string, name: unknown, cookie: string) =>
      app.inject({ method: 'PATCH', url: `/api/devices/${id}`, headers: publicPost(cookie), payload: JSON.stringify({ name }) });
    expect((await rename(TEST_PHONE.id, 'Kitchen phone', DESKTOP_COOKIE)).json()).toMatchObject({ name: 'Kitchen phone' });
    expect((await rename(TEST_PHONE.id, '  Pocket phone ', PHONE_COOKIE)).json()).toMatchObject({ name: 'Pocket phone' });
    expect((await rename(TEST_DESKTOP.id, 'Mine now', PHONE_COOKIE)).statusCode).toBe(403);
    for (const bad of ['', 'x'.repeat(61), 'two\nlines', 'sneaky\u202eeman', 5]) {
      expect((await rename(TEST_PHONE.id, bad, DESKTOP_COOKIE)).statusCode, String(bad)).toBe(400);
    }
    expect((await rename(`dv_${'e'.repeat(24)}`, 'Ghost', DESKTOP_COOKIE)).statusCode).toBe(404);
    expect((await rename('..%2Fetc', 'Ghost', DESKTOP_COOKIE)).statusCode).toBe(400);
  });

  it('lets only a desktop offer codes, and a phone revoke only itself', async () => {
    const { app } = await build();
    expect((await offer(app, 'phone', PHONE_COOKIE)).statusCode).toBe(403);
    const revoke = (id: string, cookie: string) => app.inject({ method: 'DELETE', url: `/api/devices/${id}`, headers: publicDelete(cookie) });
    expect((await revoke(TEST_DESKTOP.id, PHONE_COOKIE)).statusCode).toBe(403);
    const self = await revoke(TEST_PHONE.id, PHONE_COOKIE);
    expect(self.statusCode).toBe(200);
    expect(String(self.headers['set-cookie'])).toMatch(/^wr_device=; Max-Age=0;/);
    expect((await app.inject({ url: '/api/me', headers: publicHeaders(PHONE_COOKIE) })).statusCode).toBe(401);
    expect((await revoke(TEST_PHONE.id, DESKTOP_COOKIE)).statusCode).toBe(404);
  });

  it('tells power routes which kind of device is asking', () => {
    expect(deviceKind({ device: { id: TEST_DESKTOP.id, name: 'd', kind: 'desktop', scopes: [], created: 0, lastSeen: 0 } })).toBe('desktop');
    expect(deviceKind({ device: { id: TEST_PHONE.id, name: 'p', kind: 'phone', scopes: [], created: 0, lastSeen: 0 } })).toBe('phone');
    // No device (Access alone): treated as the more careful kind.
    expect(deviceKind({})).toBe('phone');
  });

  it('refuses to start over a damaged store instead of forgetting every device', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-devices-'));
    writeFileSync(join(dir, 'devices.json'), '{"version":1,"devices":[{"id":"oops"}]}');
    expect(() => new Devices(dir)).toThrow(DevicesFileError);
  });
});

describe('sign-in by origin', () => {
  it('needs both Access and a device on a public origin', async () => {
    const { app } = await build();
    expect((await app.inject({ url: '/api/me', headers: publicHeaders(DESKTOP_COOKIE) })).statusCode).toBe(200);
    const accessOnly = await app.inject({ url: '/api/me', headers: publicHeaders(null) });
    expect(accessOnly.statusCode).toBe(401);
    expect(accessOnly.json()).toEqual({ error: 'unpaired' });
    const { 'cf-access-jwt-assertion': _t, ...deviceOnly } = publicHeaders(DESKTOP_COOKIE);
    expect((await app.inject({ url: '/api/me', headers: deviceOnly })).json()).toEqual({ error: 'unauthorized' });
    // The tailnet is a public origin too.
    const tailnet = { host: new URL(TAILNET).host, 'x-wayroost-request': '1', cookie: DESKTOP_COOKIE };
    expect((await app.inject({ url: '/api/me', headers: tailnet })).statusCode).toBe(401);
  });

  it('needs a device only on a local origin, and refuses one that came through the tunnel', async () => {
    const { app } = await build();
    const me = await app.inject({ url: '/api/me', headers: localHeaders(DESKTOP_COOKIE) });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBeUndefined();
    expect((await app.inject({ url: '/api/me', headers: localHeaders(null) })).json()).toEqual({ error: 'unpaired' });
    const tunnelled = await app.inject({ url: '/api/me', headers: localHeaders(DESKTOP_COOKIE, { 'cf-ray': '0000000000000000-AAA' }) });
    expect(tunnelled.statusCode).toBe(421);
  });

  it('lets only the desktop app pair or sign in on a local origin, never a browser', async () => {
    const { app, devices } = await build();
    // A browser keeps one cookie jar for every port on 127.0.0.1, so a cookie it
    // held here would reach any local web server it opened.
    const code = devices.createCode('desktop').code;
    const refused = await pair(app, { code, name: 'Browser on the PC' }, browserLocalHeaders(null, { origin: LOCAL, 'content-type': 'application/json' }));
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatch(/desktop app/);
    expect(refused.headers['set-cookie']).toBeUndefined();
    // Refused before the code was looked at, so it still works in the app.
    expect((await pair(app, { code, name: 'This PC' }, localPost(null))).statusCode).toBe(200);

    // A browser presenting a device cookie on the local origin isn't signed in,
    // and its cookie isn't cleared (it may belong to another port).
    const browser = await app.inject({ url: '/api/me', headers: browserLocalHeaders(DESKTOP_COOKIE) });
    expect(browser.statusCode).toBe(401);
    expect(browser.json()).toEqual({ error: 'unpaired' });
    expect(browser.headers['set-cookie']).toBeUndefined();
    const wrongValue = await app.inject({ url: '/api/me', headers: localHeaders(DESKTOP_COOKIE, { 'x-wayroost-app': '1' }) });
    expect(wrongValue.statusCode).toBe(401);
    // The desktop app's own requests sign in as before.
    expect((await app.inject({ url: '/api/me', headers: localHeaders(DESKTOP_COOKIE) })).statusCode).toBe(200);
    // Public origins don't need the header.
    expect((await app.inject({ url: '/api/me', headers: publicHeaders(DESKTOP_COOKIE) })).statusCode).toBe(200);
  });

  it('holds an https:// loopback origin to the same desktop-app-only rule', async () => {
    const HTTPS_LOCAL = 'https://localhost:8443';
    const { app, devices } = await build({ access: false, origins: [LOCAL, HTTPS_LOCAL] });
    const headers = (app: boolean) => ({
      host: 'localhost:8443',
      origin: HTTPS_LOCAL,
      'x-wayroost-request': '1',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      ...(app ? { 'x-wayroost-app': 'desktop' } : {}),
    });
    // Secure doesn't scope a cookie to a port (and browsers send Secure
    // cookies to http://localhost too), so a browser is refused here as well.
    const code = devices.createCode('desktop').code;
    const browser = await pair(app, { code, name: 'Browser on the PC' }, headers(false));
    expect(browser.statusCode).toBe(403);
    expect(browser.headers['set-cookie']).toBeUndefined();
    const desktop = await pair(app, { code, name: 'This PC' }, headers(true));
    expect(desktop.statusCode).toBe(200);
    expect(String(desktop.headers['set-cookie'])).toMatch(/; Secure$/);
  });

  it("refuses the desktop app's header from another site, before the code is spent", async () => {
    // The header isn't a secret; what keeps other pages from sending it is that
    // a custom header needs a CORS grant we never give, and the Origin check.
    const { app, devices } = await build();
    const code = devices.createCode('desktop').code;
    const fromAnotherPort = localPost(null, { origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-site' });
    const refused = await pair(app, { code, name: 'Dev server' }, fromAnotherPort);
    expect(refused.statusCode).toBe(403);
    expect(refused.headers['set-cookie']).toBeUndefined();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/pair',
      headers: {
        host: '127.0.0.1:8881',
        origin: 'http://127.0.0.1:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-wayroost-app,x-wayroost-request,content-type',
      },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(preflight.headers['access-control-allow-headers']).toBeUndefined();
    expect((await pair(app, { code, name: 'This PC' }, localPost(null))).statusCode).toBe(200);
  });

  it('works with devices alone when Access is not configured', async () => {
    const { app } = await build({ access: false });
    const { 'cf-access-jwt-assertion': _t, ...headers } = publicHeaders(PHONE_COOKIE);
    expect((await app.inject({ url: '/api/me', headers })).json()).toMatchObject({ device: { id: TEST_PHONE.id } });
    const { cookie: _c, ...noDevice } = headers;
    expect((await app.inject({ url: '/api/me', headers: noDevice })).statusCode).toBe(401);
  });

  it('serves the app shell and the pairing call without a device, and nothing else', async () => {
    const { app, devices } = await build({ staticDir: makeStaticDir() });
    expect((await app.inject({ url: '/', headers: { host: '127.0.0.1:8881' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/pair', headers: { host: '127.0.0.1:8881', accept: 'text/html' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/assets/app.js', headers: { host: '127.0.0.1:8881' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/conversations', headers: localHeaders(null) })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/devices', headers: localHeaders(null) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/pair/offer', headers: localPost(null), payload: '{}' })).statusCode).toBe(401);
    // The pairing call still follows the API rules.
    const code = devices.createCode('desktop').code;
    const body = { code, name: 'This PC' };
    expect((await pair(app, body, localPost(null, { 'x-wayroost-request': '' }))).statusCode).toBe(403);
    expect((await pair(app, body, localPost(null, { origin: 'http://127.0.0.1:3000' }))).statusCode).toBe(403);
    expect((await pair(app, body, localPost(null, { 'content-type': 'text/plain' }))).statusCode).toBe(403);
    expect((await pair(app, body, localPost(null))).statusCode).toBe(200);
  });
});

describe('Host and Origin checks with several origins', () => {
  it('accepts each origin only from its own Host, and unknown Hosts not at all', async () => {
    const { app } = await build();
    const send = (headers: Record<string, string>) =>
      app.inject({ method: 'PATCH', url: `/api/devices/${TEST_PHONE.id}`, headers, payload: JSON.stringify({ name: 'Renamed' }) });
    const tailnetHost = new URL(TAILNET).host;
    expect((await send(publicPost(DESKTOP_COOKIE, { host: tailnetHost, origin: ORIGIN }))).statusCode).toBe(403);
    expect((await send(publicPost(DESKTOP_COOKIE, { host: tailnetHost, origin: TAILNET }))).statusCode).toBe(200);
    expect((await send(localPost(DESKTOP_COOKIE, { origin: TAILNET }))).statusCode).toBe(403);
    expect((await send(localPost(DESKTOP_COOKIE))).statusCode).toBe(200);
    expect((await send(publicPost(DESKTOP_COOKIE))).statusCode).toBe(200);
    expect((await send(publicPost(DESKTOP_COOKIE, { host: 'evil.example' }))).statusCode).toBe(421);
    expect((await send(publicPost(DESKTOP_COOKIE, { host: 'evil.example', origin: 'https://evil.example' }))).statusCode).toBe(421);
  });

  it('accepts the Signalbox request header during M1, and nothing without one', async () => {
    const { app } = await build();
    const { 'x-wayroost-request': _m, ...bare } = publicHeaders(DESKTOP_COOKIE);
    expect((await app.inject({ url: '/api/me', headers: { ...bare, 'x-signalbox-request': '1' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/me', headers: bare })).statusCode).toBe(403);
  });

  it("gives each origin its own CSP, and HSTS only on https", async () => {
    const { app } = await build();
    const local = await app.inject({ url: '/api/me', headers: localHeaders(DESKTOP_COOKIE) });
    expect(local.headers['content-security-policy']).toContain('connect-src \'self\' ws://127.0.0.1:8881');
    expect(local.headers['strict-transport-security']).toBeUndefined();
    const tailnet = await app.inject({ url: '/api/me', headers: publicHeaders(DESKTOP_COOKIE, { host: new URL(TAILNET).host }) });
    expect(tailnet.headers['content-security-policy']).toContain('wss://box.tailnet.example');
    expect(tailnet.headers['strict-transport-security']).toContain('max-age=');
  });
});

describe('revoking a device', () => {
  it("closes that device's open sockets at once and keeps the others", async () => {
    const { app, config } = await build();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    config.allowedHosts.add(`127.0.0.1:${port}`);
    const open = async (cookie: string | null) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { origin: ORIGIN, 'cf-access-jwt-assertion': token, ...(cookie ? { cookie } : {}) },
      });
      ws.on('error', () => {});
      cleanups.push(() => ws.terminate());
      return ws;
    };
    const greeted = async (ws: WebSocket) => JSON.parse(String((await once(ws, 'message'))[0])) as ServerEvent;

    const unpaired = await open(null);
    const [, rejected] = (await once(unpaired, 'unexpected-response')) as [unknown, { statusCode: number }];
    expect(rejected.statusCode).toBe(401);

    const phoneA = await open(PHONE_COOKIE);
    const phoneB = await open(PHONE_COOKIE);
    const desktop = await open(DESKTOP_COOKIE);
    expect(await greeted(phoneA)).toMatchObject({ type: 'hello', email: EMAIL, device: { id: TEST_PHONE.id, kind: 'phone' } });
    await greeted(phoneB);
    await greeted(desktop);

    const closed = Promise.all([once(phoneA, 'close'), once(phoneB, 'close')]);
    const res = await app.inject({ method: 'DELETE', url: `/api/devices/${TEST_PHONE.id}`, headers: publicDelete(DESKTOP_COOKIE) });
    expect(res.statusCode).toBe(200);
    const codes = (await closed).map(([code]) => code);
    expect(codes).toEqual([WS_CLOSE_DEVICE_REVOKED, WS_CLOSE_DEVICE_REVOKED]);
    expect(desktop.readyState).toBe(WebSocket.OPEN);

    const again = await open(PHONE_COOKIE);
    const [, refused] = (await once(again, 'unexpected-response')) as [unknown, { statusCode: number }];
    expect(refused.statusCode).toBe(401);
  });
});

/** A masked client frame (RFC 6455), as a browser would send it. */
function clientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const length =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
      : Buffer.from([0x80 | opcode, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([length, mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!))]);
}

/** Polls until `ready` holds (sockets give no event for "this much has arrived"). */
async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; !ready(); i++) {
    if (i > 200) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('a revoked device whose client ignores the close', () => {
  it('gets no more of its frames handled: no subscription, no transcription', async () => {
    const transcribed: Buffer[] = [];
    const speech: SpeechService = {
      health: async () => ({ voices: ['af_heart'], defaultVoice: 'af_heart' }),
      transcribe: async (pcm) => {
        transcribed.push(pcm);
        return { text: 'heard', ms: 1 };
      },
      speak: async () => Buffer.alloc(0),
    };
    const { app, config, hub } = await build({ speech });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    config.allowedHosts.add(`127.0.0.1:${port}`);

    // A bare TCP client: it does the upgrade by hand and never answers a close frame.
    const raw = connect(port, '127.0.0.1');
    raw.on('error', () => {});
    cleanups.push(() => raw.destroy());
    await once(raw, 'connect');
    let received = Buffer.alloc(0);
    raw.on('data', (data: Buffer) => (received = Buffer.concat([received, data])));
    const ended = once(raw, 'close');
    raw.write(
      [
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        `Origin: ${ORIGIN}`,
        `cf-access-jwt-assertion: ${token}`,
        `Cookie: ${PHONE_COOKIE}`,
        '',
        '',
      ].join('\r\n'),
    );
    await until(() => received.includes('"hello"'));
    expect(hub.size).toBe(1);

    const res = await app.inject({ method: 'DELETE', url: `/api/devices/${TEST_PHONE.id}`, headers: publicDelete(DESKTOP_COOKIE) });
    expect(res.statusCode).toBe(200);
    expect(hub.size).toBe(0);

    // Inside the close's grace period: subscribe, then a whole voice run.
    const text = (message: object) => clientFrame(0x1, Buffer.from(JSON.stringify(message)));
    raw.write(text({ type: 'subscribe', source: 'hermes', conversationId: 'chat-1' }));
    raw.write(text({ type: 'voice_start', run: 1 }));
    raw.write(clientFrame(0x2, Buffer.concat([Buffer.from([1]), Buffer.alloc(16_000)])));
    raw.write(clientFrame(0x2, Buffer.from([1])));
    // The server cuts the client off after its grace second; everything above arrived well before.
    await ended;

    expect(hub.isWatched('hermes', 'chat-1')).toBe(false);
    expect(hub.size).toBe(0);
    expect(transcribed).toEqual([]);
  });
});

describe('a revoke during the WebSocket handshake', () => {
  it('closes a socket whose device was revoked after its sign-in was checked', async () => {
    const { app, config, devices, hub } = await build();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    config.allowedHosts.add(`127.0.0.1:${port}`);
    // Revoke the phone right after onRequest has signed it in, before the
    // upgrade handler registers its socket: the window a racing DELETE hits.
    const authenticate = devices.authenticate.bind(devices);
    devices.authenticate = (values) => {
      const signedIn = authenticate(values);
      if (signedIn?.device.id === TEST_PHONE.id) devices.revoke(TEST_PHONE.id);
      return signedIn;
    };
    const phone = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin: ORIGIN, 'cf-access-jwt-assertion': token, cookie: PHONE_COOKIE },
    });
    phone.on('error', () => {});
    cleanups.push(() => phone.terminate());
    const messages: string[] = [];
    phone.on('message', (data) => messages.push(String(data)));
    const closed = once(phone, 'close');
    await once(phone, 'open');
    hub.publish({ type: 'pong' });
    const [code] = (await closed) as [number];
    expect(code).toBe(WS_CLOSE_DEVICE_REVOKED);
    expect(messages).toEqual([]);
    expect(devices.get(TEST_PHONE.id)).toBeUndefined();
  });
});

describe('a store that cannot be written', () => {
  /** Puts a folder where devices.json goes, so the next write fails (as a full disk would); returns the undo. */
  function breakStore(stateDir: string): () => void {
    const path = join(stateDir, 'devices.json');
    const saved = readFileSync(path, 'utf8');
    rmSync(path);
    mkdirSync(path);
    return () => {
      rmSync(path, { recursive: true });
      writeFileSync(path, saved, { mode: 0o600 });
    };
  }

  it('keeps a device fully paired, sockets included, when its revoke cannot be saved', async () => {
    const { app, config, stateDir, hub } = await build();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    config.allowedHosts.add(`127.0.0.1:${port}`);
    const phone = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin: ORIGIN, 'cf-access-jwt-assertion': token, cookie: PHONE_COOKIE },
    });
    phone.on('error', () => {});
    cleanups.push(() => phone.terminate());
    await once(phone, 'message'); // hello
    // Both devices have been seen this hour, so no lastSeen write gets in the way.
    for (const cookie of [DESKTOP_COOKIE, PHONE_COOKIE]) {
      expect((await app.inject({ url: '/api/me', headers: publicHeaders(cookie) })).statusCode).toBe(200);
    }

    const restore = breakStore(stateDir);
    const failed = await app.inject({ method: 'DELETE', url: `/api/devices/${TEST_PHONE.id}`, headers: publicDelete(DESKTOP_COOKIE) });
    expect(failed.statusCode).toBe(500);
    // Nothing half-done: still listed, still signed in, its socket still served.
    const list = await app.inject({ url: '/api/devices', headers: publicHeaders(DESKTOP_COOKIE) });
    expect(list.json().devices.map((d: { id: string }) => d.id)).toContain(TEST_PHONE.id);
    expect((await app.inject({ url: '/api/me', headers: publicHeaders(PHONE_COOKIE) })).statusCode).toBe(200);
    const event = once(phone, 'message');
    hub.publish({ type: 'pong' });
    expect(JSON.parse(String((await event)[0]))).toEqual({ type: 'pong' });
    expect(readdirSync(stateDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    // Once it can be saved, the revoke goes through: socket closed, gone after a restart too.
    restore();
    const closed = once(phone, 'close');
    const res = await app.inject({ method: 'DELETE', url: `/api/devices/${TEST_PHONE.id}`, headers: publicDelete(DESKTOP_COOKIE) });
    expect(res.statusCode).toBe(200);
    expect((await closed)[0]).toBe(WS_CLOSE_DEVICE_REVOKED);
    expect(new Devices(stateDir).get(TEST_PHONE.id)).toBeUndefined();
  });

  it('keeps the hourly cookie renewal for the next request when lastSeen cannot be saved', async () => {
    const time = clock();
    const { app, devices, stateDir } = await build({ now: time.now });
    expect(cookieOf((await app.inject({ url: '/api/me', headers: publicHeaders(DESKTOP_COOKIE) })).headers['set-cookie'])).toBe(
      DESKTOP_COOKIE,
    );
    const seen = devices.get(TEST_DESKTOP.id)!.lastSeen;
    time.advance(61 * 60_000);

    const restore = breakStore(stateDir);
    const failed = await app.inject({ url: '/api/me', headers: publicHeaders(DESKTOP_COOKIE) });
    expect(failed.statusCode).toBe(500);
    expect(failed.headers['set-cookie']).toBeUndefined();
    // Nothing applied: the hour isn't used up by a write that never happened.
    expect(devices.get(TEST_DESKTOP.id)!.lastSeen).toBe(seen);
    expect(readdirSync(stateDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    restore();
    const retried = await app.inject({ url: '/api/me', headers: publicHeaders(DESKTOP_COOKIE) });
    expect(retried.statusCode).toBe(200);
    expect(cookieOf(retried.headers['set-cookie'])).toBe(DESKTOP_COOKIE);
    expect(devices.get(TEST_DESKTOP.id)!.lastSeen).toBe(time.now());
    expect(new Devices(stateDir).get(TEST_DESKTOP.id)!.lastSeen).toBe(time.now());
  });

  it('changes nothing in memory when pairing or renaming cannot be saved', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'sb-devices-'));
    const store = new Devices(stateDir);
    const desktop = store.add('Desktop', 'desktop');
    const restore = breakStore(stateDir);
    expect(() => store.add('Phone', 'phone')).toThrow();
    expect(() => store.pair(store.createCode('phone').code, 'Phone')).toThrow();
    expect(() => store.rename(desktop.device.id, 'Renamed')).toThrow();
    expect(store.list().map((d) => d.name)).toEqual(['Desktop']);
    restore();
    expect(new Devices(stateDir).list().map((d) => d.name)).toEqual(['Desktop']);
  });
});

describe('logs', () => {
  it('never contain a pairing code, a device secret or a cookie', async () => {
    const logs: string[] = [];
    const { app, devices } = await build({ logs });
    const made = (await offer(app)).json() as { code: string };
    const paired = await pair(app, { code: made.code, name: 'Logged phone' });
    const newCookie = cookieOf(paired.headers['set-cookie']);
    await pair(app, { code: made.code, name: 'Reused' }); // refused
    await pair(app, { code: 'e'.repeat(26), name: 'Wrong' }, localPost(null)); // refused
    await app.inject({ url: '/api/me', headers: publicHeaders(newCookie) });
    await app.inject({ url: '/api/me', headers: publicHeaders(`${DEVICE_COOKIE}=${TEST_PHONE.id}.${'z'.repeat(43)}`) });
    const id = COOKIE_RE.exec(String(paired.headers['set-cookie']))![1]!;
    await app.inject({ method: 'DELETE', url: `/api/devices/${id}`, headers: publicDelete(DESKTOP_COOKIE) });

    const socketLog: string[] = [];
    const stateDir = mkdtempSync(join(tmpdir(), 'sb-pairing-'));
    const server = await startPairingSocket({ devices, stateDir, origins: [LOCAL], log: recordingLog(socketLog) });
    cleanups.push(() => server.close());
    const recovered = await requestRecoveryCode(pairingSocketPath(stateDir), 'desktop');

    const text = [...logs, ...socketLog].join('\n');
    expect(text).toContain('device paired');
    expect(text).toContain('pairing refused');
    expect(text).toContain('device revoked');
    expect(text).toContain('recovery socket');
    for (const secret of [made.code, recovered.code, newCookie.split('.')[1]!, TEST_DESKTOP.secret, TEST_PHONE.secret, 'z'.repeat(43), 'e'.repeat(26)]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain(`${DEVICE_COOKIE}=`);
  });
});

function recordingLog(lines: string[]) {
  const write = (level: string) => (obj: Record<string, unknown>, msg: string) => void lines.push(JSON.stringify({ level, msg, ...obj }));
  return { info: write('info'), warn: write('warn'), error: write('error') };
}

describe('recovery socket', () => {
  it('hands root a code over a private Unix socket, and the code pairs', async () => {
    const time = clock();
    const stateDir = mkdtempSync(join(tmpdir(), 'sb-pairing-'));
    const devices = new Devices(stateDir, { now: time.now });
    const server = await startPairingSocket({ devices, stateDir, origins: [LOCAL, ORIGIN], log: recordingLog([]) });
    cleanups.push(() => server.close());
    const path = pairingSocketPath(stateDir);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(stateDir, 'pairing')).mode & 0o777).toBe(0o700);

    // Even a lock gives way to root.
    for (let i = 0; i < 20; i++) {
      if (i % 10 === 0) time.advance(61_000);
      expect(() => devices.pair('f'.repeat(26), 'Guess')).toThrow(PairingRefused);
    }
    expect(devices.pairingLocked()).toBe(true);
    const made = await requestRecoveryCode(path, 'desktop');
    expect(made.kind).toBe('desktop');
    expect(made.urls).toEqual([`${LOCAL}/pair#${made.code}`, `${ORIGIN}/pair#${made.code}`]);
    expect(devices.pairingLocked()).toBe(false);
    expect(devices.pair(made.code, 'Rescued').device.kind).toBe('desktop');
    expect((await requestRecoveryCode(path, 'phone')).kind).toBe('phone');
  });

  it("answers with an error, and stays up and locked, when lifting the lock can't be saved", async () => {
    const time = clock();
    const stateDir = mkdtempSync(join(tmpdir(), 'sb-pairing-'));
    const devices = new Devices(stateDir, { now: time.now });
    const lines: string[] = [];
    const server = await startPairingSocket({ devices, stateDir, origins: [LOCAL], log: recordingLog(lines) });
    cleanups.push(() => server.close());
    const path = pairingSocketPath(stateDir);
    for (let i = 0; i < 20; i++) {
      if (i % 10 === 0) time.advance(61_000);
      expect(() => devices.pair('f'.repeat(26), 'Guess')).toThrow(PairingRefused);
    }
    expect(devices.pairingLocked()).toBe(true);

    // A folder where devices.json goes makes the next write fail, as a full disk would.
    const store = join(stateDir, 'devices.json');
    const saved = readFileSync(store, 'utf8');
    rmSync(store);
    mkdirSync(store);
    await expect(requestRecoveryCode(path, 'desktop')).rejects.toThrow(/could not make a code/);
    expect(server.listening).toBe(true);
    expect(devices.pairingLocked()).toBe(true);
    expect(lines.join('\n')).toContain('could not make a pairing code');
    expect(lines.join('\n')).toContain('EISDIR');

    // Once it can be saved, recovery works on the same server.
    rmSync(store, { recursive: true });
    writeFileSync(store, saved, { mode: 0o600 });
    const made = await requestRecoveryCode(path, 'desktop');
    expect(devices.pairingLocked()).toBe(false);
    expect(new Devices(stateDir).pairingLocked()).toBe(false);
    expect(lines.join('\n')).not.toContain(made.code);
  });

  it('answers nonsense with an error and cuts off oversized input', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'sb-pairing-'));
    const devices = new Devices(stateDir);
    const server = await startPairingSocket({ devices, stateDir, origins: [LOCAL], log: recordingLog([]) });
    cleanups.push(() => server.close());
    const talk = (input: string) =>
      new Promise<string>((resolve) => {
        const socket = connect(pairingSocketPath(stateDir));
        let out = '';
        socket.on('data', (d) => (out += String(d)));
        socket.on('error', () => resolve(out));
        socket.on('close', () => resolve(out));
        socket.write(input);
      });
    expect(JSON.parse(await talk('{"kind":"admin"}\n'))).toEqual({ error: 'bad request' });
    expect(JSON.parse(await talk('not json\n'))).toEqual({ error: 'bad request' });
    expect(await talk('x'.repeat(1000))).toBe('');
  });
});
