import { afterEach, expect, it, vi } from 'vitest';
import { responseAuthenticationDecision, socketAuthenticationLoss } from '../../shared/authentication.js';

afterEach(() => vi.useRealTimers());

it('suspends on a 401 status before reading a stalled body, then cancels it as unpaired', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), { status: 401 });
  const suspend = vi.fn();
  const decision = responseAuthenticationDecision(response, suspend);
  expect(suspend).toHaveBeenCalledTimes(1);
  const settled = vi.fn();
  void decision.then(settled);
  await vi.advanceTimersByTimeAsync(1999);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(decision).resolves.toEqual({ loss: 'unpaired', retire: true });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('bounds the whole read even if chunks keep arriving', async () => {
  vi.useFakeTimers();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const decision = responseAuthenticationDecision(new Response(new ReadableStream({ start(value) { controller = value; }, cancel }), { status: 401 }));
  controller.enqueue(new TextEncoder().encode('{"error":'));
  await vi.advanceTimersByTimeAsync(1000);
  controller.enqueue(new TextEncoder().encode('"unpaired"'));
  await vi.advanceTimersByTimeAsync(1000);
  await expect(decision).resolves.toEqual({ loss: 'unpaired', retire: true });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it.each(['single chunk', 'multiple chunks'])('rejects an oversized 401 in %s without waiting for its end', async (kind) => {
  const cancel = vi.fn();
  const bytes = new TextEncoder().encode(JSON.stringify({ error: 'Sign in again.', padding: 'x'.repeat(4096) }));
  const response = new Response(new ReadableStream({ start(controller) {
    if (kind === 'single chunk') controller.enqueue(bytes);
    else { controller.enqueue(bytes.slice(0, 2048)); controller.enqueue(bytes.slice(2048)); }
  }, cancel }), { status: 401 });
  await expect(responseAuthenticationDecision(response)).resolves.toEqual({ loss: 'unpaired', retire: true });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it.each([
  ['unpaired', '{"error":"unpaired"}', 'unpaired', true],
  ['expired', '{"error":"Sign in again."}', 'session-expired', false],
  ['malformed', '{', 'unpaired', true],
  ['empty', '{}', 'unpaired', true],
] as const)('keeps the %s recovery decision with a readable small body', async (_kind, body, loss, retire) => {
  await expect(responseAuthenticationDecision(new Response(body, { status: 401 }))).resolves.toEqual({ loss, retire });
});

it('does not read or suspend a successful response', async () => {
  const response = Response.json({ demo: true });
  const suspend = vi.fn();
  await expect(responseAuthenticationDecision(response, suspend)).resolves.toEqual({ loss: null, retire: false });
  expect(suspend).not.toHaveBeenCalled();
  await expect(response.json()).resolves.toEqual({ demo: true });
});

it('does not wait for an underlying stream cancellation that never resolves', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const decision = responseAuthenticationDecision(new Response(new ReadableStream({ cancel }), { status: 401 }));
  await vi.advanceTimersByTimeAsync(2000);
  await expect(decision).resolves.toEqual({ loss: 'unpaired', retire: true });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('classifies a socket by its authentication close or its refused upgrade status, and nothing else', () => {
  expect(socketAuthenticationLoss({ code: 4403 })).toBe('unpaired');
  expect(socketAuthenticationLoss({ code: 4401 })).toBe('session-expired');
  // An upgrade response has no body to read: 401 and 403 take the stricter path; a redirect is an expired sign-in.
  expect(socketAuthenticationLoss({ code: 1006, status: 401 })).toBe('unpaired');
  expect(socketAuthenticationLoss({ code: 1006, status: 403 })).toBe('unpaired');
  expect(socketAuthenticationLoss({ code: 1006, status: 302 })).toBe('session-expired');
  for (const signal of [{ code: 1006, status: 500 }, { code: 1006, status: 503 }, { code: 1006, status: 404 }, { code: 1006 }, { code: 1000 }, { code: 4000 }, {}]) {
    expect(socketAuthenticationLoss(signal), JSON.stringify(signal)).toBeNull();
  }
});
