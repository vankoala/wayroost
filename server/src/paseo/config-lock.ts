import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, fstatSync, openSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/** All Wayroost Paseo-config writers use this lock, including the owner helper. */
export async function withPaseoConfigLock<T>(configPath: string, stateDir: string, write: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const directory = realpathSync(dirname(configPath));
  let lockPath = join(directory, `${basename(configPath)}.wayroost.lock`);
  try { accessSync(directory, constants.W_OK); }
  catch (err) {
    if (!['EACCES', 'EPERM', 'EROFS'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
    const target = createHash('sha256').update(join(directory, basename(configPath))).digest('hex');
    lockPath = join(stateDir, `paseo-config-${target}.lock`);
  }
  const fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Paseo configuration lock must be a regular file.');
    // The child and parent share the open file description. After flock exits,
    // the parent retains the lock until finally closes its descriptor.
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/flock', ['--exclusive', '--timeout', '4', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
      const abort = () => { child.kill('SIGKILL'); };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      child.once('error', error => { cleanup(); reject(error); });
      child.once('exit', code => {
        cleanup();
        if (signal?.aborted) reject(signal.reason);
        else if (code === 0) resolve();
        else reject(new Error('Paseo configuration is locked; retry the Safety change.'));
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted();
    return await write();
  } finally { closeSync(fd); }
}
