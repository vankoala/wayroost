import { z } from 'zod';
import { dirname } from 'node:path';
import { RECOVERY_OPERATIONS } from '../../shared/settings-ops.js';
import { settingsTargetsSchema, type SettingsTargets } from '../../shared/settings-targets.js';
import { configRecoveryResultSchema, drainMarkerSchema, type ConfigWriteResult } from '../../shared/supervisor-config.js';
import { configCommand, type ConfigCommand } from './config-command.js';
import { ConfigError } from './config-paths.js';
import { DRAIN_UNIT, fileDrainIO } from './drain-files.js';
import { configUnit, gatewayPointUnit, type ConfigUnit } from './config-unit.js';
import { serviceEntry } from './service-unit.js';

export const recoveryRequestSchema = z.object({
  mode: z.literal('recovery'), site: settingsTargetsSchema, operation: z.enum(RECOVERY_OPERATIONS),
}).strict();

export function recoveryUnit(site: SettingsTargets, operation: string, executable = process.execPath, entry = serviceEntry): ConfigUnit {
  const request = recoveryRequestSchema.parse({ mode: 'recovery', site, operation });
  if (operation === 'gateway.socket-recover') {
    if (!site.targets['gateway-role-map']) throw new ConfigError('not_configured');
    return gatewayPointUnit(request, executable, entry);
  }
  if (!site.hermes || site.hermes.runAs.uid !== site.hermes.drainMarker.runAs.uid) throw new ConfigError('not_configured');
  return configUnit({ path: site.hermes.drainMarker.path, uid: site.hermes.drainMarker.runAs.uid,
    backupDir: dirname(site.hermes.drainMarker.path) }, request, executable, entry);
}

/** Only the site file supplies units and paths; recoveries accept no caller-selected arguments. */
export async function executeRecovery(input: unknown, dependencies: {
  command?: ConfigCommand; drainIO?: typeof fileDrainIO; uid?: number;
} = {}): Promise<ConfigWriteResult> {
  const { site, operation } = recoveryRequestSchema.parse(input);
  if (!site.configWrites) throw new ConfigError('config_writes_off');
  const command = dependencies.command ?? configCommand();
  const uid = dependencies.uid ?? process.getuid?.();
  if (operation === 'gateway.socket-recover') {
    const target = site.targets['gateway-role-map'];
    if (!target) throw new ConfigError('not_configured');
    if (uid !== 0) throw new ConfigError('unsafe_target');
    for (const [args, timeout] of [
      [['reset-failed', target.service, target.socket], 5000], [['restart', target.socket], 15000],
    ] as const) {
      const output = await command(['systemctl', ...args], {}, timeout);
      if (output.code !== 0) throw new ConfigError(output.code === 124 ? 'timeout' : 'failed');
    }
    const output = await command(['systemctl', 'show', target.socket, '-p', 'Id', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'Triggers'], {}, 5000);
    const properties = new Map(output.stdout.trim().split('\n').map(line => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
    }));
    if (output.code !== 0 || properties.get('Id') !== target.socket || properties.get('LoadState') !== 'loaded'
      || properties.get('ActiveState') !== 'active' || !properties.get('Triggers')?.split(/\s+/).includes(target.service)) {
      throw new ConfigError('verify_mismatch');
    }
  } else {
    const target = site.hermes;
    if (!target) throw new ConfigError('not_configured');
    if (uid !== target.runAs.uid || uid !== target.drainMarker.runAs.uid) throw new ConfigError('unsafe_target');
    const inactive = async () => {
      const output = await command(['systemctl', 'is-active', DRAIN_UNIT], {}, 5000);
      if (output.code === 0 || ['activating', 'deactivating', 'reloading'].includes(output.stdout.trim())) return false;
      if (output.code === 3 && ['inactive', 'failed'].includes(output.stdout.trim())
        || output.code === 4 && output.stdout.trim() === 'unknown') return true;
      throw new ConfigError('unavailable');
    };
    if (!await inactive()) return { ok: false, code: 'busy' };
    const io = (dependencies.drainIO ?? fileDrainIO)(target);
    const marker = await io.marker();
    if (marker !== null && !drainMarkerSchema.safeParse(marker).success) {
      return { ok: false, code: 'precondition_changed' };
    }
    if (marker) {
      if (!await inactive()) return { ok: false, code: 'busy' };
      await io.removeMarker(marker.requested_at);
      if (await io.marker() !== null) throw new ConfigError('verify_mismatch');
    }
  }
  return configRecoveryResultSchema.parse({ ok: true, recovered: true, operation,
    target: operation === 'gateway.socket-recover' ? 'gateway-role-map' : 'hermes-config' });
}
