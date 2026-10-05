import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';
import type { Approval, ListResponse } from '../../shared/protocol.js';
import { handshakeStatus, networkFailure, ServerClient, socketCloseAction, socketCloseLoss, type LiveSocket } from '../src/server-client.js';
import { json as snapshot, routedApproval } from './authentication-fixture.js';
import { approvalById, approvalKey, onceOption } from '../src/approvals.js';

const approval: Approval = { id: 'demo-approval', source: 'hermes', conversationId: 'demo:chat', kind: 'permission', title: 'Run the demo check.', detail: 'npm test', options: [{ id: 'once', label: 'Allow once', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' }], createdAt: 0 };
async function fixture() {
  const fetch = vi.fn(async () => snapshot({ role: 'primary', notifications: true, conversations: [], approvals: [approval], statuses: [] }));
  const notify = vi.fn(); const notification = vi.fn(); const changed = vi.fn(); const removed = vi.fn();
  const client = new ServerClient('http://127.0.0.1:8896', { fetch } as unknown as Session, { notify, notification, changed, removed });
  fetch.mockResolvedValueOnce(snapshot({ device: { id: 'demo-device', kind: 'desktop' } }));
  await client.revalidateAuthentication(0); fetch.mockClear();
  return { client, fetch, notify, notification, changed, removed };
}
describe('desktop server client', () => {
  it('does not toast approvals from snapshots or upserts without a server route', async () => {
    const { client, fetch, notify } = await fixture();
    fetch.mockResolvedValueOnce(snapshot({ role: 'primary', notifications: true, conversations: [], approvals: [approval], statuses: [], approvalNotifications: [] }));
    await client.refresh();
    client.receive({ type: 'approval_upsert', approval });
    expect(client.approvals.size).toBe(1); expect(notify).not.toHaveBeenCalled(); client.stop();
  });

  it('shows a routed finished alert once, including over the native socket', async () => {
    const { client, notification } = await fixture();
    await client.refresh();
    let socket!: LiveSocket;
    client.connect(() => (socket = { onopen: null, onmessage: null, onerror: null, onclose: null, close: vi.fn() }));
    socket.onopen?.({});
    const alert = { event: 'agent-finished' as const, source: 'hermes' as const, title: 'The task finished', url: '/c/hermes/demo', at: 1 };
    socket.onmessage?.({ data: JSON.stringify({ type: 'notification', notification: alert }) });
    client.receive({ type: 'notification', notification: alert });
    expect(notification).toHaveBeenCalledExactlyOnceWith(alert); client.stop();
  });

  it.each(['/\t/example.com/', '/\u0000/example.com/', '//example.com/', '/\\example.com/', 'https://example.com/'])(
    'rejects routed alerts with unsafe local URLs: %j', async (url) => {
      const { client, notification } = await fixture();
      await client.refresh();
      client.receive({ type: 'notification', notification: { event: 'agent-finished', source: 'hermes', title: 'A task finished', url, at: 1 } });
      expect(notification).not.toHaveBeenCalled();
      expect(client.authenticationBlocked).toBe(true); client.stop();
    },
  );

  it('rejects a routed approval whose identity differs from the authenticated pending request', async () => {
    const { client, fetch, notify } = await fixture();
    const alert = routedApproval({ ...approval, createdAt: 99 });
    fetch.mockResolvedValueOnce(snapshot({ role: 'primary', notifications: true, conversations: [], approvals: [approval], statuses: [], approvalNotifications: [alert] }));
    await client.refresh();
    expect(notify).not.toHaveBeenCalled(); client.stop();
  });
  it('reports an answer only for a snapshot that landed', async () => {
    const answered = vi.fn();
    let fail = true;
    const fetch = vi.fn(async (url: string) => { if (url.endsWith('/api/me')) return snapshot({ device: { id: 'demo-device', kind: 'desktop' } }); if (fail) throw new Error('offline'); return snapshot({ role: 'primary', notifications: true, conversations: [], approvals: [], statuses: [] }); });
    const client = new ServerClient('http://127.0.0.1:8896', { fetch } as unknown as Session, { notify: vi.fn(), changed: vi.fn(), removed: vi.fn(), answered });
    await client.revalidateAuthentication(0);
    await expect(client.refresh()).rejects.toThrow(); expect(answered).not.toHaveBeenCalled();
    fail = false; await client.revalidateAuthentication(0); await client.refresh(); expect(answered).toHaveBeenCalledTimes(1); client.stop();
  });
  it('uses existing approval route, allow option, and authenticated session', async () => {
    const { client, fetch } = await fixture(); await client.refresh(); await client.allowOnce(approvalKey(approval));
    expect(fetch).toHaveBeenLastCalledWith('http://127.0.0.1:8896/api/conversations/hermes/demo%3Achat/approvals/demo-approval', expect.objectContaining({
      method: 'POST', credentials: 'include', redirect: 'manual', body: '{"optionId":"once"}',
      headers: expect.objectContaining({ 'x-signalbox-request': '1', Origin: 'http://127.0.0.1:8896' }),
    }));
  });
  it('notifies once across upserts, reconnect snapshots, and removals', async () => {
    const { client, notify, changed } = await fixture();
    client.receive({ type: 'approval_upsert', approval }); await client.refresh(); await client.refresh();
    expect(notify).toHaveBeenCalledTimes(1);
    client.receive({ type: 'approval_removed', source: approval.source, conversationId: approval.conversationId, approvalId: approval.id });
    expect(client.approvals.size).toBe(0); expect(changed).toHaveBeenCalled();
    await expect(client.allowOnce(approvalKey(approval))).rejects.toThrow();
  });
  it('keys approvals by source, conversation and id', async () => {
    const { client, notify, fetch } = await fixture();
    const other: Approval = { ...approval, conversationId: 'demo-session', title: 'Something else.' };
    // Toasts need a snapshot that says the server is a primary allowing them.
    await client.refresh(); client.receive({ type: 'approval_upsert', approval }); client.receive({ type: 'approval_upsert', approval: other });
    fetch.mockResolvedValueOnce(snapshot({ role: 'primary', notifications: true, conversations: [], approvals: [approval, other], statuses: [] }));
    await client.refresh();
    expect(client.approvals.size).toBe(2); expect(notify).toHaveBeenCalledTimes(2);
    expect(approvalById(client.approvals.values(), approval.id)).toBeUndefined();
    await client.allowOnce(approvalKey(other));
    expect(fetch).toHaveBeenLastCalledWith('http://127.0.0.1:8896/api/conversations/hermes/demo-session/approvals/demo-approval', expect.anything());
  });
  it('closes resolved toasts and toasts a reused id again', async () => {
    const { client, notify, removed, fetch } = await fixture();
    await client.refresh();
    fetch.mockResolvedValueOnce(snapshot({ role: 'primary', notifications: true, conversations: [], approvals: [], statuses: [] }));
    await client.refresh();
    expect(removed).toHaveBeenCalledWith(approvalKey(approval));
    const again = { ...approval, title: 'A new request, same id.', createdAt: 5 };
    client.receive({ type: 'approval_upsert', approval: again });
    fetch.mockResolvedValueOnce(snapshot({ role: 'primary', notifications: true, conversations: [], approvals: [again], statuses: [] }));
    await client.refresh();
    expect(notify).toHaveBeenCalledTimes(2);
    client.receive({ type: 'approval_removed', source: approval.source, conversationId: 'demo:other', approvalId: approval.id });
    expect(client.approvals.size).toBe(1); expect(removed).toHaveBeenCalledTimes(1);
  });
  it('retires the old toast when a reconnect snapshot shows a reused id as a new request', async () => {
    const { client, notify, removed, fetch } = await fixture();
    await client.refresh();
    // Answered and asked again while the socket was down: the snapshot has the same key, a new createdAt.
    const again = { ...approval, title: 'A new request, same id.', createdAt: 9 };
    fetch.mockResolvedValueOnce(snapshot({ role: 'primary', notifications: true, conversations: [], approvals: [again], statuses: [] }));
    await client.refresh();
    expect(removed).toHaveBeenCalledWith(approvalKey(approval));
    expect(notify).toHaveBeenCalledTimes(2); expect(notify).toHaveBeenLastCalledWith(again);
    expect(removed.mock.invocationCallOrder[0]).toBeLessThan(notify.mock.invocationCallOrder[1]!);
    expect(client.approvals.get(approvalKey(approval))).toEqual(again);
    // Ordinary updates of the same request (same createdAt) neither retire nor toast again.
    client.receive({ type: 'approval_upsert', approval: { ...again, title: 'Updated title.' } });
    expect(notify).toHaveBeenCalledTimes(2); expect(removed).toHaveBeenCalledTimes(1);
  });
  it('never lets an older snapshot land after a newer one', async () => {
    const { client, fetch, notify, removed } = await fixture();
    // Request n answers with the server's state when it was asked: nothing at first, then approval B.
    const b: Approval = { ...approval, id: 'demo-approval-b', title: 'A newer request.', createdAt: 3 };
    const replies: Array<() => void> = [];
    fetch.mockImplementation(() => new Promise<Response>((resolve) => {
      const approvals = fetch.mock.calls.length === 1 ? [] : [b];
      replies.push(() => resolve(snapshot({ role: 'primary', notifications: true, conversations: [], approvals, statuses: [] })));
    }));
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    // A toast activation refreshes directly while a socket hint (B was just asked) refreshes too.
    const activation = client.refresh(); client.hint(); await flush();
    // Answer the newest request first, the way a slow older response arrives last.
    while (replies.length) { while (replies.length) replies.pop()!(); await flush(); }
    await activation; await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect([...client.approvals.keys()]).toEqual([approvalKey(b)]);
    expect(notify).toHaveBeenCalledWith(b); expect(removed).not.toHaveBeenCalled();
    // An unreadable approval body suspends queued snapshots until main checks identity.
    fetch.mockResolvedValueOnce(new Response('{'));
    fetch.mockImplementationOnce(async () => snapshot({ role: 'primary', notifications: true, conversations: [], approvals: [], statuses: [] }));
    const failed = client.refresh().catch((error: unknown) => error); const next = client.refresh().catch((error: unknown) => error);
    expect(await failed).toBeInstanceOf(Error); expect(await next).toBeInstanceOf(Error);
    expect(client.authenticationBlocked).toBe(true); client.stop();
    expect(removed).toHaveBeenCalledWith(approvalKey(b));
  });
  it('allows from a toast only the option that is unambiguously once', () => {
    const paseo = (options: Approval['options']): Approval => ({ ...approval, source: 'paseo', options });
    const hermes = (options: Approval['options']): Approval => ({ ...approval, options });
    const deny = { id: 'deny', label: 'Deny', kind: 'deny' as const };
    expect(onceOption(approval)).toEqual(approval.options[0]);
    expect(onceOption(hermes([{ id: 'once', label: 'Allow once', kind: 'allow' }, { id: 'session', label: 'Allow for this chat', kind: 'allow_session' }, { id: 'always', label: 'Always allow', kind: 'allow_always' }, deny]))?.id).toBe('once');
    for (const item of [
      // Paseo's own fallback pair can't be told from provider actions that reuse its ids, so neither is once.
      paseo([{ id: 'allow', label: 'Allow', kind: 'allow' }, deny]),
      paseo([{ id: 'allow', label: 'Implement (then auto-accepts edits)', kind: 'allow' }, deny]),
      paseo([{ id: 'implement', label: 'Implement (then auto-accepts edits)', kind: 'allow' }, deny]),
      paseo([{ id: 'yes', label: "Yes, and don't ask again", kind: 'allow' }, { id: 'no', label: 'No', kind: 'deny' }]),
      paseo([{ id: 'allow', label: 'Allow', kind: 'allow' }, deny, { id: 'implement', label: 'Implement', kind: 'allow' }]),
      hermes([{ id: 'session', label: 'Allow for this chat', kind: 'allow_session' }, deny]),
      hermes([{ id: 'once', label: 'Allow once', kind: 'allow' }, { id: 'once', label: 'Allow once', kind: 'allow' }, deny]),
      { ...approval, kind: 'question' as const },
    ]) expect(onceOption(item)).toBeUndefined();
  });
  it('refuses truncated and non-permission approvals', async () => {
    const { client, fetch } = await fixture();
    const { detail: _detail, ...blind } = approval;
    for (const item of [{ ...approval, detailTruncated: true }, { ...approval, kind: 'question' as const }, { ...approval, options: [] }, blind, { ...approval, detail: 'pwd\u2028rm /tmp/demo' }]) {
      client.receive({ type: 'approval_upsert', approval: item });
      await expect(client.allowOnce(approvalKey(item))).rejects.toThrow('Open this approval');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps future pairing and presence routes behind the interface', async () => {
    const { client, fetch } = await fixture();
    fetch.mockResolvedValueOnce(snapshot({ device: { id: 'demo-device', kind: 'desktop' } }));
    fetch.mockResolvedValueOnce(snapshot({ device: { id: 'demo-device', kind: 'desktop' } }));
    await client.pair('demo-code', 'Demo desktop');
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8896/api/pair', expect.objectContaining({ body: '{"code":"demo-code","name":"Demo desktop"}' }));
    await client.presence('locked');
    expect(fetch).toHaveBeenLastCalledWith('http://127.0.0.1:8896/api/presence', expect.objectContaining({ body: '{"state":"locked"}' }));
  });
  it('coalesces socket approval hints into authenticated snapshots and ignores them after stop', async () => {
    const { client, fetch } = await fixture();
    let socket!: LiveSocket;
    client.connect(() => (socket = { onopen: null, onmessage: null, onerror: null, onclose: null, close: vi.fn() }));
    socket.onopen?.({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.connected).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    socket.onmessage?.({ data: JSON.stringify({ type: 'approval_upsert', approval }) });
    socket.onmessage?.({ data: JSON.stringify({ type: 'approval_removed', source: approval.source, conversationId: approval.conversationId, approvalId: approval.id }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(3);
    client.stop(); socket.onmessage?.({ data: JSON.stringify({ type: 'approval_upsert' }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe('shadow desktop notification policy', () => {
  const policySnapshot = (policy: Pick<ListResponse, 'role' | 'notifications'>, approvals: Approval[] = [approval]) =>
    snapshot({ ...policy, conversations: [], approvals, statuses: [] });

  it.each([
    { role: 'shadow', notifications: false }, { role: 'shadow', notifications: true },
    { role: 'primary', notifications: false }, {},
  ] as const)('retains approvals and deliberate responses without toasting under %j', async (policy) => {
    const { client, fetch, notify } = await fixture();
    client.receive({ type: 'approval_upsert', approval });
    expect(notify).not.toHaveBeenCalled();
    fetch.mockImplementation(async () => policySnapshot(policy));
    await client.refresh();
    client.receive({ type: 'approval_upsert', approval: { ...approval, createdAt: 2 } });
    await client.refresh();
    expect(notify).not.toHaveBeenCalled();
    expect(client.approvals.size).toBe(1);
    expect(client.shadow).toBe(policy.role === 'shadow');
    await client.allowOnce(approvalKey(approval));
    expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('/approvals/demo-approval'), expect.objectContaining({ method: 'POST' }));
    client.stop();
  });

  it('closes existing toasts on a primary-to-shadow policy change without dropping approval cards', async () => {
    const { client, fetch, notify, removed } = await fixture();
    await client.refresh();
    expect(notify).toHaveBeenCalledOnce();
    fetch.mockImplementation(async () => policySnapshot({ role: 'shadow', notifications: false }));
    await client.refresh();
    expect(removed).toHaveBeenCalledWith(approvalKey(approval));
    expect(client.approvals.size).toBe(1);
    expect(client.shadow).toBe(true);
    client.receive({ type: 'approval_upsert', approval: { ...approval, createdAt: 7 } });
    expect(notify).toHaveBeenCalledOnce();
    client.stop();
  });

  it('forgets the role and the toast permission when sign-in is suspended, until a fresh snapshot', async () => {
    const { client, fetch, notify } = await fixture();
    fetch.mockImplementation(async () => policySnapshot({ role: 'shadow', notifications: false }));
    await client.refresh();
    expect(client.shadow).toBe(true);
    client.suspend(client.pairingGeneration);
    expect(client.shadow).toBe(false);
    expect(client.approvals.size).toBe(0);
    fetch.mockResolvedValueOnce(snapshot({ device: { id: 'demo-device', kind: 'desktop' } }));
    await client.revalidateAuthentication(client.pairingGeneration);
    // Verified again, but no snapshot yet: an event alone toasts nothing.
    client.receive({ type: 'approval_upsert', approval: { ...approval, createdAt: 9 } });
    expect(notify).not.toHaveBeenCalled();
    fetch.mockImplementation(async () => policySnapshot({ role: 'primary', notifications: true }));
    await client.refresh();
    expect(client.shadow).toBe(false);
    expect(notify).toHaveBeenCalledOnce();
    client.stop();
  });
});

describe('native socket refusals and reconnects', () => {
  // Close reasons as Electron's net.WebSocket reports them on Windows: the status only appears in the text.
  const refused = (status: number) => ({ code: 1006, reason: `Error during WebSocket handshake: Unexpected response code: ${status} (net::ERR_FAILED)` });
  const unauthorized = { code: 1006, reason: 'HTTP Authentication failed; no valid credentials available (net::OK)' };
  const unreachable = { code: 1006, reason: 'Error in connection establishment: net::ERR_CONNECTION_REFUSED' };
  const emptyResponse = { code: 1006, reason: 'Connection closed before receiving a handshake response (net::ERR_EMPTY_RESPONSE)' };
  const reset = { code: 1006, reason: 'Error in connection establishment: net::ERR_CONNECTION_RESET' };
  // Failures before opening that aren't positively identified: other wordings of a refusal or a network failure,
  // empty or missing text, another status, and the pin check's own rejection. All of them fail closed.
  const unrecognized = [
    ['a 403 refusal in other words', { code: 1006, reason: 'WebSocket handshake failed: unexpected status 403' }],
    ['a 503 refusal in other words', { code: 1006, reason: 'Unexpected response code: 503' }],
    ['a network failure in other words', { code: 1006, reason: 'Connection establishment failed: net::ERR_CONNECTION_REFUSED' }],
    ['an empty reason', { code: 1006, reason: '' }],
    ['no reason', { code: 1006 }],
    ['an unexpected status', refused(404)],
    ['a certificate rejection', { code: 1006, reason: 'Error in connection establishment: net::ERR_FAILED' }],
    ['a clean close before opening', { code: 1000 }],
  ] as const;
  async function socketFixture() {
    vi.useFakeTimers();
    let identity: () => Response = () => snapshot({ device: { id: 'demo-device', kind: 'desktop' } });
    const identityChecks: number[] = [];
    let begin = 0;
    const fetch = vi.fn(async (url: string) => {
      if (!url.endsWith('/api/me')) return snapshot({ role: 'primary', notifications: true, conversations: [], approvals: [approval], statuses: [] });
      identityChecks.push(Date.now() - begin); return identity();
    });
    const handlers = { notify: vi.fn(), changed: vi.fn(), removed: vi.fn(), unpaired: vi.fn(), paired: vi.fn() };
    const client = new ServerClient('http://127.0.0.1:8896', { fetch } as unknown as Session, handlers);
    await client.revalidateAuthentication(0);
    begin = Date.now(); identityChecks.length = 0;
    const sockets: Array<LiveSocket & { at: number }> = [];
    let unbuildable = false;
    client.connect(() => {
      if (unbuildable) { unbuildable = false; throw new Error('Demo socket constructor failure'); }
      const socket = { onopen: null, onmessage: null, onerror: null, onclose: null, close: vi.fn(), at: Date.now() - begin };
      sockets.push(socket); return socket;
    });
    sockets[0]!.onopen?.({}); await vi.advanceTimersByTimeAsync(0);
    expect(client.approvals.size).toBe(1); expect(handlers.notify).toHaveBeenCalledOnce();
    /** Closes the open first socket so the next attempt, a second later, is one that never opened. */
    const attempt = async () => { sockets[0]!.onclose?.({ code: 1000 }); await vi.advanceTimersByTimeAsync(1000); return sockets.at(-1)!; };
    return { client, fetch, handlers, sockets, identityChecks, attempt, failNextSocket: () => { unbuildable = true; },
      setIdentity: (next: () => Response) => { identity = next; } };
  }
  const unpairedIdentity = () => new Response(JSON.stringify({ error: 'unpaired' }), { status: 401 });
  afterEach(() => vi.useRealTimers());

  it('reconnects only on positively identified network failures and 5xx refusals before opening', () => {
    expect(handshakeStatus(refused(403))).toBe(403);
    expect(handshakeStatus(refused(503))).toBe(503);
    expect(handshakeStatus(unauthorized)).toBe(401);
    for (const event of [unreachable, emptyResponse, { code: 1000, reason: refused(403).reason }, { code: 4403 }, ...unrecognized.filter(([name]) => name !== 'an unexpected status').map(([, item]) => item)]) {
      expect(handshakeStatus(event), JSON.stringify(event)).toBeUndefined();
    }
    for (const event of [unreachable, emptyResponse, reset]) expect(networkFailure(event), event.reason).toBe(true);
    for (const event of [{ code: 1006, reason: 'Error in connection establishment: net::ERR_INSECURE_RESPONSE' }, refused(503), ...unrecognized.map(([, item]) => item)]) {
      expect(networkFailure(event), JSON.stringify(event)).toBe(false);
    }
    for (const event of [refused(503), refused(500), unreachable, emptyResponse, reset]) expect(socketCloseAction(event, false), event.reason).toBe('reconnect');
    for (const event of [unauthorized, refused(403), refused(302), ...unrecognized.map(([, item]) => item)]) {
      expect(socketCloseAction(event, false), JSON.stringify(event)).toBe('suspend');
    }
    // An open socket's ordinary close reconnects; its authentication closes do not.
    for (const code of [1000, 1006, 1011, 4000]) expect(socketCloseAction({ code }, true)).toBe('reconnect');
    for (const code of [4401, 4403]) expect(socketCloseAction({ code }, true)).toBe('suspend');
    expect(socketCloseLoss(refused(403), false)).toBe('unpaired');
    expect(socketCloseLoss(refused(403), true)).toBeNull();
    expect(socketCloseLoss({ code: 4401 }, true)).toBe('session-expired');
  });

  it.each([
    ['an upgrade refused with 401', unauthorized, false], ['an upgrade refused with 403', refused(403), false],
    ['a redirected upgrade', refused(302), false], ['a 4401 close', { code: 4401 }, true], ['a 4403 close', { code: 4403 }, true],
    ...unrecognized.map(([name, event]) => [name, event, false] as const),
  ] as const)('suspends approvals and stops reconnecting after %s when the identity check finds the desktop unpaired', async (_name, event, opened) => {
    const { client, handlers, sockets, attempt, setIdentity } = await socketFixture();
    try {
      const socket = opened ? sockets[0]! : await attempt();
      const before = sockets.length;
      setIdentity(unpairedIdentity);
      socket.onclose?.(event);
      expect(client.authenticationState).toBe('unverified');
      expect(client.approvals.size).toBe(0); expect(handlers.removed).toHaveBeenCalledOnce();
      // The identity check finds the desktop revoked: no socket is attempted again, however long it waits.
      await vi.advanceTimersByTimeAsync(120000);
      expect(client.authenticationState).toBe('unpaired'); expect(handlers.unpaired).toHaveBeenCalledOnce();
      expect(sockets).toHaveLength(before);
    } finally { client.stop(); }
  });

  it.each([['an upgrade refused with 403', refused(403)] as const, ...unrecognized])('reconnects after %s only once a fresh identity check verifies, after its back-off', async (_name, event) => {
    const { client, handlers, sockets, attempt } = await socketFixture();
    try {
      (await attempt()).onclose?.(event);
      expect(client.authenticationState).toBe('unverified'); expect(client.approvals.size).toBe(0);
      expect(handlers.removed).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(999);
      expect(client.authenticationState).toBe('unverified'); expect(sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.authenticationState).toBe('verified'); expect(sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(2000);
      expect(sockets).toHaveLength(3);
    } finally { client.stop(); }
  });

  it('stays suspended after an unrecognized failure while the identity check fails, retrying the check with back-off', async () => {
    const { client, sockets, identityChecks, attempt, setIdentity } = await socketFixture();
    try {
      setIdentity(() => new Response(JSON.stringify({ error: 'Demo unavailable' }), { status: 503 }));
      const socket = await attempt();
      socket.onclose?.({ code: 1006, reason: '' });
      const closedAt = 1000;
      await vi.advanceTimersByTimeAsync(15000);
      expect(identityChecks.map(at => at - closedAt)).toEqual([1000, 3000, 7000, 15000]);
      expect(client.authenticationState).toBe('unverified'); expect(client.approvals.size).toBe(0);
      expect(sockets).toHaveLength(2);
      // Network failures of the check itself keep it suspended too.
      setIdentity(() => { throw new TypeError('Demo offline'); });
      await vi.advanceTimersByTimeAsync(16000);
      expect(identityChecks).toHaveLength(5); expect(client.authenticationState).toBe('unverified'); expect(sockets).toHaveLength(2);
      setIdentity(() => snapshot({ device: { id: 'demo-device', kind: 'desktop' } }));
      await vi.advanceTimersByTimeAsync(30000);
      expect(client.authenticationState).toBe('verified'); expect(sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(2000);
      expect(sockets).toHaveLength(3);
    } finally { client.stop(); }
  });

  it('fails closed when the socket cannot be made, and makes it again only after a verified check', async () => {
    const { client, handlers, sockets, failNextSocket } = await socketFixture();
    try {
      failNextSocket(); sockets[0]!.onclose?.({ code: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(client.authenticationState).toBe('unverified'); expect(handlers.removed).toHaveBeenCalledOnce();
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(client.authenticationState).toBe('verified'); expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2000);
      expect(sockets).toHaveLength(2);
    } finally { client.stop(); }
  });

  it('reconnects as soon as a re-paired desktop verifies', async () => {
    const { client, sockets, setIdentity } = await socketFixture();
    try {
      setIdentity(unpairedIdentity);
      sockets[0]!.onclose?.({ code: 4403 }); await vi.advanceTimersByTimeAsync(1000);
      expect(client.authenticationState).toBe('unpaired');
      setIdentity(() => snapshot({ device: { id: 'demo-device', kind: 'desktop' } }));
      await client.pair('demo-code', 'Demo desktop');
      expect(client.authenticationState).toBe('verified'); expect(sockets).toHaveLength(2);
    } finally { client.stop(); }
  });

  it.each([
    ['a refused upgrade with 503', refused(503)], ['a refused upgrade with 500', refused(500)],
    ['an unreachable server', unreachable], ['a server closing before its response', emptyResponse], ['a reset connection', reset],
  ] as const)('keeps approvals and reconnects with back-off doubling to thirty seconds after %s, reset by an open', async (_name, event) => {
    const { client, sockets, identityChecks } = await socketFixture();
    try {
      sockets[0]!.onclose?.({ code: 1000 });
      let failed = 1;
      while (sockets.length < 9) {
        await vi.advanceTimersByTimeAsync(1000);
        if (sockets.length > failed && sockets.length < 9) { sockets.at(-1)!.onclose?.(event); failed = sockets.length; }
      }
      expect(sockets.slice(1).map(socket => socket.at)).toEqual([1000, 3000, 7000, 15000, 31000, 61000, 91000, 121000]);
      expect(client.authenticationState).toBe('verified'); expect(client.approvals.size).toBe(1); expect(identityChecks).toEqual([]);
      // A socket that opens resets the back-off: its next close, even without a reason, reconnects after one second.
      const opened = sockets.at(-1)!; opened.onopen?.({}); await vi.advanceTimersByTimeAsync(0);
      opened.onclose?.({ code: 1006 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets.at(-1)!.at).toBe(sockets.at(-2)!.at + 1000);
      expect(client.authenticationState).toBe('verified');
    } finally { client.stop(); }
  });
});
