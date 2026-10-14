import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const hasPython310 = spawnSync('python3.10', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasPython310) console.warn('Skipping Python 3.10 checks: interpreter unavailable; using python3.');
const python = hasPython310 ? 'python3.10' : 'python3';
const transitionTimeoutMs = 900_000;

it(`runs the owner job transition checks with ${python} without listeners`, () => {
  const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'helper', '-p', 'test_jobs_transition.py'], {
    encoding: 'utf8', timeout: transitionTimeoutMs,
    env: { ...process.env, NODE_BIN: process.execPath },
  });
  expect(result.stderr + result.stdout).toContain('OK');
  expect(result.status, result.stderr + result.stdout).toBe(0);
}, transitionTimeoutMs);

it('links the owner transition procedure and its accepted mail baseline', () => {
  expect(readFileSync('deploy/README.md', 'utf8')).toContain('../docs/jobs-transition.md');
  const doc = readFileSync('docs/jobs-transition.md', 'utf8');
  expect(doc).toContain('--no-pending-oauth-confirmed');
  expect(doc).toContain('acts on no old mail');
  expect(doc).toContain('Python 3.10 or newer');
  expect(doc).toContain('npm ci');
  expect(doc).toContain('dev dependencies');
  expect(doc).toContain('launchPersistentContext');
  expect(doc).toContain('--node');
  expect(doc).toContain('/reload-mcp');
  expect(doc).not.toContain('--browser-cdp');
});
