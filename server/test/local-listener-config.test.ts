import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadStartupConfig, parseConfig } from '../src/config.js';

const valid = {
  publicOrigin: 'https://wayroost.example.com',
  origins: ['https://127.0.0.1:19014'],
  localListener: { port: 19014 },
  stateDir: '/var/lib/signalbox',
};

let folder: string | undefined;
afterEach(() => { if (folder) rmSync(folder, { recursive: true, force: true }); folder = undefined; });
function startup(body: unknown, env: NodeJS.ProcessEnv = {}) {
  folder ??= mkdtempSync(join(tmpdir(), 'wayroost-local-config-'));
  const path = join(folder, 'startup.json');
  writeFileSync(path, JSON.stringify(body));
  return loadStartupConfig(path, env);
}

describe('the local listener', () => {
  it('is a second loopback port for the desktop app, with PC-only writes off until confirmed', () => {
    const config = parseConfig(valid);
    expect(config.localListener).toEqual({ host: '127.0.0.1', port: 19014, pcOnlyWrites: false });
    expect(parseConfig({ ...valid, localListener: { port: 19014, pcOnlyWrites: true } }).localListener?.pcOnlyWrites).toBe(true);
  });

  it('is absent unless configured', () => {
    const { localListener: _local, origins: _origins, ...rest } = valid;
    expect(parseConfig(rest).localListener).toBeUndefined();
  });

  it('listens on loopback only', () => {
    expect(() => parseConfig({ ...valid, localListener: { host: '0.0.0.0', port: 19014 } })).toThrow(ConfigError);
    expect(() => parseConfig({ ...valid, localListener: { host: '192.0.2.10', port: 19014 } })).toThrow(ConfigError);
  });

  it('uses the shared loopback definition for both listeners and local consumers', () => {
    for (const host of ['127.0.0.0', '127.0.0.2', '127.255.255.255', 'localhost', '::1']) {
      const authority = host.includes(':') ? `[${host}]` : host;
      const config = parseConfig({ ...valid, listen: { host }, origins: [`https://${authority}:19014`], localListener: { host, port: 19014 },
        hermes: { url: `http://${authority}:19006` }, paseo: { url: `ws://${authority}:19007` } });
      expect(config.localListener?.host, host).toBe(host);
    }
    for (const host of ['::ffff:127.0.0.1', '::ffff:7f00:1', 'localhost.', 'box.localhost', '128.0.0.1']) {
      const authority = host.includes(':') ? `[${host}]` : host;
      expect(() => parseConfig({ ...valid, listen: { host } }), host).toThrow(/listen.host/);
      expect(() => parseConfig({ ...valid, localListener: { host, port: 19014 } }), host).toThrow(/localListener.host/);
      expect(() => parseConfig({ ...valid, hermes: { url: `http://${authority}:19006` } }), host).toThrow(/hermes.url/);
      expect(() => parseConfig({ ...valid, paseo: { url: `ws://${authority}:19007` } }), host).toThrow(/paseo.url/);
    }
  });

  it('never shares a port the tunnel or another service uses', () => {
    for (const port of [19010, 19011, 19012, 19013]) {
      expect(() => parseConfig({ ...valid, origins: [`https://127.0.0.1:${port}`], localListener: { port } }), String(port)).toThrow(ConfigError);
    }
    expect(() => parseConfig({ ...valid, listen: { port: 19020 }, origins: ['https://127.0.0.1:19020'], localListener: { port: 19020 } })).toThrow(ConfigError);
  });

  it('needs device sign-in and its own address listed as a local origin', () => {
    expect(() => parseConfig({
      ...valid,
      origins: undefined,
      localListener: { port: 19014 },
      access: { teamDomain: 'https://myteam.cloudflareaccess.com', aud: 'abc123', allowedEmails: ['you@example.com'] },
      devices: { enabled: false },
    })).toThrow(ConfigError);
    expect(() => parseConfig({ ...valid, origins: ['https://127.0.0.1:19015'] })).toThrow(/origins/);
  });

  it('matches both host and effective port, including the HTTPS default', () => {
    expect(() => parseConfig({ ...valid, localListener: { host: '127.0.0.2', port: 19014 } })).toThrow(/origins/);
    expect(parseConfig({ ...valid, origins: ['https://127.0.0.2:19014'], localListener: { host: '127.0.0.2', port: 19014 } }).localListener?.host).toBe('127.0.0.2');
    expect(parseConfig({ ...valid, origins: ['https://127.0.0.1'], localListener: { port: 443 } }).localListener?.port).toBe(443);
    expect(parseConfig({ ...valid, origins: ['https://[::1]:19014'], localListener: { host: '::1', port: 19014 } }).localListener?.host).toBe('::1');
    expect(parseConfig({ ...valid, origins: ['https://[::1]:19014'], localListener: { host: '0:0:0:0:0:0:0:1', port: 19014 } }).localListener?.port).toBe(19014);
  });

  it('requires TLS for installed local listeners at startup', () => {
    expect(() => startup(valid)).toThrow(/require TLS/);
    expect(startup({ ...valid, tls: { certFile: '/home/me/cert.pem' } }).tls).toEqual({ certFile: '/home/me/cert.pem' });
    expect(() => startup({ ...valid, tls: { certFile: '/home/me/cert.pem', keyFile: '/home/me/key.pem' } })).toThrow(/LoadCredential/);
    expect(startup(valid, { WAYROOST_DEV_ALLOW_LOOPBACK: '1' }).localListener?.port).toBe(19014);
    expect(startup({ ...valid, tls: { certFile: '/home/me/cert.pem', keyFile: '/home/me/key.pem' } }, { WAYROOST_DEV_ALLOW_LOOPBACK: '1' }).tls?.keyFile).toBe('/home/me/key.pem');
  });

  it('refuses unknown fields', () => {
    expect(() => parseConfig({ ...valid, localListener: { port: 19014, tunnel: true } })).toThrow(ConfigError);
  });

  it('keeps clear of the primary\'s ports in shadow', () => {
    const shadow = { ...valid, role: 'shadow', listen: { port: 8890 }, stateDir: '/var/lib/wayroost-shadow' };
    expect(parseConfig({ ...shadow, origins: ['https://127.0.0.1:8891'], localListener: { port: 8891 } }, { env: {} }).localListener?.port).toBe(8891);
    expect(() => parseConfig({ ...shadow, origins: ['https://127.0.0.1:19010'], localListener: { port: 19010 } }, { env: {} })).toThrow(/Shadow/);
  });
});
