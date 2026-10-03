import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { EventHub } from '../src/hub.js';
import { createAccessVerifier } from '../src/security/access.js';
import { FakeHermes, FakePaseo, makeConfig, makeKeys, makeToken, postHeaders, type Keys } from './helpers.js';

let keys: Keys;
let token: string;
beforeAll(async () => {
  keys = await makeKeys();
  token = await makeToken(keys);
});

it('keeps pid and hostname in Wayroost request logs', async () => {
  const lines: string[] = [];
  const config = makeConfig();
  const app = await buildApp({ config, sources: { hermes: new FakeHermes(), paseo: new FakePaseo() }, hub: new EventHub(),
    logger: { level: 'info', name: 'Wayroost', stream: { write: (line: string) => { lines.push(line); } } },
    verifier: createAccessVerifier({ ...config.access!, keySource: keys.keySource }) });
  try {
    const headers = postHeaders(token);
    delete headers['cf-access-jwt-assertion'];
    await app.inject({ method: 'GET', url: '/api/health', headers });
    await expect.poll(() => lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ name: 'Wayroost', pid: process.pid, hostname: expect.any(String) });
  } finally { await app.close(); }
});

describe.each(['shadow', 'primary'] as const)('%s authenticated actions', (role) => {
  async function fixture() {
    const config = { ...makeConfig(), role };
    const sources = { hermes: new FakeHermes(), paseo: new FakePaseo() };
    const app = await buildApp({ config, sources, hub: new EventHub(), logger: false,
      verifier: createAccessVerifier({ ...config.access!, keySource: keys.keySource }) });
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload, headers: postHeaders(token) });
    return { app, sources, post };
  }

  it('advertises the effective notification policy and requires a paired deliberate open', async () => {
    const { app, sources, post } = await fixture();
    const read = vi.spyOn(sources.paseo, 'getConversation');
    try {
      expect((await app.inject({ url: '/api/conversations', headers: postHeaders(token) })).json())
        .toMatchObject({ role, notifications: role === 'primary' });
      await app.inject({ url: '/api/conversations/paseo/fake-chat', headers: postHeaders(token) });
      expect(read).toHaveBeenLastCalledWith('fake-chat');
      read.mockClear();
      expect((await post('/api/conversations/paseo/fake-chat/open', {})).statusCode).toBe(200);
      expect(read).toHaveBeenLastCalledWith('fake-chat', true);
      read.mockClear();
      expect((await app.inject({ method: 'POST', url: '/api/conversations/paseo/fake-chat/open', headers: postHeaders(token, { cookie: '' }), payload: {} })).statusCode).toBe(401);
      expect(read).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('keeps signed messages, approvals, interrupts and new chats available', async () => {
    const { app, sources, post } = await fixture();
    try {
      for (const source of ['hermes', 'paseo'] as const) {
        const base = `/api/conversations/${source}/fake-chat`;
        expect((await post(`${base}/messages`, { text: 'Demo request' })).statusCode).toBe(200);
        expect((await post(`${base}/approvals/fake-approval`, { optionId: 'once' })).statusCode).toBe(200);
        expect((await post(`${base}/interrupt`, {})).statusCode).toBe(200);
        expect(sources[source].calls).toEqual(['send:fake-chat:Demo request', 'approve:fake-chat:fake-approval:once', 'interrupt:fake-chat']);
      }
      expect((await post('/api/hermes/conversations', { text: 'Demo chat' })).json()).toMatchObject({ id: 'new-hermes' });
      expect((await post('/api/paseo/conversations', { providerId: 'claude', cwd: '/home/me/code/demo', text: 'Demo chat' })).json())
        .toMatchObject({ id: 'new-paseo' });
    } finally { await app.close(); }
  });

  it('keeps signed chat tidying and folder creation available', async () => {
    const { app, sources, post } = await fixture();
    try {
      const threads = [{ source: 'hermes', id: 'fake-hermes' }, { source: 'paseo', id: 'fake-paseo' }];
      for (const action of ['archive', 'restore', 'delete']) {
        expect((await post(`/api/threads/${action}`, { threads })).json()).toEqual({ done: 2, failed: [] });
      }
      expect((await post('/api/folders', { path: '/home/me/code/demo' })).json()).toEqual({ path: '/home/me/code/demo' });
      expect(sources.paseo.calls).toContain('mkdir:/home/me/code/demo');
    } finally { await app.close(); }
  });

  it('still refuses unauthenticated writes before any backend call', async () => {
    const { app, sources } = await fixture();
    try {
      const headers = postHeaders(token);
      delete headers['cf-access-jwt-assertion'];
      const response = await app.inject({ method: 'POST', url: '/api/conversations/hermes/fake-chat/messages', headers, payload: { text: 'Demo request' } });
      expect(response.statusCode).toBe(401);
      expect(sources.hermes.calls).toEqual([]);
    } finally { await app.close(); }
  });

  it('refuses Access-only live mutations before any backend call', async () => {
    const { app, sources } = await fixture();
    const read = vi.spyOn(sources.paseo, 'getConversation');
    const headers = postHeaders(token, { cookie: '' });
    try {
      for (const source of ['hermes', 'paseo'] as const) {
        const base = `/api/conversations/${source}/fake-chat`;
        for (const [path, payload] of [
          ['open', {}], ['messages', { text: 'Demo request' }], ['controls', { control: 'mode', value: 'plan' }],
          ['interrupt', {}], ['approvals/fake-approval', { optionId: 'once' }],
        ] as const) {
          const response = await app.inject({ method: 'POST', url: `${base}/${path}`, headers, payload });
          expect(response.statusCode, `${source}/${path}`).toBe(401);
          expect(response.json()).toEqual({ error: 'unpaired' });
        }
      }
      const threads = [{ source: 'hermes', id: 'fake-hermes' }, { source: 'paseo', id: 'fake-paseo' }];
      for (const [method, url, payload] of [
        ['POST', '/api/hermes/conversations', { text: 'Demo chat' }],
        ['POST', '/api/paseo/conversations', { providerId: 'claude', cwd: '/home/me/code/demo', text: 'Demo chat' }],
        ['POST', '/api/folders', { path: '/home/me/code/demo' }],
        ['PUT', '/api/settings/hermes', { username: 'demo', password: 'fake-password' }],
        ['DELETE', '/api/settings/hermes', {}],
        ['PUT', '/api/cloud-agents/claude', { enabled: false }],
        ['POST', '/api/threads/archive', { threads }],
        ['POST', '/api/threads/restore', { threads }],
        ['POST', '/api/threads/delete', { threads }],
        ['POST', '/api/cleanup', { idleDays: 30 }],
      ] as const) {
        const response = await app.inject({ method, url, headers, payload });
        expect(response.statusCode, `${method} ${url}`).toBe(401);
        expect(response.json()).toEqual({ error: 'unpaired' });
      }
      expect(read).not.toHaveBeenCalled();
      for (const source of ['hermes', 'paseo'] as const) {
        expect(sources[source].calls).toEqual([]);
        expect(sources[source].tidying.calls).toEqual([]);
        expect(sources[source].tidying.idleBefore).toEqual([]);
      }
    } finally { await app.close(); }
  });
});
