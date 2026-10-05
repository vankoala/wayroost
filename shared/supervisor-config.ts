// The supervisor's config verbs, between it and its two callers: the Wayroost
// server and the stack launcher, each with its own key. Every verb names a
// catalogue operation or read view with typed parameters, never a path, key,
// command or shell string; the supervisor runs each in a transient unit as the
// target's owner (root only for root-owned targets) and answers with one
// fixed-shape result. Reads work whenever the verbs exist; writes also need
// `configWrites` on in the site file.
import { z } from 'zod';
import { CATALOGUE_VERSION, READ_VIEW_IDS, RECOVERY_OPERATIONS, type ReadViewId } from './settings-ops.js';
import {
  BACKUP_ID, CHANGE_ID, DEVICE_ID, DRAIN_RESTART_COMPONENTS, MAX_OPERATION_KEYS, OPERATION_ID, credentialSecretSchema, keyPathSchema, targetIdSchema,
  operationParamsSchema, preconditionsSchema, settingValueSchema, settingsErrorCodeSchema, settingsLevelSchema, sha256Schema, undoTokenSchema,
  timingSchema, settingsApplyResponseSchema,
} from './settings.js';
import { DEVICE_KINDS } from './protocol.js';
import { GATEWAY_ROLES, backendIdSchema, credentialNameSchema, gatewayCredentialTestResultSchema } from './gateway.js';

export const CONFIG_VERBS = ['config.read', 'config.request-status', 'config.apply', 'config.undo', 'credential.write', 'credential.test', 'service.drain-restart', 'service.drain-status', 'project.scan', 'checks.observe', 'usage.summary'] as const;
/** Credential probes are authenticated reads and never reserve a writable target. */
export type ConfigVerb = (typeof CONFIG_VERBS)[number];
/** Verbs that change something: refused while `configWrites` is off. */
export const CONFIG_WRITE_VERBS: readonly ConfigVerb[] = ['config.apply', 'config.undo', 'credential.write', 'service.drain-restart'];

/** Routes on the supervisor's Unix socket. */
export const CONFIG_ROUTES = {
  read: '/v1/config/read',
  requestStatus: '/v1/config/request-status',
  apply: '/v1/config/apply',
  undo: '/v1/config/undo',
  credential: '/v1/config/credential',
  credentialTest: '/v1/config/credential/test',
  drainRestart: '/v1/config/drain-restart',
  drainRestartRun: (id: string) => `/v1/config/drain-restart/${encodeURIComponent(id)}`,
  usage: '/v1/usage/summary',
  projectScan: '/v1/project/scan',
  checksObserve: '/v1/checks/observe',
} as const;
export const CONFIG_ROUTE_FOR: Readonly<Record<(typeof CONFIG_VERBS)[number], string>> = {
  'config.read': CONFIG_ROUTES.read,
  'config.request-status': CONFIG_ROUTES.requestStatus,
  'config.apply': CONFIG_ROUTES.apply,
  'config.undo': CONFIG_ROUTES.undo,
  'credential.write': CONFIG_ROUTES.credential,
  'credential.test': CONFIG_ROUTES.credentialTest,
  'service.drain-restart': CONFIG_ROUTES.drainRestart,
  'service.drain-status': '/v1/config/drain-restart/:id',
  'project.scan': CONFIG_ROUTES.projectScan,
  'checks.observe': CONFIG_ROUTES.checksObserve,
  'usage.summary': CONFIG_ROUTES.usage,
};

// ---- Keys ----------------------------------------------------------------------

/**
 * The stack launcher's key: an entry named `launcher` with scope `server` in
 * supervisor-keys.json, so the previous supervisor's strict key loader (which
 * knows only `server` and `rescue`) still reads the file after a rollback. The
 * key itself sits in LAUNCHER_KEY_FILE, readable by root only.
 */
export const LAUNCHER_KEY_NAME = 'launcher';
export const LAUNCHER_KEY_FILE = '/etc/wayroost/launcher-key';

/** What a key is for: the Wayroost server, the stack launcher, or the desktop's rescue path. */
export type KeyRole = 'server' | 'launcher' | 'rescue';
export function keyRole(key: { name: string; scope: 'server' | 'rescue' }): KeyRole {
  if (key.scope === 'rescue') return 'rescue';
  return key.name === LAUNCHER_KEY_NAME ? 'launcher' : 'server';
}

/** Everything a key may reach on the socket: status, events, lifecycle actions, the busy push and the config verbs. */
export type SupervisorCapability = 'status' | 'events' | 'actions' | 'busy' | ConfigVerb;
/**
 * The launcher reads status and applies its own catalogue operations; it never
 * runs actions or pushes busy counts, and the old routes treat it by this
 * table, not by its `server` scope. The rescue key reaches status, events and
 * its one rescue action.
 */
export const KEY_ROLE_ACCESS: Readonly<Record<KeyRole, readonly SupervisorCapability[]>> = {
  server: ['status', 'events', 'actions', 'busy', ...CONFIG_VERBS],
  launcher: ['status', 'config.read', 'config.apply'],
  rescue: ['status', 'events', 'actions'],
};
export const keyMay = (role: KeyRole, capability: SupervisorCapability): boolean => KEY_ROLE_ACCESS[role].includes(capability);

// ---- Status ------------------------------------------------------------------

/**
 * The status reply's `configVerbs` field, present only on a supervisor that has
 * the config verbs. The launcher uses config.apply only when it's present and
 * `configWrites` is true; otherwise it writes through its own locked path.
 */
export const configDirectoryRowSchema = z.object({
  target: targetIdSchema, storage: z.enum(['target', 'backup', 'audit', 'lock']),
  ok: z.boolean(), code: settingsErrorCodeSchema.optional(),
}).strict().refine(row => row.ok ? row.code === undefined : row.code !== undefined, 'refusals carry a code');
export type ConfigDirectoryRow = z.infer<typeof configDirectoryRowSchema>;

export const gatewayPersistenceSchema = z.union([
  z.object({ ok: z.literal(true), failedChanges: z.array(z.union([z.string().regex(CHANGE_ID), z.uuid({ version: 'v4' })])).max(64) }).strict(),
  z.object({ ok: z.literal(false), code: settingsErrorCodeSchema }).strict(),
]);

export const configVerbsStatusSchema = z.object({
  version: z.number().int().positive(),
  configWrites: z.boolean(),
  /** Preserve unknown future verbs; callers check membership for verbs they understand. */
  verbs: z.array(z.string().min(1).max(128)),
  /** The catalogue's version (settings-ops.ts), so a caller can tell an older supervisor. */
  catalogue: z.number().int().positive(),
  directories: z.array(configDirectoryRowSchema).max(64).optional(),
  /** Bounded supervisor audit evidence about writes to its own gateway records. */
  gatewayPersistence: gatewayPersistenceSchema.optional(),

});
export type ConfigVerbsStatus = z.infer<typeof configVerbsStatusSchema>;
export const currentConfigVerbs = (configWrites: boolean): ConfigVerbsStatus =>
  ({ version: 1, configWrites, verbs: [...CONFIG_VERBS], catalogue: CATALOGUE_VERSION });

// ---- Common request fields ---------------------------------------------------

/** One request, for idempotence and for matching the server's audit to the supervisor's. */
const requestId = z.uuid({ version: 'v4' });
/** The device a server request came from and the level the server enforced, for the supervisor's audit. */
const origin = z.object({
  change: z.string().regex(CHANGE_ID),
  device: z.object({ id: z.string().regex(DEVICE_ID), kind: z.enum(DEVICE_KINDS) }).strict().optional(),
  level: settingsLevelSchema,
}).strict();

/** Every result that fails carries a fixed code only. */
const refusal = z.object({ ok: z.literal(false), code: settingsErrorCodeSchema }).strict();

// ---- config.read -------------------------------------------------------------

export const configReadRequestSchema = z.object({
  view: z.enum(READ_VIEW_IDS as [ReadViewId, ...ReadViewId[]]),
}).strict();
export type ConfigReadRequest = z.infer<typeof configReadRequestSchema>;

export const configReadResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    view: z.enum(READ_VIEW_IDS as [ReadViewId, ...ReadViewId[]]),
    /** Whether the persisted file exists. Effective defaults may exist without it. */
    present: z.boolean(),
    effective: z.literal(true).optional(),
    sha256: sha256Schema.optional(),
    /** Produced by readViewValues: allowlisted safe values or PC-only text; other callers get { sha256, length }. */
    values: z.array(z.union([
      z.object({ path: keyPathSchema, exists: z.literal(false) }).strict(),
      z.object({ path: keyPathSchema, exists: z.literal(true), value: settingValueSchema.optional() }).strict(),
    ])).max(MAX_OPERATION_KEYS),
    order: z.array(z.object({ path: keyPathSchema, names: z.array(z.string().max(256)).max(512) }).strict()).max(8).optional(),
  }).strict().refine(result => result.present ? result.sha256 !== undefined : result.sha256 === undefined && (result.values.length === 0 || result.effective === true) && !result.order,
    'a present file has a content hash; an absent file has no content'),
  refusal,
]);
export type ConfigReadResult = z.infer<typeof configReadResultSchema>;

// ---- config.apply and config.undo --------------------------------------------

/**
 * Apply one catalogue operation. The server sends `origin`; the launcher, whose
 * key names it, sends none. Delayed applies are refused with invalid_parameters.
 */
export const configApplyRequestSchema = z.object({
  requestId,
  operation: z.string().regex(OPERATION_ID),
  params: operationParamsSchema,
  preconditions: preconditionsSchema.optional(),
  origin: origin.optional(),
  afterSeconds: z.number().int().min(1).max(600).optional(),
}).strict();
export type ConfigApplyRequest = z.infer<typeof configApplyRequestSchema>;

export const configUndoRequestSchema = z.object({
  requestId,
  token: undoTokenSchema,
  origin: origin.optional(),
}).strict();
export type ConfigUndoRequest = z.infer<typeof configUndoRequestSchema>;

/** Service recoveries are verified without inventing a configuration backup or undo token. */
export const configRecoveryResultSchema = z.object({
  ok: z.literal(true), recovered: z.literal(true), operation: z.enum(RECOVERY_OPERATIONS),
  target: z.enum(['gateway-role-map', 'hermes-config']),
}).strict().refine(result => result.target === (result.operation === 'gateway.socket-recover' ? 'gateway-role-map' : 'hermes-config'));

/**
 * The outcome of an apply or undo, which is also the executor unit's one output
 * line. After a launched write fails, the supervisor returns `outcome_unknown`.
 * The caller resolves uncertainty from config.request-status only. A lost output
 * has no known backup id. The executor's internal committed result may still
 * supply a backup token to the supervisor.
 */
export const configWriteResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    operation: z.string().regex(OPERATION_ID),
    target: targetIdSchema,
    /** Key names only. */
    keys: z.array(z.string().max(512)).max(MAX_OPERATION_KEYS),
    backupId: z.string().regex(BACKUP_ID),
    backupSha256: sha256Schema,
    writtenSha256: sha256Schema,
    undo: undoTokenSchema,
    /** Changes the file didn't need (every value already as asked) write nothing and say so. */
    unchanged: z.boolean().optional(),
  }).strict(),
  configRecoveryResultSchema,
  z.object({ ok: z.literal(false), code: z.literal('outcome_unknown'), target: targetIdSchema,
    backupId: z.string().regex(BACKUP_ID).nullable() }).strict(),
  z.object({ ok: z.literal(false), code: settingsErrorCodeSchema, committed: z.literal(true), undo: undoTokenSchema }).strict()
    .refine(result => result.code !== 'outcome_unknown', 'an unknown outcome does not assert a commit'),
  refusal.refine(result => result.code !== 'outcome_unknown', 'an unknown outcome identifies the target and backup'),
]);
export type ConfigWriteResult = z.infer<typeof configWriteResultSchema>;

// ---- credential.write --------------------------------------------------------

/**
 * Set or remove one provider's key for the gateway. `provider` must be one the
 * role map names. The key is written once, never logged, audited or returned.
 */
export const credentialWriteRequestSchema = z.discriminatedUnion('action', [
  z.object({ requestId, action: z.literal('set'), provider: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/), secret: credentialSecretSchema, origin: origin.optional() }).strict(),
  z.object({ requestId, action: z.literal('remove'), provider: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/), origin: origin.optional() }).strict(),
]);
export type CredentialWriteRequest = z.infer<typeof credentialWriteRequestSchema>;
export const credentialWriteResultSchema = z.union([
  z.object({ ok: z.literal(true), provider: z.string(), timing: z.literal('restart-when-idle:gateway') }).strict(),
  refusal,
]);

/** The server supplies names only. Root reads the current stored key and sends it to the gateway's admin test route. */
export const credentialTestRequestSchema = z.object({ requestId, provider: credentialNameSchema, backend: backendIdSchema }).strict();
export type CredentialTestRequest = z.infer<typeof credentialTestRequestSchema>;
export const credentialTestResultSchema = z.union([gatewayCredentialTestResultSchema, refusal]);
export type CredentialTestResult = z.infer<typeof credentialTestResultSchema>;
/** Probe errors keep their bounded result instead of being replaced by a settings transport error. */
export const settingsCredentialResponseSchema = z.union([
  settingsApplyResponseSchema,
  z.object({ status: z.literal('applied'), timing: timingSchema, test: credentialTestResultSchema.optional() }).strict(),
  z.object({ status: z.literal('refused'), code: z.union([settingsErrorCodeSchema, gatewayCredentialTestResultSchema.options[1].shape.code]),
    test: credentialTestResultSchema }).strict().refine(response => !response.test.ok && response.test.code === response.code),
]);

// ---- service.drain-restart ---------------------------------------------------

/** Fixed executor policy, selected by version rather than caller-supplied timeouts or safety overrides. */
export const HERMES_DRAIN_PROTOCOL = {
  version: 1,
  timing: {
    drainPollSeconds: 1, waitPollSeconds: 15, drainLimitSeconds: 180, retrySeconds: 600,
    overallLimitSeconds: 7200, staleCountProbeSeconds: 600, oneShotWindowSeconds: 300,
    claimTtlSeconds: 300, claimFutureSkewSeconds: 60, phoneTimeoutSeconds: 12,
    engageDeadlineSeconds: 5, verifyDeadlineSeconds: 150, unitRuntimeMaxSeconds: 8100, unitStopTimeoutSeconds: 150,
  },
  readers: { noFollow: true, regularFile: true, ownerChecked: true, sizeCapped: true,
    unreadable: 'busy', count: 'nonnegative-json-integer', timestamp: 'iso-with-offset', database: 'read-only' },
  precheck: { inactiveUnit: 'not_running', existingMarker: 'foreign_drain' },
  wait: {
    phone: 'zero-active-calls-regardless-of-http-status', cronStores: 'main-and-all-profiles',
    claims: 'fire-and-run-for-all-jobs', dueSoon: 'runnable-one-shots-including-overdue',
    runnable: 'enabled-not-paused-completed-or-error', recurring: 'catch-up-after-release',
    processes: 'live-host-pid-or-any-non-host-entry', delegations: 'running',
    gatewayStates: ['running', 'degraded'], probe: 'unchanged-nonzero-count-with-all-other-checks-clear',
  },
  marker: { principal: 'wayroost', action: 'drain', suppressNotification: true, mode: 0o600,
    epoch: 'boot-id:pid-1-start-time', publish: 'exclusive-temp-fsync-link-unlink-fsync-directory',
    linkFailure: 'foreign_drain' },
  drain: {
    engagement: 'draining-write-newer-than-marker', chatAtEntry: 'remove-own-marker-and-wait',
    callStartsOrPhoneUnreadable: 'remove-own-marker-and-wait', markerOwnership: 'principal-and-requested-at',
    lostMarker: 'marker_lost', idle: 'zero-count-and-background-clear', idleReadings: 2,
    idleWrites: 'strictly-newer-updated-at-at-least-one-second-apart',
    timeout: 'remove-own-marker-and-retry', noEngagement: 'remove-own-marker-and-fail',
  },
  restart: { order: ['record-stop', 'stop', 'clear-own-marker', 'record-cleared', 'start', 'record-started', 'verify'],
    verify: 'new-pid-and-start-time-running-or-degraded-no-marker', commands: 'systemctl-user-with-runtime-dir' },
  state: { mode: 0o600, beforeSideEffects: true, duplicateActiveRun: 'busy', deleteOnCleanExit: true },
  cleanup: { everyExitIncludingKillAndTimeout: true, order: ['remove-own-marker', 'start-if-stopped-not-started', 'delete-state'],
    start: 'no-block', sweep: 'remove-wayroost-marker-only-with-no-active-executor' },
  unit: { runAs: 'marker-owner', noNewPrivileges: true, network: 'real-loopback-only', pid1Visible: true,
    writes: 'marker-and-own-state', cleanup: 'exec-stop-post' },
} as const;

const drainTimestamp = z.iso.datetime({ offset: true });
export const drainMarkerSchema = z.object({
  action: z.literal('drain'), requested_at: drainTimestamp, principal: z.literal('wayroost'),
  epoch: z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[0-9]+$/), suppress_notification: z.literal(true),
}).strict();

/** Persisted before each side effect; cleanup can recover even after the executor is killed. */
export const drainExecutorStateSchema = z.object({
  phase: z.enum(['waiting', 'probing', 'draining', 'stopping', 'cleared', 'starting', 'verifying']),
  marker_requested_at: drainTimestamp.nullable(), stopped_gateway: z.boolean(), started_gateway: z.boolean(),
}).strict().refine(state => !state.started_gateway || state.stopped_gateway, 'a start follows a stop');

/** The reader supplies the original JSON number token; parsed numbers cannot prove integer spelling. */
export const drainCountSchema = z.string().max(64).regex(/^[\t\n\r ]*(?:0|[1-9][0-9]*)[\t\n\r ]*$/)
  .transform(token => Number(token)).pipe(z.number().int().nonnegative());

/** Missing or invalid observations are busy, including during a stale-count probe. */
const drainWaitObservationSchema = z.object({
  activeAgents: drainCountSchema, unchangedForSeconds: z.number().nonnegative(),
  phoneClear: z.literal(true), cronClear: z.literal(true), backgroundClear: z.literal(true),
  markerAbsent: z.literal(true), gatewayState: z.enum(['running', 'degraded']),
});
export function drainWaitDecision(observation: unknown): 'wait' | 'drain' | 'probe' {
  const result = drainWaitObservationSchema.safeParse(observation);
  if (!result.success) return 'wait';
  if (result.data.activeAgents === 0) return 'drain';
  return result.data.unchangedForSeconds >= HERMES_DRAIN_PROTOCOL.timing.staleCountProbeSeconds ? 'probe' : 'wait';
}

/** A content-free cron observation; runnable excludes disabled, paused, completed and error jobs. */
const cronDrainObservationSchema = z.object({
  kind: z.enum(['once', 'recurring']), runnable: z.boolean(), nextRunAt: drainTimestamp.optional(),
  claims: z.array(drainTimestamp),
});
export function cronBlocksDrain(observation: unknown, now: number): boolean {
  const result = cronDrainObservationSchema.safeParse(observation);
  if (!result.success || !Number.isFinite(now)) return true;
  const policy = HERMES_DRAIN_PROTOCOL.timing;
  if (result.data.claims.some(claim => {
    const claimedAt = Date.parse(claim);
    if (claimedAt > now + policy.claimFutureSkewSeconds * 1000) return true;
    return now - claimedAt < policy.claimTtlSeconds * 1000;
  })) return true;
  if (result.data.kind !== 'once' || !result.data.runnable) return false;
  return result.data.nextRunAt === undefined || Date.parse(result.data.nextRunAt) <= now + policy.oneShotWindowSeconds * 1000;
}

const drainIdleReadingSchema = z.object({
  state: z.literal('draining'), updatedAt: drainTimestamp, readAt: z.number().nonnegative(),
  activeAgents: drainCountSchema.pipe(z.literal(0)), backgroundClear: z.literal(true), phoneClear: z.literal(true), markerOwned: z.literal(true),
});
export const DRAIN_IDLE_MIN_GAP_MS = 1000;
export const drainIdlePairSchema = z.object({
  first: drainIdleReadingSchema, second: drainIdleReadingSchema, markerRequestedAt: drainTimestamp,
}).strict().refine(({ first, second, markerRequestedAt }) => Date.parse(first.updatedAt) > Date.parse(markerRequestedAt)
  && Date.parse(second.updatedAt) - Date.parse(first.updatedAt) >= DRAIN_IDLE_MIN_GAP_MS
  && second.readAt - first.readAt >= DRAIN_IDLE_MIN_GAP_MS, 'idle writes and reads are sufficiently separated');
/** A frozen state file cannot establish idle, however often it is read. */
export function drainIdlePair(first: unknown, second: unknown, markerRequestedAt: string): boolean {
  return drainIdlePairSchema.safeParse({ first, second, markerRequestedAt }).success;
}

/**
 * Restart Hermes' gateway or the model gateway when idle, or now; the dashboard
 * only now. It runs as its own tracked unit, outside the single action slot;
 * a second one for the same component is refused with `busy`.
 */
export const drainRestartRequestSchema = z.object({
  requestId,
  protocol: z.literal(HERMES_DRAIN_PROTOCOL.version).default(HERMES_DRAIN_PROTOCOL.version),
  component: z.enum(DRAIN_RESTART_COMPONENTS),
  when: z.enum(['idle', 'now']),
  origin: origin.optional(),
}).strict().refine(request => request.component !== 'dashboard' || request.when === 'now', { path: ['when'], message: 'the dashboard has no idle restart' });
export type DrainRestartRequest = z.infer<typeof drainRestartRequestSchema>;

/** Why a component isn't idle yet: shown as what "Restart now" would cut. */
export const BUSY_REASONS = [
  'call', 'call-ringing', 'phone-wrap-up', 'cron-running', 'cron-due', 'messaging-turn', 'agents-unknown',
  'agents-running', 'drain-in-progress', 'connections-open',
  'phone-unavailable', 'background-job', 'delegated-task', 'cron-unknown', 'background-unknown',
] as const;
export const DRAIN_RESTART_STATES = ['waiting', 'probing', 'draining', 'restarting', 'clearing', 'verifying', 'done', 'still-busy', 'failed', 'cancelled'] as const;
export const DRAIN_RESTART_OUTCOMES = ['restarted', 'restart_unverified', 'still_busy', 'foreign_drain', 'marker_lost', 'drain_not_engaged', 'not_running'] as const;
/** One content-free output line from the executor. */
export const drainRestartOutcomeSchema = z.object({ outcome: z.enum(DRAIN_RESTART_OUTCOMES) }).strict();

export const drainRestartRunSchema = z.object({
  id: z.uuid({ version: 'v4' }),
  component: z.enum(DRAIN_RESTART_COMPONENTS),
  when: z.enum(['idle', 'now']),
  state: z.enum(DRAIN_RESTART_STATES),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
  attempts: z.number().int().nonnegative(),
  protocol: z.literal(HERMES_DRAIN_PROTOCOL.version).default(HERMES_DRAIN_PROTOCOL.version),
  probeAttempts: z.number().int().nonnegative().default(0),
  /** The run returns to waiting after releasing its marker for any of these reasons. */
  lastRelease: z.enum(['call-started', 'phone-unavailable', 'chat-at-entry', 'drain-timeout']).optional(),
  /** What held it last time it looked. */
  busy: z.array(z.enum(BUSY_REASONS)).max(BUSY_REASONS.length),
  code: settingsErrorCodeSchema.optional(),
  outcome: z.enum(DRAIN_RESTART_OUTCOMES).optional(),
}).strict().superRefine((run, context) => {
  if (run.component === 'dashboard' && run.when !== 'now') context.addIssue({ code: 'custom', path: ['when'], message: 'the dashboard has no idle restart' });
  const terminal = ['done', 'still-busy', 'failed', 'cancelled'].includes(run.state);
  if (terminal !== (run.endedAt !== undefined)) context.addIssue({ code: 'custom', path: ['endedAt'], message: 'only completed runs have an end time' });
  if (terminal && run.state !== 'cancelled' && run.outcome === undefined) context.addIssue({ code: 'custom', path: ['outcome'], message: 'completed runs report their outcome' });
  if (!terminal && run.outcome !== undefined) context.addIssue({ code: 'custom', path: ['outcome'], message: 'a running executor has no final outcome' });
  if (run.endedAt !== undefined && run.endedAt < run.startedAt) context.addIssue({ code: 'custom', path: ['endedAt'], message: 'a run ends after it starts' });
  if (run.probeAttempts > run.attempts) context.addIssue({ code: 'custom', path: ['probeAttempts'], message: 'probes are drain attempts' });
  const states: Record<string, string> = { restarted: 'done', not_running: 'done', still_busy: 'still-busy',
    restart_unverified: 'failed', foreign_drain: 'failed', marker_lost: 'failed', drain_not_engaged: 'failed' };
  if (run.outcome && states[run.outcome] !== run.state) context.addIssue({ code: 'custom', path: ['outcome'], message: 'the outcome matches the terminal state' });
});
export type DrainRestartRun = z.infer<typeof drainRestartRunSchema>;
/** Pending is acceptance only; terminal outcomes determine both response and audit. */
export function drainRunResult(run: DrainRestartRun): 'pending' | 'ok' | z.infer<typeof settingsErrorCodeSchema> {
  if (run.code) return run.code;
  if (run.endedAt === undefined) return 'pending';
  switch (run.outcome) {
    case 'restarted': return 'ok';
    case 'not_running': return 'target_missing';
    case 'still_busy': return 'still_busy';
    case 'restart_unverified': return 'restart_unverified';
    case 'foreign_drain': case 'marker_lost': case 'drain_not_engaged': return run.outcome;
    default: return 'outcome_unknown';
  }
}
export const drainRestartResultSchema = z.union([
  z.object({ ok: z.literal(true), run: drainRestartRunSchema }).strict(),
  refusal,
]);
/** Accepted runs are pending; only a verified terminal run is completed. */
export const settingsRestartResponseSchema = z.union([
  settingsApplyResponseSchema,
  z.object({ status: z.literal('accepted'), run: drainRestartRunSchema.optional(), timing: timingSchema.optional() }).strict()
    .refine(result => !result.run || drainRunResult(result.run) === 'pending'),
  z.object({ status: z.literal('completed'), run: drainRestartRunSchema, timing: timingSchema.optional() }).strict()
    .refine(result => drainRunResult(result.run) === 'ok'),
  z.object({ status: z.literal('refused'), code: settingsErrorCodeSchema, run: drainRestartRunSchema }).strict()
    .refine(result => drainRunResult(result.run) === result.code),
]);
export type SettingsRestartResponse = z.infer<typeof settingsRestartResponseSchema>;

// ---- usage.summary -----------------------------------------------------------

/** Status-class: summaries only, by role and backend model, for the windows asked for. */
export const usageSummaryRequestSchema = z.object({
  windows: z.array(z.object({ id: z.enum(['today', 'week']), since: z.number().int().nonnegative() }).strict()).min(1).max(2),
}).strict();
export type UsageSummaryRequest = z.infer<typeof usageSummaryRequestSchema>;

const count = z.number().int().nonnegative();
export const usageRowSchema = z.object({
  role: z.enum(GATEWAY_ROLES),
  backend: backendIdSchema.nullable(),
  backendModel: z.string().max(256),
  requests: count,
  errors: count,
  inputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  outputTokens: count,
  /** Price times usage; a provider-reported cost wins. 0 for local backends. */
  estimatedCostUsd: z.number().nonnegative(),
}).strict();
export type UsageRow = z.infer<typeof usageRowSchema>;
export const usageSummaryResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    generatedAt: z.number().int().nonnegative(),
    windows: z.array(z.object({ id: z.enum(['today', 'week']), since: z.number().int().nonnegative(), rows: z.array(usageRowSchema).max(512) }).strict()).max(2),
  }).strict(),
  refusal,
]);
export type UsageSummaryResult = z.infer<typeof usageSummaryResultSchema>;

// ---- The supervisor's own audit ----------------------------------------------

/**
 * One row per unit launch attempt in the supervisor's root-held audit: key names,
 * backup id and hashes. The undo check reads `backupSha256` from here. No field
 * can hold a value.
 */
export const configAuditRowSchema = z.object({
  id: z.uuid({ version: 'v4' }),
  time: z.iso.datetime({ offset: false }),
  caller: z.string().min(1).max(200),
  verb: z.enum(CONFIG_VERBS),
  operation: z.string().regex(OPERATION_ID).optional(),
  target: z.string().min(1).max(64).optional(),
  keys: z.array(z.string().max(512)).max(MAX_OPERATION_KEYS),
  backupId: z.string().regex(BACKUP_ID).optional(),
  backupSha256: sha256Schema.optional(),
  writtenSha256: sha256Schema.optional(),
  change: z.string().regex(CHANGE_ID).optional(),
  result: z.union([z.literal('ok'), settingsErrorCodeSchema]),
}).strict();
export type ConfigAuditRow = z.infer<typeof configAuditRowSchema>;

/** Read-only evidence for one write request; no target values are returned. */
export const configRequestStatusRequestSchema = z.object({ requestId }).strict();
export const configRequestStatusResultSchema = z.union([
  z.object({ ok: z.literal(true), requestId, state: z.enum(['missing', 'pending', 'interrupted']) }).strict(),
  z.object({ ok: z.literal(true), requestId, state: z.literal('terminal'), row: configAuditRowSchema,
    outcome: z.enum(['applied', 'refused', 'outcome_unknown']) }).strict().refine(result => result.requestId === result.row.id),
  refusal,
]);
export type ConfigRequestStatusResult = z.infer<typeof configRequestStatusResultSchema>;
