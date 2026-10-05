import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfigInput } from './config-entry.js';
import { executeObservation } from './owner-observations.js';
if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => '') === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await executeObservation(JSON.parse(await readConfigInput(process.stdin)))) + '\n'); }
  catch { process.stdout.write('{"ok":false,"code":"unavailable"}\n'); }
}
