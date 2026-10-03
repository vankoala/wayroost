import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { configPath } from '../src/config.js';
import { wayroostEnv } from '../src/environment.js';

describe('Wayroost names and environment compatibility', () => {
  it('defaults to /etc/wayroost/config.json and accepts both config variables', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(configPath({})).toBe('/etc/wayroost/config.json');
    expect(configPath({ WAYROOST_CONFIG: '/home/me/wayroost.json', SIGNALBOX_CONFIG: '/home/me/legacy.json' })).toBe('/home/me/wayroost.json');
    expect(configPath({ SIGNALBOX_CONFIG: '/home/me/legacy.json' })).toBe('/home/me/legacy.json');
    expect(configPath({ SIGNALBOX_CONFIG: '/home/me/legacy.json' })).toBe('/home/me/legacy.json');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('Wayroost: SIGNALBOX_CONFIG is deprecated; use WAYROOST_CONFIG.');
    warn.mockRestore();
  });

  it.each(['DEV_ALLOW_LOOPBACK', 'ASSIST_URLS', 'LOG_LEVEL'])('prefers WAYROOST_%s and warns once about its fallback without values', (suffix) => {
    const warn = vi.fn();
    const env = { [`SIGNALBOX_${suffix}`]: 'fake-legacy-value', [`WAYROOST_${suffix}`]: 'fake-current-value' };
    expect(wayroostEnv(suffix, env, warn)).toBe('fake-current-value');
    expect(warn).not.toHaveBeenCalled();
    delete env[`WAYROOST_${suffix}`];
    expect(wayroostEnv(suffix, env, warn)).toBe('fake-legacy-value');
    expect(wayroostEnv(suffix, env, warn)).toBe('fake-legacy-value');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).not.toContain('fake-legacy-value');
  });

  it('uses Wayroost in app titles and the install manifest', () => {
    const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
    const manifest = JSON.parse(readFileSync(new URL('../../web/public/manifest.webmanifest', import.meta.url), 'utf8'));
    expect(html).toContain('<title>Wayroost</title>');
    expect(html).toContain('name="apple-mobile-web-app-title" content="Wayroost"');
    expect(manifest).toMatchObject({ name: 'Wayroost', short_name: 'Wayroost' });
  });
});
