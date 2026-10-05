import { createHash, randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { operationParamsSchema, MAX_OPERATION_KEYS, keyPathSchema, settingValueSchema } from '../../../shared/settings.js';
import { operationKeys, parseOperation } from '../../../shared/settings-ops.js';
import type { SettingsAuditEntry } from '../settings/audit.js';
import { readJsonBounded } from '../hub/safe-read.js';

const heldSchema = z.object({ exists: z.boolean(), value: settingValueSchema.optional() }).strict();
export const intendedKeySchema = z.object({ path: keyPathSchema, intentId: z.string().regex(/^[a-f0-9]{64}$/).optional(), factId: z.string().max(64).optional(), at: z.number().int().nonnegative().optional(), before: heldSchema, intended: heldSchema }).strict();
export const intentFactSchema = z.object({
  id: z.string().max(64), target: z.string().max(64),
  keys: z.array(intendedKeySchema).max(128),
  operation: z.string().max(64).optional(), params: operationParamsSchema.optional(), undoOf: z.string().max(64).optional(),
  confirmedAt: z.number().int().nonnegative().optional(),
  entrySha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  revoked: z.boolean().optional(),
}).strict();
export type IntendedKey = z.infer<typeof intendedKeySchema>;
export type IntentFact = z.infer<typeof intentFactSchema>;
const revocationSchema = z.object({ entrySha256: z.string().regex(/^[a-f0-9]{64}$/), revokedAt: z.number().int().nonnegative() }).strict();
const checkpointSchema = z.object({ through: z.string().max(64), intended: z.array(intendedKeySchema).max(MAX_OPERATION_KEYS),
  sequence: z.number().int().positive().optional(),
  revocations: z.array(revocationSchema.extend({ factId: z.string().max(64) })).max(64), revocationsIncomplete: z.boolean().optional() }).strict();
const stateSchema = z.object({ version: z.literal(1), facts: z.array(intentFactSchema).max(4096), checkpoint: checkpointSchema.optional() }).strict();
type State = z.infer<typeof stateSchema>;
const intentId = (fact: IntentFact, entry: SettingsAuditEntry, at: number) => createHash('sha256').update(JSON.stringify([fact.id, entry.id, at])).digest('hex');
const MAX_STATE_BYTES = 1024 * 1024;

function revocationActive(fact: IntentFact, facts: ReadonlyMap<string, IntentFact>): boolean {
  let active = true;
  const seen = new Set<string>();
  while (fact.revoked === undefined && fact.undoOf) {
    if (seen.has(fact.id)) throw new Error('unavailable');
    seen.add(fact.id);
    const original = facts.get(fact.undoOf);
    if (!original || original.entrySha256 !== fact.entrySha256) throw new Error('unavailable');
    active = !active;
    fact = original;
  }
  return active === (fact.revoked ?? true);
}

const RESTORABLE_PARAMS: Record<string, readonly string[]> = {
  'hermes.reasoning-effort': ['effort'], 'hermes.personality': ['personality'],
  'hermes.delegation-limits': ['maxConcurrentChildren', 'maxIterations'],
  'hermes.default-model': ['provider', 'model', 'baseUrl'], 'hermes.delegation-model': ['provider', 'model'],
  'hermes.delegation-fallbacks': ['chain'], 'hermes.main-fallbacks': ['chain'], 'hermes.helper-model': ['provider', 'model'],
  'hermes.approval-mode': ['mode'], 'hermes.skill-staging': ['enabled'],
};

/** Compared values live in a private state file; the audit contains names and result codes only. */
export class ChecksState {
  private readonly path: string;
  constructor(stateDir: string) { this.path = join(stateDir, 'settings-checks-state.json'); }

  private async load(): Promise<State> {
    const result = await readJsonBounded(this.path, { maxBytes: MAX_STATE_BYTES, root: dirname(this.path) });
    if ('refused' in result) {
      if (result.reason === 'io-error' && result.code === 'ENOENT') return { version: 1, facts: [] };
      throw new Error('unavailable');
    }
    return stateSchema.parse(result.value);
  }

  /** Persist intent before dispatch; only a confirmed audit result makes it effective. */
  async record(fact: IntentFact, entries: readonly SettingsAuditEntry[] = []): Promise<void> {
    if (!fact.keys.length && !fact.entrySha256) return;
    let state = await this.load();
    if (entries.length && (state.facts.length >= 256 || Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES / 2)) {
      const effective = this.resolve(state, entries);
      const required = new Set([...effective.intended.map(key => key.factId), ...effective.revocations.map(revoke => revoke.factId),
        ...entries.filter(entry => entry.runId && entry.result === 'outcome_unknown').map(entry => entry.id)]);
      const retained = new Set<string>();
      const counts = new Map<string, number>();
      for (const entry of [...entries].reverse()) {
        if (entry.action !== 'apply' || entry.result !== 'ok') continue;
        const count = counts.get(entry.target ?? '') ?? 0;
        if (count < 10) retained.add(entry.id);
        counts.set(entry.target ?? '', count + 1);
      }
      const facts = new Map(state.facts.map(fact => [fact.id, fact]));
      state = { version: 1, checkpoint: { through: entries.at(-1)!.id, intended: effective.intended,
        ...(entries.every(entry => entry.sequence !== undefined) ? { sequence: Math.max(...entries.map(entry => entry.sequence!)) } : {}),
        revocations: effective.revocations.slice(-64), revocationsIncomplete: state.checkpoint?.revocationsIncomplete || effective.revocations.length > 64 },
        facts: state.facts.filter(item => required.has(item.id) || retained.has(item.id)).map(item => item.entrySha256
          ? { ...item, revoked: revocationActive(item, facts) } : item) };
      // Optional undo history is dropped before durable effective state reaches the byte limit.
      while (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES / 2) {
        const removable = state.facts.findIndex(item => !required.has(item.id));
        if (removable < 0) break;
        state.facts.splice(removable, 1);
      }
    }
    state = stateSchema.parse({ ...state, facts: [...state.facts.filter(entry => entry.id !== fact.id), intentFactSchema.parse(fact)] });
    const data = JSON.stringify(state);
    if (Buffer.byteLength(data) > MAX_STATE_BYTES) throw new Error('unavailable');
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
      await rename(temporary, this.path);
      const directory = await open(dirname(this.path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await file.close(); await unlink(temporary).catch(() => {}); }
  }

  async confirm(id: string, at: number): Promise<void> {
    const fact = (await this.load()).facts.find(entry => entry.id === id);
    if (fact) await this.record({ ...fact, confirmedAt: at });
  }

  async confirmUndo(id: string, undoOf: string, at: number, entries: readonly SettingsAuditEntry[]): Promise<void> {
    const facts = new Map((await this.load()).facts.map(fact => [fact.id, fact]));
    const fact = facts.get(undoOf);
    if (!fact) return;
    await this.record({ ...fact, id, undoOf, confirmedAt: at,
      ...(fact.entrySha256 ? { revoked: !revocationActive(fact, facts) } : {}),
      keys: fact.keys.map(key => ({ ...key, before: key.intended, intended: key.before, at })) }, entries);
  }

  private resolve(state: State, entries: readonly SettingsAuditEntry[]): {
    intended: IntendedKey[]; revocations: { entrySha256: string; revokedAt: number; factId: string }[];
  } {
    const facts = new Map(state.facts.map(fact => [fact.id, fact]));
    const intended = new Map((state.checkpoint?.intended ?? []).map(key => [JSON.stringify(key.path), key]));
    const revoked = new Map((state.checkpoint?.revocations ?? []).map(revoke => [revoke.entrySha256, revoke]));
    const through = state.checkpoint ? entries.findIndex(entry => entry.id === state.checkpoint!.through) : -1;
    if (state.checkpoint && through < 0) throw new Error('unavailable');
    const boundary = state.checkpoint?.sequence ?? (state.checkpoint ? entries[through]?.firstSequence : undefined);
    const changes = boundary === undefined ? entries.slice(through + 1).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)) : entries.filter(entry => {
      if (entry.sequence === undefined) throw new Error('unavailable');
      return entry.sequence > boundary;
    }).sort((a, b) => a.sequence! - b.sequence!);
    for (const entry of changes) {
      if (entry.result !== 'ok' || entry.action !== 'apply' && entry.action !== 'undo') continue;
      const recordedUndo = entry.action === 'undo' ? facts.get(entry.id) : undefined;
      const fact = recordedUndo ?? facts.get(entry.action === 'undo' ? entry.undoOf ?? '' : entry.id);
      if (!fact) {
        if (entry.action === 'undo' && entry.target === 'hermes-config' && !entry.operation?.startsWith('gateway.') && entry.operation !== 'hermes.revoke-always'
          || entry.operation === 'hermes.revoke-always') throw new Error('unavailable');
        continue;
      }
      const operation = fact.operation ?? entry.operation;
      const at = recordedUndo?.confirmedAt ?? (entry.action === 'undo' ? entry.at : fact.confirmedAt ?? entry.at);
      if (fact.entrySha256) {
        if (fact.confirmedAt === undefined) throw new Error('unavailable');
        const active = revocationActive(fact, facts);
        if (entry.action === 'undo' && !recordedUndo ? !active : active) {
          revoked.set(fact.entrySha256, { entrySha256: fact.entrySha256, revokedAt: at, factId: fact.id });
        } else revoked.delete(fact.entrySha256);
      }
      if (fact.target !== 'hermes-config') continue;
      for (const key of fact.keys) {
        const held = entry.action === 'undo' && !recordedUndo ? { before: key.intended, intended: key.before } : key;
        intended.set(JSON.stringify(key.path), { path: key.path, before: held.before, intended: held.intended, at,
          factId: fact.id, ...(operation && Object.hasOwn(RESTORABLE_PARAMS, operation) ? { intentId: intentId(fact, entry, at) } : {}) });
      }
    }
    return { intended: [...intended.values()], revocations: [...revoked.values()] };
  }

  async effective(entries: readonly SettingsAuditEntry[]): Promise<{
    intended: IntendedKey[]; revocations: { entrySha256: string; revokedAt: number }[]; revocationsComplete: boolean;
  }> {
    const state = await this.load();
    const result = this.resolve(state, entries);
    const usable = new Set<string>();
    for (const id of new Set(result.intended.flatMap(key => key.intentId ? [key.intentId] : []))) {
      if (this.restoration(state, result.intended.filter(key => key.intentId === id), entries)) usable.add(id);
    }
    const intended = result.intended.map(key => {
      const fact = state.facts.find(fact => fact.id === key.factId);
      const complete = fact?.keys.every(path => result.intended.some(held => held.intentId === key.intentId
        && JSON.stringify(held.path) === JSON.stringify(path.path)));
      if (complete && key.intentId && usable.has(key.intentId)) return key;
      const { intentId: _intentId, ...held } = key;
      return held;
    });
    return { intended, revocationsComplete: !state.checkpoint?.revocationsIncomplete, revocations: result.revocations.map(({ factId: _factId, ...revoke }) => revoke) };
  }

  /** Resolve an opaque id only while every key of that change remains the latest intent. */
  async reapply(id: string, entries: readonly SettingsAuditEntry[]): Promise<{ operation: string; params: Record<string, unknown>; at?: number; paths: IntendedKey['path'][] } | undefined> {
    const state = await this.load();
    const keys = this.resolve(state, entries).intended.filter(key => key.intentId === id);
    return this.restoration(state, keys, entries);
  }

  private restoration(state: State, keys: IntendedKey[], entries: readonly SettingsAuditEntry[]) {
    const fact = state.facts.find(fact => fact.id === keys[0]?.factId);
    if (!fact || !keys.length || keys.length !== fact.keys.length) return undefined;
    const idOperation = fact.operation ?? entries.find(entry => entry.id === fact.id)?.operation;
    if (!idOperation) return undefined;
    const values = fact.keys.map(key => keys.find(held => JSON.stringify(held.path) === JSON.stringify(key.path))?.intended);
    if (values.some(value => !value)) return undefined;
    const names = RESTORABLE_PARAMS[idOperation];
    if (!names || names.length !== values.length) return undefined;
    const params: Record<string, unknown> = { ...fact.params };
    if (idOperation === 'hermes.helper-model') params.task ??= fact.keys[0]?.path[1];
    names.forEach((name, index) => { params[name] = values[index]!.exists ? values[index]!.value
      : idOperation === 'hermes.reasoning-effort' ? null : idOperation === 'hermes.personality' ? '' : undefined; });
    const operation = parseOperation(idOperation, params, 'server');
    if (!operation.ok) return undefined;
    const paths = operationKeys(operation.spec, operation.params);
    if (paths === 'recorded' || JSON.stringify(paths) !== JSON.stringify(fact.keys.map(key => key.path))) return undefined;
    return operation.ok ? { operation: operation.operation, params: operation.params, at: keys[0]!.at, paths: keys.map(key => key.path) } : undefined;
  }
}
