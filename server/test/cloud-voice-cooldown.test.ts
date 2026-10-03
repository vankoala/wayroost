import { afterEach, expect, it, vi } from 'vitest';
import { CloudSpeechError, type CloudSpeechService } from '../src/cloud-speech.js';
import { pcmWav, readAloud, type SpeechService } from '../src/speech.js';
import type { AppVoice, CloudVoiceErrorCode, SpeechFrame } from '../../shared/voice.js';

const choice: AppVoice = { provider: 'elevenlabs', voiceId: 'fake-voice', modelId: 'fake-model' };
const pcm = Buffer.alloc(6000, 1);
afterEach(() => vi.useRealTimers());
async function collect(source: AsyncIterable<SpeechFrame>) {
  const frames: SpeechFrame[] = [];
  for await (const frame of source) frames.push(frame);
  return frames;
}
async function overlapping(olderCode: CloudVoiceErrorCode, newerCode: CloudVoiceErrorCode) {
  vi.useFakeTimers();
  const local: SpeechService = {
    health: async () => ({ voices: ['af_heart'], defaultVoice: 'af_heart' }),
    transcribe: async () => ({ text: '', ms: 0 }), speak: vi.fn(async () => pcmWav(pcm)),
  };
  let calls = 0;
  const synthesize = vi.fn(async function* () {
    const call = ++calls;
    if (call === 2) throw new CloudSpeechError(newerCode);
    yield pcm;
    if (call === 1) throw new CloudSpeechError(olderCode);
  });
  const cloud: CloudSpeechService = { catalog: async () => ({ voices: [], models: [] }), synthesize };
  const read = (text: string) => readAloud(local, cloud, choice, text, 'af_heart', 1.25);
  const older = read('Older output.');
  expect((await older.next()).value).toMatchObject({ type: 'start', provider: 'elevenlabs' });
  expect((await older.next()).value).toMatchObject({ type: 'audio' });
  const failedAt = Date.now();
  expect((await collect(read('Newer output.')))[0]).toMatchObject({ provider: 'local', reason: newerCode });
  const failOlder = async () => {
    expect((await collect({ [Symbol.asyncIterator]: () => older }))[0]).toMatchObject({ type: 'reset', provider: 'local', reason: olderCode });
    expect(local.speak).toHaveBeenCalledWith('Older output.', 'af_heart', 1.25);
  };
  return { read, synthesize, failedAt, failOlder };
}

const shortCodes = ['unreachable', 'rate-limit', 'timeout', 'failed'] as const;
const longCodes = ['auth', 'quota'] as const;
it.each(longCodes.flatMap(long => shortCodes.map(short => ({ long, short }))))('preserves a newer $long cooldown after an older $short failure', async ({ long, short }) => {
  const f = await overlapping(short, long);
  await vi.advanceTimersByTimeAsync(1_000);
  await f.failOlder();
  await vi.advanceTimersByTimeAsync(61_000);
  expect((await collect(f.read('After the shorter cooldown.')))[0]).toMatchObject({ provider: 'local', reason: long });
  await vi.advanceTimersByTimeAsync(f.failedAt + 300_000 - Date.now() - 1);
  expect((await collect(f.read('Before the longest deadline.')))[0]).toMatchObject({ provider: 'local', reason: long });
  expect(f.synthesize).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect((await collect(f.read('At the longest deadline.')))[0]).toMatchObject({ provider: 'elevenlabs' });
  expect(f.synthesize).toHaveBeenCalledTimes(3);
});

it.each(longCodes)('extends the cooldown when an older %s failure has a later deadline', async code => {
  const f = await overlapping(code, 'unreachable');
  await vi.advanceTimersByTimeAsync(1_000);
  await f.failOlder();
  await vi.advanceTimersByTimeAsync(299_999);
  expect((await collect(f.read('Before the extended deadline.')))[0]).toMatchObject({ provider: 'local', reason: code });
  expect(f.synthesize).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect((await collect(f.read('At the extended deadline.')))[0]).toMatchObject({ provider: 'elevenlabs' });
});

it('keeps the recorded reason for equal deadlines and extends equal-length cooldowns when they arrive later', async () => {
  const equal = await overlapping('auth', 'quota');
  await equal.failOlder();
  expect((await collect(equal.read('Equal deadlines.')))[0]).toMatchObject({ provider: 'local', reason: 'quota' });
  const later = await overlapping('auth', 'quota');
  await vi.advanceTimersByTimeAsync(1_000);
  await later.failOlder();
  await vi.advanceTimersByTimeAsync(299_000);
  expect((await collect(later.read('Original deadline expired.')))[0]).toMatchObject({ provider: 'local', reason: 'auth' });
  expect(later.synthesize).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await collect(later.read('Extended deadline expired.')))[0]).toMatchObject({ provider: 'elevenlabs' });
});

it('records a fresh short cooldown after the previous long cooldown expires', async () => {
  const f = await overlapping('unreachable', 'quota');
  await vi.advanceTimersByTimeAsync(300_001);
  await f.failOlder();
  await vi.advanceTimersByTimeAsync(59_999);
  expect((await collect(f.read('Fresh failure.')))[0]).toMatchObject({ provider: 'local', reason: 'unreachable' });
  expect(f.synthesize).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect((await collect(f.read('Fresh cooldown expired.')))[0]).toMatchObject({ provider: 'elevenlabs' });
});
