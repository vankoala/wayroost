import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareRegistry } from '../src/install-registry.js';
import { buildRegistry, loadRegistry } from '../src/registry.js';
import { configSchema } from '../src/config.js';
import { createSupervisor } from '../src/server.js';
import { trustAny } from './fixtures.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, lstat: vi.fn(actual.lstat), readlink: vi.fn(actual.readlink), readFile: vi.fn(actual.readFile) };
});

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await fs.rm(folder, { recursive: true, force: true });
  vi.resetAllMocks(); vi.unstubAllGlobals();
});

async function source(entries: unknown): Promise<string> {
  await fs.mkdir('.tmp', { recursive: true });
  const folder = await fs.mkdtemp(join(process.cwd(), '.tmp', 'install-registry-')); folders.push(folder);
  const path = join(folder, 'components.json');
  await fs.writeFile(path, JSON.stringify(entries));
  return path;
}

it('installs a validated snapshot even if the original is replaced after validation', async () => {
  const path = await source([{ id: 'coder', name: 'Demo operator coder', restart: ['/opt/demo/restart.sh'] }]);
  const trust = vi.fn(trustAny);
  const snapshot = await prepareRegistry(path, {}, trust);
  expect(trust).toHaveBeenCalledWith(path);
  expect(snapshot.generic).toBe(false);
  await fs.writeFile(path, '[{"id":"coder","restart":["/opt/demo/changed.sh"]}]');
  const installed = join(folders[0]!, 'installed.json');
  await fs.writeFile(installed, snapshot.contents);
  expect((await loadRegistry(installed)).find(entry => entry.id === 'coder')?.restart).toEqual(['/opt/demo/restart.sh']);
});

it('validates and compares the registry using the configured launcher and operator profiles', async () => {
  const adopt = { launchScript: '/opt/demo/launch.sh' };
  const generic = await prepareRegistry(await source([{ id: 'main-model' }]), adopt, trustAny);
  expect(generic.generic).toBe(true);
  const entries = [{ id: 'main-model', gpus: [2], profiles: [{ id: 'demo-profile', name: 'Demo profile', gpus: [2],
    health: { kind: 'http', url: 'http://127.0.0.1:19021/health' } }] }];
  const operator = await prepareRegistry(await source(entries), adopt, trustAny);
  expect(operator.generic).toBe(false);
  expect(buildRegistry(adopt, JSON.parse(operator.contents)).find(entry => entry.id === 'main-model')?.start)
    .toEqual(['/opt/demo/launch.sh', 'demo-profile']);
});

it.each([false, true])('starts and serves status with a generic or operator registry (operator: %s)', async operator => {
  const entries = operator ? [{ id: 'main-model', name: 'Demo operator model', gpus: [2],
    profiles: [{ id: 'demo-profile', name: 'Demo profile', gpus: [2], health: { kind: 'http', url: 'http://127.0.0.1:19021/health' } }] }]
    : JSON.parse(await fs.readFile('deploy/components.example.json', 'utf8'));
  const path = await source(entries);
  const folder = folders[0]!;
  const adopt = operator ? { launchScript: '/opt/demo/launch.sh' } : {};
  const snapshot = await prepareRegistry(path, adopt, trustAny);
  const installed = join(folder, 'installed.json'); await fs.writeFile(installed, snapshot.contents);
  const commands: string[][] = [];
  // Probes and lifecycle commands are fixtures; no generic or operator endpoint is contacted.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  const supervisor = createSupervisor({
    config: configSchema.parse({ development: true, socket: join(folder, 'socket'), stateDir: folder, rescuePort: 8899,
      statusOnly: snapshot.generic, adopt }),
    registry: await loadRegistry(installed, adopt), keys: [], trust: trustAny,
    exec: { async run(argv, line) { commands.push([...argv]); if (argv.includes('--property=LoadState')) line?.('loaded'); return 0; } },
  });
  await supervisor.start();
  try {
    const status = await supervisor.status();
    expect(snapshot.generic).toBe(!operator);
    if (!operator) {
      expect(status.notSetUp).toContainEqual({ id: 'main-model', name: 'Main model', sentence: 'Not set up on this PC.' });
      expect(status.components.every(entry => entry.actions.length === 0)).toBe(true);
      return;
    }
    const model = status.components.find(entry => entry.id === 'main-model')!;
    expect(model.state).toBe('up');
    expect(model.model?.live).toBe('demo-profile');
    const action = await supervisor.actions.start({ verb: 'restart', target: 'main-model' }, 'demo');
    await vi.waitFor(() => expect(action.state).toBe('done'));
    expect(commands.some(argv => argv.includes('/opt/demo/launch.sh') && argv.includes('demo-profile'))).toBe(true);
  } finally { await supervisor.close(); }
});

it.each([
  { at: '/', uid: 1000, mode: 0o755 },
  { at: '/demo', uid: 1000, mode: 0o755 },
  { at: '/demo', uid: 0, mode: 0o775 },
  { at: '/demo/components.json', uid: 1000, mode: 0o600 },
  { at: '/demo/components.json', uid: 0, mode: 0o622 },
  { at: '/operator', uid: 1000, mode: 0o755 },
])('refuses untrusted source paths before reading any commands: $at ($uid, $mode)', async ({ at, uid, mode }) => {
  vi.mocked(fs.lstat).mockImplementation(async path => {
    const name = String(path);
    return { uid: name === at ? uid : 0, mode: name === at ? mode : 0o755,
      isSymbolicLink: () => name === '/demo/linked', isFile: () => name.endsWith('.json') } as Stats;
  });
  vi.mocked(fs.readlink).mockResolvedValue('/operator');
  const path = at === '/operator' ? '/demo/linked/components.json' : '/demo/components.json';
  await expect(prepareRegistry(path)).rejects.toThrow('changed by someone other than root');
  expect(fs.readFile).not.toHaveBeenCalled();
});
