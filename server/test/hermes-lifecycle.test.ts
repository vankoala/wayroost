import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BackgroundGate } from '../src/background.js';
import { HermesAdapter } from '../src/hermes/adapter.js';
import { deviceSignal } from '../src/security/device-signal.js';
import { SecretStore } from '../src/secrets.js';
import type { HermesSource } from '../src/sources.js';
import { FakeHermes, FAKE_USER } from './fake-hermes.js';
import { makeApp, makeKeys, makeToken, PHONE_COOKIE, postHeaders, TEST_DESKTOP, type Keys } from './helpers.js';

let keys: Keys; let token: string;
beforeAll(async () => { keys = await makeKeys(); token = await makeToken(keys); });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });

describe('Hermes shared lifecycle after credential saving', () => {
  it('reconnects after the saving device is revoked and accepts another device action', async () => {
    const ctx = await makeApp(keys); const fake = new FakeHermes(); await fake.start();
    const adapter = new HermesAdapter(fake.url, ctx.hub, new SecretStore(ctx.config.stateDir),
      { info() {}, warn() {}, error() {} }, { background: new BackgroundGate('primary') });
    cleanups.push(async () => { adapter.stop(); await fake.stop(); await ctx.app.close(); });
    vi.spyOn(ctx.hermes as HermesSource, 'setCredentials').mockImplementation((...args) => adapter.setCredentials(...args));
    vi.spyOn(ctx.hermes, 'sendMessage').mockImplementation((...args) => adapter.sendMessage(...args));
    const fetch = globalThis.fetch;
    const tickets: Array<AbortSignal | undefined> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/api/auth/ws-ticket')) {
        tickets.push(deviceSignal());
        if (tickets.length === 1) return new Response('{}', { status: 503 });
      }
      return fetch(input, init);
    });
    const saved = await ctx.app.inject({ method: 'PUT', url: '/api/settings/hermes', headers: postHeaders(token), payload: FAKE_USER });
    expect(saved.statusCode).toBe(200);
    await expect.poll(() => tickets.length).toBe(1);
    ctx.devices!.revoke(TEST_DESKTOP.id);
    await expect.poll(() => adapter.status().state, { timeout: 3000 }).toBe('connected');
    expect(tickets).toEqual([undefined, undefined]);
    const sent = await ctx.app.inject({ method: 'POST', url: `/api/conversations/hermes/${FakeHermes.stored}/messages`,
      headers: postHeaders(token, { cookie: PHONE_COOKIE }), payload: { text: 'Demo message' } });
    expect(sent.statusCode).toBe(200);
    expect(fake.calls.some(call => call.method === 'prompt.submit')).toBe(true);
    const refused = await ctx.app.inject({ method: 'PUT', url: '/api/settings/hermes', headers: postHeaders(token), payload: FAKE_USER });
    expect(refused.statusCode).toBe(401);
  });
});
