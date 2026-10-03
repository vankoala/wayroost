import type { Exec } from '../src/probes.js';
/** No test executes systemd commands or calls the built-in health ports. */
export function isolatedExec(exec: Exec): Exec {
  return { run(argv, line) { return argv.includes('list-units') ? Promise.resolve(0) : exec.run(argv, line); } };
}
/** Tests run fake argv through a fake Exec; the real ownership walk has its own test. */
export const trustAny = async (command: string): Promise<string> => command;
