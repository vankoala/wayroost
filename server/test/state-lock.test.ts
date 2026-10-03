import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { lockStateDirectory } from '../src/state-directory.js';

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit');
      child.kill('SIGKILL');
      await ended;
    }
  }));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), 'wayroost-lock-test-'));
  roots.push(path);
  return path;
}

it.each(['primary', 'shadow'] as const)('exclusively locks a %s directory across processes and releases it on crash', async role => {
  const path = root();
  const module = new URL('../src/state-directory.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { lockStateDirectory } from ${JSON.stringify(module)};
    process.on('message', async ({ path, role }) => {
      await lockStateDirectory(path, role);
      process.send('held');
    });
    process.send('ready');
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.push(child);
  expect((await once(child, 'message'))[0]).toBe('ready');
  const held = once(child, 'message');
  child.send({ path, role });
  expect((await held)[0]).toBe('held');
  await expect(lockStateDirectory(path, role)).rejects.toThrow(/exclusive lock/);
  const alias = join(root(), 'alias');
  symlinkSync(path, alias);
  await expect(lockStateDirectory(alias, role)).rejects.toThrow(/exclusive lock/);
  const ended = once(child, 'exit');
  child.kill('SIGKILL');
  await ended;
  const next = await lockStateDirectory(path, role);
  expect(readFileSync(join(path, '.wayroost-role'), 'utf8')).toBe(`${role}\n`);
  await expect(lockStateDirectory(path, role)).rejects.toThrow(/exclusive lock/);
  await next.release();
  await next.release();
  await (await lockStateDirectory(path, role)).release();
});
