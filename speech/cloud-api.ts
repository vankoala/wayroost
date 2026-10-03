import { readFileSync } from 'node:fs';
import { request, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { CLOUD_ID, type CloudFormat, type CloudVoiceErrorCode, type CloudVoices } from '../shared/voice.js';

const API = 'https://api.elevenlabs.io';
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
export class CloudVoiceError extends Error {
  constructor(readonly code: CloudVoiceErrorCode) { super(`Cloud voice: ${code}`); }
}

export function apiUrl(path: string): URL {
  const url = new URL(path, API);
  if (url.origin !== API || url.username || url.password || url.hash || !url.pathname.startsWith('/v1/')) {
    throw new CloudVoiceError('invalid');
  }
  return url;
}

export function credential(env: NodeJS.ProcessEnv): string {
  try {
    const dir = env.CREDENTIALS_DIRECTORY;
    if (!dir || !isAbsolute(dir)) throw new Error();
    const value = readFileSync(join(dir, 'elevenlabs-api-key'), 'utf8').trim();
    if (!value || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value)) throw new Error();
    return value;
  } catch { throw new CloudVoiceError('auth'); }
}

/** The injected transport is used only by offline tests; production always uses HTTPS. */
export type CloudTransport = (url: URL, options: RequestOptions, receive: (res: IncomingMessage) => void) => ClientRequest;
export class ElevenLabs {
  constructor(
    private readonly key: string,
    private readonly transport: CloudTransport = request,
    private readonly timeoutMs = 30_000,
  ) {}

  private open(path: string, body?: unknown, signal?: AbortSignal): Promise<IncomingMessage> {
    const url = apiUrl(path);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new CloudVoiceError('unreachable')); return; }
      let response: IncomingMessage | undefined;
      const data = body === undefined ? undefined : JSON.stringify(body);
      let timedOut = false;
      const deadline = Math.min(2_000, this.timeoutMs);
      let req: ClientRequest;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { clearTimeout(timer); clearTimeout(connectTimer); signal?.removeEventListener('abort', cancel); req?.off('timeout', timeout); };
      const fail = () => { cleanup(); reject(new CloudVoiceError(timedOut ? 'timeout' : 'unreachable')); };
      const cancel = () => {
        cleanup();
        req.destroy();
        response?.destroy(new CloudVoiceError('unreachable'));
        reject(new CloudVoiceError('unreachable'));
      };
      const timeout = () => { timedOut = true; req.destroy(); response?.destroy(new CloudVoiceError('timeout')); fail(); };
      try { req = this.transport(url, {
        method: data === undefined ? 'GET' : 'POST', agent: false,
        timeout: deadline,
        headers: { 'xi-api-key': this.key, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
      }, (res) => {
        clearTimeout(connectTimer);
        response = res;
        res.on('error', () => {});
        res.once('close', cleanup); res.once('end', cleanup);
        resolve(res);
      }); } catch { reject(new CloudVoiceError('auth')); return; }
      // A socket idle timeout alone does not cover DNS lookup or a stalled SYN.
      connectTimer = setTimeout(timeout, deadline);
      timer = setTimeout(timeout, this.timeoutMs);
      req.setTimeout(deadline, timeout);
      req.on('error', fail);
      req.on('close', () => { clearTimeout(connectTimer); if (!response) cleanup(); });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      req.end(data);
    });
  }

  private async json(res: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const part of res) {
        const chunk = Buffer.from(part as Uint8Array);
        size += chunk.length;
        if (size > MAX_JSON_BYTES) throw new CloudVoiceError('failed');
        chunks.push(chunk);
      }
      // Treat everything from the remote API as untrusted; never return a key echo.
      return JSON.parse(Buffer.concat(chunks).toString('utf8'), (_name, value: unknown) =>
        typeof value === 'string' ? value.split(this.key).join('[redacted]') : value,
      ) as unknown;
    } catch (err) {
      res.destroy();
      throw err instanceof CloudVoiceError ? err : new CloudVoiceError('failed');
    }
  }

  private async checked(res: IncomingMessage): Promise<IncomingMessage> {
    if (res.statusCode === 200) return res;
    const status = res.statusCode;
    let detail: unknown;
    try { detail = await this.json(res); } catch { /* Only fixed error codes leave this process. */ }
    const code = JSON.stringify(detail ?? '');
    if (/quota_exceeded|insufficient_credits|payment_required/.test(code) || status === 402) throw new CloudVoiceError('quota');
    if (status === 401 || status === 403) throw new CloudVoiceError('auth');
    if (status === 429) throw new CloudVoiceError('rate-limit');
    throw new CloudVoiceError(status && status >= 500 ? 'unreachable' : 'failed');
  }

  async catalog(signal?: AbortSignal): Promise<CloudVoices> {
    const rawVoices = await this.json(await this.checked(await this.open('/v1/voices', undefined, signal))) as { voices?: unknown };
    const rawModels = await this.json(await this.checked(await this.open('/v1/models', undefined, signal)));
    const label = (v: unknown, fallback: string) => typeof v === 'string' ? v.slice(0, 120) : fallback;
    const rows = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.slice(0, 1000).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object') : [];
    return {
      voices: rows(rawVoices.voices).filter(v => typeof v.voice_id === 'string' && CLOUD_ID.test(v.voice_id)).map(v => ({
        id: String(v.voice_id), name: label(v.name, 'Voice'), category: label(v.category, 'unknown'), preview: typeof v.preview_url === 'string' && !!v.preview_url,
      })),
      models: rows(rawModels).filter(m => m.can_do_text_to_speech === true && typeof m.model_id === 'string' && CLOUD_ID.test(m.model_id)).map(m => ({ id: String(m.model_id), name: label(m.name, 'Model') })),
    };
  }

  async synthesize(text: string, voiceId: string, modelId: string, format: CloudFormat, signal?: AbortSignal): Promise<IncomingMessage> {
    if (!CLOUD_ID.test(voiceId) || !CLOUD_ID.test(modelId) || !text.trim() || text.length > 1000 || !['pcm_24000', 'mp3_44100_128'].includes(format)) throw new CloudVoiceError('invalid');
    const res = await this.checked(await this.open(`/v1/text-to-speech/${voiceId}/stream?output_format=${format}`, { text, model_id: modelId }, signal));
    const type = String(res.headers['content-type'] ?? '');
    if (!type.startsWith('audio/') && !type.startsWith('application/octet-stream')) { res.destroy(); throw new CloudVoiceError('failed'); }
    return res;
  }

  async *audio(res: IncomingMessage): AsyncGenerator<Buffer> {
    let tail = Buffer.alloc(0);
    let bytes = 0;
    const secret = Buffer.from(this.key);
    try {
      for await (const part of res) {
        const chunk = Buffer.from(part as Uint8Array);
        bytes += chunk.length;
        if (bytes > MAX_AUDIO_BYTES) throw new CloudVoiceError('failed');
        const data = Buffer.concat([tail, chunk]);
        if (data.includes(secret)) throw new CloudVoiceError('failed');
        const end = Math.max(0, data.length - secret.length + 1);
        if (end) yield data.subarray(0, end);
        tail = data.subarray(end);
      }
      if (!bytes) throw new CloudVoiceError('failed');
      if (tail.length) yield tail;
    } catch (err) {
      throw err instanceof CloudVoiceError ? err : new CloudVoiceError('unreachable');
    } finally { res.destroy(); }
  }
}
