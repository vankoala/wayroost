import { connect } from 'node:net';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function prepareSocketDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || directory.uid !== process.getuid?.()) throw new Error('The socket directory must be owned by the supervisor.');
  await chmod(dirname(path), 0o750);
}

export async function recoverSocket(path: string): Promise<void> {
  let previous;
  try { previous = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!previous.isSocket() || previous.uid !== process.getuid?.()) throw new Error('The socket path is not a supervisor-owned socket.');
  const inactive = await new Promise<boolean>((resolve, reject) => {
    const client = connect(path);
    const timer = setTimeout(() => { client.destroy(); reject(new Error('The existing socket could not be checked.')); }, 1000);
    client.once('connect', () => { clearTimeout(timer); client.destroy(); resolve(false); });
    client.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ECONNREFUSED') resolve(true); else reject(error);
    });
  });
  if (!inactive) throw new Error('The supervisor socket is already in use.');
  const current = await lstat(path);
  if (!current.isSocket() || current.uid !== previous.uid || current.ino !== previous.ino || current.dev !== previous.dev)
    throw new Error('The socket path changed while it was being checked.');
  await unlink(path);
}
