import { GATEWAY_ADMIN_ROUTES } from '../../shared/gateway.js';
import { z } from 'zod';
import { gatewayAdmin } from './gateway-admin.js';
import { credentialWriteRequestSchema, credentialWriteResultSchema, drainRestartRequestSchema, drainRestartResultSchema, drainRestartOutcomeSchema,
  keyMay, keyRole, drainRunResult, credentialTestRequestSchema, credentialTestResultSchema, drainRestartRunSchema, type ConfigAuditRow, type CredentialWriteRequest, type DrainRestartRun } from '../../shared/supervisor-config.js';
import { credentialSecretSchema } from '../../shared/settings.js';
import type { SettingsTargets } from '../../shared/settings-targets.js';
import { ConfigAudit, type ConfigRequestRecord } from './config-audit.js';
import { ConfigError, digest } from './config-paths.js';
import { configErrorCode } from './config-executor.js';
import { credentialMap, storedCredential, credentialProviders, type CredentialResult } from './credential-executor.js';
import { configUnit, type ConfigUnit, type ConfigUnitLineHandler, type ConfigUnitRunner } from './config-unit.js';
import { drainProgressSchema } from './drain-runtime.js';
import { credentialUnit, drainUnit, componentRestartUnit, prepareCredentialUnit, prepareDrainUnit, serviceEntry, sweepUnit } from './service-unit.js';
import type { Trust } from './trust.js';
import type { Key } from './keys.js';
import { configCommand, type ConfigCommand } from './config-command.js';
import { DRAIN_UNIT, type HermesTarget } from './drain-files.js';
import type { SettingsErrorCode } from '../../shared/settings.js';

export type DrainResult = z.infer<typeof drainRestartResultSchema>;
export interface ConfigServicesOptions {
  site: () => Promise<SettingsTargets>; runner: ConfigUnitRunner; trust: Trust; audit: ConfigAudit;
  executable?: string; entry?: string;
  command?: ConfigCommand;
  admin?: typeof gatewayAdmin;
}
const unknown = { ok: false, code: 'outcome_unknown' } as const;
export class ConfigServices {
  private readonly requests = new Map<string, { binding: string; promise: Promise<CredentialResult | DrainResult> }>();
  private readonly drains = new Map<string, DrainRestartRun>();
  private readonly drainActive = new Set<string>();
  sweepStatus: { ok: boolean; code?: SettingsErrorCode } | undefined;
  constructor(private readonly options: ConfigServicesOptions) {}
  async initialize(): Promise<void> {
    try {
      const site = await this.options.site();
      if (!site.hermes) return;
      await this.prepareDrain(site.hermes);
      const output = await this.launch(sweepUnit(site.hermes, this.options.executable, this.options.entry));
      if (output.code !== 0 || output.stdout.trim() !== '{"ok":true}') throw new ConfigError('outcome_unknown');
      this.sweepStatus = { ok: true };
    } catch (error) { this.sweepStatus = { ok: false, code: configErrorCode(error) }; }
  }
  async runStatus(id: string): Promise<DrainResult> {
    if (!z.uuid({ version: 'v4' }).safeParse(id).success) return { ok: false, code: 'invalid_parameters' };
    const active = this.drains.get(id);
    if (active) return { ok: true, run: structuredClone(active) };
    const previous = await this.options.audit.request(id);
    const result = previous?.drainResult;
    return result?.ok && drainRunResult(result.run) === 'pending' ? unknown : result ?? unknown;
  }
  credential(input: unknown, key: Key): Promise<CredentialResult> {
    return this.run('credential.write', input, key) as Promise<CredentialResult>;
  }
  drain(input: unknown, key: Key): Promise<DrainResult> {
    return this.run('service.drain-restart', input, key) as Promise<DrainResult>;
  }
  async withDrainRecovery<T>(work: () => Promise<T>): Promise<T> {
    if (this.drainActive.has('hermes')) throw new ConfigError('busy');
    this.drainActive.add('hermes');
    try { return await work(); } finally { this.drainActive.delete('hermes'); }
  }
  async credentialTest(input: unknown, key: Key) {
    if (!keyMay(keyRole(key), 'credential.test')) return { ok: false, code: 'not_permitted' } as const;
    const parsed = credentialTestRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'invalid_parameters' } as const;
    try {
      const site = await this.options.site();
      const target = site.targets['gateway-role-map'];
      if (!target || !site.targets['gateway-credentials']) return { ok: false, code: 'not_configured' } as const;
      const { provider, backend } = parsed.data;
      const map = await credentialMap(site);
      if (!Object.hasOwn(map.backends, backend) || map.backends[backend]?.provider !== provider) return { ok: false, code: 'invalid_parameters' } as const;
      const secret = await storedCredential(site, provider);
      if (!secret) return { ok: false, code: 'credential_missing' } as const;
      const result = credentialTestResultSchema.safeParse(await (this.options.admin ?? gatewayAdmin)(target.adminSocket,
        GATEWAY_ADMIN_ROUTES.credentialTest(provider), { backend, secret }, 6000));
      if (!result.success || result.data.ok && (result.data.provider !== provider || result.data.backend !== backend)) return { ok: false, code: 'test_failed' } as const;
      return result.data;
    } catch { return { ok: false, code: 'backend_unavailable' } as const; }
  }
  private async prepareDrain(target: HermesTarget): Promise<void> {
    const unit = await prepareDrainUnit(target, this.options.executable, this.options.entry);
    if (!unit) return;
    const output = await this.launch(unit);
    if (output.code !== 0 || output.stdout.trim() !== '{"ok":true}') throw new ConfigError('outcome_unknown');
    if (await prepareDrainUnit(target, this.options.executable, this.options.entry)) throw new ConfigError('unsafe_directory');
  }
  private async launch(unit: ConfigUnit, onLine?: ConfigUnitLineHandler) {
    const separator = unit.argv.indexOf('--');
    try {
      await this.options.trust(unit.argv[0]!);
      await this.options.trust(unit.argv[separator + 1]!);
      await this.options.trust(unit.argv[separator + 2]!);
    } catch { throw new ConfigError('unsafe_target'); }
    return this.options.runner(unit, onLine);
  }
  private async run(verb: 'credential.write' | 'service.drain-restart', input: unknown, key: Key, importing = false): Promise<CredentialResult | DrainResult> {
    if (!keyMay(keyRole(key), verb)) return { ok: false, code: 'not_permitted' };
    const parsed = (verb === 'credential.write' ? credentialWriteRequestSchema : drainRestartRequestSchema).safeParse(input);
    if (!parsed.success) return { ok: false, code: 'invalid_parameters' };
    const request = parsed.data;
    // Only names and action identities are persisted; a secret has no audit fingerprint.
    const { secret: _secret, ...publicRequest } = request as CredentialWriteRequest & { secret?: string };
    const identity = { requestSha256: digest(JSON.stringify({ verb, request: publicRequest, importing })), callerSha256: digest(JSON.stringify([key.name, key.scope, key.sha256])) };
    const binding = JSON.stringify(identity);
    const existing = this.requests.get(request.requestId);
    if (existing) return existing.binding === binding ? structuredClone(await existing.promise) : { ok: false, code: 'invalid_parameters' };
    const promise = this.execute(verb, request, key, identity, importing);
    this.requests.set(request.requestId, { binding, promise });
    try { return structuredClone(await promise); }
    finally { this.requests.delete(request.requestId); }
  }
  private async execute(verb: 'credential.write' | 'service.drain-restart', request: z.infer<typeof credentialWriteRequestSchema> | z.infer<typeof drainRestartRequestSchema>,
    key: Key, identity: Pick<ConfigRequestRecord, 'requestSha256' | 'callerSha256'>, importing: boolean): Promise<CredentialResult | DrainResult> {
    const audit = this.options.audit;
    const row: ConfigAuditRow = { id: request.requestId, time: new Date().toISOString(), caller: key.name, verb,
      keys: 'provider' in request ? [request.provider] : [], target: 'provider' in request ? 'gateway-credentials' : request.component, result: 'outcome_unknown' };
    if (request.origin) row.change = request.origin.change;
    let launched = false;
    let audited = false;
    let lockedDrain = false;
    let result: CredentialResult | DrainResult = unknown;
    try {
      const previous = await audit.request(row.id);
      if (previous) {
        if (previous.requestSha256 !== identity.requestSha256 || previous.callerSha256 !== identity.callerSha256) throw new ConfigError('invalid_parameters');
        await audit.reconcile();
        const result = previous.credentialResult ?? previous.drainResult ?? unknown;
        return result.ok && 'run' in result && drainRunResult(result.run) === 'pending' ? unknown : result;
      }
      const site = await this.options.site();
      if (!site.configWrites) throw new ConfigError('config_writes_off');
      let unit: ConfigUnit;
      let preparation: ConfigUnit | undefined;
      if ('provider' in request) {
        if (!site.targets['gateway-credentials']) throw new ConfigError('not_configured');
        if (!(await credentialProviders(site)).includes(request.provider)) throw new ConfigError('invalid_parameters');
        preparation = await prepareCredentialUnit(site, this.options.executable, this.options.entry);
        unit = credentialUnit(site, request, this.options.executable, this.options.entry);
      } else {
        if (request.component === 'hermes' && (!site.hermes || site.hermes.runAs.uid !== site.hermes.drainMarker.runAs.uid)) throw new ConfigError('not_configured');
        if (this.drainActive.has(request.component)) throw new ConfigError('busy');
        this.drainActive.add(request.component); lockedDrain = true;
        const unitName = request.component === 'hermes' ? DRAIN_UNIT : `wayroost-drain-${request.component}.service`;
        const status = await (this.options.command ?? configCommand(this.options.trust))(['systemctl', 'is-active', unitName], {}, 5000);
        if ([0, 3].includes(status.code) && ['active', 'activating', 'deactivating', 'reloading'].includes(status.stdout.trim())) throw new ConfigError('busy');
        if (![3, 4].includes(status.code) || !['inactive', 'failed', 'unknown', ''].includes(status.stdout.trim())) throw new ConfigError('failed');
        this.drains.set(row.id, { id: row.id, component: request.component, when: request.when, state: 'waiting', startedAt: Date.now(), attempts: 0,
          protocol: request.protocol, probeAttempts: 0, busy: [] });
        unit = request.component === 'hermes' ? drainUnit(site.hermes!, request.when, this.options.executable, this.options.entry)
          : componentRestartUnit(site, request.component, request.when, this.options.executable, this.options.entry);
      }
      const separator = unit.argv.indexOf('--');
      try {
        for (const path of [unit.argv[0]!, unit.argv[separator + 1]!, unit.argv[separator + 2]!]) await this.options.trust(path);
      } catch { throw new ConfigError('unsafe_target'); }
      await audit.save({ ...identity, row, ...(!('provider' in request) ? { drainResult: { ok: true as const, run: this.drains.get(row.id)! } } : {}) });
      audited = true;
      if (importing && 'provider' in request) {
        const target = site.targets['pi-models'];
        if (!target || target.runAs.uid === 0 || !site.keySources.some(source => source.provider === request.provider)) throw new ConfigError('not_configured');
        const sourceUnit = configUnit({ path: target.path, uid: target.runAs.uid }, { mode: 'import-read', site, provider: request.provider }, this.options.executable, this.options.entry ?? serviceEntry);
        const sourceOutput = await this.launch(sourceUnit);
        if (sourceOutput.code !== 0 || sourceOutput.stdout.length > 16 * 1024) throw new ConfigError('unsafe_target');
        const value = z.object({ secret: credentialSecretSchema }).strict().safeParse(JSON.parse(sourceOutput.stdout));
        if (!value.success) throw new ConfigError('parse_failed');
        unit = credentialUnit(site, { ...request, secret: value.data.secret }, this.options.executable, this.options.entry);
      }
      const work = async (): Promise<CredentialResult | DrainResult> => {
        launched = true;
        try {
          if (preparation) {
            const output = await this.launch(preparation);
            if (output.code !== 0 || output.stdout.trim() !== '{"ok":true}') throw new ConfigError('outcome_unknown');
            if (await prepareCredentialUnit(site, this.options.executable, this.options.entry)) throw new ConfigError('unsafe_directory');
          }
          if (!('provider' in request) && request.component === 'hermes') await this.prepareDrain(site.hermes!);
          let terminalSeen = false;
          const output = await this.launch(unit, 'provider' in request ? undefined : line => {
            const value: unknown = JSON.parse(line);
            if (drainRestartOutcomeSchema.safeParse(value).success && !terminalSeen) { terminalSeen = true; return false; }
            const { progress } = drainProgressSchema.parse(value);
            if (terminalSeen) throw new Error();
            const run = this.drains.get(row.id)!;
            const next = drainRestartRunSchema.parse({ ...run, ...progress });
            if (next.attempts < run.attempts || next.probeAttempts < run.probeAttempts) throw new Error();
            Object.assign(run, next);
            return true;
          });
          if (output.code !== 0 || Buffer.byteLength(output.stdout) > 64 * 1024 || output.stdout.trim().split('\n').length !== 1) throw new Error();
          if ('provider' in request) {
            result = credentialWriteResultSchema.parse(JSON.parse(output.stdout));
            if (result.ok && result.provider !== request.provider) throw new Error();
          } else {
            const outcome = drainRestartOutcomeSchema.parse(JSON.parse(output.stdout)).outcome;
            const run = structuredClone(this.drains.get(row.id)!);
            const states = { restarted: 'done', not_running: 'done', still_busy: 'still-busy', restart_unverified: 'failed', foreign_drain: 'failed', marker_lost: 'failed', drain_not_engaged: 'failed' } as const;
            Object.assign(run, { outcome, state: states[outcome], endedAt: Date.now() });
            result = drainRestartResultSchema.parse({ ok: true, run });
          }
          row.result = result.ok && 'run' in result ? drainRunResult(result.run) as ConfigAuditRow['result'] : result.ok ? 'ok' : result.code;
        } catch { result = unknown; row.result = result.code;
          const current = this.drains.get(row.id);
          const run = current && structuredClone(current);
          if (run) { Object.assign(run, { state: 'failed', outcome: 'restart_unverified', code: 'outcome_unknown', endedAt: Date.now() }); result = { ok: true, run }; }
        }
        if (audited) {
          try {
            await audit.append(row);
            await audit.save({ ...identity, row, ...(verb === 'credential.write' ? { credentialResult: credentialWriteResultSchema.parse(result) } : { drainResult: drainRestartResultSchema.parse(result) }) });
          } catch {
            const current = this.drains.get(row.id);
            result = current ? { ok: true, run: { ...current, state: 'failed', outcome: 'restart_unverified', code: 'outcome_unknown', endedAt: Date.now() } } : unknown;
          }
        }
        if (result.ok && 'run' in result) this.drains.set(row.id, structuredClone(result.run));
        if (lockedDrain && !('provider' in request)) this.drainActive.delete(request.component);
        return result;
      };
      if (!('provider' in request)) {
        const accepted: DrainResult = { ok: true, run: structuredClone(this.drains.get(row.id)!) };
        void work();
        return accepted;
      }
      return await work();
    } catch (error) { result = launched ? unknown : { ok: false, code: configErrorCode(error) }; row.result = result.code; }
    if (lockedDrain && !('provider' in request)) this.drainActive.delete(request.component);
    if (audited) {
      try {
        await audit.append(row);
        await audit.save({ ...identity, row, ...(verb === 'credential.write' ? { credentialResult: credentialWriteResultSchema.parse(result) } : { drainResult: drainRestartResultSchema.parse(result) }) });
      } catch { result = unknown; }
    }
    if (!result.ok && verb === 'service.drain-restart') this.drains.delete(row.id);
    return result;
  }

  async importKeys(input: unknown, key: Key): Promise<{ ok: true; providers: string[] } | { ok: false; code: string }> {
    if (!keyMay(keyRole(key), 'credential.write')) return { ok: false, code: 'not_permitted' };
    const parsed = z.object({ requestId: z.uuid({ version: 'v4' }) }).strict().safeParse(input);
    if (!parsed.success) return { ok: false, code: 'invalid_parameters' };
    try {
      const site = await this.options.site();
      if (!site.configWrites) throw new ConfigError('config_writes_off');
      const target = site.targets['pi-models'];
      if (!target || !site.targets['gateway-credentials']) throw new ConfigError('not_configured');
      const allowed = await credentialProviders(site);
      const providers: string[] = [];
      for (const source of site.keySources) {
        if (!allowed.includes(source.provider)) throw new ConfigError('invalid_parameters');
        const requestId = importRequestId(parsed.data.requestId, source.provider);
        const result = await this.run('credential.write', { requestId, action: 'set', provider: source.provider, secret: 'import' }, key, true);
        if (!result.ok) return result;
        providers.push(source.provider);
      }
      return { ok: true, providers };
    } catch (error) { return { ok: false, code: configErrorCode(error) }; }
  }
}
function importRequestId(id: string, provider: string): string {
  const hash = digest(id + ':' + provider);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
