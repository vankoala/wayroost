import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Devices } from '../src/devices.js';

// writeSync is swapped for one the tests can make write short or fail, as a
// nearly full disk does; everything else is the real thing.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, writeSync: vi.fn(real.writeSync) };
});
const { writeSync: realWriteSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
const writeSync = vi.mocked(fs.writeSync) as unknown as ReturnType<typeof vi.fn>;

/** Writes at most `most` bytes of what it's asked to, as a short write does. */
const short = (most: number) => (fd: number, buffer: Buffer, offset: number, length: number) =>
  realWriteSync(fd, buffer, offset, Math.min(length, most));
const noSpace = () => {
  throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
};

afterEach(() => {
  writeSync.mockReset();
  writeSync.mockImplementation(realWriteSync);
});

function store() {
  const stateDir = fs.mkdtempSync(join(tmpdir(), 'sb-devices-'));
  const devices = new Devices(stateDir);
  devices.add('Desktop', 'desktop');
  return { stateDir, devices, path: join(stateDir, 'devices.json') };
}

describe('saving devices.json', () => {
  it('keeps the old file and the live list when a short write is followed by a full disk', () => {
    const { stateDir, devices, path } = store();
    const before = fs.readFileSync(path, 'utf8');
    writeSync.mockImplementationOnce(short(25)).mockImplementationOnce(noSpace);

    expect(() => devices.add('Phone', 'phone')).toThrow(/ENOSPC/);
    expect(fs.readFileSync(path, 'utf8')).toBe(before);
    expect(devices.list().map((d) => d.name)).toEqual(['Desktop']);
    expect(fs.readdirSync(stateDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(new Devices(stateDir).list().map((d) => d.name)).toEqual(['Desktop']);
  });

  it('writes the rest when a write comes back short, so the saved file is whole', () => {
    const { stateDir, devices } = store();
    writeSync.mockClear();
    writeSync.mockImplementation(short(25));

    devices.add('Phone', 'phone');
    expect(writeSync.mock.calls.length).toBeGreaterThan(1);
    expect(new Devices(stateDir).list().map((d) => d.name)).toEqual(['Desktop', 'Phone']);
  });

  it('fails rather than loop when the disk takes nothing', () => {
    const { stateDir, devices, path } = store();
    const before = fs.readFileSync(path, 'utf8');
    writeSync.mockImplementation(() => 0);

    expect(() => devices.add('Phone', 'phone')).toThrow();
    expect(fs.readFileSync(path, 'utf8')).toBe(before);
    expect(devices.list().map((d) => d.name)).toEqual(['Desktop']);
    expect(fs.readdirSync(stateDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
