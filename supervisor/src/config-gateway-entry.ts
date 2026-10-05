import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfigInput } from './config-entry.js';
import { executeGatewayPoint } from './config-gateway-point.js';

if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => '') === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await executeGatewayPoint(JSON.parse(await readConfigInput(process.stdin, 4096)))) + '\n'); }
  catch { process.stdout.write('{"ok":false,"code":"invalid_parameters"}\n'); }
}
