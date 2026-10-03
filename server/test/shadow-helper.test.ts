import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('checks helper, mail gate and hook side effects in shadow and primary', () => {
  const output = execFileSync('python3', ['-m', 'unittest', 'discover', '-s', 'helper', '-p', 'test_shadow.py', '-v'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { ...process.env, WAYROOST_ROLE: 'primary', PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  expect(output).toBe('');
});
