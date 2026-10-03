import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

it.each([undefined, 'http://127.0.0.1:19021/v1/'])('uses the generic assistant default or the configured endpoint (%s)', async configured => {
  vi.stubEnv('WAYROOST_ASSIST_URLS', configured);
  vi.stubEnv('SIGNALBOX_ASSIST_URLS', undefined);
  vi.resetModules();
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'demo-model' }] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'Demo answer' } }] })));
  vi.stubGlobal('fetch', fetch);
  const { Assist } = await import('../src/assist.js');
  expect(await new Assist().complete([{ role: 'user', content: 'Demo question' }])).toBe('Demo answer');
  const base = configured ? 'http://127.0.0.1:19021/v1' : 'http://127.0.0.1:19001/v1';
  expect(fetch.mock.calls.map(call => call[0])).toEqual([base + '/models', base + '/chat/completions']);
});
