import { createServer } from 'node:net';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { ServerRole } from './background.js';

export const PRIMARY_STATE_DIR = '/var/lib/wayroost';
export const SHADOW_STATE_DIR = '/var/lib/wayroost-shadow';
const PRIMARY_PATHS = [PRIMARY_STATE_DIR, '/var/lib/signalbox', '/etc/signalbox'];
const OWNER_FILE = '.wayroost-role';

export class StateDirectoryError extends Error {}

/** Resolve existing ancestors too: a new child of a symlink still belongs to its target. */
function canonicalDirectory(path: string): string {
  let parent = resolve(path);
  const children: string[] = [];
  for (;;) {
    try {
      lstatSync(parent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === dirname(parent)) {
        throw new StateDirectoryError('Cannot inspect stateDir; state ownership is unresolved', { cause: err });
      }
      children.unshift(basename(parent));
      parent = dirname(parent);
      continue;
    }
    try {
      const canonical = realpathSync(parent);
      if (!statSync(canonical).isDirectory()) throw new Error('not a directory');
      return join(canonical, ...children);
    } catch (err) {
      throw new StateDirectoryError('Cannot resolve stateDir; state ownership is unresolved', { cause: err });
    }
  }
}

function primaryDirectory(path: string): string {
  // Legacy deployments can point into a private directory. Reserve the link's
  // target without requiring permission to enter that primary-owned state.
  try {
    if (lstatSync(path).isSymbolicLink()) {
      const target = resolve(dirname(path), readlinkSync(path));
      try {
        return canonicalDirectory(target);
      } catch (err) {
        if (((err as Error).cause as NodeJS.ErrnoException | undefined)?.code === 'EACCES') return target;
        throw err;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new StateDirectoryError('Cannot inspect primary stateDir');
    }
  }
  return canonicalDirectory(path);
}

function owner(directory: string): ServerRole | undefined {
  const path = join(directory, OWNER_FILE);
  let info;
  try {
    info = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new StateDirectoryError('Cannot inspect stateDir role marker');
  }
  if (!info.isFile() || info.size > 8) throw new StateDirectoryError('Invalid stateDir role marker');
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const text = readFileSync(fd, 'utf8');
    if (text === 'primary\n') return 'primary';
    if (text === 'shadow\n') return 'shadow';
    throw new Error('invalid role');
  } catch {
    throw new StateDirectoryError('Cannot read a valid stateDir role marker');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function validateStateDirectory(path: string, role: ServerRole): string {
  const state = canonicalDirectory(path);
  if (role === 'shadow') {
    // Check both the reserved spelling and its target if the primary directory is a symlink.
    const reserved = PRIMARY_PATHS.flatMap((primary) => [primary, primaryDirectory(primary)]);
    const spelling = resolve(path);
    if (reserved.some((primary) => [state, spelling].some((candidate) => candidate === primary || candidate.startsWith(`${primary}/`)))) {
      throw new StateDirectoryError('Shadow stateDir must not use a primary-owned directory');
    }
  }
  let directory = state;
  for (;;) {
    const claimed = owner(directory);
    if (claimed !== undefined && claimed !== role) {
      throw new StateDirectoryError(`stateDir belongs to ${claimed}; ${role} requires a separate directory`);
    }
    if (directory === dirname(directory)) break;
    directory = dirname(directory);
  }
  if (role === 'shadow' && owner(state) === undefined) {
    try {
      if (readdirSync(state).length) {
        throw new StateDirectoryError('Shadow stateDir has unowned existing state; use a new empty directory');
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (err instanceof StateDirectoryError) throw err;
        throw new StateDirectoryError('Cannot inspect shadow stateDir contents');
      }
    }
  }
  return state;
}

/** Claim before constructing any store; exclusive creation prevents concurrent roles sharing state. */
export function claimStateDirectory(path: string, role: ServerRole): string {
  const state = validateStateDirectory(path, role);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  validateStateDirectory(state, role);
  try {
    writeFileSync(join(state, OWNER_FILE), `${role}\n`, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return validateStateDirectory(state, role);
}

/** An abstract Unix socket is an exclusive Linux lock, released by the kernel on process exit. */
export async function lockStateDirectory(path: string, role: ServerRole): Promise<{ path: string; release(): Promise<void> }> {
  const state = claimStateDirectory(path, role);
  const { dev, ino } = statSync(state, { bigint: true });
  // Inode identity also covers aliases; there is no socket file to unlink after a crash.
  const lock = createServer(socket => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      lock.once('error', reject);
      lock.listen(`\0wayroost-state-${dev}-${ino}`, () => { lock.off('error', reject); resolve(); });
    });
  } catch (cause) {
    throw new StateDirectoryError('stateDir is already in use or its exclusive lock could not be acquired', { cause });
  }
  lock.unref();
  let released: Promise<void> | undefined;
  return { path: state, release() {
    return released ??= new Promise<void>((resolve, reject) => lock.close(error => error ? reject(error) : resolve()));
  } };
}
