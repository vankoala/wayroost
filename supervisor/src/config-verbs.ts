import { gatewayOwnerUid, readGatewayListeners, readGatewayPersistence, readGatewayStatus } from './config-observations.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CONFIG_IMPLEMENTED_VERBS, configBackupDirectory, configErrorCode, fileTarget, preflightTarget, readConfigView, reserveConfigBackupId, type ExecutorRequest, type ExecutorResult } from './config-executor.js';
import { ConfigAudit, configRequestFinished } from './config-audit.js';
import { ConfigError, checkConfigDirectory, configFileMissing, digest, loadSettingsTargets, readConfigFile } from './config-paths.js';
import { configUnit, configUnitRunner, gatewayPointUnit, type ConfigUnitRunner, type ConfigUnitTarget } from './config-unit.js';
import { keyMay, keyRole, configApplyRequestSchema, configReadRequestSchema, configReadResultSchema, configUndoRequestSchema, configWriteResultSchema,
  configRequestStatusRequestSchema, type ConfigRequestStatusResult, type ConfigAuditRow, type ConfigReadResult, type ConfigVerbsStatus, type ConfigDirectoryRow, type ConfigWriteResult } from '../../shared/supervisor-config.js';
import { CATALOGUE_VERSION, READ_VIEWS, operationKeys, operationSpec, operationTarget, parseOperation, publicKeyNames, readViewValues, type ReadView } from '../../shared/settings-ops.js';
import { undoTokenSchema, type SettingsErrorCode, type KeyPath } from '../../shared/settings.js';
import { type SettingsTargets, type TargetId } from '../../shared/settings-targets.js';
import type { Key } from './keys.js';
import { trustedExecutable, type Trust } from './trust.js';
import type { PaseoReload } from './config-paseo.js';
import { GatewayConfigState, type MigrationUpdate } from './config-gateway-state.js';
import { checkConfigTransport, configExecutorWriteResultSchema, migrationRecord, recordedKind } from './config-records.js';
import { configOperations } from './config-operations.js';
import { jsonEditor } from '../../server/src/settings/editors/json.js';
import { yamlEditor } from '../../server/src/settings/editors/yaml.js';
import { GATEWAY_CONSUMERS, roleMapSchema, migrationTargetRecordSchema, gatewayRepointResultSchema, gatewayOverrideSchema, gatewayRoleSchema, backendIdSchema,
  type RoleMap, type MigrationTarget, type GatewayConsumer, type MigrationTargetRecord, type GatewayMigration } from '../../shared/gateway.js';
import { ConfigServices } from './config-services.js';
import type { ConfigCommand } from './config-command.js';
import { recoveryUnit } from './config-recovery.js';
import type { gatewayAdmin } from './gateway-admin.js';
import { checksObserveRequestSchema, checksObserveResultSchema, projectScanRequestSchema, projectScanResultSchema, type ChecksObserveResult } from '../../shared/supervisor-observations.js';
import { observationEntry, projectScanUnit } from './owner-observations.js';

const unknownOutcome = (row: ConfigAuditRow): Extract<ConfigWriteResult, { code: 'outcome_unknown' }> => ({
  ok: false, code: 'outcome_unknown', target: row.target as TargetId, backupId: row.backupId ?? null,
});

export interface ConfigVerbsOptions {
  stateDir: string;
  site?: () => Promise<SettingsTargets>;
  runner?: ConfigUnitRunner;
  trust?: Trust;
  executable?: string;
  entry?: string;
  gatewayEntry?: string;
  gatewayState?: (site: SettingsTargets) => GatewayConfigState;
  roleMap?: (site: SettingsTargets) => Promise<{ map: RoleMap; sha256: string }>;
  gatewayUid?: (site: SettingsTargets) => Promise<number>;
  serviceEntry?: string;
  serviceCommand?: ConfigCommand;
  serviceAdmin?: typeof gatewayAdmin;
  observationEntry?: string;
  /** The supported client reloads the daemon and verifies its effective configuration. */
  reloadPaseo?: PaseoReload;
  audit?: ConfigAudit;
}

export class ConfigVerbs {
  private readonly services: ConfigServices;
  private readonly audit: ConfigAudit;
  private readonly site: () => Promise<SettingsTargets>;
  private readonly runner: ConfigUnitRunner;
  private readonly trust: Trust;
  private readonly requests = new Map<string, { binding: string; result: Promise<ExecutorResult> }>();
  constructor(private readonly options: ConfigVerbsOptions) {
    this.audit = options.audit ?? new ConfigAudit(options.stateDir);
    this.trust = options.trust ?? trustedExecutable;
    this.site = options.site ?? (() => loadSettingsTargets());
    this.runner = options.runner ?? configUnitRunner(this.trust);
    this.services = new ConfigServices({ site: this.site, runner: this.runner, trust: this.trust, audit: this.audit,
      executable: options.executable, entry: options.serviceEntry, command: options.serviceCommand, admin: options.serviceAdmin });
  }
  async status(): Promise<ConfigVerbsStatus & { directories: ConfigDirectoryRow[]; drainSweep?: { ok: boolean; code?: SettingsErrorCode } }> {
    let site: SettingsTargets | undefined;
    try { site = await this.site(); } catch {}
    const directories: ConfigDirectoryRow[] = [];
    for (const [id, target] of Object.entries(site?.targets ?? {})) {
      const uid = 'runAs' in target ? target.runAs.uid : id === 'gateway-role-map'
        ? await gatewayOwnerUid(site!).catch(() => undefined) : 0;
      const paths: { storage: ConfigDirectoryRow['storage']; path: string; directory: boolean }[] = [];
      if ('path' in target) paths.push({ storage: 'target', path: target.path, directory: false });
      if ('directory' in target) paths.push({ storage: 'target', path: target.directory, directory: true });
      if ('dropIn' in target) paths.push({ storage: 'target', path: target.dropIn, directory: false });
      if ('backupDir' in target) paths.push({ storage: 'backup', path: target.backupDir, directory: true });
      if ('auditDir' in target) paths.push({ storage: 'audit', path: target.auditDir, directory: true });
      if ('lockFile' in target) paths.push({ storage: 'lock', path: target.lockFile, directory: false });
      if ('lock' in target) paths.push({ storage: 'lock', path: target.lock.path, directory: false });
      for (const { storage, path, directory } of paths) {
        try {
          if (uid === undefined) throw new ConfigError('unsafe_directory');
          await checkConfigDirectory(path, uid, directory, 'drvfs' in target && target.drvfs ? 'drvfs' : 'owner');
          directories.push({ target: id as TargetId, storage, ok: true });
        }
        catch { directories.push({ target: id as TargetId, storage, ok: false, code: 'unsafe_directory' }); }
      }
    }
    return { version: 1, catalogue: CATALOGUE_VERSION, verbs: ['config.read', 'config.request-status', ...CONFIG_IMPLEMENTED_VERBS.filter(verb => verb !== 'config.read'), 'credential.write', 'credential.test', 'service.drain-restart', 'service.drain-status', 'project.scan', 'checks.observe'], configWrites: site?.configWrites ?? false, directories,
      ...(this.services.sweepStatus ? { drainSweep: this.services.sweepStatus } : {}),
      ...(site?.targets['gateway-state'] ? { gatewayPersistence: await readGatewayPersistence(this.options.stateDir) } : {}) };
  }
  async read(input: unknown, key: Key): Promise<ConfigReadResult> {
    const result = await this.run('config.read', input, key) as ConfigReadResult;
    const request = configReadRequestSchema.safeParse(input);
    if (keyMay(keyRole(key), 'config.read') && request.success) {
      const view: ReadView = READ_VIEWS[request.data.view];
      if (view.target === 'hermes-config' && !view.persisted && !result.ok) return { ok: false, code: 'unavailable' };
    }
    return result;
  }
  apply(input: unknown, key: Key): Promise<ConfigWriteResult> {
    return this.run('config.apply', input, key) as Promise<ConfigWriteResult>;
  }
  undo(input: unknown, key: Key): Promise<ConfigWriteResult> { return this.run('config.undo', input, key) as Promise<ConfigWriteResult>; }
  async initialize(): Promise<void> { await this.audit.initialize(); await this.services.initialize(); }
  async requestStatus(input: unknown, key: Key): Promise<ConfigRequestStatusResult> {
    if (!keyMay(keyRole(key), 'config.request-status')) return { ok: false, code: 'not_permitted' };
    const parsed = configRequestStatusRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'invalid_parameters' };
    const { requestId } = parsed.data;
    try {
      const record = await this.audit.request(requestId);
      if (!record) return { ok: true, requestId, state: 'missing' };
      if (record.interrupted) return { ok: true, requestId, state: 'interrupted' };
      if (!configRequestFinished(record)) {
        return { ok: true, requestId, state: 'pending' };
      }
      const row = record.row;
      const result = record.result ?? record.credentialResult;
      const outcome = row.result === 'ok' ? 'applied' : row.result === 'outcome_unknown'
        || result && !result.ok && 'committed' in result ? 'outcome_unknown' : 'refused';
      return { ok: true, requestId, state: 'terminal', row, outcome };
    } catch { return { ok: false, code: 'audit_unavailable' }; }
  }
  credential(input: unknown, key: Key) { return this.services.credential(input, key); }
  credentialTest(input: unknown, key: Key) { return this.services.credentialTest(input, key); }
  drainRestart(input: unknown, key: Key) { return this.services.drain(input, key); }
  drainRestartRun(id: string) { return this.services.runStatus(id); }
  importKeys(input: unknown, key: Key) { return this.services.importKeys(input, key); }
  async usageSocket(): Promise<string | undefined> { return (await this.site()).targets['gateway-role-map']?.adminSocket; }
  private async observation<T>(unit: import('./config-unit.js').ConfigUnit, schema: z.ZodType<T>): Promise<T> {
    const separator = unit.argv.indexOf('--');
    for (const path of [unit.argv[0]!, unit.argv[separator + 1]!, unit.argv[separator + 2]!]) await this.trust(path);
    const output = await this.runner(unit);
    if (output.code !== 0 || Buffer.byteLength(output.stdout) > 1024 * 1024 || output.stdout.trim().split('\n').length !== 1) throw new ConfigError('unavailable');
    return schema.parse(JSON.parse(output.stdout));
  }
  async projectScan(input: unknown, key: Key) {
    if (!keyMay(keyRole(key), 'project.scan')) return { ok: false, code: 'not_permitted' } as const;
    if (!projectScanRequestSchema.safeParse(input).success) return { ok: false, code: 'invalid_parameters' } as const;
    try { return await this.observation(await projectScanUnit(input, this.options.executable, this.options.observationEntry), projectScanResultSchema); }
    catch (error) { return { ok: false, code: configErrorCode(error) } as const; }
  }
  async checksObserve(input: unknown, key: Key): Promise<ChecksObserveResult> {
    if (!keyMay(keyRole(key), 'checks.observe')) return { ok: false, code: 'not_permitted' };
    if (!checksObserveRequestSchema.safeParse(input).success) return { ok: false, code: 'invalid_parameters' };
    try {
      const site = await this.site();
      const result: Extract<ChecksObserveResult, { ok: true }> = { ok: true, hermesStartedAt: null, coderProcesses: null, drainMarker: null, switchFlags: null };
      const sources = [
        { kind: 'hermes', owner: site.hermes?.runAs },
        { kind: 'coder', owner: site.coderMcp ? site.targets['pi-mcp']?.runAs ?? site.hermes?.runAs ?? site.agentStatus?.runAs : undefined },
        { kind: 'flags', owner: site.switchFlags?.runAs },
      ] as const;
      await Promise.all(sources.map(async ({ kind, owner }) => {
        if (!owner || owner.uid === 0) return;
        try {
          const observed = await this.observation(configUnit({ path: '/', uid: owner.uid }, { mode: 'checks-observe', site, uid: owner.uid, kind },
            this.options.executable, this.options.observationEntry ?? observationEntry), checksObserveResultSchema);
          if (!observed.ok) return;
          if (kind === 'hermes') { result.hermesStartedAt = observed.hermesStartedAt; result.drainMarker = observed.drainMarker; }
          if (kind === 'coder') result.coderProcesses = observed.coderProcesses;
          if (kind === 'flags') result.switchFlags = observed.switchFlags;
        } catch { /* Missing observations stay unknown. */ }
      }));
      return result;
    } catch { return { ok: false, code: 'unavailable' }; }
  }

  private async run(verb: ExecutorRequest['verb'], input: unknown, key: Key): Promise<ExecutorResult> {
    if (!keyMay(keyRole(key), verb)) return { ok: false, code: 'not_permitted' };
    const schema = verb === 'config.read' ? configReadRequestSchema : verb === 'config.apply' ? configApplyRequestSchema : configUndoRequestSchema;
    const parsed = schema.safeParse(input);
    if (!parsed.success || 'afterSeconds' in parsed.data && parsed.data.afterSeconds !== undefined) return { ok: false, code: 'invalid_parameters' };
    if (!('requestId' in parsed.data)) return this.execute(verb, parsed.data, key);
    const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, item]) => [name, stable(item)])) : value;
    const identity = { requestSha256: digest(JSON.stringify(stable({ verb, request: parsed.data }))),
      callerSha256: digest(JSON.stringify([key.name, key.scope, key.sha256])) };
    const binding = JSON.stringify(identity);
    const id = parsed.data.requestId;
    const active = this.requests.get(id);
    if (active) return active.binding === binding ? structuredClone(await active.result) : { ok: false, code: 'invalid_parameters' };
    const result = (async (): Promise<ExecutorResult> => {
      try {
        const previous = await this.audit.request(id);
        if (previous) {
          if (previous.requestSha256 !== identity.requestSha256 || previous.callerSha256 !== identity.callerSha256) return { ok: false, code: 'invalid_parameters' };
          const row = previous.row;
          try {
            const result = previous.result ?? unknownOutcome(row);
            if (!previous.result) await this.audit.save({ ...previous, row: { ...row, result: 'outcome_unknown' }, result });
            await this.audit.reconcile();
            return result;
          } catch { return unknownOutcome(row); }
        }
        return await this.execute(verb, parsed.data, key, identity);
      } catch (error) { return { ok: false, code: configErrorCode(error) }; }
    })();
    this.requests.set(id, { binding, result });
    try { return structuredClone(await result); }
    finally { this.requests.delete(id); }
  }

  private async execute(verb: ExecutorRequest['verb'], input: unknown, key: Key,
    identity?: { requestSha256: string; callerSha256: string }): Promise<ExecutorResult> {
    try {
      const site = await this.site();
      const request = (verb === 'config.apply' ? configApplyRequestSchema : verb === 'config.undo' ? configUndoRequestSchema : configReadRequestSchema).parse(input);
      if ('view' in request && request.view === 'wayroost.agents') {
        const target = site.agentStatus;
        if (!target) throw new ConfigError('not_configured');
        await checkConfigDirectory(target.home, target.runAs.uid, true);
        const unit = configUnit({ path: target.home, uid: target.runAs.uid },
          { site, caller: 'server', verb: 'config.read', request }, this.options.executable, this.options.entry);
        const separator = unit.argv.indexOf('--');
        try {
          await this.trust(unit.argv[0]!); await this.trust(unit.argv[separator + 1]!); await this.trust(unit.argv[separator + 2]!);
        } catch { throw new ConfigError('unsafe_target'); }
        const output = await this.runner(unit);
        if (output.code === 124 || output.result === 'timeout') throw new ConfigError('timeout');
        if (output.code !== 0 || Buffer.byteLength(output.stdout) > 1024 * 1024 || output.stdout.trim().split('\n').length !== 1) throw new ConfigError('unavailable');
        const result = configReadResultSchema.parse(JSON.parse(output.stdout));
        if (result.ok && result.view !== request.view) throw new ConfigError('verify_mismatch');
        return result;
      }
      const spec = 'operation' in request ? operationSpec(request.operation) : 'token' in request ? operationSpec(request.token.operation) : undefined;
      if ('view' in request && (request.view === 'gateway.state' || request.view === 'gateway.role-map')) {
        let document: unknown;
        let sha256: string;
        if (request.view === 'gateway.state') {
          const state = this.options.gatewayState?.(site) ?? new GatewayConfigState(site);
          const snapshot = await state.snapshot();
          if (!snapshot.present) return { ok: true, view: request.view, present: false, values: [] };
          document = snapshot.document; sha256 = snapshot.sha256;
        } else {
          try { const snapshot = await this.roleMap(site); document = snapshot.map; sha256 = snapshot.sha256; }
          catch (error) {
            if (error instanceof ConfigError && error.code === 'target_missing') return { ok: true, view: request.view, present: false, values: [] };
            throw error;
          }
        }
        const values = await readViewValues(request.view, document, { scopes: ['settings', 'pc-settings'], listener: 'local', pcOnlyWrites: true });
        return configReadResultSchema.parse({ ok: true, view: request.view, present: true, sha256, values });
      }
      const caller = keyRole(key) === 'launcher' ? 'launcher' : 'server';
      if ('operation' in request) {
        const operation = parseOperation(request.operation, request.params, caller);
        if (!operation.ok) throw new ConfigError(operation.code);
        if (operation.spec.verb !== 'config.apply') throw new ConfigError('not_permitted');
        if (request.afterSeconds !== undefined) throw new ConfigError('invalid_parameters');
      } else if ('token' in request && (!spec || spec.recovery || !spec.callers.includes(caller))) throw new ConfigError('not_permitted');
      if (verb !== 'config.read' && !site.configWrites) throw new ConfigError('config_writes_off');
      if ('operation' in request && spec?.recovery && request.operation === 'hermes.drain-marker-remove') {
        return await this.services.withDrainRecovery(() => this.executeRequest(verb, input, key, identity, site, undefined));
      }
      if (spec && (spec.records || spec.keys === 'recorded')) {
        const state = this.options.gatewayState?.(site) ?? new GatewayConfigState(site);
        return await state.withLock(() => this.executeRequest(verb, input, key, identity, site, state));
      }
      return await this.executeRequest(verb, input, key, identity, site, undefined);
    } catch (error) { return { ok: false, code: configErrorCode(error) }; }
  }

  private async roleMap(site: SettingsTargets): Promise<{ map: RoleMap; sha256: string }> {
    if (this.options.roleMap) return this.options.roleMap(site);
    const target = site.targets['gateway-role-map'];
    if (!target) throw new ConfigError('not_configured');
    const uid = await (this.options.gatewayUid ?? gatewayOwnerUid)(site);
    const snapshot = await readConfigFile(target.path, uid, 0o600, 'owner', 128 * 1024);
    return { map: roleMapSchema.parse(JSON.parse(snapshot.source)), sha256: snapshot.sha256 };
  }

  /** Saved records must fit later apply, restore and undo envelopes, including their results. */
  private async checkMigrationTransport(migration: GatewayMigration, target: MigrationTarget & TargetId, payload: ExecutorRequest): Promise<void> {
    const records = GATEWAY_CONSUMERS.flatMap(consumer => {
      const record = (migration.consumers[consumer] as Partial<Record<MigrationTarget, MigrationTargetRecord>> | undefined)?.[target];
      return record ? [{ consumer, record }] : [];
    });
    const moved = records.filter(({ record }) => record.moved);
    if (moved.length > 1) {
      const combined = migrationTargetRecordSchema.safeParse({ ...moved[0]!.record, keys: moved.flatMap(({ record }) => record.keys)
        .filter((key, index, keys) => keys.findIndex(other => isDeepStrictEqual(key.path, other.path)) === index) });
      if (!combined.success) throw new ConfigError('invalid_parameters');
      records.push({ consumer: moved[0]!.consumer, record: combined.data });
    }
    const serving = { provider: 'x'.repeat(64), model: 'x'.repeat(200), baseUrl: 'http://127.0.0.1/' + 'x'.repeat(2031) };
    for (const { consumer, record } of records) {
      const keys = await publicKeyNames(target, record.keys.map(key => key.path));
      const token = { operation: 'gateway.restore-recorded', target, backupId: payload.backupId!,
        backupSha256: record.preMoveBackupSha256, writtenSha256: record.postMoveSha256 };
      const base = { ...payload, caller: 'server', context: { migration: record }, expectedSha256: record.postMoveSha256 };
      checkConfigTransport({ ...base, verb: 'config.apply', request: { requestId: randomUUID(), operation: token.operation,
        params: { consumer, target, serving, keepRoleEntries: true } } });
      checkConfigTransport({ ...base, verb: 'config.undo', request: { requestId: randomUUID(), token }, undoProof: { ...token, keys } });
      const result = { ok: true, ...token, keys, undo: token, unchanged: true };
      checkConfigTransport({ ...result, record });
      checkConfigTransport({ ...result, record: { ...record, keys: record.keys.map(key => ({ ...key, before: key.intended })) } });
      checkConfigTransport({ ...result, record: { ...record, keys: record.keys.map(key => {
        const name = key.path.join('.');
        const value = ['model.provider', 'defaultProvider'].includes(name) ? serving.provider
          : ['model.default', 'defaultModel'].includes(name) ? serving.model : serving.baseUrl;
        return { ...key, before: key.intended, intended: key.kind === 'model-dependent' ? { exists: true, value } : key.before };
      }) } });
    }
  }

  private async executeRequest(verb: ExecutorRequest['verb'], input: unknown, key: Key,
    identity: { requestSha256: string; callerSha256: string } | undefined, site: SettingsTargets, gateway?: GatewayConfigState): Promise<ExecutorResult> {
    const role = keyRole(key);
    if (!keyMay(role, verb)) return { ok: false, code: 'not_permitted' };
    const schema = verb === 'config.read' ? configReadRequestSchema : verb === 'config.apply' ? configApplyRequestSchema : configUndoRequestSchema;
    const parsed = schema.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'invalid_parameters' };
    const request = parsed.data;
    const effectiveHermes = 'view' in request && READ_VIEWS[request.view].target === 'hermes-config' && !(READ_VIEWS[request.view] as ReadView).persisted;
    const id = 'requestId' in request ? request.requestId : randomUUID();
    const row: ConfigAuditRow = { id, time: new Date().toISOString(), caller: key.name, verb, keys: [], result: 'failed' };
    const binding = identity ?? { requestSha256: digest(JSON.stringify({ verb, request })),
      callerSha256: digest(JSON.stringify([key.name, key.scope, key.sha256])) };
    let result: ExecutorResult;
    let launched = false;
    const unknown = () => unknownOutcome(row);
    try {
      if (verb !== 'config.read' && !site.configWrites) throw new ConfigError('config_writes_off');
      const caller = role === 'launcher' ? 'launcher' : 'server';
      let targetId: TargetId;
      let undoProof: ExecutorRequest['undoProof'];
      if ('view' in request && request.view === 'gateway.status') return readGatewayStatus(site, this.options.gatewayUid);
      if ('view' in request && request.view === 'gateway.listeners') return readGatewayListeners(site);
      let recordConsumer: GatewayConsumer | undefined;
      let recordChange: 'move' | 'intended' | 'restore' | undefined;
      let context: ExecutorRequest['context'];
      if ('view' in request) targetId = READ_VIEWS[request.view].target;
      else if ('operation' in request) {
        const operation = parseOperation(request.operation, request.params, caller);
        if (!operation.ok) throw new ConfigError(operation.code);
        if (operation.spec.verb !== 'config.apply') throw new ConfigError('not_permitted');
        if (request.afterSeconds !== undefined) throw new ConfigError('invalid_parameters');
        targetId = operationTarget(operation.spec, operation.params);
        row.operation = request.operation;
        const paths = operationKeys(operation.spec, operation.params);
        // Parameter identities are projected by the executor before reaching the audit.
        if (paths !== 'recorded') row.keys = await publicKeyNames(targetId, paths);
        recordConsumer = operation.spec.consumer ?? operation.params.consumer as GatewayConsumer | undefined;
        recordChange = operation.spec.records === 'override' ? undefined : operation.spec.records;
        if (gateway && recordConsumer) {
          context = { migration: await gateway.record(recordConsumer, targetId as MigrationTarget) };
          if (operation.spec.keys === 'recorded' && !context.migration?.moved) throw new ConfigError('not_configured');
          if (request.operation === 'pi.catalog-roles' || request.operation === 'hermes.move-to-roles') context.roleMap = (await this.roleMap(site)).map;
        }
      } else {
        const spec = operationSpec(request.token.operation);
        if (!spec || !spec.callers.includes(caller)) throw new ConfigError('not_permitted');
        targetId = request.token.target;
        if (typeof spec.target === 'string' && spec.target !== targetId) throw new ConfigError('invalid_parameters');
        row.operation = request.token.operation;
      }
      row.target = targetId;
      if ('token' in request) {
        const proof = (await this.audit.rows()).find(record => record.operation === request.token.operation && record.target === targetId
          && record.backupId === request.token.backupId && record.backupSha256 === request.token.backupSha256
          && record.writtenSha256 === request.token.writtenSha256 && (record.verb === 'config.apply' || record.verb === 'config.undo'));
        if (!proof) throw new ConfigError('backup_mismatch');
        undoProof = { ...request.token, keys: proof.keys };
        row.keys = proof.keys;
      }
      if ('origin' in request && request.origin) row.change = request.origin.change;
      if ('operation' in request && operationSpec(request.operation)?.recovery) {
        if (request.preconditions) throw new ConfigError('invalid_parameters');
        const unit = recoveryUnit(site, request.operation, this.options.executable, this.options.serviceEntry);
        const separator = unit.argv.indexOf('--');
        try { for (const at of [unit.argv[0]!, unit.argv[separator + 1]!, unit.argv[separator + 2]!]) await this.trust(at); }
        catch { throw new ConfigError('unsafe_target'); }
        await this.audit.reconcile();
        await this.audit.save({ ...binding, row: { ...row, result: 'outcome_unknown' } });
        launched = true;
        const output = await this.runner(unit);
        if (output.code !== 0 || output.stdout.length > 4096 || output.stdout.trim().split('\n').length !== 1) throw new ConfigError('failed');
        result = configWriteResultSchema.parse(JSON.parse(output.stdout));
        if (result.ok && (!('recovered' in result) || result.operation !== request.operation || result.target !== targetId)) {
          throw new ConfigError('verify_mismatch');
        }
        row.result = result.ok ? 'ok' : result.code;
      } else if (targetId === 'gateway-role-map') {
        if (!gateway || row.operation !== 'gateway.point') throw new ConfigError('not_configured');
        const target = site.targets['gateway-role-map'];
        if (!target) throw new ConfigError('not_configured');
        const before = await this.roleMap(site);
        let role: z.infer<typeof gatewayRoleSchema>;
        let backend: string | null;
        let previousOverride: z.infer<typeof gatewayOverrideSchema> | undefined;
        if ('operation' in request) {
          const params = parseOperation(request.operation, request.params, caller);
          if (!params.ok) throw new ConfigError(params.code);
          role = gatewayRoleSchema.parse(params.params.role); backend = backendIdSchema.parse(params.params.backend);
        } else if ('token' in request) {
          if (before.sha256 !== request.token.writtenSha256) throw new ConfigError('undo_changed');
          const source = await gateway.readBackup(request.token.backupId);
          if (digest(source) !== request.token.backupSha256) throw new ConfigError('backup_mismatch');
          const saved = z.object({ role: gatewayRoleSchema, backend: backendIdSchema.nullable(), override: gatewayOverrideSchema.optional() }).strict().parse(JSON.parse(source));
          role = saved.role; backend = saved.backend; previousOverride = saved.override;
        } else throw new ConfigError('invalid_parameters');
        if ('operation' in request && request.preconditions) {
          const expected = request.preconditions;
          if ('file' in expected && expected.file.sha256 !== before.sha256 || 'keys' in expected && expected.keys.some(condition => condition.key !== 0
            || ('value' in condition ? condition.value !== before.map.roles[role] : !condition.exists))) throw new ConfigError('precondition_changed');
        }
        const candidate = roleMapSchema.safeParse({ ...before.map, roles: { ...before.map.roles, [role]: backend } });
        if (!candidate.success) throw new ConfigError('invalid_parameters');
        const stateBefore = await gateway.state();
        const backup = JSON.stringify({ role, backend: before.map.roles[role], ...(stateBefore.overrides[role] ? { override: stateBefore.overrides[role] } : {}) });
        row.keys = await publicKeyNames(targetId, [['roles', role]]);
        row.backupId = reserveConfigBackupId(target.path);
        const unit = gatewayPointUnit({ socket: target.adminSocket, role, body: { backend } }, this.options.executable,
          this.options.gatewayEntry ?? fileURLToPath(new URL('./config-gateway-entry.js', import.meta.url)));
        const separator = unit.argv.indexOf('--');
        try { for (const at of [unit.argv[0]!, unit.argv[separator + 1]!, unit.argv[separator + 2]!]) await this.trust(at); }
        catch { throw new ConfigError('unsafe_target'); }
        await this.audit.reconcile();
        await gateway.backup(row.backupId, backup);
        row.backupSha256 = digest(backup);
        await this.audit.save({ ...binding, row: { ...row, result: 'outcome_unknown' } });
        launched = true;
        const output = await this.runner(unit);
        if (output.code !== 0 || output.stdout.length > 4096 || output.stdout.trim().split('\n').length !== 1) throw new ConfigError('verify_mismatch');
        const applied = gatewayRepointResultSchema.parse(JSON.parse(output.stdout));
        if (applied.role !== role || applied.backend !== backend) throw new ConfigError('verify_mismatch');
        const after = await this.roleMap(site);
        if (!isDeepStrictEqual(after.map, candidate.data)) throw new ConfigError('verify_mismatch');
        await gateway.recordOverride({ role, backend: 'token' in request ? previousOverride?.backend ?? null : backend }, true, previousOverride);
        const token = { operation: 'gateway.point', target: targetId, backupId: row.backupId, backupSha256: row.backupSha256, writtenSha256: after.sha256 };
        row.writtenSha256 = token.writtenSha256;
        const recoveryIds = (await this.audit.rows()).filter(previous => previous.id !== id && previous.target === targetId
          && previous.result === 'outcome_unknown' && previous.backupId).map(previous => previous.backupId!);
        await gateway.expireBackups(row.backupId, recoveryIds);
        result = { ok: true, ...token, keys: row.keys, undo: token };
        row.result = 'ok';
      } else {
        const target = site.targets[targetId];
        if (!target || !('path' in target) || !('runAs' in target)) throw new ConfigError('not_configured');
        if ('view' in request && targetId === 'pi-settings' && await configFileMissing(target.path, target.runAs.uid)) {
          return { ok: true, view: request.view, present: false, values: [] };
        }
        const unitTarget: ConfigUnitTarget = { path: target.path, uid: target.runAs.uid };
        await checkConfigDirectory(target.path, target.runAs.uid, false, verb === 'config.read' && 'drvfs' in target && target.drvfs ? 'drvfs' : 'owner');
        if ('backupDir' in target && 'auditDir' in target) {
          await preflightTarget(fileTarget(site, targetId), verb !== 'config.read');
          if (verb !== 'config.read') { unitTarget.backupDir = target.backupDir; unitTarget.auditDir = target.auditDir; }
          if (target.lock.kind !== 'file') unitTarget.lockPath = target.lock.path;
        }
        if (targetId === 'paseo-config' && verb !== 'config.read' && !this.options.reloadPaseo) throw new ConfigError('not_configured');
        const recoveryIds = (await this.audit.rows()).filter(previous => previous.id !== id && previous.target === targetId
          && previous.result === 'outcome_unknown' && previous.backupId?.split('/')[0] === digest(target.path)).map(previous => previous.backupId!);
        if (verb !== 'config.read') row.backupId = reserveConfigBackupId(target.path);
        if ('token' in request && gateway) {
          const records = (await Promise.all(GATEWAY_CONSUMERS.map(consumer => gateway.record(consumer, targetId as MigrationTarget)))).filter(record => record?.moved);
          if (records.length) context = { migration: { ...records[0]!, keys: records.flatMap(record => record!.keys)
            .filter((entry, index, keys) => keys.findIndex(other => isDeepStrictEqual(other.path, entry.path)) === index) } };
        }
        const payload: ExecutorRequest = { site, verb, request, caller, ...(row.backupId ? { backupId: row.backupId, recoveryBackupIds: recoveryIds } : {}),
          ...(undoProof ? { undoProof } : {}), ...(context ? { context } : {}) };
        let prospectiveRecord: MigrationTargetRecord | undefined;
        if (gateway && context && verb !== 'config.read') {
          const snapshot = await readConfigFile(target.path, target.runAs.uid, 'mode' in target ? target.mode : undefined);
          const editor = target.format === 'yaml' ? yamlEditor : jsonEditor;
          const current = editor.parse(snapshot.source);
          if ('operation' in request) {
            const plan = configOperations(request.operation, request.params, caller, current, site, context);
            const edited = plan.operations.length ? editor.edit(snapshot.source, plan.operations) : snapshot.source;
            prospectiveRecord = migrationRecord(targetId, plan.paths, current, editor.parse(edited), snapshot.sha256, digest(edited));
          } else if ('token' in request && context.migration) {
            if (snapshot.sha256 !== request.token.writtenSha256) throw new ConfigError('undo_changed');
            const backup = await readConfigFile(join(configBackupDirectory(fileTarget(site, targetId)), request.token.backupId), target.runAs.uid);
            if (backup.sha256 !== request.token.backupSha256) throw new ConfigError('backup_mismatch');
            prospectiveRecord = migrationRecord(targetId, context.migration.keys.map(key => key.path), current, editor.parse(backup.source), snapshot.sha256, backup.sha256);
          }
          if (prospectiveRecord) {
            const token = { operation: row.operation!, target: targetId, backupId: row.backupId!,
              backupSha256: prospectiveRecord.preMoveBackupSha256, writtenSha256: prospectiveRecord.postMoveSha256 };
            const keys = await publicKeyNames(targetId, prospectiveRecord.keys.map(key => key.path));
            checkConfigTransport({ ok: true, ...token, keys, undo: token, unchanged: true, record: prospectiveRecord });
            const updates: MigrationUpdate[] = [];
            if (recordConsumer && recordChange) updates.push({ consumer: recordConsumer, target: targetId as MigrationTarget, change: recordChange, record: prospectiveRecord });
            else for (const consumer of GATEWAY_CONSUMERS) {
              if ((await gateway.record(consumer, targetId as MigrationTarget))?.moved) updates.push({ consumer, target: targetId as MigrationTarget, change: 'intended', record: prospectiveRecord });
            }
            payload.expectedSha256 = snapshot.sha256;
            await gateway.validateMigration(updates, migration => this.checkMigrationTransport(migration, targetId as MigrationTarget & TargetId, payload));
          }
        }
        checkConfigTransport(payload);
        const unit = configUnit(unitTarget, payload, this.options.executable, this.options.entry);
        if (verb === 'config.read' && targetId === 'hermes-config') {
          unit.argv = unit.argv.map(argument => argument === '--property=RuntimeMaxSec=30' ? '--property=RuntimeMaxSec=5' : argument);
        }
        const separator = unit.argv.indexOf('--');
        try {
          await this.trust(unit.argv[0]!);
          await this.trust(unit.argv[separator + 1]!);
          await this.trust(unit.argv[separator + 2]!);
          if ('loader' in target) await this.trust(target.loader);
        } catch { throw new ConfigError('unsafe_target'); }
        if ('view' in request && targetId === 'hermes-config' && !(READ_VIEWS[request.view] as ReadView).persisted && 'resolver' in target && target.resolver) {
          try {
            await this.trust(target.resolver.python);
            await this.trust(join(target.resolver.modulePath, 'hermes_cli/config.py'));
          } catch { throw new ConfigError('unavailable'); }
        }
        await this.audit.reconcile();
        await this.audit.save({ ...binding, row: { ...row, result: 'outcome_unknown' } });
        launched = true;
        const output = await this.runner(unit);
        if (output.code === 124 || output.result === 'timeout') throw new ConfigError('timeout');
        if (output.code !== 0 || output.stdout.length > 1024 * 1024) throw new ConfigError('failed');
        const lines = output.stdout.trim().split('\n');
        if (lines.length !== 1) throw new ConfigError('failed');
        const internal = (verb === 'config.read' ? configReadResultSchema : configExecutorWriteResultSchema).parse(JSON.parse(lines[0]!));
        const record = internal.ok && 'record' in internal && internal.record ? migrationTargetRecordSchema.parse(internal.record) : undefined;
        result = verb === 'config.read' ? internal : configWriteResultSchema.parse(internal.ok && 'record' in internal
          ? Object.fromEntries(Object.entries(internal).filter(([name]) => name !== 'record')) : internal);
        if (effectiveHermes && !result.ok) result = { ok: false, code: 'unavailable' };
        if (effectiveHermes && result.ok && (!('effective' in result) || result.effective !== true)) throw new ConfigError('unavailable');
        if (result.ok && 'view' in result && (!('view' in request) || result.view !== request.view)) throw new ConfigError('verify_mismatch');
        if (result.ok && 'recovered' in result) throw new ConfigError('verify_mismatch');
        if (result.ok && 'operation' in result && !('recovered' in result)) {
          if (result.operation !== row.operation || result.target !== targetId || result.undo.operation !== row.operation || result.undo.target !== targetId) throw new ConfigError('verify_mismatch');
          if (result.backupId !== row.backupId) throw new ConfigError('verify_mismatch');
          if (result.backupId !== result.undo.backupId || result.backupSha256 !== result.undo.backupSha256 || result.writtenSha256 !== result.undo.writtenSha256) throw new ConfigError('verify_mismatch');
          row.keys = result.keys; row.backupId = result.backupId; row.backupSha256 = result.backupSha256; row.writtenSha256 = result.writtenSha256;
          if (targetId === 'paseo-config') {
            let reloaded = false;
            const committed = result;
            try {
              const expected = await readConfigView(site, 'paseo.agents');
              if (expected.ok && expected.present && expected.sha256 === committed.writtenSha256 && await this.options.reloadPaseo!(expected)) {
                const current = await readConfigView(site, 'paseo.agents');
                reloaded = current.ok && current.present && current.sha256 === committed.writtenSha256;
              }
            } catch {}
            if (!reloaded) result = unknown();
          }
          if (result.ok && gateway && record) {
            if (!isDeepStrictEqual(record, prospectiveRecord)) throw new ConfigError('verify_mismatch');
            if (record.preMoveBackupSha256 !== result.backupSha256 || record.postMoveSha256 !== result.writtenSha256
              || record.keys.some(entry => recordedKind(targetId, entry.path) !== entry.kind)) throw new ConfigError('verify_mismatch');
            let allowed: KeyPath[] | undefined = context?.migration?.keys.map(key => key.path);
            if ('operation' in request) {
              const operation = parseOperation(request.operation, request.params, caller);
              if (!operation.ok) throw new ConfigError('verify_mismatch');
              const paths = operationKeys(operation.spec, operation.params);
              if (paths !== 'recorded') allowed = request.operation === 'pi.catalog-roles' ? [...paths, ['providers']] : paths;
            }
            if (!allowed || record.keys.length !== allowed.length || allowed.some(path => record.keys.filter(key => isDeepStrictEqual(key.path, path)).length !== 1)) {
              throw new ConfigError('verify_mismatch');
            }
            const views = { 'hermes-config': 'hermes.models', 'pi-settings': 'pi.settings', 'pi-models': 'pi.models', 'pi-mcp': 'pi.mcp',
              'paseo-config': 'paseo.agents' } as const;
            const view = Object.hasOwn(views, targetId) ? views[targetId as keyof typeof views] : undefined;
            if (!view) throw new ConfigError('verify_mismatch');
            const checking = configUnit({ path: target.path, uid: target.runAs.uid,
              ...(targetId === 'pi-settings' || targetId === 'paseo-config' ? { lockPath: fileTarget(site, targetId).lock.path } : {}) },
            { site, caller, verb: 'config.read', request: { view } }, this.options.executable, this.options.entry);
            const checked = await this.runner(checking);
            if (checked.code !== 0 || checked.stdout.length > 1024 * 1024 || checked.stdout.trim().split('\n').length !== 1) throw new ConfigError('verify_mismatch');
            const observation = configReadResultSchema.parse(JSON.parse(checked.stdout));
            if (!observation.ok || observation.view !== view || !observation.present || observation.sha256 !== result.writtenSha256) throw new ConfigError('verify_mismatch');
            if (recordConsumer && recordChange) await gateway.recordMigration({ consumer: recordConsumer, target: targetId as MigrationTarget, change: recordChange }, record, true);
            else for (const consumer of GATEWAY_CONSUMERS) {
              if ((await gateway.record(consumer, targetId as MigrationTarget))?.moved) await gateway.recordMigration({ consumer, target: targetId as MigrationTarget, change: 'intended' }, record, true);
            }
          } else if (result.ok && recordChange && !('unchanged' in result && result.unchanged)) throw new ConfigError('verify_mismatch');
        } else if (!result.ok && 'undo' in result) {
          const token = undoTokenSchema.parse(result.undo);
          if (token.target !== targetId || token.operation !== row.operation) throw new ConfigError('verify_mismatch');
          if (token.backupId !== row.backupId) throw new ConfigError('verify_mismatch');
          row.backupId = token.backupId; row.backupSha256 = token.backupSha256; row.writtenSha256 = token.writtenSha256;
        }
        if (!result.ok && verb !== 'config.read' && !(result.code === 'precondition_changed' && 'operation' in request && request.preconditions && 'keys' in request.preconditions)) result = unknown();
        row.result = result.ok ? 'ok' : result.code;
      }
    } catch (error) {
      result = launched && verb !== 'config.read' ? unknown() : { ok: false, code: effectiveHermes ? 'unavailable' : configErrorCode(error) };
      row.result = result.code;
    }
    if (launched) {
      const failAudit = () => {
        result = verb === 'config.read' ? { ok: false, code: effectiveHermes ? 'unavailable' : 'audit_unavailable' } : unknown();
        row.result = result.code;
      };
      try {
        await this.audit.append(row);
        await this.audit.save({ ...binding, row, ...(verb !== 'config.read' ? { result: configWriteResultSchema.parse(result) } : {}) });
      } catch { failAudit(); }
    }
    return result;
  }
}
