import { afterEach, describe, expect, it, vi } from 'vitest';
import { HelperClient } from '../src/connectors/helper.js';

afterEach(() => vi.unstubAllGlobals());

async function fixture(roleAware = true, listingRole = 'shadow') {
  const capabilities = { roleAware };
  const requests: Array<{ path: string; role: string | undefined; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const route = path.replace(/^\/v1\/shadow/, '');
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ path, role: headers.get('x-wayroost-role') ?? undefined, body });
    return Response.json(path === '/health' ? { role: capabilities.roleAware ? 'shadow' : undefined, roleAware: capabilities.roleAware }
      : route === '/skills' ? { role: listingRole, skills: [] }
      : { role: 'shadow', workdir: '/home/me/fake-trigger', script: 'wayroost_mail_trigger.py' });
  }));
  return { requests, capabilities, helper: new HelperClient(8896, 'fake-helper-token', 'shadow') };
}

describe('helper HTTP role hand-off', () => {
  it('sends the shadow header and body even when a caller asks for primary', async () => {
    const { requests, helper } = await fixture();
    expect(await helper.putTrigger('fake0001', 'label:fake-demo', 'primary')).toMatchObject({ role: 'shadow' });
    await helper.skills();
    expect(requests.every((r) => r.role === 'shadow')).toBe(true);
    expect(requests.find((r) => r.path === '/v1/shadow/triggers/fake0001')?.body).toEqual({ query: 'label:fake-demo', role: 'shadow' });
  });

  it('refuses an old helper before a skill listing or trigger write', async () => {
    const { requests, helper } = await fixture(false);
    await expect(helper.skills()).rejects.toThrow('role-aware');
    await expect(helper.putTrigger('fake0001', 'label:fake-demo')).rejects.toThrow('role-aware');
    expect(requests.map((r) => r.path)).toEqual(['/health', '/health']);
  });

  it('refuses a skill response that fails to acknowledge the shadow role', async () => {
    const { helper } = await fixture(true, 'primary');
    await expect(helper.skills()).rejects.toThrow('did not honour');
  });

  it('revalidates before every shadow request after the helper is replaced', async () => {
    const { requests, capabilities, helper } = await fixture();
    await helper.skills();
    capabilities.roleAware = false;
    await expect(helper.skills()).rejects.toThrow('role-aware');
    await expect(helper.putTrigger('fake0001', 'label:fake-demo')).rejects.toThrow('role-aware');
    await expect(helper.skillsVersion()).rejects.toThrow('role-aware');
    expect(requests.map((r) => r.path)).toEqual(['/health', '/v1/shadow/skills', '/health', '/health', '/health']);
    capabilities.roleAware = true;
    await helper.skills();
    expect(requests.slice(-2).map((r) => r.path)).toEqual(['/health', '/v1/shadow/skills']);
  });

  const operations: Array<{ name: string; method: string; path: string; call: (helper: HelperClient) => Promise<unknown> }> = [
    { name: 'Google status', method: 'GET', path: '/google', call: (h) => h.google() },
    { name: 'Google sign-in', method: 'POST', path: '/google/start', call: (h) => h.googleStart() },
    { name: 'Google finish', method: 'POST', path: '/google/finish', call: (h) => h.googleFinish('http://localhost:1/?code=fake-code') },
    { name: 'Google disconnect', method: 'POST', path: '/google/disconnect', call: (h) => h.googleDisconnect() },
    { name: 'shop status', method: 'GET', path: '/shops', call: (h) => h.shops() },
    { name: 'trigger queries', method: 'GET', path: '/triggers', call: (h) => h.triggerQueries() },
    { name: 'trigger roles', method: 'GET', path: '/triggers', call: (h) => h.triggerRoles() },
    { name: 'trigger write', method: 'PUT', path: '/triggers/fake0001', call: (h) => h.putTrigger('fake0001', 'label:fake-demo') },
    { name: 'trigger deletion', method: 'DELETE', path: '/triggers/fake0001', call: (h) => h.deleteTrigger('fake0001') },
    { name: 'WhatsApp status', method: 'GET', path: '/whatsapp-routing', call: (h) => h.whatsappRouting() },
    { name: 'WhatsApp routing', method: 'PUT', path: '/whatsapp-routing', call: (h) => h.setWhatsappRouting({ replyRouting: true, returnMinutes: 30, freshAfterHours: 12 }) },
    { name: 'phone status', method: 'GET', path: '/phone', call: (h) => h.phone() },
    { name: 'phone PIN read', method: 'GET', path: '/phone/pin', call: (h) => h.phonePin() },
    { name: 'phone PIN write', method: 'PUT', path: '/phone/pin', call: (h) => h.setPhonePin('0000') },
    { name: 'phone voice', method: 'PUT', path: '/phone/voice', call: (h) => h.setPhoneVoice('fake-voice') },
    { name: 'skill listing', method: 'GET', path: '/skills', call: (h) => h.skills() },
    { name: 'skill version', method: 'GET', path: '/skills/version', call: (h) => h.skillsVersion() },
    { name: 'skill content', method: 'GET', path: '/skills/content', call: (h) => h.skillContent('shared', 'demo') },
    { name: 'skill scan', method: 'POST', path: '/skills/scan', call: (h) => h.skillScan('shared', 'demo') },
    { name: 'skill share', method: 'POST', path: '/skills/share', call: (h) => h.skillShare('shared', 'demo', false) },
    { name: 'skill take-shared', method: 'POST', path: '/skills/take-shared', call: (h) => h.skillTakeShared('codex', 'demo') },
    { name: 'skill exclusion', method: 'PUT', path: '/skills/excluded', call: (h) => h.skillExcluded('demo', 'codex', true) },
    { name: 'skill removal', method: 'POST', path: '/skills/remove', call: (h) => h.skillRemove('demo') },
    { name: 'skill refresh', method: 'POST', path: '/skills/refresh', call: (h) => h.skillsRefresh() },
  ];

  it.each(operations)('refuses $name without effects when a legacy helper replaces health verification', async ({ method, path, call }) => {
    let legacy = false;
    const effects: string[] = [];
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const route = new URL(url).pathname;
      requests.push(`${init.method} ${route}`);
      if (route === '/health') {
        // Replacement happens after the role-aware health response, before the operation.
        legacy = true;
        return Response.json({ role: 'shadow', roleAware: true });
      }
      if (legacy && route === path && init.method === method) {
        effects.push(route);
        return Response.json({ version: 1, skills: [] });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    }));
    await expect(call(new HelperClient(8896, 'fake-helper-token', 'shadow'))).rejects.toThrow('not found');
    expect(requests).toEqual(['GET /health', `${method} /v1/shadow${path}`]);
    expect(effects).toEqual([]);
  });

  it('preserves skill-content query parameters on the versioned route', async () => {
    const { helper } = await fixture();
    await helper.skillContent('shared', 'demo');
    const fetchMock = vi.mocked(fetch);
    const url = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
    expect(url.pathname).toBe('/v1/shadow/skills/content');
    expect(Object.fromEntries(url.searchParams)).toEqual({ place: 'shared', name: 'demo' });
  });

  it.each(operations)('keeps the legacy primary route for $name', async ({ method, path, call }) => {
    const { requests } = await fixture();
    await call(new HelperClient(8896, 'fake-helper-token', 'primary'));
    expect(requests).toMatchObject([{ path, role: 'primary' }]);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.method).toBe(method);
  });

  it('uses the shadow transport when the client role is unresolved', async () => {
    const { requests } = await fixture();
    // @ts-expect-error Runtime callers must also fail closed when role resolution fails.
    const helper = new HelperClient(8896, 'fake-helper-token', undefined);
    await helper.skills();
    expect(requests.map((r) => r.path)).toEqual(['/health', '/v1/shadow/skills']);
    expect(requests.every((r) => r.role === 'shadow')).toBe(true);
  });
});
