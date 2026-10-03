import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { listenerTls, spkiFingerprint } from '../../lib/loopback-tls.js';
import { pairPinnedDesktop, parsePairingToken, pinnedRequest } from '../../desktop/src/tls.js';
import { buildApp } from '../src/app.js';
import { loadStartupConfig, parseConfig } from '../src/config.js';
import { Devices } from '../src/devices.js';
import { EventHub } from '../src/hub.js';
import { FakeHermes, FakePaseo } from './helpers.js';
import { configSchema } from '../../supervisor/src/config.js';
import { createSupervisor } from '../../supervisor/src/server.js';
import { hashKey } from '../../supervisor/src/keys.js';
import { loopbackTlsFixtures } from '../../tests/loopback-tls-fixtures.js';

// Throwaway key pairs, generated for this run and removed afterwards; none is committed.
const tls = loopbackTlsFixtures();
afterAll(() => tls.remove());
const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function credentials() {
  const directory = mkdtempSync(join(tmpdir(), 'demo-tls-credentials-')); directories.push(directory);
  const cert = tls.cert('server');
  writeFileSync(join(directory, 'loopback-tls-cert'), cert);
  writeFileSync(join(directory, 'loopback-tls-key'), tls.key('server'), { mode: 0o600 });
  vi.stubEnv('CREDENTIALS_DIRECTORY', directory);
  return { directory, cert, pin: spkiFingerprint(cert) };
}
it('requires TLS at installed startup and refuses file keys outside explicit dev mode', () => {
  const { directory } = credentials();
  const path = join(directory, 'config.json');
  const base = { role: 'shadow', listen: { port: 8896 }, publicOrigin: 'https://wayroost.example.com', stateDir: join(directory, 'state') };
  writeFileSync(path, JSON.stringify(base));
  expect(() => loadStartupConfig(path, {})).toThrow('Installed listeners require TLS');
  expect(loadStartupConfig(path, { WAYROOST_DEV_ALLOW_LOOPBACK: '1' }).tls).toBeUndefined();
  writeFileSync(path, JSON.stringify({ ...base, role: 'primary', origins: ['https://127.0.0.1:8896'] }));
  expect(() => loadStartupConfig(path, {})).toThrow('Installed listeners require TLS');
  writeFileSync(path, JSON.stringify({ ...base, role: 'primary' }));
  expect(loadStartupConfig(path, {}).tls).toBeUndefined();
  writeFileSync(path, JSON.stringify({ ...base, tls: { certFile: '/demo/cert', keyFile: '/demo/key' } }));
  expect(() => loadStartupConfig(path, {})).toThrow('LoadCredential');
  expect(() => listenerTls({ certFile: '/demo/cert' }, {})).toThrow('LoadCredential');
  const supplied = listenerTls({ certFile: '/demo/unused-cert' }, { CREDENTIALS_DIRECTORY: directory });
  expect(supplied.key).toBeInstanceOf(Buffer);
});
it('serves HTTPS and WSS with credential keys, pairs with pins and refuses plain HTTP', async () => {
  const { directory, cert, pin } = credentials();
  const origin = 'https://127.0.0.1:8896';
  const config = parseConfig({ listen: { port: 8896 }, publicOrigin: 'https://wayroost.example.com', origins: [origin], stateDir: directory, tls: { certFile: '/demo/unused-cert' } });
  const devices = new Devices(directory);
  const app = await buildApp({ config, devices, hub: new EventHub(), sources: { hermes: new FakeHermes(), paseo: new FakePaseo() }, logger: false });
  try {
    await app.listen({ host: '127.0.0.1', port: 8896 });
    const made = devices.createCode('desktop');
    const cookie = await pairPinnedDesktop(origin, parsePairingToken(JSON.stringify({ code: made.code, serverPin: pin, rescuePin: pin })));
    expect(cookie).toMatch(/^dv_/);
    await expect(pairPinnedDesktop(origin, { code: made.code, serverPin: pin, rescuePin: pin })).rejects.toThrow('code was refused');
    const socket = new WebSocket(origin.replace('https:', 'wss:') + '/ws', { ca: cert, origin, headers: { Cookie: `wr_device=${cookie}`, 'x-wayroost-app': 'desktop' } });
    await once(socket, 'open'); socket.close(); await once(socket, 'close');
    await expect(new Promise<void>((resolve, reject) => {
      const call = request('http://127.0.0.1:8896/api/me', () => resolve()); call.on('error', reject); call.end();
    })).rejects.toThrow();
  } finally { await app.close(); }
});
it('makes the installed supervisor rescue listener HTTPS while preserving its Unix socket', async () => {
  const { directory, pin } = credentials();
  const config = configSchema.parse({ socket: join(directory, 'socket'), stateDir: directory, rescuePort: 8895, tls: { certFile: '/demo/unused-cert' } });
  const supervisor = createSupervisor({ config, registry: [], keys: [{ name: 'demo-rescue', scope: 'rescue', sha256: hashKey('demo-rescue-key') }], exec: { run: async () => 0 }, status: async () => ({ overall: 'ok', sentence: 'Demo running.', components: [], at: 0 }) });
  try {
    await supervisor.start();
    const response = await pinnedRequest(new URL('https://127.0.0.1:8895/v1/status'), pin, { Authorization: 'Bearer demo-rescue-key' });
    expect(response.status).toBe(200);
    await expect(new Promise<void>((resolve, reject) => {
      const call = request('http://127.0.0.1:8895/v1/status', () => resolve()); call.on('error', reject); call.end();
    })).rejects.toThrow();
  } finally { await supervisor.close(); }
  expect(() => createSupervisor({ config: configSchema.parse({ stateDir: directory }), registry: [], keys: [], exec: { run: async () => 0 } })).toThrow('requires TLS');
});
