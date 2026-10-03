import { closeSync, existsSync, fchmodSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Logger } from '../hermes/adapter.js';
import { checkDeviceSignal } from '../security/device-signal.js';
import { ENDED, TASK_STATES, WORKER_ID, type TaskRecord, type TaskState } from './store.js';

const DAY = 86_400_000;
const KEEP_MS = 180 * DAY;
const WEEK = 7 * DAY;
const MONDAY = Date.UTC(1970, 0, 5);
type EventState = TaskState | 'queued';
type StateTimes = Partial<Record<EventState, number>>;
type StateTimeBounds = Partial<Record<EventState, { min: number; max: number }>>;
type HistoryLog = Pick<Logger, 'info' | 'warn'>;

export interface TaskEvent {
  task: string;
  round: number;
  /** Telemetry run number survives task pruning; it never sets the saved round. */
  run?: number;
  role?: TaskRecord['role'];
  provider: string;
  from: EventState | null;
  to: EventState;
  since: number;
  changedAt: number;
  unseenFrom?: number;
  /** Known request/round start, independent of when this status was first observed. */
  startedAt?: number;
}

interface RunTotal {
  event: TaskEvent;
  startedAt: number;
  doneAt: number;
  outcome: TaskState;
  stateMs: StateTimes;
  stateMsBounds?: StateTimeBounds;
}

export interface TaskEventTotal {
  week: number;
  role?: TaskRecord['role'];
  provider: string;
  outcome: TaskState;
  count: number;
  rounds: number;
  fixupRounds: number;
  stateMs: StateTimes;
  /** Bounds preserve missed transitions; absent on legacy totals that discarded uncertainty. */
  stateMsBounds?: StateTimeBounds;
  requestToDoneMs: number;
  rolledAt: number;
  /** Metadata per round keeps later archive lines and re-added workers deduplicated. */
  runs: RunTotal[];
}

interface Compaction {
  events: TaskEvent[];
  totals: TaskEventTotal[];
  /** The input prefix distinguishes later appends from lines already summarized. */
  source?: TaskEvent[];
}

const FIELDS = new Set(['task', 'round', 'run', 'role', 'provider', 'from', 'to', 'since', 'changedAt', 'unseenFrom', 'startedAt']);
const sameEvent = (a: TaskEvent, b: TaskEvent): boolean => [...FIELDS].every((key) => a[key as keyof TaskEvent] === b[key as keyof TaskEvent]);
const TOTAL_FIELDS = new Set(['week', 'role', 'provider', 'outcome', 'count', 'rounds', 'fixupRounds', 'stateMs', 'stateMsBounds', 'requestToDoneMs', 'rolledAt', 'runs']);
const RUN_FIELDS = new Set(['event', 'startedAt', 'doneAt', 'outcome', 'stateMs', 'stateMsBounds']);
const ROLES = ['manager', 'coder-lead', 'worker', 'reviewer', 'agent'];
const PROVIDER_ID = /^[A-Za-z0-9._:/-]{1,64}$(?![\s\S])/;
const state = (value: unknown): value is EventState => value === 'queued' || TASK_STATES.includes(value as TaskState);
const role = (value: unknown): boolean => value === undefined || ROLES.includes(value as string);
const provider = (value: string): string => PROVIDER_ID.test(value) ? value : 'other';
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const elapsed = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const runKey = (event: TaskEvent): string => JSON.stringify([event.task, event.run ?? event.round]);
const observationKey = (event: TaskEvent): string => JSON.stringify([event.task, event.round, event.to, event.since, event.changedAt]);
const newerRun = (event: TaskEvent, previous?: TaskEvent): boolean => previous === undefined ||
  (event.run ?? event.round) > (previous.run ?? previous.round) ||
  ((event.run ?? event.round) === (previous.run ?? previous.round) && event.changedAt >= previous.changedAt);

function validEvent(value: TaskEvent): boolean {
  return object(value) && Object.keys(value).every((key) => FIELDS.has(key)) &&
    typeof value.task === 'string' && WORKER_ID.test(value.task) &&
    Number.isSafeInteger(value.round) && value.round >= 1 && role(value.role) &&
    (value.run === undefined || (Number.isSafeInteger(value.run) && value.run >= 1)) &&
    typeof value.provider === 'string' && PROVIDER_ID.test(value.provider) &&
    (value.from === null || state(value.from)) && state(value.to) &&
    Number.isFinite(value.since) && Number.isFinite(value.changedAt) &&
    (value.unseenFrom === undefined || Number.isFinite(value.unseenFrom)) &&
    (value.startedAt === undefined || Number.isFinite(value.startedAt));
}

function eventMetadata(value: TaskEvent): TaskEvent {
  if (object(value) && typeof value.provider === 'string') value.provider = provider(value.provider);
  if (!validEvent(value)) throw new Error('Invalid task history metadata');
  return value;
}

function taskEvent(task: Pick<TaskRecord, 'id' | 'round' | 'role' | 'provider' | 'since' | 'changedAt' | 'unseenFrom'> & { status: EventState; startedAt?: number }, from: EventState | null): TaskEvent {
  return eventMetadata({
    task: task.id, round: task.round, provider: task.provider, from, to: task.status,
    since: task.since, changedAt: task.changedAt,
    ...(task.role === undefined ? {} : { role: task.role }),
    ...(task.unseenFrom === undefined ? {} : { unseenFrom: task.unseenFrom }),
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
  });
}

function validTimes(value: StateTimes): boolean {
  return object(value) && Object.entries(value).every(([key, ms]) => state(key) && elapsed(ms));
}

function validBounds(value: StateTimeBounds | undefined): boolean {
  return value === undefined || (object(value) && Object.entries(value).every(([key, bounds]) =>
    state(key) && object(bounds) && Object.keys(bounds).every((key) => key === 'min' || key === 'max') &&
    elapsed(bounds.min) && elapsed(bounds.max) && bounds.min <= bounds.max));
}

function totalsMetadata(value: TaskEventTotal[]): TaskEventTotal[] {
  if (!Array.isArray(value)) throw new Error('Invalid task history totals metadata');
  for (const total of value) {
    if (!object(total) || !Object.keys(total).every((key) => TOTAL_FIELDS.has(key)) ||
        !Number.isFinite(total.week) || !role(total.role) || typeof total.provider !== 'string' ||
        !ENDED.has(total.outcome) || !Number.isSafeInteger(total.count) || total.count < 0 ||
        total.rounds !== total.count || !Number.isSafeInteger(total.fixupRounds) || total.fixupRounds < 0 ||
        !validTimes(total.stateMs) || !validBounds(total.stateMsBounds) || !elapsed(total.requestToDoneMs) || !Number.isFinite(total.rolledAt) ||
        !Array.isArray(total.runs) || total.runs.length !== total.count) {
      throw new Error('Invalid task history totals metadata');
    }
    total.provider = provider(total.provider);
    for (const run of total.runs) {
      if (!object(run) || !Object.keys(run).every((key) => RUN_FIELDS.has(key)) ||
          !Number.isFinite(run.startedAt) || !Number.isFinite(run.doneAt) || !ENDED.has(run.outcome) || !validTimes(run.stateMs) || !validBounds(run.stateMsBounds)) {
        throw new Error('Invalid task history round metadata');
      }
      run.event = eventMetadata(run.event);
    }
  }
  return value;
}

function read(path: string): string {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(dirname(path), 'r');
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

function replace(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  syncDirectory(path);
}

function addTime(times: StateTimes, state: EventState, ms: number): void {
  if (ms > 0) times[state] = (times[state] ?? 0) + ms;
}

function addBounds(times: StateTimeBounds, state: EventState, min: number, max: number): void {
  if (max <= 0) return;
  const previous = times[state];
  times[state] = { min: (previous?.min ?? 0) + Math.max(0, min), max: (previous?.max ?? 0) + max };
}

function boundsOf(run: RunTotal): StateTimeBounds | undefined {
  return run.stateMsBounds === undefined ? undefined : Object.fromEntries(
    Object.entries(run.stateMsBounds).map(([state, bounds]) => [state, { ...bounds }]));
}

const lower = (event: TaskEvent): number => Math.min(event.since, event.unseenFrom ?? event.since, event.changedAt);
const sameObservation = (a: TaskEvent, b: TaskEvent): boolean =>
  a.task === b.task && a.round === b.round && a.to === b.to && a.since === b.since && a.changedAt === b.changedAt;

function observations(events: TaskEvent[]): TaskEvent[] {
  const timeline: TaskEvent[] = [];
  for (const event of events) {
    // Reconciliation can repeat a follow-up from an older saved round.
    if (event.from !== null && ENDED.has(event.from as TaskState) && !ENDED.has(event.to as TaskState)) timeline.length = 0;
    if (event.from === null) {
      const saved = timeline.findLastIndex((previous) => sameObservation(previous, event));
      if (saved >= 0) {
        // Restore the saved observation and discard its unsaved successors.
        timeline.length = saved + 1;
        continue;
      }
      while (timeline.length && timeline.at(-1)!.changedAt >= event.changedAt) timeline.pop();
    }
    timeline.push(event);
  }
  return timeline;
}

function summarize(events: TaskEvent[], previous?: RunTotal): RunTotal {
  // A quarantined marker can leave both published totals and their original lines.
  if (previous) events = events.slice(events.findLastIndex((event) => sameEvent(event, previous.event)) + 1);
  if (!events.length) return previous!;
  const tail = events.at(-1)!;
  events = observations(events);
  const first = events[0]!;
  const startedAt = previous?.startedAt ?? first.startedAt ?? (first.from !== null && ENDED.has(first.from as TaskState) ? first.changedAt : first.since);
  const run: RunTotal = previous ? { ...previous, stateMs: { ...previous.stateMs }, stateMsBounds: boundsOf(previous) } : {
    event: first, startedAt, doneAt: first.changedAt, outcome: 'stopped', stateMs: {}, stateMsBounds: {},
  };
  let last = previous?.event;
  for (const [i, event] of events.entries()) {
    const repeatedEnding = event.from === null && last && ENDED.has(last.to as TaskState) && ENDED.has(event.to as TaskState);
    // Baselines describe saved observations, not elapsed time in a missing segment.
    if (event.from === null) last = undefined;
    if (last) {
      addTime(run.stateMs, last.to, event.changedAt - last.changedAt);
      if (run.stateMsBounds) addBounds(run.stateMsBounds, last.to, lower(event) - last.changedAt, event.changedAt - lower(last));
    } else if (!repeatedEnding) {
      const duration = event.changedAt - Math.max(startedAt, lower(event));
      addTime(run.stateMs, event.to, duration);
      // A following transition already includes this initial uncertainty window.
      if (run.stateMsBounds && (i === events.length - 1 || events[i + 1]!.from === null)) {
        addBounds(run.stateMsBounds, event.to, 0, duration);
      }
    }
    // Closing or archiving an already ended round does not replace its result.
    if (!repeatedEnding && ENDED.has(event.to as TaskState) && (event.to !== 'stopped' || run.outcome === 'stopped')) {
      run.outcome = event.to as TaskState;
      run.doneAt = event.changedAt;
    }
    last = event;
  }
  run.event = tail;
  return run;
}

function weeklyTotals(runs: Iterable<RunTotal>, now: number): TaskEventTotal[] {
  const totals = new Map<string, TaskEventTotal>();
  for (const run of runs) {
    const event = run.event;
    const week = MONDAY + Math.floor((run.doneAt - MONDAY) / WEEK) * WEEK;
    const key = JSON.stringify([week, event.role, event.provider, run.outcome]);
    const total = totals.get(key) ?? {
      week, ...(event.role === undefined ? {} : { role: event.role }), provider: event.provider,
      outcome: run.outcome, count: 0, rounds: 0, fixupRounds: 0, stateMs: {}, stateMsBounds: {}, requestToDoneMs: 0, rolledAt: now, runs: [],
    };
    total.count++;
    total.rounds++;
    if ((event.run ?? event.round) > 1) total.fixupRounds++;
    for (const [state, ms] of Object.entries(run.stateMs)) addTime(total.stateMs, state as EventState, ms);
    if (run.stateMsBounds === undefined) delete total.stateMsBounds;
    else if (total.stateMsBounds) {
      for (const [state, bounds] of Object.entries(run.stateMsBounds)) addBounds(total.stateMsBounds, state as EventState, bounds.min, bounds.max);
    }
    total.requestToDoneMs += Math.max(0, run.doneAt - run.startedAt);
    total.runs.push(run);
    totals.set(key, total);
  }
  return [...totals.values()];
}

/** Metadata only. Appends are durable before status changes; compaction is the sole rewrite. */
export class TaskHistory {
  private readonly path: string;
  private readonly totalsPath: string;
  private readonly compactPath: string;
  private readonly latest = new Map<string, TaskEvent>();
  private readonly observations = new Map<string, TaskEvent>();
  private readonly runs = new Map<string, number>();
  private maintainedAt: number | undefined;
  private missingNewline = false;
  private appendFailed = false;
  private initialized = false;
  private unavailable = false;
  private pending: Compaction | undefined;

  constructor(stateDir: string, private readonly now: () => number = Date.now, private readonly log: HistoryLog = console) {
    this.path = join(stateDir, 'task-events.jsonl');
    this.totalsPath = join(stateDir, 'task-event-totals.json');
    this.compactPath = `${this.path}.retention`;
    this.load(false);
  }

  private quarantine(path: string): void {
    if (!statSync(path).isFile()) throw new Error('Task history is not a regular file');
    let target = `${path}.corrupt-${this.now()}`;
    for (let i = 1; existsSync(target); i++) target = `${path}.corrupt-${this.now()}-${i}`;
    renameSync(path, target);
    syncDirectory(path);
    if (path === this.path) {
      this.latest.clear();
      this.observations.clear();
      this.runs.clear();
      this.missingNewline = false;
    }
    this.log.warn({ file: basename(path) }, 'task log: invalid or unreadable history moved aside');
  }

  private metadata<T>(path: string, parse: (raw: string) => T, empty: T, repair = true): T {
    try {
      const raw = read(path);
      return raw ? parse(raw) : empty;
    } catch {
      if (!repair) throw new Error('Task history requires recovery');
      this.quarantine(path);
      return empty;
    }
  }

  private totals(repair = true): TaskEventTotal[] {
    return this.metadata(this.totalsPath, (raw) => totalsMetadata(JSON.parse(raw) as TaskEventTotal[]), [], repair);
  }

  private load(repair = true): void {
    try {
      this.pending = this.metadata<Compaction | undefined>(this.compactPath, (raw) => {
        const compact = JSON.parse(raw) as Compaction;
        if (!object(compact) || Object.keys(compact).some((key) => key !== 'events' && key !== 'totals' && key !== 'source') ||
            !Array.isArray(compact.events) || (compact.source !== undefined && !Array.isArray(compact.source))) {
          throw new Error('Invalid task history retention metadata');
        }
        return { events: compact.events.map(eventMetadata), totals: totalsMetadata(compact.totals),
          ...(compact.source === undefined ? {} : { source: compact.source.map(eventMetadata) }) };
      }, undefined, repair);
      const totals = this.pending?.totals ?? this.totals(repair);
      const events = this.events(repair);
      if (this.pending && repair) this.mergeAppends(events);
      this.restoreIndexes(this.pending?.events ?? events, totals);
      this.unavailable = false;
      this.initialized = repair;
    } catch {
      // Storage may be unavailable. Reads and tasks.json still work; appends must retry first.
      this.unavailable = true;
      this.log.warn({}, 'task log: history unavailable; status changes wait for storage');
    }
  }

  last(task: string): TaskEvent | undefined {
    return this.latest.get(task);
  }

  /** Retry storage failures before appending more telemetry. */
  recover(): void {
    checkDeviceSignal();
    if (!this.initialized || this.unavailable) this.load();
    if (this.unavailable) throw new Error('Task history unavailable');
    if (this.appendFailed) this.recoverAppend();
  }

  private recoverAppend(): void {
    const events = this.events();
    const fd = openSync(this.path, 'a', 0o600);
    try { fchmodSync(fd, 0o600); fsyncSync(fd); }
    finally { closeSync(fd); }
    syncDirectory(this.path);
    if (this.pending) this.mergeAppends(events);
    this.restoreIndexes(this.pending?.events ?? events, this.pending?.totals ?? this.totals());
    this.appendFailed = false;
  }

  private restoreIndexes(events: TaskEvent[], totals: TaskEventTotal[]): void {
    this.latest.clear();
    this.observations.clear();
    this.runs.clear();
    for (const total of totals) {
      this.maintainedAt = Math.max(this.maintainedAt ?? -Infinity, total.rolledAt);
      for (const run of total.runs) {
        this.observations.set(observationKey(run.event), run.event);
        this.runs.set(run.event.task, Math.max(this.runs.get(run.event.task) ?? 0, run.event.run ?? run.event.round));
        if (newerRun(run.event, this.latest.get(run.event.task))) {
          this.remember(run.event);
        }
      }
    }
    for (const event of events) this.remember(event);
  }

  private remember(event: TaskEvent): void {
    this.latest.set(event.task, event);
    this.observations.set(observationKey(event), event);
    this.runs.set(event.task, Math.max(this.runs.get(event.task) ?? 0, event.run ?? event.round));
  }

  /** A missing or contradictory telemetry tail never changes the saved record. */
  baseline(task: TaskRecord): void {
    checkDeviceSignal();
    this.recover();
    const last = this.latest.get(task.id);
    if (last?.round === task.round && last.to === task.status && last.since === task.since && last.changedAt === task.changedAt) return;
    this.append(task, null);
  }

  /** A complete failed-sync append can be retried without rewinding its baseline. */
  recorded(task: TaskRecord, from: TaskState): boolean {
    const last = this.latest.get(task.id);
    return last !== undefined && sameEvent(last, { ...taskEvent(task, from), ...(last.run === undefined ? {} : { run: last.run }) });
  }

  private event(task: Parameters<typeof taskEvent>[0], from: EventState | null, firstSighting: boolean): TaskEvent {
    const event = taskEvent(task, from);
    const last = this.latest.get(task.id);
    const repeated = last && sameEvent(last, { ...event, ...(last.run === undefined ? {} : { run: last.run }) });
    if (repeated) return last;
    let run: number;
    if (firstSighting) {
      // Rediscovering an ended worker observes its last run; a resumed worker starts another.
      run = last && ENDED.has(last.to as TaskState) && ENDED.has(event.to as TaskState)
        ? last.run ?? last.round : (this.runs.get(task.id) ?? 0) + 1;
    } else if (from === null) {
      // Saved observations may rewind unsaved successors, including follow-up attempts.
      const saved = this.observations.get(observationKey(event));
      run = saved?.run ?? saved?.round ?? last?.run ?? last?.round ?? task.round;
    } else {
      run = last?.run ?? last?.round ?? task.round;
      if (ENDED.has(from as TaskState) && !ENDED.has(event.to as TaskState)) run++;
    }
    return eventMetadata({ ...event, run });
  }

  /** Never serialize the record itself: only these fields can reach the history. */
  append(task: Parameters<typeof taskEvent>[0], from: EventState | null, firstSighting = false): void {
    checkDeviceSignal();
    this.recover();
    const event = this.event(task, from, firstSighting);
    const last = this.latest.get(event.task);
    if (last && sameEvent(last, event)) return;
    try {
      const created = !existsSync(this.path);
      const fd = openSync(this.path, 'a', 0o600);
      try {
        fchmodSync(fd, 0o600);
        writeFileSync(fd, `${this.missingNewline ? '\n' : ''}${JSON.stringify(event)}\n`);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      if (created) syncDirectory(this.path);
    } catch (error) {
      // A complete line may have reached disk before sync failed. Re-read it before any retry.
      this.appendFailed = true;
      throw error;
    }
    this.missingNewline = false;
    this.remember(event);
  }

  /** Daily. Keep incomplete rounds intact; completed rounds become weekly counts and times. */
  retain(): void {
    checkDeviceSignal();
    this.recover();
    this.finishCompaction();
    const now = this.now();
    if (this.maintainedAt !== undefined && now - this.maintainedAt >= 0 && now - this.maintainedAt < DAY) return;
    const events = this.events();
    const groups = new Map<string, TaskEvent[]>();
    for (const event of events) {
      const key = runKey(event);
      const group = groups.get(key) ?? [];
      group.push(event);
      groups.set(key, group);
    }
    const old = new Map([...groups].filter(([, group]) => {
      const last = group.at(-1)!;
      return ENDED.has(last.to as TaskState) && group.every((event) => event.changedAt < now - KEEP_MS);
    }));
    if (old.size) {
      const runs = new Map(this.totals().flatMap((total) => total.runs.map((run) => [runKey(run.event), run] as const)));
      for (const [key, group] of old) runs.set(key, summarize(group, runs.get(key)));
      this.pending = { source: events, events: events.filter((event) => !old.has(runKey(event))), totals: weeklyTotals(runs.values(), now) };
      this.finishCompaction();
    }
    this.maintainedAt = now;
  }

  private finishCompaction(): void {
    if (!this.pending) return;
    this.mergeAppends(this.events());
    // Publish the marker first on every retry, including a failed marker-directory sync.
    replace(this.compactPath, JSON.stringify(this.pending));
    replace(this.totalsPath, JSON.stringify(this.pending.totals));
    replace(this.path, this.pending.events.map((event) => `${JSON.stringify(event)}\n`).join(''));
    unlinkSync(this.compactPath);
    syncDirectory(this.compactPath);
    this.restoreIndexes(this.pending.events, this.pending.totals);
    this.pending = undefined;
    this.missingNewline = false;
  }

  private mergeAppends(events: TaskEvent[]): void {
    const compact = this.pending!;
    if (!events.length && !existsSync(this.path) && compact.events.length) {
      // Quarantine can remove the input ledger. Its retained snapshot is still valid.
      replace(this.path, compact.events.map((event) => `${JSON.stringify(event)}\n`).join(''));
      events = compact.events;
    }
    const prefix = (before: TaskEvent[]): boolean => before.length <= events.length && before.every((event, i) => sameEvent(event, events[i]!));
    if (compact.source === undefined) {
      // Older retention markers have no input prefix. Remove only run prefixes whose
      // final archived event is still present, then retain any later observations.
      const archived = new Map(compact.totals.flatMap((total) => total.runs.map((run) => [runKey(run.event), run.event] as const)));
      const through = new Map<string, number>();
      events.forEach((event, i) => { const last = archived.get(runKey(event)); if (last && sameEvent(event, last)) through.set(runKey(event), i); });
      compact.events = events.filter((event, i) => i > (through.get(runKey(event)) ?? -1));
    } else {
      const before = [compact.source, compact.events].filter((before) => prefix(before) && this.validAppends(events.slice(before.length)))
        .sort((a, b) => b.length - a.length)[0];
      if (!before) {
        this.quarantine(this.path);
        replace(this.path, compact.events.map((event) => `${JSON.stringify(event)}\n`).join(''));
        this.missingNewline = false;
        events = compact.events;
      } else compact.events = [...compact.events, ...events.slice(before.length)];
    }
    compact.source = events;
  }

  private validAppends(events: TaskEvent[]): boolean {
    // An empty retained snapshot matches any prefix, including damaged source lines.
    // Rewinds must match known saved observations; ordinary appends follow known rounds.
    const latest = new Map<string, TaskEvent>();
    const known = [...(this.pending!.source ?? []), ...this.pending!.events,
      ...this.pending!.totals.flatMap((total) => total.runs.map((run) => run.event))];
    for (const total of this.pending!.totals) {
      for (const run of total.runs) {
        const previous = latest.get(run.event.task);
        if (newerRun(run.event, previous)) {
          latest.set(run.event.task, run.event);
        }
      }
    }
    for (const event of this.pending!.events) latest.set(event.task, event);
    for (const event of events) {
      const previous = latest.get(event.task);
      if (previous) {
        if (event.from === null && ((event.changedAt >= previous.changedAt && (event.run ?? event.round) >= (previous.run ?? previous.round)) ||
            known.some((saved) => sameEvent({ ...saved, from: null, startedAt: saved.startedAt ?? event.startedAt,
              run: saved.run ?? (event.run === undefined ? undefined : saved.round) }, event)))) {
          latest.set(event.task, event);
          continue;
        }
        const round = previous.round + Number(ENDED.has(previous.to as TaskState) && !ENDED.has(event.to as TaskState));
        const run = (previous.run ?? previous.round) + Number(ENDED.has(previous.to as TaskState) && !ENDED.has(event.to as TaskState));
        if (event.from !== previous.to || event.to === previous.to || event.round !== round || (event.run ?? event.round) !== run) return false;
      } else if (event.from !== null) return false;
      latest.set(event.task, event);
    }
    return true;
  }

  private events(repair = true): TaskEvent[] {
    this.missingNewline = false;
    return this.metadata(this.path, (raw) => {
      const lines = raw.split('\n');
      const events: TaskEvent[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line && i === lines.length - 1) break;
        events.push(eventMetadata(JSON.parse(line) as TaskEvent));
        if (i === lines.length - 1) this.missingNewline = true;
      }
      return events;
    }, [], repair);
  }
}
