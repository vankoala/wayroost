// What a check may look at, gathered once per page load. Every source is an
// injected function: the supervisor's config.read and status, the gateway's
// health answers, the phone's health answers, a bounded process list, the drain
// marker, the directory-rule preflight, the desktop switch's flag file, the
// revoked "always" entries and the server's own recent changes.
// Collection is bounded: each source gets its own timeout inside an overall
// budget, and every answer is checked against its contract before a check sees
// it. A source that is missing, slow, or answers out of shape becomes an
// unavailable observation, so the checks that needed it answer "unknown" and the
// rest of the page still fills in.
import { intendedKeySchema, type IntendedKey } from './state.js';
import { z } from 'zod';
import { configReadResultSchema, HERMES_DRAIN_PROTOCOL } from '../../../shared/supervisor-config.js';
import { GATEWAY_ROLES, gatewayAdminStatusSchema, gatewayListenersSchema, type GatewayRole, type GatewayListeners } from '../../../shared/gateway.js';
import { READ_VIEW_IDS, type ReadViewId } from '../../../shared/settings-ops.js';
import {
  MAX_OPERATION_KEYS, keyPathSchema, settingValueSchema, settingsErrorCodeSchema,
  type KeyPath, type SettingValue, type SettingsErrorCode, type TargetId,
} from '../../../shared/settings.js';
import type { SupervisorStatus } from '../../../shared/supervisor.js';

/** Per source: a slow answer is dropped, not waited on forever. */
export const CHECK_SOURCE_TIMEOUT_MS = 2_000;
export const CHECK_PHONE_SOURCE_TIMEOUT_MS = HERMES_DRAIN_PROTOCOL.timing.phoneTimeoutSeconds * 1000 + 500;
/** The whole snapshot: past this, whatever is still in the air counts as unread. */
export const CHECK_SNAPSHOT_BUDGET_MS = 15_000;
/** Bounds on the lists a source may return. */
export const MAX_CHECK_VIEWS = READ_VIEW_IDS.length;
export const MAX_PROCESSES_SEEN = 256;
export const MAX_REVOCATIONS_SEEN = 64;
export const MAX_ORDER_NAMES = 512;

export type SourceFailure = 'not_configured' | 'failed' | 'timeout';
export type Observation<T> = { ok: true; value: T } | { ok: false; failure: SourceFailure; code?: SettingsErrorCode };
export const isAvailable = (observation: Observation<unknown> | undefined): boolean => observation?.ok === true;

/** One config.read view: the file's content hash, its allowlisted values, and their order. */
export interface ViewSnapshot {
  present: boolean;
  sha256?: string;
  document: Record<string, unknown>;
  values: { path: KeyPath; exists: boolean; value?: SettingValue }[];
  /** An object's entry names in the file's order, keyed by the path that holds them. */
  order: Record<string, string[]>;
}

export const BACKEND_HEALTH_STATES = ['up', 'down', 'unmapped', 'owner_mismatch', 'unknown'] as const;
export const GATEWAY_SOCKET_UNIT_STATES = ['active', 'activating', 'inactive', 'failed'] as const;

/** What the gateway's listeners and its socket unit say right now. */
export interface GatewaySnapshot {
  /** GET /healthz on each role listener answered with 200 in time. */
  healthz: Record<GatewayRole, boolean>;
  /** Null when this PC cannot say what state it is in. */
  socketUnit: (typeof GATEWAY_SOCKET_UNIT_STATES)[number] | null;
  /** Ports with a listening socket, as the kernel's socket table gives them. */
  listeningPorts: number[] | null;
  listeners?: Observation<GatewayListeners>;
  /** What each role's own listener answers about the backend behind it. */
  roles: Record<GatewayRole, { health: (typeof BACKEND_HEALTH_STATES)[number] }>;
  status?: Observation<import('../../../shared/gateway.js').GatewayAdminStatus>;
  /** A drain is holding new connections. */
  draining: boolean | null;
}
const observationOf = <T extends z.ZodTypeAny>(value: T) => z.union([
  z.object({ ok: z.literal(true), value }).strict(),
  z.object({ ok: z.literal(false), failure: z.enum(['not_configured', 'failed', 'timeout']), code: settingsErrorCodeSchema.optional() }).strict(),
]);
export const gatewaySnapshotSchema: z.ZodType<GatewaySnapshot> = z.object({
  healthz: z.object(Object.fromEntries(GATEWAY_ROLES.map(role => [role, z.boolean()]))).strict(),
  socketUnit: z.enum(GATEWAY_SOCKET_UNIT_STATES).nullable(),
  listeningPorts: z.array(z.number().int().min(1).max(65_535)).max(64).nullable(),
  listeners: observationOf(gatewayListenersSchema).optional(),
  roles: z.object(Object.fromEntries(GATEWAY_ROLES.map(role => [role, z.object({
    health: z.enum(BACKEND_HEALTH_STATES),
  }).strict()]))).strict(),
  draining: z.boolean().nullable(),
  status: observationOf(gatewayAdminStatusSchema).optional(),
}).strict() as unknown as z.ZodType<GatewaySnapshot>;

const counters = { activeCalls: z.number().int().nonnegative(), webhooks: z.number().int().nonnegative(), outboundCalls: z.number().int().nonnegative() };
/** The phone server's counters beside the bridge's; either may be unreadable on its own. */
export interface PhoneSnapshot {
  server: Observation<{ activeCalls: number; webhooks: number; outboundCalls: number }>;
  /** `oldestCallMs` is the age of the bridge's oldest call record, 0 when it has none. */
  bridge: Observation<{ activeCalls: number; oldestCallMs: number }>;
  pin?: Observation<{ address: string; model: string }>;
  quietForMs?: number | null;
  excessForMs?: number | null;
}
export const phoneSnapshotSchema = z.object({
  quietForMs: z.number().nonnegative().nullable().optional(),
  excessForMs: z.number().nonnegative().nullable().optional(),
  pin: observationOf(z.object({ address: z.string().min(1).max(2048), model: z.string().min(1).max(256) }).strict()).optional(),
  server: observationOf(z.object(counters).strict()),
  bridge: observationOf(z.object({ activeCalls: z.number().int().nonnegative(), oldestCallMs: z.number().int().nonnegative() }).strict()),
}).strict();

/** One running coder MCP: when it started, and which registered copy it runs. */
export interface CoderProcess { startedAt: number; script: 'gateway-copy' | 'original' | 'other' }
export const coderProcessListSchema = z.array(z.object({
  startedAt: z.number().int().nonnegative(),
  script: z.enum(['gateway-copy', 'original', 'other']),
}).strict()).max(MAX_PROCESSES_SEEN);

/** Hermes' drain marker, read through the safe reader. */
export interface DrainMarkerSnapshot {
  present: boolean;
  /** Whether the marker's principal is Wayroost's; the principal itself is never kept. */
  ours: boolean;
  requestedAt: number;
  /** A Wayroost drain-restart is running now, so a marker of ours is expected. */
  drainRunning: boolean | null;
  /** The marker file couldn't be read at all: a link, too large, or unreadable. */
  unreadable: boolean;
}
export const drainMarkerSnapshotSchema = z.object({
  present: z.boolean(), ours: z.boolean(), requestedAt: z.number().int().nonnegative(),
  drainRunning: z.boolean().nullable(), unreadable: z.boolean(),
}).strict();

/** The directory-rule preflight's answer, named by target id. */
export interface DirectoryRuleSnapshot { passed: string[]; refused: string[] }
export const directoryRuleSnapshotSchema = z.object({
  passed: z.array(z.string().min(1).max(64)).max(64),
  refused: z.array(z.string().min(1).max(64)).max(64),
}).strict();

/**
 * One "always" answer Wayroost revoked, and when. The hash is the revoke
 * operation's own parameter: a PC whose record of it is durable can compare the
 * list, and one that only knows the time cannot.
 */
/**
 * What a check needs from the server's settings audit about a past change: its id,
 * when it was asked for, what it was, and how it ended. Ids, names and result codes.
 */
export interface ChangeFact {
  id: string;
  at: number;
  action: 'apply' | 'undo' | 'credential' | 'restart';
  operation?: string;
  target?: string;
  result: string;
}
export const changeFactListSchema = z.array(z.object({
  id: z.string().min(1).max(64),
  at: z.number().int().nonnegative(),
  action: z.enum(['apply', 'undo', 'credential', 'restart']),
  operation: z.string().max(64).optional(),
  target: z.string().max(64).optional(),
  result: z.string().max(64),
})).max(64);

export interface AlwaysRevocation { entrySha256?: string; revokedAt: number }
export const revocationListSchema = z.array(z.object({
  entrySha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  revokedAt: z.number().int().nonnegative(),
}).strict()).max(MAX_REVOCATIONS_SEEN);

/** Facts about this PC that don't come from a file the checks read. */
export interface ChecksDeployment {
  /** The address each role is served at, from the site file. */
  roleAddresses?: Partial<Record<GatewayRole, string>>;
  /** The coder MCP's two scripts: the original, and the copy a move points at. */
  coderMcp?: { original: string; gatewayCopy: string };
  /** How this PC's supervisor is meant to be configured. */
  supervisor?: { configWrites: boolean; statusOnly: boolean };
  /** Targets this PC has a place for; a target with no entry isn't here. */
  targets?: readonly TargetId[];
}

export const paseoRuntimeSnapshotSchema = z.object({
  providers: z.record(z.string().max(64), z.object({ enabled: z.boolean(), models: z.array(z.string().max(256)).max(512) }).strict()),
  agents: z.array(z.object({ id: z.string().max(128), provider: z.string().max(64), model: z.string().max(256).nullable() }).strict()).max(256),
}).strict();
export type PaseoRuntimeSnapshot = z.infer<typeof paseoRuntimeSnapshotSchema>;

export interface CheckSnapshot {
  at: number;
  deployment: ChecksDeployment;
  views: Partial<Record<ReadViewId, Observation<ViewSnapshot>>>;
  supervisor: Observation<SupervisorStatus>;
  gateway: Observation<GatewaySnapshot>;
  phone: Observation<PhoneSnapshot>;
  coderProcesses: Observation<CoderProcess[]>;
  drainMarker: Observation<DrainMarkerSnapshot>;
  directoryRule: Observation<DirectoryRuleSnapshot>;
  switchFlags: Observation<Record<string, boolean>>;
  revocations: Observation<AlwaysRevocation[]>;
  changes: Observation<ChangeFact[]>;
  intended: Observation<IntendedKey[]>;
  hermesStartedAt: Observation<number>;
  paseoRuntime: Observation<PaseoRuntimeSnapshot>;
}

/** Anything a PC doesn't have simply isn't provided. */
export interface ChecksSources {
  readView?(view: ReadViewId): Promise<unknown>;
  supervisorStatus?(): Promise<SupervisorStatus | null>;
  gateway?(): Promise<GatewaySnapshot>;
  phone?(): Promise<PhoneSnapshot>;
  coderProcesses?(): Promise<CoderProcess[]>;
  drainMarker?(): Promise<DrainMarkerSnapshot>;
  directoryRule?(): Promise<DirectoryRuleSnapshot>;
  switchFlags?(): Promise<Record<string, boolean>>;
  revocations?(): Promise<AlwaysRevocation[]>;
  recentChanges?(): Promise<ChangeFact[]>;
  intended?(): Promise<IntendedKey[]>;
  hermesStartedAt?(): Promise<number>;
  paseoRuntime?(): Promise<PaseoRuntimeSnapshot>;
}

export interface CollectOptions {
  now?: () => number;
  sourceTimeoutMs?: number;
  phoneTimeoutMs?: number;
  gatewayTimeoutMs?: number;
  ownerTimeoutMs?: number;
  budgetMs?: number;
  /** Which views to read; the engine passes exactly the ones its checks name. */
  views?: readonly ReadViewId[];
}

class SourceTimedOut extends Error {}

const notConfigured = <T>(): Observation<T> => ({ ok: false, failure: 'not_configured' });
const unreadable = <T>(code?: SettingsErrorCode): Observation<T> => ({ ok: false, failure: 'failed', ...(code ? { code } : {}) });

/** Run one source inside the remaining budget; whatever it throws or answers late is an observation. */
async function gather<T, R = T>(run: (() => Promise<T>) | undefined, remaining: () => number, timeoutMs: number,
  check: (value: T) => Observation<R>): Promise<Observation<R>> {
  if (!run) return notConfigured();
  const left = remaining();
  if (left <= 0) return { ok: false, failure: 'timeout' };
  const limit = Math.max(1, Math.min(timeoutMs, left));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new SourceTimedOut()), limit);
      void run().then(resolve, reject);
    });
    return check(value);
  } catch (error) {
    return error instanceof SourceTimedOut ? { ok: false, failure: 'timeout' } : unreadable();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The values a config.read answered, rebuilt into a plain document for lookup. */
function documentOf(values: ViewSnapshot['values']): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  for (const entry of values) {
    if (!entry.exists) continue;
    let container: Record<string | number, unknown> = document;
    for (const [index, segment] of entry.path.entries()) {
      if (typeof segment === 'object' || segment === '__proto__') throw new Error('unreadable view');
      if (index === entry.path.length - 1) {
        Object.defineProperty(container, segment, { value: entry.value ?? null, writable: true, enumerable: true, configurable: true });
      } else {
        if (!Object.hasOwn(container, segment)) Object.defineProperty(container, segment, {
          value: typeof entry.path[index + 1] === 'number' ? [] : {}, writable: true, enumerable: true, configurable: true,
        });
        const next = container[segment];
        if (!next || typeof next !== 'object') throw new Error('unreadable view');
        container = next as Record<string | number, unknown>;
      }
    }
  }
  return document;
}

function checkView(result: unknown, expectedView: ReadViewId): Observation<ViewSnapshot> {
  const parsed = configReadResultSchema.safeParse(result);
  if (!parsed.success) return unreadable();
  if (!parsed.data.ok) return unreadable(parsed.data.code);
  const answer = parsed.data;
  if (answer.view !== expectedView) return unreadable();
  if (!answer.present && !answer.effective) return { ok: true, value: { present: false, document: {}, values: [], order: {} } };
  try {
    const values = answer.values.map(entry => ({
      path: keyPathSchema.parse(entry.path) as KeyPath,
      exists: entry.exists,
      ...(entry.exists && 'value' in entry ? { value: settingValueSchema.parse(entry.value) } : {}),
    }));
    const order: Record<string, string[]> = {};
    for (const entry of answer.order ?? []) {
      order[formatPath(keyPathSchema.parse(entry.path))] = entry.names.slice(0, MAX_ORDER_NAMES);
    }
    return { ok: true, value: { present: answer.present, sha256: answer.sha256, document: documentOf(values), values, order } };
  } catch { return unreadable(); }
}

function formatPath(path: readonly (string | number | { id: string })[]): string {
  return path.map(segment => typeof segment === 'number' ? `[${segment}]` : typeof segment === 'object' ? segment.id : segment).join('.');
}

const isSupervisorStatus = (value: unknown): value is SupervisorStatus => isRecord(value)
  && (value.overall === 'ok' || value.overall === 'attention' || value.overall === 'down')
  && typeof value.sentence === 'string' && Array.isArray(value.components) && typeof value.at === 'number';

/** Read every source at once, inside one budget, and never let one of them throw. */
export async function collectSnapshot(sources: ChecksSources, deployment: ChecksDeployment = {}, options: CollectOptions = {}): Promise<CheckSnapshot> {
  const now = options.now ?? Date.now;
  const started = now();
  const timeoutMs = options.sourceTimeoutMs ?? CHECK_SOURCE_TIMEOUT_MS;
  const budgetMs = options.budgetMs ?? CHECK_SNAPSHOT_BUDGET_MS;
  const remaining = () => started + budgetMs - now();
  const viewIds = (options.views ?? READ_VIEW_IDS).filter(id => (READ_VIEW_IDS as string[]).includes(id)).slice(0, MAX_CHECK_VIEWS);
  const checkedViews = Promise.all(viewIds.map(async id => [id, await gather(
    sources.readView ? () => sources.readView!(id) : undefined, remaining, timeoutMs, result => checkView(result, id))] as const));
  const list = <T>(run: (() => Promise<T>) | undefined, schema: z.ZodType<T>, limitMs = timeoutMs): Promise<Observation<T>> =>
    gather(run, remaining, limitMs, value => {
      const parsed = schema.safeParse(value);
      return parsed.success ? { ok: true, value: parsed.data } : unreadable<T>();
    });
  const [supervisor, gateway, phone, coderProcesses, drainMarker, directoryRule, switchFlags, revocations, changes, intended, hermesStartedAt, paseoRuntime] = await Promise.all([
    gather(sources.supervisorStatus, remaining, timeoutMs, value =>
      value === null || value === undefined || !isSupervisorStatus(value) ? unreadable<SupervisorStatus>() : { ok: true, value }),
    gather(sources.gateway, remaining, options.gatewayTimeoutMs ?? timeoutMs, value => {
      const parsed = gatewaySnapshotSchema.safeParse(value);
      return parsed.success ? { ok: true, value: parsed.data } : unreadable<GatewaySnapshot>();
    }),
    gather(sources.phone, remaining, options.phoneTimeoutMs ?? options.sourceTimeoutMs ?? CHECK_PHONE_SOURCE_TIMEOUT_MS, value => {
      const parsed = phoneSnapshotSchema.safeParse(value);
      return parsed.success ? { ok: true, value: parsed.data } : unreadable<PhoneSnapshot>();
    }),
    list(sources.coderProcesses, coderProcessListSchema, options.ownerTimeoutMs),
    list(sources.drainMarker, drainMarkerSnapshotSchema, options.ownerTimeoutMs),
    list(sources.directoryRule, directoryRuleSnapshotSchema),
    list(sources.switchFlags, z.record(z.string().max(64), z.boolean()), options.ownerTimeoutMs),
    list(sources.revocations, revocationListSchema),
    list(sources.recentChanges, changeFactListSchema),
    list(sources.intended, z.array(intendedKeySchema).max(MAX_OPERATION_KEYS)),
    list(sources.hermesStartedAt, z.number().int().positive(), options.ownerTimeoutMs),
    list(sources.paseoRuntime, paseoRuntimeSnapshotSchema),
  ]);
  return {
    at: started,
    deployment,
    views: Object.fromEntries(await checkedViews) as CheckSnapshot['views'],
    supervisor, gateway, phone, coderProcesses, drainMarker, directoryRule, switchFlags, revocations, changes, intended, hermesStartedAt, paseoRuntime,
  };
}

/** The refusal that made a source unavailable, as a fixed code. */
export function refusalCode(observation: Observation<unknown>): SettingsErrorCode | undefined {
  return observation.ok ? undefined : observation.code;
}
