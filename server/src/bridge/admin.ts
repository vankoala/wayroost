import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { BackgroundGate } from '../background.js';
import type { MaintenanceHold } from './maintenance.js';
import type { QuietReport } from '../../../shared/protocol.js';

export const MAINTENANCE_SOCKET = join('bridge-admin', 'admin.sock');
const Command = z.object({ command: z.enum(['hold', 'release', 'quiet']) }).strict();

/** The service and root only: agent bearer tokens and browser cookies grant no access. */
export async function startMaintenanceAdmin(stateDir: string, hold: MaintenanceHold, quiet: () => Promise<QuietReport>, background = new BackgroundGate('primary')): Promise<Server> {
  const dir = join(stateDir, 'bridge-admin');
  const path = join(stateDir, MAINTENANCE_SOCKET);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error('The bridge admin directory is not a directory.');
  chmodSync(dir, 0o700);
  try {
    if (!lstatSync(path).isSocket()) throw new Error('The bridge admin path is not a socket.');
    rmSync(path);
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    let input = '';
    let answered = false;
    const answer = async () => {
      if (answered) return;
      answered = true;
      const parsed = Command.safeParse((() => { try { return JSON.parse(input.trim()); } catch { return undefined; } })());
      if (!parsed.success) { socket.end(`${JSON.stringify({ error: 'bad_request' })}\n`); return; }
      try {
        if (parsed.data.command !== 'quiet') background.require();
        const result = parsed.data.command === 'quiet' ? await quiet() : hold.set(parsed.data.command === 'hold');
        socket.end(`${JSON.stringify(result)}\n`);
      } catch { socket.end(`${JSON.stringify({ error: 'unavailable', message: 'The maintenance command could not be completed.' })}\n`); }
    };
    socket.on('data', (chunk: string) => {
      input += chunk;
      if (input.length > 256) socket.destroy();
      else if (input.includes('\n')) void answer();
    });
    socket.on('end', () => { void answer(); });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => { server.off('error', reject); resolve(); });
    });
    chmodSync(path, 0o600);
  } catch (err) { server.close(); throw err; }
  return server;
}
