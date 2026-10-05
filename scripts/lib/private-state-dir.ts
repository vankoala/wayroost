import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A private state folder for a demo, a visual check or an end-to-end run.
 *
 * Wayroost's own settings (notification rules and quiet hours) are written through the
 * write-through core, which refuses a folder anyone can write: `/tmp` is world-writable,
 * so a state dir there can hold cards and subscriptions but not a settings file. This is
 * where a real install keeps it — a directory only the service's own user can write.
 */
export function privateStateDir(prefix: string, base = join(process.cwd(), '.tmp')): string {
  mkdirSync(base, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(base, prefix));
}
