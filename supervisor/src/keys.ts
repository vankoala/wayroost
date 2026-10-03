import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { RESCUE_ACTIONS } from '../../shared/supervisor.js';
import type { ActionRequest } from '../../shared/supervisor.js';
const schema = z.array(z.object({ name: z.string().min(1), scope: z.enum(['server', 'rescue']), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict());
export type Key = z.infer<typeof schema>[number];
export const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');
export async function loadKeys(path: string): Promise<Key[]> { return schema.parse(JSON.parse(await readFile(path, 'utf8'))); }
export function authenticate(token: string, keys: Key[]): Key | undefined {
  const digest = Buffer.from(hashKey(token), 'hex');
  let match: Key | undefined;
  for (const key of keys) if (timingSafeEqual(digest, Buffer.from(key.sha256, 'hex'))) match = key;
  return match;
}
export function permits(key: Key, request: ActionRequest): boolean {
  return key.scope === 'server' || RESCUE_ACTIONS.some(action => action.verb === request.verb && action.target === request.target);
}
