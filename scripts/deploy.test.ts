import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function registryPlan(contents: string): string {
  mkdirSync('.tmp', { recursive: true });
  const folder = mkdtempSync(join(process.cwd(), '.tmp', 'deploy-registry-')); folders.push(folder);
  const source = join(folder, 'components.json');
  writeFileSync(source, contents);
  return execFileSync('bash', ['deploy/install-supervisor.sh', '--dry-run', '--root', join(folder, 'root'),
    '--components-file', source, '--enable-actions'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

it('plans both installers and removals without changing files or services', () => {
  const output = execFileSync('bash', ['tests/deploy-dryrun.sh'], { cwd: process.cwd(), encoding: 'utf8' });
  expect(output).toContain('PASS deploy dry-run checks');
});

it('keeps equivalent generic registries status-only after reformatting and reordering keys', () => {
  const entries = JSON.parse(readFileSync('deploy/components.example.json', 'utf8')) as Record<string, unknown>[];
  const reordered = entries.map(entry => Object.fromEntries(Object.entries(entry).reverse())).reverse();
  expect(registryPlan(JSON.stringify(reordered))).toContain('"statusOnly": true');
  expect(registryPlan('[{"id":"main-model"}]')).toContain('"statusOnly": true');
});

it.each([
  [{ id: 'main-model', profiles: [{ id: 'demo-profile' }] }],
  [{ id: 'demo-new-component' }],
  [{ id: 'coder', health: { kind: 'http', url: 'invalid' } }],
  [{ id: 'coder', restart: [] }],
  [{ id: 'coder', gpus: [-1] }],
  [{ id: 'coder', unknown: true }],
].map(entries => ({ entries })))('refuses invalid registry entries before planning any installation: $entries', ({ entries }) => {
  try { registryPlan(JSON.stringify(entries)); expect.fail('Invalid registry was accepted'); }
  catch (error) {
    expect((error as { status: number }).status).toBe(1);
    expect((error as { stdout: string }).stdout).not.toMatch(/\b(?:PLAN|WRITE)\b/);
  }
});
