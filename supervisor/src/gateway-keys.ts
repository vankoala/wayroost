import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ConfigVerbs } from './config-verbs.js';
import { loadConfig } from './config.js';

if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => '') === fileURLToPath(import.meta.url)) {
  try {
    if (process.getuid!() !== 0 || process.argv.length !== 3 || process.argv[2] !== 'import') throw new Error();
    const config = await loadConfig();
    const verbs = new ConfigVerbs({ stateDir: config.stateDir });
    const result = await verbs.importKeys({ requestId: randomUUID() }, { name: 'key-import', scope: 'server', sha256: '0'.repeat(64) });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.ok) process.exitCode = 1;
  } catch { process.stdout.write('{"ok":false,"code":"failed"}\n'); process.exitCode = 1; }
}
