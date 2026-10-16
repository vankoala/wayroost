import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import type { AgentSnapshotPayload } from '@getpaseo/protocol/messages';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { BackgroundGate } from '../src/background.js';
import { Bridge } from '../src/bridge/service.js';
import { quietReport } from '../src/bridge/quiet.js';
import { DisabledHermes } from '../src/disabled.js';
import { HermesAdapter } from '../src/hermes/adapter.js';
import type { HermesAuth } from '../src/hermes/auth.js';
import type { HermesGateway } from '../src/hermes/gateway.js';
import type { HermesMessageRow } from '../src/hermes/normalize.js';
import { EventHub } from '../src/hub.js';
import { Lineage } from '../src/lineage.js';
import { PaseoAdapter } from '../src/paseo/adapter.js';
import { SecretStore } from '../src/secrets.js';
import { TaskRelay } from '../src/tasks/relay.js';
import { WorkerUpdatesSetting } from '../src/tasks/setting.js';
import { TaskStore } from '../src/tasks/store.js';
import { paseoWorkers } from '../src/tasks/wire.js';
import { DESKTOP_COOKIE, makeConfig } from './helpers.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const background = new BackgroundGate('primary');
const historyIO = vi.hoisted(() => ({ failAppend: false, failLineage: false,
  failQuietMarker: false as false | 'all' | 'sync' | 'directory sync' }));
vi.mock('node:fs', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => {
    if (args[1] === 'wx' && historyIO.failQuietMarker === 'all' && /\/lineage-quiet(?:-save)?\.json$/.test(String(args[0]))) {
      throw Object.assign(new Error('Fixture storage full'), { code: 'ENOSPC' });
    }
    if (historyIO.failAppend && String(args[0]).endsWith('/task-events.jsonl') && args[1] === 'a') {
      throw Object.assign(new Error('Fixture storage full'), { code: 'ENOSPC' });
    }
    return fs.openSync(...args);
  }, fsyncSync: (fd: number) => {
    if (historyIO.failQuietMarker === 'sync' || historyIO.failQuietMarker === 'directory sync' && fs.fstatSync(fd).isDirectory()) {
      throw Object.assign(new Error('Fixture sync failed'), { code: 'EIO' });
    }
    return fs.fsyncSync(fd);
  }, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (historyIO.failLineage && /\/lineage\.json\.\d+\.tmp$/.test(String(args[0]))) {
      throw Object.assign(new Error('Fixture storage full'), { code: 'ENOSPC' });
    }
    return fs.writeFileSync(...args);
  } };
});
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  historyIO.failAppend = false;
  historyIO.failLineage = false;
  historyIO.failQuietMarker = false;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture(disabled = false, historyDirectory?: string, stateDir?: string) {
  const config = makeConfig(undefined, { role: 'primary', hermes: { enabled: !disabled }, localListener: { port: 19014 }, origins: ['https://127.0.0.1:19014'] });
  const freshDir = config.stateDir;
  cleanups.push(() => rmSync(freshDir, { recursive: true, force: true }));
  if (stateDir) config.stateDir = stateDir;
  const hub = new EventHub();
  const lineage = new Lineage(config.stateDir, log, undefined, background);
  const hermes = new HermesAdapter('http://example.com', hub, new SecretStore(config.stateDir), log, { background, lineage });
  const paseo = new PaseoAdapter('ws://example.com', hub, log, 'fake-client', undefined, background);
  paseo.useLineage(lineage);
  const gateway = Reflect.get(hermes, 'gateway') as HermesGateway;
  Object.assign(gateway, { state: 'ready' });
  Reflect.set(hermes, 'statusValue', { source: 'hermes', state: 'connected' });
  Object.assign(paseo, { listLoaded: true, statusValue: { source: 'paseo', state: 'connected' } });
  const client = { close: async () => {}, getLastServerInfoMessage: () => ({ features: { providerSubagents: true } }),
    listProviderSubagents: vi.fn(async () => ({ subagents: [] })), fetchAgents: vi.fn(async () => ({
    entries: [...(Reflect.get(paseo, 'agents') as Map<string, AgentSnapshotPayload>).values()].map((agent) => ({ agent, project: null })),
    pageInfo: { hasMore: false, nextCursor: null as string | null, prevCursor: null },
  })) };
  Reflect.set(paseo, 'client', client);
  const runtime: Array<{ id: string; session_key: string; status: string }> = [];
  const runs: Array<{ id: string; parent_session_id: string; is_active: boolean }> = [];
  const rpc = vi.spyOn(gateway, 'call').mockImplementation(async () => ({ sessions: runtime.map((session) => ({ ...session })) }) as never);
  const auth = Reflect.get(hermes, 'auth') as HermesAuth;
  const dashboard = vi.spyOn(auth, 'json').mockImplementation(async (path) => {
    if (path === '/api/config/defaults') return { sessions: { show_subagents: false } };
    if (path === '/api/config') return { sessions: { show_subagents: true } };
    if (path === '/api/chat/workspaces') return {};
    if (path.startsWith('/api/sessions?')) {
      const sessions = path.includes('subagent') ? runs : [];
      return { sessions, total: sessions.length };
    }
    throw new Error('Fixture data is unavailable');
  });
  const sources = { hermes: disabled ? new DisabledHermes() : hermes, paseo };
  const bridge = new Bridge({ stateDir: config.stateDir, sources, hub, background, log, pollMs: 0, lineage });
  const hold = bridge.maintenanceHold(config.stateDir);
  if (historyDirectory) mkdirSync(join(config.stateDir, historyDirectory));
  const store = new TaskStore(config.stateDir, Date.now, undefined, log);
  const tasks = new TaskRelay({ store, bridge, workers: paseoWorkers(paseo), setting: new WorkerUpdatesSetting(config.stateDir), hub,
    background, log, tickMs: 0, chats: { connected: () => true, rows: async () => [], find: async () => undefined, origin: async () => 'tui' } });
  const app = await buildApp({ config, sources, bridge, tasks, hub, logger: false, verifier: async () => ({ email: 'you@example.com', exp: 2_000_000_000 }) });
  app.addHook('onRequest', async (req) => {
    Object.defineProperty(req.raw.socket, 'localPort', { configurable: true, value: 19014 });
  });
  const headers = { host: '127.0.0.1:19014', origin: 'https://127.0.0.1:19014', cookie: DESKTOP_COOKIE,
    'x-wayroost-app': 'desktop', 'x-wayroost-request': '1', 'content-type': 'application/json' };
  let stopped = false;
  const stop = async (saveLineage = true) => {
    if (stopped) return;
    stopped = true;
    await app.close();
    tasks.stop(); bridge.stop(); hermes.stop(); paseo.stop();
    if (saveLineage) lineage.save();
    lineage.close();
  };
  cleanups.push(stop);
  const quiet = async () => {
    const response = await app.inject({ url: '/api/bridge/quiet', headers });
    expect(response.statusCode).toBe(200);
    const report = response.json();
    expect(JSON.stringify(report)).not.toMatch(/Fixture|message|title|prompt|content/);
    return report;
  };
  const held = await app.inject({ method: 'PUT', url: '/api/bridge/maintenance', headers, payload: { held: true } });
  expect(held.json()).toEqual({ held: true });
  return { config, hub, hermes, paseo, client, gateway, runtime, runs, rpc, dashboard, bridge, hold, quiet, tasks, lineage, stop };
}

function terminalWorker(f: Awaited<ReturnType<typeof fixture>>, id: string, chat = 'fake-chat', createdAt = Date.now()) {
  const agent = { id, provider: 'demo', cwd: '/home/me/app', status: 'idle',
    labels: { 'wayroost.parent-hermes-chat': chat }, pendingPermissions: [],
    capabilities: { supportsStreaming: true }, createdAt: new Date(createdAt).toISOString(), updatedAt: new Date(createdAt).toISOString() };
  Reflect.get(f.paseo, 'agents').set(id, agent);
  return agent;
}

function launchRows(id: string, at: number): HermesMessageRow[] {
  return [
    { id: 1, role: 'assistant', content: '', timestamp: at / 1_000, tool_calls: [{ id: 'fake-launch',
      function: { name: 'terminal', arguments: JSON.stringify({ command: 'paseo run -d --provider demo "Fixture"' }) } }] },
    { id: 2, role: 'tool', tool_call_id: 'fake-launch', timestamp: (at + 1) / 1_000,
      content: JSON.stringify({ output: `AGENT ID  STATUS  PROVIDER  CWD  TITLE\n${id}  running  demo  /home/me/app  Fixture`, exit_code: 0, error: null }) },
  ];
}

it.each([0, 1])('includes a launch verified while activity results settle, delay: %s', async (delay) => {
  const f = await fixture();
  const store = Reflect.get(f.tasks, 'deps').store as TaskStore;
  let now = Date.now();
  const createdAt = now;
  const id = '00000000-0000-4000-8000-000000000099';
  Reflect.set(f.tasks, 'now', () => now);
  terminalWorker(f, id, 'fake-chat', createdAt);
  const rows = vi.fn<() => Promise<HermesMessageRow[]>>().mockResolvedValueOnce([]);
  Reflect.get(f.tasks, 'deps').chats.rows = rows;
  await f.tasks.tick();
  expect(store.get(id)).toMatchObject({ status: 'finished', verified: false });
  expect(await f.quiet()).toMatchObject({ held: true, quiet: true, pendingRelays: 0 });

  now += 31_000;
  let finish!: (rows: HermesMessageRow[]) => void;
  rows.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const tick = f.tasks.tick();
  expect(finish).toBeTypeOf('function');
  const readActivity = f.paseo.readActivityConversations.bind(f.paseo);
  vi.spyOn(f.paseo, 'readActivityConversations').mockImplementation(async (...args) => {
    const snapshot = await readActivity(...args);
    queueMicrotask(() => {
      if (delay) queueMicrotask(() => finish(launchRows(id, createdAt)));
      else finish(launchRows(id, createdAt));
    });
    return snapshot;
  });
  const activitySnapshot = f.hermes.activitySnapshot.bind(f.hermes);
  let pendingAtValidation: number | undefined;
  vi.spyOn(f.hermes, 'activitySnapshot').mockImplementation(async () => {
    const snapshot = await activitySnapshot();
    return { ...snapshot, isCurrent: () => {
      pendingAtValidation = f.tasks.quietCounts().pendingRelays;
      return snapshot.isCurrent?.() ?? true;
    } };
  });
  const report = await quietReport({ hold: f.hold, bridge: f.bridge, tasks: f.tasks,
    sources: { hermes: f.hermes, paseo: f.paseo } });
  await tick;
  expect(store.get(id)).toMatchObject({ status: 'finished', verified: true });
  expect(pendingAtValidation).toBe(1);
  expect(report).toMatchObject({ held: true, quiet: false, pendingRelays: 1 });
});

it.each(['per chat', 'global'] as const)('keeps capped workers unreconciled until recorded or removed: %s', async (cap) => {
  const f = await fixture();
  const store = Reflect.get(f.tasks, 'deps').store as TaskStore;
  let now = Date.now();
  const launchedAt = now;
  Reflect.set(f.tasks, 'now', () => now);
  Reflect.set(store, 'now', () => now);
  const count = cap === 'per chat' ? 10 : 40;
  for (let i = 0; i < count; i++) terminalWorker(f, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    cap === 'per chat' ? 'fake-chat' : `fake-chat-${Math.floor(i / 10)}`, now);
  const id = '00000000-0000-4000-8000-000000000099';
  const agent = terminalWorker(f, id, 'fake-chat', now);
  Reflect.get(f.tasks, 'deps').chats.rows = vi.fn(async () => launchRows(id, launchedAt));
  await f.tasks.tick();
  expect(store.all()).toHaveLength(count);
  expect(store.get(id)).toBeUndefined();
  expect(await f.quiet()).toMatchObject({ held: true, quiet: false, pendingRelays: 0, runningTasks: 0,
    reasons: expect.arrayContaining(['tasks_unreconciled']) });
  Reflect.get(f.paseo, 'agents').delete(id);
  await f.tasks.tick();
  expect(await f.quiet()).toMatchObject({ quiet: true });
  Reflect.get(f.paseo, 'agents').set(id, agent);
  await f.tasks.tick();
  expect(await f.quiet()).toMatchObject({ quiet: false, reasons: expect.arrayContaining(['tasks_unreconciled']) });
  now += 16 * 60_000;
  await f.tasks.tick();
  expect(store.get(id)).toMatchObject({ verified: true, status: 'finished' });
  expect(store.get(id)!.baseline).toBeUndefined();
  expect(await f.quiet()).toMatchObject({ quiet: false, pendingRelays: 1 });
  expect(f.tasks.quietCounts().reasons ?? []).not.toContain('tasks_unreconciled');
});

it.each(['task-events.jsonl', 'task-event-totals.json', 'append'] as const)(
  'keeps task history failures unknown across saves and restarts: %s', async (fault) => {
    const f = await fixture(false, fault === 'append' ? undefined : fault);
    const store = Reflect.get(f.tasks, 'deps').store as TaskStore;
    expect(store.canCheckQuiet()).toBe(fault === 'append');
    const id = '00000000-0000-4000-8000-000000000099';
    const now = Date.now();
    terminalWorker(f, id, 'fake-chat', now);
    Reflect.get(f.tasks, 'deps').chats.rows = async () => launchRows(id, now);
    if (fault === 'append') historyIO.failAppend = true;
    await f.tasks.tick();
    expect(store.get(id)).toBeUndefined();
    expect(await f.quiet()).toMatchObject({ held: true, quiet: false, pendingRelays: null,
      reasons: expect.arrayContaining(['tasks_unavailable']) });
    expect(store.canCheckQuiet()).toBe(false);
    historyIO.failAppend = false;
    if (fault !== 'append') rmSync(join(f.config.stateDir, fault), { recursive: true });
    await f.tasks.tick();
    expect(store.get(id)).toMatchObject({ verified: true, status: 'finished' });
    expect(f.tasks.quietCounts().pendingRelays).toBe(1);
    store.save(true);
    expect(JSON.parse(readFileSync(join(f.config.stateDir, 'tasks-quiet.json'), 'utf8'))).toEqual({ reason: 'tasks_unavailable' });
    expect(new TaskStore(f.config.stateDir, Date.now, undefined, log).canCheckQuiet()).toBe(false);
  },
);

it.each(['agent', 'sub-agent'] as const)('rejects a Paseo-to-Hermes handoff during the Hermes read: %s', async (kind) => {
  const f = await fixture();
  const parent = terminalWorker(f, '00000000-0000-4000-8000-000000000099');
  const original = f.dashboard.getMockImplementation()!;
  let changed = false;
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (!changed && path === '/api/config') {
      changed = true;
      if (kind === 'agent') Reflect.get(f.paseo, 'onAgentUpdate').call(f.paseo, { kind: 'upsert', agent: { ...parent, status: 'running' } });
      else Reflect.get(f.paseo, 'onSubagentUpdate').call(f.paseo, { kind: 'upsert',
        subagent: { id: 'fake-child', parentAgentId: parent.id, provider: parent.provider, status: 'running' } });
    }
    return original(path, ...args);
  });
  f.client.fetchAgents.mockResolvedValue({ entries: [{ agent: parent as never, project: null }],
    pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } });
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
    reasons: expect.arrayContaining(['paseo_activity_unavailable']) });
  expect(changed).toBe(true);
  expect(await f.quiet()).toMatchObject({ quiet: true });
});

it('keeps a failed history recovery during a status change unknown after storage returns', async () => {
  const f = await fixture();
  const store = Reflect.get(f.tasks, 'deps').store as TaskStore;
  const id = '00000000-0000-4000-8000-000000000099';
  const now = Date.now();
  const agent = terminalWorker(f, id, 'fake-chat', now);
  await f.tasks.tick();
  const task = store.get(id)!;
  expect(task.status).toBe('finished');
  historyIO.failAppend = true;
  expect(() => store.move(task, 'running', now + 1)).toThrow('Fixture storage full');
  expect(() => store.move(task, 'running', now + 2)).toThrow('Fixture storage full');
  expect(task.status).toBe('finished');
  expect(store.canCheckQuiet()).toBe(false);
  expect(await f.quiet()).toMatchObject({ quiet: false, reasons: expect.arrayContaining(['tasks_unavailable']) });
  historyIO.failAppend = false;
  store.move(task, 'running', now + 3);
  agent.status = 'running';
  store.save(true);
  expect(new TaskStore(f.config.stateDir, Date.now, undefined, log).canCheckQuiet()).toBe(false);
});

it('reads quiet counts without reconciling admission records or writing their evidence', async () => {
  const f = await fixture();
  const reconcile = vi.spyOn(f.tasks, 'reconcileQuiet');
  expect(await f.quiet()).toMatchObject({ held: true, quiet: true });
  expect(await quietReport({ hold: f.hold, bridge: f.bridge, tasks: f.tasks,
    sources: { hermes: f.hermes, paseo: f.paseo } })).toMatchObject({ held: true, quiet: true });
  expect(reconcile).not.toHaveBeenCalled();
});

it.each(['chats', 'runs'] as const)('requires complete listing totals for %s', async (kind) => {
  const f = await fixture();
  const original = f.dashboard.getMockImplementation()!;
  let total: unknown;
  let sessions: unknown[] = [];
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (path.startsWith('/api/sessions?') && path.includes('subagent') === (kind === 'runs')) return { sessions, total };
    return original(path, ...args);
  });
  for (total of [1, undefined, null, '0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
      reasons: expect.arrayContaining(['hermes_listing_incomplete']) });
  }
  total = 0;
  sessions = [{ id: 'fake-finished-session', ended_at: 1_800_000_000 }];
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
    reasons: expect.arrayContaining(['hermes_listing_incomplete']) });
  total = 1;
  expect(await f.quiet()).toMatchObject({ quiet: true, runningTasks: 0 });
});

it.each(['chats', 'runs'] as const)('rejects inconsistent or truncated paging totals for %s', async (kind) => {
  const f = await fixture();
  const original = f.dashboard.getMockImplementation()!;
  const limit = kind === 'runs' ? 100 : 60;
  const rows = Array.from({ length: limit + 1 }, (_, i) => ({ id: `fake-finished-${i}`, ended_at: 1_800_000_000 }));
  let nextTotal: unknown = rows.length;
  let truncated = true;
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (path.startsWith('/api/sessions?') && path.includes('subagent') === (kind === 'runs')) {
      const offset = Number(new URL(path, 'http://example.com').searchParams.get('offset'));
      return { sessions: offset > 0 && truncated ? [] : rows.slice(offset, offset + limit),
        total: offset === 0 ? rows.length : nextTotal };
    }
    return original(path, ...args);
  });
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
    reasons: expect.arrayContaining(['hermes_listing_incomplete']) });
  truncated = false;
  for (nextTotal of [limit, limit + 2, undefined]) {
    expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
      reasons: expect.arrayContaining(['hermes_listing_incomplete']) });
  }
  nextTotal = rows.length;
  expect(await f.quiet()).toMatchObject({ quiet: true, runningTasks: 0 });
});

it.each(['chats', 'runs'] as const)('never lets idle runtime identities suppress an unfinished %s row', async (kind) => {
  const f = await fixture();
  const row = { id: 'fake-unfinished-session', is_active: true, ended_at: null as number | null, last_active: Date.now() / 1_000 };
  const original = f.dashboard.getMockImplementation()!;
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (path.startsWith('/api/sessions?') && path.includes('subagent') === (kind === 'runs')) return { sessions: [row], total: 1 };
    return original(path, ...args);
  });
  for (const runtime of ['fake-watcher', 'fake-predecessor', 'fake-superseded']) {
    f.runtime.splice(0, f.runtime.length, { id: runtime, session_key: row.id, status: 'idle' });
    Reflect.get(f.hermes, 'runtimeByStored').set(row.id, 'fake-current-runtime');
    for (const active of [true, false]) {
      row.is_active = active;
      row.last_active -= 600;
      expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: active ? 1 : null });
    }
  }
  row.ended_at = 1_800_000_000;
  expect(await f.quiet()).toMatchObject({ quiet: true, runningTasks: 0 });
  expect(f.rpc).not.toHaveBeenCalled();
});

it.each(['chats', 'runs'] as const)('requires stored completion evidence for an unfinished external %s row', async (kind) => {
  const f = await fixture();
  const row = { id: 'fake-external-session', is_active: false, ended_at: null as number | null,
    last_active: Date.now() / 1_000 - 600 };
  const original = f.dashboard.getMockImplementation()!;
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (path.startsWith('/api/sessions?') && path.includes('subagent') === (kind === 'runs')) return { sessions: [row], total: 1 };
    return original(path, ...args);
  });
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
    reasons: expect.arrayContaining(['hermes_activity_unavailable']) });
  for (const status of ['working', 'waiting']) {
    // Another process owns this row; the attached registry cannot classify it.
    f.runtime.splice(0, f.runtime.length, { id: 'fake-unrelated-runtime', session_key: 'fake-unrelated-session', status: 'idle' });
    expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
      reasons: expect.arrayContaining(['hermes_activity_unavailable']) });
    f.runtime[0] = { id: 'fake-external-runtime', session_key: row.id, status };
    expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
      reasons: expect.arrayContaining(['hermes_activity_unavailable']) });
  }
  f.runtime[0]!.status = 'idle';
  row.is_active = true;
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: 1 });
  f.runtime.splice(0);
  row.ended_at = Date.now() / 1_000;
  expect(await f.quiet()).toMatchObject({ quiet: true, runningTasks: 0 });
});

it.each(['cron', 'acp', 'archived', 'empty'] as const)('includes busy external sessions excluded from the inbox: %s', async (kind) => {
  const f = await fixture();
  const row = { id: `fake-external-${kind}`, source: kind === 'cron' || kind === 'acp' ? kind : 'cli',
    archived: kind === 'archived', message_count: kind === 'empty' ? 0 : 1, is_active: true,
    ended_at: null as number | null };
  const original = f.dashboard.getMockImplementation()!;
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (path.startsWith('/api/sessions?')) {
      const params = new URL(path, 'http://example.com').searchParams;
      const excluded = (params.get('exclude_sources') ?? '').split(',');
      const filtered = excluded.includes(row.source) ||
        (row.archived && params.get('archived') !== 'include') ||
        row.message_count < Number(params.get('min_messages') ?? 0);
      return { sessions: filtered ? [] : [row], total: 1 };
    }
    return original(path, ...args);
  });
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: 1 });
  row.is_active = false;
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
    reasons: expect.arrayContaining(['hermes_activity_unavailable']) });
  row.ended_at = Date.now() / 1_000;
  expect(await f.quiet()).toMatchObject({ quiet: true, runningTasks: 0 });
});

it.each(['chats', 'runs'] as const)('reads activity beyond the first page of %s', async (kind) => {
  const f = await fixture();
  const rows = Array.from({ length: 201 }, (_, i) => ({ id: `fake-${kind}-${i}`, is_active: i === 200,
    ended_at: i === 200 ? null : 1_800_000_000 }));
  const original = f.dashboard.getMockImplementation()!;
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (path.startsWith('/api/sessions?') && path.includes('subagent') === (kind === 'runs')) {
      const params = new URL(path, 'http://example.com').searchParams;
      const offset = Number(params.get('offset') ?? 0);
      return { sessions: rows.slice(offset, offset + Number(params.get('limit'))), total: rows.length };
    }
    return original(path, ...args);
  });
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: 1 });
  expect(f.dashboard.mock.calls.some(([path]) => path.includes('offset=') && Number(new URL(path, 'http://example.com').searchParams.get('offset')) > 0)).toBe(true);
  rows[200]!.is_active = false;
  rows[200]!.ended_at = 1_800_000_000;
  expect(await f.quiet()).toMatchObject({ quiet: true, runningTasks: 0 });
});

it.each(['repeated page', 'unreadable next page'] as const)('keeps an incomplete activity listing unknown: %s', async (kind) => {
  const f = await fixture();
  const original = f.dashboard.getMockImplementation()!;
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: `fake-run-${i}`, is_active: false, ended_at: 1_800_000_000 }));
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (path.startsWith('/api/sessions?') && path.includes('subagent')) {
      if (kind === 'unreadable next page' && path.includes('offset=100')) throw new Error('Fixture unreadable page');
      return { sessions: rows, total: 200 };
    }
    return original(path, ...args);
  });
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
    reasons: expect.arrayContaining([kind === 'repeated page' ? 'hermes_listing_incomplete' : 'hermes_activity_unavailable']) });
});

it.each([{}, null, { sessions: {} }, { sessions: { show_subagents: 'unknown' } }])(
  'keeps unrecognized run capability evidence unknown: %j', async (config) => {
    const f = await fixture();
    const original = f.dashboard.getMockImplementation()!;
    f.dashboard.mockImplementation(async (path, ...args) => path === '/api/config' ? config : original(path, ...args));
    expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
      reasons: expect.arrayContaining(['hermes_activity_unavailable']) });
  },
);

it('keeps hidden delegate activity unknown until run visibility supplies complete evidence', async () => {
  const f = await fixture();
  let visible = false;
  f.runs.push({ id: 'fake-hidden-run', parent_session_id: 'fake-chat', is_active: true });
  const original = f.dashboard.getMockImplementation()!;
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (path === '/api/config') return { sessions: { show_subagents: visible } };
    if (path.startsWith('/api/sessions?') && path.includes('subagent')) return { sessions: visible ? f.runs : [], total: f.runs.length };
    return original(path, ...args);
  });
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
    reasons: expect.arrayContaining(['hermes_activity_unavailable']) });
  visible = true;
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: 1 });
  f.runs.splice(0);
  expect(await f.quiet()).toMatchObject({ quiet: true, runningTasks: 0 });
});

it.each(['chats', 'runs'] as const)('rejects run visibility disabled during a %s listing', async (kind) => {
  const f = await fixture();
  let visible = true;
  const original = f.dashboard.getMockImplementation()!;
  f.runs.push({ id: 'fake-hidden-run', parent_session_id: 'fake-chat', is_active: true });
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (path === '/api/config') return { sessions: { show_subagents: visible } };
    if (path.startsWith('/api/sessions?') && path.includes('subagent') === (kind === 'runs')) {
      await Promise.resolve();
      visible = false;
    }
    if (path.startsWith('/api/sessions?') && path.includes('subagent')) return { sessions: visible ? f.runs : [], total: f.runs.length };
    return original(path, ...args);
  });
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
    reasons: expect.arrayContaining(['hermes_activity_unavailable']) });
});

it.each(['chats', 'runs'] as const)('checks visibility between every page of %s', async (kind) => {
  const f = await fixture();
  let visible = true;
  let checked = false;
  const limit = kind === 'runs' ? 100 : 60;
  const original = f.dashboard.getMockImplementation()!;
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (path === '/api/config') {
      if (!visible) checked = true;
      return { sessions: { show_subagents: visible } };
    }
    if (path.startsWith('/api/sessions?') && path.includes('subagent') === (kind === 'runs')) {
      await Promise.resolve();
      const offset = Number(new URL(path, 'http://example.com').searchParams.get('offset'));
      // The next page would restore visibility after a hidden page omitted a busy run.
      visible = offset !== 0;
      return { sessions: offset === 0 ? Array.from({ length: limit }, (_, i) => ({ id: `fake-idle-${i}`, is_active: false, ended_at: 1_800_000_000 })) : [], total: limit };
    }
    return original(path, ...args);
  });
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
    reasons: expect.arrayContaining(['hermes_activity_unavailable']) });
  expect(checked).toBe(true);
});

it.each(['hidden', 'unreadable'] as const)('requires fresh effective visibility at the end of an activity snapshot: %s', async (kind) => {
  const f = await fixture();
  let visible = true;
  let finish!: () => void;
  const original = f.dashboard.getMockImplementation()!;
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (path === '/api/config') {
      if (!visible && kind === 'unreadable') throw new Error('Fixture config unavailable');
      return { sessions: { show_subagents: visible } };
    }
    if (path.startsWith('/api/sessions?') && path.includes('subagent')) await new Promise<void>((resolve) => { finish = resolve; });
    return original(path, ...args);
  });
  const pending = f.quiet();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  visible = false;
  finish();
  expect(await pending).toMatchObject({ quiet: false, runningTasks: null,
    reasons: expect.arrayContaining(['hermes_activity_unavailable']) });
});

it.each(['chats', 'runs'] as const)('rejects unhealthy storage evidence on every page of %s', async (kind) => {
  const f = await fixture();
  const original = f.dashboard.getMockImplementation()!;
  let storage: unknown;
  let failedPage = 0;
  const limit = kind === 'runs' ? 100 : 60;
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (path.startsWith('/api/sessions?') && path.includes('subagent') === (kind === 'runs')) {
      const offset = Number(new URL(path, 'http://example.com').searchParams.get('offset'));
      return { sessions: offset < failedPage * limit
        ? Array.from({ length: limit }, (_, i) => ({ id: `fake-idle-${offset + i}`, is_active: false, ended_at: 1_800_000_000 })) : [],
      total: failedPage * limit, storage: offset < failedPage * limit ? {} : storage };
    }
    return original(path, ...args);
  });
  for (failedPage of [0, 1, 2]) {
    for (storage of [{ default: 'corrupt' }, { default: 'unavailable' }, { other: 'corrupt' }, null, [], 'corrupt', { default: null }]) {
      expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
        reasons: expect.arrayContaining(['hermes_activity_unavailable']) });
    }
    storage = {};
    expect(await f.quiet()).toMatchObject({ quiet: true, runningTasks: 0 });
  }
});

it.each(['run listing', 'Paseo listing'] as const)('invalidates external session evidence during a delayed %s', async (kind) => {
  const f = await fixture();
  let finish!: () => void;
  if (kind === 'run listing') {
    const original = f.dashboard.getMockImplementation()!;
    f.dashboard.mockImplementation(async (path, ...args) => {
      if (path.startsWith('/api/sessions?') && path.includes('subagent')) {
        return new Promise((resolve) => { finish = () => resolve({ sessions: [], total: 0 }); });
      }
      return original(path, ...args);
    });
  } else {
    vi.spyOn(f.paseo, 'readActivityConversations').mockImplementation(() => new Promise((resolve) => { finish = () => resolve([]); }));
  }
  const pending = f.quiet();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  f.runtime.push({ id: 'fake-external-runtime', session_key: 'fake-external-chat', status: 'working' });
  f.gateway.emit('event', { type: 'sessions.changed', payload: {} });
  finish();
  expect(await pending).toMatchObject({ quiet: false, runningTasks: null,
    reasons: expect.arrayContaining([kind === 'run listing' ? 'hermes_activity_unavailable' : 'hermes_changed']) });
});

it.each(['chats', 'runs'] as const)('requires verified activity or completion evidence for %s', async (kind) => {
  const f = await fixture();
  const original = f.dashboard.getMockImplementation()!;
  let evidence: Record<string, unknown> = {};
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (path.startsWith('/api/sessions?') && path.includes('subagent') === (kind === 'runs')) {
      return { sessions: [{ id: 'fake-session', ...evidence }], total: 1 };
    }
    return original(path, ...args);
  });
  for (const invalid of [{}, { is_active: false }, { is_active: null }, { is_active: 'unavailable' }, { is_active: 0 },
    { ended_at: 'unavailable' }, { is_active: false, ended_at: -1 }]) {
    evidence = invalid;
    expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
      reasons: expect.arrayContaining(['hermes_activity_unavailable']) });
  }
  for (const idle of [{ is_active: false, ended_at: 1_800_000_000 }, { ended_at: 1_800_000_000 }, { is_active: null, ended_at: 1_800_000_000 }]) {
    evidence = idle;
    expect(await f.quiet()).toMatchObject({ quiet: true, runningTasks: 0 });
  }
  evidence = { is_active: true, ended_at: null };
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: 1 });
});

it.each(['running worker', 'approval', 'task', 'followup', 'unreadable ledger'] as const)(
  'refreshes %s after a delayed Hermes read', async (kind) => {
    const f = await fixture();
    const counts = vi.spyOn(f.tasks, 'quietCounts').mockReturnValue({ pendingRelays: 0, runningTaskIds: [] });
    const id = '00000000-0000-4000-8000-000000000033';
    let finish!: () => void;
    const original = f.dashboard.getMockImplementation()!;
    f.dashboard.mockImplementation(async (path, ...args) => {
      if (path.startsWith('/api/sessions?') && path.includes('subagent')) await new Promise<void>((resolve) => { finish = resolve; });
      return original(path, ...args);
    });
    const pending = f.quiet();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    if (kind === 'running worker' || kind === 'approval') Reflect.set(f.paseo, 'agents', new Map([[id, {
      id, provider: 'demo', cwd: '/home/me/code/app', status: kind === 'running worker' ? 'running' : 'idle', labels: {},
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', pendingPermissions: kind === 'approval' ? ['fake-prompt'] : [], capabilities: { supportsStreaming: true },
    }]]));
    if (kind === 'task') counts.mockReturnValue({ pendingRelays: 1, runningTaskIds: [id] });
    if (kind === 'approval') Reflect.set(f.paseo, 'permissions', new Map([['fake-prompt', { agentId: id,
      approvals: [{ id: 'fake-prompt', source: 'paseo', conversationId: id }] }]]));
    if (kind === 'followup') counts.mockReturnValue({ pendingRelays: 0, runningTaskIds: [id], reasons: ['followups_unreconciled'] });
    if (kind === 'unreadable ledger') counts.mockReturnValue({ pendingRelays: 0, runningTaskIds: [], reasons: ['tasks_unavailable'] });
    finish();
    expect(await pending).toMatchObject({ quiet: false });
  },
);

it('does not log response content from a failed activity source or call the UI reader', async () => {
  const f = await fixture();
  const warnings = vi.spyOn(log, 'warn');
  const ui = vi.spyOn(f.hermes, 'listConversations');
  const original = f.dashboard.getMockImplementation()!;
  const content = 'Invented private fixture response';
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (path.startsWith('/api/sessions?') && path.includes('subagent')) return JSON.parse(content);
    return original(path, ...args);
  });
  expect(await f.quiet()).toMatchObject({ quiet: false, reasons: expect.arrayContaining(['hermes_activity_unavailable']) });
  expect(JSON.stringify(warnings.mock.calls)).not.toContain(content);
  expect(JSON.stringify(warnings.mock.calls)).not.toMatch(/SyntaxError|Invented p/);
  expect(ui).not.toHaveBeenCalled();
});

it.each(['malformed', 'filtered', 'unreadable'] as const)('preserves unknown task-ledger evidence after a normal tick and restart: %s', async (kind) => {
  const f = await fixture();
  const path = join(f.config.stateDir, 'tasks.json');
  writeFileSync(path, kind === 'filtered' ? JSON.stringify({ tasks: [{ id: 'invalid' }] }) : '{');
  if (kind === 'unreadable') chmodSync(path, 0);
  const store = new TaskStore(f.config.stateDir, Date.now, undefined, log);
  chmodSync(path, 0o600);
  const workers = { agentsLoaded: true, workerSnapshots: () => [], workerSnapshot: () => undefined,
    lookUp: async () => null, lastMessage: vi.fn() };
  const relay = new TaskRelay({ store, bridge: f.bridge, workers, setting: new WorkerUpdatesSetting(f.config.stateDir), hub: f.hub,
    background, log, tickMs: 0, chats: { connected: () => true, rows: async () => [], find: async () => undefined, origin: async () => 'tui' } });
  relay.start();
  cleanups.push(() => relay.stop());
  expect(relay.quietCounts().reasons).toContain('tasks_unavailable');
  await relay.tick();
  expect(JSON.parse(readFileSync(path, 'utf8')).tasks).toEqual([]);
  const restarted = new TaskStore(f.config.stateDir, Date.now, undefined, log);
  expect(restarted.canCheckQuiet()).toBe(false);
  const marker = join(f.config.stateDir, 'tasks-quiet.json');
  expect(statSync(marker).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ reason: 'tasks_unavailable' });
  const restartedRelay = new TaskRelay({ store: restarted, bridge: f.bridge, workers, setting: new WorkerUpdatesSetting(f.config.stateDir), hub: f.hub,
    background, log, tickMs: 0, chats: { connected: () => true, rows: async () => [], find: async () => undefined, origin: async () => 'tui' } });
  vi.spyOn(f.tasks, 'quietCounts').mockImplementation(() => restartedRelay.quietCounts());
  expect(await f.quiet()).toMatchObject({ quiet: false, pendingRelays: null, runningTasks: null,
    reasons: expect.arrayContaining(['tasks_unavailable']) });
});

it('rejects Hermes activity changed while a later Paseo read is delayed', async () => {
  const f = await fixture();
  let finish!: (rows: []) => void;
  vi.spyOn(f.paseo, 'readActivityConversations').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const pending = f.quiet();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  Reflect.set(f.hermes, 'activityRevision', Reflect.get(f.hermes, 'activityRevision') + 1);
  finish([]);
  expect(await pending).toMatchObject({ quiet: false, runningTasks: null, reasons: expect.arrayContaining(['hermes_changed']) });
});

it('requires an empty final page after an exact run-page boundary', async () => {
  const f = await fixture();
  const original = f.dashboard.getMockImplementation()!;
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (path.startsWith('/api/sessions?') && path.includes('subagent')) {
      const offset = Number(new URL(path, 'http://example.com').searchParams.get('offset') ?? 0);
      return { sessions: offset === 0 ? Array.from({ length: 100 }, (_, i) => ({ id: `fake-run-${i}`, is_active: false, ended_at: 1_800_000_000 })) : [], total: 100 };
    }
    return original(path, ...args);
  });
  expect(await f.quiet()).toMatchObject({ quiet: true, runningTasks: 0 });
  expect(f.dashboard.mock.calls.some(([path]) => path.includes('offset=100'))).toBe(true);
});

it('keeps activity unknown if every page fills the read budget', async () => {
  const f = await fixture();
  const original = f.dashboard.getMockImplementation()!;
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (path.startsWith('/api/sessions?') && path.includes('subagent')) {
      const offset = Number(new URL(path, 'http://example.com').searchParams.get('offset') ?? 0);
      return { sessions: Array.from({ length: 100 }, (_, i) => ({ id: `fake-run-${offset + i}`, is_active: false, ended_at: 1_800_000_000 })), total: 1_000_000 };
    }
    return original(path, ...args);
  });
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
    reasons: expect.arrayContaining(['hermes_listing_incomplete']) });
});

it('certifies idle production adapters and detects work omitted from the inbox without devices', async () => {
  const f = await fixture();
  expect(f.hub.size).toBe(0);
  expect(await f.quiet()).toMatchObject({ held: true, quiet: true, runningTasks: 0, openApprovalPrompts: 0 });
  f.runs.push({ id: 'fake-run', parent_session_id: 'fake-chat', is_active: true });
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: 1 });
  Reflect.set(f.hermes, 'pending', new Map([['fake-approval', { approval: { conversationId: 'fake-run' } }]]));
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: 1, openApprovalPrompts: 1 });
  Reflect.set(f.hermes, 'pending', new Map());
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: 1 });
  f.runs.splice(0);
  expect(await f.quiet()).toMatchObject({ quiet: true });
});

it('certifies complete finished histories without runtime inactivity evidence', async () => {
  const f = await fixture();
  const chats = Array.from({ length: 121 }, (_, i) => ({ id: `fake-finished-chat-${i}`, ended_at: 1_800_000_000 as number | null, is_active: true }));
  const runs = Array.from({ length: 101 }, (_, i) => ({ id: `fake-finished-run-${i}`, ended_at: 1_800_000_000, is_active: false }));
  const original = f.dashboard.getMockImplementation()!;
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (path.startsWith('/api/sessions?')) {
      const params = new URL(path, 'http://example.com').searchParams;
      const rows = path.includes('subagent') ? runs : chats;
      const offset = Number(params.get('offset'));
      return { sessions: rows.slice(offset, offset + Number(params.get('limit'))), total: rows.length };
    }
    return original(path, ...args);
  });
  f.rpc.mockRejectedValue(new Error('Fixture registry unavailable'));
  expect(await f.quiet()).toMatchObject({ held: true, quiet: true, runningTasks: 0, openApprovalPrompts: 0 });
  chats[0]!.ended_at = null;
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: 1 });
  chats[0]!.is_active = false;
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
    reasons: expect.arrayContaining(['hermes_activity_unavailable']) });
  chats[0]!.ended_at = 1_800_000_000;
  expect(await f.quiet()).toMatchObject({ quiet: true, runningTasks: 0 });
  f.hold.set(false);
  expect(await f.quiet()).toMatchObject({ held: false, quiet: false, runningTasks: 0 });
  expect(f.rpc).not.toHaveBeenCalled();
});

it.each(['dashboard', 'run listing', 'disconnected', 'unloaded', 'approval', 'task'] as const)(
  'keeps a production quiet report false for %s', async (kind) => {
    const f = await fixture();
    expect((await f.quiet()).quiet).toBe(true);
    if (kind === 'dashboard') f.dashboard.mockRejectedValue(new Error('Fixture content'));
    if (kind === 'run listing') {
      const original = f.dashboard.getMockImplementation()!;
      f.dashboard.mockImplementation((...args) => args[0].includes('subagent') ? Promise.reject(new Error('Fixture content')) : original(...args));
    }
    if (kind === 'disconnected') Reflect.set(f.paseo, 'statusValue', { source: 'paseo', state: 'disconnected' });
    if (kind === 'unloaded') Reflect.set(f.paseo, 'listLoaded', false);
    if (kind === 'approval') Reflect.set(f.hermes, 'pending', new Map([['fake-approval', { approval: { conversationId: 'fake-chat' } }]]));
    if (kind === 'task') Reflect.set(f.paseo, 'agents', new Map([['fake-worker', {
      id: 'fake-worker', provider: 'demo', cwd: '/home/me/code/app', status: 'running', labels: {},
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', pendingPermissions: [], capabilities: { supportsStreaming: true },
    }]]));
    expect(await f.quiet()).toMatchObject({ quiet: false });
  },
);

it('treats configured-disabled Hermes as verified idle without a bridge-unavailable reason', async () => {
  const f = await fixture(true);
  expect(await f.quiet()).toMatchObject({ quiet: true, runningTasks: 0, openApprovalPrompts: 0 });
  expect(f.rpc).not.toHaveBeenCalled();
  expect(f.dashboard).not.toHaveBeenCalled();
});

it.each(['claude', 'codex', 'opencode', 'omp', 'custom-claude', 'custom-plugin'])('reads fresh background sub-agents of idle loaded %s parents', async (provider) => {
  const f = await fixture();
  const agent = { id: 'fake-parent', provider, cwd: '/home/me/app', status: 'idle', labels: {}, pendingPermissions: [],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', capabilities: { supportsStreaming: true } };
  let status = 'running';
  const list = vi.fn(async () => ({ subagents: [{ id: 'fake-sub', parentAgentId: agent.id, provider, status }] }));
  Object.assign(f.client, { getLastServerInfoMessage: () => ({ features: { providerSubagents: true } }), listProviderSubagents: list });
  f.client.fetchAgents.mockResolvedValue({ entries: [{ agent: agent as never, project: null }],
    pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } });
  expect(await f.paseo.listConversations()).toEqual([]);
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: 1, reasons: expect.arrayContaining(['paseo_running']) });
  expect(list).toHaveBeenCalledWith(agent.id, { timeout: 15_000 });
  expect(await f.paseo.listConversations()).toEqual([]);
  status = 'completed';
  expect(await f.quiet()).toMatchObject({ quiet: true });
  expect(list).toHaveBeenCalledTimes(2);
});

it.each(['unsupported', 'error', 'timeout', 'revision', 'malformed'] as const)('keeps sub-agent activity unknown on %s', async (kind) => {
  const f = await fixture();
  const agent = { id: 'fake-parent', provider: 'claude', cwd: '/home/me/app', status: 'idle', labels: {}, pendingPermissions: [],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', capabilities: { supportsStreaming: true } };
  const list = vi.fn(async () => {
    if (kind === 'error' || kind === 'timeout') throw new Error(`Fixture ${kind}`);
    if (kind === 'revision') Reflect.set(f.paseo, 'statusValue', { source: 'paseo', state: 'connected' });
    return { subagents: kind === 'malformed' ? null : [] };
  });
  Object.assign(f.client, { getLastServerInfoMessage: () => ({ features: { providerSubagents: kind !== 'unsupported' } }), listProviderSubagents: list });
  f.client.fetchAgents.mockResolvedValue({ entries: [{ agent: agent as never, project: null }],
    pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } });
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null, reasons: expect.arrayContaining(['paseo_activity_unavailable']) });
  if (kind === 'unsupported') expect(list).not.toHaveBeenCalled();
});

it('queries every loaded provider and never queries stored or closed agents', async () => {
  const f = await fixture();
  const list = vi.fn(async () => ({ subagents: [] }));
  Object.assign(f.client, { getLastServerInfoMessage: () => ({ features: { providerSubagents: true } }), listProviderSubagents: list });
  const agents = [
    { id: 'fake-stored', provider: 'claude', status: 'idle', capabilities: { supportsStreaming: false } },
    { id: 'fake-closed', provider: 'claude', status: 'closed', capabilities: { supportsStreaming: true } },
    { id: 'fake-other', provider: 'demo', status: 'idle', capabilities: { supportsStreaming: true } },
  ].map((agent) => ({ ...agent, cwd: '/home/me/app', labels: {}, pendingPermissions: [],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }));
  f.client.fetchAgents.mockResolvedValue({ entries: agents.map((agent) => ({ agent: agent as never, project: null })),
    pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } });
  expect(await f.quiet()).toMatchObject({ quiet: true });
  expect(list.mock.calls).toEqual([['fake-other', { timeout: 15_000 }]]);
});

it.each([0, 7 * 3600_000])('keeps unfinished lineage runs unknown without fresh completion evidence after %s ms', async (age) => {
  const f = await fixture();
  let now = 1_800_000_000_000;
  const lineage = new Lineage(null, log, () => now, background);
  f.paseo.useLineage(lineage);
  const id = '00000000-0000-4000-8000-000000000055';
  lineage.noteRun(id, 'start', { candidates: [{ kind: 'hermes', id: 'fake-chat' }] });
  lineage.noteRun(id, 'prompt', { task: 'Fixture task' });
  now += age;
  expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null, reasons: expect.arrayContaining(['paseo_activity_unavailable']) });
  lineage.noteRun(id, 'stop', { final: 'Fixture answer' });
  expect(await f.quiet()).toMatchObject({ quiet: true });
});

const RUN = '00000000-0000-4000-8000-000000000055';
const ONESHOT = '20260101_000000_abcdef';
const unavailablePaseo = { held: true, quiet: false, runningTasks: null,
  reasons: expect.arrayContaining(['paseo_activity_unavailable']) };

it.each(['directory', 'damaged', 'unreadable'] as const)('keeps lost lineage unknown through repeated restarts: %s', async (fault) => {
  const f = await fixture();
  await f.bridge.call('note_run', { session: RUN, event: 'start', candidates: [{ kind: 'hermes', id: '20260101_120000_abc123' }] });
  await f.bridge.call('note_run', { session: RUN, event: 'prompt', task: 'Fixture task' });
  expect(await f.quiet()).toMatchObject(unavailablePaseo);
  await f.stop();
  const path = join(f.config.stateDir, 'lineage.json');
  if (fault === 'directory') { rmSync(path); mkdirSync(path); }
  else if (fault === 'damaged') writeFileSync(path, '');
  else chmodSync(path, 0);
  const restored = await fixture(false, undefined, f.config.stateDir);
  expect(restored.lineage.runs()).toEqual([]);
  await restored.bridge.call('note_run', { session: RUN, event: 'prompt', task: 'Fixture later prompt' });
  expect(restored.lineage.run(RUN)).toBeUndefined();
  expect(await restored.quiet()).toMatchObject(unavailablePaseo);
  const marker = join(f.config.stateDir, 'lineage-quiet.json');
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ reason: 'paseo_activity_unavailable' });
  expect(statSync(marker).mode & 0o777).toBe(0o600);
  if (fault === 'directory') rmSync(path, { recursive: true });
  await restored.stop();
  const restarted = await fixture(false, undefined, f.config.stateDir);
  expect(restarted.lineage.runs()).toEqual([]);
  expect(await restarted.quiet()).toMatchObject(unavailablePaseo);
});

it('keeps an unpersisted lineage run unknown after a save failure and restart', async () => {
  const f = await fixture();
  await f.bridge.call('note_run', { session: RUN, event: 'stop', candidates: [{ kind: 'hermes', id: ONESHOT }] });
  const next = '00000000-0000-4000-8000-000000000056';
  historyIO.failLineage = true;
  await expect(f.bridge.call('note_run', { session: next, event: 'start', candidates: [{ kind: 'hermes', id: ONESHOT }] }))
    .rejects.toMatchObject({ status: 503 });
  await expect(f.bridge.call('note_run', { session: next, event: 'stop' })).rejects.toMatchObject({ status: 503 });
  expect(await f.quiet()).toMatchObject(unavailablePaseo);
  const marker = join(f.config.stateDir, 'lineage-quiet-save.json');
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ reason: 'paseo_activity_unavailable' });
  expect(statSync(marker).mode & 0o777).toBe(0o600);
  await f.stop(false);
  historyIO.failLineage = false;
  const restored = await fixture(false, undefined, f.config.stateDir);
  expect(restored.lineage.run(next)).toBeUndefined();
  expect(restored.lineage.run(RUN)?.status).toBe('done');
  expect(await restored.quiet()).toMatchObject(unavailablePaseo);
  restored.lineage.save();
  await restored.stop();
  expect(await (await fixture(false, undefined, f.config.stateDir)).quiet()).toMatchObject(unavailablePaseo);
});

it.each(['write', 'file sync', 'directory sync'] as const)('recovers a failed %s save with the complete live state', async (fault) => {
  const f = await fixture();
  if (fault === 'write') historyIO.failLineage = true;
  else historyIO.failQuietMarker = fault === 'file sync' ? 'sync' : 'directory sync';
  await expect(f.bridge.call('note_run', { session: RUN, event: 'start', candidates: [{ kind: 'hermes', id: ONESHOT }] }))
    .rejects.toMatchObject({ status: 503 });
  expect(f.lineage.unavailable).toBe(true);
  expect(await f.quiet()).toMatchObject(unavailablePaseo);
  historyIO.failLineage = false;
  historyIO.failQuietMarker = false;
  await f.bridge.call('note_run', { session: RUN, event: 'stop' });
  expect(f.lineage.unavailable).toBe(false);
  expect(() => statSync(join(f.config.stateDir, 'lineage-quiet-save.json'))).toThrow();
  expect(await f.quiet()).toMatchObject({ quiet: true });
  await f.stop(false);
  const restored = await fixture(false, undefined, f.config.stateDir);
  expect(restored.lineage.run(RUN)?.status).toBe('done');
  expect(await restored.quiet()).toMatchObject({ quiet: true });
});

it('does not acknowledge a held run when both its save and failure marker fail', async () => {
  const f = await fixture();
  historyIO.failLineage = true;
  historyIO.failQuietMarker = 'all';
  await expect(f.bridge.call('note_run', { session: RUN, event: 'start', candidates: [{ kind: 'hermes', id: ONESHOT }] }))
    .rejects.toMatchObject({ status: 503 });
  expect(await f.quiet()).toMatchObject(unavailablePaseo);
  expect(() => statSync(join(f.config.stateDir, 'lineage-quiet-save.json'))).toThrow();
  historyIO.failLineage = false;
  historyIO.failQuietMarker = false;
  f.hold.set(true);
  expect(f.lineage.unavailable).toBe(false);
  await f.stop(false);
  const restored = await fixture(false, undefined, f.config.stateDir);
  expect(restored.lineage.run(RUN)?.status).toBe('running');
  expect(await restored.quiet()).toMatchObject(unavailablePaseo);
});

it.each(['clean', 'crash', 'error'] as const)('keeps held runs durable across a real %s process exit without a shutdown save', async (mode) => {
  const f = await fixture();
  await f.stop();
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { Lineage } from './server/src/lineage.js';
    import { Bridge } from './server/src/bridge/service.js';
    import { BackgroundGate } from './server/src/background.js';
    import { EventHub } from './server/src/hub.js';
    const [dir, mode] = process.argv.slice(1);
    const background = new BackgroundGate('primary');
    const lineage = new Lineage(dir, undefined, Date.now, background);
    lineage.noteRun('fake-flushed', 'start', { candidates: [{ kind: 'hermes', id: 'fake-chat' }] });
    const bridge = new Bridge({ stateDir: dir, lineage, background, hub: new EventHub(), sources: {}, log: {} });
    bridge.maintenanceHold(dir).set(true);
    lineage.noteRun('fake-running', 'start', { candidates: [{ kind: 'hermes', id: 'fake-chat' }] });
    lineage.noteRun('fake-completed', 'start', { candidates: [{ kind: 'hermes', id: 'fake-chat' }] });
    lineage.noteRun('fake-completed', 'stop', {});
    if (mode === 'crash') process.kill(process.pid, 'SIGKILL');
    process.exit(mode === 'error' ? 1 : 0);
  `, f.config.stateDir, mode], { encoding: 'utf8', timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.signal).toBe(mode === 'crash' ? 'SIGKILL' : null);
  expect(result.status).toBe(mode === 'crash' ? null : mode === 'error' ? 1 : 0);
  const restored = await fixture(false, undefined, f.config.stateDir);
  expect(restored.lineage.unavailable).toBe(false);
  expect(restored.lineage.run('fake-flushed')?.status).toBe('running');
  expect(restored.lineage.run('fake-running')?.status).toBe('running');
  expect(restored.lineage.run('fake-completed')?.status).toBe('done');
  expect(await restored.quiet()).toMatchObject(unavailablePaseo);
  restored.lineage.noteRun('fake-flushed', 'stop', {});
  restored.lineage.noteRun('fake-running', 'stop', {});
  expect(await restored.quiet()).toMatchObject({ quiet: true });
  expect(() => statSync(join(f.config.stateDir, 'lineage-quiet-active.json'))).toThrow();
});

it.each(['age', 'cap', 'running cap'] as const)('retains unfinished lineage through the %s limit and restart', async (limit) => {
  const f = await fixture();
  let now = Date.now();
  Reflect.set(f.lineage, 'now', () => now);
  f.hold.set(false);
  f.lineage.noteRun(RUN, 'start', { candidates: [{ kind: 'hermes', id: ONESHOT }] });
  if (limit === 'age') now += 31 * 24 * 3600_000;
  else {
    now++;
    for (let i = 0; i < 2000; i++) f.lineage.noteRun(`fake-run-${i}`, limit === 'running cap' ? 'start' : 'stop',
      { candidates: [{ kind: 'hermes', id: ONESHOT }] });
  }
  f.hold.set(true);
  expect(f.lineage.run(RUN)?.status).toBe('running');
  expect(f.lineage.unavailable).toBe(false);
  if (limit === 'running cap') expect(f.lineage.runs()).toHaveLength(2001);
  expect(await f.quiet()).toMatchObject(unavailablePaseo);
  await f.stop(false);
  const restored = await fixture(false, undefined, f.config.stateDir);
  expect(restored.lineage.run(RUN)?.status).toBe('running');
  expect(restored.lineage.unavailable).toBe(false);
  expect(await restored.quiet()).toMatchObject(unavailablePaseo);
});

it('restores readable lineage and certifies quiet only after its run ends', async () => {
  const f = await fixture();
  expect(await f.quiet()).toMatchObject({ quiet: true });
  await f.bridge.call('note_run', { session: RUN, event: 'start', candidates: [{ kind: 'hermes', id: '20260101_120000_abc123' }] });
  await f.stop();
  const restored = await fixture(false, undefined, f.config.stateDir);
  expect(restored.lineage.run(RUN)?.status).toBe('running');
  expect(await restored.quiet()).toMatchObject(unavailablePaseo);
  await restored.bridge.call('note_run', { session: RUN, event: 'stop' });
  expect(await restored.quiet()).toMatchObject({ quiet: true });
});

it('requires owner reconciliation to clear lost lineage evidence', async () => {
  const f = await fixture();
  await f.stop();
  writeFileSync(join(f.config.stateDir, 'lineage.json'), '{');
  const restored = await fixture(false, undefined, f.config.stateDir);
  expect(await restored.quiet()).toMatchObject(unavailablePaseo);
  await restored.stop();
  rmSync(join(f.config.stateDir, 'lineage-quiet.json'));
  const reconciled = await fixture(false, undefined, f.config.stateDir);
  expect(await reconciled.quiet()).toMatchObject({ quiet: true });
});

it('ignores a leftover process guard when restarting from complete lineage', async () => {
  const f = await fixture();
  await f.stop();
  writeFileSync(join(f.config.stateDir, 'lineage-quiet-active.json'), '{"reason":"paseo_activity_unavailable"}');
  const restored = await fixture(false, undefined, f.config.stateDir);
  expect(restored.lineage.unavailable).toBe(false);
  expect(await restored.quiet()).toMatchObject({ quiet: true });
});

it.each(['Hermes read', 'Paseo read'] as const)('invalidates a lineage handoff during the %s', async (phase) => {
  const f = await fixture();
  await f.bridge.call('note_run', { session: RUN, event: 'start', candidates: [{ kind: 'hermes', id: '20260101_120000_abc123' }] });
  await f.bridge.call('note_run', { session: RUN, event: 'prompt', task: 'Fixture task' });
  expect(await f.quiet()).toMatchObject(unavailablePaseo);
  const revision = f.paseo.activityVersion;
  let changed = false;
  const handoff = async () => {
    changed = true;
    await f.bridge.call('note_launch', { child: ONESHOT, candidates: [{ kind: 'claude', id: RUN }] });
    await f.bridge.call('note_run', { session: RUN, event: 'stop' });
  };
  const original = f.dashboard.getMockImplementation()!;
  let visibilityReads = 0;
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (phase === 'Hermes read' && path === '/api/config' && ++visibilityReads === 4) await handoff();
    if (changed && path.startsWith('/api/sessions?') && !path.includes('subagent')) {
      return { sessions: [{ id: ONESHOT, source: 'oneshot', is_active: true, ended_at: null }], total: 1 };
    }
    return original(path, ...args);
  });
  if (phase === 'Paseo read') f.client.fetchAgents.mockImplementation(async () => {
    if (!changed) await handoff();
    return { entries: [], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } };
  });
  expect(await f.quiet()).toMatchObject(unavailablePaseo);
  expect(changed).toBe(true);
  expect(f.lineage.run(RUN)?.status).toBe('done');
  expect(f.lineage.launchOf([ONESHOT])).toBeDefined();
  expect(f.paseo.activityVersion).toBeGreaterThan(revision);
  expect(await f.quiet()).toMatchObject({ held: true, quiet: false, runningTasks: 1 });
});

it('invalidates a report when only a lineage launch changes during its read', async () => {
  const f = await fixture();
  const revision = f.paseo.activityVersion;
  f.client.fetchAgents.mockImplementationOnce(async () => {
    await f.bridge.call('note_launch', { child: ONESHOT, candidates: [{ kind: 'hermes', id: '20260101_120000_abc123' }] });
    return { entries: [], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } };
  });
  expect(await f.quiet()).toMatchObject(unavailablePaseo);
  expect(f.paseo.activityVersion).toBeGreaterThan(revision);
  expect(await f.quiet()).toMatchObject({ quiet: true });
});

it('keeps archived workers out of the inbox during reconciliation and bridge sends', async () => {
  const f = await fixture();
  const id = '00000000-0000-4000-8000-000000000099';
  const agent = { id, provider: 'demo', cwd: '/home/me/code/app', status: 'idle', archivedAt: '2026-01-01T00:00:00Z',
    requiresAttention: true, attentionReason: 'finished', labels: {}, pendingPermissions: [], capabilities: { supportsStreaming: false },
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } as unknown as AgentSnapshotPayload;
  const client = new DaemonClient({ url: 'ws://example.com', clientId: 'fake-client', logger: log });
  const fetch = vi.spyOn(client, 'fetchAgent').mockResolvedValue({ agent } as never);
  const history = vi.spyOn(client, 'fetchAgentTimeline').mockResolvedValue({ epoch: 'fake-epoch', entries: [
    { seqStart: 1, seqEnd: 1, item: { type: 'assistant_message', text: 'Fixture completion' }, timestamp: '2026-01-01T00:00:00Z' },
  ] } as never);
  const subscribe = vi.spyOn(client, 'subscribeAgentTimeline');
  Reflect.set(f.paseo, 'client', client);
  const keep = vi.spyOn(f.paseo as unknown as { keepAgent(): void }, 'keepAgent');
  const workers = paseoWorkers(f.paseo);
  await workers.lookUp(id);
  await workers.completionEvidence!(id);
  expect(await workers.lastMessage(id)).toBeUndefined();
  const store = new TaskStore(f.config.stateDir, Date.now, undefined, log);
  store.recordBridgeStart(id, 'fake-chat', Date.now());
  const relay = new TaskRelay({ store, bridge: f.bridge, workers, setting: new WorkerUpdatesSetting(f.config.stateDir), hub: f.hub,
    background, log, tickMs: 0, chats: { connected: () => true, rows: async () => [], find: async () => undefined, origin: async () => 'tui' } });
  relay.start();
  cleanups.push(() => relay.stop());
  await relay.tick();
  expect(store.get(id)?.status).toBe('finished');
  f.hold.set(false);
  await expect(f.bridge.call('send_message', { chat: `paseo:${id}`, text: 'Fixture follow-up' },
    { cwd: '/home/me/code/app' })).rejects.toMatchObject({ status: 403 });
  expect(fetch).toHaveBeenCalled();
  expect(history).not.toHaveBeenCalled();
  expect(keep).not.toHaveBeenCalled();
  expect(subscribe).not.toHaveBeenCalled();
  expect(f.paseo.workerSnapshot(id)).toBeUndefined();
  expect(await f.paseo.listConversations()).toEqual([]);
});


it.each([true, false])('uses effective run visibility when idle: %s', async (visible) => {
  const f = await fixture();
  const original = f.dashboard.getMockImplementation()!;
  f.dashboard.mockImplementation(async (path, ...args) => {
    if (path === '/api/config/defaults') return { sessions: { show_subagents: !visible } };
    if (path === '/api/config') return { sessions: { show_subagents: visible } };
    return original(path, ...args);
  });
  if (visible) expect(await f.quiet()).toMatchObject({ quiet: true, runningTasks: 0 });
  else expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
    reasons: expect.arrayContaining(['hermes_activity_unavailable']) });
  expect(f.dashboard.mock.calls.some(([path]) => path === '/api/config/defaults')).toBe(false);
});


it('keeps a loaded custom provider unknown without sub-agent support', async () => {
  const f = await fixture();
  f.client.fetchAgents.mockResolvedValue({ entries: [{ agent: {
    id: 'fake-custom', provider: 'custom-claude', cwd: '/home/me/app', status: 'idle', labels: {}, pendingPermissions: [],
    capabilities: { supportsStreaming: true }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  } as never, project: null }], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } });
  Object.assign(f.client, { getLastServerInfoMessage: () => ({ features: { providerSubagents: false } }) });
  expect(await f.quiet()).toMatchObject({ quiet: false, reasons: expect.arrayContaining(['paseo_activity_unavailable']) });
});

it.each(['parent wake-up', 'page hand-off', 'sub-agent update'] as const)(
  'rejects activity that changes during a report: %s', async (kind) => {
    const f = await fixture();
    const parent = { id: 'fake-parent', provider: 'claude', cwd: '/home/me/app', status: 'idle', labels: {}, pendingPermissions: [],
      capabilities: { supportsStreaming: true }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    let changed = false;
    const change = () => {
      if (changed) return;
      changed = true;
      if (kind === 'sub-agent update') Reflect.get(f.paseo, 'onSubagentUpdate').call(f.paseo, { kind: 'upsert',
        subagent: { id: 'fake-sub', parentAgentId: parent.id, provider: parent.provider, status: 'running' } });
      else Reflect.get(f.paseo, 'onAgentUpdate').call(f.paseo, { kind: 'upsert', agent: { ...parent, status: 'running' } });
    };
    Reflect.get(f.paseo, 'agents').set(parent.id, parent);
    Object.assign(f.client, { getLastServerInfoMessage: () => ({ features: { providerSubagents: true } }),
      listProviderSubagents: async () => { if (kind !== 'page hand-off') change(); return { subagents: [] }; } });
    f.client.fetchAgents.mockImplementation(async (...args: unknown[]) => {
      const cursor = (args[0] as { page: { cursor?: string } }).page.cursor;
      if (cursor) { change(); return { entries: [], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }; }
      return { entries: [{ agent: parent as never, project: null }],
        pageInfo: { hasMore: kind === 'page hand-off', nextCursor: kind === 'page hand-off' ? 'fake-next' : null, prevCursor: null } };
    });
    expect(await f.quiet()).toMatchObject({ quiet: false, runningTasks: null,
      reasons: expect.arrayContaining(['paseo_activity_unavailable']) });
    expect(changed).toBe(true);
  },
);

it.each(['restart', 'failed proof', 'exhausted proof'] as const)(
  'keeps an unverified terminal task unreconciled after %s', async (kind) => {
    const f = await fixture();
    const tasks = f.tasks;
    const store = Reflect.get(tasks, 'deps').store as TaskStore;
    const now = Date.now();
    const snap = { id: '00000000-0000-4000-8000-000000000099', provider: 'demo', cwd: '/home/me/app',
      status: 'running' as const, loaded: true, pendingPermissions: 0, labels: { 'wayroost.parent-hermes-chat': 'fake-chat' }, createdAt: now };
    const rows = vi.fn(async () => { throw new Error('Fixture proof unavailable'); });
    Reflect.get(tasks, 'deps').chats.rows = rows;
    tasks.consider(snap, now);
    tasks.consider({ ...snap, status: 'idle' }, now + 1);
    const task = store.get(snap.id)!;
    expect(task).toMatchObject({ verified: false, status: 'finished' });
    if (kind === 'restart') {
      store.save();
      const restored = new TaskRelay({ ...Reflect.get(tasks, 'deps'), store: new TaskStore(f.config.stateDir) });
      const agent = { id: snap.id, provider: snap.provider, cwd: snap.cwd, status: 'idle', labels: snap.labels,
        capabilities: { supportsStreaming: true }, pendingPermissions: [], createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
      Reflect.get(f.paseo, 'agents').set(snap.id, agent);
      await restored.tick();
      expect(restored.quietCounts().reasons).toContain('tasks_unreconciled');
    } else {
      await tasks.tick();
      if (kind === 'exhausted proof') Reflect.get(tasks, 'lateChecks').set(task.id, 3);
      expect(await f.quiet()).toMatchObject({ quiet: false, reasons: expect.arrayContaining(['tasks_unreconciled']) });
    }
  },
);


it.each(['during read', 'before cached read'] as const)(
  'requires launch-proof reads begun after the task state change: %s', async (when) => {
    const f = await fixture();
    const tasks = f.tasks;
    const now = Date.now();
    const snap = (id: string) => ({ id, provider: 'demo', cwd: '/home/me/app', status: 'running' as const,
      loaded: true, pendingPermissions: 0, labels: { 'wayroost.parent-hermes-chat': 'fake-chat' }, createdAt: now });
    const first = snap('00000000-0000-4000-8000-000000000091');
    const second = snap('00000000-0000-4000-8000-000000000092');
    tasks.consider(first, now); tasks.consider(second, now);
    Reflect.get(tasks, 'deps').chats.rows = vi.fn(async () => {
      tasks.consider({ ...second, status: 'idle' }, now + 1);
      if (when === 'during read') tasks.consider({ ...first, status: 'idle' }, now + 1);
      return [];
    });
    await tasks.tick();
    expect(tasks.quietCounts().reasons).toContain('tasks_unreconciled');
    expect(await f.quiet()).toMatchObject({ quiet: false, reasons: expect.arrayContaining(['tasks_unreconciled']) });
    Reflect.get(tasks, 'deps').chats.rows = vi.fn(async () => []);
    // A new read after the state change establishes that no launch proof is present.
    Reflect.get(tasks, 'checked').clear();
    await tasks.tick();
    expect(tasks.quietCounts().reasons ?? []).not.toContain('tasks_unreconciled');
  },
);
