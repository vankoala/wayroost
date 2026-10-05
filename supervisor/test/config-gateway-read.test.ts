import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConfigVerbs } from '../src/config-verbs.js';
import { GatewayConfigState } from '../src/config-gateway-state.js';
import { settingsTargetsSchema } from '../../shared/settings-targets.js';
import { GATEWAY_STATE_FILES } from '../../shared/gateway.js';
import { demoMap } from '../../gateway/test/map-fixture.js';

vi.mock('node:fs/promises', async original => ({ ...await original<typeof fs>(), lstat: vi.fn() }));
const actual = await vi.importActual<typeof fs>('node:fs/promises');
const uid = process.getuid!();
const roots: string[] = [];
beforeEach(() => {
  vi.mocked(lstat).mockImplementation(async (path, options) => {
    const stat = await actual.lstat(path, options); if (String(path) === '/') stat.uid = typeof stat.uid === 'bigint' ? 0n : 0; return stat;
  });
});
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const key = { name: 'example-server', scope: 'server' as const, sha256: 'a'.repeat(64) };
async function fixture() {
  const root = await mkdtemp(join(process.cwd(), '.gateway-read-')); roots.push(root);
  const directory = join(root, 'state'); await mkdir(directory, { mode: 0o700 });
  const path = join(root, 'map.json'); await writeFile(path, JSON.stringify(demoMap()), { mode: 0o600 });
  const site = settingsTargetsSchema.parse({ version: 1, configWrites: false, targets: {
    'gateway-role-map': { path, defaultMap: join(root, 'default.json'), adminSocket: join(root, 'admin.sock'), service: 'example.service', socket: 'example.socket' },
    'gateway-state': { directory, backupDir: join(root, 'backups') },
  } });
  const runner = vi.fn(); const gatewayUid = vi.fn(async () => uid);
  const verbs = new ConfigVerbs({ stateDir: join(root, 'audit'), site: async () => site, runner, gatewayUid,
    gatewayState: site => new GatewayConfigState(site, uid) });
  return { root, directory, path, verbs, runner, gatewayUid };
}

it('authorizes before reading and handles gateway targets without runAs using bounded dedicated readers', async () => {
  const f = await fixture();
  expect(await f.verbs.read({ view: 'gateway.role-map' }, { ...key, scope: 'rescue' })).toEqual({ ok: false, code: 'not_permitted' });
  expect(f.gatewayUid).not.toHaveBeenCalled();
  expect(await f.verbs.read({ view: 'gateway.role-map', path: '/home/me/other.json' }, key)).toEqual({ ok: false, code: 'invalid_parameters' });
  expect(await f.verbs.read({ view: 'gateway.role-map' }, key)).toMatchObject({ ok: true, present: true, values: expect.arrayContaining([
    { path: ['roles', 'main'], exists: true, value: demoMap().roles.main },
  ]) });
  expect(await f.verbs.read({ view: 'gateway.state' }, key)).toEqual({ ok: true, view: 'gateway.state', present: false, values: [] });
  await writeFile(join(f.directory, GATEWAY_STATE_FILES.state), JSON.stringify({ version: 1, profile: 'example', engine: 'vllm', broughtUpAt: null, overrides: {} }), { mode: 0o600 });
  expect(await f.verbs.read({ view: 'gateway.state' }, key)).toMatchObject({ ok: true, present: true, values: expect.arrayContaining([
    { path: ['state', 'profile'], exists: true, value: 'example' }, { path: ['state', 'engine'], exists: true, value: 'vllm' },
  ]) });
  expect(await readdir(f.directory)).toEqual([GATEWAY_STATE_FILES.state]);
  expect(f.runner).not.toHaveBeenCalled();
  expect(await readdir(f.root)).not.toContain('audit');
});

it('refuses an unexpected map owner, symbolic links and oversized maps', async () => {
  const f = await fixture();
  f.gatewayUid.mockResolvedValueOnce(uid + 1);
  expect(await f.verbs.read({ view: 'gateway.role-map' }, key)).toMatchObject({ ok: false });
  const original = join(f.root, 'original.json'); await writeFile(original, JSON.stringify(demoMap()), { mode: 0o600 });
  await rm(f.path); await symlink(original, f.path);
  expect(await f.verbs.read({ view: 'gateway.role-map' }, key)).toEqual({ ok: false, code: 'unsafe_target' });
  await rm(f.path); await writeFile(f.path, 'x'.repeat(128 * 1024 + 1), { mode: 0o600 });
  expect(await f.verbs.read({ view: 'gateway.role-map' }, key)).toEqual({ ok: false, code: 'parse_failed' });
});

it('refuses public state directories and malformed or oversized state files', async () => {
  const f = await fixture();
  await chmod(f.directory, 0o755);
  expect(await f.verbs.read({ view: 'gateway.state' }, key)).toMatchObject({ ok: false });
  await chmod(f.directory, 0o700);
  const path = join(f.directory, GATEWAY_STATE_FILES.state);
  for (const source of ['{invalid', 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    await writeFile(path, source, { mode: 0o600 });
    expect(await f.verbs.read({ view: 'gateway.state' }, key)).toMatchObject({ ok: false });
  }
});
