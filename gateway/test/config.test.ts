import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig, ROLE_PORTS } from '../src/config.js';
import { demoMap } from './map-fixture.js';

 describe('gateway role maps', () => {
  it('uses stable ports without binding and parses profile rows', () => {
    expect(ROLE_PORTS).toEqual({ main: 18010, coder: 18011, fast: 18012 });
    expect(parseConfig(demoMap())).toEqual(demoMap());
  });
  it('requires only named credentials and canonicalizes backend URLs', () => {
    const map = demoMap();
    map.backends['demo-a'] = { ...map.backends['demo-a']!, baseUrl: 'https://api.example.com/v1/', provider: 'demo-key', listenerUid: undefined };
    expect(parseConfig(map, '/home/me/credentials').backends['demo-a']?.baseUrl).toBe('https://api.example.com/v1');
  });
  it.each(['input', 'toolCalling', 'thinkingLevels', 'maxOutputTokens'] as const)('rejects a backend outside the %s contract', key => {
    const map = demoMap();
    if (key === 'input') map.contracts.main.input = ['image', 'text'];
    if (key === 'toolCalling') map.backends['demo-a']!.toolCalling = false;
    if (key === 'thinkingLevels') map.contracts.main.thinkingLevels = true;
    if (key === 'maxOutputTokens') map.backends['demo-a']!.maxOutputTokens = 1;
    expect(() => parseConfig(map)).toThrow(ConfigError);
  });
  it.each([
    'http://api.example.com/v1', 'https://fake-key@api.example.com/v1', 'https://api.example.com/v1?',
    'http://127.0.0.1:8899/v1#', 'http://127.0.0.1.example.com/v1', 'http://127.0.0.1:8899/v1\\other',
    'http://127.0.0.1:8899/v1/%2e%2e', 'not a URL',
  ])('rejects unsafe backend URL %s', baseUrl => {
    const map = demoMap(); map.backends['demo-a']!.baseUrl = baseUrl;
    expect(() => parseConfig(map)).toThrow(ConfigError);
  });
  it('rejects unknown backends, inline keys, missing UIDs, and invalid profile contracts', () => {
    const map = demoMap();
    expect(() => parseConfig({ ...map, roles: { ...map.roles, main: 'missing' } })).toThrow(ConfigError);
    expect(() => parseConfig({ ...map, backends: { ...map.backends, 'demo-a': { ...map.backends['demo-a'], apiKey: 'fake-key' } } })).toThrow(ConfigError);
    delete map.backends['demo-a']!.listenerUid;
    expect(() => parseConfig(map)).toThrow(ConfigError);
    expect(() => parseConfig({ ...demoMap(), version: 1 })).toThrow(ConfigError);
  });
});
