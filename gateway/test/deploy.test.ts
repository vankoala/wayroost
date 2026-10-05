import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config.js';
import { seedMap, seedInstalledMap } from '../src/seed.js';
import { demoMap } from './map-fixture.js';
import { directoryMetadata } from './filesystem-fixture.js';

vi.mock('node:fs/promises', { spy: true });
describe('deployed gateway definitions', () => {
  it('ships an invented map whose current and profile mappings fit every contract', async () => {
    const map = parseConfig(JSON.parse(await readFile('gateway/role-map.default.json', 'utf8')));
    expect(Object.keys(map.profiles)).toEqual(['example/vllm']);
    expect(Object.values(map.backends).map(backend => backend.servedName)).toEqual([
      'example-main-model', 'example-coder-model', 'example-fast-model',
    ]);
    expect(Object.keys(map.backends)).toEqual(['example-main', 'example-coder', 'example-fast']);
    expect(map.roles).toEqual(map.profiles['example/vllm']);
  });
  it('deploys dynamic-user state and plain user seeding with no start limit', async () => {
    const service = await readFile('deploy/wayroost-gateway.service', 'utf8');
    for (const line of ['DynamicUser=yes', 'StateDirectory=wayroost-gateway', 'StateDirectoryMode=0700', 'RuntimeDirectoryMode=0700',
      'Restart=always', 'RestartSec=1', 'StartLimitIntervalSec=0', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6']) expect(service.split('\n')).toContain(line);
    expect(service).toMatch(/^ExecStartPre=\/usr\/bin\/node .* \/var\/lib\/private\/wayroost-gateway\/role-map.json$/m);
    expect(service).not.toMatch(/^ExecStartPre=[+!]/m);
    expect(service).toMatch(/^ExecStart=.*--config \/var\/lib\/private\/wayroost-gateway\/role-map.json/m);
    const socket = await readFile('deploy/wayroost-gateway.socket', 'utf8');
    expect(socket.match(/^ListenStream=.+$/gm)).toEqual(['ListenStream=127.0.0.1:18010', 'ListenStream=127.0.0.1:18011', 'ListenStream=127.0.0.1:18012']);
    expect(socket).toContain('TriggerLimitIntervalSec=2s'); expect(socket).toContain('TriggerLimitBurst=20');
  });
  it('parses the CI workflow and checks the root deployment harness syntax', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const job = workflow.jobs['gateway-systemd']; expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job.steps.at(-1).run).toContain('sudo env CI=true');
    execFileSync(process.execPath, ['--check', 'gateway/test/systemd-ci.mjs']);
  });
});

describe('service-user map seeding', () => {
  let path: string;
  beforeEach(async () => {
    const root = join(process.cwd(), 'gateway/.test-tmp'); await mkdir(root, { recursive: true, mode: 0o700 });
    path = await mkdtemp(join(root, 'seed-')); await directoryMetadata();
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(path, { recursive: true, force: true }); });
  it('seeds a private map once without overwriting a repointed map', async () => {
    const source = join(path, 'default.json'); const target = join(path, 'role-map.json');
    await writeFile(source, JSON.stringify(demoMap()), { mode: 0o644 }); await seedMap(source, target);
    const metadata = await stat(target); expect(metadata.mode & 0o777).toBe(0o600); expect(metadata.uid).toBe(process.getuid!());
    const map = demoMap(); map.roles.main = 'demo-b'; await writeFile(target, JSON.stringify(map));
    await seedMap(source, target); expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(map);
  });
  it('uses a site seed, preserves a live map and falls back only when the site seed is absent', async () => {
    const source = join(path, 'default.json'); const local = join(path, 'local.json'); const target = join(path, 'role-map.json');
    const localMap = demoMap(); localMap.roles.main = 'demo-b';
    await writeFile(source, JSON.stringify(demoMap()), { mode: 0o644 });
    await writeFile(local, JSON.stringify(localMap), { mode: 0o644 });
    await seedInstalledMap(local, source, target);
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(localMap);
    await writeFile(local, JSON.stringify(demoMap())); await seedInstalledMap(local, source, target);
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(localMap);
    await rm(target); await rm(local); await seedInstalledMap(local, source, target);
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(demoMap());
    await rm(target); await writeFile(local, '{invalid');
    await expect(seedInstalledMap(local, source, target)).rejects.toThrow();
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
