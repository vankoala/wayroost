import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Anchor every directory to an open fd; neither parents nor the file may be symlinks. */
export async function changeHold(path: string, verb: 'hold' | 'release'): Promise<void> {
  if (!isAbsolute(path)) throw new Error('The hold path must be absolute.');
  let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of dirname(path).split('/').filter(Boolean)) {
      if (part === '..') throw new Error('The hold path must not traverse parents.');
      const next = await open(`/proc/self/fd/${directory.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close();
      directory = next;
    }
    const anchored = `/proc/self/fd/${directory.fd}/${basename(path)}`;
    let file;
    try {
      file = await open(anchored, constants.O_NOFOLLOW | constants.O_NONBLOCK |
        (verb === 'hold' ? constants.O_WRONLY | constants.O_CREAT : constants.O_RDONLY), 0o600);
    } catch (error) {
      if (verb === 'release' && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    try {
      if (!(await file.stat()).isFile()) throw new Error('The hold path must be a regular file.');
      if (verb === 'release') await unlink(anchored);
      else await file.sync();
    } finally { await file.close(); }
  } finally { await directory.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [verb, path] = process.argv.slice(2);
  if ((verb !== 'hold' && verb !== 'release') || !path) process.exitCode = 1;
  else await changeHold(path, verb).catch(() => { console.error('The hold file could not be changed safely.'); process.exitCode = 1; });
}
