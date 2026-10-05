import { operationKeys, parseOperation, type OperationCaller } from '../../shared/settings-ops.js';
import { GATEWAY_ROLES, ROLE_PROVIDERS, type RoleMap, type MigrationTargetRecord } from '../../shared/gateway.js';
import { isDeepStrictEqual } from 'node:util';
import { commandAllowlist } from '../../shared/command-allowlist.js';
import { workerApprovalTools } from '../../shared/safety.js';
import type { KeyPath } from '../../shared/settings.js';
import type { SettingsTargets } from '../../shared/settings-targets.js';
import { applyValues, valueAt, type SettingOperation, type SettingValue } from '../../server/src/settings/editors/types.js';
import { ConfigError, digest } from './config-paths.js';

/** Resolve catalogue ids against the current array, never caller-supplied indices. */
export function resolveKey(path: KeyPath, document: SettingValue): (string | number)[] {
  const result: (string | number)[] = [];
  let current: SettingValue | undefined = document;
  for (const segment of path) {
    let key: string | number;
    if (typeof segment === 'object') {
      if (!Array.isArray(current)) throw new ConfigError('precondition_changed');
      const matches: number[] = current.flatMap((entry, index) => entry && typeof entry === 'object' && !Array.isArray(entry) && entry.id === segment.id ? [index] : []);
      if (matches.length !== 1) throw new ConfigError('precondition_changed');
      key = matches[0]!;
    } else key = segment;
    result.push(key);
    current = current && typeof current === 'object' && Object.hasOwn(current, key)
      ? (current as Record<string | number, SettingValue>)[key] : undefined;
  }
  return result;
}

export interface ConfigOperationContext { roleMap?: RoleMap; migration?: MigrationTargetRecord }

function object(value: SettingValue | undefined): Record<string, SettingValue> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError('parse_failed');
  return value;
}

export function configOperations(operation: string, params: unknown, caller: OperationCaller, current: SettingValue, site: SettingsTargets,
  context?: ConfigOperationContext): {
  operations: SettingOperation[]; paths: KeyPath[];
} {
  const parsed = parseOperation(operation, params, caller);
  if (!parsed.ok) throw new ConfigError(parsed.code);
  if (parsed.spec.records && !context) throw new ConfigError('not_configured');
  const p = parsed.params;
  const listed = operationKeys(parsed.spec, p, current);
  const paths = listed === 'recorded' ? context?.migration?.keys.map(key => key.path) : listed;
  if (!paths) throw new ConfigError('not_configured');
  const set = (index: number, value: unknown): SettingOperation => ({ type: 'set', path: resolveKey(paths[index]!, current), value: value as SettingValue });
  const remove = (index: number): SettingOperation => ({ type: 'delete', path: resolveKey(paths[index]!, current) });
  let operations: SettingOperation[];
  switch (operation) {
    case 'hermes.reasoning-effort': operations = [p.effort === null ? remove(0) : set(0, p.effort)]; break;
    case 'hermes.personality': operations = [set(0, p.personality)]; break;
    case 'hermes.delegation-limits': operations = [set(0, p.maxConcurrentChildren), set(1, p.maxIterations)]; break;
    case 'paseo.provider-enabled': operations = [set(0, p.enabled)]; break;
    case 'paseo.profile-model': operations = [set(0, p.model)]; break;
    case 'paseo.routing-note': operations = [p.text === '' ? remove(0) : set(0, p.text)]; break;
    case 'hermes.default-model': operations = [set(0, p.provider), set(1, p.model), set(2, p.baseUrl)]; break;
    case 'hermes.delegation-model': operations = [set(0, p.provider), set(1, p.model)]; break;
    case 'hermes.helper-model': operations = [set(0, p.provider), set(1, p.model)]; break;
    case 'hermes.delegation-fallbacks':
    case 'hermes.main-fallbacks': operations = [set(0, p.chain)]; break;
    case 'hermes.approval-mode': operations = [set(0, p.mode)]; break;
    case 'hermes.skill-staging': operations = [set(0, p.enabled)]; break;
    case 'paseo.worker-approvals': {
      operations = paths.map((path, index) => {
        const tools = object(valueAt(current, resolveKey(path, current)).value);
        try { return set(index, workerApprovalTools(tools, p.enabled as boolean)); }
        catch { throw new ConfigError('parse_failed'); }
      });
      break;
    }
    case 'hermes.revoke-always': {
      const list = valueAt(current, resolveKey(paths[0]!, current));
      const entries = commandAllowlist(list.value);
      if (!list.exists || !entries) throw new ConfigError('precondition_changed');
      const remaining = entries.filter(entry => digest(entry as string) !== p.entrySha256);
      if (remaining.length === entries.length) throw new ConfigError('precondition_changed');
      operations = [set(0, remaining)]; break;
    }
    case 'wayroost.safety-commands': operations = [set(0, p.enabled)]; break;
    case 'wayroost.notifications': operations = [set(0, p.push), set(1, p.quietHours), set(2, p.rules)]; break;
    case 'hermes.prompt-keys-move': operations = [p.toolUseEnforcement === null ? remove(0) : set(0, p.toolUseEnforcement),
      p.executionGuidance === null ? remove(1) : set(1, p.executionGuidance), p.reasoningEcho === null ? remove(2) : set(2, p.reasoningEcho)]; break;
    case 'pi.default-move': operations = [set(0, ROLE_PROVIDERS.main), set(1, 'main')]; break;
    case 'paseo.profile-move': operations = [set(0, `${ROLE_PROVIDERS.coder}/coder`)]; break;
    case 'hermes.move-to-roles': {
      if (!site.roleAddresses || !context?.roleMap) throw new ConfigError('not_configured');
      const values = new Map<string, SettingValue>();
      for (const role of GATEWAY_ROLES) values.set(`providers.${ROLE_PROVIDERS[role]}`, { base_url: site.roleAddresses[role], api_key: 'unused' });
      values.set('model.provider', ROLE_PROVIDERS.main); values.set('model.default', 'main'); values.set('model.base_url', site.roleAddresses.main);
      values.set('delegation.provider', ROLE_PROVIDERS.main); values.set('delegation.model', 'main');
      values.set('delegation.fallback_providers', [{ provider: ROLE_PROVIDERS.coder, model: 'coder' }, p.directFallback as SettingValue]);
      for (const task of p.helperTasks as string[]) {
        values.set(`auxiliary.${task}.provider`, ROLE_PROVIDERS.fast); values.set(`auxiliary.${task}.model`, 'fast');
      }
      operations = paths.map((path, index) => set(index, values.get(path.join('.'))!)); break;
    }
    case 'pi.catalog-roles': {
      if (!site.roleAddresses || !context?.roleMap) throw new ConfigError('not_configured');
      operations = GATEWAY_ROLES.map((role, index) => {
        const contract = context.roleMap!.contracts[role];
        return set(index, { baseUrl: site.roleAddresses![role], apiKey: 'unused', api: 'openai-completions', models: [{
          id: role, name: role, input: contract.input, reasoning: contract.thinkingLevels,
          contextWindow: contract.advertisedContext, maxTokens: contract.maxOutputTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }] });
      });
      const providers = object(valueAt(applyValues(current, operations), ['providers']).value);
      operations.push({ type: 'set', path: ['providers'], value: Object.fromEntries([
        ...GATEWAY_ROLES.map(role => [ROLE_PROVIDERS[role], providers[ROLE_PROVIDERS[role]]!] as const),
        ...Object.entries(providers).filter(([name]) => !Object.values(ROLE_PROVIDERS).includes(name)),
      ]) });
      paths.push(['providers']); break;
    }
    case 'gateway.reapply-intended':
    case 'gateway.restore-recorded': {
      const record = context?.migration;
      if (!record?.moved) throw new ConfigError('not_configured');
      const serving = p.serving as { provider: string; model: string; baseUrl?: string } | undefined;
      operations = [];
      for (const key of record.keys) {
        const path = resolveKey(key.path, current);
        let desired = operation === 'gateway.reapply-intended' ? key.intended : key.before;
        if (operation === 'gateway.restore-recorded' && key.kind === 'model-dependent') {
          if (!serving) throw new ConfigError('not_configured');
          const values: Record<string, string | undefined> = { 'model.provider': serving.provider, 'model.default': serving.model,
            'model.base_url': serving.baseUrl, defaultProvider: serving.provider, defaultModel: serving.model };
          const value = values[key.path.join('.')];
          if (value === undefined) throw new ConfigError('invalid_parameters');
          desired = { exists: true, value };
        }
        if (key.kind === 'order') continue;
        if (operation === 'gateway.restore-recorded' && p.keepRoleEntries && key.path[0] === 'providers') continue;
        if (!isDeepStrictEqual(valueAt(current, path), desired)) operations.push(desired.exists
          ? { type: 'set', path, value: desired.value } : { type: 'delete', path });
      }
      for (const key of record.keys.filter(key => key.kind === 'order')) {
        const providers = object(valueAt(applyValues(current, operations), resolveKey(key.path, current)).value);
        const desired = operation === 'gateway.reapply-intended' ? key.intended : key.before;
        if (desired.exists && (!Array.isArray(desired.value) || desired.value.some(name => typeof name !== 'string'))) throw new ConfigError('parse_failed');
        let names = [...(desired.exists ? desired.value as string[] : []), ...Object.keys(providers)]
          .filter((name, index, all) => Object.hasOwn(providers, name) && all.indexOf(name) === index);
        if (operation === 'gateway.restore-recorded') {
          if (!serving || !Object.hasOwn(providers, serving.provider)) throw new ConfigError('not_configured');
          names = [serving.provider, ...names.filter(name => name !== serving.provider && !Object.values(ROLE_PROVIDERS).includes(name)),
            ...names.filter(name => Object.values(ROLE_PROVIDERS).includes(name))];
        }
        if (!isDeepStrictEqual(Object.keys(providers), names)) operations.push({ type: 'set', path: resolveKey(key.path, current),
          value: Object.fromEntries(names.map(name => [name, providers[name]!])) });
      }
      break;
    }
    case 'hermes.coder-mcp-path':
    case 'pi.coder-mcp-path': {
      if (!site.coderMcp) throw new ConfigError('not_configured');
      const args = valueAt(current, resolveKey(paths[0]!, current)).value;
      if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string') || !args.includes(site.coderMcp.original)) throw new ConfigError('precondition_changed');
      operations = [set(0, args.map(arg => arg === site.coderMcp!.original ? site.coderMcp!.gatewayCopy : arg))]; break;
    }
    default: throw new ConfigError('not_configured');
  }
  return { operations, paths };
}
