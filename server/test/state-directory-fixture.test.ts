import { constants, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { isolatedStateRoot, useIsolatedStateDirectories, withHostileStateDirectories } from './state-directory-fixture.js';
import { parseConfig } from '../src/config.js';
import { hostPaths, isolatedStateFilesystem, reservedTestPaths, temporaryBases } from './host-path-fixture.js';
import { temporaryDirectory } from '../../tests/temporary-directory.js';

useIsolatedStateDirectories();
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each(temporaryBases)('allocates accepted shadow state outside TMPDIR=%s', directory => {
  vi.stubEnv('TMPDIR', directory);
  const state = temporaryDirectory('wayroost-shadow-state-');
  roots.push(state);
  expect(reservedTestPaths.some(path => state === path || state.startsWith(`${path}/`))).toBe(false);
  withHostileStateDirectories(() => {
    const input = { origins: ['https://wayroost.example.com'], role: 'shadow', listen: { port: 8890 } };
    expect(() => parseConfig(input, { env: {} })).toThrow('Cannot resolve stateDir; state ownership is unresolved');
    expect(parseConfig({ ...input, stateDir: state }, { env: {} }).stateDir).toBe(state);
  });
});

it.each(reservedTestPaths)('redirects filesystem access to %s before calling real filesystem methods', async directory => {
  const original = await vi.importActual<typeof import('node:fs')>('node:fs');
  const seen: string[] = [];
  const fs = { ...original };
  for (const key of ['lstatSync', 'statSync', 'readFileSync', 'openSync', 'readdirSync', 'mkdirSync', 'writeFileSync', 'symlinkSync'] as const) {
    const fn = original[key];
    Object.defineProperty(fs, key, { value: (...args: unknown[]) => {
      seen.push(String(args[0]));
      if (key === 'symlinkSync') seen.push(String(args[1]));
      return Reflect.apply(fn, original, args);
    } });
  }
  fs.realpathSync = Object.assign((...args: Parameters<typeof original.realpathSync>) => {
    seen.push(String(args[0]));
    return Reflect.apply(original.realpathSync, original, args);
  }, { native: (...args: Parameters<typeof original.realpathSync.native>) => {
    seen.push(String(args[0]));
    return Reflect.apply(original.realpathSync.native, original, args);
  } }) as typeof original.realpathSync;
  const root = isolatedStateRoot();
  const isolated = isolatedStateFilesystem(fs, { root, hostile: false, files: new Map() });
  isolated.mkdirSync(directory, { recursive: true });
  const path = join(directory, 'demo.json');
  isolated.writeFileSync(path, 'demo');
  expect(isolated.lstatSync(path).isFile()).toBe(true);
  expect(isolated.statSync(path).isFile()).toBe(true);
  expect(isolated.readFileSync(path, 'utf8')).toBe('demo');
  const fd = isolated.openSync(path, constants.O_RDONLY);
  try { expect(isolated.readFileSync(fd, 'utf8')).toBe('demo'); }
  finally { original.closeSync(fd); }
  expect(isolated.readdirSync(directory)).toContain('demo.json');
  expect(isolated.realpathSync(directory)).toBe(directory);
  expect(isolated.realpathSync.native(directory)).toBe(directory);
  const aliasRoot = temporaryDirectory('wayroost-alias-');
  roots.push(aliasRoot);
  const alias = join(aliasRoot, 'state');
  isolated.symlinkSync(directory, alias);
  expect(isolated.readlinkSync(alias)).toBe(directory);
  expect(isolated.realpathSync(alias)).toBe(directory);
  expect(seen.filter(path => reservedTestPaths.some(reserved => path === reserved || path.startsWith(`${reserved}/`))))
    .toEqual([]);
  expect(seen).toContain(join(root, directory));
});

it('refuses installed filesystem paths when the fixture is inactive', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const isolated = isolatedStateFilesystem(fs, { root: undefined, hostile: false, files: new Map() });
  expect(() => isolated.statSync(hostPaths.primaryState)).toThrow('State directory fixture is not active');
});
