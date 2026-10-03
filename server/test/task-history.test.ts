import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withDeviceSignal } from '../src/security/device-signal.js';
import { TaskHistory, type TaskEvent, type TaskEventTotal } from '../src/tasks/history.js';
import { TASK_STATES, TaskStore, type TaskRecord } from '../src/tasks/store.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5);
const ID = 'deadbeef-0000-0000-0000-000000000001';
const dirs: string[] = [];
const io = vi.hoisted(() => ({ failSync: false, partialAppend: false, directorySyncs: 0, eventRewrites: 0, failRetention: false, failPublication: '', operations: [] as string[], paths: new Map<number, string>() }));
vi.mock('node:fs', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => {
    const fd = fs.openSync(...args);
    io.paths.set(fd, String(args[0]));
    return fd;
  }, closeSync: (fd: number) => { io.paths.delete(fd); fs.closeSync(fd); }, fsyncSync: (fd: number) => {
    if (io.failSync) { io.failSync = false; throw new Error('Demo sync failure'); }
    if (fs.fstatSync(fd).isDirectory()) { io.directorySyncs++; io.operations.push('sync directory'); }
    else io.operations.push('sync ' + basename(io.paths.get(fd) ?? ''));
    fs.fsyncSync(fd);
  }, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (io.partialAppend && typeof args[0] === 'number' && io.paths.get(args[0])?.endsWith('/task-events.jsonl')) {
      io.partialAppend = false;
      fs.writeFileSync(args[0], String(args[1]).slice(0, 12));
      throw Object.assign(new Error('Demo partial append failure'), { code: 'EIO' });
    }
    fs.writeFileSync(...args);
  }, renameSync: (from: string, to: string) => {
    if (io.failPublication === basename(to)) throw new Error('Demo publication failure');
    if (to.endsWith('task-events.jsonl')) io.eventRewrites++;
    if (io.failRetention && to.endsWith('task-event-totals.json')) throw new Error('Demo retention failure');
    fs.renameSync(from, to);
    io.operations.push('rename ' + basename(to));
  }, unlinkSync: (path: string) => {
    if (io.failPublication === 'cleanup' && path.endsWith('task-events.jsonl.retention')) throw new Error('Demo cleanup failure');
    fs.unlinkSync(path);
    io.operations.push('unlink ' + basename(path));
  } };
});
afterEach(() => { io.failSync = false; io.partialAppend = false; io.failRetention = false; io.failPublication = ''; io.directorySyncs = 0; io.eventRewrites = 0; io.operations = []; io.paths.clear(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wayroost-task-history-'));
  dirs.push(dir);
  let now = T0;
  const store = new TaskStore(dir, () => now);
  return { dir, store, now: () => now, at: (at: number) => { now = at; } };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: ID, provider: 'demo-provider', role: 'worker', cwd: '/home/me/example', title: 'Demo task',
    chat: 'demo-chat', verified: false, createdAt: T0, startedAt: T0,
    dueMinutes: 30, dueAt: T0 + 30 * 60_000, status: 'running', round: 1,
    since: T0, changedAt: T0, lastSeen: T0, relays: [], ...overrides,
  };
}

function events(dir: string): TaskEvent[] {
  const text = readFileSync(join(dir, 'task-events.jsonl'), 'utf8').trim();
  return text ? text.split('\n').map((line) => JSON.parse(line) as TaskEvent) : [];
}

function totals(dir: string): TaskEventTotal[] {
  return JSON.parse(readFileSync(join(dir, 'task-event-totals.json'), 'utf8')) as TaskEventTotal[];
}

function revoked(action: () => void): void {
  const device = new AbortController();
  withDeviceSignal(device.signal, () => {
    device.abort();
    expect(action).toThrow(expect.objectContaining({ status: 403 }));
  });
}

function files(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]));
}

describe('task status history', () => {
  it.each(['add', 'finish', 'restart', 'same state', 'bridge start', 'changed', 'save'])(
    'rejects revoked-device %s before saved baselines or task state change', (action) => {
      const t = setup();
      const saved = task({ status: action === 'restart' ? 'finished' : 'running' });
      writeFileSync(join(t.dir, 'tasks.json'), JSON.stringify({ tasks: [saved] }));
      const store = new TaskStore(t.dir, t.now);
      const record = store.get(ID)!;
      const before = files(t.dir);
      const mutations: Record<string, () => void> = {
        add: () => { store.add(task({ id: 'deadbeef-0000-0000-0000-000000000002' })); },
        finish: () => store.move(record, 'finished', T0 + 60_000),
        restart: () => store.move(record, 'running', T0 + 60_000),
        'same state': () => store.move(record, record.status, T0 + 60_000),
        'bridge start': () => store.recordBridgeStart(ID, 'demo-chat', T0),
        changed: () => store.changed(),
        save: () => store.save(true),
      };
      revoked(mutations[action]!);
      expect(store.all()).toEqual([saved]);
      expect(store.bridgeStarts()).toEqual([]);
      expect(files(t.dir)).toEqual(before);
      // A rejected call must not leave dirty task bookkeeping for a later writer.
      t.at(T0 + 60_000);
      store.save();
      expect(readFileSync(join(t.dir, 'tasks.json'), 'utf8')).toBe(before['tasks.json']);
      expect(events(t.dir)).toEqual([expect.objectContaining({ from: null, to: saved.status })]);
    },
  );

  it.each(['append', 'baseline', 'recover', 'retain'])(
    'rejects revoked-device history %s without writes or index changes', (action) => {
      const t = setup();
      const history = new TaskHistory(t.dir, t.now);
      history.append(task({ status: 'finished' }), null);
      t.at(T0 + 181 * DAY);
      const before = files(t.dir);
      const last = structuredClone(history.last(ID));
      const next = task({ round: 2, changedAt: t.now(), since: t.now() });
      const mutations: Record<string, () => void> = {
        append: () => history.append(next, 'finished'),
        baseline: () => history.baseline(next),
        recover: () => history.recover(),
        retain: () => history.retain(),
      };
      revoked(mutations[action]!);
      expect(history.last(ID)).toEqual(last);
      expect(files(t.dir)).toEqual(before);
      history.append(next, 'finished');
      expect(events(t.dir).map((event) => [event.to, event.run])).toEqual([['finished', 1], ['running', 2]]);
    },
  );

  it.each(['task-events.jsonl', 'task-event-totals.json', 'task-events.jsonl.retention'])(
    'does not quarantine corrupt %s for a revoked device', (name) => {
      const t = setup();
      writeFileSync(join(t.dir, name), '{"obviously-fake":"corrupt"');
      const log = { info: vi.fn(), warn: vi.fn() };
      const history = new TaskHistory(t.dir, t.now, log);
      const before = files(t.dir);
      revoked(() => history.recover());
      expect(files(t.dir)).toEqual(before);
      history.recover();
      expect(readdirSync(t.dir).some((file) => file.startsWith(name + '.corrupt-'))).toBe(true);
    },
  );

  it('does not recover a failed append sync for a revoked device', () => {
    const t = setup();
    const history = new TaskHistory(t.dir, t.now);
    io.failSync = true;
    expect(() => history.append(task(), null)).toThrow('Demo sync failure');
    const before = files(t.dir);
    const syncs = io.directorySyncs;
    revoked(() => history.recover());
    expect(files(t.dir)).toEqual(before);
    expect(io.directorySyncs).toBe(syncs);
    expect(history.last(ID)).toBeUndefined();
    history.recover();
    expect(history.last(ID)).toMatchObject({ to: 'running' });
    expect(events(t.dir)).toHaveLength(1);
  });

  it('does not publish pending retention for a revoked device', () => {
    const t = setup();
    const history = new TaskHistory(t.dir, t.now);
    history.append(task({ status: 'finished' }), null);
    t.at(T0 + 181 * DAY);
    io.failPublication = 'task-event-totals.json';
    expect(() => history.retain()).toThrow('Demo publication failure');
    io.failPublication = '';
    const before = files(t.dir);
    revoked(() => history.retain());
    expect(files(t.dir)).toEqual(before);
    history.retain();
    expect(events(t.dir)).toEqual([]);
    expect(totals(t.dir)[0]?.count).toBe(1);
  });

  it.each([false, true])('preserves saved state and quarantines a truncated final line with pending retention: %s', (retention) => {
    const t = setup();
    const record = t.store.add(task());
    t.store.move(record, 'finished', T0 + 60_000);
    if (retention) {
      t.at(T0 + 181 * DAY);
      record.lastSeen = t.now();
      io.failPublication = 'task-events.jsonl.retention';
      t.store.save(true);
    }
    t.store.move(record, 'running', t.now() + 120_000);
    t.store.move(record, 'finished', t.now() + 180_000);
    record.relays.push({ id: 'finished#2', kind: 'update', queuedAt: t.now() + 180_000, attempts: 1 });
    t.store.save(true);
    const saved = JSON.parse(readFileSync(join(t.dir, 'tasks.json'), 'utf8')).tasks[0];
    const path = join(t.dir, 'task-events.jsonl');
    const raw = readFileSync(path, 'utf8').trimEnd().slice(0, -12);
    writeFileSync(path, raw);
    io.failPublication = '';
    const log = { info: vi.fn(), warn: vi.fn() };
    const reopened = new TaskStore(t.dir, t.now, undefined, log);
    expect(reopened.get(ID)).toEqual(saved);
    expect(reopened.all()).toEqual([saved]);
    new TaskHistory(t.dir, t.now, log).recover();
    const quarantine = readdirSync(t.dir).find((name) => name.startsWith('task-events.jsonl.corrupt-'))!;
    expect(quarantine).toBeDefined();
    expect(readFileSync(join(t.dir, quarantine), 'utf8')).toBe(raw);
    expect(log.warn).toHaveBeenCalledWith({ file: 'task-events.jsonl' }, 'task log: invalid or unreadable history moved aside');
    reopened.move(reopened.get(ID)!, 'running', t.now() + 240_000);
    expect(events(t.dir)).toEqual([
      expect.objectContaining({ from: null, to: 'finished', round: 2, since: saved.since, changedAt: saved.changedAt }),
      expect.objectContaining({ from: 'finished', to: 'running', round: 3 }),
    ]);
    reopened.save(true);
    expect(new TaskStore(t.dir, t.now).get(ID)).toMatchObject({ status: 'running', round: 3 });
  });

  it('writes saved baselines for every existing task before its first transition after upgrade', () => {
    const t = setup();
    const other = task({ id: 'deadbeef-0000-0000-0000-000000000002', status: 'needs-approval' });
    writeFileSync(join(t.dir, 'tasks.json'), JSON.stringify({ tasks: [task(), other] }));
    t.at(T0 + 60 * 60_000);
    const upgraded = new TaskStore(t.dir, t.now);
    expect(upgraded.get(ID)).toEqual(task());
    upgraded.move(upgraded.get(ID)!, 'finished', t.now());
    expect(events(t.dir).map((event) => [event.task, event.from, event.to])).toEqual([
      [ID, null, 'running'], [other.id, null, 'needs-approval'], [ID, 'running', 'finished'],
    ]);
    expect(events(t.dir)[0]).toMatchObject({ since: T0, changedAt: T0, startedAt: T0 });
    upgraded.save(true);
    const restarted = new TaskStore(t.dir, t.now);
    restarted.move(restarted.get(ID)!, 'finished', t.now());
    expect(events(t.dir)).toHaveLength(3);
    t.at(T0 + 182 * DAY);
    restarted.save(true);
    expect(totals(t.dir)[0]).toMatchObject({ outcome: 'finished', count: 1, stateMs: { running: 3_600_000 }, requestToDoneMs: 3_600_000 });
    expect(totals(t.dir)[0]!.stateMs.finished).toBeUndefined();
  });

  it('seeds existing tasks on a save without changing them or duplicating baselines on restart', () => {
    const t = setup();
    const saved = task({ round: 2, status: 'needs-approval', since: T0 + 60_000, changedAt: T0 + 120_000 });
    writeFileSync(join(t.dir, 'tasks.json'), JSON.stringify({ tasks: [saved] }));
    const upgraded = new TaskStore(t.dir, t.now);
    expect(existsSync(join(t.dir, 'task-events.jsonl'))).toBe(false);
    upgraded.save(true);
    expect(upgraded.get(ID)).toEqual(saved);
    expect(events(t.dir)).toEqual([expect.objectContaining({ from: null, to: saved.status, round: 2, since: saved.since, changedAt: saved.changedAt })]);
    new TaskStore(t.dir, t.now).save(true);
    expect(events(t.dir)).toHaveLength(1);
    expect(statSync(join(t.dir, 'task-events.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('writes a saved baseline after retention detects newly damaged history in the same process', () => {
    const t = setup();
    const record = t.store.add(task());
    t.store.move(record, 'finished', T0 + 60_000);
    t.store.save(true);
    const path = join(t.dir, 'task-events.jsonl');
    writeFileSync(path, readFileSync(path, 'utf8') + '{"task":');
    t.at(T0 + DAY);
    t.store.save(true);
    expect(record.status).toBe('finished');
    t.store.move(record, 'running', t.now());
    expect(events(t.dir).map((event) => [event.from, event.to, event.round])).toEqual([
      [null, 'finished', 1], ['finished', 'running', 2],
    ]);
  });

  it.each(TASK_STATES.flatMap((from) => TASK_STATES.filter((to) => to !== from).map((to) => ({ from, to }))))(
    'writes exactly one line for $from -> $to', ({ from, to }) => {
      const t = setup();
      const record = t.store.add(task({ status: from }));
      t.store.move(record, to, T0 + 60_000);
      t.store.move(record, to, T0 + 90_000);
      expect(events(t.dir)).toHaveLength(2);
      expect(events(t.dir)[1]).toMatchObject({ from, to, since: T0, changedAt: T0 + 60_000, round: record.round });
    },
  );

  it('appends immediately, preserves timing bounds, and ignores unchanged status', () => {
    const t = setup();
    const record = t.store.add(task());
    t.store.move(record, 'needs-approval', T0 + 60_000);
    t.store.move(record, 'needs-approval', T0 + 90_000);
    t.store.move(record, 'running', T0 + 120_000);
    expect(events(t.dir)).toEqual([
      { task: ID, round: 1, run: 1, role: 'worker', provider: 'demo-provider', from: null, to: 'running', since: T0, changedAt: T0, startedAt: T0 },
      { task: ID, round: 1, run: 1, role: 'worker', provider: 'demo-provider', from: 'running', to: 'needs-approval', since: T0, changedAt: T0 + 60_000, startedAt: T0 },
      { task: ID, round: 1, run: 1, role: 'worker', provider: 'demo-provider', from: 'needs-approval', to: 'running', since: T0 + 60_000, changedAt: T0 + 120_000, startedAt: T0 },
    ]);
    expect(existsSync(join(t.dir, 'tasks.json'))).toBe(false);
    expect(statSync(join(t.dir, 'task-events.jsonl')).mode & 0o777).toBe(0o600);
    chmodSync(join(t.dir, 'task-events.jsonl'), 0o644);
    t.store.move(record, 'finished', T0 + 180_000);
    expect(statSync(join(t.dir, 'task-events.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('allows only metadata, even with worker content and extra properties on the record', () => {
    const t = setup();
    const record = Object.assign(task(), {
      title: 'DEMO_TITLE_TEXT', cwd: '/home/me/DEMO_CWD_TEXT', brief: 'DEMO_BRIEF_TEXT',
      final: 'DEMO_FINAL_TEXT', relayText: 'DEMO_RELAY_TEXT', criteria: ['DEMO_CRITERIA_TEXT'], evidence: ['DEMO_EVIDENCE_TEXT'],
    });
    t.store.add(record);
    t.store.move(record, 'finished', T0 + 60_000);
    const fields = ['task', 'round', 'run', 'role', 'provider', 'from', 'to', 'since', 'changedAt', 'unseenFrom', 'startedAt'];
    for (const event of events(t.dir)) expect(Object.keys(event).every((key) => fields.includes(key))).toBe(true);
    expect(events(t.dir).every((event) => typeof event.startedAt === 'number')).toBe(true);
    expect(readFileSync(join(t.dir, 'task-events.jsonl'), 'utf8')).not.toMatch(/DEMO_\w+_TEXT/);
  });

  it('rejects metadata with invalid scalar types and a history line outside the allowlist', () => {
    const t = setup();
    expect(() => t.store.add(Object.assign(task(), { provider: { workerText: 'DEMO_WORKER_TEXT' } }) as unknown as TaskRecord)).toThrow('Invalid task history metadata');
    expect(t.store.all()).toEqual([]);
    t.store.add(task({ role: undefined }));
    expect(events(t.dir)[0]).not.toHaveProperty('role');
    const path = join(t.dir, 'task-events.jsonl');
    writeFileSync(path, JSON.stringify({ ...events(t.dir)[0], title: 'DEMO_WORKER_TEXT' }) + '\n');
    expect(() => new TaskStore(t.dir)).not.toThrow();
    new TaskHistory(t.dir).recover();
    expect(readdirSync(t.dir).some((name) => name.startsWith('task-events.jsonl.corrupt-'))).toBe(true);
  });

  it.each([NaN, Infinity, 'DEMO_START_TEXT'])('rejects a nonnumeric or nonfinite round start (%s)', (startedAt) => {
    const t = setup();
    expect(() => t.store.add({ ...task(), startedAt } as TaskRecord)).toThrow('Invalid task history metadata');
    expect(t.store.all()).toEqual([]);
    expect(existsSync(join(t.dir, 'task-events.jsonl'))).toBe(false);
  });

  it('keeps the saved status, round, times and queue when later telemetry was not saved', () => {
    const t = setup();
    const record = t.store.add(task());
    t.store.save();
    t.store.move(record, 'finished', T0 + 60_000);
    t.store.move(record, 'running', T0 + 120_000);
    t.store.move(record, 'failed', T0 + 180_000);
    const reopened = new TaskStore(t.dir, () => T0 + 240_000);
    const restored = reopened.get(ID)!;
    expect(restored).toEqual(task());
    reopened.move(restored, 'failed', T0 + 240_000);
    expect(events(t.dir)).toHaveLength(6);
    expect(events(t.dir)[4]).toMatchObject({ from: null, to: 'running', round: 1 });
    expect(events(t.dir)[5]).toMatchObject({ from: 'running', to: 'failed', round: 1, unseenFrom: T0 });
    reopened.save();
    expect(new TaskStore(t.dir).get(ID)).toMatchObject({ status: 'failed', round: 1 });
  });

  it('preserves saved state even when later telemetry has an earlier clock time', () => {
    const t = setup();
    const record = t.store.add(task());
    t.store.save();
    t.store.move(record, 'finished', T0 - 60_000);
    const reopened = new TaskStore(t.dir, () => T0 + 60_000);
    expect(reopened.get(ID)).toEqual(task());
    reopened.move(reopened.get(ID)!, 'finished', T0 + 60_000);
    expect(events(t.dir)).toHaveLength(4);
    expect(reopened.get(ID)).toMatchObject({ status: 'finished', changedAt: T0 + 60_000 });
  });

  it('keeps downtime uncertainty for approval and resumed statuses as well as endings', () => {
    const t = setup();
    const record = t.store.add(task());
    t.store.move(record, 'needs-approval', T0 + 600_000);
    t.store.move(record, 'finished', T0 + 900_000);
    t.store.move(record, 'running', T0 + 1_200_000);
    expect(events(t.dir).slice(1).map((event) => event.unseenFrom)).toEqual([T0, T0 + 600_000, T0 + 900_000]);
  });

  it('takes a new sighting from the worker when no task record was saved', () => {
    const t = setup();
    const record = t.store.add(task());
    t.store.move(record, 'finished', T0 + 60_000);
    const reopened = new TaskStore(t.dir, () => T0 + 120_000);
    reopened.add(task({ status: 'finished', changedAt: T0 + 120_000, since: T0 + 120_000 }));
    expect(events(t.dir)).toHaveLength(3);
    expect(reopened.get(ID)).toMatchObject({ status: 'finished', since: T0 + 120_000, changedAt: T0 + 120_000 });
    reopened.move(reopened.get(ID)!, 'running', T0 + 180_000);
    expect(events(t.dir)[3]).toMatchObject({ from: 'finished', to: 'running', round: 2 });
  });

  it('fails before changing a status or adding a record if the history cannot be written', () => {
    const t = setup();
    const record = t.store.add(task());
    rmSync(join(t.dir, 'task-events.jsonl'));
    mkdirSync(join(t.dir, 'task-events.jsonl'));
    expect(() => t.store.move(record, 'finished', T0 + 60_000)).toThrow();
    expect(record).toMatchObject({ status: 'running', round: 1, changedAt: T0 });
    expect(() => t.store.add(task({ id: 'deadbeef-0000-0000-0000-000000000002' }))).toThrow();
    expect(t.store.all()).toHaveLength(1);
    expect(() => t.store.get(ID)).not.toThrow();
    t.store.recordBridgeStart(ID, 'demo-chat', T0);
    expect(() => t.store.save()).not.toThrow();
    expect(JSON.parse(readFileSync(join(t.dir, 'tasks.json'), 'utf8')).bridgeStarts).toHaveLength(1);
    const reopened = new TaskStore(t.dir);
    expect(reopened.get(ID)?.status).toBe('running');
    expect(() => reopened.move(reopened.get(ID)!, 'finished', T0 + 60_000)).toThrow();
  });

  it('retries a complete append whose sync failed without counting the transition twice', () => {
    const t = setup();
    const record = t.store.add(task());
    io.failSync = true;
    expect(() => t.store.move(record, 'finished', T0 + 60_000)).toThrow('Demo sync failure');
    expect(record.status).toBe('running');
    expect(t.store.get(ID)).toMatchObject({ status: 'running', changedAt: T0 });
    t.store.move(record, 'finished', T0 + 120_000);
    expect(record).toMatchObject({ status: 'finished', changedAt: T0 + 60_000 });
    expect(events(t.dir)).toHaveLength(2);
    io.failSync = true;
    const second = task({ id: 'deadbeef-0000-0000-0000-000000000002' });
    expect(() => t.store.add(second)).toThrow('Demo sync failure');
    t.store.add(second);
    expect(events(t.dir)).toHaveLength(3);
    expect(t.store.all()).toHaveLength(2);
  });

  it.each(['finished', 'follow-up'] as const)('restores the starting observation after a partial %s append is quarantined', (transition) => {
    const t = setup();
    const record = t.store.add(task());
    if (transition === 'follow-up') t.store.move(record, 'finished', T0 + 60_000);
    const before = structuredClone(record);
    const pendingAt = T0 + (transition === 'finished' ? 60_000 : 120_000);
    io.partialAppend = true;
    expect(() => t.store.move(record, transition === 'finished' ? 'finished' : 'running', pendingAt)).toThrow('Demo partial append failure');
    expect(record).toEqual(before);
    t.store.move(record, transition === 'finished' ? 'finished' : 'running', T0 + 180_000);
    expect(events(t.dir)).toEqual([
      expect.objectContaining({ from: null, to: before.status, round: before.round, changedAt: before.changedAt }),
      expect.objectContaining({ from: before.status, to: record.status, round: record.round, changedAt: pendingAt }),
    ]);
    expect(readdirSync(t.dir).filter((name) => name.startsWith('task-events.jsonl.corrupt-'))).toHaveLength(1);
    if (transition === 'follow-up') t.store.move(record, 'finished', T0 + 180_000);
    t.at(T0 + 182 * DAY);
    t.store.save(true);
    const completed = totals(t.dir).flatMap((total) => total.runs).find((run) => run.event.round === record.round)!;
    expect(completed.stateMs.running).toBe(60_000);
    expect(completed.doneAt - completed.startedAt).toBe(60_000);
    expect(completed.stateMs.finished).toBeUndefined();
  });

  it.each(['finished', 'follow-up', 'first sighting'] as const)('requires successful recovery before retrying a %s transition', (transition) => {
    const t = setup();
    const record = task();
    if (transition !== 'first sighting') t.store.add(record);
    if (transition === 'follow-up') t.store.move(record, 'finished', T0 + 60_000);
    const at = T0 + 120_000;
    const mutate = (now: number) => transition === 'first sighting'
      ? t.store.add(record)
      : t.store.move(record, transition === 'finished' ? 'finished' : 'running', now);
    io.failSync = true;
    expect(() => mutate(at)).toThrow('Demo sync failure');
    const before = { ...record };
    const count = events(t.dir).length;
    io.failSync = true;
    expect(() => mutate(at + 60_000)).toThrow('Demo sync failure');
    expect(record).toEqual(before);
    expect(events(t.dir)).toHaveLength(count);
    io.failSync = true;
    expect(() => t.store.get(ID)).not.toThrow();
    io.failSync = false;
    mutate(at + 120_000);
    expect(events(t.dir)).toHaveLength(count);
    if (transition === 'follow-up') expect(record).toMatchObject({ round: 2, startedAt: at, dueAt: at + 30 * 60_000, changedAt: at });
    else expect(record.changedAt).toBe(transition === 'first sighting' ? T0 : at);
    t.store.save(true);
    expect(new TaskStore(t.dir).get(ID)).toMatchObject({ status: record.status, round: record.round, startedAt: record.startedAt, dueAt: record.dueAt });
  });

  it('quarantines an interrupted append and accepts a complete final line without a newline', () => {
    const t = setup();
    t.store.add(task());
    const path = join(t.dir, 'task-events.jsonl');
    writeFileSync(path, readFileSync(path, 'utf8') + '{"task":');
    const reopened = new TaskStore(t.dir, t.now);
    const record = reopened.add(task());
    reopened.move(record, 'finished', T0 + 60_000);
    expect(events(t.dir).map((event) => event.to)).toEqual(['running', 'finished']);
    expect(readdirSync(t.dir).some((name) => name.startsWith('task-events.jsonl.corrupt-'))).toBe(true);
    reopened.save(true);
    writeFileSync(path, readFileSync(path, 'utf8').trimEnd());
    const again = new TaskStore(t.dir, t.now);
    const finished = again.get(ID)!;
    again.move(finished, 'running', T0 + 120_000);
    expect(events(t.dir)).toHaveLength(3);
  });

  it('supports queued metadata without adding a queue or a UI', () => {
    const t = setup();
    const history = new TaskHistory(t.dir, t.now);
    history.append({ ...task(), status: 'queued' }, null);
    history.append(task(), 'queued');
    expect(events(t.dir).map((event) => [event.from, event.to])).toEqual([[null, 'queued'], ['queued', 'running']]);
  });

  it.each([
    '{"not":"an event"}\n',
    JSON.stringify({ task: ID, round: 1, provider: 'demo-provider', role: 'designer', from: null, to: 'running', since: T0, changedAt: T0 }) + '\n',
    JSON.stringify({ task: ID, round: 1, provider: 'demo-provider', from: null, to: 'demo-future-state', since: T0, changedAt: T0 }) + '\n',
  ])('quarantines corrupt or unknown history and keeps the task log usable (%s)', (bad) => {
    const t = setup();
    t.store.add(task());
    t.store.save();
    const path = join(t.dir, 'task-events.jsonl');
    const raw = readFileSync(path, 'utf8') + bad;
    writeFileSync(path, raw);
    const reopened = new TaskStore(t.dir);
    expect(reopened.get(ID)?.status).toBe('running');
    reopened.move(reopened.get(ID)!, 'finished', T0 + 60_000);
    const quarantine = readdirSync(t.dir).find((name) => name.startsWith('task-events.jsonl.corrupt-'))!;
    expect(readFileSync(join(t.dir, quarantine), 'utf8')).toBe(raw);
    expect(events(t.dir)).toHaveLength(2);
    expect(events(t.dir)[0]).toMatchObject({ from: null, to: 'running' });
  });

  it('never restores queued metadata as an unsupported task status', () => {
    const t = setup();
    t.store.add(task());
    t.store.save();
    new TaskHistory(t.dir).append({ ...task(), status: 'queued', changedAt: T0 + 60_000 }, 'running');
    const reopened = new TaskStore(t.dir);
    expect(reopened.get(ID)?.status).toBe('running');
    reopened.save();
    expect(new TaskStore(t.dir).get(ID)).toBeDefined();
  });

  it('uses the supplied round for a pruned worker without restoring it from telemetry', () => {
    const t = setup();
    const record = t.store.add(task());
    t.store.move(record, 'finished', T0 + 60_000);
    t.store.move(record, 'running', T0 + 120_000);
    t.store.move(record, 'finished', T0 + 180_000);
    t.at(T0 + 15 * DAY);
    t.store.save();
    const reopened = new TaskStore(t.dir, t.now);
    const restored = reopened.add(task({ status: 'finished', baseline: true, changedAt: t.now() }));
    expect(restored).toMatchObject({ baseline: true, round: 1, status: 'finished', relays: [] });
    reopened.move(restored, 'running', t.now() + 60_000);
    expect(restored).toMatchObject({ round: 2, status: 'running' });
    expect(restored.baseline).toBeUndefined();
  });

  it('maps free-form providers to a bounded id on write and read', () => {
    const t = setup();
    t.store.add(task({ provider: 'DEMO_WORKER_TEXT /home/me/example ' + 'x'.repeat(5000) }));
    expect(events(t.dir)[0]?.provider).toBe('other');
    expect(readFileSync(join(t.dir, 'task-events.jsonl'), 'utf8')).not.toContain('DEMO_WORKER_TEXT');
    const path = join(t.dir, 'task-events.jsonl');
    writeFileSync(path, JSON.stringify({ ...events(t.dir)[0], provider: 'demo provider text' }) + '\n');
    const history = new TaskHistory(t.dir);
    expect(history.last(ID)?.provider).toBe('other');
  });

  it.each(['', 'x'.repeat(65), 'demo provider', 'demo\n', 'demo\t', 'demo\u200b'])('normalizes invalid provider ids (%j)', (provider) => {
    const t = setup();
    t.store.add(task({ provider }));
    expect(events(t.dir)[0]?.provider).toBe('other');
  });

  it('preserves bounded provider ids', () => {
    const t = setup();
    const provider = 'demo.provider:v1/model-id_'.padEnd(64, 'x');
    t.store.add(task({ provider }));
    expect(events(t.dir)[0]?.provider).toBe(provider);
  });

  it('syncs the directory after the first append and each retention publication', () => {
    const t = setup();
    t.store.add(task({ status: 'finished' }));
    expect(io.directorySyncs).toBeGreaterThan(0);
    expect(io.operations.slice(-2)).toEqual(['sync task-events.jsonl', 'sync directory']);
    io.directorySyncs = 0;
    io.operations = [];
    t.at(T0 + 181 * DAY);
    t.store.save();
    expect(io.directorySyncs).toBeGreaterThanOrEqual(4);
    for (const name of ['rename task-events.jsonl.retention', 'rename task-event-totals.json', 'rename task-events.jsonl', 'unlink task-events.jsonl.retention']) {
      expect(io.operations[io.operations.indexOf(name) + 1]).toBe('sync directory');
    }
  });
});

describe('task history retention', () => {
  it.each([
    { rolled: false, legacy: false, repeatedStart: false },
    { rolled: true, legacy: false, repeatedStart: false },
    { rolled: true, legacy: true, repeatedStart: false },
    { rolled: false, legacy: true, repeatedStart: true },
  ])('distinguishes reused rounds after pruning (totals: $rolled, legacy: $legacy, repeated clock: $repeatedStart)', ({ rolled, legacy, repeatedStart }) => {
    const t = setup();
    const record = t.store.add(task());
    t.store.move(record, 'finished', T0 + 60_000);
    t.store.move(record, 'running', T0 + 120_000);
    t.store.move(record, 'finished', T0 + 180_000);
    if (legacy) writeFileSync(join(t.dir, 'task-events.jsonl'), events(t.dir).map(({ run: _run, ...event }) => JSON.stringify(event) + '\n').join(''));
    t.at(T0 + (rolled ? 182 : 15) * DAY);
    t.store.save(true);
    expect(t.store.all()).toEqual([]);
    const reopened = new TaskStore(t.dir, t.now);
    const rediscovered = reopened.add(task({ status: 'finished', baseline: true, since: t.now(), changedAt: t.now(), lastSeen: t.now() }));
    expect(rediscovered).toMatchObject({ status: 'finished', round: 1, startedAt: T0 });
    const start = repeatedStart ? T0 + 90_000 : t.now() + 60_000;
    reopened.move(rediscovered, 'running', start);
    reopened.move(rediscovered, 'finished', start + 60_000);
    expect(rediscovered).toMatchObject({ round: 2, startedAt: start });
    expect(rediscovered).not.toHaveProperty('run');
    reopened.save(true);
    t.at(Math.max(start, t.now()) + 182 * DAY);
    new TaskStore(t.dir, t.now).save(true);
    const rolledUp = totals(t.dir);
    expect(rolledUp.reduce((sum, total) => sum + total.count, 0)).toBe(3);
    expect(rolledUp.reduce((sum, total) => sum + total.fixupRounds, 0)).toBe(2);
    expect(rolledUp.reduce((sum, total) => sum + total.requestToDoneMs, 0)).toBe(180_000);
    expect(rolledUp.reduce((sum, total) => sum + (total.stateMs.running ?? 0), 0)).toBe(180_000);
    expect(rolledUp.flatMap((total) => total.runs).map((run) => run.event.run ?? run.event.round).sort()).toEqual([1, 2, 3]);
    expect(new TaskHistory(t.dir, t.now).last(ID)?.run).toBe(3);
    expect(rolledUp.flatMap((total) => total.runs).map((run) => run.startedAt).sort()).toEqual([T0, T0 + 120_000, start].sort());
  });

  it('keeps reused rounds through failed retention publication and restart', () => {
    const t = setup();
    const record = t.store.add(task());
    t.store.move(record, 'finished', T0 + 60_000);
    t.store.move(record, 'running', T0 + 120_000);
    t.store.move(record, 'finished', T0 + 180_000);
    t.at(T0 + 182 * DAY);
    io.failPublication = 'task-event-totals.json';
    t.store.save(true);
    expect(t.store.all()).toEqual([]);
    const reopened = new TaskStore(t.dir, t.now);
    const rediscovered = reopened.add(task({ status: 'finished', since: t.now(), changedAt: t.now(), lastSeen: t.now() }));
    reopened.move(rediscovered, 'running', t.now());
    reopened.move(rediscovered, 'finished', t.now() + 60_000);
    reopened.save(true);
    const restarted = new TaskStore(t.dir, t.now);
    io.failPublication = '';
    restarted.save(true);
    expect(events(t.dir).at(-1)).toMatchObject({ round: 2, run: 3, to: 'finished' });
    expect(readdirSync(t.dir).some((name) => name.includes('.corrupt-'))).toBe(false);
    t.at(t.now() + 182 * DAY);
    restarted.save(true);
    expect(totals(t.dir).reduce((sum, total) => sum + total.count, 0)).toBe(3);
    expect(totals(t.dir).reduce((sum, total) => sum + total.requestToDoneMs, 0)).toBe(180_000);
  });

  it.each(['running', 'needs-approval'] as const)('excludes superseded intervals after restoring a saved %s baseline', (status) => {
    const t = setup();
    const record = t.store.add(task());
    if (status === 'needs-approval') {
      record.lastSeen = T0 + 60_000;
      t.store.move(record, status, T0 + 60_000);
    }
    t.store.save(true);
    const saved = structuredClone(record);
    t.store.move(record, 'finished', T0 + (status === 'running' ? 60_000 : 90_000));
    t.at(T0 + 120_000);
    const reopened = new TaskStore(t.dir, t.now);
    expect(reopened.get(ID)).toEqual(saved);
    reopened.move(reopened.get(ID)!, 'finished', t.now());
    expect(events(t.dir).slice(-2)).toEqual([
      expect.objectContaining({ from: null, to: status, since: saved.since, changedAt: saved.changedAt }),
      expect.objectContaining({ from: status, to: 'finished', changedAt: t.now() }),
    ]);
    t.at(T0 + 182 * DAY);
    reopened.save(true);
    const stateMs = status === 'running' ? { running: 120_000 } : { running: 60_000, 'needs-approval': 60_000 };
    expect(totals(t.dir)[0]).toMatchObject({ count: 1, stateMs, requestToDoneMs: 120_000 });
    expect(totals(t.dir)[0]!.stateMs).toEqual(stateMs);
    const restarted = new TaskHistory(t.dir, t.now);
    t.at(t.now() + DAY);
    restarted.retain();
    expect(totals(t.dir)[0]!.stateMs).toEqual(stateMs);
  });

  it.each((['needs-approval', 'finished'] as const).flatMap((status) => [55, 60].map((sinceMinute) => ({ status, sinceMinute }))))(
    'bounds an upgrade $status baseline since minute $sinceMinute independently of request latency', ({ status, sinceMinute }) => {
      const t = setup();
      const minute = 60_000;
      const saved = task({ status, since: T0 + sinceMinute * minute, changedAt: T0 + 60 * minute, lastSeen: T0 + 60 * minute });
      writeFileSync(join(t.dir, 'tasks.json'), JSON.stringify({ tasks: [saved] }));
      const upgraded = new TaskStore(t.dir, t.now);
      expect(upgraded.get(ID)).toEqual(saved);
      if (status === 'needs-approval') {
        upgraded.get(ID)!.lastSeen = T0 + 70 * minute;
        upgraded.move(upgraded.get(ID)!, 'finished', T0 + 70 * minute);
      } else upgraded.save(true);
      t.at(T0 + 182 * DAY);
      upgraded.save(true);
      const duration = (60 - sinceMinute + (status === 'needs-approval' ? 10 : 0)) * minute;
      const minimum = (status === 'needs-approval' ? 10 : 0) * minute;
      const stateMs = duration ? { [status]: duration } : {};
      const stateMsBounds = duration ? { [status]: { min: minimum, max: duration } } : {};
      expect(totals(t.dir)[0]).toMatchObject({
        count: 1, stateMs, stateMsBounds,
        requestToDoneMs: (status === 'needs-approval' ? 70 : 60) * minute,
      });
      expect(totals(t.dir)[0]!.stateMs).toEqual(stateMs);
      expect(totals(t.dir)[0]!.stateMsBounds).toEqual(stateMsBounds);
    },
  );

  it.each(['task-event-totals.json', 'task-events.jsonl', 'cleanup'])(
    'preserves an older saved baseline and its reconciled follow-up during failed %s retention', (failure) => {
      const t = setup();
      const record = t.store.add(task());
      t.store.move(record, 'finished', T0 + 60_000);
      t.at(T0 + 181 * DAY);
      record.lastSeen = t.now();
      io.failPublication = failure;
      t.store.save(true);
      const saved = structuredClone(record);
      t.store.move(record, 'running', t.now());
      t.store.move(record, 'finished', t.now() + 60_000);
      const log = { info: vi.fn(), warn: vi.fn() };
      const reopened = new TaskStore(t.dir, t.now, undefined, log);
      expect(reopened.get(ID)).toEqual(saved);
      reopened.move(reopened.get(ID)!, 'running', t.now() + 120_000);
      const tail = events(t.dir).slice(-2);
      expect(tail).toEqual([
        expect.objectContaining({ from: null, to: 'finished', round: 1, changedAt: T0 + 60_000 }),
        expect.objectContaining({ from: 'finished', to: 'running', round: 2, changedAt: t.now() + 120_000 }),
      ]);
      // Recover the appends while the retention publication is still failing.
      const restarted = new TaskStore(t.dir, t.now, undefined, log);
      expect(restarted.get(ID)).toEqual(saved);
      expect(events(t.dir).slice(-2)).toEqual(tail);
      restarted.move(restarted.get(ID)!, 'running', t.now() + 120_000);
      restarted.save(true);
      io.failPublication = '';
      restarted.save(true);
      expect(events(t.dir).slice(-2)).toEqual(tail);
      expect(new TaskStore(t.dir, t.now).get(ID)).toMatchObject({ status: 'running', round: 2 });
      expect(readdirSync(t.dir).some((name) => name.includes('.corrupt-'))).toBe(false);
      expect(log.warn).not.toHaveBeenCalledWith({ file: 'task-events.jsonl' }, expect.any(String));
      expect(totals(t.dir)[0]).toMatchObject({ count: 1, stateMs: { running: 60_000 }, requestToDoneMs: 60_000 });
      restarted.move(restarted.get(ID)!, 'finished', t.now() + 180_000);
      t.at(T0 + 363 * DAY);
      restarted.save(true);
      expect(totals(t.dir).reduce((sum, total) => sum + total.count, 0)).toBe(2);
      expect(totals(t.dir).reduce((sum, total) => sum + total.requestToDoneMs, 0)).toBe(120_000);
      expect(totals(t.dir).reduce((sum, total) => sum + (total.stateMs.running ?? 0), 0)).toBe(120_000);
      expect(totals(t.dir).some((total) => total.stateMs.finished !== undefined)).toBe(false);
    },
  );

  it('reads and rolls up legacy events without a known start using their observation bounds', () => {
    const t = setup();
    const record = t.store.add(task({ since: T0 + 30 * 60_000, changedAt: T0 + 30 * 60_000, lastSeen: T0 + 30 * 60_000 }));
    t.store.move(record, 'finished', T0 + 60 * 60_000);
    const legacy = events(t.dir).map(({ startedAt: _start, ...event }) => event);
    writeFileSync(join(t.dir, 'task-events.jsonl'), legacy.map((event) => JSON.stringify(event) + '\n').join(''));
    t.at(T0 + 182 * DAY);
    const history = new TaskHistory(t.dir, t.now);
    expect(history.last(ID)).toEqual(legacy.at(-1));
    history.retain();
    expect(totals(t.dir)[0]).toMatchObject({ count: 1, requestToDoneMs: 30 * 60_000 });
    expect(readdirSync(t.dir).some((name) => name.includes('.corrupt-'))).toBe(false);
  });

  it('keeps roll-up timing in telemetry without restoring a pruned worker from it', () => {
    const t = setup();
    const record = t.store.add(task({ since: T0 + 30 * 60_000, changedAt: T0 + 30 * 60_000, lastSeen: T0 + 30 * 60_000 }));
    t.store.move(record, 'finished', T0 + 60 * 60_000);
    t.at(T0 + 182 * DAY);
    t.store.save(true);
    expect(t.store.all()).toEqual([]);
    expect(totals(t.dir)[0]).toMatchObject({ stateMs: { running: 30 * 60_000 }, requestToDoneMs: 60 * 60_000 });
    const reopened = new TaskStore(t.dir, t.now);
    const seen = reopened.add(task({ startedAt: t.now(), status: 'finished', since: t.now(), changedAt: t.now() }));
    expect(seen).toMatchObject({ round: 1, startedAt: t.now(), dueAt: T0 + 30 * 60_000, changedAt: t.now() });
    expect(events(t.dir)).toEqual([expect.objectContaining({ from: null, to: 'finished', startedAt: t.now() })]);
    reopened.move(seen, 'running', t.now() + 60_000);
    expect(events(t.dir)[1]).toMatchObject({ round: 2, startedAt: t.now() + 60_000 });
    reopened.move(seen, 'finished', t.now() + 120_000);
    t.at(t.now() + 182 * DAY);
    reopened.save(true);
    expect(totals(t.dir).reduce((sum, total) => sum + total.count, 0)).toBe(2);
    expect(totals(t.dir).reduce((sum, total) => sum + total.rounds, 0)).toBe(2);
    expect(totals(t.dir).reduce((sum, total) => sum + total.fixupRounds, 0)).toBe(1);
    expect(totals(t.dir).reduce((sum, total) => sum + total.requestToDoneMs, 0)).toBe(61 * 60_000);
    expect(totals(t.dir).reduce((sum, total) => sum + (total.stateMs.running ?? 0), 0)).toBe(31 * 60_000);
  });

  it('keeps legacy durations readable without inventing timing bounds that were never retained', () => {
    const t = setup();
    t.store.add(task({ status: 'finished', changedAt: T0 + DAY, since: T0 + DAY }));
    const rolled: TaskEventTotal[] = [{
      week: T0, role: 'worker', provider: 'demo-provider', outcome: 'finished', count: 1,
      rounds: 1, fixupRounds: 0, stateMs: { running: DAY }, requestToDoneMs: DAY, rolledAt: T0 + 181 * DAY,
      runs: [{ event: events(t.dir)[0]!, startedAt: T0, doneAt: T0 + DAY, outcome: 'finished', stateMs: { running: DAY } }],
    }];
    writeFileSync(join(t.dir, 'task-events.jsonl'), '');
    writeFileSync(join(t.dir, 'task-event-totals.json'), JSON.stringify(rolled));
    const history = new TaskHistory(t.dir, t.now);
    history.append({ ...task(), status: 'stopped', since: T0 + 182 * DAY, changedAt: T0 + 182 * DAY }, 'finished');
    t.at(T0 + 363 * DAY);
    history.retain();
    expect(totals(t.dir)[0]).toMatchObject({ count: 1, stateMs: { running: DAY }, requestToDoneMs: DAY });
    expect(totals(t.dir)[0]?.stateMsBounds).toBeUndefined();
    expect(totals(t.dir)[0]?.runs[0]?.stateMsBounds).toBeUndefined();
  });

  it('does not sum a round twice when a corrupt marker is quarantined after totals were published', () => {
    const t = setup();
    const record = t.store.add(task());
    t.store.move(record, 'needs-approval', T0 + DAY);
    t.store.move(record, 'finished', T0 + 2 * DAY);
    t.at(T0 + 183 * DAY);
    io.failPublication = 'task-events.jsonl';
    t.store.save();
    writeFileSync(join(t.dir, 'task-events.jsonl.retention'), '{"unknown":"demo"}');
    const reopened = new TaskStore(t.dir, t.now);
    t.at(T0 + 184 * DAY);
    io.failPublication = '';
    reopened.save(true);
    expect(events(t.dir)).toEqual([]);
    expect(totals(t.dir)[0]).toMatchObject({ count: 1, rounds: 1, stateMs: { running: DAY, 'needs-approval': DAY }, requestToDoneMs: 2 * DAY });
    expect(readdirSync(t.dir).some((name) => name.startsWith('task-events.jsonl.retention.corrupt-'))).toBe(true);
  });

  it('restores retained lines from a pending roll-up after corrupt history is quarantined', () => {
    const t = setup();
    t.store.add(task({ status: 'finished' }));
    const active = task({ id: 'deadbeef-0000-0000-0000-000000000002' });
    t.store.add(active);
    t.at(T0 + 181 * DAY);
    io.failRetention = true;
    t.store.save(true);
    const path = join(t.dir, 'task-events.jsonl');
    writeFileSync(path, readFileSync(path, 'utf8') + '{"unknown":"demo"}\n');
    const reopened = new TaskStore(t.dir, t.now);
    expect(() => reopened.move(reopened.get(active.id)!, 'finished', t.now())).not.toThrow();
    expect(readdirSync(t.dir).some((name) => name.startsWith('task-events.jsonl.corrupt-'))).toBe(true);
    io.failRetention = false;
    reopened.save(true);
    expect(events(t.dir).map((event) => event.to)).toEqual(['running', 'finished']);
    expect(totals(t.dir)[0]?.count).toBe(1);
  });

  it.each(['truncated final line', 'changed prefix'] as const)('quarantines inconsistent retention input with a %s and resumes durable transitions', (corruption) => {
    const t = setup();
    t.store.add(task({ status: 'finished' }));
    const active = t.store.add(task({ id: 'deadbeef-0000-0000-0000-000000000002' }));
    t.at(T0 + 181 * DAY);
    io.failRetention = true;
    t.store.save(true);
    const path = join(t.dir, 'task-events.jsonl');
    const source = events(t.dir);
    const raw = corruption === 'truncated final line'
      ? JSON.stringify(source[0]) + '\n' + JSON.stringify(source[1]).slice(0, -12)
      : source.map((event, i) => JSON.stringify(i === 0 ? { ...event, changedAt: T0 + 1 } : event) + '\n').join('');
    writeFileSync(path, raw);
    const log = { info: vi.fn(), warn: vi.fn() };
    const reopened = new TaskStore(t.dir, t.now, undefined, log);
    const restored = reopened.get(active.id)!;
    expect(() => reopened.move(restored, 'finished', t.now())).not.toThrow();
    expect(restored).toMatchObject({ status: 'finished', round: 1 });
    expect(events(t.dir).map((event) => event.to)).toEqual(['running', 'finished']);
    const quarantine = readdirSync(t.dir).find((name) => name.startsWith('task-events.jsonl.corrupt-'))!;
    expect(readFileSync(join(t.dir, quarantine), 'utf8')).toBe(raw);
    expect(log.warn).toHaveBeenCalledWith({ file: 'task-events.jsonl' }, 'task log: invalid or unreadable history moved aside');
    reopened.save(true);
    expect(JSON.parse(readFileSync(join(t.dir, 'tasks.json'), 'utf8')).tasks[0].status).toBe('finished');
    const restarted = new TaskStore(t.dir, t.now);
    expect(() => restarted.move(restarted.get(active.id)!, 'running', t.now() + 60_000)).not.toThrow();
    expect(events(t.dir).map((event) => [event.to, event.round])).toEqual([['running', 1], ['finished', 1], ['running', 2]]);
    io.failRetention = false;
    restarted.save(true);
    expect(totals(t.dir).reduce((sum, total) => sum + total.count, 0)).toBe(1);
    t.at(T0 + 363 * DAY);
    restarted.save(true);
    expect(totals(t.dir).reduce((sum, total) => sum + total.count, 0)).toBe(2);
    expect(events(t.dir).map((event) => [event.to, event.round])).toEqual([['running', 2]]);
    expect(new TaskStore(t.dir, t.now).get(active.id)).toMatchObject({ status: 'running', round: 2 });
  });

  it.each(['task-event-totals.json', 'task-events.jsonl'].flatMap((failure) =>
    ['truncated final line', 'changed prefix', 'changed provider', 'changed role', 'changed start', 'changed run', 'legacy changed run'].map((corruption) => ({ failure, corruption }))))(
    'quarantines $corruption with an empty retained snapshot after failed $failure publication', ({ failure, corruption }) => {
      const t = setup();
      const record = t.store.add(task());
      t.store.move(record, 'finished', T0 + 60_000);
      t.at(T0 + 181 * DAY);
      record.lastSeen = t.now();
      io.failPublication = failure;
      t.store.save(true);
      expect(JSON.parse(readFileSync(join(t.dir, 'task-events.jsonl.retention'), 'utf8')).events).toEqual([]);
      const path = join(t.dir, 'task-events.jsonl');
      let source = events(t.dir);
      if (corruption === 'legacy changed run') {
        const legacy = ({ run: _run, ...event }: TaskEvent): TaskEvent => event;
        source = source.map(legacy);
        const markerPath = join(t.dir, 'task-events.jsonl.retention');
        const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
        marker.source = marker.source.map(legacy);
        marker.events = marker.events.map(legacy);
        for (const total of marker.totals as TaskEventTotal[]) for (const run of total.runs) run.event = legacy(run.event);
        writeFileSync(markerPath, JSON.stringify(marker));
      }
      const changed: Partial<TaskEvent> = corruption === 'changed provider' ? { provider: 'demo-other-provider' }
        : corruption === 'changed role' ? { role: 'reviewer' }
        : corruption === 'changed start' ? { startedAt: T0 + 1 } : corruption.endsWith('changed run') ? { run: 9 } : { changedAt: T0 + 1 };
      const raw = corruption === 'truncated final line'
        ? JSON.stringify(source[0]) + '\n' + JSON.stringify(source[1]).slice(0, -12)
        : source.map((event, i) => JSON.stringify(corruption === 'legacy changed run' || i === (corruption === 'changed run' ? 1 : 0) ? { ...event, ...changed } : event) + '\n').join('');
      writeFileSync(path, raw);
      // Ledger repair is available; totals publication continues to fail.
      io.failPublication = 'task-event-totals.json';
      const log = { info: vi.fn(), warn: vi.fn() };
      const reopened = new TaskStore(t.dir, t.now, undefined, log);
      expect(reopened.get(ID)).toMatchObject({ status: 'finished', round: 1, startedAt: T0, changedAt: T0 + 60_000 });
      new TaskHistory(t.dir, t.now, log).recover();
      expect(existsSync(path) ? events(t.dir) : []).toEqual([]);
      const quarantine = readdirSync(t.dir).find((name) => name.startsWith('task-events.jsonl.corrupt-'))!;
      expect(readFileSync(join(t.dir, quarantine), 'utf8')).toBe(raw);
      expect(log.warn).toHaveBeenCalledWith({ file: 'task-events.jsonl' }, 'task log: invalid or unreadable history moved aside');
      const restored = reopened.get(ID)!;
      expect(() => reopened.move(restored, 'running', t.now())).not.toThrow();
      expect(() => reopened.move(restored, 'finished', t.now() + 60_000)).not.toThrow();
      reopened.save(true);
      expect(new TaskStore(t.dir, t.now).get(ID)).toMatchObject({ status: 'finished', round: 2 });
      io.failPublication = '';
      reopened.save(true);
      expect(totals(t.dir)[0]).toMatchObject({ count: 1, stateMs: { running: 60_000 }, requestToDoneMs: 60_000 });
      expect(events(t.dir).map((event) => [event.to, event.round])).toEqual([['running', 2], ['finished', 2]]);
      t.at(T0 + 363 * DAY);
      reopened.save(true);
      expect(events(t.dir)).toEqual([]);
      expect(totals(t.dir).reduce((sum, total) => sum + total.count, 0)).toBe(2);
      expect(totals(t.dir).reduce((sum, total) => sum + total.requestToDoneMs, 0)).toBe(120_000);
      expect(totals(t.dir).reduce((sum, total) => sum + (total.stateMs.running ?? 0), 0)).toBe(120_000);
    },
  );

  it.each(['task-events.jsonl.retention', 'task-event-totals.json', 'task-events.jsonl', 'cleanup'])(
    'keeps later appends through a failed %s publication and restart', (failure) => {
      const t = setup();
      const record = t.store.add(task({ status: 'finished' }));
      t.at(T0 + 181 * DAY);
      record.lastSeen = t.now();
      io.failPublication = failure;
      t.store.save();
      expect(() => t.store.move(record, 'running', t.now())).not.toThrow();
      io.failSync = true;
      expect(() => t.store.move(record, 'needs-approval', t.now() + 60_000)).toThrow('Demo sync failure');
      expect(t.store.get(ID)).toMatchObject({ status: 'running', round: 2 });
      t.store.move(record, 'needs-approval', t.now() + 60_000);
      expect(() => t.store.move(record, 'finished', t.now() + 120_000)).not.toThrow();
      t.store.save(true);
      const reopened = new TaskStore(t.dir, t.now);
      expect(reopened.get(ID)).toMatchObject({ status: 'finished', round: 2 });
      io.failPublication = '';
      reopened.save(true);
      expect(events(t.dir).map((event) => event.to)).toEqual(['running', 'needs-approval', 'finished']);
      expect(totals(t.dir)[0]?.count).toBe(1);
      t.at(T0 + 363 * DAY);
      reopened.save(true);
      expect(events(t.dir)).toEqual([]);
      expect(totals(t.dir).reduce((sum, total) => sum + total.count, 0)).toBe(2);
      expect(totals(t.dir).reduce((sum, total) => sum + total.requestToDoneMs, 0)).toBe(120_000);
      expect(totals(t.dir).reduce((sum, total) => sum + (total.stateMs['needs-approval'] ?? 0), 0)).toBe(60_000);
    },
  );

  it('keeps saved status and telemetry working while totals publication fails, then rolls up once', () => {
    const t = setup();
    const record = t.store.add(task({ status: 'finished' }));
    t.at(T0 + 181 * DAY);
    record.lastSeen = t.now();
    io.failRetention = true;
    t.store.save();
    expect(() => t.store.move(record, 'running', t.now())).not.toThrow();
    expect(() => t.store.move(record, 'finished', t.now() + 60_000)).not.toThrow();
    t.store.save(true);
    const reopened = new TaskStore(t.dir, t.now);
    expect(reopened.get(ID)).toMatchObject({ status: 'finished', round: 2 });
    const resumed = reopened.get(ID)!;
    expect(() => reopened.move(resumed, 'running', t.now() + 120_000)).not.toThrow();
    expect(events(t.dir)).toHaveLength(4);
    io.failRetention = false;
    reopened.save(true);
    expect(events(t.dir).map((event) => event.round)).toEqual([2, 2, 3]);
    expect(totals(t.dir)[0]?.count).toBe(1);
    reopened.move(resumed, 'finished', t.now() + 180_000);
    t.at(T0 + 363 * DAY);
    reopened.save(true);
    expect(events(t.dir)).toEqual([]);
    expect(totals(t.dir).reduce((sum, total) => sum + total.count, 0)).toBe(3);
    expect(totals(t.dir).reduce((sum, total) => sum + total.fixupRounds, 0)).toBe(2);
  });

  it.each([1, 71])('preserves intermediate downtime timing bounds after roll-up and restart (lower hour %i)', (lowerHour) => {
    const t = setup();
    const history = new TaskHistory(t.dir, t.now);
    const hour = DAY / 24;
    history.append(task(), null);
    history.append({ ...task(), status: 'needs-approval', since: T0 + lowerHour * hour, changedAt: T0 + 72 * hour, unseenFrom: T0 + lowerHour * hour }, 'running');
    history.append({ ...task(), status: 'running', since: T0 + 73 * hour, changedAt: T0 + 73 * hour }, 'needs-approval');
    history.append({ ...task(), status: 'finished', since: T0 + 74 * hour, changedAt: T0 + 74 * hour }, 'running');
    t.at(T0 + 185 * DAY);
    history.retain();
    const total = totals(t.dir)[0]!;
    expect(total).toMatchObject({ count: 1, rounds: 1, stateMs: { running: 73 * hour, 'needs-approval': hour }, requestToDoneMs: 74 * hour });
    expect(total).toHaveProperty('stateMsBounds', {
      running: { min: (lowerHour + 1) * hour, max: 73 * hour },
      'needs-approval': { min: hour, max: (73 - lowerHour) * hour },
    });
    expect(total.runs[0]).toHaveProperty('stateMsBounds', total.stateMsBounds);
    const reopened = new TaskHistory(t.dir, t.now);
    reopened.append({ ...task(), status: 'stopped', since: T0 + 186 * DAY, changedAt: T0 + 186 * DAY }, 'finished');
    t.at(T0 + 367 * DAY);
    reopened.retain();
    expect(totals(t.dir)[0]).toMatchObject({ count: 1, stateMsBounds: expect.objectContaining({ 'needs-approval': { min: hour, max: (73 - lowerHour) * hour } }) });
  });

  it('writes task delivery bookkeeping even when retention fails', () => {
    const t = setup();
    const record = t.store.add(task({ status: 'finished' }));
    record.relays.push({ id: 'finished#1', kind: 'update', attempts: 1, deliveredAt: T0 });
    io.failRetention = true;
    t.at(T0 + 181 * DAY);
    record.lastSeen = t.now();
    expect(() => t.store.save()).not.toThrow();
    expect(JSON.parse(readFileSync(join(t.dir, 'tasks.json'), 'utf8')).tasks[0].relays[0].deliveredAt).toBe(T0);
    io.failRetention = false;
    const reopened = new TaskStore(t.dir, t.now);
    reopened.save(true);
    expect(totals(t.dir)[0]?.count).toBe(1);
  });

  it.each(['task-event-totals.json', 'task-events.jsonl.retention'])('quarantines corrupt %s without blocking a save', (name) => {
    const t = setup();
    t.store.add(task({ status: 'finished' }));
    writeFileSync(join(t.dir, name), '{"not":"an array"}');
    t.at(T0 + 181 * DAY);
    const reopened = new TaskStore(t.dir, t.now);
    reopened.recordBridgeStart(ID, 'demo-chat', t.now());
    expect(() => reopened.save()).not.toThrow();
    expect(readdirSync(t.dir).some((file) => file.startsWith(name + '.corrupt-'))).toBe(true);
    expect(JSON.parse(readFileSync(join(t.dir, 'tasks.json'), 'utf8')).bridgeStarts).toHaveLength(1);
  });

  it('compacts at most once a day as hourly events expire', () => {
    const t = setup();
    for (let i = 0; i < 48; i++) t.store.add(task({ id: `deadbeef-0000-0000-0000-${String(i + 1).padStart(12, '0')}`, status: 'finished', since: T0 + i * DAY / 24, changedAt: T0 + i * DAY / 24 }));
    t.at(T0 + 181 * DAY);
    t.store.save();
    expect(io.eventRewrites).toBe(1);
    const reopened = new TaskStore(t.dir, t.now);
    for (let i = 1; i < 24; i++) { t.at(T0 + 181 * DAY + i * DAY / 24); reopened.save(); }
    expect(io.eventRewrites).toBe(1);
    t.at(T0 + 182 * DAY);
    t.store.save();
    expect(io.eventRewrites).toBe(2);
  });

  it('keeps whole rounds across the cutoff and preserves queue, approval, round and completion totals', () => {
    const t = setup();
    const history = new TaskHistory(t.dir, t.now);
    const append = (round: number, status: TaskEvent['to'], from: TaskEvent['from'], offset: number) => history.append({ ...task({ round, startedAt: T0 + (round === 1 ? 0 : 6 * DAY) }), status, since: T0 + offset, changedAt: T0 + offset }, from);
    append(1, 'queued', null, 0);
    append(1, 'running', 'queued', DAY);
    append(1, 'needs-approval', 'running', 2 * DAY);
    append(1, 'running', 'needs-approval', 3 * DAY);
    append(1, 'finished', 'running', 4 * DAY);
    append(1, 'stopped', 'finished', 5 * DAY);
    append(2, 'running', 'stopped', 6 * DAY);
    append(2, 'finished', 'running', 7 * DAY);
    t.at(T0 + 184 * DAY);
    history.retain();
    expect(events(t.dir)).toHaveLength(8);
    t.at(T0 + 186 * DAY);
    history.retain();
    expect(events(t.dir)).toHaveLength(2);
    expect(totals(t.dir)).toEqual([expect.objectContaining({ week: T0, outcome: 'finished', count: 1, rounds: 1, fixupRounds: 0, stateMs: { queued: DAY, running: 2 * DAY, 'needs-approval': DAY, finished: DAY }, requestToDoneMs: 4 * DAY })]);
    t.at(T0 + 188 * DAY);
    history.retain();
    expect(events(t.dir)).toEqual([]);
    expect(totals(t.dir).reduce((sum, total) => sum + total.rounds, 0)).toBe(2);
    expect(totals(t.dir).reduce((sum, total) => sum + total.fixupRounds, 0)).toBe(1);
    expect(totals(t.dir).reduce((sum, total) => sum + total.requestToDoneMs, 0)).toBe(5 * DAY);
    // Archiving a rolled-up run later must not count its outcome again.
    const reopened = new TaskHistory(t.dir, t.now);
    reopened.append({ ...task({ round: 2 }), status: 'stopped', since: T0 + 190 * DAY, changedAt: T0 + 190 * DAY }, 'finished');
    t.at(T0 + 371 * DAY);
    reopened.retain();
    expect(totals(t.dir).reduce((sum, total) => sum + total.count, 0)).toBe(2);
  });

  it('retains old open rounds until they end so their time is recoverable', () => {
    const t = setup();
    const record = t.store.add(task());
    t.at(T0 + 181 * DAY);
    t.store.save();
    expect(events(t.dir)).toHaveLength(1);
    t.store.move(record, 'finished', t.now());
    t.at(T0 + 362 * DAY);
    t.store.save();
    expect(totals(t.dir)[0]).toMatchObject({ count: 1, stateMs: { running: 181 * DAY }, requestToDoneMs: 181 * DAY });
  });
  it('outlives the 14-day task retention and the 500-task limit', () => {
    const t = setup();
    for (let i = 1; i <= 501; i++) {
      t.store.add(task({ id: `deadbeef-0000-0000-0000-${String(i).padStart(12, '0')}`, status: 'finished' }));
    }
    t.store.save();
    expect(t.store.all()).toHaveLength(500);
    expect(events(t.dir)).toHaveLength(501);
    t.at(T0 + 15 * DAY);
    t.store.save();
    expect(t.store.all()).toHaveLength(0);
    expect(events(t.dir)).toHaveLength(501);
    const reopened = new TaskStore(t.dir, t.now);
    reopened.add(task({ status: 'finished', changedAt: t.now() }));
    expect(events(t.dir)).toHaveLength(502);
    expect(reopened.get(ID)).toMatchObject({ changedAt: t.now(), round: 1 });
  });

  it('keeps at least 180 days, then rolls daily into UTC weeks by role, provider and outcome once', () => {
    const t = setup();
    t.store.add(task({ status: 'finished' }));
    t.store.add(task({ id: 'deadbeef-0000-0000-0000-000000000002', status: 'finished' }));
    t.store.add(task({ id: 'deadbeef-0000-0000-0000-000000000003', role: 'reviewer', status: 'failed', changedAt: T0 + 7 * DAY, since: T0 + 7 * DAY }));
    t.store.add(task({ id: 'deadbeef-0000-0000-0000-000000000004', provider: 'demo-other-provider', status: 'stopped', changedAt: T0 + 60_000 }));
    t.at(T0 + 180 * DAY);
    t.store.save();
    expect(events(t.dir)).toHaveLength(4);
    expect(existsSync(join(t.dir, 'task-event-totals.json'))).toBe(false);
    t.at(T0 + 180 * DAY + 1);
    t.store.save();
    expect(events(t.dir)).toHaveLength(4);
    t.at(T0 + 181 * DAY);
    t.store.save();
    expect(events(t.dir)).toHaveLength(1);
    expect(totals(t.dir)).toEqual([
      expect.objectContaining({ week: T0, role: 'worker', provider: 'demo-provider', outcome: 'finished', count: 2, rounds: 2 }),
      expect.objectContaining({ week: T0, role: 'worker', provider: 'demo-other-provider', outcome: 'stopped', count: 1 }),
    ]);
    t.at(T0 + 188 * DAY);
    const reopened = new TaskStore(t.dir, t.now);
    reopened.save();
    reopened.save(true);
    expect(events(t.dir)).toEqual([]);
    expect(totals(t.dir)).toHaveLength(3);
    expect(totals(t.dir)[2]).toMatchObject({ week: T0 + 7 * DAY, role: 'reviewer', provider: 'demo-provider', outcome: 'failed', count: 1 });
    expect(statSync(join(t.dir, 'task-event-totals.json')).mode & 0o777).toBe(0o600);
    expect(totals(t.dir)[0]?.runs.map((run) => run.event.task)).toEqual([ID, 'deadbeef-0000-0000-0000-000000000002']);
    expect(readFileSync(join(t.dir, 'task-event-totals.json'), 'utf8')).not.toMatch(/Demo task|\/home\/me|demo-chat/);
  });

  it.each(['before totals', 'after totals', 'after events'])('recovers a roll-up interrupted %s and keeps later appends without double-counting', (stage) => {
    const t = setup();
    t.store.add(task({ status: 'finished' }));
    const rolled: TaskEventTotal[] = [{
      week: T0, role: 'worker', provider: 'demo-provider', outcome: 'finished', count: 1,
      rounds: 1, fixupRounds: 0, stateMs: {}, requestToDoneMs: 0, rolledAt: T0 + 181 * DAY,
      runs: [{ event: events(t.dir)[0]!, startedAt: T0, doneAt: T0, outcome: 'finished', stateMs: {} }],
    }];
    const pending = { events: [], totals: rolled };
    // Invent each boundary of the retention transaction, without copying any real ledger.
    if (stage !== 'before totals') writeFileSync(join(t.dir, 'task-event-totals.json'), JSON.stringify(rolled));
    if (stage === 'after events') writeFileSync(join(t.dir, 'task-events.jsonl'), '');
    writeFileSync(join(t.dir, 'task-events.jsonl.retention'), JSON.stringify(pending));
    t.at(T0 + 181 * DAY);
    const reopened = new TaskStore(t.dir, t.now);
    reopened.add(task({ id: 'deadbeef-0000-0000-0000-000000000002', changedAt: t.now(), since: t.now(), lastSeen: t.now() }));
    reopened.save();
    expect(events(t.dir)).toHaveLength(1);
    expect(totals(t.dir)).toEqual(rolled);
    expect(existsSync(join(t.dir, 'task-events.jsonl.retention'))).toBe(false);
  });
});
