import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shadowBackground, type BackgroundGate } from '../background.js';

// The bridge's bearer token lives in the service's private state directory.
// deploy/setup-bridge.sh (as root) copies it to the agent user's
// ~/.config/wayroost/bridge-token. It is never logged.

export const BRIDGE_TOKEN_FILE = 'bridge-token';
const TOKEN = /^[A-Za-z0-9_-]{32,512}$/;
const stateDirectories = new Map<string, string>();
const tokenKey = (token: string) => createHash('sha256').update(token).digest('hex');

/** The listener restores its admission hold from the same state directory as its token. */
export function bridgeStateDirectory(token: string): string | undefined {
  return stateDirectories.get(tokenKey(token));
}

function remember(token: string, stateDir: string): string {
  stateDirectories.set(tokenKey(token), stateDir);
  return token;
}

/** Read the token, creating 32 random bytes (base64url, mode 0600) on first start. */
export function readOrCreateBridgeToken(stateDir: string, background: BackgroundGate = shadowBackground): string {
  background.require();
  const path = join(stateDir, BRIDGE_TOKEN_FILE);
  let existing: string | undefined;
  try {
    existing = readFileSync(path, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing !== undefined) {
    if (!TOKEN.test(existing)) throw new Error(`${path} doesn't hold a usable bridge token; delete it to make a new one.`);
    if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
    return remember(existing, stateDir);
  }
  const token = randomBytes(32).toString('base64url');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try {
    // No trailing newline: the file is used as a header value as-is.
    writeFileSync(path, token, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return readOrCreateBridgeToken(stateDir, background);
    throw err;
  }
  return remember(token, stateDir);
}
