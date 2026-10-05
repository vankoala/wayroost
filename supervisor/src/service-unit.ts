import { dirname, join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { configUnit, systemdPath, type ConfigUnit } from './config-unit.js';
import { checkConfigDirectory, ConfigError } from './config-paths.js';
import { credentialDirectories } from './credential-executor.js';
import type { HermesTarget } from './drain-files.js';
import type { SettingsTargets } from '../../shared/settings-targets.js';

export const serviceEntry = fileURLToPath(new URL('./service-entry.js', import.meta.url));
export function componentRestartUnit(site: SettingsTargets, component: 'gateway' | 'dashboard', when: 'idle' | 'now', executable = process.execPath, entry = serviceEntry): ConfigUnit {
  if (component === 'gateway' ? !site.targets['gateway-role-map'] : !site.hermes || when !== 'now') throw new ConfigError('not_configured');
  const uid = component === 'dashboard' && site.hermes!.dashboardUnit.scope === 'user' ? site.hermes!.runAs.uid : 0;
  const unit = configUnit({ path: '/', uid }, { mode: 'component-restart', site, component, when }, executable, entry);
  unit.argv = unit.argv.map(arg => arg.startsWith('--unit=') ? '--unit=wayroost-drain-' + component
    : arg === '--property=RuntimeMaxSec=30' ? '--property=RuntimeMaxSec=8100'
    : arg === '--property=TimeoutStopSec=5' ? '--property=TimeoutStopSec=150' : arg);
  return unit;
}
/** Missing storage is created by its owner before the drain namespace requires it. */
export async function prepareDrainUnit(target: HermesTarget, executable = process.execPath, entry = serviceEntry): Promise<ConfigUnit | undefined> {
  const uid = target.drainMarker.runAs.uid;
  if (uid !== target.runAs.uid) throw new ConfigError('unsafe_directory');
  const writable: string[] = [];
  let missing = false;
  for (const directory of [target.drainStateDir, dirname(target.drainMarker.path)]) {
    await checkConfigDirectory(directory, uid, true);
    let at = directory;
    for (;;) {
      try {
        const stat = await lstat(at);
        if (at === target.drainStateDir && (stat.uid !== uid || stat.mode & 0o077)) throw new ConfigError('unsafe_directory');
        writable.push(at);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        missing = true;
        at = dirname(at);
      }
    }
  }
  if (!missing) return;
  const unit = configUnit({ path: target.drainMarker.path, uid }, { mode: 'prepare-drain', target }, executable, entry);
  unit.argv = unit.argv.map(arg => arg.startsWith('--property=ReadWritePaths=')
    ? '--property=ReadWritePaths=' + [...new Set(writable)].map(systemdPath).join(' ') : arg);
  return unit;
}
export function drainUnit(target: HermesTarget, when: 'idle' | 'now', executable = process.execPath, entry = serviceEntry): ConfigUnit {
  const cleanup = [executable, entry, 'cleanup', JSON.stringify(target)].map(value => systemdPath(value).replace(/\$/g, () => '$$')).join(' ');
  return {
    argv: ['systemd-run', '--unit=wayroost-drain-hermes-gateway', '--wait', '--pipe', '--quiet', '--uid=' + target.drainMarker.runAs.uid,
      '--property=CollectMode=inactive', '--property=Type=exec', '--property=NoNewPrivileges=yes', '--property=RuntimeMaxSec=8100',
      '--property=TimeoutStopSec=150', '--property=KillMode=control-group', '--property=ProtectSystem=strict', '--property=ProtectHome=read-only',
      '--property=UMask=0077', '--property=StandardError=null', '--property=WorkingDirectory=/',
      '--property=IPAddressDeny=any', '--property=IPAddressAllow=localhost', '--property=ExecStopPost=' + cleanup,
      '--property=ReadWritePaths=' + [dirname(target.drainMarker.path), target.drainStateDir].map(systemdPath).join(' '), '--', executable, entry],
    input: JSON.stringify({ mode: 'drain', target, when }) + '\n',
  };
}
export function sweepUnit(target: HermesTarget, executable = process.execPath, entry = serviceEntry): ConfigUnit {
  const unit = configUnit({ path: target.drainMarker.path, uid: target.drainMarker.runAs.uid,
    backupDir: dirname(target.drainMarker.path), auditDir: target.drainStateDir }, { mode: 'sweep', target }, executable, entry);
  unit.argv = unit.argv.filter(arg => !['--property=PrivateNetwork=yes', '--property=TimeoutStopSec=5', '--property=RuntimeMaxSec=30'].includes(arg));
  unit.argv = [...unit.argv.slice(0, -3), '--property=RuntimeMaxSec=180', '--property=TimeoutStopSec=150', ...unit.argv.slice(-3)];
  return unit;
}
export function credentialUnit(site: SettingsTargets, request: unknown, executable = process.execPath, entry = serviceEntry): ConfigUnit {
  const target = site.targets['gateway-credentials']!;
  const unit = configUnit({ path: join(target.directory, 'credential'), uid: 0, backupDir: target.backupDir,
    auditDir: target.directory, lockPath: target.lockFile }, { mode: 'credential', site, request }, executable, entry);
  unit.argv = unit.argv.map(arg => arg.startsWith('--property=ReadWritePaths=') ? '--property=ReadWritePaths=' + credentialDirectories(site).map(systemdPath).join(' ') : arg);
  return unit;
}
/** Root creates missing storage before the writer namespace requires it. */
export async function prepareCredentialUnit(site: SettingsTargets, executable = process.execPath, entry = serviceEntry): Promise<ConfigUnit | undefined> {
  const target = site.targets['gateway-credentials'];
  if (!target) throw new ConfigError('not_configured');
  const writable: string[] = [];
  let missing = false;
  for (const directory of credentialDirectories(site)) {
    await checkConfigDirectory(directory, 0, true);
    let at = directory;
    for (;;) {
      try {
        const stat = await lstat(at);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022) throw new ConfigError('unsafe_directory');
        if (at === target.directory && stat.mode & 0o077) throw new ConfigError('unsafe_directory');
        writable.push(at);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        missing = true;
        at = dirname(at);
      }
    }
  }
  if (!missing) return;
  const unit = configUnit({ path: join(target.directory, 'credential'), uid: 0 }, { mode: 'prepare-credential', site }, executable, entry);
  unit.argv = unit.argv.map(arg => arg.startsWith('--property=ReadWritePaths=')
    ? '--property=ReadWritePaths=' + [...new Set(writable)].map(systemdPath).join(' ') : arg);
  return unit;
}
