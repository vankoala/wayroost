import { lstatSync } from 'node:fs';
import { z } from 'zod';
import { EventJournal } from '../hub/journal.js';
import { settingsAuditRecordSchema, timingSchema, undoTokenSchema, CHANGE_ID, RECENT_CHANGES,
  type Timing, type UndoToken } from '../../../shared/settings.js';
import { operationSpec } from '../../../shared/settings-ops.js';

const recordSchema = settingsAuditRecordSchema;
const entrySchema = recordSchema.extend({ notes: timingSchema, undoOf: z.string().regex(CHANGE_ID).optional() }).strict();
const startSchema = entrySchema.omit({ result: true }).extend({ requestId: z.uuid({ version: 'v4' }).optional() }).strip();
export type SettingsAuditEntry = z.infer<typeof entrySchema> & { firstSequence?: number; sequence?: number };
export type SettingsWriteRecord = z.infer<typeof recordSchema>;
export class SettingsAuditError extends Error { constructor() { super('audit_unavailable'); } }

/** A separate journal keeps settings writable only while its durable chain verifies. */
export class SettingsAudit {
  private journal?: EventJournal;
  private identity?: { dev: number; ino: number };
  private failed = false;
  private readonly active = new Set<string>();

  constructor(stateDir: string, now: () => number = Date.now) {
    try {
      this.journal = new EventJournal(stateDir, now, 'settings-audit.jsonl');
      this.identity = lstatSync(this.journal.path);
      this.verify();
    } catch {
      this.failed = true;
      this.journal?.close();
    }
  }

  verify(): void {
    if (this.failed || !this.journal) throw new SettingsAuditError();
    try {
      const stat = lstatSync(this.journal.path);
      if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== this.identity?.dev || stat.ino !== this.identity.ino) throw new Error('audit_unavailable');
      for (const event of this.journal.load()) {
        if (event.type === 'settings-write-start') startSchema.parse(event.data);
        if (event.type === 'settings-change') entrySchema.parse(event.data);
      }
    } catch {
      this.failed = true;
      throw new SettingsAuditError();
    }
  }

  event(type: string, data: object): void {
    this.verify();
    try { this.journal!.append({ type, data: JSON.parse(JSON.stringify(data)) }); }
    catch { this.failed = true; throw new SettingsAuditError(); }
  }

  start(record: SettingsWriteRecord, notes: Timing, undoOf?: string, requestId?: string): void {
    const { result: _result, ...metadata } = recordSchema.parse(record);
    this.event('settings-write-start', startSchema.parse({ ...metadata, notes, ...(undoOf ? { undoOf } : {}), ...(requestId ? { requestId } : {}) }));
    this.active.add(record.id);
  }

  record(record: SettingsWriteRecord, notes: Timing, undoOf?: string): void {
    const { firstSequence: _firstSequence, sequence: _sequence, ...metadata } = record as SettingsAuditEntry;
    this.event('settings-change', entrySchema.parse({ ...metadata, notes, ...(undoOf ? { undoOf } : {}) }));
    this.active.delete(record.id);
  }

  entries(): SettingsAuditEntry[] {
    this.verify();
    const entries = new Map<string, SettingsAuditEntry>();
    for (const event of this.journal!.byType('settings-change')) {
      const entry = entrySchema.parse(event.data);
      entries.set(entry.id, { ...entry, firstSequence: entries.get(entry.id)?.firstSequence ?? event.seq, sequence: event.seq });
    }
    return [...entries.values()];
  }

  unresolved() {
    const entries = new Map(this.entries().map(entry => [entry.id, entry]));
    return this.journal!.byType('settings-write-start').map(event => startSchema.parse(event.data)).flatMap(start => {
      const entry = entries.get(start.id);
      if (this.active.has(start.id) || entry && (entry.result !== 'outcome_unknown'
        || entry.observed === 'supervisor' || entry.observed === 'resolved-by-user')) return [];
      return [{ ...start, ...(entry ?? { result: 'outcome_unknown' as const }) }];
    });
  }

  requestId(change: string): string | undefined {
    this.verify();
    return this.journal!.byType('settings-write-start').map(event => startSchema.parse(event.data)).find(start => start.id === change)?.requestId;
  }

  recent(): SettingsAuditEntry[] {
    return this.entries().filter(entry => entry.action === 'apply' || entry.action === 'undo')
      .sort((a, b) => a.sequence! - b.sequence!).slice(-RECENT_CHANGES).reverse();
  }

  token(change: string): { entry: SettingsAuditEntry; token: UndoToken } | undefined {
    const entries = this.entries();
    const entry = entries.find(record => record.id === change);
    if (!entry?.operation || !entry.target || !entry.backupId || !entry.backupSha256 || !entry.writtenSha256
      || entries.some(record => record.undoOf === change)
      || this.journal!.byType('settings-write-start').some(event => startSchema.parse(event.data).undoOf === change)) return undefined;
    const spec = operationSpec(entry.operation);
    if (!spec || !spec.callers.includes('server')) return undefined;
    return { entry, token: undoTokenSchema.parse({ operation: entry.operation, target: entry.target,
      backupId: entry.backupId, backupSha256: entry.backupSha256, writtenSha256: entry.writtenSha256 }) };
  }

  close(): void { this.journal?.close(); }
}
