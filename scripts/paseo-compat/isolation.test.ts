import { BUILTIN_PROVIDER_IDS } from '@getpaseo/protocol/provider-manifest';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compatProviders, isolatedDaemonEnv, startCompatDaemon } from './isolation.js';

describe('Paseo compatibility isolation', () => {
  it('uses only the assigned development ports when the first is occupied', async () => {
    const busy = Object.assign(new Error('fake port busy'), { code: 'EADDRINUSE' });
    const start = vi.fn().mockRejectedValueOnce(busy).mockResolvedValueOnce('fake-daemon');
    expect(await startCompatDaemon(start)).toBe('fake-daemon');
    expect(start.mock.calls).toEqual([['127.0.0.1:8892'], ['127.0.0.1:8893']]);
    const bothBusy = vi.fn().mockRejectedValue(busy);
    await expect(startCompatDaemon(bothBusy)).rejects.toBe(busy);
    expect(bothBusy).toHaveBeenCalledTimes(2);
    const refused = Object.assign(new Error('fake start failure'), { code: 'EACCES' });
    const failed = vi.fn().mockRejectedValue(refused);
    await expect(startCompatDaemon(failed)).rejects.toBe(refused);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('updates native home resolution without replacing the process environment', () => {
    const root = '/tmp/fake-paseo-native-home';
    const helper = new URL('./isolation.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { homedir } from 'node:os';
      import { isolateDaemonEnv } from ${JSON.stringify(helper)};
      const original = process.env;
      isolateDaemonEnv(${JSON.stringify(root)});
      console.log(JSON.stringify({ home: homedir(), same: original === process.env, env: process.env }));
    `], { encoding: 'utf8', env: { PATH: '/usr/bin', HOME: '/home/me', USERPROFILE: '/home/me', CODEX_HOME: '/home/me/external' } });
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.home).toBe(join(root, 'home'));
    expect(result.same).toBe(true);
    expect(result.env.CODEX_HOME).toBeUndefined();
    expect(result.env.HOME).toBe(join(root, 'home'));
  });

  it('contains home, XDG, provider and temporary paths and removes inherited output paths', () => {
    const root = '/tmp/fake-paseo-home';
    const external = '/home/me/external';
    const inherited = Object.fromEntries([
      'HOME', 'USERPROFILE', 'PASEO_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
      'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'TMP', 'TEMP', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
      'PI_CODING_AGENT_DIR', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT',
      'PASEO_GIT_TRACE_FILE', 'PASEO_DICTATION_DEBUG_DIR', 'TTS_DEBUG_AUDIO_DIR', 'GIT_TRACE',
      'GIT_TRACE2_EVENT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'BASH_ENV', 'NODE_OPTIONS',
      'CREDENTIALS_DIRECTORY', 'PASEO_AGENT_ID', 'HERMES_SESSION_ID',
    ].map((key) => [key, external]));
    const env = isolatedDaemonEnv(root, { ...inherited, PATH: '/usr/bin', PASEO_DEBUG: '1' });

    expect(env.HOME).toBe(join(root, 'home'));
    expect(env.USERPROFILE).toBe(join(root, 'home'));
    expect(env.XDG_CONFIG_HOME).toBe(join(root, 'home', '.config'));
    for (const key of ['PASEO_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
      'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'TMP', 'TEMP']) {
      expect(env[key], key).toBeDefined();
    }
    for (const [key, value] of Object.entries(env)) {
      if (key === 'PATH' || !value || !isAbsolute(value)) continue;
      const path = relative(root, value);
      expect(path === '' || (!path.startsWith('..') && !isAbsolute(path)), key).toBe(true);
    }
    expect(Object.values(env)).not.toContain(external);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    for (const key of ['GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF']) expect(env[key], key).toBe('0');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.PASEO_DEBUG).toBe('1');
    expect(inherited.PASEO_HOME).toBe(external);
  });

  it('disables every daemon builtin before discovery, including future providers', () => {
    const ids = [...BUILTIN_PROVIDER_IDS, 'fake-future-builtin'];
    const providers = compatProviders(ids, '/usr/bin/node', '/tmp/fake-acp-agent.mjs');
    for (const id of ids) expect(providers).toHaveProperty(`${id}.enabled`, false);
    for (const id of ['fakeacp', 'fakemodes', 'hermes']) {
      expect(providers).toHaveProperty(`${id}.extends`, 'acp');
      expect(providers).toHaveProperty(`${id}.command.0`, '/usr/bin/node');
      expect(providers).toHaveProperty(`${id}.command.1`, '/tmp/fake-acp-agent.mjs');
    }
  });
});
