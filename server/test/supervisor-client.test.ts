import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SUPERVISOR_ROUTES } from '../../shared/supervisor.js';
import type { SupervisorEvent, SupervisorStatus } from '../../shared/supervisor.js';
import type { ConversationStatus, ConversationSummary } from '../../shared/protocol.js';
import type { Logger } from '../src/hermes/adapter.js';
import { UserFacingError } from '../src/sources.js';
import { SupervisorClient } from '../src/supervisor-client.js';
import { BusyReporter, countBusy } from '../src/busy.js';
import { actionSummary, demoStatus, mainModel } from './fake-supervisor.js';

// The real client against a stub supervisor on a Unix socket, speaking the
// contract in shared/supervisor.ts: Bearer key on every call, JSON on the plain
// routes, server-sent events on /v1/events. Nothing here binds a port.

/** 256-bit random, stored as hex — the shape a systemd credential arrives in. */
const KEY = randomBytes(32).toString('hex');
const OTHER = randomBytes(32).toString('hex');

const quiet: Logger = { info() {}, warn() {}, error() {} };

function captureLog() {
  const lines: string[] = [];
  const capture = (level: string) => (obj: object, msg?: string) => void lines.push(JSON.stringify({ level, msg, ...obj }));
  return { lines, log: { info: capture('info'), warn: capture('warn'), error: capture('error') } as Logger };
}

interface Stub {
  socket: string;
  keyFile: string;
  /** Every request the supervisor saw: path and the authorization header. */
  seen: Array<{ method: string; path: string; authorization?: string; body?: unknown }>;
  /** Change what the stub answers. */
  set: (patch: Partial<{ status: SupervisorStatus | null; busy: unknown; key: string; action: unknown; actionId: string }>) => void;
  /** Send an event down every open event stream. */
  push(event: SupervisorEvent): void;
  /** Send an event with CRLF line endings, the way some servers write SSE. */
  pushCrlf(event: SupervisorEvent): void;
  /** Write raw text down every open stream, one piece at a time. */
  writeRaw(parts: string[]): void;
  /** Streams the supervisor has open right now, and how many it has ever had. */
  streams(): number;
  /** End every open stream the way a restarting supervisor does. */
  dropStreams(): void;
  /** Stop answering at all. */
  stopListening(): Promise<void>;
}

async function startStub(): Promise<Stub & { close(): Promise<void> }> {
  const folder = await mkdtemp(join(tmpdir(), 'wayroost-supervisor-test-'));
  const socket = join(folder, 'supervisor.sock');
  const keyFile = join(folder, 'supervisor-key');
  await writeFile(keyFile, `${KEY}\n`, { mode: 0o600 });

  const state: { status: SupervisorStatus | null; busy: unknown; key: string; action: unknown; actionId: string } = {
    status: demoStatus(),
    busy: undefined,
    key: KEY,
    action: undefined,
    actionId: 'act-socket-1',
  };
  const seen: Stub['seen'] = [];
  const streams = new Set<ServerResponse>();
  let closing = false;

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const authorization = req.headers.authorization;
    seen.push({ method: req.method ?? '', path, authorization });
    if (closing) {
      res.destroy();
      return;
    }
    if (authorization !== `Bearer ${state.key}`) {
      json(res, 401, { message: 'A valid key is required.' });
      return;
    }
    let text = '';
    req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    req.on('end', () => {
      if (text) seen.at(-1)!.body = JSON.parse(text);
      if (req.method === 'GET' && path === SUPERVISOR_ROUTES.status) {
        if (state.status === null) return json(res, 500, { message: 'Nothing answered.' });
        return json(res, 200, state.status);
      }
      if (req.method === 'GET' && path === SUPERVISOR_ROUTES.events) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        streams.add(res);
        res.on('close', () => streams.delete(res));
        if (state.status) res.write(`event: status\ndata: ${JSON.stringify({ type: 'status', status: state.status })}\n\n`);
        return;
      }
      if (req.method === 'POST' && path === SUPERVISOR_ROUTES.busy) {
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'POST' && path === SUPERVISOR_ROUTES.actions) {
        if (state.busy !== undefined) return json(res, 409, state.busy);
        return json(res, 202, { actionId: 'act-socket-1' });
      }
      if (req.method === 'GET' && path.startsWith(`${SUPERVISOR_ROUTES.actions}/`)) {
        const id = decodeURIComponent(path.slice(SUPERVISOR_ROUTES.actions.length + 1));
        if (!state.action || state.actionId !== id) return json(res, 404, { message: 'That action was not found.' });
        return json(res, 200, state.action);
      }
      return json(res, 404, { message: 'That route was not found.' });
    });
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socket, () => resolve()));

  return {
    socket,
    keyFile,
    seen,
    set: (patch) => Object.assign(state, patch),
    push: (event) => {
      const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const res of streams) res.write(frame);
    },
    pushCrlf: (event) => {
      for (const res of streams) res.write(`event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`);
    },
    writeRaw: (parts) => {
      for (const res of streams) for (const part of parts) res.write(part);
    },
    streams: () => streams.size,
    dropStreams: () => {
      for (const res of streams) res.end();
      streams.clear();
    },
    stopListening: async () => {
      closing = true;
      for (const res of streams) res.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    close: async () => {
      closing = true;
      for (const res of streams) res.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(folder, { recursive: true, force: true });
    },
  };
}

const fast = { backoffMs: { min: 20, max: 60 }, idleMs: 300 };

describe('the supervisor over its Unix socket', () => {
  let stub: Awaited<ReturnType<typeof startStub>>;
  const cleanups: Array<() => Promise<unknown>> = [];

  beforeAll(async () => {
    stub = await startStub();
  });

  afterEach(() => {
    stub.set({ status: demoStatus(), busy: undefined, key: KEY, action: undefined, actionId: 'act-socket-1' });
    stub.seen.length = 0;
  });

  afterAll(async () => {
    while (cleanups.length) await cleanups.pop()!();
    await stub.close();
  });

  /** A client pointed at the stub; streams it opens get stopped by each test. */
  function client(log: Logger = quiet, options = fast): SupervisorClient {
    return new SupervisorClient(stub.socket, stub.keyFile, log, options);
  }

  it('asks with the key from the key file and reads the snapshot back', async () => {
    const made = client();
    const status = await made.status();
    expect(status).toEqual(demoStatus());
    expect(stub.seen[0]).toMatchObject({ method: 'GET', path: SUPERVISOR_ROUTES.status, authorization: `Bearer ${KEY}` });
  });

  it('keeps what the supervisor says about parts not set up and about the PC being busy', async () => {
    // The shape The supervisor's status builder sends for a PC whose launch and coder scripts aren't configured yet.
    const unconfigured = demoStatus({
      components: [{ id: 'paseo', name: 'Agent workspace', state: 'up', sentence: 'Agent workspace is running.', busy: true, actions: ['restart'] }],
      notSetUp: [
        { id: 'main-model', name: 'Main model', sentence: 'Not set up on this PC.' },
        { id: 'coder', name: 'Coder', sentence: 'Not set up on this PC.' },
        { id: 'paseo-extra', name: 'Agent workspace (second)', sentence: 'Not set up on this PC.' },
      ],
      busy: 'unknown',
    });
    stub.set({ status: unconfigured });
    const made = client();
    expect(await made.status()).toEqual(unconfigured);

    const events: SupervisorEvent[] = [];
    const stop = made.events({ event: (event) => void events.push(event), lost() {} });
    cleanups.push(async () => stop());
    await expect.poll(() => events.length).toBe(1); // the snapshot sent on connect
    expect(events[0]).toEqual({ type: 'status', status: unconfigured });
    stop();
    await expect.poll(() => stub.streams()).toBe(0);
  });

  it('says nothing is running when the key is refused, and never logs the key', async () => {
    const { log, lines } = captureLog();
    stub.set({ key: OTHER });
    const made = new SupervisorClient(stub.socket, stub.keyFile, log, fast);
    expect(await made.status()).toBeNull();
    expect(lines.join('')).toContain('401');
    expect(lines.join('')).not.toContain(KEY);
    await expect(made.act({ verb: 'restart', target: 'paseo' })).rejects.toThrow(UserFacingError);
  });

  it('works without a supervisor at all: status is null and an action says so', async () => {
    const missing = new SupervisorClient(join(stub.socket + '-gone'), stub.keyFile, quiet, fast);
    expect(await missing.status()).toBeNull();
    const err = await missing.act({ verb: 'restart', target: 'paseo' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as UserFacingError).status).toBe(503);
    expect((err as Error).message).toMatch(/supervisor/i);
  });

  it('takes an action and returns what the supervisor recorded for it', async () => {
    stub.set({
      actionId: 'act-socket-1',
      action: {
        id: 'act-socket-1',
        verb: 'switch-model',
        target: 'main-model',
        profile: 'balanced',
        state: 'running',
        caller: 'server-key',
        startedAt: 1_700_000_000_000,
        lines: ['Main model loading…'],
      },
    });
    const made = client();
    const result = await made.act({ verb: 'switch-model', target: 'main-model', profile: 'balanced', when: 'idle' });
    expect(result).toEqual({
      id: 'act-socket-1',
      verb: 'switch-model',
      target: 'main-model',
      profile: 'balanced',
      state: 'running',
      caller: 'server-key',
      startedAt: 1_700_000_000_000,
    });
    const post = stub.seen.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({ verb: 'switch-model', target: 'main-model', profile: 'balanced', when: 'idle' });
  });

  it("answers with no start time when the action's record can't be read", async () => {
    // Accepted, but the record isn't there (404); the same goes for one that can't be read.
    stub.set({ actionId: 'act-socket-1', action: undefined });
    const made = client();
    const result = await made.act({ verb: 'restart', target: 'paseo' });
    // Not this server's clock: that could look newer than a snapshot showing the action finished.
    const guess = { id: 'act-socket-1', verb: 'restart', target: 'paseo', state: 'queued', caller: 'this app', startedAt: 0 };
    expect(result).toEqual(guess);
    stub.set({ action: { id: 'act-socket-1', state: 'not a state' } });
    expect(await made.act({ verb: 'restart', target: 'paseo' })).toEqual(guess);
  });

  it('hands a busy answer back instead of throwing, with the action that is running', async () => {
    stub.set({ busy: { error: 'busy', message: 'Another action is running. Wait until it finishes.', running: actionSummary({ verb: 'restart', target: 'coder' }, { id: 'act-socket-0', state: 'running' }) } });
    const made = client();
    const result = await made.act({ verb: 'restart', target: 'paseo' });
    expect(result).toMatchObject({ error: 'busy', running: { id: 'act-socket-0', state: 'running' } });
  });

  it('turns a plain refusal into a sentence the person can read', async () => {
    stub.set({ busy: { message: 'That component is not known.' } });
    const made = client();
    // A 409 whose body isn't a BusyError still has to say something true.
    const err = await made.act({ verb: 'restart', target: 'nonsense' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as UserFacingError).status).toBe(409);
    expect((err as Error).message).toBe('That component is not known.');
  });

  it('reads an action record when a page asks for it', async () => {
    stub.set({ actionId: 'act-socket-9', action: { id: 'act-socket-9', verb: 'restart', target: 'paseo', state: 'done', caller: 'server-key', startedAt: 1, endedAt: 2, lines: ['done'], result: 'Restarted.' } });
    const made = client();
    expect(await made.action('act-socket-9')).toMatchObject({ id: 'act-socket-9', state: 'done', lines: ['done'], result: 'Restarted.' });
    expect(await made.action('act-unknown')).toBeNull();
  });

  it('reads an action with a long history, cut the way the supervisor cuts it', async () => {
    // 700 short lines are more than 64 KiB of JSON, and one line runs past 4096 characters.
    const lines = [...Array.from({ length: 700 }, (_, n) => `Step ${n}: ${'.'.repeat(90)}`), 'x'.repeat(5_000)];
    const record = { id: 'act-socket-1', verb: 'switch-model', target: 'main-model', profile: 'balanced', state: 'running', caller: 'server-key', startedAt: 1_700_000_000_000, lines };
    expect(Buffer.byteLength(JSON.stringify(record))).toBeGreaterThan(64 * 1024);
    stub.set({ actionId: 'act-socket-1', action: record });
    const made = client();

    const detail = await made.action('act-socket-1');
    expect(detail?.state).toBe('running');
    expect(detail?.lines).toHaveLength(200); // the newest 200, as the supervisor keeps them
    expect(detail?.lines.at(-1)).toBe('x'.repeat(4_096));
    expect(detail?.lines[0]).toBe(lines[501]);

    // Taking an action reads the same record: its real state, not a guess that it's queued.
    expect(await made.act({ verb: 'switch-model', target: 'main-model', profile: 'balanced' })).toEqual({
      id: 'act-socket-1',
      verb: 'switch-model',
      target: 'main-model',
      profile: 'balanced',
      state: 'running',
      caller: 'server-key',
      startedAt: 1_700_000_000_000,
    });
  });

  it('tells an action record too big to read apart from one that is not there', async () => {
    const made = client();
    stub.set({ actionId: 'act-socket-1', action: { id: 'act-socket-1', verb: 'restart', target: 'paseo', state: 'done', caller: 'server-key', startedAt: 1, lines: ['y'.repeat(6 * 1024 * 1024)] } });
    const tooBig = await made.action('act-socket-1').catch((e: unknown) => e);
    expect(tooBig).toBeInstanceOf(UserFacingError);
    expect((tooBig as UserFacingError).status).toBe(502);

    stub.set({ action: { not: 'an action record' } });
    const odd = await made.action('act-socket-1').catch((e: unknown) => e);
    expect((odd as UserFacingError).status).toBe(502);

    expect(await made.action('act-unknown')).toBeNull(); // the supervisor's 404: no such action

    const missing = new SupervisorClient(join(stub.socket + '-gone'), stub.keyFile, quiet, fast);
    const down = await missing.action('act-socket-1').catch((e: unknown) => e);
    expect((down as UserFacingError).status).toBe(503);
  });

  it('delivers an action event that carries its whole history, and a line longer than the supervisor keeps', async () => {
    const made = client();
    const events: SupervisorEvent[] = [];
    const stop = made.events({ event: (event) => void events.push(event), lost() {} });
    cleanups.push(async () => stop());
    await expect.poll(() => events.length).toBe(1);

    // An action event with every line it printed, over 64 KiB as one frame: its completion still arrives.
    const done = actionSummary({ verb: 'restart', target: 'paseo' }, { id: 'act-socket-1', state: 'done', endedAt: 1_700_000_000_500 });
    const withHistory = { type: 'action', action: { ...done, lines: Array.from({ length: 700 }, (_, n) => `Step ${n}: ${'.'.repeat(90)}`) } } as SupervisorEvent;
    stub.push(withHistory);
    stub.push({ type: 'line', actionId: 'act-socket-1', line: 'z'.repeat(5_000) });
    await expect.poll(() => events.length).toBe(3);
    expect(events[1]).toEqual({ type: 'action', action: done });
    expect(events[2]).toEqual({ type: 'line', actionId: 'act-socket-1', line: 'z'.repeat(4_096) });
    expect(stub.streams()).toBe(1); // the same stream, never dropped
    stop();
  });

  it('pushes busy counts with its key, every few seconds, and stops on shutdown', async () => {
    const { log, lines } = captureLog();
    const made = new SupervisorClient(stub.socket, stub.keyFile, log, fast);
    expect(await made.reportBusy({ paseoRunning: 0, hermesRunning: 0, calls: 0 })).toBe(true);

    // The reporter the server runs, counting from its sources: one Paseo agent mid-turn,
    // one waiting on an approval, nothing running in Hermes, a phone line confirmed off.
    const row = (status: ConversationStatus): ConversationSummary => ({ source: 'paseo', id: `demo-${status}`, title: 'Demo chat', status, updatedAt: 1, pendingApprovals: 0 });
    const sources = {
      paseo: { status: () => ({ source: 'paseo' as const, state: 'connected' as const }), listConversations: async () => [row('running'), row('needs_approval'), row('idle')] },
      hermes: { status: () => ({ source: 'hermes' as const, state: 'connected' as const }), activeTurns: async () => 0 },
      phone: { phone: async () => ({ running: false, ok: false, pinSet: false, off: true }) },
    };
    const reporter = new BusyReporter(made, () => countBusy(sources), log, 25);
    stub.seen.length = 0;
    reporter.start();
    await expect.poll(() => stub.seen.filter((call) => call.path === SUPERVISOR_ROUTES.busy).length).toBeGreaterThanOrEqual(2);
    const pushes = stub.seen.filter((call) => call.path === SUPERVISOR_ROUTES.busy);
    for (const push of pushes) {
      expect(push).toMatchObject({ method: 'POST', authorization: `Bearer ${KEY}`, body: { paseoRunning: 2, hermesRunning: 0, calls: 0 } });
    }

    reporter.stop(); // what shutdown does first
    await new Promise((resolve) => setTimeout(resolve, 40)); // let a request already on the wire land
    const after = stub.seen.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stub.seen.length).toBe(after);

    // A key the supervisor refuses: the counts aren't taken, said once, and the key is never written.
    stub.set({ key: OTHER });
    expect(await made.reportBusy({ paseoRunning: 0, hermesRunning: 0, calls: 0 })).toBe(false);
    const refused = new BusyReporter(made, () => countBusy(sources), log, 20);
    refused.start();
    await new Promise((resolve) => setTimeout(resolve, 90));
    refused.stop();
    expect(lines.filter((line) => line.includes('did not take the busy counts'))).toHaveLength(1);
    expect(lines.join('')).not.toContain(KEY);
  });

  it('watches the event stream and sends what is in the contract', async () => {
    const made = client();
    const events: SupervisorEvent[] = [];
    const stop = made.events({ event: (event) => void events.push(event), lost() {} });
    cleanups.push(async () => stop());

    await expect.poll(() => events.length).toBe(1); // the snapshot sent on connect
    stub.push({ type: 'line', actionId: 'act-socket-1', line: 'Loading Balanced model…' });
    stub.push({ type: 'action', action: actionSummary({ verb: 'switch-model', target: 'main-model' }, { id: 'act-socket-1' }) });
    await expect.poll(() => events.length).toBe(3);
    expect(events[1]).toEqual({ type: 'line', actionId: 'act-socket-1', line: 'Loading Balanced model…' });

    stop();
    // The supervisor sees the socket go away with the request.
    await expect.poll(() => stub.streams()).toBe(0);
  });

  it('reads frames that end their lines with CRLF', async () => {
    const made = client();
    const events: SupervisorEvent[] = [];
    const stop = made.events({ event: (event) => void events.push(event), lost() {} });
    cleanups.push(async () => stop());

    await expect.poll(() => events.length).toBe(1); // the snapshot sent on connect, in LF
    const line: SupervisorEvent = { type: 'line', actionId: 'act-socket-1', line: 'Loading Balanced model…' };
    stub.pushCrlf(line);
    await expect.poll(() => events.length).toBe(2);
    expect(events[1]).toEqual(line);

    // A chunk that stops between the \r and the \n of one CRLF, inside a frame whose
    // JSON runs over two data lines: the \n that starts the next chunk is the other
    // half of that line ending, not a blank line, so the frame stays whole.
    const next: SupervisorEvent = { type: 'line', actionId: 'act-socket-1', line: 'almost there' };
    const json = JSON.stringify(next);
    const cut = json.indexOf(',') + 1;
    // The pause makes the two writes reach the client as two chunks, not one.
    stub.writeRaw([`event: line\r\ndata: ${json.slice(0, cut)}\r`]);
    await new Promise((done) => setTimeout(done, 30));
    expect(events).toHaveLength(2);
    stub.writeRaw([`\ndata: ${json.slice(cut)}\r\n\r\n`]);
    await expect.poll(() => events.length).toBe(3);
    expect(events[2]).toEqual(next);

    // A bare CR ends a line too, so \r\r ends a frame, even as the last bytes sent.
    const last: SupervisorEvent = { type: 'line', actionId: 'act-socket-1', line: 'done' };
    stub.writeRaw([`event: line\rdata: ${JSON.stringify(last)}\r\r`]);
    await expect.poll(() => events.length).toBe(4);
    expect(events[3]).toEqual(last);

    stop();
  });

  it('drops what isn’t an event and stays on the stream', async () => {
    const made = client();
    const events: SupervisorEvent[] = [];
    const stop = made.events({ event: (event) => void events.push(event), lost() {} });
    cleanups.push(async () => stop());
    await expect.poll(() => events.length).toBe(1);

    // A keep-alive comment, a body that isn’t JSON, an event the contract doesn’t
    // have, and events missing what they need: none of them reach the server, and
    // the one that follows still does.
    const line: SupervisorEvent = { type: 'line', actionId: 'act-socket-1', line: 'still here' };
    stub.writeRaw([
      ': keep-alive\n\n',
      'event: line\ndata: {not json\n\n',
      'event: weather\ndata: {"type":"weather","sky":"clear"}\n\n',
      'data: {"type":"status","sentence":"nothing of ours"}\n\n',
      'data: {"type":"line","actionId":"act-socket-1"}\n\n',
      `event: line\ndata: ${JSON.stringify(line)}\n\n`,
    ]);
    await expect.poll(() => events.length).toBe(2);
    expect(events[1]).toEqual(line);

    stop();
  });

  it('redials a stream that dropped and catches up on the way back', async () => {
    const made = client();
    const events: SupervisorEvent[] = [];
    let lostCount = 0;
    const stop = made.events({ event: (event) => void events.push(event), lost: () => void lostCount++ });
    cleanups.push(async () => stop());

    await expect.poll(() => events.length).toBe(1);
    const first = demoStatus({ sentence: 'One moment, the model is starting.', components: [mainModel({ state: 'starting' })] });
    stub.set({ status: first });
    stub.dropStreams();
    await expect.poll(() => lostCount).toBeGreaterThan(0);

    // The supervisor came back; its new stream starts with a fresh snapshot.
    await expect.poll(() => stub.streams(), { timeout: 5_000 }).toBe(1);
    await expect.poll(() => events.at(-1)).toEqual({ type: 'status', status: first });
    stop();
  });

  it('treats a stream that goes quiet as dropped', async () => {
    const made = client(quiet, { backoffMs: { min: 20, max: 40 }, idleMs: 60 });
    let lostCount = 0;
    const stop = made.events({ event() {}, lost: () => void lostCount++ });
    cleanups.push(async () => stop());
    // The stub sends one snapshot and then nothing: the watchdog redials.
    await expect.poll(() => lostCount, { timeout: 3_000 }).toBeGreaterThan(0);
    stop();
  });

  it('says nothing sensitive when the key file isn’t a key', async () => {
    const { log, lines } = captureLog();
    const folder = await mkdtemp(join(tmpdir(), 'wayroost-keyfile-test-'));
    const bad = join(folder, 'key');
    await writeFile(bad, 'not a key at all, and far too short');
    const made = new SupervisorClient(stub.socket, bad, log, fast);
    expect(await made.status()).toBeNull();
    const all = lines.join('');
    expect(all).toContain('keyFile');
    expect(all).not.toContain('not a key at all');
    expect(stub.seen).toEqual([]); // never called out with a bad key
    await rm(folder, { recursive: true, force: true });
  });
});
