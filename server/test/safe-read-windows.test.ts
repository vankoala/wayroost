import * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBounded, readJsonBounded } from '../src/hub/safe-read.js';

const io = vi.hoisted(() => ({ symlink: '', swapped: false, reads: 0 }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, constants: { ...actual.constants, O_NOFOLLOW: 0 } };
});
vi.mock('node:path', async original => {
  const actual = await original<typeof import('node:path')>();
  return { ...actual, ...actual.win32 };
});
vi.mock('node:fs/promises', () => {
  const info = (path: string) => ({
    dev: 1, ino: 1, size: 5,
    isSymbolicLink: () => path.replaceAll('/', '\\') === io.symlink,
    isDirectory: () => !path.endsWith('.txt'),
    isFile: () => path.endsWith('.txt'),
  });
  return {
    lstat: vi.fn(async (path: string) => info(path)),
    realpath: vi.fn(async (path: string) => path),
    open: vi.fn(async (path: string) => {
      io.swapped = true;
      return {
        stat: async () => info(path),
        read: async (buffer: Buffer, offset: number, length: number) => {
          const text = io.reads++ === 0 ? 'other' : '';
          return { bytesRead: buffer.write(text.slice(0, length), offset) };
        },
        close: async () => {},
      };
    }),
  };
});

beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'win32', cwd: () => 'C:\\allowed' });
  io.symlink = '';
  io.swapped = false;
  io.reads = 0;
  vi.clearAllMocks();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Windows file safety', () => {
  it.each(['D:secret.txt', 'D:', 'C:child\\secret.txt'])('refuses drive-relative input %s before filesystem access', async path => {
    expect(await readBounded(path, { root: 'C:\\allowed', maxBytes: 5 })).toEqual({ refused: true, reason: 'invalid-options' });
    expect(fs.lstat).not.toHaveBeenCalled();
    expect(fs.open).not.toHaveBeenCalled();
  });

  it('refuses a drive-relative root before filesystem access', async () => {
    expect(await readBounded('C:\\allowed\\secret.txt', { root: 'D:allowed', maxBytes: 5 })).toEqual({ refused: true, reason: 'invalid-options' });
    expect(fs.open).not.toHaveBeenCalled();
  });

  it.each([undefined, 'C:\\allowed'])('fails closed before a final-entry swap with root %s', async root => {
    expect(await readBounded('C:\\allowed\\secret.txt', { root, maxBytes: 5 })).toEqual({ refused: true, reason: 'unsupported-platform' });
    expect(io.swapped).toBe(false);
    expect(io.reads).toBe(0);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it.each([
    'C:/allowed/linked/nested/secret.txt',
    'C:\\allowed/linked\\nested/secret.txt',
    'C:/allowed/linked/../secret.txt',
    'C:\\allowed\\linked/../secret.txt',
  ])('fails closed for a symlink in mixed-separator input %s', async path => {
    io.symlink = 'C:\\allowed\\linked';
    expect(await readBounded(path, { root: 'C:\\allowed', maxBytes: 5 })).toEqual({ refused: true, reason: 'unsupported-platform' });
    expect(fs.open).not.toHaveBeenCalled();
    expect(io.reads).toBe(0);
  });

  it('uses the same platform refusal for JSON reads', async () => {
    expect(await readJsonBounded('C:\\allowed\\secret.txt', { maxBytes: 5 })).toEqual({ refused: true, reason: 'unsupported-platform' });
    expect(fs.open).not.toHaveBeenCalled();
  });
});
