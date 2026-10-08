// The settings pages' read side and wording: what the section endpoint returns,
// how to find a value in it, how to say a level or a timing label in plain
// words, and what each fixed error code means to the person who sees it. A
// value this device may not see arrives as a digest of itself; pages say the
// value is shown on the PC, never the digest.
import { z } from 'zod';
import { rolloutSchema, type Rollout } from '../../shared/rollout.js';
import { drainRestartRunSchema, settingsRestartResponseSchema, type CredentialTestResult, type UsageSummaryResult } from '../../shared/supervisor-config.js';
import { READ_VIEW_IDS } from '../../shared/settings-ops.js';
import { commandAllowlist } from '../../shared/command-allowlist.js';
import { formatKeyPath, keyPathSchema, recentChangeSchema, settingValueSchema, settingsApplyResponseSchema, settingsErrorCodeSchema, settingsSectionSchema, timingSchema, type RecentChange, type SettingValue, type SettingsApplyResponse, type SettingsErrorCode, type SettingsLevel, type SettingsSection, type Timing, type TimingSurface } from '../../shared/settings.js';

export type { RecentChange } from '../../shared/settings.js';

/** What a row allows on this device: straight through, with a confirm step, or shown only. */
export type RowAccess = 'editable' | 'confirm' | 'read-only';

/** One projected value as it arrives from the server. */
export interface ReadViewEntry {
  path: (string | number | { id: string })[];
  exists: boolean;
  value?: SettingValue;
}

/** One view's answer: its values, or a fixed code. A missing file says present: false. */
export interface SettingsViewResult {
  ok: boolean;
  view?: string;
  present?: boolean;
  effective?: true;
  sha256?: string;
  values?: ReadViewEntry[];
  order?: { path: (string | number)[]; names: string[] }[];
  code?: SettingsErrorCode;
}

/** One catalogue operation as the section endpoint describes it to this device. */
export interface SettingsOperationInfo {
  operation: string;
  title: string;
  access: RowAccess;
  /** For a level that follows one parameter: the access each of its values gets. */
  accessByValue?: Record<string, RowAccess>;
  writer?: 'pipeline' | 'legacy';
}

/** GET /api/settings/sections/<section>. */
export interface SettingsSectionPayload {
  section: SettingsSection;
  rollout?: Rollout;
  restartWhenIdleCertified?: boolean;
  legacyRoutesViaPipeline?: boolean;
  restartRuns?: z.infer<typeof drainRestartRunSchema>[];
  views?: SettingsViewResult[];
  operations?: SettingsOperationInfo[];
  changes?: RecentChange[];
  backendChoices?: { id: string; label: string; currentRoles: string[] }[];
  profiles?: { id: string; label: string; model?: string }[];
  personalities?: { id: string; label: string }[];
  allowlistEntries?: { entrySha256: string }[];
  modelStatus?: { role: string; health: 'up' | 'down' | 'unmapped' | 'owner_mismatch' | 'unknown'; inFlight: number }[];
  roleLoads?: { role: string; harness: string; words: number; tokens: number; targetWords: number | null; budgetWords: number | null; parts: { shared: number; dispatch: number; role: number; skills: number } }[];
  agentAvailability?: { id: string; installed: boolean | null; authenticated: boolean | null }[];
}

const rowAccessSchema = z.enum(['editable', 'confirm', 'read-only']);
const countSchema = z.number().int().nonnegative();
const sectionPayloadSchema = z.object({
  section: settingsSectionSchema,
  rollout: rolloutSchema.optional(),
  restartWhenIdleCertified: z.boolean().optional(),
  legacyRoutesViaPipeline: z.boolean().optional(),
  restartRuns: z.array(drainRestartRunSchema).optional(),
  views: z.array(z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true), view: z.enum(READ_VIEW_IDS), present: z.boolean(),
      effective: z.literal(true).optional(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      values: z.array(z.object({ path: keyPathSchema, exists: z.boolean(), value: settingValueSchema.optional() })).optional(),
      order: z.array(z.object({ path: keyPathSchema, names: z.array(z.string()) })).optional(),
    }).refine(view => view.present ? view.sha256 !== undefined && view.values !== undefined
      : view.sha256 === undefined && (!view.values?.length || view.effective === true) && view.order === undefined),
    z.object({ ok: z.literal(false), view: z.enum(READ_VIEW_IDS), code: settingsErrorCodeSchema }),
  ])).optional(),
  operations: z.array(z.object({ operation: z.string(), title: z.string(), access: rowAccessSchema,
    accessByValue: z.record(z.string(), rowAccessSchema).optional(), writer: z.enum(['pipeline', 'legacy']).optional() })).optional(),
  changes: z.array(recentChangeSchema).optional(),
  backendChoices: z.array(z.object({ id: z.string(), label: z.string(), currentRoles: z.array(z.string()) })).optional(),
  profiles: z.array(z.object({ id: z.string(), label: z.string(), model: z.string().optional() })).optional(),
  personalities: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  allowlistEntries: z.array(z.object({ entrySha256: z.string().regex(/^[a-f0-9]{64}$/) })).optional(),
  modelStatus: z.array(z.object({ role: z.string(), health: z.enum(['up', 'down', 'unmapped', 'owner_mismatch', 'unknown']), inFlight: countSchema })).optional(),
  roleLoads: z.array(z.object({ role: z.string(), harness: z.string(), words: countSchema, tokens: countSchema,
    targetWords: countSchema.nullable(), budgetWords: countSchema.nullable(),
    parts: z.object({ shared: countSchema, dispatch: countSchema, role: countSchema, skills: countSchema }) })).optional(),
  agentAvailability: z.array(z.object({ id: z.string(), installed: z.boolean().nullable(), authenticated: z.boolean().nullable() })).optional(),
}).refine(payload => payload.section === 'overview' ? payload.changes !== undefined : payload.views !== undefined && payload.operations !== undefined);

/** Failed reads and malformed bodies must never look like an empty section. */
export function isSettingsSectionPayload(value: unknown, section: SettingsSection): value is SettingsSectionPayload {
  const result = sectionPayloadSchema.safeParse(value);
  return result.success && result.data.section === section;
}

/** A route's fixed-code refusal, outside the apply response. */
export interface SettingsRefusal {
  status: 'refused';
  code: SettingsErrorCode;
}

/** GET /api/settings/usage. */
export type SettingsUsagePayload = UsageSummaryResult | SettingsRefusal;

/** A restart reports its tracked run, or asks for confirmation before starting it. */
export { settingsRestartResponseSchema };
export type SettingsRestartPayload = z.infer<typeof settingsRestartResponseSchema>;

/** The credential routes: the key is never echoed back, only the timing and, for a test, its result. */
export type SettingsCredentialPayload =
  | { status: 'applied'; timing: Timing; test?: CredentialTestResult }
  | { status: 'refused'; code: SettingsErrorCode | Extract<CredentialTestResult, { ok: false }>['code']; test?: CredentialTestResult };

/** What a row's current value looks like to this device. */
export type RowValue =
  | { kind: 'value'; value: SettingValue }
  /** The key isn't in the file: the consumer's own default applies. */
  | { kind: 'absent' }
  /** The value exists but this device may not see it: it arrived as a digest. */
  | { kind: 'hidden' }
  /** The file or the read itself didn't answer. */
  | { kind: 'no-data'; code?: SettingsErrorCode };

export function isRedactedValue(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as { sha256?: unknown }).sha256 === 'string'
    && /^[a-f0-9]{64}$/.test((value as { sha256: string }).sha256)
    && typeof (value as { length?: unknown }).length === 'number';
}

/** One view's entries by their formatted path, plus whether the view answered at all. */
export function viewEntries(payload: SettingsSectionPayload | undefined, view: string): { entries: Map<string, ReadViewEntry>; failed: boolean; absent: boolean } {
  const result = payload?.views?.find((candidate) => candidate.view === view);
  if (!result || !result.ok) return { entries: new Map(), failed: true, absent: false };
  if (!result.present && !result.effective) return { entries: new Map(), failed: false, absent: true };
  return { entries: new Map((result.values ?? []).map((entry) => [formatKeyPath(entry.path), entry])), failed: false, absent: false };
}

/** The value at one key of one view, in the shape this device was allowed to see. */
export function rowValue(payload: SettingsSectionPayload | undefined, view: string, key: string): RowValue {
  const { entries, failed, absent } = viewEntries(payload, view);
  if (failed) return { kind: 'no-data', code: payload?.views?.find((candidate) => candidate.view === view)?.code };
  if (absent) return { kind: 'absent' };
  const entry = entries.get(key);
  if (!entry || !entry.exists) return { kind: 'absent' };
  if (entry.value === undefined || isRedactedValue(entry.value)) return { kind: 'hidden' };
  return { kind: 'value', value: entry.value };
}

/** Managed keys override the user file; an unreadable overlay leaves the effective value unknown. */
export function hermesSetting(payload: SettingsSectionPayload | undefined, view: string, key: string, managedPayload: SettingsSectionPayload | undefined) {
  const managed = rowValue(managedPayload, 'hermes.managed', key);
  const pinned = managed.kind === 'hidden' || managed.kind === 'value';
  const overlayUnavailable = managed.kind === 'no-data' && managed.code !== 'not_configured' && managed.code !== 'target_missing';
  // Unpinned revocations edit saved text; pinned commands use the effective safety view.
  const editingAllowlist = !pinned && view === 'hermes.safety' && key === 'command_allowlist'
    && payload?.views?.find(result => result.view === view)?.effective === true;
  let value: RowValue = overlayUnavailable ? { kind: 'no-data' } : rowValue(payload, editingAllowlist ? 'hermes.allowlist' : view, key);
  if (pinned && value.kind === 'absent') value = { kind: 'no-data' };
  if (view === 'hermes.safety' && key === 'command_allowlist' && value.kind === 'value') {
    const list = commandAllowlist(value.value);
    value = list ? { kind: 'value', value: list } : { kind: 'no-data' };
  }
  const unavailable = value.kind === 'hidden' || value.kind === 'no-data';
  return { value, pinned, unavailable, overlayUnavailable };
}

/** The entry names under one view's prefix (dynamic entries), in the file's order when the view gives one. */
export function rowNames(payload: SettingsSectionPayload | undefined, view: string, prefix: string): string[] {
  const { entries } = viewEntries(payload, view);
  const names: string[] = [];
  for (const key of entries.keys()) {
    if (!key.startsWith(`${prefix}.`)) continue;
    const name = key.slice(prefix.length + 1).split('.')[0] ?? '';
    if (name && !names.includes(name)) names.push(name);
  }
  const ordered = payload?.views?.find((candidate) => candidate.view === view)?.order?.find((entry) => entry.path.join('.') === prefix);
  return ordered ? [...ordered.names.filter((name) => names.includes(name)), ...names.filter((name) => !ordered.names.includes(name))] : names;
}

/** A dynamic entry's name as this device sees it; a phone gets an opaque identity instead. */
export function isOpaqueName(name: string): boolean {
  return name.startsWith('sha256:');
}

export function settingAsText(value: RowValue, fallback = ''): string {
  if (value.kind !== 'value') return fallback;
  if (typeof value.value === 'string') return value.value;
  if (value.value === null || typeof value.value !== 'object') return String(value.value);
  return fallback;
}

export function settingAsNumber(value: RowValue): number | null {
  return value.kind === 'value' && typeof value.value === 'number' ? value.value : null;
}

export function settingAsBoolean(value: RowValue): boolean | null {
  return value.kind === 'value' && typeof value.value === 'boolean' ? value.value : null;
}

/** A string array a view holds, entry by entry; 'hidden' when it arrived as one digest. */
export function settingAsStringList(value: RowValue): string[] | 'hidden' {
  if (value.kind === 'hidden' || value.kind === 'no-data') return 'hidden';
  if (value.kind !== 'value' || !Array.isArray(value.value)) return [];
  return value.value.filter((entry): entry is string => typeof entry === 'string');
}

// ---- Wording ---------------------------------------------------------------

export const LEVEL_LABEL: Record<SettingsLevel, string> = {
  anywhere: 'Any device',
  confirm: 'Confirm',
  'pc-only': 'PC only',
};

export const LEVEL_TIP: Record<SettingsLevel, string> = {
  anywhere: 'Any paired device can change this.',
  confirm: 'From a phone this asks for a one-time code first.',
  'pc-only': 'Only the paired desktop app on this PC can change this.',
};

const SURFACE_LABEL: Record<TimingSurface, string> = {
  messaging: 'WhatsApp',
  api: 'phone',
  'app-chats': 'app chats',
  jobs: 'jobs',
  'pi-agents': 'new agents',
};

const COMPONENT_LABEL: Record<string, string> = {
  hermes: "Hermes' gateway",
  dashboard: 'the app-chat service',
  gateway: 'the model gateway',
  paseo: 'Paseo',
  'phone-bridge': 'the phone bridge',
};

/** The change takes effect this way, with each surface named when they differ. */
export function timingSentence(timing: Timing): string {
  const notePhrase = (note: Timing[number]): string => {
    const condition = note.when === 'model-or-provider-changed' ? ' when the model or provider changes'
      : note.when === 'base-url-only' ? ' when only the address changes' : '';
    const label = labelPhrase(note.label) + condition;
    return note.surface ? `${SURFACE_LABEL[note.surface]}: ${label}` : label;
  };
  const parts = [...new Set(timing.map(notePhrase))];
  const body = parts.length === 1 && !timing[0]?.surface ? `Takes effect ${parts[0]}.` : `Takes effect \u2014 ${parts.join(' \u00b7 ')}.`;
  const extras: string[] = [];
  if (timing.some((note) => note.refresh === 'next-always-answer')) extras.push('the gateway also picks it up the next time a chat answers \u201calways\u201d');
  if (timing.some((note) => note.refresh === 'next-app-chat-build')) extras.push('app chats reload the list when one starts or resumes');
  if (timing.some((note) => note.sessionApproval === 'until-session-ends')) extras.push('a chat that answered \u201calways\u201d keeps it until that chat ends');
  return extras.length ? `${body} ${extras.join('; ')}.` : body;
}

function labelPhrase(label: Timing[number]['label']): string {
  if (label === 'now') return 'now';
  if (label === 'next-turn') return 'the next message';
  if (label === 'next-chat') return 'the next chat';
  if (label === 'next-run') return 'the next run';
  if (label === 'not-used') return 'not used there';
  const [kind, component] = label.split(':');
  const name = COMPONENT_LABEL[component ?? ''] ?? component;
  if (kind === 'restart-when-idle') return `after a required restart of ${name}`;
  if (kind === 'restart-now') return `the next restart of ${name}, which you time`;
  return label;
}

/** The same words again in the result of a change. */
export function changeToastText(change: { timing: Timing; effective: string; lasts?: string; reloadOpenPages?: boolean; restartRequired?: { runId?: string; code?: SettingsErrorCode } }): string {
  const parts = [`Applied. ${timingSentence(change.timing)}`];
  if (change.restartRequired?.runId) parts.push('A tracked restart has been scheduled.');
  else if (change.timing.some(note => note.label.startsWith('restart-when-idle:'))) parts.push('No restart has been scheduled.');
  if (change.effective === 'pending') parts.push('Some processes pick it up later.');
  if (change.effective === 'mismatch') parts.push('A check after the write saw something else.');
  if (change.lasts === 'until-next-switch') parts.push('In place until the next model switch.');
  if (change.reloadOpenPages) parts.push('Reload any open Hermes settings page: one save there puts back every old value.');
  return parts.join(' ');
}

/** What each fixed code means, in the words a page says. Upstream messages are never shown. */
export const SETTINGS_ERROR_TEXT: Record<SettingsErrorCode, string> = {
  not_rolled_out: 'Settings writes have not been enabled on this site.',
  shadow_read_only: 'This server is a shadow; it reads settings and changes nothing.',
  audit_unavailable: "The change journal can't be written, so settings changes are stopped. Chats keep working.",
  outcome_unknown: 'The outcome is unknown. Check Recent changes or use Checks on this PC to accept the current file as is.',
  config_writes_off: 'Settings writes are switched off on this PC.',
  not_configured: 'This PC has no such setting set up yet.',
  unknown_operation: "This change is not in the settings catalogue.",
  invalid_parameters: 'That value is not valid for this change.',
  not_permitted: 'This device may not make this change.',
  confirm_required: 'This change needs confirming.',
  confirm_invalid: 'That confirmation is used or expired. Ask again.',
  pc_only: 'This setting can only be changed on the PC itself.',
  pc_only_read_only: "PC-only settings are read-only until this PC's own local listener is confirmed.",
  precondition_changed: 'The current value changed since this page showed it. Reload and try again.',
  parse_failed: "The settings file can't be parsed; nothing was written.",
  target_missing: 'The settings file is missing.',
  unsafe_target: "The settings file is not a plain file owned as expected; nothing was written.",
  unsafe_directory: 'A folder on the way to the settings file is writable by someone else.',
  locked: 'The settings file is busy right now; try again.',
  consumer_refused: "The consumer's own checks refused this change; nothing was written.",
  contract_mismatch: "That backend falls outside the role's contract.",
  verify_mismatch: 'The change was written but did not verify as intended.',
  undo_changed: 'The file changed since that change; undo is offered as a new change instead.',
  backup_mismatch: "The backup does not match its record; nothing was restored.",
  busy: 'A restart for that part is already running.',
  still_busy: 'It never went quiet in time; a restart you time is offered instead.',
  foreign_drain: 'Someone else is draining it; Wayroost left it alone.',
  marker_lost: 'The drain changed hands; the restart stopped.',
  drain_not_engaged: 'The drain did not start; the process may be hung.',
  restart_unverified: 'The restart finished but did not verify.',
  unavailable: 'This PC did not answer. Try again.',
  timeout: 'The change took too long; check Recent changes before trying again.',
  failed: 'The change failed.',
};

export function settingsErrorText(code: string | undefined): string {
  return code && Object.hasOwn(SETTINGS_ERROR_TEXT, code) ? SETTINGS_ERROR_TEXT[code as SettingsErrorCode] : SETTINGS_ERROR_TEXT.failed;
}

/** A settings response turned into what a page does next. */
export type ApplyOutcome =
  | { kind: 'legacy-applied' }
  | { kind: 'applied'; change: Extract<SettingsApplyResponse, { status: 'applied' }>['change'] }
  | { kind: 'confirm'; code: string; summary: string; expiresAt: number }
  | { kind: 'refused'; code: SettingsErrorCode; message: string; change?: Extract<SettingsApplyResponse, { status: 'refused' }>['change']; backupId?: string | null };

export function describeApplyResponse(response: SettingsApplyResponse): ApplyOutcome {
  if (response.status === 'applied') return { kind: 'applied', change: response.change };
  if (response.status === 'confirm') return { kind: 'confirm', code: response.confirm, summary: response.summary, expiresAt: response.expiresAt };
  return { kind: 'refused', code: response.code, message: settingsErrorText(response.code),
    ...(response.change ? { change: response.change } : {}), ...(response.backupId !== undefined ? { backupId: response.backupId } : {}) };
}

/** A response body that failed on the transport: the same outcome shape. */
export function failedOutcome(error: unknown): ApplyOutcome {
  return { kind: 'refused', code: 'unavailable', message: error instanceof Error && error.message ? error.message : settingsErrorText('unavailable') };
}

// ---- Small formats -----------------------------------------------------------

export function formatCount(n: number): string {
  if (n < 10_000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

export function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** The entry's UTF-8 text hashed here: a revoke request carries only the hash. */
export async function entrySha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Keys for the row: what a change touched, as short chips (the names only). */
export function keyChips(keys: readonly string[], max = 3): string[] {
  return keys.length <= max ? [...keys] : [...keys.slice(0, max - 1), `+${keys.length - (max - 1)}`];
}
