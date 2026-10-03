// Every action command runs as root, so only root may be able to change what
// runs: the file, every directory on its path, and every directory holding a
// symlink on the way. The same walk as require_trusted_binary in deploy/lib.sh,
// repeated before each launch because paths can change after install.
import { constants } from 'node:fs';
import { access, lstat, readlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, join } from 'node:path';

/** Bare command names resolve here, never through the caller's PATH. */
const SEARCH_PATH = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];
const MAX_SYMLINKS = 40;

export type Trust = (command: string) => Promise<string>;

/** Resolves argv[0] to the absolute path to run, or throws when anyone but root could change it. */
export const trustedExecutable: Trust = async command => {
  if (!command.includes('/')) {
    for (const directory of SEARCH_PATH) {
      const candidate = join(directory, command);
      try { await access(candidate, constants.X_OK); } catch { continue; }
      await requireRootOnly(candidate);
      return candidate;
    }
    throw new Error('The command for this action was not found on this PC.');
  }
  if (!command.startsWith('/')) throw new Error('The command for this action must be an absolute path.');
  await requireRootOnly(command);
  return command;
};

async function requireRootOnly(path: string): Promise<void> {
  const refuse = (at: string) => new Error(`The command for this action can be changed by someone other than root (${at}). Move it to a root-owned folder.`);
  const check = async (at: string): Promise<Stats> => {
    let info: Stats;
    try { info = await lstat(at); } catch { throw refuse(at); }
    if (!info.isSymbolicLink() && (info.uid !== 0 || (info.mode & 0o022) !== 0)) throw refuse(at);
    return info;
  };
  let current = '/';
  let info = await check(current);
  let rest = path.split('/').filter(Boolean);
  let hops = 0;
  while (rest.length) {
    const part = rest.shift()!;
    if (part === '.') continue;
    // `current` never contains a symlink, so its parent is the real parent.
    if (part === '..') { current = dirname(current); info = await check(current); continue; }
    const next = join(current, part);
    info = await check(next);
    if (info.isSymbolicLink()) {
      if (++hops > MAX_SYMLINKS) throw refuse(next);
      const target = await readlink(next);
      if (target.startsWith('/')) current = '/';
      rest = [...target.split('/').filter(Boolean), ...rest];
      continue;
    }
    current = next;
  }
  if (!info.isFile()) throw new Error(`The command for this action is not a regular file (${current}).`);
}
