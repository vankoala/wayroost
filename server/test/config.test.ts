import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.js';

const valid = {
  publicOrigin: 'https://signalbox.example.com',
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
    expect(cfg.listen).toEqual({ host: '127.0.0.1', port: 8790 });
    expect(cfg.access.issuer).toBe('https://myteam.cloudflareaccess.com');
    expect(cfg.access.jwksUrl).toBe('https://myteam.cloudflareaccess.com/cdn-cgi/access/certs');
    expect(cfg.access.allowedEmails).toEqual(['me@example.com']);
    expect(cfg.hermes.url).toBe('http://127.0.0.1:9119');
    expect(cfg.hermes.secretPrompts).toBe(false);
    expect(cfg.paseo.url).toBe('ws://127.0.0.1:6777');
    expect([...cfg.allowedHosts]).toContain('signalbox.example.com');
  });

  it.each([
    ['listening on every interface', withPatch({ listen: { host: '0.0.0.0', port: 8790 } })],
    ['a plain-http public origin', withPatch({ publicOrigin: 'http://signalbox.example.com' })],
    ['a public origin with a path', withPatch({ publicOrigin: 'https://signalbox.example.com/app' })],
    [
      'a team domain that is not Cloudflare Access',
      withPatch({ access: { ...valid.access, teamDomain: 'https://evil.example.com' } }),
    ],
    ['no allowed emails', withPatch({ access: { ...valid.access, allowedEmails: [] } })],
    ['a remote Hermes', withPatch({ hermes: { url: 'http://192.0.2.5:9119' } })],
    ['a remote Paseo', withPatch({ paseo: { url: 'ws://192.0.2.5:6777' } })],
    ['unknown keys', withPatch({ debugDisableAuth: true })],
    ['unknown keys in listen', withPatch({ listen: { host: '127.0.0.1', port: 8790, hots: '0.0.0.0' } })],
    ['unknown keys in access', withPatch({ access: { ...valid.access, allowedEmail: ['x@example.com'] } })],
    ['a Hermes URL that is not http', withPatch({ hermes: { url: 'file://127.0.0.1/etc' } })],
    ['a relative state directory', withPatch({ stateDir: 'relative/dir' })],
    ['a non-ASCII allowed email', withPatch({ access: { ...valid.access, allowedEmails: ['\u212Aate@example.com'] } })],
    [
      'a local key server (would let local processes mint tokens)',
      withPatch({ access: { ...valid.access, teamDomain: 'http://127.0.0.1:8799' } }),
    ],
    ['a plain-http loopback origin', withPatch({ publicOrigin: 'http://127.0.0.1:8790' })],
    ['Hermes secret prompts turned on with a non-boolean', withPatch({ hermes: { secretPrompts: 'yes' } })],
    ['a misspelled Hermes secret prompts switch', withPatch({ hermes: { secretPrompt: true } })],
  ])('rejects %s', (_name, input) => {
    expect(() => parseConfig(input)).toThrow(ConfigError);
  });

  it('answers Hermes password prompts from the phone only when explicitly turned on', () => {
    expect(parseConfig(withPatch({ hermes: { secretPrompts: true } })).hermes).toEqual({
      enabled: true,
      url: 'http://127.0.0.1:9119',
      secretPrompts: true,
    });
    expect(parseConfig(withPatch({ hermes: { enabled: true } })).hermes.secretPrompts).toBe(false);
  });

  it('allows loopback Access and http origins only in explicit local-dev mode', () => {
    const local = withPatch({
      publicOrigin: 'http://127.0.0.1:8798',
      access: { ...valid.access, teamDomain: 'http://127.0.0.1:8799' },
    });
    expect(() => parseConfig(local)).toThrow(ConfigError);
    expect(parseConfig(local, { allowLocalDev: true }).access.issuer).toBe('http://127.0.0.1:8799');
  });
});
