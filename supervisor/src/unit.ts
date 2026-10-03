// systemd units, as data. The supervisor runs as root, so user units go
// through the explicitly configured owner's manager.
import { z } from 'zod';

export const unitSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_.@:-]*\.service$/),
  scope: z.enum(['system', 'user']),
  /** Only meaningful with scope "user"; site-specific, so overrides supply it. */
  user: z.string().regex(/^[a-z_][a-z0-9_-]*$/).optional(),
}).strict();
export type Unit = z.infer<typeof unitSchema>;

/** systemctl argv for a verb (start, stop, restart) or a probe (is-active …). */
export function unitArgv(unit: Unit, ...args: string[]): string[] {
  if (unit.scope === 'user') {
    if (!unit.user) throw new Error('A user unit needs its owner.');
    return ['systemctl', '--user', '-M', unit.user + '@', ...args, unit.name];
  }
  return ['systemctl', ...args, unit.name];
}
