import { checkDeviceSignal } from '../security/device-signal.js';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChatIdentity } from '../hermes/identity.js';
import type { Logger } from '../hermes/adapter.js';
import { TaskHistory } from './history.js';

// The task log: one record per Paseo worker a Hermes chat started, kept in
// Signalbox's state directory (tasks.json, written whole: temp file + rename).
// It's the durable side of worker updates: what each worker is doing, whether
// the chat that started it has been told, and what's still to be delivered
// after a restart. The shape is the seed of Wayroost's dispatch hub.

const FILE = 'tasks.json';
const MAX_TASKS = 500;
/** Workers that stopped running are kept this long after Signalbox last saw them. */
const KEEP_MS = 14 * 86_400_000;
const BRIDGE_MEMORY_MS = 86_400_000;

/** A Paseo agent id: the only shape tracked, and the only one that goes into a command Signalbox suggests. */
export const WORKER_ID = /^[0-9a-f][0-9a-f-]{7,63}$/i;

export const TASK_STATES = ['running', 'needs-approval', 'finished', 'failed', 'stopped'] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const ENDED: ReadonlySet<TaskState> = new Set(['finished', 'failed', 'stopped']);

export interface RelayRecord {
  /** "finished#2", "needs-approval#1", "overdue#1": one terminal update per worker run. */
  id: string;
  kind: 'update' | 'overdue';
  /** When it was handed to the bridge (the latest time, if it was handed over again). */
  queuedAt?: number;
  deliveredAt?: number;
  /** How many times it was handed to the bridge. */
  attempts: number;
  /** Handovers dropped after permanent send failures; outages, expiry and restarts don't count. */
  failures?: number;
  /** Why it wasn't (or won't be) sent: the switch was off, it went stale, or delivery failed. */
  skipped?: string;
  /** Why delivery is held while the current recipient cannot be resolved. */
  held?: string;
  /** The chat it was handed over to (the per-chat budget counts the recipient). */
  to?: string;
}

export interface TaskRecord {
  /** The Paseo agent's id. */
  id: string;
  provider: string;
  cwd: string;
  title?: string;
  /** The Hermes chat (stored id) that started it, from its signalbox.parent-hermes-chat label. */
  chat: string;
  /** The chat's own records show it launched this worker (or the bridge started it for that chat). */
  verified: boolean;
  via?: 'bridge' | 'terminal';
  launchProof?: 'single-command-v1';
  /** Visible reason when a worker is not linked to the claimed launching chat. */
  linkReason?: string;
  createdAt: number;
  /** When its current run started: its creation, or the follow-up that started this round. */
  startedAt: number;
  dueMinutes: number;
  /** When the current run is due: its start plus the time box. */
  dueAt: number;
  status: TaskState;
  /** 1 for its first run; one more each time it starts running again (a follow-up message). */
  round: number;
  /** The latest the current status can have begun: when Signalbox last saw the one before (its clock). */
  since: number;
  /** When Signalbox noticed the current status: the grace periods count from here. */
  changedAt: number;
  finishedAt?: number;
  /** Its status changed while Signalbox wasn't watching: after this, and by changedAt. */
  unseenFrom?: number;
  relays: RelayRecord[];
  /** Its For-you card, once it was overdue long enough to raise one. */
  feedKey?: string;
  /** Cards from ended rounds whose closure still needs to be saved to the feed. */
  closingFeedKeys?: string[];
  lastSeen: number;
  /** Seen first when it had already stopped, before the task log knew it: nothing to report. */
  baseline?: boolean;
  // Reserved for Wayroost's dispatch hub; never set yet.
  role?: 'manager' | 'coder-lead' | 'worker' | 'reviewer' | 'agent';
  parent_task?: string;
  requested_by_chat?: string;
  criteria?: string[];
  evidence?: string[];
}

interface TaskFile {
  tasks: TaskRecord[];
  /** Trusted launches whose worker might not have reached the adapter yet. */
  bridgeStarts?: Array<{ id: string; chat: string; at: number }>;
  /** When the task log last ran (ms), to tell workers made while Signalbox was down from older ones. */
  aliveAt?: number;
}

export class TaskStore {
  private readonly path: string;
  private file: TaskFile;
  private readonly history: TaskHistory;
  private readonly savedTasks = new Map<string, TaskRecord>();
  private readonly pendingMoves = new Map<string, { from: TaskState; next: TaskRecord }>();
  private baselines: TaskRecord[];
  private dirty = false;

  constructor(
    stateDir: string,
    private readonly now: () => number = Date.now,
    readonly chatIdentity = new ChatIdentity(stateDir),
    private readonly log: Pick<Logger, 'info' | 'warn'> = console,
  ) {
    this.path = join(stateDir, FILE);
    this.history = new TaskHistory(stateDir, now, log);
    this.file = this.load();
    this.baselines = structuredClone(this.file.tasks);
  }

  private load(): TaskFile {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<TaskFile>;
      const tasks = Array.isArray(raw.tasks)
        ? raw.tasks.filter(
            (t): t is TaskRecord =>
              Boolean(t) &&
              typeof t.id === 'string' &&
              WORKER_ID.test(t.id) &&
              typeof t.chat === 'string' &&
              (TASK_STATES as readonly string[]).includes(t.status) &&
              Number.isInteger(t.round) &&
              t.round >= 1 &&
              Number.isInteger(t.dueMinutes) &&
              t.dueMinutes >= 1 &&
              t.dueMinutes <= 1440 &&
              [t.createdAt, t.startedAt, t.dueAt, t.since, t.changedAt, t.lastSeen].every(Number.isFinite) &&
              (t.closingFeedKeys === undefined || (Array.isArray(t.closingFeedKeys) && t.closingFeedKeys.every((key) => typeof key === 'string'))) &&
              Array.isArray(t.relays) &&
              t.relays.every(
                (r) =>
                  r &&
                  typeof r.id === 'string' &&
                  /^(?:finished|failed|stopped|needs-approval|overdue)#\d+$/.test(r.id) &&
                  (r.kind === 'update' || r.kind === 'overdue') &&
                  Number.isInteger(r.attempts) &&
                  r.attempts >= 0 &&
                  (r.failures === undefined || (Number.isInteger(r.failures) && r.failures >= 0)) &&
                  [r.queuedAt, r.deliveredAt].every((at) => at === undefined || Number.isFinite(at)),
              ),
          )
        : [];
      for (const task of tasks) {
        this.savedTasks.set(task.id, structuredClone(task));
        for (const relay of task.relays) {
          // Remove the retired wait-suppression state from older ledgers; delivered news stays deduplicated.
          if (relay.skipped === 'hermes already knew') {
            delete relay.skipped;
            if (relay.deliveredAt === undefined) relay.queuedAt ??= task.changedAt;
            this.dirty = true;
          }
        }
        if (task.verified && task.via === 'terminal' && task.launchProof !== 'single-command-v1') {
          task.verified = false;
          delete task.via;
          task.linkReason = 'Not linked: earlier terminal launch proof must be checked against a single command.';
          this.dirty = true;
        }
      }
      const bridgeStarts = Array.isArray(raw.bridgeStarts)
        ? raw.bridgeStarts.filter((start) => start && typeof start.id === 'string' && WORKER_ID.test(start.id) &&
            typeof start.chat === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(start.chat) && Number.isFinite(start.at))
        : [];
      return { tasks, bridgeStarts, ...(typeof raw.aliveAt === 'number' ? { aliveAt: raw.aliveAt } : {}) };
    } catch {
      return { tasks: [] };
    }
  }

  /** When the task log last ran before this start, if ever. */
  get aliveAt(): number | undefined {
    return this.file.aliveAt;
  }

  get(id: string): TaskRecord | undefined {
    return this.file.tasks.find((t) => t.id === id);
  }

  all(): readonly TaskRecord[] {
    return this.file.tasks;
  }

  bridgeChat(id: string): string | undefined {
    return this.bridgeStarts().find((s) => s.id === id)?.chat;
  }

  /** Recent trusted launches, including workers that never reached the adapter's list. */
  bridgeStarts(): Array<{ id: string; chat: string; at: number }> {
    return (this.file.bridgeStarts ?? []).filter((s) => this.now() - s.at <= BRIDGE_MEMORY_MS);
  }

  recordBridgeStart(id: string, chat: string, at: number): void {
    checkDeviceSignal();
    this.file.bridgeStarts = [...(this.file.bridgeStarts ?? []).filter((s) => s.id !== id), { id, chat, at }];
    this.changed();
  }

  add(task: TaskRecord): TaskRecord {
    checkDeviceSignal();
    this.writeBaselines();
    this.history.append(task, null, true);
    this.file.tasks.push(task);
    this.changed();
    return task;
  }

  /** The single status mutation point: publish metadata before changing the durable record. */
  move(task: TaskRecord, state: TaskState, now: number): void {
    checkDeviceSignal();
    this.writeBaselines();
    const pending = this.pendingMoves.get(task.id);
    if (!pending || pending.from !== task.status || pending.next.status !== state) {
      this.pendingMoves.delete(task.id);
      this.history.baseline(task);
    } else if (!this.history.recorded(pending.next, pending.from)) this.history.baseline(task);
    if (task.status === state) return;
    const next = pending?.from === task.status && pending.next.status === state ? pending.next : { ...task };
    if (next !== pending?.next) {
      if (!ENDED.has(state)) {
        if (ENDED.has(task.status)) {
          next.round += 1;
          next.startedAt = now;
          next.dueAt = now + next.dueMinutes * 60_000;
          delete next.finishedAt;
          delete next.baseline;
          if (next.feedKey) next.closingFeedKeys = [...new Set([...(next.closingFeedKeys ?? []), next.feedKey])];
          delete next.feedKey;
        }
      } else next.finishedAt = now;
      if (now - task.lastSeen > 120_000) next.unseenFrom = task.lastSeen;
      else delete next.unseenFrom;
      next.status = state;
      next.since = Math.min(task.lastSeen, now);
      next.changedAt = now;
      next.lastSeen = now;
    }
    this.pendingMoves.set(task.id, { from: task.status, next });
    this.history.append(next, task.status);
    this.pendingMoves.delete(task.id);
    // Assigning alone would leave optional fields that the new run cleared.
    for (const key of ['finishedAt', 'unseenFrom', 'baseline', 'feedKey'] as const) {
      if (!(key in next)) delete task[key];
    }
    Object.assign(task, next);
    this.changed();
  }

  /** Seed telemetry from saved records only when the primary begins writing. */
  private writeBaselines(): void {
    this.history.recover();
    while (this.baselines.length) {
      this.history.baseline(this.baselines[0]!);
      this.baselines.shift();
    }
  }

  /** Queue acceptance alone is not durable permission to deliver. */
  hasSavedRelay(task: TaskRecord, relay: RelayRecord): boolean {
    const saved = this.savedTasks.get(task.id);
    return saved?.status === task.status && saved.round === task.round &&
      saved.since === task.since && saved.changedAt === task.changedAt &&
      saved.relays.some((record) => record.id === relay.id && record.kind === relay.kind &&
        record.queuedAt !== undefined && record.queuedAt === relay.queuedAt && record.deliveredAt === undefined && !record.skipped);
  }

  /** Something in a record changed in place: written at the next save. */
  changed(): void {
    checkDeviceSignal();
    this.dirty = true;
  }

  /** Write if anything changed, noting the task log ran now. Forgets old records first. */
  save(force = false): void {
    checkDeviceSignal();
    try { this.writeBaselines(); this.history.retain(); }
    catch { checkDeviceSignal(); this.log.warn({}, 'task log: history retention failed; task records will still be saved'); }
    const now = this.now();
    const starts = this.file.bridgeStarts ?? [];
    const keepStarts = starts.filter((s) => now - s.at <= BRIDGE_MEMORY_MS).slice(-MAX_TASKS);
    if (keepStarts.length !== starts.length) {
      this.file.bridgeStarts = keepStarts;
      this.dirty = true;
    }
    const before = this.file.tasks.length;
    let tasks = this.file.tasks.filter((t) => !(t.status !== 'running' && t.status !== 'needs-approval' && now - t.lastSeen > KEEP_MS));
    if (tasks.length > MAX_TASKS) {
      // Keep what still has an update to deliver, then proven workers, then the most recently seen.
      const rank = (t: TaskRecord) =>
        t.relays.some((r) => r.queuedAt && !r.deliveredAt && !r.skipped) ? 2 : t.verified ? 1 : 0;
      tasks = [...tasks].sort((a, b) => rank(b) - rank(a) || b.lastSeen - a.lastSeen).slice(0, MAX_TASKS);
    }
    if (tasks.length !== before) {
      this.file.tasks = tasks;
      this.dirty = true;
    }
    if (!this.dirty && !force) return;
    this.file.aliveAt = now;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.file), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.savedTasks.clear();
    for (const task of this.file.tasks) this.savedTasks.set(task.id, structuredClone(task));
    this.dirty = false;
  }
}
