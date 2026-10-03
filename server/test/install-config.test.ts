import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { EventHub } from '../src/hub.js';
import { Devices } from '../src/devices.js';
import { FakeHermes, FakePaseo } from './helpers.js';
import { loopbackTlsFixtures } from '../../tests/loopback-tls-fixtures.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wayroost-install-config-'));
  roots.push(root);
  mkdirSync(join(root, 'etc/wayroost'), { recursive: true });
  return root;
}
function plan(root: string, args: string[] = []) {
  return execFileSync('bash', ['deploy/install-wayroost-server.sh', '--dry-run', '--root', root, ...args], { encoding: 'utf8' });
}
function generated(output: string) {
  const line = output.split('\n').findIndex(line => line.includes('/etc/wayroost/config.json mode='));
  const json = output.split('\n').slice(line + 1).join('\n');
  const end = json.indexOf('\n}\n');
  return JSON.parse(json.slice(0, end + 2)) as Record<string, unknown>;
}

it('generates an explicitly paired desktop origin while preserving public Access and custom origins', async () => {
  const root = fixture();
  const access = { teamDomain: 'https://example.cloudflareaccess.com', aud: 'obviously-fake-audience', allowedEmails: ['you@example.com'] };
  writeFileSync(join(root, 'etc/wayroost/config.json'), JSON.stringify({ publicOrigin: 'https://wayroost.example.com', origins: ['https://other.example.com'], access, devices: { enabled: false } }));
  const raw = generated(plan(root));
  expect(raw.origins).toEqual(['https://other.example.com', 'https://127.0.0.1:8881']);
  expect(raw.publicOrigin).toBe('https://wayroost.example.com');
  expect(raw.access).toEqual(access);
  expect(raw.devices).toEqual({ enabled: true });
  // The generated config as the installed server reads it: the real parser, with the shadow
  // role, its port and its own state directory. The unit's WAYROOST_ROLE=shadow agrees. The
  // supervisor key comes as a systemd credential: here, an invented path for one.
  const credential = { supervisorKeyCredential: join(root, 'credentials', 'supervisor-server-key') };
  const installed = parseConfig(raw, { ...credential, env: { WAYROOST_ROLE: 'shadow' } });
  expect(installed.role).toBe('shadow');
  expect(installed.listen).toEqual({ host: '127.0.0.1', port: 8881 });
  expect(installed.stateDir).toBe('/var/lib/wayroost-shadow');
  expect(installed.supervisor?.socket).toBe('/run/wayroost/supervisor.sock');
  expect(installed.origins.map((o) => o.origin)).toContain('https://127.0.0.1:8881');
  // A shadow never takes the primary's state, whatever the config says.
  expect(() => parseConfig({ ...raw, stateDir: '/var/lib/wayroost' }, credential)).toThrow(/primary-owned/);
  // Pairing the desktop on the local origin, in an empty state directory of the shadow's own.
  const config = parseConfig({ ...raw, stateDir: join(root, 'shadow-state') }, { ...credential, env: {} });
  expect(config.role).toBe('shadow');
  const credentials = join(root, 'credentials');
  mkdirSync(credentials);
  // A throwaway key pair, generated for this test and removed with it; none is committed.
  const tls = loopbackTlsFixtures();
  writeFileSync(join(credentials, 'loopback-tls-cert'), tls.cert('server'));
  writeFileSync(join(credentials, 'loopback-tls-key'), tls.key('server'), { mode: 0o600 });
  tls.remove();
  vi.stubEnv('CREDENTIALS_DIRECTORY', credentials);
  const devices = new Devices(config.stateDir);
  const code = devices.createCode('desktop', { recovery: true });
  const app = await buildApp({ config, devices, verifier: async () => { throw new Error('local requests must not use Access'); }, hub: new EventHub(), sources: { hermes: new FakeHermes(), paseo: new FakePaseo() }, logger: false });
  try {
    const result = await app.inject({ method: 'POST', url: '/api/pair', headers: { host: '127.0.0.1:8881', origin: 'https://127.0.0.1:8881', 'x-wayroost-app': 'desktop', 'x-wayroost-request': '1' }, payload: { code: code.code, name: 'Demo desktop', kind: 'desktop' } });
    expect(result.statusCode).toBe(200);
    expect(result.headers['set-cookie']).toContain('wr_device=');
  } finally { await app.close(); }
});

it('supplies exactly paseo-password only when the protected source exists, without printing its contents', () => {
  const root = fixture();
  expect(plan(root)).not.toContain('LoadCredential=paseo-password:');
  const password = 'obviously-fake-paseo-password';
  writeFileSync(join(root, 'etc/wayroost/paseo-password'), password, { mode: 0o600 });
  const output = plan(root);
  expect(output).toContain('LoadCredential=paseo-password:/etc/wayroost/paseo-password');
  expect(output).toContain('ProtectHome=yes');
  expect(output).not.toContain(password);
  const custom = plan(root, ['--paseo-password-file', '/etc/wayroost/paseo-password']);
  expect(custom).toContain('LoadCredential=paseo-password:/etc/wayroost/paseo-password');
});

it('plans the scoped owner helper and credential without opening the server home sandbox', () => {
  const root = fixture();
  const output = plan(root, ['--safety-owner', 'demo-owner', '--safety-paseo-config', '/home/me/demo-paseo/config.json']);
  expect(output).toContain('User=demo-owner');
  expect(output).toContain('ReadWritePaths=/home/me/demo-paseo');
  expect(output).toContain('"safetyHelper"');
  expect(output).toContain('LoadCredential=safety-helper-key:/etc/wayroost/safety-helper-key');
  expect(output).toContain('ProtectHome=yes');
  expect(readFileSync('deploy/wayroost-server.service', 'utf8')).toContain('ProtectHome=yes');
  expect(output).toContain('safety-helper.js');
  expect(output).toContain('systemctl enable wayroost-paseo-safety.service');
});

it('validates the configured Unix socket and retains helper credentials on reinstall', () => {
  const root = fixture();
  expect(() => parseConfig({ origins: ['https://127.0.0.1:8881'], stateDir: root, safetyHelper: { socket: 'relative' } })).toThrow();
  expect(() => parseConfig({ origins: ['https://127.0.0.1:8881'], stateDir: root, safetyHelper: { socket: '/tmp/bad\npath' } })).toThrow();
  writeFileSync(join(root, 'etc/wayroost/safety-helper.json'), '{"configPath":"/home/me/demo-paseo/config.json","url":"ws://127.0.0.1:8896"}');
  writeFileSync(join(root, 'etc/wayroost/config.json'), JSON.stringify({ publicOrigin: 'https://wayroost.example.com', safetyHelper: { socket: '/run/wayroost-paseo-safety/helper.sock' } }));
  const output = plan(root);
  expect(output).toContain('LoadCredential=safety-helper-key:/etc/wayroost/safety-helper-key');
  expect(generated(output).safetyHelper).toEqual({ socket: '/run/wayroost-paseo-safety/helper.sock' });
});
