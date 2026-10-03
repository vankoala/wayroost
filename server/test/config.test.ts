import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig, supervisorKeyCredential } from '../src/config.js';

const valid = {
  publicOrigin: 'https://wayroost.example.com',
  access: {
    teamDomain: 'https://myteam.cloudflareaccess.com',
    aud: 'abc123',
    allowedEmails: ['Me@Example.com'],
  },
  stateDir: '/var/lib/signalbox',
};

const withPatch = (patch: Record<string, unknown>) => ({ ...valid, ...patch });

describe('config', () => {
  it('accepts a production config and fills safe defaults', () => {
    const cfg = parseConfig(valid);
    expect(cfg.role).toBe('primary');
    expect(cfg.listen).toEqual({ host: '127.0.0.1', port: 19010 });
    expect(cfg.access!.issuer).toBe('https://myteam.cloudflareaccess.com');
    expect(cfg.access!.jwksUrl).toBe('https://myteam.cloudflareaccess.com/cdn-cgi/access/certs');
    expect(cfg.access!.allowedEmails).toEqual(['me@example.com']);
    expect(cfg.hermes.url).toBe('http://127.0.0.1:19006');
    expect(cfg.hermes.secretPrompts).toBe(false);
    expect(cfg.paseo.url).toBe('ws://127.0.0.1:19007');
    expect([...cfg.allowedHosts]).toContain('wayroost.example.com');
  });

  it.each(['publicOrigin', 'origins'])('uses a Wayroost example in %s validation errors', (field) => {
    const origin = 'https://wayroost.example.com/app';
    const patch = field === 'publicOrigin' ? { publicOrigin: origin } : { origins: [origin] };
    expect(() => parseConfig(withPatch(patch)))
      .toThrow(`${field} entries must be bare origins like https://wayroost.example.com (no path)`);
  });

  it('defaults each resolved role to its own Wayroost state directory', () => {
    const { stateDir: _stateDir, ...input } = valid;
    expect(parseConfig(input, { env: {} }).stateDir).toBe('/var/lib/wayroost');
    expect(parseConfig({ ...input, role: 'shadow', listen: { port: 8890 } }, { env: {} }))
      .toMatchObject({ role: 'shadow', stateDir: '/var/lib/wayroost-shadow' });
    expect(parseConfig({ ...input, listen: { port: 8890 } }, { env: { WAYROOST_ROLE: 'shadow' } }).stateDir)
      .toBe('/var/lib/wayroost-shadow');
    expect(parseConfig({ ...input, role: 'shadow', listen: { port: 8890 } }, { env: { WAYROOST_ROLE: 'primary' } }).stateDir)
      .toBe('/var/lib/wayroost-shadow');
    expect(() => parseConfig({ ...valid, role: 'standby' })).toThrow(ConfigError);
    expect(parseConfig(valid).stateDir).toBe('/var/lib/signalbox');
  });

  it.each([
    [undefined, 'shadow', 'shadow'], ['primary', 'shadow', 'shadow'],
    ['shadow', 'primary', 'shadow'], ['primary', 'primary', 'primary'],
  ])('resolves config %s and environment %s to %s', (role, override, expected) => {
    expect(parseConfig({ ...valid, role, listen: { port: 8890 }, stateDir: '/home/me/wayroost-state' },
      { env: { WAYROOST_ROLE: override } }).role).toBe(expected);
  });

  it('accepts the legacy role override and rejects invalid role overrides', () => {
    const input = { ...valid, listen: { port: 8890 }, stateDir: '/home/me/wayroost-state' };
    expect(parseConfig(input, { env: { SIGNALBOX_ROLE: 'shadow' } }).role).toBe('shadow');
    for (const role of ['', 'Shadow', 'primary\n']) {
      expect(() => parseConfig(input, { env: { WAYROOST_ROLE: role } })).toThrow(ConfigError);
    }
  });

  it.each([
    ['shadow', {}],
    ['shadow', { WAYROOST_ROLE: 'primary' }],
    [undefined, { WAYROOST_ROLE: 'shadow' }],
    ['primary', { WAYROOST_ROLE: 'shadow' }],
    [undefined, { SIGNALBOX_ROLE: 'shadow' }],
    ['primary', { SIGNALBOX_ROLE: 'shadow' }],
  ] as const)('requires pairing for shadow config %s / environment %j even with Access', (role, env) => {
    const input = { ...valid, role, listen: { port: 8890 }, stateDir: '/home/me/wayroost-state' };
    expect(() => parseConfig({ ...input, devices: { enabled: false } }, { env }))
      .toThrow('Shadow requires device sign-in (devices.enabled)');
    expect(parseConfig(input, { env })).toMatchObject({ role: 'shadow', devices: { enabled: true } });
    expect(parseConfig({ ...input, devices: { enabled: true } }, { env }))
      .toMatchObject({ role: 'shadow', devices: { enabled: true } });
  });

  it.each(['WAYROOST_ROLE', 'SIGNALBOX_ROLE'])('refuses explicit primary state when %s narrows the role to shadow', (name) => {
    expect(() => parseConfig({ ...valid, role: 'primary', listen: { port: 8890 }, stateDir: '/var/lib/wayroost' },
      { env: { [name]: 'shadow' } })).toThrow(ConfigError);
  });

  it.each([
    {}, { stateDir: '/home/me/wayroost-state' },
    ...[19010, 19011, 19012, 19013].map((port) => ({ listen: { port }, stateDir: '/home/me/wayroost-state' })),
    ...['/var/lib/signalbox', '/var/lib/signalbox/child', '/etc/signalbox', '/etc/signalbox/state',
      '/var/lib/wayroost', '/var/lib/wayroost/child', '/var/lib/wayroost/', '/var/lib/wayroost-shadow/../wayroost',
      '/home/me/../../var/lib/signalbox'].map((stateDir) => ({ listen: { port: 8890 }, stateDir })),
  ])('rejects shadow collisions or missing explicit isolation: %j', (isolation) => {
    const { stateDir: _stateDir, ...base } = valid;
    expect(() => parseConfig({ ...base, role: 'shadow', ...isolation })).toThrow(ConfigError);
  });

  it.each([
    ['listening on every interface', withPatch({ listen: { host: '0.0.0.0', port: 19010 } })],
    ['a plain-http public origin', withPatch({ publicOrigin: 'http://wayroost.example.com' })],
    ['a public origin with a path', withPatch({ publicOrigin: 'https://wayroost.example.com/app' })],
    [
      'a team domain that is not Cloudflare Access',
      withPatch({ access: { ...valid.access, teamDomain: 'https://evil.example.com' } }),
    ],
    ['no allowed emails', withPatch({ access: { ...valid.access, allowedEmails: [] } })],
    ['a remote Hermes', withPatch({ hermes: { url: 'http://192.0.2.5:19006' } })],
    ['a remote Paseo', withPatch({ paseo: { url: 'ws://192.0.2.5:19007' } })],
    ['unknown keys', withPatch({ debugDisableAuth: true })],
    ['unknown keys in listen', withPatch({ listen: { host: '127.0.0.1', port: 19010, hots: '0.0.0.0' } })],
    ['unknown keys in access', withPatch({ access: { ...valid.access, allowedEmail: ['x@example.com'] } })],
    ['a Hermes URL that is not http', withPatch({ hermes: { url: 'file://127.0.0.1/etc' } })],
    ['a relative state directory', withPatch({ stateDir: 'relative/dir' })],
    ['a non-ASCII allowed email', withPatch({ access: { ...valid.access, allowedEmails: ['\u212Aate@example.com'] } })],
    [
      'a local key server (would let local processes mint tokens)',
      withPatch({ access: { ...valid.access, teamDomain: 'http://127.0.0.1:8899' } }),
    ],
    ['a plain-http loopback origin', withPatch({ publicOrigin: 'http://127.0.0.1:19010' })],
    ['Hermes secret prompts turned on with a non-boolean', withPatch({ hermes: { secretPrompts: 'yes' } })],
    ['a misspelled Hermes secret prompts switch', withPatch({ hermes: { secretPrompt: true } })],
    ['a supervisor block with no key file', withPatch({ supervisor: { socket: '/run/wayroost/supervisor.sock' } })],
    ['a supervisor socket that is not absolute', withPatch({ supervisor: { socket: 'supervisor.sock', keyFile: '/etc/wayroost/supervisor-key' } })],
    ['a supervisor key file that is relative', withPatch({ supervisor: { socket: '/run/wayroost/supervisor.sock', keyFile: 'supervisor-key' } })],
    // sun_path is 108 bytes with its NUL, so the whole path gets 107 — in bytes.
    ['a supervisor socket path one byte too long', withPatch({ supervisor: { socket: `/${'a'.repeat(107)}`, keyFile: '/etc/wayroost/supervisor-key' } })],
    ['a supervisor socket path that fits in characters but not in bytes', withPatch({ supervisor: { socket: `/s${'ön'.repeat(60)}`, keyFile: '/etc/wayroost/supervisor-key' } })],
    ['a supervisor block with a typo in it', withPatch({ supervisor: { socket: '/run/wayroost/supervisor.sock', keyFile: '/etc/wayroost/supervisor-key', rescuuePort: 8880 } })],
    ['a supervisor block that is not an object', withPatch({ supervisor: '/run/wayroost/supervisor.sock' })],
  ])('rejects %s', (_name, input) => {
    expect(() => parseConfig(input)).toThrow(ConfigError);
  });

  it('answers Hermes password prompts from the phone only when explicitly turned on', () => {
    expect(parseConfig(withPatch({ hermes: { secretPrompts: true } })).hermes).toEqual({
      enabled: true,
      url: 'http://127.0.0.1:19006',
      secretPrompts: true,
    });
    expect(parseConfig(withPatch({ hermes: { enabled: true } })).hermes.secretPrompts).toBe(false);
  });

  it('talks to the supervisor only when the config names it', () => {
    expect(parseConfig(valid).supervisor).toBeUndefined();
    expect(parseConfig(withPatch({ supervisor: { keyFile: '/etc/wayroost/supervisor-key' } })).supervisor).toEqual({
      socket: '/run/wayroost/supervisor.sock',
      keyFile: '/etc/wayroost/supervisor-key',
    });
    expect(parseConfig(withPatch({ supervisor: { socket: '/run/wayroost/supervisor.sock', keyFile: '/etc/wayroost/supervisor-key' } })).supervisor).toEqual({
      socket: '/run/wayroost/supervisor.sock',
      keyFile: '/etc/wayroost/supervisor-key',
    });
    // Exactly at the limit, and a short path with accents in it, both pass.
    expect(parseConfig(withPatch({ supervisor: { socket: `/${'a'.repeat(106)}`, keyFile: '/etc/wayroost/supervisor-key' } })).supervisor?.socket).toBe(`/${'a'.repeat(106)}`);
    expect(parseConfig(withPatch({ supervisor: { socket: '/run/wayroost/σöck.sock', keyFile: '/etc/wayroost/supervisor-key' } })).supervisor?.socket).toBe('/run/wayroost/σöck.sock');
  });

  it('takes the supervisor key from the systemd credential first, and keyFile only without one', () => {
    const credential = '/demo/credentials/supervisor-server-key';
    const socketOnly = withPatch({ supervisor: { socket: '/demo/supervisor.sock' } });
    expect(parseConfig(socketOnly, { supervisorKeyCredential: credential }).supervisor).toEqual({
      socket: '/demo/supervisor.sock',
      keyFile: credential,
    });
    // Both there: the credential wins over the development key file.
    const both = withPatch({ supervisor: { keyFile: '/srv/dev/supervisor-key' } });
    expect(parseConfig(both, { supervisorKeyCredential: credential }).supervisor?.keyFile).toBe(credential);
    // Neither: nothing to call with, so the config is refused.
    expect(() => parseConfig(socketOnly)).toThrow(/supervisor-server-key/);
    expect(() => parseConfig(socketOnly, { supervisorKeyCredential: 'supervisor-server-key' })).toThrow(/absolute/);
    // The pairing recovery tool never calls the supervisor and doesn't need its key.
    expect(parseConfig(socketOnly, { withoutSupervisor: true }).supervisor).toBeUndefined();
  });

  it('finds the supervisor credential only where systemd put it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-credentials-'));
    try {
      expect(() => supervisorKeyCredential({ CREDENTIALS_DIRECTORY: dir })).toThrow(ConfigError);
      writeFileSync(join(dir, 'supervisor-server-key'), 'obviously-fake-test-key\n', { mode: 0o600 });
      expect(supervisorKeyCredential({ CREDENTIALS_DIRECTORY: dir })).toBe(join(dir, 'supervisor-server-key'));
      expect(supervisorKeyCredential({})).toBeUndefined();
      expect(() => supervisorKeyCredential({ CREDENTIALS_DIRECTORY: 'relative/dir' })).toThrow(ConfigError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['', 'relative/dir', '/demo/credentials\u0000', '/demo/credentials\n', `/${'x'.repeat(4096)}`])(
    'refuses an invalid configured credential directory %j instead of using the dev key', (dir) => {
      const input = withPatch({ supervisor: { keyFile: '/demo/dev/supervisor-key' } });
      expect(() => parseConfig(input, { supervisorKeyCredential: supervisorKeyCredential({ CREDENTIALS_DIRECTORY: dir }) })).toThrow(ConfigError);
    },
  );

  it('uses the dev key only with no configured credential directory', () => {
    const input = withPatch({ supervisor: { keyFile: '/demo/dev/supervisor-key' } });
    expect(parseConfig(input, { supervisorKeyCredential: supervisorKeyCredential({}) }).supervisor?.keyFile).toBe('/demo/dev/supervisor-key');
    const dir = mkdtempSync(join(tmpdir(), 'sb-credentials-'));
    try {
      for (const directory of [dir, join(dir, 'missing')]) {
        expect(() => parseConfig(input, { supervisorKeyCredential: supervisorKeyCredential({ CREDENTIALS_DIRECTORY: directory }) })).toThrow(ConfigError);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['', 'too-short', 'obviously fake invalid key', 'x'.repeat(257), 'fake-key-with-control\u0000'])('refuses a malformed production credential %j', (key) => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-credentials-'));
    try {
      writeFileSync(join(dir, 'supervisor-server-key'), key, { mode: 0o600 });
      expect(() => supervisorKeyCredential({ CREDENTIALS_DIRECTORY: dir })).toThrow(ConfigError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a credential path that is a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-credentials-'));
    try {
      mkdirSync(join(dir, 'supervisor-server-key'));
      expect(() => supervisorKeyCredential({ CREDENTIALS_DIRECTORY: dir })).toThrow(ConfigError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows loopback Access and http origins only in explicit local-dev mode', () => {
    const local = withPatch({
      publicOrigin: 'http://127.0.0.1:8898',
      access: { ...valid.access, teamDomain: 'http://127.0.0.1:8899' },
    });
    expect(() => parseConfig(local)).toThrow(ConfigError);
    expect(parseConfig(local, { allowLocalDev: true }).access!.issuer).toBe('http://127.0.0.1:8899');
  });

  describe('sign-in and origins', () => {
    const base = { stateDir: '/var/lib/signalbox' };

    it('never starts without sign-in: devices off and no Access is refused', () => {
      expect(() => parseConfig({ ...base, publicOrigin: 'https://wayroost.example.com', devices: { enabled: false } })).toThrow(
        /never runs without sign-in/,
      );
      // Device sign-in alone is a full setup; it is on unless turned off.
      const devicesOnly = parseConfig({ ...base, publicOrigin: 'https://wayroost.example.com' });
      expect(devicesOnly.devices.enabled).toBe(true);
      expect(devicesOnly.access).toBeUndefined();
      // Access alone still works, as Signalbox did.
      expect(parseConfig(withPatch({ devices: { enabled: false } })).access?.aud).toBe('abc123');
    });

    it('takes a list of origins, keeps publicOrigin as one of them, and allows each one\'s Host', () => {
      const cfg = parseConfig({
        ...valid,
        origins: ['https://box.tailnet.example', 'http://127.0.0.1:8881', 'https://wayroost.example.com'],
        listen: { host: '127.0.0.1', port: 8881 },
      });
      expect(cfg.publicOrigin).toBe('https://wayroost.example.com');
      expect(cfg.origins).toEqual([
        { origin: 'https://wayroost.example.com', host: 'wayroost.example.com', local: false },
        { origin: 'https://box.tailnet.example', host: 'box.tailnet.example', local: false },
        { origin: 'http://127.0.0.1:8881', host: '127.0.0.1:8881', local: true },
      ]);
      expect([...cfg.allowedHosts]).toEqual(
        expect.arrayContaining(['wayroost.example.com', 'box.tailnet.example', '127.0.0.1:8881', 'localhost:8881']),
      );
      // Without publicOrigin, the first https:// origin is the main one.
      const listOnly = parseConfig({ ...base, origins: ['http://127.0.0.1:8881', 'https://box.tailnet.example'] });
      expect(listOnly.publicOrigin).toBe('https://box.tailnet.example');
    });

    it('treats every loopback host as local, https:// too, and never as the public origin', () => {
      const cfg = parseConfig({
        ...base,
        publicOrigin: 'https://wayroost.example.com',
        origins: ['https://127.0.0.1:8443', 'https://localhost:8444', 'http://[::1]:8881'],
      });
      expect(cfg.origins.filter((o) => o.local).map((o) => o.origin)).toEqual([
        'https://127.0.0.1:8443',
        'https://localhost:8444',
        'http://[::1]:8881',
      ]);
      expect(() => parseConfig({ ...base, publicOrigin: 'https://127.0.0.1:8443' })).toThrow(/can't be a loopback one/);
      expect(() => parseConfig({ ...base, publicOrigin: 'https://localhost' })).toThrow(/can't be a loopback one/);
      expect(() =>
        parseConfig({ ...valid, devices: { enabled: false }, origins: ['https://127.0.0.1:8443'] }),
      ).toThrow(/need device sign-in/);
    });

    it('knows every spelling of a loopback host, so none of them slips through as the public origin', () => {
      const spellings = [
        'https://127.0.0.2',
        'https://127.255.255.254:8443',
        'https://127.1', // URL makes these 127.0.0.1
        'https://0x7f.1',
        'https://2130706433',
        'https://localhost.',
        'https://LOCALHOST..',
        'https://box.localhost',
        'https://box.localhost.',
        'https://[::ffff:127.0.0.1]',
        'https://[::ffff:7f00:2]',
        'https://[0:0:0:0:0:0:0:1]',
        'https://0.0.0.0',
        'https://[::]',
      ];
      for (const publicOrigin of spellings) {
        expect(() => parseConfig({ ...base, publicOrigin: new URL(publicOrigin).origin }), publicOrigin).toThrow(/can't be a loopback one/);
      }
      // Listed, each is a local origin: the desktop app's alone.
      const listed = ['https://127.0.0.2', 'https://localhost.:8443', 'https://box.localhost', 'https://[::ffff:7f00:1]', 'http://127.0.0.5:8881'];
      const cfg = parseConfig({ ...base, publicOrigin: 'https://wayroost.example.com', origins: listed });
      expect(cfg.origins.filter((o) => o.local).map((o) => o.origin)).toEqual(listed);
      // Hosts that only look local are not.
      const remote = parseConfig({
        ...base,
        publicOrigin: 'https://localhost.example.com',
        origins: ['https://127.0.0.1.example.com', 'https://[::2]', 'https://128.0.0.1'],
      });
      expect(remote.origins.some((o) => o.local)).toBe(false);
    });

    it('listens on and talks to loopback addresses only, never the unspecified ones', () => {
      const ok = parseConfig(
        withPatch({ listen: { host: '127.0.0.2', port: 19010 }, hermes: { url: 'http://[::1]:19006' }, paseo: { url: 'ws://127.0.0.3:19007' } }),
      );
      expect(ok.listen.host).toBe('127.0.0.2');
      for (const host of ['0.0.0.0', '::', 'box.localhost', 'localhost.example.com', '127.1']) {
        expect(() => parseConfig(withPatch({ listen: { host, port: 19010 } })), host).toThrow(/loopback/);
      }
      expect(() => parseConfig(withPatch({ hermes: { url: 'http://0.0.0.0:19006' } }))).toThrow(/loopback/);
    });

    it('refuses two origins on one Host, in either order', () => {
      for (const origins of [
        ['http://127.0.0.1:8900', 'https://127.0.0.1:8900'],
        ['https://127.0.0.1:8900', 'http://127.0.0.1:8900'],
      ]) {
        expect(() => parseConfig({ ...base, publicOrigin: 'https://wayroost.example.com', origins }), origins.join(' ')).toThrow(
          /shares its host/,
        );
      }
      // The dev-only http publicOrigin can't share a Host with a listed origin either.
      expect(() =>
        parseConfig({ ...base, publicOrigin: 'http://127.0.0.1:8900', origins: ['https://127.0.0.1:8900'] }, { allowLocalDev: true }),
      ).toThrow(/shares its host/);
      // The same origin twice is just one entry.
      const twice = parseConfig({ ...base, publicOrigin: 'https://wayroost.example.com', origins: ['https://wayroost.example.com'] });
      expect(twice.origins).toHaveLength(1);
    });

    it.each([
      ['no origin at all', { ...base }],
      ['a plain-http origin that is not loopback', { ...base, origins: ['http://wayroost.example.com'] }],
      ['an origin with a path', { ...base, origins: ['https://wayroost.example.com/app'] }],
      ['an origin that is not a URL', { ...base, origins: ['wayroost.example.com'] }],
      ['a local origin with device sign-in off', { ...valid, devices: { enabled: false }, origins: ['http://127.0.0.1:8881'] }],
      ['unknown keys in devices', { ...base, publicOrigin: 'https://wayroost.example.com', devices: { enabled: true, open: true } }],
    ])('rejects %s', (_name, input) => {
      expect(() => parseConfig(input)).toThrow(ConfigError);
    });
  });
});
