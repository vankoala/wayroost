import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ConfigError } from './config-paths.js';
import { trustedExecutable, type Trust } from './trust.js';

export interface ConfigUnit { argv: readonly string[]; input: string }
export interface ConfigUnitOutput { code: number; stdout: string; result?: string }
export type ConfigUnitLineHandler = (line: string) => boolean;
export type ConfigUnitRunner = (unit: ConfigUnit, onLine?: ConfigUnitLineHandler) => Promise<ConfigUnitOutput>;
export interface ConfigUnitTarget { path: string; uid: number; backupDir?: string; auditDir?: string; lockPath?: string }
export const systemdPath = (path: string): string => '"' + path.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

export function gatewayPointUnit(input: unknown, executable = process.execPath,
  entry = fileURLToPath(new URL('./config-gateway-entry.js', import.meta.url))): ConfigUnit {
  const unit = configUnit({ path: '/', uid: 0 }, input, executable, entry);
  return { ...unit, argv: unit.argv.filter(argument => argument !== '--property=ProtectHome=read-only')
    .flatMap(argument => argument === '--' ? ['--property=ProtectHome=yes', '--property=RestrictAddressFamilies=AF_UNIX', '--'] : [argument]) };
}

export function configUnit(target: ConfigUnitTarget, input: unknown, executable = process.execPath,
  entry = fileURLToPath(new URL('./config-entry.js', import.meta.url))): ConfigUnit {
  const writable = [...new Set([...(target.lockPath ? [dirname(target.lockPath)] : []),
    ...(target.backupDir ? [dirname(target.path), target.backupDir] : []), ...(target.auditDir ? [target.auditDir] : [])])];
  return {
    argv: ['systemd-run', '--unit=wayroost-config-' + randomUUID(), '--wait', '--pipe', '--quiet', '--property=CollectMode=inactive', '--uid=' + target.uid,
      '--property=Type=exec', '--property=PrivateNetwork=yes', '--property=NoNewPrivileges=yes', '--property=RuntimeMaxSec=30',
      '--property=TimeoutStopSec=5', '--property=KillMode=control-group', '--property=ProtectSystem=strict', '--property=ProtectHome=read-only',
      '--property=UMask=0077', '--property=StandardError=null', '--property=WorkingDirectory=/',
      '--property=ReadWritePaths=' + writable.map(systemdPath).join(' '), '--', executable, entry],
    input: JSON.stringify(input) + '\n',
  };
}

/** The fixed program and the systemd client both pass the same root-only walk. */
export function configUnitRunner(trust: Trust = trustedExecutable, launch: typeof spawn = spawn): ConfigUnitRunner {
  return async (unit, onLine) => {
    const separator = unit.argv.indexOf('--');
    if (separator < 0 || unit.argv.length !== separator + 3) throw new ConfigError('unsafe_target');
    const command = await trust(unit.argv[0]!);
    await trust(unit.argv[separator + 1]!);
    await trust(unit.argv[separator + 2]!);
    const run = (command: string, argv: readonly string[], input: string, timeout: number, lineHandler?: ConfigUnitLineHandler): Promise<ConfigUnitOutput> => new Promise((resolve, reject) => {
      const child = launch(command, [...argv], { shell: false, stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' } });
      let stdout = '';
      let pending = '';
      let refused = false;
      let timedOut = false;
      child.stdout.setEncoding('utf8');
      const refuse = () => { refused = true; child.kill(); };
      const append = (chunk: string) => {
        if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 1024 * 1024) refuse();
        else stdout += chunk;
      };
      child.stdout.on('data', (chunk: string) => {
        if (refused) return;
        if (!lineHandler) { append(chunk); return; }
        pending += chunk;
        let end: number;
        while (!refused && (end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (Buffer.byteLength(line) > 64 * 1024) { refuse(); break; }
          try { if (!lineHandler(line)) append(line + '\n'); }
          catch { refuse(); }
        }
        if (Buffer.byteLength(pending) > 64 * 1024) refuse();
      });
      const timer = setTimeout(() => { timedOut = true; refused = true; child.kill(); }, timeout);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => {
        clearTimeout(timer);
        if (pending && !refused) {
          try { if (!lineHandler!(pending)) append(pending); }
          catch { refuse(); }
        }
        resolve({ code: timedOut ? 124 : refused ? 1 : code ?? 1, stdout: refused ? '' : stdout });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
    const drain = unit.argv.some(arg => /^--unit=wayroost-drain-(?:hermes-gateway|gateway|dashboard)$/.test(arg));
    const sweep = unit.argv.includes('--property=RuntimeMaxSec=180');
    const output = await run(command, unit.argv.slice(1), unit.input, drain ? 8_260_000 : sweep ? 340_000 : 40_000, drain ? onLine : undefined);
    if (output.code === 0) return output;
    const name = unit.argv.find(argument => argument.startsWith('--unit='))?.slice(7);
    if (!name || !/^(?:wayroost-config-[a-f0-9-]{36}|wayroost-drain-(?:hermes-gateway|gateway|dashboard))$/.test(name)) throw new ConfigError('unsafe_target');
    // Failed units stay loaded until their manager result has been captured.
    try {
      const systemctl = await trust('systemctl');
      const outcome = await run(systemctl, ['show', name + '.service', '--property=Result', '--value'], '', 5000);
      const result = outcome.stdout.trim();
      if (outcome.code === 0 && /^[a-z-]+$/.test(result)) {
        await run(systemctl, ['reset-failed', name + '.service'], '', 5000);
        return { ...output, result };
      }
    } catch {}
    return output;
  };
}
