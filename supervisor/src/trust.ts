// Every action command runs as root, so only root may be able to change what
// runs: the file, every directory on its path, and every directory holding a
// symlink on the way. The same walk as require_trusted_binary in deploy/lib.sh,
// repeated before each launch because paths can change after install.
import { constants } from 'node:fs';
import { access, lstat, readFile, readlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';

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

export type OwnerGroupLookup = (gid: number, ownerUid: number) => Promise<boolean>;
export type OwnerAclCheck = (path: string) => Promise<boolean>;

/** Any ACL in the system namespace counts: POSIX access ACLs, NFSv4 and rich ACLs alike. */
export const ACL_PROBE_SCRIPT = "import os, sys; print('acl' if any(name.startswith('system.') and 'acl' in name for name in os.listxattr(sys.argv[1], follow_symlinks=False)) else 'no-acl')";

const noAccessAcl: OwnerAclCheck = async path => {
  const python = await trustedExecutable('/usr/bin/python3');
  return new Promise((resolve, reject) => {
    execFile(python, ['-I', '-c', ACL_PROBE_SCRIPT, path],
      { timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 1024, cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } },
      (error, stdout, stderr) => {
        if (error || stderr !== '' || !['acl\n', 'no-acl\n'].includes(stdout)) reject(new Error('The resolver access ACL could not be checked.'));
        else resolve(stdout === 'no-acl\n');
      });
  });
};

const privateOwnerGroup: OwnerGroupLookup = async (gid, ownerUid) => {
  try {
    const [groups, accounts] = await Promise.all([readFile('/etc/group', 'utf8'), readFile('/etc/passwd', 'utf8')]);
    const users = accounts.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(':'));
    const owners = users.filter(fields => fields.length === 7 && /^\d+$/.test(fields[2]!) && Number(fields[2]) === ownerUid);
    const matching = groups.split('\n').map(line => line.split(':')).filter(fields => fields.length === 4
      && /^\d+$/.test(fields[2]!) && Number(fields[2]) === gid);
    if (owners.length !== 1 || matching.length !== 1 || !matching[0]![0]) return false;
    const name = owners[0]![0];
    const members = matching[0]![3];
    return !!name && (members === '' || members === name) && !users.some(fields => Number(fields[2]) !== ownerUid
      && /^\d+$/.test(fields[3] ?? '') && Number(fields[3]) === gid);
  } catch { return false; }
};

/**
 * Owner-run resolvers require a private ancestor and code nobody else can write.
 * Multiple links are harmless once only the owner or root can write the inode through any alias.
 * File group bits can be an ACL mask, so any group access requires a check for ACLs of any kind.
 * Directory ACL masks already obey the ancestor mode checks, including the private closure.
 */
export async function trustedOwnerExecutable(path: string, ownerUid: number, groupLookup: OwnerGroupLookup = privateOwnerGroup,
  aclCheck: OwnerAclCheck = noAccessAcl): Promise<string> {
  const refuse = () => new Error('The resolver path is not protected for its owner.');
  if (ownerUid === 0 || process.getuid?.() !== ownerUid || !path.startsWith('/') || path.split('/').includes('..')) throw refuse();
  let current = '/';
  let closed = false;
  const parts = path.split('/').filter(Boolean);
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = join(current, parts[index]!);
    const info = await lstat(current);
    if (info.isSymbolicLink() || ![0, ownerUid].includes(info.uid)) throw refuse();
    if (index === parts.length - 1) {
      if (!closed || !info.isFile() || (info.mode & 0o002) !== 0) throw refuse();
      if ((info.mode & 0o020) !== 0 && !await groupLookup(info.gid, ownerUid)) throw refuse();
      if ((info.mode & 0o070) !== 0) {
        try { if (!await aclCheck(current)) throw refuse(); } catch { throw refuse(); }
      }
    } else {
      if (!info.isDirectory() || !closed && (info.mode & 0o022) !== 0) throw refuse();
      if ((info.mode & 0o077) === 0) closed = true;
    }
  }
  return path;
}
