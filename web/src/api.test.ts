import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, fetchMedia, refreshList, request, speakAudio, streamSpeech } from './api';
import { act, actionLines, load } from './power';
import { applyEvent, getState, markUnpaired, setState, toast } from './store';

const initialState = getState();
const device = { id: 'demo-desktop', name: 'Demo desktop', kind: 'desktop' as const, scopes: [], created: 1, lastSeen: 1 };
const powerStatus = { running: true, status: { overall: 'ok', sentence: 'Demo power', components: [], at: 1 }, sentence: 'Demo power', presence: [] };
/** A power action needs a known device and a supervisor that is answering, as on the Status page. */
async function readyPower(): Promise<void> {
  // These tests run without a DOM; the power client only asks whether the page is hidden.
  if (typeof document === 'undefined') vi.stubGlobal('document', { hidden: false });
  setState((s) => ({ ...s, device }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(powerStatus)));
  await load();
}
const needsPower = (path: string) => path === 'power action' || path === 'power lines';

afterEach(() => {
  setState(() => initialState);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('authentication loss on every renderer request path', () => {
  const paths = [
    ['JSON', () => request('GET', '/api/me')],
    ['media', () => fetchMedia('/api/media/hermes/demo-chat?p=demo&s=demo')],
    ['audio', () => speakAudio('Demo reply.')],
    ['speech stream', () => streamSpeech('Demo reply.', 1, new AbortController().signal).next()],
    ['power status', () => load()],
    ['power action', () => act({ verb: 'restart', target: 'wayroost-server', when: 'now' })],
    ['power lines', () => actionLines('demo-action')],
  ] as const;
  it.each(paths)('blocks ordinary browser work on a stalled %s 401 and retires within two seconds', async (path, run) => {
    if (needsPower(path)) await readyPower();
    vi.useFakeTimers();
    const unpaired = vi.fn();
    const suspend = vi.fn();
    const expired = vi.fn();
    const cancel = vi.fn();
    vi.stubGlobal('window', { wayroostTray: { unpaired, suspend, expired } });
    let finish!: (value: unknown) => void;
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    const fetch = vi.fn().mockResolvedValueOnce({ status: 200, ok: true, json: () => {
      reading(); return new Promise((resolve) => { finish = resolve; });
    } } as Response);
    vi.stubGlobal('fetch', fetch);
    const old = refreshList().catch(() => {});
    await started;
    fetch.mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 401 }));
    const pending = run().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(getState().sessionExpired || getState().unpaired).toBe(true);
    expect(suspend).not.toHaveBeenCalled();
    expect(expired).not.toHaveBeenCalled();
    const calls = fetch.mock.calls.length;
    await request('POST', '/api/demo-action', {}).catch(() => {});
    expect(fetch).toHaveBeenCalledTimes(calls);
    finish({ conversations: [], approvals: [{ id: 'demo-stale', source: 'hermes', conversationId: 'demo-chat' }], statuses: [] });
    await old;
    applyEvent({ type: 'approval_upsert', approval: { id: 'demo-stale', source: 'hermes', conversationId: 'demo-chat', kind: 'permission', title: 'Demo check', options: [], createdAt: 0 } });
    toast('Demo stale toast.');
    expect(getState()).toMatchObject({ approvals: {}, toasts: [], listLoaded: false });
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(unpaired).not.toHaveBeenCalled();
    expect(expired).not.toHaveBeenCalled();
    expect(getState()).toMatchObject({ unpaired: true, sessionExpired: false, approvals: {}, toasts: [] });
  });
  const answers = [
    ['unpaired', () => Response.json({ error: 'unpaired' }, { status: 401 })],
    ['expired', () => Response.json({ error: 'Sign in again.' }, { status: 401 })],
    ['unreadable', () => new Response('{', { status: 401 })],
    ['truncated revocation', () => new Response('{"error":"unpaired"', { status: 401 })],
    ['failed body read', () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('Demo read failed.')); } }), { status: 401 })],
    ['null', () => Response.json(null, { status: 401 })],
    ['missing error', () => Response.json({}, { status: 401 })],
    ['invalid error', () => Response.json({ error: 123 }, { status: 401 })],
    ['empty error', () => Response.json({ error: '' }, { status: 401 })],
    ['blank error', () => Response.json({ error: ' ' }, { status: 401 })],
    ['oversized body', () => Response.json({ error: 'Sign in again.', padding: 'x'.repeat(4096) }, { status: 401 })],
    ['redirect', () => Object.defineProperty(new Response(null), 'type', { value: 'opaqueredirect' })],
  ] as const;

  it.each(paths.flatMap(([path, run]) => answers.map(([cause, answer]) => ({ path, run, cause, answer }))))(
    'classifies $cause on $path in an ordinary browser', async ({ path, run, cause, answer }) => {
      const unpaired = vi.fn();
      const expired = vi.fn();
      vi.stubGlobal('window', { wayroostTray: { unpaired, expired } });
      if (needsPower(path)) await readyPower();
      vi.stubGlobal('fetch', vi.fn(async () => answer()));
      const approval = { id: 'demo-approval', source: 'hermes' as const, conversationId: 'demo-chat', kind: 'permission' as const,
        title: 'Run the demo check.', options: [], createdAt: 0 };
      setState((s) => ({ ...s, approvals: { 'demo-approval': approval }, listLoaded: true }));
      await run().catch((error: unknown) => {
        expect(error).toBeInstanceOf(ApiError);
        expect(error).toMatchObject({ kind: 'auth', message: cause !== 'expired' && cause !== 'redirect' ? "This device isn't paired." : 'Your sign-in expired.' });
      });
      if (cause !== 'expired' && cause !== 'redirect') {
        expect(unpaired).not.toHaveBeenCalled();
        expect(expired).not.toHaveBeenCalled();
        expect(getState()).toMatchObject({ unpaired: true, sessionExpired: false, approvals: {}, listLoaded: false });
        await run().catch(() => {});
        expect(unpaired).not.toHaveBeenCalled();
      } else {
        expect(unpaired).not.toHaveBeenCalled();
        expect(expired).not.toHaveBeenCalled();
        expect(getState()).toMatchObject({ unpaired: false, sessionExpired: true });
      }
    },
  );

  it.each(['media', 'audio'])('does not consume successful %s as JSON during authentication checks', async (kind) => {
    const bytes = new Uint8Array([1, 2, 3]);
    const response = new Response(bytes, { headers: { 'content-type': kind === 'media' ? 'image/png' : 'audio/wav' } });
    const json = vi.spyOn(response, 'json');
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const result = kind === 'media' ? await (await fetchMedia('/api/media/hermes/demo-chat?p=demo&s=demo')).arrayBuffer()
      : await speakAudio('Demo reply.');
    expect(new Uint8Array(result)).toEqual(bytes);
    expect(json).not.toHaveBeenCalled();
  });
});

describe('request', () => {
  it('classifies a concurrent revoked response after another request suspended the same device', async () => {
    const unpaired = vi.fn();
    vi.stubGlobal('window', { wayroostTray: { unpaired } });
    let finish!: (response: Response) => void;
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ error: 'Sign in again.' }, { status: 401 }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch);
    const expired = request('GET', '/api/demo-first').catch(() => {});
    const revoked = request('GET', '/api/demo-second');
    const rejected = expect(revoked).rejects.toMatchObject({ kind: 'auth', message: "This device isn't paired." });
    await expired;
    finish(Response.json({ error: 'unpaired' }, { status: 401 }));
    await rejected;
    expect(getState()).toMatchObject({ sessionExpired: false, unpaired: true });
    expect(unpaired).not.toHaveBeenCalled();
  });
  it('discards cached browser approvals on an unpaired response', async () => {
    const unpaired = vi.fn();
    vi.stubGlobal('window', { wayroostTray: { unpaired } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'unpaired' }), { status: 401 })));
    const approval = { id: 'demo-approval', source: 'hermes' as const, conversationId: 'demo-chat', kind: 'permission' as const,
      title: 'Run the demo check.', options: [], createdAt: 0 };
    setState((s) => ({ ...s, approvals: { 'demo-approval': approval }, listLoaded: true }));
    await expect(request('GET', '/api/me')).rejects.toMatchObject({ kind: 'auth', status: 401 });
    expect(unpaired).not.toHaveBeenCalled();
    expect(getState()).toMatchObject({ unpaired: true, approvals: {}, listLoaded: false });
    await expect(request('GET', '/api/me')).rejects.toMatchObject({ kind: 'auth', status: 401 });
    expect(unpaired).not.toHaveBeenCalled();
  });

  it.each([undefined, {}])('still marks an ordinary browser unpaired without the desktop bridge (%s)', (browser) => {
    vi.stubGlobal('window', browser);
    markUnpaired();
    expect(getState().unpaired).toBe(true);
  });

  it('keeps an expired Access session separate from device revocation', async () => {
    const unpaired = vi.fn();
    vi.stubGlobal('window', { wayroostTray: { unpaired } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Sign in again.' }), { status: 401 })));
    await expect(request('GET', '/api/me')).rejects.toMatchObject({ kind: 'auth' });
    expect(getState()).toMatchObject({ sessionExpired: true, unpaired: false });
    expect(unpaired).not.toHaveBeenCalled();
  });

  it('returns the parsed body of a successful answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ recent: { sent: 1 } }), { status: 200 })));
    await expect(request('GET', '/api/bridge')).resolves.toEqual({ recent: { sent: 1 } });
  });

  it('treats a success whose body cannot be read as a failed request, not an empty answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"recent": {"se', { status: 200 })));
    const failure = request('GET', '/api/bridge');
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({ kind: 'network', message: "Can't reach Wayroost. Check your connection." });
  });

  it('still reports the server error of a failed answer without a readable body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 500 })));
    await expect(request('GET', '/api/bridge')).rejects.toMatchObject({ kind: 'http', message: 'Request failed (500)' });
  });
});

it('uses GET for automatic conversation reads and POST only for a deliberate open', async () => {
  const detail = { conversation: { source: 'paseo', id: 'fake-chat', title: 'Demo chat', status: 'idle', updatedAt: 0, pendingApprovals: 0 }, items: [], approvals: [] };
  const fetch = vi.fn(async () => new Response(JSON.stringify(detail)));
  vi.stubGlobal('fetch', fetch);
  await api.conversation('paseo', 'fake-chat');
  expect(fetch).toHaveBeenLastCalledWith('/api/conversations/paseo/fake-chat', expect.objectContaining({ method: 'GET' }));
  await api.openConversation('paseo', 'fake-chat');
  expect(fetch).toHaveBeenLastCalledWith('/api/conversations/paseo/fake-chat/open', expect.objectContaining({ method: 'POST' }));
});
