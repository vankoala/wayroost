import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, readdirSync, unlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface JournalInput {
  type: string;
  data: JsonValue;
  key?: string;
}

export interface JournalEvent extends Readonly<JournalInput> {
  readonly seq: number;
  readonly id: string;
  readonly at: string;
  readonly prev: string;
  readonly hash: string;
}

export type JournalErrorCode =
  | 'locked' | 'closed' | 'invalid-input' | 'key-conflict' | 'unknown-task'
  | 'duplicate-result' | 'task-resolved' | 'invalid-json' | 'invalid-event'
  | 'bad-seq' | 'bad-prev' | 'bad-hash' | 'duplicate-id' | 'torn-tail' | 'ulid-overflow';

export class JournalError extends Error {
  constructor(readonly code: JournalErrorCode, message: string, readonly line?: number, options?: ErrorOptions) {
    super(line === undefined ? message : `Journal line ${line}: ${message}`, options);
    this.name = 'JournalError';
  }
}

export interface TornTail {
  line: number;
  offset: number;
  bytes: number;
}

export class JournalTornTailError extends JournalError implements TornTail {
  constructor(line: number, readonly offset: number, readonly bytes: number) {
    super('torn-tail', 'final line has no newline; explicit repair is required', line);
    this.name = 'JournalTornTailError';
  }

  declare readonly line: number;
}

export const JOURNAL_GENESIS = '0'.repeat(64);
const FILE = 'journal.jsonl';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_TIME = 2 ** 48 - 1;
const MAX_RANDOM = (1n << 80n) - 1n;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HEX = /^[a-f0-9]{64}$/;

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function digest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

function unlinkOwned(path: string, fd: number): boolean {
  const held = fstatSync(fd);
  let current;
  try { current = lstatSync(path); }
  catch (error) { if (code(error) !== 'ENOENT') throw error; }
  if (current?.dev !== held.dev || current.ino !== held.ino) return false;
  unlinkSync(path);
  return true;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (cause) {
    if (code(cause) === 'ESRCH') return false;
    throw new JournalError('locked', 'journal writer may still be alive', undefined, { cause });
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    let written: number;
    try { written = writeSync(fd, bytes, offset, bytes.length - offset); }
    catch (error) {
      if (code(error) === 'EINTR') continue;
      throw error;
    }
    if (written === 0) throw new Error('Journal write made no progress');
    offset += written;
  }
}

function readAll(fd: number): Buffer {
  const bytes = Buffer.alloc(fstatSync(fd).size);
  let offset = 0;
  while (offset < bytes.length) {
    let read: number;
    try { read = readSync(fd, bytes, offset, bytes.length - offset, offset); }
    catch (error) {
      if (code(error) === 'EINTR') continue;
      throw error;
    }
    if (read === 0) throw new Error('Journal changed while being read');
    offset += read;
  }
  return bytes;
}

/** Reject values that JSON would silently omit or change, and sort object keys for replay comparison. */
function json(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || value === null || ancestors.has(value)) {
    throw new JournalError('invalid-input', 'data must be a finite, acyclic JSON value');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let i = 0; i < value.length; i++) items.push(json(value[i], ancestors));
      return `[${items.join(',')}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) {
      throw new JournalError('invalid-input', 'data must contain only JSON objects and arrays');
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${json(object[key], ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function field(data: JsonValue, name: string): string | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const value = (data as Record<string, JsonValue>)[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function encodeId(value: bigint): string {
  let encoded = '';
  for (let i = 0; i < 26; i++) {
    encoded = ALPHABET[Number(value & 31n)]! + encoded;
    value >>= 5n;
  }
  return encoded;
}

function decodeId(id: string): bigint {
  let value = 0n;
  for (const char of id) value = (value << 5n) | BigInt(ALPHABET.indexOf(char));
  return value;
}

interface Index {
  events: JournalEvent[];
  types: Map<string, JournalEvent[]>;
  tasks: Map<string, JournalEvent[]>;
  keys: Map<string, { event: JournalEvent; payload: string }>;
  ids: Set<string>;
  started: Set<string>;
  resolved: Set<string>;
  results: Set<string>;
  prev: string;
}

function emptyIndex(): Index {
  return {
    events: [], types: new Map(), tasks: new Map(), keys: new Map(), ids: new Set(),
    started: new Set(), resolved: new Set(), results: new Set(), prev: JOURNAL_GENESIS,
  };
}

function checkResult(index: Index, taskId: string, resultId: string, line?: number): void {
  if (!index.started.has(taskId)) throw new JournalError('unknown-task', 'result has no prior task start', line);
  if (index.results.has(resultId)) throw new JournalError('duplicate-result', 'result id is already committed', line);
  if (index.resolved.has(taskId)) throw new JournalError('task-resolved', 'task is already resolved', line);
}

function checkEvent(index: Index, event: JournalInput, line?: number): void {
  if (event.key !== undefined && index.keys.has(event.key)) {
    throw new JournalError('key-conflict', 'idempotency key occurs more than once', line);
  }
  if (event.type === 'start' && !field(event.data, 'taskId')) {
    throw new JournalError('invalid-input', 'start requires a taskId', line);
  }
  if (event.type === 'result') {
    const taskId = field(event.data, 'taskId');
    const resultId = field(event.data, 'resultId');
    if (!taskId || !resultId || event.data === null || typeof event.data !== 'object' || !Object.hasOwn(event.data, 'data')) {
      throw new JournalError('invalid-input', 'result requires taskId, resultId and data', line);
    }
    checkResult(index, taskId, resultId, line);
  }
}

function indexEvent(index: Index, event: JournalEvent, payload: string): void {
  index.events.push(event);
  index.ids.add(event.id);
  const byType = index.types.get(event.type) ?? [];
  byType.push(event);
  index.types.set(event.type, byType);
  const taskId = field(event.data, 'taskId');
  if (taskId) {
    const byTask = index.tasks.get(taskId) ?? [];
    byTask.push(event);
    index.tasks.set(taskId, byTask);
    if (event.type === 'start') index.started.add(taskId);
    if (event.type === 'result') index.resolved.add(taskId);
  }
  if (event.type === 'result') index.results.add(field(event.data, 'resultId')!);
  if (event.key !== undefined) index.keys.set(event.key, { event, payload });
}

/** One exclusive writer; indexes are published only after the whole file verifies. */
export class EventJournal {
  readonly path: string;
  private readonly dir: string;
  private readonly lockPath: string;
  private fd: number | undefined;
  private lockFd: number | undefined;
  private closed = false;
  private loaded = false;
  private index = emptyIndex();
  private lastTime = -1;
  private lastRandom = 0n;

  // Settings use a separate audit file; each filename also has its own lock and recovery claims.
  constructor(stateDir: string, private readonly now: () => number = Date.now, file: string = FILE) {
    if (!/^[a-z][a-z0-9-]*\.jsonl$/.test(file)) throw new JournalError('invalid-input', 'invalid journal filename');
    this.dir = resolve(stateDir);
    this.path = join(this.dir, file);
    this.lockPath = `${this.path}.lock`;
    const created = mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (created) {
      for (let path = this.dir; ; path = dirname(path)) {
        syncDirectory(path);
        if (path === dirname(resolve(created))) break;
      }
    }
    try {
      this.acquireLock();
      try {
        this.fd = openSync(this.path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        fsyncSync(this.fd);
        syncDirectory(this.dir);
      } catch (error) {
        if (code(error) !== 'EEXIST' || this.fd !== undefined) throw error;
        this.fd = openSync(this.path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
      }
      const stat = fstatSync(this.fd);
      if (!stat.isFile()) throw new Error('Journal must be a regular file');
      if (stat.nlink !== 1) throw new Error('Journal must not have multiple hard links');
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private acquireLock(): void {
    const recovery = this.acquireRecoveryClaim();
    try {
      writeAll(recovery.fd, Buffer.from(JSON.stringify({ pid: process.pid }) + '\n'));
      fsyncSync(recovery.fd);
      try {
        // Linking a flushed O_EXCL claim publishes the complete owner without replacing another lock.
        linkSync(recovery.path, this.lockPath);
      } catch (error) {
        if (code(error) !== 'EEXIST') throw error;
        let stale: number | undefined;
        try {
          stale = openSync(this.lockPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
          const stat = fstatSync(stale);
          if (!stat.isFile()) throw new JournalError('locked', 'journal lock must be a regular file');
          const owner = JSON.parse(readFileSync(stale, 'utf8')) as { pid?: unknown };
          if (!Number.isInteger(owner?.pid) || Number(owner.pid) <= 0 || Number(owner.pid) > 2 ** 31 - 1) {
            throw new JournalError('locked', 'journal lock has no verifiable owner');
          }
          if (isAlive(Number(owner.pid))) throw new JournalError('locked', 'journal already has a writer');
          const current = lstatSync(this.lockPath);
          if (current.dev !== stat.dev || current.ino !== stat.ino) throw new JournalError('locked', 'journal lock changed during recovery');
          unlinkSync(this.lockPath);
          linkSync(recovery.path, this.lockPath);
        } catch (cause) {
          if (cause instanceof JournalError) throw cause;
          throw new JournalError('locked', 'journal lock could not be safely recovered', undefined, { cause });
        } finally {
          if (stale !== undefined) closeSync(stale);
        }
      }
      this.lockFd = recovery.fd;
    } finally {
      try { unlinkOwned(recovery.path, recovery.fd); }
      finally { if (this.lockFd !== recovery.fd) closeSync(recovery.fd); }
    }
    syncDirectory(this.dir);
  }

  private acquireRecoveryClaim(): { path: string; fd: number } {
    const prefix = `${basename(this.lockPath)}.recovery.`;
    const path = `${this.lockPath}.recovery.${process.pid}.${randomBytes(16).toString('hex')}`;
    let fd: number | undefined;
    try {
      // Publish ownership in the name so even a crash before the first write is recoverable.
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      // Every contender publishes before scanning and refuses any other live claim.
      // A later contender must see this claim until recovery has finished.
      for (const name of readdirSync(this.dir)) {
        if (!name.startsWith(prefix) || join(this.dir, name) === path) continue;
        const owner = /^(\d+)\.[a-f0-9]{32}$/.exec(name.slice(prefix.length));
        const pid = Number(owner?.[1]);
        if (!owner || !Number.isInteger(pid) || pid <= 0 || pid > 2 ** 31 - 1) {
          throw new JournalError('locked', 'journal recovery claim has no verifiable owner');
        }
        const other = join(this.dir, name);
        let stat;
        try { stat = lstatSync(other); }
        catch (cause) { if (code(cause) === 'ENOENT') continue; throw cause; }
        if (!stat.isFile()) throw new JournalError('locked', 'journal recovery claim must be a regular file');
        if (stat.nlink !== 1) {
          // A crash after publication may leave both names for the same ownership record.
          const published = lstatSync(this.lockPath);
          if (stat.nlink !== 2 || published.dev !== stat.dev || published.ino !== stat.ino) {
            throw new JournalError('locked', 'journal recovery claim has unrelated hard links');
          }
        }
        if (isAlive(pid)) throw new JournalError('locked', 'journal lock recovery is already in progress');
        let current;
        try { current = lstatSync(other); }
        catch (cause) { if (code(cause) === 'ENOENT') continue; throw cause; }
        if (current.dev !== stat.dev || current.ino !== stat.ino) throw new JournalError('locked', 'journal recovery claim changed');
        try { unlinkSync(other); }
        catch (cause) { if (code(cause) !== 'ENOENT') throw cause; }
      }
      return { path, fd };
    } catch (cause) {
      if (fd !== undefined) {
        try { unlinkOwned(path, fd); }
        finally { closeSync(fd); }
      }
      if (cause instanceof JournalError) throw cause;
      throw new JournalError('locked', 'journal recovery claim could not be safely acquired', undefined, { cause });
    }
  }

  private requireOpen(): number {
    if (this.closed || this.fd === undefined) throw new JournalError('closed', 'journal is closed');
    return this.fd;
  }

  private requireLoaded(): void {
    this.requireOpen();
    if (!this.loaded) this.load();
  }

  private scan(): { index: Index; tail?: TornTail } {
    const bytes = readAll(this.requireOpen());
    const index = emptyIndex();
    let offset = 0;
    while (offset < bytes.length) {
      const line = index.events.length + 1;
      const end = bytes.indexOf(10, offset);
      if (end === -1) return { index, tail: { line, offset, bytes: bytes.length - offset } };
      const raw = bytes.subarray(offset, end + 1);
      const text = raw.toString('utf8');
      let parsed: unknown;
      try {
        if (!Buffer.from(text).equals(raw)) throw new Error('Invalid UTF-8');
        parsed = JSON.parse(text);
      } catch (cause) { throw new JournalError('invalid-json', 'invalid JSON or UTF-8', line, { cause }); }
      const event = parsed as JournalEvent | null;
      if (!event || typeof event !== 'object' || Array.isArray(event)
        || !Number.isSafeInteger(event.seq) || typeof event.id !== 'string' || !ULID.test(event.id)
        || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at)) || new Date(event.at).toISOString() !== event.at
        || typeof event.type !== 'string' || !event.type || !Object.hasOwn(event, 'data')
        || event.key !== undefined && typeof event.key !== 'string'
        || typeof event.prev !== 'string' || !HEX.test(event.prev) || typeof event.hash !== 'string' || !HEX.test(event.hash)) {
        throw new JournalError('invalid-event', 'invalid event fields', line);
      }
      if (event.seq !== line) throw new JournalError('bad-seq', 'sequence is not contiguous', line);
      if (event.prev !== index.prev) throw new JournalError('bad-prev', 'previous line digest does not match', line);
      const { seq, id, at, type, data, key, prev, hash } = event;
      let canonicalData: string;
      try { canonicalData = json(data); }
      catch (cause) { throw new JournalError('invalid-event', 'invalid JSON data', line, { cause }); }
      const unsigned = JSON.stringify({ seq, id, at, type, data: JSON.parse(canonicalData) as JsonValue, ...(key === undefined ? {} : { key }), prev });
      // The event hash covers its serialization without hash, including the newline.
      if (digest(unsigned + '\n') !== hash || text !== unsigned.slice(0, -1) + `,"hash":"${hash}"}\n`) {
        throw new JournalError('bad-hash', 'event digest or exact encoding does not match', line);
      }
      if (index.ids.has(id)) throw new JournalError('duplicate-id', 'event id occurs more than once', line);
      const payload = JSON.stringify([type, canonicalData]);
      checkEvent(index, event, line);
      indexEvent(index, freeze(event), payload);
      index.prev = digest(raw);
      offset = end + 1;
    }
    return { index };
  }

  load(): readonly JournalEvent[] {
    this.requireOpen();
    this.loaded = false;
    this.index = emptyIndex();
    const { index, tail } = this.scan();
    if (tail) throw new JournalTornTailError(tail.line, tail.offset, tail.bytes);
    fsyncSync(this.requireOpen());
    this.index = index;
    const last = index.events.at(-1);
    if (last) {
      const id = decodeId(last.id);
      const time = Number(id >> 80n);
      if (time > this.lastTime || time === this.lastTime && (id & MAX_RANDOM) > this.lastRandom) {
        this.lastTime = time;
        this.lastRandom = id & MAX_RANDOM;
      }
    }
    this.loaded = true;
    return [...index.events];
  }

  /** Reverify the prefix before removing only a final line without a newline. */
  repairTornTail(): TornTail | undefined {
    this.requireOpen();
    this.loaded = false;
    this.index = emptyIndex();
    const { tail } = this.scan();
    if (tail) {
      ftruncateSync(this.requireOpen(), tail.offset);
      fsyncSync(this.requireOpen());
    }
    this.load();
    return tail;
  }

  append(input: JournalInput): JournalEvent {
    this.requireLoaded();
    if (!input || typeof input.type !== 'string' || !input.type || input.key !== undefined && typeof input.key !== 'string') {
      throw new JournalError('invalid-input', 'event requires a type and an optional string key');
    }
    const canonicalData = json(input.data);
    const payload = JSON.stringify([input.type, canonicalData]);
    if (input.key !== undefined) {
      const existing = this.index.keys.get(input.key);
      if (existing) {
        if (existing.payload !== payload) throw new JournalError('key-conflict', 'idempotency key has a different payload');
        return existing.event;
      }
    }
    const detached: JournalInput = { type: input.type, data: JSON.parse(canonicalData) as JsonValue, ...(input.key === undefined ? {} : { key: input.key }) };
    checkEvent(this.index, detached);
    const time = this.now();
    if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) throw new JournalError('invalid-input', 'time must fit 48 bits of milliseconds');
    const idTime = Math.max(time, this.lastTime);
    const random = idTime === this.lastTime ? this.lastRandom + 1n : BigInt(`0x${randomBytes(10).toString('hex')}`);
    if (random > MAX_RANDOM) throw new JournalError('ulid-overflow', 'random component exhausted in this millisecond');
    const id = encodeId((BigInt(idTime) << 80n) | random);
    const unsigned = { seq: this.index.events.length + 1, id, at: new Date(time).toISOString(), ...detached, prev: this.index.prev };
    const body = JSON.stringify(unsigned);
    const event = freeze({ ...unsigned, hash: digest(body + '\n') });
    const bytes = Buffer.from(JSON.stringify(event) + '\n');
    try {
      writeAll(this.requireOpen(), bytes);
      fsyncSync(this.requireOpen());
    } catch (error) {
      // An uncertain write must be verified before another append can proceed.
      this.loaded = false;
      this.index = emptyIndex();
      throw error;
    }
    this.lastTime = idTime;
    this.lastRandom = random;
    indexEvent(this.index, event, payload);
    this.index.prev = digest(bytes);
    return event;
  }

  /** A result resolves its task; taskId and resultId are outside the caller's data. */
  commitResult(taskId: string, resultId: string, data: JsonValue): JournalEvent {
    this.requireLoaded();
    if (!taskId || !resultId || typeof taskId !== 'string' || typeof resultId !== 'string') {
      throw new JournalError('invalid-input', 'taskId and resultId must be nonempty strings');
    }
    checkResult(this.index, taskId, resultId);
    return this.append({ type: 'result', data: { taskId, resultId, data } });
  }

  all(): readonly JournalEvent[] {
    this.requireLoaded();
    return [...this.index.events];
  }

  byType(type: string): readonly JournalEvent[] {
    this.requireLoaded();
    return [...this.index.types.get(type) ?? []];
  }

  byTaskId(taskId: string): readonly JournalEvent[] {
    this.requireLoaded();
    return [...this.index.tasks.get(taskId) ?? []];
  }

  afterSeq(seq: number): readonly JournalEvent[] {
    this.requireLoaded();
    if (!Number.isSafeInteger(seq) || seq < 0) throw new JournalError('invalid-input', 'sequence must be a nonnegative integer');
    return this.index.events.slice(seq);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.loaded = false;
    this.index = emptyIndex();
    try {
      if (this.fd !== undefined) closeSync(this.fd);
    } finally {
      this.fd = undefined;
      if (this.lockFd !== undefined) {
        try {
          if (unlinkOwned(this.lockPath, this.lockFd)) syncDirectory(this.dir);
        } finally {
          closeSync(this.lockFd);
          this.lockFd = undefined;
        }
      }
    }
  }
}
