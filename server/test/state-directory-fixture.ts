import { chmodSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { hostPaths } from './host-path-fixture.js';
import { temporaryDirectory } from '../../tests/temporary-directory.js';

const fixture = vi.hoisted(() => ({ root: undefined as string | undefined, hostile: false,
  files: new Map<string, string>(), resolvedPaths: [] as string[] }));

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  const { isolatedStateFilesystem } = await import('./host-path-fixture.js');
  const record = <T extends (...args: never[]) => unknown>(fn: T): T => ((...args: Parameters<T>) => {
    const result: unknown = Reflect.apply(fn, fs, args);
    fixture.resolvedPaths.push(String(result));
    return result;
  }) as T;
  const realpathSync = Object.assign(record(fs.realpathSync), { native: record(fs.realpathSync.native) });
  return isolatedStateFilesystem({ ...fs, realpathSync }, fixture);
});

/** Keep the installed path spellings while resolving ownership only inside a temporary root. */
export function useIsolatedStateDirectories(): void {
  beforeEach(async () => {
    fixture.root = temporaryDirectory('wayroost-state-root-');
    for (const path of ['var/lib', 'etc', 'run/credentials']) mkdirSync(join(fixture.root, path), { recursive: true });
    const { validateStateDirectory } = await import('../src/state-directory.js');
    fixture.resolvedPaths.length = 0;
    validateStateDirectory(hostPaths.shadowState, 'shadow');
    expect(fixture.resolvedPaths, 'State validation must use the isolated filesystem').not.toHaveLength(0);
    expect(fixture.resolvedPaths.every(path => path.startsWith(`${fixture.root}/`)),
      'State validation must resolve inside the fixture root').toBe(true);
  });
  afterEach(() => {
    if (fixture.root) rmSync(fixture.root, { recursive: true, force: true });
    fixture.root = undefined;
    fixture.hostile = false;
    fixture.files.clear();
    fixture.resolvedPaths.length = 0;
  });
}

export function isolatedStateRoot(): string {
  if (!fixture.root) throw new Error('State directory fixture is not active');
  return fixture.root;
}

/** Supply a temporary config at its logical path without writing outside the test root. */
export function withVirtualConfigFile<T>(path: string, content: string, action: () => T): T {
  path = resolve(path);
  fixture.files.set(path, content);
  try { return action(); }
  finally { fixture.files.delete(path); }
}

/** Model systemd's private state links, including EACCES even when tests run as root. */
export function withHostileStateDirectories<T>(action: () => T): T {
  const root = isolatedStateRoot();
  const privateDir = join(root, hostPaths.privateState);
  mkdirSync(privateDir, { mode: 0o700 });
  for (const name of ['wayroost', 'wayroost-shadow', 'signalbox']) {
    mkdirSync(join(privateDir, name));
    symlinkSync(`private/${name}`, join(root, 'var/lib', name));
  }
  chmodSync(privateDir, 0o700);
  fixture.hostile = true;
  try { return action(); }
  finally { fixture.hostile = false; }
}
