import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { credential, ElevenLabs, type CloudTransport } from '../../speech/cloud-api.js';
import { CloudSpeechError, type CloudSpeechService } from '../src/cloud-speech.js';
import { readAloud, type SpeechService } from '../src/speech.js';
import { apiHeaders, makeApp, makeKeys, makeToken, PHONE_COOKIE, postHeaders, TEST_DESKTOP, type Keys } from './helpers.js';
import type { AppVoice, CloudVoices, SpeechFrame } from '../../shared/voice.js';

const choice: AppVoice = { provider: 'elevenlabs', voiceId: 'fake-voice', modelId: 'fake-model' };
const catalog: CloudVoices = { voices: [{ id: 'fake-voice', name: 'Demo', category: 'cloned', preview: true }], models: [{ id: 'fake-model', name: 'Demo model' }] };
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { vi.useRealTimers(); while (cleanups.length) await cleanups.pop()!(); });
let keys: Keys;
let token: string;
beforeAll(async () => { keys = await makeKeys(); token = await makeToken(keys); });
function local(): SpeechService {
  return { health: async () => ({ voices: ['af_heart', 'bm_george'], defaultVoice: 'af_heart' }), transcribe: async () => ({ text: '', ms: 0 }), speak: vi.fn(async () => Buffer.alloc(64)) };
}
function cloud(load = async () => catalog): CloudSpeechService {
  return { catalog: vi.fn(load), synthesize: async function* () { yield Buffer.alloc(6000); } };
}
async function collect(source: AsyncIterable<SpeechFrame>) { const frames: SpeechFrame[] = []; for await (const frame of source) frames.push(frame); return frames; }

it('status and local saves never load the catalog, including phones', async () => {
  const remote = cloud(async () => { throw new Error('unexpected catalog'); });
  const ctx = await makeApp(keys, { speech: local(), cloudSpeech: remote });
  cleanups.push(() => ctx.app.close());
  for (const cookie of [undefined, PHONE_COOKIE]) {
    const response = await ctx.app.inject({ url: '/api/voice', headers: apiHeaders(token, cookie ? { cookie } : {}) });
    expect(response.json()).toMatchObject({ available: true, defaultVoice: 'af_heart' });
  }
  const saved = await ctx.app.inject({ method: 'PUT', url: '/api/voice', headers: postHeaders(token), payload: { voice: 'bm_george' } });
  expect(saved.json()).toMatchObject({ available: true, defaultVoice: 'bm_george' });
  expect(remote.catalog).not.toHaveBeenCalled();
});

it('only a live paired desktop can deliberately load the picker, with cached success and failure', async () => {
  const remote = cloud();
  const ctx = await makeApp(keys, { speech: local(), cloudSpeech: remote });
  cleanups.push(() => ctx.app.close());
  expect((await ctx.app.inject({ url: '/api/voice/catalog', headers: apiHeaders(token, { cookie: PHONE_COOKIE }) })).statusCode).toBe(403);
  const get = () => ctx.app.inject({ url: '/api/voice/catalog', headers: apiHeaders(token) });
  expect((await get()).json()).toMatchObject({ available: true, ...catalog });
  expect((await get()).json()).toMatchObject({ available: true });
  expect(remote.catalog).toHaveBeenCalledTimes(1);
  const failed = cloud(async () => { throw new CloudSpeechError('unreachable'); });
  const other = await makeApp(keys, { speech: local(), cloudSpeech: failed });
  cleanups.push(() => other.app.close());
  for (let i = 0; i < 2; i++) expect((await other.app.inject({ url: '/api/voice/catalog', headers: apiHeaders(token) })).json()).toMatchObject({ available: false, error: 'unreachable' });
  expect(failed.catalog).toHaveBeenCalledTimes(1);
});

it('a hung picker is bounded and cannot block local status', async () => {
  const remote = cloud(() => new Promise(() => {}));
  const ctx = await makeApp(keys, { speech: local(), cloudSpeech: remote });
  cleanups.push(() => ctx.app.close());
  const pending = ctx.app.inject({ url: '/api/voice/catalog', headers: apiHeaders(token) }).then(response => response.json());
  await expect.poll(() => vi.mocked(remote.catalog).mock.calls.length).toBe(1);
  const status = await ctx.app.inject({ url: '/api/voice', headers: apiHeaders(token) });
  expect(status.json().available).toBe(true);
  expect(await pending).toMatchObject({ available: false, error: 'timeout' });
}, 4000);

it('revocation during catalog validation prevents either setting from being written', async () => {
  let release!: (value: CloudVoices) => void;
  const remote = cloud();
  vi.mocked(remote.catalog).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const ctx = await makeApp(keys, { speech: local(), cloudSpeech: remote });
  cleanups.push(() => ctx.app.close());
  const saving = ctx.app.inject({ method: 'PUT', url: '/api/voice', headers: postHeaders(token), payload: { voice: 'bm_george', appReadAloud: choice } }).then(response => response);
  await expect.poll(() => !!release).toBe(true);
  ctx.devices!.revoke(TEST_DESKTOP.id);
  release(catalog);
  expect((await saving).statusCode).toBe(403);
  expect((await ctx.app.inject({ url: '/api/voice', headers: apiHeaders(token, { cookie: PHONE_COOKIE }) })).json()).toMatchObject({ defaultVoice: 'af_heart', appReadAloud: { provider: 'local' } });
});

it.each(['auth', 'quota', 'rate-limit', 'unreachable', 'timeout', 'failed'] as const)('remembers %s failures, reads later pieces locally, and retries after cooldown', async code => {
  vi.useFakeTimers();
  const speech = local();
  const synthesize = vi.fn(async function* () { throw new CloudSpeechError(code); });
  const remote = { catalog: async () => catalog, synthesize };
  expect((await collect(readAloud(speech, remote, choice, 'One.', 'af_heart', 1)))[0]).toMatchObject({ provider: 'local', reason: code });
  expect((await collect(readAloud(speech, remote, choice, 'Two.', 'af_heart', 1)))[0]).toMatchObject({ provider: 'local', reason: code });
  expect(synthesize).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(code === 'auth' || code === 'quota' ? 300_001 : 60_001);
  await collect(readAloud(speech, remote, choice, 'Three.', 'af_heart', 1));
  expect(synthesize).toHaveBeenCalledTimes(2);
});

it('bounds first audio even when a cloud iterator never yields and aborts it', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const remote: CloudSpeechService = { catalog: async () => catalog, synthesize: (_text, _choice, _format, cancellation) => {
    signal = cancellation;
    return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
  } };
  const result = collect(readAloud(local(), remote, choice, 'Demo.', 'af_heart', 1));
  await vi.advanceTimersByTimeAsync(2001);
  expect((await result)[0]).toMatchObject({ provider: 'local', reason: 'timeout' });
  expect(signal?.aborted).toBe(true);
});

it('rejects non-ASCII credentials and normalizes a synchronous header failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wayroost-cloud-voice-guards-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const suffix of ['\u200b', '\u201c', '\u00e9', '\tbad']) {
    writeFileSync(join(dir, 'elevenlabs-api-key'), `obviously-fake-key${suffix}`);
    expect(() => credential({ CREDENTIALS_DIRECTORY: dir })).toThrow('Cloud voice: auth');
  }
  const transport: CloudTransport = () => { throw new TypeError('invalid header'); };
  await expect(new ElevenLabs('obviously-fake-key', transport).catalog()).rejects.toMatchObject({ code: 'auth' });
});

it('bounds DNS and connection setup independently of the total stream budget', async () => {
  vi.useFakeTimers();
  let req: ReturnType<typeof request> | undefined;
  const transport: CloudTransport = (_url, options, receive) => {
    req = request({ ...options, host: 'never-resolved.invalid', lookup: () => {} }, receive);
    return req;
  };
  const pending = new ElevenLabs('obviously-fake-key', transport).catalog();
  const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
  await vi.advanceTimersByTimeAsync(2001);
  await assertion;
  expect(req?.destroyed).toBe(true);
});

it('releases streaming capacity after disconnects during health checks', async () => {
  const speech = local();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let checks = 0;
  speech.health = async () => { checks++; await gate; return { voices: ['af_heart'], defaultVoice: 'af_heart' }; };
  const ctx = await makeApp(keys, { speech });
  cleanups.push(() => ctx.app.close());
  const dir = mkdtempSync(join(tmpdir(), 'voice-disconnect-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, 'app.sock');
  await ctx.app.listen({ path: socketPath });
  for (let i = 0; i < 4; i++) {
    const req = request({ socketPath, path: '/api/voice/speak', method: 'POST', headers: postHeaders(token) });
    req.on('error', () => {});
    req.end(JSON.stringify({ text: 'Demo.', stream: true }));
    await expect.poll(() => checks).toBe(i + 1);
    const closed = new Promise<void>(resolve => req.once('close', resolve));
    req.destroy();
    await closed;
  }
  release();
  await new Promise(resolve => setTimeout(resolve, 30));
  const next = await ctx.app.inject({ method: 'POST', url: '/api/voice/speak', headers: postHeaders(token), payload: { text: 'Still available.', stream: true } });
  expect(next.statusCode).toBe(200);
  expect(speech.speak).toHaveBeenCalledTimes(1);
});

it('pins local sealing and cloud isolation without relying on the current git commit', () => {
  const unit = (name: string) => readFileSync(new URL(`../../deploy/${name}`, import.meta.url), 'utf8');
  const localUnit = unit('signalbox-speech.service');
  for (const line of ['PrivateNetwork=yes', 'IPAddressDeny=any', 'RestrictAddressFamilies=AF_UNIX', 'RootDirectory=/opt/signalbox-speech/root']) expect(localUnit.split('\n')).toContain(line);
  for (const line of ['SocketMode=0660', 'SocketGroup=signalbox-voice']) expect(unit('signalbox-speech.socket').split('\n')).toContain(line);
  const cloudUnit = unit('wayroost-voice-cloud.service');
  expect(cloudUnit.split('\n')).toContain('Group=wayroost-voice-cloud');
  expect(cloudUnit).toMatch(/^IPAddressDeny=.*localhost.*link-local/m);
  expect(cloudUnit).toMatch(/^IPAddressAllow=127\.0\.0\.53$/m);
  expect(cloudUnit).toMatch(/^InaccessiblePaths=.*-\/mnt.*-\/run\/wayroost .*-/m);
});
