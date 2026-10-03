import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvalKey } from '../src/approvals.js';
import { UnpairedError } from '../src/server-client.js';
import { approval, deferred, fixture, identity, json, origin, snapshot } from './authentication-fixture.js';

afterEach(() => { vi.useRealTimers(); });

describe('main authentication state machine', () => {
  it('starts unverified and cannot publish approvals before main checks the current identity', async () => {
    const gate = await fixture(false);
    try {
      expect(gate.client.authenticationState).toBe('unverified');
      expect(gate.sockets).toHaveLength(0);
      gate.client.receive({ type: 'approval_upsert', approval });
      await expect(gate.client.refresh()).rejects.toBeInstanceOf(UnpairedError);
      await expect(gate.client.presence('active')).rejects.toBeInstanceOf(UnpairedError);
      expect(gate.fetch).not.toHaveBeenCalled();
      await gate.client.revalidateAuthentication(0);
      expect(gate.fetch).toHaveBeenCalledWith(`${origin}/api/me`, expect.objectContaining({ method: 'GET', credentials: 'include' }));
      expect(gate.client.authenticationState).toBe('verified');
      expect(gate.sockets).toHaveLength(1);
    } finally { gate.client.stop(); }
  });

  const anomalies: Array<[string, () => Promise<Response>]> = [
    ['native login redirect rejection', async () => { throw new TypeError('Demo redirect error'); }],
    ['network rejection', async () => { throw new Error('Demo offline'); }],
    ...[301, 302, 303, 307, 308, 401, 403].map((status): [string, () => Promise<Response>] => [`status ${status}`, async () => json({ error: 'unpaired' }, status)]),
    ['opaque redirect', async () => ({ status: 0, ok: false, type: 'opaqueredirect' }) as Response],
    ['followed redirect', async () => ({ status: 200, ok: true, redirected: true }) as Response],
    ['malformed success body', async () => new Response('{')],
    ['unreadable success body', async () => ({ status: 200, ok: true, json: async () => { throw new Error('Demo cut connection'); } }) as unknown as Response],
  ];
  it.each(anomalies)('suspends on %s, clears tickets, and discards late snapshots before a fresh check', async (_name, response) => {
    const gate = await fixture();
    try {
      await gate.client.refresh();
      const ticket = gate.handlers.notify.mock.results[0]!.value;
      const body = deferred<unknown>(); const reading = deferred<void>();
      gate.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => { reading.resolve(); return body.promise; } } as Response);
      const old = gate.client.refresh().catch((error: unknown) => error);
      await reading.promise;
      gate.fetch.mockImplementationOnce(response);
      await expect(gate.client.request('/api/me')).rejects.toThrow();
      expect(gate.client.authenticationBlocked).toBe(true);
      expect(gate.client.unpaired).toBe(false);
      expect(gate.client.approvals.size).toBe(0);
      expect(gate.tickets.take(ticket)).toBeUndefined();
      expect(gate.handlers.removed).toHaveBeenCalledWith(approvalKey(approval));
      await expect(gate.client.allowOnce(approvalKey(approval))).rejects.toThrow();
      gate.client.receive({ type: 'approval_upsert', approval });
      body.resolve(snapshot); expect(await old).toBeInstanceOf(UnpairedError);
      expect(gate.client.approvals.size).toBe(0);
      const posts = gate.fetch.mock.calls.filter(([, init]) => init?.method === 'POST').length;
      await gate.client.revalidateAuthentication(gate.client.pairingGeneration);
      expect(gate.client.authenticationBlocked).toBe(false);
      expect(gate.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(posts);
    } finally { gate.client.stop(); }
  });

  it.each(['pending fetch', 'pending body'])('bounds a %s and blocks POSTs at its deadline', async (stage) => {
    vi.useFakeTimers(); const gate = await fixture();
    try {
      await gate.client.refresh();
      if (stage === 'pending fetch') gate.fetch.mockImplementationOnce(() => new Promise(() => {}));
      else gate.fetch.mockResolvedValueOnce({ status: 200, ok: true, json: () => new Promise(() => {}) } as Response);
      const pending = gate.client.request('/api/me').catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10000);
      expect(await pending).toBeInstanceOf(Error);
      expect(gate.client.authenticationState).toBe('unverified');
      expect(gate.client.approvals.size).toBe(0);
      await expect(gate.client.presence('active')).rejects.toThrow();
    } finally { gate.client.stop(); }
  });

  it.each([4401, 4403])('suspends a current native socket close %s and requires /api/me', async (code) => {
    vi.useFakeTimers(); const gate = await fixture();
    try {
      await gate.client.refresh();
      gate.sockets[0]!.onclose?.({ code });
      expect(gate.client.authenticationState).toBe('unverified');
      expect(gate.handlers.unpaired).not.toHaveBeenCalled();
      expect(gate.client.approvals.size).toBe(0);
      await gate.client.revalidateAuthentication(0);
      expect(gate.client.authenticationState).toBe('verified');
      // The closed socket's back-off still applies after the fresh check, so a refusal can't loop every second.
      expect(gate.sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(gate.sockets).toHaveLength(2);
      gate.sockets[0]!.onclose?.({ code: 4403 });
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it.each(['repeated malformed socket frames', 'invalid snapshot'])('suspends on %s', async (anomaly) => {
    const gate = await fixture();
    try {
      if (anomaly === 'socket error') gate.sockets[0]!.onerror?.({});
      else if (anomaly === 'repeated malformed socket frames') {
        for (let attempt = 0; attempt < 3; attempt += 1) gate.sockets[0]!.onmessage?.({ data: '{' });
      } else if (anomaly === 'socket constructor failure') {
        gate.client.suspend(0); gate.client.connect(() => { throw new Error('Demo constructor failure'); });
        await gate.client.revalidateAuthentication(0);
      } else { gate.fetch.mockResolvedValueOnce(json({ approvals: null })); await gate.client.refresh().catch(() => {}); }
      expect(gate.client.authenticationState).toBe('unverified');
    } finally { gate.client.stop(); }
  });

  it.each(['expired', 'unreadable 401', 'missing error', 'invalid JSON', 'no device', 'phone', 'blank id', 'redirect', 'network', 'stalled body', 'oversized body'])('stays unverified after a %s identity check', async (failure) => {
    vi.useFakeTimers(); const gate = await fixture();
    try {
      gate.client.suspend(0);
      if (failure === 'network') gate.fetch.mockRejectedValueOnce(new Error('Demo offline'));
      else if (failure === 'stalled body') gate.fetch.mockResolvedValueOnce(new Response(new ReadableStream(), { status: 401 }));
      else gate.fetch.mockResolvedValueOnce(failure === 'expired' ? json({ error: 'Demo sign-in expired.' }, 401)
        : failure === 'unreadable 401' ? new Response('{', { status: 401 })
          : failure === 'missing error' ? json({}, 401)
            : failure === 'invalid JSON' ? new Response('{')
              : failure === 'redirect' ? json({}, 302)
                : failure === 'no device' ? json({ statuses: [] })
                  : failure === 'oversized body' ? json({ ...identity, demo: 'x'.repeat(5000) })
                    : json({ device: { id: failure === 'blank id' ? '' : 'demo-phone', kind: failure === 'phone' ? 'phone' : 'desktop' } }));
      const check = gate.client.revalidateAuthentication(0);
      await vi.advanceTimersByTimeAsync(failure === 'stalled body' ? 2000 : 0); await check;
      expect(gate.client.authenticationState).toBe('unverified');
      expect(gate.handlers.unpaired).not.toHaveBeenCalled();
      await expect(gate.client.presence('active')).rejects.toThrow();
      gate.fetch.mockResolvedValueOnce(json(identity));
      await gate.client.revalidateAuthentication(0);
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it('enters unpaired only when the current native identity check explicitly returns 401 unpaired', async () => {
    const gate = await fixture();
    try {
      gate.client.suspend(0);
      gate.fetch.mockResolvedValueOnce(json({ error: 'unpaired' }, 401));
      await gate.client.revalidateAuthentication(0);
      expect(gate.client.authenticationState).toBe('unpaired');
      expect(gate.handlers.unpaired).toHaveBeenCalledTimes(1);
      const count = gate.fetch.mock.calls.length;
      gate.client.suspend(0); await gate.client.revalidateAuthentication(0);
      expect(gate.fetch).toHaveBeenCalledTimes(count);
      await gate.client.pair('demo-code', 'Demo desktop');
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it('retries only identity checks with capped backoff while recovery remains published', async () => {
    vi.useFakeTimers(); const gate = await fixture();
    try {
      gate.fetch.mockRejectedValue(new Error('Demo offline'));
      gate.client.suspend(0);
      const attempts: number[] = [];
      let elapsed = 0;
      while (attempts.length < 7 && elapsed < 100000) {
        const before = gate.fetch.mock.calls.length;
        await vi.advanceTimersByTimeAsync(500); elapsed += 500;
        if (gate.fetch.mock.calls.length !== before) attempts.push(elapsed);
      }
      expect(attempts).toEqual([1000, 3000, 7000, 15000, 31000, 61000, 91000]);
      expect(gate.fetch.mock.calls.every(([url, init]) => url === `${origin}/api/me` && init?.method === 'GET')).toBe(true);
      expect(gate.handlers.authentication).toHaveBeenCalledWith('unverified', 0);
      gate.fetch.mockImplementation(async (url) => json(url.endsWith('/api/me') ? identity : snapshot));
      await vi.advanceTimersByTimeAsync(30000);
      expect(gate.client.authenticationState).toBe('verified');
      gate.client.stop(); const count = gate.fetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60000); expect(gate.fetch).toHaveBeenCalledTimes(count);
    } finally { gate.client.stop(); }
  });

  it.each(['new anomaly', 'replacement pairing', 'shutdown'])('ignores a successful identity body superseded by %s', async (cause) => {
    const gate = await fixture();
    try {
      gate.client.suspend(0);
      const body = deferred<unknown>(); const reading = deferred<void>();
      gate.fetch.mockResolvedValueOnce({ status: 200, ok: true, json: () => { reading.resolve(); return body.promise; } } as Response);
      const check = gate.client.revalidateAuthentication(0); await reading.promise;
      if (cause === 'new anomaly') gate.client.suspend(0);
      else if (cause === 'replacement pairing') gate.client.beginPairing(0, Symbol());
      else gate.client.stop();
      body.resolve(identity); await check;
      expect(gate.client.authenticationBlocked).toBe(true);
      expect(gate.handlers.paired).not.toHaveBeenCalled();
    } finally { gate.client.stop(); }
  });
});
