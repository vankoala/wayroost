// The site file /etc/wayroost/settings-targets.json: where each consumer config
// lives on this PC, who owns it, which lock its writers share and where its
// backups and audit go, plus the few places the config verbs need beside them.
// It's root-owned and read only by the supervisor's config verbs; the previous
// supervisor never reads it, so a rollback is unaffected. `configWrites` turns
// every config write on or off without touching supervisor.json.
import { z } from 'zod';
import { CREDENTIAL_NAME, GATEWAY_ROLES, isLoopbackUrl } from './gateway.js';

export const SETTINGS_TARGETS_FILE = '/etc/wayroost/settings-targets.json';

export { OWNER_FILE_TARGETS, ROOT_TARGETS, READ_ONLY_TARGETS, TARGET_IDS, targetIdSchema,
  type TargetId, type OwnerFileTarget } from './settings.js';

/** A canonical absolute path: no empty, "." or ".." segments, no trailing slash, no control characters. */
export const absolutePathSchema = z.string().max(4096)
  .regex(/^\/[^\x00-\x1f\x7f]*$/, 'an absolute path without control characters')
  .refine(path => path === '/' || path.slice(1).split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'a canonical path');
/** A Unix socket path fits sun_path: 107 bytes and its NUL. */
export const socketPathSchema = absolutePathSchema.refine(path => new TextEncoder().encode(path).length <= 107, 'at most 107 bytes');

/** Lexical separation only; the runtime executor must check symlinks and realpaths before using storage. */
export function storagePathsApart(paths: readonly string[]): boolean {
  if (paths.some(path => !absolutePathSchema.safeParse(path).success)) return false;
  return paths.every((path, index) => paths.slice(index + 1).every(other => path !== other
    && !other.startsWith(path === '/' ? path : path + '/') && !path.startsWith(other === '/' ? other : other + '/')));
}

export const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
/**
 * The account a target's unit runs as, checked against the file's real owner
 * before any edit. Consumer files never run as root: root never opens a path a
 * consumer's owner can change.
 */
export const ownerSchema = z.object({
  user: z.string().regex(USER_NAME),
  uid: z.number().int().min(0).max(4_294_967_294),
}).strict();
const consumerOwnerSchema = ownerSchema.refine(owner => owner.uid !== 0 && owner.user !== 'root', 'a consumer file is never edited or read as root');

export const UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,200}\.service$/;
export const SOCKET_UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,200}\.socket$/;
/** Visible drop-ins with a nonempty basename; punctuation and suffixes outside this set are refused. */
export const CREDENTIAL_DROP_IN_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.conf$/;

/**
 * The lock a target's writers share: a lock file every writer takes; pi's own lock, which pi
 * also takes to read; or Wayroost's Paseo config lock. Every kind names the exact
 * shared path; a writer must never choose a private fallback path.
 */
const fileLock = z.object({ kind: z.literal('file'), path: absolutePathSchema }).strict();
const piLock = z.object({ kind: z.literal('pi'), path: absolutePathSchema }).strict();
const paseoLock = z.object({ kind: z.literal('paseo'), path: absolutePathSchema }).strict();

const ownerFileFields = {
  path: absolutePathSchema,
  runAs: consumerOwnerSchema,
  /** When set, the file's mode must be exactly this before an edit, and stays so after it. */
  mode: z.number().int().min(0).max(0o7777).optional(),
  backupDir: absolutePathSchema,
  auditDir: absolutePathSchema,
};
const storageApart = (target: { path: string; backupDir: string; auditDir: string; lock?: { kind: string; path?: string } }, context: z.RefinementCtx) => {
  const paths = [target.path, target.backupDir, target.auditDir, ...(target.lock?.path ? [target.lock.path] : [])];
  if (!storagePathsApart(paths)) {
    context.addIssue({ code: 'custom', message: 'target, lock, backups and audit must be distinct with no path inside another' });
  }
};

const hermesConfigTarget = z.object({ ...ownerFileFields, format: z.literal('yaml'), lock: fileLock,
  /** The installed Hermes interpreter and import root used to resolve effective config. */
  resolver: z.object({ python: absolutePathSchema, modulePath: absolutePathSchema,
    /** Startup HOME, independent of the profile's HERMES_HOME; defaults to the owner process's home. */
    home: absolutePathSchema.optional(),
    /** Approved non-secret startup variables, passed to Hermes' own environment loader. */
    environment: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/).refine(name =>
      !/^(?:LD_|DYLD_|PYTHON|NODE_|BASH_ENV$|ENV$|HOME$|PATH$|HERMES_HOME$)/.test(name)
      && !/(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(?:_|$)/.test(name)), z.string().max(4096))
      .refine(environment => Object.keys(environment).length <= 128).optional(),
  }).strict().optional(),
}).strict().superRefine(storageApart);
const piSettingsTarget = z.object({ ...ownerFileFields, format: z.literal('json'), lock: piLock }).strict().superRefine(storageApart);
const piJsonTarget = z.object({ ...ownerFileFields, format: z.literal('json'), lock: fileLock }).strict().superRefine(storageApart);
const paseoConfigTarget = z.object({
  ...ownerFileFields,
  format: z.literal('json'),
  lock: paseoLock,
  /**
   * The installed daemon's own module exporting readPersistedConfig. An edited
   * document is checked with it on a private copy, so a key the daemon would
   * refuse at load is refused here. It must pass the root-only trust walk.
   */
  loader: absolutePathSchema,
}).strict().superRefine(storageApart);

const readOnlyTarget = (formats: readonly [string, ...string[]]) => z.object({
  path: absolutePathSchema,
  runAs: consumerOwnerSchema,
  format: z.enum(formats),
  /** A Windows file seen through drvfs (CRLF, root:root 0777 as WSL shows it): read with O_NOFOLLOW only. */
  drvfs: z.boolean().default(false),
}).strict();

const gatewayRoleMapTarget = z.object({
  /** The map at its resolved path inside the gateway's state folder (no systemd link on the way). */
  path: absolutePathSchema,
  /** The packaged default the gateway's own user seeds the map from. */
  defaultMap: absolutePathSchema,
  /** The gateway's admin socket, reachable by root only. */
  adminSocket: socketPathSchema,
  service: z.string().regex(UNIT_NAME),
  /** The socket unit that holds the role listeners through restarts. */
  socket: z.string().regex(SOCKET_UNIT_NAME),
}).strict();

const gatewayCredentialsTarget = z.object({
  /** One file per provider, named by its credential name; root, 0600. */
  directory: absolutePathSchema,
  /** The drop-in holding one LoadCredential= line per provider; root, 0644. */
  dropIn: absolutePathSchema,
  service: z.string().regex(UNIT_NAME),
  lockFile: absolutePathSchema,
  /** Backups of the drop-in. Keys themselves are never backed up. */
  backupDir: absolutePathSchema,
}).strict().superRefine((target, context) => {
  const slash = target.dropIn.lastIndexOf('/');
  if (target.dropIn.slice(0, slash) !== `/etc/systemd/system/${target.service}.d` || !CREDENTIAL_DROP_IN_NAME.test(target.dropIn.slice(slash + 1))) {
    context.addIssue({ code: 'custom', path: ['dropIn'], message: "a visible .conf file directly in the gateway service's own drop-in folder" });
  }
  if (!storagePathsApart([target.directory, target.dropIn, target.lockFile, target.backupDir])) {
    context.addIssue({ code: 'custom', message: 'credentials, drop-in, lock and backups must be distinct with no path inside another' });
  }
});

const gatewayStateTarget = z.object({
  /** The supervisor's gateway folder: root, 0700. File names are fixed (GATEWAY_STATE_FILES). */
  directory: absolutePathSchema,
  backupDir: absolutePathSchema,
}).strict().refine(target => storagePathsApart([target.directory, target.backupDir]), { path: ['backupDir'], message: 'backups live outside the state folder' });

const loopbackUrlSchema = z.string().refine(isLoopbackUrl, 'an http loopback address');

export const settingsTargetsSchema = z.object({
  version: z.literal(1),
  /** Every config write (apply, undo, credentials, drain-restart). Off until switched on; reads work either way. */
  configWrites: z.boolean().default(false),
  switchFlags: z.object({ path: absolutePathSchema, runAs: consumerOwnerSchema }).strict().optional(),
  /** Fixed CLI status probes run in a read-only unit as this configuration owner. */
  agentStatus: z.object({ home: absolutePathSchema, runAs: consumerOwnerSchema, binaries: z.object({
    claude: absolutePathSchema.optional(), codex: absolutePathSchema.optional(), copilot: absolutePathSchema.optional(),
  }).strict() }).strict().optional(),
  targets: z.object({
    'hermes-config': hermesConfigTarget.optional(),
    'pi-settings': piSettingsTarget.optional(),
    'pi-models': piJsonTarget.optional(),
    'pi-mcp': piJsonTarget.optional(),
    'paseo-config': paseoConfigTarget.optional(),
    'wayroost-settings': piJsonTarget.optional(),
    'gateway-role-map': gatewayRoleMapTarget.optional(),
    'gateway-credentials': gatewayCredentialsTarget.optional(),
    'gateway-state': gatewayStateTarget.optional(),
    'hermes-managed': readOnlyTarget(['yaml']).optional(),
    'windows-hermes': readOnlyTarget(['yaml']).optional(),
    'claude-settings': readOnlyTarget(['json']).optional(),
    'codex-config': readOnlyTarget(['toml']).optional(),
    'opencode-config': readOnlyTarget(['json']).optional(),
  }).strict(),
  /** The role addresses consumers are pointed at: http://127.0.0.1:<port>/v1, one per role. */
  roleAddresses: z.object(Object.fromEntries(GATEWAY_ROLES.map(role => [role, loopbackUrlSchema])) as
    Record<(typeof GATEWAY_ROLES)[number], typeof loopbackUrlSchema>).strict().optional(),
  /** The coder MCP's script: the original registrations name, and the root-owned copy a move points them at. */
  coderMcp: z.object({ original: absolutePathSchema, gatewayCopy: absolutePathSchema }).strict()
    .refine(paths => paths.original !== paths.gatewayCopy, 'two different scripts').optional(),
  /**
   * Where the key import finds each local backend's key: the provider entry of
   * that name in pi's catalog, read as the catalog's owner and handed to root.
   */
  keySources: z.array(z.object({
    provider: z.string().regex(CREDENTIAL_NAME),
    piProvider: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  }).strict()).max(32).default([]),
  /** What the Hermes drain-restart reads and runs. */
  hermes: z.object({
    /** The account whose systemd user manager runs the gateway. */
    runAs: consumerOwnerSchema,
    gatewayUnit: z.string().regex(UNIT_NAME),
    dashboardUnit: z.object({ name: z.string().regex(UNIT_NAME), scope: z.enum(['system', 'user']) }).strict(),
    /** Hermes' gateway_state.json (its active_agents count). */
    stateFile: absolutePathSchema,
    /** The main cron store; every profile's cron store is discovered under profilesDir too. */
    cronJobs: absolutePathSchema,
    profilesDir: absolutePathSchema,
    /** Running processes and async delegations are checked before and during a drain. */
    processesFile: absolutePathSchema,
    stateDatabase: absolutePathSchema,
    /** Owner-only durable restart state, written before side effects. */
    drainStateDir: absolutePathSchema,
    /** Hermes' drain marker; a leftover one is removed at supervisor start by a unit running as `runAs` here. */
    drainMarker: z.object({ path: absolutePathSchema, runAs: consumerOwnerSchema }).strict(),
    /** The phone server's /health (its active_calls); absent when there is no phone line. */
    phoneHealth: loopbackUrlSchema.optional(),
  }).strict().optional(),
}).strict().superRefine((file, context) => {
  const storage = Object.values(file.targets).flatMap(target => Object.entries(target)
    .flatMap(([field, value]) => {
      if (field === 'lock') return [(value as { path: string }).path];
      return ['path', 'directory', 'backupDir', 'auditDir', 'lockFile', 'dropIn', 'defaultMap', 'adminSocket'].includes(field)
        ? [value as string] : [];
    }));
  if (file.hermes) {
    const hermes = file.hermes;
    storage.push(hermes.stateFile, hermes.cronJobs, hermes.profilesDir, hermes.processesFile,
      hermes.stateDatabase, hermes.drainStateDir, hermes.drainMarker.path);
  }
  if (!storagePathsApart(storage)) {
    context.addIssue({ code: 'custom', message: 'all target and drain files, locks and storage roots must be distinct with no path inside another' });
  }
  const providers = file.keySources.map(source => source.provider);
  if (new Set(providers).size !== providers.length) {
    context.addIssue({ code: 'custom', path: ['keySources'], message: 'each provider once' });
  }
  if (file.keySources.length > 0 && !file.targets['pi-models']) {
    context.addIssue({ code: 'custom', path: ['keySources'], message: "key sources read pi's catalog, which needs its target" });
  }
  if (file.roleAddresses && Object.values(file.roleAddresses).every(isLoopbackUrl)) {
    const ports = Object.values(file.roleAddresses).map(address => {
      const url = new URL(address);
      return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    });
    if (new Set(ports).size !== ports.length) {
      context.addIssue({ code: 'custom', path: ['roleAddresses'], message: 'each role on its own port' });
    }
  }
});
export type SettingsTargets = z.infer<typeof settingsTargetsSchema>;
