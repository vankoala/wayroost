import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { DeviceKind, ServerEvent } from '../../shared/protocol.js';
import type { ActionSummary, BusyError, SupervisorStatus } from '../../shared/supervisor.js';
import { UserFacingError } from '../src/sources.js';
import { actionSummary, demoStatus, FakeSupervisor, gate, mainModel } from './fake-supervisor.js';
import {
  DESKTOP_COOKIE,
  ORIGIN,
  PHONE_COOKIE,
  TEST_DESKTOP,
  TEST_PHONE,
  apiHeaders,
  makeApp,
  makeKeys,
  makeToken,
  postHeaders,
  type Keys,
} from './helpers.js';

// Status & power with a fake supervisor behind it: what the
// routes answer, who may ask for what, and what a phone has to confirm first.
// Who asks is a paired device: the test desktop and phone sign in with their
// cookies, and an Access sign-in alone may not act.

let keys: Keys;
let token: string;
const cleanups: Array<() => Promise<unknown>> = [];

beforeAll(async () => {
  keys = await makeKeys();
  token = await makeToken(keys);
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** The test device of that kind signs the request in (the desktop unless it says phone). */
const cookieOf = (kind?: DeviceKind): string => (kind === 'phone' ? PHONE_COOKIE : DESKTOP_COOKIE);

const settle = () => new Promise((resolve) => setImmediate(resolve));

type Ctx = Awaited<ReturnType<typeof makeApp>>;
type Res = Awaited<ReturnType<Ctx['app']['inject']>>;

interface Setup extends Ctx {
  supervisor: FakeSupervisor;
  /** Every event published to signed-in pages, from here on. */
  published: ServerEvent[];
  logs: string[];
  clock: { now: number };
  power: (headers?: Record<string, string>) => Promise<Res>;
  act: (body: unknown, kind?: DeviceKind, extra?: Record<string, string>) => Promise<Res>;
  presence: (state: unknown, kind?: DeviceKind, extra?: Record<string, string>) => Promise<Res>;
}

async function setup(
  options: {
    /** null wires no supervisor at all, the way a config without the block does. */
    supervisor?: FakeSupervisor | null;
    confirmTtlMs?: number;
    captureLogs?: boolean;
    /** Let the clock run for real, to watch a token expire on its own. */
    realClock?: boolean;
    /** Config fields on top of the test config (device sign-in off, for one). */
    configExtra?: Record<string, unknown>;
  } = {},
): Promise<Setup> {
  const clock = { now: 1_700_000_000_000 };
  const supervisor = options.supervisor === undefined ? new FakeSupervisor() : options.supervisor;
  const logs: string[] = [];
  const ctx = await makeApp(keys, {
    ...(supervisor ? { supervisor } : {}),
    ...(options.configExtra ? { configExtra: options.configExtra } : {}),
    power: {
      ...(options.confirmTtlMs ? { confirmTtlMs: options.confirmTtlMs } : {}),
      now: options.realClock ? () => Date.now() : () => clock.now,
    },
    ...(options.captureLogs ? { logger: { level: 'trace', stream: { write: (line: string) => void logs.push(line) } } } : {}),
  });
  cleanups.push(() => ctx.app.close());
  await settle(); // the first snapshot, fetched when the app was built

  const published: ServerEvent[] = [];
  const publish = ctx.hub.publish.bind(ctx.hub);
  ctx.hub.publish = (event: ServerEvent) => {
    published.push(event);
    publish(event);
  };

  return {
    ...ctx,
    supervisor: supervisor ?? new FakeSupervisor(),
    published,
    logs,
    clock,
    power: (headers = {}) => ctx.app.inject({ method: 'GET', url: '/api/power', headers: apiHeaders(token, headers) }),
    act: (body, kind, extra) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/power/actions',
        headers: postHeaders(token, { cookie: cookieOf(kind), ...extra }),
        payload: JSON.stringify(body),
      }),
    presence: (state, kind, extra) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/presence',
        headers: postHeaders(token, { cookie: cookieOf(kind), ...extra }),
        payload: JSON.stringify(state),
      }),
  };
}

describe('GET /api/power', () => {
  it('answers with the supervisor snapshot it cached from the event stream', async () => {
    const ctx = await setup();
    const res = await ctx.power();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      running: true,
      status: demoStatus(),
      sentence: 'Everything is running.',
      presence: [],
    });
  });

  it('follows the stream: a new snapshot changes the answer and reaches open pages', async () => {
    const ctx = await setup();
    const attention = demoStatus({ overall: 'attention', sentence: 'The model is starting.', components: [mainModel({ state: 'starting', sentence: 'Loading Balanced model, about 4 min left.' })] });

    ctx.supervisor.push({ type: 'status', status: attention });
    expect(ctx.published.map((event) => event.type)).toEqual(['power_status']);
    expect((await ctx.power()).json().status).toEqual(attention);

    // The same snapshot again (the supervisor polls) says nothing new.
    ctx.published.length = 0;
    ctx.supervisor.push({ type: 'status', status: attention });
    expect(ctx.published).toEqual([]);

    // Nor does the next poll, whose only change is its own timestamp.
    ctx.supervisor.push({ type: 'status', status: { ...attention, at: attention.at + 5_000 } });
    expect(ctx.published).toEqual([]);
  });

  it('keeps the running action and its progress lines in what it pushes', async () => {
    const ctx = await setup();
    const started = actionSummary({ verb: 'switch-model', target: 'main-model', profile: 'balanced' }, { id: 'act-demo-7', state: 'running' });

    ctx.supervisor.push({ type: 'action', action: started });
    ctx.supervisor.push({ type: 'line', actionId: 'act-demo-7', line: 'Main model loading…' });

    expect((await ctx.power()).json().status.running).toEqual(started);
    expect(ctx.published.map((event) => event.type)).toEqual(['power_status', 'power_action', 'power_line']);
    expect(ctx.published[2]).toEqual({ type: 'power_line', actionId: 'act-demo-7', line: 'Main model loading…' });

    // When it finishes, the snapshot stops claiming an action is running.
    ctx.supervisor.push({ type: 'action', action: { ...started, state: 'done', endedAt: ctx.clock.now } });
    expect((await ctx.power()).json().status.running).toBeUndefined();
  });

  it('does not let the snapshot it asked for at startup undo what the stream said', async () => {
    const supervisor = new FakeSupervisor();
    const held = gate<SupervisorStatus | null>();
    supervisor.statusGate = held.promise; // the GET /v1/status made at startup stays in the air
    const ctx = await setup({ supervisor });

    const newer = demoStatus({ at: 200, sentence: 'The Balanced model is answering.', components: [mainModel({ sentence: 'The Balanced model is answering.' })] });
    supervisor.push({ type: 'status', status: newer });
    held.resolve(demoStatus({ at: 100 })); // the older answer arrives last
    await settle();

    expect((await ctx.power()).json().status).toEqual(newer);
  });

  it('does not let the startup snapshot bring back a stream that has failed', async () => {
    const supervisor = new FakeSupervisor();
    const held = gate<SupervisorStatus | null>();
    supervisor.statusGate = held.promise; // the GET /v1/status made at startup stays in the air
    const ctx = await setup({ supervisor });

    supervisor.lose(); // the first stream fails before it says anything
    held.resolve(demoStatus()); // and then the startup answer lands
    await settle();

    expect((await ctx.power()).json()).toEqual({ running: false, sentence: "The supervisor isn't running.", presence: [] });
    expect(ctx.published).toEqual([]);
    const refused = await ctx.act({ verb: 'restart', target: 'paseo' });
    expect(refused.statusCode).toBe(503);
    expect(supervisor.acted).toEqual([]);

    // The stream coming back is what makes it live again.
    supervisor.push({ type: 'status', status: demoStatus() });
    expect((await ctx.power()).json().running).toBe(true);
  });

  it('does not let the startup snapshot land after the server stopped watching', async () => {
    const supervisor = new FakeSupervisor();
    const held = gate<SupervisorStatus | null>();
    supervisor.statusGate = held.promise;
    const ctx = await setup({ supervisor });

    await ctx.app.close(); // shutting down: the stream is stopped
    held.resolve(demoStatus());
    await settle();
    expect(ctx.published).toEqual([]);
  });

  it('pushes a snapshot whose only news is something a page would show', async () => {
    const ctx = await setup();
    ctx.published.length = 0;

    // Same states and same sentences: the plain name, the details and the GPU changed.
    const renamed = demoStatus({
      at: 999,
      components: [
        mainModel({ name: 'Main model on both GPUs', since: 1_700_000_000_400, details: { port: '19023', gpus: '0, 1' } }),
        { id: 'paseo', name: 'Agent workspace', state: 'up', sentence: 'The agent workspace is running.', actions: ['restart'] },
      ],
    });
    ctx.supervisor.push({ type: 'status', status: renamed });
    expect(ctx.published).toHaveLength(1);
    expect((await ctx.power()).json().status.components[0].name).toBe('Main model on both GPUs');

    // A profile's cold-start time goes into the sentence a phone taps, so it counts too.
    const profiles = renamed.components[0]!.model!.profiles;
    ctx.published.length = 0;
    ctx.supervisor.push({
      type: 'status',
      status: demoStatus({
        at: 1000,
        components: [mainModel({ ...renamed.components[0]!, model: { live: 'main-model', profiles: [profiles[0]!, { id: 'balanced', name: 'Balanced model', loadSeconds: 300, gpus: [2, 3] }] } }), renamed.components[1]!],
      }),
    });
    expect(ctx.published).toHaveLength(1);
  });

  it('does not let a late answer about an action put one that finished back on screen', async () => {
    const supervisor = new FakeSupervisor();
    const held = gate<ActionSummary | BusyError>();
    supervisor.actGate = held.promise; // the supervisor takes its time answering the POST
    const ctx = await setup({ supervisor });
    const queued = actionSummary({ verb: 'restart', target: 'paseo' }, { id: 'act-demo-9' });

    const hit = ctx.act({ verb: 'restart', target: 'paseo' });
    await settle(); // the request is still with the supervisor while the stream moves on
    supervisor.push({ type: 'action', action: { ...queued, state: 'running' } });
    supervisor.push({ type: 'action', action: { ...queued, state: 'done', endedAt: ctx.clock.now } });
    held.resolve(queued); // and now the answer to the first call arrives, calling it queued
    expect((await hit).statusCode).toBe(202);
    await settle();

    expect((await ctx.power()).json().status.running).toBeUndefined();
  });

  it('learns that an action ended from the snapshot after a reconnect, and a late answer does not undo it', async () => {
    const supervisor = new FakeSupervisor();
    const held = gate<ActionSummary | BusyError>();
    supervisor.actGate = held.promise;
    const ctx = await setup({ supervisor });
    const startedAt = 1_700_000_000_000;
    const queued = actionSummary({ verb: 'restart', target: 'paseo' }, { id: 'act-demo-11', startedAt });

    const hit = ctx.act({ verb: 'restart', target: 'paseo' });
    await settle();
    supervisor.push({ type: 'action', action: queued }); // the stream says it was queued
    expect((await ctx.power()).json().status.running).toEqual(queued);
    supervisor.lose(); // and drops; the action finishes while nobody is listening
    supervisor.push({ type: 'status', status: demoStatus({ at: startedAt + 5_000 }) }); // the snapshot on reconnecting
    held.resolve(queued); // the answer to the POST, still calling it queued, lands last
    expect((await hit).statusCode).toBe(202);
    await settle();
    expect((await ctx.power()).json().status.running).toBeUndefined();

    // A later event about it, from before the gap, can't bring it back either.
    supervisor.push({ type: 'action', action: { ...queued, state: 'running' } });
    expect((await ctx.power()).json().status.running).toBeUndefined();

    // A snapshot taken before an action started says nothing about it: its answer still shows it.
    supervisor.actGate = null;
    const next = actionSummary({ verb: 'restart', target: 'paseo' }, { id: 'act-demo-12', startedAt: startedAt + 9_000 });
    supervisor.result = next;
    expect((await ctx.act({ verb: 'restart', target: 'paseo' })).statusCode).toBe(202);
    expect((await ctx.power()).json().status.running).toEqual(next);
  });

  it('does not let an answer with no start time undo an end learned from a snapshot', async () => {
    // The sequence: the record behind the POST's answer couldn't be read, so the
    // client built it from the request with startedAt 0 (supervisor-client summary()).
    const supervisor = new FakeSupervisor();
    const held = gate<ActionSummary | BusyError>();
    supervisor.actGate = held.promise;
    const ctx = await setup({ supervisor });
    const startedAt = 1_700_000_000_000;
    const queued = actionSummary({ verb: 'restart', target: 'paseo' }, { id: 'act-demo-13', startedAt });

    const hit = ctx.act({ verb: 'restart', target: 'paseo' });
    await settle();
    supervisor.push({ type: 'action', action: queued });
    supervisor.lose(); // the end is missed
    supervisor.push({ type: 'status', status: demoStatus({ at: startedAt + 5_000 }) }); // nothing running on reconnect
    held.resolve({ ...queued, caller: 'this app', startedAt: 0 }); // the guess lands last
    expect((await hit).statusCode).toBe(202);
    await settle();
    expect((await ctx.power()).json().status.running).toBeUndefined();
  });

  it('shows a guessed answer until the supervisor says more, but not over a snapshot sent meanwhile', async () => {
    const supervisor = new FakeSupervisor();
    const ctx = await setup({ supervisor });
    await settle();
    const guess = actionSummary({ verb: 'restart', target: 'paseo' }, { id: 'act-demo-14', caller: 'this app', startedAt: 0 });

    // Nothing newer known: the page sees the action at once.
    supervisor.result = guess;
    expect((await ctx.act({ verb: 'restart', target: 'paseo' })).statusCode).toBe(202);
    expect((await ctx.power()).json().status.running).toEqual(guess);
    // The stream then says how it is going.
    const running = { ...guess, state: 'running' as const, caller: 'demo-key', startedAt: 1_700_000_001_000 };
    supervisor.push({ type: 'action', action: running });
    expect((await ctx.power()).json().status.running).toEqual(running);
    supervisor.push({ type: 'action', action: { ...running, state: 'done', endedAt: 1_700_000_002_000 } });
    expect((await ctx.power()).json().status.running).toBeUndefined();

    // A snapshot arrived while the POST was out: it is newer than any guess.
    const held = gate<ActionSummary | BusyError>();
    supervisor.actGate = held.promise;
    const hit = ctx.act({ verb: 'restart', target: 'paseo' });
    await expect.poll(() => supervisor.acted.length).toBe(2); // the POST is out
    supervisor.push({ type: 'status', status: demoStatus({ at: 1_700_000_009_000 }) });
    held.resolve({ ...guess, id: 'act-demo-15' });
    expect((await hit).statusCode).toBe(202);
    await settle();
    expect((await ctx.power()).json().status.running).toBeUndefined();
  });

  it('does not end an action whose event carries no start time', async () => {
    const supervisor = new FakeSupervisor();
    const ctx = await setup({ supervisor });
    await settle();
    supervisor.push({ type: 'status', status: demoStatus({ at: 1_700_000_005_000 }) });
    // An older supervisor's event without startedAt (parsed as 0): it can't be placed before the snapshot.
    const untimed = actionSummary({ verb: 'restart', target: 'paseo' }, { id: 'act-demo-16', state: 'running', startedAt: 0 });
    supervisor.push({ type: 'action', action: untimed });
    expect((await ctx.power()).json().status.running).toEqual(untimed);
  });

  it('does not show an action that had already finished as running', async () => {
    const supervisor = new FakeSupervisor();
    supervisor.result = actionSummary({ verb: 'restart', target: 'paseo' }, { id: 'act-demo-8', state: 'done', endedAt: 1_700_000_000_500 });
    const ctx = await setup({ supervisor });

    expect((await ctx.act({ verb: 'restart', target: 'paseo' })).statusCode).toBe(202);
    await settle();
    expect((await ctx.power()).json().status.running).toBeUndefined();
  });

  it("says the supervisor isn't running when nothing answers", async () => {
    const down = new FakeSupervisor();
    down.snapshot = null;
    const ctx = await setup({ supervisor: down });
    const res = await ctx.power();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ running: false, sentence: "The supervisor isn't running.", presence: [] });

    // A stream that drops off mid-air goes back to that plain state.
    down.snapshot = demoStatus();
    ctx.supervisor.push({ type: 'status', status: demoStatus() });
    expect((await ctx.power()).json().running).toBe(true);
    down.lose();
    expect((await ctx.power()).json()).toEqual({ running: false, sentence: "The supervisor isn't running.", presence: [] });
  });

  it('says the same when this server has no supervisor to talk to', async () => {
    const ctx = await setup({ supervisor: null });
    expect((await ctx.power()).json()).toEqual({ running: false, sentence: "The supervisor isn't running.", presence: [] });
    const refused = await ctx.act({ verb: 'restart', target: 'paseo' });
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual({ error: "The supervisor isn't running." });
  });
});

describe('power actions from a desktop', () => {
  it('forwards at once, with the profile and when', async () => {
    const ctx = await setup();
    const res = await ctx.act({ verb: 'switch-model', target: 'main-model', profile: 'balanced', when: 'idle' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ action: expect.objectContaining({ id: 'act-demo-1', verb: 'switch-model', state: 'queued' }) });
    expect(ctx.supervisor.acted).toEqual([{ verb: 'switch-model', target: 'main-model', profile: 'balanced', when: 'idle' }]);
  });

  it('takes any id the registry allows, even one that starts with a digit', async () => {
    const ctx = await setup();
    for (const target of ['demo-helper', 'demo-secondary', 'coder-2']) {
      const res = await ctx.act({ verb: 'restart', target });
      expect(res.statusCode, target).toBe(202);
    }
    const switched = await ctx.act({ verb: 'switch-model', target: 'main-model', profile: '8b' });
    expect(switched.statusCode).toBe(202);
    expect(ctx.supervisor.acted.map((request) => request.target)).toEqual(['demo-helper', 'demo-secondary', 'coder-2', 'main-model']);
    expect(ctx.supervisor.acted.at(-1)).toMatchObject({ profile: '8b' });

    // Still only the registry's characters, and not an unbounded string.
    for (const target of ['Demo-helper', 'demo_helper', '', 'a'.repeat(201)]) {
      expect((await ctx.act({ verb: 'restart', target })).statusCode, target).toBe(400);
    }
    expect(ctx.supervisor.acted).toHaveLength(4);
  });

  it('may ask for every verb the contract has', async () => {
    const ctx = await setup();
    for (const verb of ['start', 'stop', 'restart', 'hold', 'release', 'switch-model', 'diagnostics'] as const) {
      const res = await ctx.act({ verb, target: 'coder' });
      expect(res.statusCode).toBe(202);
    }
    expect(ctx.supervisor.acted).toHaveLength(7);
  });

  it('passes a 409 through with the action that is already running', async () => {
    const ctx = await setup();
    const running = actionSummary({ verb: 'switch-model', target: 'main-model', profile: 'balanced' }, { id: 'act-demo-2', state: 'running' });
    ctx.supervisor.busy = { error: 'busy', message: 'Another action is running. Wait until it finishes.', running };
    const res = await ctx.act({ verb: 'restart', target: 'paseo' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'busy', message: 'Another action is running. Wait until it finishes.', running });
  });

  it("refuses a body that isn't one action request", async () => {
    const ctx = await setup();
    const cases: Array<[string, unknown]> = [
      ['unknown verb', { verb: 'reboot', target: 'paseo' }],
      ['unknown target', { verb: 'restart', target: 'Paseo!' }],
      ['no verb', { target: 'paseo' }],
      ['an extra field', { verb: 'restart', target: 'paseo', argv: ['rm', '-rf'] }],
      ['a when that is not now or idle', { verb: 'restart', target: 'paseo', when: 'tonight' }],
      ['a profile with odd characters', { verb: 'switch-model', target: 'main-model', profile: '../etc' }],
      ['nothing at all', {}],
    ];
    for (const [name, body] of cases) {
      const res = await ctx.act(body);
      expect(res.statusCode, name).toBe(400);
    }
    expect(ctx.supervisor.acted).toEqual([]);
  });
});

describe('power actions from a phone', () => {
  it('asks for a confirm tap first, in one plain sentence', async () => {
    const ctx = await setup();
    const res = await ctx.act({ verb: 'switch-model', target: 'main-model', profile: 'balanced' }, 'phone');
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.summary).toBe('Switch to Balanced model? About 4 min without the main model.');
    expect(body.confirm).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.supervisor.acted).toEqual([]); // nothing ran yet
  });

  it('forwards the same request when it comes back with the token', async () => {
    const ctx = await setup();
    const request = { verb: 'restart', target: 'paseo' };
    const first = await ctx.act(request, 'phone');
    const { confirm } = first.json();
    const second = await ctx.act({ ...request, confirm }, 'phone');
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({ action: expect.objectContaining({ verb: 'restart', target: 'paseo', state: 'queued' }) });
    expect(ctx.supervisor.acted).toEqual([{ verb: 'restart', target: 'paseo', when: 'now' }]);
  });

  it('refuses a token that is reused, expired, another device\'s, or for another request', async () => {
    const ctx = await setup();
    const request = { verb: 'restart', target: 'paseo' };
    // A second phone, paired by the same person (same Access email): its own device.
    const second = ctx.devices!.add('Second phone', 'phone');

    // One tap, one action: the next time the same token comes back, it's spent.
    const first = (await ctx.act(request, 'phone')).json().confirm;
    expect((await ctx.act({ ...request, confirm: first }, 'phone')).statusCode).toBe(202);
    const reused = await ctx.act({ ...request, confirm: first }, 'phone');
    expect(reused.statusCode).toBe(403);
    expect(reused.json().error).toMatch(/already used/i);

    // A token belongs to the device it was handed to.
    const otherPhone = (await ctx.act(request, 'phone', { cookie: `wr_device=${second.cookie}` })).json().confirm;
    const otherDevice = await ctx.act({ ...request, confirm: otherPhone }, 'phone');
    expect(otherDevice.statusCode).toBe(403);
    expect(otherDevice.json().error).toMatch(/another device/i);

    // And to the exact request it was handed for.
    const again = (await ctx.act(request, 'phone')).json().confirm;
    const changed = await ctx.act({ ...request, target: 'coder', confirm: again }, 'phone');
    expect(changed.statusCode).toBe(403);
    expect(changed.json().error).toMatch(/different request/i);

    // A minute on the clock and it's gone.
    const later = (await ctx.act(request, 'phone')).json().confirm;
    ctx.clock.now += 60_001;
    const tooLate = await ctx.act({ ...request, confirm: later }, 'phone');
    expect(tooLate.statusCode).toBe(403);
    expect(tooLate.json().error).toMatch(/expired/i);

    // A token this server never handed out.
    const unknown = await ctx.act({ ...request, confirm: '00000000000000000000000000000000' }, 'phone');
    expect(unknown.statusCode).toBe(403);

    // Of everything above, exactly one call was a forward: this phone's own tap.
    // Every refusal stopped here, and no action ran twice.
    expect(ctx.supervisor.acted).toEqual([{ verb: 'restart', target: 'paseo', when: 'now' }]);
  });

  it('expires a tap on its own clock', async () => {
    const ctx = await setup({ confirmTtlMs: 50, realClock: true });
    const request = { verb: 'restart', target: 'paseo' };
    const { confirm } = (await ctx.act(request, 'phone')).json();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const res = await ctx.act({ ...request, confirm }, 'phone');
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/expired/i);
    expect(ctx.supervisor.acted).toEqual([]);
  });

  it('can restart and switch the model, and nothing else', async () => {
    const ctx = await setup();
    for (const verb of ['stop', 'hold', 'release', 'start', 'diagnostics'] as const) {
      const res = await ctx.act({ verb, target: 'coder' }, 'phone');
      expect(res.statusCode, verb).toBe(403);
      expect(res.json().error, verb).toMatch(/desktop/i);
    }
    expect(ctx.supervisor.acted).toEqual([]);
    expect((await ctx.act({ verb: 'restart', target: 'coder' }, 'phone')).statusCode).toBe(202);
    expect((await ctx.act({ verb: 'switch-model', target: 'main-model', profile: 'main-model' }, 'phone')).statusCode).toBe(202);
  });

  it('sends a busy phone request back to the confirm sheet', async () => {
    const ctx = await setup();
    const running = actionSummary({ verb: 'restart', target: 'paseo' }, { id: 'act-demo-3', state: 'running' });
    ctx.supervisor.busy = { error: 'busy', message: 'Another action is running. Wait until it finishes.', running };
    const { confirm } = (await ctx.act({ verb: 'restart', target: 'coder' }, 'phone')).json();
    const res = await ctx.act({ verb: 'restart', target: 'coder', confirm }, 'phone');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'busy', message: expect.any(String), running });
  });
});

describe('who may act: paired devices only', () => {
  it('lets the paired desktop act at once', async () => {
    const ctx = await setup();
    const res = await ctx.act({ verb: 'restart', target: 'paseo' }, 'desktop');
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ action: expect.objectContaining({ state: 'queued' }) });
    expect(ctx.supervisor.acted).toHaveLength(1);
  });

  it('refuses an Access sign-in without a paired device', async () => {
    // Device sign-in on: an unpaired browser is sent to pairing before any route runs.
    const unpaired = await setup();
    const noCookie = postHeaders(token);
    delete noCookie.cookie;
    for (const [url, body] of [['/api/power/actions', { verb: 'restart', target: 'paseo' }], ['/api/presence', { state: 'idle' }]] as const) {
      const res = await unpaired.app.inject({ method: 'POST', url, headers: noCookie, payload: JSON.stringify(body) });
      expect(res.statusCode, url).toBe(401);
      expect(res.json()).toEqual({ error: 'unpaired' });
    }

    // Device sign-in off (Access alone): signed in, but nobody's desktop or phone.
    const accessOnly = await setup({ configExtra: { devices: { enabled: false } } });
    const act = await accessOnly.app.inject({
      method: 'POST', url: '/api/power/actions', headers: noCookie, payload: JSON.stringify({ verb: 'restart', target: 'paseo' }),
    });
    expect(act.statusCode).toBe(403);
    expect(act.json()).toEqual({ error: 'Pair this device before controlling the PC.' });
    const presence = await accessOnly.app.inject({ method: 'POST', url: '/api/presence', headers: noCookie, payload: JSON.stringify({ state: 'idle' }) });
    expect(presence.statusCode).toBe(403);
    expect(accessOnly.supervisor.acted).toEqual([]);
    const read = vi.spyOn(accessOnly.supervisor, 'action');
    for (const url of ['/api/power', '/api/power/actions/act-demo-1']) {
      const res = await accessOnly.app.inject({ method: 'GET', url, headers: noCookie });
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toEqual({ error: 'Pair this device before controlling the PC.' });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'desktop' as const, url: '/api/power/actions', body: { verb: 'stop', target: 'main-model' } },
    { kind: 'phone' as const, url: '/api/power/actions', body: { verb: 'restart', target: 'paseo' } },
    { kind: 'desktop' as const, url: '/api/presence', body: { state: 'active' } },
    { kind: 'phone' as const, url: '/api/presence', body: { state: 'locked' } },
  ])('refuses a delayed $kind body for $url after revocation', async ({ kind, url, body }) => {
    const ctx = await setup();
    const device = kind === 'desktop' ? TEST_DESKTOP : TEST_PHONE;
    await ctx.presence({ state: 'idle' }, kind);
    const authenticated = gate<string | undefined>();
    const authenticate = ctx.devices!.authenticate.bind(ctx.devices);
    vi.spyOn(ctx.devices!, 'authenticate').mockImplementation((values) => {
      const signedIn = authenticate(values);
      authenticated.resolve(signedIn?.device.id);
      return signedIn;
    });
    const payload = new PassThrough();
    const response = ctx.app.inject({ method: 'POST', url, headers: postHeaders(token, { cookie: cookieOf(kind) }), payload });
    try {
      expect(await authenticated.promise).toBe(device.id);
      const revoked = await ctx.app.inject({ method: 'DELETE', url: `/api/devices/${device.id}`, headers: apiHeaders(token, { origin: ORIGIN }) });
      expect(revoked.statusCode).toBe(200);
    } finally {
      payload.end(JSON.stringify(body));
    }
    const res = await response;
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Pair this device before controlling the PC.' });
    expect(ctx.supervisor.acted).toEqual([]);
    const remainingCookie = kind === 'desktop' ? PHONE_COOKIE : DESKTOP_COOKIE;
    expect((await ctx.power({ cookie: remainingCookie })).json().presence).toEqual([]);
  });

  it('keeps a revoked phone from confirming the tap it was handed', async () => {
    const ctx = await setup();
    const request = { verb: 'restart', target: 'paseo' };
    await ctx.presence({ state: 'active' }, 'phone');
    const { confirm } = (await ctx.act(request, 'phone')).json();
    expect(confirm).toMatch(/^[0-9a-f]{32}$/);

    // Revoked between the first tap and the confirmation.
    const revoked = await ctx.app.inject({ method: 'DELETE', url: `/api/devices/${TEST_PHONE.id}`, headers: apiHeaders(token, { origin: ORIGIN }) });
    expect(revoked.statusCode).toBe(200);
    expect((await ctx.power()).json().presence).toEqual([]);

    const late = await ctx.act({ ...request, confirm }, 'phone');
    expect(late.statusCode).toBe(401);
    expect(ctx.supervisor.acted).toEqual([]);
  });

  it('gives a page the progress lines of an action it missed', async () => {
    const ctx = await setup();
    ctx.supervisor.detail = {
      id: 'act-demo-1',
      verb: 'switch-model',
      target: 'main-model',
      profile: 'balanced',
      state: 'running',
      caller: 'demo-key',
      startedAt: 1_700_000_000_000,
      lines: ['Main model loading…', 'Loading Balanced model…'],
    };
    const hit = await ctx.app.inject({ method: 'GET', url: '/api/power/actions/act-demo-1', headers: apiHeaders(token) });
    expect(hit.statusCode).toBe(200);
    expect(hit.json()).toEqual({ ...ctx.supervisor.detail, profile: 'balanced' });

    const miss = await ctx.app.inject({ method: 'GET', url: '/api/power/actions/act-gone', headers: apiHeaders(token) });
    expect(miss.statusCode).toBe(404);
    expect(miss.json()).toEqual({ error: 'That action is not here any more.' });

    const junk = await ctx.app.inject({ method: 'GET', url: '/api/power/actions/..%2f..', headers: apiHeaders(token) });
    expect(junk.statusCode).toBe(400);
  });
});

describe('presence', () => {
  it("keeps the latest state per device and shows it in GET /api/power", async () => {
    const ctx = await setup();
    expect((await ctx.presence({ state: 'active' }, 'desktop')).statusCode).toBe(200);
    ctx.clock.now += 1_000;
    expect((await ctx.presence({ state: 'locked' }, 'desktop')).statusCode).toBe(200);
    ctx.clock.now += 1_000;
    expect((await ctx.presence({ state: 'idle' }, 'phone')).statusCode).toBe(200);

    // Newest first, and the same device only once: the desktop's "active" is
    // gone, replaced by its "locked".
    expect((await ctx.power()).json().presence).toEqual([
      { device: TEST_PHONE.id, kind: 'phone', state: 'idle', at: ctx.clock.now },
      { device: TEST_DESKTOP.id, kind: 'desktop', state: 'locked', at: ctx.clock.now - 1_000 },
    ]);
  });

  it("refuses anything that isn't one of the three states", async () => {
    const ctx = await setup();
    for (const body of [{ state: 'asleep' }, { state: 'ACTIVE' }, {}, { notState: 'idle' }, { state: 'idle', extra: 1 }, 'idle', null]) {
      expect((await ctx.presence(body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await ctx.power()).json().presence).toEqual([]);
  });

  it('records it and routes nothing: no other page event comes out', async () => {
    const ctx = await setup();
    await ctx.presence({ state: 'active' }, 'desktop');
    expect(ctx.published.map((event) => event.type)).toEqual(['power_status']);
    ctx.published.length = 0;
    // The same state again doesn't even wake the pages.
    ctx.clock.now += 60_000;
    await ctx.presence({ state: 'active' }, 'desktop');
    expect(ctx.published).toEqual([]);
    expect(ctx.supervisor.acted).toEqual([]);
  });
});

describe('the rules every API route follows', () => {
  const routes = [
    { method: 'GET' as const, url: '/api/power' },
    { method: 'GET' as const, url: '/api/power/actions/act-demo-1' },
    { method: 'POST' as const, url: '/api/power/actions', body: { verb: 'restart', target: 'paseo' } },
    { method: 'POST' as const, url: '/api/presence', body: { state: 'idle' } },
  ];

  for (const route of routes) {
    it(`${route.url} needs an Access identity`, async () => {
      const ctx = await setup();
      const headers = { host: new URL(ORIGIN).host, cookie: PHONE_COOKIE };
      const res = await ctx.app.inject({ method: route.method, url: route.url, headers, ...(route.body ? { payload: JSON.stringify(route.body) } : {}) });
      expect(res.statusCode).toBe(401);
    });

    it(`${route.url} needs the request marker`, async () => {
      const ctx = await setup();
      const headers = apiHeaders(token);
      delete headers['x-wayroost-request'];
      const res = await ctx.app.inject({ method: route.method, url: route.url, headers, ...(route.body ? { payload: JSON.stringify(route.body) } : {}) });
      expect(res.statusCode).toBe(403);
    });

    it(`${route.url} refuses a cross-site request`, async () => {
      const ctx = await setup();
      const res = await ctx.app.inject({
        method: route.method,
        url: route.url,
        headers: apiHeaders(token, { 'sec-fetch-site': 'cors' }),
        ...(route.body ? { payload: JSON.stringify(route.body) } : {}),
      });
      expect(res.statusCode).toBe(403);
    });

    it(`${route.url} refuses another site's origin`, async () => {
      const ctx = await setup();
      const res = await ctx.app.inject({
        method: route.method,
        url: route.url,
        headers: apiHeaders(token, { origin: 'https://evil.example.com' }),
        ...(route.body ? { payload: JSON.stringify(route.body) } : {}),
      });
      // Browsers send Origin on every request, but the API rule only holds writes to
      // our own origin; a read from another site passes and answers on its own merits.
      if (route.method === 'GET') expect([200, 404]).toContain(res.statusCode);
      else expect(res.statusCode).toBe(403);
    });

    it(`${route.url} refuses a Host we don't serve`, async () => {
      const ctx = await setup();
      const res = await ctx.app.inject({
        method: route.method,
        url: route.url,
        headers: apiHeaders(token, { host: 'rebind.example' }),
        ...(route.body ? { payload: JSON.stringify(route.body) } : {}),
      });
      expect(res.statusCode).toBe(421);
    });
  }

  it('takes JSON bodies only on the posts', async () => {
    const ctx = await setup();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/presence',
      headers: postHeaders(token, { 'content-type': 'text/plain' }),
      payload: '{"state":"idle"}',
    });
    expect(res.statusCode).toBe(403);
  });

  it("answers nobody's own id back to a signed-in page", async () => {
    const ctx = await setup();
    await ctx.presence({ state: 'active' }, 'phone');
    const res = await ctx.power();
    expect(res.json().presence[0].device).toBe(TEST_PHONE.id);
  });
});

describe('nothing sensitive in the logs', () => {
  it('names the action but never the confirm token', async () => {
    const ctx = await setup({ captureLogs: true });
    const request = { verb: 'switch-model', target: 'main-model', profile: 'balanced' };
    const { confirm } = (await ctx.act(request, 'phone')).json();
    const forwarded = await ctx.act({ ...request, confirm }, 'phone');
    expect(forwarded.statusCode).toBe(202);

    const all = ctx.logs.join('');
    expect(all).toContain('power action needs a confirm tap');
    expect(all).toContain('power action queued');
    expect(all).not.toContain(confirm);
    expect(all).not.toContain('Bearer');
    // The token is in the two responses and nowhere else: not in an event pushed
    // to another page, and not in what the supervisor was asked to run.
    expect(forwarded.json().action).toBeTruthy();
    expect(JSON.stringify(ctx.published)).not.toContain(confirm);
    expect(JSON.stringify(ctx.supervisor.acted)).not.toContain(confirm);
  });

  it('keeps the supervisor key out of anything the server writes', async () => {
    const ctx = await setup({ captureLogs: true });
    ctx.supervisor.failing = new UserFacingError('The supervisor is not answering.', 503);
    const res = await ctx.act({ verb: 'restart', target: 'paseo' });
    expect(res.statusCode).toBe(503);
    expect(ctx.logs.join('')).not.toContain('Bearer');
  });
});

describe('power over the live event socket', () => {
  it('keeps every power event off an Access-only socket, while other events still arrive', async () => {
    const ctx = await setup({ configExtra: { devices: { enabled: false } } });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (ctx.app.server.address() as { port: number }).port;
    ctx.config.allowedHosts.add(`127.0.0.1:${port}`);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin: ORIGIN, 'cf-access-jwt-assertion': token },
    });
    ws.on('error', () => {});
    cleanups.push(async () => ws.terminate());
    const received: ServerEvent[] = [];
    ws.on('message', (data) => received.push(JSON.parse(String(data))));
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'ping' }));
    await expect.poll(() => received.at(-1)?.type).toBe('pong');
    expect(received.map((event) => event.type)).toEqual(['hello', 'pong']);

    ctx.supervisor.push({ type: 'status', status: demoStatus({ sentence: 'The model is starting.' }) });
    ctx.supervisor.push({ type: 'action', action: actionSummary({ verb: 'restart', target: 'paseo' }) });
    ctx.supervisor.push({ type: 'line', actionId: 'act-demo-9', line: 'The Balanced model is loading.' });
    ws.send(JSON.stringify({ type: 'ping' }));
    await expect.poll(() => received.filter((event) => event.type === 'pong').length).toBe(2);
    expect(received.map((event) => event.type)).toEqual(['hello', 'pong', 'pong']);
  });

  it.each(['desktop', 'phone'] as const)('greets a paired %s with the current snapshot and follows every power event', async (kind) => {
    const ctx = await setup();
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (ctx.app.server.address() as { port: number }).port;
    ctx.config.allowedHosts.add(`127.0.0.1:${port}`);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin: ORIGIN, 'cf-access-jwt-assertion': token, cookie: cookieOf(kind) },
    });
    ws.on('error', () => {});
    cleanups.push(async () => ws.terminate());
    const received: ServerEvent[] = [];
    ws.on('message', (data) => received.push(JSON.parse(String(data))));
    await once(ws, 'open');

    await expect.poll(() => received.map((event) => event.type)).toEqual(['hello', 'power_status']);
    expect((received[1] as { power: { running: boolean } }).power.running).toBe(true);

    ctx.supervisor.push({ type: 'status', status: demoStatus({ sentence: 'The model is starting.' }) });
    ctx.supervisor.push({ type: 'action', action: actionSummary({ verb: 'restart', target: 'paseo' }) });
    ctx.supervisor.push({ type: 'line', actionId: 'act-demo-9', line: 'The Balanced model is loading.' });
    await expect.poll(() => received.at(-1)).toEqual({ type: 'power_line', actionId: 'act-demo-9', line: 'The Balanced model is loading.' });
    expect(received.map((event) => event.type)).toEqual(['hello', 'power_status', 'power_status', 'power_status', 'power_action', 'power_line']);
    ws.terminate();
  });
});
