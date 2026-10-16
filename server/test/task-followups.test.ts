import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { ConversationSummary } from '../../shared/protocol.js';
import { BackgroundGate } from '../src/background.js';
import { Bridge } from '../src/bridge/service.js';
import { EventHub } from '../src/hub.js';
import { PaseoAdapter } from '../src/paseo/adapter.js';
import type { AgentTimelineMirror } from '../src/paseo/mirror.js';
import type { FetchAgentTimelinePayload } from '@getpaseo/client/internal/daemon-client';
import { TaskRelay } from '../src/tasks/relay.js';
import { WorkerUpdatesSetting } from '../src/tasks/setting.js';
import { TaskStore } from '../src/tasks/store.js';
import { paseoWorkers } from '../src/tasks/wire.js';
import { FakeHermes, FakePaseo } from './helpers.js';

const log = { info() {}, warn() {}, error() {} };
const background = new BackgroundGate('primary');
const T0 = 1_800_000_000_000;
const PROJECT = '/home/me/code/app';
const roots: string[] = [];
const cleanups: Array<() => unknown> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  vi.restoreAllMocks();
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

const current = { Bridge, TaskRelay, TaskStore, paseoWorkers, PaseoAdapter };
let baseline: typeof current;
let baselineDir: string;
beforeAll(async () => {
  const root = resolve('.tmp');
  mkdirSync(root, { recursive: true });
  baselineDir = mkdtempSync(join(root, 'task-baseline-'));
  const files = ['server/src/bridge/service.ts', 'server/src/tasks/relay.ts', 'server/src/tasks/store.ts', 'server/src/tasks/wire.ts',
    'server/src/paseo/adapter.ts'];
  for (const file of files) {
    const content = execFileSync('git', ['show', `cc55e34:${file}`], { encoding: 'utf8' })
      .replace(/(from\s+['"])(\.[^'"]+)(['"])/g, (_match, before: string, specifier: string, after: string) => {
        const absolute = resolve(dirname(file), specifier).replace(/\.js$/, '.ts');
        const own = files.find((candidate) => resolve(candidate) === absolute);
        return `${before}${own ? join(baselineDir, own.split('/').at(-1)!) : absolute}${after}`;
      });
    writeFileSync(join(baselineDir, file.split('/').at(-1)!), content);
  }
  const [bridge, relay, store, wire, paseo] = await Promise.all([
    import(/* @vite-ignore */ join(baselineDir, 'service.ts')),
    import(/* @vite-ignore */ join(baselineDir, 'relay.ts')),
    import(/* @vite-ignore */ join(baselineDir, 'store.ts')),
    import(/* @vite-ignore */ join(baselineDir, 'wire.ts')),
    import(/* @vite-ignore */ join(baselineDir, 'adapter.ts')),
  ]);
  baseline = { Bridge: bridge.Bridge, TaskRelay: relay.TaskRelay, TaskStore: store.TaskStore, paseoWorkers: wire.paseoWorkers,
    PaseoAdapter: paseo.PaseoAdapter };
});
afterAll(() => { if (baselineDir) rmSync(baselineDir, { recursive: true, force: true }); });

type Item = { kind: 'user' | 'assistant'; id: string; text: string };

function setup(initialItems: Item[], version = current) {
  const dir = mkdtempSync(join(tmpdir(), 'wayroost-followups-'));
  roots.push(dir);
  const clock = { now: T0 };
  const hub = new EventHub();
  const sources = { hermes: new FakeHermes(), paseo: new FakePaseo() };
  const id = '00000000-0000-4000-8000-000000000077';
  const chat = (source: 'hermes' | 'paseo', cid: string): ConversationSummary => ({
    source, id: cid, title: 'Fixture', preview: 'Fixture', status: 'idle', pendingApprovals: 0,
    updatedAt: T0 - 60_000, project: { path: PROJECT, name: 'Demo project' },
  });
  const worker = chat('paseo', id);
  const hermesChat = chat('hermes', 'h1');
  const chats = [worker, hermesChat];
  vi.spyOn(sources.hermes, 'listConversations').mockImplementation(async () => chats.filter((c) => c.source === 'hermes'));
  vi.spyOn(sources.paseo, 'listConversations').mockImplementation(async () => chats.filter((c) => c.source === 'paseo'));
  const agent: Record<string, unknown> = { id, provider: 'demo', cwd: PROJECT, title: 'Fixture', createdAt: new Date(T0 - 60_000).toISOString(),
    updatedAt: new Date(T0 - 60_000).toISOString(), status: 'idle', pendingPermissions: [], labels: {},
    capabilities: { supportsStreaming: true }, requiresAttention: true, attentionReason: 'finished' };
  const paseo = new version.PaseoAdapter('ws://example.com', hub, log, 'fake-client', undefined, background);
  cleanups.push(() => {
    for (const mirror of (Reflect.get(paseo, 'mirrors') as Map<string, AgentTimelineMirror>).values()) mirror.close();
  });
  Object.assign(paseo, { agents: new Map([[id, agent]]), listLoaded: true, statusValue: { source: 'paseo', state: 'connected' } });
  const items: Item[] = [...initialItems];
  const evidence = version === current ? vi.spyOn(paseo, 'readWorkerConversation') : vi.fn();
  evidence.mockImplementation(async () => ({
    conversation: (await paseo.listConversations())[0]!, items: [...items], approvals: [],
    userMessageIds: items.filter((item) => item.kind === 'user').map((item) => item.id),
    userMessages: items.filter((item) => item.kind === 'user').map((item) => ({ id: item.id, turnId: 'fake-turn' })),
    completionTurnId: 'fake-turn', subsequentTurnIds: [],
  }));
  const workers = version.paseoWorkers(paseo);
  const s = {
    dir, clock, hub, sources, id, worker, chats, agent, paseo, items, workers, evidence,
    store: undefined as unknown as TaskStore, bridge: undefined as unknown as Bridge, relay: undefined as unknown as TaskRelay,
    boot() {
      s.store = new version.TaskStore(dir, () => clock.now, undefined, log);
      s.bridge = new version.Bridge({ stateDir: dir, sources, hub, background, log, pollMs: 0, now: () => clock.now } as never);
      s.relay = new version.TaskRelay({ store: s.store, bridge: s.bridge, workers, setting: new WorkerUpdatesSetting(dir), hub, background, log,
        tickMs: 0, now: () => clock.now,
        chats: { connected: () => true, rows: async () => [], find: async () => hermesChat, origin: async () => 'tui' } } as never);
      s.relay.start();
    },
    shutdown() { s.relay.stop(); s.bridge.stop(); },
    see() { s.relay.consider(workers.workerSnapshot(id)!, clock.now); },
    run() { agent.status = 'running'; agent.requiresAttention = false; worker.status = 'running'; },
    finish() { agent.status = 'idle'; agent.requiresAttention = true; agent.attentionReason = 'finished'; worker.status = 'idle'; },
    send: (text: string) => s.bridge.call('send_message', { chat: `paseo:${id}`, text }, { hermesSession: 'h1', cwd: PROJECT }),
    report() {
      const t = s.store.get(id)!;
      return { round: t.round, status: t.status, relays: t.relays.map((r) => r.id) };
    },
  };
  s.boot();
  s.store.recordBridgeStart(id, 'h1', T0 - 60_000);
  s.see();
  s.store.get(id)!.relays.push({ id: 'finished#1', kind: 'update', attempts: 1, deliveredAt: T0 });
  s.store.save();
  cleanups.push(() => s.shutdown());
  return s;
}

async function drain(s: ReturnType<typeof setup>) {
  // The owner's or a bridge run finishes; the relay's grace passes.
  s.clock.now += 1_000; s.finish(); s.see(); await s.relay.tick();
  s.clock.now += 120_001; await s.relay.tick(); await s.relay.tick();
  // Many more ticks over the next 6 hours (worker idle).
  for (let i = 0; i < 24; i++) { s.clock.now += 15 * 60_000; s.see(); await s.relay.tick(); }
}

it('preserves unheld completion quotes beyond the stored tail with the existing subscription', async () => {
  const scenario = async (version: typeof current) => {
    const s = setup([], version);
    s.evidence.mockRestore();
    const timestamp = new Date(T0).toISOString();
    const history: FetchAgentTimelinePayload['entries'] = [{
      seqStart: 1, seqEnd: 1, timestamp, provider: 'demo', sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [],
      item: { type: 'assistant_message', text: 'Fixture result before tool output' },
    }];
    const subscribe = vi.fn(() => Object.assign(vi.fn(), { ready: Promise.resolve() }));
    const client = {
      subscribeAgentTimeline: subscribe,
      fetchAgent: vi.fn(async () => ({ agent: s.agent })),
      fetchAgentTimeline: vi.fn(async () => ({
        epoch: 'fake-epoch', entries: history.slice(-120),
        startCursor: { epoch: 'fake-epoch', seq: history[0]!.seqStart },
        endCursor: { epoch: 'fake-epoch', seq: history.at(-1)!.seqEnd },
      })),
    };
    Reflect.set(s.paseo, 'client', client);
    const detail = await s.paseo.getConversation(s.id);
    expect(detail.items).toContainEqual(expect.objectContaining({ kind: 'assistant', text: 'Fixture result before tool output' }));
    const mirror = (Reflect.get(s.paseo, 'mirrors') as Map<string, AgentTimelineMirror>).get(s.id)!;
    cleanups.push(() => mirror.close());
    s.clock.now += 1_000; s.run(); s.see();
    for (let seq = 2; seq <= 122; seq++) {
      const item = { type: 'tool_call' as const, callId: `fake-call-${seq}`, name: 'demo', status: 'completed' as const,
        error: null, detail: { type: 'unknown' as const, input: null, output: null } };
      history.push({ seqStart: seq, seqEnd: seq, timestamp, provider: 'demo', sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], item });
      mirror.handleLive({ agentId: s.id, epoch: 'fake-epoch', seq, timestamp, event: { type: 'timeline', provider: 'demo', item } });
    }
    expect(mirror.loaded).toBe(true);
    expect(history.slice(-120).some((row) => row.item.type === 'assistant_message')).toBe(false);
    expect(await s.workers.lastMessage(s.id)).toBe('Fixture result before tool output');
    const relayed = vi.spyOn(s.sources.hermes, 'sendMessage');
    await drain(s); await s.bridge.deliverQueued();
    expect(s.store.get(s.id)!.relays.find((relay) => relay.id === 'finished#2')?.deliveredAt).toBeDefined();
    expect(relayed.mock.calls[0]![1]).toContain('> Fixture result before tool output');
    expect(subscribe).toHaveBeenCalledOnce();
    expect(client.fetchAgentTimeline).toHaveBeenCalledOnce();
    s.shutdown();
    return relayed.mock.calls;
  };
  expect(await scenario(current)).toEqual(await scenario(baseline));
});

it.each([false, true].flatMap((newer) => [false, true].map((failure) => ({ newer, failure }))))(
  'preserves unheld quotes without opening the worker, newer quote: $newer, failed catch-up: $failure', async ({ newer, failure }) => {
  const scenario = async (version: typeof current) => {
    const s = setup([], version);
    s.evidence.mockRestore();
    const timestamp = new Date(T0).toISOString();
    const history: FetchAgentTimelinePayload['entries'] = [];
    const append = (item: FetchAgentTimelinePayload['entries'][number]['item']) => {
      const seq = history.length + 1;
      history.push({ seqStart: seq, seqEnd: seq, timestamp, provider: 'demo',
        sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], item });
      const mirror = (Reflect.get(s.paseo, 'mirrors') as Map<string, AgentTimelineMirror>).get(s.id);
      mirror?.handleLive({ agentId: s.id, epoch: 'fake-epoch', seq, timestamp, event: { type: 'timeline', provider: 'demo', item } });
    };
    append({ type: 'assistant_message', text: 'Earlier fixture result' });
    const subscribe = vi.fn(() => Object.assign(vi.fn(), { ready: Promise.resolve() }));
    const client = {
      subscribeAgentTimeline: subscribe,
      fetchAgent: vi.fn(async () => ({ agent: s.agent })),
      fetchAgentTimeline: vi.fn(async (_id: string, options: { direction: string; cursor?: { seq: number } }) => ({ epoch: 'fake-epoch',
        entries: options.direction === 'after' ? history.filter((entry) => entry.seqEnd > options.cursor!.seq) : history.slice(-120),
        startCursor: { epoch: 'fake-epoch', seq: history[0]!.seqStart },
        endCursor: { epoch: 'fake-epoch', seq: history.at(-1)!.seqEnd },
      })),
    };
    Reflect.set(s.paseo, 'client', client);
    const relayed = vi.spyOn(s.sources.hermes, 'sendMessage');
    expect((Reflect.get(s.paseo, 'mirrors') as Map<string, AgentTimelineMirror>).size).toBe(0);
    s.clock.now += 1_000; s.run(); s.see(); await drain(s); await s.bridge.deliverQueued();
    expect(relayed.mock.calls).toHaveLength(1);
    expect(relayed.mock.calls[0]![1]).toContain('> Earlier fixture result');
    s.clock.now += 1_000; s.run(); s.see();
    append({ type: 'user_message', text: 'Later fixture prompt', clientMessageId: 'fake-later-prompt' });
    if (newer) append({ type: 'assistant_message', text: 'Latest fixture result' });
    for (let n = 0; n < 121; n++) append({ type: 'tool_call', callId: `fake-call-${n}`, name: 'demo',
      status: 'completed', error: null, detail: { type: 'unknown', input: null, output: null } });
    expect(history.slice(-120).some((row) => row.item.type === 'assistant_message')).toBe(false);
    if (failure) {
      client.fetchAgentTimeline.mockRejectedValueOnce(new Error('Fixture catch-up timeout'));
      const mirror = (Reflect.get(s.paseo, 'mirrors') as Map<string, AgentTimelineMirror>).get(s.id);
      if (mirror) await expect(mirror.catchUp()).rejects.toThrow('Fixture catch-up timeout');
    }
    await drain(s); await s.bridge.deliverQueued();
    expect(relayed.mock.calls).toHaveLength(2);
    expect(relayed.mock.calls[1]![1]).toContain(newer ? '> Latest fixture result' : '> Earlier fixture result');
    expect(s.store.get(s.id)).toMatchObject({ round: 3, status: 'finished' });
    expect(s.store.get(s.id)!.relays.every((relay) => relay.deliveredAt !== undefined)).toBe(true);
    s.shutdown();
    return relayed.mock.calls;
  };
  expect(await scenario(current)).toEqual(await scenario(baseline));
});

it.each([false, true].flatMap((archived) => [false, true].flatMap((listed) =>
  [false, true].map((loaded) => ({ archived, listed, loaded })))))(
  'preserves unheld quote opening with archived: $archived, listed: $listed, loaded: $loaded', async ({ archived, listed, loaded }) => {
    const scenario = async (version: typeof current) => {
      const s = setup([], version);
      s.evidence.mockRestore();
      s.agent.capabilities = { supportsStreaming: loaded };
      if (archived) s.agent.archivedAt = new Date(T0).toISOString();
      if (!listed) (Reflect.get(s.paseo, 'agents') as Map<string, unknown>).delete(s.id);
      const subscribe = vi.fn(() => Object.assign(vi.fn(), { ready: Promise.resolve() }));
      const read = vi.fn(async () => ({ agent: s.agent, epoch: 'fake-epoch', entries: [{
        seqStart: 1, seqEnd: 1, timestamp: new Date(T0).toISOString(), provider: 'demo',
        sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [],
        item: { type: 'assistant_message', text: 'Fixture completion' },
      }], startCursor: { epoch: 'fake-epoch', seq: 1 }, endCursor: { epoch: 'fake-epoch', seq: 1 } }));
      Reflect.set(s.paseo, 'client', { fetchAgent: async () => ({ agent: s.agent }),
        fetchAgentTimeline: read, subscribeAgentTimeline: subscribe });
      const result = await s.workers.lastMessage(s.id);
      s.shutdown();
      return { result, reads: read.mock.calls.length, subscriptions: subscribe.mock.calls.length,
        listed: (Reflect.get(s.paseo, 'agents') as Map<string, unknown>).has(s.id) };
    };
    const expected = await scenario(baseline);
    expect(expected.result).toBe('Fixture completion');
    const actual = await scenario(current);
    if (archived && !loaded) expect(actual).toEqual({ result: undefined, reads: 0, subscriptions: 0, listed });
    else expect(actual).toEqual(expected);
  },
);

it('preserves the unheld relay quote after an archived worker is viewed twice', async () => {
  const scenario = async (version: typeof current) => {
    const s = setup([], version);
    s.evidence.mockRestore();
    let resumes = 0;
    const client = {
      fetchAgent: vi.fn(async () => ({ agent: s.agent })),
      subscribeAgentTimeline: vi.fn(() => Object.assign(vi.fn(), { ready: Promise.resolve() })),
      fetchAgentTimeline: vi.fn(async () => {
        if (!(s.agent.capabilities as { supportsStreaming: boolean }).supportsStreaming) {
          resumes++;
          s.agent.capabilities = { supportsStreaming: true };
        }
        return { agent: s.agent, epoch: 'fake-epoch', entries: [{ seqStart: 1, seqEnd: 1,
          timestamp: new Date(T0).toISOString(), provider: 'demo', sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [],
          item: { type: 'assistant_message', text: 'Fixture result' } }],
          startCursor: { epoch: 'fake-epoch', seq: 1 }, endCursor: { epoch: 'fake-epoch', seq: 1 } };
      }),
    };
    Reflect.set(s.paseo, 'client', client);
    const sent = vi.spyOn(s.sources.hermes, 'sendMessage');
    s.run(); s.see();
    s.clock.now += 1_000; s.finish(); s.see();
    s.agent.archivedAt = new Date(s.clock.now).toISOString();
    s.agent.capabilities = { supportsStreaming: false };
    const remove = () => Reflect.get(s.paseo, 'onAgentUpdate').call(s.paseo, { kind: 'remove', agentId: s.id });
    remove();
    await s.paseo.getConversation(s.id);
    // Loading archived history emits another removal; the next view finds it loaded.
    remove();
    await s.paseo.getConversation(s.id);
    expect(s.workers.workerSnapshot(s.id)).toMatchObject({ loaded: true });
    client.fetchAgentTimeline.mockClear();
    for (let tick = 0; tick < 10; tick++) { s.clock.now += 15_000; await s.relay.tick(); await s.bridge.deliverQueued(); }
    expect(resumes).toBe(1);
    expect(client.fetchAgentTimeline).not.toHaveBeenCalled();
    expect(sent).toHaveBeenCalledOnce();
    const result = { sent: sent.mock.calls, task: structuredClone(s.store.get(s.id)), resumes };
    s.shutdown();
    return result;
  };
  const expected = await scenario(baseline);
  expect(expected.sent[0]![1]).toContain('> Fixture result');
  expect(await scenario(current)).toEqual(expected);
});

it('preserves unheld idle cadence after a follow-up worker is deleted', async () => {
  const scenario = async (version: typeof current) => {
    const s = setup([], version);
    vi.spyOn(s.sources.paseo, 'sendMessage').mockImplementation(async (_id, text) => {
      s.items.push({ kind: 'user', id: 'fake-followup', text }); s.run();
      return { messageId: 'fake-followup' } as never;
    });
    await s.send('Fixture follow-up');
    s.clock.now += 1_000; s.see(); await s.relay.tick();
    Reflect.get(s.paseo, 'agents').delete(s.id);
    vi.spyOn(s.workers, 'lookUp').mockResolvedValue(null);
    const read = s.evidence.mockResolvedValue(undefined);
    const idle = async () => {
      for (let i = 0; i < 40; i++) { s.clock.now += 15_000; await s.relay.tick(); await s.bridge.deliverQueued(); }
    };
    await idle();
    const result = structuredClone(s.store.get(s.id));
    expect(result).toMatchObject({ round: 2, status: 'stopped' });
    expect(result!.relays.every((relay) => relay.deliveredAt !== undefined)).toBe(true);
    read.mockClear(); await idle(); expect(read).not.toHaveBeenCalled();
    s.shutdown(); s.boot(); await s.relay.tick();
    read.mockClear(); await idle(); expect(read).not.toHaveBeenCalled();
    s.clock.now += 16 * 24 * 60 * 60_000; await s.relay.tick();
    expect(s.store.get(s.id)).toBeUndefined();
    read.mockClear(); await idle(); expect(read).not.toHaveBeenCalled();
    s.shutdown();
    return result;
  };
  expect(await scenario(current)).toEqual(await scenario(baseline));
});

it('a failed immediate submission must not freeze the task for a later run', async () => {
  const s = setup([{ kind: 'user', id: 'm1', text: 'Earlier fixture prompt' }]);
  vi.spyOn(s.sources.paseo, 'sendMessage').mockRejectedValueOnce(new Error('fixture backend failure'));
  await expect(s.send('Fixture follow-up')).rejects.toThrow();
  // The owner then starts a run from the app (outside the bridge).
  s.clock.now += 1_000; s.items.push({ kind: 'user', id: 'm-owner', text: 'Owner fixture message' }); s.run(); s.see();
  await s.relay.tick();
  await drain(s);
  expect(s.report()).toMatchObject({ round: 2, status: 'finished' });
  expect(s.report().relays).toContain('finished#2');
});

it('keeps the baseline readiness decision before a restart', async () => {
  const s = setup([{ kind: 'user', id: 'm1', text: 'Earlier fixture prompt' }]);
  // A third readiness read would see another client start the recipient.
  const list = vi.mocked(s.sources.paseo.listConversations);
  let calls = 0;
  list.mockImplementation(async () => { calls++; if (calls === 3) s.worker.status = 'running'; return s.chats.filter((c) => c.source === 'paseo'); });
  expect(await s.send('Fixture follow-up')).toMatchObject({ delivered: 'now' });
  list.mockImplementation(async () => s.chats.filter((c) => c.source === 'paseo'));
  s.worker.status = 'idle';
  // After a restart the owner starts a run from the app.
  s.shutdown(); s.boot();
  s.clock.now += 1_000; s.items.push({ kind: 'user', id: 'm-owner', text: 'Owner fixture message' }); s.run(); s.see();
  await s.relay.tick();
  await drain(s);
  expect(s.report()).toMatchObject({ round: 2, status: 'finished' });
  expect(s.report().relays).toContain('finished#2');
});

it.each(['restart', 'reconnect', 'restart, long run'] as const)(
  'a delivered follow-up is reconciled after %s', async (kind) => {
    // A long first run: the 120-row tail holds no user message (except in the long-run variant).
    const s = setup(kind === 'restart, long run' ? [{ kind: 'user', id: 'm1', text: 'Earlier fixture prompt' }]
      : [{ kind: 'assistant', id: 'a1', text: 'Fixture tool output' }]);
    vi.spyOn(s.sources.paseo, 'sendMessage').mockImplementation(async (_id, text) => {
      s.items.push({ kind: 'user', id: 'm2', text });
      s.run();
    });
    expect(await s.send('Fixture follow-up')).toMatchObject({ delivered: 'now' });
    if (kind === 'reconnect') {
      Object.assign(s.paseo, { statusValue: { source: 'paseo', state: 'disconnected' } });
      Object.assign(s.paseo, { statusValue: { source: 'paseo', state: 'connected' } });
    }
    s.clock.now += 1_000; s.see(); // running observed through the hub
    if (kind !== 'reconnect') { s.shutdown(); s.boot(); } // a graceful restart before the next 15 s tick
    if (kind === 'restart, long run') s.items.splice(0, s.items.length, { kind: 'assistant', id: 'a-tail', text: 'Fixture tool output' });
    s.clock.now += 15_000; s.see(); await s.relay.tick();
    await drain(s);
    expect(s.report()).toMatchObject({ round: 2, status: 'finished' });
    expect(s.report().relays).toContain('finished#2');
  });

it('two quick follow-ups before a tick keep their own rounds', async () => {
  const s = setup([{ kind: 'user', id: 'm1', text: 'Earlier fixture prompt' }]);
  let n = 1;
  vi.spyOn(s.sources.paseo, 'sendMessage').mockImplementation(async (_id, text) => {
    s.items.push({ kind: 'user', id: `m${++n}`, text });
    s.run();
  });
  expect(await s.send('Fixture follow-up one')).toMatchObject({ delivered: 'now' });
  s.clock.now += 1_000; s.see();
  s.clock.now += 1_000; s.finish(); s.see();
  s.clock.now += 10_000;
  expect(await s.send('Fixture follow-up two')).toMatchObject({ delivered: 'now' });
  s.clock.now += 1_000; s.see();
  await drain(s);
  expect(s.report()).toMatchObject({ round: 3, status: 'finished' });
});

it.each(['restart', 'reconnect', 'successive', 'failed', 'readiness', 'expired', 'dropped'] as const)(
  'preserves unheld tracking, persistence and delivery through %s', async (kind) => {
    const scenario = async (version: typeof current) => {
      const s = setup([{ kind: 'user', id: 'm1', text: 'Earlier fixture message' }], version);
      const send = vi.spyOn(s.sources.paseo, 'sendMessage').mockImplementation(async (_id, text) => {
        s.items.push({ kind: 'user', id: `m${s.items.length + 1}`, text }); s.run();
      });
      const relaySend = vi.spyOn(s.sources.hermes, 'sendMessage');
      if (kind === 'failed') send.mockRejectedValueOnce(new Error('fixture failure'));
      if (kind === 'expired' || kind === 'dropped') s.worker.status = 'running';
      if (kind === 'readiness') {
        let reads = 0;
        vi.mocked(s.sources.paseo.listConversations).mockImplementation(async () => {
          if (++reads === 2) s.worker.status = 'running';
          return s.chats.filter((chat) => chat.source === 'paseo');
        });
      }
      let outcome: unknown;
      try { outcome = await s.send('Fixture follow-up'); } catch { outcome = 'failed'; }
      if (kind === 'restart') { s.see(); s.shutdown(); s.boot(); }
      if (kind === 'reconnect') {
        Object.assign(s.paseo, { listLoaded: false, statusValue: { source: 'paseo', state: 'disconnected' } });
        Object.assign(s.paseo, { listLoaded: true, statusValue: { source: 'paseo', state: 'connected' } });
      }
      if (kind === 'expired') { s.clock.now += 61 * 60_000; await s.bridge.deliverQueued(); }
      if (kind === 'dropped') {
        s.bridge.setPaused(true); s.shutdown(); s.boot();
      }
      s.clock.now += 1_000; s.run(); s.see();
      if (kind === 'successive') {
        s.clock.now += 1_000; s.finish(); s.see();
        s.clock.now += 10_000; await s.send('Another fixture follow-up');
        s.clock.now += 1_000; s.see();
      }
      await drain(s);
      s.worker.status = 'idle';
      s.clock.now += 10_000; await s.bridge.deliverQueued();
      const result = { outcome, task: structuredClone(s.store.get(s.id)),
        sent: send.mock.calls, relayed: relaySend.mock.calls,
        persisted: JSON.parse(readFileSync(join(s.dir, 'tasks.json'), 'utf8')) };
      s.shutdown();
      return result;
    };
    expect(await scenario(current)).toEqual(await scenario(baseline));
  },
);

it.each(['restart', 'reconnect'] as const)('holds relays without a verified epoch after %s while tracking the round normally', async (kind) => {
  const s = setup([{ kind: 'user', id: 'm1', text: 'Earlier fixture message' }]);
  vi.spyOn(s.sources.paseo, 'sendMessage').mockImplementation(async (_id, text) => {
    s.items.push({ kind: 'user', id: 'm2', text }); s.run();
  });
  await s.send('Fixture follow-up');
  if (kind === 'restart') { s.shutdown(); s.boot(); }
  else Object.assign(s.paseo, { statusValue: { source: 'paseo', state: 'connected' } });
  s.bridge.maintenanceHold(s.dir).set(true);
  const deliver = vi.spyOn(s.bridge, 'deliverSystem');
  s.clock.now += 1_000; s.see();
  await drain(s);
  expect(s.report()).toMatchObject({ round: 2, status: 'finished' });
  expect(deliver.mock.results.some((result) => result.type === 'throw' && result.value.code === 'maintenance')).toBe(true);
  expect(s.relay.quietCounts().pendingRelays).toBeGreaterThan(0);
  expect(s.bridge.quietCounts().queuedMessages).toBe(0);
});

it.each([false, true])('never resubmits after an admission acknowledgment callback fails while queued: %s', async (queued) => {
  const s = setup([{ kind: 'user', id: 'm1', text: 'Earlier fixture message' }]);
  const send = vi.spyOn(s.sources.paseo, 'sendMessage');
  s.bridge.watch({ sending: () => ({ acknowledged: () => { throw new Error('Fixture storage failure'); }, failed() {} }) });
  if (queued) s.worker.status = 'running';
  expect(await s.send('Fixture follow-up')).toMatchObject({ delivered: queued ? 'queued' : 'now' });
  s.worker.status = 'idle';
  for (let i = 0; i < 5; i++) { s.clock.now += 10_000; await s.bridge.deliverQueued(); }
  expect(send).toHaveBeenCalledTimes(1);
  expect(s.bridge.quietCounts().queuedMessages).toBe(0);
});

it.each([false, true].flatMap((archived) => ['error', 'closed'].map((status) => ({ archived, status }))))(
  'preserves a $status follow-up after restart with archived: $archived', async ({ archived, status }) => {
    const scenario = async (version: typeof current) => {
      const s = setup([{ kind: 'user', id: 'm1', text: 'Earlier fixture message' }], version);
      vi.spyOn(s.sources.paseo, 'sendMessage').mockImplementation(async (_id, text) => {
        s.items.push({ kind: 'user', id: 'm2', text }); s.run();
      });
      await s.send('Fixture follow-up');
      s.clock.now += 1_000; s.see();
      s.shutdown(); s.boot();
      s.agent.status = status;
      s.worker.status = 'error';
      const snapshot = s.workers.workerSnapshot(s.id)!;
      if (archived) {
        (Reflect.get(s.paseo, 'agents') as Map<string, unknown>).delete(s.id);
        vi.spyOn(s.workers, 'lookUp').mockResolvedValue(snapshot);
      }
      s.clock.now += 1_000; await s.relay.tick();
      s.clock.now += 120_001; await s.relay.tick();
      const result = structuredClone(s.store.get(s.id)!);
      expect(result).toMatchObject({ round: 2, status: status === 'error' ? 'failed' : 'stopped' });
      expect(result.relays.map((relay) => relay.id)).toContain(`${result.status}#2`);
      s.shutdown();
      return result;
    };
    expect(await scenario(current)).toEqual(await scenario(baseline));
  },
);

it.each([false, true])('passes exact submission identity through bridge delivery while queued: %s', async (queued) => {
  const s = setup([{ kind: 'user', id: 'm1', text: 'Earlier fixture message' }]);
  const hold = s.bridge.maintenanceHold(s.dir);
  vi.spyOn(s.sources.paseo, 'sendMessage').mockImplementation(async (_id, text) => {
    s.items.push({ kind: 'user', id: 'submitted-message', text });
    s.run();
    return { messageId: 'submitted-message' } as never;
  });
  if (queued) s.worker.status = 'running';
  expect(await s.send('Fixture follow-up')).toMatchObject({ delivered: queued ? 'queued' : 'now' });
  if (queued) {
    s.worker.status = 'idle';
    s.clock.now += 10_000;
    await s.bridge.deliverQueued();
  }
  hold.set(true);
  s.clock.now += 1_000; s.see();
  await s.relay.tick();
  const deliver = vi.spyOn(s.bridge, 'deliverSystem');
  await drain(s);
  expect(s.report()).toMatchObject({ round: 2, status: 'finished' });
  expect(deliver.mock.calls.some(([message]) => message.key.endsWith('finished#2') && message.admissionEpoch === 0)).toBe(true);
  expect(s.bridge.quietCounts().queuedMessages).toBe(1);
});

it.each([false, true])('refuses an owner round repeating an unobserved follow-up with an identity receipt: %s', async (receipt) => {
  const s = setup([{ kind: 'user', id: 'm1', text: 'Earlier fixture message' }]);
  let envelope = '';
  vi.spyOn(s.sources.paseo, 'sendMessage').mockImplementation(async (_id, text) => {
    envelope = text;
    s.items.push({ kind: 'user', id: 'submitted-message', text });
    // This run finishes before task telemetry observes it.
    if (receipt) return { messageId: 'submitted-message' } as never;
  });
  const hold = s.bridge.maintenanceHold(s.dir);
  await s.send('Fixture follow-up');
  hold.set(true);
  s.items.push({ kind: 'user', id: 'owner-message', text: envelope });
  s.run(); s.see();
  await s.relay.tick();
  const deliver = vi.spyOn(s.bridge, 'deliverSystem');
  await drain(s);
  expect(s.report()).toMatchObject({ round: 2, status: 'finished' });
  expect(deliver.mock.results.some((result) => result.type === 'throw' && result.value.code === 'maintenance')).toBe(true);
  expect(s.bridge.quietCounts().queuedMessages).toBe(0);
  expect(s.relay.quietCounts().pendingRelays).toBeGreaterThan(0);
  expect(JSON.parse(readFileSync(join(s.dir, 'task-admissions.json'), 'utf8')).pending).toEqual([]);
});

it('revokes both unresolved follow-ups when the first production worker read reconnects', async () => {
  const s = setup([{ kind: 'user', id: 'm1', text: 'Earlier fixture message' }]);
  const secondId = '00000000-0000-4000-8000-000000000078';
  const secondAgent: Record<string, unknown> = { ...s.agent, id: secondId };
  const secondChat = { ...s.worker, id: secondId };
  const agents = Reflect.get(s.paseo, 'agents') as Map<string, unknown>;
  agents.set(secondId, secondAgent);
  s.chats.push(secondChat);
  s.store.recordBridgeStart(secondId, 'h1', T0 - 60_000);
  s.relay.consider(s.workers.workerSnapshot(secondId)!, s.clock.now);
  s.store.get(secondId)!.relays.push({ id: 'finished#1', kind: 'update', attempts: 1, deliveredAt: T0 });
  const messages = new Map<string, Item[]>();
  vi.spyOn(s.sources.paseo, 'sendMessage').mockImplementation(async (id, text) => {
    messages.set(id, [{ kind: 'user', id: `submitted-${id}`, text }]);
    return { messageId: `submitted-${id}` } as never;
  });
  const hold = s.bridge.maintenanceHold(s.dir);
  await s.send('First fixture follow-up');
  await s.bridge.call('send_message', { chat: `paseo:${secondId}`, text: 'Second fixture follow-up' },
    { hermesSession: 'h1', cwd: PROJECT });
  s.run(); s.see();
  secondAgent.status = 'running'; secondAgent.requiresAttention = false; secondChat.status = 'running';
  s.relay.consider(s.workers.workerSnapshot(secondId)!, s.clock.now);
  let reads = 0;
  const status = vi.fn();
  s.hub.observe((event) => { if (event.type === 'source_status') status(event.status.state); });
  s.evidence.mockImplementation(async (id: string) => {
    if (++reads === 1) {
      const change = Reflect.get(s.paseo, 'setStatus').bind(s.paseo) as (state: string) => void;
      change('disconnected'); change('connected');
    }
    return { conversation: (await s.paseo.listConversations()).find((c) => c.id === id)!,
      items: messages.get(id)!, userMessageIds: messages.get(id)!.filter((item) => item.kind === 'user').map((item) => item.id),
      userMessages: messages.get(id)!.filter((item) => item.kind === 'user').map((item) => ({ id: item.id, turnId: 'fake-turn' })),
      completionTurnId: 'fake-turn', subsequentTurnIds: [], approvals: [] };
  });
  hold.set(true);
  await s.relay.tick();
  expect(reads).toBe(1);
  expect(status.mock.calls).toEqual([['disconnected'], ['connected']]);
  hold.set(true);
  await s.relay.tick();
  const deliver = vi.spyOn(s.bridge, 'deliverSystem');
  await drain(s);
  expect(s.store.get(secondId)).toMatchObject({ round: 2, status: 'running' });
  secondAgent.status = 'idle'; secondAgent.requiresAttention = true; secondChat.status = 'idle';
  s.relay.consider(s.workers.workerSnapshot(secondId)!, s.clock.now);
  s.clock.now += 120_001;
  await s.relay.tick();
  expect(s.report()).toMatchObject({ round: 2, status: 'finished' });
  expect(s.store.get(secondId)).toMatchObject({ round: 2, status: 'finished' });
  expect(deliver.mock.calls.filter(([message]) => message.key.endsWith('finished#2')).every(([message]) => message.admissionEpoch === undefined)).toBe(true);
  expect(s.relay.quietCounts().pendingRelays).toBe(2);
  expect(s.bridge.quietCounts().queuedMessages).toBe(0);
});


it.each(['launch', 'follow-up'].flatMap((admission) => ['plain', 'restart', 'reconnect', 'long stream', 'long stream restart', 'long stream reconnect', 'stored finished', 'stored running', 'deleted', 'deleted restart', 'disabled provider', 'disabled provider reconnect', 'retained expiry'].map((state) => ({ admission, state }))))(
  'preserves unheld daemon calls and tracking for a $admission after $state', async ({ admission, state }) => {
    const scenario = async (version: typeof current) => {
      const s = setup([], version);
      s.evidence.mockRestore();
      let resumes = 0;
      const client = {
        subscribeAgentTimeline: vi.fn(() => Object.assign(vi.fn(), { ready: Promise.resolve() })),
        fetchAgent: vi.fn(async () => {
          if (state.startsWith('deleted')) return null;
          return { agent: s.agent };
        }),
        fetchAgentTimeline: vi.fn(async () => {
          if (state.startsWith('disabled provider') || state === 'retained expiry') throw new Error('Agent references unavailable provider demo');
          if (s.agent.capabilities && !(s.agent.capabilities as { supportsStreaming: boolean }).supportsStreaming) {
            resumes++;
            for (const status of ['initializing', 'idle']) Reflect.get(s.paseo, 'onAgentUpdate').call(s.paseo,
              { kind: 'upsert', agent: { ...s.agent, status, capabilities: { supportsStreaming: true } } });
            s.agent.status = 'idle';
            s.agent.capabilities = { supportsStreaming: true };
          }
          return { epoch: 'fake-epoch', entries: state.startsWith('long stream') ? Array.from({ length: 300 }, (_, seq) => ({
            seqStart: seq + 1, seqEnd: seq + 1, timestamp: new Date(T0).toISOString(), turnId: 'fake-turn',
            item: { type: 'assistant_message', text: 'Fixture stream' },
          })).slice(-120) : [{ seqStart: 1, seqEnd: 1,
            timestamp: new Date(T0).toISOString(), turnId: 'fake-turn', item: { type: 'user_message', text: 'Fixture', clientMessageId: 'fake-message' } }],
            startCursor: { epoch: 'fake-epoch', seq: 1 }, endCursor: { epoch: 'fake-epoch', seq: 1 } };
        }),
      };
      Reflect.set(s.paseo, 'client', client);
      const sent = vi.spyOn(s.sources.hermes, 'sendMessage');
      if (admission === 'follow-up') {
        vi.spyOn(s.sources.paseo, 'sendMessage').mockImplementation(async () => { s.run(); return { messageId: 'fake-message' } as never; });
        await s.send('Fixture follow-up'); s.see();
      } else {
        s.run(); s.see();
        if (version === current) Reflect.get(s.relay, 'admissions').started(s.id, 0, 'fake-message', s.workers.revision);
      }
      if (state === 'stored finished') { s.finish(); s.see(); }
      if (state.startsWith('stored') || state.startsWith('disabled provider') || state === 'retained expiry') s.agent.capabilities = { supportsStreaming: false };
      if (state.startsWith('deleted')) Reflect.get(s.paseo, 'agents').delete(s.id);
      if (state.includes('restart') || state.startsWith('stored') || state.startsWith('disabled provider')) { s.shutdown(); s.boot(); }
      if (state.includes('reconnect')) Reflect.set(s.paseo, 'statusValue', { source: 'paseo', state: 'connected' });
      if (state === 'retained expiry') { s.finish(); s.see(); Reflect.get(s.paseo, 'agents').delete(s.id); s.clock.now += 16 * 24 * 3600_000; }
      const calls: Array<{ fetch: number; timeline: number; subscribe: number }> = [];
      for (let tick = 0; tick < 40; tick++) {
        client.fetchAgent.mockClear(); client.fetchAgentTimeline.mockClear(); client.subscribeAgentTimeline.mockClear();
        s.clock.now += 15_000;
        await s.relay.tick(); await s.bridge.deliverQueued();
        calls.push({ fetch: client.fetchAgent.mock.calls.length, timeline: client.fetchAgentTimeline.mock.calls.length,
          subscribe: client.subscribeAgentTimeline.mock.calls.length });
      }
      const result = { calls, resumes, task: structuredClone(s.store.get(s.id)), sent: sent.mock.calls };
      if (state === 'retained expiry') expect(result.task).toBeUndefined();
      s.shutdown();
      return result;
    };
    const expected = await scenario(baseline);
    expect(expected.resumes).toBe(0);
    expect(await scenario(current)).toEqual(expected);
  },
);
