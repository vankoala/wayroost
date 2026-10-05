import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CREDENTIAL_TEST_ERRORS } from '../../../shared/gateway.js';
import { commandAllowlist } from '../../../shared/command-allowlist.js';
import { ApprovalCodes } from '../hub/approval-codes.js';
import type { AppConfig } from '../config.js';
import type { EventHub } from '../hub.js';
import type { SupervisorApi } from '../supervisor-client.js';
import type { SafetyCommandsSetting } from '../hermes/safety.js';
import type { Notifications } from '../notifications/service.js';
import type { Feed } from '../feed/service.js';
import { HHMM } from '../feed/store.js';
import { SAFETY_COMMANDS } from '../hermes/commands.js';
import { PROACTIVITY_LEVELS, type CloudAgentsStatus } from '../../../shared/protocol.js';
import { pendingWorkerApprovals, workerApprovalTools, WORKER_APPROVAL_TOOLS, type WorkerApprovalsApi } from '../../../shared/safety.js';
import { checkDeviceSignal } from '../security/device-signal.js';
import { SettingsAudit, SettingsAuditError, type SettingsWriteRecord, type SettingsAuditEntry } from './audit.js';
import { consumerRecord } from '../checks/common.js';
import type { IntentFact } from '../checks/state.js';
import type { SettingsChecksResponse } from '../../../shared/settings-checks.js';
import { WayroostSettingsStore } from './store.js';
import { decideChange, decideRead, isSettingsPolicyRoute, routePolicy, rowAccess, settingsContext } from './levels.js';
import { CONFIRM_TTL_MS, strictestLevel, stricterLevel, type SettingsRequestContext } from '../../../shared/settings-levels.js';
import {
  READ_VIEWS, OPERATION_IDS, HERMES_PERSONALITIES, operationSpec, parseOperation, operationLevel, operationTarget, operationKeys,
  operationKeyNames, operationTiming, undoLevel, readViewValues, publicKeyNames,
  type OperationSpec, type ReadViewId, type ReadView,
} from '../../../shared/settings-ops.js';
import {
  EARLIER_SETTINGS_ROUTES, SETTINGS_ROUTES, SETTINGS_RESOLUTION_MESSAGE, settingsSectionSchema, settingsApplyBodySchema, settingsUndoBodySchema,
  settingsRestartBodySchema, settingsCredentialBodySchema, settingsCredentialTestBodySchema,
  settingValuesEqual, keyPathSchema, type SettingValue, type KeyPath, type SettingsSection, type SettingsLevel,
  settingsNotificationsWriteBodySchema,
  undoTokenSchema,
  type SettingsErrorCode, type SettingsApplyResponse, type SettingsAuditRecord, type Timing, type ChangeResult, type UndoToken,
} from '../../../shared/settings.js';
import {
  configReadResultSchema, configWriteResultSchema, credentialWriteResultSchema, credentialTestResultSchema,
  drainRestartResultSchema, drainRunResult, usageSummaryResultSchema, HERMES_DRAIN_PROTOCOL,
  configRequestStatusResultSchema, type ConfigReadResult, type ConfigWriteResult,
} from '../../../shared/supervisor-config.js';

const views: Record<SettingsSection, readonly ReadViewId[]> = {
  overview: [], agents: ['hermes.agents', 'paseo.agents', 'hermes.models'],
  models: ['hermes.models', 'pi.settings', 'pi.models', 'gateway.role-map', 'gateway.state'],
  safety: ['hermes.safety', 'hermes.allowlist', 'hermes.managed', 'claude.permissions', 'codex.approvals', 'opencode.permissions', 'wayroost.settings'],
  notifications: ['wayroost.settings'], checks: ['hermes.managed', 'hermes.models', 'gateway.state'],
};
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const changeId = () => `ch_${randomBytes(12).toString('hex')}`;
const refused = (code: SettingsErrorCode): SettingsApplyResponse => ({ status: 'refused', code });
const legacyOperations = new Set(['paseo.provider-enabled', 'wayroost.safety-commands', 'paseo.worker-approvals']);
const modelStatusSchema = z.array(z.object({ role: z.enum(['main', 'coder', 'fast']), health: z.enum(['up', 'down', 'unmapped', 'owner_mismatch', 'unknown']), inFlight: z.number().int().nonnegative() }));
const roleLoadsSchema = z.array(z.object({ role: z.string().regex(/^[a-z0-9-]+$/), harness: z.enum(['hermes', 'paseo', 'claude', 'codex']),
  words: z.number().int().nonnegative(), tokens: z.number().int().nonnegative(), targetWords: z.number().int().positive().nullable(), budgetWords: z.number().int().positive().nullable(),
  parts: z.object({ shared: z.number().int().nonnegative(), dispatch: z.number().int().nonnegative(), role: z.number().int().nonnegative(), skills: z.number().int().nonnegative() }) }));
const agentAvailabilitySchema = z.array(z.object({ id: z.enum(['claude', 'codex', 'opencode', 'copilot', 'hermes']), installed: z.boolean().nullable(), authenticated: z.boolean().nullable() }));
async function readMetadata<T>(reader: (() => Promise<unknown>) | undefined, schema: z.ZodType<T>): Promise<T | undefined> {
  if (!reader) return undefined;
  try { const result = schema.safeParse(await reader()); return result.success ? result.data : undefined; }
  catch { return undefined; }
}
const feedSettingsBody = z.object({
  level: z.enum(PROACTIVITY_LEVELS).optional(),
  quietHours: z.object({ start: HHMM, end: HHMM }).strict().nullable().optional(),
  push: z.object({ approvals: z.boolean().optional(), cards: z.boolean().optional() }).strict().optional(),
  removeLessLike: z.string().trim().min(1).max(40).optional(),
}).strict();

interface SettingsSnapshot {
  ok: true;
  document: Record<string, unknown>;
  sha256?: string;
}

function persistedFileMatches(snapshot: SettingsSnapshot, sha256: string | undefined): boolean {
  return sha256 !== undefined && snapshot.sha256 === sha256;
}

interface IntendedValue { path: KeyPath; exists: boolean; value?: SettingValue }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function send(reply: FastifyReply, response: unknown) {
  const code = (response as { code?: SettingsErrorCode | typeof CREDENTIAL_TEST_ERRORS[number] }).code;
  const status = !code ? 200 : code === 'invalid_parameters' || code === 'unknown_operation' ? 400
    : ['not_permitted', 'pc_only', 'pc_only_read_only', 'shadow_read_only', 'confirm_invalid'].includes(code) ? 403
      : code === 'audit_unavailable' || code === 'unavailable' || code === 'backend_unavailable' ? 503 : 409;
  return reply.code(status).send(response);
}

/** Rebuild the allowlisted view so the shared projector can check values and dynamic identities again. */
function documentOf(result: Extract<ConfigReadResult, { ok: true }>): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  for (const entry of result.values) {
    if (!entry.exists) continue;
    let container: Record<string | number, unknown> = document;
    for (const [index, segment] of entry.path.entries()) {
      if (typeof segment === 'object' || segment === '__proto__') throw new Error('failed');
      if (index === entry.path.length - 1) {
        Object.defineProperty(container, segment, { value: entry.value ?? null, writable: true, enumerable: true, configurable: true });
      } else {
        if (!Object.hasOwn(container, segment)) Object.defineProperty(container, segment, {
          value: typeof entry.path[index + 1] === 'number' ? [] : {}, writable: true, enumerable: true, configurable: true,
        });
        const next = container[segment];
        if (!next || typeof next !== 'object') throw new Error('failed');
        container = next as Record<string | number, unknown>;
      }
    }
  }
  return document;
}

function valueAt(document: unknown, path: KeyPath): { exists: boolean; value?: SettingValue } {
  let current = document;
  for (const segment of path) {
    if (typeof segment === 'object') {
      current = Array.isArray(current) ? current.find(entry => entry && typeof entry === 'object' && entry.id === segment.id) : undefined;
      if (current === undefined) return { exists: false };
    } else {
      if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) return { exists: false };
      current = (current as Record<string | number, unknown>)[segment];
    }
  }
  return { exists: true, value: current as SettingValue };
}

/** Intended values are recorded for Checks within the authorizing request. */
function intendedValues(operation: string, params: Record<string, unknown>, paths: KeyPath[], document: Record<string, unknown>): IntendedValue[] {
  const values: Record<string, unknown[]> = {
    'hermes.reasoning-effort': [params.effort === null ? undefined : params.effort], 'hermes.personality': [params.personality],
    'hermes.delegation-limits': [params.maxConcurrentChildren, params.maxIterations],
    'paseo.provider-enabled': [params.enabled], 'paseo.profile-model': [params.model],
    'paseo.routing-note': [params.text || undefined],
    'hermes.default-model': [params.provider, params.model, params.baseUrl],
    'hermes.delegation-model': [params.provider, params.model], 'hermes.delegation-fallbacks': [params.chain],
    'hermes.main-fallbacks': [params.chain], 'hermes.helper-model': [params.provider, params.model],
    'gateway.point': [params.backend], 'hermes.approval-mode': [params.mode],
    'hermes.skill-staging': [params.enabled], 'wayroost.safety-commands': [params.enabled],
    'wayroost.notifications': [params.push, params.quietHours, params.rules],
  };
  return paths.map((path, index) => {
    const before = valueAt(document, path).value;
    const value = operation === 'hermes.revoke-always'
      ? commandAllowlist(before)?.filter(entry => hash(entry) !== params.entrySha256)
      : operation === 'paseo.worker-approvals'
      ? workerApprovalTools(before, params.enabled as boolean)
      : values[operation]?.[index];
    return { path, exists: value !== undefined, ...(value !== undefined ? { value: value as SettingValue } : {}) };
  });
}

interface PendingConfirm {  actionId: string;
  binding: string;
  expiresAt: number;
}

/** What the Checks page reads: one snapshot, every row, in one call. */
export interface ChecksReader {
  rows(entries?: readonly SettingsAuditEntry[], context?: SettingsRequestContext): Promise<SettingsChecksResponse>;
  useState?(stateDir: string): void;
  recordIntent?(fact: IntentFact, entries?: readonly SettingsAuditEntry[]): Promise<void>;
  confirmIntent?(id: string, at: number): Promise<void>;
  confirmUndo?(id: string, undoOf: string, at: number, entries: readonly SettingsAuditEntry[]): Promise<void>;
  resolveIntent?(id: string, entries: readonly SettingsAuditEntry[]): Promise<{ operation: string; params: Record<string, unknown>; at?: number; paths?: KeyPath[] } | undefined>;
  canReapplyMigration?(record: NonNullable<ReturnType<typeof consumerRecord>>, entries: readonly SettingsAuditEntry[]): Promise<boolean>;
}

export interface SettingsOptions {
  now?: () => number;
  /** The Checks engine: one snapshot, every row. Absent means the page says it isn't configured. */
  checks?: ChecksReader;
  modelStatus?: () => Promise<unknown>;
  roleLoads?: () => Promise<unknown>;
  agentAvailability?: () => Promise<unknown>;
  consumers?: {
    safetyCommands?: SafetyCommandsSetting;
    cloudAgents?: () => Promise<CloudAgentsStatus>;
    workerApprovals?: WorkerApprovalsApi;
    notifications?: Notifications;
    feed?: Feed;
  };
}

class SettingsPipeline {
  private readonly notificationSources = new WeakMap<object, 'hermes' | 'paseo' | 'supervisor'>();
  private readonly notificationOutcomes = new WeakMap<object, string>();
  private readonly drains = new Map<string, { record: SettingsWriteRecord; timing: Timing }>();
  private closed = false;
  private polling = false;
  private auditStore?: SettingsAudit;
  private readonly now: () => number;
  private readonly codes: ApprovalCodes<string>;
  private readonly pending = new Map<string, PendingConfirm>();
  private readonly timer: ReturnType<typeof setInterval>;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly store = new WayroostSettingsStore();
  private settingsPending = false;
  private readonly settingsUncertain = new Set<string>();
  readonly legacyRoutesViaPipeline: boolean;

  constructor(private readonly config: AppConfig, private readonly supervisor: SupervisorApi | undefined,
    private readonly hub: EventHub, private readonly options: SettingsOptions) {
    this.now = options.now ?? Date.now;
    options.checks?.useState?.(config.stateDir);
    this.legacyRoutesViaPipeline = config.settings.legacyRoutesViaPipeline;
    this.codes = new ApprovalCodes({ identityOf: id => id, adminCapability: {}, now: this.now,
      record: event => this.audit.event(event.type, event) });
    this.timer = setInterval(() => {
      try { this.codes.expire(this.now()); } catch { /* Writes will refuse the unavailable audit. */ }
      if (!this.polling && this.drains.size) {
        this.polling = true;
        void this.enqueue(async () => { await this.refreshDrains(); }).catch(() => {}).finally(() => { this.polling = false; });
      }
    }, 1000);
    this.timer.unref();
  }

  async initialize(): Promise<void> {
    if (existsSync(join(this.config.stateDir, 'settings-audit.jsonl'))) {
      try { await this.resolveUncertain(); } catch { /* Unresolved writes keep changes closed. */ }
    }
    try {
      for (const entry of existsSync(join(this.config.stateDir, 'settings-audit.jsonl')) ? this.audit.entries() : []) if (entry.runId && entry.result === 'outcome_unknown' && !entry.observed) {
        if (entry.action === 'restart') this.drains.set(entry.runId, { record: entry, timing: entry.notes });
      }
    } catch { /* An unavailable journal keeps writes closed. */ }
    if (this.legacyRoutesViaPipeline) {
      this.options.consumers?.safetyCommands?.useSettingsSource(() => this.safetyCommandsEnabled());
    }
    if (this.configSource('wayroost-settings')?.configRead
      && (this.legacyRoutesViaPipeline && this.options.consumers?.safetyCommands || this.options.consumers?.notifications)) {
      try {
        this.audit.verify();
        for (const entry of this.audit.entries()) {
          if (entry.target !== 'wayroost-settings' || !entry.operation) continue;
          if (entry.result === 'outcome_unknown' && !entry.observed) this.settingsUncertain.add(entry.id);
        }
      }
      catch { /* The audit check keeps safety commands blocked. */ }
      await this.read('wayroost.settings');
    }
  }

  private safetyCommandsEnabled(): boolean {
    try {
      this.audit.verify();
      return !this.settingsPending && !this.settingsUncertain.size && this.store.safetyCommandsEnabled();
    } catch { return false; }
  }

  async refreshConsumers(): Promise<SettingsApplyResponse | undefined> {
    if (!this.configSource('wayroost-settings')?.configRead) return;
    await this.resolveUncertain();
    if (this.blocked('wayroost-settings').length) return { status: 'refused', code: 'outcome_unknown', message: SETTINGS_RESOLUTION_MESSAGE };
    const current = await this.read('wayroost.settings');
    return current.ok ? undefined : refused(current.code);
  }

  private get audit(): SettingsAudit { return this.auditStore ??= new SettingsAudit(this.config.stateDir, this.now); }
  close(): void { this.closed = true; clearInterval(this.timer); this.auditStore?.close(); }
  notificationSource(request: object) { return this.notificationSources.get(request); }
  notificationOutcome(request: object) { return this.notificationOutcomes.get(request); }

  serialize<T>(request: FastifyRequest, action: () => Promise<T>): Promise<T | SettingsApplyResponse> {
    return this.enqueue(() => this.guarded(request, action));
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(action);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async guarded<T>(request: FastifyRequest, action: () => Promise<T>): Promise<T | SettingsApplyResponse> {
    try {
      checkDeviceSignal(request.deviceSignal);
      await this.resolveUncertain();
      return await action();
    }
    catch (error) { return refused(request.deviceSignal?.aborted ? 'not_permitted' : error instanceof SettingsAuditError ? 'audit_unavailable' : 'failed'); }
  }

  private blocked(target: string) {
    return this.audit.unresolved().filter(entry => entry.target === target && !(entry.action === 'restart' && entry.runId));
  }

  private async resolveUncertain(): Promise<void> {
    for (const entry of this.audit.unresolved()) {
      const { requestId, notes, undoOf, ...record } = entry;
      if (requestId && entry.runId && entry.action === 'restart') {
        this.drains.set(entry.runId, { record, timing: notes });
        await this.restartRun(entry.runId);
        continue;
      }
      if (entry.target === 'wayroost-settings') { this.settingsUncertain.add(entry.id); continue; }
      if (!requestId || !this.supervisor?.configRequestStatus) continue;
      const parsed = configRequestStatusResultSchema.safeParse(await this.supervisor.configRequestStatus({ requestId }).catch(() => undefined));
      if (!parsed.success || !parsed.data.ok || parsed.data.requestId !== requestId || parsed.data.state !== 'terminal') continue;
      const { row, outcome } = parsed.data;
      const verb = entry.action === 'apply' ? 'config.apply' : entry.action === 'undo' ? 'config.undo' : 'credential.write';
      if (row.change !== entry.id || row.target !== entry.target || row.verb !== verb
        || entry.action !== 'credential' && row.operation !== entry.operation || outcome === 'outcome_unknown') continue;
      if (outcome === 'applied' && row.result !== 'ok' || outcome === 'refused' && (row.result === 'ok' || row.result === 'outcome_unknown' || row.writtenSha256)) continue;
      this.audit.event('settings-write-resolved', { id: entry.id, requestId, outcome });
      this.complete({ ...record, observed: 'supervisor', ...(row.backupId ? { backupId: row.backupId } : {}),
        ...(row.backupSha256 ? { backupSha256: row.backupSha256 } : {}), ...(row.writtenSha256 ? { writtenSha256: row.writtenSha256 } : {}) },
        notes, outcome === 'applied' ? 'ok' : row.result, undoOf);
      if (outcome === 'applied' && undoOf) await this.options.checks?.confirmUndo?.(entry.id, undoOf, this.now(), this.audit.entries());
      else if (outcome === 'applied') await this.options.checks?.confirmIntent?.(entry.id, this.now());
      this.hub.publish({ type: 'settings_changed', sections: ['overview', 'checks'], change: entry.id });
    }
  }

  private async acceptCurrent(request: FastifyRequest, body: z.infer<typeof settingsApplyBodySchema>): Promise<SettingsApplyResponse> {
    const operation = parseOperation(body.operation, body.params, 'server');
    if (!operation.ok || body.expected) return refused('invalid_parameters');
    const decision = decideChange('pc-only', settingsContext(request, this.config));
    if (!decision.allowed) return refused(decision.code);
    const entry = this.blocked(String(operation.params.target)).find(entry => entry.id === operation.params.change);
    if (!entry) return refused('precondition_changed');
    // Local PC access and an explicit confirmation are both required for this resolution.
    const authorization = this.authorize(request, 'confirm', body.operation, operation.params, null, body.confirm, true);
    if (authorization) return authorization;
    checkDeviceSignal(request.deviceSignal);
    const { requestId: _requestId, notes, undoOf, ...record } = entry;
    this.audit.event('settings-resolved-by-user', { id: entry.id, target: entry.target, device: request.device!.id, level: 'confirm' });
    this.complete({ ...record, observed: 'resolved-by-user' }, notes, 'outcome_unknown', undoOf);
    this.settingsUncertain.delete(entry.id);
    if (entry.target === 'wayroost-settings') await this.read('wayroost.settings');
    this.hub.publish({ type: 'settings_changed', sections: ['overview', 'checks'], change: entry.id });
    return { status: 'applied', change: { id: entry.id, operation: body.operation, target: entry.target as UndoToken['target'],
      keys: [], timing: [{ label: 'now' }], effective: 'verified', undoable: false } };
  }

  async legacyWrite(request: FastifyRequest, operation: string, writer: () => unknown | Promise<unknown>): Promise<unknown> {
    // Until the startup switch hands these routes to the pipeline, each keeps M1's own
    // checks (the paired desktop), so existing controls keep working; levels apply in pipeline mode.
    if (!this.legacyRoutesViaPipeline) return writer();
    return this.serialize(request, async () => {
      const parsed = z.record(z.string(), z.unknown()).safeParse(request.body);
      if (!parsed.success) return refused('invalid_parameters');
      const params = parsed.data;
      if (operation === 'paseo.provider-enabled') params.provider = (request.params as { id: string }).id;
      return this.legacy(request, operation, params);
    });
  }

  private async read(view: ReadViewId): Promise<ConfigReadResult> {
    const source = this.configSource(READ_VIEWS[view].target);
    if (!source?.configRead) return { ok: false, code: 'config_writes_off' };
    if (view === 'wayroost.settings') this.store.invalidate();
    try {
      const result = configReadResultSchema.safeParse(await source.configRead({ view }));
      if (!result.success || result.data.ok && result.data.view !== view) return { ok: false, code: 'failed' };
      if (result.data.ok && view === 'wayroost.settings') {
        try {
          this.store.update(documentOf(result.data));
        }
        catch { return { ok: false, code: 'failed' }; }
      }
      return result.data;
    } catch { return { ok: false, code: 'unavailable' }; }
  }

  private configSource(target: string) {
    return target === 'wayroost-settings' ? this.options.consumers?.notifications ?? this.supervisor : this.supervisor;
  }

  async workerApprovals() {
    if (!this.legacyRoutesViaPipeline) return this.options.consumers?.workerApprovals?.status() ?? pendingWorkerApprovals();
    const result = await this.read('paseo.agents');
    if (!result.ok) return refused(result.code);
    if (!result.present) return refused('not_configured');
    const document = documentOf(result);
    const paths = operationKeys(operationSpec('paseo.worker-approvals')!, { enabled: true }, document);
    if (paths === 'recorded' || !paths.length) return refused('not_configured');
    try {
      const enabled = paths.every(path => {
        const tools = valueAt(document, path).value;
        if (!tools || typeof tools !== 'object' || Array.isArray(tools)) return false;
        const disabled = z.array(z.string()).parse(tools.disabledTools ?? []);
        return tools.enabled === false || WORKER_APPROVAL_TOOLS.every(tool => disabled.includes(tool));
      });
      return { ...pendingWorkerApprovals(), enabled, config: 'written' as const, choiceConfirmed: true,
        message: 'The saved policy applies to new workers; existing workers may still use their earlier tool settings.' };
    } catch { return refused('parse_failed'); }
  }

  async notifications() {
    const notifications = this.options.consumers?.notifications;
    if (!notifications) return refused('not_configured');
    return notifications.settings();
  }

  /** The checks page: rows only. No check writes; a Fix is a normal settings apply. */
  async checks(request: FastifyRequest): Promise<SettingsChecksResponse | SettingsApplyResponse> {
    const checks = this.options.checks;
    try {
      const result = checks ? await checks.rows(this.audit.entries(), settingsContext(request, this.config)).catch(() => ({
        generatedAt: this.now(), rows: [], unavailable: ['unavailable'],
      } as SettingsChecksResponse)) : { generatedAt: this.now(), rows: [] } as SettingsChecksResponse;
      const entries = this.audit.unresolved().filter(entry => entry.target && !(entry.action === 'restart' && entry.runId));
      const targets = [...new Set(entries.map(entry => entry.target!))];
      result.rows.unshift(...targets.map(target => {
        const entry = entries.find(entry => entry.target === target)!;
        return { id: `settings.blocked-${target}`, state: 'fail' as const, priority: 'high' as const,
          sentence: 'This target has an uncertain write. Accept the current file as is to unblock it.',
          details: [target, entry.id, 'Accept the current file as is'],
          fix: { operation: 'settings.accept-current', params: { target, change: entry.id } } };
      }));
      for (const row of result.rows) {
        if (!['hermes.drift', 'hermes.stale-page', 'allowlist.revoke-back', 'paseo.switch-flags', 'paseo.profiles'].includes(row.id) || row.state === 'unknown') continue;
        this.options.consumers?.notifications?.mismatch(row.id.startsWith('paseo.') ? 'paseo' : 'hermes', row.state === 'fail' || row.state === 'warn', 'checks:' + row.id);
      }
      return result;
    } catch { return refused('failed'); }
  }

  private async projected(view: ReadViewId, context: SettingsRequestContext): Promise<ConfigReadResult> {
    const result = await this.read(view);
    if (!result.ok || !result.present && !result.effective) return result;
    try {
      const document = documentOf(result);
      const values = await readViewValues(view, document, context);
      const spec: ReadView = READ_VIEWS[view];
      const order = result.order?.filter(entry => spec.order?.some(path => canonical(path) === canonical(entry.path)))
        .map(entry => ({ path: entry.path, names: entry.names.map(name => decideRead(context, 'pc-only').allowed
          || spec.publicNames?.[`${entry.path.join('.')}.*`]?.includes(name) ? name : `sha256:${hash(name)}`) }));
      return { ok: true, view, present: result.present, ...(result.effective ? { effective: true as const } : {}), ...(result.sha256 ? { sha256: result.sha256 } : {}),
        values: values.map(entry => ({ ...entry, path: [...entry.path] })), ...(order?.length ? { order } : {}) };
    } catch { return { ok: false, code: 'failed' }; }
  }

  async section(request: FastifyRequest, section: SettingsSection) {
    const context = settingsContext(request, this.config);
    if (section === 'overview') return { section, changes: this.recent(context) };
    const results = await Promise.all(views[section].map(async view => ({ ...await this.projected(view, context), view })));
    const operations = OPERATION_IDS.filter(id => operationSpec(id)!.section === section && operationSpec(id)!.callers.includes('server'))
      .map(operation => {
        const spec = operationSpec(operation)!;
        if (!this.legacyRoutesViaPipeline && legacyOperations.has(operation)) {
          const access = context.role === 'primary' && request.device?.kind === 'desktop' && context.scopes.includes('settings') ? 'editable' : 'read-only';
          return { operation, title: spec.title, writer: 'legacy', level: 'pc-only', timing: spec.timing, access,
            ...('byParam' in spec.level ? { accessByValue: Object.fromEntries(Object.keys(spec.level.values).map(value => [value, access])) } : {}) };
        }
        return { operation, title: spec.title, writer: 'pipeline', level: spec.level, timing: spec.timing, access: rowAccess(strictestLevel(spec.level), context),
          ...('byParam' in spec.level ? { accessByValue: Object.fromEntries(Object.entries(spec.level.values).map(([value, level]) => [value, rowAccess(level, context)])) } : {}) };
      });
    const metadata: Record<string, unknown> = {};
    if (section === 'models') {
      const raw = await this.read('gateway.role-map');
      if (raw.ok && raw.present) {
        const document = documentOf(raw);
        const backends = valueAt(document, ['backends']).value;
        const roles = valueAt(document, ['roles']).value;
        metadata.backendChoices = Object.keys(backends && typeof backends === 'object' ? backends : {}).map((id, index) => ({
          id: decideRead(context, 'pc-only').allowed ? id : hash(id).slice(0, 63), label: decideRead(context, 'pc-only').allowed ? id : `Backend ${index + 1}`,
          currentRoles: Object.entries(roles && typeof roles === 'object' ? roles : {}).filter(([, backend]) => backend === id).map(([role]) => role),
        }));
      }
      metadata.modelStatus = await readMetadata(this.options.modelStatus, modelStatusSchema);
    }
    if (section === 'agents') {
      const raw = await this.read('hermes.agents');
      if (raw.ok) {
        const document = documentOf(raw);
        const names = [...new Set([...HERMES_PERSONALITIES, ...['personalities', 'agent.personalities'].flatMap(key => {
          const value = valueAt(document, key.split('.')).value;
          return value && typeof value === 'object' ? Object.keys(value).filter(name => /^[A-Za-z0-9_-]{1,64}$/.test(name)) : [];
        })])];
        metadata.personalities = names.map((name, index) => ({ id: (HERMES_PERSONALITIES as readonly string[]).includes(name) || decideRead(context, 'pc-only').allowed ? name : hash(name),
          label: (HERMES_PERSONALITIES as readonly string[]).includes(name) || decideRead(context, 'pc-only').allowed ? name || 'Default (none)' : `Custom personality ${index + 1}` }));
      }
      const paseo = await this.read('paseo.agents');
      if (paseo.ok) {
        const profiles = valueAt(documentOf(paseo), ['daemon', 'agentProfiles']).value;
        metadata.profiles = Array.isArray(profiles) ? profiles.flatMap(entry => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string') return [];
          const local = decideRead(context, 'pc-only').allowed;
          return [{ id: local ? entry.id : hash(entry.id), label: local ? entry.id : `Profile ${profiles.indexOf(entry) + 1}`, ...(local && typeof entry.model === 'string' ? { model: entry.model } : {}) }];
        }) : [];
      }
      metadata.roleLoads = await readMetadata(this.options.roleLoads, roleLoadsSchema);
    }
    if (section === 'safety') {
      const latest = this.audit.entries().filter(entry => entry.action === 'restart' && entry.target === 'hermes' && entry.runId
        && (entry.result === 'outcome_unknown' || entry.observed === 'supervisor')).at(-1)?.runId;
      const runIds = [...new Set([...this.drains.keys(), ...(latest ? [latest] : [])])];
      metadata.restartRuns = (await Promise.all(runIds.map(id => this.restartRun(id))))
        .flatMap(result => 'run' in result && result.run.component === 'hermes' ? [result.run] : []);
      const effective = await this.read('hermes.safety');
      const raw = effective.ok ? await this.read('hermes.allowlist') : effective;
      if (raw.ok) {
        const list = valueAt(documentOf(raw), ['command_allowlist']).value;
        metadata.allowlistEntries = commandAllowlist(list)?.map(entry => ({ entrySha256: hash(entry) })) ?? [];
      }
    }
    if (section === 'agents' || section === 'models') metadata.agentAvailability = await readMetadata(this.options.agentAvailability, agentAvailabilitySchema);
    return { section, legacyRoutesViaPipeline: this.legacyRoutesViaPipeline, views: results, operations, ...metadata };
  }

  recent(context?: SettingsRequestContext) {
    return this.audit.recent().filter(entry => entry.action === 'apply' || entry.action === 'undo').map(entry => ({
      id: entry.id, at: entry.at, action: entry.action, operation: entry.operation, target: entry.target,
      keys: entry.keys, device: entry.device ? { ...entry.device, name: '' } : undefined,
      level: entry.level, timing: entry.notes, result: entry.result, undoable: !!this.audit.token(entry.id),
      ...(context ? { undoAccess: rowAccess(operationSpec(entry.operation ?? '') ? undoLevel(operationSpec(entry.operation ?? '')!) : 'pc-only', context) } : {}),
    }));
  }

  private async target(spec: OperationSpec, params: Record<string, unknown>) {
    const target = operationTarget(spec, params);
    const view = (Object.keys(READ_VIEWS) as ReadViewId[]).find(id => READ_VIEWS[id].target === target);
    if (!view) return { ok: false as const, code: 'not_configured' as const };
    // Hermes model, agent and safety fields share a file and a content hash.
    const ids = spec === operationSpec('hermes.revoke-always') ? ['hermes.safety', 'hermes.allowlist'] as const
      : (Object.keys(READ_VIEWS) as ReadViewId[]).filter(id => READ_VIEWS[id].target === target
        && !(READ_VIEWS[id] as ReadView).namesOnly && !(READ_VIEWS[id] as ReadView).runtime
        && !(READ_VIEWS[id] as ReadView).comparisonDigests && !(READ_VIEWS[id] as ReadView).persisted);
    const results = await Promise.all(ids.map(id => this.read(id)));
    let sha256: string | undefined;
    let present: boolean | undefined;
    for (const result of results) {
      if (!result.ok) return result;
      if (present !== undefined && present !== result.present || sha256 !== undefined && sha256 !== result.sha256) return { ok: false as const, code: 'precondition_changed' as const };
      present = result.present; sha256 = result.sha256;
    }
    const document = documentOf({ ok: true, view, present: !!present, sha256,
      values: results.flatMap(result => result.ok ? result.values : []) });
    return { ok: true as const, document, sha256 };
  }

  private authorize(request: FastifyRequest, level: SettingsLevel, operation: string, parameters: unknown,
    targetSha256: string | null, confirm?: string, forceConfirm = false): SettingsApplyResponse | undefined {
    const context = settingsContext(request, this.config);
    const decision = decideChange(level, forceConfirm ? { ...context, scopes: context.scopes.filter(scope => scope !== 'pc-settings') } : context);
    if (decision.allowed) return undefined;
    if (decision.code !== 'confirm_required') return refused(decision.code);
    this.codes.expire(this.now());
    const binding = hash(canonical({ operation, paramsSha256: hash(canonical(parameters)), targetSha256, deviceId: request.device!.id }));
    if (confirm) {
      const stored = this.pending.get(hash(confirm));
      const result = this.codes.redeem({ code: confirm, actionId: stored?.binding === binding ? stored.actionId : `settings_${binding}`,
        sessionOrDevice: request.device!.id, decision: 'approve' });
      return result.ok ? undefined : refused('confirm_invalid');
    }
    const actionId = `settings_${randomUUID()}`;
    const issued = this.codes.issue({ actionId, sessionOrDevice: request.device!.id, decisions: ['approve', 'deny'], ttlMs: CONFIRM_TTL_MS });
    this.pending.set(hash(issued.code), { actionId, binding, expiresAt: issued.expiresAt });
    return { status: 'confirm', confirm: issued.code, summary: operationSpec(operation)?.title ?? 'Restart', expiresAt: issued.expiresAt };
  }

  private metadata(request: Pick<FastifyRequest, 'device'>, action: SettingsAuditRecord['action'], operation: string, target: string,
    keys: string[], level: SettingsLevel, timing: Timing): SettingsWriteRecord {
    this.notificationSources.set(request, target.startsWith('hermes') || target === 'dashboard' || operation.startsWith('hermes.') || operation === 'wayroost.safety-commands' ? 'hermes'
      : target.startsWith('paseo') || operation.startsWith('paseo.') ? 'paseo' : 'supervisor');
    return { id: changeId(), at: this.now(), action, operation, target, keys,
      ...(request.device ? { device: { id: request.device.id, kind: request.device.kind } } : {}),
      level, timing: timing.map(note => note.label), result: 'failed' };
  }

  private finish(record: SettingsWriteRecord, timing: Timing, response: SettingsApplyResponse, undoOf?: string): SettingsApplyResponse {
    this.complete(record, timing, response.status === 'applied' ? 'ok' : response.status === 'refused' ? response.code : 'confirm_required', undoOf);
    return response;
  }

  private complete(record: SettingsWriteRecord, timing: Timing, result: SettingsAuditRecord['result'], undoOf?: string): void {
    if (result === 'outcome_unknown' || result !== 'ok' && record.writtenSha256) {
      const section = record.operation ? operationSpec(record.operation)?.section : undefined;
      this.hub.publish({ type: 'settings_changed', sections: [...new Set(['overview', 'checks', ...(section ? [section] : [])])] as SettingsSection[], change: record.id });
    }
    try { this.audit.record({ ...record, result }, timing, undoOf); }
    catch (error) {
      if (result === 'ok' && (record.writtenSha256 || record.action === 'credential')) {
        const section = record.operation ? operationSpec(record.operation)?.section : undefined;
        this.hub.publish({ type: 'settings_changed', sections: [...new Set(['overview', 'checks', ...(section ? [section] : [])])] as SettingsSection[], change: record.id });
      }
      throw error;
    }
  }

  async feedSettings(request: FastifyRequest) {
    const feed = this.options.consumers!.feed!;
    const parsed = feedSettingsBody.safeParse(request.body);
    if (!parsed.success) return refused('invalid_parameters');
    const { quietHours, push, ...patch } = parsed.data;
    if (!this.options.consumers?.notifications) return feed.updateSettings(parsed.data);
    if (quietHours !== undefined || push !== undefined) {
      const snapshot = await this.target(operationSpec('wayroost.notifications')!, {});
      if (!snapshot.ok) return refused(snapshot.code);
      const current = this.store.notificationSettings();
      const response = await this.apply(request, { operation: 'wayroost.notifications', params: {
        ...current, ...(quietHours !== undefined ? { quietHours } : {}),
        ...(push !== undefined ? { push: { ...current.push, ...push } } : {}),
      } }, snapshot);
      if (response.status !== 'applied') return response;
    }
    return feed.updateSettings(patch);
  }

  async apply(request: FastifyRequest, input: unknown, notificationSnapshot?: SettingsSnapshot): Promise<SettingsApplyResponse> {
    const body = settingsApplyBodySchema.safeParse(input);
    if (!body.success || body.data.afterSeconds !== undefined) return refused('invalid_parameters');
    if (body.data.operation === 'settings.accept-current') return this.acceptCurrent(request, body.data);
    let parameters = body.data.params;
    if (!decideRead(settingsContext(request, this.config), 'pc-only').allowed) {
      const lookup = body.data.operation === 'gateway.point' ? { view: 'gateway.role-map' as const, param: 'backend' }
        : body.data.operation === 'paseo.profile-model' ? { view: 'paseo.agents' as const, param: 'profile' }
        : body.data.operation === 'hermes.personality' ? { view: 'hermes.agents' as const, param: 'personality' } : undefined;
      if (lookup && typeof parameters[lookup.param] === 'string' && /^[a-f0-9]{63,64}$/.test(parameters[lookup.param] as string)) {
        const result = await this.read(lookup.view);
        if (!result.ok) return refused(result.code);
        const document = documentOf(result);
        const profiles = valueAt(document, ['daemon', 'agentProfiles']).value;
        const names = lookup.param === 'backend' ? Object.keys(valueAt(document, ['backends']).value ?? {})
          : lookup.param === 'profile' ? (Array.isArray(profiles) ? profiles.flatMap(entry => entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.id === 'string' ? [entry.id] : []) : [])
          : ['personalities', 'agent.personalities'].flatMap(key => Object.keys(valueAt(document, key.split('.')).value ?? {}));
        const name = names.find(name => hash(name).slice(0, String(parameters[lookup.param]).length) === parameters[lookup.param]);
        if (!name) return refused('precondition_changed');
        parameters = { ...parameters, [lookup.param]: name };
      }
    }
    if (body.data.operation === 'wayroost.notifications') {
      const parsed = settingsNotificationsWriteBodySchema.safeParse(parameters);
      if (!parsed.success) return refused('invalid_parameters');
      if (!('push' in parsed.data && 'quietHours' in parsed.data)) {
        const current = await this.read('wayroost.settings');
        if (!current.ok) return refused(current.code);
        notificationSnapshot = { ok: true, document: documentOf(current), sha256: current.sha256 };
        parameters = { ...this.store.notificationSettings(), ...parsed.data };
      }
    }
    let requestedOperation = body.data.operation;
    const intentReference = requestedOperation === 'gateway.reapply-intended' && parameters.intentId !== undefined;
    if (intentReference) {
      const alias = parseOperation(requestedOperation, parameters, 'server');
      if (!alias.ok) return refused(alias.code);
      const restored = await this.options.checks?.resolveIntent?.(String(alias.params.intentId), this.audit.entries());
      if (!restored) return refused('precondition_changed');
      const state = await this.read('gateway.state');
      if (!state.ok) return refused(state.code);
      const migration = consumerRecord(documentOf(state), 'hermes', 'hermes-config');
      if (migration?.movedAt && Date.parse(migration.movedAt) > (restored.at ?? 0)
        && migration.keys.some(key => restored.paths?.some(path => settingValuesEqual([...path], key.path)))) return refused('precondition_changed');
      requestedOperation = restored.operation; parameters = restored.params;
    }
    const operation = parseOperation(requestedOperation, parameters, 'server');
    if (!operation.ok) return refused(operation.code);
    const { spec, params } = operation;
    if (spec.verb !== 'config.apply') return refused('invalid_parameters');
    if (this.blocked(operationTarget(spec, params)).length) return { status: 'refused', code: 'outcome_unknown', message: SETTINGS_RESOLUTION_MESSAGE };
    if (spec.recovery && body.data.expected) return refused('invalid_parameters');
    const level = intentReference ? stricterLevel('confirm', operationLevel(spec, params)) : operationLevel(spec, params);
    const context = settingsContext(request, this.config);
    const decision = decideChange(level, context);
    let timing: Timing = [{ label: 'now' }];
    let keys: string[] = [];
    if (spec.keys !== 'recorded') {
      timing = await operationTiming(spec, params);
      keys = await operationKeyNames(spec, params) as string[];
    }
    const record = this.metadata(request, 'apply', operation.operation, operationTarget(spec, params), keys, level, timing);
    if (!decision.allowed && decision.code !== 'confirm_required') return this.finish(record, timing, refused(decision.code));
    if (legacyOperations.has(operation.operation) && !this.legacyRoutesViaPipeline) {
      return this.finish(record, timing, refused('config_writes_off'));
    }
    this.audit.verify();
    const current: SettingsSnapshot | { ok: false; code: SettingsErrorCode } = spec.recovery
      ? { ok: true, document: {} } : notificationSnapshot ?? await this.target(spec, params);
    if (!current.ok) return this.finish(record, timing, refused(current.code));
    let paths = operationKeys(spec, params, current.document);
    let intended: IntendedValue[];
    if (paths === 'recorded') {
      const state = await this.read('gateway.state');
      if (!state.ok) return this.finish(record, timing, refused(state.code));
      if (operation.operation === 'gateway.reapply-intended' && params.consumer === 'hermes' && params.target === 'hermes-config') {
        const migration = consumerRecord(documentOf(state), 'hermes', 'hermes-config');
        const safe = migration && await this.options.checks?.canReapplyMigration?.(migration, this.audit.entries()).catch(() => false);
        if (!safe) return this.finish(record, timing, refused('precondition_changed'));
      }
      const saved = valueAt(documentOf(state), ['migration', 'consumers', String(params.consumer), String(params.target), 'keys']).value;
      if (!Array.isArray(saved)) return this.finish(record, timing, refused('not_configured'));
      paths = saved.map(entry => keyPathSchema.parse((entry as Record<string, unknown>).path));
      intended = saved.map(entry => {
        const key = entry as Record<string, SettingValue>;
        const value = key.intended as { exists: boolean; value?: SettingValue };
        return { path: keyPathSchema.parse(key.path), ...value };
      });
    } else intended = intendedValues(operation.operation, params, paths, current.document);
    record.keys = await publicKeyNames(operationTarget(spec, params), paths);
    timing = await operationTiming(spec, params, paths);
    if (operation.operation === 'hermes.default-model') {
      const modelChanged = !settingValuesEqual(valueAt(current.document, ['model', 'default']).value, params.model as SettingValue)
        || !settingValuesEqual(valueAt(current.document, ['model', 'provider']).value, params.provider as SettingValue);
      timing = timing.filter(note => !note.when || (note.when === 'model-or-provider-changed') === modelChanged);
    }
    record.timing = timing.map(note => note.label);
    const expected = body.data.expected;
    if (expected && ('file' in expected ? expected.file.sha256 !== current.sha256 : expected.keys.some(entry => {
      const path = paths[entry.key];
      if (!path) return true;
      const value = valueAt(current.document, path);
      return 'exists' in entry ? value.exists : !value.exists || !settingValuesEqual(value.value, entry.value);
    }))) return this.finish(record, timing, refused('precondition_changed'));
    const authorization = this.authorize(request, level, operation.operation, { params, intentId: intentReference ? body.data.params.intentId : null, expected: expected ?? null }, current.sha256 ?? null, body.data.confirm);
    if (authorization) return authorization.status === 'confirm' ? authorization : this.finish(record, timing, authorization);
    const source = this.configSource(record.target!);
    if (!source?.configApply) return this.finish(record, timing, refused('config_writes_off'));
    checkDeviceSignal(request.deviceSignal);
    const command = { requestId: randomUUID(), operation: operation.operation, params,
      ...(current.sha256 ? { preconditions: { file: { sha256: current.sha256 } } }
        : paths.length ? { preconditions: { keys: paths.map((_path, key) => ({ key, exists: false as const })) } } : {}),
      origin: { change: record.id, device: record.device, level } };
    await this.options.checks?.recordIntent?.({ id: record.id, target: record.target!, operation: operation.operation, params,
      keys: record.target === 'hermes-config' && !operation.operation.startsWith('gateway.') && operation.operation !== 'hermes.revoke-always'
        ? intended.map(key => ({ path: [...key.path], before: valueAt(current.document, key.path),
          intended: { exists: key.exists, ...(key.exists ? { value: key.value } : {}) } })) : [],
      ...(operation.operation === 'hermes.revoke-always' ? { entrySha256: String(params.entrySha256) } : {}),
    }, this.audit.entries());
    this.audit.start(record, timing, undefined, command.requestId);
    return this.dispatch(request, record, timing, spec, () => source.configApply!(command));
  }

  private async dispatch(request: Pick<FastifyRequest, 'deviceSignal'>, record: SettingsWriteRecord, timing: Timing, spec: OperationSpec,
    call: () => Promise<ConfigWriteResult>, undoOf?: string): Promise<SettingsApplyResponse> {
    return this.track(request, record, timing, call,
      raw => this.writeResult(request, record, timing, spec, raw, undoOf),
      undoOf);
  }

  private async unknown(request: Pick<FastifyRequest, 'deviceSignal'>, record: SettingsWriteRecord, timing: Timing,
    undoOf?: string): Promise<SettingsApplyResponse> {
    // Keep uncertain local settings disabled until the confirmed Checks resolution.
    if (record.target === 'wayroost-settings') { this.settingsUncertain.add(record.id); this.settingsPending = false; }
    if (record.runId && record.action === 'restart') this.drains.set(record.runId, { record, timing });
    const response: SettingsApplyResponse = { status: 'refused', code: 'outcome_unknown', backupId: record.backupId ?? null };
    try { this.finish(record, timing, response, undoOf); }
    catch { /* The failed audit blocks later writes without replacing the uncertain outcome or backup id. */ }
    return response;
  }

  private async track<T>(request: Pick<FastifyRequest, 'deviceSignal'>, record: SettingsWriteRecord, timing: Timing,
    call: () => Promise<unknown>, settle: (raw: unknown) => T | Promise<T>, undoOf?: string): Promise<T | SettingsApplyResponse> {
    if (request.deviceSignal?.aborted) return this.finish(record, timing, refused('not_permitted'), undoOf);
    if (record.target === 'wayroost-settings') {
      this.settingsPending = true;
      this.store.invalidate();
    }
    let raw: unknown;
    try { raw = await call(); }
    catch { return this.unknown(request, record, timing, undoOf); }
    // A revoked request may be audited, but cannot run any remaining consumer writes.
    if (request.deviceSignal?.aborted) {
      this.captureUnknownBackup(raw, record);
      const result = configWriteResultSchema.safeParse(raw);
      const token = result.success && (result.data.ok && 'undo' in result.data ? result.data.undo
        : !result.data.ok && 'committed' in result.data ? result.data.undo : undefined);
      if (token && token.operation === record.operation && token.target === record.target) {
        Object.assign(record, { backupId: token.backupId, backupSha256: token.backupSha256, writtenSha256: token.writtenSha256 });
      }
      return this.unknown(request, record, timing, undoOf);
    }
    return settle(raw);
  }

  /** Older executors may carry recovery metadata even when their final outcome is unknown. */
  private captureUnknownBackup(raw: unknown, record: SettingsWriteRecord): void {
    const recovery = z.object({ ok: z.literal(false), code: z.literal('outcome_unknown'),
      committed: z.literal(true), undo: undoTokenSchema }).strict().safeParse(raw);
    if (recovery.success && recovery.data.undo.operation === record.operation && recovery.data.undo.target === record.target) {
      const token = recovery.data.undo;
      Object.assign(record, { backupId: token.backupId, backupSha256: token.backupSha256, writtenSha256: token.writtenSha256 });
    }
    const advertised = configWriteResultSchema.safeParse(raw);
    if (advertised.success && !advertised.data.ok && advertised.data.code === 'outcome_unknown'
      && 'target' in advertised.data && advertised.data.target === record.target && advertised.data.backupId) {
      record.backupId = advertised.data.backupId;
    }
  }

  private async writeResult(request: Pick<FastifyRequest, 'deviceSignal'>, record: SettingsWriteRecord, timing: Timing, spec: OperationSpec, raw: unknown,
    undoOf?: string): Promise<SettingsApplyResponse> {
    const parsed = configWriteResultSchema.safeParse(raw);
    if (!parsed.success) {
      this.captureUnknownBackup(raw, record);
      return this.unknown(request, record, timing, undoOf);
    }
    let result: ConfigWriteResult = parsed.data;
    if (result.ok && 'recovered' in result) {
      if (!spec.recovery || result.operation !== record.operation || result.target !== record.target || undoOf) {
        return this.unknown(request, record, timing, undoOf);
      }
      const change: ChangeResult = { id: record.id, operation: record.operation!, target: result.target,
        keys: [], timing: [...timing], effective: 'verified', undoable: false };
      const response = this.finish(record, timing, { status: 'applied', change });
      this.hub.publish({ type: 'settings_changed', sections: ['overview', 'checks'], change: record.id });
      return response;
    }
    if (result.ok && spec.recovery) return this.unknown(request, record, timing);
    const token = result.ok ? result.undo : 'committed' in result ? result.undo : undefined;
    if (token && (token.operation !== record.operation || token.target !== record.target
      || result.ok && (result.operation !== record.operation || result.target !== record.target || result.backupId !== token.backupId
        || result.backupSha256 !== token.backupSha256 || result.writtenSha256 !== token.writtenSha256))) {
      return this.unknown(request, record, timing, undoOf);
    }
    if (!result.ok && result.code === 'outcome_unknown') {
      this.captureUnknownBackup(raw, record);
      if (token) Object.assign(record, { backupId: token.backupId, backupSha256: token.backupSha256, writtenSha256: token.writtenSha256 });
      return this.unknown(request, record, timing, undoOf);
    }
    if (record.target === 'wayroost-settings') this.settingsPending = false;
    if (token) {
      Object.assign(record, { backupId: token.backupId, backupSha256: token.backupSha256, writtenSha256: token.writtenSha256 });
      try {
        const current = await this.target(spec, { target: token.target });
        if (result.ok && !current.ok) return this.unknown(request, record, timing, undoOf);
        if (result.ok && (!current.ok || !persistedFileMatches(current, token.writtenSha256))) result = { ok: false, code: 'verify_mismatch', committed: true, undo: token };
        else if (result.ok && record.target === 'wayroost-settings') {
          const consumers = this.options.consumers;
          if (this.legacyRoutesViaPipeline && consumers?.safetyCommands && consumers.safetyCommands.enabled() !== this.safetyCommandsEnabled()) {
            result = { ok: false, code: 'verify_mismatch', committed: true, undo: token };
          }
        }
      } catch { return this.unknown(request, record, timing, undoOf); }
    }
    if (!token && record.target === 'wayroost-settings') {
      await this.refreshConsumers();
    }
    if (token) Object.assign(record, { backupId: token.backupId, backupSha256: token.backupSha256, writtenSha256: token.writtenSha256 });
    try {
      if (result.ok && !undoOf) await this.options.checks?.confirmIntent?.(record.id, this.now());
      if (result.ok && undoOf) await this.options.checks?.confirmUndo?.(record.id, undoOf, this.now(), this.audit.entries());
    } catch { return this.unknown(request, record, timing, undoOf); }
    if (!result.ok && !token) return this.finish(record, timing, refused(result.code), undoOf);
    const safetyBlocked = record.operation === 'wayroost.safety-commands'
      && this.store.safetyCommandsEnabled() !== this.safetyCommandsEnabled();
    const change: ChangeResult = { id: record.id, operation: record.operation!, target: record.target as UndoToken['target'],
      keys: record.keys, timing: [...timing], effective: result.ok && !safetyBlocked ? timing.every(note => note.label === 'now') ? 'verified' : 'pending' : 'mismatch',
      undoable: !!token && !(result.ok && result.unchanged), ...(spec.lasts ? { lasts: spec.lasts } : {}),
      ...(record.target === 'hermes-config' ? { reloadOpenPages: true } : {}) };
    if (record.operation === 'hermes.revoke-always') change.restartRequired = { component: 'hermes', choices: ['idle', 'now'], timing: [...timing] };
    if (result.ok && result.unchanged) { delete record.backupId; delete record.backupSha256; delete record.writtenSha256; }
    let response: SettingsApplyResponse;
    try { response = this.finish(record, timing, result.ok ? { status: 'applied', change } : { status: 'refused', code: result.code, change }, undoOf); }
    catch (error) {
      if (!(error instanceof SettingsAuditError)) throw error;
      return { status: 'refused', code: 'audit_unavailable', change: { ...change, undoable: false } };
    }
    if (result.ok && !result.unchanged && !undoOf && record.operation === 'hermes.revoke-always') {
      const restartTiming: Timing = [{ label: 'restart-when-idle:hermes' }];
      const restartRecord: SettingsWriteRecord = { id: changeId(), at: this.now(), action: 'restart', operation: 'service.restart-hermes',
        target: 'hermes', keys: [], device: record.device, level: 'anywhere', timing: restartTiming.map(note => note.label), result: 'outcome_unknown' };
      try {
        const restart = await this.launchRestart(request, restartRecord, restartTiming, 'hermes', 'idle');
        if ('run' in restart && restart.run) change.restartRequired!.runId = restart.run.id;
        else if ('code' in restart) change.restartRequired!.code = restart.code;
      } catch (error) { change.restartRequired!.code = error instanceof SettingsAuditError ? 'audit_unavailable' : 'outcome_unknown'; }
    }
    if (result.ok && !result.unchanged) this.hub.publish({ type: 'settings_changed', sections: ['overview', spec.section, 'checks'], change: record.id });
    return response;
  }

  async undo(request: FastifyRequest): Promise<SettingsApplyResponse> {
    const body = settingsUndoBodySchema.safeParse(request.body);
    if (!body.success) return refused('invalid_parameters');
    const saved = this.audit.token(body.data.change);
    if (!saved) return refused('undo_changed');
    if (this.blocked(saved.token.target).length) return { status: 'refused', code: 'outcome_unknown', message: SETTINGS_RESOLUTION_MESSAGE };
    const spec = operationSpec(saved.token.operation)!;
    const level = stricterLevel(saved.entry.level, undoLevel(spec));
    const timing = saved.entry.notes;
    const record = this.metadata(request, 'undo', saved.token.operation, saved.token.target, saved.entry.keys, level, timing);
    const decision = decideChange(level, settingsContext(request, this.config));
    if (!decision.allowed && decision.code !== 'confirm_required') return this.finish(record, timing, refused(decision.code));
    if (legacyOperations.has(saved.token.operation) && !this.legacyRoutesViaPipeline) {
      return this.finish(record, timing, refused('config_writes_off'));
    }
    const current = await this.target(spec, { target: saved.token.target });
    if (!current.ok) return this.finish(record, timing, refused(current.code));
    if (current.sha256 !== saved.token.writtenSha256) return this.finish(record, timing, refused('undo_changed'));
    const authorization = this.authorize(request, level, saved.token.operation, { undo: body.data.change, token: saved.token }, current.sha256, body.data.confirm);
    if (authorization) return authorization.status === 'confirm' ? authorization : this.finish(record, timing, authorization);
    const source = this.configSource(saved.token.target);
    if (!source?.configUndo) return this.finish(record, timing, refused('config_writes_off'));
    checkDeviceSignal(request.deviceSignal);
    const command = { requestId: randomUUID(), token: saved.token, origin: { change: record.id, device: record.device, level } };
    // Accepting an undo durably spends its token before the supervisor can receive it.
    this.audit.start(record, timing, body.data.change, command.requestId);
    return this.dispatch(request, record, timing, spec, () => source.configUndo!(command), body.data.change);
  }

  async legacy(request: FastifyRequest, operation: string, input: Record<string, unknown>): Promise<unknown> {
    const { confirm, ...params } = input;
    const response = await this.apply(request, { operation, params, ...(confirm ? { confirm } : {}) });
    this.notificationOutcomes.set(request, response.status);
    if (response.status !== 'applied') return response;
    if (operation === 'wayroost.safety-commands') return { enabled: this.safetyCommandsEnabled(), commands: SAFETY_COMMANDS };
    if (operation === 'paseo.provider-enabled') {
      const status = await this.options.consumers?.cloudAgents?.();
      if (!status) return refused('not_configured');
      return { agents: status.agents.map(agent => agent.id === params.provider
        ? { ...agent, enabled: params.enabled, state: params.enabled ? agent.state === 'off' ? 'loading' : agent.state : 'off' } : agent) };
    }
    const status = await this.workerApprovals();
    if ('status' in status) return status;
    return { ...status, enabled: params.enabled, choiceConfirmed: true, config: 'written', reload: 'pending' };
  }

  async credential(request: FastifyRequest) {
    const provider = z.object({ provider: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/) }).safeParse(request.params);
    if (!provider.success) return refused('invalid_parameters');
    const test = request.method === 'POST';
    const body = test ? settingsCredentialTestBodySchema.safeParse(request.body) : request.method === 'PUT' ? settingsCredentialBodySchema.safeParse(request.body) : undefined;
    if (body && !body.success) return refused('invalid_parameters');
    if (test) {
      const decision = decideChange('pc-only', settingsContext(request, this.config));
      if (!decision.allowed) return refused(decision.code);
      if (!this.supervisor?.credentialTest) return refused('config_writes_off');
      checkDeviceSignal(request.deviceSignal);
      const id = changeId();
      this.audit.event('settings-probe-start', { id, at: this.now(), device: request.device!.id });
      let raw: unknown;
      try { raw = await this.supervisor.credentialTest({ requestId: randomUUID(), provider: provider.data.provider,
        backend: (body!.data as { backend: string }).backend }); } catch { raw = { ok: false, code: 'unavailable' }; }
      const parsed = credentialTestResultSchema.safeParse(raw);
      const result = request.deviceSignal?.aborted ? { ok: false as const, code: 'not_permitted' as const }
        : parsed.success && (!parsed.data.ok || parsed.data.provider === provider.data.provider && parsed.data.backend === (body!.data as { backend: string }).backend)
          ? parsed.data : { ok: false as const, code: 'unavailable' as const };
      const code = result.ok ? undefined : result.code === 'outcome_unknown' ? 'unavailable' : result.code;
      this.audit.event('settings-probe-result', { id, result: code ?? 'ok' });
      return code ? { status: 'refused', code, test: { ok: false, code } } : { status: 'applied', timing: [], test: result };
    }
    const timing: Timing = [{ label: 'restart-when-idle:gateway' }];
    const record = this.metadata(request, 'credential', 'gateway.credential', 'gateway-credentials', [`["sha256:${hash(provider.data.provider)}"]`], 'pc-only', timing);
    const decision = decideChange('pc-only', settingsContext(request, this.config));
    if (!decision.allowed) return this.finish(record, timing, refused(decision.code));
    const supervisor = this.supervisor;
    if (!supervisor?.credentialWrite) return this.finish(record, timing, refused('config_writes_off'));
    checkDeviceSignal(request.deviceSignal);
    const requestId = randomUUID();
    if (this.blocked('gateway-credentials').length) return { status: 'refused', code: 'outcome_unknown', message: SETTINGS_RESOLUTION_MESSAGE };
    this.audit.start(record, timing, undefined, requestId);
    const call = () => supervisor.credentialWrite!({ requestId, provider: provider.data.provider,
      ...(request.method === 'PUT' ? { action: 'set' as const, secret: (body!.data as { secret: string }).secret } : { action: 'remove' as const }),
      origin: { change: record.id, device: record.device, level: record.level } });
    return this.track<unknown>(request, record, timing, call, raw => {
      const result = credentialWriteResultSchema.safeParse(raw);
      if (!result.success) return this.unknown(request, record, timing);
      const errorCode = result.data.ok ? undefined : result.data.code;
      if (errorCode === 'outcome_unknown') return this.unknown(request, record, timing);
      this.complete(record, timing, errorCode ?? 'ok');
      if (errorCode) return { status: 'refused', code: errorCode };
      this.hub.publish({ type: 'settings_changed', sections: ['models', 'overview'], change: record.id });
      return { status: 'applied', timing: [...timing] };
    });
  }

  async restart(request: FastifyRequest) {
    const body = settingsRestartBodySchema.safeParse(request.body);
    if (!body.success) return refused('invalid_parameters');
    const { component, when, confirm } = body.data;
    const timing: Timing = [{ label: when === 'idle' ? `restart-when-idle:${component}` : `restart-now:${component}` }];
    const level = when === 'idle' ? 'anywhere' : 'confirm';
    const record = this.metadata(request, 'restart', `service.restart-${component}`, component, [], level, timing);
    const authorization = this.authorize(request, level, record.operation!, { component, when }, null, confirm);
    if (authorization) return authorization.status === 'confirm' ? authorization : this.finish(record, timing, authorization);
    return this.launchRestart(request, record, timing, component, when);
  }

  private async launchRestart(request: Pick<FastifyRequest, 'deviceSignal'>, record: SettingsWriteRecord, timing: Timing,
    component: z.infer<typeof settingsRestartBodySchema>['component'], when: 'idle' | 'now') {
    if (!this.supervisor?.drainRestart) return this.finish(record, timing, refused('config_writes_off'));
    checkDeviceSignal(request.deviceSignal);
    const command = { requestId: randomUUID(), protocol: HERMES_DRAIN_PROTOCOL.version, component, when,
      origin: { change: record.id, device: record.device, level: record.level } };
    record.runId = command.requestId;
    this.audit.start(record, timing, undefined, command.requestId);
    return this.track(request, record, timing, () => this.supervisor!.drainRestart!(command), raw => {
      const result = drainRestartResultSchema.safeParse(raw);
      if (!result.success) return this.unknown(request, record, timing);
      if (!result.data.ok) return result.data.code === 'outcome_unknown' ? this.unknown(request, record, timing) : this.finish(record, timing, refused(result.data.code));
      const run = result.data.run;
      if (run.id !== command.requestId || run.component !== component || run.when !== when) return this.unknown(request, record, timing);
      const code = drainRunResult(run);
      if (code === 'outcome_unknown' && run.endedAt === undefined) return this.unknown(request, record, timing);
      if (code === 'pending') {
        this.complete(record, timing, 'outcome_unknown');
        this.drains.set(run.id, { record, timing });
        return { status: 'accepted', run, timing: [...timing] };
      }
      this.complete({ ...record, observed: 'supervisor' }, timing, code);
      return code === 'ok' ? { status: 'completed', run, timing: [...timing] } : { ...refused(code), run };
    });
  }

  private async refreshDrains() {
    for (const id of this.drains.keys()) await this.restartRun(id);
  }
  async restartRun(id: string) {
    if (!z.uuid({ version: 'v4' }).safeParse(id).success) return refused('invalid_parameters');
    if (!this.supervisor?.drainRestartRun) return refused('unavailable');
    let raw: unknown;
    try { raw = await this.supervisor.drainRestartRun(id); } catch { return refused('unavailable'); }
    const result = drainRestartResultSchema.safeParse(raw);
    if (!result.success || result.data.ok && result.data.run.id !== id) return refused('failed');
    if (!result.data.ok) return refused(result.data.code);
    const run = result.data.run;
    const pending = this.drains.get(id);
    const code = drainRunResult(run);
    if (pending && !this.closed && run.endedAt !== undefined && code !== 'pending') {
      if (run.component !== pending.record.target || run.when !== (pending.record.timing[0]?.startsWith('restart-now:') ? 'now' : 'idle')) return refused('failed');
      this.complete({ ...pending.record, observed: 'supervisor' }, pending.timing, code);
      this.drains.delete(id);
      if (code !== 'outcome_unknown') this.hub.publish({ type: 'settings_changed', sections: ['overview', 'checks'], change: pending.record.id });
      this.options.consumers?.notifications?.alert({ event: code === 'ok' ? 'settings-applied' : 'settings-failed',
        source: run.component === 'hermes' || run.component === 'dashboard' ? 'hermes' : 'supervisor',
        title: code === 'ok' ? 'A change applied' : code === 'outcome_unknown' ? 'The change outcome is unknown' : 'A change failed',
        ...(code === 'outcome_unknown' ? { body: SETTINGS_RESOLUTION_MESSAGE } : {}), url: '/#settings', tag: 'settings-restart' });
    }
    return code === 'pending' ? { status: 'accepted', run } : code === 'ok' ? { status: 'completed', run } : { status: 'refused', code, run };
  }

  async usage() {    if (!this.supervisor?.usageSummary) return refused('config_writes_off');
    const today = new Date(this.now()); today.setUTCHours(0, 0, 0, 0);
    try {
      const result = usageSummaryResultSchema.safeParse(await this.supervisor.usageSummary({ windows: [
        { id: 'today', since: today.getTime() }, { id: 'week', since: today.getTime() - 6 * 86_400_000 },
      ] }));
      return !result.success ? refused('failed') : result.data.ok ? result.data : refused(result.data.code);
    } catch { return refused('unavailable'); }
  }
}

/** Route policy also closes earlier write paths to the same settings. */
export async function registerSettingsRoutes(app: FastifyInstance, config: AppConfig, supervisor: SupervisorApi | undefined, hub: EventHub, options: SettingsOptions = {}) {
  const pipeline = new SettingsPipeline(config, supervisor, hub, options);
  await pipeline.initialize();
  app.addHook('onClose', async () => pipeline.close());
  app.addHook('preHandler', async (request, reply) => {
    const route = request.routeOptions.url ?? request.url.split('?')[0]!;
    if (pipeline.legacyRoutesViaPipeline && (request.method === 'GET' || request.method === 'HEAD') && route === '/api/safety-commands') {
      const result = await pipeline.serialize(request, () => pipeline.refreshConsumers());
      if (result) return send(reply, result);
    }
    if (!isSettingsPolicyRoute(route)) return;
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    if (EARLIER_SETTINGS_ROUTES.includes(route as typeof EARLIER_SETTINGS_ROUTES[number])) {
      if (method !== 'GET' && config.role === 'shadow') return send(reply, refused('shadow_read_only'));
      return;
    }
    const policy = routePolicy(method, route);
    if (!policy) {
      if (!route.startsWith('/api/settings/') && (method === 'GET' || method === 'HEAD')) return;
      return send(reply, refused('not_permitted'));
    }
    if (policy.write && config.role === 'shadow') return send(reply, refused('shadow_read_only'));
    const decision = decideRead(settingsContext(request, config));
    if (!decision.allowed) return send(reply, refused(decision.code));
  });
  app.get(SETTINGS_ROUTES.section, async (request, reply) => {
    const section = settingsSectionSchema.safeParse((request.params as { section: string }).section);
    if (!section.success) return send(reply, refused('invalid_parameters'));
    return send(reply, await pipeline.serialize(request, () => pipeline.section(request, section.data)));
  });
  app.get(SETTINGS_ROUTES.changes, async (request, reply) => send(reply, await pipeline.serialize(request, async () => ({ changes: pipeline.recent(settingsContext(request, config)) }))));
  app.post(SETTINGS_ROUTES.apply, async (request, reply) => send(reply, await pipeline.serialize(request, () => pipeline.apply(request, request.body))));
  app.put('/api/feed/settings', async (request, reply) => {
    if (!options.consumers?.feed) return reply.code(404).send({ error: 'For you is turned off here.' });
    return send(reply, await pipeline.serialize(request, () => pipeline.feedSettings(request)));
  });
  app.post(SETTINGS_ROUTES.undo, async (request, reply) => send(reply, await pipeline.serialize(request, () => pipeline.undo(request))));
  app.get(SETTINGS_ROUTES.checks, async (request, reply) => send(reply, await pipeline.serialize(request, () => pipeline.checks(request))));
  app.get(SETTINGS_ROUTES.usage, async (_request, reply) => send(reply, await pipeline.usage()));
  app.post(SETTINGS_ROUTES.restart, async (request, reply) => send(reply, await pipeline.serialize(request, () => pipeline.restart(request))));
  app.get(SETTINGS_ROUTES.restartRun, async (request, reply) => send(reply, await pipeline.restartRun((request.params as { id: string }).id)));
  for (const method of ['PUT', 'DELETE'] as const) app.route({ method, url: SETTINGS_ROUTES.credential,
    handler: async (request, reply) => send(reply, await pipeline.serialize(request, () => pipeline.credential(request))) });
  app.post(SETTINGS_ROUTES.credentialTest, async (request, reply) => send(reply, await pipeline.serialize(request, () => pipeline.credential(request))));
  for (const [url, operation, section] of [[SETTINGS_ROUTES.notifications, 'wayroost.notifications', 'notifications'],
    [SETTINGS_ROUTES.safetyCommands, 'wayroost.safety-commands', 'safety']] as const) {
    app.get(url, async (request, reply) => send(reply, await pipeline.serialize(request, async () => section === 'notifications'
      ? pipeline.notifications() : pipeline.section(request, section))));
    app.put(url, async (request, reply) => send(reply, await pipeline.serialize(request, () => pipeline.apply(request, { operation, params: request.body }))));
  }
  return {
    notificationSource: (request: FastifyRequest) => pipeline.notificationSource(request),
    notificationOutcome: (request: FastifyRequest) => pipeline.notificationOutcome(request),
    workerApprovals: (request: FastifyRequest) => pipeline.serialize(request, () => pipeline.workerApprovals()),
    legacyRoutesViaPipeline: pipeline.legacyRoutesViaPipeline,
    legacyWrite: async (request: FastifyRequest, reply: FastifyReply, operation: string, writer: () => unknown | Promise<unknown>) =>
      send(reply, await pipeline.legacyWrite(request, operation, writer)),
  };
}
