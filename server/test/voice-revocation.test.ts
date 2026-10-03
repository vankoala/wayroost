import { beforeAll, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';

import type { SpeechService } from '../src/speech.js';
import type { CloudSpeechService } from '../src/cloud-speech.js';
import { makeApp, makeKeys, makeToken, postHeaders, TEST_DESKTOP, type Keys } from './helpers.js';

let keys: Keys;
let token: string;
beforeAll(async () => { keys = await makeKeys(); token = await makeToken(keys); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const health = { voices: ['af_heart'], defaultVoice: 'af_heart' };
const catalog = { voices: [{ id: 'fake-voice', name: 'Demo voice', category: 'cloned', preview: false }], models: [{ id: 'fake-model', name: 'Demo model' }] };
const choice = { provider: 'elevenlabs' as const, voiceId: 'fake-voice', modelId: 'fake-model' };

describe('speech belongs to the live paired device', () => {
  it('rechecks pairing after local health before requesting the cloud catalog for a setting', async () => {
    const entered = deferred(); const ready = deferred();
    const catalogRequest = vi.fn(async () => catalog);
    const speech: SpeechService = { health: async () => { entered.resolve(); await ready.promise; return health; },
      transcribe: async () => ({ text: '', ms: 0 }), speak: async () => Buffer.from('RIFFdemo') };
    const { app, devices } = await makeApp(keys, { speech, cloudSpeech: { catalog: catalogRequest, synthesize: async function* () {} } });
    try {
      const device = devices!.add('Demo desktop', 'desktop');
      const pending = Promise.resolve(app.inject({ method: 'PUT', url: '/api/voice',
        headers: postHeaders(token, { cookie: `wr_device=${device.cookie}` }), payload: { voice: 'af_heart', appReadAloud: choice } }));
      await entered.promise; devices!.revoke(device.device.id); ready.resolve();
      expect((await pending).statusCode).toBe(403); expect(catalogRequest).not.toHaveBeenCalled();
    } finally { ready.resolve(); await app.close(); }
  });

  it.each([false, true])('refuses revocation during health before synthesis (stream %s)', async stream => {
    const entered = deferred(); const ready = deferred(); let waiting = false;
    const speak = vi.fn(async () => Buffer.from('RIFFdemo'));
    const speech: SpeechService = { health: async () => { if (waiting) { entered.resolve(); await ready.promise; } return health; },
      transcribe: async () => ({ text: '', ms: 0 }), speak };
    const synthesize = vi.fn(async function* () { yield Buffer.alloc(6000); });
    const cloudSpeech: CloudSpeechService = { catalog: async () => catalog, synthesize };
    const { app, devices } = await makeApp(keys, { speech, cloudSpeech });
    try {
      expect((await app.inject({ method: 'PUT', url: '/api/voice', headers: postHeaders(token), payload: { appReadAloud: choice } })).statusCode).toBe(200);
      const device = devices!.add('Demo desktop', 'desktop');
      waiting = true;
      const pending = app.inject({ method: 'POST', url: '/api/voice/speak',
        headers: postHeaders(token, { cookie: `wr_device=${device.cookie}` }), payload: { text: 'Demo text.', stream } });
      const response = Promise.resolve(pending);
      await entered.promise;
      devices!.revoke(device.device.id); ready.resolve();
      expect((await response).statusCode).toBe(403);
      expect(synthesize).not.toHaveBeenCalled(); expect(speak).not.toHaveBeenCalled();
    } finally { ready.resolve(); await app.close(); }
  });

  it.each([false, true].flatMap(stream => [false, true].map(later => ({ stream, later }))))('aborts cloud synthesis during each audio await without fallback (stream $stream, later $later)', async ({ stream, later }) => {
    const entered = deferred(); const finish = deferred(); let signal: AbortSignal | undefined;
    const speak = vi.fn(async () => Buffer.from('RIFFdemo'));
    const speech: SpeechService = { health: async () => health, transcribe: async () => ({ text: '', ms: 0 }), speak };
    const cloudSpeech: CloudSpeechService = { catalog: async () => catalog,
      synthesize: async function* (_text, _choice, _format, owner) {
        signal = owner;
        if (later) yield Buffer.alloc(6000);
        entered.resolve();
        await Promise.race([finish.promise, new Promise<void>(resolve => owner!.addEventListener('abort', () => resolve(), { once: true }))]);
        throw new Error('Demo revoked');
      } };
    const { app, devices } = await makeApp(keys, { speech, cloudSpeech });
    try {
      expect((await app.inject({ method: 'PUT', url: '/api/voice', headers: postHeaders(token), payload: { appReadAloud: choice } })).statusCode).toBe(200);
      const device = devices!.add('Demo desktop', 'desktop');
      await app.listen({ host: '127.0.0.1', port: 8894 });
      const pending = new Promise<void>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: 8894, path: '/api/voice/speak', method: 'POST',
          headers: postHeaders(token, { cookie: `wr_device=${device.cookie}` }) }, res => {
          res.on('error', reject); res.on('end', resolve); res.resume();
        });
        req.on('error', reject); req.end(JSON.stringify({ text: 'Demo text.', stream }));
      });
      const response = pending.catch(() => undefined);
      await entered.promise; devices!.revoke(device.device.id);
      expect(signal?.aborted).toBe(true);
      await response;
      expect(speak).not.toHaveBeenCalled();
    } finally { finish.resolve(); await app.close(); }
  });

  it.each([false, true])('passes cancellation to active local synthesis (stream %s)', async stream => {
    const entered = deferred(); const finish = deferred(); let signal: AbortSignal | undefined;
    const speech: SpeechService = { health: async () => health, transcribe: async () => ({ text: '', ms: 0 }),
      speak: async (_text, _voice, _speed, owner) => {
        signal = owner; entered.resolve();
        await Promise.race([finish.promise, new Promise<void>(resolve => owner!.addEventListener('abort', () => resolve(), { once: true }))]);
        return Buffer.from('RIFFdemo');
      } };
    const { app, devices } = await makeApp(keys, { speech });
    try {
      await app.listen({ host: '127.0.0.1', port: 8894 });
      const pending = new Promise<void>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: 8894, path: '/api/voice/speak', method: 'POST', headers: postHeaders(token) }, res => {
          res.on('error', reject); res.on('end', resolve); res.resume();
        });
        req.on('error', reject); req.end(JSON.stringify({ text: 'Demo text.', stream }));
      });
      const response = pending.catch(() => undefined);
      await entered.promise; devices!.revoke(TEST_DESKTOP.id);
      expect(signal?.aborted).toBe(true);
      await response;
    } finally { finish.resolve(); await app.close(); }
  });

});
