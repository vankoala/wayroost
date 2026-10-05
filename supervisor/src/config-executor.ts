import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { READ_VIEWS, operationTarget, parseOperation, publicKeyNames, readViewValues, type ReadView, type ReadViewId } from '../../shared/settings-ops.js';
import { settingsTargetsSchema, type SettingsTargets } from '../../shared/settings-targets.js';
import { configApplyRequestSchema, configReadRequestSchema, configReadResultSchema, configUndoRequestSchema,
  type ConfigReadResult } from '../../shared/supervisor-config.js';
import { settingsErrorCodeSchema, sha256Schema, type SettingsErrorCode, type UndoToken } from '../../shared/settings.js';
import { SettingsCommitError, SettingsWriteError, SettingsWriteThrough, type TimingLabel, type UndoToken as CoreUndo } from '../../server/src/settings/write-through.js';
import { jsonEditor } from '../../server/src/settings/editors/json.js';
import { yamlEditor } from '../../server/src/settings/editors/yaml.js';
import { checkPreconditions, type ValuePrecondition } from '../../server/src/settings/editors/types.js';
import { checkConfigDirectory, configFileMissing, ConfigError, digest, readConfigFile } from './config-paths.js';
import { checkLockPath, withConsumerLock, type FileTarget } from './config-locks.js';
import { configOperations, resolveKey } from './config-operations.js';
import { readConfigToml } from './config-toml.js';
import { trustedExecutable } from './trust.js';
import { roleMapSchema, migrationTargetRecordSchema } from '../../shared/gateway.js';
import { checkConfigTransport, configExecutorWriteResultSchema, migrationRecord, type ConfigExecutorWriteResult } from './config-records.js';
import { readAgentAvailability } from './config-observations.js';
import { resolveHermesConfig } from './config-hermes.js';

const reservedBackupId = /^[a-f0-9]{64}\/\d{16}-[a-f0-9]{64}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.bak$/;
export const executorRequestSchema = z.object({
  site: settingsTargetsSchema,
  caller: z.enum(['server', 'launcher']),
  verb: z.enum(['config.read', 'config.apply', 'config.undo']),
  request: z.unknown(),
  backupId: z.string().regex(reservedBackupId).optional(),
  recoveryBackupIds: z.array(z.string().regex(reservedBackupId)).optional(),
  expectedSha256: sha256Schema.optional(),
  context: z.object({ roleMap: roleMapSchema.optional(), migration: migrationTargetRecordSchema.optional() }).strict().optional(),
  /** Root audit proof, supplied by the supervisor after matching the token. */
  undoProof: z.object({ operation: z.string(), target: z.string(), backupId: z.string(), backupSha256: z.string(), writtenSha256: z.string(), keys: z.array(z.string()) }).strict().optional(),
}).strict();
export type ExecutorRequest = z.infer<typeof executorRequestSchema>;
export interface ExecutorDependencies {
  validatePaseo?: (source: string, target: FileTarget) => Promise<void>;
  lock?: <T>(target: FileTarget, work: () => Promise<T>) => Promise<T>;
  uid?: number;
}
export const CONFIG_IMPLEMENTED_VERBS = ['config.read', 'config.apply', 'config.undo'] as const;
export type ExecutorResult = ConfigReadResult | ConfigExecutorWriteResult;

function checkedWriteResult(result: ConfigExecutorWriteResult): ConfigExecutorWriteResult {
  const parsed = configExecutorWriteResultSchema.parse(result);
  checkConfigTransport(parsed);
  return parsed;
}

export function configErrorCode(error: unknown): SettingsErrorCode {
  if (error instanceof ConfigError) return error.code;
  if (error instanceof SettingsWriteError) {
    const mapped: Record<string, SettingsErrorCode> = {
      changed_underneath: 'precondition_changed', precondition_failed: 'precondition_changed', verification_failed: 'verify_mismatch',
      invalid_backup: 'backup_mismatch', invalid_id: 'invalid_parameters', metadata_mismatch: 'unsafe_target',
      unsafe_storage: 'unsafe_directory', unsafe_audit: 'audit_unavailable', audit_failed: 'audit_unavailable',
      unsupported_yaml: 'parse_failed', invalid_operation: 'invalid_parameters', io_failed: 'failed',
    };
    return mapped[error.code] ?? (settingsErrorCodeSchema.safeParse(error.code).success ? error.code as SettingsErrorCode : 'failed');
  }
  return 'failed';
}

export function fileTarget(site: SettingsTargets, id: string): FileTarget {
  const target = site.targets[id as keyof SettingsTargets['targets']];
  if (!target || !('backupDir' in target) || !('auditDir' in target) || !('runAs' in target)) throw new ConfigError('not_configured');
  return target;
}

// Keep the core's shared audit lock inside the site's writable backup folder.
export const configBackupDirectory = (target: FileTarget): string => join(target.backupDir, 'files');

export function reserveConfigBackupId(path: string): string {
  const id = randomUUID();
  return `${digest(path)}/${String(Date.now()).padStart(16, '0')}-${digest(id)}-${id}.bak`;
}

async function saveReservedBackup(target: FileTarget, id: string, snapshot: Awaited<ReturnType<typeof readConfigFile>>): Promise<void> {
  const path = join(configBackupDirectory(target), id);
  await checkConfigDirectory(path, target.runAs.uid);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (const directory of [configBackupDirectory(target), dirname(path)]) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== target.runAs.uid || stat.mode & 0o077) throw new ConfigError('unsafe_directory');
  }
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, snapshot.expected.mode & 0o770);
  try { await file.writeFile(snapshot.source); await file.chmod(snapshot.expected.mode & 0o770); await file.sync(); }
  finally { await file.close(); }
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Called while the core holds the target lock; unresolved recovery stays pinned. */
async function expireConfigBackups(target: FileTarget, protectedId: string, recoveryIds: readonly string[]): Promise<void> {
  const path = join(configBackupDirectory(target), digest(target.path));
  await checkConfigDirectory(path, target.runAs.uid, true);
  let names: string[];
  try { names = await readdir(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const protectedNames = new Set([protectedId, ...recoveryIds].map(id => basename(id)));
  let completed = 1;
  for (const name of names.sort().reverse()) {
    if (protectedNames.has(name)) continue;
    const time = name.match(/^(\d{16})-[a-f0-9]{64}-[a-f0-9-]{36}\.bak$/)?.[1];
    if (!time) continue;
    if (await lstat(join(path, `${name}.recovery.json`)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    })) continue;
    if (++completed <= 10 && Number(time) >= Date.now() - 30 * 24 * 60 * 60 * 1000) continue;
    const backup = join(path, name);
    const stat = await lstat(backup);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== target.runAs.uid || stat.nlink !== 1) throw new ConfigError('backup_mismatch');
    await unlink(backup);
  }
}

export async function preflightTarget(target: FileTarget, writing = true): Promise<void> {
  checkLockPath(target);
  await checkConfigDirectory(target.path, target.runAs.uid);
  await checkConfigDirectory(target.backupDir, target.runAs.uid, true);
  await checkConfigDirectory(target.auditDir, target.runAs.uid, true);
  await checkConfigDirectory(target.lock.path, target.runAs.uid);
  if (writing) {
    for (const path of [target.backupDir, target.auditDir]) {
      const stat = await lstat(path).catch(() => { throw new ConfigError('not_configured'); });
      if (!stat.isDirectory() || stat.uid !== target.runAs.uid || stat.mode & 0o077) throw new ConfigError('unsafe_directory');
    }
    const stat = await lstat(target.path).catch(() => { throw new ConfigError('target_missing'); });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== target.runAs.uid
      || target.mode !== undefined && (stat.mode & 0o7777) !== target.mode) throw new ConfigError('unsafe_target');
  }
}

/** The loader receives a private home containing config.json, as the daemon does. */
export async function validateInstalledPaseo(source: string, target: FileTarget): Promise<void> {
  if (!('loader' in target)) throw new ConfigError('consumer_refused');
  let home: string | undefined;
  try {
    await trustedExecutable(target.loader);
    await mkdir(target.auditDir, { recursive: true, mode: 0o700 });
    home = await mkdtemp(join(target.auditDir, 'validate-'));
    await writeFile(join(home, 'config.json'), source, { mode: 0o600, flag: 'wx' });
    const loader = await import(pathToFileURL(target.loader).href) as { readPersistedConfig?: (home: string) => unknown };
    if (typeof loader.readPersistedConfig !== 'function' || !await loader.readPersistedConfig(home)) throw new Error();
  } catch { throw new ConfigError('consumer_refused'); }
  finally { if (home) await rm(home, { recursive: true, force: true }); }
}

function externalToken(operation: string, target: UndoToken['target'], token: CoreUndo, backupId: string): UndoToken {
  return { operation, target, backupId, backupSha256: token.backupHash, writtenSha256: token.writtenHash };
}

/** Read a checked snapshot without changing the target or its lock. */
export async function readConfigView(site: SettingsTargets, id: ReadViewId): Promise<ConfigReadResult> {
  const view: ReadView = READ_VIEWS[id];
  try { return await readConfigSnapshot(site, id); }
  catch (error) {
    if (view.target === 'hermes-config' && !view.persisted) throw new ConfigError('unavailable');
    throw error;
  }
}

async function readConfigSnapshot(site: SettingsTargets, id: ReadViewId): Promise<ConfigReadResult> {
  const view: ReadView = READ_VIEWS[id];
  if (id === 'wayroost.agents') {
    if (!site.agentStatus) throw new ConfigError('not_configured');
    const document = { agents: await readAgentAvailability(site.agentStatus) };
    return { ok: true, view: id, present: true, sha256: digest(JSON.stringify(document)),
      values: (await readViewValues(id, document, { scopes: ['settings'] })).map(value => ({ ...value, path: [...value.path] })) };
  }
  const target = site.targets[view.target];
  if (!target || !('runAs' in target) || !('path' in target)) throw new ConfigError('not_configured');
  let snapshot;
  const policy = 'drvfs' in target && target.drvfs ? 'drvfs' : view.target === 'hermes-managed' ? 'root-managed' : 'owner';
  const read = () => readConfigFile(target.path, target.runAs.uid, 'mode' in target ? target.mode : undefined, policy).catch(error => {
    if (error instanceof ConfigError && error.code === 'target_missing') return undefined;
    throw error;
  });
  snapshot = await read();
  const effectiveHermes = view.target === 'hermes-config' && !view.persisted;
  if (!snapshot && !effectiveHermes) return { ok: true, view: id, present: false, values: [] };
  const managed = effectiveHermes ? site.targets['hermes-managed'] : undefined;
  const readManaged = () => managed ? readConfigFile(managed.path, managed.runAs.uid, undefined, 'root-managed').catch(error => {
    if (error instanceof ConfigError && error.code === 'target_missing') return undefined;
    throw error;
  }) : undefined;
  const managedBefore = await readManaged();
  const document = effectiveHermes ? await resolveHermesConfig(site, view)
    : target.format === 'toml' ? readConfigToml(snapshot!.source) : (target.format === 'yaml' ? yamlEditor : jsonEditor).parse(snapshot!.source);
  if (effectiveHermes && ((await read())?.sha256 !== snapshot?.sha256 || (await readManaged())?.sha256 !== managedBefore?.sha256)) {
    throw new ConfigError('precondition_changed');
  }
  const context = { scopes: ['settings', 'pc-settings'] as const, listener: 'local' as const, pcOnlyWrites: true };
  const values = (await readViewValues(id, document, context)).map(value => ({ ...value, path: [...value.path] }));
  const order = view.order?.map(path => {
    let object: unknown = document;
    for (const segment of path) object = object && typeof object === 'object' && Object.hasOwn(object, segment) ? (object as Record<string, unknown>)[segment] : undefined;
    return { path: [...path], names: object && typeof object === 'object' && !Array.isArray(object) ? Object.keys(object) : [] };
  });
  return { ok: true, view: id, present: !!snapshot, ...(snapshot ? { sha256: snapshot.sha256 } : {}), values,
    ...(effectiveHermes ? { effective: true as const } : {}), ...(order ? { order } : {}) };
}

async function readView(input: ExecutorRequest, dependencies: ExecutorDependencies): Promise<ConfigReadResult> {
  const parsed = configReadRequestSchema.safeParse(input.request);
  if (!parsed.success) throw new ConfigError('invalid_parameters');
  if (parsed.data.view === 'wayroost.agents') {
    const target = input.site.agentStatus;
    if (!target) throw new ConfigError('not_configured');
    if ((dependencies.uid ?? process.getuid?.()) !== target.runAs.uid || target.runAs.uid === 0) throw new ConfigError('unsafe_target');
    await checkConfigDirectory(target.home, target.runAs.uid, true);
    return readConfigView(input.site, parsed.data.view);
  }
  const targetId = READ_VIEWS[parsed.data.view].target;
  const target = input.site.targets[targetId];
  if (!target || !('runAs' in target) || !('path' in target)) throw new ConfigError('not_configured');
  if ((dependencies.uid ?? process.getuid?.()) !== target.runAs.uid) throw new ConfigError('unsafe_target');
  if (targetId === 'pi-settings' && await configFileMissing(target.path, target.runAs.uid)) {
    return { ok: true, view: parsed.data.view, present: false, values: [] };
  }
  try {
    if ('backupDir' in target && 'auditDir' in target) await preflightTarget(target, false);
    const work = () => readConfigView(input.site, parsed.data.view);
    if ('lock' in target) return await (dependencies.lock ?? withConsumerLock)(target, work);
    return await work();
  } catch (error) {
    const view: ReadView = READ_VIEWS[parsed.data.view];
    if (view.target === 'hermes-config' && !view.persisted) throw new ConfigError('unavailable');
    throw error;
  }
}

async function writeConfig(input: ExecutorRequest, dependencies: ExecutorDependencies): Promise<ConfigExecutorWriteResult> {
  if (!input.site.configWrites) throw new ConfigError('config_writes_off');
  const applying = input.verb === 'config.apply';
  const apply = applying ? configApplyRequestSchema.safeParse(input.request) : undefined;
  const undo = !applying ? configUndoRequestSchema.safeParse(input.request) : undefined;
  if (apply && !apply.success || undo && !undo.success) throw new ConfigError('invalid_parameters');
  const request = apply?.success ? apply.data : undefined;
  const undoRequest = undo?.success ? undo.data : undefined;
  const operation = request?.operation ?? undoRequest!.token.operation;
  const parsed = request ? parseOperation(operation, request.params, input.caller) : undefined;
  if (parsed && !parsed.ok) throw new ConfigError(parsed.code);
  if (parsed?.ok && parsed.spec.records && (!input.context || !input.site.targets['gateway-state'])) throw new ConfigError('not_configured');
  const targetId = parsed?.ok ? operationTarget(parsed.spec, parsed.params) : undoRequest!.token.target;
  const target = fileTarget(input.site, targetId);
  const backupId = input.backupId ?? reserveConfigBackupId(target.path);
  const recoveryIds = input.recoveryBackupIds ?? [];
  if ([backupId, ...recoveryIds].some(id => id.split('/')[0] !== digest(target.path))) throw new ConfigError('invalid_parameters');
  if ((dependencies.uid ?? process.getuid?.()) !== target.runAs.uid) throw new ConfigError('unsafe_target');
  await preflightTarget(target);
  return (dependencies.lock ?? withConsumerLock)(target, async () => {
    const snapshot = await readConfigFile(target.path, target.runAs.uid, target.mode);
    if (input.expectedSha256 !== undefined && snapshot.sha256 !== input.expectedSha256) throw new ConfigError('precondition_changed');
    const editor = target.format === 'yaml' ? yamlEditor : jsonEditor;
    let reverseToken: CoreUndo | undefined;
    let keys: string[] = [];
    const core = new SettingsWriteThrough({ backupDir: configBackupDirectory(target), auditFile: join(target.auditDir, 'audit.jsonl'), keepBackups: Number.MAX_SAFE_INTEGER,
      coordinate: async (_target, work) => {
        const current = await readConfigFile(target.path, target.runAs.uid, target.mode);
        if (current.sha256 !== snapshot.sha256) throw new ConfigError('precondition_changed');
        await saveReservedBackup(target, backupId, current);
        const folder = join(configBackupDirectory(target), digest(target.path));
        const before = applying ? undefined : new Set(await readdir(folder));
        const result = await work();
        if (!applying) {
          // The core retains its reverse recovery record through coordination.
          const names = (await readdir(folder)).filter(name => name.endsWith('.recovery.json') && !before!.has(name));
          if (names.length !== 1) throw new ConfigError('verify_mismatch');
          const saved = JSON.parse((await readConfigFile(join(folder, names[0]!), target.runAs.uid, 0o600)).source) as { action?: string; id?: string; undoToken?: CoreUndo };
          const token = saved.undoToken;
          if (saved.action !== 'undo' || !token || saved.id !== `${token.backupId}.recovery.json`
            || join(configBackupDirectory(target), saved.id) !== join(folder, names[0]!) || token.target !== target.path
            || token.backupHash !== snapshot.sha256 || token.writtenHash !== undoRequest!.token.backupSha256) throw new ConfigError('verify_mismatch');
          reverseToken = token;
        }
        // The reserved snapshot is the public rollback backup; the core's copy is temporary.
        const token = applying ? result as CoreUndo : reverseToken!;
        await checkConfigDirectory(join(configBackupDirectory(target), token.backupId), target.runAs.uid);
        await unlink(join(configBackupDirectory(target), token.backupId));
        await expireConfigBackups(target, backupId, recoveryIds);
        return result;
      } });
    const context = request?.origin ?? undoRequest?.origin;
    try {
      if (request) {
        if (request.afterSeconds !== undefined) throw new ConfigError('invalid_parameters');
        const current = editor.parse(snapshot.source);
        const plan = configOperations(operation, request.params, input.caller, current, input.site, input.context);
        keys = await publicKeyNames(targetId, plan.paths);
        const preconditions: ValuePrecondition[] = request.preconditions && 'keys' in request.preconditions ? request.preconditions.keys.map(condition => {
          const path = plan.paths[condition.key];
          if (!path) throw new ConfigError('invalid_parameters');
          const resolved = resolveKey(path, current);
          return 'value' in condition ? { path: resolved, value: condition.value } : { path: resolved, exists: condition.exists };
        }) : [];
        if (request.preconditions && 'file' in request.preconditions && request.preconditions.file.sha256 !== snapshot.sha256) throw new ConfigError('precondition_changed');
        checkPreconditions(current, preconditions);
        const edited = plan.operations.length ? editor.edit(snapshot.source, plan.operations) : snapshot.source;
        const record = parsed?.ok && parsed.spec.records || input.context?.migration
          ? migrationRecord(targetId, plan.paths, current, editor.parse(edited), snapshot.sha256, digest(edited)) : undefined;
        const prospectiveUndo = { operation, target: targetId, backupId, backupSha256: snapshot.sha256, writtenSha256: digest(edited) };
        const prospective = checkedWriteResult({ ok: true, keys: plan.operations.length ? keys : [], ...prospectiveUndo, undo: prospectiveUndo,
          ...(plan.operations.length ? {} : { unchanged: true }), ...(record ? { record } : {}) });
        if (targetId === 'paseo-config') {
          try { await (dependencies.validatePaseo ?? validateInstalledPaseo)(edited, target); }
          catch { throw new ConfigError('consumer_refused'); }
        }
        if (plan.operations.length === 0) {
          await saveReservedBackup(target, backupId, snapshot);
          await expireConfigBackups(target, backupId, recoveryIds);
          return prospective;
        }
        const timing: TimingLabel = 'now';
        const token = await core.apply({ target: target.path, editor: target.format, operations: plan.operations, timing, expected: snapshot.expected,
          version: { hash: snapshot.sha256 }, preconditions, ...(context ? { level: context.level, device: context.device?.id } : {}) });
        const undoToken = externalToken(operation, targetId, token, backupId);
        if (token.backupHash !== prospectiveUndo.backupSha256 || token.writtenHash !== prospectiveUndo.writtenSha256) throw new ConfigError('verify_mismatch');
        return { ok: true, keys, ...undoToken, undo: undoToken, ...(record ? { record } : {}) };
      }
      const token = undoRequest!.token;
      const proof = input.undoProof;
      if (!proof || ['operation', 'target', 'backupId', 'backupSha256', 'writtenSha256'].some(key => proof[key as keyof typeof proof] !== token[key as keyof typeof token])) throw new ConfigError('backup_mismatch');
      keys = proof.keys;
      if (snapshot.sha256 !== token.writtenSha256) throw new ConfigError('undo_changed');
      const backup = await readConfigFile(join(configBackupDirectory(target), token.backupId), target.runAs.uid);
      if (backup.sha256 !== token.backupSha256) throw new ConfigError('backup_mismatch');
      const record = input.context?.migration ? migrationRecord(targetId, input.context.migration.keys.map(key => key.path), editor.parse(snapshot.source),
        editor.parse(backup.source), snapshot.sha256, backup.sha256) : undefined;
      const prospectiveReverse = { operation, target: targetId, backupId, backupSha256: snapshot.sha256, writtenSha256: backup.sha256 };
      checkedWriteResult({ ok: true, keys, ...prospectiveReverse, undo: prospectiveReverse, ...(record ? { record } : {}) });
      if (targetId === 'paseo-config') {
        try { await (dependencies.validatePaseo ?? validateInstalledPaseo)(backup.source, target); }
        catch { throw new ConfigError('consumer_refused'); }
      }
      await core.undo({ target: target.path, editor: target.format, expected: snapshot.expected, timing: 'now', backupId: token.backupId,
        backupHash: token.backupSha256, writtenHash: token.writtenSha256 });
      if (!reverseToken) throw new ConfigError('verify_mismatch');
      const reverse = externalToken(operation, targetId, reverseToken, backupId);
      if (reverse.backupSha256 !== prospectiveReverse.backupSha256 || reverse.writtenSha256 !== prospectiveReverse.writtenSha256) throw new ConfigError('verify_mismatch');
      return { ok: true, ...reverse, keys, undo: reverse, ...(record ? { record } : {}) };
    } catch (error) {
      if (error instanceof SettingsCommitError) {
        return { ok: false, code: configErrorCode(error), committed: true, undo: externalToken(operation, targetId, error.recovery.undoToken, backupId) };
      }
      throw error;
    }
  });
}

/** One result only; neither loader errors nor config values are emitted on failure. */
export async function executeConfig(input: unknown, dependencies: ExecutorDependencies = {}): Promise<ExecutorResult> {
  try {
    const parsed = executorRequestSchema.safeParse(input);
    if (!parsed.success) throw new ConfigError('invalid_parameters');
    const result = parsed.data.verb === 'config.read' ? await readView(parsed.data, dependencies) : await writeConfig(parsed.data, dependencies);
    return (parsed.data.verb === 'config.read' ? configReadResultSchema : configExecutorWriteResultSchema).parse(result);
  } catch (error) { return { ok: false, code: configErrorCode(error) }; }
}
