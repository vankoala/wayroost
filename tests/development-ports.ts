import { Server } from 'node:net';

// Opt-in for isolated checkouts with assigned ports; existing ephemeral fixtures
// share this small pool when Vitest runs files sequentially.
const ports = (process.env.WAYROOST_TEST_PORTS ?? '').split(',').map(Number);
if (!ports.length || ports.some(port => !Number.isInteger(port) || port < 8890 || port > 8899))
  throw new Error('WAYROOST_TEST_PORTS must name ports in the development block.');
const reserved = new Set<number>();
const original = Server.prototype.listen;
Server.prototype.listen = function (this: Server, ...args: unknown[]): Server {
  const first = args[0];
  const options = first && typeof first === 'object' ? first as Record<string, unknown> : undefined;
  const requested = typeof first === 'number' ? first : options?.port;
  if (typeof requested === 'number') {
    const port = requested === 0 ? ports.find(port => !reserved.has(port)) : requested;
    if (port === undefined || !ports.includes(port)) throw new Error('The test has no allowed development port available.');
    reserved.add(port);
    const release = () => reserved.delete(port);
    this.once('close', release); this.once('error', release);
    if (options) args[0] = { ...options, port }; else args[0] = port;
  }
  return Reflect.apply(original, this, args) as Server;
} as typeof original;
