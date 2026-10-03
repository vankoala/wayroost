import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvalKey } from '../src/approvals.js';
import { approval, deferred, fixture, identity, json, origin } from './authentication-fixture.js';

afterEach(() => { vi.useRealTimers(); });

describe('authentication losses across document cancellation', () => {
  it.each(['401', '302', 'redirect', 'error', 'completion'])('preserves a current-generation %s after reload', async (loss) => {
    vi.useFakeTimers(); const gate = await fixture();
    try {
      await gate.client.refresh();
      const ticket = gate.handlers.notify.mock.results[0]!.value;
      gate.start(1, '/api/me'); gate.discard();
      if (loss === 'redirect') gate.redirect(1);
      else if (loss === 'error') gate.fail(1);
      else if (loss === 'completion') gate.finish(1, 401);
      else expect(gate.receive(1, Number(loss))).toHaveBeenCalledWith({ cancel: true, responseHeaders: { 'Content-Type': ['application/json'] } });
      expect(gate.client.authenticationState).toBe('unverified');
      expect(gate.client.approvals.size).toBe(0);
      expect(gate.tickets.take(ticket)).toBeUndefined();
      const calls = gate.fetch.mock.calls.length;
      await expect(gate.client.allowOnce(approvalKey(approval))).rejects.toThrow();
      await expect(gate.client.presence('active')).rejects.toThrow();
      expect(gate.fetch).toHaveBeenCalledTimes(calls);
      expect(gate.start(2, '/api/presence', 42, 'POST')).toHaveBeenCalledWith({ cancel: true });
      const probe = deferred<Response>(); gate.fetch.mockImplementationOnce(() => probe.promise);
      const check = gate.client.revalidateAuthentication(0);
      expect(gate.fetch).toHaveBeenLastCalledWith(`${origin}/api/me`, expect.objectContaining({ method: 'GET' }));
      expect(gate.client.authenticationBlocked).toBe(true);
      probe.resolve(json(identity)); await check;
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it('ignores cancellation fallout after a fresh native check covered the loss', async () => {
    const gate = await fixture();
    try {
      gate.start(1); gate.start(2); gate.discard(); gate.receive(1, 401);
      await gate.client.revalidateAuthentication(0);
      expect(gate.client.authenticationState).toBe('verified');
      expect(gate.receive(2, 401)).toHaveBeenCalledWith({ cancel: true, responseHeaders: { 'Content-Type': ['application/json'] } });
      gate.fail(1); gate.fail(2);
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });
});

describe('app document authentication', () => {
  it.each(['net::ERR_ABORTED', 'net::ERR_BLOCKED_BY_CLIENT'].flatMap((error) =>
    ['reload', 'replacement'].flatMap((reason) => ['request', 'headers'].map((stage) => ({ error, reason, stage })))))
    ('ignores its own $stage cancellation $error after $reason and clears its deadline', async ({ error, reason, stage }) => {
      vi.useFakeTimers(); const gate = await fixture();
      try {
        gate.start(1);
        gate.discard(reason as 'reload' | 'replacement');
        const cancelled = stage === 'headers' ? gate.receive(1) : gate.start(1);
        expect(cancelled).toHaveBeenCalledWith(expect.objectContaining({ cancel: true }));
        await vi.advanceTimersByTimeAsync(10000);
        expect(gate.client.authenticationState).toBe('verified');
        gate.fail(1, error);
        expect(gate.client.authenticationState).toBe('verified');
      } finally { gate.client.stop(); }
    });

  it.each(['net::ERR_ABORTED', 'net::ERR_BLOCKED_BY_CLIENT'])('keeps an unowned %s as a request failure', async (error) => {
    const gate = await fixture();
    try {
      gate.start(1); gate.fail(1, error);
      expect(gate.client.authenticationState).toBe('unverified');
    } finally { gate.client.stop(); }
  });

  it('preserves a genuine network failure even after the guard cancelled delivery', async () => {
    const gate = await fixture();
    try {
      gate.start(1); gate.discard('replacement'); gate.receive(1); gate.fail(1);
      expect(gate.client.authenticationState).toBe('unverified');
    } finally { gate.client.stop(); }
  });

  it('retires deliberate replacement cancellations and their deadlines without losing verified authentication', async () => {
    vi.useFakeTimers(); const gate = await fixture();
    try {
      await gate.client.refresh();
      gate.start(1, '/chats', 42, 'GET', 'mainFrame'); gate.start(2);
      gate.discard('replacement');
      expect(gate.receive(1)).toHaveBeenCalledWith({ cancel: true, responseHeaders: { 'Content-Type': ['application/json'] } });
      gate.fail(1, 'net::ERR_ABORTED');
      await vi.advanceTimersByTimeAsync(10000);
      expect(gate.client.authenticationState).toBe('verified');
      gate.fail(2, 'net::ERR_ABORTED');
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it.each(['401', 'redirect', 'completion'])('preserves genuine queued %s from a deliberately replaced document', async (loss) => {
    const gate = await fixture();
    try {
      gate.start(1, '/chats', 42, 'GET', 'mainFrame'); gate.discard('replacement');
      if (loss === '401') gate.receive(1, 401);
      else if (loss === 'redirect') gate.redirect(1);
      else if (loss === 'network error') gate.fail(1);
      else gate.finish(1, 401);
      expect(gate.client.authenticationState).toBe('unverified');
    } finally { gate.client.stop(); }
  });

  it('owns a superseded main-frame abort without clearing approvals or toast tickets', async () => {
    const gate = await fixture();
    try {
      await gate.client.refresh();
      const ticket = gate.handlers.notify.mock.results[0]!.value;
      gate.start(1, '/chats', 42, 'GET', 'mainFrame'); gate.discard(); gate.fail(1, 'net::ERR_ABORTED');
      expect(gate.client.authenticationState).toBe('verified');
      expect(gate.client.approvals.size).toBe(1);
      expect(gate.handlers.removed).not.toHaveBeenCalled();
      expect(gate.tickets.take(ticket)).toMatchObject({ id: approval.id });
      gate.start(2, '/tasks', 42, 'GET', 'mainFrame'); gate.fail(2, 'net::ERR_ABORTED');
      expect(gate.client.authenticationState).toBe('unverified');
    } finally { gate.client.stop(); }
  });

  it.each(['401', 'redirect', 'completion'])('preserves genuine %s from a superseded main frame', async loss => {
    const gate = await fixture();
    try {
      gate.start(1, '/chats', 42, 'GET', 'mainFrame'); gate.discard();
      if (loss === '401') gate.receive(1, 401);
      else if (loss === 'redirect') gate.redirect(1, 'https://access.example.com/login');
      else gate.finish(1, 401);
      expect(gate.client.authenticationState).toBe('unverified');
    } finally { gate.client.stop(); }
  });

  it('does not retire native requests when intentionally replacing their renderer', async () => {
    const gate = await fixture();
    try {
      gate.start(1, '/api/conversations', -1); gate.discard('replacement'); gate.fail(1, 'net::ERR_ABORTED');
      expect(gate.client.authenticationState).toBe('unverified');
    } finally { gate.client.stop(); }
  });

  it.each(['401', 'redirect', 'completion'])('suspends approvals on an app-document %s', async (loss) => {
    vi.useFakeTimers(); const gate = await fixture();
    try {
      await gate.client.refresh();
      const ticket = gate.handlers.notify.mock.results[0]!.value;
      expect(gate.start(1, '/chats', 42, 'GET', 'mainFrame')).toHaveBeenCalledWith({});
      if (loss === 'redirect') gate.redirect(1);
      else if (loss === 'error') gate.fail(1);
      else if (loss === 'completion') gate.finish(1, 401);
      else if (loss === 'deadline') await vi.advanceTimersByTimeAsync(10000);
      else gate.receive(1, Number(loss));
      expect(gate.client.authenticationState).toBe('unverified');
      expect(gate.client.approvals.size).toBe(0);
      expect(gate.tickets.take(ticket)).toBeUndefined();
      const calls = gate.fetch.mock.calls.length;
      await expect(gate.client.allowOnce(approvalKey(approval))).rejects.toThrow();
      expect(gate.fetch).toHaveBeenCalledTimes(calls);
      await gate.client.revalidateAuthentication(0);
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it.each(['unverified', 'unpaired'])('keeps recovery documents and their assets loadable while %s', async (state) => {
    const gate = await fixture();
    try {
      gate.client.suspend(0);
      if (state === 'unpaired') {
        gate.fetch.mockResolvedValueOnce(json({ error: 'unpaired' }, 401));
        await gate.client.revalidateAuthentication(0);
      }
      expect(gate.client.authenticationState).toBe(state);
      for (const [id, path, resource] of [[1, '/pair', 'mainFrame'], [2, '/assets/demo.js', 'script']] as const) {
        expect(gate.start(id, path, 42, 'GET', resource)).toHaveBeenCalledWith({});
        expect(gate.receive(id)).toHaveBeenCalledWith({}); gate.finish(id);
      }
      expect(gate.start(3, '/api/conversations')).toHaveBeenCalledWith({ cancel: true });
      expect(gate.start(4, '/api/conversations', 42, 'GET', 'mainFrame')).toHaveBeenCalledWith({ cancel: true });
      expect(gate.start(5, '/pair', 43, 'GET', 'mainFrame')).toHaveBeenCalledWith({ cancel: true });
      expect(gate.client.authenticationState).toBe(state);
    } finally { gate.client.stop(); }
  });

  it.each(['headers', 'redirect', 'error'])('ignores an old document’s %s after replacement pairing is verified', async (loss) => {
    const gate = await fixture();
    try {
      gate.start(1, '/chats', 42, 'GET', 'mainFrame');
      await gate.client.pair('demo-code', 'Demo desktop');
      if (loss === 'headers') expect(gate.receive(1, 401)).toHaveBeenCalledWith({ cancel: true, responseHeaders: { 'Content-Type': ['application/json'] } });
      else if (loss === 'redirect') gate.redirect(1);
      else gate.fail(1);
      expect(gate.client.pairingGeneration).toBe(1);
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });
});
