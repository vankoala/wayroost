import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, fstatSync, openSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/** All Wayroost Paseo-config writers use this lock, including the owner helper. */
export async function withPaseoConfigLock<T>(configPath: string, stateDir: string, write: () => Promise<T>): Promise<T> {
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
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('Paseo configuration is locked; retry the Safety change.')));
    });
    return await write();
  } finally { closeSync(fd); }
}
