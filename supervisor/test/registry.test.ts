import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildRegistry, loadRegistry } from '../src/registry.js';
import { configSchema } from '../src/config.js';
import { DemoSupervisor } from '../../scripts/demo-power.js';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

it('uses invented model profiles and local ports in the built-in registry and demo', () => {
  const registry = buildRegistry();
  const profiles = registry.find(entry => entry.id === 'main-model')!.profiles!;
  expect(profiles.map(profile => [profile.id, profile.name, new URL(profile.health.url).port]))
    .toEqual([['main-model', 'Main model', '19001'], ['fast', 'Fast model', '19002'], ['balanced', 'Balanced model', '19003'], ['large', 'Large model', '19004']]);
  for (const entry of registry) if (entry.health.kind === 'http')
    expect(Number(new URL(entry.health.url).port)).toBeGreaterThanOrEqual(19001);
  const demo = new DemoSupervisor();
  expect(demo.snapshot().components.find(entry => entry.id === 'main-model')?.model?.profiles.map(profile => profile.id))
    .toEqual(['main-model', 'balanced', 'large']);
  for (const entry of demo.snapshot().components) if (entry.details?.Port)
    expect(Number(entry.details.Port)).toBeGreaterThanOrEqual(19001);
  demo.stop();
});

it('loads the generic example in status-only mode and falls back safely when it is absent', async () => {
  const path = new URL('../../deploy/components.example.json', import.meta.url).pathname;
  const registry = await loadRegistry(path);
  expect(registry).toEqual(buildRegistry());
  const config = configSchema.parse(JSON.parse(await readFile(new URL('../../deploy/supervisor.example.json', import.meta.url), 'utf8')));
  expect(config.statusOnly).toBe(true);
  expect(config.registryOverrides).toBe('/etc/wayroost/components.local.json');
  const folder = await mkdtemp(join(process.cwd(), '.registry-test-')); folders.push(folder);
  expect(await loadRegistry(join(folder, 'absent.json'))).toEqual(buildRegistry());
});

it('takes profiles, GPU assignments, owners and probes from an operator configuration', async () => {
  const folder = await mkdtemp(join(process.cwd(), '.registry-test-')); folders.push(folder);
  const path = join(folder, 'components.json');
  await writeFile(path, JSON.stringify([
    { id: 'main-model', gpus: [2], profiles: [{ id: 'demo-profile', name: 'Demo profile', gpus: [2], health: { kind: 'http', url: 'http://127.0.0.1:19021/health' } }] },
    { id: 'hermes-gateway', unit: { name: 'demo-gateway.service', scope: 'user', user: 'demo-owner' } },
  ]));
  const registry = await loadRegistry(path, { launchScript: '/opt/demo/launch.sh' });
  const main = registry.find(entry => entry.id === 'main-model')!;
  expect(main.gpus).toEqual([2]);
  expect(main.profiles?.map(profile => profile.id)).toEqual(['demo-profile']);
  expect(main.start).toEqual(['/opt/demo/launch.sh', 'demo-profile']);
  expect(main.profiles?.[0]?.argv).toEqual(['/opt/demo/launch.sh', 'demo-profile']);
  expect(registry.find(entry => entry.id === 'hermes-gateway')?.restart)
    .toEqual(['systemctl', '--user', '-M', 'demo-owner@', 'restart', 'demo-gateway.service']);
});

it('checks production registry trust before reading operator commands', async () => {
  const trust = vi.fn().mockRejectedValue(new Error('Untrusted configuration'));
  await expect(loadRegistry('/home/me/components.json', {}, trust)).rejects.toThrow('Untrusted configuration');
  expect(trust).toHaveBeenCalledWith('/home/me/components.json');
});
