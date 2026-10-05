// The model gateway's contracts. Consumers name a role (main, coder or fast) at
// a stable loopback address; the role map says which backend serves each role
// right now. Each role has a contract, what every backend it may map to shares,
// so a backend change behind a role never changes what a consumer may send.
// Beside the map, the supervisor and the stack launcher keep two state files:
// which profile is up with any manual overrides, and which consumers were moved
// onto roles with every key's value before the move.
import { z } from 'zod';
import { MAX_OPERATION_KEYS, credentialSecretSchema, keyPathSchema, settingValueSchema, sha256Schema } from './settings.js';

export const GATEWAY_ROLES = ['main', 'coder', 'fast'] as const;
export type GatewayRole = (typeof GATEWAY_ROLES)[number];
export const gatewayRoleSchema = z.enum(GATEWAY_ROLES);

/**
 * The provider names consumers use for the roles, in Hermes' `providers` and
 * pi's catalog alike. The model name a consumer sends is the role itself.
 */
export const ROLE_PROVIDERS: Readonly<Record<GatewayRole, string>> = {
  main: 'wayroost-main',
  coder: 'wayroost-coder',
  fast: 'wayroost-fast',
};
export const ROLE_PROVIDER_IDS = GATEWAY_ROLES.map(role => ROLE_PROVIDERS[role]);

/** How the stack launcher treats consumers: not at all, both ways, or roles only. */
export const GATEWAY_MODES = ['off', 'dual', 'only'] as const;
export type GatewayMode = (typeof GATEWAY_MODES)[number];
export const GATEWAY_MODE_FILE = '/etc/wayroost/gateway-mode';

/** A backend entry's id in the role map: "main-sglang", "coder-local". */
export const BACKEND_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const backendIdSchema = z.string().regex(BACKEND_ID);
/**
 * The provider whose key a backend uses: the file name in the gateway's
 * credentials folder and its LoadCredential name.
 */
export const CREDENTIAL_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const credentialNameSchema = z.string().regex(CREDENTIAL_NAME);
/** Profile and engine names as the stack launcher takes them. */
export const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const ENGINE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A role-map row's key: "<profile>/<engine>". */
export const PROFILE_KEY = /^[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9-]{0,62}$/;

export const INPUT_TYPES = ['text', 'image'] as const;
export type InputType = (typeof INPUT_TYPES)[number];
const inputSchema = z.array(z.enum(INPUT_TYPES)).min(1).max(INPUT_TYPES.length)
  .refine(input => input.includes('text'), 'text input is always part of it')
  .refine(input => new Set(input).size === input.length, 'each input type once');

const tokens = z.number().int().positive().max(16_777_216);

/**
 * What every backend a role may map to shares (the static consumer entries are
 * written to match this, never a backend). `advertisedContext` is the window a
 * static catalog entry states for the role; a backend with a smaller window
 * answers an overflow with its own limit, so it isn't a backend requirement.
 */
export const roleContractSchema = z.object({
  input: inputSchema,
  toolCalling: z.boolean(),
  /** Whether consumers may send a thinking level (pi's thinkingLevelMap). */
  thinkingLevels: z.boolean(),
  maxOutputTokens: tokens,
  advertisedContext: tokens,
}).strict();
export type RoleContract = z.infer<typeof roleContractSchema>;

/** Per-million-token prices in USD; a backend without one costs nothing. */
export const modelPriceSchema = z.object({
  inputPerMillionUsd: z.number().nonnegative().optional(),
  cacheReadPerMillionUsd: z.number().nonnegative().optional(),
  cacheWritePerMillionUsd: z.number().nonnegative().optional(),
  outputPerMillionUsd: z.number().nonnegative().optional(),
}).strict();
export type ModelPrice = z.infer<typeof modelPriceSchema>;

/** Only 127.0.0.0/8, IPv6 ::1 and literal localhost; mapped IPv6 and DNS aliases are excluded. */
export function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  const octets = hostname.split('.');
  if (octets.length === 4 && octets.every(part => /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)) {
    return octets[0] === '127';
  }
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (!host.includes(':') || !/^[0-9a-f:]+$/i.test(host)) return false;
  try { return new URL(`http://[${host}]`).hostname === '[::1]'; } catch { return false; }
}

/**
 * A backend or role address: http on loopback only, https anywhere; no user
 * info, query or fragment, and nothing that could re-route the path (whitespace,
 * backslashes, encoded separators or dots).
 */
export function isGatewayUrl(value: string): boolean {
  if (value.length > 2048 || /[\s\\?#]/.test(value) || /%(?:2f|5c|2e)/i.test(value)) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopbackHost(url.hostname);
}
export const isLoopbackUrl = (value: string): boolean => {
  if (!isGatewayUrl(value)) return false;
  return isLoopbackHost(new URL(value).hostname);
};

export const backendSchema = z.object({
  /** OpenAI-compatible base, with its version path: http://127.0.0.1:19041/v1. */
  baseUrl: z.string().refine(isGatewayUrl, 'an http loopback or https address without user info, query or fragment'),
  /** The model name the backend serves; the gateway rewrites the role to it. */
  servedName: z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/),
  /** Whose key it sends, by credential name; none for a local engine without one. */
  provider: credentialNameSchema.optional(),
  /** The backend's real window, reported to consumers on /v1/models and in overflow answers. */
  contextLength: tokens,
  maxOutputTokens: tokens,
  input: inputSchema,
  toolCalling: z.boolean(),
  thinkingLevels: z.boolean(),
  /**
   * The uid that must own the backend's listening socket. The gateway checks it
   * in the kernel's socket table before sending anything; required on loopback.
   */
  listenerUid: z.number().int().min(0).max(4_294_967_294).optional(),
  price: modelPriceSchema.optional(),
}).strict().superRefine((backend, context) => {
  if (!isGatewayUrl(backend.baseUrl)) return;
  const loopback = isLoopbackUrl(backend.baseUrl);
  if (loopback && backend.listenerUid === undefined) {
    context.addIssue({ code: 'custom', path: ['listenerUid'], message: 'a loopback backend names its listener owner' });
  }
  if (!loopback && backend.listenerUid !== undefined) {
    context.addIssue({ code: 'custom', path: ['listenerUid'], message: 'only a loopback backend has a listener owner' });
  }
});
export type Backend = z.infer<typeof backendSchema>;

/** True when the backend offers at least what the role's contract lets consumers ask for. */
export function backendFitsContract(backend: Pick<Backend, 'input' | 'toolCalling' | 'thinkingLevels' | 'maxOutputTokens'>,
  contract: RoleContract): boolean {
  return contract.input.every(type => backend.input.includes(type))
    && (!contract.toolCalling || backend.toolCalling)
    && (!contract.thinkingLevels || backend.thinkingLevels)
    && backend.maxOutputTokens >= contract.maxOutputTokens;
}

/** Which backend serves each role; null leaves the role unmapped (its connections are reset). */
export const roleMappingSchema = z.object({
  main: backendIdSchema.nullable(),
  coder: backendIdSchema.nullable(),
  fast: backendIdSchema.nullable(),
}).strict();
export type RoleMapping = z.infer<typeof roleMappingSchema>;

export const ROLE_MAP_VERSION = 2;
export const MAX_BACKENDS = 64;
export const MAX_PROFILES = 64;

/**
 * The gateway's role map, kept in its own state folder and changed only through
 * its admin socket. `profiles` holds the mapping for each profile and engine
 * the launcher brings up; `roles` is what serves now (a profile row, or that row
 * with manual overrides).
 */
export const roleMapSchema = z.object({
  version: z.literal(ROLE_MAP_VERSION),
  contracts: z.object({ main: roleContractSchema, coder: roleContractSchema, fast: roleContractSchema }).strict(),
  backends: z.record(backendIdSchema, backendSchema),
  profiles: z.record(z.string().regex(PROFILE_KEY), roleMappingSchema),
  roles: roleMappingSchema,
}).strict().superRefine((map, context) => {
  const backendIds = Object.keys(map.backends);
  if (backendIds.length > MAX_BACKENDS) context.addIssue({ code: 'custom', path: ['backends'], message: `at most ${MAX_BACKENDS} backends` });
  if (Object.keys(map.profiles).length > MAX_PROFILES) context.addIssue({ code: 'custom', path: ['profiles'], message: `at most ${MAX_PROFILES} profiles` });
  const check = (mapping: RoleMapping, path: (string | number)[]) => {
    for (const role of GATEWAY_ROLES) {
      const id = mapping[role];
      if (id === null) continue;
      const backend = Object.hasOwn(map.backends, id) ? map.backends[id] : undefined;
      if (!backend) context.addIssue({ code: 'custom', path: [...path, role], message: 'names a backend the map does not have' });
      else if (!backendFitsContract(backend, map.contracts[role])) {
        context.addIssue({ code: 'custom', path: [...path, role], message: `the backend falls outside the ${role} contract` });
      }
    }
  };
  for (const [key, mapping] of Object.entries(map.profiles)) check(mapping, ['profiles', key]);
  check(map.roles, ['roles']);
});
export type RoleMap = z.infer<typeof roleMapSchema>;

/** Credential names the map uses: the only names the credential verb accepts. */
export function roleMapProviders(map: RoleMap): string[] {
  return [...new Set(Object.values(map.backends).flatMap(backend => backend.provider ? [backend.provider] : []))].sort();
}

// ---- Admin socket (root only) ------------------------------------------------

/** The private status answer supplies actual mappings and backend ownership results. */
const gatewayAdminRoleSchema = z.object({
  backend: backendIdSchema.nullable(),
  backendModel: z.string().max(256).nullable(), contextLength: z.number().int().positive().nullable(),
  contract: roleContractSchema,
  health: z.enum(['up', 'down', 'unmapped', 'owner_mismatch', 'unknown']),
  backendPort: z.number().int().min(1).max(65_535).nullable(),
  inFlight: z.number().int().nonnegative(), openConnections: z.number().int().nonnegative(),
}).strict();
export const gatewayAdminStatusSchema = z.object({
  roles: z.object({ main: gatewayAdminRoleSchema, coder: gatewayAdminRoleSchema, fast: gatewayAdminRoleSchema }).strict(),
  draining: z.boolean(),
}).strict();
export type GatewayAdminStatus = z.infer<typeof gatewayAdminStatusSchema>;

/** Listener identity is checked against the socket unit and the manager's open descriptors. */
const gatewayListenerSchema = z.object({
  address: z.string().max(2048).refine(isLoopbackUrl),
  state: z.enum(['held', 'missing', 'foreign']),
}).strict();
export const gatewayListenersSchema = z.object({
  unit: z.string().regex(/^[A-Za-z0-9@_.:-]+\.socket$/).max(256),
  socketUnit: z.enum(['active', 'activating', 'inactive', 'failed']),
  roles: z.object({ main: gatewayListenerSchema, coder: gatewayListenerSchema, fast: gatewayListenerSchema }).strict(),
}).strict();
export type GatewayListeners = z.infer<typeof gatewayListenersSchema>;

/** Routes on the gateway's admin socket that the supervisor's own program uses. */
export const GATEWAY_ADMIN_ROUTES = {
  role: (role: GatewayRole) => `/v1/roles/${role}`,
  credentialTest: (provider: string) => `/v1/credentials/${encodeURIComponent(provider)}/test`,
} as const;

/**
 * Root reads the stored credential and passes it over the admin socket for one
 * tiny, fixed request to a backend using that provider. It overrides only this
 * request's authentication; neither input nor key is logged or persisted.
 */
export const gatewayCredentialTestBodySchema = z.object({ backend: backendIdSchema, secret: credentialSecretSchema }).strict();
export const CREDENTIAL_TEST_ERRORS = ['credential_missing', 'credential_rejected', 'backend_unavailable', 'test_failed'] as const;
export const gatewayCredentialTestResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), provider: credentialNameSchema, backend: backendIdSchema }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(CREDENTIAL_TEST_ERRORS) }).strict(),
]);
export type GatewayCredentialTestResult = z.infer<typeof gatewayCredentialTestResultSchema>;

/** PUT /v1/roles/<role>: point the role at a backend from the map, or leave it unmapped. */
export const gatewayRepointBodySchema = z.object({ backend: backendIdSchema.nullable() }).strict();
export type GatewayRepointBody = z.infer<typeof gatewayRepointBodySchema>;
export const gatewayRepointResultSchema = z.object({
  role: gatewayRoleSchema,
  backend: backendIdSchema.nullable(),
  applied: z.literal(true),
}).strict();

// ---- State files beside the supervisor ---------------------------------------

/**
 * Root-only files in the supervisor's gateway folder (0700, files 0600). Both
 * writers, the supervisor and the stack launcher, take the lock file first.
 */
export const GATEWAY_STATE_FILES = {
  state: 'gateway-state.json',
  migration: 'gateway-migration.json',
  lock: 'gateway-state.lock',
} as const;

const isoTime = z.iso.datetime({ offset: false });

/** A manual role change, kept until the profile or engine changes. */
export const gatewayOverrideSchema = z.object({
  backend: backendIdSchema,
  at: isoTime,
  by: z.enum(['wayroost', 'launcher']),
}).strict();

/** gateway-state.json: what the launcher brought up last, and manual overrides on top of it. */
export const gatewayStateSchema = z.object({
  version: z.literal(1),
  profile: z.string().regex(PROFILE_ID).nullable(),
  engine: z.string().regex(ENGINE_ID).nullable(),
  broughtUpAt: isoTime.nullable(),
  overrides: z.object({
    main: gatewayOverrideSchema.optional(),
    coder: gatewayOverrideSchema.optional(),
    fast: gatewayOverrideSchema.optional(),
  }).strict(),
}).strict();
export type GatewayState = z.infer<typeof gatewayStateSchema>;

/** Consumers that move onto role addresses one at a time. pi covers its catalog, its default and Paseo's profile. */
export const GATEWAY_CONSUMERS = ['coder-mcp', 'phone', 'hermes', 'pi'] as const;
export type GatewayConsumer = (typeof GATEWAY_CONSUMERS)[number];
export const gatewayConsumerSchema = z.enum(GATEWAY_CONSUMERS);

/** The files a move changes. The phone's is a root-written drop-in on its bridge unit. */
export const MIGRATION_TARGETS = ['hermes-config', 'pi-settings', 'pi-models', 'pi-mcp', 'paseo-config', 'phone-bridge-dropin'] as const;
export type MigrationTarget = (typeof MIGRATION_TARGETS)[number];

/** Which files each consumer's move touches. */
export const CONSUMER_TARGETS: Readonly<Record<GatewayConsumer, readonly MigrationTarget[]>> = {
  'coder-mcp': ['hermes-config', 'pi-mcp'],
  phone: ['phone-bridge-dropin'],
  hermes: ['hermes-config'],
  pi: ['pi-models', 'pi-settings', 'paseo-config'],
};

/** One key's value as recorded: absent counts as a value of its own. */
export const recordedValueSchema = z.union([
  z.object({ exists: z.literal(false) }).strict(),
  z.object({ exists: z.literal(true), value: settingValueSchema }).strict(),
]);
/**
 * A recorded key. `model-dependent` keys (Hermes' model block, pi's default)
 * follow the serving model when a consumer is moved back; every other key gets
 * its value from before the move. `order` records the names of an object's
 * entries in their order (pi's provider order, which is model-dependent too).
 */
export const recordedKeySchema = z.object({
  path: keyPathSchema,
  kind: z.enum(['model-dependent', 'recorded', 'order']),
  before: recordedValueSchema,
  intended: recordedValueSchema,
}).strict();
export type RecordedKey = z.infer<typeof recordedKeySchema>;

export const migrationTargetRecordSchema = z.object({
  moved: z.boolean(),
  movedAt: isoTime.optional(),
  restoredAt: isoTime.optional(),
  /** The file's backup from just before the move, and the file's hash right after it. */
  preMoveBackupSha256: sha256Schema,
  postMoveSha256: sha256Schema,
  keys: z.array(recordedKeySchema).max(MAX_OPERATION_KEYS),
}).strict();
export type MigrationTargetRecord = z.infer<typeof migrationTargetRecordSchema>;

const targetRecord = migrationTargetRecordSchema.optional();
/** gateway-migration.json: per consumer and file, whether it's moved and every key's before and intended values. */
export const gatewayMigrationSchema = z.object({
  version: z.literal(1),
  consumers: z.object({
    'coder-mcp': z.object({ 'hermes-config': targetRecord, 'pi-mcp': targetRecord }).strict().optional(),
    phone: z.object({ 'phone-bridge-dropin': targetRecord }).strict().optional(),
    hermes: z.object({ 'hermes-config': targetRecord }).strict().optional(),
    pi: z.object({ 'pi-models': targetRecord, 'pi-settings': targetRecord, 'paseo-config': targetRecord }).strict().optional(),
  }).strict(),
}).strict();
export type GatewayMigration = z.infer<typeof gatewayMigrationSchema>;
