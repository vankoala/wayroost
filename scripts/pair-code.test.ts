import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadStartupConfig } from '../server/src/config.js';
import { spkiFingerprint } from '../lib/loopback-tls.js';
import { Devices } from '../server/src/devices.js';
import { parsePairingToken } from '../desktop/src/tls.js';
import { loopbackTlsFixtures } from '../tests/loopback-tls-fixtures.js';

const certificates = vi.hoisted(() => ({ missing: false, supervisor: '' }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readFileSync: ((path: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
    if (path === '/etc/wayroost/supervisor-tls-cert.pem') {
      if (certificates.missing) throw Object.assign(new Error('Demo missing certificate'), { code: 'ENOENT' });
      return fs.readFileSync(certificates.supervisor);
    }
    return Reflect.apply(fs.readFileSync, fs, [path, ...args]);
  }) as typeof fs.readFileSync };
});

// Throwaway key pairs, generated for this run and removed afterwards; none is committed.
const tls = loopbackTlsFixtures();
certificates.supervisor = tls.certFile('supervisor');
afterAll(() => tls.remove());

const recovery = vi.hoisted(() => vi.fn());
vi.mock('../server/src/pairing-socket.js', async (original) => ({
  ...await original<object>(), requestRecoveryCode: recovery,
}));

let root: string;
let config: string;
beforeEach(() => {
  vi.resetModules();
  recovery.mockReset();
  certificates.missing = false;
  mkdirSync('test-results', { recursive: true });
  root = mkdtempSync(resolve('test-results/pair-code-'));
  config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({
    role: 'shadow', listen: { port: 8890 }, publicOrigin: 'http://127.0.0.1:8890', stateDir: join(root, 'state'),
  }));
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'pair-code', '--phone', '--config', config]);
  for (const name of ['WAYROOST_CONFIG', 'SIGNALBOX_CONFIG', 'WAYROOST_ROLE', 'SIGNALBOX_ROLE']) vi.stubEnv(name, undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('pairing recovery development flag', () => {
  it('prints both public SPKI fingerprints with a single combined desktop token and no key material', async () => {
    vi.stubEnv('WAYROOST_DEV_ALLOW_LOOPBACK', '1');
    const certFile = tls.certFile('server');
    writeFileSync(config, JSON.stringify({ role: 'shadow', listen: { port: 8890 }, publicOrigin: 'http://127.0.0.1:8890', stateDir: join(root, 'state'), localListener: { port: 8883 }, origins: ['https://127.0.0.1:8883'], tls: { certFile } }));
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'pair-code', '--desktop', '--config', config]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const devices = new Devices(join(root, 'devices'));
    const made = devices.createCode('desktop');
    recovery.mockResolvedValue({ ...made, urls: [] });
    await import('./pair-code.js');
    const output = log.mock.calls.map(args => args.join(' ')).join('\n');
    const serverPin = spkiFingerprint(readFileSync(certFile));
    const rescuePin = spkiFingerprint(tls.cert('supervisor'));
    expect(output).toContain(`Server fingerprint: ${serverPin}`);
    expect(output).toContain(`Supervisor rescue fingerprint: ${rescuePin}`);
    const token = log.mock.calls.flatMap(args => args.join(' ').split('\n')).find(line => line.startsWith('{'))!;
    expect(parsePairingToken(token)).toEqual({ code: made.code, serverPin, rescuePin, localPort: 8883 });
    expect(devices.pair(parsePairingToken(token).code, 'Demo desktop').device.kind).toBe('desktop');
    expect(output).toContain('Paste the whole token line');
    expect(output).not.toContain('type the code into the app');
    expect(output).not.toContain('PRIVATE KEY');
  });
  it.each(['phone', 'desktop'])('only desktop pairing requires the supervisor certificate (%s)', async kind => {
    certificates.missing = true;
    writeFileSync(config, JSON.stringify({ role: 'shadow', listen: { port: 8890 }, publicOrigin: 'https://wayroost.example.com', stateDir: join(root, 'state'), localListener: { port: 8883 }, origins: ['https://127.0.0.1:8883'], tls: { certFile: tls.certFile('server') } }));
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'pair-code', `--${kind}`, '--config', config]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('fake-pair-code-exit'); });
    recovery.mockResolvedValue({ code: 'a'.repeat(26), kind, expiresAt: Date.now() + 600_000, urls: [] });
    if (kind === 'phone') {
      await import('./pair-code.js');
      expect(recovery).toHaveBeenCalledOnce();
      expect(log.mock.calls.flat().join('\n')).not.toContain('desktop app');
    } else {
      await expect(import('./pair-code.js')).rejects.toThrow('fake-pair-code-exit');
      expect(recovery).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('re-run install-supervisor.sh'));
    }
  });
  it.each([
    [undefined, undefined, false],
    ['1', undefined, true],
    [undefined, '1', true],
    [undefined, '0', false],
    ['1', '0', true],
    ['0', '1', false],
    ['', '1', false],
    ['true', undefined, false],
    ['1', '1', true],
  ] as const)('matches startup for Wayroost %j / legacy %j (allowed: %s)', async (current, legacy, allowed) => {
    vi.stubEnv('WAYROOST_DEV_ALLOW_LOOPBACK', current);
    vi.stubEnv('SIGNALBOX_DEV_ALLOW_LOOPBACK', legacy);
    const env = { WAYROOST_DEV_ALLOW_LOOPBACK: current, SIGNALBOX_DEV_ALLOW_LOOPBACK: legacy };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('fake-pair-code-exit'); });
    recovery.mockResolvedValue({ code: 'obviously-fake-pairing-code', kind: 'phone', expiresAt: Date.now() + 600_000, urls: [] });

    if (allowed) {
      expect(loadStartupConfig(config, env).publicOrigin).toBe('http://127.0.0.1:8890');
      await import('./pair-code.js');
      expect(recovery).toHaveBeenCalledExactlyOnceWith(join(root, 'state', 'pairing', 'pair.sock'), 'phone');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('obviously-fake-pairing-code'));
      expect(error).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    } else {
      expect(() => loadStartupConfig(config, env)).toThrow('publicOrigin must use https');
      await expect(import('./pair-code.js')).rejects.toThrow('fake-pair-code-exit');
      expect(error).toHaveBeenCalledWith(expect.stringContaining('publicOrigin must use https'));
      expect(exit).toHaveBeenCalledWith(1);
      expect(recovery).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    }
  });
});
