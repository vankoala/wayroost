import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { commandAllowlist } from '../../shared/command-allowlist.js';
import { currentConfigVerbs, type ConfigApplyRequest, type ConfigReadRequest, type ConfigUndoRequest, type ConfigWriteResult } from '../../shared/supervisor-config.js';
import { READ_VIEWS, operationKeys, parseOperation, readViewKeys, type ReadView } from '../../shared/settings-ops.js';
import { formatKeyPath, settingValuesEqual, type SettingValue, type KeyPath, type TargetId, type UndoToken } from '../../shared/settings.js';
import type { SupervisorApi } from '../src/supervisor-client.js';
import { workerApprovalTools } from '../../shared/safety.js';

export class FakeSettingsSupervisor implements SupervisorApi {
  documents: Partial<Record<TargetId, Record<string, unknown>>> = {
    'hermes-config': { model: { provider: 'demo', default: 'demo-model', base_url: 'http://127.0.0.1:18010' },
      agent: { reasoning_effort: 'medium' }, display: { personality: '' }, approvals: { mode: 'smart' },
      skills: { write_approval: false }, command_allowlist: ['echo example'] },
    'paseo-config': { agents: { providers: { codex: { enabled: true, paseoTools: { enabled: true } } } }, daemon: {} },
    'wayroost-settings': { safetyCommandsEnabled: false, push: { approvals: true, cards: true }, quietHours: null, rules: [] },
    'gateway-role-map': { roles: { main: 'demo' } },
    'gateway-state': {}, 'pi-settings': {}, 'pi-models': {},
  };
  effectiveDocuments: Partial<Record<TargetId, Record<string, unknown>>> = {};
  agentAvailability = (['claude', 'codex', 'copilot'] as const).map(id => ({ id,
    installed: null as boolean | null, authenticated: null as boolean | null }));
  readonly backups = new Map<string, Record<string, unknown>>();
  readonly status = vi.fn(async () => ({ overall: 'ok' as const, sentence: 'Ready', components: [], at: 0, configVerbs: currentConfigVerbs(true) }));
  readonly events = vi.fn(() => () => {});
  readonly act = vi.fn<SupervisorApi['act']>();
  readonly action = vi.fn(async () => null);
  readonly reportBusy = vi.fn(async () => true);
  readonly configRequestStatus = vi.fn<NonNullable<SupervisorApi['configRequestStatus']>>(async ({ requestId }) => ({ ok: true, requestId, state: 'missing' }));
  readonly configRead = vi.fn(async ({ view }: ConfigReadRequest) => {
    if (view === 'wayroost.agents') return { ok: true as const, view, present: true, sha256: digest(this.agentAvailability),
      values: [{ path: ['agents'], exists: true as const, value: structuredClone(this.agentAvailability) }] };
    const spec: ReadView = READ_VIEWS[view];
    const effective = spec.target === 'hermes-config' && !spec.persisted;
    const document = (effective ? this.effectiveDocuments[spec.target] : undefined) ?? this.documents[spec.target];
    if (!document) return { ok: true as const, view, present: false, values: [] };
    const values = readViewKeys(READ_VIEWS[view], document).map(path => {
      const value = get(document, path);
      return value === undefined ? { path: [...path], exists: false as const } : { path: [...path], exists: true as const, value: value as never };
    });
    return { ok: true as const, view, present: true, sha256: this.sha(READ_VIEWS[view].target), values,
      ...(effective ? { effective: true as const } : {}) };
  });
  readonly configApply = vi.fn(async (request: ConfigApplyRequest): Promise<ConfigWriteResult> => {
    const parsed = parseOperation(request.operation, request.params, 'server');
    if (!parsed.ok) return { ok: false, code: parsed.code };
    const target = parsed.spec.target as TargetId;
    const before = structuredClone(this.documents[target] ?? {});
    if (request.preconditions && 'file' in request.preconditions && request.preconditions.file.sha256 !== this.sha(target)) return { ok: false, code: 'precondition_changed' };
    const params = parsed.params;
    const document = this.documents[target] ?? {};
    const paths = operationKeys(parsed.spec, params, document);
    if (paths === 'recorded') return { ok: false, code: 'not_configured' };
    if (request.preconditions && 'keys' in request.preconditions && request.preconditions.keys.some(entry => {
      const path = paths[entry.key];
      if (!path) return true;
      const value = get(document, path) as SettingValue | undefined;
      return 'exists' in entry ? value !== undefined : value === undefined || !settingValuesEqual(value, entry.value);
    })) return { ok: false, code: 'precondition_changed' };
    this.documents[target] = document;
    const values: Record<string, unknown[]> = {
      'hermes.reasoning-effort': [params.effort], 'hermes.personality': [params.personality],
      'hermes.approval-mode': [params.mode], 'hermes.skill-staging': [params.enabled],
      'paseo.routing-note': [params.text], 'paseo.provider-enabled': [params.enabled],
      'hermes.default-model': [params.provider, params.model, params.baseUrl],
      'hermes.delegation-limits': [params.maxConcurrentChildren, params.maxIterations],
      'wayroost.safety-commands': [params.enabled], 'wayroost.notifications': [params.push, params.quietHours, params.rules],
    };
    if (request.operation === 'hermes.revoke-always') document.command_allowlist = commandAllowlist(document.command_allowlist)?.filter(entry =>
      createHash('sha256').update(entry).digest('hex') !== params.entrySha256);
    else paths.forEach((path, index) => set(document, path, request.operation === 'paseo.worker-approvals'
      ? workerApprovalTools(get(document, path), params.enabled as boolean)
      : values[request.operation] ? values[request.operation]![index] : params.enabled));
    return this.written(request.operation, target, before, paths.map(formatKeyPath));
  });
  readonly configUndo = vi.fn(async ({ token }: ConfigUndoRequest): Promise<ConfigWriteResult> => {
    if (this.sha(token.target) !== token.writtenSha256) return { ok: false, code: 'undo_changed' };
    const backup = this.backups.get(token.backupId);
    if (!backup || digest(backup) !== token.backupSha256) return { ok: false, code: 'backup_mismatch' };
    const before = structuredClone(this.documents[token.target]!);
    this.documents[token.target] = structuredClone(backup);
    return this.written(token.operation, token.target, before, []);
  });

  sha(target: TargetId): string { return digest(this.documents[target]); }

  private written(operation: string, target: TargetId, before: Record<string, unknown>, keys: string[]): ConfigWriteResult {
    const backupId = `backup-${this.backups.size}`;
    this.backups.set(backupId, before);
    const token: UndoToken = { operation, target, backupId, backupSha256: digest(before), writtenSha256: this.sha(target) };
    return { ok: true, keys, ...token, undo: token };
  }
}

function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function get(document: unknown, path: KeyPath): unknown {
  let current = document;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || typeof segment === 'object' || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}
function set(document: Record<string, unknown>, path: KeyPath, value: unknown) {
  let current = document;
  path.forEach((segment, index) => {
    if (typeof segment !== 'string') throw new Error('Unsupported test path');
    if (index === path.length - 1) current[segment] = value;
    else current = (current[segment] ??= {}) as Record<string, unknown>;
  });
}
