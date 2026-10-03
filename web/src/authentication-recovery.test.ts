import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.useRealTimers(); });

async function fixture() {
  let publish!: (state: 'verified' | 'unverified' | 'unpaired') => void;
  const anomaly = vi.fn(); const socketClosed = vi.fn();
  const bridge = { anomaly, socketClosed, onAuthentication: (listener: typeof publish) => { publish = listener; listener('verified'); } };
  vi.stubGlobal('window', { wayroostTray: bridge });
  const store = await import('./store');
  return { ...store, anomaly, socketClosed, publish };
}

it('renders only main’s state, clears local approvals on suspension, and cannot restore itself', async () => {
  const gate = await fixture();
  const approval = { id: 'demo-approval', source: 'hermes' as const, conversationId: 'demo-chat', kind: 'permission' as const, title: 'Demo check.', options: [], createdAt: 0 };
  gate.setState((state) => ({ ...state, approvals: { demo: approval }, listLoaded: true, toasts: [{ id: 1, text: 'Demo toast.', tone: 'info' }] }));
  gate.publish('unverified');
  expect(gate.getState()).toMatchObject({ sessionExpired: true, unpaired: false, approvals: {}, toasts: [], listLoaded: false });
  gate.markUnpaired(); expect(gate.getState().unpaired).toBe(false); expect(gate.anomaly).toHaveBeenCalledTimes(1);
  gate.setState((state) => ({ ...state, sessionExpired: false, approvals: { demo: approval } }));
  gate.applyEvent({ type: 'approval_upsert', approval });
  expect(gate.getState()).toMatchObject({ sessionExpired: true, approvals: {} });
  gate.publish('unpaired'); expect(gate.getState().unpaired).toBe(true);
  gate.publish('verified'); expect(gate.authenticationBlocked()).toBe(false);
});

const paths = ['JSON', 'media', 'audio', 'power status', 'power action', 'power lines'] as const;
/** A power action needs a known device and a supervisor that is answering, as on the Status page. */
async function readyPower(gate: Awaited<ReturnType<typeof fixture>>, path: string, load: () => Promise<void>): Promise<void> {
  if (path !== 'power action' && path !== 'power lines') return;
  // These tests run without a DOM; the power client only asks whether the page is hidden.
  if (typeof document === 'undefined') vi.stubGlobal('document', { hidden: false });
  gate.setState((s) => ({ ...s, device: { id: 'demo-desktop', name: 'Demo desktop', kind: 'desktop', scopes: [], created: 1, lastSeen: 1 } }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ running: true, status: { overall: 'ok', sentence: 'Demo power', components: [], at: 1 }, sentence: 'Demo power', presence: [] })));
  await load();
}
it.each(paths)('forwards %s anomalies without deciding desktop authentication or echoing suspension', async (path) => {
  const gate = await fixture();
  const { request, fetchMedia, speakAudio } = await import('./api');
  const { load, act, actionLines } = await import('./power');
  const run = () => path === 'JSON' ? request('GET', '/api/me') : path === 'media' ? fetchMedia('/api/media/hermes/demo-chat?p=demo')
    : path === 'audio' ? speakAudio('Demo reply.') : path === 'power status' ? load()
      : path === 'power action' ? act({ verb: 'restart', target: 'wayroost-server', when: 'now' }) : actionLines('demo-action');
  await readyPower(gate, path, load);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'unpaired' }, { status: 401 })));
  await run().catch(() => {});
  expect(gate.anomaly).toHaveBeenCalled(); expect(gate.authenticationBlocked()).toBe(false);
  const count = gate.anomaly.mock.calls.length;
  gate.publish('unverified'); expect(gate.authenticationBlocked()).toBe(true);
  expect(gate.anomaly).toHaveBeenCalledTimes(count);
  await run().catch(() => {}); expect(gate.getState().unpaired).toBe(false);
});

it.each(paths)('only identity reads forward %s fetch rejection to main', async (path) => {
  const gate = await fixture();
  const { request, fetchMedia, speakAudio } = await import('./api');
  const { load, act, actionLines } = await import('./power');
  await readyPower(gate, path, load);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Demo offline'); }));
  const pending = path === 'JSON' ? request('GET', '/api/me') : path === 'media' ? fetchMedia('/api/media/hermes/demo-chat?p=demo')
    : path === 'audio' ? speakAudio('Demo reply.') : path === 'power status' ? load()
      : path === 'power action' ? act({ verb: 'restart', target: 'wayroost-server', when: 'now' }) : actionLines('demo-action');
  await pending.catch(() => {});
  expect(gate.anomaly).toHaveBeenCalledTimes(path === 'JSON' || path === 'power status' ? 1 : 0);
  expect(gate.authenticationBlocked()).toBe(false);
});

it.each(['HTML', 'truncated JSON', 'null', 'missing device', 'invalid kind', 'empty id'])('reports successful power identity %s to main', async body => {
  const gate = await fixture(); const { load, powerSnapshot } = await import('./power');
  gate.setState(state => ({ ...state, approvals: { demo: { id: 'demo-approval', source: 'hermes', conversationId: 'demo-chat',
    kind: 'permission', title: 'Demo check.', options: [], createdAt: 0 } } }));
  const response = body === 'HTML' ? new Response('<html>Demo login</html>') : body === 'truncated JSON' ? new Response('{')
    : Response.json(body === 'null' ? null : body === 'missing device' ? {} : { device: { id: body === 'empty id' ? '' : 'demo-device', kind: body === 'empty id' ? 'desktop' : 'unknown' } });
  const fetch = vi.fn(async () => response); vi.stubGlobal('fetch', fetch);
  await load();
  expect(gate.anomaly).toHaveBeenCalledTimes(1); expect(powerSnapshot()).toBeNull();
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/me', expect.anything());
  gate.publish('unverified'); expect(gate.getState().approvals).toEqual({});
});

it('ignores an invalid power identity body after a newer hello established the device', async () => {
  const gate = await fixture(); const { load } = await import('./power');
  let reject!: (error: Error) => void;
  const response = new Response('{}');
  vi.spyOn(response, 'json').mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  vi.stubGlobal('fetch', vi.fn(async () => response));
  const pending = load();
  await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
  gate.applyEvent({ type: 'hello', device: { id: 'demo-new-device', name: 'Demo desktop', kind: 'desktop', scopes: [], created: 1, lastSeen: 1 }, statuses: [] });
  reject(new Error('Demo truncated body')); await pending;
  expect(gate.anomaly).not.toHaveBeenCalled(); expect(gate.getState().device?.id).toBe('demo-new-device');
});

it.each([404, 409, 429, 500, 503])('does not report unreadable power identity HTTP %s as an anomaly', async status => {
  const gate = await fixture(); const { load } = await import('./power');
  vi.stubGlobal('fetch', async () => new Response('<html>Demo unavailable</html>', { status }));
  await load(); expect(gate.anomaly).not.toHaveBeenCalled(); expect(gate.authenticationBlocked()).toBe(false);
});

it.each([404, 409, 429, 500, 503])('keeps renderer Tasks HTTP %s as an ordinary error', async status => {
  const gate = await fixture(); const { request } = await import('./api');
  vi.stubGlobal('fetch', async () => Response.json({ error: 'Demo unavailable.' }, { status }));
  await expect(request('GET', '/api/tasks')).rejects.toMatchObject({ kind: 'http', status });
  expect(gate.anomaly).not.toHaveBeenCalled(); expect(gate.authenticationBlocked()).toBe(false);
});

it.each(['/api/me', '/api/conversations', '/api/voice/speak'])('reads HTTP 403 on %s before classifying authentication', async path => {
  const gate = await fixture(); const { request } = await import('./api');
  vi.stubGlobal('fetch', async () => Response.json({ error: 'Demo operation forbidden.' }, { status: 403 }));
  await expect(request('GET', path)).rejects.toMatchObject({ kind: 'http', status: 403 });
  expect(gate.anomaly).not.toHaveBeenCalled();
  vi.stubGlobal('fetch', async () => Response.json({ error: 'unpaired' }, { status: 403 }));
  await expect(request('GET', path)).rejects.toMatchObject({ kind: 'auth', status: 403 });
  expect(gate.anomaly).toHaveBeenCalledTimes(1);
});

it('ignores an old request failure and success after main suspended the renderer', async () => {
  const gate = await fixture(); const { refreshList, request } = await import('./api');
  let resolve!: (value: Response) => void; let reject!: (error: Error) => void;
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise<Response>((_resolve, fail) => { reject = fail; }))
    .mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; })));
  const failed = request('GET', '/api/demo').catch(() => {}); const snapshot = refreshList().catch(() => {});
  gate.publish('unverified');
  reject(new Error('Demo late failure')); resolve(Response.json({ conversations: [], approvals: [{ id: 'demo-approval' }], statuses: [] }));
  await Promise.all([failed, snapshot]);
  expect(gate.anomaly).not.toHaveBeenCalled(); expect(gate.getState().approvals).toEqual({});
});

it.each([4401, 4403])('forwards current renderer socket %s with ownership and ignores delayed losses after suspension', async (code) => {
  const gate = await fixture();
  vi.stubGlobal('location', { protocol: 'https:', host: 'wayroost.example.com' });
  const sockets: DemoSocket[] = [];
  class DemoSocket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0; onopen = null; onmessage = null; onclose: ((event: { code: number }) => void) | null = null;
    close = vi.fn(); send = vi.fn();
    constructor() { sockets.push(this); }
  }
  vi.stubGlobal('WebSocket', DemoSocket);
  const { connect } = await import('./events'); connect();
  sockets[0]!.onclose?.({ code }); expect(gate.socketClosed).toHaveBeenCalledExactlyOnceWith(code);
  expect(gate.authenticationBlocked()).toBe(false);
  gate.publish('unverified'); gate.publish('verified');
  expect(sockets).toHaveLength(2);
  sockets[0]!.onclose?.({ code: 4403 }); expect(gate.socketClosed).toHaveBeenCalledTimes(1);
  expect(gate.getState().unpaired).toBe(false);
});
