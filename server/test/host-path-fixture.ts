import { join, resolve } from 'node:path';

export const hostPaths = {
  primaryState: '/var/lib/wayroost',
  shadowState: '/var/lib/wayroost-shadow',
  legacyState: '/var/lib/signalbox',
  privateState: '/var/lib/private',
  config: '/etc/wayroost',
  legacyConfig: '/etc/signalbox',
  credentials: '/run/credentials',
} as const;

/** Logical installed paths are data; filesystem tests redirect them into their own root. */
export const reservedTestPaths = Object.values(hostPaths);
export const temporaryBases = [
  '/var/tmp', '/etc/tmp', '/var/lib/test-tmp', `${hostPaths.legacyConfig}/test-tmp`,
  ...reservedTestPaths.map(path => `${path}/test-tmp`),
];

export interface StateFilesystem {
  root: string | undefined;
  hostile: boolean;
  files: Map<string, string>;
}

/** Redirect installed state, config and credential paths before touching the filesystem. */
export function isolatedStateFilesystem(fs: typeof import('node:fs'), fixture: StateFilesystem): typeof fs {
  const original = { ...fs };
  const protectedPath = (path: string) => ['/var/lib', hostPaths.config, hostPaths.legacyConfig, hostPaths.credentials]
    .some(root => path === root || path.startsWith(`${root}/`))
    || ['/var', '/etc', '/run'].some(parent => path === parent || path === `${parent}/.wayroost-role`);
  function redirect(path: unknown): unknown {
    if (typeof path !== 'string' || !protectedPath(resolve(path))) return path;
    if (!fixture.root) throw new Error('State directory fixture is not active');
    return join(fixture.root, resolve(path));
  }
  function restore(path: unknown): unknown {
    if (typeof path !== 'string' || !fixture.root || !path.startsWith(`${fixture.root}/`)) return path;
    return path.slice(fixture.root.length);
  }
  function wrap<T extends (...args: never[]) => unknown>(fn: T, canonical = false) {
    const wrapped = (...args: Parameters<T>): ReturnType<T> => {
      const result: unknown = Reflect.apply(fn, original, [redirect(args[0]), ...args.slice(1)]);
      if (canonical && fixture.hostile && typeof result === 'string'
        && result.startsWith(join(fixture.root!, hostPaths.privateState, '/'))) {
        throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
      }
      return (canonical ? restore(result) : result) as ReturnType<T>;
    };
    return wrapped as T;
  }
  return {
    ...original,
    lstatSync: wrap(original.lstatSync),
    statSync: wrap(original.statSync),
    realpathSync: Object.assign(wrap(original.realpathSync, true), { native: wrap(original.realpathSync.native, true) }),
    readlinkSync: wrap(original.readlinkSync, true),
    readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
      const content = typeof args[0] === 'string' ? fixture.files.get(resolve(args[0])) : undefined;
      if (content === undefined) return Reflect.apply(original.readFileSync, original, [redirect(args[0]), ...args.slice(1)]) as ReturnType<typeof fs.readFileSync>;
      const encoding = typeof args[1] === 'string' ? args[1] : args[1]?.encoding;
      const buffer = Buffer.from(content);
      return encoding ? buffer.toString(encoding) : buffer;
    }) as typeof fs.readFileSync,
    openSync: wrap(original.openSync),
    readdirSync: wrap(original.readdirSync),
    mkdirSync: wrap(original.mkdirSync),
    writeFileSync: wrap(original.writeFileSync),
    symlinkSync: ((target, path, type) => original.symlinkSync(redirect(target) as string, redirect(path) as string, type)) as typeof fs.symlinkSync,
  };
}

/** Child processes use the same isolated ownership layout as the parent test. */
export async function isolateChildStateFilesystem(root: string): Promise<void> {
  const { default: fs } = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  const isolated = isolatedStateFilesystem(fs, { root, hostile: false, files: new Map() });
  for (const key of ['lstatSync', 'statSync', 'realpathSync', 'readlinkSync', 'readFileSync', 'openSync', 'readdirSync', 'mkdirSync', 'writeFileSync', 'symlinkSync'] as const) {
    Object.defineProperty(fs, key, { ...Object.getOwnPropertyDescriptor(fs, key), value: isolated[key] });
  }
  syncBuiltinESMExports();
}
