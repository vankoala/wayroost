import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type ClientRequest, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ElevenLabs, type CloudTransport } from '../../speech/cloud-api.js';
import { startCloudRpc } from '../../speech/cloud-rpc.js';
import { CloudSpeechClient, CloudSpeechError, type CloudSpeechService } from '../src/cloud-speech.js';
import { pcmWav, readAloud, type SpeechService } from '../src/speech.js';
import { makeApp, makeKeys, makeToken, postHeaders, type Keys } from './helpers.js';
import type { AppVoice, SpeechFrame } from '../../shared/voice.js';

const choice: AppVoice = { provider: 'elevenlabs', voiceId: 'fake-voice', modelId: 'fake-model' };
const catalog = { voices: [{ id: 'fake-voice', name: 'Demo', category: 'cloned', preview: true }], models: [{ id: 'fake-model', name: 'Demo model' }] };
const pcm = Buffer.alloc(6000, 1);
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { vi.useRealTimers(); while (cleanups.length) await cleanups.pop()!(); });
let keys: Keys;
let token: string;
beforeAll(async () => { keys = await makeKeys(); token = await makeToken(keys); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wayroost-cloud-voice-cancellation-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function keep(server: Server) {
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
}
function local(): SpeechService {
  return { health: async () => ({ voices: ['af_heart'], defaultVoice: 'af_heart' }), transcribe: async () => ({ text: '', ms: 0 }), speak: vi.fn(async () => pcmWav(pcm)) };
}
async function fake(handler: RequestListener) {
  const dir = fixture();
  const socketPath = join(dir, 'api.sock');
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  keep(server);
  const requests: Array<{ path: string; req: ClientRequest }> = [];
  const responses: IncomingMessage[] = [];
  const transport: CloudTransport = (url, options, receive) => {
    const req = request({ ...options, socketPath, path: url.pathname + url.search }, res => { responses.push(res); receive(res); });
    requests.push({ path: url.pathname, req });
    return req;
  };
  const rpcPath = join(dir, 'cloud.sock');
  const rpc = await startCloudRpc(rpcPath, new ElevenLabs('obviously-fake-cancellation-key', transport));
  keep(rpc);
  return { client: new CloudSpeechClient(rpcPath), requests, responses, dir };
}
async function collect<T>(source: AsyncIterable<T>) {
  const result: T[] = [];
  for await (const value of source) result.push(value);
  return result;
}

it.each(['catalog', 'synthesize'] as const)('cancels %s immediately during connection setup and clears deadlines', async operation => {
  vi.useFakeTimers();
  for (const stage of ['before', 'during', 'setup'] as const) {
    const abort = new AbortController();
    let upstream: ClientRequest | undefined;
    cleanups.push(() => { upstream?.destroy(); });
    const transport: CloudTransport = (_url, options, receive) => {
      upstream = request({ ...options, host: 'never-resolved.invalid', lookup: () => {} }, receive);
      if (stage === 'setup') abort.abort();
      return upstream;
    };
    const api = new ElevenLabs('obviously-fake-cancellation-key', transport);
    if (stage === 'before') abort.abort();
    const pending = operation === 'catalog' ? api.catalog(abort.signal) : api.synthesize('Demo.', 'fake-voice', 'fake-model', 'pcm_24000', abort.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'unreachable' });
    if (stage === 'during') abort.abort();
    if (stage === 'before') expect(upstream).toBeUndefined();
    else expect(upstream?.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await assertion;
  }
});

it.each([false, true])('cancels eight pre-header upstream requests through the app without leaving synthesis running (stream=%s)', async stream => {
  let stalled = true;
  const { client, requests, dir } = await fake((req, res) => {
    if (req.url === '/v1/voices') return res.end(JSON.stringify({ voices: [{ voice_id: 'fake-voice', name: 'Demo' }] }));
    if (req.url === '/v1/models') return res.end(JSON.stringify([{ model_id: 'fake-model', name: 'Demo model', can_do_text_to_speech: true }]));
    if (!stalled) { res.writeHead(200, { 'content-type': 'audio/pcm' }); res.end(pcm); }
  });
  const speech = local();
  const ctx = await makeApp(keys, { speech, cloudSpeech: client });
  cleanups.push(() => ctx.app.close());
  const saved = await ctx.app.inject({ method: 'PUT', url: '/api/voice', headers: postHeaders(token), payload: { appReadAloud: choice } });
  expect(saved.statusCode).toBe(200);
  const socketPath = join(dir, 'app.sock');
  await ctx.app.listen({ path: socketPath });
  const synthesis = () => requests.filter(row => row.path.startsWith('/v1/text-to-speech/'));
  for (let i = 0; i < 8; i++) {
    const req = request({ socketPath, path: '/api/voice/speak', method: 'POST', headers: postHeaders(token) });
    req.on('error', () => {});
    cleanups.push(() => { req.destroy(); });
    req.end(JSON.stringify({ text: 'Demo.', stream }));
    await expect.poll(() => synthesis().length).toBe(i + 1);
    req.destroy();
    await expect.poll(() => synthesis().every(row => row.req.destroyed), { timeout: 500 }).toBe(true);
    expect(speech.speak).not.toHaveBeenCalled();
  }
  stalled = false;
  const next = await ctx.app.inject({ method: 'POST', url: '/api/voice/speak', headers: postHeaders(token), payload: { text: 'Available again.', stream } });
  expect(next.statusCode).toBe(200);
  if (stream) expect(JSON.parse(next.body.split('\n')[0]!)).toMatchObject({ provider: 'elevenlabs' });
  else expect(next.headers['x-wayroost-voice-provider']).toBe('elevenlabs');
  expect(speech.speak).not.toHaveBeenCalled();
});

it.each(['voices-headers', 'voices-body', 'models-headers', 'models-body'] as const)('cancels catalog work at %s without starting another upstream request', async stage => {
  const { client, requests, responses } = await fake((req, res) => {
    const voices = req.url === '/v1/voices';
    const data = voices ? { voices: [] } : [];
    if (voices && stage.startsWith('models')) return res.end(JSON.stringify(data));
    if (stage.endsWith('body')) { res.writeHead(200, { 'content-type': 'application/json' }); res.write('['); }
  });
  const abort = new AbortController();
  const pending = client.catalog(abort.signal);
  const assertion = expect(pending).rejects.toBeInstanceOf(CloudSpeechError);
  const count = stage.startsWith('models') ? 2 : 1;
  await expect.poll(() => requests.length).toBe(count);
  if (stage.endsWith('body')) await expect.poll(() => responses.at(-1)?.headers['content-type']).toBe('application/json');
  abort.abort();
  await assertion;
  await expect.poll(() => requests.every(row => row.req.destroyed), { timeout: 500 }).toBe(true);
  expect(requests).toHaveLength(count);
});

it('cancels an upstream stream after headers and audio arrive', async () => {
  const { client, requests } = await fake((_req, res) => { res.writeHead(200, { 'content-type': 'audio/pcm' }); res.write(pcm); });
  const abort = new AbortController();
  const iterator = client.synthesize('Demo.', choice, 'pcm_24000', abort.signal)[Symbol.asyncIterator]();
  const first = await iterator.next();
  expect(first.done).toBe(false);
  expect(first.value.length).toBeGreaterThan(0);
  const pending = iterator.next();
  const assertion = expect(pending).rejects.toBeInstanceOf(CloudSpeechError);
  abort.abort();
  await assertion;
  await expect.poll(() => requests[0]!.req.destroyed, { timeout: 500 }).toBe(true);
});

it.each(['auth', 'quota', 'rate-limit', 'unreachable', 'timeout', 'failed'] as const)('preserves a newer %s cooldown when an older stream succeeds', async code => {
  vi.useFakeTimers();
  const speech = local();
  let calls = 0;
  const synthesize = vi.fn(async function* () {
    if (++calls === 2) throw new CloudSpeechError(code);
    yield pcm;
  });
  const remote: CloudSpeechService = { catalog: async () => catalog, synthesize };
  const older = readAloud(speech, remote, choice, 'Older.', 'af_heart', 1);
  expect((await older.next()).value).toMatchObject({ type: 'start', provider: 'elevenlabs' });
  expect((await older.next()).value).toMatchObject({ type: 'audio' });
  expect((await collect(readAloud(speech, remote, choice, 'Newer.', 'af_heart', 1)))[0]).toMatchObject({ provider: 'local', reason: code });
  expect(await collect<SpeechFrame>({ [Symbol.asyncIterator]: () => older })).toEqual([{ type: 'end', provider: 'elevenlabs', voice: 'fake-voice' }]);
  const cooldown = code === 'auth' || code === 'quota' ? 300_000 : 60_000;
  await vi.advanceTimersByTimeAsync(cooldown - 1);
  expect((await collect(readAloud(speech, remote, choice, 'During cooldown.', 'af_heart', 1)))[0]).toMatchObject({ provider: 'local', reason: code });
  expect(synthesize).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2);
  expect((await collect(readAloud(speech, remote, choice, 'After cooldown.', 'af_heart', 1)))[0]).toMatchObject({ provider: 'elevenlabs' });
  expect(synthesize).toHaveBeenCalledTimes(3);
});
