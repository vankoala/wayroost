import { checkDeviceSignal, deviceSignal, actionSignal, withDeviceSignal } from './security/device-signal.js';
import { request } from 'node:http';
import {
  VOICE_MAX_SECONDS,
  VOICE_SAMPLE_RATE,
  type VoiceErrorCode,
  type VoiceEvent,
} from '../../shared/protocol.js';
import { UserFacingError } from './sources.js';
import { CloudSpeechError, type CloudSpeechService } from './cloud-speech.js';
import type { AppVoice, SpeechFrame } from '../../shared/voice.js';

// Voice mode. The speech service (speech/signalbox-speech.py, set up by
// deploy/setup-speech.sh) runs beside Signalbox and answers on a Unix socket
// only Signalbox may open. It writes down what you say and reads replies
// aloud, on the CPU. Nothing here keeps audio or text, or logs either.

const HEALTH_TIMEOUT_MS = 3_000;
const WORK_TIMEOUT_MS = 30_000;
const HEALTH_CACHE_MS = 15_000;
const MAX_REPLY_BYTES = 8 * 1024 * 1024;
const MAX_PCM_BYTES = VOICE_SAMPLE_RATE * 2 * VOICE_MAX_SECONDS;
/** Under a quarter of a second, nothing was said: don't bother the speech service. */
const MIN_PCM_BYTES = VOICE_SAMPLE_RATE / 2;
/** A run whose audio stops arriving (the page went away mid-sentence) is dropped. */
const RUN_IDLE_MS = 10_000;
/** Recordings one browser may have waiting to be written down; more are refused. */
const MAX_WAITING = 2;

export interface SpeechHealth {
  voices: string[];
  defaultVoice: string;
}

export interface SpeechService {
  health(): Promise<SpeechHealth>;
  transcribe(pcm: Buffer, signal?: AbortSignal): Promise<{ text: string; ms: number }>;
  speak(text: string, voice: string, speed: number, signal?: AbortSignal): Promise<Buffer>;
}

interface CloudState {
  generation: number;
  failure?: { until: number; reason: import('../../shared/voice.js').CloudVoiceErrorCode };
}
const cloudStates = new WeakMap<CloudSpeechService, CloudState>();
const CLOUD_AUDIO_DEADLINE_MS = 2_000;

function nextAudio(iterator: AsyncIterator<Buffer>, signal: AbortSignal): Promise<IteratorResult<Buffer>> {
  return new Promise((resolve, reject) => {
    const timeout = () => { cleanup(); reject(new CloudSpeechError('timeout')); };
    const timer = setTimeout(timeout, CLOUD_AUDIO_DEADLINE_MS);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', timeout); };
    signal.addEventListener('abort', timeout, { once: true });
    if (signal.aborted) { timeout(); return; }
    Promise.resolve().then(() => iterator.next()).then(
      part => { cleanup(); resolve(part); }, err => { cleanup(); reject(err); },
    );
  });
}

/** Cloud errors, including a broken stream, replay this exact text using the local voice. */
export async function* readAloud(local: SpeechService, cloud: CloudSpeechService | undefined, choice: AppVoice, text: string, voice: string, speed: number, signal?: AbortSignal): AsyncGenerator<SpeechFrame> {
  if (signal?.aborted) return;
  let started = false;
  let reason: import('../../shared/voice.js').CloudVoiceErrorCode | undefined;
  if (choice.provider === 'elevenlabs') {
    const state = cloud ? cloudStates.get(cloud) ?? { generation: 0 } : undefined;
    if (cloud && state) cloudStates.set(cloud, state);
    const failure = state?.failure;
    const generation = state?.generation;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    let iterator: AsyncIterator<Buffer> | undefined;
    try {
      if (failure && failure.until > Date.now()) throw new CloudSpeechError(failure.reason);
      if (!cloud) throw new CloudSpeechError('unreachable');
      checkDeviceSignal();
      iterator = cloud.synthesize(text, choice, 'pcm_24000', abort.signal)[Symbol.asyncIterator]();
      let bytes = 0;
      while (true) {
        const part = await nextAudio(iterator, abort.signal);
        if (signal?.aborted) return;
        if (part.done) break;
        const chunk = part.value;
        if (!chunk.length) continue;
        if (!started) { yield { type: 'start', provider: 'elevenlabs', voice: choice.voiceId!, format: 'pcm_24000' }; started = true; }
        bytes += chunk.length;
        if (bytes > MAX_REPLY_BYTES) throw new CloudSpeechError('failed');
        yield { type: 'audio', data: chunk.toString('base64') };
      }
      if (!bytes || bytes % 2) throw new CloudSpeechError('failed');
      // An older stream cannot erase a failure reported after it started.
      if (state && state.generation === generation) delete state.failure;
      yield { type: 'end', provider: 'elevenlabs', voice: choice.voiceId! };
      return;
    } catch (err) {
      if (signal?.aborted) return;
      reason = err instanceof CloudSpeechError ? err.code : 'failed';
      if (state && iterator) {
        state.generation += 1;
        const until = Date.now() + (reason === 'auth' || reason === 'quota' ? 300_000 : 60_000);
        // Concurrent failures must not shorten the active cooldown or change its reason.
        if (!state.failure || until > state.failure.until) state.failure = { until, reason };
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
      abort.abort();
      // Abort the socket immediately; a hostile iterator may never finish next().
      void iterator?.return?.().catch(() => {});
    }
  }
  if (signal?.aborted) return;
  checkDeviceSignal();
  const wav = await (signal ? local.speak(text, voice, speed, signal) : local.speak(text, voice, speed));
  if (signal?.aborted) return;
  yield { type: started ? 'reset' : 'start', provider: 'local', voice, format: 'wav', ...(reason ? { reason } : {}) };
  yield { type: 'audio', data: wav.toString('base64') };
  yield { type: 'end', provider: 'local', voice };
}

export function pcmWav(pcm: Buffer, speed = 1): Buffer {
  const rate = Math.round(24000 * speed);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const UNAVAILABLE = "Voice isn't available right now: the speech service on your PC isn't answering.";

interface Reply {
  status: number;
  type: string;
  body: Buffer;
}

export class SpeechClient implements SpeechService {
  private cached: { at: number; health: SpeechHealth } | undefined;

  constructor(private readonly socketPath: string) {}

  private call(method: string, path: string, body: Buffer | undefined, type: string, timeoutMs: number, signal = deviceSignal()): Promise<Reply> {
    return new Promise((resolve, reject) => {
      checkDeviceSignal();
      checkDeviceSignal(signal);
      const req = request(
        {
          socketPath: this.socketPath,
          signal: actionSignal(signal),
          method,
          path,
          // A fresh connection each time: the service closes idle ones, and a
          // reused socket it just closed would fail the next call.
          agent: false,
          headers: {
            host: 'localhost',
            ...(body ? { 'content-type': type, 'content-length': String(body.length) } : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_REPLY_BYTES) {
              res.destroy();
              reject(new UserFacingError('The speech service sent too much back.', 502));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              type: String(res.headers['content-type'] ?? ''),
              body: Buffer.concat(chunks),
            }),
          );
          res.on('error', () => reject(new UserFacingError(UNAVAILABLE, 503)));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => reject(new UserFacingError(UNAVAILABLE, 503)));
      req.end(body);
    });
  }

  private static json(reply: Reply): Record<string, unknown> {
    try {
      return JSON.parse(reply.body.toString('utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private static failed(reply: Reply, fallback: string): UserFacingError {
    const error = SpeechClient.json(reply).error;
    // The service's own messages are short and fixed; anything else gets ours.
    const message = typeof error === 'string' && error.length < 200 ? error : fallback;
    return new UserFacingError(message, reply.status === 400 ? 400 : 502);
  }

  async health(): Promise<SpeechHealth> {
    if (this.cached && Date.now() - this.cached.at < HEALTH_CACHE_MS) return this.cached.health;
    const reply = await this.call('GET', '/health', undefined, '', HEALTH_TIMEOUT_MS);
    const data = SpeechClient.json(reply);
    if (reply.status !== 200 || data.ok !== true || !Array.isArray(data.voices)) {
      throw new UserFacingError(UNAVAILABLE, 503);
    }
    const health = {
      voices: data.voices.filter((v): v is string => typeof v === 'string'),
      defaultVoice: typeof data.defaultVoice === 'string' ? data.defaultVoice : 'af_heart',
    };
    this.cached = { at: Date.now(), health };
    return health;
  }

  async transcribe(pcm: Buffer, signal?: AbortSignal): Promise<{ text: string; ms: number }> {
    const reply = await this.call('POST', '/stt', pcm, 'application/octet-stream', WORK_TIMEOUT_MS, signal);
    if (reply.status !== 200) throw SpeechClient.failed(reply, "Couldn't write down what you said.");
    const data = SpeechClient.json(reply);
    return {
      text: typeof data.text === 'string' ? data.text : '',
      ms: typeof data.ms === 'number' ? data.ms : 0,
    };
  }

  async speak(text: string, voice: string, speed: number, signal?: AbortSignal): Promise<Buffer> {
    const body = Buffer.from(JSON.stringify({ text, voice, speed }));
    const reply = await this.call('POST', '/tts', body, 'application/json', WORK_TIMEOUT_MS, signal);
    if (reply.status !== 200) throw SpeechClient.failed(reply, "Couldn't read that aloud.");
    if (!reply.type.startsWith('audio/wav') || reply.body.length < 44) {
      throw new UserFacingError("Couldn't read that aloud.", 502);
    }
    return reply.body;
  }
}

const ERROR_TEXT: Record<VoiceErrorCode, string> = {
  unavailable: UNAVAILABLE,
  'too-long': `That was longer than ${VOICE_MAX_SECONDS / 60} minutes; try a shorter message.`,
  timeout: 'The recording stopped arriving, so it was dropped.',
  busy: 'Still writing down your last message. Try again in a moment.',
  failed: "Couldn't write down what you said. Try again.",
};

interface Run {
  id: number;
  chunks: Buffer[];
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One browser's voice input, on its WebSocket. A run collects the audio frames
 * for one press of the mic; when it ends, the audio is written down and the
 * text goes back to that browser only.
 */
export class VoiceSession {
  private run: Run | null = null;
  private queue: Promise<void> = Promise.resolve();
  private waiting = 0;
  private closed = false;

  constructor(
    private readonly speech: SpeechService,
    private readonly send: (event: VoiceEvent) => void,
    private readonly idleMs = RUN_IDLE_MS,
    private readonly signal?: AbortSignal,
  ) {}

  start(id: number): void {
    this.drop();
    if (this.closed) return;
    this.run = { id, chunks: [], bytes: 0, timer: this.idleTimer(id) };
  }

  cancel(id: number): void {
    if (this.run?.id === id) this.drop();
  }

  /** A binary frame: the run number, then audio; the run number alone ends it. */
  frame(data: Buffer): void {
    const run = this.run;
    if (!run || data.length === 0 || data[0] !== run.id) return; // a stale or cancelled run
    if (data.length === 1) {
      this.finish(run);
      return;
    }
    const audio = data.subarray(1);
    if (audio.length % 2 !== 0) return; // never split a sample; the browser doesn't
    run.bytes += audio.length;
    if (run.bytes > MAX_PCM_BYTES) {
      this.drop();
      this.error(run.id, 'too-long');
      return;
    }
    run.chunks.push(Buffer.from(audio)); // copy: ws may reuse the frame's memory
    clearTimeout(run.timer);
    run.timer = this.idleTimer(run.id);
  }

  close(): void {
    this.closed = true;
    this.drop();
  }

  private idleTimer(id: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (this.run?.id !== id) return;
      this.drop();
      this.error(id, 'timeout');
    }, this.idleMs);
  }

  private drop(): void {
    if (!this.run) return;
    clearTimeout(this.run.timer);
    this.run = null;
  }

  private finish(run: Run): void {
    this.drop();
    const pcm = Buffer.concat(run.chunks);
    this.emit({ type: 'voice', run: run.id, stage: 'stt-start' });
    if (pcm.length < MIN_PCM_BYTES) {
      this.emit({ type: 'voice', run: run.id, stage: 'stt-end', text: '', ms: 0 });
      return;
    }
    if (this.waiting >= MAX_WAITING) {
      this.error(run.id, 'busy');
      return;
    }
    // One transcription at a time per browser, in the order they were spoken.
    this.waiting += 1;
    this.queue = this.queue.then(async () => {
      if (this.closed || this.signal?.aborted) {
        // Its socket is gone (or its device revoked): nobody is waiting for the text.
        this.waiting -= 1;
        return;
      }
      try {
        const { text, ms } = await withDeviceSignal(this.signal, () => this.speech.transcribe(pcm, this.signal));
        this.emit({ type: 'voice', run: run.id, stage: 'stt-end', text, ms });
      } catch (err) {
        this.error(run.id, err instanceof UserFacingError && err.status === 503 ? 'unavailable' : 'failed');
      } finally {
        this.waiting -= 1;
      }
    });
  }

  private error(run: number, code: VoiceErrorCode): void {
    this.emit({ type: 'voice', run, stage: 'error', code, message: ERROR_TEXT[code] });
  }

  private emit(event: VoiceEvent): void {
    if (!this.closed) this.send(event);
  }
}
