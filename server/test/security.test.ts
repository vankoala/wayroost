import { once } from 'node:events';
import { SignJWT, type CryptoKey } from 'jose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { WS_CLOSE_REAUTH, WS_CLOSE_SESSION_EXPIRED, type ServerEvent } from '../../shared/protocol.js';
import { createAccessVerifier } from '../src/security/access.js';
import {
  AUD,
  EMAIL,
  ISSUER,
  ORIGIN,
  apiHeaders,
  makeApp,
  makeKeys,
  makeStaticDir,
  makeToken,
  postHeaders,
  type Keys,
} from './helpers.js';

let keys: Keys;
let token: string;
const host = new URL(ORIGIN).host;
const cleanups: Array<() => Promise<unknown>> = [];

beforeAll(async () => {
  keys = await makeKeys();
  token = await makeToken(keys);
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(options: { staticDir?: string; wsMaxLifetimeMs?: number } = {}) {
  const ctx = await makeApp(keys, options);
  cleanups.push(() => ctx.app.close());
  return ctx;
}

describe('Cloudflare Access identity', () => {
  it('rejects requests without an Access token', async () => {
    const { app } = await setup();
    const res = await app.inject({ url: '/api/me', headers: { host, 'x-signalbox-request': '1' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('accepts a valid token for an allowed email', async () => {
    const { app } = await setup();
    const res = await app.inject({ url: '/api/me', headers: apiHeaders(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe(EMAIL);
  });

  const badTokens: Array<[string, () => Promise<string>]> = [
    ['wrong audience', () => makeToken(keys, { audience: 'someone-elses-app' })],
    ['wrong issuer', () => makeToken(keys, { issuer: 'https://evil.cloudflareaccess.com' })],
    ['expired', () => makeToken(keys, { expiresIn: Math.floor(Date.now() / 1000) - 120 })],
    ['signed by another key', () => makeToken(keys, { key: keys.otherPrivateKey })],
    ['unknown key id', () => makeToken(keys, { kid: 'nope' })],
    ['garbage', async () => 'not-a-jwt'],
    [
      'unsigned (alg none)',
      async () => {
        const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const now = Math.floor(Date.now() / 1000);
        return `${enc({ alg: 'none' })}.${enc({ email: EMAIL, iss: ISSUER, aud: [AUD], iat: now, exp: now + 3600 })}.`;
      },
    ],
    [
      'HS256 forged with a guessed secret',
      async () =>
        new SignJWT({ email: EMAIL })
          .setProtectedHeader({ alg: 'HS256', kid: keys.kid })
          .setIssuer(ISSUER)
          .setAudience(AUD)
          .setIssuedAt()
          .setExpirationTime('1h')
          .sign(new TextEncoder().encode('secret-secret-secret-secret-1234')),
    ],
  ];

  for (const [name, make] of badTokens) {
    it(`rejects a token that is ${name}`, async () => {
      const { app } = await setup();
      const res = await app.inject({ url: '/api/me', headers: apiHeaders(await make()) });
      expect(res.statusCode).toBe(401);
    });
  }

  it('rejects valid tokens for other people', async () => {
    const { app } = await setup();
    const other = await makeToken(keys, { claims: { email: 'intruder@example.com' } });
    expect((await app.inject({ url: '/api/me', headers: apiHeaders(other) })).statusCode).toBe(403);
  });

  it('does not let Unicode look-alike emails match the allowlist', async () => {
    // U+212A KELVIN SIGN lowercases to "k" under Unicode rules.
    const verify = createAccessVerifier({
      issuer: ISSUER,
      jwksUrl: `${ISSUER}/cdn-cgi/access/certs`,
      aud: AUD,
      allowedEmails: ['kate@example.com'],
      keySource: keys.keySource,
    });
    const kelvin = await makeToken(keys, { claims: { email: '\u212Aate@example.com' } });
    await expect(verify(kelvin)).rejects.toMatchObject({ status: 403 });
    const upper = await makeToken(keys, { claims: { email: 'KATE@EXAMPLE.COM' } });
    await expect(verify(upper)).resolves.toMatchObject({ email: 'kate@example.com' });
  });

  it('rejects service tokens (no email identity)', async () => {
    const { app } = await setup();
    const service = await makeToken(keys, { claims: { common_name: 'robot.access' } });
    expect((await app.inject({ url: '/api/me', headers: apiHeaders(service) })).statusCode).toBe(403);
  });

  it('protects the web app shell as well as the API', async () => {
    const { app } = await setup({ staticDir: makeStaticDir() });
    expect((await app.inject({ url: '/', headers: { host } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/assets/app.js', headers: { host } })).statusCode).toBe(401);
    const res = await app.inject({ url: '/', headers: { host, 'cf-access-jwt-assertion': token } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('serves the app shell for client-side routes', async () => {
    const { app } = await setup({ staticDir: makeStaticDir() });
    const res = await app.inject({
      url: '/c/hermes/abc',
      headers: { host, 'cf-access-jwt-assertion': token, accept: 'text/html' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Signalbox');
  });

  it('lets install assets through without a token (Access still guards them at the edge)', async () => {
    const { app } = await setup({ staticDir: makeStaticDir() });
    expect((await app.inject({ url: '/manifest.webmanifest', headers: { host } })).statusCode).toBe(200);
  });
});

describe('browser protections', () => {
  it('rejects unexpected Host headers (DNS rebinding)', async () => {
    const { app } = await setup();
    const res = await app.inject({ url: '/api/me', headers: { ...apiHeaders(token), host: 'evil.example' } });
    expect(res.statusCode).toBe(421);
  });

  it('requires the request marker header on API calls', async () => {
    const { app } = await setup();
    const { 'x-signalbox-request': _omit, ...headers } = apiHeaders(token);
    expect((await app.inject({ url: '/api/me', headers })).statusCode).toBe(403);
  });

  it('applies the API rules to percent-encoded and odd paths too', async () => {
    const { app, hermes } = await setup();
    for (const url of ['/%61pi/me', '/%61%70%69/conversations', '/api/me/']) {
      const res = await app.inject({ url, headers: { host, 'cf-access-jwt-assertion': token } });
      expect(res.statusCode, url).not.toBe(200);
    }
    const post = await app.inject({
      method: 'POST',
      url: '/%61pi/conversations/hermes/h1/messages',
      headers: { host, 'cf-access-jwt-assertion': token, 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'hi' }),
    });
    expect(post.statusCode).toBe(403);
    expect(hermes.calls).toEqual([]);
  });

  it('rejects cross-site fetches', async () => {
    const { app } = await setup();
    const res = await app.inject({ url: '/api/me', headers: apiHeaders(token, { 'sec-fetch-site': 'cross-site' }) });
    expect(res.statusCode).toBe(403);
  });

  it('only accepts state changes from our own origin as JSON', async () => {
    const { app, hermes } = await setup();
    const url = '/api/conversations/hermes/h1/messages';
    const payload = JSON.stringify({ text: 'hi' });
    const { origin: _o, ...noOrigin } = postHeaders(token);
    const cases = [
      noOrigin,
      postHeaders(token, { origin: 'https://evil.example' }),
      postHeaders(token, { 'content-type': 'text/plain' }),
      postHeaders(token, { 'content-type': 'application/x-www-form-urlencoded' }),
    ];
    for (const headers of cases) {
      const res = await app.inject({ method: 'POST', url, headers, payload });
      expect(res.statusCode).toBe(403);
    }
    expect(hermes.calls).toEqual([]);

    const ok = await app.inject({ method: 'POST', url, headers: postHeaders(token), payload });
    expect(ok.statusCode).toBe(200);
    expect(hermes.calls).toEqual(['send:h1:hi']);
  });

  it('sets strict security headers on every response, including denials', async () => {
    const { app } = await setup();
    for (const res of [
      await app.inject({ url: '/api/me', headers: { host } }),
      await app.inject({ url: '/api/me', headers: apiHeaders(token) }),
    ]) {
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain('unsafe-inline');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['strict-transport-security']).toContain('max-age=');
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });
});

describe('input validation', () => {
  it('rejects unknown sources, odd ids, empty and oversized messages', async () => {
    const { app, hermes } = await setup();
    const post = (url: string, body: unknown) =>
      app.inject({ method: 'POST', url, headers: postHeaders(token), payload: JSON.stringify(body) });

    expect((await post('/api/conversations/shell/x/messages', { text: 'hi' })).statusCode).toBe(400);
    expect((await post('/api/conversations/hermes/..%2F..%2Fetc/messages', { text: 'hi' })).statusCode).toBe(400);
    expect((await post('/api/conversations/hermes/%2E%2E/messages', { text: 'hi' })).statusCode).not.toBe(200);
    expect((await post('/api/conversations/hermes/./messages', { text: 'hi' })).statusCode).not.toBe(200);
    for (const id of ['%2E%2E', '%2E', '.hidden']) {
      const res = await app.inject({ url: `/api/conversations/hermes/${id}`, headers: apiHeaders(token) });
      expect(res.statusCode, id).toBeGreaterThanOrEqual(400);
    }
    expect((await post('/api/conversations/hermes/h1/messages', { text: '   ' })).statusCode).toBe(400);
    expect((await post('/api/conversations/hermes/h1/messages', { text: 'hi', extra: 1 })).statusCode).toBe(400);
    // Message routes take large bodies (attachments), so long text is refused by validation.
    expect((await post('/api/conversations/hermes/h1/messages', { text: 'x'.repeat(300_000) })).statusCode).toBe(400);
    expect((await post('/api/conversations/hermes/h1/approvals/a1', { text: 'x'.repeat(300_000) })).statusCode).toBe(413);
    expect(hermes.calls).toEqual([]);
  });

  it('only allows absolute working directories and known provider ids for new Paseo agents', async () => {
    const { app, paseo } = await setup();
    const post = (body: unknown) =>
      app.inject({ method: 'POST', url: '/api/paseo/conversations', headers: postHeaders(token), payload: JSON.stringify(body) });
    expect((await post({ providerId: 'claude', cwd: 'relative/dir', text: 'hi' })).statusCode).toBe(400);
    expect((await post({ providerId: 'Claude; rm -rf', cwd: '/tmp', text: 'hi' })).statusCode).toBe(400);
    expect((await post({ providerId: 'claude', cwd: '/home/me/app', text: 'hi' })).statusCode).toBe(200);
    expect(paseo.calls).toEqual(['create:claude:/home/me/app']);
  });

  it('checks attachments before any backend sees them', async () => {
    const { app, hermes } = await setup();
    const post = (url: string, body: unknown) =>
      app.inject({ method: 'POST', url, headers: postHeaders(token), payload: JSON.stringify(body) });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString('base64');
    const file = (name: string, mimeType: string, data: string) => ({ name, mimeType, data });

    const disguised = await post('/api/conversations/hermes/h1/messages', {
      text: 'hi',
      attachments: [file('x.png', 'image/png', Buffer.from('<svg onload=alert(1)>').toString('base64'))],
    });
    expect(disguised.statusCode).toBe(400);
    const tooMany = await post('/api/conversations/hermes/h1/messages', { attachments: Array(5).fill(file('a.png', 'image/png', png)) });
    expect(tooMany.statusCode).toBe(400);
    expect(hermes.calls).toEqual([]);

    // A photo alone is a message, and file names lose their directories.
    const ok = await post('/api/conversations/hermes/h1/messages', { attachments: [file('../../etc/a.png', 'image/png', png)] });
    expect(ok.statusCode).toBe(200);
    expect(hermes.calls).toEqual(['send:h1::+a.png']);
  });
});

describe('new Hermes chats', () => {
  it('offers the models and starts a chat on the one picked', async () => {
    const { app, hermes } = await setup();
    const options = await app.inject({ url: '/api/hermes/options', headers: apiHeaders(token) });
    expect(options.statusCode).toBe(200);
    expect(options.json()).toEqual({
      models: [{ id: '["local","flash-next"]', label: 'flash-next', group: 'Local' }],
      defaultModel: '["local","flash-next"]',
    });
    const post = (body: unknown) =>
      app.inject({ method: 'POST', url: '/api/hermes/conversations', headers: postHeaders(token), payload: JSON.stringify(body) });
    expect((await post({ text: 'hi', model: '["local","flash-next"]', confirmModel: true })).statusCode).toBe(200);
    expect((await post({ text: 'hi', model: 5 })).statusCode).toBe(400);
    expect((await post({ text: 'hi', model: '' })).statusCode).toBe(400);
    expect((await post({ text: 'hi', confirmModel: 'yes' })).statusCode).toBe(400);
    expect(hermes.calls).toEqual(['options', 'create:hi', 'create-model:["local","flash-next"]:confirmed']);
  });
});

describe('folders for new chats', () => {
  it('says whether a folder exists and makes a new one, under the usual rules', async () => {
    const { app, paseo } = await setup();
    const get = (path: string) => app.inject({ url: `/api/folders?path=${encodeURIComponent(path)}`, headers: apiHeaders(token) });
    expect((await get('/home/me/code')).json()).toEqual({ status: 'exists' });
    expect((await get('/home/me/notes')).json()).toEqual({ status: 'missing' });
    expect((await get('/home/me/nope/deeper')).json()).toEqual({ status: 'missing-parent' });
    expect((await get('code')).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/folders', headers: apiHeaders(token) })).statusCode).toBe(400);

    const post = (body: unknown, extra: Record<string, string> = {}) =>
      app.inject({ method: 'POST', url: '/api/folders', headers: postHeaders(token, extra), payload: JSON.stringify(body) });
    const made = await post({ path: '/home/me/notes' });
    expect(made.statusCode).toBe(200);
    expect(made.json()).toEqual({ path: '/home/me/notes' });
    expect((await post({ path: 'notes' })).statusCode).toBe(400);
    expect((await post({ path: '/home/me/x', parents: true })).statusCode).toBe(400);
    // Same rules as the rest of the API.
    expect((await post({ path: '/home/me/y' }, { 'x-signalbox-request': '' })).statusCode).toBe(403);
    expect((await post({ path: '/home/me/y' }, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect(paseo.calls.filter((c) => c.startsWith('mkdir:'))).toEqual(['mkdir:/home/me/notes']);
  });

  it("passes on what Hermes says when it didn't keep the folder", async () => {
    const { app, hermes } = await setup();
    hermes.createNotice = 'Hermes started this chat in ~, not ~/typo.';
    const res = await app.inject({
      method: 'POST',
      url: '/api/hermes/conversations',
      headers: postHeaders(token),
      payload: JSON.stringify({ text: 'hi', cwd: '/home/me/typo' }),
    });
    expect(res.json()).toEqual({ source: 'hermes', id: 'new-hermes', notice: 'Hermes started this chat in ~, not ~/typo.' });
  });
});

describe('"/" commands', () => {
  it('lists commands per conversation and for new chats, and says who runs them', async () => {
    const { app, hermes } = await setup();
    const get = (url: string) => app.inject({ url, headers: apiHeaders(token) });

    const res = await get('/api/conversations/hermes/h1/commands');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ commands: [{ name: 'status', kind: 'command', description: 'Show session info' }], runner: 'signalbox' });
    expect((await get('/api/conversations/paseo/p1/commands')).json()).toEqual({ commands: [], runner: 'agent' });
    expect((await get('/api/hermes/commands')).json()).toMatchObject({ commands: [{ name: 'plan' }], runner: 'signalbox' });
    expect(hermes.calls).toEqual(['commands:h1', 'commands:new']);

    // Same rules as the rest of the API.
    const noMarker = await app.inject({ url: '/api/hermes/commands', headers: { ...apiHeaders(token), 'x-signalbox-request': '' } });
    expect(noMarker.statusCode).toBe(403);
  });

  it('validates control changes and copes with sources that have no controls', async () => {
    const { app } = await setup();
    const url = '/api/conversations/paseo/p1/controls';
    expect((await app.inject({ url, headers: apiHeaders(token) })).json()).toEqual({ controls: [] });
    const post = (body: unknown) => app.inject({ method: 'POST', url, headers: postHeaders(token), payload: JSON.stringify(body) });
    expect((await post({ control: 'yolo', value: '1' })).statusCode).toBe(400);
    expect((await post({ control: 'mode', value: 'x', extra: true })).statusCode).toBe(400);
    expect((await post({ control: 'mode', value: 'plan' })).statusCode).toBe(404);
  });

  it('returns what a command produced with the send reply', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations/hermes/h1/messages',
      headers: postHeaders(token),
      payload: JSON.stringify({ text: '/status' }),
    });
    expect(res.json()).toEqual({ ok: true, command: { items: [{ kind: 'command', id: 'cmd-1', command: '/status', output: 'all good' }] } });
  });
});

describe('live event socket', () => {
  async function listen() {
    const ctx = await setup();
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (ctx.app.server.address() as { port: number }).port;
    ctx.config.allowedHosts.add(`127.0.0.1:${port}`);
    return { ...ctx, url: `ws://127.0.0.1:${port}/ws` };
  }

  function connect(url: string, headers: Record<string, string>) {
    const ws = new WebSocket(url, { headers });
    // Rejected handshakes emit 'error'; the assertions look at the response instead.
    ws.on('error', () => {});
    cleanups.push(async () => ws.terminate());
    return ws;
  }

  async function rejectionStatus(ws: WebSocket): Promise<number> {
    const [, res] = (await once(ws, 'unexpected-response')) as [unknown, { statusCode: number }];
    return res.statusCode;
  }

  it('refuses sockets from other origins (cross-site WebSocket hijacking)', async () => {
    const { url } = await listen();
    const ws = connect(url, { origin: 'https://evil.example', 'cf-access-jwt-assertion': token });
    expect(await rejectionStatus(ws)).toBe(403);
  });

  it('refuses sockets without an Access token', async () => {
    const { url } = await listen();
    expect(await rejectionStatus(connect(url, { origin: ORIGIN }))).toBe(401);
  });

  it('greets an authenticated socket and routes timeline events only to subscribers', async () => {
    const { url, hub } = await listen();
    const received: ServerEvent[] = [];
    const ws = connect(url, { origin: ORIGIN, 'cf-access-jwt-assertion': token });
    ws.on('message', (data) => received.push(JSON.parse(String(data))));
    await once(ws, 'open');
    await expect.poll(() => received[0]?.type).toBe('hello');

    hub.publish({ type: 'items_upsert', source: 'hermes', conversationId: 'h1', items: [] });
    ws.send(JSON.stringify({ type: 'subscribe', source: 'hermes', conversationId: 'h1' }));
    await expect.poll(() => hub.isWatched('hermes', 'h1')).toBe(true);
    hub.publish({ type: 'items_upsert', source: 'hermes', conversationId: 'h1', items: [] });
    hub.publish({ type: 'conversation_removed', source: 'paseo', id: 'p9' });

    await expect.poll(() => received.map((e) => e.type)).toEqual(['hello', 'items_upsert', 'conversation_removed']);
  });

  it('recycles long-lived sockets so they re-authenticate through Access', async () => {
    const ctx = await setup({ wsMaxLifetimeMs: 300 });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (ctx.app.server.address() as { port: number }).port;
    ctx.config.allowedHosts.add(`127.0.0.1:${port}`);
    const ws = connect(`ws://127.0.0.1:${port}/ws`, { origin: ORIGIN, 'cf-access-jwt-assertion': token });
    const [code] = (await once(ws, 'close')) as [number];
    expect(code).toBe(WS_CLOSE_REAUTH);
  });

  it('closes the socket when the Access session expires', async () => {
    const { url } = await listen();
    const shortLived = await makeToken(keys, { expiresIn: Math.floor(Date.now() / 1000) + 2 });
    const ws = connect(url, { origin: ORIGIN, 'cf-access-jwt-assertion': shortLived });
    const [code] = (await once(ws, 'close')) as [number];
    expect(code).toBe(WS_CLOSE_SESSION_EXPIRED);
  });
});

// Keep the CryptoKey type import used for editors that check unused imports.
export type { CryptoKey };
