import { spawn } from 'node:child_process';
import { trustedExecutable, type Trust } from './trust.js';

export interface CommandOutput { code: number; stdout: string }
export type ConfigCommand = (argv: readonly string[], env?: Readonly<Record<string, string>>, timeoutMs?: number) => Promise<CommandOutput>;
export function configCommand(trust: Trust = trustedExecutable): ConfigCommand {
  return async (argv, environment = {}, timeoutMs = 150_000) => {
    const executable = await trust(argv[0]!);
    return new Promise((resolve, reject) => {
      const child = spawn(executable, argv.slice(1), { shell: false, stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', ...environment } });
      let stdout = '';
      let refused = false;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 64 * 1024) { refused = true; child.kill('SIGKILL'); }
        else stdout += chunk;
      });
      const timer = setTimeout(() => { refused = true; child.kill('SIGKILL'); }, timeoutMs);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ code: refused ? 124 : code ?? 1, stdout: refused ? '' : stdout }); });
    });
  };
}
