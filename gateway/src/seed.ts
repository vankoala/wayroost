import { constants } from 'node:fs';
import { open, lstat, unlink, link } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TrustedDirectory } from './directory.js';
import { parseConfig, readLimitedFile } from './config.js';

/** Seed once as the service user, without replacing an existing map. */
export async function seedMap(source: string, target: string): Promise<void> {
  if (source !== resolve(source) || target !== resolve(target)) throw new Error('Use absolute map paths.');
  const directory = await TrustedDirectory.open(dirname(target));
  const temporary = `${basename(target)}.${randomUUID()}.tmp`;
  try {
    if (await lstat(directory.entry(basename(target))).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    })) return;
    const map = parseConfig(JSON.parse((await readLimitedFile(source, 128 * 1024, 0o022)).toString('utf8')), '/run/credentials/wayroost-gateway.service');
    const file = await open(directory.entry(temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await file.writeFile(`${JSON.stringify(map, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
    await directory.assertValid();
    try { await link(directory.entry(temporary), directory.entry(basename(target))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally { await unlink(directory.entry(temporary)).catch(() => {}); await directory.close(); }
}

/** A site seed takes precedence; an absent site seed uses the packaged example. */
export async function seedInstalledMap(local: string, source: string, target: string): Promise<void> {
  if (local !== resolve(local)) throw new Error('Use an absolute local map path.');
  const present = await lstat(local).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  await seedMap(present ? local : source, target);
}

if (process.argv[1]?.endsWith('/seed.js')) {
  try {
    if (process.argv.length === 6 && process.argv[2] === '--local') {
      await seedInstalledMap(process.argv[3]!, process.argv[4]!, process.argv[5]!);
    } else {
      if (process.argv.length !== 4) throw new Error('Supply source and target paths.');
      await seedMap(process.argv[2]!, process.argv[3]!);
    }
  } catch { process.stderr.write('Could not seed the role map.\n'); process.exitCode = 1; }
}
