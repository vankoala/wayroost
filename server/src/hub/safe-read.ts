import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

export interface SafeReadOptions {
  maxBytes: number;
  root?: string;
  ownerUid?: number;
  fileMode?: number;
}

export type SafeReadRefusalReason = 'invalid-options' | 'outside-root' | 'symlink' | 'not-regular' | 'wrong-owner' | 'wrong-mode' | 'too-large' | 'changed' | 'io-error' | 'invalid-json' | 'unsupported-platform';
export interface SafeReadRefusal {
  refused: true;
  reason: SafeReadRefusalReason;
  code?: string;
}
export interface SafeRead {
  text: string;
  bytes: number;
  truncated: false;
}
export type SafeReadResult = SafeRead | SafeReadRefusal;
export type SafeJsonReadResult = (SafeRead & { value: unknown }) | SafeReadRefusal;

const refuse = (reason: SafeReadRefusalReason): SafeReadRefusal => ({ refused: true, reason });
const absolutePath = (path: string) => path.startsWith('/') ? path : `${process.cwd()}/${path}`;
const descriptorPath = (file: FileHandle, component: string) => `/proc/self/fd/${file.fd}/${component}`;
interface PinnedDirectory { file: FileHandle; dev: bigint; ino: bigint }

/** Each lookup uses its pinned parent; '..' returns to a previously checked handle. */
async function directory(path: string, handles: FileHandle[]): Promise<PinnedDirectory[] | SafeReadRefusal> {
  const stack: PinnedDirectory[] = [];
  for (const component of ['/', ...path.split('/')]) {
    if (!component || component === '.') continue;
    if (component === '..') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const current = stack.length === 0 ? '/' : descriptorPath(stack.at(-1)!.file, component);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) return refuse('symlink');
    if (!entry.isDirectory()) return refuse('not-regular');
    const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY | constants.O_NONBLOCK);
    handles.push(file);
    const info = await file.stat({ bigint: true });
    if (!info.isDirectory()) return refuse('not-regular');
    stack.push({ file, dev: info.dev, ino: info.ino });
  }
  return stack;
}

function ioRefusal(error: unknown): SafeReadRefusal {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return { refused: true, reason: code === 'ELOOP' ? 'symlink' : 'io-error', ...(code ? { code } : {}) };
}

/** Refuse excess data rather than returning an incomplete document. */
export async function readBounded(path: string, options: SafeReadOptions): Promise<SafeReadResult> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || options.maxBytes >= Number.MAX_SAFE_INTEGER ||
      !path || path.includes('\0') || (options.root !== undefined && (!options.root || options.root.includes('\0'))) ||
      (options.ownerUid !== undefined && (!Number.isSafeInteger(options.ownerUid) || options.ownerUid < 0)) ||
      (options.fileMode !== undefined && (!Number.isInteger(options.fileMode) || options.fileMode < 0 || options.fileMode > 0o7777))) {
    return refuse('invalid-options');
  }
  if (process.platform === 'win32' && [path, options.root].some(value => value !== undefined && /^[a-z]:(?![\\/])/i.test(value))) {
    return refuse('invalid-options');
  }
  // Node cannot atomically reject Windows reparse points; pinned traversal needs Linux descriptor paths.
  if (process.platform === 'win32' || !constants.O_NOFOLLOW ||
      (options.root !== undefined && (process.platform !== 'linux' || !constants.O_DIRECTORY))) {
    return refuse('unsupported-platform');
  }
  const handles: FileHandle[] = [];
  let result: SafeReadResult;
  try {
    let checkedPath = absolutePath(path);
    if (options.root !== undefined) {
      const checkedRoot = await directory(absolutePath(options.root), handles);
      if (!Array.isArray(checkedRoot)) return checkedRoot;
      const root = checkedRoot.at(-1)!;
      const components = checkedPath.split('/');
      const name = components.pop()!;
      const parent = await directory(components.join('/') || '/', handles);
      if (!Array.isArray(parent)) return parent;
      if (!parent.some(item => item.dev === root.dev && item.ino === root.ino)) return refuse('outside-root');
      checkedPath = descriptorPath(parent.at(-1)!.file, name || '.');
    }
    const entry = await lstat(checkedPath);
    if (entry.isSymbolicLink()) return refuse('symlink');
    if (!entry.isFile()) return refuse('not-regular');
    // Nonblocking open also avoids waiting on a FIFO swapped in after lstat.
    const file = await open(checkedPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    handles.push(file);
    const info = await file.stat();
    if (!info.isFile()) {
      result = refuse('not-regular');
    } else if (options.ownerUid !== undefined && info.uid !== options.ownerUid) {
      result = refuse('wrong-owner');
    } else if (options.fileMode !== undefined && (info.mode & 0o7777) !== options.fileMode) {
      result = refuse('wrong-mode');
    } else if (info.size > options.maxBytes) {
      result = refuse('too-large');
    } else {
      const buffer = Buffer.alloc(Math.min(64 * 1024, options.maxBytes + 1));
      const chunks: Buffer[] = [];
      let bytes = 0;
      while (bytes <= options.maxBytes) {
        const length = Math.min(buffer.length, options.maxBytes + 1 - bytes);
        const read = await file.read(buffer, 0, length, null);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
        if (bytes > options.maxBytes) break;
        chunks.push(Buffer.from(buffer.subarray(0, read.bytesRead)));
      }
      result = bytes > options.maxBytes ? refuse('too-large') : {
        text: Buffer.concat(chunks, bytes).toString('utf8'), bytes, truncated: false,
      };
    }
  } catch (error) {
    result = ioRefusal(error);
  } finally {
    for (const file of handles.reverse()) {
      try {
        await file.close();
      } catch (error) {
        result = ioRefusal(error);
      }
    }
  }
  return result;
}

export async function readJsonBounded(path: string, options: SafeReadOptions): Promise<SafeJsonReadResult> {
  const result = await readBounded(path, options);
  if ('refused' in result) return result;
  try {
    return { ...result, value: JSON.parse(result.text) as unknown };
  } catch {
    return refuse('invalid-json');
  }
}
