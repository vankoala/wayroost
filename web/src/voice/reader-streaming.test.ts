import { afterEach, expect, it, vi } from 'vitest';
import { ReplyReader, type ReaderOutput } from './reader';

afterEach(() => vi.useRealTimers());
const audio = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const text = (clip: ArrayBuffer) => new TextDecoder().decode(clip);
const replies = [{ kind: 'assistant' as const, id: 'fake-reply', text: 'One. Two. Three.' }];

it('starts the next stream before the current stream finishes', async () => {
  const requested: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const out: ReaderOutput = {
    speak: async () => audio('unused'), stream: async function* (piece) {
      requested.push(piece); yield audio(piece);
      if (piece === 'One.') await gate;
    }, play: async () => {}, pending: () => 0, changed: async () => {},
  };
  const reader = new ReplyReader(out, () => {});
  reader.update(replies, false);
  try { await vi.waitFor(() => expect(requested).toEqual(['One.', 'Two.'])); }
  finally { release(); reader.stop(); }
});

it('retries a busy streamed piece in place before prefetched later sentences', async () => {
  vi.useFakeTimers();
  let busy = true;
  const played: string[] = [];
  const done = vi.fn();
  const out: ReaderOutput = {
    speak: async () => audio('unused'), stream: async function* (piece) {
      if (piece === 'One.' && busy) { busy = false; throw Object.assign(new Error('busy'), { status: 429 }); }
      yield audio(piece);
    }, play: async clip => { played.push(text(clip)); }, pending: () => 0, changed: async () => {},
  };
  new ReplyReader(out, done).update(replies, false);
  await vi.advanceTimersByTimeAsync(801);
  expect(played).toEqual(['One.', 'Two.', 'Three.']);
  expect(done).toHaveBeenCalledWith(undefined);
});

it('a fallback resets only its own piece and preserves earlier local audio', async () => {
  const playing = new Map<symbol | undefined, string[]>();
  const resetPieces: Array<symbol | undefined> = [];
  const played: string[] = [];
  const out: ReaderOutput = {
    speak: async () => audio('unused'), stream: async function* (piece) {
      if (piece === 'One.') yield audio('One-local');
      else { yield audio('Two-cloud'); yield 'reset'; yield audio('Two-local'); }
    }, play: async (clip, piece) => {
      played.push(text(clip)); playing.set(piece, [...playing.get(piece) ?? [], text(clip)]);
    }, reset: piece => { resetPieces.push(piece); playing.delete(piece); }, pending: () => 0, changed: async () => {},
  };
  const done = vi.fn();
  new ReplyReader(out, done).update([{ kind: 'assistant', id: 'fake-reply', text: 'One. Two.' }], false);
  await vi.waitFor(() => expect(done).toHaveBeenCalled());
  expect(played).toEqual(['One-local', 'Two-cloud', 'Two-local']);
  expect(resetPieces[0]).toBeTypeOf('symbol');
  expect([...playing.values()].flat()).toEqual(['One-local', 'Two-local']);
});

it('uses seconds of queued PCM rather than two tiny clips as its streaming buffer', async () => {
  let queued = 0;
  let waiting: (() => void) | undefined;
  let clips = 0;
  const out: ReaderOutput = {
    speak: async () => audio('unused'), stream: async function* () { for (let i = 0; i < 20; i++) yield audio('pcm'); },
    play: async () => { clips++; queued += 0.125; }, pending: () => clips,
    bufferedSeconds: () => queued, changed: () => new Promise(resolve => { waiting = resolve; }),
  };
  const reader = new ReplyReader(out, () => {});
  reader.update([{ kind: 'assistant', id: 'fake-reply', text: 'One.' }], false);
  await vi.waitFor(() => expect(waiting).toBeTypeOf('function'));
  expect(queued).toBeGreaterThanOrEqual(1);
  expect(queued).toBeLessThanOrEqual(2);
  reader.stop(); waiting?.();
});

it('announces cloud fallback at most once for an entire reply', async () => {
  const notice = vi.fn();
  const out: ReaderOutput = {
    speak: async () => audio('unused'), stream: async function* (piece, _signal, fallback) { fallback(); yield audio(piece); },
    fallback: notice, play: async () => {}, pending: () => 0, changed: async () => {},
  };
  const done = vi.fn();
  new ReplyReader(out, done).update(replies, false);
  await vi.waitFor(() => expect(done).toHaveBeenCalled());
  expect(notice).toHaveBeenCalledTimes(1);
});
