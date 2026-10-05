import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual, types } from 'node:util';
import { jsonEditor } from './editors/json.js';
import { yamlEditor } from './editors/yaml.js';
import { applyValues, checkPreconditions, invalidOperation, SettingsWriteError, validatePath, validateValue,
  type FormatEditor, type SettingOperation, type ValuePrecondition } from './editors/types.js';

export { SettingsWriteError } from './editors/types.js';
export type { SettingOperation, SettingPath, SettingValue, ValuePrecondition } from './editors/types.js';
export type EditorKind = 'json' | 'yaml';
export type TimingLabel = 'now' | 'next-turn' | 'next-chat' | 'next-run'
  | `restart-when-idle:${string}` | `restart-now:${string}` | `restart:${string}`;
export interface ExpectedFile { uid: number; gid: number; mode: number }
/** Only content guards a version; mtime is optional metadata for callers. */
export interface FileVersion { hash: string; mtimeNs?: string }
export interface SettingsChange {
  target: string;
  editor: EditorKind;
  operations: readonly SettingOperation[];
  timing: TimingLabel;
  expected: ExpectedFile;
  version?: FileVersion;
  preconditions?: readonly ValuePrecondition[];
  device?: string;
  level?: string;
}
export interface UndoToken {
  target: string;
  editor: EditorKind;
  backupId: string;
  backupHash: string;
  writtenHash: string;
  expected: ExpectedFile;
  timing: TimingLabel;
  device?: string;
  level?: string;
}
/** Suspend all independent target writers until the callback, including its audit, settles. */
export type SettingsCoordinator = <T>(target: string, operation: () => Promise<T>) => Promise<T>;
export interface WriteThroughOptions {
  /** Private backup storage, separate from the audit directory and shared by writers using the same audit. */
  backupDir: string;
  /** Audit file in a private directory outside backup storage. */
  auditFile: string;
  keepBackups?: number;
  coordinate: SettingsCoordinator;
}
export interface RecoveryInfo { id: string; action: 'apply' | 'undo'; undoToken: UndoToken }
export class SettingsCommitError extends SettingsWriteError {
  readonly committed = true;
  constructor(error: SettingsWriteError, readonly recovery: RecoveryInfo) {
    super(error.code, `${error.message} The replacement committed; recovery information is available.`);
    this.name = 'SettingsCommitError';
  }
}
interface CommitState { committed: boolean; backupId?: string; recovery?: RecoveryInfo }
interface Snapshot { bytes: Buffer; hash: string; stat: BigIntStats }
interface AuditRecord {
  timestamp: string;
  action: 'apply' | 'undo';
  target: string;
  operations: unknown[];
  backupId: string | null;
  timing: TimingLabel;
  result: 'success' | 'failure';
  error?: string;
  beforeHash?: string;
  afterHash?: string;
  device?: string;
  level?: string;
}

const editors: Record<EditorKind, FormatEditor> = { json: jsonEditor, yaml: yamlEditor };
const backupFilename = String.raw`\d{16}-[a-f0-9]{64}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.bak`;
const backupName = new RegExp(`^${backupFilename}(?![\\s\\S])`);
const targetPath = String.raw`/(?:\.?[A-Za-z0-9_ -][A-Za-z0-9_. -]*/)*\.?[A-Za-z0-9_ -][A-Za-z0-9_. -]*`;
const identifier = new RegExp(`^(?:target:${targetPath}|backup:[a-f0-9]{64}/${backupFilename}`
  + `|hash:[a-f0-9]{64}|mtime:[0-9]{1,30})(?![\\s\\S])`);
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const mode = (stat: BigIntStats) => Number(stat.mode & 0o7777n);
const failure = (code: string, message: string): never => { throw new SettingsWriteError(code, message); };

/** The advisory lock lives beside its target as <file>.wayroost-settings.lock. */
export function settingsLockPath(target: string): string { return `${target}.wayroost-settings.lock`; }
export { withLock as withSettingsFileLock };

function validIdentifier(kind: 'target' | 'backup' | 'hash' | 'mtime', value: unknown): value is string {
  return typeof value === 'string' && identifier.test(`${kind}:${value}`);
}

function captureRequest<T>(input: T): { value?: T; target?: string } {
  if (!input || typeof input !== 'object' || types.isProxy(input)) return {};
  const descriptor = Object.getOwnPropertyDescriptor(input, 'target');
  const target = descriptor && 'value' in descriptor && validIdentifier('target', descriptor.value) ? descriptor.value : undefined;
  const seen = new Set<object>();
  const check = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (types.isProxy(value) || types.isMap(value) || types.isSet(value) || types.isDate(value) || types.isRegExp(value)
      || types.isAnyArrayBuffer(value) || types.isArrayBufferView(value) || types.isBoxedPrimitive(value) || types.isNativeError(value)) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error();
    if (seen.has(value)) return;
    seen.add(value);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!('value' in descriptor)) throw new Error();
      check(descriptor.value);
    }
  };
  try { check(input); return { value: structuredClone(input), target }; }
  catch { return { target }; }
}

function validIdentifiers(input: SettingsChange | UndoToken, action: 'apply' | 'undo'): boolean {
  if (!input || typeof input !== 'object' || !validIdentifier('target', input.target)) return false;
  if (action === 'undo') {
    const token = input as UndoToken;
    return validIdentifier('backup', token.backupId) && validIdentifier('hash', token.backupHash)
      && validIdentifier('hash', token.writtenHash) && token.backupId.split('/')[0] === hash(token.target);
  }
  const version = (input as SettingsChange).version;
  return version === undefined || !!version && validIdentifier('hash', version.hash)
    && (version.mtimeNs === undefined || validIdentifier('mtime', version.mtimeNs));
}

function decode(bytes: Buffer): string {
  if (!isUtf8(bytes)) failure('parse_failed', 'Settings file is not valid UTF-8.');
  return bytes.toString('utf8');
}

function safeError(error: unknown): SettingsWriteError {
  return error instanceof SettingsWriteError ? error : new SettingsWriteError('io_failed', 'Settings file operation failed.');
}

function auditOperations(operations: readonly SettingOperation[]): unknown[] {
  return operations.map(operation => ({ type: operation.type, path: [...operation.path] }));
}

function auditContext(input: { device?: string; level?: string }): { device?: string; level?: string } {
  return { ...(input.device === undefined ? {} : { device: input.device }),
    ...(input.level === undefined ? {} : { level: input.level }) };
}

function checkMetadata(stat: BigIntStats, expected: ExpectedFile): void {
  if (Number(stat.uid) !== expected.uid || Number(stat.gid) !== expected.gid || mode(stat) !== expected.mode) {
    failure('metadata_mismatch', 'Settings file owner or mode differs from the expected metadata.');
  }
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function snapshot(target: string, expected: ExpectedFile): Promise<Snapshot> {
  const before = await lstat(target, { bigint: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') failure('missing_target', 'Settings target does not exist.');
    throw error;
  });
  if (before.isSymbolicLink()) failure('symlink_target', 'Settings target must not be a symlink.');
  if (!before.isFile()) failure('not_regular', 'Settings target must be a regular file.');
  checkMetadata(before, expected);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat({ bigint: true });
    if (!opened.isFile() || !sameStat(before, opened)) failure('changed_underneath', 'Settings file changed underneath the operation.');
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    const current = await lstat(target, { bigint: true });
    if (!sameStat(opened, after) || !sameStat(after, current)) failure('changed_underneath', 'Settings file changed underneath the operation.');
    checkMetadata(after, expected);
    return { bytes, hash: hash(bytes), stat: after };
  } finally { await file.close(); }
}

async function unchanged(target: string, expected: ExpectedFile, previous: Snapshot): Promise<void> {
  try {
    const current = await snapshot(target, expected);
    if (current.hash !== previous.hash) throw new Error();
  } catch { failure('changed_underneath', 'Settings file changed underneath the operation; nothing was written.'); }
}

async function privateDirectory(path: string): Promise<void> {
  let ancestor = path;
  while (!await optionalStat(ancestor)) ancestor = dirname(ancestor);
  let directory = await BoundDirectory.open(ancestor);
  try {
    for (const segment of relative(ancestor, path).split(sep).filter(Boolean)) {
      await directory.check();
      await mkdir(directory.entry(segment), { mode: 0o700 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      await directory.file.sync();
      const entry = directory.entry(segment);
      const stat = await lstat(entry, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) failure('unsafe_storage', 'Settings storage must not be a symlink.');
      const next = await BoundDirectory.open(entry);
      await directory.file.close();
      directory = next;
    }
    await directory.check();
  } finally { await directory.file.close(); }
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (mode(stat) & 0o077) !== 0
    || Number(stat.uid) !== process.getuid?.()) failure('unsafe_storage', 'Settings backups and audit require a private directory owned by the current user.');
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function trustedDirectory(path: string): Promise<void> {
  const stat = await lstat(path, { bigint: true });
  const root = dirname(path) === path;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (mode(stat) & 0o022) !== 0
    || (Number(stat.uid) !== 0 && Number(stat.uid) !== process.getuid?.())) {
    failure('unsafe_directory', 'Settings directories and ancestors require trusted ownership and must not allow group or world writes.');
  }
  if (!root) await trustedDirectory(dirname(path));
}

async function canonicalStorage(path: string): Promise<string> {
  let ancestor = path;
  while (!await optionalStat(ancestor)) ancestor = dirname(ancestor);
  const canonical = await realpath(ancestor);
  await trustedDirectory(canonical);
  return resolve(canonical, relative(ancestor, path));
}

function separateStorage(backupDir: string, auditDir: string): void {
  const contains = (parent: string, child: string) => parent === child || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  if (contains(backupDir, auditDir) || contains(auditDir, backupDir)) {
    failure('storage_collision', 'Settings backup and audit directories must be separate; neither may contain the other.');
  }
}

class BoundDirectory {
  private constructor(readonly path: string, readonly file: FileHandle, private readonly stat: BigIntStats) {}

  static async open(path: string): Promise<BoundDirectory> {
    if (process.platform !== 'linux') failure('unsupported_platform', 'Settings directory binding requires Linux.');
    const canonical = await realpath(path);
    await trustedDirectory(canonical);
    const before = await lstat(canonical, { bigint: true });
    const file = await open(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat({ bigint: true });
      if (!sameIdentity(before, stat)) failure('unsafe_directory', 'Settings directory changed while opening it.');
      return new BoundDirectory(canonical, file, stat);
    } catch (error) { await file.close(); throw error; }
  }

  entry(name: string): string { return `/proc/self/fd/${this.file.fd}/${name}`; }

  async check(): Promise<void> {
    await trustedDirectory(this.path);
    if (!sameIdentity(this.stat, await lstat(this.path, { bigint: true }))) failure('unsafe_directory', 'Settings directory was replaced.');
  }
}

async function atomicWrite(directory: BoundDirectory, name: string, bytes: Buffer, expected: ExpectedFile,
  previous: Snapshot, state: CommitState, authorize?: () => void): Promise<void> {
  const target = directory.entry(name);
  const temp = directory.entry(`.${name}.${randomUUID()}.tmp`);
  const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let renamed = false;
  try {
    await file.writeFile(bytes);
    const stat = await file.stat({ bigint: true });
    if (Number(stat.uid) !== expected.uid || Number(stat.gid) !== expected.gid) await file.chown(expected.uid, expected.gid);
    await file.chmod(expected.mode);
    await file.sync();
    await directory.check();
    const replacement = await snapshot(temp, expected);
    if (!sameIdentity(await file.stat({ bigint: true }), replacement.stat) || replacement.hash !== hash(bytes)) {
      failure('changed_underneath', 'Settings replacement changed underneath the operation; nothing was written.');
    }
    await unchanged(target, expected, previous);
    authorize?.();
    await rename(temp, target);
    renamed = true;
    state.committed = true;
    await directory.check();
    await directory.file.sync();
  } finally {
    await file.close().catch(() => {});
    if (!renamed) await unlink(temp).catch(() => {});
  }
}

async function optionalStat(path: string): Promise<BigIntStats | undefined> {
  return lstat(path, { bigint: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
}

async function staleLock(path: string): Promise<boolean> {
  const stat = await optionalStat(path);
  if (!stat?.isFile() || Number(stat.uid) !== process.getuid?.() || (mode(stat) & 0o077) !== 0) return false;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!file) return false;
  try {
    if (!sameIdentity(stat, await file.stat({ bigint: true }))) return false;
    const owner: unknown = JSON.parse(await file.readFile('utf8'));
    if (!owner || typeof owner !== 'object' || !('pid' in owner) || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0) return false;
    try { process.kill(Number(owner.pid), 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    return 'birth' in owner && typeof owner.birth === 'string' && owner.birth !== await processIdentity(Number(owner.pid));
  } catch { return false; }
  finally { await file.close(); }
}

async function processIdentity(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (!fields[19] || !/^\d+$/.test(fields[19])) throw new Error();
  return fields[19];
}

async function withLock<T>(path: string, operation: () => Promise<T>, depth = 0, waitUntil = 0,
  onFailure?: () => Promise<void>): Promise<T> {
  const ownerPath = `${path}.owner-${process.pid}-${randomUUID()}`;
  const file = await open(ownerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let published = false;
  try {
    // Publish a complete ownership record atomically, including across process termination.
    await file.writeFile(JSON.stringify({ pid: process.pid, birth: await processIdentity(process.pid) }));
    await file.sync();
    await link(ownerPath, path);
    published = true;
  }
  catch (error) {
    await file.close();
    await unlink(ownerPath).catch(() => {});
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (depth >= 8 || !await staleLock(path)) {
      if (Date.now() < waitUntil) {
        await new Promise(resolve => setTimeout(resolve, 10));
        return withLock(path, operation, depth, waitUntil, onFailure);
      }
      failure('locked', 'Settings target is locked by another writer; retry after it finishes.');
    }
    await withLock(`${path}.reap`, async () => {
      const stale = await optionalStat(path);
      const current = await optionalStat(path);
      if (stale && (!await staleLock(path) || !current || !sameIdentity(stale, current))) {
        failure('locked', 'Settings target is locked by another writer; retry after it finishes.');
      }
      if (stale) await unlink(path);
    }, depth + 1, waitUntil);
    // Finish every reaper's cleanup before the operation can resolve recovery or prune backups.
    return withLock(path, operation, depth + 1, waitUntil, onFailure);
  }
  let held: BigIntStats | undefined;
  try {
    held = await file.stat({ bigint: true });
    if (published) await unlink(ownerPath);
    const prefix = `${basename(path)}.owner-`;
    for (const name of await readdir(dirname(path))) if (name.startsWith(prefix)) {
      const orphan = join(dirname(path), name);
      const before = await optionalStat(orphan);
      if (!before || !await staleLock(orphan)) continue;
      const current = await optionalStat(orphan);
      if (current && sameIdentity(before, current)) await unlink(orphan);
    }
    return await operation();
  } catch (error) {
    await onFailure?.();
    throw error;
  } finally {
    try {
      await unlink(ownerPath).catch(() => {});
      // Keep the published lock until descriptor cleanup and failure recovery finish.
      try { await file.close(); }
      catch (error) { await onFailure?.(); throw error; }
    } finally {
      try {
        const current = await lstat(path, { bigint: true }).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        });
        if (held && current?.ino === held.ino && current.dev === held.dev) await unlink(path);
      } catch (error) { await onFailure?.(); throw error; }
    }
  }
}

async function repairAuditTail(file: FileHandle, check: () => Promise<void>): Promise<void> {
  const size = Number((await file.stat({ bigint: true })).size);
  if (!Number.isSafeInteger(size)) throw new Error();
  const buffer = Buffer.alloc(4096);
  let offset = size;
  while (offset > 0) {
    const length = Math.min(buffer.length, offset);
    offset -= length;
    const { bytesRead } = await file.read(buffer, 0, length, offset);
    if (bytesRead !== length) throw new Error();
    const newline = buffer.lastIndexOf(10, length - 1);
    if (newline !== -1) {
      const end = offset + newline + 1;
      if (end !== size) { await check(); await file.truncate(end); await check(); await file.sync(); await check(); }
      return;
    }
  }
  if (size) { await check(); await file.truncate(0); await check(); await file.sync(); await check(); }
}

function checkRequest(change: SettingsChange): void {
  if (typeof change.editor !== 'string' || !Object.hasOwn(editors, change.editor)
    || typeof change.timing !== 'string'
    || !/^(now|next-turn|next-chat|next-run|restart(?:-when-idle|-now)?:[^\s]+)(?![\s\S])/.test(change.timing)
    || [change.device, change.level].some(value => value !== undefined && typeof value !== 'string')
    || !change.target || ![change.expected?.uid, change.expected?.gid, change.expected?.mode].every(Number.isSafeInteger)
    || change.expected.uid < 0 || change.expected.gid < 0 || change.expected.mode < 0 || change.expected.mode > 0o7777) {
    failure('invalid_change', 'Settings change requires a supported editor, timing, target and expected owner/mode.');
  }
}

export class SettingsWriteThrough {
  private readonly backupDir: string;
  private readonly auditFile: string;
  private readonly keepBackups: number;
  private readonly coordinate: SettingsCoordinator;
  private lastBackupTime = 0;

  constructor(options: WriteThroughOptions) {
    this.backupDir = resolve(options.backupDir);
    this.auditFile = resolve(options.auditFile);
    this.keepBackups = options.keepBackups ?? 10;
    if (typeof options.coordinate !== 'function') failure('coordination_required', 'Settings writes require coordination with every independent target writer.');
    this.coordinate = options.coordinate;
    if (!Number.isSafeInteger(this.keepBackups) || this.keepBackups < 1) failure('invalid_retention', 'Backup retention must be a positive integer.');
  }

  async apply(input: SettingsChange, authorize?: () => void): Promise<UndoToken> {
    authorize?.();
    const { value: change, target } = captureRequest(input);
    if (!change || !validIdentifiers(change, 'apply')) return this.invalidId('apply', target);
    checkRequest(change);
    const record: AuditRecord = { timestamp: new Date().toISOString(), action: 'apply', target: resolve(change.target),
      operations: [], backupId: null, timing: change.timing, result: 'failure', ...auditContext(change) };
    return this.run(record, change.target, async (directory, state) => {
      authorize?.();
      const target = record.target;
      const boundTarget = directory.entry(basename(target));
      // Validate the whole list before copying user data into the audit.
      if (!Array.isArray(change.operations)) invalidOperation();
      for (const operation of change.operations) {
        if (!operation || typeof operation !== 'object' || (operation.type !== 'set' && operation.type !== 'delete')
          || !Array.isArray(operation.path)) invalidOperation();
        validatePath([...operation.path]);
        if (operation.type === 'set') validateValue(operation.value);
      }
      record.operations = auditOperations(change.operations);
      const before = await snapshot(boundTarget, change.expected);
      record.beforeHash = before.hash;
      if (change.version && before.hash !== change.version.hash) {
        failure('changed_underneath', 'Settings file changed underneath the operation; nothing was written.');
      }
      const editor = editors[change.editor];
      const source = decode(before.bytes);
      const original = editor.parse(source);
      validateValue(original);
      checkPreconditions(original, change.preconditions ?? []);
      const expectedValue = applyValues(original, change.operations);
      record.backupId = await this.backup(target, before, state);
      const edited = Buffer.from(editor.edit(source, change.operations));
      if (!isDeepStrictEqual(editor.parse(decode(edited)), expectedValue)) failure('verification_failed', 'Edited settings do not contain the requested values.');
      const token: UndoToken = { target, editor: change.editor, backupId: record.backupId, backupHash: before.hash,
        writtenHash: hash(edited), expected: { ...change.expected }, timing: change.timing, ...auditContext(change) };
      record.afterHash = token.writtenHash;
      state.recovery = await this.prepareRecovery('apply', token);
      await atomicWrite(directory, basename(target), edited, change.expected, before, state, authorize);
      await this.verify(directory, basename(target), change.expected, change.editor, token.writtenHash, expectedValue);
      return token;
    });
  }

  async undo(input: UndoToken, authorize?: () => void): Promise<void> {
    await this.undoWithToken(input, authorize);
  }

  /** Return the reverse change so the settings pipeline can audit and undo a successful restoration. */
  async undoWithToken(input: UndoToken, authorize?: () => void): Promise<UndoToken> {
    authorize?.();
    const { value: token, target } = captureRequest(input);
    if (!token || !validIdentifiers(token, 'undo')) return this.invalidId('undo', target);
    try { checkRequest({ ...token, operations: [] }); }
    catch { return this.invalidId('undo', target); }
    const record: AuditRecord = { timestamp: new Date().toISOString(), action: 'undo', target: resolve(token.target),
      operations: [], backupId: null, timing: token.timing, result: 'failure', ...auditContext(token) };
    record.backupId = token.backupId;
    return this.run(record, token.target, async (targetDirectory, state) => {
      authorize?.();
      const target = record.target;
      if (token.backupId.split('/')[0] !== hash(target)) failure('invalid_id', 'Settings identifier is invalid.');
      const boundTarget = targetDirectory.entry(basename(target));
      const before = await snapshot(boundTarget, token.expected);
      record.beforeHash = before.hash;
      if (before.hash !== token.writtenHash) failure('undo_changed', 'Undo refused: settings changed since this write; the outside change has been left intact.');
      const directory = join(this.backupDir, hash(target));
      await privateDirectory(this.backupDir);
      await privateDirectory(directory);
      const backupDirectory = await BoundDirectory.open(directory);
      let backup: Snapshot;
      try {
        const backupPath = backupDirectory.entry(basename(token.backupId));
        const metadata = await lstat(backupPath, { bigint: true });
        backup = await snapshot(backupPath, { uid: process.getuid!(), gid: Number(metadata.gid), mode: token.expected.mode & 0o770 });
        await backupDirectory.check();
      } finally { await backupDirectory.file.close(); }
      if (backup.hash !== token.backupHash) failure('invalid_backup', 'Undo backup bytes no longer match the saved hash.');
      record.afterHash = backup.hash;
      const original = editors[token.editor].parse(decode(backup.bytes));
      const reverse: UndoToken = { ...token, target, backupId: await this.backup(target, before, state), backupHash: before.hash,
        writtenHash: backup.hash };
      state.recovery = await this.prepareRecovery('undo', reverse);
      await atomicWrite(targetDirectory, basename(target), backup.bytes, token.expected, before, state, authorize);
      await this.verify(targetDirectory, basename(target), token.expected, token.editor, token.backupHash, original);
      return reverse;
    });
  }

  private async invalidId(action: 'apply' | 'undo', target?: string): Promise<never> {
    if (target === undefined) return failure('invalid_id', 'Settings identifier is invalid.');
    const record: AuditRecord = { timestamp: new Date().toISOString(), action, target: 'invalid id', operations: [],
      backupId: null, timing: 'now', result: 'failure' };
    return this.run(record, target, async () => failure('invalid_id', 'Settings identifier is invalid.'));
  }

  private async backup(target: string, before: Snapshot, state: CommitState): Promise<string> {
    await privateDirectory(this.backupDir);
    const directory = join(this.backupDir, hash(target));
    await privateDirectory(directory);
    this.lastBackupTime = Math.max(Date.now(), this.lastBackupTime + 1);
    const name = `${String(this.lastBackupTime).padStart(16, '0')}-${before.hash}-${randomUUID()}.bak`;
    const bound = await BoundDirectory.open(directory);
    try {
      const file = await open(bound.entry(name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      state.backupId = `${hash(target)}/${name}`;
      try {
        await file.writeFile(before.bytes);
        // Keep owner/group permissions; backups never grant access to others.
        await file.chmod(mode(before.stat) & 0o770);
        await file.sync();
      } finally { await file.close(); }
      await bound.check();
      await bound.file.sync();
      return state.backupId;
    } finally { await bound.file.close(); }
  }

  private async prepareRecovery(action: 'apply' | 'undo', undoToken: UndoToken): Promise<RecoveryInfo> {
    const recovery: RecoveryInfo = { id: `${undoToken.backupId}.recovery.json`, action, undoToken };
    const directory = await BoundDirectory.open(dirname(join(this.backupDir, recovery.id)));
    try {
      const file = await open(directory.entry(basename(recovery.id)), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(`${JSON.stringify(recovery)}\n`); await file.sync(); }
      finally { await file.close(); }
      await directory.check();
      await directory.file.sync();
      return recovery;
    } finally { await directory.file.close(); }
  }

  private async finishRecovery(record: AuditRecord, recovery: RecoveryInfo): Promise<void> {
    const path = dirname(join(this.backupDir, recovery.id));
    await trustedDirectory(dirname(recovery.undoToken.target));
    // Reclaim the target lock so retention cannot overlap backup creation or undo reads.
    await withLock(settingsLockPath(recovery.undoToken.target), async () => {
      const directory = await BoundDirectory.open(path);
      try {
        const resolved = new Set([basename(recovery.undoToken.backupId)]);
        if (record.action === 'undo' && record.backupId) resolved.add(basename(record.backupId));
        const names = (await readdir(directory.entry('.'))).filter(entry => backupName.test(entry)).sort().reverse();
        const completed: string[] = [];
        for (const name of names) {
          if (resolved.has(name) || !await optionalStat(directory.entry(`${name}.recovery.json`))) completed.push(name);
        }
        // Unresolved recovery records pin their backup regardless of normal retention.
        for (const name of completed.slice(this.keepBackups)) {
          if (name === basename(recovery.undoToken.backupId)) continue;
          await unlink(directory.entry(name));
        }
        for (const name of resolved) await unlink(directory.entry(`${name}.recovery.json`)).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
        await directory.check();
        await directory.file.sync();
      } finally { await directory.file.close(); }
    }, 0, Date.now() + 10_000, async () => {
      await this.prepareRecovery(recovery.action, recovery.undoToken).catch(() => {});
    });
  }

  private async discardBackup(backupId: string): Promise<void> {
    const directory = await BoundDirectory.open(dirname(join(this.backupDir, backupId)));
    try {
      await directory.check();
      for (const name of [`${basename(backupId)}.recovery.json`, basename(backupId)]) {
        await unlink(directory.entry(name)).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
      await directory.file.sync();
    } finally { await directory.file.close(); }
  }

  private async verify(directory: BoundDirectory, name: string, expected: ExpectedFile, editor: EditorKind,
    writtenHash: string, value: unknown): Promise<void> {
    try {
      await directory.check();
      const written = await snapshot(directory.entry(name), expected);
      if (written.hash !== writtenHash || !isDeepStrictEqual(editors[editor].parse(decode(written.bytes)), value)) throw new Error();
      await directory.check();
    } catch { failure('verification_failed', 'Settings write could not be verified; the saved backup is available for recovery.'); }
  }

  private async run<T>(record: AuditRecord, target: string,
    operation: (directory: BoundDirectory, state: CommitState) => Promise<T>): Promise<T> {
    if (/\.wayroost-(?:settings|audit)\.lock(?:$|\.)/.test(basename(this.auditFile))
      || basename(this.auditFile).startsWith('.wayroost-audit-')) {
      failure('storage_collision', 'Settings audit path must not name an internal lock or reaper file.');
    }
    const state: CommitState = { committed: false };
    let directory: BoundDirectory | undefined;
    try {
      let value: T;
      try {
        directory = await BoundDirectory.open(dirname(target));
        const name = basename(target);
        const canonicalTarget = join(directory.path, name);
        const validTarget = validIdentifier('target', canonicalTarget);
        if (record.target !== 'invalid id' && validTarget) record.target = canonicalTarget;
        const bound = directory;
        value = await withLock(settingsLockPath(bound.entry(name)), async () => {
          let called = false;
          const result = await this.coordinate(validTarget ? canonicalTarget : target, async () => {
            if (called) failure('coordination_failed', 'Settings coordination must invoke the operation exactly once.');
            called = true;
            return this.audited(record, { directory: bound, name }, async () => {
              try {
                if (!validTarget) failure('invalid_id', 'Settings identifier is invalid.');
                return await operation(bound, state);
              } finally {
                // Only this attempt's backup is disposable before replacement.
                if (!state.committed && state.backupId) {
                  await this.discardBackup(state.backupId);
                  state.backupId = undefined;
                  state.recovery = undefined;
                }
              }
            });
          });
          if (!called) failure('coordination_failed', 'Settings coordination did not invoke the operation.');
          return result;
        });
      } finally { await directory?.file.close(); }
      // Keep recovery pinned through coordination, target lock release and directory close.
      if (state.recovery) await this.finishRecovery(record, state.recovery);
      return value;
    } catch (cause) {
      const error = safeError(cause);
      if (state.committed && state.recovery) throw new SettingsCommitError(error, state.recovery);
      throw error;
    }
  }

  private async audited<T>(record: AuditRecord, target: { directory: BoundDirectory; name: string },
    operation: () => Promise<T>): Promise<T> {
    separateStorage(await canonicalStorage(this.backupDir), await canonicalStorage(dirname(this.auditFile)));
    await privateDirectory(dirname(this.auditFile));
    const directory = await BoundDirectory.open(dirname(this.auditFile));
    try {
      separateStorage(await canonicalStorage(this.backupDir), directory.path);
      await directory.check();
      if (join(target.directory.path, target.name) === join(directory.path, basename(this.auditFile))) {
        failure('storage_collision', 'Settings target and audit file must be different files.');
      }
      const file = await open(directory.entry(basename(this.auditFile)), constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        const stat = await file.stat({ bigint: true });
        const targetStat = await optionalStat(target.directory.entry(target.name));
        if (targetStat && sameIdentity(stat, targetStat)) failure('storage_collision', 'Settings target and audit file must be different files.');
        if (!stat.isFile() || Number(stat.uid) !== process.getuid?.() || (mode(stat) & 0o077) !== 0) failure('unsafe_audit', 'Settings audit must be a private regular file owned by the current user.');
        const auditPath = directory.entry(basename(this.auditFile));
        const check = async () => {
          await directory.check();
          const current = await file.stat({ bigint: true });
          if (current.nlink !== 1n || Number(current.uid) !== process.getuid?.() || (mode(current) & 0o077) !== 0
            || !sameIdentity(stat, await lstat(auditPath, { bigint: true }))) {
            failure('unsafe_audit', 'Settings audit must have exactly one unchanged hard link.');
          }
        };
        // A shared storage namespace keeps the inode lock stable when the audit file moves.
        const storagePath = dirname(this.backupDir);
        if (!await optionalStat(storagePath)) await privateDirectory(storagePath);
        const storage = await BoundDirectory.open(storagePath);
        try {
          return await withLock(storage.entry(`.wayroost-audit-${stat.dev}-${stat.ino}.lock`), async () => {
            await storage.check();
            await check();
            try { await repairAuditTail(file, check); }
            catch { failure('audit_failed', 'Settings audit record could not be persisted completely.'); }
            let result: T | undefined;
            let error: SettingsWriteError | undefined;
            try { result = await operation(); record.result = 'success'; }
            catch (cause) {
              error = safeError(cause);
              record.error = error.code;
              if (error.code === 'invalid_id') {
                record.target = 'invalid id'; record.operations = []; record.backupId = null; record.timing = 'now'; record.error = 'invalid id';
              }
            }
            const line = Buffer.from(`${JSON.stringify(record)}\n`);
            try {
              let offset = 0;
              while (offset < line.length) {
                await check();
                const written = await file.write(line.subarray(offset));
                if (written.bytesWritten <= 0 || written.bytesWritten > line.length - offset) throw new Error();
                offset += written.bytesWritten;
                await check();
              }
              await file.sync();
              await check();
              await directory.file.sync();
              await check();
              await storage.check();
            } catch { failure('audit_failed', 'Settings audit record could not be persisted completely.'); }
            if (error) throw error;
            return result as T;
          }, 0, Date.now() + 10_000);
        } finally { await storage.file.close(); }
      } catch (error) { throw safeError(error); }
      finally { await file.close(); }
    } finally { await directory.file.close(); }
  }
}
