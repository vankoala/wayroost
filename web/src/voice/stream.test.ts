import { afterEach, expect, it, vi } from 'vitest';
import { streamSpeech } from '../api';
import { ReplyReader, type ReaderOutput } from './reader';

afterEach(() => vi.unstubAllGlobals());
const frame = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);

it('plays PCM before the stream ends, handles split frames and resets on local fallback', async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const stream = new ReadableStream<Uint8Array>({ async start(controller) {
    const start = frame({ type: 'start', provider: 'elevenlabs', voice: 'fake-voice', format: 'pcm_24000' });
    controller.enqueue(start.slice(0, 12)); controller.enqueue(start.slice(12));
    controller.enqueue(frame({ type: 'audio', data: btoa(String.fromCharCode(...new Uint8Array(6000))) }));
    await gate;
    controller.enqueue(frame({ type: 'reset', provider: 'local', voice: 'af_heart', format: 'wav' }));
    controller.enqueue(frame({ type: 'audio', data: btoa('RIFFdemo') }));
    controller.enqueue(frame({ type: 'end', provider: 'local', voice: 'af_heart' }));
    controller.close();
  } });
  const fetch = vi.fn(async () => new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } }));
  vi.stubGlobal('fetch', fetch);
  const audio = streamSpeech('Demo text.', 1, new AbortController().signal);
  const first = (await audio.next()).value as ArrayBuffer;
  expect(new TextDecoder().decode(first.slice(0, 4))).toBe('RIFF');
  expect(first.byteLength).toBe(6044);
  expect(new DataView(first).getUint32(24, true)).toBe(24000);
  finish();
  expect((await audio.next()).value).toBe('reset');
  expect(new TextDecoder().decode((await audio.next()).value as ArrayBuffer)).toBe('RIFFdemo');
  expect((await audio.next()).done).toBe(true);
  expect(fetch).toHaveBeenCalledWith('/api/voice/speak', expect.objectContaining({ body: JSON.stringify({ text: 'Demo text.', speed: 1, stream: true }) }));
});

it('rejects an interrupted stream instead of treating partial audio as success', async () => {
  vi.stubGlobal('fetch', async () => new Response(`${JSON.stringify({ type: 'start', provider: 'local', voice: 'af_heart', format: 'wav' })}\n`));
  const stream = streamSpeech('Demo.', 1, new AbortController().signal);
  await expect(stream.next()).rejects.toThrow('Voice stream stopped');
});

it.each([0.9, 1, 1.15, 1.3])('plays cloud PCM at the device speed %s and leaves local fallback WAV speed intact', async speed => {
  const local = new Uint8Array([82, 73, 70, 70, 7]);
  vi.stubGlobal('fetch', async () => new Response([
    { type: 'start', provider: 'elevenlabs', voice: 'fake-voice', format: 'pcm_24000' },
    { type: 'audio', data: btoa(String.fromCharCode(...new Uint8Array(6000))) },
    { type: 'reset', provider: 'local', voice: 'af_heart', format: 'wav' },
    { type: 'audio', data: btoa(String.fromCharCode(...local)) },
    { type: 'end', provider: 'local', voice: 'af_heart' },
  ].map(value => JSON.stringify(value)).join('\n') + '\n'));
  const stream = streamSpeech('Demo.', speed, new AbortController().signal);
  const clip = (await stream.next()).value as ArrayBuffer;
  expect(new DataView(clip).getUint32(24, true)).toBe(Math.round(24000 * speed));
  expect((await stream.next()).value).toBe('reset');
  expect(new Uint8Array((await stream.next()).value as ArrayBuffer)).toEqual(local);
  expect((await stream.next()).done).toBe(true);
});

it('the reply reader consumes streaming clips in order and aborts when stopped', async () => {
  const played: number[] = [];
  const signals: AbortSignal[] = [];
  let reset = 0;
  const out: ReaderOutput = {
    speak: async () => { throw new Error('buffered path called'); },
    stream: async function* (_text, signal) { signals.push(signal); yield new Uint8Array([1]).buffer; yield 'reset'; yield new Uint8Array([2]).buffer; },
    play: async clip => { played.push(new Uint8Array(clip)[0]!); },
    reset: () => { reset++; }, pending: () => 0, changed: async () => {},
  };
  const done: Array<string | undefined> = [];
  const reader = new ReplyReader(out, error => done.push(error));
  reader.update([{ kind: 'assistant', id: 'fake-reply', text: 'Demo text.' }], false);
  await vi.waitFor(() => expect(done).toEqual([undefined]));
  expect(played).toEqual([1, 2]); expect(reset).toBe(1);
  reader.stop(); expect(signals[0]?.aborted).toBe(true);
});
