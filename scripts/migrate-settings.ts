import { constants } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { access, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { WORKER_APPROVAL_TOOLS } from '../shared/safety.js';
import { DEFAULT_NOTIFICATION_RULES, DEFAULT_QUIET_HOURS, settingsNotificationsBodySchema } from '../shared/settings.js';
import { absolutePathSchema, settingsTargetsSchema, UNIT_NAME, storagePathsApart, type SettingsTargets } from '../shared/settings-targets.js';
import { appReadAloudSchema, localVoiceSchema, workerUpdatesSchema, wayroostSettingsSchema, type WayroostSettingsDocument } from '../shared/wayroost-settings.js';
import { PROACTIVITY_LEVELS } from '../shared/protocol.js';
import { parseConfig, ConfigError as LegacyConfigError } from '../server/src/config.js';
import { wayroostEnv } from '../server/src/environment.js';
import { parseLegacyJson, legacyObject, readLegacyNotifications, readLegacyFeed, readLegacyWorkerUpdates, readLegacyVoice,
  readLegacySafetyCommands, readLegacyApprovalState, readLegacyPaseo, editableLegacyProviders, legacyProvidersSchema as providersSchema,
  legacyApprovalBackupSchema as backupSchema, legacyApprovalStateSchema as approvalStateSchema, legacyFeedSchema,
  LEGACY_PASEO_MAX_BYTES, LEGACY_APPROVAL_MAX_BYTES, LEGACY_NOTIFICATION_MAX_BYTES, LEGACY_NOTIFICATION_FORBIDDEN_MODE, decodeLegacyNotifications, legacyPaseoSchema, type LegacyRead } from '../shared/legacy-settings.js';
import { SettingsWriteThrough, settingsLockPath, withSettingsFileLock, type SettingOperation, type SettingValue } from '../server/src/settings/write-through.js';
import { jsonEditor } from '../server/src/settings/editors/json.js';
import { validatePath, validateValue } from '../server/src/settings/editors/types.js';
import { withConsumerLock, type FileTarget } from '../supervisor/src/config-locks.js';
import { checkConfigDirectory, ConfigError, digest, loadSettingsTargets, readConfigFile } from '../supervisor/src/config-paths.js';
import { configBackupDirectory, preflightTarget, validateInstalledPaseo } from '../supervisor/src/config-executor.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const cloudIds = ['claude', 'codex', 'opencode'] as const;
type Document = Record<string, SettingValue>;
type Providers = z.infer<typeof providersSchema>;
type Snapshot = { document: Document; source: string | null; sha256: string | null; mode: number; gid: number; bytes?: Buffer; validUtf8?: boolean; legacy?: boolean; restoration?: boolean };
type DocumentReader = { parse: (source: string) => unknown; maxBytes?: number; forbiddenMode?: number; decode?: (bytes: Buffer) => string };
type Legacy = { paseo: Snapshot; config: Snapshot; stores: Record<string, Snapshot>; settings: WayroostSettingsDocument; providers: Providers };
class MigrationError extends Error {}
class MixedPolicyError extends MigrationError {
  constructor() { super('Unsupported mixed provider approval policies; reverse requires an explicit legacy adapter.'); }
}
class OwnerRequiredError extends MigrationError {
  constructor() { super('Settings migration must run as the configured owner, never root.'); }
}
export interface MigrationOptions {
  mode: 'plan' | 'forward' | 'verify' | 'reverse';
  site: SettingsTargets;
  legacyDir: string;
  legacyPaseo: string;
  legacyConfig: string;
  units: string[];
}
export interface MigrationDependencies {
  uid?: number;
  stopped?: (unit: string) => Promise<boolean>;
  validatePaseo?: typeof validateInstalledPaseo;
  lock?: typeof withConsumerLock;
  preflightLock?: typeof withConsumerLock;
  env?: NodeJS.ProcessEnv;
  systemctl?: (args: string[]) => Promise<{ code: number; stdout: string }>;
}
const storeNames = ['wayroost-settings.json', 'hermes-safety-commands.json', 'worker-updates.json', 'voice.json', 'feed.json', 'worker-approvals.json'] as const;
const object = (value: unknown): Document => z.record(z.string(), z.json()).parse(value) as Document;
const legacyDocument = (value: unknown): Document => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError('parse_failed');
  return value as Document;
};
const clone = <T>(value: T): T => structuredClone(value);
const primaryMaxBytes = 4 * 1024 * 1024;
const legacyPreferenceReader = {
  maxBytes: Infinity,
  decode: (bytes: Buffer): string => bytes.toString('utf8'),
  parse(source: string): SettingValue {
    // JSON.parse preserves the legacy last-key-wins behaviour and rejects a BOM.
    try { return parseLegacyJson(source) as SettingValue; }
    catch { throw new ConfigError('parse_failed'); }
  },
};
const legacyNotificationReader = { ...legacyPreferenceReader, maxBytes: LEGACY_NOTIFICATION_MAX_BYTES, forbiddenMode: LEGACY_NOTIFICATION_FORBIDDEN_MODE,
  decode(bytes: Buffer): string {
    try { return decodeLegacyNotifications(bytes); } catch { throw new ConfigError('parse_failed'); }
  },
};
const legacyPaseoReader = { ...legacyPreferenceReader, maxBytes: LEGACY_PASEO_MAX_BYTES };
const legacyApprovalReader = { ...legacyPreferenceReader, maxBytes: LEGACY_APPROVAL_MAX_BYTES };
const legacyStoreReaders: Record<typeof storeNames[number], DocumentReader> = {
  'wayroost-settings.json': { ...legacyNotificationReader, parse: source => readLegacyNotifications(source).document },
  'hermes-safety-commands.json': { ...legacyPreferenceReader, parse: source => readLegacySafetyCommands(source).document },
  'worker-updates.json': { ...legacyPreferenceReader, parse: source => readLegacyWorkerUpdates(source).document },
  'voice.json': { ...legacyPreferenceReader, parse: source => readLegacyVoice(source).document },
  'feed.json': { ...legacyPreferenceReader, parse: source => readLegacyFeed(source).document },
  'worker-approvals.json': { ...legacyApprovalReader, parse: readLegacyApprovalState },
};
const receiptMaxBytes = primaryMaxBytes;
const receiptSchema = z.object({
  version: z.literal(2), phase: z.enum(['prepared', 'forward', 'reversing', 'reverse']),
  paths: z.object({ legacyDir: absolutePathSchema, legacyPaseo: absolutePathSchema, legacyConfig: absolutePathSchema,
    owner: absolutePathSchema, paseo: absolutePathSchema }).strict(),
  snapshots: z.record(z.enum([...storeNames, 'paseo', 'configuration']), z.object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative(),
  }).strict().nullable()), selectedApprovals: z.boolean(),
  metadata: z.record(z.string(), z.object({ mode: z.number().int().min(0).max(0o7777), gid: z.number().int().min(0).max(4_294_967_294), present: z.boolean() }).strict()),
  originalPaseoSha256: z.string().regex(/^[a-f0-9]{64}$/), originalConfigSha256: z.string().regex(/^[a-f0-9]{64}$/),
  forwardPaseoSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sourceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/).nullable()),
  targetHashes: z.object({ owner: z.string().regex(/^[a-f0-9]{64}$/), paseo: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).passthrough();
function legacyConfigNotifications(document: Document, env: NodeJS.ProcessEnv) {
  return parseConfig(document, { env, allowLocalDev: wayroostEnv('DEV_ALLOW_LOOPBACK', env) === '1', withoutSupervisor: true }).notifications;
}

function warnLegacy(name: string, result: LegacyRead<unknown>): void {
  for (const problem of new Set(result.problems)) process.stderr.write(`Warning: legacy ${name}: ${problem}; reader defaults applied.\n`);
}

/** Apply each legacy byte contract while retaining checked paths, metadata and raw hashes. */
async function readLegacyFile(path: string, uid: number, mode: number | undefined, reader: DocumentReader) {
  await checkConfigDirectory(path, uid);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
    throw new ConfigError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'target_missing' : 'unsafe_target');
  });
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || Number(before.uid) !== uid || before.nlink !== 1n
      || mode !== undefined && Number(before.mode & 0o7777n) !== mode) throw new ConfigError('unsafe_target');
    const maxBytes = reader.maxBytes ?? Infinity;
    if (Number(before.size) > maxBytes) throw new ConfigError('parse_failed');
    const bytes = await file.readFile();
    if (bytes.length > maxBytes) throw new ConfigError('parse_failed');
    const after = await file.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    for (const stat of [after, current]) {
      if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size
        || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs) throw new ConfigError('precondition_changed');
    }
    return { bytes, source: reader.decode!(bytes), sha256: digest(bytes), validUtf8: isUtf8(bytes),
      expected: { mode: Number(before.mode & 0o7777n), gid: Number(before.gid) } };
  } finally { await file.close(); }
}

async function snapshot(path: string, uid: number, optional = true, mode?: number, reader: DocumentReader = jsonEditor): Promise<Snapshot> {
  try {
    const file = reader.decode ? await readLegacyFile(path, uid, mode, reader)
      : { ...await readConfigFile(path, uid, mode, 'owner', reader.maxBytes), validUtf8: true };
    if (file.expected.mode & (reader.forbiddenMode ?? 0)) throw new ConfigError('unsafe_target');
    let document: Document;
    try { document = reader.decode ? legacyDocument(reader.parse(file.source)) : object(reader.parse(file.source)); }
    catch { throw new ConfigError('parse_failed'); }
    return { document, source: file.source, sha256: file.sha256, mode: file.expected.mode, gid: file.expected.gid,
      bytes: 'bytes' in file ? file.bytes : undefined, validUtf8: file.validUtf8, legacy: !!reader.decode };
  } catch (error) {
    if (!optional || !(error instanceof ConfigError) || error.code !== 'target_missing') throw error;
    return { document: {}, source: null, sha256: null, mode: mode ?? 0o600, gid: process.getgid!() };
  }
}

function providers(document: Document): Providers {
  return legacyPaseoSchema.parse(document).agents?.providers ?? {};
}

/** Complete policies are copied, including custom providers and deliberate absence. */
function copyProviders(destination: Document, source: Providers, previousIds: string[]): Document {
  const agents = object(destination.agents ?? {});
  const current = legacyPaseoSchema.parse(destination).agents?.providers ?? {};
  const next = clone(current);
  for (const id of new Set([...Object.keys(source), ...previousIds, ...cloudIds])) {
    const entry = Object.hasOwn(source, id) ? source[id] : undefined;
    const old = Object.hasOwn(next, id) ? next[id] : undefined;
    if (!entry && !old) continue;
    const merged = clone(old ?? entry ?? {});
    if (Object.hasOwn(merged, 'enabled') && typeof merged.enabled !== 'boolean') delete merged.enabled;
    delete merged.paseoTools;
    if (entry && Object.hasOwn(entry, 'paseoTools')) merged.paseoTools = clone(entry.paseoTools);
    if ((cloudIds as readonly string[]).includes(id)) {
      delete merged.enabled;
      if (entry && typeof entry.enabled === 'boolean') merged.enabled = entry.enabled;
    }
    // New custom providers need their definition to load.
    if (!old && entry) {
      const definition = clone(entry);
      if (Object.hasOwn(definition, 'enabled') && typeof definition.enabled !== 'boolean') delete definition.enabled;
      if (Object.keys(definition).length || !Object.hasOwn(entry, 'enabled')) next[id] = definition;
    }
    else if (Object.keys(merged).length) next[id] = merged;
    else delete next[id];
  }
  return { ...destination, agents: { ...agents, providers: next as Document } };
}

async function readLegacy(options: MigrationOptions, uid: number, env: NodeJS.ProcessEnv): Promise<Legacy> {
  const paseo = await snapshot(options.legacyPaseo, uid, false, undefined, { ...legacyPaseoReader, parse: readLegacyPaseo });
  const config = await snapshot(options.legacyConfig, uid, false, undefined, legacyPreferenceReader);
  const stores: Record<string, Snapshot> = {};
  for (const name of storeNames) stores[name] = await snapshot(join(options.legacyDir, name), uid, true, undefined, legacyStoreReaders[name]);
  const notifications = readLegacyNotifications(stores['wayroost-settings.json']!.source ?? '{}');
  const feed = readLegacyFeed(stores['feed.json']!.source);
  const rawFeed = legacyObject(feed.document.settings);
  const worker = readLegacyWorkerUpdates(stores['worker-updates.json']!.source);
  const safety = readLegacySafetyCommands(stores['hermes-safety-commands.json']!.source);
  const voice = readLegacyVoice(stores['voice.json']!.source);
  for (const [name, result] of [['feed.json', feed], ['worker-updates.json', worker], ['hermes-safety-commands.json', safety], ['voice.json', voice]] as const) warnLegacy(name, result);
  const settings: Document = { version: 1 };
  for (const key of ['rules', 'quietHours', 'push'] as const) {
    if (Object.hasOwn(notifications.document, key)) settings[key] = notifications.value[key];
    else if (stores['wayroost-settings.json']!.sha256 === null && key !== 'rules' && Object.hasOwn(rawFeed, key)) settings[key] = feed.value[key];
  }
  if (Object.hasOwn(safety.document, 'enabled')) settings.safetyCommandsEnabled = safety.value;
  settings.workerUpdates = { enabled: worker.value.enabled, ...(Object.hasOwn(worker.document, 'defaultMinutes') ? { defaultMinutes: worker.value.defaultMinutes } : {}) };
  settings.feed = { ...(Object.hasOwn(rawFeed, 'lessLike') ? { lessLike: feed.value.lessLike } : {}), level: feed.value.level };
  const voiceChoice = { ...(Object.hasOwn(voice.document, 'voice') ? { voice: voice.value.voice } : {}),
    ...(Object.hasOwn(voice.document, 'appReadAloud') ? { appReadAloud: voice.value.appReadAloud } : {}) };
  if (Object.keys(voiceChoice).length) settings.voice = voiceChoice as Document;
  const notificationConfig = legacyConfigNotifications(config.document, env);
  if (Object.hasOwn(notificationConfig, 'timeZone')) settings.timeZone = notificationConfig.timeZone!;
  readLegacyApprovalState(stores['worker-approvals.json']!.source);
  const configured = legacyPaseoSchema.parse(paseo.document).agents?.providers ?? {};
  const supported = editableLegacyProviders(configured);
  if (Object.keys(supported).length !== Object.keys(configured).length) {
    warnLegacy('Paseo configuration', { document: {}, value: undefined, problems: ['invalid_value'] });
  }
  return { paseo, config, stores, settings: wayroostSettingsSchema.parse(settings), providers: configured };
}

/** Compare meaning rather than JSON ordering or an explicitly written default. */
export function effectiveSettings(settings: WayroostSettingsDocument, legacy = false): unknown {
  return {
    safetyCommandsEnabled: settings.safetyCommandsEnabled ?? false,
    rules: [...(settings.rules ?? DEFAULT_NOTIFICATION_RULES)].sort((a, b) => `${a.event}/${a.source}`.localeCompare(`${b.event}/${b.source}`)),
    quietHours: settings.quietHours === undefined ? DEFAULT_QUIET_HOURS : settings.quietHours,
    push: { approvals: settings.push?.approvals ?? true, cards: settings.push?.cards ?? false },
    timeZone: settings.timeZone ?? null,
    feed: { level: settings.feed?.level ?? (legacy ? 'normal' : 'off'), lessLike: settings.feed?.lessLike ?? [] },
    workerUpdates: { enabled: settings.workerUpdates?.enabled ?? legacy, defaultMinutes: settings.workerUpdates?.defaultMinutes ?? 60 },
    voice: { voice: settings.voice?.voice ?? '', appReadAloud: settings.voice?.appReadAloud ?? { provider: 'local' } },
  };
}

function effectiveProviders(entries: Providers, ids: readonly string[] = []): unknown {
  const resolve = (id: string): Document => {
    const entry = Object.hasOwn(entries, id) ? entries[id]! : {};
    // Tool policies use the exact provider ID; extends only supplies its launch definition.
    const policy = object(entry.paseoTools ?? {});
    return { ...policy, enabled: policy.enabled ?? true, disabledTools: [...new Set((policy.disabledTools ?? []) as string[])].sort() };
  };
  return { flags: Object.fromEntries(cloudIds.map(id => [id, entries[id]?.enabled !== false])),
    policies: Object.fromEntries([...new Set([...cloudIds, 'copilot', 'pi', 'omp', ...Object.keys(entries), ...ids])].sort().map(id => [id, resolve(id)])) };
}

function approvalChoice(entries: Providers): boolean {
  const resolved = effectiveProviders(entries) as { policies: Record<string, Document> };
  const choices = Object.values(resolved.policies).map(policy => {
    if (policy.enabled === false) return true;
    const disabled = policy.disabledTools as string[];
    const count = WORKER_APPROVAL_TOOLS.filter(tool => disabled.includes(tool)).length;
    if (count !== 0 && count !== WORKER_APPROVAL_TOOLS.length) throw new MixedPolicyError();
    return count === WORKER_APPROVAL_TOOLS.length;
  });
  // Providers with every tool disabled are compatible with either choice.
  const live = Object.entries(resolved.policies).filter(([, policy]) => policy.enabled !== false).map(([id]) => choices[Object.keys(resolved.policies).indexOf(id)]!);
  if (new Set(live).size > 1) throw new MixedPolicyError();
  return live[0] ?? true;
}

function legacyTarget(path: string, template: FileTarget, mode: number): FileTarget {
  return { path, runAs: template.runAs, mode, format: 'json', backupDir: template.backupDir, auditDir: template.auditDir,
    lock: { kind: 'file', path: settingsLockPath(path) } };
}

/** Missing files publish complete documents inside the core's target/consumer locks. */
async function seed(path: string, value: Document | Buffer, mode: number, gid: number): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await file.writeFile(Buffer.isBuffer(value) ? value : `${JSON.stringify(value)}\n`); await file.chown(process.getuid!(), gid); await file.chmod(mode); await file.sync();
    try { await lstat(path); throw new MigrationError('Settings appeared during initialization; no replacement was made.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Rename keeps the published file at one link even if initialization is killed.
    await rename(temporary, path);
    const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await file.close();
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}

/** Uneditable legacy bytes are retained by the core's atomic restoration path. */
function needsRestoration(before: Snapshot): boolean {
  if (!before.legacy || before.source === null) return false;
  if (before.restoration !== undefined) return before.restoration;
  try {
    validateValue(legacyDocument(parseLegacyJson(before.source)));
    object(jsonEditor.parse(before.source));
    return before.restoration = false;
  } catch { return before.restoration = true; }
}

function documentOperations(before: Snapshot, wanted: Document): SettingOperation[] {
  if (needsRestoration(before)) return [{ type: 'set', path: [], value: wanted }];
  const initial = before.sha256 === null ? wanted : before.document;
  return [...new Set([...Object.keys(initial), ...Object.keys(wanted)])]
    .filter(key => !isDeepStrictEqual(initial[key], wanted[key]))
    .map(key => Object.hasOwn(wanted, key) ? { type: 'set' as const, path: [key], value: wanted[key]! } : { type: 'delete' as const, path: [key] });
}

function editedSource(before: Snapshot, wanted: Document): string {
  if (needsRestoration(before)) return `${JSON.stringify(wanted)}\n`;
  return jsonEditor.edit(before.source ?? `${JSON.stringify(wanted)}\n`, documentOperations(before, wanted));
}

function checkWriteSize(before: Snapshot, wanted: Document, name: string, maxBytes: number): void {
  if (Buffer.byteLength(editedSource(before, wanted)) > maxBytes) {
    const limit = maxBytes < 1024 * 1024 ? `${maxBytes / 1024} KiB` : `${maxBytes / (1024 * 1024)} MiB`;
    throw new MigrationError(`${name} write exceeds ${limit}; reduce the stopped input before retrying.`);
  }
}

function checkLegacyWriteSize(before: Snapshot, wanted: Document, name: string, reader: DocumentReader = legacyPreferenceReader): void {
  checkWriteSize(before, wanted, `Legacy ${name}`, reader.maxBytes ?? Infinity);
}

function checkReceiptSize(before: Snapshot, wanted: Document): void {
  const source = editedSource(before, wanted);
  // Completion adds hashes; reversing is the longest subsequent phase name.
  const reserved = jsonEditor.edit(source, [
    { type: 'set', path: ['phase'], value: 'reversing' },
    { type: 'set', path: ['targetHashes'], value: { owner: '0'.repeat(64), paseo: '0'.repeat(64) } },
  ]);
  if (Math.max(Buffer.byteLength(source), Buffer.byteLength(reserved)) > receiptMaxBytes) throw new MigrationError('Migration receipt exceeds 4 MiB, including completion metadata.');
}

type ProposedWrite = { target: FileTarget; before: Snapshot; wanted: Document; validate: (document: Document, source: string) => unknown };
const optionalStat = (path: string) => lstat(path).catch(error => {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  return undefined;
});

/** Plan removes only a Paseo lock inode that it exclusively created. */
async function preflightConsumerLock(target: FileTarget, dependencies: MigrationDependencies, plan: boolean): Promise<void> {
  const lock = dependencies.preflightLock ?? dependencies.lock ?? withConsumerLock;
  const work = () => withSettingsFileLock(settingsLockPath(target.path), async () => {});
  if (!plan || target.lock.kind !== 'paseo') { await lock(target, work); return; }
  const file = await open(target.lock.path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return undefined;
  });
  if (!file) { await lock(target, work); return; }
  try {
    const created = await file.stat();
    try { await lock(target, work); }
    finally {
      const current = await optionalStat(target.lock.path);
      if (current?.isFile() && current.dev === created.dev && current.ino === created.ino
        && current.uid === target.runAs.uid && current.nlink === 1 && (current.mode & 0o7777) === 0o600) await unlink(target.lock.path);
    }
  } finally { await file.close(); }
}

/** Check the complete write set before publishing a receipt or taking a creating lock. */
async function preflightWrites(writes: ProposedWrite[], dependencies: MigrationDependencies, plan = false): Promise<void> {
  const auditLocks = new Set<string>();
  for (const { target, before, wanted } of writes) {
    if (before.validUtf8 === false) throw new ConfigError('parse_failed');
    await preflightTarget(target, false);
    if (!target.path.slice(1).split('/').every(segment => /^\.?[A-Za-z0-9_ -][A-Za-z0-9_. -]*$/.test(segment))) throw new ConfigError('unsafe_target');
    if (target.mode !== undefined && before.mode !== target.mode) throw new ConfigError('unsafe_target');
    if (![process.getgid!(), ...process.getgroups!()].includes(before.gid)) throw new ConfigError('unsafe_target');
    validateValue(needsRestoration(before) ? wanted : before.document);
    for (const operation of documentOperations(before, wanted)) {
      validatePath(operation.path);
      if (operation.type === 'set') validateValue(operation.value);
    }
    await access(dirname(target.path), constants.W_OK | constants.X_OK);
    for (const [path, required] of [[target.backupDir, true], [target.auditDir, true], [configBackupDirectory(target), false],
      [join(configBackupDirectory(target), digest(target.path)), false]] as const) {
      await checkConfigDirectory(path, target.runAs.uid, true);
      const info = await optionalStat(path);
      if ((required && !info) || (info && (!info.isDirectory() || info.uid !== target.runAs.uid || info.mode & 0o077))) {
        throw new MigrationError('Private owner backup and audit directories must already exist.');
      }
      if (info) await access(path, constants.W_OK | constants.X_OK);
    }
    const auditPath = join(target.auditDir, 'audit.jsonl');
    const audit = await optionalStat(auditPath);
    if (audit && (!audit.isFile() || audit.nlink !== 1 || audit.uid !== target.runAs.uid || audit.mode & 0o077)) throw new ConfigError('audit_unavailable');
    if (audit) await access(auditPath, constants.R_OK | constants.W_OK);
    if (audit) auditLocks.add(join(target.backupDir, `.wayroost-audit-${audit.dev}-${audit.ino}.lock`));
    const lockPaths = new Set([target.lock.path, settingsLockPath(target.path),
      ...(audit ? [join(target.backupDir, `.wayroost-audit-${audit.dev}-${audit.ino}.lock`)] : [])]);
    for (const base of [...lockPaths]) {
      if (base === target.lock.path && target.lock.kind !== 'file') continue;
      for (let depth = 1; depth <= 8; depth++) lockPaths.add(`${base}${'.reap'.repeat(depth)}`);
    }
    for (const path of lockPaths) {
      await checkConfigDirectory(path, target.runAs.uid);
      const info = await optionalStat(path);
      if (!info) continue;
      if (!info.isFile() || info.nlink !== 1 || info.uid !== target.runAs.uid || info.mode & 0o077) throw new ConfigError('locked');
      if (path !== target.lock.path || target.lock.kind === 'file') {
        const lock = await readConfigFile(path, target.runAs.uid);
        let pid: number;
        try { pid = z.object({ pid: z.number().int().positive() }).parse(JSON.parse(lock.source)).pid; }
        catch { throw new ConfigError('locked'); }
        try { process.kill(pid, 0); throw new ConfigError('locked'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new ConfigError('locked'); }
      } else {
        try { await execute('/usr/bin/flock', ['--exclusive', '--nonblock', path, '/usr/bin/true']); }
        catch { throw new ConfigError('locked'); }
      }
    }
    // Exercise the editor now too: a document it cannot edit must never start a transaction.
    object(jsonEditor.parse(editedSource(before, wanted)));
  }
  for (const write of writes) {
    const source = editedSource(write.before, write.wanted);
    await write.validate(object(jsonEditor.parse(source)), source);
  }
  // Exercise every consumer, file and existing audit lock only after all checks pass.
  for (const { target } of writes) await preflightConsumerLock(target, dependencies, plan);
  for (const path of auditLocks) await withSettingsFileLock(path, async () => {});
}

const snapshotDirectory = (owner: FileTarget) => join(owner.backupDir, 'migration-snapshots');
const snapshotReader = (name: string): DocumentReader => name === 'paseo' ? { ...legacyPaseoReader, parse: readLegacyPaseo }
  : name === 'configuration' ? legacyPreferenceReader : legacyStoreReaders[name as typeof storeNames[number]]!;
const legacySnapshots = (legacy: Legacy): Record<string, Snapshot> => ({ ...legacy.stores, paseo: legacy.paseo, configuration: legacy.config });

/** Immutable raw snapshots have independent byte contracts and never enter the receipt. */
async function checkSnapshotStorage(owner: FileTarget): Promise<void> {
  const path = snapshotDirectory(owner);
  await checkConfigDirectory(path, owner.runAs.uid, true);
  const info = await optionalStat(path);
  if (info && (!info.isDirectory() || info.uid !== owner.runAs.uid || (info.mode & 0o7777) !== 0o700)) throw new ConfigError('unsafe_directory');
  if (info) await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
}

/** Interrupted publications leave only hash-and-UUID temporaries eligible for cleanup. */
async function cleanSnapshotTemporaries(owner: FileTarget): Promise<void> {
  await checkSnapshotStorage(owner);
  const directory = snapshotDirectory(owner);
  if (!await optionalStat(directory)) return;
  let removed = false;
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9]{64}\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(name)) continue;
    const path = join(directory, name);
    const before = await optionalStat(path);
    if (!before?.isFile() || before.uid !== owner.runAs.uid || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600) continue;
    const current = await optionalStat(path);
    if (!current?.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.uid !== before.uid
      || current.nlink !== 1 || current.mode !== before.mode) continue;
    await unlink(path);
    removed = true;
  }
  if (removed) {
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  }
}

async function readSavedSnapshots(document: Document, owner: FileTarget): Promise<Record<string, Snapshot>> {
  const saved = receiptSchema.parse(document);
  await checkSnapshotStorage(owner);
  const result: Record<string, Snapshot> = {};
  for (const name of [...storeNames, 'paseo', 'configuration'] as const) {
    if (!Object.hasOwn(saved.snapshots, name)) throw new ConfigError('parse_failed');
    const reference = saved.snapshots[name];
    const expectedHash = name === 'paseo' ? saved.originalPaseoSha256 : name === 'configuration' ? saved.originalConfigSha256 : saved.sourceHashes[name];
    if ((reference?.sha256 ?? null) !== expectedHash) throw new ConfigError('precondition_changed');
    if (!reference) {
      result[name] = { document: {}, source: null, sha256: null, mode: 0o600, gid: process.getgid!() };
      continue;
    }
    // Stored bytes are 0600, independent of the original store's restoration mode.
    const before = await snapshot(join(snapshotDirectory(owner), reference.sha256), owner.runAs.uid, false, 0o600, snapshotReader(name));
    if (before.sha256 !== reference.sha256 || before.bytes?.length !== reference.size) throw new ConfigError('precondition_changed');
    result[name] = before;
  }
  return result;
}

async function preflightSnapshots(legacy: Legacy, owner: FileTarget): Promise<void> {
  await checkSnapshotStorage(owner);
  for (const [name, before] of Object.entries(legacySnapshots(legacy))) {
    if (before.sha256 === null) continue;
    const path = join(snapshotDirectory(owner), before.sha256);
    if (!await optionalStat(path)) continue;
    const stored = await snapshot(path, owner.runAs.uid, false, 0o600, snapshotReader(name));
    if (stored.sha256 !== before.sha256 || !stored.bytes?.equals(before.bytes!)) throw new ConfigError('precondition_changed');
  }
}

async function saveSnapshots(legacy: Legacy, owner: FileTarget): Promise<void> {
  const directory = snapshotDirectory(owner);
  await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  await checkSnapshotStorage(owner);
  const parent = await open(owner.backupDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
  for (const [name, before] of Object.entries(legacySnapshots(legacy))) {
    if (before.sha256 === null) continue;
    const path = join(directory, before.sha256);
    if (await optionalStat(path)) {
      const stored = await snapshot(path, owner.runAs.uid, false, 0o600, snapshotReader(name));
      if (stored.sha256 !== before.sha256 || !stored.bytes?.equals(before.bytes!)) throw new ConfigError('precondition_changed');
    } else await seed(path, before.bytes!, 0o600, process.getgid!());
  }
}

async function writeDocument(target: FileTarget, before: Snapshot, wanted: Document, dependencies: MigrationDependencies, reader: DocumentReader = jsonEditor): Promise<string> {
  const initial = wanted;
  const initialHash = digest(`${JSON.stringify(initial)}\n`);
  const operations = documentOperations(before, wanted);
  const core = new SettingsWriteThrough({ backupDir: configBackupDirectory(target), auditFile: join(target.auditDir, 'audit.jsonl'), keepBackups: Number.MAX_SAFE_INTEGER,
    coordinate: (_path, work) => (dependencies.lock ?? withConsumerLock)(target, async () => {
      const current = await snapshot(target.path, target.runAs.uid, true, target.mode, reader);
      if (current.sha256 !== before.sha256) throw new MigrationError('Settings changed during migration; no replacement was made.');
      if (before.sha256 === null) await seed(target.path, initial, before.mode, before.gid);
      return work();
    }) });
  if (needsRestoration(before)) {
    const directory = join(configBackupDirectory(target), digest(target.path));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const name = `${String(Date.now()).padStart(16, '0')}-${initialHash}-${randomUUID()}.bak`;
    await seed(join(directory, name), wanted, before.mode & 0o770, before.gid);
    const result = await core.undoWithToken({ target: target.path, editor: 'json', backupId: `${digest(target.path)}/${name}`,
      backupHash: initialHash, writtenHash: before.sha256!, expected: { uid: target.runAs.uid, gid: before.gid, mode: before.mode }, timing: 'now' });
    return result.writtenHash;
  }
  const result = await core.apply({ target: target.path, editor: 'json', operations, timing: 'now',
    expected: { uid: target.runAs.uid, gid: before.gid, mode: before.mode }, version: { hash: before.sha256 ?? initialHash } });
  return result.writtenHash;
}

/** Reserve storage roots, including every internal backup, audit and temporary artifact. */
function migrationPathInventory(options: MigrationOptions, owner: FileTarget, paseo: FileTarget, receiptPath: string): string[] {
  const paths = [owner.path, paseo.path, options.legacyPaseo, options.legacyConfig, ...storeNames.map(name => join(options.legacyDir, name))];
  // The legacy Paseo file may already be the prepared target.
  const distinct = paths.filter((_path, index) => index !== 2 || options.legacyPaseo !== paseo.path);
  const documents = [...distinct, receiptPath, snapshotDirectory(owner)];
  const baseLocks = [...new Set([owner.lock.path, paseo.lock.path, `${options.legacyPaseo}.wayroost.lock`, ...documents.map(settingsLockPath)])];
  const locks = baseLocks.flatMap(path => [path, ...Array.from({ length: 8 }, (_, depth) => `${path}${'.reap'.repeat(depth + 1)}`)]);
  const storage = [owner.backupDir, owner.auditDir, paseo.backupDir, paseo.auditDir];
  if (!storagePathsApart([...documents, ...locks]) || !storagePathsApart([options.legacyDir, ...storage])
    || [...documents, ...locks].some(path => storage.some(directory => {
      // The receipt and its own lock deliberately live in the owner's backup root.
      if (directory === owner.backupDir && [receiptPath, snapshotDirectory(owner), ...Array.from({ length: 9 }, (_, depth) => `${settingsLockPath(receiptPath)}${'.reap'.repeat(depth)}`),
        ...Array.from({ length: 9 }, (_, depth) => `${settingsLockPath(snapshotDirectory(owner))}${'.reap'.repeat(depth)}`)].includes(path)) return false;
      return !storagePathsApart([path, directory]);
    }))) throw new MigrationError('Migration paths overlap.');
  return distinct;
}

type MigrationResult = { mode: string; verified: boolean; paths: string[] };

/** Resolve all existing-state refusals before returning a write phase. */
async function preflightMigration(options: MigrationOptions, dependencies: MigrationDependencies): Promise<() => Promise<MigrationResult>> {
  const uid = dependencies.uid ?? process.getuid!();
  if (uid === 0) throw new OwnerRequiredError();
  const site = settingsTargetsSchema.parse(options.site);
  const owner = site.targets['wayroost-settings']; const paseo = site.targets['paseo-config'];
  if (!owner || !paseo || [owner, paseo].some(target => target.runAs.uid !== uid)) throw new MigrationError('Run as the configured settings and Paseo owner.');
  if (!site.configWrites && ['forward', 'reverse'].includes(options.mode)) throw new MigrationError('configWrites is off.');
  if (!options.units.length || options.units.some(unit => !UNIT_NAME.test(unit))) throw new MigrationError('Name every stopped writer with --stopped-unit.');
  const systemctl = dependencies.systemctl ?? (async (args: string[]) => {
    try { const result = await execute('/usr/bin/systemctl', args); return { code: 0, stdout: result.stdout }; }
    catch (error) { const result = error as { code?: number; stdout?: string }; return { code: result.code ?? -1, stdout: result.stdout ?? '' }; }
  });
  const stopped = dependencies.stopped ?? (async (unit: string) => {
    const loaded = await systemctl(['show', '-p', 'LoadState', '--value', unit]);
    if (loaded.code !== 0 || loaded.stdout.trim() !== 'loaded') return false;
    const result = await systemctl(['is-active', unit]);
    return result.code === 3 && result.stdout.trim() === 'inactive';
  });
  for (const unit of options.units) if (!await stopped(unit)) throw new MigrationError(`Writer is running or its stopped state cannot be proved: ${unit}`);
  for (const path of [options.legacyDir, options.legacyPaseo, options.legacyConfig]) absolutePathSchema.parse(path);
  const receiptPath = join(owner.backupDir, 'migration.json');
  const distinct = migrationPathInventory(options, owner, paseo, receiptPath);
  const legacy = await readLegacy(options, uid, dependencies.env ?? process.env);
  const currentOwner = await snapshot(owner.path, uid, true, owner.mode);
  if (currentOwner.sha256 !== null) wayroostSettingsSchema.parse(currentOwner.document);
  const currentPaseo = await snapshot(paseo.path, uid, false, paseo.mode);
  const receiptTarget = legacyTarget(receiptPath, owner, 0o600);
  let receipt = await snapshot(receiptPath, uid, true, 0o600);
  if (receipt.sha256 !== null) receiptSchema.parse(receipt.document);
  const identity = { legacyDir: options.legacyDir, legacyPaseo: options.legacyPaseo, legacyConfig: options.legacyConfig, owner: owner.path, paseo: paseo.path };
  if (receipt.sha256 !== null && !isDeepStrictEqual(receipt.document.paths, identity)) throw new MigrationError('The migration receipt belongs to different paths.');
  const originals = receipt.sha256 === null ? undefined : await readSavedSnapshots(receipt.document, owner);
  if (options.mode === 'verify') {
    const actual = wayroostSettingsSchema.parse(currentOwner.document);
    const primaryProviders = providers(currentPaseo.document);
    const ids = [...new Set([...Object.keys(primaryProviders), ...Object.keys(legacy.providers)])];
    if (!isDeepStrictEqual(effectiveSettings(actual), effectiveSettings(legacy.settings, true))
      || !isDeepStrictEqual(effectiveProviders(primaryProviders, ids), effectiveProviders(legacy.providers, ids))) throw new MigrationError('Effective settings or provider policies differ.');
    return async () => ({ mode: options.mode, verified: true, paths: distinct });
  }
  const saveReceipt = async (document: Document) => {
    receiptSchema.parse(document);
    checkReceiptSize(receipt, document);
    await writeDocument(receiptTarget, receipt, document, dependencies);
    receipt = await snapshot(receiptPath, uid, false, 0o600);
  };
  const receiptWrite = (wanted: Document): ProposedWrite => ({ target: receiptTarget, before: receipt, wanted,
    validate: document => { checkReceiptSize(receipt, document); receiptSchema.parse(document); } });
  const paseoWrite = (target: FileTarget, before: Snapshot, wanted: Document): ProposedWrite => ({ target, before, wanted,
    validate: (_document, source) => (dependencies.validatePaseo ?? validateInstalledPaseo)(source, target) });
  if (options.mode === 'forward' || options.mode === 'plan') {
    if (receipt.document.phase === 'forward') {
      await migrateSettings({ ...options, mode: 'verify' }, dependencies);
      return async () => ({ mode: options.mode, verified: options.mode !== 'plan', paths: distinct });
    }
    let prepared = receipt.document;
    if (receipt.sha256 === null) {
      const metadata = Object.fromEntries(Object.entries(legacy.stores).map(([name, saved]) => [name, { mode: saved.mode, gid: saved.gid, present: saved.sha256 !== null }]));
      prepared = { version: 2, phase: 'prepared', paths: identity,
        snapshots: Object.fromEntries(Object.entries(legacySnapshots(legacy)).map(([name, saved]) => [name,
          saved.sha256 === null ? null : { sha256: saved.sha256, size: saved.bytes!.length }])),
        selectedApprovals: legacy.stores['worker-approvals.json']!.document.enabled ?? true, metadata, originalPaseoSha256: legacy.paseo.sha256,
        originalConfigSha256: legacy.config.sha256,
        sourceHashes: Object.fromEntries(Object.entries(legacy.stores).map(([name, saved]) => [name, saved.sha256])),
      };
    } else if (receipt.document.phase !== 'prepared') throw new MigrationError('Migration is already reversed; use a new prepared target for another cutover.');
    prepared = JSON.parse(JSON.stringify(prepared)) as Document;
    checkReceiptSize(receipt, prepared);
    if (options.legacyPaseo !== paseo.path && prepared.originalPaseoSha256 !== legacy.paseo.sha256) throw new MigrationError('Legacy Paseo changed since the forward snapshot.');
    if (options.legacyPaseo === paseo.path && receipt.sha256 !== null) {
      if (!prepared.forwardPaseoSha256) throw new MigrationError('Prepared migration receipt lacks the intended Paseo revision; restore the original snapshot and prepare a new receipt.');
      if (currentPaseo.sha256 !== prepared.originalPaseoSha256 && currentPaseo.sha256 !== prepared.forwardPaseoSha256) {
        throw new MigrationError('Legacy Paseo changed since the forward snapshot.');
      }
    }
    if (prepared.originalConfigSha256 !== legacy.config.sha256) throw new MigrationError('Legacy configuration changed since the forward snapshot.');
    const sourceHashes = object(prepared.sourceHashes);
    if (Object.entries(legacy.stores).some(([name, before]) => sourceHashes[name] !== before.sha256)) throw new MigrationError('Legacy preferences changed since the forward snapshot.');
    if (receipt.sha256 === null) await preflightSnapshots(legacy, owner);
    const savedProviders = originals ? providers(originals.paseo!.document) : legacy.providers;
    const wantedPaseo = copyProviders(currentPaseo.document, savedProviders, []);
    const wantedProviders = providers(wantedPaseo);
    const ids = [...new Set([...Object.keys(savedProviders), ...Object.keys(wantedProviders)])];
    if (!isDeepStrictEqual(effectiveProviders(savedProviders, ids), effectiveProviders(wantedProviders, ids))) throw new MigrationError('Prepared Paseo target has conflicting provider definitions or policies.');
    const wantedOwner = legacy.settings;
    checkWriteSize(currentPaseo, wantedPaseo, 'Primary Paseo', options.legacyPaseo === paseo.path ? legacyPaseoReader.maxBytes : primaryMaxBytes);
    checkWriteSize(currentOwner, wantedOwner as Document, 'Primary owner settings', primaryMaxBytes);
    if (receipt.sha256 === null) prepared.forwardPaseoSha256 = digest(editedSource(currentPaseo, wantedPaseo));
    await preflightWrites([receiptWrite(prepared), paseoWrite(paseo, currentPaseo, wantedPaseo),
      { target: owner, before: currentOwner, wanted: wantedOwner as Document, validate: document => wayroostSettingsSchema.parse(document) }], dependencies, options.mode === 'plan');
    if (options.mode === 'plan') return async () => ({ mode: options.mode, verified: false, paths: distinct });
    return async () => {
      if (receipt.sha256 === null) { await saveSnapshots(legacy, owner); await saveReceipt(prepared); }
      await writeDocument(paseo, currentPaseo, wantedPaseo, dependencies);
      await writeDocument(owner, currentOwner, wantedOwner as Document, dependencies);
      await migrateSettings({ ...options, mode: 'verify' }, dependencies);
      await saveReceipt({ ...receipt.document, phase: 'forward', targetHashes: { owner: (await snapshot(owner.path, uid, false)).sha256, paseo: (await snapshot(paseo.path, uid, false)).sha256 } });
      return { mode: options.mode, verified: true, paths: distinct };
    };
  }
  if (!['forward', 'reversing', 'reverse'].includes(String(receipt.document.phase))) throw new MigrationError('Reverse requires the forward receipt.');
  const primary = wayroostSettingsSchema.parse(currentOwner.document);
  const primaryProviders = providers(currentPaseo.document);
  const chosen = approvalChoice(primaryProviders);
  const originalApprovals = originals!['worker-approvals.json']!.document;
  const saved = approvalStateSchema.parse(Object.keys(originalApprovals).length ? originalApprovals
    : { version: 1, enabled: true, backup: {}, reloadPending: true });
  // Resolve historical prepared state against the original revision, never against a new file.
  if (saved.prepared) {
    const revision = receipt.document.originalPaseoSha256;
    if (revision !== saved.prepared.beforeRevision && revision !== saved.prepared.afterRevision) throw new MigrationError('Unresolved legacy approval preparation; restore or resolve it before reverse.');
    saved.backup = revision === saved.prepared.afterRevision ? saved.prepared.committedBackup : saved.prepared.previousBackup;
    delete saved.prepared;
  }
  const backup: z.infer<typeof backupSchema> = {};
  if (chosen) for (const [id, entry] of Object.entries(primaryProviders)) {
    const now = entry.paseoTools ?? {};
    const previous = Object.hasOwn(saved.backup, id) ? saved.backup[id] : undefined;
    const before = clone(now);
    // Without an undo record, existing restrictions cannot be attributed to the option.
    const preexisting = previous ? previous.before?.disabledTools ?? [] : now.disabledTools ?? [];
    if (now.disabledTools) before.disabledTools = now.disabledTools.filter(tool => !WORKER_APPROVAL_TOOLS.includes(tool as typeof WORKER_APPROVAL_TOOLS[number]) || preexisting.includes(tool));
    if (!previous?.before?.disabledTools && before.disabledTools?.length === 0) delete before.disabledTools;
    backup[id] = { entry: previous?.entry ?? 'existing', ...(Object.keys(before).length ? { before } : {}), applied: clone(now) };
  }
  const metadata = object(receipt.document.metadata);
  for (const [name, before] of Object.entries(legacy.stores)) {
    if (before.sha256 !== null) continue;
    const restored = object(metadata[name]);
    before.mode = z.number().int().parse(restored.mode);
    if (name === 'wayroost-settings.json' && (before.mode & legacyNotificationReader.forbiddenMode)) throw new ConfigError('unsafe_target');
    before.gid = z.number().int().parse(restored.gid);
    before.document = name === 'feed.json' ? { settings: clone(legacyObject(originals![name]!.document.settings)) as Document }
      : clone(originals![name]!.document);
  }
  const wantedLegacyPaseo = copyProviders(legacy.paseo.document, primaryProviders, Object.keys(providers(originals!.paseo!.document)));
  const restoredProviders = providers(wantedLegacyPaseo);
  const ids = [...new Set([...Object.keys(primaryProviders), ...Object.keys(restoredProviders)])];
  if (!isDeepStrictEqual(effectiveProviders(primaryProviders, ids), effectiveProviders(restoredProviders, ids))) throw new MigrationError('Unsupported legacy provider inheritance; reverse requires an explicit adapter.');
  const setFields = (document: Document, source: Document, keys: string[]) => {
    const next = clone(document);
    for (const key of keys) { delete next[key]; if (Object.hasOwn(source, key)) next[key] = source[key]!; }
    return next;
  };
  const legacyNotifications: Document = { ...primary as Document, ...(Object.hasOwn(primary, 'push') ? { push: { approvals: primary.push?.approvals ?? true, cards: primary.push?.cards ?? false } } : {}) };
  const targets: Record<string, Document> = {
    'wayroost-settings.json': setFields(legacy.stores['wayroost-settings.json']!.document, legacyNotifications, ['rules', 'quietHours', 'push']),
    'hermes-safety-commands.json': setFields(legacy.stores['hermes-safety-commands.json']!.document, Object.hasOwn(primary, 'safetyCommandsEnabled') ? { enabled: primary.safetyCommandsEnabled! } : {}, ['enabled']),
    'worker-updates.json': setFields(legacy.stores['worker-updates.json']!.document, { ...primary.workerUpdates, enabled: primary.workerUpdates?.enabled ?? false }, ['enabled', 'defaultMinutes']),
    'voice.json': { ...setFields(legacy.stores['voice.json']!.document, primary.voice as Document ?? {}, ['voice', 'appReadAloud']), version: 2 },
    'worker-approvals.json': { version: 1, enabled: chosen, backup: backup as Document, reloadPending: true },
  };
  const feed = legacy.stores['feed.json']!.document;
  targets['feed.json'] = { ...feed, settings: { ...setFields(legacyObject(feed.settings) as Document, primary.feed as Document ?? {}, ['level', 'lessLike']),
    level: primary.feed?.level ?? 'off', quietHours: primary.quietHours === undefined ? DEFAULT_QUIET_HOURS : primary.quietHours,
    push: { approvals: primary.push?.approvals ?? true, cards: primary.push?.cards ?? false } } };
  const config = legacy.config.document;
  const nextConfig = { ...config, notifications: setFields(object(config.notifications ?? {}), primary as Document, ['timeZone']) };
  checkLegacyWriteSize(legacy.paseo, wantedLegacyPaseo, 'Paseo', legacyPaseoReader);
  for (const [name, document] of Object.entries(targets)) {
    checkLegacyWriteSize(legacy.stores[name]!, document, name === 'wayroost-settings.json' ? 'notification' : name,
      legacyStoreReaders[name as typeof storeNames[number]]);
  }
  checkLegacyWriteSize(legacy.config, nextConfig, 'configuration');
  const legacyPaseoTarget = options.legacyPaseo === paseo.path ? paseo : { ...paseo, path: options.legacyPaseo, lock: { kind: 'paseo' as const, path: `${options.legacyPaseo}.wayroost.lock` }, mode: legacy.paseo.mode };
  const legacySchemas: Record<string, (document: Document) => unknown> = {
    'wayroost-settings.json': document => readLegacyNotifications(JSON.stringify(document)),
    'hermes-safety-commands.json': document => z.object({ enabled: z.boolean().optional() }).passthrough().parse(document),
    'worker-updates.json': document => workerUpdatesSchema.loose().parse(document),
    'voice.json': document => z.object({ version: z.literal(2), voice: localVoiceSchema.optional(), appReadAloud: appReadAloudSchema.optional() }).passthrough().parse(document),
    'worker-approvals.json': document => approvalStateSchema.parse(document),
    'feed.json': document => z.object({ settings: z.object({ level: z.enum(PROACTIVITY_LEVELS),
      quietHours: settingsNotificationsBodySchema.shape.quietHours, push: settingsNotificationsBodySchema.shape.push,
      lessLike: legacyFeedSchema.shape.lessLike.unwrap().optional() }).passthrough() }).passthrough().parse(document),
  };
  const reversing = { ...receipt.document, phase: 'reversing' };
  await preflightWrites([receiptWrite(reversing), paseoWrite(legacyPaseoTarget, legacy.paseo, wantedLegacyPaseo),
    ...Object.entries(targets).map(([name, wanted]): ProposedWrite => ({ target: legacyTarget(join(options.legacyDir, name), owner, legacy.stores[name]!.mode),
      before: legacy.stores[name]!, wanted, validate: document => legacySchemas[name]!(document) })),
    { target: legacyTarget(options.legacyConfig, owner, legacy.config.mode), before: legacy.config, wanted: nextConfig, validate: document => legacyConfigNotifications(document, dependencies.env ?? process.env) }], dependencies);
  return async () => {
    await saveReceipt(reversing);
    await writeDocument(legacyPaseoTarget, legacy.paseo, wantedLegacyPaseo, dependencies, legacyPaseoReader);
    for (const [name, document] of Object.entries(targets)) {
      const before = legacy.stores[name]!;
      await writeDocument(legacyTarget(join(options.legacyDir, name), owner, before.mode), before, document, dependencies, legacyStoreReaders[name as typeof storeNames[number]]);
    }
    await writeDocument(legacyTarget(options.legacyConfig, owner, legacy.config.mode), legacy.config, nextConfig, dependencies, legacyPreferenceReader);
    await migrateSettings({ ...options, mode: 'verify' }, dependencies);
    await saveReceipt({ ...receipt.document, phase: 'reverse' });
    return { mode: options.mode, verified: true, paths: distinct };
  };
}

export async function migrateSettings(options: MigrationOptions, dependencies: MigrationDependencies = {}): Promise<MigrationResult> {
  const apply = await preflightMigration(options, dependencies);
  await cleanSnapshotTemporaries(options.site.targets['wayroost-settings']!);
  return apply();
}

async function main(): Promise<void> {
  if (process.getuid!() === 0) throw new OwnerRequiredError();
  const [mode, ...args] = process.argv.slice(2);
  if (!['plan', 'forward', 'verify', 'reverse'].includes(mode ?? '')) throw new MigrationError('Usage: migrate-settings plan|forward|verify|reverse --targets PATH --legacy-dir PATH --legacy-paseo PATH --legacy-config PATH --stopped-unit UNIT (repeat for every writer)');
  const flags: Record<string, string[]> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!key || !['--targets', '--legacy-dir', '--legacy-paseo', '--legacy-config', '--stopped-unit'].includes(key) || !value) throw new MigrationError('Invalid migration arguments.');
    (flags[key] ??= []).push(value);
  }
  const single = (key: string) => { if (flags[key]?.length !== 1) throw new MigrationError(`Supply exactly one ${key}.`); return flags[key]![0]!; };
  const site = await loadSettingsTargets(single('--targets'));
  const result = await migrateSettings({ mode: mode as MigrationOptions['mode'], site, legacyDir: single('--legacy-dir'), legacyPaseo: single('--legacy-paseo'), legacyConfig: single('--legacy-config'), units: flags['--stopped-unit'] ?? [] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
export async function runMigrationCli(work: () => Promise<void> = main): Promise<void> {
  try { await work(); }
  catch (error) {
    let message = 'Migration failed.';
    if (error instanceof MigrationError) message = error.message;
    else if (error instanceof z.ZodError) message = 'Invalid settings schema.';
    else if (error instanceof LegacyConfigError) message = 'Invalid legacy configuration.';
    else if (error instanceof ConfigError) message = 'Configuration storage or validation failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runMigrationCli();
