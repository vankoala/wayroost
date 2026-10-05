import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EventJournal, JOURNAL_GENESIS, JournalError, JournalTornTailError,
  type JournalErrorCode, type JournalEvent, type JsonValue,
} from '../src/hub/journal.js';

const io = vi.hoisted(() => ({
  paths: new Map<number, string>(), operations: [] as string[],
  partialWrite: false, shortWrites: false, interruptWrite: false, failSync: false,
  failDirectorySync: false, random: undefined as number | undefined,
}));
vi.mock('node:fs', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args);
      io.paths.set(fd, String(args[0]));
      return fd;
    },
    closeSync: (fd: number) => { io.paths.delete(fd); fs.closeSync(fd); },
    writeSync: (fd: number, bytes: Buffer, offset: number, length: number) => {
      if (io.paths.get(fd)?.endsWith('/journal.jsonl')) {
        io.operations.push('write file');
        if (io.interruptWrite) {
          io.interruptWrite = false;
          throw Object.assign(new Error('Interrupted write'), { code: 'EINTR' });
        }
        if (io.partialWrite) {
          io.partialWrite = false;
          fs.writeSync(fd, bytes, offset, Math.min(length, 20));
          throw Object.assign(new Error('Partial write'), { code: 'EIO' });
        }
        if (io.shortWrites) length = Math.min(length, 7);
      }
      return fs.writeSync(fd, bytes, offset, length);
    },
    fsyncSync: (fd: number) => {
      if (fs.fstatSync(fd).isDirectory()) {
        io.operations.push('sync directory');
        if (io.failDirectorySync) {
          io.failDirectorySync = false;
          throw new Error('Directory sync failed');
        }
      } else if (io.paths.get(fd)?.endsWith('/journal.jsonl')) {
        io.operations.push('sync file');
        if (io.failSync) { io.failSync = false; throw new Error('File sync failed'); }
      }
      fs.fsyncSync(fd);
    },
    ftruncateSync: (fd: number, length: number) => { io.operations.push('truncate file'); fs.ftruncateSync(fd, length); },
  };
});
vi.mock('node:crypto', async () => {
  const crypto = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return { ...crypto, randomBytes: (size: number) => io.random === undefined ? crypto.randomBytes(size) : Buffer.alloc(size, io.random) };
});

const dirs: string[] = [];
const journals: EventJournal[] = [];
const children: ChildProcess[] = [];
const TIME = Date.UTC(2026, 0, 5);
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

afterEach(async () => {
  io.partialWrite = false;
  io.shortWrites = false;
  io.interruptWrite = false;
  io.failSync = false;
  io.failDirectorySync = false;
  io.random = undefined;
  vi.restoreAllMocks();
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit');
      child.kill('SIGKILL');
      await ended;
    }
  }));
  for (const journal of journals.splice(0)) journal.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  io.operations = [];
  io.paths.clear();
});

function root(): string {
  const dir = mkdtempSync(join(process.cwd(), '.hub-journal-test-'));
  dirs.push(dir);
  return dir;
}

function open(dir = root(), now: () => number = () => TIME): EventJournal {
  const journal = new EventJournal(dir, now);
  journals.push(journal);
  return journal;
}

function sha(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function failure(action: () => unknown, code: JournalErrorCode, line?: number): JournalError {
  try { action(); }
  catch (error) {
    expect(error).toBeInstanceOf(JournalError);
    expect(error).toMatchObject({ code, ...(line === undefined ? {} : { line }) });
    if (line !== undefined) expect((error as Error).message).toContain(`line ${line}`);
    return error as JournalError;
  }
  throw new Error('Expected journal failure');
}

function idValue(id: string): bigint {
  let value = 0n;
  for (const char of id) value = value * 32n + BigInt(ALPHABET.indexOf(char));
  return value;
}

function seeded(): { dir: string; path: string; lines: string[] } {
  const dir = root();
  const journal = open(dir);
  for (let i = 0; i < 3; i++) journal.append({ type: 'note', data: { value: i } });
  journal.close();
  return { dir, path: journal.path, lines: readFileSync(journal.path, 'utf8').trimEnd().split('\n') };
}

/** Re-sign a fabricated stream so semantic failures are reached after digest verification. */
function sign(events: JournalEvent[]): string {
  let prev = JOURNAL_GENESIS;
  return events.map((event, i) => {
    const { type, data, key, id, at } = event;
    const unsigned = { seq: i + 1, id, at, type, data, ...(key === undefined ? {} : { key }), prev };
    const line = JSON.stringify({ ...unsigned, hash: sha(JSON.stringify(unsigned) + '\n') }) + '\n';
    prev = sha(line);
    return line;
  }).join('');
}

describe('event journal', () => {
  it('appends contiguous, durable events with hashes of exact UTF-8 lines', () => {
    const dir = root();
    const journal = open(join(dir, 'state', 'nested'));
    expect(io.operations.filter(op => op === 'sync directory').length).toBeGreaterThanOrEqual(4);
    journal.load();
    io.operations = [];
    const first = journal.append({ type: 'note', data: { text: 'A line\nwith snow: 雪' } });
    const second = journal.append({ type: 'incident', data: null, key: 'demo-incident' });
    expect(io.operations).toEqual(['write file', 'sync file', 'write file', 'sync file']);
    const lines = readFileSync(journal.path, 'utf8').match(/[^\n]*\n/g)!;
    expect(lines).toHaveLength(2);
    expect(first).toMatchObject({ seq: 1, at: new Date(TIME).toISOString(), prev: JOURNAL_GENESIS });
    expect(second).toMatchObject({ seq: 2, prev: sha(Buffer.from(lines[0]!)) });
    expect(second.prev).not.toBe(sha(lines[0]!.slice(0, -1)));
    for (const event of [first, second]) {
      const { hash, ...unsigned } = event;
      expect(hash).toBe(sha(JSON.stringify(unsigned) + '\n'));
    }
    expect(journal.load()).toEqual([first, second]);
    expect(journal.append({ type: 'note', data: false }).seq).toBe(3);
    expect(journal.load()).toHaveLength(3);
  });

  it.each([
    ['edited line', 'bad-hash', (lines: string[]) => { const event = JSON.parse(lines[1]!); event.data.value = 99; lines[1] = JSON.stringify(event); }],
    ['deleted line', 'bad-seq', (lines: string[]) => { lines.splice(1, 1); }],
    ['lines out of order', 'bad-seq', (lines: string[]) => { [lines[1], lines[2]] = [lines[2]!, lines[1]!]; }],
    ['bad JSON', 'invalid-json', (lines: string[]) => { lines[1] = '{"broken":'; }],
    ['bad prev', 'bad-prev', (lines: string[]) => { const event = JSON.parse(lines[1]!); event.prev = 'f'.repeat(64); lines[1] = JSON.stringify(event); }],
    ['bad hash', 'bad-hash', (lines: string[]) => { const event = JSON.parse(lines[1]!); event.hash = 'f'.repeat(64); lines[1] = JSON.stringify(event); }],
    ['changed whitespace', 'bad-hash', (lines: string[]) => { lines[1] = ' ' + lines[1]!; }],
    ['empty line', 'invalid-json', (lines: string[]) => { lines[1] = ''; }],
    ['invalid event', 'invalid-event', (lines: string[]) => { const event = JSON.parse(lines[1]!); event.at = 'not-a-date'; lines[1] = JSON.stringify(event); }],
    ['sequence gap', 'bad-seq', (lines: string[]) => { const event = JSON.parse(lines[1]!); event.seq = 8; lines[1] = JSON.stringify(event); }],
  ] as const)('fails closed on %s at the first bad line', (_name, code, mutate) => {
    const { dir, path, lines } = seeded();
    mutate(lines);
    const raw = lines.join('\n') + '\n';
    writeFileSync(path, raw);
    const journal = open(dir);
    failure(() => journal.load(), code, 2);
    failure(() => journal.all(), code, 2);
    failure(() => journal.byType('note'), code, 2);
    failure(() => journal.byTaskId('demo-task'), code, 2);
    failure(() => journal.afterSeq(0), code, 2);
    failure(() => journal.append({ type: 'note', data: null }), code, 2);
    failure(() => journal.repairTornTail(), code, 2);
    expect(readFileSync(path, 'utf8')).toBe(raw);
  });

  it('rejects a wrong genesis at line one before examining later damage', () => {
    const { dir, path, lines } = seeded();
    const first = JSON.parse(lines[0]!);
    first.prev = '1'.repeat(64);
    lines[0] = JSON.stringify(first);
    lines[1] = 'bad JSON';
    writeFileSync(path, lines.join('\n') + '\n');
    failure(() => open(dir).load(), 'bad-prev', 1);
  });

  it('rejects malformed UTF-8 even inside a JSON string', () => {
    const { dir, path, lines } = seeded();
    writeFileSync(path, Buffer.concat([Buffer.from(lines[0]! + '\n{"text":"'), Buffer.from([0xff]), Buffer.from('"}\n')]));
    failure(() => open(dir).load(), 'invalid-json', 2);
  });

  it.each(['{"type":', 'complete', 'multibyte'])('reports a %s torn tail and requires explicit repair', kind => {
    const { dir, path, lines } = seeded();
    const prefix = lines.slice(0, 2).join('\n') + '\n';
    const tail = kind === 'complete' ? Buffer.from(lines[2]!) : kind === 'multibyte' ? Buffer.from([0xe9, 0x9b]) : Buffer.from(kind);
    const raw = Buffer.concat([Buffer.from(prefix), tail]);
    writeFileSync(path, raw);
    const journal = open(dir);
    const error = failure(() => journal.load(), 'torn-tail', 3);
    expect(error).toBeInstanceOf(JournalTornTailError);
    expect(error).toMatchObject({ offset: Buffer.byteLength(prefix), bytes: tail.length });
    failure(() => journal.append({ type: 'note', data: null }), 'torn-tail', 3);
    expect(readFileSync(path)).toEqual(raw);
    io.operations = [];
    expect(journal.repairTornTail()).toEqual({ line: 3, offset: Buffer.byteLength(prefix), bytes: tail.length });
    expect(io.operations).toEqual(['truncate file', 'sync file', 'sync file']);
    expect(readFileSync(path, 'utf8')).toBe(prefix);
    expect(journal.all()).toHaveLength(2);
    expect(journal.append({ type: 'note', data: 'repaired' }).seq).toBe(3);
    expect(journal.load()).toHaveLength(3);
    expect(journal.repairTornTail()).toBeUndefined();
  });

  it('can explicitly repair a torn first line to an empty journal', () => {
    const dir = root();
    writeFileSync(join(dir, 'journal.jsonl'), '{');
    const journal = open(dir);
    failure(() => journal.load(), 'torn-tail', 1);
    expect(journal.repairTornTail()).toEqual({ line: 1, offset: 0, bytes: 1 });
    expect(journal.append({ type: 'note', data: [] })).toMatchObject({ seq: 1, prev: JOURNAL_GENESIS });
  });

  it('refuses to repair a torn tail when an earlier complete line is corrupt', () => {
    const { dir, path, lines } = seeded();
    writeFileSync(path, lines[0]! + '\nnot JSON\n{"torn":');
    const raw = readFileSync(path);
    const journal = open(dir);
    failure(() => journal.repairTornTail(), 'invalid-json', 2);
    expect(readFileSync(path)).toEqual(raw);
  });

  it('replays keys without a write, including after restart and with reordered JSON keys', () => {
    const dir = root();
    let journal = open(dir);
    const first = journal.append({ type: 'note', data: { b: [2, 3], a: { y: true, x: null } }, key: '' });
    const raw = readFileSync(journal.path);
    io.operations = [];
    expect(journal.append({ type: 'note', data: { a: { x: null, y: true }, b: [2, 3] }, key: '' })).toBe(first);
    expect(io.operations).toEqual([]);
    expect(readFileSync(journal.path)).toEqual(raw);
    journal.close();
    journal = open(dir);
    journal.load();
    io.operations = [];
    expect(journal.append({ type: 'note', data: first.data, key: '' })).toEqual(first);
    expect(io.operations).toEqual([]);
    expect(journal.append({ type: 'note', data: null, key: 'next' }).seq).toBe(2);
  });

  it.each(['type', 'data'] as const)('rejects an idempotency key with conflicting %s', changed => {
    const journal = open();
    journal.append({ type: 'note', data: { value: 1 }, key: 'demo-key' });
    const raw = readFileSync(journal.path);
    io.operations = [];
    failure(() => journal.append({ type: changed === 'type' ? 'incident' : 'note', data: { value: changed === 'data' ? 2 : 1 }, key: 'demo-key' }), 'key-conflict');
    expect(io.operations).toEqual([]);
    expect(readFileSync(journal.path)).toEqual(raw);
    expect(journal.all()).toHaveLength(1);
  });

  it('keeps caller mutations out of stored events and indexes', () => {
    const journal = open();
    const data = { taskId: 'demo-task', nested: { items: [1] } };
    const event = journal.append({ type: 'start', data });
    data.taskId = 'other-task';
    data.nested.items.push(2);
    expect(event.data).toEqual({ taskId: 'demo-task', nested: { items: [1] } });
    expect(() => { (event.data as typeof data).nested.items.push(3); }).toThrow();
    expect(() => { (event as { type: string }).type = 'incident'; }).toThrow();
    const all = journal.all() as JournalEvent[];
    all.pop();
    expect(journal.byTaskId('demo-task')).toEqual([event]);
    expect(journal.all()).toEqual([event]);
  });

  it.each([undefined, NaN, Infinity, 1n, () => null, new Date(TIME), { x: undefined }, [undefined], Array(1)])('rejects non-JSON input %s without writing', data => {
    const journal = open();
    journal.load();
    io.operations = [];
    failure(() => journal.append({ type: 'note', data: data as JsonValue }), 'invalid-input');
    expect(io.operations).toEqual([]);
    expect(journal.all()).toEqual([]);
  });

  it('rejects cyclic JSON but accepts shared acyclic values', () => {
    const journal = open();
    const cyclic: Record<string, JsonValue> = {};
    cyclic.self = cyclic;
    failure(() => journal.append({ type: 'note', data: cyclic }), 'invalid-input');
    const shared = { value: 1 };
    expect(journal.append({ type: 'note', data: [shared, shared] }).data).toEqual([{ value: 1 }, { value: 1 }]);
  });

  it('rejects unknown tasks, duplicate result ids and already resolved tasks after reload', () => {
    const dir = root();
    let journal = open(dir);
    failure(() => journal.commitResult('unknown-task', 'demo-result', null), 'unknown-task');
    journal.append({ type: 'start', data: { taskId: 'demo-task-a' } });
    journal.append({ type: 'start', data: { taskId: 'demo-task-b' } });
    const result = journal.commitResult('demo-task-a', 'demo-result', { answer: 42 });
    expect(result).toMatchObject({ type: 'result', data: { taskId: 'demo-task-a', resultId: 'demo-result', data: { answer: 42 } } });
    const raw = readFileSync(journal.path);
    const guards = () => {
      failure(() => journal.commitResult('unknown-task', 'new-result', null), 'unknown-task');
      failure(() => journal.commitResult('demo-task-b', 'demo-result', null), 'duplicate-result');
      failure(() => journal.commitResult('demo-task-a', 'new-result', null), 'task-resolved');
      failure(() => journal.commitResult('demo-task-a', 'demo-result', null), 'duplicate-result');
      expect(readFileSync(journal.path)).toEqual(raw);
    };
    guards();
    journal.close();
    journal = open(dir);
    journal.load();
    guards();
    journal.append({ type: 'start', data: { taskId: 'demo-task-a' } });
    failure(() => journal.commitResult('demo-task-a', 'another-result', null), 'task-resolved');
    expect(journal.commitResult('demo-task-b', 'other-result', false).seq).toBe(5);
  });

  it('enforces result guards for direct appends while allowing exact keyed replay', () => {
    const journal = open();
    failure(() => journal.append({ type: 'start', data: {} }), 'invalid-input');
    failure(() => journal.append({ type: 'result', data: { taskId: 'unknown-task', resultId: 'demo-result', data: null } }), 'unknown-task');
    journal.append({ type: 'start', data: { taskId: 'demo-task' } });
    const input = { type: 'result', key: 'demo-key', data: { taskId: 'demo-task', resultId: 'demo-result', data: null } };
    const result = journal.append(input);
    expect(journal.append(input)).toBe(result);
    failure(() => journal.append({ type: 'result', data: { taskId: 'demo-task', resultId: 'new-result', data: null } }), 'task-resolved');
  });

  it.each(['duplicate-id', 'key-conflict', 'unknown-task', 'duplicate-result', 'task-resolved'] as const)('verifies %s invariants when loading a correctly signed stream', reason => {
    const { dir, path, lines } = seeded();
    const events = lines.map(line => JSON.parse(line) as { -readonly [K in keyof JournalEvent]: JournalEvent[K] });
    let line = 2;
    if (reason === 'duplicate-id') events[1]!.id = events[0]!.id;
    else if (reason === 'key-conflict') { events[0]!.key = 'demo-key'; events[1]!.key = 'demo-key'; }
    else if (reason === 'unknown-task') {
      events[1]!.type = 'result';
      events[1]!.data = { data: null, resultId: 'demo-result', taskId: 'unknown-task' };
    } else {
      line = 3;
      events[0]!.type = 'start';
      events[0]!.data = { taskId: 'demo-task' };
      events[1]!.type = 'result';
      events[1]!.data = { data: null, resultId: 'demo-result', taskId: 'demo-task' };
      events[2]!.type = 'result';
      events[2]!.data = { data: null, resultId: reason === 'duplicate-result' ? 'demo-result' : 'new-result', taskId: 'demo-task' };
    }
    writeFileSync(path, sign(events));
    failure(() => open(dir).load(), reason, line);
  });

  it('rebuilds type, task and sequence indexes on load', () => {
    const dir = root();
    let journal = open(dir);
    const events = [
      journal.append({ type: 'start', data: { taskId: 'demo-task-a' } }),
      journal.append({ type: 'incident', data: { taskId: 'demo-task-b' } }),
      journal.append({ type: 'note', data: { taskId: 'demo-task-a' } }),
      journal.commitResult('demo-task-a', 'demo-result', null),
    ];
    const check = () => {
      expect(journal.byType('start')).toEqual([events[0]]);
      expect(journal.byType('missing')).toEqual([]);
      expect(journal.byTaskId('demo-task-a')).toEqual([events[0], events[2], events[3]]);
      expect(journal.byTaskId('missing')).toEqual([]);
      expect(journal.afterSeq(0)).toEqual(events);
      expect(journal.afterSeq(2)).toEqual(events.slice(2));
      expect(journal.afterSeq(4)).toEqual([]);
      expect(journal.afterSeq(99)).toEqual([]);
      failure(() => journal.afterSeq(-1), 'invalid-input');
    };
    check();
    journal.close();
    journal = open(dir);
    journal.load();
    check();
    journal.load();
    check();
  });

  it('refuses a second writer through the same path or a directory alias and releases on close', () => {
    const dir = root();
    const journal = open(dir);
    const lock = readFileSync(`${journal.path}.lock`);
    failure(() => open(dir), 'locked');
    const alias = join(root(), 'alias');
    symlinkSync(dir, alias);
    failure(() => open(alias), 'locked');
    expect(readFileSync(`${journal.path}.lock`)).toEqual(lock);
    journal.close();
    journal.close();
    expect(existsSync(`${journal.path}.lock`)).toBe(false);
    expect(open(dir).append({ type: 'note', data: null }).seq).toBe(1);
    failure(() => journal.append({ type: 'note', data: null }), 'closed');
    failure(() => journal.load(), 'closed');
    failure(() => journal.repairTornTail(), 'closed');
  });

  it('checks the pid and recovers a lock only after its writer has died', async () => {
    const dir = root();
    const module = new URL('../src/hub/journal.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { EventJournal } from ${JSON.stringify(module)};
      process.on('message', ({ dir }) => {
        const journal = new EventJournal(dir);
        journal.append({ type: 'note', data: 'persisted before crash' });
        process.send('held');
      });
      process.send('ready');
    `], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.push(child);
    expect((await once(child, 'message'))[0]).toBe('ready');
    const held = once(child, 'message');
    child.send({ dir });
    expect((await held)[0]).toBe('held');
    failure(() => open(dir), 'locked');
    const ended = once(child, 'exit');
    child.kill('SIGKILL');
    await ended;
    const checkPid = vi.spyOn(process, 'kill');
    const journal = open(dir);
    expect(checkPid).toHaveBeenCalledWith(child.pid, 0);
    expect(journal.load()[0]?.data).toBe('persisted before crash');
    expect(JSON.parse(readFileSync(`${journal.path}.lock`, 'utf8')).pid).toBe(process.pid);
    failure(() => open(dir), 'locked');
  });

  it.each([false, true])('publishes a verifiable owner before a crash at lock creation (recovery=%s)', async recovery => {
    const dir = root();
    const path = join(dir, 'journal.jsonl.lock');
    const module = new URL('../src/hub/journal.ts', import.meta.url).href;
    if (recovery) {
      const writer = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        import { EventJournal } from ${JSON.stringify(module)};
        new EventJournal(${JSON.stringify(dir)}).append({ type: 'note', data: 'before crash' });
        process.send('held');
        setInterval(() => {}, 1000);
      `], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      children.push(writer);
      expect((await once(writer, 'message', { signal: AbortSignal.timeout(5000) }))[0]).toBe('held');
      const ended = once(writer, 'exit');
      writer.kill('SIGKILL');
      await ended;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const contender = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const pause = () => {
          process.send('published');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        };
        const originalOpen = fs.openSync;
        fs.openSync = (...args) => {
          const fd = originalOpen(...args);
          if (String(args[0]) === ${JSON.stringify(path)} && (args[1] & fs.constants.O_CREAT)) pause();
          return fd;
        };
        const originalLink = fs.linkSync;
        fs.linkSync = (...args) => {
          originalLink(...args);
          if (String(args[1]) === ${JSON.stringify(path)}) pause();
        };
        syncBuiltinESMExports();
        const { EventJournal } = await import(${JSON.stringify(module)});
        new EventJournal(${JSON.stringify(dir)});
      `], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      children.push(contender);
      expect((await once(contender, 'message', { signal: AbortSignal.timeout(5000) }))[0]).toBe('published');
      const owner = readFileSync(path, 'utf8');
      expect(JSON.parse(owner)).toEqual({ pid: contender.pid });
      failure(() => open(dir), 'locked');
      expect(readFileSync(path, 'utf8')).toBe(owner);
      const ended = once(contender, 'exit');
      contender.kill('SIGKILL');
      await ended;
    }
    const checkPid = vi.spyOn(process, 'kill');
    const journal = open(dir);
    expect(checkPid).toHaveBeenCalledWith(children.at(-1)!.pid, 0);
    expect(journal.load().map(event => event.data)).toEqual(recovery ? ['before crash'] : []);
    expect(journal.append({ type: 'note', data: 'after recovery' }).seq).toBe(recovery ? 2 : 1);
    expect(readdirSync(dir).filter(name => name.includes('.recovery'))).toEqual([]);
  });

  it.each(['broken JSON', '{"pid":0}', '{"pid":-1}', '{"pid":"123"}', '{"pid":2147483648}', '{}'])('refuses an unverifiable lock %s without removing it', raw => {
    const dir = root();
    const path = join(dir, 'journal.jsonl.lock');
    writeFileSync(path, raw);
    failure(() => open(dir), 'locked');
    expect(readFileSync(path, 'utf8')).toBe(raw);
  });

  it('treats permission failure in the pid check as a live writer', () => {
    const dir = root();
    const path = join(dir, 'journal.jsonl.lock');
    writeFileSync(path, JSON.stringify({ pid: 123456 }));
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Permission denied'), { code: 'EPERM' }); });
    failure(() => open(dir), 'locked');
    expect(existsSync(path)).toBe(true);
  });

  it('refuses to remove a lock replaced during a dead-pid check', () => {
    const dir = root();
    const path = join(dir, 'journal.jsonl.lock');
    writeFileSync(path, JSON.stringify({ pid: 123456 }));
    vi.spyOn(process, 'kill').mockImplementation(() => {
      rmSync(path);
      writeFileSync(path, JSON.stringify({ pid: process.pid }));
      throw Object.assign(new Error('Process absent'), { code: 'ESRCH' });
    });
    failure(() => open(dir), 'locked');
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid);
  });

  it('refuses a writer through a hard-linked journal alias without changing the journal', () => {
    const journal = open();
    journal.append({ type: 'note', data: 'first' });
    const alias = root();
    linkSync(journal.path, join(alias, 'journal.jsonl'));
    const raw = readFileSync(journal.path);
    expect(() => open(alias)).toThrow('Journal must not have multiple hard links');
    expect(existsSync(join(alias, 'journal.jsonl.lock'))).toBe(false);
    expect(readFileSync(journal.path)).toEqual(raw);
    expect(journal.append({ type: 'note', data: 'second' }).seq).toBe(2);
    expect(journal.load()).toHaveLength(2);
  });

  it.each([false, true])('recovers after a crash before writing the ownership claim (recovery=%s)', async recovery => {
    const dir = root();
    const module = new URL('../src/hub/journal.ts', import.meta.url).href;
    let writer: ChildProcess | undefined;
    if (recovery) {
      writer = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        import { EventJournal } from ${JSON.stringify(module)};
        const journal = new EventJournal(${JSON.stringify(dir)});
        journal.append({ type: 'note', data: 'persisted before crash' });
        process.send('held');
        setInterval(() => {}, 1000);
      `], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      children.push(writer);
      expect((await once(writer, 'message', { signal: AbortSignal.timeout(5000) }))[0]).toBe('held');
      const writerEnded = once(writer, 'exit');
      writer.kill('SIGKILL');
      await writerEnded;
    }
    const checkPid = vi.spyOn(process, 'kill');

    for (let attempt = 0; attempt < 2; attempt++) {
      const contender = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const original = fs.openSync;
        fs.openSync = (...args) => {
          const fd = original(...args);
          if (String(args[0]).includes('journal.jsonl.lock.recovery')) {
            process.send('recovering');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          }
          return fd;
        };
        syncBuiltinESMExports();
        const { EventJournal } = await import(${JSON.stringify(module)});
        new EventJournal(${JSON.stringify(dir)});
      `], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      children.push(contender);
      expect((await once(contender, 'message', { signal: AbortSignal.timeout(5000) }))[0]).toBe('recovering');
      const lockPath = join(dir, 'journal.jsonl.lock');
      const lock = recovery ? readFileSync(lockPath) : undefined;
      failure(() => open(dir), 'locked');
      if (recovery) expect(readFileSync(lockPath)).toEqual(lock);
      else expect(existsSync(lockPath)).toBe(false);
      const ended = once(contender, 'exit');
      contender.kill('SIGKILL');
      await ended;
    }

    const journal = open(dir);
    if (writer) expect(checkPid).toHaveBeenCalledWith(writer.pid, 0);
    for (const contender of children.slice(writer ? 1 : 0)) expect(checkPid).toHaveBeenCalledWith(contender.pid, 0);
    expect(journal.load().map(event => event.data)).toEqual(recovery ? ['persisted before crash'] : []);
    expect(journal.append({ type: 'note', data: 'after recovery' }).seq).toBe(recovery ? 2 : 1);
    expect(readdirSync(dir).filter(name => name.includes('.recovery'))).toEqual([]);
    failure(() => open(dir), 'locked');
  });

  it('rejects a FIFO lock without blocking or modifying it', async () => {
    const dir = root();
    const path = join(dir, 'journal.jsonl.lock');
    execFileSync('mkfifo', [path]);
    const module = new URL('../src/hub/journal.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { EventJournal } from ${JSON.stringify(module)};
      let result;
      try { new EventJournal(${JSON.stringify(dir)}); result = { name: 'accepted' }; }
      catch (error) { result = { name: error.name, code: error.code }; }
      process.send(result, () => process.exit(0));
    `], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.push(child);
    expect((await once(child, 'message', { signal: AbortSignal.timeout(5000) }))[0]).toEqual({ name: 'JournalError', code: 'locked' });
    expect(lstatSync(path).isFIFO()).toBe(true);
    expect(readdirSync(dir)).toEqual(['journal.jsonl.lock']);
  });

  it('refuses competing live recovery before checking or deleting the writer lock', () => {
    const dir = root();
    const path = join(dir, 'journal.jsonl.lock');
    writeFileSync(path, '{"pid":123456}');
    writeFileSync(`${path}.recovery.${process.pid}.${'0'.repeat(32)}`, '');
    const checkPid = vi.spyOn(process, 'kill');
    failure(() => open(dir), 'locked');
    expect(checkPid).toHaveBeenCalledWith(process.pid, 0);
    expect(checkPid).not.toHaveBeenCalledWith(123456, 0);
    expect(readFileSync(path, 'utf8')).toBe('{"pid":123456}');
  });

  it('does not remove a replacement lock during close', () => {
    const dir = root();
    const journal = open(dir);
    rmSync(`${journal.path}.lock`);
    writeFileSync(`${journal.path}.lock`, '{"pid":123456}');
    journal.close();
    expect(readFileSync(`${journal.path}.lock`, 'utf8')).toBe('{"pid":123456}');
  });

  it('generates Crockford ULIDs with 48-bit time and monotonically incremented 80-bit randomness', () => {
    io.random = 0;
    let time = TIME;
    const dir = root();
    let journal = open(dir, () => time);
    const ids = Array.from({ length: 100 }, () => journal.append({ type: 'note', data: null }).id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(100);
    for (const [i, id] of ids.entries()) {
      expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
      expect(idValue(id) >> 80n).toBe(BigInt(TIME));
      expect(idValue(id) & ((1n << 80n) - 1n)).toBe(BigInt(i));
    }
    journal.close();
    journal = open(dir, () => time);
    expect(idValue(journal.append({ type: 'note', data: null }).id)).toBe(idValue(ids.at(-1)!) + 1n);
    time--;
    const backwards = journal.append({ type: 'note', data: null });
    expect(idValue(backwards.id)).toBe(idValue(ids.at(-1)!) + 2n);
    expect(backwards.at).toBe(new Date(time).toISOString());
    time = TIME + 1;
    io.random = 0x5a;
    const next = journal.append({ type: 'note', data: null });
    expect(idValue(next.id) >> 80n).toBe(BigInt(time));
    expect(idValue(next.id) & ((1n << 80n) - 1n)).toBe(BigInt('0x' + '5a'.repeat(10)));
  });

  it('rejects random overflow within a millisecond without writing and resumes at the next millisecond', () => {
    io.random = 0xff;
    let time = TIME;
    const journal = open(root(), () => time);
    journal.append({ type: 'note', data: null });
    const raw = readFileSync(journal.path);
    failure(() => journal.append({ type: 'note', data: null }), 'ulid-overflow');
    expect(readFileSync(journal.path)).toEqual(raw);
    time++;
    expect(journal.append({ type: 'note', data: null }).seq).toBe(2);
  });

  it.each([-1, 2 ** 48, 1.5, NaN])('rejects time outside the ULID range: %s', time => {
    const journal = open(root(), () => time);
    failure(() => journal.append({ type: 'note', data: null }), 'invalid-input');
    expect(readFileSync(journal.path, 'utf8')).toBe('');
  });

  it('retries interrupted and short writes before fsync', () => {
    const journal = open();
    journal.load();
    io.operations = [];
    io.interruptWrite = true;
    io.shortWrites = true;
    const event = journal.append({ type: 'note', data: 'short writes' });
    expect(io.operations.at(-1)).toBe('sync file');
    expect(io.operations.filter(op => op === 'write file').length).toBeGreaterThan(2);
    expect(journal.load()).toEqual([event]);
  });

  it('blocks further writes after a partial append until explicit tail repair', () => {
    const journal = open();
    const first = journal.append({ type: 'note', data: null });
    const prefix = readFileSync(journal.path);
    io.partialWrite = true;
    expect(() => journal.append({ type: 'note', data: 'partial' })).toThrow('Partial write');
    const raw = readFileSync(journal.path);
    expect(raw.length).toBe(prefix.length + 20);
    failure(() => journal.all(), 'torn-tail', 2);
    failure(() => journal.append({ type: 'note', data: 'next' }), 'torn-tail', 2);
    expect(readFileSync(journal.path)).toEqual(raw);
    journal.repairTornTail();
    expect(journal.all()).toEqual([first]);
    expect(journal.append({ type: 'note', data: 'next' }).seq).toBe(2);
  });

  it('verifies and fsyncs an uncertain complete append before keyed replay', () => {
    const journal = open();
    journal.load();
    io.failSync = true;
    const input = { type: 'note', data: 'uncertain', key: 'demo-key' };
    expect(() => journal.append(input)).toThrow('File sync failed');
    const raw = readFileSync(journal.path);
    io.operations = [];
    const event = journal.append(input);
    expect(io.operations).toEqual(['sync file']);
    expect(event.seq).toBe(1);
    expect(readFileSync(journal.path)).toEqual(raw);
    expect(journal.append({ type: 'note', data: 'next' }).seq).toBe(2);
  });

  it('releases ownership after a constructor durability failure', () => {
    const dir = root();
    io.failSync = true;
    expect(() => open(dir)).toThrow('File sync failed');
    expect(existsSync(join(dir, 'journal.jsonl.lock'))).toBe(false);
    expect(open(dir).load()).toEqual([]);
  });

  it('releases ownership when syncing the lock directory fails', () => {
    const dir = root();
    io.failDirectorySync = true;
    expect(() => open(dir)).toThrow('Directory sync failed');
    expect(existsSync(join(dir, 'journal.jsonl.lock'))).toBe(false);
    expect(open(dir).load()).toEqual([]);
  });

  it('verifies and indexes 10,000 events in under two seconds', () => {
    const dir = root();
    let journal = open(dir);
    for (let i = 0; i < 10_000; i++) journal.append({ type: i % 2 ? 'note' : 'incident', data: { taskId: `demo-task-${i % 10}`, value: i }, key: `demo-key-${i}` });
    journal.close();
    journal = open(dir);
    const before = performance.now();
    const loaded = journal.load();
    const duration = performance.now() - before;
    expect(loaded).toHaveLength(10_000);
    expect(duration).toBeLessThan(2_000);
    expect(journal.byType('note')).toHaveLength(5_000);
    expect(journal.byTaskId('demo-task-0')).toHaveLength(1_000);
    expect(journal.afterSeq(9_999)[0]?.seq).toBe(10_000);
    expect(journal.append({ type: 'incident', data: { value: 0, taskId: 'demo-task-0' }, key: 'demo-key-0' }).seq).toBe(1);
    expect(journal.append({ type: 'note', data: null }).seq).toBe(10_001);
    console.info(`Journal load: 10,000 verified events in ${duration.toFixed(1)} ms`);
  }, 60_000);
});
