import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Adopt } from './config.js';
import { buildRegistry, componentPatchSchema } from './registry.js';
import { trustedExecutable, type Trust } from './trust.js';

/** Validate once and retain the contents: installation must never reopen the source. */
export async function prepareRegistry(path: string, adopt: Adopt = {}, trust: Trust = trustedExecutable): Promise<{ contents: string; generic: boolean }> {
  await trust(path);
  const overrides = z.array(componentPatchSchema).parse(JSON.parse(await readFile(path, 'utf8')));
  const registry = buildRegistry(adopt, overrides);
  return { contents: JSON.stringify(overrides, null, 2), generic: isDeepStrictEqual(registry, buildRegistry(adopt)) };
}
