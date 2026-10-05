import { execFileSync } from 'node:child_process';
import { appendFileSync, constants, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBounded, readJsonBounded } from '../src/hub/safe-read.js';

const io = vi.hoisted(() => ({
  onOpen: undefined as ((file: FileHandle) => void) | undefined,
  files: [] as FileHandle[], handles: [] as FileHandle[],
}));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args);
    io.handles.push(file);
    if (typeof args[1] !== 'number' || !(args[1] & constants.O_DIRECTORY)) {
      io.files.push(file);
      io.onOpen?.(file);
    }
    return file;
  }), lstat: vi.fn(actual.lstat) };
});
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const trackedOpen = vi.mocked(fs.open).getMockImplementation()!;
const fileOpens = () => vi.mocked(fs.open).mock.calls.filter(([, flags]) => typeof flags !== 'number' || !(flags & constants.O_DIRECTORY));
const dirs: string[] = [];
function fixture(text = 'hello') {
  const temporary = join(process.cwd(), '.tmp');
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, 'safe-read-'));
  dirs.push(root);
  const path = join(root, 'data.txt');
  writeFileSync(path, text);
  return { root, path };
}
afterEach(async () => {
  io.onOpen = undefined;
  vi.restoreAllMocks();
  vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat);
  vi.mocked(fs.open).mockReset().mockImplementation(trackedOpen);
  expect(io.handles.every(file => file.fd === -1)).toBe(true);
  for (const file of io.handles.splice(0)) await file.close();
  io.files.length = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('bounded text reads', () => {
  it('reads a normal file with O_NOFOLLOW and reports actual UTF-8 bytes', async () => {
    const { path } = fixture('café 😀');
    expect(await readBounded(path, { maxBytes: 10 })).toEqual({ text: 'café 😀', bytes: 10, truncated: false });
    const flags = vi.mocked(fs.open).mock.calls[0]![1];
    if (typeof flags !== 'number') throw new Error('Expected numeric open flags');
    expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(io.files[0]!.fd).toBe(-1);
  });

  it.each([undefined, 'root'])('reads within an optional %s boundary', async boundary => {
    const { root, path } = fixture();
    mkdirSync(join(root, 'child'));
    const options = { maxBytes: 5, ...(boundary ? { root } : {}) };
    expect(await readBounded(relative(process.cwd(), path), options)).toEqual({ text: 'hello', bytes: 5, truncated: false });
    expect(await readBounded(`${root}/child/../data.txt`, options)).toEqual({ text: 'hello', bytes: 5, truncated: false });
  });

  it('reads empty files at a zero-byte cap', async () => {
    const { path } = fixture('');
    expect(await readBounded(path, { maxBytes: 0 })).toEqual({ text: '', bytes: 0, truncated: false });
    writeFileSync(path, 'x');
    expect(await readBounded(path, { maxBytes: 0 })).toEqual({ refused: true, reason: 'too-large' });
  });

  it('refuses an oversize file before issuing any read', async () => {
    const { path } = fixture('123456');
    let read: ReturnType<typeof vi.spyOn> | undefined;
    io.onOpen = file => { read = vi.spyOn(file, 'read'); };
    expect(await readBounded(path, { maxBytes: 5 })).toEqual({ refused: true, reason: 'too-large' });
    expect(read).not.toHaveBeenCalled();
    expect(io.files[0]!.fd).toBe(-1);
  });

  it('stops at maxBytes + 1 if a file grows after fstat', async () => {
    const { path } = fixture('x'.repeat(65_536));
    const lengths: number[] = [];
    let bytes = 0;
    io.onOpen = file => {
      const read = file.read.bind(file);
      vi.spyOn(file, 'read').mockImplementation((async (buffer: Buffer, offset: number, length: number, position: null) => {
        lengths.push(length);
        if (lengths.length === 2) appendFileSync(path, 'y'.repeat(100));
        const result = await read(buffer, offset, length, position);
        bytes += result.bytesRead;
        return result;
      }) as typeof file.read);
    };
    expect(await readBounded(path, { maxBytes: 65_536 })).toEqual({ refused: true, reason: 'too-large' });
    expect(lengths).toEqual([65_536, 1]);
    expect(bytes).toBe(65_537);
    expect(io.files[0]!.fd).toBe(-1);
  });

  it('joins multiple chunks without corrupting a split Unicode character', async () => {
    const text = `${'x'.repeat(65_535)}😀tail`;
    const { path } = fixture(text);
    expect(await readBounded(path, { maxBytes: Buffer.byteLength(text) })).toEqual({ text, bytes: 65_543, truncated: false });
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('refuses invalid maxBytes %s before opening', async maxBytes => {
    const { path } = fixture();
    expect(await readBounded(path, { maxBytes })).toEqual({ refused: true, reason: 'invalid-options' });
    expect(fs.open).not.toHaveBeenCalled();
  });

  it('returns typed failures for invalid paths and filesystem errors', async () => {
    const { root } = fixture();
    expect(await readBounded('', { maxBytes: 5 })).toEqual({ refused: true, reason: 'invalid-options' });
    expect(await readBounded('bad\0path', { maxBytes: 5 })).toEqual({ refused: true, reason: 'invalid-options' });
    expect(await readBounded(join(root, 'missing'), { maxBytes: 5 })).toEqual({ refused: true, reason: 'io-error', code: 'ENOENT' });
  });

  it('closes the descriptor after a read error', async () => {
    const { path } = fixture();
    io.onOpen = file => { vi.spyOn(file, 'read').mockRejectedValue(Object.assign(new Error('Read failed'), { code: 'EIO' })); };
    expect(await readBounded(path, { maxBytes: 5 })).toEqual({ refused: true, reason: 'io-error', code: 'EIO' });
    expect(io.files[0]!.fd).toBe(-1);
  });
});

describe('safe file and directory checks', () => {
  it.each([false, true])('refuses a symlink file with root supplied: %s', async bounded => {
    const { root, path } = fixture();
    const link = join(root, 'link');
    symlinkSync(path, link);
    expect(await readBounded(link, { maxBytes: 5, ...(bounded ? { root } : {}) })).toEqual({ refused: true, reason: 'symlink' });
    expect(fileOpens()).toHaveLength(0);
  });

  it('refuses dangling symlinks', async () => {
    const { root } = fixture();
    const link = join(root, 'link');
    symlinkSync(join(root, 'missing'), link);
    expect(await readBounded(link, { maxBytes: 5 })).toEqual({ refused: true, reason: 'symlink' });
  });

  it('uses O_NOFOLLOW when a regular entry is replaced by a symlink before open', async () => {
    const { root, path } = fixture();
    const other = join(root, 'other.txt');
    writeFileSync(other, 'hello');
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (typeof args[1] === 'number' && !(args[1] & constants.O_DIRECTORY)) {
        unlinkSync(path);
        symlinkSync(other, path);
      }
      return trackedOpen(...args);
    });
    expect(await readBounded(path, { root, maxBytes: 5 })).toEqual({ refused: true, reason: 'symlink', code: 'ELOOP' });
  });

  it.each(['inside', 'outside'])('refuses symlinked parents targeting %s root', async target => {
    const { root } = fixture();
    const other = target === 'inside' ? root : fixture().root;
    const link = join(root, 'linked');
    symlinkSync(other, link, 'dir');
    expect(await readBounded(join(link, 'data.txt'), { root, maxBytes: 5 })).toEqual({ refused: true, reason: 'symlink' });
    expect(fileOpens()).toHaveLength(0);
  });

  it('checks a symlink component before .. can normalize it away', async () => {
    const { root } = fixture();
    symlinkSync(root, join(root, 'linked'), 'dir');
    expect(await readBounded(`${root}/linked/../data.txt`, { root, maxBytes: 5 })).toEqual({ refused: true, reason: 'symlink' });
  });

  it('refuses a symlink root and symlink ancestors of root', async () => {
    const { root } = fixture();
    mkdirSync(join(root, 'child'));
    writeFileSync(join(root, 'child', 'data.txt'), 'hello');
    const link = join(root, 'linked');
    symlinkSync(root, link, 'dir');
    for (const boundary of [link, join(link, 'child')]) {
      expect(await readBounded(join(boundary, 'data.txt'), { root: boundary, maxBytes: 5 })).toEqual({ refused: true, reason: 'symlink' });
    }
  });

  it('refuses paths escaping root via .. and similarly prefixed siblings', async () => {
    const { root } = fixture();
    const boundary = join(root, 'allowed');
    mkdirSync(boundary);
    mkdirSync(join(root, 'allowed-other'));
    writeFileSync(join(root, 'allowed-other', 'data.txt'), 'hello');
    for (const path of [`${boundary}/../data.txt`, join(root, 'allowed-other', 'data.txt')]) {
      expect(await readBounded(path, { root: boundary, maxBytes: 5 })).toEqual({ refused: true, reason: 'outside-root' });
    }
    expect(fileOpens()).toHaveLength(0);
  });

  it('keeps the file bound to its checked parent during repeated directory swaps', async () => {
    const { root } = fixture();
    const outside = fixture('other').root;
    const parent = join(root, 'parent');
    const saved = join(root, 'saved');
    mkdirSync(parent);
    const path = join(parent, 'data.txt');
    writeFileSync(path, 'hello');
    const swap = () => {
      renameSync(parent, saved);
      symlinkSync(outside, parent, 'dir');
    };
    const restore = () => {
      unlinkSync(parent);
      renameSync(saved, parent);
    };
    let opened = false;
    let swaps = 0;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const content = typeof args[1] === 'number' && !(args[1] & constants.O_DIRECTORY);
      if (content) { swap(); swaps++; }
      try {
        const file = await actual.open(...args);
        io.handles.push(file);
        if (content) { io.files.push(file); opened = true; }
        return file;
      } finally {
        if (content) restore();
      }
    });
    vi.mocked(fs.lstat).mockImplementation((async (...args: Parameters<typeof actual.lstat>) => {
      const swapAgain = args[0] === path && opened;
      if (swapAgain) { swap(); swaps++; }
      try {
        return await actual.lstat(...args);
      } finally {
        if (swapAgain) restore();
      }
    }) as typeof fs.lstat);
    for (let attempt = 0; attempt < 8; attempt++) {
      opened = false;
      expect(await readBounded(path, { root, maxBytes: 5 })).toEqual({ text: 'hello', bytes: 5, truncated: false });
    }
    expect(swaps).toBeGreaterThanOrEqual(8);
    expect(io.handles.every(file => file.fd === -1)).toBe(true);
  });

  it('refuses a symlink swapped in between checking and opening a parent component', async () => {
    const { root } = fixture();
    const outside = fixture('other').root;
    const parent = join(root, 'parent');
    const saved = join(root, 'saved');
    mkdirSync(parent);
    const path = join(parent, 'data.txt');
    writeFileSync(path, 'hello');
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (typeof args[0] !== 'string' || !args[0].endsWith('/parent')) return trackedOpen(...args);
      renameSync(parent, saved);
      symlinkSync(outside, parent, 'dir');
      try {
        return await trackedOpen(...args);
      } finally {
        unlinkSync(parent);
        renameSync(saved, parent);
      }
    });
    expect(await readBounded(path, { root, maxBytes: 5 })).toEqual({ refused: true, reason: 'io-error', code: 'ENOTDIR' });
    expect(fileOpens()).toHaveLength(0);
  });

  it('refuses directories without opening them', async () => {
    const { root } = fixture();
    expect(await readBounded(root, { maxBytes: 100 })).toEqual({ refused: true, reason: 'not-regular' });
    expect(fs.open).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO without blocking or opening it', async () => {
    const { root } = fixture();
    const fifo = join(root, 'pipe');
    execFileSync('mkfifo', [fifo]);
    expect(await readBounded(fifo, { root, maxBytes: 100 })).toEqual({ refused: true, reason: 'not-regular' });
    expect(fileOpens()).toHaveLength(0);
  });

  it.each(['device', 'socket'])('refuses a %s entry before opening', async kind => {
    const { path } = fixture();
    const info = await actual.lstat(path);
    vi.spyOn(info, 'isFile').mockReturnValue(false);
    vi.spyOn(info, 'isCharacterDevice').mockReturnValue(kind === 'device');
    vi.spyOn(info, 'isSocket').mockReturnValue(kind === 'socket');
    vi.mocked(fs.lstat).mockResolvedValue(info);
    expect(await readBounded(path, { maxBytes: 100 })).toEqual({ refused: true, reason: 'not-regular' });
    expect(fs.open).not.toHaveBeenCalled();
  });

  it('verifies the opened file with fstat even after a regular lstat', async () => {
    const { path } = fixture();
    let read: ReturnType<typeof vi.spyOn> | undefined;
    io.onOpen = file => {
      const stat = file.stat.bind(file);
      vi.spyOn(file, 'stat').mockImplementation((async () => {
        const info = await stat();
        vi.spyOn(info, 'isFile').mockReturnValue(false);
        return info;
      }) as typeof file.stat);
      read = vi.spyOn(file, 'read');
    };
    expect(await readBounded(path, { maxBytes: 100 })).toEqual({ refused: true, reason: 'not-regular' });
    expect(read).not.toHaveBeenCalled();
    expect(io.files[0]!.fd).toBe(-1);
  });
});

describe('bounded JSON reads', () => {
  it.each([{ name: 'demo', count: 3 }, [1, 2], null, true, 'hello'])('parses JSON without trusting its shape: %j', async value => {
    const text = JSON.stringify(value);
    const { root, path } = fixture(text);
    expect(await readJsonBounded(path, { root, maxBytes: Buffer.byteLength(text) })).toEqual({ text, value, bytes: Buffer.byteLength(text), truncated: false });
  });

  it('returns parse errors as typed refusals', async () => {
    const { path } = fixture('{"name":');
    expect(await readJsonBounded(path, { maxBytes: 100 })).toEqual({ refused: true, reason: 'invalid-json' });
    expect(io.files[0]!.fd).toBe(-1);
  });

  it('shares byte caps and symlink checks with text reads', async () => {
    const { root, path } = fixture('{"name":"demo"}');
    const link = join(root, 'link');
    symlinkSync(path, link);
    expect(await readJsonBounded(path, { maxBytes: 5 })).toEqual({ refused: true, reason: 'too-large' });
    expect(await readJsonBounded(link, { root, maxBytes: 100 })).toEqual({ refused: true, reason: 'symlink' });
  });
});
