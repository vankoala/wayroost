import { constants } from 'node:fs';
import { access, lstat, mkdir, rmdir, utimes } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SettingsTargets } from '../../shared/settings-targets.js';
import { settingsLockPath, withSettingsFileLock } from '../../server/src/settings/write-through.js';
import { withPaseoConfigLock } from '../../server/src/paseo/config-lock.js';
import { checkConfigDirectory, ConfigError } from './config-paths.js';
import { trustedExecutable, type Trust } from './trust.js';

export type FileTarget = NonNullable<SettingsTargets['targets']['hermes-config'] | SettingsTargets['targets']['pi-settings']
  | SettingsTargets['targets']['pi-models'] | SettingsTargets['targets']['paseo-config']>;

export async function withConfigFileLock<T>(path: string, uid: number, work: () => Promise<T>): Promise<T> {
  await checkConfigDirectory(path, uid);
  return withSettingsFileLock(path, work);
}

/** Share pi's mkdir lock and heartbeat. A stale lock is never removed by this writer. */
export async function withPiConfigLock<T>(path: string, write: () => Promise<T>): Promise<T> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch { throw new ConfigError('locked'); }
  const stat = await lstat(path);
  let lost = false;
  const heartbeat = setInterval(() => {
    void lstat(path).then(current => {
      if (current.ino !== stat.ino || current.dev !== stat.dev || !current.isDirectory()) { lost = true; return; }
      return utimes(path, new Date(), new Date());
    }).catch(() => { lost = true; });
  }, 1000);
  heartbeat.unref();
  try {
    const result = await write();
    if (lost) throw new ConfigError('locked');
    return result;
  } finally {
    clearInterval(heartbeat);
    const current = await lstat(path).catch(() => undefined);
    if (current?.ino === stat.ino && current.dev === stat.dev) await rmdir(path);
  }
}

export function checkLockPath(target: FileTarget): void {
  const expected = target.lock.kind === 'file' ? settingsLockPath(target.path)
    : target.lock.kind === 'pi' ? `${target.path}.lock` : `${target.path}.wayroost.lock`;
  if (target.lock.path !== expected) throw new ConfigError('unsafe_target');
}

export async function withConsumerLock<T>(target: FileTarget, work: () => Promise<T>, trust: Trust = trustedExecutable): Promise<T> {
  checkLockPath(target);
  await checkConfigDirectory(target.lock.path, target.runAs.uid);
  switch (target.lock.kind) {
    case 'file': return work(); // The write-through core takes this exact lock.
    case 'pi': return withPiConfigLock(target.lock.path, work);
    case 'paseo':
      try { await access(dirname(target.path), constants.W_OK); } catch { throw new ConfigError('unsafe_directory'); }
      await trust('/usr/bin/flock');
      let failure: unknown;
      try { return await withPaseoConfigLock(target.path, target.auditDir, async () => {
        try { return await work(); } catch (error) { failure = error; throw error; }
      }); }
      catch (error) { if (failure === error) throw error; throw new ConfigError('locked'); }
  }
}
