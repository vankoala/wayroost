import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Devices } from '../src/devices.js';

// Writes and persistence can fail independently, including after replacement.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, writeSync: vi.fn(real.writeSync), fsyncSync: vi.fn(real.fsyncSync), renameSync: vi.fn(real.renameSync) };
});
const real = await vi.importActual<typeof import('node:fs')>('node:fs');
const realWriteSync = real.writeSync;
const writeSync = vi.mocked(fs.writeSync) as unknown as ReturnType<typeof vi.fn>;
const roots: string[] = [];

/** Writes at most `most` bytes of what it's asked to, as a short write does. */
const short = (most: number) => (fd: number, buffer: Buffer, offset: number, length: number) =>
  realWriteSync(fd, buffer, offset, Math.min(length, most));
const noSpace = () => {
  throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
};

afterEach(() => {
  writeSync.mockReset();
  writeSync.mockImplementation(realWriteSync);
  vi.mocked(fs.fsyncSync).mockReset().mockImplementation(real.fsyncSync);
  vi.mocked(fs.renameSync).mockReset().mockImplementation(real.renameSync);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function store(options: { now?: () => number } = {}) {
  const tempDir = join(process.cwd(), '.tmp');
  fs.mkdirSync(tempDir, { recursive: true });
  const stateDir = fs.mkdtempSync(join(tempDir, 'devices-'));
  roots.push(stateDir);
  const devices = new Devices(stateDir, options);
  devices.add('Desktop', 'desktop');
  return { stateDir, devices, path: join(stateDir, 'devices.json') };
}

describe('saving devices.json', () => {
  it('persists the replacement directory before acknowledging a revocation', () => {
    const { devices, path } = store();
    const paired = devices.add('Phone', 'phone');
    let durable = fs.readFileSync(path, 'utf8');
    const events: string[] = [];
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      real.renameSync(from, to);
      events.push('rename');
    });
    vi.mocked(fs.fsyncSync).mockImplementation(fd => {
      real.fsyncSync(fd);
      if (fs.fstatSync(fd).isDirectory()) {
        durable = fs.readFileSync(path, 'utf8');
        events.push('directory-sync');
      } else events.push('file-sync');
    });
    devices.onRevoke(() => events.push('revoked'));

    expect(devices.revoke(paired.device.id)).toBe(true);
    expect(events).toEqual(['file-sync', 'rename', 'directory-sync', 'revoked']);
    expect(JSON.parse(durable).devices.map((device: { id: string }) => device.id)).not.toContain(paired.device.id);
  });

  it('reports a committed persistence failure and still invalidates a revoked credential and its codes', () => {
    const { stateDir, devices, path } = store();
    const paired = devices.add('Phone', 'phone');
    const code = devices.createCode('phone', { issuer: paired.device.id });
    const signal = devices.signal(paired.device.id);
    const listener = vi.fn();
    devices.onRevoke(listener);
    vi.mocked(fs.fsyncSync).mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error('demo-directory-sync-error');
      real.fsyncSync(fd);
    });

    const error = (() => { try { devices.revoke(paired.device.id); } catch (cause) { return cause; } })();
    expect(error).toMatchObject({ committed: true, message: expect.stringContaining('persistence could not be confirmed') });
    expect(devices.get(paired.device.id)).toBeUndefined();
    expect(devices.authenticate([paired.cookie])).toBeNull();
    expect(signal.aborted).toBe(true);
    expect(listener).toHaveBeenCalledExactlyOnceWith(paired.device.id);
    expect(new Devices(stateDir).get(paired.device.id)).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path, 'utf8')).devices.map((device: { id: string }) => device.id)).not.toContain(paired.device.id);
    expect(fs.readdirSync(stateDir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    vi.mocked(fs.fsyncSync).mockImplementation(real.fsyncSync);
    expect(() => devices.pair(code.code, 'Replacement')).toThrow('pairing refused (invalid)');
  });

  it('keeps a credential live when persistence fails before rename', () => {
    const { devices, path } = store();
    const paired = devices.add('Phone', 'phone');
    const before = fs.readFileSync(path, 'utf8');
    const signal = devices.signal(paired.device.id);
    const listener = vi.fn();
    devices.onRevoke(listener);
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error('demo-file-sync-error'); });

    expect(() => devices.revoke(paired.device.id)).toThrow('demo-file-sync-error');
    expect(fs.readFileSync(path, 'utf8')).toBe(before);
    expect(devices.authenticate([paired.cookie])?.device.id).toBe(paired.device.id);
    expect(signal.aborted).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it.each(['add', 'rename', 'touch', 'unlock'] as const)('keeps live state aligned with a committed %s after directory sync fails', action => {
    let now = 0;
    const { stateDir, devices: initial, path } = store({ now: () => now });
    const id = initial.list()[0]!.id;
    if (action === 'unlock') {
      const saved = JSON.parse(fs.readFileSync(path, 'utf8'));
      saved.pairingLocked = true;
      fs.writeFileSync(path, JSON.stringify(saved));
    }
    const devices = new Devices(stateDir, { now: () => now });
    now = 2 * 60 * 60_000;
    vi.mocked(fs.fsyncSync).mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error('demo-directory-sync-error');
      real.fsyncSync(fd);
    });
    const change = () => {
      if (action === 'add') devices.add('Phone', 'phone');
      if (action === 'rename') devices.rename(id, 'Updated desktop');
      if (action === 'touch') devices.touch(id);
      if (action === 'unlock') devices.unlockPairing();
    };
    const error = (() => { try { change(); } catch (cause) { return cause; } })();
    expect(error).toMatchObject({ committed: true });
    const reloaded = new Devices(stateDir);
    expect(devices.list()).toEqual(reloaded.list());
    expect(devices.pairingLocked()).toBe(reloaded.pairingLocked());
  });

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
