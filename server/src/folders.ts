import { posix } from 'node:path';
import { UserFacingError } from './sources.js';

/**
 * A folder someone typed for a new chat, normalized and split for creating it one level down:
 * `/home/me/new/` → { path: '/home/me/new', parent: '/home/me', name: 'new' }.
 */
export function splitFolder(typed: string): { path: string; parent: string; name: string } {
  if (!typed.startsWith('/')) throw new UserFacingError('A folder path starts with /.', 400);
  const path = posix.normalize(typed).replace(/\/+$/, '') || '/';
  const name = posix.basename(path);
  // eslint-disable-next-line no-control-regex
  if (path !== '/' && (name.length > 255 || /[\u0000-\u001f]/.test(name))) {
    throw new UserFacingError("That folder name can't be used.", 400);
  }
  return { path, parent: posix.dirname(path), name };
}
