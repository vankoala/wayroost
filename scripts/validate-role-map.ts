import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readLimitedFile, parseConfig } from '../gateway/src/config.js';
import type { RoleMap } from '../shared/gateway.js';

/** Validate the current mapping and every profile against the role contracts. */
export async function validateRoleMap(path: string): Promise<RoleMap> {
  return parseConfig(JSON.parse((await readLimitedFile(resolve(path), 128 * 1024)).toString('utf8')));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error();
    await validateRoleMap(process.argv[2]!);
    process.stdout.write('Role map is valid.\n');
  } catch {
    process.stderr.write('Invalid role map. Supply one JSON file matching the schema and every role contract.\n');
    process.exitCode = 1;
  }
}
