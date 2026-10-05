import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gatewayUsageSummary } from '../../supervisor/src/usage-summary.js';
import { createSupervisor } from '../../supervisor/src/server.js';
import { configSchema } from '../../supervisor/src/config.js';
import { hashKey } from '../../supervisor/src/keys.js';
import type { UsageSummaryResult } from '../../shared/supervisor-config.js';

const fake = vi.hoisted(() => ({ servers: [] as unknown[], reply: '{}' as string, status: 200, calls: [] as Array<{ options: Record<string, unknown>; body: string }> }));
vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events'); const { PassThrough } = await import('node:stream');
  return { createServer: (handler: (...args: unknown[]) => void) => {
    const server = new EventEmitter(); server.on('request', handler); fake.servers.push(server); return server;
  }, request: (options: Record<string, unknown>, callback: (response: unknown) => void) => {
    const client = new EventEmitter() as EventEmitter & { end: (body: string) => void };
    client.end = body => {
      fake.calls.push({ options, body });
      const stream = new PassThrough() as PassThrough & { statusCode: number }; stream.statusCode = fake.status;
      queueMicrotask(() => { callback(stream); stream.end(fake.reply); });
    };
    return client;
  } };
});

const requestBody = { windows: [{ id: 'today' as const, since: 0 }] };
const result: UsageSummaryResult = { ok: true, generatedAt: 100, windows: [{ id: 'today', since: 0, rows: [] }] };
class Response extends Writable {
  statusCode = 200; headersSent = false; chunks: Buffer[] = [];
  writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) { this.chunks.push(Buffer.from(chunk)); done(); }
  get json() { return JSON.parse(Buffer.concat(this.chunks).toString()); }
}

beforeEach(() => { fake.servers = []; fake.calls = []; fake.reply = JSON.stringify(result); fake.status = 200; });
describe('supervisor usage transport', () => {
  it('forwards validated windows to a fixed private gateway socket', async () => {
    expect(await gatewayUsageSummary(requestBody)).toEqual(result);
    expect(fake.calls[0]?.options).toMatchObject({ socketPath: '/run/wayroost-gateway/admin.sock', path: '/v1/usage/summary', method: 'POST' });
    expect(JSON.parse(fake.calls[0]!.body)).toEqual(requestBody);
  });
  it('rejects arbitrary fields and returns fixed failures for malformed, oversized or unexpected responses', async () => {
    expect(await gatewayUsageSummary({ ...requestBody, path: '/home/me/fake' })).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(fake.calls).toHaveLength(0);
    for (const body of ['not-json', JSON.stringify({ ...result, prompt: 'fake private prompt' }), 'x'.repeat(1024 * 1024 + 1)]) {
      fake.reply = body; expect(await gatewayUsageSummary(requestBody)).toEqual({ ok: false, code: 'unavailable' });
    }
    fake.status = 503; fake.reply = JSON.stringify(result);
    expect(await gatewayUsageSummary(requestBody)).toEqual({ ok: false, code: 'unavailable' });
  });
});

describe('supervisor usage access', () => {
  async function send(token: string | undefined, body: unknown, rescue = false, supplied: UsageSummaryResult = result) {
    const relay = vi.fn(async () => supplied);
    const supervisor = createSupervisor({ config: configSchema.parse({ development: true, stateDir: '/home/me/fake-state', statusOnly: true }), registry: [],
      keys: [{ name: 'server', scope: 'server', sha256: hashKey('fake-server') }, { name: 'launcher', scope: 'server', sha256: hashKey('fake-launcher') },
        { name: 'rescue', scope: 'rescue', sha256: hashKey('fake-rescue') }], exec: { async run() { return 0; } }, usageSummary: relay });
    const incoming = new PassThrough() as PassThrough & { url: string; method: string; headers: Record<string, string> };
    incoming.url = '/v1/usage/summary'; incoming.method = 'POST'; incoming.headers = token ? { authorization: `Bearer ${token}` } : {};
    const response = new Response(); const done = new Promise(resolve => response.once('finish', resolve));
    const server = rescue ? supervisor.rescue : supervisor.socket;
    (server as Server).emit('request', incoming as unknown as IncomingMessage, response as unknown as ServerResponse);
    incoming.end(JSON.stringify(body)); await done;
    return { response, relay };
  }
  it('allows a server key to read summaries while writes and lifecycle actions are disabled', async () => {
    const { response, relay } = await send('fake-server', requestBody);
    expect(response.statusCode).toBe(200); expect(response.json).toEqual(result); expect(relay).toHaveBeenCalledOnce();
  });
  it.each([
    [undefined, false, 401], ['fake-launcher', false, 403], ['fake-rescue', true, 403], ['fake-rescue', false, 403],
  ] as const)('refuses an unauthorized reader %s', async (token, rescue, status) => {
    const { response, relay } = await send(token, requestBody, rescue);
    expect(response.statusCode).toBe(status); expect(relay).not.toHaveBeenCalled();
  });
  it('rejects invalid windows before contacting the gateway', async () => {
    const { response, relay } = await send('fake-server', { windows: [{ id: 'other', since: 0 }] });
    expect(response.statusCode).toBe(400); expect(relay).not.toHaveBeenCalled();
  });
});
