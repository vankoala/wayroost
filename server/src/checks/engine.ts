// The Checks engine. Every check is a pure function over one snapshot: it
// compares what it read against what it should be and answers one row. A check
// never writes, never waits on anything, and can't crash the page: a source that
// couldn't be read, a check that threw, or a row outside its schema all come back
// as an `unknown` row saying the comparison didn't happen. A check that names a
// Fix only names a change the settings pipeline can run; the engine checks it
// against the operation catalogue first, so a row can't offer a write the
// pipeline would refuse.
import { MAX_CHECK_ROWS, settingsCheckRowSchema, sortCheckRows, type CheckFix, type CheckState, type SettingsCheckRow } from '../../../shared/settings-checks.js';
import { parseOperation, READ_VIEWS, type ReadViewId } from '../../../shared/settings-ops.js';
import { formatKeyPath, type KeyPath, type SettingValue } from '../../../shared/settings.js';
import type { SupervisorStatus } from '../../../shared/supervisor.js';
import { allowlistChecks } from './allowlist.js';
import { coderMcpChecks } from './coder-mcp.js';
import { directoriesChecks } from './directories.js';
import { drainMarkerChecks } from './drain-marker.js';
import { fallbacksChecks } from './fallbacks.js';
import { gatewayChecks } from './gateway.js';
import { hermesChecks } from './hermes.js';
import { hermesRoleChecks } from './hermes-roles.js';
import { paseoChecks } from './paseo.js';
import { phoneChecks } from './phone.js';
import { piChecks } from './pi.js';
import { supervisorChecks } from './supervisor.js';
import { windowsChecks } from './windows.js';
import {
  isAvailable, type AlwaysRevocation, type ChangeFact, type CheckSnapshot, type CoderProcess, type DirectoryRuleSnapshot, type DrainMarkerSnapshot,
  type GatewaySnapshot, type PaseoRuntimeSnapshot, type Observation, type PhoneSnapshot, type SourceFailure, type ViewSnapshot, type ChecksDeployment,
} from './snapshot.js';
import type { IntendedKey } from './state.js';
import type { SettingsErrorCode } from '../../../shared/settings.js';
import type { SettingsRequestContext } from '../../../shared/settings-levels.js';

/** Everything a check may need: a read view by id, or one of the gathered sources. */
export type CheckSourceKey = ReadViewId | 'supervisor' | 'gateway' | 'phone' | 'coderProcesses' | 'drainMarker'
  | 'directoryRule' | 'switchFlags' | 'revocations' | 'changes' | 'intended' | 'hermesStartedAt' | 'paseoRuntime';

export interface CheckRowInput {
  state: CheckState;
  sentence: string;
  details?: string[];
  fix?: CheckFix;
  priority?: 'high';
}

/** What a check may look at. Only the sources it names are guaranteed to be there. */
export interface CheckContext {
  readonly settingsContext: Pick<SettingsRequestContext, 'scopes'> & Partial<SettingsRequestContext>;
  /** When the snapshot was taken. */
  readonly at: number;
  readonly deployment: ChecksDeployment;
  view(id: ReadViewId): ViewSnapshot;
  /** One document across views that read the same file. */
  files(ids: readonly ReadViewId[]): Record<string, unknown>;
  value(id: ReadViewId | readonly ReadViewId[], path: KeyPath): { exists: boolean; value?: SettingValue };
  /** Why a source isn't there: a check that names a specific failure reads it itself. */
  refusal(key: CheckSourceKey): { failure: SourceFailure; code?: SettingsErrorCode } | undefined;
  supervisor(): SupervisorStatus;
  gateway(): GatewaySnapshot;
  phone(): PhoneSnapshot;
  coderProcesses(): CoderProcess[];
  drainMarker(): DrainMarkerSnapshot;
  directoryRule(): DirectoryRuleSnapshot;
  switchFlags(): Record<string, boolean>;
  revocations(): AlwaysRevocation[];
  changes(): ChangeFact[];
  intended(): IntendedKey[];
  hermesStartedAt(): number;
  paseoRuntime(): PaseoRuntimeSnapshot;
  /** A key's name for a details line: model.default, auxiliary.compression.provider. */
  name(...path: KeyPath): string;
}

export interface Check {
  /** The row this check owns; one check, one row. */
  id: string;
  /** Sources the engine must have read before calling run. */
  requires?: readonly CheckSourceKey[];
  /** The sentence when a source it needs couldn't be read. */
  unknown: string;
  run(context: CheckContext): CheckRowInput;
}

class MissingSource extends Error {}

const SOURCES: readonly Exclude<CheckSourceKey, ReadViewId>[] = ['supervisor', 'gateway', 'phone', 'coderProcesses',
  'drainMarker', 'directoryRule', 'switchFlags', 'revocations', 'changes', 'intended', 'hermesStartedAt', 'paseoRuntime'];

const isViewKey = (key: CheckSourceKey): key is ReadViewId => !SOURCES.includes(key as Exclude<CheckSourceKey, ReadViewId>);

function sourceOf(snapshot: CheckSnapshot, key: CheckSourceKey): Observation<unknown> | undefined {
  return isViewKey(key) ? snapshot.views[key] : snapshot[key];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function merge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const current = merged[key];
    if (isPlainObject(current) && isPlainObject(value)) merged[key] = merge(current, value);
    else if (Array.isArray(current) && Array.isArray(value) && value.length > current.length) merged[key] = value;
    else if (current === undefined) merged[key] = value;
  }
  return merged;
}

function lookup(document: unknown, path: KeyPath): { exists: boolean; value?: SettingValue } {
  let current = document;
  for (const segment of path) {
    if (typeof segment === 'object') {
      current = Array.isArray(current) ? current.find(entry => isPlainObject(entry) && entry.id === segment.id) : undefined;
    } else if (isPlainObject(current) || Array.isArray(current)) {
      if (!Object.hasOwn(current, String(segment))) return { exists: false };
      current = (current as Record<string | number, unknown>)[segment as string];
    } else return { exists: false };
    if (current === undefined) return { exists: false };
  }
  if (current === undefined) return { exists: false };
  return { exists: true, value: current as SettingValue };
}

function contextOf(snapshot: CheckSnapshot, settingsContext: CheckContext['settingsContext']): CheckContext {
  const must = <T>(key: CheckSourceKey): T => {
    const observation = sourceOf(snapshot, key);
    if (!observation) throw new MissingSource();
    if (!observation.ok) throw new MissingSource();
    return observation.value as T;
  };
  const view = (id: ReadViewId) => must<ViewSnapshot>(id);
  const files = (ids: readonly ReadViewId[]) => {
    const versions = new Map<string, ViewSnapshot>();
    return ids.reduce<Record<string, unknown>>((document, id) => {
      const current = view(id);
      const target = READ_VIEWS[id].target;
      const previous = versions.get(target);
      if (previous && (previous.present !== current.present || previous.sha256 !== current.sha256
        || (current.present && !current.sha256))) throw new MissingSource();
      versions.set(target, current);
      return merge(document, current.document);
    }, {});
  };
  return {
    settingsContext,
    at: snapshot.at,
    deployment: snapshot.deployment,
    view,
    files,
    value: (id, path) => lookup(files(Array.isArray(id) ? id : [id]), path),
    refusal: key => {
      const observation = sourceOf(snapshot, key);
      return observation && !observation.ok ? { failure: observation.failure, ...(observation.code ? { code: observation.code } : {}) } : undefined;
    },
    supervisor: () => must<SupervisorStatus>('supervisor'),
    gateway: () => must<GatewaySnapshot>('gateway'),
    phone: () => must<PhoneSnapshot>('phone'),
    coderProcesses: () => must<CoderProcess[]>('coderProcesses'),
    drainMarker: () => must<DrainMarkerSnapshot>('drainMarker'),
    directoryRule: () => must<DirectoryRuleSnapshot>('directoryRule'),
    switchFlags: () => must<Record<string, boolean>>('switchFlags'),
    revocations: () => must<AlwaysRevocation[]>('revocations'),
    changes: () => must<ChangeFact[]>('changes'),
    intended: () => must<IntendedKey[]>('intended'),
    hermesStartedAt: () => must<number>('hermesStartedAt'),
    paseoRuntime: () => must<PaseoRuntimeSnapshot>('paseoRuntime'),
    name: (...path) => formatKeyPath(path),
  };
}

/** A Fix only if the pipeline would take it from the server, with exactly these parameters. */
function usableFix(fix: CheckFix | undefined): CheckFix | undefined {
  if (!fix) return undefined;
  if ('operation' in fix) return parseOperation(fix.operation, fix.params, 'server').ok ? fix : undefined;
  if ('restart' in fix) return fix;
  return undefined;
}

function rowFor(check: Check, snapshot: CheckSnapshot, settingsContext: CheckContext['settingsContext']): SettingsCheckRow {
  const missing = (check.requires ?? []).filter(key => !isAvailable(sourceOf(snapshot, key)));
  let input: CheckRowInput;
  if (missing.length) input = { state: 'unknown', sentence: check.unknown };
  else {
    try {
      input = check.run(contextOf(snapshot, settingsContext));
    } catch {
      input = { state: 'unknown', sentence: check.unknown };
    }
  }
  const fix = usableFix(input.fix);
  const parsed = settingsCheckRowSchema.safeParse({
    id: check.id, state: input.state, sentence: input.sentence,
    ...(input.details ? { details: input.details.slice(0, 12) } : {}),
    ...(fix ? { fix } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
  });
  return parsed.success ? parsed.data : { id: check.id, state: 'unknown', sentence: check.unknown };
}

/** Every check, in a stable display order. */
export const CHECKS: readonly Check[] = [
  ...hermesChecks,
  ...hermesRoleChecks,
  ...allowlistChecks,
  ...windowsChecks,
  ...piChecks,
  ...paseoChecks,
  ...gatewayChecks,
  ...fallbacksChecks,
  ...coderMcpChecks,
  ...phoneChecks,
  ...directoriesChecks,
  ...supervisorChecks,
  ...drainMarkerChecks,
];

export const CHECK_IDS: readonly string[] = CHECKS.map(check => check.id);

/** The read views the checks ask for: nothing else is read for a page load. */
export const CHECK_VIEWS: readonly ReadViewId[] = [...new Set(CHECKS
  .flatMap(check => check.requires ?? [])
  .filter((key): key is ReadViewId => isViewKey(key)))];

/** Run every check over one snapshot; high-priority rows first, then this order. */
export function runChecks(snapshot: CheckSnapshot, checks: readonly Check[] = CHECKS,
  settingsContext: CheckContext['settingsContext'] = { scopes: ['settings'] }): SettingsCheckRow[] {
  const rows = checks.map(check => rowFor(check, snapshot, settingsContext));
  return sortCheckRows(rows, checks.map(check => check.id)).slice(0, MAX_CHECK_ROWS);
}
