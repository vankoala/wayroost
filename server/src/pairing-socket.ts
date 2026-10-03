import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { DEVICE_KINDS, PAIR_PATH, type DeviceKind } from '../../shared/protocol.js';
import type { Devices, PairingCode } from './devices.js';
import type { Logger } from './hermes/adapter.js';

// Recovery: root on the PC can always get a pairing code, even with no paired
// desktop left or pairing locked. The server listens on a Unix socket inside its
// own state directory (<stateDir>/pairing/pair.sock): the folder is mode 700 and
// the socket 600, both owned by the service user, so only that user and root can
// connect. Agents run as your own user and can't. There is no network listener,
// and the socket only ever hands out a code: one line in, one line out.
// scripts/pair-code.ts is the root side.

export const PAIRING_SOCKET = join('pairing', 'pair.sock');
const MAX_REQUEST = 256;
const TIMEOUT_MS = 2_000;

const Request = z.object({ kind: z.enum(DEVICE_KINDS).default('desktop') }).strict();

/** What the socket answers: the code and a pairing link on every configured origin. */
export interface RecoveryCode {
  code: string;
  kind: DeviceKind;
  expiresAt: number;
  urls: string[];
}

export function pairingSocketPath(stateDir: string): string {
  return join(stateDir, PAIRING_SOCKET);
}

export interface PairingSocketOptions {
  devices: Pick<Devices, 'createCode'>;
  stateDir: string;
  /** Every origin the app is opened from, local ones first. */
  origins: readonly string[];
  log: Logger;
}

export async function startPairingSocket(options: PairingSocketOptions): Promise<Server> {
  const path = pairingSocketPath(options.stateDir);
  const dir = join(options.stateDir, 'pairing');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} isn't a directory`);
  chmodSync(dir, 0o700);
  try {
    if (!lstatSync(path).isSocket()) throw new Error(`${path} exists and isn't a socket`);
    rmSync(path); // left over from the last run
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    let input = '';
    let answered = false;
    const answer = () => {
      if (answered) return;
      answered = true;
      let kind: DeviceKind;
      try {
        kind = Request.parse(JSON.parse(input.trim() || '{}')).kind;
      } catch {
        socket.end(`${JSON.stringify({ error: 'bad request' })}\n`);
        return;
      }
      let made: PairingCode;
      try {
        made = options.devices.createCode(kind, { recovery: true });
      } catch (err) {
        // Lifting a lock writes the device store, which can fail (a full disk,
        // say). Inside a socket handler that would take the server down; root
        // gets an error instead. Only the error's code is logged.
        options.log.error({ kind, err: (err as NodeJS.ErrnoException).code ?? 'unknown' }, 'the recovery socket could not make a pairing code');
        socket.end(`${JSON.stringify({ error: 'could not make a code; see the server log' })}\n`);
        return;
      }
      const reply: RecoveryCode = {
        ...made,
        urls: options.origins.map((origin) => `${origin}${PAIR_PATH}#${made.code}`),
      };
      options.log.warn({ kind }, 'pairing code made through the recovery socket');
      socket.end(`${JSON.stringify(reply)}\n`);
    };
    socket.on('data', (chunk: string) => {
      input += chunk;
      if (input.length > MAX_REQUEST) socket.destroy();
      else if (input.includes('\n')) answer();
    });
    socket.on('end', answer);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  chmodSync(path, 0o600);
  return server;
}

/** The root side: asks the running server for a code. */
export function requestRecoveryCode(socketPath: string, kind: DeviceKind): Promise<RecoveryCode> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let output = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5_000, () => socket.destroy(new Error('the server did not answer')));
    socket.on('connect', () => socket.write(`${JSON.stringify({ kind })}\n`));
    socket.on('data', (chunk: string) => {
      output += chunk;
    });
    socket.on('error', reject);
    socket.on('close', () => {
      try {
        const reply = JSON.parse(output) as RecoveryCode | { error: string };
        if ('error' in reply) reject(new Error(reply.error));
        else resolve(reply);
      } catch {
        reject(new Error('the server gave no code'));
      }
    });
  });
}
