import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvalKey } from '../src/approvals.js';
import { UnpairedError } from '../src/server-client.js';
import { approval, deferred, fixture, identity, json, origin, snapshot } from './authentication-fixture.js';

afterEach(() => { vi.useRealTimers(); });

describe('owned Chromium authentication signals', () => {
  it.each([401, 302])('suspends renderer and native HTTP on status %s before delivering its body', async (status) => {
    const gate = await fixture();
    try {
      await gate.client.refresh();
      const ticket = gate.handlers.notify.mock.results[0]!.value;
      gate.start(1);
      const callback = gate.receive(1, status);
      expect(gate.client.authenticationState).toBe('unverified');
      expect(callback).toHaveBeenCalledWith({ cancel: true, responseHeaders: { 'Content-Type': ['application/json'] } });
      expect(gate.tickets.take(ticket)).toBeUndefined();
      expect(gate.client.approvals.size).toBe(0);
      await expect(gate.client.allowOnce(approvalKey(approval))).rejects.toThrow();
      await gate.client.revalidateAuthentication(0);
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it.each([42, 0, -1])('suspends rejected socket handshakes owned by contents %s before any retry', async (contents) => {
    const gate = await fixture();
    try {
      await gate.client.refresh();
      gate.start(1, `${origin.replace('https:', 'wss:')}/ws`, contents, 'GET', 'webSocket');
      gate.receive(1, 401);
      expect(gate.client.authenticationState).toBe('unverified');
      expect(gate.client.approvals.size).toBe(0);
      await gate.client.revalidateAuthentication(0);
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it('accepts a current 101 upgrade without treating it as an HTTP anomaly', async () => {
    const gate = await fixture();
    try {
      gate.start(1, `${origin.replace('https:', 'wss:')}/ws`, 42, 'GET', 'webSocket');
      expect(gate.receive(1, 101)).toHaveBeenCalledWith({});
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it.each(['redirect', 'network error', 'stalled body'])('suspends owned renderer work on %s', async (signal) => {
    vi.useFakeTimers(); const gate = await fixture();
    try {
      gate.start(1, signal === 'network error' ? '/api/me' : '/api/conversations');
      if (signal === 'redirect') gate.redirect(1);
      else if (signal === 'network error') gate.fail(1);
      else { gate.receive(1); await vi.advanceTimersByTimeAsync(10000); }
      expect(gate.client.authenticationState).toBe('unverified');
      expect(gate.start(2, '/api/presence', 42, 'POST')).toHaveBeenCalledWith({ cancel: true });
    } finally { gate.client.stop(); }
  });

  it('preserves owned native identity checks across reload while blocking every renderer probe', async () => {
    const gate = await fixture();
    try {
      gate.client.suspend(0);
      const body = deferred<unknown>(); const reading = deferred<void>();
      gate.fetch.mockImplementationOnce(async () => {
        expect(gate.start(1, '/api/me', -1)).toHaveBeenCalledWith({});
        expect(gate.receive(1)).toHaveBeenCalledWith({});
        expect(gate.start(2, '/api/me', -1)).toHaveBeenCalledWith({ cancel: true });
        expect(gate.start(3, '/api/me', 42)).toHaveBeenCalledWith({ cancel: true });
        return { status: 200, ok: true, json: () => { reading.resolve(); return body.promise; } } as Response;
      });
      const probe = gate.client.revalidateAuthentication(0); await reading.promise;
      gate.discard();
      expect(gate.receive(1)).toHaveBeenCalledWith({});
      await expect(gate.client.presence('active')).rejects.toThrow();
      body.resolve(identity); await probe;
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it('rejects late probe cookies once its main verification owner has finished', async () => {
    const gate = await fixture();
    try {
      gate.client.suspend(0);
      gate.fetch.mockImplementationOnce(async () => {
        gate.start(1, '/api/me', -1); gate.receive(1); return json(identity);
      });
      await gate.client.revalidateAuthentication(0);
      expect(gate.client.authenticationState).toBe('verified');
      expect(gate.receive(1)).toHaveBeenCalledWith({ cancel: true, responseHeaders: { 'Content-Type': ['application/json'] } });
      gate.fail(1); expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it('discards successful old cookie responses after a reload without suspending authentication', async () => {
    const gate = await fixture();
    try {
      gate.start(1); gate.discard();
      expect(gate.receive(1)).toHaveBeenCalledWith({ cancel: true, responseHeaders: { 'Content-Type': ['application/json'] } });
      gate.finish(1);
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });
});

describe('replacement pairing generation', () => {
  it.each(['native', 'renderer'])('quarantines old socket and HTTP signals while replacement %s pairing reads its body', async (route) => {
    const gate = await fixture();
    try {
      await gate.client.refresh();
      const ticket = gate.handlers.notify.mock.results[0]!.value;
      gate.start(1);
      const oldSignal = gate.client.requestSignal;
      const oldSocket = gate.sockets[0]!;
      const body = deferred<unknown>(); const reading = deferred<void>();
      let pairing: Promise<unknown>;
      if (route === 'native') {
        gate.fetch.mockImplementationOnce(async () => {
          expect(gate.start(2, '/api/pair?demo=1', -1, 'POST')).toHaveBeenCalledWith({});
          expect(gate.receive(2)).toHaveBeenCalledWith({});
          return { status: 200, ok: true, json: () => { reading.resolve(); return body.promise; } } as Response;
        });
        pairing = gate.client.pair('demo-code', 'Demo desktop'); await reading.promise;
      } else {
        expect(gate.start(2, '/api/pair?demo=1', 42, 'POST')).toHaveBeenCalledWith({});
        expect(gate.receive(2)).toHaveBeenCalledWith({}); pairing = Promise.resolve();
      }
      expect(gate.client.pairingGeneration).toBe(1);
      expect(oldSignal.aborted).toBe(true);
      expect(gate.client.approvals.size).toBe(0);
      expect(gate.tickets.take(ticket)).toBeUndefined();
      gate.client.suspend(0); oldSocket.onclose?.({ code: 4403 }); oldSocket.onerror?.({});
      expect(gate.receive(1, 401)).toHaveBeenCalledWith({ cancel: true, responseHeaders: { 'Content-Type': ['application/json'] } });
      gate.fail(1);
      expect(gate.client.pairingGeneration).toBe(1);
      expect(gate.client.unpaired).toBe(false);
      expect(gate.client.authenticationBlocked).toBe(true);
      expect(gate.start(3, '/api/presence', 42, 'POST')).toHaveBeenCalledWith({ cancel: true });
      if (route === 'native') { body.resolve(identity); await pairing; }
      else { gate.finish(2); await gate.client.revalidateAuthentication(1); }
      expect(gate.client.authenticationState).toBe('verified');
      expect(gate.handlers.unpaired).not.toHaveBeenCalled();
    } finally { gate.client.stop(); }
  });

  it.each(['native', 'renderer'])('requires an identity check even after successful %s pairing', async (route) => {
    const gate = await fixture();
    try {
      const probe = deferred<Response>(); const probing = deferred<void>();
      gate.fetch.mockImplementation(async (url) => {
        if (url.endsWith('/api/me')) { probing.resolve(); return probe.promise; }
        return json(snapshot);
      });
      const pairing = route === 'native' ? gate.client.pair('demo-code', 'Demo desktop') : Promise.resolve();
      if (route === 'renderer') { gate.start(1, '/api/pair', 42, 'POST'); gate.receive(1); gate.finish(1); }
      await probing.promise;
      expect(gate.client.authenticationState).toBe('unverified');
      await expect(gate.client.allowOnce(approvalKey(approval))).rejects.toThrow();
      probe.resolve(json(identity)); await pairing; await gate.client.revalidateAuthentication(1);
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it.each(['network error', 'HTTP error', 'invalid body', 'body deadline'])('keeps failed native pairing %s unverified until a current check', async (failure) => {
    vi.useFakeTimers(); const gate = await fixture();
    try {
      if (failure === 'network error') gate.fetch.mockRejectedValueOnce(new Error('Demo offline'));
      else if (failure === 'HTTP error') gate.fetch.mockResolvedValueOnce(json({}, 400));
      else if (failure === 'invalid body') gate.fetch.mockResolvedValueOnce(new Response('{'));
      else gate.fetch.mockResolvedValueOnce({ status: 200, ok: true, json: () => new Promise(() => {}) } as Response);
      const pairing = gate.client.pair('demo-code', 'Demo desktop').catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(failure === 'body deadline' ? 10000 : 0);
      expect(await pairing).toBeInstanceOf(Error);
      expect(gate.client.authenticationState).toBe('unverified');
      await gate.client.revalidateAuthentication(1);
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it('holds one owner across native pairing headers, body, and renderer attempts', async () => {
    const gate = await fixture();
    try {
      const body = deferred<unknown>(); const reading = deferred<void>();
      gate.fetch.mockImplementationOnce(async () => {
        gate.start(1, '/api/pair', -1, 'POST'); gate.receive(1);
        return { status: 200, ok: true, json: () => { reading.resolve(); return body.promise; } } as Response;
      });
      const pairing = gate.client.pair('demo-code', 'Demo desktop'); await reading.promise; gate.finish(1);
      await expect(gate.client.pair('demo-code', 'Demo desktop')).rejects.toThrow('Pairing is already in progress');
      expect(gate.start(2, '/api/pair', 42, 'POST')).toHaveBeenCalledWith({ cancel: true });
      expect(gate.receive(2)).toHaveBeenCalledWith({ cancel: true, responseHeaders: { 'Content-Type': ['application/json'] } });
      body.resolve(identity); await pairing;
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it('rejects concurrent renderer/native owners and releases failed renderer pairing for a new attempt', async () => {
    const gate = await fixture();
    try {
      gate.start(1, '/api/pair?demo=1', 42, 'POST');
      expect(gate.start(2, '/api/pair', 42, 'POST')).toHaveBeenCalledWith({ cancel: true });
      await expect(gate.client.pair('demo-code', 'Demo desktop')).rejects.toThrow('Pairing is already in progress');
      gate.fail(1);
      expect(gate.start(3, '/api/pair', 42, 'POST')).toHaveBeenCalledWith({});
      gate.receive(3); gate.finish(3); await gate.client.revalidateAuthentication(2);
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it.each(['/api/pair', '/api/pair?demo=1'])('blocks stale cookies and duplicate completions for %s pairing', async (path) => {
    const gate = await fixture();
    try {
      gate.start(1, path, 42, 'POST'); gate.receive(1); gate.fail(1);
      gate.start(2, path, 42, 'POST');
      gate.finish(1); gate.fail(1);
      expect(gate.receive(1)).toHaveBeenCalledWith({ cancel: true, responseHeaders: { 'Content-Type': ['application/json'] } });
      gate.receive(2); gate.finish(2); await gate.client.revalidateAuthentication(2);
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it.each(['/%61pi/me', '/api/%70air', '/api%2Fpresence', '/api/%ZZ'])('blocks encoded API path %s before taking ownership', async (path) => {
    const gate = await fixture();
    try {
      expect(gate.start(1, path, 42, 'POST')).toHaveBeenCalledWith({ cancel: true });
      expect(gate.receive(1)).toHaveBeenCalledWith({ cancel: true, responseHeaders: { 'Content-Type': ['application/json'] } });
      expect(gate.client.pairingGeneration).toBe(0);
      expect(gate.start(2, '/api/conversations/hermes/demo%3Achat/approvals/demo%3Aapproval', 42, 'POST')).toHaveBeenCalledWith({});
    } finally { gate.client.stop(); }
  });

  it('bounds renderer pairing body reads and blocks stale cookies before verified recovery', async () => {
    vi.useFakeTimers(); const gate = await fixture();
    try {
      gate.start(1, '/api/pair', 42, 'POST'); gate.receive(1);
      await vi.advanceTimersByTimeAsync(10000);
      expect(gate.client.authenticationState).toBe('unverified');
      expect(gate.receive(1)).toHaveBeenCalledWith({ cancel: true, responseHeaders: { 'Content-Type': ['application/json'] } });
      await gate.client.revalidateAuthentication(1);
      expect(gate.client.authenticationState).toBe('verified');
      gate.finish(1); expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it('does not grant new cookie ownership to assets requested by a retired renderer document', async () => {
    const gate = await fixture();
    try {
      gate.start(1, '/api/pair', 42, 'POST'); gate.receive(1);
      gate.start(2, '/assets/demo.js');
      expect(gate.receive(2)).toHaveBeenCalledWith({ cancel: true, responseHeaders: { 'Content-Type': ['application/json'] } });
      gate.finish(1); await gate.client.revalidateAuthentication(1);
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it('aborts a pending pairing on shutdown and refuses its late response cookies', async () => {
    const gate = await fixture();
    try {
      const response = deferred<Response>();
      gate.fetch.mockImplementationOnce(() => { gate.start(1, '/api/pair', -1, 'POST'); return response.promise; });
      const pairing = gate.client.pair('demo-code', 'Demo desktop').catch((error: unknown) => error);
      gate.client.stop(); response.resolve(json(identity));
      expect(await pairing).toBeInstanceOf(UnpairedError);
      expect(gate.receive(1)).toHaveBeenCalledWith({ cancel: true, responseHeaders: { 'Content-Type': ['application/json'] } });
    } finally { gate.client.stop(); }
  });
});
