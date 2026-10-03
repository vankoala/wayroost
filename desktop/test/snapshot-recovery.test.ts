import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvalKey } from '../src/approvals.js';
import { approval, connectionLost, deferred, fixture, json, snapshot } from './authentication-fixture.js';

afterEach(() => vi.useRealTimers());

describe('ordinary snapshot recovery', () => {
  it.each(['HTTP 503', 'network'])('retries %s without another socket hint', async failure => {
    vi.useFakeTimers(); const gate = await fixture();
    try {
      if (failure === 'HTTP 503') gate.fetch.mockResolvedValueOnce(json({ error: 'Demo unavailable' }, 503));
      else gate.fetch.mockRejectedValueOnce(new Error('Demo offline'));
      gate.sockets[0]!.onopen?.({}); await vi.advanceTimersByTimeAsync(0);
      expect(gate.client.authenticationState).toBe('verified');
      expect(gate.handlers.notify).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(gate.fetch).toHaveBeenCalledTimes(2);
      expect(gate.client.approvals.get(approvalKey(approval))).toEqual(approval);
      expect(gate.handlers.notify).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60000);
      expect(gate.fetch).toHaveBeenCalledTimes(2);
    } finally { gate.client.stop(); }
  });

  it('caps retry backoff and cancels retries when their connection is retired', async () => {
    vi.useFakeTimers(); const gate = await fixture();
    try {
      gate.fetch.mockImplementation(async () => json({ error: 'Demo unavailable' }, 503));
      gate.client.hint(); await vi.advanceTimersByTimeAsync(0);
      const attempts = [0]; let elapsed = 0;
      while (elapsed < 91000) {
        const before = gate.fetch.mock.calls.length;
        await vi.advanceTimersByTimeAsync(1000); elapsed += 1000;
        if (gate.fetch.mock.calls.length !== before) attempts.push(elapsed);
      }
      expect(attempts).toEqual([0, 1000, 3000, 7000, 15000, 31000, 61000, 91000]);
      gate.sockets[0]!.onclose?.(connectionLost);
      const calls = gate.fetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60000);
      expect(gate.fetch).toHaveBeenCalledTimes(calls);
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it.each(['suspend', 'pair', 'stop'])('cancels a scheduled retry on %s', async retirement => {
    vi.useFakeTimers(); const gate = await fixture();
    try {
      gate.fetch.mockResolvedValueOnce(json({}, 503));
      gate.client.hint(); await vi.advanceTimersByTimeAsync(0);
      if (retirement === 'suspend') {
        gate.fetch.mockImplementationOnce(() => new Promise(() => {}));
        gate.client.suspend(0);
      }
      else if (retirement === 'pair') gate.client.beginPairing(0, Symbol());
      else gate.client.stop();
      await vi.advanceTimersByTimeAsync(1000);
      const snapshots = gate.fetch.mock.calls.filter(([url]) => url.endsWith('/api/conversations'));
      expect(snapshots).toHaveLength(1);
    } finally { gate.client.stop(); }
  });
});

describe('snapshot connection ownership', () => {
  it('retires snapshots started between a close and the next socket open', async () => {
    vi.useFakeTimers(); const gate = await fixture();
    try {
      gate.sockets[0]!.onclose?.(connectionLost);
      const response = deferred<Response>(); const reading = deferred<void>();
      gate.fetch.mockImplementationOnce(() => { reading.resolve(); return response.promise; });
      const old = gate.client.refresh().catch((error: unknown) => error); await reading.promise;
      await vi.advanceTimersByTimeAsync(1000);
      gate.fetch.mockResolvedValueOnce(json({ ...snapshot, role: 'shadow', notifications: false }));
      gate.sockets[1]!.onopen?.({}); await vi.advanceTimersByTimeAsync(0);
      response.resolve(json(snapshot)); await vi.advanceTimersByTimeAsync(0);
      expect(await old).toBeInstanceOf(Error);
      expect(gate.client.shadow).toBe(true);
      expect(gate.client.authenticationState).toBe('verified');
      expect(gate.handlers.notify).not.toHaveBeenCalled();
    } finally { gate.client.stop(); }
  });

  it.each(['primary', 'malformed', '401'])('retires a pending %s snapshot and queued refreshes before reconnecting', async stale => {
    vi.useFakeTimers(); const gate = await fixture();
    try {
      await gate.client.refresh();
      const ticket = gate.handlers.notify.mock.results[0]!.value;
      const response = deferred<Response>(); const reading = deferred<void>();
      gate.fetch.mockImplementationOnce(() => { reading.resolve(); return response.promise; });
      const old = gate.client.refresh().catch((error: unknown) => error);
      const queued = gate.client.refresh().catch((error: unknown) => error);
      await reading.promise;
      const oldSignal = gate.fetch.mock.calls.at(-1)![1]!.signal!;
      gate.sockets[0]!.onclose?.(connectionLost);
      expect(gate.client.authenticationState).toBe('verified');
      expect(gate.client.approvals.get(approvalKey(approval))).toEqual(approval);
      expect(gate.handlers.removed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      const current = deferred<Response>();
      gate.fetch.mockImplementationOnce(() => current.promise);
      gate.sockets[1]!.onopen?.({}); await vi.advanceTimersByTimeAsync(0);
      response.resolve(stale === '401' ? json({ error: 'unpaired' }, 401) : stale === 'malformed' ? json({ approvals: null })
        : json({ ...snapshot, approvals: [approval, { ...approval, id: 'demo-stale-approval' }] }));
      await vi.advanceTimersByTimeAsync(0);
      expect(await old).toBeInstanceOf(Error); expect(await queued).toBeInstanceOf(Error);
      expect(oldSignal.aborted).toBe(true);
      expect(gate.fetch).toHaveBeenCalledTimes(3);
      expect(gate.client.authenticationState).toBe('verified');
      expect(gate.handlers.notify).toHaveBeenCalledOnce();
      expect(gate.tickets.take(ticket)).toMatchObject({ id: approval.id });
      current.resolve(json({ ...snapshot, role: 'shadow', notifications: false }));
      await vi.advanceTimersByTimeAsync(0);
      expect(gate.client.shadow).toBe(true);
      expect(gate.handlers.notify).toHaveBeenCalledOnce();
      expect(gate.client.approvals.size).toBe(1);
    } finally { gate.client.stop(); }
  });

  it('owns Chromium cancellation fallout from a retired native snapshot', async () => {
    const gate = await fixture();
    try {
      await gate.client.refresh();
      gate.start(1, '/api/conversations', -1); gate.receive(1);
      gate.sockets[0]!.onclose?.(connectionLost);
      gate.fail(1, 'net::ERR_ABORTED');
      expect(gate.client.authenticationState).toBe('verified');
      expect(gate.client.approvals.size).toBe(1);
    } finally { gate.client.stop(); }
  });

  it.each(['primary', 'invalid', 'unreadable'])('ignores a retired %s snapshot body after the new connection applies its policy', async stale => {
    vi.useFakeTimers(); const gate = await fixture();
    try {
      const body = deferred<unknown>(); const reading = deferred<void>();
      gate.fetch.mockResolvedValueOnce({ status: 200, ok: true, json: () => { reading.resolve(); return body.promise; } } as Response);
      const pending = gate.client.refresh().catch((error: unknown) => error); await reading.promise;
      gate.sockets[0]!.onclose?.(connectionLost);
      await vi.advanceTimersByTimeAsync(1000);
      gate.fetch.mockResolvedValueOnce(json({ ...snapshot, role: 'shadow', notifications: false }));
      gate.sockets[1]!.onopen?.({}); await vi.advanceTimersByTimeAsync(0);
      expect(gate.client.shadow).toBe(true);
      if (stale === 'unreadable') body.reject(new Error('Demo truncated body'));
      else body.resolve(stale === 'invalid' ? { approvals: null } : snapshot);
      await vi.advanceTimersByTimeAsync(0);
      expect(await pending).toBeInstanceOf(Error);
      expect(gate.client.authenticationState).toBe('verified');
      expect(gate.client.shadow).toBe(true);
      expect(gate.handlers.notify).not.toHaveBeenCalled();
    } finally { gate.client.stop(); }
  });
});
