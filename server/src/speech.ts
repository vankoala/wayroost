import { request } from 'node:http';
import {
  VOICE_MAX_SECONDS,
  VOICE_SAMPLE_RATE,
  type VoiceErrorCode,
  type VoiceEvent,
} from '../../shared/protocol.js';
import { UserFacingError } from './sources.js';

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
  transcribe(pcm: Buffer): Promise<{ text: string; ms: number }>;
  speak(text: string, voice: string, speed: number): Promise<Buffer>;
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

  private call(method: string, path: string, body: Buffer | undefined, type: string, timeoutMs: number): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
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

  async transcribe(pcm: Buffer): Promise<{ text: string; ms: number }> {
    const reply = await this.call('POST', '/stt', pcm, 'application/octet-stream', WORK_TIMEOUT_MS);
    if (reply.status !== 200) throw SpeechClient.failed(reply, "Couldn't write down what you said.");
    const data = SpeechClient.json(reply);
    return {
      text: typeof data.text === 'string' ? data.text : '',
      ms: typeof data.ms === 'number' ? data.ms : 0,
    };
  }

  async speak(text: string, voice: string, speed: number): Promise<Buffer> {
    const body = Buffer.from(JSON.stringify({ text, voice, speed }));
    const reply = await this.call('POST', '/tts', body, 'application/json', WORK_TIMEOUT_MS);
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
      try {
        const { text, ms } = await this.speech.transcribe(pcm);
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
