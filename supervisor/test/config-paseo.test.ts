import { expect, it, vi } from 'vitest';
import { configuredPaseoReload, createPaseoReload } from '../src/config-paseo.js';
import type { PaseoExpectedConfig } from '../src/config-paseo.js';

const expected: PaseoExpectedConfig = { ok: true, view: 'paseo.agents', present: true, sha256: 'a'.repeat(64), values: [
  { path: ['agents', 'providers', 'codex', 'enabled'], exists: true, value: false },
  { path: ['daemon', 'appendSystemPrompt'], exists: true, value: 'note 🦉' },
] };

it('reloads through the supported API and refuses results the daemon could not apply', async () => {
  const reload = vi.fn(async () => ({ restartRequiredPaths: [] as string[], overrideControlledPaths: [] as string[] }));
  const effectiveConfig = vi.fn(async () => ({ providers: { codex: { enabled: false } }, appendSystemPrompt: 'note 🦉' }));
  const client = vi.fn(() => ({ reload, effectiveConfig }));
  const run = createPaseoReload('ws://127.0.0.1:8891/ws', 'fake-password', client);
  expect(client).toHaveBeenCalledWith('ws://127.0.0.1:8891/ws', 'fake-password');
  expect(await run(expected)).toBe(true);
  effectiveConfig.mockResolvedValue({ providers: { codex: { enabled: true } }, appendSystemPrompt: 'note 🦉' });
  expect(await run(expected)).toBe(false);
  effectiveConfig.mockResolvedValue({ providers: { codex: { enabled: false } }, appendSystemPrompt: 'outside save' });
  expect(await run(expected)).toBe(false);
  effectiveConfig.mockResolvedValue({ providers: { codex: { enabled: false } }, appendSystemPrompt: 'note 🦉' });
  reload.mockResolvedValue({ restartRequiredPaths: ['daemon.agentProfiles'], overrideControlledPaths: [] });
  expect(await run(expected)).toBe(false);
  reload.mockResolvedValue({ restartRequiredPaths: [], overrideControlledPaths: ['providers.codex.enabled'] });
  expect(await run(expected)).toBe(false);
  reload.mockRejectedValue(new Error('fake-private-text'));
  expect(await run(expected)).toBe(false);
});

it.each(['ws://example.com/ws', 'https://127.0.0.1:8891/ws', 'ws://you@example.com:fake@127.0.0.1:8891/ws', 'bad'])('refuses an unconfigured connection %s', url => {
  expect(() => createPaseoReload(url)).toThrow('not_configured');
});

it('keeps reload disabled until the root unit configures it', async () => {
  expect(await configuredPaseoReload({})).toBeUndefined();
});

it('verifies effective provider defaults when an undo removes the persisted entry', async () => {
  const effectiveConfig = vi.fn(async () => ({ providers: { codex: { enabled: false } }, appendSystemPrompt: '' }));
  const run = createPaseoReload('ws://127.0.0.1:8891/ws', undefined, () => ({
    reload: async () => ({ restartRequiredPaths: [], overrideControlledPaths: [] }), effectiveConfig,
  }));
  const restored: PaseoExpectedConfig = { ...expected, values: [{ path: ['daemon', 'appendSystemPrompt'], exists: false }] };
  expect(await run(restored)).toBe(false);
  effectiveConfig.mockResolvedValue({ providers: { codex: { enabled: true } }, appendSystemPrompt: '' });
  expect(await run(restored)).toBe(true);
});
