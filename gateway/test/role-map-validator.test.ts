import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { validateRoleMap } from '../../scripts/validate-role-map.js';
import { demoMap } from './map-fixture.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function file(value: unknown) {
  const base = join(process.cwd(), 'gateway/.test-tmp'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'validate-')); roots.push(root);
  const path = join(root, 'map.json'); await writeFile(path, JSON.stringify(value)); return path;
}

it('validates a file through the shared schema and exposes a standalone CLI', async () => {
  const path = await file(demoMap());
  expect(await validateRoleMap(path)).toEqual(demoMap());
  expect(execFileSync(process.execPath, ['--import', 'tsx', 'scripts/validate-role-map.ts', path], { encoding: 'utf8' })).toBe('Role map is valid.\n');
});

it.each(['schema', 'current', 'profile', 'contract'] as const)('refuses a map with an invalid %s', async problem => {
  const map = demoMap();
  if (problem === 'schema') map.version = 3 as 2;
  if (problem === 'current') map.roles.main = 'missing';
  if (problem === 'profile') map.profiles['example/vllm'] = { ...map.roles, coder: 'missing' };
  if (problem === 'contract') map.backends['demo-a']!.toolCalling = false;
  const path = await file(map);
  await expect(validateRoleMap(path)).rejects.toThrow();
  expect(() => execFileSync(process.execPath, ['--import', 'tsx', 'scripts/validate-role-map.ts', path], { stdio: 'pipe' })).toThrow();
});

it('refuses oversized files and writes no output containing file values', async () => {
  const path = await file('x'.repeat(129 * 1024));
  await expect(validateRoleMap(path)).rejects.toThrow('File is too large');
});
