import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { VOICE_MAX_SECONDS, VOICE_SAMPLE_RATE, type ServerEvent, type VoiceEvent } from '../../shared/protocol.js';
import { SpeechClient, VoiceSession, type SpeechService } from '../src/speech.js';
import { UserFacingError } from '../src/sources.js';
import { VoiceSetting } from '../src/voice-setting.js';
import { ORIGIN, apiHeaders, makeApp, makeKeys, makeToken, postHeaders, type Keys } from './helpers.js';

const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60, 1)]);

class FakeSpeech implements SpeechService {
  transcribed: Buffer[] = [];
  spoken: Array<{ text: string; voice: string; speed: number }> = [];
  down = false;
  transcribeError: UserFacingError | null = null;
  async health() {
    if (this.down) throw new UserFacingError('down', 503);
    return { voices: ['af_heart', 'bm_george'], defaultVoice: 'af_heart' };
  }
  async transcribe(pcm: Buffer) {
    if (this.transcribeError) throw this.transcribeError;
    this.transcribed.push(pcm);
    return { text: `heard ${pcm.length} bytes`, ms: 12 };
  }
  async speak(text: string, voice: string, speed: number) {
    this.spoken.push({ text, voice, speed });
    return WAV;
  }
}

/** A run's audio frame: its number, then PCM. */
const frame = (run: number, audio: Buffer = Buffer.alloc(0)) => Buffer.concat([Buffer.from([run]), audio]);
const audio = (bytes: number, fill = 1) => Buffer.alloc(bytes, fill);
const QUARTER_SECOND = VOICE_SAMPLE_RATE / 2;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('VoiceSession', () => {
  function session(speech: SpeechService = new FakeSpeech(), idleMs?: number) {
    const events: VoiceEvent[] = [];
    const voice = new VoiceSession(speech, (event) => events.push(event), idleMs);
    cleanups.push(async () => voice.close());
    return { voice, events };
  }

  it('collects a run in order and writes it down when the run number arrives alone', async () => {
    const speech = new FakeSpeech();
    const { voice, events } = session(speech);
    voice.start(7);
    voice.frame(frame(7, audio(6000, 1)));
    voice.frame(frame(7, audio(4000, 2)));
    voice.frame(frame(7));
    await expect.poll(() => events.length).toBe(2);
    expect(events).toEqual([
      { type: 'voice', run: 7, stage: 'stt-start' },
      { type: 'voice', run: 7, stage: 'stt-end', text: 'heard 10000 bytes', ms: 12 },
    ]);
    expect(speech.transcribed[0]).toEqual(Buffer.concat([audio(6000, 1), audio(4000, 2)]));
  });

  it('ignores frames from other runs, after a cancel, and with half a sample', async () => {
    const speech = new FakeSpeech();
    const { voice, events } = session(speech);
    voice.frame(frame(1, audio(QUARTER_SECOND))); // no run started
    voice.start(1);
    voice.frame(frame(2, audio(QUARTER_SECOND)));
    voice.frame(frame(1, audio(QUARTER_SECOND + 1)));
    voice.frame(Buffer.alloc(0));
    voice.cancel(1);
    voice.frame(frame(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([]);
    expect(speech.transcribed).toEqual([]);
  });

  it('a new run replaces one still recording', async () => {
    const speech = new FakeSpeech();
    const { voice, events } = session(speech);
    voice.start(1);
    voice.frame(frame(1, audio(QUARTER_SECOND)));
    voice.start(2);
    voice.frame(frame(1)); // the old run's end is stale now
    voice.frame(frame(2, audio(QUARTER_SECOND)));
    voice.frame(frame(2));
    await expect.poll(() => events.length).toBe(2);
    expect(events.map((e) => e.run)).toEqual([2, 2]);
  });

  it("doesn't bother the speech service with a blip", async () => {
    const speech = new FakeSpeech();
    const { voice, events } = session(speech);
    voice.start(3);
    voice.frame(frame(3, audio(QUARTER_SECOND - 2)));
    voice.frame(frame(3));
    expect(events).toEqual([
      { type: 'voice', run: 3, stage: 'stt-start' },
      { type: 'voice', run: 3, stage: 'stt-end', text: '', ms: 0 },
    ]);
    expect(speech.transcribed).toEqual([]);
  });

  it('stops a run that goes on too long', () => {
    const { voice, events } = session();
    voice.start(4);
    voice.frame(frame(4, audio(VOICE_SAMPLE_RATE * 2 * VOICE_MAX_SECONDS)));
    expect(events).toEqual([]);
    voice.frame(frame(4, audio(2)));
    expect(events).toMatchObject([{ run: 4, stage: 'error', code: 'too-long' }]);
    voice.frame(frame(4)); // gone
    expect(events).toHaveLength(1);
  });

  it('drops a run whose audio stops arriving', async () => {
    const { voice, events } = session(new FakeSpeech(), 30);
    voice.start(5);
    voice.frame(frame(5, audio(QUARTER_SECOND)));
    await expect.poll(() => events).toMatchObject([{ run: 5, stage: 'error', code: 'timeout' }]);
  });

  it('says whether the speech service is down or the transcription failed', async () => {
    const speech = new FakeSpeech();
    const { voice, events } = session(speech);
    speech.transcribeError = new UserFacingError('nope', 503);
    voice.start(1);
    voice.frame(frame(1, audio(QUARTER_SECOND)));
    voice.frame(frame(1));
    await expect.poll(() => events.at(-1)).toMatchObject({ run: 1, stage: 'error', code: 'unavailable' });
    speech.transcribeError = new UserFacingError('bad', 502);
    voice.start(2);
    voice.frame(frame(2, audio(QUARTER_SECOND)));
    voice.frame(frame(2));
    await expect.poll(() => events.at(-1)).toMatchObject({ run: 2, stage: 'error', code: 'failed' });
  });

  it('refuses a third recording while two are still being written down', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const speech = new FakeSpeech();
    const transcribe = speech.transcribe.bind(speech);
    speech.transcribe = async (pcm: Buffer) => {
      await gate;
      return transcribe(pcm);
    };
    const { voice, events } = session(speech);
    for (const run of [1, 2, 3]) {
      voice.start(run);
      voice.frame(frame(run, audio(QUARTER_SECOND)));
      voice.frame(frame(run));
    }
    expect(events.filter((e) => e.stage === 'error')).toMatchObject([{ run: 3, code: 'busy' }]);
    release();
    await expect.poll(() => events.filter((e) => e.stage === 'stt-end').map((e) => e.run)).toEqual([1, 2]);
    // Room again once they're done.
    voice.start(4);
    voice.frame(frame(4, audio(QUARTER_SECOND)));
    voice.frame(frame(4));
    await expect.poll(() => events.at(-1)).toMatchObject({ run: 4, stage: 'stt-end' });
  });

  it('sends nothing once closed', async () => {
    const speech = new FakeSpeech();
    const { voice, events } = session(speech);
    voice.start(1);
    voice.frame(frame(1, audio(QUARTER_SECOND)));
    voice.close();
    voice.frame(frame(1));
    voice.start(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([]);
  });
});

describe('SpeechClient', () => {
  async function service(handler: (req: IncomingMessage, body: Buffer, res: ServerResponse) => void) {
    const path = join(mkdtempSync(join(tmpdir(), 'sb-speech-')), 's.sock');
    const calls: string[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        calls.push(`${req.method} ${req.url}`);
        handler(req, Buffer.concat(chunks), res);
      });
    });
    server.listen(path);
    await once(server, 'listening');
    cleanups.push(() => new Promise((r) => server.close(r)));
    return { client: new SpeechClient(path), calls };
  }

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  it('asks for health once in a while, and sends audio and text the way the service expects', async () => {
    const seen: Array<{ type: string | undefined; body: Buffer }> = [];
    const { client, calls } = await service((req, body, res) => {
      seen.push({ type: req.headers['content-type'], body });
      if (req.url === '/health') return json(res, 200, { ok: true, voices: ['af_heart', 3], defaultVoice: 'af_heart' });
      if (req.url === '/stt') return json(res, 200, { text: 'hello there', ms: 40 });
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(WAV);
    });
    expect(await client.health()).toEqual({ voices: ['af_heart'], defaultVoice: 'af_heart' });
    await client.health();
    expect(calls).toEqual(['GET /health']);

    const pcm = audio(QUARTER_SECOND, 9);
    expect(await client.transcribe(pcm)).toEqual({ text: 'hello there', ms: 40 });
    expect(seen[1]).toEqual({ type: 'application/octet-stream', body: pcm });

    expect(await client.speak('Hi.', 'bm_george', 1.25)).toEqual(WAV);
    expect(seen[2]!.type).toBe('application/json');
    expect(JSON.parse(seen[2]!.body.toString())).toEqual({ text: 'Hi.', voice: 'bm_george', speed: 1.25 });
  });

  it("passes on the service's short refusals, and never echoes anything else", async () => {
    const { client } = await service((req, _body, res) => {
      if (req.url === '/tts') return json(res, 400, { error: 'unknown voice' });
      if (req.url === '/stt') return json(res, 500, { error: 'x'.repeat(500) });
      json(res, 200, { ok: false });
    });
    await expect(client.speak('Hi.', 'af_heart', 1)).rejects.toMatchObject({ message: 'unknown voice', status: 400 });
    await expect(client.transcribe(audio(QUARTER_SECOND))).rejects.toMatchObject({
      message: "Couldn't write down what you said.",
      status: 502,
    });
    await expect(client.health()).rejects.toMatchObject({ status: 503 });
  });

  it('refuses audio that is not audio', async () => {
    const { client } = await service((_req, _body, res) => json(res, 200, { ok: true }));
    await expect(client.speak('Hi.', 'af_heart', 1)).rejects.toMatchObject({ status: 502 });
  });

  it('says voice is unavailable when nothing answers', async () => {
    const client = new SpeechClient(join(mkdtempSync(join(tmpdir(), 'sb-speech-')), 'missing.sock'));
    await expect(client.health()).rejects.toMatchObject({ status: 503 });
    await expect(client.transcribe(audio(QUARTER_SECOND))).rejects.toMatchObject({ status: 503 });
  });
});

describe('voice mode in the app', () => {
  let keys: Keys;
  let token: string;
  beforeAll(async () => {
    keys = await makeKeys();
    token = await makeToken(keys);
  });

  async function setup(speech?: SpeechService) {
    const ctx = await makeApp(keys, speech ? { speech } : {});
    cleanups.push(() => ctx.app.close());
    return ctx;
  }

  it('lets the page use the microphone only when voice mode is on', async () => {
    const off = await setup();
    const offHeader = (await off.app.inject({ url: '/api/me', headers: apiHeaders(token) })).headers['permissions-policy'];
    expect(offHeader).toContain('microphone=()');
    const on = await setup(new FakeSpeech());
    const onHeader = (await on.app.inject({ url: '/api/me', headers: apiHeaders(token) })).headers['permissions-policy'];
    expect(onHeader).toContain('microphone=(self)');
    expect(onHeader).toContain('camera=()');
  });

  it('reports whether voice is on and the speech service answers', async () => {
    const get = async (app: Awaited<ReturnType<typeof setup>>['app']) =>
      (await app.inject({ url: '/api/voice', headers: apiHeaders(token) })).json();
    expect(await get((await setup()).app)).toEqual({ enabled: false, available: false, voices: [], defaultVoice: '' });
    const speech = new FakeSpeech();
    const { app } = await setup(speech);
    expect(await get(app)).toEqual({ enabled: true, available: true, voices: ['af_heart', 'bm_george'], defaultVoice: 'af_heart' });
    speech.down = true;
    expect(await get(app)).toEqual({ enabled: true, available: false, voices: [], defaultVoice: '' });
  });

  it('reads text aloud with a known voice, under the usual API rules', async () => {
    const speech = new FakeSpeech();
    const { app } = await setup(speech);
    const speak = (body: unknown, headers = postHeaders(token)) =>
      app.inject({ method: 'POST', url: '/api/voice/speak', headers, payload: JSON.stringify(body) });

    const res = await speak({ text: '  Hello there.  ', voice: 'bm_george', speed: 1.1 });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.rawPayload).toEqual(WAV);
    // An unknown voice falls back to the default rather than failing.
    await speak({ text: 'Hi.', voice: 'am_adam' });
    expect(speech.spoken).toEqual([
      { text: 'Hello there.', voice: 'bm_george', speed: 1.1 },
      { text: 'Hi.', voice: 'af_heart', speed: 1 },
    ]);

    for (const bad of [{ text: '' }, { text: 'x'.repeat(1001) }, { text: 'Hi.', voice: '../x' }, { text: 'Hi.', speed: 9 }, { text: 'Hi.', extra: 1 }]) {
      expect((await speak(bad)).statusCode).toBe(400);
    }
    expect((await speak({ text: 'Hi.' }, { ...postHeaders(token), 'x-signalbox-request': '' })).statusCode).toBe(403);
    expect(speech.spoken).toHaveLength(2);
  });

  it('keeps one voice for every device and hands it to the phone line', async () => {
    const speech = new FakeSpeech();
    const phoneVoices: string[] = [];
    let phoneDown = false;
    const phone = {
      phone: async () => ({ running: true, ok: true, pinSet: false }),
      phonePin: async () => ({ pin: null }),
      setPhonePin: async () => ({ running: true, ok: true, pinSet: true }),
      setPhoneVoice: async (voice: string) => {
        if (phoneDown) throw new UserFacingError("Hermes Phone isn't running.", 503);
        phoneVoices.push(voice);
        return { voice };
      },
    };
    const ctx = await makeApp(keys, { speech, phone });
    cleanups.push(() => ctx.app.close());
    const { app } = ctx;
    const put = (body: unknown, headers = postHeaders(token)) =>
      app.inject({ method: 'PUT', url: '/api/voice', headers, payload: JSON.stringify(body) });
    const get = async () => (await app.inject({ url: '/api/voice', headers: apiHeaders(token) })).json();

    const res = await put({ voice: 'bm_george' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ defaultVoice: 'bm_george', calls: 'updated' });
    expect(phoneVoices).toEqual(['bm_george']);
    // Every device now sees it, and reads in it when it names no voice.
    expect((await get()).defaultVoice).toBe('bm_george');
    await app.inject({ method: 'POST', url: '/api/voice/speak', headers: postHeaders(token), payload: '{"text":"Hi."}' });
    expect(speech.spoken.at(-1)).toEqual({ text: 'Hi.', voice: 'bm_george', speed: 1 });
    // A preview can still name another voice without changing the shared one.
    await app.inject({ method: 'POST', url: '/api/voice/speak', headers: postHeaders(token), payload: '{"text":"Hi.","voice":"af_heart"}' });
    expect(speech.spoken.at(-1)?.voice).toBe('af_heart');
    expect((await get()).defaultVoice).toBe('bm_george');

    // The phone line down: saved for Signalbox anyway, and the page is told calls didn't change.
    phoneDown = true;
    expect((await put({ voice: 'af_heart' })).json()).toMatchObject({ defaultVoice: 'af_heart', calls: 'failed', callsMessage: "Hermes Phone isn't running." });

    for (const bad of [{ voice: 'zz_nope' }, { voice: '../x' }, {}, { voice: 'af_heart', extra: 1 }]) {
      expect((await put(bad)).statusCode).toBe(400);
    }
    expect((await put({ voice: 'bm_george' }, { ...postHeaders(token), 'x-signalbox-request': '' })).statusCode).toBe(403);
    expect((await get()).defaultVoice).toBe('af_heart');
  });

  it('saves the voice without a phone line, and says so', async () => {
    const { app } = await setup(new FakeSpeech());
    const res = await app.inject({ method: 'PUT', url: '/api/voice', headers: postHeaders(token), payload: '{"voice":"bm_george"}' });
    expect(res.json()).toMatchObject({ defaultVoice: 'bm_george', calls: 'off' });
  });

  it('keeps the shared voice across restarts, and ignores a damaged file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-voice-'));
    expect(new VoiceSetting(dir).voice()).toBe('');
    new VoiceSetting(dir).setVoice('bm_george');
    expect(new VoiceSetting(dir).voice()).toBe('bm_george');
    writeFileSync(join(dir, 'voice.json'), '{"voice":"../etc"}');
    expect(new VoiceSetting(dir).voice()).toBe('');
  });

  it("says voice mode is off when it isn't set up", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/voice/speak', headers: postHeaders(token), payload: '{"text":"Hi."}' });
    expect(res.statusCode).toBe(404);
  });

  async function open(url: string) {
    const ws = new WebSocket(url, { headers: { origin: ORIGIN, 'cf-access-jwt-assertion': token } });
    ws.on('error', () => {});
    cleanups.push(async () => ws.terminate());
    const received: ServerEvent[] = [];
    ws.on('message', (data, isBinary) => {
      if (!isBinary) received.push(JSON.parse(String(data)) as ServerEvent);
    });
    await once(ws, 'open');
    await expect.poll(() => received[0]?.type).toBe('hello');
    return { ws, received };
  }

  async function listen(speech?: SpeechService) {
    const ctx = await setup(speech);
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (ctx.app.server.address() as { port: number }).port;
    ctx.config.allowedHosts.add(`127.0.0.1:${port}`);
    const url = `ws://127.0.0.1:${port}/ws`;
    return { ...(await open(url)), url };
  }

  it('writes down audio sent over the live socket and answers only that socket', async () => {
    const speech = new FakeSpeech();
    const { ws, received } = await listen(speech);
    ws.send(JSON.stringify({ type: 'voice_start', run: 9 }));
    ws.send(frame(9, audio(4800, 5)));
    ws.send(frame(9, audio(4800, 6)));
    ws.send(frame(9));
    await expect.poll(() => received.filter((e) => e.type === 'voice')).toEqual([
      { type: 'voice', run: 9, stage: 'stt-start' },
      { type: 'voice', run: 9, stage: 'stt-end', text: 'heard 9600 bytes', ms: 12 },
    ]);
    expect(speech.transcribed[0]).toEqual(Buffer.concat([audio(4800, 5), audio(4800, 6)]));
  });

  it('never sends what you said to another open page', async () => {
    const speech = new FakeSpeech();
    const { ws, received, url } = await listen(speech);
    const other = await open(url);
    // The other page records too, with the same run number: still only its own audio counts.
    other.ws.send(JSON.stringify({ type: 'voice_start', run: 5 }));
    ws.send(JSON.stringify({ type: 'voice_start', run: 5 }));
    ws.send(frame(5, audio(4800, 7)));
    ws.send(frame(5, audio(4800, 7)));
    ws.send(frame(5));
    await expect.poll(() => received.filter((e) => e.type === 'voice').length).toBe(2);
    other.ws.send(JSON.stringify({ type: 'ping' }));
    await expect.poll(() => other.received.at(-1)?.type).toBe('pong');
    expect(other.received.some((e) => e.type === 'voice')).toBe(false);
    expect(speech.transcribed).toHaveLength(1);
  });

  it('ignores audio when voice mode is off', async () => {
    const { ws, received } = await listen();
    ws.send(JSON.stringify({ type: 'voice_start', run: 1 }));
    ws.send(frame(1, audio(QUARTER_SECOND)));
    ws.send(frame(1));
    ws.send(JSON.stringify({ type: 'ping' }));
    await expect.poll(() => received.at(-1)?.type).toBe('pong');
    expect(received.some((e) => e.type === 'voice')).toBe(false);
  });
});
