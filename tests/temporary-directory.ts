import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Keep test allocations inside the checkout even when the host overrides TMPDIR. */
export function temporaryDirectory(prefix: string): string {
  const base = fileURLToPath(new URL('../test-results/', import.meta.url));
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}
