import { hostPaths } from './host-path-fixture.js';
import { temporaryDirectory } from '../../tests/temporary-directory.js';
import { execFile } from 'node:child_process';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, type Server } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Approval, ConversationSummary, QuietReport } from '../../shared/protocol.js';
import { buildApp } from '../src/app.js';
import { BackgroundGate } from '../src/background.js';
import { MAINTENANCE_SOCKET, startMaintenanceAdmin } from '../src/bridge/admin.js';
import { MAINTENANCE_FILE, MAINTENANCE_MESSAGE, MaintenanceHold } from '../src/bridge/maintenance.js';
import { quietReport } from '../src/bridge/quiet.js';
import { buildBridgeServer } from '../src/bridge/server.js';
import { Bridge, type SystemMessage } from '../src/bridge/service.js';
import { readOrCreateBridgeToken } from '../src/bridge/token.js';
import { DisabledHermes, DisabledPaseo } from '../src/disabled.js';
import { EventHub } from '../src/hub.js';
import type { WorkerSnapshot } from '../src/paseo/normalize.js';
import { TaskRelay } from '../src/tasks/relay.js';
import { WorkerUpdatesSetting } from '../src/tasks/setting.js';
import { TaskStore, type TaskRecord } from '../src/tasks/store.js';
import { DESKTOP_COOKIE, FakeHermes, FakePaseo, PHONE_COOKIE, apiHeaders, makeConfig, postHeaders, seedDevices } from './helpers.js';

const roots: string[] = [];
const cleanups: Array<() => unknown | Promise<unknown>> = [];
const log = { info() {}, warn() {}, error() {} };
const background = new BackgroundGate('primary');
const T0 = 1_800_000_000_000;
const PROJECT = '/home/me/code/app';
const CONTENT = 'Private fixture contents, prompt and task title';
const run = promisify(execFile);
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function directory() {
  // Short prefix: the admin socket must fit the Unix socket path limit under test-results/.
  const dir = temporaryDirectory('wr-maint-');
  roots.push(dir);
  return dir;
}

function fixture() {
  const dir = directory();
  let now = T0;
  const hub = new EventHub();
  const sources = { hermes: new FakeHermes(), paseo: new FakePaseo() };
  const chat = (source: 'hermes' | 'paseo', id: string): ConversationSummary => ({
    source, id, title: CONTENT, preview: CONTENT, status: 'idle', pendingApprovals: 0,
    updatedAt: T0 - 60_000, project: { path: PROJECT, name: 'Demo project' },
  });
  const chats = [chat('paseo', 'caller'), chat('paseo', 'recipient'), chat('hermes', 'h1')];
  for (const source of [sources.hermes, sources.paseo]) {
    vi.spyOn(source, 'status').mockReturnValue(source.status());
  }
  Object.assign(sources.hermes, { activitySnapshot: vi.fn(async () => ({
    complete: true,
    runningTasks: chats.filter((c) => c.source === 'hermes' && (c.status === 'running' || c.status === 'needs_approval')).length,
    openApprovalPrompts: chats.filter((c) => c.source === 'hermes').reduce((sum, c) => sum + c.pendingApprovals, 0),
    conversations: chats.filter((c) => c.source === 'hermes'),
  })) });
  vi.spyOn(sources.hermes, 'listConversations').mockImplementation(async () => chats.filter((c) => c.source === 'hermes'));
  vi.spyOn(sources.paseo, 'listConversations').mockImplementation(async () => chats.filter((c) => c.source === 'paseo'));
  Object.assign(sources.paseo, { readActivityConversations: () => sources.paseo.listConversations() });
  vi.spyOn(sources.paseo, 'getConversation').mockImplementation(async (id) => ({
    conversation: chats.find((c) => c.id === id)!, approvals: [], items: [{ id: 'demo-answer', kind: 'assistant', text: CONTENT }],
  }));
  vi.spyOn(sources.paseo, 'options').mockResolvedValue({ providers: [{ id: 'demo', label: 'Demo', modes: [], defaultModeId: 'default' }], workspaces: [] });
  const bridge = new Bridge({ stateDir: dir, sources, hub, background, log, pollMs: 0, now: () => now });
  const hold = bridge.maintenanceHold(dir);
  cleanups.push(() => bridge.stop());
  const call = (tool: string, args: object = {}) => bridge.call(tool, args, { paseoAgent: 'caller', cwd: PROJECT });
  const system = (key: string, admittedAt?: number): SystemMessage => ({
    key, ...(admittedAt !== undefined ? { admittedAt } : {}), target: { source: 'hermes', id: 'h1' },
    sender: 'Wayroost', text: CONTENT, delivered: vi.fn(), dropped: vi.fn(),
  });
  const report = () => quietReport({ hold, bridge, sources });
  return { dir, hub, sources, chats, bridge, hold, call, system, report, advance: (ms: number) => { now += ms; } };
}

describe('maintenance admission and durability', () => {
  it.each(['unreadable', 'empty'] as const)('returns maintenance before a %s backend listing through the HTTP route', async (kind) => {
    const f = fixture();
    const token = readOrCreateBridgeToken(f.dir, background);
    const listener = await buildBridgeServer({ bridge: f.bridge, token, port: 19012, background, log });
    cleanups.push(() => listener.close());
    f.hold.set(true);
    const listing = vi.mocked(f.sources.paseo.listConversations);
    if (kind === 'unreadable') listing.mockRejectedValue(new Error('Fixture listing unavailable'));
    else listing.mockResolvedValue([]);
    listing.mockClear();
    const result = await listener.inject({ method: 'POST', url: '/bridge/v1/send_message',
      headers: { host: '127.0.0.1:19012', authorization: `Bearer ${token}`, 'x-bridge-paseo-agent': 'caller', 'x-bridge-cwd': PROJECT },
      payload: { chat: 'paseo:recipient', text: CONTENT } });
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ ok: false, error: 'maintenance', message: MAINTENANCE_MESSAGE });
    expect(listing).not.toHaveBeenCalled();
    expect(f.sources.paseo.calls).toEqual([]);
  });

  it('refuses an unresolved sender to an existing wait during a backend outage', async () => {
    const f = fixture();
    const wait = f.call('wait_for_reply', { chat: 'paseo:recipient', timeout_seconds: 120 });
    void wait.catch(() => {});
    await vi.waitFor(() => expect(f.bridge.activeWaits).toBe(1));
    f.hold.set(true);
    vi.mocked(f.sources.paseo.listConversations).mockRejectedValue(new Error('Fixture listing unavailable'));
    await expect(f.bridge.call('send_message', { chat: 'paseo:caller', text: 'Fixture new message' },
      { hermesSession: 'h1', cwd: PROJECT })).rejects.toMatchObject({ code: 'maintenance', status: 503 });
    expect(f.bridge.activeWaits).toBe(1);
    vi.mocked(f.sources.paseo.listConversations).mockResolvedValue(f.chats.filter((c) => c.source === 'paseo'));
    await f.bridge.call('send_message', { chat: 'paseo:caller', text: 'Fixture reply' }, { paseoAgent: 'recipient', cwd: PROJECT });
    await expect(wait).resolves.toMatchObject({ kind: 'reply', text: 'Fixture reply' });
  });

  it('returns maintenance before a send rate limit through the HTTP route', async () => {
    const f = fixture();
    const token = readOrCreateBridgeToken(f.dir, background);
    const listener = await buildBridgeServer({ bridge: f.bridge, token, port: 19012, background, log });
    cleanups.push(() => listener.close());
    const send = () => listener.inject({ method: 'POST', url: '/bridge/v1/send_message',
      headers: { host: '127.0.0.1:19012', authorization: `Bearer ${token}`, 'x-bridge-paseo-agent': 'caller', 'x-bridge-cwd': PROJECT },
      payload: { chat: 'paseo:recipient', text: CONTENT } });
    f.chats[1]!.status = 'running';
    for (let i = 0; i < 4; i++) expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(429);
    f.hold.set(true);
    const result = await send();
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ ok: false, error: 'maintenance', message: MAINTENANCE_MESSAGE });
  });

  it.each(['send_message', 'start_chat'])('keeps the maintenance error stable for %s when Settings Pause is also set', async (tool) => {
    const f = fixture();
    f.bridge.setPaused(true);
    f.hold.set(true);
    const args = tool === 'send_message' ? { chat: 'paseo:recipient', text: CONTENT } : { backend: 'hermes', text: CONTENT };
    await expect(f.call(tool, args)).rejects.toMatchObject({ code: 'maintenance', status: 503, message: MAINTENANCE_MESSAGE });
  });

  it.each([false, true])('drains a same-millisecond launch with a hold during creation: %s', async (duringCreation) => {
    const f = fixture();
    let now = T0;
    const id = '00000000-0000-4000-8000-000000000003';
    const snap: WorkerSnapshot = { id, provider: 'demo', cwd: PROJECT, createdAt: T0,
      status: 'running', loaded: true, pendingPermissions: 0, labels: {} };
    const workers = { agentsLoaded: true, revision: {}, workerSnapshots: () => [snap], workerSnapshot: () => snap,
      completionEvidence: async () => ({ messages: [{ id: 'fake-launch-message', turnId: 'fake-launch-turn' }],
        completionTurnId: 'fake-launch-turn', subsequentTurnIds: [], completed: snap.status === 'idle' }),
      lookUp: async () => snap, lastMessage: async () => CONTENT };
    const chats = { connected: () => true, rows: async () => [],
      find: async () => f.chats[2], origin: async () => 'tui' };
    const setting = new WorkerUpdatesSetting(f.dir);
    const store = new TaskStore(f.dir, () => now, undefined, log);
    const relay = new TaskRelay({ store, bridge: f.bridge, workers, chats, setting,
      hub: f.hub, background, log, tickMs: 0, now: () => now });
    relay.start();
    cleanups.push(() => relay.stop());
    vi.mocked(f.sources.paseo.options).mockResolvedValue({ providers: [{ id: 'demo', label: 'Demo',
      modes: [{ id: 'default', label: 'Default' }], defaultModeId: 'default' }], workspaces: [] });
    vi.spyOn(f.sources.paseo, 'createConversation').mockImplementation(async () => {
      if (duringCreation) f.hold.set(true);
      return { id, messageId: 'fake-launch-message' } as never;
    });
    await f.bridge.call('start_chat', { backend: 'paseo', agent: 'demo', text: CONTENT }, { hermesSession: 'h1', cwd: PROJECT });
    if (!duringCreation) f.hold.set(true);
    await expect(f.bridge.call('start_chat', { backend: 'paseo', agent: 'demo', text: CONTENT },
      { hermesSession: 'h1', cwd: PROJECT })).rejects.toMatchObject({ code: 'maintenance' });
    relay.consider(snap, now);
    await relay.tick();
    snap.status = 'idle';
    relay.consider(snap, now);
    now += 120_001;
    f.advance(120_001);
    const deliver = vi.spyOn(f.bridge, 'deliverSystem');
    await relay.tick();
    expect(deliver).toHaveReturnedWith('queued');
    expect(store.get(id)?.relays[0]).toMatchObject({ id: 'finished#1', queuedAt: now });

    const message = deliver.mock.calls[0]![0];
    now += 60_000;
    f.advance(60_000);
    expect(f.bridge.deliverSystem({ ...message, key: 'retried-completion', dropped: vi.fn() })).toBe('queued');
    const restarted = new Bridge({ stateDir: f.dir, sources: f.sources, hub: f.hub, background, log, pollMs: 0 });
    cleanups.push(() => restarted.stop());
    const reloaded = new TaskStore(f.dir, () => now, undefined, log);
    const recovered = new TaskRelay({ store: reloaded, bridge: restarted, workers, chats, setting,
      hub: f.hub, background, log, tickMs: 0, now: () => now });
    await recovered.tick();
    await recovered.tick();
    expect(restarted.quietCounts().queuedMessages).toBe(1);
    expect(reloaded.get(id)?.relays[0]).toMatchObject({ id: 'finished#1', queuedAt: now });
    expect(() => restarted.deliverSystem(f.system('unproven-equal-time', T0))).toThrow(MAINTENANCE_MESSAGE);

    snap.status = 'running';
    recovered.consider(snap, now);
    snap.status = 'idle';
    recovered.consider(snap, now);
    now += 120_001;
    await recovered.tick();
    expect(restarted.quietCounts().queuedMessages).toBe(0);
    expect(reloaded.get(id)?.round).toBe(2);
  });

  it('preserves admission order through repeated holds and durable releases', () => {
    const f = fixture();
    const first = f.hold.admit();
    f.hold.set(true);
    f.hold.set(true);
    expect(() => f.hold.requireAdmission(T0, first)).not.toThrow();
    f.hold.set(false);
    const released = new MaintenanceHold(f.dir, () => T0);
    const next = released.admit();
    expect(next).toBeGreaterThan(first);
    released.set(true);
    const held = new MaintenanceHold(f.dir, () => T0);
    expect(() => held.requireAdmission(T0, first)).not.toThrow();
    expect(() => held.requireAdmission(T0, next)).not.toThrow();
    expect(() => held.admit()).toThrow(MAINTENANCE_MESSAGE);
    expect(() => held.requireAdmission(T0, next + 1)).toThrow(MAINTENANCE_MESSAGE);
    expect(() => held.requireAdmission(T0, -1)).toThrow(MAINTENANCE_MESSAGE);
  });

  it('holds starts and new relays, keeps reads available, and releases admissions', async () => {
    const f = fixture();
    f.hold.set(true);
    expect(f.bridge.status()).toMatchObject({ maintenance: true, paused: false });
    await expect(f.call('start_chat', { backend: 'hermes', text: CONTENT })).rejects.toMatchObject({ code: 'maintenance', status: 503, message: MAINTENANCE_MESSAGE });
    await expect(f.call('send_message', { chat: 'paseo:recipient', text: CONTENT })).rejects.toMatchObject({ code: 'maintenance' });
    expect(() => f.bridge.deliverSystem(f.system('new-relay'))).toThrow(MAINTENANCE_MESSAGE);
    expect(await f.call('list_chats')).toHaveProperty('chats');
    expect(await f.call('read_chat', { chat: 'paseo:recipient' })).toHaveProperty('items');
    expect(f.sources.hermes.calls.some((c) => c.startsWith('create:'))).toBe(false);
    f.hold.set(false);
    expect(await f.call('send_message', { chat: 'paseo:recipient', text: 'Demo message' })).toMatchObject({ delivered: 'now' });
    expect(await f.call('start_chat', { backend: 'hermes', text: 'Demo start' })).toHaveProperty('chat');
    expect(f.bridge.deliverSystem(f.system('released-relay'))).toBe('queued');
  });

  it('loads the hold before the restarted listener can accept requests', async () => {
    const f = fixture();
    f.hold.set(true);
    f.bridge.stop();
    const restarted = new Bridge({ sources: f.sources, hub: f.hub, background, log, pollMs: 0 });
    cleanups.push(() => restarted.stop());
    const token = readOrCreateBridgeToken(f.dir, background);
    const listener = await buildBridgeServer({ bridge: restarted, token, port: 19012, background, log });
    cleanups.push(() => listener.close());
    const response = await listener.inject({ method: 'POST', url: '/bridge/v1/start_chat',
      headers: { host: '127.0.0.1:19012', authorization: `Bearer ${token}`, 'x-bridge-name': 'wayroost' },
      payload: { backend: 'hermes', text: CONTENT } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: 'maintenance', message: MAINTENANCE_MESSAGE });
    expect(statSync(join(f.dir, MAINTENANCE_FILE)).mode & 0o777).toBe(0o600);
    restarted.maintenanceHold(f.dir).set(false);
    expect(new MaintenanceHold(f.dir).isHeld()).toBe(false);
  });

  it('refuses malformed durable state without including its contents', () => {
    const dir = directory();
    writeFileSync(join(dir, MAINTENANCE_FILE), CONTENT);
    expect(() => new MaintenanceHold(dir)).toThrow('The bridge maintenance state could not be read.');
  });

  it('rechecks a start after asynchronous project discovery', async () => {
    const f = fixture();
    vi.spyOn(f.sources.hermes, 'listConversations').mockImplementation(async () => {
      f.hold.set(true);
      return f.chats.filter((c) => c.source === 'hermes');
    });
    await expect(f.call('start_chat', { backend: 'hermes', text: CONTENT })).rejects.toMatchObject({ code: 'maintenance' });
    expect(f.sources.hermes.calls.some((c) => c.startsWith('create:'))).toBe(false);
  });
});

describe('quiet counts', () => {
  it.each(['tasks.json', 'tasks-quiet.json'])('keeps existing %s evidence unknown when its task counter is absent', async (file) => {
    const f = fixture();
    f.hold.set(true);
    writeFileSync(join(f.dir, file), JSON.stringify({ tasks: [], bridgeStarts: [
      { id: '00000000-0000-4000-8000-000000000007', chat: 'h1', at: T0 },
    ] }));
    expect(await f.report()).toMatchObject({ quiet: false, pendingRelays: null, runningTasks: null,
      reasons: expect.arrayContaining(['tasks_unavailable']) });
  });

  it.each(['submission', 'callback'])('logs only reason codes when a queued %s fails', async (failure) => {
    const f = fixture();
    const warnings = vi.spyOn(log, 'warn');
    if (failure === 'submission') {
      f.chats[1]!.status = 'running';
      await f.call('send_message', { chat: 'paseo:recipient', text: CONTENT });
      f.chats[1]!.status = 'idle';
      vi.spyOn(f.sources.paseo, 'sendMessage').mockRejectedValue(new Error(CONTENT));
    } else {
      const message = f.system('demo-callback');
      message.delivered = () => { throw new Error(CONTENT); };
      f.bridge.deliverSystem(message);
    }
    for (let attempt = 0; attempt < 3; attempt++) await f.bridge.deliverQueued();
    expect(warnings).toHaveBeenCalled();
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(CONTENT);
    expect(warnings).toHaveBeenLastCalledWith(expect.objectContaining({ reason: expect.any(String) }), expect.any(String));
  });

  it('fails closed when a backend status cannot be read', async () => {
    const f = fixture();
    f.hold.set(true);
    vi.mocked(f.sources.paseo.status).mockImplementation(() => { throw new Error(CONTENT); });
    const result = await f.report();
    expect(result).toMatchObject({ quiet: false, runningTasks: null, reasons: expect.arrayContaining(['paseo_activity_unavailable']) });
    expect(JSON.stringify(result)).not.toContain(CONTENT);
  });

  it.each(['bridge', 'tasks'] as const)('reports an unreadable %s count as unknown without leaking its error', async (source) => {
    const f = fixture();
    f.hold.set(true);
    const unavailable = () => { throw new Error(CONTENT); };
    const result = await quietReport({ hold: f.hold, sources: f.sources,
      ...(source === 'bridge' ? { bridge: { quietCounts: unavailable } } : { tasks: { quietCounts: unavailable } }) });
    expect(result).toMatchObject({ quiet: false, reasons: expect.arrayContaining([`${source}_unavailable`]) });
    if (source === 'bridge') expect(result.bridgeWaiters).toBeNull();
    else expect(result.pendingRelays).toBeNull();
    expect(JSON.stringify(result)).not.toContain(CONTENT);
  });

  it('never certifies a filtered or unreadable task ledger as empty', async () => {
    const f = fixture();
    writeFileSync(join(f.dir, 'tasks.json'), '{');
    const store = new TaskStore(f.dir, () => T0, undefined, log);
    const relay = new TaskRelay({ store, bridge: f.bridge, background, hub: f.hub, log, tickMs: 0,
      setting: new WorkerUpdatesSetting(f.dir), workers: { agentsLoaded: true, workerSnapshots: () => [],
        workerSnapshot: () => undefined, lookUp: async () => null, lastMessage: vi.fn() },
      chats: { connected: () => true, rows: vi.fn(), find: vi.fn(), origin: vi.fn() } });
    f.hold.set(true);
    expect(await quietReport({ hold: f.hold, sources: f.sources, tasks: relay }))
      .toMatchObject({ quiet: false, pendingRelays: null, runningTasks: null, reasons: ['tasks_unavailable'] });
  });

  it('refreshes complete activity and approvals with no devices, including work absent from the inbox', async () => {
    const f = fixture();
    f.hold.set(true);
    expect(f.hub.size).toBe(0);
    const activity = vi.fn().mockResolvedValue({ complete: true, runningTasks: 1, openApprovalPrompts: 2 });
    Object.assign(f.sources.hermes, { activitySnapshot: activity });
    expect(await f.report()).toMatchObject({ quiet: false, runningTasks: 1, openApprovalPrompts: 2 });
    activity.mockResolvedValue({ complete: true, runningTasks: 0, openApprovalPrompts: 0 });
    expect((await f.report()).quiet).toBe(true);
    expect(activity).toHaveBeenCalledTimes(2);
  });

  it.each([
    { complete: false, runningTasks: 0, openApprovalPrompts: 0 },
    { complete: true, runningTasks: -1, openApprovalPrompts: 0 },
    { complete: true, runningTasks: 0, openApprovalPrompts: Number.NaN },
    { complete: true, runningTasks: 0.5, openApprovalPrompts: 0 },
  ])('refuses incomplete or invalid activity evidence: %j', async (snapshot) => {
    const f = fixture();
    f.hold.set(true);
    Object.assign(f.sources.hermes, { activitySnapshot: async () => snapshot });
    expect(await f.report()).toMatchObject({ quiet: false, reasons: expect.any(Array) });
  });

  it('counts disabled backends as verified zeros', async () => {
    const f = fixture();
    f.hold.set(true);
    expect(await quietReport({ hold: f.hold, sources: { hermes: new DisabledHermes(), paseo: new DisabledPaseo() } }))
      .toEqual({ held: true, quiet: true, bridgeWaiters: 0, queuedMessages: 0, pendingRelays: 0,
        pendingDeliveries: 0, runningTasks: 0, openApprovalPrompts: 0 });
  });

  it('counts an unrecovered durable launch while an archived worker lookup is pending', async () => {
    const f = fixture();
    const id = '00000000-0000-4000-8000-000000000002';
    const store = new TaskStore(f.dir, () => T0, undefined, log);
    store.recordBridgeStart(id, 'h1', T0 - 600_000);
    store.save();
    const reloaded = new TaskStore(f.dir, () => T0, undefined, log);
    let recover!: (value: null) => void;
    const workers = { agentsLoaded: true, workerSnapshots: () => [], workerSnapshot: () => undefined,
      lookUp: vi.fn(() => new Promise<null>((resolve) => { recover = resolve; })), lastMessage: vi.fn() };
    const relay = new TaskRelay({ store: reloaded, bridge: f.bridge, background, hub: f.hub, log,
      now: () => T0, tickMs: 0, setting: new WorkerUpdatesSetting(f.dir), workers,
      chats: { connected: () => false, rows: vi.fn(async () => []), find: vi.fn(async () => undefined), origin: vi.fn(async () => undefined) } });
    f.hold.set(true);
    const report = () => quietReport({ hold: f.hold, bridge: f.bridge, sources: f.sources, tasks: relay });
    expect(await report()).toMatchObject({ quiet: false, pendingRelays: 1 });
    const tick = relay.tick();
    await vi.waitFor(() => expect(workers.lookUp).toHaveBeenCalledWith(id));
    expect(reloaded.get(id)).toBeUndefined();
    expect(await report()).toMatchObject({ quiet: false, pendingRelays: 1 });
    recover(null);
    await tick;
    expect(reloaded.get(id)).toMatchObject({ verified: true, status: 'stopped' });
    expect(await report()).toMatchObject({ quiet: false, pendingRelays: 1 });
    reloaded.get(id)!.relays.push({ id: 'stopped#1', kind: 'update', attempts: 1, deliveredAt: T0 });
    expect((await report()).quiet).toBe(true);
  });

  it.each(['hermes', 'paseo'] as const)('rechecks %s after the other backend finishes a delayed read', async (backend) => {
    const f = fixture();
    f.hold.set(true);
    const other = backend === 'hermes' ? 'paseo' : 'hermes';
    let finish!: (rows: ConversationSummary[]) => void;
    if (other === 'hermes') Reflect.get(f.sources.hermes, 'activitySnapshot').mockImplementation(() => new Promise((resolve) => {
      finish = (conversations) => resolve({ complete: true, runningTasks: 0, openApprovalPrompts: 0, conversations });
    }));
    else vi.mocked(f.sources.paseo.listConversations).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const report = f.report();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    vi.mocked(f.sources[backend].status).mockReturnValue({ source: backend, state: 'disconnected' });
    finish([]);
    expect(await report).toMatchObject({ quiet: false, reasons: expect.any(Array) });
  });

  it.each(['hermes', 'paseo'] as const)('rejects an intervening %s reconnect during a delayed read', async (backend) => {
    const f = fixture();
    f.hold.set(true);
    const other = backend === 'hermes' ? 'paseo' : 'hermes';
    let finish!: (rows: ConversationSummary[]) => void;
    if (other === 'hermes') Reflect.get(f.sources.hermes, 'activitySnapshot').mockImplementation(() => new Promise((resolve) => {
      finish = (conversations) => resolve({ complete: true, runningTasks: 0, openApprovalPrompts: 0, conversations });
    }));
    else vi.mocked(f.sources.paseo.listConversations).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const report = f.report();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const status = vi.mocked(f.sources[backend].status);
    status.mockReturnValue({ source: backend, state: 'disconnected' });
    status.mockReturnValue({ source: backend, state: 'connected' });
    finish([]);
    expect(await report).toMatchObject({ quiet: false, reasons: expect.any(Array) });
  });

  it('rechecks whether the Paseo list is loaded after a delayed Hermes read', async () => {
    const f = fixture();
    f.hold.set(true);
    let finish!: (rows: ConversationSummary[]) => void;
    Reflect.get(f.sources.hermes, 'activitySnapshot').mockImplementation(() => new Promise((resolve) => {
      finish = (conversations) => resolve({ complete: true, runningTasks: 0, openApprovalPrompts: 0, conversations });
    }));
    const report = f.report();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    Object.defineProperty(f.sources.paseo, 'agentsLoaded', { configurable: true, value: false });
    finish([]);
    expect(await report).toMatchObject({ quiet: false, reasons: expect.any(Array) });
  });

  it('becomes quiet only after the hold is set and waits and queues drain', async () => {
    const f = fixture();
    expect(await f.report()).toMatchObject({ quiet: false, held: false, runningTasks: 0 });
    const recipient = f.chats[1]!;
    recipient.status = 'running';
    const wait = f.call('wait_for_reply', { chat: 'paseo:recipient', timeout_seconds: 120 });
    await vi.waitFor(() => expect(f.bridge.activeWaits).toBe(1));
    await f.call('send_message', { chat: 'paseo:recipient', text: CONTENT });
    const message = f.system('already-admitted');
    f.bridge.deliverSystem(message);
    f.hold.set(true);
    expect(await f.report()).toMatchObject({ held: true, quiet: false, bridgeWaiters: 1, queuedMessages: 2, pendingDeliveries: 0, runningTasks: 1 });
    recipient.status = 'idle';
    await f.bridge.tick();
    f.advance(10_001);
    await f.bridge.tick();
    await expect(wait).resolves.toMatchObject({ kind: 'finished' });
    expect(message.delivered).toHaveBeenCalledOnce();
    expect(await f.report()).toEqual({ held: true, quiet: true, bridgeWaiters: 0, queuedMessages: 0, pendingRelays: 0,
      pendingDeliveries: 0, runningTasks: 0, openApprovalPrompts: 0 });
    f.hold.set(false);
    expect((await f.report()).quiet).toBe(false);
  });

  it('allows a reply to finish an existing wait while held', async () => {
    const f = fixture();
    const wait = f.call('wait_for_reply', { chat: 'paseo:recipient', timeout_seconds: 120 });
    await vi.waitFor(() => expect(f.bridge.activeWaits).toBe(1));
    f.hold.set(true);
    await f.bridge.call('send_message', { chat: 'paseo:caller', text: 'Demo reply' }, { paseoAgent: 'recipient', cwd: PROJECT });
    await expect(wait).resolves.toMatchObject({ kind: 'reply', text: 'Demo reply' });
    expect((await f.report()).quiet).toBe(true);
  });

  it('holds quiet false while a backend acknowledges an admitted delivery', async () => {
    const f = fixture();
    let acknowledge!: () => void;
    vi.spyOn(f.sources.paseo, 'sendMessage').mockImplementation(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    const sent = f.call('send_message', { chat: 'paseo:recipient', text: CONTENT });
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
    f.hold.set(true);
    expect(await f.report()).toMatchObject({ quiet: false, pendingDeliveries: 1 });
    acknowledge();
    await sent;
    expect(await f.report()).toMatchObject({ quiet: false, pendingDeliveries: 1 });
    f.advance(10_001);
    expect((await f.report()).quiet).toBe(true);
  });

  it('keeps a newly launched chat pending until backend status is visible and settled', async () => {
    const f = fixture();
    await f.call('start_chat', { backend: 'hermes', text: 'Demo start' });
    f.hold.set(true);
    expect(await f.report()).toMatchObject({ quiet: false, pendingDeliveries: 1 });
    f.chats.push({ ...f.chats[2]!, id: 'new-hermes' });
    expect(await f.report()).toMatchObject({ quiet: false, pendingDeliveries: 1 });
    f.advance(10_001);
    expect((await f.report()).quiet).toBe(true);
  });

  it('allows completion relays for work admitted before the hold, including after restart', () => {
    const f = fixture();
    f.hold.set(true);
    const first = f.system('old-task-completion', T0 - 1);
    expect(f.bridge.deliverSystem(first)).toBe('queued');
    expect(f.bridge.deliverSystem(first)).toBe('already queued');
    const restarted = new Bridge({ stateDir: f.dir, sources: f.sources, hub: f.hub, background, log, pollMs: 0 });
    cleanups.push(() => restarted.stop());
    expect(restarted.deliverSystem(f.system('recovered-completion', T0 - 1))).toBe('queued');
    expect(() => restarted.deliverSystem(f.system('new-task-completion', T0 + 1))).toThrow(MAINTENANCE_MESSAGE);
  });

  it('counts durable relays, tasks and prompts without returning any content', async () => {
    const f = fixture();
    const store = new TaskStore(f.dir, () => T0, undefined, log);
    const task: TaskRecord = { id: '00000000-0000-4000-8000-000000000001', provider: 'demo', cwd: PROJECT,
      title: CONTENT, chat: 'h1', verified: true, status: 'running', round: 1, dueMinutes: 60,
      createdAt: T0 - 100, startedAt: T0 - 100, dueAt: T0 + 60_000, since: T0 - 100,
      changedAt: T0 - 100, lastSeen: T0, criteria: [CONTENT],
      relays: [{ id: 'overdue#1', kind: 'overdue', attempts: 0, held: CONTENT, queuedAt: T0 - 50 }] };
    store.add(task); store.save();
    const reloaded = new TaskStore(f.dir, () => T0, undefined, log);
    const relay = new TaskRelay({ store: reloaded, bridge: f.bridge,
      background, hub: f.hub, log, now: () => T0, tickMs: 0, setting: new WorkerUpdatesSetting(f.dir),
      workers: { agentsLoaded: false, workerSnapshots: () => [], workerSnapshot: () => undefined, lookUp: async () => null, lastMessage: vi.fn() },
      chats: { connected: () => false, rows: vi.fn(async () => []), find: vi.fn(async () => undefined), origin: vi.fn(async () => undefined) } });
    const saved = reloaded.get(task.id)!;
    const approval = { id: 'demo-approval', source: 'paseo', conversationId: 'recipient', prompt: CONTENT } as unknown as Approval;
    vi.spyOn(f.sources.paseo, 'listApprovals').mockReturnValue([approval]);
    f.chats[1]!.pendingApprovals = 1;
    f.hold.set(true);
    const report = () => quietReport({ hold: f.hold, bridge: f.bridge, sources: f.sources, tasks: relay });
    const first = await report();
    expect(first).toMatchObject({ quiet: false, runningTasks: 1, pendingRelays: 1, openApprovalPrompts: 1 });
    expect(JSON.stringify(first)).not.toContain(CONTENT);
    expect(Object.keys(first).sort()).toEqual(['held', 'quiet', 'bridgeWaiters', 'queuedMessages', 'pendingRelays', 'pendingDeliveries', 'runningTasks', 'openApprovalPrompts', 'reasons'].sort());
    saved.status = 'finished';
    saved.relays[0]!.deliveredAt = T0;
    expect((await report()).pendingRelays).toBe(1);
    saved.relays.push({ id: 'finished#1', kind: 'update', attempts: 1, deliveredAt: T0 });
    vi.mocked(f.sources.paseo.listApprovals).mockReturnValue([]);
    f.chats[1]!.pendingApprovals = 0;
    expect((await report()).quiet).toBe(false);
    relay.consider({ id: task.id, provider: 'demo', cwd: PROJECT, status: 'idle', loaded: true,
      pendingPermissions: 0, labels: {} }, T0);
    expect((await report()).quiet).toBe(true);
  });

  it('does not certify an unavailable backend or a hold changed during the check', async () => {
    const f = fixture();
    f.hold.set(true);
    vi.spyOn(f.sources.paseo, 'status').mockReturnValue({ source: 'paseo', state: 'disconnected' });
    expect(await f.report()).toMatchObject({ quiet: false, reasons: expect.any(Array) });
    vi.mocked(f.sources.paseo.status).mockReturnValue({ source: 'paseo', state: 'connected' });
    vi.mocked(f.sources.paseo.listConversations).mockImplementation(async () => {
      f.hold.set(false); f.hold.set(true);
      return f.chats.filter((c) => c.source === 'paseo');
    });
    expect((await f.report()).quiet).toBe(false);
  });

  it('refuses unloaded backend lists and sanitizes backend failures', async () => {
    const f = fixture();
    f.hold.set(true);
    Object.defineProperty(f.sources.paseo, 'agentsLoaded', { configurable: true, value: false });
    expect(await f.report()).toMatchObject({ quiet: false, reasons: expect.any(Array) });
    Object.defineProperty(f.sources.paseo, 'agentsLoaded', { configurable: true, value: true });
    vi.mocked(f.sources.paseo.listConversations).mockRejectedValue(new Error(CONTENT));
    expect(await f.report()).toMatchObject({ quiet: false, reasons: expect.any(Array) });
  });

  it('counts running tasks once when they also appear in the backend list', async () => {
    const f = fixture();
    f.hold.set(true);
    f.chats[1]!.status = 'running';
    const tasks = { quietCounts: () => ({ runningTaskIds: ['recipient'], pendingRelays: 0 }) };
    expect(await quietReport({ hold: f.hold, sources: f.sources, bridge: f.bridge, tasks })).toMatchObject({ runningTasks: 1 });
  });
});

describe('owner administration', () => {
  async function appFixture(origin = 'https://127.0.0.1:19014', port = 19014, role: 'primary' | 'shadow' = 'primary') {
    const f = fixture();
    seedDevices(f.dir);
    const config = makeConfig(undefined, { listen: { port: role === 'shadow' ? 19100 : 19010 }, localListener: { port }, origins: [origin] });
    roots.push(config.stateDir);
    config.stateDir = f.dir;
    config.role = role;
    const app = await buildApp({ config, sources: f.sources, bridge: f.bridge, hub: f.hub, logger: false,
      verifier: async () => ({ email: 'you@example.com', exp: 2_000_000_000 }) });
    let local = false;
    app.addHook('onRequest', async (req) => { Object.defineProperty(req.raw.socket, 'localPort', { configurable: true, value: local ? port : 19010 }); });
    cleanups.push(() => app.close());
    const localHeaders = { host: new URL(origin).host, origin, 'content-type': 'application/json',
      cookie: DESKTOP_COOKIE, 'x-wayroost-app': 'desktop', 'x-wayroost-request': '1' };
    return { ...f, app, localHeaders, setLocal: (value: boolean) => { local = value; } };
  }

  it.each([
    ['https://127.0.0.1', 443],
    ['http://127.0.0.1', 80],
  ] as const)('allows local administration through the default port for %s', async (origin, port) => {
    const f = await appFixture(origin, port);
    f.setLocal(true);
    const write = (held: boolean) => f.app.inject({ method: 'PUT', url: '/api/bridge/maintenance', headers: f.localHeaders, payload: { held } });
    const hold = await write(true);
    expect(hold.statusCode).toBe(200);
    expect(hold.json()).toEqual({ held: true });
    const quiet = await f.app.inject({ url: '/api/bridge/quiet', headers: f.localHeaders });
    expect(quiet.statusCode).toBe(200);
    expect(quiet.json().quiet).toBe(true);
    expect((await write(false)).json()).toEqual({ held: false });
    f.setLocal(false);
    expect((await write(true)).statusCode).toBe(403);
  });

  it.each([false, true])('refuses hold and release through a shadow local route while held: %s', async (held) => {
    const f = await appFixture('https://127.0.0.1:19014', 19014, 'shadow');
    f.hold.set(held);
    f.setLocal(true);
    for (const next of [true, false]) {
      const result = await f.app.inject({ method: 'PUT', url: '/api/bridge/maintenance', headers: f.localHeaders, payload: { held: next } });
      expect(result.statusCode).toBe(503);
      expect(f.hold.isHeld()).toBe(held);
    }
    expect((await f.app.inject({ url: '/api/bridge/quiet', headers: f.localHeaders })).statusCode).toBe(200);
  });

  it('denies the public origin and main listener, and lets only a local paired desktop hold and release', async () => {
    const f = await appFixture();
    const write = (headers: Record<string, string>, held: boolean) => f.app.inject({ method: 'PUT', url: '/api/bridge/maintenance', headers, payload: { held } });
    expect((await write(postHeaders('fake'), true)).statusCode).toBe(403);
    expect(f.hold.isHeld()).toBe(false);
    expect((await write(f.localHeaders, true)).statusCode).toBe(403);
    f.setLocal(true);
    expect((await write({ ...f.localHeaders, cookie: PHONE_COOKIE }, true)).statusCode).toBe(403);
    expect((await write({ ...f.localHeaders, cookie: '' }, true)).statusCode).toBe(401);
    expect((await write({ ...f.localHeaders, 'cf-ray': 'fake-ray' }, true)).statusCode).toBe(421);
    expect((await write(f.localHeaders, true)).json()).toEqual({ held: true });
    expect((await f.app.inject({ url: '/api/bridge', headers: apiHeaders('fake') })).json().maintenance).toBe(true);
    expect((await f.app.inject({ url: '/api/bridge/quiet', headers: apiHeaders('fake') })).statusCode).toBe(403);
    expect((await f.app.inject({ url: '/api/bridge/quiet', headers: f.localHeaders })).json().quiet).toBe(true);
    expect((await write(postHeaders('fake'), false)).statusCode).toBe(403);
    expect(f.hold.isHeld()).toBe(true);
    expect((await write(f.localHeaders, false)).json()).toEqual({ held: false });
  });

  it('publishes banner state to owner devices after hold and release', async () => {
    const f = await appFixture();
    f.setLocal(true);
    const events: unknown[] = [];
    f.hub.add({ readyState: 1, bufferedAmount: 0, send: (payload: string) => events.push(JSON.parse(payload)) } as never, 'you@example.com');
    for (const held of [true, false]) {
      await f.app.inject({ method: 'PUT', url: '/api/bridge/maintenance', headers: f.localHeaders, payload: { held } });
      expect(events.at(-1)).toMatchObject({ type: 'source_status', maintenance: held });
    }
  });

  it('serves hold, quiet and release as JSON through the fixed-config CLI and a private Unix socket', async () => {
    const f = fixture();
    const admin = await startMaintenanceAdmin(f.dir, f.hold, f.report);
    cleanups.push(() => new Promise<void>((resolve) => admin.close(() => resolve())));
    const socketPath = join(f.dir, MAINTENANCE_SOCKET);
    expect(statSync(join(f.dir, 'bridge-admin')).mode & 0o777).toBe(0o700);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    const config = join(f.dir, 'config.json');
    const id = join(f.dir, 'test-id');
    const wrapper = join(f.dir, 'wayroost');
    writeFileSync(config, JSON.stringify({ stateDir: f.dir }));
    writeFileSync(id, '#!/bin/sh\necho 0\n', { mode: 0o700 });
    writeFileSync(wrapper, readFileSync(new URL('../../deploy/wayroost.sh', import.meta.url), 'utf8')
      .replaceAll('@NODE@', process.execPath).replaceAll('@CONFIG@', config).replaceAll('@ID@', id).replaceAll('@PAIR_CODE@', join(f.dir, 'pair-code.js')));
    for (const command of ['hold', 'quiet', 'release', 'quiet']) {
      const result = await run('/bin/bash', ['-p', wrapper, command], { env: { CONFIG: '/home/me/ignored.json', NODE: '/home/me/ignored-node' } });
      const reply = JSON.parse(result.stdout) as QuietReport | { held: boolean };
      expect(result.stderr).toBe('');
      expect(reply.held).toBe(command === 'hold' || command === 'quiet' && f.hold.isHeld());
      if (command === 'quiet') expect((reply as QuietReport).quiet).toBe(f.hold.isHeld());
    }
    expect((await run('/bin/bash', ['-p', wrapper, '--help'])).stderr).toContain('sudo wayroost quiet');
    await expect(run('/bin/bash', ['-p', wrapper, 'hold', '--config', config])).rejects.toMatchObject({ code: 2 });
    writeFileSync(id, '#!/bin/sh\necho 1000\n', { mode: 0o700 });
    await expect(run('/bin/bash', ['-p', wrapper, 'hold'])).rejects.toMatchObject({ code: 1 });
  });

  it.each([false, true])('refuses shadow socket writes while held: %s', async (held) => {
    const f = fixture();
    f.hold.set(held);
    const admin = await startMaintenanceAdmin(f.dir, f.hold, f.report, new BackgroundGate('shadow'));
    cleanups.push(() => new Promise<void>((resolve) => admin.close(() => resolve())));
    for (const command of ['hold', 'release', 'quiet']) {
      const output = await new Promise<string>((resolve, reject) => {
        const socket = connect(join(f.dir, MAINTENANCE_SOCKET));
        let result = '';
        socket.setEncoding('utf8'); socket.on('error', reject);
        socket.on('connect', () => socket.write(`${JSON.stringify({ command })}\n`));
        socket.on('data', (chunk: string) => { result += chunk; }); socket.on('close', () => resolve(result));
      });
      expect(JSON.parse(output)).toMatchObject(command === 'quiet' ? { held } : { error: 'unavailable' });
      expect(f.hold.isHeld()).toBe(held);
    }
  });

  it.each([
    [{}, hostPaths.primaryState],
    [{ WAYROOST_ROLE: 'shadow' }, hostPaths.shadowState],
    [{ SIGNALBOX_ROLE: 'shadow' }, hostPaths.shadowState],
    [{ WAYROOST_ROLE: 'primary', SIGNALBOX_ROLE: 'shadow' }, hostPaths.primaryState],
  ])('uses the role default for the CLI socket with %j', async (env, expected) => {
    const dir = directory();
    const config = join(dir, 'config.json');
    const id = join(dir, 'test-id');
    const preload = join(dir, 'connect.mjs');
    const node = join(dir, 'test-node');
    const wrapper = join(dir, 'wayroost');
    writeFileSync(config, '{}');
    writeFileSync(id, '#!/bin/sh\necho 0\n', { mode: 0o700 });
    writeFileSync(preload, `import net from 'node:net';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
net.connect = path => {
  const socket = new EventEmitter();
  socket.setEncoding = socket.setTimeout = () => socket;
  socket.write = () => { socket.emit('data', JSON.stringify({ path })); socket.emit('close'); };
  queueMicrotask(() => socket.emit('connect'));
  return socket;
};
syncBuiltinESMExports();
`);
    writeFileSync(node, `#!/bin/sh\nexec '${process.execPath}' --import '${preload}' "$@"\n`, { mode: 0o700 });
    writeFileSync(wrapper, readFileSync(new URL('../../deploy/wayroost.sh', import.meta.url), 'utf8')
      .replaceAll('@NODE@', node).replaceAll('@CONFIG@', config).replaceAll('@ID@', id));
    const result = await run('/bin/bash', ['-p', wrapper, 'quiet'], { env });
    expect(JSON.parse(result.stdout)).toEqual({ path: join(expected, MAINTENANCE_SOCKET) });
  });

  it('returns a bounded error for unsupported socket commands', async () => {
    const f = fixture();
    const admin: Server = await startMaintenanceAdmin(f.dir, f.hold, f.report);
    cleanups.push(() => new Promise<void>((resolve) => admin.close(() => resolve())));
    const output = await new Promise<string>((resolve, reject) => {
      const socket = connect(join(f.dir, MAINTENANCE_SOCKET));
      let result = '';
      socket.setEncoding('utf8'); socket.on('error', reject);
      socket.on('connect', () => socket.write(`${JSON.stringify({ command: CONTENT })}\n`));
      socket.on('data', (chunk: string) => { result += chunk; }); socket.on('close', () => resolve(result));
    });
    expect(JSON.parse(output)).toEqual({ error: 'bad_request' });
    expect(f.hold.isHeld()).toBe(false);
  });
});
