import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { TaskRecord } from './store.js';

const Epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Round = z.number().int().positive();
const Pending = z.object({ id: z.string(), round: Round, messageId: z.string().min(1).optional(),
  epoch: Epoch.optional(), acknowledged: z.boolean() });
const SavedRound = z.object({ id: z.string(), round: Round, epoch: Epoch, hash: z.string().optional(), messageId: z.string().optional() });
const State = z.object({ identityVersion: z.literal(1).optional(), rounds: z.array(SavedRound), pending: z.array(Pending),
  unavailable: z.boolean().default(false), unavailableTasks: z.array(z.string()).optional() });
type PendingAdmission = z.infer<typeof Pending> & { revision?: unknown; observed?: boolean; confirmed?: boolean; awaitingRun?: boolean };
const ended = (task: TaskRecord) => ['finished', 'failed', 'stopped'].includes(task.status);

export interface CompletionEvidence {
  messages: Array<{ id?: string; turnId?: string }>;
  completed: boolean;
  completionTurnId?: string;
  subsequentTurnIds?: Array<string | undefined>;
}

function receivedBy(evidence: CompletionEvidence | undefined, messageId: string): boolean {
  if (!evidence) return false;
  const last = evidence.messages.at(-1);
  return !!last?.turnId && last.id === messageId && evidence.messages.filter((row) => row.id === messageId).length === 1 &&
    evidence.completionTurnId === last.turnId && evidence.subsequentTurnIds !== undefined &&
    evidence.subsequentTurnIds.every((turnId) => turnId === last.turnId);
}

/** Admission evidence is independent of task tracking, time boxes and delivery records. */
export class TaskAdmissions {
  private readonly path: string;
  private rounds: Array<z.infer<typeof SavedRound>> = [];
  private readonly verified = new Map<string, unknown>();
  private pending: PendingAdmission[] = [];
  private unavailable = false;
  private unavailableTasks: Set<string> | undefined = new Set();
  private persistedIds = new Set<string>();

  constructor(stateDir: string) {
    this.path = join(stateDir, 'task-admissions.json');
    try {
      const state = State.parse(JSON.parse(readFileSync(this.path, 'utf8')));
      this.rounds = state.rounds.filter((entry) => !entry.hash);
      // Older follow-up records inferred identity from text and cannot prove admission.
      if (!state.identityVersion) this.rounds = this.rounds.filter((entry) => !entry.messageId);
      this.unavailable = state.unavailable;
      this.unavailableTasks = state.unavailable && !state.unavailableTasks ? undefined : new Set(state.unavailableTasks);
      this.persistedIds = new Set([...state.rounds, ...state.pending].map((entry) => entry.id));
      // An interrupted submission cannot prove permission for a later round.
      this.pending = state.pending.map(({ epoch: _epoch, messageId, ...record }) => ({
        ...record, ...(state.identityVersion && messageId ? { messageId } : {}),
      }));
      for (const entry of state.rounds.filter((entry) => !this.rounds.includes(entry))) {
        this.pending.push({ id: entry.id, round: entry.round, acknowledged: true });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.unavailable = true;
        this.unavailableTasks = undefined;
      }
    }
  }

  epoch(task: TaskRecord, revision?: unknown): number | undefined {
    if (this.unavailable) return undefined;
    const record = this.rounds.find((entry) => entry.id === task.id && entry.round === task.round);
    if (revision === undefined || this.verified.get(task.id) !== revision) return undefined;
    return record?.epoch;
  }

  needsReconciliation(): boolean {
    return this.rounds.length > 0 || this.pending.length > 0 || this.unavailable;
  }

  /** A cached epoch cannot authorize a held relay without current receiving-run evidence. */
  async relayEpoch(task: TaskRecord,
    read: (id: string) => Promise<CompletionEvidence | undefined>,
    getRevision: () => unknown): Promise<number | undefined> {
    const revision = getRevision();
    const epoch = this.epoch(task, revision);
    const record = this.rounds.find((entry) => entry.id === task.id && entry.round === task.round);
    if (epoch === undefined || !record?.messageId) return undefined;
    const { round, status, changedAt } = task;
    try {
      const evidence = await read(task.id);
      if (getRevision() !== revision || this.epoch(task, revision) !== epoch || !this.rounds.includes(record) ||
          task.round !== round || task.status !== status || task.changedAt !== changedAt) return undefined;
      if (evidence?.completed && receivedBy(evidence, record.messageId)) return epoch;
    } catch {
      // Unavailable or incomplete history cannot establish admission.
    }
    return undefined;
  }

  started(id: string, epoch: number | undefined, messageId?: string, _revision?: unknown): void {
    this.rounds = this.rounds.filter((entry) => entry.id !== id);
    // An acknowledgment can arrive after another run has replaced the launch.
    this.verified.delete(id);
    if (epoch !== undefined) {
      this.rounds.push({ id, round: 1, epoch, ...(messageId ? { messageId } : {}) });
    }
    this.save();
  }

  sending(task: TaskRecord, epoch: number | undefined, _envelope: string, revision: unknown) {
    const record: PendingAdmission = { id: task.id, round: task.round + (ended(task) ? 1 : 0),
      acknowledged: false, revision, awaitingRun: !ended(task),
      ...(epoch !== undefined ? { epoch } : {}) };
    // Several unresolved sends to one worker cannot establish which round received one.
    if (this.pending.some((entry) => entry.id === task.id)) {
      delete record.epoch;
      for (const entry of this.pending.filter((entry) => entry.id === task.id)) delete entry.epoch;
    }
    this.pending.push(record);
    this.save();
    return {
      acknowledged: (messageId?: string) => {
        record.acknowledged = true;
        if (messageId) record.messageId = messageId;
        else delete record.epoch;
        this.observe(task, revision, false);
        this.save();
      },
      failed: () => { this.pending = this.pending.filter((entry) => entry !== record); this.save(); },
    };
  }

  observe(task: TaskRecord, revision: unknown, observed = true): void {
    let changed = false;
    const previous = this.rounds.find((entry) => entry.id === task.id);
    if (previous && previous.round !== task.round) {
      this.rounds = this.rounds.filter((entry) => entry !== previous);
      this.verified.delete(task.id);
      changed = true;
    }
    for (const record of this.pending.filter((entry) => entry.id === task.id)) {
      if (record.revision === undefined || record.revision !== revision) {
        if (record.epoch !== undefined) changed = true;
        delete record.epoch;
        delete record.confirmed;
      }
      if (record.awaitingRun && observed && task.round > record.round && !ended(task)) delete record.awaitingRun;
      if (!record.awaitingRun && observed && task.round >= record.round && !ended(task) && !record.observed) {
        record.observed = true;
        delete record.confirmed;
      }
      if (task.round < record.round || !record.acknowledged || !record.observed || !record.confirmed) continue;
      this.rounds = this.rounds.filter((entry) => entry.id !== task.id);
      if (task.round === record.round && record.epoch !== undefined) {
        this.rounds.push({ id: task.id, round: task.round, epoch: record.epoch, messageId: record.messageId });
        this.verified.set(task.id, revision);
      }
      delete record.epoch;
      delete record.confirmed;
      changed = true;
    }
    if (changed) this.save();
  }

  /** Ledger retention bounds side records without reading a worker. */
  forgetMissing(task: (id: string) => TaskRecord | undefined): void {
    const gone = new Set([...this.rounds, ...this.pending].filter((record) => !task(record.id)).map((record) => record.id));
    if (!gone.size) {
      if (this.unavailable) this.save();
      return;
    }
    this.rounds = this.rounds.filter((record) => !gone.has(record.id));
    this.pending = this.pending.filter((record) => !gone.has(record.id));
    for (const id of gone) { this.verified.delete(id); this.unavailableTasks?.delete(id); }
    this.save();
  }

  async reconcile(read: (id: string) => Promise<CompletionEvidence | undefined>,
    task: (id: string) => TaskRecord | undefined, getRevision: () => unknown,
    reconciled: (id: string) => boolean = () => true, drained: (task: TaskRecord) => boolean = () => false): Promise<void> {
    this.forgetMissing(task);
    const revision = getRevision();
    const current = () => getRevision() === revision;
    const revoke = () => {
      for (const record of this.pending) {
        delete record.epoch;
        delete record.revision;
        delete record.confirmed;
      }
      this.verified.clear();
      this.save();
    };
    let changed = false;
    for (const record of this.pending) {
      if (record.revision === undefined || record.revision !== revision) {
        if (record.epoch !== undefined) changed = true;
        delete record.epoch;
        delete record.confirmed;
      }
    }
    this.rounds = this.rounds.filter((record) => {
      const currentTask = task(record.id);
      if (currentTask && !drained(currentTask) && (record.messageId || revision !== undefined && this.verified.get(record.id) === revision)) return true;
      this.verified.delete(record.id);
      changed = true;
      return false;
    });
    if (changed) this.save();
    for (const record of this.rounds.filter((entry) => entry.messageId && this.verified.get(entry.id) !== revision)) {
      try {
        const evidence = await read(record.id);
        if (!current()) { revoke(); return; }
        if (!evidence) continue;
        if (receivedBy(evidence, record.messageId!) && revision !== undefined) this.verified.set(record.id, revision);
        else {
          this.rounds = this.rounds.filter((entry) => entry !== record);
          this.verified.delete(record.id);
          this.save();
        }
      } catch {
        if (!current()) { revoke(); return; }
        // Reconnected activity must establish its message identity again.
      }
    }
    for (const record of [...this.pending]) {
      if (!record.acknowledged || !reconciled(record.id)) continue;
      try {
        const observed = record.observed === true;
        const evidence = await read(record.id);
        if (!current()) { revoke(); return; }
        if (!this.pending.includes(record)) continue;
        if (evidence?.completed) {
          // Only a read begun after acknowledgment can retire a completed submission.
          this.pending = this.pending.filter((entry) => entry !== record);
          this.save();
          continue;
        }
        if (!record.messageId || record.epoch === undefined || !evidence?.messages.length) continue;
        const matched = receivedBy(evidence, record.messageId);
        if (!matched) { delete record.epoch; this.save(); continue; }
        record.confirmed = observed;
        const currentTask = task(record.id);
        if (currentTask) this.observe(currentTask, revision, false);
      } catch {
        if (!current()) { revoke(); return; }
        // Missing evidence keeps quiet false without affecting task tracking.
      }
    }
    for (const id of this.unavailableTasks ?? []) {
      const currentTask = task(id);
      if ((!currentTask || ended(currentTask)) && reconciled(id)) this.unavailableTasks!.delete(id);
    }
    if (this.unavailable && this.unavailableTasks) this.save();
  }

  quiet(revision?: unknown): { ids: string[]; reasons: string[] } {
    const restored = this.rounds.filter((entry) => revision === undefined || this.verified.get(entry.id) !== revision);
    return { ids: [...new Set([...this.pending, ...restored].map((entry) => entry.id))], reasons: [
      ...(this.unavailable ? ['followups_unavailable'] : []), ...(this.pending.length || restored.length ? ['followups_unreconciled'] : []),
    ] };
  }

  private save(): void {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const unavailable = this.unavailable && (!this.unavailableTasks || this.unavailableTasks.size > 0);
    const ids = new Set([...this.rounds, ...this.pending].map((entry) => entry.id));
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ identityVersion: 1, unavailable,
          ...(this.unavailableTasks ? { unavailableTasks: [...this.unavailableTasks] } : {}),
          rounds: this.rounds, pending: this.pending.map(({ revision: _revision, observed: _observed, confirmed: _confirmed, awaitingRun: _awaitingRun, ...entry }) => entry) }));
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temp, this.path);
      const dir = openSync(dirname(this.path), 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
      this.unavailable = unavailable;
      this.persistedIds = ids;
    } catch {
      this.storageFailed(ids);
    } finally {
      try { rmSync(temp, { force: true }); } catch { this.storageFailed(ids); }
    }
  }

  private storageFailed(ids: Set<string>): void {
    this.unavailable = true;
    for (const id of [...ids, ...this.persistedIds]) this.unavailableTasks?.add(id);
    this.rounds = [];
    this.verified.clear();
    for (const record of this.pending) delete record.epoch;
  }
}
