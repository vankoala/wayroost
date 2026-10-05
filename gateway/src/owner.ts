import { readFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export type OwnerLookup = (socket: Socket) => Promise<number | undefined>;

export class BackendOwnerError extends Error {
  constructor(readonly port: number) { super('Backend owner mismatch.'); }
}

function address(value: string): string {
  const normalized = value.toUpperCase();
  if (normalized.includes(':')) {
    const halves = normalized.split('::');
    const left = halves[0]!.split(':').filter(Boolean);
    const right = (halves[1] ?? '').split(':').filter(Boolean);
    const words = halves.length === 2 ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right] : left;
    const hex = words.map(word => word.padStart(4, '0')).join('');
    return hex.match(/.{8}/g)!.map(word => word.match(/.{2}/g)!.reverse().join('')).join('');
  }
  return normalized.split('.').reverse().map(part => Number(part).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Match the accepted backend end, not the listener or the gateway's end. */
export function acceptedOwner(table: string, socket: Pick<Socket, 'localAddress' | 'localPort' | 'remoteAddress' | 'remotePort'>): number | undefined {
  if (!socket.localAddress || !socket.remoteAddress || !socket.localPort || !socket.remotePort) return undefined;
  const local = `${address(socket.remoteAddress)}:${socket.remotePort.toString(16).padStart(4, '0').toUpperCase()}`;
  const remote = `${address(socket.localAddress)}:${socket.localPort.toString(16).padStart(4, '0').toUpperCase()}`;
  for (const line of table.trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] === local && fields[2] === remote && fields[3] === '01' && /^\d+$/.test(fields[7] ?? '')) return Number(fields[7]);
  }
  return undefined;
}

export const lookupOwner: OwnerLookup = async socket => {
  const path = socket.remoteAddress?.includes(':') ? '/proc/net/tcp6' : '/proc/net/tcp';
  for (let attempt = 0; attempt < 3; attempt++) {
    const owner = acceptedOwner(await readFile(path, 'utf8'), socket);
    if (owner !== undefined) return owner;
    await delay(5);
  }
  return undefined;
};

/** No HTTP bytes or provider credentials are sent until the peer's owner is verified. */
export async function ownedConnection(url: URL, uid: number, lookup: OwnerLookup, signal: AbortSignal): Promise<Socket> {
  const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) });
  const abort = () => socket.destroy();
  signal.addEventListener('abort', abort, { once: true });
  socket.once('close', () => signal.removeEventListener('abort', abort));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve); socket.once('error', reject);
      socket.once('close', () => reject(new Error('Backend connection closed.')));
      if (signal.aborted) socket.destroy();
    });
    let closed: (() => void) | undefined;
    let actual: number | undefined;
    try {
      actual = await Promise.race([lookup(socket), new Promise<undefined>((_resolve, reject) => {
        closed = () => reject(new Error('Backend connection closed.'));
        socket.once('close', closed);
        if (signal.aborted) closed();
      })]);
    } finally { if (closed) socket.off('close', closed); }
    if (actual !== uid || signal.aborted) throw new BackendOwnerError(Number(url.port || (url.protocol === 'https:' ? 443 : 80)));
    return socket;
  } catch (error) { socket.destroy(); throw error; }
}
