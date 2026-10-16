import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConversationSummary } from '../../shared/protocol.js';
import { buildApp } from '../src/app.js';
import { BackgroundGate } from '../src/background.js';
import { quietReport } from '../src/bridge/quiet.js';
import { Bridge } from '../src/bridge/service.js';
import { DisabledHermes } from '../src/disabled.js';
import { EventHub } from '../src/hub.js';
import { PaseoAdapter } from '../src/paseo/adapter.js';
import type { PaseoSource } from '../src/sources.js';
import { TaskRelay } from '../src/tasks/relay.js';
import { WorkerUpdatesSetting } from '../src/tasks/setting.js';
import { TaskStore } from '../src/tasks/store.js';
import { paseoWorkers } from '../src/tasks/wire.js';
import { DESKTOP_COOKIE, EMAIL, FakeHermes, makeConfig, seedDevices } from './helpers.js';

const log = { info() {}, warn() {}, error() {} };
const background = new BackgroundGate('primary');
const T0 = 1_800_000_000_000;
const PROJECT = '/home/me/code/app';
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function setup(identity = true, launch = false) {
  const dir = mkdtempSync(join(tmpdir(), 'wayroost-drain-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const clock = { now: T0 };
  const hub = new EventHub();
  const hermes = new FakeHermes();
  const id = '00000000-0000-4000-8000-000000000077';
  const hermesChat: ConversationSummary = { source: 'hermes', id: 'fake-chat', title: 'Fixture', preview: '',
    status: 'idle', pendingApprovals: 0, updatedAt: T0 - 60_000, project: { path: PROJECT, name: 'Demo project' } };
  vi.spyOn(hermes, 'listConversations').mockResolvedValue([hermesChat]);
  const agent = { id, provider: 'demo', cwd: PROJECT, title: 'Fixture', createdAt: new Date(T0 - 60_000).toISOString(),
    updatedAt: new Date(T0 - 60_000).toISOString(), status: 'idle', pendingPermissions: [], labels: {},
    activeTurn: null as { turnId: string; startedAt: null } | null,
    capabilities: { supportsStreaming: true }, requiresAttention: true, attentionReason: 'finished' };
  const paseo = new PaseoAdapter('ws://example.com', hub, log, 'fake-client', undefined, background);
  Object.assign(paseo, { agents: new Map([[id, agent]]), listLoaded: true, statusValue: { source: 'paseo', state: 'connected' } });
  const messages = [{ text: 'Earlier fixture message', clientMessageId: 'fake-earlier-message' }];
  const client = {
    close: vi.fn(async () => {}),
    getLastServerInfoMessage: () => ({ features: { providerSubagents: true } }),
    listProviderSubagents: vi.fn(async () => ({ subagents: [] })),
    subscribeAgentTimeline: vi.fn(() => Object.assign(vi.fn(), { ready: Promise.resolve() })),
    createAgent: vi.fn(async (input: { initialPrompt: string; clientMessageId: string }) => {
      messages.splice(0, messages.length, { text: input.initialPrompt, clientMessageId: input.clientMessageId });
      agent.status = 'running'; agent.requiresAttention = false;
      agent.activeTurn = { turnId: `fake-turn-${input.clientMessageId}`, startedAt: null };
      return agent;
    }),
    fetchAgents: vi.fn(async () => ({ entries: [{ agent: { ...agent }, project: null }],
      pageInfo: { hasMore: false, nextCursor: null as string | null, prevCursor: null } })),
    sendAgentMessage: vi.fn(async (_id: string, text: string, options: { messageId: string }) => {
      messages.push({ text, clientMessageId: options.messageId });
      agent.status = 'running'; agent.requiresAttention = false;
      agent.activeTurn = { turnId: `fake-turn-${options.messageId}`, startedAt: null };
    }),
    fetchAgent: vi.fn(async () => ({ agent })),
    fetchAgentTimeline: vi.fn(async () => ({ epoch: 'fake-epoch', entries: messages.map((message, seq) => ({
      seqStart: seq + 1, seqEnd: seq + 1, turnId: `fake-turn-${message.clientMessageId}`, item: { type: 'user_message', ...message },
      timestamp: new Date(T0).toISOString(),
    })), startCursor: { epoch: 'fake-epoch', seq: 1 }, endCursor: { epoch: 'fake-epoch', seq: messages.length } })),
  };
  Reflect.set(paseo, 'client', client);
  cleanups.push(() => paseo.stop());
  vi.spyOn(paseo as unknown as { requireClient(): unknown }, 'requireClient').mockReturnValue(client);
  const sendMessage = paseo.sendMessage.bind(paseo);
  const source: PaseoSource = paseo;
  const receipts: unknown[] = [];
  vi.spyOn(source, 'sendMessage').mockImplementation(async (...args) => {
    const receipt = await sendMessage(...args);
    receipts.push(receipt);
    if (identity) return receipt;
  });
  const workers = paseoWorkers(paseo);
  const s = {
    dir, clock, hub, hermes, id, agent, paseo, client, workers, receipts,
    store: undefined as unknown as TaskStore, bridge: undefined as unknown as Bridge, relay: undefined as unknown as TaskRelay,
    boot() {
      s.store = new TaskStore(dir, () => clock.now, undefined, log);
      s.bridge = new Bridge({ stateDir: dir, sources: { hermes, paseo }, hub, background, log, pollMs: 0, now: () => clock.now });
      s.relay = new TaskRelay({ store: s.store, bridge: s.bridge, workers, setting: new WorkerUpdatesSetting(dir), hub,
        background, log, tickMs: 0, now: () => clock.now,
        chats: { connected: () => true, rows: async () => [], find: async () => hermesChat, origin: async () => 'tui' } });
      s.relay.start();
    },
    shutdown() { s.relay.stop(); s.bridge.stop(); },
    see() { s.relay.consider(workers.workerSnapshot(id)!, clock.now); },
    finish() { agent.status = 'idle'; agent.activeTurn = null; agent.requiresAttention = true; agent.attentionReason = 'finished'; },
    send: (text: string) => s.bridge.call('send_message', { chat: `paseo:${id}`, text }, { hermesSession: hermesChat.id, cwd: PROJECT }),
    report: () => quietReport({ hold: s.bridge.maintenanceHold(dir), sources: { hermes: new DisabledHermes(), paseo }, bridge: s.bridge, tasks: s.relay }),
    saved: () => JSON.parse(readFileSync(join(dir, 'task-admissions.json'), 'utf8')) as { pending: unknown[]; unavailable: boolean },
  };
  s.boot();
  if (!launch) {
    s.store.recordBridgeStart(id, hermesChat.id, T0 - 60_000);
    s.see();
    s.store.get(id)!.relays.push({ id: 'finished#1', kind: 'update', attempts: 1, deliveredAt: T0 });
    s.store.save();
  }
  cleanups.push(() => s.shutdown());
  return s;
}

async function settle(s: ReturnType<typeof setup>) {
  s.clock.now += 1_000; s.finish(); s.see(); await s.relay.tick();
  s.clock.now += 120_001; await s.relay.tick(); await s.relay.tick();
  for (let i = 0; i < 12; i++) { s.clock.now += 15 * 60_000; s.see(); await s.relay.tick(); await s.bridge.deliverQueued(); }
}

async function quietRoute(s: ReturnType<typeof setup>) {
  const config = makeConfig(undefined, { localListener: { port: 19014 }, origins: ['https://127.0.0.1:19014'] });
  const configDir = config.stateDir;
  cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));
  config.stateDir = s.dir;
  seedDevices(s.dir);
  const app = await buildApp({ config, sources: { hermes: new DisabledHermes(), paseo: s.paseo },
    bridge: s.bridge, tasks: s.relay, hub: s.hub, logger: false,
    verifier: async () => ({ email: EMAIL, exp: 2_000_000_000 }) });
  cleanups.push(() => app.close());
  app.addHook('onRequest', async (req) => {
    Object.defineProperty(req.raw.socket, 'localPort', { configurable: true, value: 19014 });
  });
  const headers = { host: '127.0.0.1:19014', origin: 'https://127.0.0.1:19014', cookie: DESKTOP_COOKIE,
    'x-wayroost-app': 'desktop', 'x-wayroost-request': '1' };
  return async () => {
    const response = await app.inject({ url: '/api/bridge/quiet', headers });
    expect(response.statusCode).toBe(200);
    return response.json();
  };
}

it.each(['control', 'identity', 'no identity'] as const)('certifies an idle, fully relayed install after restart: %s', async (kind) => {
  const s = setup(kind !== 'no identity');
  if (kind !== 'control') {
    expect(await s.send('Fixture follow-up')).toMatchObject({ delivered: 'now' });
    if (kind === 'identity') {
      expect(s.receipts).toEqual([{ messageId: s.client.sendAgentMessage.mock.calls[0]![2].messageId, items: [] }]);
      expect(s.saved().pending).toEqual([expect.objectContaining({
        messageId: s.client.sendAgentMessage.mock.calls[0]![2].messageId,
      })]);
    }
    s.clock.now += 1_000; s.see();
  }
  await settle(s);
  expect(s.store.get(s.id)).toMatchObject({ round: kind === 'control' ? 1 : 2, status: 'finished' });
  expect(s.store.get(s.id)!.relays.every((relay) => relay.deliveredAt !== undefined)).toBe(true);
  s.bridge.maintenanceHold(s.dir).set(true);
  for (let i = 0; i < 20; i++) { s.clock.now += 60 * 60_000; s.see(); await s.relay.tick(); }
  expect(await s.report()).toMatchObject({ held: true, quiet: true });
  if (kind !== 'control') expect(s.saved().pending).toEqual([]);
  s.shutdown(); s.boot();
  for (let i = 0; i < 20; i++) { s.clock.now += 60 * 60_000; s.see(); await s.relay.tick(); }
  expect(await s.report()).toMatchObject({ held: true, quiet: true });
  if (kind !== 'control') expect(s.saved().pending).toEqual([]);
});

function finishUnobserved(s: ReturnType<typeof setup>, attention: boolean) {
  s.agent.status = 'idle'; s.agent.requiresAttention = attention; s.agent.attentionReason = 'finished';
  s.agent.activeTurn = null;
  s.agent.updatedAt = new Date(s.clock.now + 60_000).toISOString();
}

it.each([true, false])('retires an unobserved completed follow-up after reconnect without restarting, with identity: %s', async (identity) => {
  const s = setup(identity);
  expect(await s.send('Fixture follow-up')).toMatchObject({ delivered: 'now' });
  const change = Reflect.get(s.paseo, 'setStatus').bind(s.paseo) as (state: string) => void;
  change('disconnected');
  finishUnobserved(s, true);
  change('connected');
  for (let i = 0; i < 24; i++) { s.clock.now += 60 * 60_000; s.see(); await s.relay.tick(); await s.bridge.deliverQueued(); }
  s.bridge.maintenanceHold(s.dir).set(true);
  for (let i = 0; i < 24; i++) { s.clock.now += 60 * 60_000; s.see(); await s.relay.tick(); }
  expect(await s.report()).toMatchObject({ held: true, quiet: true });
  expect(s.saved().pending).toEqual([]);
});

it('retires an unobserved completed follow-up with attention cleared and stops history reads', async () => {
  const s = setup();
  expect(await s.send('Fixture follow-up')).toMatchObject({ delivered: 'now' });
  finishUnobserved(s, false);
  for (let i = 0; i < 48; i++) { s.clock.now += 60 * 60_000; s.see(); await s.relay.tick(); }
  s.client.fetchAgentTimeline.mockClear();
  await s.relay.tick();
  s.bridge.maintenanceHold(s.dir).set(true);
  expect(s.client.fetchAgentTimeline).not.toHaveBeenCalled();
  await s.relay.tick();
  expect(await s.report()).toMatchObject({ quiet: true });
  expect(s.saved().pending).toEqual([]);
});

it('never grants an owner round started while held an epoch from an unobserved follow-up', async () => {
  const s = setup();
  expect(await s.send('Fixture follow-up')).toMatchObject({ delivered: 'now' });
  finishUnobserved(s, false);
  s.clock.now += 15_000; await s.relay.tick();
  s.bridge.maintenanceHold(s.dir).set(true);
  await s.client.sendAgentMessage(s.id, 'Owner fixture message', { messageId: 'owner-message' });
  s.clock.now += 1_000; s.see();
  const deliver = vi.spyOn(s.bridge, 'deliverSystem');
  await settle(s);
  const epochs = deliver.mock.calls.filter(([message]) => message.key.endsWith('finished#2')).map(([message]) => message.admissionEpoch);
  expect(s.store.get(s.id)).toMatchObject({ round: 2, status: 'finished' });
  expect(epochs.length).toBeGreaterThan(0);
  expect(epochs.every((epoch) => epoch === undefined)).toBe(true);
  expect(s.store.get(s.id)!.relays.find((relay) => relay.id === 'finished#2')?.deliveredAt).toBeUndefined();
  expect(await s.report()).toMatchObject({ held: true, quiet: false });
});

it.each([false, true])('idle ticks stop reading completion history after successive follow-ups retire with identity: %s', async (identity) => {
  const s = setup(identity);
  for (let n = 0; n < 5; n++) {
    expect(await s.send(`Fixture follow-up ${n}`)).toMatchObject({ delivered: 'now' });
    s.clock.now += 1_000; s.see(); await settle(s);
  }
  expect(s.store.get(s.id)).toMatchObject({ round: 6, status: 'finished' });
  s.shutdown(); s.boot();
  s.clock.now += 7 * 24 * 60 * 60_000;
  s.client.fetchAgentTimeline.mockClear();
  await s.relay.tick();
  expect(s.client.fetchAgentTimeline).not.toHaveBeenCalled();
  s.bridge.maintenanceHold(s.dir).set(true);
  await s.relay.tick();
  await s.report();
  expect(s.saved().pending).toEqual([]);
});

it.each([false, true])('reconciles a pending production follow-up after restart with identity: %s', async (identity) => {
  const s = setup(identity);
  expect(await s.send('Fixture follow-up')).toMatchObject({ delivered: 'now' });
  s.shutdown(); s.boot();
  s.clock.now += 1_000; s.see(); await s.relay.tick();
  await settle(s);
  s.bridge.maintenanceHold(s.dir).set(true);
  await s.relay.tick();
  expect(await s.report()).toMatchObject({ held: true, quiet: true });
  expect(s.saved().pending).toEqual([]);
});

it('reads the exact daemon submission identity from the production worker tail', async () => {
  const s = setup();
  await s.send('Fixture follow-up');
  const messageId = s.client.sendAgentMessage.mock.calls[0]![2].messageId;
  expect(await s.workers.completionEvidence!(s.id)).toMatchObject({ messages: [
    { id: 'fake-earlier-message' }, { id: messageId },
  ], completed: false });
});

it.each(['plain', 'failed read', 'restart'] as const)('refuses a held owner round with a blank user row: %s', async (kind) => {
  const s = setup();
  await s.send('Fixture follow-up');
  if (kind === 'restart') {
    s.clock.now += 1_000; s.see(); await s.relay.tick();
  }
  s.bridge.maintenanceHold(s.dir).set(true);
  finishUnobserved(s, false);
  if (kind === 'failed read') {
    s.client.fetchAgentTimeline.mockRejectedValueOnce(new Error('Fixture history unavailable'));
    await s.relay.tick();
  }
  if (kind === 'restart') s.shutdown();
  await s.client.sendAgentMessage(s.id, '', { messageId: 'fake-owner-image' });
  if (kind === 'restart') s.boot();
  s.clock.now += 1_000; s.see(); await s.relay.tick();
  const detail = await s.paseo.readWorkerConversation(s.id);
  expect(detail!.items.filter((item) => item.kind === 'user').at(-1)?.id).not.toBe('fake-owner-image');
  const deliver = vi.spyOn(s.bridge, 'deliverSystem');
  await settle(s);
  const epochs = deliver.mock.calls.filter(([message]) => message.key.endsWith('finished#2')).map(([message]) => message.admissionEpoch);
  expect(epochs.length).toBeGreaterThan(0);
  expect(epochs.every((epoch) => epoch === undefined)).toBe(true);
  expect(s.store.get(s.id)!.relays.find((relay) => relay.id === 'finished#2')?.deliveredAt).toBeUndefined();
});

it('keeps raw blank user identities and sequence fallback keys in completion evidence', async () => {
  const s = setup();
  s.client.fetchAgentTimeline.mockResolvedValue({ epoch: 'fake-epoch', entries: [
    { seqStart: 7, seqEnd: 7, item: { type: 'user_message', text: '', clientMessageId: 'fake-image' } },
    { seqStart: 8, seqEnd: 8, item: { type: 'user_message', text: '' } },
  ] } as never);
  expect(await s.workers.completionEvidence!(s.id)).toMatchObject({ messages: [{ id: 'fake-image' }, { id: 'fake-epoch:8' }] });
  expect((await s.paseo.readWorkerConversation(s.id))!.items).toEqual([]);
});

it.each(['restart', 'reconnect'].flatMap((kind) => [false, true].map((owner) => ({ kind, owner }))))(
  'defers ambiguous launch completion after $kind with an intervening owner round: $owner', async ({ kind, owner }) => {
    const s = setup(true, true);
    vi.spyOn(s.paseo, 'options').mockResolvedValue({ providers: [{ id: 'demo', label: 'Demo',
      modes: [{ id: 'default', label: 'Default' }], defaultModeId: 'default' }], workspaces: [] });
    // The fixture provider uses the same explicit permission mode as the bridge.
    Reflect.set(s.paseo, 'providers', [{ id: 'demo', label: 'Demo', modes: [{ id: 'default', label: 'Default' }], defaultModeId: 'default' }]);
    await s.bridge.call('start_chat', { backend: 'paseo', agent: 'demo', text: 'Fixture launch' },
      { hermesSession: 'fake-chat', cwd: PROJECT });
    expect(JSON.parse(readFileSync(join(s.dir, 'task-admissions.json'), 'utf8')).rounds).toEqual([
      expect.objectContaining({ id: s.id, messageId: s.client.createAgent.mock.calls[0]![0].clientMessageId }),
    ]);
    s.see();
    s.bridge.maintenanceHold(s.dir).set(true);
    if (kind === 'restart') s.shutdown();
    else Reflect.get(s.paseo, 'setStatus').call(s.paseo, 'disconnected');
    if (owner) {
      finishUnobserved(s, false);
      await s.client.sendAgentMessage(s.id, 'Owner fixture message', { messageId: 'fake-owner-message' });
    }
    if (kind === 'restart') s.boot();
    else Reflect.get(s.paseo, 'setStatus').call(s.paseo, 'connected');
    s.see(); await s.relay.tick();
    const deliver = vi.spyOn(s.bridge, 'deliverSystem');
    await settle(s);
    const epochs = deliver.mock.calls.filter(([message]) => message.key.endsWith('finished#1')).map(([message]) => message.admissionEpoch);
    expect(epochs.length).toBeGreaterThan(0);
    expect(epochs.every((epoch) => epoch === undefined)).toBe(true);
    expect(s.store.get(s.id)!.relays.find((relay) => relay.id === 'finished#1')?.deliveredAt).toBeUndefined();
    s.bridge.maintenanceHold(s.dir).set(false);
    s.clock.now += 10 * 60_000; await s.relay.tick(); await s.bridge.deliverQueued();
    expect(s.store.get(s.id)!.relays.find((relay) => relay.id === 'finished#1')?.deliveredAt).toBeDefined();
  },
);

it.each(['createAgent', 'fetchAgent'].flatMap((boundary) => [false, true].flatMap((owner) =>
  [false, true].map((reconnect) => ({ boundary, owner, reconnect })))))(
  'defers ambiguous completion through delayed $boundary acknowledgment with an owner round: $owner, reconnect: $reconnect', async ({ boundary, owner, reconnect }) => {
    const s = setup(true, true);
    const providers = [{ id: 'demo', label: 'Demo', modes: [{ id: 'default', label: 'Default' }], defaultModeId: 'default' }];
    vi.spyOn(s.paseo, 'options').mockResolvedValue({ providers, workspaces: [] });
    Reflect.set(s.paseo, 'providers', providers);
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const acknowledgment = new Promise<void>((resolve) => { release = resolve; });
    if (boundary === 'createAgent') {
      const create = s.client.createAgent.getMockImplementation()!;
      s.client.createAgent.mockImplementationOnce(async (input) => {
        const agent = await create(input);
        entered(); await acknowledgment;
        return agent;
      });
    } else {
      const fetch = s.client.fetchAgent.getMockImplementation()!;
      s.client.fetchAgent.mockImplementationOnce(async () => {
        const found = await fetch();
        entered(); await acknowledgment;
        return found;
      });
    }
    const launch = s.bridge.call('start_chat', { backend: 'paseo', agent: 'demo', text: 'Fixture launch' },
      { hermesSession: 'fake-chat', cwd: PROJECT });
    await pending;
    s.bridge.maintenanceHold(s.dir).set(true);
    const change = Reflect.get(s.paseo, 'setStatus').bind(s.paseo) as (state: string) => void;
    if (reconnect) change('disconnected');
    if (owner) {
      finishUnobserved(s, false);
      await s.client.sendAgentMessage(s.id, 'Owner fixture message', { messageId: 'fake-owner-message' });
    }
    if (reconnect) change('connected');
    release(); await launch;
    const deliver = vi.spyOn(s.bridge, 'deliverSystem');
    s.see(); await s.relay.tick();
    expect(s.client.fetchAgentTimeline).toHaveBeenCalled();
    await settle(s);
    const epochs = deliver.mock.calls.filter(([message]) => message.key.endsWith('finished#1')).map(([message]) => message.admissionEpoch);
    expect(epochs.length).toBeGreaterThan(0);
    expect(epochs.every((epoch) => epoch === undefined)).toBe(true);
    expect(s.store.get(s.id)!.relays.find((relay) => relay.id === 'finished#1')?.deliveredAt).toBeUndefined();
    expect(s.bridge.maintenanceHold(s.dir).isHeld()).toBe(true);
    s.bridge.maintenanceHold(s.dir).set(false);
    s.clock.now += 10 * 60_000; await s.relay.tick(); await s.bridge.deliverQueued();
    expect(s.store.get(s.id)!.relays.find((relay) => relay.id === 'finished#1')?.deliveredAt).toBeDefined();
  },
);

it.each(['launch', 'follow-up'].flatMap((kind) => [false, true].map((reconnect) => ({ kind, reconnect }))))(
  'rechecks a verified $kind at held relay admission after an unseen owner run, reconnect: $reconnect', async ({ kind, reconnect }) => {
    const s = setup(true, kind === 'launch');
    if (kind === 'launch') {
      const providers = [{ id: 'demo', label: 'Demo', modes: [{ id: 'default', label: 'Default' }], defaultModeId: 'default' }];
      vi.spyOn(s.paseo, 'options').mockResolvedValue({ providers, workspaces: [] });
      Reflect.set(s.paseo, 'providers', providers);
      await s.bridge.call('start_chat', { backend: 'paseo', agent: 'demo', text: 'Fixture launch' },
        { hermesSession: 'fake-chat', cwd: PROJECT });
    } else await s.send('Fixture follow-up');
    s.see(); await s.relay.tick();
    const round = s.store.get(s.id)!.round;
    s.bridge.maintenanceHold(s.dir).set(true);
    if (reconnect) {
      Reflect.get(s.paseo, 'setStatus').call(s.paseo, 'disconnected');
      Reflect.get(s.paseo, 'setStatus').call(s.paseo, 'connected');
      await s.relay.tick();
    }
    finishUnobserved(s, false);
    await s.client.sendAgentMessage(s.id, 'Owner fixture prompt', { messageId: 'fake-owner-message' });
    const deliver = vi.spyOn(s.bridge, 'deliverSystem');
    const history = vi.spyOn(s.workers, 'completionEvidence');
    s.finish(); s.see();
    s.clock.now += 120_001;
    await s.relay.tick();
    expect(history).toHaveBeenCalled();
    const evidence = await history.mock.results[0]!.value;
    expect(evidence).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ id: 'fake-owner-message' })]), completed: true });
    const relays = deliver.mock.calls.filter(([message]) => message.key.endsWith(`finished#${round}`));
    expect(relays.length).toBeGreaterThan(0);
    expect(relays.every(([message]) => message.admissionEpoch === undefined)).toBe(true);
    expect(s.bridge.quietCounts().queuedMessages).toBe(0);
    expect(s.store.get(s.id)!.relays.find((relay) => relay.id === `finished#${round}`)?.deliveredAt).toBeUndefined();
    expect(s.relay.quietCounts().reasons).toContain('relay_admission_unverified');
    expect(await s.report()).toMatchObject({ quiet: false, reasons: expect.arrayContaining(['relay_admission_unverified']) });
  },
);

it('keeps admission evidence fresh while reusing quotes and omitting archived worker quotes', async () => {
  const s = setup();
  const unsubscribe = vi.fn();
  const subscribe = vi.fn(() => Object.assign(unsubscribe, { ready: Promise.resolve() }));
  Object.assign(s.client, { subscribeAgentTimeline: subscribe });
  const page = (messageId: string, text: string) => ({ epoch: 'fake-epoch', entries: [
    { seqStart: 1, seqEnd: 1, timestamp: new Date(T0).toISOString(), item: { type: 'user_message', text: '', clientMessageId: messageId } },
    { seqStart: 2, seqEnd: 2, timestamp: new Date(T0).toISOString(), item: { type: 'assistant_message', text } },
  ], startCursor: { epoch: 'fake-epoch', seq: 1 }, endCursor: { epoch: 'fake-epoch', seq: 2 } });
  s.client.fetchAgentTimeline.mockResolvedValue(page('fake-launch-message', 'Earlier fixture result') as never);
  await s.paseo.getConversation(s.id);
  s.client.fetchAgentTimeline.mockResolvedValue(page('fake-owner-message', 'Latest fixture result') as never);
  expect(await s.workers.lastMessage(s.id)).toBe('Earlier fixture result');
  expect(s.client.fetchAgentTimeline).toHaveBeenCalledOnce();
  expect(await s.workers.completionEvidence!(s.id)).toMatchObject({ messages: [{ id: 'fake-owner-message' }] });
  expect(s.client.fetchAgentTimeline).toHaveBeenCalledTimes(3);
  Reflect.set(s.agent, 'archivedAt', new Date(T0).toISOString());
  s.agent.capabilities.supportsStreaming = false;
  Reflect.get(s.paseo, 'forgetAgent').call(s.paseo, s.id);
  const publish = vi.spyOn(s.hub, 'publish');
  expect(await s.workers.lastMessage(s.id)).toBeUndefined();
  expect(s.client.fetchAgentTimeline).toHaveBeenCalledTimes(3);
  expect(s.paseo.workerSnapshot(s.id)).toBeUndefined();
  expect(await s.paseo.listConversations()).toEqual([]);
  expect(publish).not.toHaveBeenCalled();
  expect(subscribe).toHaveBeenCalledOnce();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it.each(['replacement', 'reset', 'gap', 'stale cursor', 'deleted', 'unavailable'] as const)(
  'keeps %s admission reads separate from the subscribed relay quote', async (kind) => {
    const s = setup();
    const page = (epoch: string, text?: string) => ({ epoch, entries: text ? [
      { seqStart: 1, seqEnd: 1, timestamp: new Date(T0).toISOString(), item: { type: 'assistant_message', text } },
    ] : [], startCursor: { epoch, seq: 1 }, endCursor: { epoch, seq: 1 } });
    s.client.fetchAgentTimeline.mockResolvedValueOnce(page('fake-epoch', 'Earlier fixture result') as never);
    expect(await s.workers.lastMessage(s.id)).toBe('Earlier fixture result');
    if (kind === 'deleted') s.client.fetchAgentTimeline.mockRejectedValueOnce(new Error(`Agent not found: ${s.id}`));
    else if (kind === 'unavailable') s.client.fetchAgentTimeline.mockRejectedValueOnce(new Error('Fixture history unavailable'));
    else {
      const invalid = { ...page(kind === 'replacement' ? 'fake-replacement-epoch' : 'fake-epoch'),
        ...(kind === 'reset' ? { reset: true } : {}), ...(kind === 'gap' ? { gap: true } : {}),
        ...(kind === 'stale cursor' ? { staleCursor: true } : {}) };
      s.client.fetchAgentTimeline.mockResolvedValueOnce(invalid as never);
    }
    s.client.fetchAgentTimeline.mockResolvedValue(page(kind === 'replacement' ? 'fake-replacement-epoch' : 'fake-epoch') as never);
    if (kind === 'unavailable') await expect(s.workers.completionEvidence!(s.id)).rejects.toThrow('Fixture history unavailable');
    else if (kind === 'gap' || kind === 'stale cursor') {
      await expect(s.workers.completionEvidence!(s.id)).rejects.toThrow('Paseo worker history is unavailable.');
    } else expect(await s.workers.completionEvidence!(s.id)).toMatchObject({ messages: [], completed: true });
    expect(await s.workers.lastMessage(s.id)).toBe('Earlier fixture result');
    s.client.fetchAgentTimeline.mockResolvedValue(page('fake-epoch', 'Latest fixture result') as never);
    expect(await s.workers.completionEvidence!(s.id)).toMatchObject({ messages: [], completed: true });
    expect(await s.workers.lastMessage(s.id)).toBe('Earlier fixture result');
    expect(s.client.subscribeAgentTimeline).toHaveBeenCalledOnce();
  },
);

it.each(['timeline missing', 'timeline error', 'agent missing', 'agent null', 'restart'] as const)('retires deleted workers and stops unheld completion reads: %s', async (kind) => {
  const s = setup();
  await s.send('Fixture follow-up');
  s.clock.now += 1_000; s.see(); await s.relay.tick();
  if (kind === 'restart') s.shutdown();
  Reflect.set(s.paseo, 'agents', new Map());
  if (kind === 'timeline missing' || kind === 'restart') s.client.fetchAgentTimeline.mockRejectedValue(new Error(`Agent not found: ${s.id}`));
  if (kind === 'timeline error') s.client.fetchAgentTimeline.mockResolvedValue({ error: `Agent not found: ${s.id}` } as never);
  if (kind === 'agent missing') s.client.fetchAgent.mockRejectedValue(new Error(`Agent not found: ${s.id}`));
  else s.client.fetchAgent.mockResolvedValue(null as never);
  if (kind === 'restart') s.boot();
  for (let i = 0; i < 20; i++) { s.clock.now += 15_000; await s.relay.tick(); }
  expect(s.store.get(s.id)).toMatchObject({ round: 2, status: 'stopped' });
  s.bridge.maintenanceHold(s.dir).set(true); await s.relay.tick();
  s.bridge.maintenanceHold(s.dir).set(false);
  expect(s.saved().pending).toEqual([]);
  const idle = async () => {
    s.client.fetchAgentTimeline.mockClear();
    for (let i = 0; i < 40; i++) { s.clock.now += 15_000; await s.relay.tick(); }
    expect(s.client.fetchAgentTimeline).not.toHaveBeenCalled();
  };
  await idle();
  s.shutdown(); s.boot(); await s.relay.tick(); await idle();
  s.clock.now += 16 * 24 * 60 * 60_000; await s.relay.tick(); await idle();
  expect(s.store.get(s.id)).toBeUndefined();
});

it.each(['timeline', 'agent'] as const)('keeps transient %s failures pending', async (kind) => {
  const s = setup();
  await s.send('Fixture follow-up');
  const failed = kind === 'timeline' ? s.client.fetchAgentTimeline : s.client.fetchAgent;
  failed.mockRejectedValue(new Error('Fixture daemon unavailable'));
  await s.relay.tick();
  expect(s.saved().pending).toHaveLength(1);
  await expect(s.workers.completionEvidence!(s.id)).rejects.toThrow('Fixture daemon unavailable');
});

it.each(['idle', 'error', 'closed'])('uses the worker snapshot to recognize completion with attention cleared: %s', async (status) => {
  const s = setup();
  s.agent.status = status; s.agent.requiresAttention = false;
  expect(await s.workers.completionEvidence!(s.id)).toMatchObject({ completed: true });
});

it.each(['before history', 'during history'] as const)('keeps the quiet route unquiet when activity starts %s and the cached worker is idle', async (when) => {
  const s = setup();
  expect(await s.send('Fixture follow-up')).toMatchObject({ delivered: 'now' });
  Reflect.set(s.paseo, 'agents', new Map([[s.id, { ...s.agent, status: 'idle' }]]));
  s.client.fetchAgent.mockImplementation(async () => ({ agent: { ...s.agent } }));
  if (when === 'during history') {
    s.agent.status = 'idle';
    const timeline = s.client.fetchAgentTimeline.getMockImplementation()!;
    s.client.fetchAgentTimeline.mockImplementationOnce(async () => {
      const page = await timeline();
      s.agent.status = 'running';
      return page;
    });
  }
  const quiet = await quietRoute(s);
  s.clock.now += 15_000;
  s.bridge.maintenanceHold(s.dir).set(true);
  const pending = s.saved().pending;
  const task = structuredClone(s.store.get(s.id));
  expect(await quiet()).toMatchObject({ held: true, quiet: false, runningTasks: 1,
    reasons: expect.arrayContaining(['followups_unreconciled']) });
  await s.relay.tick();
  expect(s.client.fetchAgent).toHaveBeenCalled();
  expect(s.agent.status).toBe('running');
  expect(await quiet()).toMatchObject({ held: true, quiet: false, runningTasks: 1,
    reasons: expect.arrayContaining(['followups_unreconciled']) });
  expect(s.saved().pending).toEqual(pending);
  expect(s.store.get(s.id)).toMatchObject({ round: task!.round, status: task!.status, relays: task!.relays });
  s.finish();
  await s.relay.tick();
  expect(await quiet()).toMatchObject({ held: true, quiet: true, runningTasks: 0 });
  expect(s.saved().pending).toEqual([]);
  s.client.fetchAgentTimeline.mockClear();
  await s.relay.tick();
  expect(s.client.fetchAgentTimeline).not.toHaveBeenCalled();
  expect(s.client.sendAgentMessage).toHaveBeenCalledTimes(1);
});

it.each(['restart', 'reconnect'].flatMap((kind) => [true, false].map((identity) => ({ kind, identity }))))(
  'requires fresh ended activity after $kind with identity: $identity', async ({ kind, identity }) => {
    const s = setup(identity);
    expect(await s.send('Fixture follow-up')).toMatchObject({ delivered: 'now' });
    Reflect.set(s.paseo, 'agents', new Map([[s.id, { ...s.agent, status: 'idle', requiresAttention: true }]]));
    s.client.fetchAgent.mockImplementation(async () => ({ agent: { ...s.agent } }));
    const change = Reflect.get(s.paseo, 'setStatus').bind(s.paseo) as (state: string) => void;
    if (kind === 'restart') { s.shutdown(); s.boot(); }
    else { change('disconnected'); change('connected'); }
    const quiet = await quietRoute(s);
    s.clock.now += 15_000;
    s.bridge.maintenanceHold(s.dir).set(true);
    const task = structuredClone(s.store.get(s.id))!;
    await s.relay.tick();
    expect(await quiet()).toMatchObject({ held: true, quiet: false, runningTasks: 1,
      reasons: expect.arrayContaining(['followups_unreconciled']) });
    expect(s.client.fetchAgent).toHaveBeenCalled();
    expect(s.agent.status).toBe('running');
    expect(s.saved().pending).toHaveLength(1);
    expect(s.store.get(s.id)).toMatchObject({ round: task.round, status: task.status, relays: task.relays });
    s.client.fetchAgent.mockRejectedValueOnce(new Error('Fixture activity unavailable'));
    await s.relay.tick();
    expect(await quiet()).toMatchObject({ quiet: false, reasons: expect.arrayContaining(['followups_unreconciled']) });
    expect(s.saved().pending).toHaveLength(1);
    s.client.fetchAgent.mockImplementationOnce(async () => {
      change('disconnected'); change('connected');
      return { agent: { ...s.agent, status: 'idle' } };
    });
    await s.relay.tick();
    expect(await quiet()).toMatchObject({ quiet: false, reasons: expect.arrayContaining(['followups_unreconciled']) });
    expect(s.saved().pending).toHaveLength(1);
    s.finish();
    await s.relay.tick();
    expect(await quiet()).toMatchObject({ held: true, quiet: true, runningTasks: 0 });
    expect(s.saved().pending).toEqual([]);
    s.client.fetchAgent.mockClear(); s.client.fetchAgentTimeline.mockClear();
    await s.relay.tick();
    expect(s.client.fetchAgent).not.toHaveBeenCalled();
    expect(s.client.fetchAgentTimeline).not.toHaveBeenCalled();
    expect(s.client.sendAgentMessage).toHaveBeenCalledTimes(1);
  },
);

it.each(['live', 'restart', 'reconnect'].flatMap((kind) => [true, false].map((identity) => ({ kind, identity }))))(
  'keeps a queued same-round follow-up unquiet after $kind with identity: $identity', async ({ kind, identity }) => {
    const s = setup(identity);
    expect(await s.send('First fixture follow-up')).toMatchObject({ delivered: 'now' });
    s.clock.now += 1_000; s.see(); await s.relay.tick();
    expect(s.store.get(s.id)).toMatchObject({ round: 2, status: 'running' });
    expect(await s.send('Second fixture follow-up')).toMatchObject({ delivered: 'queued' });
    s.finish();
    Reflect.set(s.paseo, 'agents', new Map([[s.id, { ...s.agent }]]));
    s.client.fetchAgent.mockImplementation(async () => ({ agent: { ...s.agent } }));
    s.clock.now += 10_000; await s.bridge.deliverQueued();
    expect(s.client.sendAgentMessage).toHaveBeenCalledTimes(2);
    expect(s.saved().pending).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ round: 2, acknowledged: true })));
    expect(s.agent.status).toBe('running');
    const change = Reflect.get(s.paseo, 'setStatus').bind(s.paseo) as (state: string) => void;
    if (kind === 'restart') { s.shutdown(); s.boot(); }
    else if (kind === 'reconnect') { change('disconnected'); change('connected'); }
    const quiet = await quietRoute(s);
    s.clock.now += 1_000; await s.relay.tick();
    s.clock.now += 120_001; await s.relay.tick(); await s.bridge.deliverQueued();
    s.clock.now += 60_000; await s.relay.tick(); await s.bridge.deliverQueued();
    s.clock.now += 60 * 60_000 + 1;
    s.bridge.maintenanceHold(s.dir).set(true);
    expect(s.store.get(s.id)).toMatchObject({ round: 2, status: 'finished' });
    expect(s.store.get(s.id)!.relays.every((relay) => relay.deliveredAt !== undefined)).toBe(true);
    expect(s.agent.status).toBe('running');
    expect(await s.workers.completionEvidence!(s.id)).toMatchObject({ completed: false });
    expect(await quiet()).toMatchObject({ held: true, quiet: false, bridgeWaiters: 0, queuedMessages: 0,
      pendingRelays: 0, pendingDeliveries: 0, runningTasks: 1, openApprovalPrompts: 0,
      reasons: expect.arrayContaining(['followups_unreconciled', 'paseo_running']) });
    await expect(s.client.fetchAgents.mock.results.at(-1)!.value).resolves.toMatchObject({ entries: [{ agent: { status: 'running' } }] });
    expect(s.saved().pending).toHaveLength(2);
    s.client.fetchAgent.mockRejectedValueOnce(new Error('Fixture activity unavailable'));
    await s.relay.tick();
    expect(s.saved().pending).toHaveLength(2);
    s.client.fetchAgent.mockImplementationOnce(async () => {
      change('disconnected'); change('connected');
      return { agent: { ...s.agent, status: 'idle' } };
    });
    await s.relay.tick();
    expect(s.saved().pending).toHaveLength(2);
    s.finish(); await s.relay.tick();
    expect(await quiet()).toMatchObject({ held: true, quiet: true, runningTasks: 0 });
    expect(s.saved().pending).toEqual([]);
    s.client.fetchAgent.mockClear(); s.client.fetchAgentTimeline.mockClear();
    await s.relay.tick();
    expect(s.client.fetchAgent).not.toHaveBeenCalled();
    expect(s.client.fetchAgentTimeline).not.toHaveBeenCalled();
    expect(s.client.sendAgentMessage).toHaveBeenCalledTimes(2);
  },
);

it.each([true, false])('keeps a queued submission pending until acknowledgment with identity: %s', async (identity) => {
  const s = setup(identity);
  await s.send('First fixture follow-up');
  s.clock.now += 1_000; s.see(); await s.relay.tick();
  await s.send('Second fixture follow-up');
  s.finish();
  Reflect.set(s.paseo, 'agents', new Map([[s.id, { ...s.agent }]]));
  let acknowledge!: () => void;
  const send = s.client.sendAgentMessage.getMockImplementation()!;
  s.client.sendAgentMessage.mockImplementationOnce(async (...args) => {
    await new Promise<void>((resolve) => { acknowledge = resolve; });
    await send(...args);
  });
  s.clock.now += 10_000;
  const delivery = s.bridge.deliverQueued();
  await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
  await s.relay.tick();
  expect(s.saved().pending).toEqual(expect.arrayContaining([expect.objectContaining({ acknowledged: false })]));
  acknowledge(); await delivery;
  expect(s.saved().pending).toEqual(expect.arrayContaining([expect.objectContaining({ acknowledged: true })]));
  s.clock.now += 120_001; await s.relay.tick(); await s.bridge.deliverQueued();
  s.clock.now += 60_000; await s.relay.tick(); await s.bridge.deliverQueued();
  s.clock.now += 60 * 60_000 + 1;
  s.bridge.maintenanceHold(s.dir).set(true);
  const quiet = await quietRoute(s);
  s.client.fetchAgents.mockClear();
  expect(await quiet()).toMatchObject({ held: true, quiet: false, runningTasks: 1,
    reasons: expect.arrayContaining(['paseo_running']) });
  expect(s.client.fetchAgents).toHaveBeenCalledTimes(1);
  await expect(s.client.fetchAgents.mock.results[0]!.value).resolves.toMatchObject({ entries: [{ agent: { status: 'running' } }] });
  expect(s.saved().pending).toHaveLength(2);
  s.finish(); await s.relay.tick();
  expect(await quiet()).toMatchObject({ quiet: true });
  expect(s.saved().pending).toEqual([]);
});

it.each(['running', 'initializing', 'busy', 'starting', 'unknown'])('reads fresh %s activity when the inbox is idle and no follow-up is pending', async (status) => {
  const s = setup();
  Reflect.set(s.paseo, 'agents', new Map([[s.id, { ...s.agent }]]));
  s.agent.status = status;
  s.bridge.maintenanceHold(s.dir).set(true);
  const quiet = await quietRoute(s);
  expect(await quiet()).toMatchObject({ quiet: false,
    reasons: expect.arrayContaining([status === 'unknown' ? 'paseo_activity_unavailable' : 'paseo_running']) });
  expect(s.client.fetchAgents).toHaveBeenCalledTimes(1);
  await expect(s.client.fetchAgents.mock.results[0]!.value).resolves.toMatchObject({ entries: [{ agent: { status } }] });
});

it('keeps a failed fresh activity read unknown despite an idle inbox', async () => {
  const s = setup();
  s.client.fetchAgents.mockRejectedValue(new Error('Fixture activity unavailable'));
  s.bridge.maintenanceHold(s.dir).set(true);
  expect(await (await quietRoute(s))()).toMatchObject({ quiet: false, runningTasks: null,
    reasons: expect.arrayContaining(['paseo_activity_unavailable']) });
});

it('reads archived activity across every page without reviving workers or changing the inbox', async () => {
  const s = setup();
  const archived = { ...s.agent, id: 'fake-archived-worker', archivedAt: new Date(T0).toISOString(), status: 'running' };
  s.client.fetchAgents.mockImplementation(async (request?: unknown) => {
    const cursor = (request as { page?: { cursor?: string } })?.page?.cursor;
    return { entries: [{ agent: cursor ? { ...archived } : { ...s.agent }, project: null }],
      pageInfo: { hasMore: !cursor, nextCursor: cursor ? null : 'fake-next-page', prevCursor: null } } as never;
  });
  s.bridge.maintenanceHold(s.dir).set(true);
  const quiet = await quietRoute(s);
  const before = await s.paseo.listConversations();
  const task = structuredClone(s.store.get(s.id));
  expect(await quiet()).toMatchObject({ quiet: false, runningTasks: 1, reasons: ['paseo_running'] });
  expect(s.client.fetchAgents.mock.calls).toEqual([
    [{ filter: { includeArchived: true }, sort: [{ key: 'created_at', direction: 'asc' }], page: { limit: 200 } }],
    [{ filter: { includeArchived: true }, sort: [{ key: 'created_at', direction: 'asc' }], page: { limit: 200, cursor: 'fake-next-page' } }],
  ]);
  expect(await s.paseo.listConversations()).toEqual(before);
  expect(s.paseo.workerSnapshot(archived.id)).toBeUndefined();
  expect(s.store.get(s.id)).toEqual(task);
  expect(s.client.fetchAgent).not.toHaveBeenCalled();
  expect(s.client.fetchAgentTimeline).not.toHaveBeenCalled();
  expect(s.client.sendAgentMessage).not.toHaveBeenCalled();
  archived.status = 'idle';
  expect(await quiet()).toMatchObject({ held: true, quiet: true, runningTasks: 0 });
});

it.each(['missing cursor', 'repeated cursor', 'duplicate agent', 'unreadable page', 'missing page info', 'empty partial page', 'incremental page'] as const)(
  'keeps a partial daemon activity read unknown: %s', async (kind) => {
    const s = setup();
    const first = { entries: [{ agent: { ...s.agent }, project: null }],
      pageInfo: { hasMore: true, nextCursor: kind === 'missing cursor' ? null : 'fake-next-page', prevCursor: null } };
    if (kind === 'empty partial page') first.entries = [];
    s.client.fetchAgents.mockResolvedValueOnce(kind === 'missing page info' ? { entries: [] } as never :
      kind === 'incremental page' ? { ...first, sync: { mode: 'changes' } } as never : first);
    if (kind === 'unreadable page') s.client.fetchAgents.mockRejectedValueOnce(new Error('Fixture page unavailable'));
    if (kind === 'repeated cursor') s.client.fetchAgents.mockResolvedValueOnce({ entries: [{ agent: { ...s.agent, id: 'fake-second-worker' }, project: null }],
      pageInfo: { hasMore: true, nextCursor: 'fake-next-page', prevCursor: null } });
    s.bridge.maintenanceHold(s.dir).set(true);
    expect(await (await quietRoute(s))()).toMatchObject({ quiet: false, runningTasks: null,
      reasons: expect.arrayContaining(['paseo_activity_unavailable']) });
  },
);

it('rejects a fresh activity read superseded by a daemon reconnect', async () => {
  const s = setup();
  const read = s.client.fetchAgents.getMockImplementation()!;
  s.client.fetchAgents.mockImplementationOnce(async () => {
    const snapshot = await read();
    const change = Reflect.get(s.paseo, 'setStatus').bind(s.paseo) as (state: string) => void;
    change('disconnected'); change('connected');
    return snapshot;
  });
  s.bridge.maintenanceHold(s.dir).set(true);
  expect(await (await quietRoute(s))()).toMatchObject({ quiet: false, runningTasks: null,
    reasons: expect.arrayContaining(['paseo_activity_unavailable', 'paseo_changed']) });
});

it.each(['idle', 'error', 'closed'].flatMap((cached) => ['running', 'initializing'].map((fresh) => ({ cached, fresh }))))(
  'rejects completion when fresh activity is $fresh and cached activity is $cached', async ({ cached, fresh }) => {
    const s = setup();
    Reflect.set(s.paseo, 'agents', new Map([[s.id, { ...s.agent, status: cached }]]));
    s.agent.status = fresh;
    expect(await s.workers.completionEvidence!(s.id)).toMatchObject({ completed: false });
    expect(s.client.fetchAgent).toHaveBeenCalled();
  },
);

it.each(['unknown', 'busy', 'starting'])('does not retire a follow-up from unrecognized worker completion activity: %s', async (status) => {
  const s = setup();
  await s.send('Fixture follow-up');
  Reflect.set(s.paseo, 'agents', new Map([[s.id, { ...s.agent, status: 'idle' }]]));
  s.agent.status = status;
  s.clock.now += 15_000; await s.relay.tick();
  expect(s.saved().pending).toHaveLength(1);
  await expect(s.workers.completionEvidence!(s.id)).rejects.toThrow('Paseo worker activity is unavailable.');
});

it.each(['running', 'initializing'].flatMap((cached) => ['idle', 'error', 'closed'].map((fresh) => ({ cached, fresh }))))(
  'rejects completion when cached activity is $cached and fresh activity is $fresh', async ({ cached, fresh }) => {
    const s = setup();
    Reflect.set(s.paseo, 'agents', new Map([[s.id, { ...s.agent, status: cached }]]));
    s.agent.status = fresh;
    expect(await s.workers.completionEvidence!(s.id)).toMatchObject({ completed: false });
    expect(s.client.fetchAgent).toHaveBeenCalled();
  },
);

it.each(['idle', 'error', 'closed'])('uses fresh %s evidence for an archived worker without reviving it', async (status) => {
  const s = setup();
  Reflect.set(s.paseo, 'agents', new Map());
  s.agent.status = status;
  expect(await s.workers.completionEvidence!(s.id)).toMatchObject({ completed: true });
  expect(s.client.fetchAgent).toHaveBeenCalled();
  expect(s.workers.workerSnapshot(s.id)).toBeUndefined();
  expect(await s.paseo.listConversations()).toEqual([]);
});

it.each([false, true])('retires a drained follow-up after its identity leaves the production history tail with identity: %s', async (identity) => {
  const s = setup(identity);
  expect(await s.send('Fixture follow-up')).toMatchObject({ delivered: 'now' });
  s.clock.now += 1_000; s.see();
  s.client.fetchAgentTimeline.mockImplementation(async () => ({ epoch: 'fake-epoch', entries: Array.from({ length: 120 }, (_, seq) => ({
    seqStart: seq + 1, seqEnd: seq + 1, item: { type: 'assistant_message', text: 'Fixture output' },
  })) } as never));
  await s.relay.tick();
  await settle(s);
  expect(await s.workers.completionEvidence!(s.id)).toMatchObject({ messages: [], completed: true });
  expect(s.store.get(s.id)).toMatchObject({ round: 2, status: 'finished' });
  expect(s.store.get(s.id)!.relays.every((relay) => relay.deliveredAt !== undefined)).toBe(true);
  s.bridge.maintenanceHold(s.dir).set(true);
  await s.relay.tick();
  expect(await s.report()).toMatchObject({ held: true, quiet: true, runningTasks: 0 });
  expect(s.saved().pending).toEqual([]);
  s.client.fetchAgentTimeline.mockClear();
  await s.relay.tick(); await s.relay.tick();
  expect(s.client.fetchAgentTimeline).not.toHaveBeenCalled();
  s.shutdown(); s.boot();
  await s.relay.tick();
  expect(await s.report()).toMatchObject({ held: true, quiet: true });
  expect(s.saved().pending).toEqual([]);
  expect(s.client.fetchAgentTimeline).not.toHaveBeenCalled();
  s.agent.status = 'running'; s.agent.requiresAttention = false;
  s.clock.now += 1_000; s.see();
  const deliver = vi.spyOn(s.bridge, 'deliverSystem');
  await settle(s);
  expect(s.store.get(s.id)).toMatchObject({ round: 3, status: 'finished' });
  expect(deliver.mock.calls.filter(([message]) => message.key.endsWith('finished#3')).length).toBeGreaterThan(0);
  expect(deliver.mock.results.some((result) => result.type === 'throw' && result.value.code === 'maintenance')).toBe(true);
  expect(s.relay.quietCounts().pendingRelays).toBeGreaterThan(0);
  expect(await s.report()).toMatchObject({ held: true, quiet: false });
  expect(s.client.sendAgentMessage).toHaveBeenCalledTimes(1);
});

it('refuses the relay for an identityless receiving round while held after its side record retires', async () => {
  const s = setup(false);
  await s.send('Fixture follow-up');
  s.bridge.maintenanceHold(s.dir).set(true);
  s.clock.now += 1_000; s.see(); await s.relay.tick();
  const deliver = vi.spyOn(s.bridge, 'deliverSystem');
  await settle(s);
  expect(deliver.mock.results.some((result) => result.type === 'throw' && result.value.code === 'maintenance')).toBe(true);
  expect(s.saved().pending).toEqual([]);
  expect(s.relay.quietCounts().pendingRelays).toBeGreaterThan(0);
  expect(await s.report()).toMatchObject({ held: true, quiet: false });
});

it('recovers quiet after a transient side-record write failure and reconciliation', async () => {
  const s = setup();
  const path = join(s.dir, 'task-admissions.json');
  mkdirSync(path);
  try { expect(await s.send('Fixture follow-up')).toMatchObject({ delivered: 'now' }); }
  finally { rmSync(path, { recursive: true, force: true }); }
  s.clock.now += 1_000; s.see();
  expect(s.relay.quietCounts().reasons).toContain('followups_unavailable');
  await settle(s);
  s.shutdown(); s.boot();
  for (let i = 0; i < 5; i++) { s.clock.now += 60 * 60_000; s.see(); await s.relay.tick(); }
  s.bridge.maintenanceHold(s.dir).set(true);
  await s.relay.tick();
  expect(await s.report()).toMatchObject({ quiet: true });
  expect(s.saved()).toMatchObject({ pending: [], unavailable: false });
  expect(s.client.sendAgentMessage).toHaveBeenCalledTimes(1);
});

it.each([false, true])('defers a completion without terminal identity until release after a queued send: %s', async (queued) => {
  const s = setup();
  if (queued) { s.agent.status = 'running'; s.agent.requiresAttention = false; }
  expect(await s.send('Fixture follow-up')).toMatchObject({ delivered: queued ? 'queued' : 'now' });
  if (queued) {
    s.finish(); s.clock.now += 10_000;
    await s.bridge.deliverQueued();
  }
  s.bridge.maintenanceHold(s.dir).set(true);
  s.clock.now += 1_000; s.see(); await s.relay.tick();
  expect(await s.workers.completionEvidence!(s.id)).toMatchObject({ completionTurnId: s.agent.activeTurn!.turnId, completed: false });
  await settle(s);
  expect(s.store.get(s.id)!.relays.find((relay) => relay.id === 'finished#2')).toMatchObject({ held: 'relay_admission_unverified' });
  expect(await s.report()).toMatchObject({ held: true, quiet: false });
  expect(s.saved().pending).toEqual([]);
  s.bridge.maintenanceHold(s.dir).set(false);
  s.clock.now += 10 * 60_000; await s.relay.tick(); await s.bridge.deliverQueued();
  expect(s.store.get(s.id)!.relays.find((relay) => relay.id === 'finished#2')).toMatchObject({ deliveredAt: expect.any(Number) });
  s.clock.now += 60 * 60_000; await s.relay.tick();
  s.bridge.maintenanceHold(s.dir).set(true);
  const report = await s.report();
  expect(report, JSON.stringify(report)).toMatchObject({ held: true, quiet: true });
});

it('preserves the ordinary message HTTP response when Paseo returns a submission receipt', async () => {
  const s = setup();
  const config = makeConfig();
  cleanups.push(() => rmSync(config.stateDir, { recursive: true, force: true }));
  const app = await buildApp({ config, sources: { hermes: s.hermes, paseo: s.paseo }, hub: s.hub, logger: false,
    verifier: async () => ({ email: EMAIL, exp: 2_000_000_000 }) });
  cleanups.push(() => app.close());
  const response = await app.inject({ method: 'POST', url: `/api/conversations/paseo/${s.id}/messages`,
    headers: { host: new URL(config.publicOrigin).host, origin: config.publicOrigin, cookie: DESKTOP_COOKIE,
      'x-wayroost-app': 'desktop', 'x-wayroost-request': '1', 'content-type': 'application/json' },
    payload: { text: 'Fixture follow-up' } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true });
  expect(s.client.sendAgentMessage).toHaveBeenCalledTimes(1);
});


it.each(['launch', 'follow-up'].flatMap((kind) => ['plain', 'restart', 'reconnect'].map((boundary) => ({ kind, boundary }))))(
  'refuses a $kind relay for a schedule run without a user row after $boundary', async ({ kind, boundary }) => {
    const s = setup(true, kind === 'launch');
    if (kind === 'launch') {
      const providers = [{ id: 'demo', label: 'Demo', modes: [{ id: 'default', label: 'Default' }], defaultModeId: 'default' }];
      vi.spyOn(s.paseo, 'options').mockResolvedValue({ providers, workspaces: [] });
      Reflect.set(s.paseo, 'providers', providers);
      await s.bridge.call('start_chat', { backend: 'paseo', agent: 'demo', text: 'Fixture launch' },
        { hermesSession: 'fake-chat', cwd: PROJECT });
    } else await s.send('Fixture follow-up');
    s.see();
    s.bridge.maintenanceHold(s.dir).set(true);
    await s.relay.tick();
    const round = s.store.get(s.id)!.round;
    if (boundary === 'restart') { s.shutdown(); s.boot(); }
    if (boundary === 'reconnect') {
      Reflect.get(s.paseo, 'setStatus').call(s.paseo, 'disconnected');
      Reflect.get(s.paseo, 'setStatus').call(s.paseo, 'connected');
    }
    const timeline = s.client.fetchAgentTimeline.getMockImplementation()!;
    s.client.fetchAgentTimeline.mockImplementation(async () => {
      const page = await timeline();
      return { ...page, entries: [...page.entries, { seqStart: 100, seqEnd: 100, turnId: 'fake-schedule-turn',
        timestamp: new Date(s.clock.now).toISOString(), item: { type: 'assistant_message', text: 'Fixture scheduled result' } }] } as never;
    });
    // A scheduled turn starts and ends without submitting another user message.
    s.finish(); s.agent.status = 'running'; s.agent.requiresAttention = false;
    const deliver = vi.spyOn(s.bridge, 'deliverSystem');
    await settle(s);
    const relays = deliver.mock.calls.filter(([message]) => message.key.endsWith(`finished#${round}`));
    expect(relays.length).toBeGreaterThan(0);
    expect(relays.every(([message]) => message.admissionEpoch === undefined)).toBe(true);
    expect(s.store.get(s.id)!.relays.find((relay) => relay.id === `finished#${round}`)?.deliveredAt).toBeUndefined();
    expect(await s.report()).toMatchObject({ quiet: false, reasons: expect.arrayContaining(['relay_admission_unverified']) });
  },
);

it.each(['provider disabled', 'provider removed', 'not found', '503', 'timeout'] as const)(
  'reads a stored worker without loading it after %s', async (failure) => {
    const s = setup();
    s.agent.capabilities.supportsStreaming = false;
    await s.send('Fixture follow-up');
    s.bridge.maintenanceHold(s.dir).set(true);
    s.client.fetchAgent.mockRejectedValue(failure === '503' ? new (await import('../src/sources.js')).UserFacingError('Fixture unavailable', 503)
      : failure === 'timeout' ? Object.assign(new Error('Fixture timeout'), { name: 'TimeoutError' })
        : new Error(failure === 'not found' ? 'Agent not found: fake-worker' : `Agent references unavailable provider: ${failure}`));
    if (failure === '503' || failure === 'timeout') await expect(s.workers.completionEvidence!(s.id)).rejects.toThrow();
    else expect(await s.workers.completionEvidence!(s.id)).toEqual({ messages: [], completed: true });
    expect(s.client.fetchAgentTimeline).not.toHaveBeenCalled();
  },
);


it.each((['createAgent', 'fetchAgent'] as const).flatMap((boundary) => [false, true].map((reconnect) => ({ boundary, reconnect }))))(
  'refuses a scheduled completion after delayed $boundary acknowledgment, reconnect: $reconnect', async ({ boundary, reconnect }) => {
    const s = setup(true, true);
    const providers = [{ id: 'demo', label: 'Demo', modes: [{ id: 'default', label: 'Default' }], defaultModeId: 'default' }];
    vi.spyOn(s.paseo, 'options').mockResolvedValue({ providers, workspaces: [] });
    Reflect.set(s.paseo, 'providers', providers);
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const acknowledgment = new Promise<void>((resolve) => { release = resolve; });
    const call = s.client[boundary].getMockImplementation()!;
    s.client[boundary].mockImplementationOnce(async (...args: unknown[]) => {
      const result = await (call as (...args: unknown[]) => Promise<unknown>)(...args);
      entered(); await acknowledgment;
      return result as never;
    });
    const launch = s.bridge.call('start_chat', { backend: 'paseo', agent: 'demo', text: 'Fixture launch' },
      { hermesSession: 'fake-chat', cwd: PROJECT });
    await pending;
    s.bridge.maintenanceHold(s.dir).set(true);
    if (reconnect) {
      Reflect.get(s.paseo, 'setStatus').call(s.paseo, 'disconnected');
      Reflect.get(s.paseo, 'setStatus').call(s.paseo, 'connected');
    }
    const timeline = s.client.fetchAgentTimeline.getMockImplementation()!;
    s.client.fetchAgentTimeline.mockImplementation(async () => {
      const page = await timeline();
      return { ...page, entries: [...page.entries, { seqStart: 100, seqEnd: 100, turnId: 'fake-schedule-turn',
        timestamp: new Date(s.clock.now).toISOString(), item: { type: 'assistant_message', text: 'Fixture scheduled result' } }] } as never;
    });
    release(); await launch;
    const deliver = vi.spyOn(s.bridge, 'deliverSystem');
    s.see(); await s.relay.tick(); await settle(s);
    const relays = deliver.mock.calls.filter(([message]) => message.key.endsWith('finished#1'));
    expect(relays.length).toBeGreaterThan(0);
    expect(relays.every(([message]) => message.admissionEpoch === undefined)).toBe(true);
    expect(s.store.get(s.id)!.relays.find((relay) => relay.id === 'finished#1')?.deliveredAt).toBeUndefined();
  },
);

it.each([false, true])('refuses a scheduled round after an unobserved follow-up, failed evidence: %s', async (failed) => {
  const s = setup();
  await s.send('Fixture follow-up');
  finishUnobserved(s, false);
  s.bridge.maintenanceHold(s.dir).set(true);
  const timeline = s.client.fetchAgentTimeline.getMockImplementation()!;
  s.client.fetchAgentTimeline.mockImplementation(async () => {
    const page = await timeline();
    return { ...page, entries: [...page.entries, { seqStart: 100, seqEnd: 100, turnId: 'fake-schedule-turn',
      timestamp: new Date(s.clock.now).toISOString(), item: { type: 'assistant_message', text: 'Fixture scheduled result' } }] } as never;
  });
  if (failed) s.client.fetchAgentTimeline.mockRejectedValueOnce(new Error('Fixture history unavailable'));
  s.clock.now += 1_000; s.agent.status = 'running'; s.agent.requiresAttention = false; s.see();
  expect(s.store.get(s.id)).toMatchObject({ round: 2, status: 'running' });
  const deliver = vi.spyOn(s.bridge, 'deliverSystem');
  await s.relay.tick(); await settle(s);
  const relays = deliver.mock.calls.filter(([message]) => message.key.endsWith('finished#2'));
  expect(relays.length).toBeGreaterThan(0);
  expect(relays.every(([message]) => message.admissionEpoch === undefined)).toBe(true);
});

it.each(['launch', 'follow-up'])('refuses a %s completion with only content from an earlier turn', async (kind) => {
  const s = setup(true, kind === 'launch');
  if (kind === 'launch') {
    const providers = [{ id: 'demo', label: 'Demo', modes: [{ id: 'default', label: 'Default' }], defaultModeId: 'default' }];
    vi.spyOn(s.paseo, 'options').mockResolvedValue({ providers, workspaces: [] });
    Reflect.set(s.paseo, 'providers', providers);
    await s.bridge.call('start_chat', { backend: 'paseo', agent: 'demo', text: 'Fixture launch' },
      { hermesSession: 'fake-chat', cwd: PROJECT });
  } else await s.send('Fixture follow-up');
  s.see();
  const timeline = s.client.fetchAgentTimeline.getMockImplementation()!;
  s.client.fetchAgentTimeline.mockImplementation(async () => {
    const page = await timeline();
    return { ...page, entries: [...page.entries, { seqStart: 100, seqEnd: 100,
      turnId: page.entries.at(-1)!.turnId, timestamp: new Date(s.clock.now).toISOString(),
      item: { type: 'assistant_message', text: 'Fixture result from the original turn' } }] } as never;
  });
  // The original turn ends unseen; a later turn is canceled before producing content.
  s.finish();
  s.bridge.maintenanceHold(s.dir).set(true);
  s.agent.status = 'running'; s.agent.requiresAttention = false;
  const deliver = vi.spyOn(s.bridge, 'deliverSystem');
  const round = s.store.get(s.id)!.round;
  await settle(s);
  const relays = deliver.mock.calls.filter(([message]) => message.key.endsWith(`finished#${round}`));
  expect(relays.length).toBeGreaterThan(0);
  expect(relays.every(([message]) => message.admissionEpoch === undefined)).toBe(true);
  expect(s.store.get(s.id)!.relays.find((relay) => relay.id === `finished#${round}`)?.deliveredAt).toBeUndefined();
  expect(await s.report()).toMatchObject({ quiet: false });
});

it.each(['before history', 'during history'])('refuses history overtaken by an unseen owner turn %s', async (when) => {
  const s = setup(true, true);
  const providers = [{ id: 'demo', label: 'Demo', modes: [{ id: 'default', label: 'Default' }], defaultModeId: 'default' }];
  vi.spyOn(s.paseo, 'options').mockResolvedValue({ providers, workspaces: [] });
  Reflect.set(s.paseo, 'providers', providers);
  await s.bridge.call('start_chat', { backend: 'paseo', agent: 'demo', text: 'Fixture launch' },
    { hermesSession: 'fake-chat', cwd: PROJECT });
  s.see();
  s.bridge.maintenanceHold(s.dir).set(true);
  await s.relay.tick();
  s.clock.now += 1_000; s.finish(); s.see();
  s.clock.now += 120_001;
  s.client.fetchAgent.mockImplementation(async () => ({ agent: structuredClone(s.agent) }));
  const ownerTurn = async () => {
    await s.client.sendAgentMessage(s.id, 'Fixture owner prompt', { messageId: 'fake-owner-message' });
    s.finish();
    s.agent.updatedAt = new Date(s.clock.now).toISOString();
  };
  const completion = s.workers.completionEvidence!.bind(s.workers);
  const evidence = vi.spyOn(s.workers, 'completionEvidence');
  if (when === 'before history') await ownerTurn();
  else evidence.mockImplementationOnce(async (id) => {
    const timeline = s.client.fetchAgentTimeline.getMockImplementation()!;
    s.client.fetchAgentTimeline.mockImplementationOnce(async () => {
      const page = await timeline();
      await ownerTurn();
      return page;
    });
    return completion(id);
  });
  const deliver = vi.spyOn(s.bridge, 'deliverSystem');
  await s.relay.tick();
  expect(evidence).toHaveBeenCalled();
  if (when === 'during history') await expect(evidence.mock.results[0]!.value).rejects.toThrow('Paseo worker activity is unavailable.');
  const relays = deliver.mock.calls.filter(([message]) => message.key.endsWith('finished#1'));
  expect(relays.length).toBeGreaterThan(0);
  expect(relays.every(([message]) => message.admissionEpoch === undefined)).toBe(true);
  expect(s.store.get(s.id)!.relays.find((relay) => relay.id === 'finished#1')?.deliveredAt).toBeUndefined();
  expect(await s.report()).toMatchObject({ quiet: false });
});

it.each(['snapshot', 'same-millisecond history', 'epoch', 'agent notification', 'sub-agent notification'] as const)(
  'discards admission evidence changed during the read: %s', async (change) => {
    const s = setup();
    s.client.fetchAgent.mockImplementation(async () => ({ agent: structuredClone(s.agent) }));
    const timeline = s.client.fetchAgentTimeline.getMockImplementation()!;
    let reads = 0;
    s.client.fetchAgentTimeline.mockImplementation(async () => {
      const page = await timeline();
      if (++reads === 1) {
        if (change === 'snapshot') s.agent.updatedAt = new Date(T0 + 1).toISOString();
        if (change === 'same-millisecond history') {
          await s.client.sendAgentMessage(s.id, 'Fixture owner prompt', { messageId: 'fake-owner-message' });
          s.finish();
        }
        if (change === 'agent notification') {
          Reflect.get(s.paseo, 'onAgentUpdate').call(s.paseo, { kind: 'upsert', agent: structuredClone(s.agent) });
        }
        if (change === 'sub-agent notification') {
          Reflect.get(s.paseo, 'onSubagentUpdate').call(s.paseo, { kind: 'remove', parentAgentId: s.id, subagentId: 'fake-child' });
        }
      }
      return { ...page, epoch: change === 'epoch' && reads > 1 ? 'fake-replacement-epoch' : page.epoch };
    });
    await expect(s.workers.completionEvidence!(s.id)).rejects.toThrow('Paseo worker activity is unavailable.');
  },
);

it('accepts a stable active turn across independent request identities', async () => {
  const s = setup();
  await s.send('Fixture follow-up');
  const timeline = s.client.fetchAgentTimeline.getMockImplementation()!;
  let request = 0;
  s.client.fetchAgentTimeline.mockImplementation(async () => ({ ...await timeline(), requestId: `fake-request-${++request}` }));
  expect(await s.workers.completionEvidence!(s.id)).toMatchObject({
    completed: false, completionTurnId: s.agent.activeTurn!.turnId,
  });
  expect(request).toBe(2);
  s.finish();
  expect(await s.workers.completionEvidence!(s.id)).toMatchObject({ completed: true, completionTurnId: undefined });
});
