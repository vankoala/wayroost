import { afterEach, expect, it, vi } from 'vitest';
import { speechRequest } from './request';

afterEach(() => vi.unstubAllGlobals());

it('waits for main to own a deliberate cancellation before aborting the fetch', async () => {
  let acknowledge!: (owned: boolean) => void;
  const bridge = { beginSpeech: vi.fn(async () => 'fake-speech-request'),
    cancelSpeech: vi.fn(() => new Promise<boolean>(resolve => { acknowledge = resolve; })), endSpeech: vi.fn() };
  vi.stubGlobal('window', { wayroostTray: bridge });
  const playback = new AbortController();
  const request = await speechRequest(playback.signal);
  expect(request.url).toBe('/api/voice/speak?speechRequest=fake-speech-request');
  playback.abort();
  expect(bridge.cancelSpeech).toHaveBeenCalledExactlyOnceWith('fake-speech-request');
  expect(request.signal.aborted).toBe(false);
  acknowledge(true); await request.cancel();
  expect(request.signal.aborted).toBe(true);
  await request.dispose();
  expect(bridge.endSpeech).toHaveBeenCalledExactlyOnceWith('fake-speech-request');
});

it('owns cancellation when a consumer stops reading without aborting playback', async () => {
  const bridge = { beginSpeech: vi.fn(async () => 'fake-speech-request'), cancelSpeech: vi.fn(async () => true), endSpeech: vi.fn() };
  vi.stubGlobal('window', { wayroostTray: bridge });
  const request = await speechRequest(new AbortController().signal);
  await request.dispose();
  expect(bridge.cancelSpeech).toHaveBeenCalledExactlyOnceWith('fake-speech-request');
  expect(request.signal.aborted).toBe(true);
});
