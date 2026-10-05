// Shared bits every check needs: a key's name for a details line, the hash a
// revoked "always" entry is recorded by, and the migration record read out of the
// gateway-state view. Records hold key paths and values; a check compares them and
// quotes only their names.
import { createHash } from 'node:crypto';
import { migrationTargetRecordSchema, GATEWAY_ROLES, ROLE_PROVIDERS, type MigrationTargetRecord } from '../../../shared/gateway.js';
import { OPERATION_IDS, operationSpec, HERMES_HELPER_TASKS, type KeyTemplate } from '../../../shared/settings-ops.js';
import { formatKeyPath, keyPathSchema, redactedSettingValueSchema, settingComparisonJson, type KeyPath, type SettingValue } from '../../../shared/settings.js';

/** The same digest the revoke operation carries: the entry's UTF-8 text, hashed. */
export const entryHash = (entry: string): string => createHash('sha256').update(entry, 'utf8').digest('hex');
export const comparisonHash = (value: SettingValue): string => createHash('sha256').update(settingComparisonJson(value), 'utf8').digest('hex');
/** A recorded comparison uses the same canonical digest as a private read value. */
export function comparisonHeld(held: { exists: boolean; value?: SettingValue }): { exists: boolean; value?: SettingValue } {
  if (!held.exists) return { exists: false };
  const parsed = redactedSettingValueSchema.safeParse(held.value);
  if (parsed.success) return { exists: true, value: parsed.data };
  const source = settingComparisonJson(held.value ?? null);
  return { exists: true, value: { sha256: createHash('sha256').update(source, 'utf8').digest('hex'), length: Buffer.byteLength(source) } };
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** One consumer's record for one file, from the gateway-state view's document. */
export function consumerRecord(state: Record<string, unknown>, consumer: string, target: string): MigrationTargetRecord | undefined {
  const migration = state.migration;
  if (!isRecord(migration) || !isRecord(migration.consumers)) return undefined;
  const byTarget = isRecord(migration.consumers[consumer]) ? migration.consumers[consumer] : undefined;
  if (!byTarget) return undefined;
  const parsed = migrationTargetRecordSchema.safeParse(byTarget[target]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Whether a target is recorded as moved, read from the document itself, and how many
 * keys that record holds. A record with no keys at all still says the file moved, so
 * this is how a check sees a move nothing can plan a way back from.
 */
export function movedKeyCount(state: Record<string, unknown>, consumer: string, target: string): number | undefined {
  const migration = isRecord(state.migration) ? state.migration : undefined;
  const consumers = migration && isRecord(migration.consumers) ? migration.consumers : undefined;
  const byTarget = consumers && isRecord(consumers[consumer]) ? consumers[consumer] : undefined;
  const record = byTarget && isRecord(byTarget[target]) ? byTarget[target] : undefined;
  if (!record || record.moved !== true) return undefined;
  return Array.isArray(record.keys) ? record.keys.length : 0;
}

/** Every recorded key's path, as the target file's own key path. */
export function recordedKeys(record: MigrationTargetRecord | undefined): { path: KeyPath; kind: string;
  before: { exists: boolean; value?: SettingValue }; intended: { exists: boolean; value?: SettingValue } }[] {
  if (!record) return [];
  return record.keys.flatMap(key => keyPathSchema.safeParse(key.path).success
    ? [{ path: keyPathSchema.parse(key.path) as KeyPath, kind: key.kind, before: key.before, intended: key.intended }] : []);
}

/** The role providers and role model names, so a check can name what a value should be. */
export const ROLE_MODEL_NAMES: readonly string[] = GATEWAY_ROLES;
export const isRoleProvider = (value: unknown): boolean => typeof value === 'string'
  && (Object.values(ROLE_PROVIDERS) as string[]).includes(value);
export const isRoleModel = (value: unknown): boolean => typeof value === 'string' && (ROLE_MODEL_NAMES as string[]).includes(value);

/** Whether a managed key can override a catalogue write, including validated parameter identities. */
export function hermesWritesPath(path: KeyPath): boolean {
  return OPERATION_IDS.some(id => {
    const spec = operationSpec(id)!;
    if (spec.target !== 'hermes-config' || spec.keys === 'recorded') return false;
    return (spec.keys as readonly KeyTemplate[]).some(template =>
      template.slice(0, Math.min(template.length, path.length)).every((segment, index) => {
        if (typeof segment === 'string') return segment === '*' || segment === path[index];
        if ('param' in segment) return segment.param === 'task'
          && (HERMES_HELPER_TASKS as readonly unknown[]).includes(path[index]);
        return false;
      }));
  });
}

/** A key's name for a details line. */
export const keyName = (path: KeyPath): string => formatKeyPath(path);
export const keyNameOf = (...path: KeyPath): string => formatKeyPath(path);

/** The executable script, excluding interpreter options and later application arguments. */
export function scriptArgument(argv: readonly string[]): string | undefined {
  const command = argv[0];
  if (!command) return undefined;
  if (command.startsWith('/') && command.endsWith('.py')) return command;
  // Only an interpreter runs the script it names; other commands (a pager, an editor) merely read it.
  if (!/(?:^|\/)python(?:[0-9]+(?:\.[0-9]+)*)?$/.test(command)) return undefined;
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '-c' || arg === '-m') return undefined;
    if (arg === '-W' || arg === '-X') { index++; continue; }
    if (arg === '--') return argv[index + 1];
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return undefined;
}
