import { afterEach, expect, it, vi } from 'vitest';
import { fixture, json, origin } from './authentication-fixture.js';

afterEach(() => vi.useRealTimers());

it.each(['/api/tasks', '/api/conversations', '/api/me'])('owns navigation cancellation of pending %s and its deadline', async path => {
  vi.useFakeTimers(); const gate = await fixture();
  try {
    await gate.client.refresh();
    gate.start(1, path); gate.receive(1); gate.start(2, path); gate.receive(2);
    gate.discard(); gate.fail(1, 'net::ERR_ABORTED');
    expect(gate.client.authenticationState).toBe('verified'); expect(gate.client.approvals.size).toBe(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(gate.client.authenticationState).toBe('verified'); expect(gate.client.approvals.size).toBe(1);
    gate.fail(2, 'net::ERR_ABORTED');
    expect(gate.client.authenticationState).toBe('verified'); expect(gate.handlers.removed).not.toHaveBeenCalled();
  } finally { gate.client.stop(); }
});

it.each([400, 404, 409, 429, 500, 503].flatMap(status => ['body', 'abort', 'deadline'].map(failure => ({ status, failure }))))(
  'preserves identity HTTP $status when its $failure fails', async ({ status, failure }) => {
    vi.useFakeTimers(); const gate = await fixture();
    try {
      await gate.client.refresh(); gate.start(1, '/api/me'); gate.receive(1, status);
      if (failure === 'deadline') await vi.advanceTimersByTimeAsync(10000);
      else gate.fail(1, failure === 'abort' ? 'net::ERR_ABORTED' : 'net::ERR_CONTENT_LENGTH_MISMATCH');
      expect(gate.client.authenticationState).toBe('verified'); expect(gate.client.approvals.size).toBe(1);
      expect(gate.handlers.removed).not.toHaveBeenCalled();
    } finally { gate.client.stop(); }
  },
);

it('preserves the identity deadline after an unexpected renderer failure', async () => {
  vi.useFakeTimers(); const gate = await fixture();
  try {
    gate.start(1, '/api/me'); gate.discard('failure');
    await vi.advanceTimersByTimeAsync(10000);
    expect(gate.client.authenticationState).toBe('unverified');
  } finally { gate.client.stop(); }
});

it.each(['body', 'deadline'])('still suspends an unreadable successful identity %s', async failure => {
  vi.useFakeTimers(); const gate = await fixture();
  try {
    gate.start(1, '/api/me'); gate.receive(1);
    if (failure === 'deadline') await vi.advanceTimersByTimeAsync(10000);
    else gate.fail(1, 'net::ERR_CONTENT_LENGTH_MISMATCH');
    expect(gate.client.authenticationState).toBe('unverified');
  } finally { gate.client.stop(); }
});

it('allows an internal page redirect but suspends on a login redirect', async () => {
  const gate = await fixture();
  try {
    gate.start(1, '/tasks', 42, 'GET', 'mainFrame'); gate.receive(1, 302);
    gate.redirect(1, `${origin}/tasks/`);
    expect(gate.client.authenticationState).toBe('verified');
    gate.redirect(1, 'https://access.example.com/login');
    expect(gate.client.authenticationState).toBe('unverified');
  } finally { gate.client.stop(); }
});

it.each([400, 404, 409, 429, 500, 503])('delivers renderer HTTP %s without clearing approvals or replacing the window', async status => {
  const gate = await fixture();
  try {
    await gate.client.refresh();
    gate.start(1, '/api/tasks');
    expect(gate.receive(1, status)).toHaveBeenCalledWith({}); gate.finish(1, status);
    expect(gate.client.authenticationState).toBe('verified');
    expect(gate.client.approvals.size).toBe(1);
    expect(gate.handlers.removed).not.toHaveBeenCalled(); expect(gate.handlers.paired).not.toHaveBeenCalled();
  } finally { gate.client.stop(); }
});

it.each([400, 404, 409, 429, 500, 503])('reports native HTTP %s as an ordinary error', async status => {
  const gate = await fixture();
  try {
    await gate.client.refresh(); gate.fetch.mockResolvedValueOnce(json({ error: 'Demo unavailable' }, status));
    await expect(gate.client.presence('active')).rejects.toThrow();
    expect(gate.client.authenticationState).toBe('verified'); expect(gate.client.approvals.size).toBe(1);
  } finally { gate.client.stop(); }
});

it.each([404, 409, 429, 500, 503])('keeps approvals when an approval snapshot returns HTTP %s', async status => {
  const gate = await fixture();
  try {
    await gate.client.refresh(); gate.fetch.mockResolvedValueOnce(json({ error: 'Demo unavailable' }, status));
    await expect(gate.client.refresh()).rejects.toThrow();
    expect(gate.client.authenticationState).toBe('verified'); expect(gate.client.approvals.size).toBe(1);
  } finally { gate.client.stop(); }
});

it.each([1000, 1006, 1011, 4000])('reconnects an ordinary socket close %s without retiring approvals', async code => {
  vi.useFakeTimers(); const gate = await fixture();
  try {
    gate.sockets[0]!.onopen?.({}); await vi.advanceTimersByTimeAsync(0);
    await gate.client.refresh(); gate.sockets[0]!.onclose?.({ code });
    expect(gate.client.authenticationState).toBe('verified'); expect(gate.client.approvals.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1000); expect(gate.sockets).toHaveLength(2);
    expect(gate.handlers.paired).not.toHaveBeenCalled();
  } finally { gate.client.stop(); }
});

it('treats an ordinary network failure as an error while retaining identity-probe failures', async () => {
  const gate = await fixture();
  try {
    await gate.client.refresh();
    gate.start(1, '/api/tasks'); gate.fail(1);
    gate.fetch.mockRejectedValueOnce(new Error('Demo offline'));
    await expect(gate.client.presence('active')).rejects.toThrow();
    expect(gate.client.authenticationState).toBe('verified'); expect(gate.client.approvals.size).toBe(1);
    gate.start(2, '/api/me'); gate.fail(2);
    expect(gate.client.authenticationState).toBe('unverified');
  } finally { gate.client.stop(); }
});

it('cannot cancel another request with a reused speech owner', async () => {
  const gate = await fixture();
  try {
    const owner = gate.discard.beginSpeech()!;
    gate.start(1, `/api/voice/speak?speechRequest=${owner}`, 42, 'POST');
    gate.start(2, `/api/voice/speak?speechRequest=${owner}`, 42, 'POST');
    gate.discard.cancelSpeech(owner); gate.fail(1, 'net::ERR_ABORTED');
    expect(gate.client.authenticationState).toBe('verified');
    gate.fail(2, 'net::ERR_ABORTED'); expect(gate.client.authenticationState).toBe('unverified');
  } finally { gate.client.stop(); }
});

it('owns stopping only the registered speech request and ignores its abort after acknowledgement', async () => {
  vi.useFakeTimers(); const gate = await fixture();
  try {
    await gate.client.refresh();
    const owner = gate.discard.beginSpeech()!;
    gate.start(1, `/api/voice/speak?speechRequest=${owner}`, 42, 'POST');
    expect(gate.discard.cancelSpeech(owner)).toBe(true);
    gate.fail(1, 'net::ERR_ABORTED');
    await vi.advanceTimersByTimeAsync(10000);
    expect(gate.client.authenticationState).toBe('verified'); expect(gate.client.approvals.size).toBe(1);
    expect(gate.handlers.paired).not.toHaveBeenCalled();
    gate.start(2, '/api/voice/speak', 42, 'POST'); gate.fail(2, 'net::ERR_ABORTED');
    expect(gate.client.authenticationState).toBe('unverified');
  } finally { gate.client.stop(); }
});

it('does not let speech cancellation conceal a 401 or an unexpected failure', async () => {
  const gate = await fixture();
  try {
    const owner = gate.discard.beginSpeech()!;
    gate.start(1, `/api/voice/speak?speechRequest=${owner}`, 42, 'POST'); gate.discard.cancelSpeech(owner);
    gate.receive(1, 401);
    expect(gate.client.authenticationState).toBe('unverified');
  } finally { gate.client.stop(); }
});

it.each(['/api/me', '/api/conversations', '/api/presence'])('distinguishes a forbidden operation from unpaired HTTP 403 on %s', async path => {
  const gate = await fixture();
  try {
    await gate.client.refresh();
    gate.fetch.mockResolvedValueOnce(json({ error: 'Demo operation forbidden.' }, 403));
    await expect(gate.client.request(path)).rejects.toThrow();
    expect(gate.client.authenticationState).toBe('verified'); expect(gate.client.approvals.size).toBe(1);
    gate.fetch.mockResolvedValueOnce(json({ error: 'unpaired' }, 403));
    await expect(gate.client.request(path)).rejects.toThrow();
    expect(gate.client.authenticationState).toBe('unverified');
  } finally { gate.client.stop(); }
});
