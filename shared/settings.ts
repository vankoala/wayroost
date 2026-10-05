// Settings, as the pages, the server and the supervisor all name them: sections
// and levels, when a change takes effect, the fixed error codes, the values an
// operation may carry, and the settings API's requests and results. Audit
// records and events carry key names, ids and hashes; never a value.
import { z } from 'zod';
import { DEVICE_KINDS, FEED_SOURCES, SOURCES } from './protocol.js';

/** Shared by write and read key expansion, preconditions, results and audits; checked before a write. */
export const MAX_OPERATION_KEYS = 2048;

// ---- Sections and levels -----------------------------------------------------

export const SETTINGS_SECTIONS = ['overview', 'agents', 'models', 'safety', 'notifications', 'checks'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export const settingsSectionSchema = z.enum(SETTINGS_SECTIONS);

/**
 * Who may make a change: any paired device; a phone only with a one-time
 * confirm code; or only the paired desktop app on the PC. The rules are in
 * settings-levels.ts.
 */
export const SETTINGS_LEVELS = ['anywhere', 'confirm', 'pc-only'] as const;
export type SettingsLevel = (typeof SETTINGS_LEVELS)[number];
export const settingsLevelSchema = z.enum(SETTINGS_LEVELS);

// ---- When a change takes effect ----------------------------------------------

/**
 * What a change may wait for. `hermes` is Hermes' messaging gateway (WhatsApp,
 * calls and its API), `dashboard` the app chats' Hermes, `gateway` the model
 * gateway, `phone-bridge` the phone line's model bridge.
 */
export const RESTART_COMPONENTS = ['hermes', 'dashboard', 'gateway', 'paseo', 'phone-bridge'] as const;
export type RestartComponent = (typeof RESTART_COMPONENTS)[number];

/**
 * The one vocabulary for timing. `restart-when-idle:<component>` waits for a
 * quiet moment, which Wayroost finds itself; `restart-now:<component>` is a
 * restart you time, and it may cut whatever is running.
 */
export type TimingLabel =
  | 'now'
  | 'next-turn'
  | 'next-chat'
  | 'next-run'
  | 'not-used'
  | `restart-when-idle:${RestartComponent}`
  | `restart-now:${RestartComponent}`;
export const TIMING_LABELS: readonly TimingLabel[] = [
  'now', 'next-turn', 'next-chat', 'next-run', 'not-used',
  ...RESTART_COMPONENTS.map(component => `restart-when-idle:${component}` as const),
  ...RESTART_COMPONENTS.map(component => `restart-now:${component}` as const),
];
export const timingLabelSchema = z.enum(TIMING_LABELS as [TimingLabel, ...TimingLabel[]]);

/**
 * Where a label applies when one change reaches places at different times:
 * `messaging` is WhatsApp and other gateway messages; `api` includes calls;
 * `app-chats` the app's Hermes chats; `jobs` scheduled runs; `pi-agents` new pi agents.
 */
export const TIMING_SURFACES = ['messaging', 'api', 'app-chats', 'jobs', 'pi-agents'] as const;
export type TimingSurface = (typeof TIMING_SURFACES)[number];

export const timingNoteSchema = z.object({
  label: timingLabelSchema,
  surface: z.enum(TIMING_SURFACES).optional(),
  /** Key names when only part of an operation has this timing. */
  keys: z.array(z.string().min(1).max(512)).min(1).max(MAX_OPERATION_KEYS).optional(),
  /** A process refresh or an existing session can affect when a revoke applies. */
  refresh: z.enum(['next-always-answer', 'next-app-chat-build']).optional(),
  sessionApproval: z.literal('until-session-ends').optional(),
  when: z.enum(['model-or-provider-changed', 'base-url-only']).optional(),
}).strict();
export type TimingNote = z.infer<typeof timingNoteSchema>;
/** Shown before a change and again in its result. One note, or one per surface. */
export const MAX_TIMING_NOTES = 32;
export const timingSchema = z.array(timingNoteSchema).min(1).max(MAX_TIMING_NOTES);
export type Timing = readonly TimingNote[];

// ---- Fixed error codes -------------------------------------------------------

/**
 * Every refusal or failure a settings request can end in. Upstream messages
 * (Hermes', Paseo's, a parser's) are never shown, logged or audited: they can
 * echo file contents. The page words each code itself.
 */
export const SETTINGS_ERROR_CODES = [
  /** The server runs in shadow and refuses every settings write. */
  'shadow_read_only',
  /** The settings audit can't be appended (its chain is broken); writes stop, chats keep working. */
  'audit_unavailable',
  /** A launched config write could not be confirmed; reconcile with config.read. */
  'outcome_unknown',
  /** The supervisor's config writes are switched off, or it has no config verbs. */
  'config_writes_off',
  /** This PC has no such target, or it isn't set up in the site file. */
  'not_configured',
  'unknown_operation',
  'invalid_parameters',
  /** The device, or the supervisor key, may not do this. */
  'not_permitted',
  /** A phone needs a confirm code for this; the answer carries one. */
  'confirm_required',
  /** The code is unknown, used, expired, or for another request or device. */
  'confirm_invalid',
  /** Only the paired desktop app on the PC's local listener may make this change. */
  'pc_only',
  /** PC-only settings are read-only until the local listener is confirmed on this PC. */
  'pc_only_read_only',
  /** A value the change depends on is no longer what the page showed. */
  'precondition_changed',
  /** The target file isn't valid YAML or JSON (or not UTF-8). */
  'parse_failed',
  /** The target is missing. */
  'target_missing',
  /** The target is a link, not a regular file, or its owner or mode isn't the expected one. */
  'unsafe_target',
  /** A folder on the target's, backup's or audit's path is writable by someone else. */
  'unsafe_directory',
  /** The target's lock wasn't free in time. */
  'locked',
  /** The consumer's own loader refuses the edited document (an unknown key, a wrong type). */
  'consumer_refused',
  /** The backend falls outside the role's contract. */
  'contract_mismatch',
  /** After writing, a value isn't what was intended, another key changed, or a state record failed. */
  'verify_mismatch',
  /** The file changed since the change being undone; offer the undo as a new change. */
  'undo_changed',
  /** A backup doesn't match the hash its audit holds. */
  'backup_mismatch',
  /** A restart for that component is already running. */
  'busy',
  /** The component never went quiet within its window; "Restart now" is offered instead. */
  'still_busy',
  'foreign_drain',
  'marker_lost',
  'drain_not_engaged',
  'restart_unverified',
  /** The supervisor, the gateway or a consumer didn't answer. */
  'unavailable',
  /** The run took longer than its limit and was stopped. */
  'timeout',
  /** Anything else; details stay in infra logs as a code, never text. */
  'failed',
] as const;
export type SettingsErrorCode = (typeof SETTINGS_ERROR_CODES)[number];
export const settingsErrorCodeSchema = z.enum(SETTINGS_ERROR_CODES);

// ---- Values and key paths ----------------------------------------------------

/** A JSON value, as YAML and JSON configs hold them. */
export type SettingValue = null | boolean | number | string | SettingValue[] | { [key: string]: SettingValue };

export const VALUE_LIMITS = { depth: 16, nodes: 10_000, stringLength: 65_536, keyLength: 256 } as const;

/** Why a value can't be carried, or undefined. Own `__proto__` keys are refused rather than silently dropped. */
export function settingValueProblem(value: unknown): string | undefined {
  let nodes = 0;
  const walk = (current: unknown, depth: number): string | undefined => {
    if (++nodes > VALUE_LIMITS.nodes) return 'too many values';
    if (depth > VALUE_LIMITS.depth) return 'nested too deeply';
    if (current === null || typeof current === 'boolean') return undefined;
    if (typeof current === 'number') return Number.isFinite(current) ? undefined : 'not a finite number';
    if (typeof current === 'string') return current.length > VALUE_LIMITS.stringLength ? 'text too long' : undefined;
    if (Array.isArray(current)) {
      for (const entry of current) { const problem = walk(entry, depth + 1); if (problem) return problem; }
      return undefined;
    }
    if (typeof current !== 'object') return 'not a JSON value';
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) return 'not a plain object';
    for (const key of Object.keys(current)) {
      if (key === '__proto__') return 'a reserved key';
      if (key.length > VALUE_LIMITS.keyLength) return 'key too long';
      const problem = walk((current as Record<string, unknown>)[key], depth + 1);
      if (problem) return problem;
    }
    return undefined;
  };
  return walk(value, 0);
}
export const settingValueSchema = z.unknown().superRefine((value, context) => {
  const problem = settingValueProblem(value);
  if (problem) context.addIssue({ code: 'custom', message: problem });
}) as unknown as z.ZodType<SettingValue>;

/**
 * One step into a config: an object key, an array index, or the array element
 * whose `id` equals this (Paseo's profiles).
 */
export type KeySegment = string | number | { id: string };
export type KeyPath = readonly KeySegment[];
export const keySegmentSchema = z.union([
  z.string().min(1).max(128).refine(key => key !== '__proto__', 'a reserved key'),
  z.number().int().nonnegative().max(10_000),
  z.object({ id: z.string().min(1).max(128) }).strict(),
]);
export const keyPathSchema = z.array(keySegmentSchema).min(1).max(12);

const PLAIN_KEY = /^[A-Za-z0-9_-]+$/;
/**
 * A key's name for audits and pages: model.default, auxiliary.compression.provider,
 * daemon.agentProfiles[id="coder"].model. `*` (every entry) stays bare.
 */
export function formatKeyPath(path: KeyPath): string {
  let name = '';
  for (const segment of path) {
    if (typeof segment === 'number') name += `[${segment}]`;
    else if (typeof segment === 'object') name += `[id=${JSON.stringify(segment.id)}]`;
    else if (segment === '*' || PLAIN_KEY.test(segment)) name += (name ? '.' : '') + segment;
    else name += `[${JSON.stringify(segment)}]`;
  }
  return name;
}

/**
 * Words that mark a key as holding a secret. A read never expands a wildcard
 * into such a key, and never returns one nested inside a value it does return.
 * Counts like maxTokens are fine: only the singular word counts.
 */
const SECRET_WORDS = new Set(['key', 'apikey', 'token', 'secret', 'password', 'passwd', 'passphrase', 'auth',
  'authorization', 'bearer', 'header', 'headers', 'cookie', 'cookies', 'credential', 'credentials']);
export function isSecretKeyName(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some(word => SECRET_WORDS.has(word)) || SECRET_WORDS.has(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

// ---- Ids ---------------------------------------------------------------------

/** Consumer configs and Wayroost's own settings, written as their owner. */
export const OWNER_FILE_TARGETS = ['hermes-config', 'pi-settings', 'pi-models', 'pi-mcp', 'paseo-config', 'wayroost-settings'] as const;
/** Root-owned targets; role changes use the gateway's admin socket. */
export const ROOT_TARGETS = ['gateway-role-map', 'gateway-credentials', 'gateway-state'] as const;
/** Read for pages and Checks, never written. */
export const READ_ONLY_TARGETS = ['hermes-managed', 'windows-hermes', 'claude-settings', 'codex-config', 'opencode-config'] as const;
export const TARGET_IDS = [...OWNER_FILE_TARGETS, ...ROOT_TARGETS, ...READ_ONLY_TARGETS] as const;
export type TargetId = (typeof TARGET_IDS)[number];
export type OwnerFileTarget = (typeof OWNER_FILE_TARGETS)[number];
export const targetIdSchema = z.enum(TARGET_IDS);

export const SHA256_HEX = /^[a-f0-9]{64}$/;
export const sha256Schema = z.string().regex(SHA256_HEX);
/** A free-text read value off the PC: a digest and the UTF-8 byte length, never its content. */
export const redactedSettingValueSchema = z.object({ sha256: sha256Schema, length: z.number().int().nonnegative() }).strict();
export type RedactedSettingValue = z.infer<typeof redactedSettingValueSchema>;
/** "hermes.default-model", "gateway.point". */
export const OPERATION_ID = /^[a-z][a-z0-9-]{0,31}(?:\.[a-z][a-z0-9-]{0,47})+$/;
/** A settings change, as the server records it. */
export const CHANGE_ID = /^ch_[a-f0-9]{24}$/;
/** A paired device (server/src/devices.ts). */
export const DEVICE_ID = /^dv_[a-f0-9]{24}$/;
/** A backup, opaque to everyone but the writer that stored it. */
export const BACKUP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,199})?$/;
/** A one-time confirm code: 128 bits in grouped base32 (the approval codes' format). */
export const CONFIRM_CODE = /^(?:[A-Z2-7]{4}-){6}[A-Z2-7]{2}$/;

// ---- Undo --------------------------------------------------------------------

/**
 * Held by the server, never sent to a page. Valid while the target still
 * hashes to `writtenSha256`; the supervisor checks the backup against
 * `backupSha256` and its own audit before using it.
 */
export const undoTokenSchema = z.object({
  operation: z.string().regex(OPERATION_ID),
  target: targetIdSchema,
  backupId: z.string().regex(BACKUP_ID).refine(id => !id.split('/').some(part => part === '.' || part === '..')),
  backupSha256: sha256Schema,
  writtenSha256: sha256Schema,
}).strict();
export type UndoToken = z.infer<typeof undoTokenSchema>;

// ---- Preconditions -----------------------------------------------------------

/**
 * What must still hold when the change is applied: the whole file's hash, or the
 * current value (or absence) of keys the operation changes, by their index in
 * the operation's resolved keys. Key-scoped preconditions let an unrelated write
 * to the same file go through.
 */
export const contentVersionSchema = z.object({ sha256: sha256Schema }).strict();
export type ContentVersion = z.infer<typeof contentVersionSchema>;
/** File versions compare content only; a no-change save may replace the inode and mtime. */
export const sameContentVersion = (a: ContentVersion, b: ContentVersion): boolean => a.sha256 === b.sha256;

/** Object order is immaterial to value drift; absence and array order remain significant. */
export function settingValuesEqual(a: SettingValue | undefined, b: SettingValue | undefined): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => settingValuesEqual(value, b[index]));
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && settingValuesEqual(a[key], b[key]));
}

/** Stable comparison bytes preserve absence separately and ignore object key order. */
export function settingComparisonJson(value: SettingValue): string {
  if (Array.isArray(value)) return '[' + value.map(settingComparisonJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + settingComparisonJson(value[key]!)).join(',') + '}';
  return JSON.stringify(value);
}

export const preconditionsSchema = z.union([
  z.object({ file: contentVersionSchema }).strict(),
  z.object({
    keys: z.array(z.union([
      z.object({ key: z.number().int().nonnegative().max(MAX_OPERATION_KEYS - 1), exists: z.literal(false) }).strict(),
      z.object({ key: z.number().int().nonnegative().max(MAX_OPERATION_KEYS - 1), value: settingValueSchema }).strict(),
    ])).min(1).max(MAX_OPERATION_KEYS),
  }).strict(),
]);
export type Preconditions = z.infer<typeof preconditionsSchema>;

/**
 * An operation's parameters, passed through as sent: the operation's own strict
 * schema checks them, so a key it doesn't declare (an own `__proto__` included)
 * is refused rather than dropped.
 */
export const operationParamsSchema = z.custom<Record<string, unknown>>(value => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}, 'an object').default({});

// ---- Settings API (pages and the server) -------------------------------------

/** Settings routes as the router matches them. */
export const SETTINGS_ROUTES = {
  section: '/api/settings/sections/:section',
  apply: '/api/settings/apply',
  undo: '/api/settings/undo',
  changes: '/api/settings/changes',
  checks: '/api/settings/checks',
  usage: '/api/settings/usage',
  restart: '/api/settings/restart',
  restartRun: '/api/settings/restart/:id',
  credential: '/api/settings/credentials/:provider',
  credentialTest: '/api/settings/credentials/:provider/test',
  notifications: '/api/settings/notifications',
  safetyCommands: '/api/settings/safety-commands',
} as const;
/** Earlier switches covered by the route policy outside the settings prefix. */
export const LEGACY_POLICY_ROUTES = {
  safetyCommands: '/api/safety-commands',
  cloudAgent: '/api/cloud-agents/:id',
  workerApprovals: '/api/worker-approvals',
  notifications: '/api/feed/settings',
} as const;
/**
 * Every SETTINGS_ROUTES entry lives under this prefix. A route under it that is neither in
 * the route policy (settings-levels.ts) nor one of EARLIER_SETTINGS_ROUTES is refused.
 */
export const SETTINGS_ROUTE_PREFIX = '/api/settings/';
/** Settings routes that predate the policy table and keep their own checks: the Hermes dashboard login. */
export const EARLIER_SETTINGS_ROUTES = ['/api/settings/hermes'] as const;

/** The same routes with their parameters filled in, for pages. */
export const SETTINGS_API = {
  ...SETTINGS_ROUTES,
  section: (section: SettingsSection) => `/api/settings/sections/${section}`,
  credential: (provider: string) => `/api/settings/credentials/${encodeURIComponent(provider)}`,
  credentialTest: (provider: string) => `/api/settings/credentials/${encodeURIComponent(provider)}/test`,
} as const;

/**
 * POST /api/settings/apply. `params` is checked against the operation's own
 * schema (settings-ops.ts). A phone's first request for a confirm-level change
 * gets a code back; it sends the same request again with `confirm`.
 */
export const settingsApplyBodySchema = z.object({
  operation: z.string().regex(OPERATION_ID),
  params: operationParamsSchema,
  expected: preconditionsSchema.optional(),
  afterSeconds: z.number().int().min(1).max(600).optional(),
  confirm: z.string().regex(CONFIRM_CODE).optional(),
}).strict();
export type SettingsApplyBody = z.infer<typeof settingsApplyBodySchema>;

/** POST /api/settings/undo: undo one recent change. */
export const settingsUndoBodySchema = z.object({
  change: z.string().regex(CHANGE_ID),
  confirm: z.string().regex(CONFIRM_CODE).optional(),
}).strict();

/** Components a settings page can restart: Hermes' gateway and the model gateway when idle or now, the dashboard now. */
export const DRAIN_RESTART_COMPONENTS = ['hermes', 'gateway', 'dashboard'] as const;
export type DrainRestartComponent = (typeof DRAIN_RESTART_COMPONENTS)[number];
export const drainRestartTargetSchema = z.union([
  z.object({ component: z.enum(['hermes', 'gateway']), when: z.enum(['idle', 'now']) }).strict(),
  z.object({ component: z.literal('dashboard'), when: z.literal('now') }).strict(),
]);

/** POST /api/settings/restart. */
export const settingsRestartBodySchema = z.object({
  component: z.enum(DRAIN_RESTART_COMPONENTS),
  when: z.enum(['idle', 'now']),
  confirm: z.string().regex(CONFIRM_CODE).optional(),
}).strict().refine(body => body.component !== 'dashboard' || body.when === 'now', 'the dashboard has no idle restart');

/** A provider key: printable ASCII without spaces, as the gateway reads it. */
export const credentialSecretSchema = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
/** PUT /api/settings/credentials/<provider>. The key is never echoed back. */
export const settingsCredentialBodySchema = z.object({ secret: credentialSecretSchema }).strict();
/** The backend must use the provider named in the route; the server never receives its stored key. */
export const settingsCredentialTestBodySchema = z.object({ backend: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/) }).strict();

export const NOTIFICATION_EVENTS = [
  'agent-needs-you', 'agent-finished', 'agent-error', 'feed-card', 'stack-status',
  'settings-applied', 'settings-failed', 'mismatch-warning', 'security-card',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
export const NOTIFICATION_SOURCES = [...SOURCES, ...FEED_SOURCES, 'supervisor'] as const;
export type NotificationSource = (typeof NOTIFICATION_SOURCES)[number];
export const NOTIFICATION_DELIVERIES = ['toast', 'push', 'both', 'neither'] as const;
export type NotificationDelivery = (typeof NOTIFICATION_DELIVERIES)[number];
/**
 * The card alerts quiet hours can hold. An alert the person asked for, and anything
 * still waiting on them, goes through.
 */
export const QUIET_HELD_NOTIFICATION_EVENTS = ['feed-card', 'security-card'] as const;
/** No report from the PC's desktop for this long means the desktop isn't there to show a toast. */
export const DESKTOP_GONE_MS = 120_000;

/**
 * Whether an event names an agent waiting for an answer: approval needed and a
 * question. Those alerts can never be switched off.
 */
export function isAgentNeedsYouEvent(event: NotificationEvent): boolean {
  return event === 'agent-needs-you';
}

/** Whether quiet hours may hold this event's phone push. */
export function isQuietHeldEvent(event: NotificationEvent): boolean {
  return (QUIET_HELD_NOTIFICATION_EVENTS as readonly string[]).includes(event);
}

/** Agent-needs-you keeps a toast even when push is off or quiet hours suppress it. */
export const notificationRuleSchema = z.object({
  event: z.enum(NOTIFICATION_EVENTS),
  source: z.enum([...NOTIFICATION_SOURCES, '*']),
  delivery: z.enum(NOTIFICATION_DELIVERIES),
}).strict().refine(rule => rule.event !== 'agent-needs-you' || rule.delivery === 'toast' || rule.delivery === 'both',
  'agent-needs-you requires a toast');
export type NotificationRule = z.infer<typeof notificationRuleSchema>;
/**
 * What every install starts with: an answer that waits on you reaches the app and the
 * phone, an alert about a finished or failing agent reaches the app alone. No rule is
 * written for the cards the For-you page holds: until one is, that page's own switch says
 * whether the phone hears about a new card.
 */
export const DEFAULT_NOTIFICATION_RULES: readonly NotificationRule[] = [
  { event: 'agent-needs-you', source: '*', delivery: 'both' },
  { event: 'agent-finished', source: '*', delivery: 'toast' },
  { event: 'agent-error', source: '*', delivery: 'toast' },
  { event: 'settings-applied', source: '*', delivery: 'toast' },
  { event: 'settings-failed', source: '*', delivery: 'toast' },
  { event: 'mismatch-warning', source: '*', delivery: 'toast' },
  { event: 'stack-status', source: '*', delivery: 'toast' },
];
/** Quiet hours as they start out, read in the owner's time zone. */
export const DEFAULT_QUIET_HOURS = { start: '21:00', end: '07:00' } as const;
export const notificationRulesSchema = z.array(notificationRuleSchema).max(NOTIFICATION_EVENTS.length * (NOTIFICATION_SOURCES.length + 1))
  .refine(rules => new Set(rules.map(rule => `${rule.event}/${rule.source}`)).size === rules.length, 'each event and source once');

/** Exact sources override wildcard rules; unlisted agent-needs-you events always have delivery. */
export function notificationDelivery(event: NotificationEvent, source: NotificationSource, rules: readonly NotificationRule[]): NotificationDelivery {
  const rule = rules.find(rule => rule.event === event && rule.source === source)
    ?? rules.find(rule => rule.event === event && rule.source === '*');
  const delivery = rule?.delivery ?? (event === 'agent-needs-you' ? 'both' : 'neither');
  if (event === 'agent-needs-you' && delivery === 'neither') return 'toast';
  if (event === 'agent-needs-you' && delivery === 'push') return 'both';
  return delivery;
}

/** Notification rules and local quiet hours, applied together. Older requests use the mandatory delivery defaults. */
export const notificationQuietHoursSchema = z.object({
  start: z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),
  end: z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),
}).strict();
export type NotificationQuietHours = z.infer<typeof notificationQuietHoursSchema>;

export const settingsNotificationsBodySchema = z.object({
  push: z.object({ approvals: z.boolean(), cards: z.boolean() }).strict(),
  quietHours: notificationQuietHoursSchema.nullable(),
  rules: notificationRulesSchema.default(() => DEFAULT_NOTIFICATION_RULES.map(rule => ({ ...rule }))),
}).strict();
export type SettingsNotificationsBody = z.infer<typeof settingsNotificationsBodySchema>;
/** A rules-only save leaves the shared phone switches and quiet hours as currently stored. */
export const settingsNotificationRulesBodySchema = z.object({ rules: notificationRulesSchema }).strict();
/** Shared controls can save hours or phone switches without replacing the event rules. */
export const settingsNotificationsWriteBodySchema = z.union([
  settingsNotificationsBodySchema,
  settingsNotificationRulesBodySchema,
  z.object({ quietHours: settingsNotificationsBodySchema.shape.quietHours }).strict(),
  z.object({ push: settingsNotificationsBodySchema.shape.push }).strict(),
]);
export type SettingsNotificationsWriteBody = z.infer<typeof settingsNotificationsWriteBodySchema>;
export const settingsSafetyCommandsBodySchema = z.object({ enabled: z.boolean() }).strict();

/**
 * How the effective value looked after a change: `verified` (the consumer reports
 * it), `pending` (the process that matters hasn't picked it up yet; the timing
 * says when), `mismatch` (it reports something else), `not-checked` (nothing to ask).
 */
export const EFFECTIVE_STATES = ['verified', 'pending', 'mismatch', 'not-checked'] as const;

export const changeResultSchema = z.object({
  id: z.string().regex(CHANGE_ID),
  operation: z.string().regex(OPERATION_ID),
  target: targetIdSchema,
  /** Key names only. */
  keys: z.array(z.string().max(512)).max(MAX_OPERATION_KEYS),
  timing: timingSchema,
  /** A manual role change stays until the next model switch. */
  lasts: z.literal('until-next-switch').optional(),
  effective: z.enum(EFFECTIVE_STATES),
  undoable: z.boolean(),
  /** An open Hermes settings page can restore every stale value, including revoked entries: reload it before saving. */
  reloadOpenPages: z.boolean().optional(),
  restartRequired: z.object({ component: z.literal('hermes'), choices: z.tuple([z.literal('idle'), z.literal('now')]),
    timing: timingSchema, runId: z.uuid({ version: 'v4' }).optional(), code: settingsErrorCodeSchema.optional() }).strict().optional(),
}).strict();
export type ChangeResult = z.infer<typeof changeResultSchema>;

export const SETTINGS_RESOLUTION_MESSAGE = 'The target is blocked until the supervisor records a terminal outcome or you use Checks to accept the current file as is on this PC.';

export const settingsApplyResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('confirm'), confirm: z.string().regex(CONFIRM_CODE), summary: z.string().max(500), expiresAt: z.number().int() }).strict(),
  z.object({ status: z.literal('applied'), change: changeResultSchema }).strict(),
  /** `change` is present when the file was written but a later step failed (it can be undone). */
  z.object({ status: z.literal('refused'), code: settingsErrorCodeSchema, change: changeResultSchema.optional(),
    message: z.literal(SETTINGS_RESOLUTION_MESSAGE).optional(),
    /** Null when the supervisor did not return a backup identifier. */
    backupId: z.string().regex(BACKUP_ID).nullable().optional() }).strict(),
]);
export type SettingsApplyResponse = z.infer<typeof settingsApplyResponseSchema>;

/** One row of Overview → Recent changes (the last RECENT_CHANGES). */
export const RECENT_CHANGES = 30;
export const recentChangeSchema = z.object({
  id: z.string().regex(CHANGE_ID),
  at: z.number().int().nonnegative(),
  action: z.enum(['apply', 'undo']),
  operation: z.string().regex(OPERATION_ID),
  target: z.string().min(1).max(64),
  keys: z.array(z.string().max(512)).max(MAX_OPERATION_KEYS),
  device: z.object({ id: z.string().regex(DEVICE_ID), name: z.string().max(60), kind: z.enum(DEVICE_KINDS) }).strict().optional(),
  level: settingsLevelSchema,
  timing: timingSchema,
  result: z.union([z.literal('ok'), settingsErrorCodeSchema]),
  undoable: z.boolean(),
  undoAccess: z.enum(['editable', 'confirm', 'read-only']).optional(),
}).strict();
export type RecentChange = z.infer<typeof recentChangeSchema>;

/**
 * One row of the server's settings audit. Key names, backup id and hashes,
 * device, level, timing labels and the result: never a value, so the schema
 * has no field that could hold one.
 */
export const settingsAuditRecordSchema = z.object({
  id: z.string().regex(CHANGE_ID),
  at: z.number().int().nonnegative(),
  action: z.enum(['apply', 'undo', 'credential', 'restart']),
  operation: z.string().regex(OPERATION_ID).optional(),
  target: z.string().min(1).max(64).optional(),
  keys: z.array(z.string().max(512)).max(MAX_OPERATION_KEYS),
  backupId: z.string().regex(BACKUP_ID).optional(),
  backupSha256: sha256Schema.optional(),
  writtenSha256: sha256Schema.optional(),
  runId: z.uuid({ version: 'v4' }).optional(),
  observed: z.enum(['before', 'intended', 'supervisor', 'resolved-by-user']).optional(),
  device: z.object({ id: z.string().regex(DEVICE_ID), kind: z.enum(DEVICE_KINDS) }).strict().optional(),
  level: settingsLevelSchema,
  timing: z.array(timingLabelSchema).max(MAX_TIMING_NOTES),
  result: z.union([z.literal('ok'), settingsErrorCodeSchema, z.enum(['credential_missing', 'credential_rejected', 'backend_unavailable', 'test_failed'])]),
}).strict();
export type SettingsAuditRecord = z.infer<typeof settingsAuditRecordSchema>;

// ---- Events on /ws -----------------------------------------------------------

/** A change was applied, undone or failed: pages showing these sections read them again. Ids only. */
export interface SettingsChangedEvent {
  type: 'settings_changed';
  sections: SettingsSection[];
  change?: string;
}
/** Usage moved on: usage pills read their summary again. */
export interface UsageChangedEvent {
  type: 'usage_changed';
}
