import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { migrationTargetRecordSchema, recordedValueSchema, type MigrationTargetRecord, type RecordedKey } from '../../shared/gateway.js';
import { configWriteResultSchema } from '../../shared/supervisor-config.js';
import type { KeyPath } from '../../shared/settings.js';
import { valueAt, type SettingValue } from '../../server/src/settings/editors/types.js';
import { resolveKey } from './config-operations.js';
import { ConfigError } from './config-paths.js';

export function checkConfigTransport(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value) + '\n') > 1024 * 1024) throw new ConfigError('invalid_parameters');
}

/** Private unit metadata is consumed by the supervisor and never reaches its audit or callers. */
export const configExecutorWriteResultSchema = z.union([
  configWriteResultSchema.options[0].extend({ record: migrationTargetRecordSchema.optional() }).strict(),
  ...configWriteResultSchema.options.slice(1),
]);
export type ConfigExecutorWriteResult = z.infer<typeof configExecutorWriteResultSchema>;

export function recordedKind(target: string, path: KeyPath): RecordedKey['kind'] {
  if (target === 'pi-models' && isDeepStrictEqual(path, ['providers'])) return 'order';
  if (target === 'pi-settings' && path.length === 1 && ['defaultProvider', 'defaultModel'].includes(String(path[0]))
    || target === 'hermes-config' && path.length === 2 && path[0] === 'model' && ['provider', 'default', 'base_url'].includes(String(path[1]))) return 'model-dependent';
  return 'recorded';
}

export function recordedValue(document: SettingValue, path: KeyPath, kind: RecordedKey['kind']) {
  const found = valueAt(document, resolveKey(path, document));
  if (kind === 'order' && found.exists) {
    if (!found.value || typeof found.value !== 'object' || Array.isArray(found.value)) throw new Error();
    return recordedValueSchema.parse({ exists: true, value: Object.keys(found.value) });
  }
  return recordedValueSchema.parse(found);
}

export function migrationRecord(target: string, paths: KeyPath[], before: SettingValue, after: SettingValue,
  backupSha256: string, writtenSha256: string): MigrationTargetRecord {
  return migrationTargetRecordSchema.parse({ moved: true, preMoveBackupSha256: backupSha256, postMoveSha256: writtenSha256,
    keys: paths.map(path => {
      const kind = recordedKind(target, path);
      return { path, kind, before: recordedValue(before, path, kind), intended: recordedValue(after, path, kind) };
    }) });
}
