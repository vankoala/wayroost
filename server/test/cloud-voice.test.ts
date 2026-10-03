import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { apiUrl, credential, CloudVoiceError, ElevenLabs, type CloudTransport } from '../../speech/cloud-api.js';
import { startCloudRpc } from '../../speech/cloud-rpc.js';
import { CloudSpeechClient, CloudSpeechError } from '../src/cloud-speech.js';
import { readAloud, type SpeechService } from '../src/speech.js';
import { VoiceSetting } from '../src/voice-setting.js';
import { PHONE_COOKIE, apiHeaders, makeApp, makeKeys, makeToken, postHeaders, type Keys } from './helpers.js';
import type { AppVoice, CloudVoiceErrorCode, SpeechFrame } from '../../shared/voice.js';

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const value of source) result.push(value); return result; }

const KEY = 'obviously-fake-elevenlabs-secret';
const CHOICE: AppVoice = { provider: 'elevenlabs', voiceId: 'fake-cloned-voice', modelId: 'fake-model' };
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60)]);
const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'wayroost-cloud-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function keep(server: Server) { cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })); }
const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
async function fake(handler?: (res: ServerResponse) => void, timeout = 1000) {
  const seen: { path: string; key: string; body: string; origin: string }[] = [];
  const api = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    seen.push({ path: req.url!, key: String(req.headers['xi-api-key']), body: Buffer.concat(chunks).toString(), origin: '' });
    if (req.url === '/v1/voices') return json(res, 200, { voices: [
      { voice_id: 'fake-cloned-voice', name: `Demo clone ${KEY}`, category: 'cloned', preview_url: 'https://example.com/never-fetched' },
      { voice_id: 'fake-premade-voice', name: 'Demo premade', category: 'premade' },
    ] });
    if (req.url === '/v1/models') return json(res, 200, [{ model_id: 'fake-model', name: 'Demo model', can_do_text_to_speech: true }]);
    if (handler) return handler(res);
    res.writeHead(200, { 'content-type': 'audio/pcm' }); res.write(Buffer.alloc(6000, 1)); res.end(Buffer.alloc(6000, 2));
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening'); keep(api);
  const port = (api.address() as { port: number }).port;
  const origins: string[] = [];
  const transport: CloudTransport = (url, options, receive) => {
    origins.push(url.origin);
    // Production URL validation runs first. Only this test adapter redirects it to loopback.
    return request({ ...options, host: '127.0.0.1', port, path: url.pathname + url.search }, receive);
  };
  const directory = fixture();
  writeFileSync(join(directory, 'elevenlabs-api-key'), ` ${KEY}\n`, { mode: 0o600 });
  const rpc = await startCloudRpc(join(directory, 'cloud.sock'), new ElevenLabs(credential({ CREDENTIALS_DIRECTORY: directory }), transport, timeout));
  keep(rpc);
  return { client: new CloudSpeechClient(join(directory, 'cloud.sock'), timeout + 100), seen, origins, directory };
}
function local() {
  const calls: Array<{ text: string; voice: string; speed: number }> = [];
  const service: SpeechService = {
    health: async () => ({ voices: ['af_heart', 'bm_george'], defaultVoice: 'af_heart' }),
    transcribe: async () => ({ text: 'local only', ms: 1 }),
    speak: async (text, voice, speed) => { calls.push({ text, voice, speed }); return WAV; },
  };
  return { service, calls };
}

describe('isolated cloud voice process', () => {
  it('loads only the systemd credential, trims it, refuses alternate hosts and emits fixed errors', () => {
    const dir = fixture();
    expect(() => credential({ ELEVENLABS_API_KEY: KEY })).toThrow('Cloud voice: auth');
    writeFileSync(join(dir, 'elevenlabs-api-key'), ` ${KEY}\n`);
    expect(credential({ CREDENTIALS_DIRECTORY: dir })).toBe(KEY);
    for (const path of ['https://example.com/v1/voices', 'http://api.elevenlabs.io/v1/voices', '//example.com/v1/voices', 'https://api.elevenlabs.io:8443/v1/voices', 'https://fake@api.elevenlabs.io/v1/voices', '/v1/voices#fragment']) expect(() => apiUrl(path)).toThrow('Cloud voice: invalid');
    expect(apiUrl('/v1/voices').origin).toBe('https://api.elevenlabs.io');
  });

  it('lists cloned and premade voices and models without returning preview URLs or credential echoes', async () => {
    const { client, seen, origins, directory } = await fake();
    const catalog = await client.catalog();
    expect(catalog.voices.map(v => v.category)).toEqual(['cloned', 'premade']);
    expect(catalog.voices[0]?.preview).toBe(true);
    expect(catalog.models[0]?.id).toBe('fake-model');
    expect(JSON.stringify(catalog)).not.toContain(KEY);
    expect(JSON.stringify(catalog)).not.toContain('example.com');
    expect(seen.every(r => r.key === KEY)).toBe(true);
    expect(origins).toEqual(['https://api.elevenlabs.io', 'https://api.elevenlabs.io']);
    expect(statSync(join(directory, 'cloud.sock')).mode & 0o777).toBe(0o660);
    expect(readdirSync(directory).sort()).toEqual(['cloud.sock', 'elevenlabs-api-key']);
    expect(readFileSync(join(directory, 'elevenlabs-api-key'), 'utf8')).toBe(` ${KEY}\n`);
  });

  it('streams the first chunk before synthesis finishes and sends the selected model and output format', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { client, seen } = await fake(res => {
      res.writeHead(200, { 'content-type': 'audio/pcm' }); res.write(Buffer.alloc(6000, 1));
      void gate.then(() => res.end(Buffer.alloc(6000, 2)));
    });
    const stream = client.synthesize('Demo text.', CHOICE, 'pcm_24000')[Symbol.asyncIterator]();
    const first = await stream.next();
    expect(first.value.length).toBeGreaterThan(5900);
    expect(first.value.every((byte: number) => byte === 1)).toBe(true);
    expect(first.done).toBe(false);
    release();
    const remaining = await collect({ [Symbol.asyncIterator]: () => stream });
    expect(Buffer.concat([first.value, ...remaining])).toEqual(Buffer.concat([Buffer.alloc(6000, 1), Buffer.alloc(6000, 2)]));
    expect(seen[0]?.path).toBe('/v1/text-to-speech/fake-cloned-voice/stream?output_format=pcm_24000');
    expect(JSON.parse(seen[0]!.body)).toEqual({ text: 'Demo text.', model_id: 'fake-model' });
  });

  it.each([
    [401, 'auth', 'invalid_api_key'], [403, 'auth', 'forbidden'], [402, 'quota', 'quota_exceeded'],
    [401, 'quota', 'quota_exceeded'], [429, 'rate-limit', 'too_many_requests'], [503, 'unreachable', 'unavailable'],
    [302, 'failed', 'redirect'],
  ] as const)('returns a safe code for HTTP %i (%s) and falls back with identical text', async (status, code, remote) => {
    const { client } = await fake(res => json(res, status, { detail: { status: remote, message: KEY } }));
    const { service, calls } = local();
    const frames = await collect(readAloud(service, client, CHOICE, 'Same sentence.', 'bm_george', 1.25));
    expect(frames[0]).toMatchObject({ type: 'start', provider: 'local', voice: 'bm_george', reason: code });
    expect(calls).toEqual([{ text: 'Same sentence.', voice: 'bm_george', speed: 1.25 }]);
    expect(JSON.stringify(frames)).not.toContain(KEY);
  });

  it('times out stalled requests, refuses redirects without following them, and rejects oversized synthesis inputs', async () => {
    const { client, seen } = await fake(() => {}, 50);
    await expect(collect(client.synthesize('Demo.', CHOICE, 'pcm_24000'))).rejects.toMatchObject({ code: 'timeout' });
    await expect(collect(client.synthesize('x'.repeat(1001), CHOICE, 'pcm_24000'))).rejects.toMatchObject({ code: 'invalid' });
    expect(seen).toHaveLength(1);
  });

  it('rejects a credential echoed inside audio across chunk boundaries', async () => {
    const { client } = await fake(res => {
      res.writeHead(200, { 'content-type': 'audio/pcm' });
      res.write(Buffer.concat([Buffer.alloc(6000), Buffer.from(KEY.slice(0, 10))]));
      setTimeout(() => res.end(Buffer.from(KEY.slice(10))), 10);
    });
    const parts: Buffer[] = [];
    await expect((async () => { for await (const part of client.synthesize('Demo.', CHOICE, 'pcm_24000')) parts.push(part); })()).rejects.toBeInstanceOf(CloudSpeechError);
    expect(Buffer.concat(parts).toString()).not.toContain(KEY);
  });

  it('pins the local speech sandbox and gives the cloud unit only runtime writes', () => {
    const file = (name: string) => readFileSync(new URL(`../../deploy/${name}`, import.meta.url), 'utf8');
    for (const line of ['PrivateNetwork=yes', 'IPAddressDeny=any', 'RestrictAddressFamilies=AF_UNIX', 'RootDirectory=/opt/signalbox-speech/root']) expect(file('signalbox-speech.service').split('\n')).toContain(line);
    for (const line of ['SocketMode=0660', 'SocketGroup=signalbox-voice']) expect(file('signalbox-speech.socket').split('\n')).toContain(line);
    const unit = file('wayroost-voice-cloud.service');
    for (const line of ['DynamicUser=yes', 'ProtectHome=yes', 'ProtectSystem=strict', 'NoNewPrivileges=yes',
      'CapabilityBoundingSet=', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6', 'SystemCallFilter=@system-service',
      'LoadCredential=elevenlabs-api-key:/etc/wayroost/elevenlabs-api-key', 'ReadWritePaths=/run/wayroost-voice-cloud']) expect(unit).toContain(line);
    expect(unit).not.toContain('StateDirectory=');
    expect(unit).not.toContain('ListenStream=');
  });

  it('resets a partial cloud stream and replays the whole output locally', async () => {
    const { client } = await fake(res => { res.writeHead(200, { 'content-type': 'audio/pcm' }); res.write(Buffer.alloc(6000)); setTimeout(() => res.destroy(), 25); });
    const { service, calls } = local();
    const frames = await collect(readAloud(service, client, CHOICE, 'Complete text.', 'af_heart', 1));
    expect(frames.map(f => f.type)).toEqual(['start', 'audio', 'reset', 'audio', 'end']);
    expect(frames[2]).toMatchObject({ provider: 'local', voice: 'af_heart' });
    expect(calls[0]?.text).toBe('Complete text.');
  });

  it('falls back on a missing process and every failure code, including timeout', async () => {
    for (const code of ['auth', 'quota', 'rate-limit', 'unreachable', 'timeout', 'failed'] as CloudVoiceErrorCode[]) {
      const { service } = local();
      const cloud = { catalog: async () => ({ voices: [], models: [] }), synthesize: async function* () { throw new CloudSpeechError(code); } };
      const frames = await collect(readAloud(service, cloud, CHOICE, 'Demo.', 'af_heart', 1));
      expect(frames[0]).toMatchObject({ provider: 'local', reason: code });
    }
    const missing = new CloudSpeechClient(join(fixture(), 'missing.sock'));
    await expect(missing.catalog()).rejects.toMatchObject({ code: 'unreachable' });
    expect(new CloudVoiceError('auth').message).not.toContain(KEY);
  });
});

describe('voice settings and server routing', () => {
  let keys: Keys;
  let token: string;
  beforeAll(async () => { keys = await makeKeys(); token = await makeToken(keys); });
  async function setup() {
    const { client } = await fake();
    const { service, calls } = local();
    const ctx = await makeApp(keys, { speech: service, cloudSpeech: client });
    cleanups.push(() => ctx.app.close());
    return { ...ctx, calls };
  }
  it('permits only a paired desktop to change voices, rejects unknown choices and preserves local migration', async () => {
    const { app, config } = await setup();
    writeFileSync(join(config.stateDir, 'voice.json'), '{"voice":"bm_george"}');
    const migrated = new VoiceSetting(config.stateDir);
    expect(migrated.voice()).toBe('bm_george');
    expect(migrated.appReadAloud()).toEqual({ provider: 'local' });
    migrated.setAppReadAloud(CHOICE);
    expect(new VoiceSetting(config.stateDir).voice()).toBe('bm_george');
    expect(new VoiceSetting(config.stateDir).appReadAloud()).toEqual(CHOICE);
    const put = (payload: unknown, phone = false) => app.inject({ method: 'PUT', url: '/api/voice', headers: postHeaders(token, phone ? { cookie: PHONE_COOKIE } : {}), payload: JSON.stringify(payload) });
    expect((await put({ appReadAloud: CHOICE }, true)).statusCode).toBe(403);
    expect((await put({ voice: 'bm_george' }, true)).statusCode).toBe(403);
    expect((await put({ appReadAloud: { ...CHOICE, voiceId: 'fake-unknown' } })).statusCode).toBe(400);
    expect((await put({ appReadAloud: CHOICE })).statusCode).toBe(200);
    const phone = await app.inject({ url: '/api/voice', headers: apiHeaders(token, { cookie: PHONE_COOKIE }) });
    expect(phone.json()).toMatchObject({ canChange: false, appReadAloud: CHOICE, cloud: { available: true } });
    expect(phone.body).not.toContain(KEY);
    const bad = await app.inject({ method: 'PUT', url: '/api/voice', headers: postHeaders(token), payload: { appReadAloud: CHOICE, key: KEY } });
    expect(bad.statusCode).toBe(400); expect(bad.body).not.toContain(KEY);
  });

  it('routes app output through streaming frames, reports the actual voice, and keeps transcription local', async () => {
    const { app, calls } = await setup();
    await app.inject({ method: 'PUT', url: '/api/voice', headers: postHeaders(token), payload: { appReadAloud: CHOICE } });
    const buffered = await app.inject({ method: 'POST', url: '/api/voice/speak', headers: postHeaders(token), payload: { text: 'Demo.' } });
    expect(buffered.headers['x-wayroost-voice-provider']).toBe('elevenlabs');
    expect(buffered.headers['x-wayroost-voice']).toBe('fake-cloned-voice');
    expect(buffered.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    const stream = await app.inject({ method: 'POST', url: '/api/voice/speak', headers: postHeaders(token), payload: { text: 'Demo.', stream: true } });
    const frames = stream.body.trim().split('\n').map(line => JSON.parse(line) as SpeechFrame);
    expect(frames[0]).toMatchObject({ provider: 'elevenlabs', format: 'pcm_24000' });
    expect(frames.at(-1)).toMatchObject({ type: 'end', provider: 'elevenlabs' });
    expect(calls).toEqual([]);
  });

  it('keeps the credential out of logs, responses, errors and saved voice settings', async () => {
    const { client } = await fake(res => json(res, 401, { error: KEY }));
    const logs: string[] = [];
    const ctx = await makeApp(keys, { speech: local().service, cloudSpeech: client,
      logger: { level: 'trace', stream: { write: (line: string) => { logs.push(line); } } } });
    cleanups.push(() => ctx.app.close());
    await ctx.app.inject({ method: 'PUT', url: '/api/voice', headers: postHeaders(token), payload: { appReadAloud: CHOICE, voice: 'bm_george' } });
    const result = await ctx.app.inject({ method: 'POST', url: '/api/voice/speak', headers: postHeaders(token), payload: { text: 'Demo.' } });
    expect(result.headers['x-wayroost-voice-provider']).toBe('local');
    expect(result.headers['x-wayroost-voice']).toBe('bm_george');
    expect(result.headers['x-wayroost-voice-fallback']).toBe('auth');
    await ctx.app.inject({ method: 'PUT', url: '/api/voice', headers: postHeaders(token), payload: { appReadAloud: CHOICE, key: KEY } });
    expect(logs.join('')).not.toContain(KEY);
    expect(result.body).not.toContain(KEY);
    expect(readFileSync(join(ctx.config.stateDir, 'voice.json'), 'utf8')).not.toContain(KEY);
  });

  it('does not probe the cloud at startup or from a shadow timer', async () => {
    let catalogs = 0;
    const ctx = await makeApp(keys, { configExtra: { role: 'shadow', listen: { port: 8890 }, stateDir: join(fixture(), 'shadow-state') }, speech: local().service,
      cloudSpeech: { catalog: async () => { catalogs++; return { voices: [], models: [] }; }, synthesize: async function* () { throw new Error('unexpected synthesis'); } } });
    cleanups.push(() => ctx.app.close());
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(catalogs).toBe(0);
    const desktop = ctx.devices!.add('Demo desktop', 'desktop');
    await ctx.app.inject({ url: '/api/voice', headers: apiHeaders(token, { cookie: `wr_device=${desktop.cookie}` }) });
    expect(catalogs).toBe(0);
  });

  it('bounds concurrent output even when several health checks finish together', async () => {
    const { service, calls } = local();
    let healthReady!: () => void;
    let speechReady!: () => void;
    const healthGate = new Promise<void>(resolve => { healthReady = resolve; });
    const speechGate = new Promise<void>(resolve => { speechReady = resolve; });
    const originalHealth = service.health;
    const originalSpeak = service.speak;
    service.health = async () => { await healthGate; return originalHealth(); };
    service.speak = async (text, voice, speed) => { const result = await originalSpeak(text, voice, speed); await speechGate; return result; };
    const ctx = await makeApp(keys, { speech: service });
    cleanups.push(() => ctx.app.close());
    const requests = Array.from({ length: 6 }, () => ctx.app.inject({ method: 'POST', url: '/api/voice/speak', headers: postHeaders(token), payload: { text: 'Demo.' } }));
    healthReady();
    await expect.poll(() => calls.length).toBe(4);
    speechReady();
    const responses = await Promise.all(requests);
    expect(responses.map(res => res.statusCode).sort()).toEqual([200, 200, 200, 200, 429, 429]);
  });
});
