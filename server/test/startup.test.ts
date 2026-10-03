import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadStartupConfig } from '../src/config.js';

const KEY = 'obviously-fake-supervisor-key';

describe('startup configuration', () => {
  let root: string;
  let path: string;
  let credentials: string;
  let devKey: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sb-startup-'));
    path = join(root, 'config.json');
    credentials = join(root, 'credentials');
    devKey = join(root, 'dev-key');
    mkdirSync(credentials);
    writeFileSync(join(credentials, 'helper-token'), 'obviously-fake-helper-token-for-startup\n', { mode: 0o600 });
    writeFileSync(devKey, `${KEY}\n`, { mode: 0o600 });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function config(supervisor?: { socket: string; keyFile?: string }) {
    writeFileSync(path, JSON.stringify({
      publicOrigin: 'https://wayroost.example.com',
      stateDir: join(root, 'state'),
      helper: { enabled: true },
      ...(supervisor ? { supervisor } : {}),
    }));
  }

  it('starts a helper-only configuration without requiring a supervisor credential', () => {
    config();
    const loaded = loadStartupConfig(path, { CREDENTIALS_DIRECTORY: credentials });
    expect(loaded.helper.enabled).toBe(true);
    expect(loaded.supervisor).toBeUndefined();
    expect(loaded.tls).toBeUndefined();
  });

  it('preserves the deployed primary HTTP backend without enabling development authentication', () => {
    const installed = JSON.parse(readFileSync(new URL('../../deploy/config.example.json', import.meta.url), 'utf8'));
    writeFileSync(path, JSON.stringify({ ...installed, access: { ...installed.access, teamDomain: 'https://demo.cloudflareaccess.com', aud: 'obviously-fake-audience' }, stateDir: join(root, 'primary-state') }));
    const loaded = loadStartupConfig(path, {});
    expect(loaded.role).toBe('primary'); expect(loaded.tls).toBeUndefined();
    expect(loaded.access?.issuer).toContain('cloudflareaccess.com');
    expect(loaded.origins.every(origin => !origin.local)).toBe(true);
  });

  it('ignores an unused malformed supervisor credential', () => {
    config();
    writeFileSync(join(credentials, 'supervisor-server-key'), 'too-short');
    expect(loadStartupConfig(path, { CREDENTIALS_DIRECTORY: credentials }).supervisor).toBeUndefined();
  });

  it.each([false, true])('refuses a missing production supervisor credential with a dev key: %s', (fallback) => {
    config({ socket: join(root, 'supervisor.sock'), ...(fallback ? { keyFile: devKey } : {}) });
    expect(() => loadStartupConfig(path, { CREDENTIALS_DIRECTORY: credentials })).toThrow(/Cannot read the systemd credential/);
  });

  it.each(['', 'too-short', 'obviously fake invalid key', 'x'.repeat(257), 'fake-key-with-control\u0000'])(
    'refuses an invalid production credential %j even with a valid dev key', (key) => {
      config({ socket: join(root, 'supervisor.sock'), keyFile: devKey });
      writeFileSync(join(credentials, 'supervisor-server-key'), key);
      expect(() => loadStartupConfig(path, { CREDENTIALS_DIRECTORY: credentials })).toThrow(/Invalid systemd credential/);
    },
  );

  it.each(['', 'relative/credentials', '/demo/credentials\u0000', '/demo/credentials\n', `/${'x'.repeat(4096)}`])(
    'refuses an invalid credentials directory %j when the supervisor is configured', (directory) => {
      config({ socket: join(root, 'supervisor.sock'), keyFile: devKey });
      expect(() => loadStartupConfig(path, { CREDENTIALS_DIRECTORY: directory })).toThrow(ConfigError);
    },
  );

  it('refuses a missing credentials directory and a directory in place of the key', () => {
    config({ socket: join(root, 'supervisor.sock'), keyFile: devKey });
    expect(() => loadStartupConfig(path, { CREDENTIALS_DIRECTORY: join(root, 'missing') })).toThrow(ConfigError);
    mkdirSync(join(credentials, 'supervisor-server-key'));
    expect(() => loadStartupConfig(path, { CREDENTIALS_DIRECTORY: credentials })).toThrow(ConfigError);
  });

  it.each([false, true])('uses a valid production credential with a dev key: %s', (fallback) => {
    const socket = join(root, 'supervisor.sock');
    const credential = join(credentials, 'supervisor-server-key');
    config({ socket, ...(fallback ? { keyFile: devKey } : {}) });
    writeFileSync(credential, `${KEY}\n`, { mode: 0o600 });
    expect(loadStartupConfig(path, { CREDENTIALS_DIRECTORY: credentials }).supervisor).toEqual({ socket, keyFile: credential });
  });

  it('uses the dev key only without a configured credentials directory', () => {
    const socket = join(root, 'supervisor.sock');
    config({ socket, keyFile: devKey });
    expect(loadStartupConfig(path, {}).supervisor).toEqual({ socket, keyFile: devKey });
    config({ socket });
    expect(() => loadStartupConfig(path, {})).toThrow(/supervisor needs its key/);
  });
});
