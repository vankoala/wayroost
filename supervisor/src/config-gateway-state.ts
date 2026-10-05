import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { GATEWAY_STATE_FILES, gatewayStateSchema, gatewayMigrationSchema, type GatewayState, type MigrationTargetRecord,
  GATEWAY_ROLES, type GatewayConsumer, type MigrationTarget, type GatewayRole, type GatewayMigration } from '../../shared/gateway.js';
import { READ_VIEWS, parseOperation, readViewKeys } from '../../shared/settings-ops.js';
import type { SettingsTargets } from '../../shared/settings-targets.js';
import { checkConfigDirectory, ConfigError, digest, readConfigFile } from './config-paths.js';
import { trustedExecutable } from './trust.js';

export type GatewayStateLock = <T>(path: string, uid: number, work: () => Promise<T>) => Promise<T>;
const backupIdPattern = /^[a-f0-9]{64}\/\d{16}-[a-f0-9]{64}-[a-f0-9-]{36}\.bak$/;
export interface MigrationUpdate {
  consumer: GatewayConsumer;
  target: MigrationTarget;
  change: 'move' | 'intended' | 'restore';
  record: MigrationTargetRecord;
}

function stateSource(value: unknown): string {
  const source = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(source) > 4 * 1024 * 1024) throw new ConfigError('invalid_parameters');
  return source;
}

/** Leave room for all role overrides in the aggregate reconciliation view. */
function checkMigrationRead(migration: GatewayMigration): void {
  try {
    readViewKeys(READ_VIEWS['gateway.state'], { state: { overrides: Object.fromEntries(GATEWAY_ROLES.map(role => [role, {}])) }, migration });
  } catch { throw new ConfigError('invalid_parameters'); }
}

function nextMigration(migration: GatewayMigration, updates: readonly MigrationUpdate[]): GatewayMigration {
  const next = structuredClone(migration);
  for (const { record, ...params } of updates) {
    const parsed = parseOperation('gateway.record-migration', params, 'supervisor');
    if (!parsed.ok) throw new ConfigError(parsed.code);
    const existing = (next.consumers[params.consumer] as Partial<Record<MigrationTarget, MigrationTargetRecord>> | undefined)?.[params.target];
    if (params.change === 'intended' && !existing?.moved) continue;
    const saved = existing?.moved ? { ...existing, postMoveSha256: record.postMoveSha256, keys: [...existing.keys] } : structuredClone(record);
    for (const key of record.keys) {
      const old = saved.keys.find(entry => isDeepStrictEqual(entry.path, key.path));
      if (old) old.intended = key.intended;
      else if (params.change === 'move') saved.keys.push(key);
    }
    if (params.change === 'move') { saved.moved = true; saved.movedAt ??= new Date().toISOString(); }
    if (params.change === 'restore') { saved.moved = false; saved.restoredAt = new Date().toISOString(); }
    Object.assign(next.consumers, { [params.consumer]: { ...next.consumers[params.consumer], [params.target]: saved } });
  }
  const parsed = gatewayMigrationSchema.safeParse(next);
  if (!parsed.success) throw new ConfigError('invalid_parameters');
  return parsed.data;
}

export const withGatewayStateLock: GatewayStateLock = async (path, uid, work) => {
  await checkConfigDirectory(path, uid);
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600) throw new ConfigError('unsafe_target');
    const command = await trustedExecutable('/usr/bin/flock');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, ['--exclusive', '--timeout', '4', '3'], { shell: false, stdio: ['ignore', 'ignore', 'ignore', file.fd] });
      child.once('error', () => reject(new ConfigError('locked')));
      child.once('exit', code => code === 0 ? resolve() : reject(new ConfigError('locked')));
    });
    return await work();
  } finally { await file.close(); }
};

/** Only the supervisor writes these files; owner units receive just their one migration record. */
export class GatewayConfigState {
  private readonly target;
  constructor(site: SettingsTargets, private readonly uid = 0, private readonly lock: GatewayStateLock = withGatewayStateLock) {
    const target = site.targets['gateway-state'];
    if (!target) throw new ConfigError('not_configured');
    this.target = target;
  }
  async withLock<T>(work: () => Promise<T>): Promise<T> {
    for (const path of [this.target.directory, this.target.backupDir]) {
      await checkConfigDirectory(path, this.uid, true);
      await mkdir(path, { recursive: true, mode: 0o700 });
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.uid !== this.uid || (stat.mode & 0o7777) !== 0o700) throw new ConfigError('unsafe_directory');
    }
    return this.lock(join(this.target.directory, GATEWAY_STATE_FILES.lock), this.uid, work);
  }
  private async read<T>(name: string, schema: z.ZodType<T>, initial: T): Promise<{ value: T; sha256?: string }> {
    try {
      await checkConfigDirectory(this.target.directory, this.uid, true);
      const directory = await lstat(this.target.directory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ConfigError('target_missing');
        throw error;
      });
      if (!directory.isDirectory() || directory.uid !== this.uid || (directory.mode & 0o7777) !== 0o700) throw new ConfigError('unsafe_directory');
      const snapshot = await readConfigFile(join(this.target.directory, name), this.uid, 0o600);
      return { value: schema.parse(JSON.parse(snapshot.source)), sha256: snapshot.sha256 };
    } catch (error) {
      if (error instanceof ConfigError && error.code === 'target_missing') return { value: initial };
      throw new ConfigError('verify_mismatch');
    }
  }
  async state(): Promise<GatewayState> {
    return (await this.read(GATEWAY_STATE_FILES.state, gatewayStateSchema,
      { version: 1, profile: null, engine: null, broughtUpAt: null, overrides: {} })).value;
  }
  async migration() {
    return (await this.read(GATEWAY_STATE_FILES.migration, gatewayMigrationSchema, { version: 1, consumers: {} })).value;
  }
  async snapshot() {
    const state = await this.read(GATEWAY_STATE_FILES.state, gatewayStateSchema,
      { version: 1, profile: null, engine: null, broughtUpAt: null, overrides: {} });
    const migration = await this.read(GATEWAY_STATE_FILES.migration, gatewayMigrationSchema, { version: 1, consumers: {} });
    return { present: state.sha256 !== undefined || migration.sha256 !== undefined,
      sha256: digest(JSON.stringify([state.sha256 ?? null, migration.sha256 ?? null])), document: { state: state.value, migration: migration.value } };
  }
  async record(consumer: GatewayConsumer, target: MigrationTarget): Promise<MigrationTargetRecord | undefined> {
    const records = (await this.migration()).consumers[consumer];
    return records && Object.hasOwn(records, target) ? (records as Partial<Record<MigrationTarget, MigrationTargetRecord>>)[target] : undefined;
  }
  private async publish(name: string, value: unknown, previous?: string): Promise<void> {
    const path = join(this.target.directory, name);
    const source = stateSource(value);
    const temporary = join(this.target.directory, `.gateway-${randomUUID()}`);
    try {
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(source); await file.chmod(0o600); await file.sync(); } finally { await file.close(); }
      let current: string | undefined;
      try { current = (await readConfigFile(path, this.uid, 0o600)).sha256; }
      catch (error) { if (!(error instanceof ConfigError && error.code === 'target_missing')) throw error; }
      if (current !== previous) throw new ConfigError('precondition_changed');
      await rename(temporary, path);
      const directory = await open(this.target.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
      if ((await readConfigFile(path, this.uid, 0o600)).sha256 !== digest(source)) throw new ConfigError('verify_mismatch');
    } catch { throw new ConfigError('verify_mismatch'); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async recordOverride(params: { role: GatewayRole; backend: string | null }, verified: boolean,
    override?: GatewayState['overrides'][GatewayRole]): Promise<void> {
    const parsed = parseOperation('gateway.record-override', params, 'supervisor');
    if (!parsed.ok) throw new ConfigError(parsed.code);
    if (!verified) throw new ConfigError('verify_mismatch');
    if (override && override.backend !== params.backend) throw new ConfigError('invalid_parameters');
    const snapshot = await this.read(GATEWAY_STATE_FILES.state, gatewayStateSchema,
      { version: 1, profile: null, engine: null, broughtUpAt: null, overrides: {} });
    const next = structuredClone(snapshot.value);
    if (params.backend === null) delete next.overrides[params.role];
    else next.overrides[params.role] = override ?? { backend: params.backend, at: new Date().toISOString(), by: 'wayroost' };
    await this.publish(GATEWAY_STATE_FILES.state, gatewayStateSchema.parse(next), snapshot.sha256);
  }
  async recordMigration(params: { consumer: GatewayConsumer; target: MigrationTarget; change: 'move' | 'intended' | 'restore' },
    record: MigrationTargetRecord, verified: boolean): Promise<void> {
    const parsed = parseOperation('gateway.record-migration', params, 'supervisor');
    if (!parsed.ok) throw new ConfigError(parsed.code);
    if (!verified) throw new ConfigError('verify_mismatch');
    const snapshot = await this.read(GATEWAY_STATE_FILES.migration, gatewayMigrationSchema, { version: 1, consumers: {} });
    const next = nextMigration(snapshot.value, [{ ...params, record }]);
    if (isDeepStrictEqual(next, snapshot.value)) return;
    checkMigrationRead(next);
    await this.publish(GATEWAY_STATE_FILES.migration, next, snapshot.sha256);
  }
  /** Check every prospective record together before any consumer is changed. */
  async validateMigration(updates: readonly MigrationUpdate[], check?: (migration: GatewayMigration) => Promise<void>): Promise<void> {
    let next = await this.migration();
    for (const update of updates) {
      next = nextMigration(next, [update]);
      stateSource(next);
      checkMigrationRead(next);
      await check?.(next);
    }
  }
  async backup(id: string, source: string): Promise<void> {
    if (!backupIdPattern.test(id)) throw new ConfigError('invalid_parameters');
    const folder = join(this.target.backupDir, id.split('/')[0]!);
    await checkConfigDirectory(folder, this.uid, true); await mkdir(folder, { recursive: true, mode: 0o700 });
    const stat = await lstat(folder);
    if (!stat.isDirectory() || stat.uid !== this.uid || (stat.mode & 0o7777) !== 0o700) throw new ConfigError('unsafe_directory');
    const file = await open(join(this.target.backupDir, id), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(source); await file.chmod(0o600); await file.sync(); } finally { await file.close(); }
    for (const path of [folder, this.target.backupDir]) {
      const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  async readBackup(id: string): Promise<string> {
    if (!backupIdPattern.test(id)) throw new ConfigError('backup_mismatch');
    return (await readConfigFile(join(this.target.backupDir, id), this.uid, 0o600)).source;
  }
  /** Called under the state lock after verification; uncertain requests keep their backups pinned. */
  async expireBackups(protectedId: string, recoveryIds: readonly string[]): Promise<void> {
    if (!backupIdPattern.test(protectedId)) throw new ConfigError('backup_mismatch');
    const prefix = protectedId.split('/')[0]!;
    const folder = join(this.target.backupDir, prefix);
    await checkConfigDirectory(folder, this.uid, true);
    const stat = await lstat(folder);
    if (!stat.isDirectory() || stat.uid !== this.uid || (stat.mode & 0o7777) !== 0o700) throw new ConfigError('unsafe_directory');
    const pinned = new Set([protectedId, ...recoveryIds]);
    const oldest = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let completed = 1;
    let changed = false;
    for (const name of (await readdir(folder)).sort().reverse()) {
      const id = `${prefix}/${name}`;
      if (!backupIdPattern.test(id) || name === basename(protectedId) || pinned.has(id)) continue;
      const path = join(folder, name);
      const file = await lstat(path);
      if (!file.isFile() || file.isSymbolicLink() || file.uid !== this.uid || file.nlink !== 1 || (file.mode & 0o7777) !== 0o600) throw new ConfigError('backup_mismatch');
      if (++completed <= 10 && Number(name.slice(0, 16)) >= oldest) continue;
      await unlink(path); changed = true;
    }
    if (changed) {
      const directory = await open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
}
