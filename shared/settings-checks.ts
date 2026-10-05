// The Checks page's rows: what Wayroost compared, in plain words, and the one
// change that would put a mismatch right. A row names keys, catalogue ids,
// counts and hashes; never a value read out of a config file, so a row can go to
// any paired device. Every row comes from a check's own comparison of a snapshot,
// and no check writes anything: a Fix button runs the operation it names through
// the settings pipeline, with that operation's level, audit and undo.
import { z } from 'zod';
import { DRAIN_RESTART_COMPONENTS, settingsErrorCodeSchema } from './settings.js';
import { OPERATION_IDS } from './settings-ops.js';

/** ok: as intended. warn: worth a look. fail: something contradicts something else. unknown: couldn't tell. */
export const CHECK_STATES = ['ok', 'warn', 'fail', 'unknown'] as const;
export type CheckState = (typeof CHECK_STATES)[number];
export const checkStateSchema = z.enum(CHECK_STATES);

/** "hermes.drift", "gateway.socket-unit". */
export const CHECK_ID = /^[a-z][a-z0-9-]{0,31}(?:\.[a-z][a-z0-9-]{0,47})+$/;

export const MAX_CHECK_ROWS = 96;
export const MAX_CHECK_DETAILS = 12;

/**
 * Recoveries that aren't a config write: the failed gateway socket unit
 * (`systemctl reset-failed` on both units and a restart of the socket) and the
 * leftover Wayroost drain marker (the supervisor's start-up sweep).
 */
export const CHECK_ACTION_IDS = ['gateway.socket-recover', 'hermes.drain-marker-remove'] as const;

/**
 * What a Fix button runs. `operation`: a catalogue operation through
 * POST /api/settings/apply, with exactly these parameters. `restart`: the
 * restart verb. `action`: one of the two fixed recoveries above.
 */
export const checkFixSchema = z.union([
  z.object({ operation: z.enum(OPERATION_IDS as [string, ...string[]]), params: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ restart: z.object({ component: z.enum(DRAIN_RESTART_COMPONENTS), when: z.enum(['idle', 'now']) }).strict() }).strict(),
  z.object({ action: z.enum(CHECK_ACTION_IDS) }).strict(),
]);
export type CheckFix = z.infer<typeof checkFixSchema>;

export const settingsCheckRowSchema = z.object({
  id: z.string().regex(CHECK_ID),
  state: checkStateSchema,
  /** One plain sentence. It never quotes a value read out of a config file. */
  sentence: z.string().min(1).max(400).refine(text => !/[\r\n]/.test(text), 'one line'),
  /** Key names, catalogue ids, counts and hashes only. */
  details: z.array(z.string().min(1).max(200)).max(MAX_CHECK_DETAILS).optional(),
  fix: checkFixSchema.optional(),
  /** Rows to show first: a revoked entry that came back, for example. */
  priority: z.literal('high').optional(),
}).strict();
export type SettingsCheckRow = z.infer<typeof settingsCheckRowSchema>;

/**
 * GET /api/settings/checks. Every check answers with a row, so a clean page
 * shows rows in the `ok` state and a source that couldn't be read shows `unknown`
 * rows rather than a missing check or a failure.
 */
export const settingsChecksResponseSchema = z.object({
  generatedAt: z.number().int().nonnegative(),
  rows: z.array(settingsCheckRowSchema).max(MAX_CHECK_ROWS),
  /** Why whole sources couldn't be read; fixed codes only, never their messages. */
  unavailable: z.array(settingsErrorCodeSchema).max(8).optional(),
}).strict();
export type SettingsChecksResponse = z.infer<typeof settingsChecksResponseSchema>;

/** Rows the person should see first, then the engine's own order. */
export function sortCheckRows(rows: readonly SettingsCheckRow[], order: readonly string[]): SettingsCheckRow[] {
  const rank = (row: SettingsCheckRow) => order.indexOf(row.id);
  return [...rows].sort((a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1)
    || (rank(a) < 0 ? MAX_CHECK_ROWS : rank(a)) - (rank(b) < 0 ? MAX_CHECK_ROWS : rank(b)));
}
