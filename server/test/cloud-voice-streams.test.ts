import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ElevenLabs, type CloudTransport } from '../../speech/cloud-api.js';
import { startCloudRpc } from '../../speech/cloud-rpc.js';
import { CloudSpeechClient, CloudSpeechError, type CloudSpeechService } from '../src/cloud-speech.js';
import { pcmWav, type SpeechService } from '../src/speech.js';
import { apiHeaders, makeApp, makeKeys, makeToken, postHeaders, type Keys } from './helpers.js';
import type { AppVoice, CloudVoices } from '../../shared/voice.js';

const key = 'obviously-fake-escaped-key';
const choice: AppVoice = { provider: 'elevenlabs', voiceId: 'fake-voice', modelId: 'fake-model' };
const catalog: CloudVoices = { voices: [{ id: 'fake-voice', name: 'Demo', category: 'cloned', preview: true }], models: [{ id: 'fake-model', name: 'Demo model' }] };
const pcm = Buffer.alloc(6000, 1);
const wav = pcmWav(pcm);
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); while (cleanups.length) await cleanups.pop()!(); });
let keys: Keys;
let token: string;
beforeAll(async () => { keys = await makeKeys(); token = await makeToken(keys); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wayroost-cloud-voice-streams-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function local(): SpeechService {
  return { health: async () => ({ voices: ['af_heart'], defaultVoice: 'af_heart' }), transcribe: async () => ({ text: '', ms: 0 }), speak: vi.fn(async () => wav) };
}
function cloud(): CloudSpeechService {
  return { catalog: async () => catalog, synthesize: async function* () { yield pcm; } };
}

it.each(['unicode', 'mixed'] as const)('scrubs %s JSON credential echoes before catalog data reaches the server', async encoding => {
  const dir = fixture();
  const socketPath = join(dir, 'api.sock');
  const escaped = [...key].map((char, i) => encoding === 'mixed' && i % 2 ? char : `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const api = createServer((req, res) => {
    const body = req.url === '/v1/voices' ? { voices: [
      { voice_id: 'fake-voice', name: `Demo ${key}`, category: `cloned ${key}`, preview_url: key },
      { voice_id: key, name: 'Credential identifier' },
      { voice_id: `prefix-${key}-suffix`, name: 'Embedded credential identifier' },
    ] } : [
      { model_id: 'fake-model', name: `Model ${key}`, can_do_text_to_speech: true },
      { model_id: key, name: 'Credential identifier', can_do_text_to_speech: true },
      { model_id: `prefix-${key}-suffix`, name: 'Embedded credential identifier', can_do_text_to_speech: true },
    ];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body).replaceAll(key, escaped));
  });
  await new Promise<void>(resolve => api.listen(socketPath, resolve));
  cleanups.push(() => new Promise<void>(resolve => { api.closeAllConnections(); api.close(() => resolve()); }));
  const transport: CloudTransport = (url, options, receive) => request({ ...options, socketPath, path: url.pathname }, receive);
  const rpcPath = join(dir, 'cloud.sock');
  const rpc = await startCloudRpc(rpcPath, new ElevenLabs(key, transport));
  cleanups.push(() => new Promise<void>(resolve => { rpc.closeAllConnections(); rpc.close(() => resolve()); }));
  const logs: string[] = [];
  const ctx = await makeApp(keys, { speech: local(), cloudSpeech: new CloudSpeechClient(rpcPath),
    logger: { level: 'trace', stream: { write: (line: string) => { logs.push(line); } } } });
  cleanups.push(() => ctx.app.close());
  const result = await ctx.app.inject({ url: '/api/voice/catalog', headers: apiHeaders(token) });
  expect(result.statusCode).toBe(200);
  expect(result.body).not.toContain(key);
  expect(result.json()).toEqual({ available: true,
    voices: [{ id: 'fake-voice', name: 'Demo [redacted]', category: 'cloned [redacted]', preview: true }],
    models: [{ id: 'fake-model', name: 'Model [redacted]' }],
  });
  const status = await ctx.app.inject({ url: '/api/voice', headers: apiHeaders(token) });
  expect(status.body).not.toContain(key);
  expect(logs.join('')).not.toContain(key);
});

it.each([false, true])('counts unfinished local synthesis after disconnects (stream=%s)', async stream => {
  const speech = local();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let active = 0;
  let calls = 0;
  speech.speak = vi.fn(async () => {
    active++;
    const call = ++calls;
    try { if (call <= 4) await gate; return wav; }
    finally { active--; }
  });
  const socketPath = join(fixture(), 'app.sock');
  const ctx = await makeApp(keys, { speech });
  cleanups.push(() => ctx.app.close());
  cleanups.push(release);
  let closed = 0;
  ctx.app.addHook('onRequest', async (_req, reply) => { reply.raw.once('close', () => { closed++; }); });
  await ctx.app.listen({ path: socketPath });
  for (let i = 0; i < 4; i++) {
    const req = request({ socketPath, path: '/api/voice/speak', method: 'POST', headers: postHeaders(token) });
    req.on('error', () => {});
    req.end(JSON.stringify({ text: 'Demo.', stream }));
    await expect.poll(() => calls).toBe(i + 1);
    req.destroy();
    await expect.poll(() => closed).toBe(i + 1);
  }
  expect(active).toBe(4);
  const busy = await ctx.app.inject({ method: 'POST', url: '/api/voice/speak', headers: postHeaders(token), payload: { text: 'Extra.', stream } });
  expect(busy.statusCode).toBe(429);
  expect(speech.speak).toHaveBeenCalledTimes(4);
  release();
  await expect.poll(() => active).toBe(0);
  const next = await ctx.app.inject({ method: 'POST', url: '/api/voice/speak', headers: postHeaders(token), payload: { text: 'Available again.', stream } });
  expect(next.statusCode).toBe(200);
  expect(speech.speak).toHaveBeenCalledTimes(5);
});

it('releases streams disconnected before their iterator starts', async () => {
  const speech = local();
  const socketPath = join(fixture(), 'app.sock');
  const ctx = await makeApp(keys, { speech });
  cleanups.push(() => ctx.app.close());
  let closed = 0;
  const from = Readable.from;
  const streamFactory = vi.spyOn(Readable, 'from').mockImplementation((iterable, options) => {
    const stream = from(iterable, options);
    stream.destroy();
    return stream;
  });
  ctx.app.addHook('onSend', async (_req, reply, payload) => {
    if (closed < 4 && payload instanceof Readable) {
      reply.raw.once('close', () => { closed++; });
      reply.raw.destroy();
    }
    return payload;
  });
  await ctx.app.listen({ path: socketPath });
  for (let i = 0; i < 4; i++) {
    const req = request({ socketPath, path: '/api/voice/speak', method: 'POST', headers: postHeaders(token) });
    req.on('error', () => {});
    req.end(JSON.stringify({ text: 'Demo.', stream: true }));
    await expect.poll(() => closed).toBe(i + 1);
  }
  expect(speech.speak).not.toHaveBeenCalled();
  expect(streamFactory).toHaveBeenCalledTimes(4);
  streamFactory.mockRestore();
  const next = await ctx.app.inject({ method: 'POST', url: '/api/voice/speak', headers: postHeaders(token), payload: { text: 'Available.', stream: true } });
  expect(next.statusCode).toBe(200);
  expect(speech.speak).toHaveBeenCalledTimes(1);
});

it.each([false, true])('aborts disconnected cloud work without starting local fallback (stream=%s)', async stream => {
  const speech = local();
  const remote = cloud();
  let signal: AbortSignal | undefined;
  remote.synthesize = vi.fn<CloudSpeechService['synthesize']>((_text, _choice, _format, cancellation) => {
    signal = cancellation;
    return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Buffer>>(() => {}) }) };
  });
  const socketPath = join(fixture(), 'app.sock');
  const ctx = await makeApp(keys, { speech, cloudSpeech: remote });
  cleanups.push(() => ctx.app.close());
  await ctx.app.inject({ method: 'PUT', url: '/api/voice', headers: postHeaders(token), payload: { appReadAloud: choice } });
  await ctx.app.listen({ path: socketPath });
  const req = request({ socketPath, path: '/api/voice/speak', method: 'POST', headers: postHeaders(token) });
  req.on('error', () => {});
  req.end(JSON.stringify({ text: 'Demo.', stream }));
  await expect.poll(() => !!signal).toBe(true);
  req.destroy();
  await expect.poll(() => signal?.aborted).toBe(true);
  expect(speech.speak).not.toHaveBeenCalled();
  remote.synthesize = async function* () { yield pcm; };
  const next = await ctx.app.inject({ method: 'POST', url: '/api/voice/speak', headers: postHeaders(token), payload: { text: 'Retry.', stream } });
  expect(next.statusCode).toBe(200);
  if (stream) expect(JSON.parse(next.body.split('\n')[0]!)).toMatchObject({ provider: 'elevenlabs' });
  else expect(next.headers['x-wayroost-voice-provider']).toBe('elevenlabs');
  expect(speech.speak).not.toHaveBeenCalled();
});

it.each([0.5, 0.9, 1, 1.15, 1.3, 2])('uses speed %s in buffered cloud WAV headers and preserves local fallback WAVs', async speed => {
  const speech = local();
  const remote = cloud();
  const ctx = await makeApp(keys, { speech, cloudSpeech: remote });
  cleanups.push(() => ctx.app.close());
  await ctx.app.inject({ method: 'PUT', url: '/api/voice', headers: postHeaders(token), payload: { appReadAloud: choice } });
  const speak = () => ctx.app.inject({ method: 'POST', url: '/api/voice/speak', headers: postHeaders(token), payload: { text: 'Demo.', speed } });
  const result = await speak();
  expect(result.statusCode).toBe(200);
  expect(result.headers['x-wayroost-voice-provider']).toBe('elevenlabs');
  expect(result.rawPayload.readUInt32LE(24)).toBe(Math.round(24000 * speed));
  expect(result.rawPayload.readUInt32LE(28)).toBe(Math.round(24000 * speed) * 2);
  expect(result.rawPayload.subarray(44)).toEqual(pcm);
  remote.synthesize = async function* () { throw new CloudSpeechError('quota'); };
  const fallback = await speak();
  expect(fallback.headers['x-wayroost-voice-provider']).toBe('local');
  expect(fallback.rawPayload).toEqual(wav);
  expect(speech.speak).toHaveBeenCalledWith('Demo.', 'af_heart', speed, expect.any(AbortSignal));
});
