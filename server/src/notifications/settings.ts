import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_NOTIFICATION_RULES,
  DEFAULT_QUIET_HOURS,
  notificationQuietHoursSchema,
  notificationRulesSchema,
  settingsNotificationsBodySchema,
  settingValuesEqual,
  settingsErrorCodeSchema,
  type UndoToken as SettingsUndoToken,
  type NotificationQuietHours,
  type NotificationRule,
} from '../../../shared/settings.js';
import {
  SettingsWriteError,
  SettingsCommitError,
  SettingsWriteThrough,
  type SettingsChange,
  type SettingOperation,
  type SettingsCoordinator,
  type SettingValue,
  type UndoToken,
} from '../settings/write-through.js';
import { checkDeviceSignal, deviceSignal } from '../security/device-signal.js';
import { READ_VIEWS, operationKeys, operationKeyNames, parseOperation, readViewKeys } from '../../../shared/settings-ops.js';
import type { ConfigApplyRequest, ConfigReadResult, ConfigUndoRequest, ConfigWriteResult } from '../../../shared/supervisor-config.js';

// Notification rules, quiet hours and the phone's card and approval switches, kept in
// Wayroost's own settings in the server's state folder. Every change goes through the
// write-through core, which backs the file up, writes it atomically and audits the change.
// A file that can't be read or understood routes alerts as the defaults would and is never
// replaced by one of these writes.

export const WAYROOST_SETTINGS_FILE = 'wayroost-settings.json';
/** Backup and audit storage, kept apart from each other and from the file they describe. */
export const WAYROOST_SETTINGS_BACKUPS = 'settings-backups';
export const WAYROOST_SETTINGS_AUDIT_DIR = 'settings-audit';

const FILE_MODE = 0o600;
const MAX_SETTINGS_BYTES = 128 * 1024;

export interface NotificationSettings {
  rules: NotificationRule[];
  quietHours: NotificationQuietHours | null;
  push: { approvals: boolean; cards: boolean };
}

/** What a change came from, for the audit: a device id and the level it was allowed at. */
export interface ChangeContext {
  device?: string;
  level?: string;
}

/** The three keys a change may name; what isn't named stays as it is. */
export interface NotificationSettingsInput {
  rules?: readonly NotificationRule[];
  quietHours?: NotificationQuietHours | null;
  push?: NotificationSettings['push'];
}

interface WayroostSettingsInput extends NotificationSettingsInput {
  safetyCommandsEnabled?: boolean;
}

export interface NotificationSettingsChange {
  settings: NotificationSettings;
  /** Nothing was written, because the file already said exactly this. */
  changed: boolean;
  undo?: UndoToken;
}

const DEFAULT_SETTINGS: NotificationSettings = {
  rules: DEFAULT_NOTIFICATION_RULES.map((rule) => ({ ...rule })),
  quietHours: { ...DEFAULT_QUIET_HOURS },
  push: { approvals: true, cards: false },
};

const clone = (settings: NotificationSettings): NotificationSettings => ({
  rules: settings.rules.map((rule) => ({ ...rule })),
  quietHours: settings.quietHours ? { ...settings.quietHours } : null,
  push: { ...settings.push },
});

const render = (settings: NotificationSettings): string =>
  `${JSON.stringify({ rules: settings.rules, quietHours: settings.quietHours, push: settings.push }, null, 2)}\n`;

/** Defaults fill in what an older or partial file doesn't say; anything malformed is refused. */
function readSettings(text: string): NotificationSettings {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid settings document.');
  const { safetyCommandsEnabled, ...notifications } = parsed as Record<string, unknown>;
  if (safetyCommandsEnabled !== undefined) z.boolean().parse(safetyCommandsEnabled);
  const body = settingsNotificationsBodySchema.parse({ ...clone(DEFAULT_SETTINGS), ...notifications });
  return { rules: body.rules, quietHours: body.quietHours, push: body.push };
}

function parsedInput(input: NotificationSettingsInput): NotificationSettingsInput {
  return {
    ...(input.rules !== undefined ? { rules: notificationRulesSchema.parse(input.rules) } : {}),
    ...(input.quietHours !== undefined
      ? { quietHours: input.quietHours === null ? null : notificationQuietHoursSchema.parse(input.quietHours) }
      : {}),
    ...(input.push !== undefined ? { push: settingsNotificationsBodySchema.shape.push.parse(input.push) } : {}),
  };
}

export class NotificationSettingsStore {
  readonly path: string;
  private readonly backups: string;
  private readonly auditFile: string;
  private readonly core: SettingsWriteThrough;
  /**
   * The core takes this file's lock inside a change, so a second caller has to wait for the
   * first one to finish rather than find the lock held: one change at a time, read and written
   * as one. Nothing else writes these keys.
   */
  private tail: Promise<unknown> = Promise.resolve();
  private initialSettings: NotificationSettings | undefined;
  private readonly coordinate: SettingsCoordinator = (_target, operation) => operation();

  constructor(readonly stateDir: string) {
    this.path = join(stateDir, WAYROOST_SETTINGS_FILE);
    this.backups = join(stateDir, WAYROOST_SETTINGS_BACKUPS);
    this.auditFile = join(stateDir, WAYROOST_SETTINGS_AUDIT_DIR, 'settings.jsonl');
    this.core = new SettingsWriteThrough({ backupDir: this.backups, auditFile: this.auditFile, coordinate: this.coordinate });
  }

  /** The rules and quiet hours as written; a file that can't be read or understood reads as the defaults. */
  settings(): NotificationSettings {
    try {
      return this.#read()?.settings ?? clone(this.initialSettings ?? DEFAULT_SETTINGS);
    } catch {
      return clone(DEFAULT_SETTINGS);
    }
  }

  /** The settings pipeline reads the same checked bytes that live alert routing reads. */
  configRead(): ConfigReadResult {
    try {
      const stored = this.#read();
      return { ok: true, view: 'wayroost.settings', present: !!stored, ...(stored ? { sha256: stored.hash } : {}),
        values: stored ? readViewKeys(READ_VIEWS['wayroost.settings'], stored.document).map(path => {
          let value: unknown = stored.document;
          for (const segment of path) value = value && typeof value === 'object' && typeof segment !== 'object'
            ? (value as Record<string | number, unknown>)[segment] : undefined;
          return { path: [...path], exists: value !== undefined, ...(value !== undefined ? { value: value as SettingValue } : {}) };
        }) : [] };
    } catch (error) { return { ok: false, code: this.errorCode(error) }; }
  }

  async configApply(request: ConfigApplyRequest): Promise<ConfigWriteResult> {
    const signal = deviceSignal();
    return this.#one(async () => {
      checkDeviceSignal(signal);
      try {
        const operation = parseOperation(request.operation, request.params, 'server');
        if (!operation.ok) return { ok: false, code: operation.code };
        if (operation.spec.target !== 'wayroost-settings') return { ok: false, code: 'unknown_operation' };
        const stored = this.#read();
        const paths = operationKeys(operation.spec, operation.params, stored?.document ?? {});
        if (paths === 'recorded') return { ok: false, code: 'invalid_parameters' };
        const preconditions = request.preconditions;
        if (preconditions && ('file' in preconditions ? preconditions.file.sha256 !== stored?.hash
          : preconditions.keys.some(entry => {
            const path = paths[entry.key];
            if (!path) return true;
            const value = stored?.document[String(path[0])];
            return 'exists' in entry ? (value !== undefined) !== entry.exists : !settingValuesEqual(value as SettingValue | undefined, entry.value);
          }))) return { ok: false, code: 'precondition_changed' };
        const input = request.operation === 'wayroost.safety-commands'
          ? { safetyCommandsEnabled: operation.params.enabled as boolean } : operation.params as NotificationSettingsInput;
        const changed = await this.#change(input, { device: request.origin?.device?.id, level: request.origin?.level }, signal, stored?.hash ?? null);
        const keys = await operationKeyNames(operation.spec, operation.params) as string[];
        if (changed.undo) return this.writeResult(request.operation, changed.undo, keys);
        const sha256 = stored?.hash ?? createHash('sha256').update('').digest('hex');
        const undo: SettingsUndoToken = { operation: request.operation, target: 'wayroost-settings', backupId: 'unchanged',
          backupSha256: sha256, writtenSha256: sha256 };
        return { ok: true, ...undo, keys, undo, unchanged: true };
      } catch (error) {
        checkDeviceSignal(signal);
        return this.writeError(request.operation, error);
      }
    });
  }

  async configUndo(request: ConfigUndoRequest): Promise<ConfigWriteResult> {
    const signal = deviceSignal();
    return this.#one(async () => {
      checkDeviceSignal(signal);
      try {
        const stored = this.#read();
        if (!stored) return { ok: false, code: 'target_missing' };
        const token = request.token;
        if (token.target !== 'wayroost-settings'
          || !['wayroost.notifications', 'wayroost.safety-commands'].includes(token.operation)) return { ok: false, code: 'invalid_parameters' };
        const reverse = await this.core.undoWithToken({ target: this.path, editor: 'json', expected: stored.expected, timing: 'now',
          backupId: token.backupId, backupHash: token.backupSha256, writtenHash: token.writtenSha256,
          device: request.origin?.device?.id, level: request.origin?.level }, () => checkDeviceSignal(signal));
        return this.writeResult(token.operation, reverse, []);
      } catch (error) {
        checkDeviceSignal(signal);
        return this.writeError(request.token.operation, error);
      }
    });
  }

  private writeResult(operation: string, token: UndoToken, keys: string[]): Extract<ConfigWriteResult, { ok: true; undo: SettingsUndoToken }> {
    const undo: SettingsUndoToken = { operation, target: 'wayroost-settings', backupId: token.backupId,
      backupSha256: token.backupHash, writtenSha256: token.writtenHash };
    return { ok: true, ...undo, keys, undo };
  }

  private errorCode(error: unknown) {
    const code = error instanceof SettingsWriteError ? error.code : 'failed';
    const mapped: Record<string, string> = { missing_target: 'target_missing', symlink_target: 'unsafe_target',
      not_regular: 'unsafe_target', metadata_mismatch: 'unsafe_target', unsafe_storage: 'unsafe_directory',
      changed_underneath: 'precondition_changed', precondition_failed: 'precondition_changed', invalid_backup: 'backup_mismatch',
      audit_failed: 'audit_unavailable', unsafe_audit: 'audit_unavailable', verification_failed: 'verify_mismatch',
      invalid_id: 'invalid_parameters' };
    const parsed = settingsErrorCodeSchema.safeParse(mapped[code] ?? code);
    return parsed.success ? parsed.data : 'failed' as const;
  }

  private writeError(operation: string, error: unknown): ConfigWriteResult {
    const code = this.errorCode(error);
    if (error instanceof SettingsCommitError) return { ok: false, code, committed: true,
      undo: this.writeResult(operation, error.recovery.undoToken, []).undo };
    return { ok: false, code };
  }

  async change(input: NotificationSettingsInput, context: ChangeContext = {}): Promise<NotificationSettingsChange> {
    const signal = deviceSignal();
    const wanted = parsedInput(input);
    return this.#one(() => {
      checkDeviceSignal(signal);
      return this.#change(wanted, context, signal);
    });
  }

  /** Seed an upgrade from the existing feed preferences only when no settings file exists. */
  async initialize(routing: Pick<NotificationSettings, 'quietHours' | 'push'>): Promise<void> {
    await this.#one(async () => {
      if (this.#read()) return;
      const wanted = parsedInput(routing);
      this.initialSettings = { ...clone(DEFAULT_SETTINGS), quietHours: wanted.quietHours!, push: wanted.push! };
      await this.#change(routing, {});
    });
  }

  /** Put the bytes back that a change replaced; the core refuses it if anything else changed since. */
  async undo(token: UndoToken): Promise<void> {
    const signal = deviceSignal();
    await this.#one(async () => {
      checkDeviceSignal(signal);
      try { await this.core.undo(token, () => checkDeviceSignal(signal)); }
      catch (err) { checkDeviceSignal(signal); throw err; }
    });
  }

  async #change(input: WayroostSettingsInput, context: ChangeContext, signal?: AbortSignal, expectedHash?: string | null): Promise<NotificationSettingsChange> {
    checkDeviceSignal(signal);
    const wanted = parsedInput(input);
    const stored = this.#read();
    if (expectedHash !== undefined && (stored?.hash ?? null) !== expectedHash) {
      throw new SettingsWriteError('precondition_failed', 'Settings changed since the request was authorized.');
    }
    const current = stored?.settings ?? clone(this.initialSettings ?? DEFAULT_SETTINGS);
    const settings: NotificationSettings = {
      rules: wanted.rules ? wanted.rules.map((rule) => ({ ...rule })) : current.rules,
      quietHours: wanted.quietHours === undefined ? current.quietHours : wanted.quietHours,
      push: wanted.push ?? current.push,
    };
    const operations: SettingOperation[] = (['rules', 'quietHours', 'push'] as const)
      .filter((key) => wanted[key] !== undefined && (!stored || JSON.stringify(wanted[key]) !== JSON.stringify(current[key])))
      .map((key) => ({ type: 'set' as const, path: [key], value: wanted[key] as unknown as SettingValue }));
    if (input.safetyCommandsEnabled !== undefined && stored?.document.safetyCommandsEnabled !== input.safetyCommandsEnabled) {
      operations.push({ type: 'set', path: ['safetyCommandsEnabled'], value: z.boolean().parse(input.safetyCommandsEnabled) });
    }
    if (!operations.length) return { settings, changed: false };
    const seed = stored ? undefined : this.#create(current);
    if (!stored && !seed) throw new SettingsWriteError('precondition_failed', 'Settings appeared while the initial document was prepared.');
    let undo: UndoToken;
    try {
      const snapshot = stored ?? this.#read()!;
      const change: SettingsChange = {
        target: this.path,
        editor: 'json',
        operations,
        timing: 'now',
        expected: snapshot.expected,
        version: { hash: snapshot.hash },
        ...(context.device ? { device: context.device } : {}),
        ...(context.level ? { level: context.level } : {}),
      };
      undo = await this.core.apply(change, () => checkDeviceSignal(signal));
    } catch (err) {
      if (seed) {
        const currentFile = lstatSync(this.path, { bigint: true, throwIfNoEntry: false });
        if (currentFile && currentFile.dev === seed.dev && currentFile.ino === seed.ino
          && currentFile.size === seed.size && currentFile.mtimeNs === seed.mtimeNs && currentFile.ctimeNs === seed.ctimeNs) {
          unlinkSync(this.path);
        }
      }
      checkDeviceSignal(signal);
      throw err;
    }
    return { settings, changed: true, undo };
  }

  #one<T>(run: () => Promise<T>): Promise<T> {
    const settled = this.tail.then(run, run);
    this.tail = settled.then(
      () => undefined,
      () => undefined,
    );
    return settled;
  }

  /** The file exists before anything reads it: the core writes into a file it can check, never creates one. */
  #create(settings: NotificationSettings): BigIntStats | undefined {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let file: number | undefined;
    try {
      file = openSync(temporary, 'wx', FILE_MODE);
      writeFileSync(file, render(settings));
      fsyncSync(file);
      linkSync(temporary, this.path);
      unlinkSync(temporary);
      return fstatSync(file, { bigint: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return undefined;
    } finally {
      if (file !== undefined) {
        closeSync(file);
        try { unlinkSync(temporary); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
      }
    }
  }

  #read(): { settings: NotificationSettings; document: Record<string, unknown>; expected: { uid: number; gid: number; mode: number }; hash: string } | undefined {
    let file: number | undefined;
    try {
      file = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = fstatSync(file, { bigint: true });
      const mode = Number(before.mode & 0o7777n);
      if (!before.isFile() || before.nlink !== 1n || Number(before.uid) !== process.getuid?.() || (mode & 0o7027) !== 0) {
        throw new SettingsWriteError('unsafe_target', 'Wayroost settings require a regular file with trusted ownership and permissions.');
      }
      if (before.size > BigInt(MAX_SETTINGS_BYTES)) throw new SettingsWriteError('unsafe_target', 'Wayroost settings are too large.');
      const bytes = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = readSync(file, bytes, length, bytes.length - length, null);
        if (!read) break;
        length += read;
      }
      const after = fstatSync(file, { bigint: true });
      const current = lstatSync(this.path, { bigint: true });
      if (length > MAX_SETTINGS_BYTES || [after, current].some((stat) =>
        stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs)) {
        throw new SettingsWriteError('changed_underneath', 'Wayroost settings changed while being read.');
      }
      const content = bytes.subarray(0, length);
      if (!isUtf8(content)) throw new Error('Invalid UTF-8.');
      return {
        settings: readSettings(content.toString('utf8')),
        document: JSON.parse(content.toString('utf8')) as Record<string, unknown>,
        expected: { uid: Number(before.uid), gid: Number(before.gid), mode },
        hash: createHash('sha256').update(content).digest('hex'),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && file === undefined) return undefined;
      if (err instanceof SettingsWriteError) throw err;
      throw new SettingsWriteError('parse_failed', 'Wayroost settings could not be safely read or validated.');
    } finally {
      if (file !== undefined) closeSync(file);
    }
  }
}
