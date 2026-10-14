import { temporaryDirectory } from '../tests/temporary-directory.js';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configPath, loadStartupConfig } from '../server/src/config.js';
import { spkiFingerprint } from '../lib/loopback-tls.js';
import { Devices } from '../server/src/devices.js';
import { parsePairingToken } from '../desktop/src/tls.js';
import { loopbackTlsFixtures } from '../tests/loopback-tls-fixtures.js';

const certificates = vi.hoisted(() => ({ missing: false, supervisor: '' }));
const credentials = vi.hoisted(() => ({ inaccessible: '' }));
const filesystem = vi.hoisted(() => ({ root: undefined as string | undefined, hostile: false, files: new Map<string, string>() }));
vi.mock('node:fs', async original => {
  const { hostPaths, isolatedStateFilesystem } = await import('../server/test/host-path-fixture.js');
  const fs = isolatedStateFilesystem(await original<typeof import('node:fs')>(), filesystem);
  return { ...fs, statSync: ((path: Parameters<typeof fs.statSync>[0], ...args: unknown[]) => {
    if (path === credentials.inaccessible) throw Object.assign(new Error('Demo inaccessible credential'), { code: 'EACCES' });
    return Reflect.apply(fs.statSync, fs, [path, ...args]);
  }) as typeof fs.statSync, readFileSync: ((path: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
    if (path === `${hostPaths.config}/supervisor-tls-cert.pem`) {
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
  credentials.inaccessible = '';
  filesystem.root = temporaryDirectory('wayroost-pair-state-root-');
  for (const path of ['var/lib', 'etc', 'run/credentials']) mkdirSync(join(filesystem.root, path), { recursive: true });
  root = temporaryDirectory('pair-code-');
  config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({
    role: 'shadow', listen: { port: 8890 }, publicOrigin: 'http://127.0.0.1:8890', stateDir: join(root, 'state'),
  }));
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'pair-code', '--phone', '--config', config]);
  for (const name of ['WAYROOST_CONFIG', 'SIGNALBOX_CONFIG', 'WAYROOST_ROLE', 'SIGNALBOX_ROLE', 'CREDENTIALS_DIRECTORY']) vi.stubEnv(name, undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  if (filesystem.root) rmSync(filesystem.root, { recursive: true, force: true });
  filesystem.root = undefined;
});

describe('pairing recovery config precedence', () => {
  it.each([
    ['relative', true], ['relative', false],
    ['inaccessible', true], ['inaccessible', false],
  ] as const)('handles %s credentials with an explicit config: %s', async (directory, explicit) => {
    const credentialDirectory = directory === 'relative' ? directory : join(root, 'credentials');
    vi.stubEnv('CREDENTIALS_DIRECTORY', credentialDirectory);
    if (directory === 'inaccessible') {
      mkdirSync(credentialDirectory);
      credentials.inaccessible = join(credentialDirectory, 'config.json');
      writeFileSync(credentials.inaccessible, '{}');
    }
    const message = directory === 'relative'
      ? 'CREDENTIALS_DIRECTORY must be an absolute path'
      : 'Cannot inspect the systemd config credential config.json';
    expect(() => configPath()).toThrow(message);
    vi.stubEnv('WAYROOST_DEV_ALLOW_LOOPBACK', '1');
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'pair-code', '--phone', ...(explicit ? ['--config', config] : [])]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('fake-pair-code-exit'); });
    recovery.mockResolvedValue({ code: 'obviously-fake-pairing-code', kind: 'phone', expiresAt: Date.now() + 600_000, urls: [] });

    if (explicit) {
      await import('./pair-code.js');
      expect(recovery).toHaveBeenCalledExactlyOnceWith(join(root, 'state', 'pairing', 'pair.sock'), 'phone');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('obviously-fake-pairing-code'));
      expect(error).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    } else {
      await expect(import('./pair-code.js')).rejects.toThrow('fake-pair-code-exit');
      expect(error).toHaveBeenCalledWith(expect.stringContaining(message));
      expect(exit).toHaveBeenCalledWith(1);
      expect(recovery).not.toHaveBeenCalled();
    }
  });

  it('uses the config credential when no explicit argument or config variable is set', async () => {
    const directory = join(root, 'credentials');
    mkdirSync(directory);
    writeFileSync(join(directory, 'config.json'), readFileSync(config));
    vi.stubEnv('CREDENTIALS_DIRECTORY', directory);
    vi.stubEnv('WAYROOST_DEV_ALLOW_LOOPBACK', '1');
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'pair-code', '--phone']);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('fake-pair-code-exit'); });
    recovery.mockResolvedValue({ code: 'obviously-fake-pairing-code', kind: 'phone', expiresAt: Date.now() + 600_000, urls: [] });

    await import('./pair-code.js');
    expect(recovery).toHaveBeenCalledExactlyOnceWith(join(root, 'state', 'pairing', 'pair.sock'), 'phone');
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
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
