import { checkDeviceSignal, deviceSignal, actionSignal } from './security/device-signal.js';
import { request } from 'node:http';
import type { AppVoice, CloudFormat, CloudVoiceErrorCode, CloudVoices } from '../../shared/voice.js';
import { CLOUD_ID } from '../../shared/voice.js';

export class CloudSpeechError extends Error {
  constructor(readonly code: CloudVoiceErrorCode) { super(`Cloud voice: ${code}`); }
}
export interface CloudSpeechService {
  catalog(signal?: AbortSignal): Promise<CloudVoices>;
  synthesize(text: string, choice: AppVoice, format: CloudFormat, signal?: AbortSignal): AsyncIterable<Buffer>;
}
const CODES: CloudVoiceErrorCode[] = ['auth', 'quota', 'rate-limit', 'unreachable', 'timeout', 'invalid', 'failed'];

/** This client has no credential and can connect only through the cloud process's Unix socket. */
export class CloudSpeechClient implements CloudSpeechService {
  constructor(private readonly socketPath: string, private readonly timeoutMs = 35_000) {}

  private async *call(path: string, body?: unknown, signal = deviceSignal()): AsyncGenerator<Buffer> {
    checkDeviceSignal();
    checkDeviceSignal(signal);
    signal = actionSignal(signal);
    let timedOut = false;
    const req = request({ socketPath: this.socketPath, path, method: body ? 'POST' : 'GET', agent: false, signal,
      headers: { host: 'localhost', ...(body ? { 'content-type': 'application/json' } : {}) } });
    const timer = setTimeout(() => { timedOut = true; req.destroy(new CloudSpeechError('timeout')); }, this.timeoutMs);
    try {
      const response = new Promise<import('node:http').IncomingMessage>((resolve, reject) => { req.once('response', resolve); req.on('error', reject); });
      req.end(body ? JSON.stringify(body) : undefined);
      const res = await response;
      const errorParts: Buffer[] = [];
      let bytes = 0;
      for await (const part of res) {
        const chunk = part as Buffer;
        bytes += chunk.length;
        if (bytes > (res.statusCode === 200 ? 8 * 1024 * 1024 : 16_384)) throw new CloudSpeechError('failed');
        if (res.statusCode === 200) yield chunk; else errorParts.push(chunk);
      }
      if (res.statusCode !== 200) {
        let code: CloudVoiceErrorCode = 'failed';
        try { const data = JSON.parse(Buffer.concat(errorParts).toString()) as { code?: CloudVoiceErrorCode }; if (data.code && CODES.includes(data.code)) code = data.code; } catch { /* No remote error text is exposed. */ }
        throw new CloudSpeechError(code);
      }
      if (!bytes) throw new CloudSpeechError('failed');
    } catch (err) {
      throw err instanceof CloudSpeechError ? err : new CloudSpeechError(timedOut ? 'timeout' : 'unreachable');
    } finally { clearTimeout(timer); req.destroy(); }
  }

  async catalog(signal?: AbortSignal): Promise<CloudVoices> {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of this.call('/catalog', undefined, signal)) {
      size += part.length;
      if (size > 1024 * 1024) throw new CloudSpeechError('failed');
      parts.push(part);
    }
    try {
      const data = JSON.parse(Buffer.concat(parts).toString('utf8')) as CloudVoices;
      if (!Array.isArray(data.voices) || !Array.isArray(data.models) || data.voices.some(v => !CLOUD_ID.test(v.id) || typeof v.name !== 'string' || typeof v.category !== 'string') || data.models.some(m => !CLOUD_ID.test(m.id) || typeof m.name !== 'string')) throw new Error();
      return data;
    } catch { throw new CloudSpeechError('failed'); }
  }

  synthesize(text: string, choice: AppVoice, format: CloudFormat, signal?: AbortSignal): AsyncIterable<Buffer> {
    return this.call('/synthesize', { text, voiceId: choice.voiceId, modelId: choice.modelId, outputFormat: format }, signal);
  }
}
