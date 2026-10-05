import { describe, expect, it } from 'vitest';
import {
  CONSUMER_TARGETS, GATEWAY_ADMIN_ROUTES, GATEWAY_CONSUMERS, GATEWAY_ROLES, ROLE_PROVIDERS, backendFitsContract,
  gatewayCredentialTestBodySchema, gatewayCredentialTestResultSchema, gatewayMigrationSchema, gatewayRepointBodySchema, gatewayRepointResultSchema, gatewayStateSchema, isGatewayUrl,
  isLoopbackHost, isLoopbackUrl, roleMapProviders, roleMapSchema, type RoleContract,
} from '../../shared/gateway.js';

describe('stored credential tests', () => {
  it('uses a root-only admin route with a transient key override', () => {
    expect(GATEWAY_ADMIN_ROUTES.credentialTest('demo-cloud')).toBe('/v1/credentials/demo-cloud/test');
    expect(gatewayCredentialTestBodySchema.safeParse({ backend: 'demo-cloud-backend', secret: 'demo-key-0123' }).success).toBe(true);
    expect(gatewayCredentialTestBodySchema.safeParse({ backend: 'demo-cloud-backend', secret: 'demo-key-0123', prompt: 'arbitrary prompt' }).success).toBe(false);
  });

  it('returns fixed results without keys, content or upstream errors', () => {
    const success = { ok: true, provider: 'demo-cloud', backend: 'demo-cloud-backend' };
    expect(gatewayCredentialTestResultSchema.safeParse(success).success).toBe(true);
    for (const code of ['credential_missing', 'credential_rejected', 'backend_unavailable', 'test_failed']) {
      expect(gatewayCredentialTestResultSchema.safeParse({ ok: false, code }).success).toBe(true);
      expect(gatewayCredentialTestResultSchema.safeParse({ ok: false, code, message: 'upstream details' }).success).toBe(false);
    }
    expect(gatewayCredentialTestResultSchema.safeParse({ ...success, secret: 'demo-key' }).success).toBe(false);
  });
});

const textContract: RoleContract = { input: ['text'], toolCalling: true, thinkingLevels: false, maxOutputTokens: 8192, advertisedContext: 262_144 };
const local = (port: number, servedName: string, extra: Record<string, unknown> = {}) => ({
  baseUrl: `http://127.0.0.1:${port}/v1`, servedName, contextLength: 131_072, maxOutputTokens: 16_384,
  input: ['text'], toolCalling: true, thinkingLevels: true, listenerUid: 0, ...extra,
});

/** A role map with invented backends, built fresh for each test. */
function roleMap(): Record<string, any> {
  return {
    version: 2,
    contracts: { main: textContract, coder: { ...textContract, advertisedContext: 131_072 }, fast: { ...textContract, advertisedContext: 131_072 } },
    backends: {
      'demo-main': local(19041, 'demo-main-model', { contextLength: 262_144, input: ['text', 'image'] }),
      'demo-main-alt': local(19042, 'demo-main-alt-model', { provider: 'demo-local' }),
      'demo-coder': local(19043, 'demo-coder-model'),
      'demo-small': local(19044, 'demo-small-model', { contextLength: 65_536, thinkingLevels: false, maxOutputTokens: 8192 }),
      'demo-cloud': { baseUrl: 'https://api.example.com/v1', servedName: 'vendor/demo-model', provider: 'demo-cloud', contextLength: 200_000,
        maxOutputTokens: 32_000, input: ['text', 'image'], toolCalling: true, thinkingLevels: true, price: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 } },
    },
    profiles: {
      'demo-profile/demo-engine': { main: 'demo-main', coder: 'demo-coder', fast: 'demo-coder' },
      'demo-profile/demo-fallback': { main: 'demo-main-alt', coder: 'demo-coder', fast: 'demo-coder' },
      'demo-large/demo-engine': { main: 'demo-small', coder: null, fast: null },
    },
    roles: { main: 'demo-main', coder: 'demo-coder', fast: 'demo-coder' },
  };
}
const parses = (map: unknown) => roleMapSchema.safeParse(map).success;

describe('role contracts', () => {
  it('fit a backend that offers at least what the role lets consumers ask for', () => {
    const backend = { input: ['text', 'image'] as ('text' | 'image')[], toolCalling: true, thinkingLevels: true, maxOutputTokens: 16_384 };
    expect(backendFitsContract(backend, textContract)).toBe(true);
    expect(backendFitsContract({ ...backend, toolCalling: false }, textContract)).toBe(false);
    expect(backendFitsContract({ ...backend, maxOutputTokens: 4096 }, textContract)).toBe(false);
    expect(backendFitsContract({ ...backend, input: ['text'] }, { ...textContract, input: ['text', 'image'] })).toBe(false);
    expect(backendFitsContract({ ...backend, thinkingLevels: false }, { ...textContract, thinkingLevels: true })).toBe(false);
    expect(backendFitsContract({ ...backend, thinkingLevels: false }, textContract)).toBe(true);
  });

  it('let a backend with a smaller window serve a role that advertises a larger one', () => {
    const map = roleMap();
    map.roles.main = 'demo-small';
    expect(parses(map)).toBe(true);
  });
});

describe('the role map', () => {
  it('parses a map with profile rows, unmapped roles and a remote backend', () => {
    const parsed = roleMapSchema.parse(roleMap());
    expect(parsed.profiles['demo-large/demo-engine']).toEqual({ main: 'demo-small', coder: null, fast: null });
    expect(roleMapProviders(parsed)).toEqual(['demo-cloud', 'demo-local']);
  });

  it('refuses a mapping outside the role\'s contract, in a profile row or now', () => {
    const now = roleMap();
    now.contracts.main = { ...textContract, input: ['text', 'image'] };
    now.roles.main = 'demo-coder';
    expect(parses(now)).toBe(false);
    const row = roleMap();
    row.contracts.coder = { ...textContract, maxOutputTokens: 100_000 };
    expect(parses(row)).toBe(false);
  });

  it('refuses a mapping to a backend it does not have', () => {
    const map = roleMap();
    map.profiles['demo-profile/demo-engine'].fast = 'missing';
    expect(parses(map)).toBe(false);
    const inherited = roleMap();
    inherited.roles.coder = 'constructor';
    expect(parses(inherited)).toBe(false);
  });

  it('needs every role in every row, and nothing more', () => {
    const missing = roleMap();
    delete missing.roles.fast;
    expect(parses(missing)).toBe(false);
    const extra = roleMap();
    extra.roles.vision = 'demo-main';
    expect(parses(extra)).toBe(false);
    const badKey = roleMap();
    badKey.profiles['demo-profile'] = badKey.roles;
    expect(parses(badKey)).toBe(false);
  });

  it('names the listener owner for loopback backends only', () => {
    const missing = roleMap();
    delete missing.backends['demo-coder'].listenerUid;
    expect(parses(missing)).toBe(false);
    const remote = roleMap();
    remote.backends['demo-cloud'].listenerUid = 0;
    expect(parses(remote)).toBe(false);
  });

  it.each(['127.0.0.0', '127.0.0.2', '127.255.255.255', '[::1]', 'localhost'])('requires ownership for HTTPS loopback backend %s', host => {
    const map = roleMap();
    map.backends['demo-coder'].baseUrl = `https://${host}:19043/v1`;
    expect(parses(map)).toBe(true);
    delete map.backends['demo-coder'].listenerUid;
    expect(parses(map)).toBe(false);
  });

  it('holds credential names, never keys', () => {
    const inline = roleMap();
    inline.backends['demo-cloud'].apiKey = 'demo-not-a-real-key';
    expect(parses(inline)).toBe(false);
    const path = roleMap();
    path.backends['demo-cloud'].provider = '../demo-cloud';
    expect(parses(path)).toBe(false);
  });

  it('refuses old or unknown versions', () => {
    expect(parses({ ...roleMap(), version: 1 })).toBe(false);
  });
});

describe('backend addresses', () => {
  it('shares one exact loopback definition for hosts and URLs', () => {
    for (const host of ['127.0.0.0', '127.0.0.2', '127.255.255.255', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']) {
      expect(isLoopbackHost(host), host).toBe(true);
      const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
      expect(isLoopbackUrl(`http://${authority}:19041/v1`), host).toBe(true);
    }
    for (const host of ['126.255.255.255', '128.0.0.0', '127.256.0.1', '127.01.0.1', '127.1', '0.0.0.0', '::',
      '::2', '::ffff:127.0.0.1', '[::ffff:7f00:1]', 'localhost.', 'box.localhost', 'localhost.example.com', '127.0.0.1.example.com']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
    for (const host of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', 'localhost.', 'box.localhost', '0.0.0.0']) {
      expect(isGatewayUrl(`http://${host}:19041/v1`), host).toBe(false);
      expect(isLoopbackUrl(`https://${host}:19041/v1`), host).toBe(false);
      const map = roleMap();
      map.backends['demo-coder'].baseUrl = `https://${host}:19043/v1`;
      expect(parses(map), host).toBe(false);
      delete map.backends['demo-coder'].listenerUid;
      expect(parses(map), host).toBe(true);
    }
  });

  it('allow http on loopback and https anywhere, with nothing that re-routes the path', () => {
    for (const url of ['http://127.0.0.1:19041/v1', 'http://localhost:19041/v1', 'http://[::1]:19041/v1', 'https://api.example.com/v1']) {
      expect(isGatewayUrl(url), url).toBe(true);
    }
    for (const url of ['http://api.example.com/v1', 'http://user:pass@127.0.0.1:19041/v1', 'https://api.example.com/v1?key=x',
      'https://api.example.com/v1#x', 'https://api.example.com/%2e%2e/v1', 'https://api.example.com/v1%2Fx', 'file:///etc/passwd',
      'https://api.example.com/v 1', 'not a url', `https://example.com/${'a'.repeat(2048)}`]) {
      expect(isGatewayUrl(url), url).toBe(false);
    }
  });
});

describe('the admin repoint', () => {
  it('names a backend from the map, or none', () => {
    expect(GATEWAY_ADMIN_ROUTES.role('coder')).toBe('/v1/roles/coder');
    expect(gatewayRepointBodySchema.safeParse({ backend: 'demo-coder' }).success).toBe(true);
    expect(gatewayRepointBodySchema.safeParse({ backend: null }).success).toBe(true);
    expect(gatewayRepointBodySchema.safeParse({ backend: { baseUrl: 'http://127.0.0.1:19041/v1', model: 'demo' } }).success).toBe(false);
    expect(gatewayRepointBodySchema.safeParse({ backend: 'demo-coder', credentialFile: '/etc/shadow' }).success).toBe(false);
    expect(gatewayRepointResultSchema.safeParse({ role: 'main', backend: 'demo-main', applied: true }).success).toBe(true);
  });

  it('gives each role a provider name consumers use', () => {
    expect(GATEWAY_ROLES.map(role => ROLE_PROVIDERS[role])).toEqual(['wayroost-main', 'wayroost-coder', 'wayroost-fast']);
  });
});

describe('gateway state files', () => {
  it('record the profile brought up and manual overrides', () => {
    expect(gatewayStateSchema.safeParse({ version: 1, profile: null, engine: null, broughtUpAt: null, overrides: {} }).success).toBe(true);
    const state = {
      version: 1, profile: 'demo-profile', engine: 'demo-engine', broughtUpAt: '2026-01-02T03:04:05.000Z',
      overrides: { main: { backend: 'demo-main-alt', at: '2026-01-02T03:05:00.000Z', by: 'wayroost' } },
    };
    expect(gatewayStateSchema.safeParse(state).success).toBe(true);
    expect(gatewayStateSchema.safeParse({ ...state, overrides: { vision: state.overrides.main } }).success).toBe(false);
    expect(gatewayStateSchema.safeParse({ ...state, broughtUpAt: '2026-01-02 03:04' }).success).toBe(false);
  });

  const record = {
    moved: true, movedAt: '2026-01-02T03:04:05.000Z', preMoveBackupSha256: 'a'.repeat(64), postMoveSha256: 'b'.repeat(64),
    keys: [
      { path: ['model', 'default'], kind: 'model-dependent', before: { exists: true, value: 'demo-model' }, intended: { exists: true, value: 'main' } },
      { path: ['agent', 'tool_use_enforcement'], kind: 'recorded', before: { exists: false }, intended: { exists: true, value: ['demo', 'main'] } },
    ],
  };

  it('record each consumer\'s files with values before and intended, absence included', () => {
    const migration = { version: 1, consumers: { hermes: { 'hermes-config': record }, phone: { 'phone-bridge-dropin': { ...record, keys: [] } } } };
    expect(gatewayMigrationSchema.safeParse(migration).success).toBe(true);
    expect(gatewayMigrationSchema.safeParse({ version: 1, consumers: {} }).success).toBe(true);
  });

  it('refuse a file that isn\'t one of the consumer\'s', () => {
    expect(gatewayMigrationSchema.safeParse({ version: 1, consumers: { hermes: { 'pi-mcp': record } } }).success).toBe(false);
    expect(gatewayMigrationSchema.safeParse({ version: 1, consumers: { 'demo-consumer': {} } }).success).toBe(false);
  });

  it('match the consumers and files the moves touch', () => {
    const shape = gatewayMigrationSchema.shape.consumers.shape;
    expect(Object.keys(shape).sort()).toEqual([...GATEWAY_CONSUMERS].sort());
    for (const consumer of GATEWAY_CONSUMERS) {
      expect(Object.keys(shape[consumer].unwrap().shape).sort(), consumer).toEqual([...CONSUMER_TARGETS[consumer]].sort());
    }
  });

  it('refuse a recorded value that isn\'t plain JSON', () => {
    const bad = { ...record, keys: [{ ...record.keys[0], before: { exists: true, value: JSON.parse('{"__proto__": {"x": 1}}') } }] };
    expect(gatewayMigrationSchema.safeParse({ version: 1, consumers: { hermes: { 'hermes-config': bad } } }).success).toBe(false);
    const both = { ...record, keys: [{ ...record.keys[1], before: { exists: false, value: 'x' } }] };
    expect(gatewayMigrationSchema.safeParse({ version: 1, consumers: { hermes: { 'hermes-config': both } } }).success).toBe(false);
  });
});
