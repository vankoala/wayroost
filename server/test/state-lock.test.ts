import { isolatedStateRoot, useIsolatedStateDirectories } from './state-directory-fixture.js';
import { temporaryDirectory } from '../../tests/temporary-directory.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { lockStateDirectory } from '../src/state-directory.js';

// Locking validates the directory it holds, and a shadow validates its installed primaries.
useIsolatedStateDirectories();

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
  const path = temporaryDirectory('wayroost-lock-test-');
  roots.push(path);
  return path;
}

it.each(['primary', 'shadow'] as const)('exclusively locks a %s directory across processes and releases it on crash', async role => {
  const path = root();
  const module = new URL('../src/state-directory.ts', import.meta.url).href;
  const fixture = new URL('./host-path-fixture.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { isolateChildStateFilesystem } from ${JSON.stringify(fixture)};
    await isolateChildStateFilesystem(${JSON.stringify(isolatedStateRoot())});
    const { lockStateDirectory } = await import(${JSON.stringify(module)});
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
