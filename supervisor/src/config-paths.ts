import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { absolutePathSchema, settingsTargetsSchema, SETTINGS_TARGETS_FILE, type SettingsTargets } from '../../shared/settings-targets.js';
import type { SettingsErrorCode } from '../../shared/settings.js';
import { trustedExecutable, type Trust } from './trust.js';

export class ConfigError extends Error {
  constructor(readonly code: SettingsErrorCode) { super(code); }
}
export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export type ConfigReadPolicy = 'owner' | 'root-managed' | 'drvfs';

export async function configFileMissing(path: string, uid: number): Promise<boolean> {
  await checkConfigDirectory(path, uid);
  try { await lstat(path); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw new ConfigError('unsafe_target');
  }
}

/** Missing storage directories are allowed; every existing ancestor must be safe. */
export async function checkConfigDirectory(path: string, uid: number, directory = false, policy: ConfigReadPolicy = 'owner'): Promise<void> {
  if (!absolutePathSchema.safeParse(path).success) throw new ConfigError('unsafe_directory');
  let at = directory ? path : dirname(path);
  while (true) {
    try {
      const stat = await lstat(at);
      const windowsDirectory = policy === 'drvfs' && stat.uid === 0 && stat.gid === 0 && (stat.mode & 0o7777) === 0o777;
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== uid) || ((stat.mode & 0o022) && !windowsDirectory)) {
        throw new ConfigError('unsafe_directory');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigError('unsafe_directory');
    }
    if (at === '/') break;
    at = dirname(at);
  }
}

/** Read through a checked descriptor; paths never follow the final link. */
export async function readConfigFile(path: string, uid: number, mode?: number, policy: ConfigReadPolicy = 'owner', maxBytes = 4 * 1024 * 1024): Promise<{ source: string; sha256: string; expected: { uid: number; gid: number; mode: number } }> {
  await checkConfigDirectory(path, uid, false, policy);
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { throw new ConfigError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'target_missing' : 'unsafe_target'); }
  try {
    const stat = await file.stat();
    const rootOwned = stat.uid === 0 && stat.gid === 0 && (policy === 'root-managed' && !(stat.mode & 0o022)
      || policy === 'drvfs' && (stat.mode & 0o7777) === 0o777);
    if (!stat.isFile() || (stat.uid !== uid && !rootOwned) || stat.nlink !== 1 || (mode !== undefined && (stat.mode & 0o7777) !== mode)) throw new ConfigError('unsafe_target');
    if (stat.size > maxBytes) throw new ConfigError('parse_failed');
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const bytes = buffer.subarray(0, size);
    if (bytes.length > maxBytes || !isUtf8(bytes)) throw new ConfigError('parse_failed');
    return { source: bytes.toString('utf8'), sha256: digest(bytes), expected: { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 } };
  } finally { await file.close(); }
}

export async function loadSettingsTargets(path = SETTINGS_TARGETS_FILE, trust: Trust = trustedExecutable): Promise<SettingsTargets> {
  try {
    await trust(path);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error();
      return settingsTargetsSchema.parse(JSON.parse(await file.readFile('utf8')));
    } finally { await file.close(); }
  } catch (error) {
    throw new ConfigError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_configured' : 'unsafe_target');
  }
}
