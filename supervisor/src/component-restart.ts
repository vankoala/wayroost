import { z } from 'zod';
import type { SettingsTargets } from '../../shared/settings-targets.js';
import type { DrainRestartRun } from '../../shared/supervisor-config.js';
import { configCommand, type ConfigCommand } from './config-command.js';
import { gatewayAdmin } from './gateway-admin.js';

export interface RestartIO {
  command: ConfigCommand;
  admin: typeof gatewayAdmin;
  now(): number;
  sleep(ms: number): Promise<void>;
}
/** Verify a new manager PID after the fixed restart or the gateway's connection drain. */
export async function executeComponentRestart(site: SettingsTargets, component: 'gateway' | 'dashboard', when: 'idle' | 'now',
  update: (patch: Partial<DrainRestartRun>) => void = () => {},
  io: RestartIO = { command: configCommand(), admin: gatewayAdmin, now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const target = component === 'gateway' ? site.targets['gateway-role-map'] : site.hermes;
  if (!target || component === 'dashboard' && when !== 'now') throw new Error('not_configured');
  const dashboard = site.hermes?.dashboardUnit;
  const user = component === 'dashboard' && dashboard?.scope === 'user';
  const uid = user ? site.hermes!.runAs.uid : 0;
  if (process.getuid!() !== uid) throw new Error('unsafe_target');
  const unit = component === 'gateway' ? site.targets['gateway-role-map']!.service : dashboard!.name;
  const command = (args: string[], timeout = 5000) => io.command(['systemctl', ...(user ? ['--user'] : []), ...args],
    user ? { XDG_RUNTIME_DIR: '/run/user/' + uid } : {}, timeout);
  const pid = async () => {
    const output = await command(['show', unit, '-p', 'MainPID', '--value']);
    if (output.code !== 0 || !/^[1-9][0-9]*$/.test(output.stdout.trim())) return undefined;
    return output.stdout.trim();
  };
  const before = await pid();
  if (!before) return { outcome: 'not_running' as const };
  if (component === 'gateway' && when === 'idle') {
    const deadline = io.now() + 7_200_000;
    let attempts = 0;
    while (io.now() < deadline) {
      update({ state: 'draining', attempts: ++attempts, busy: ['connections-open'] });
      const result = z.object({ status: z.enum(['drained', 'still_busy']) }).strict().parse(
        await io.admin(site.targets['gateway-role-map']!.adminSocket, '/v1/drain', {}, 610_000));
      if (result.status === 'drained') break;
      if (io.now() >= deadline) return { outcome: 'still_busy' as const };
      update({ state: 'waiting' });
      await io.sleep(Math.min(600_000, deadline - io.now()));
      if (io.now() >= deadline) return { outcome: 'still_busy' as const };
    }
  } else {
    update({ state: 'restarting' });
    if ((await command(['restart', unit], 150_000)).code !== 0) return { outcome: 'restart_unverified' as const };
  }
  update({ state: 'verifying', busy: [] });
  const deadline = io.now() + 150_000;
  while (io.now() <= deadline) {
    const current = await pid();
    const active = await command(['is-active', unit]);
    if (current && current !== before && active.code === 0 && active.stdout.trim() === 'active') return { outcome: 'restarted' as const };
    if (io.now() >= deadline) break;
    await io.sleep(Math.min(1000, deadline - io.now()));
  }
  return { outcome: 'restart_unverified' as const };
}
