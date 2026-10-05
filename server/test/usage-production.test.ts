import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createSupervisor } from '../../supervisor/src/server.js';
import { gatewayUsageEvents } from '../../supervisor/src/usage-events.js';
import { configSchema } from '../../supervisor/src/config.js';
import { hashKey } from '../../supervisor/src/keys.js';
import type { ConfigVerbs } from '../../supervisor/src/config-verbs.js';

const fake = vi.hoisted(() => ({ options: undefined as any, requests: [] as any[], responses: [] as PassThrough[] }));
vi.mock('../../gateway/src/gateway.js', () => ({ startGateway: async (options: unknown) => { fake.options = options; return { close: async () => {} }; } }));
vi.mock('../../gateway/src/cli.js', () => ({ parseCliOptions: () => ({ configPath: '/home/me/config.json', adminSocket: '/run/example/admin.sock' }) }));
vi.mock('../../supervisor/src/socket.js', () => ({ prepareSocketDirectory: async () => {}, recoverSocket: async () => {} }));
vi.mock('node:fs/promises', async original => ({ ...await original<object>(), chmod: async () => {} }));
vi.mock('node:http', async original => {
  const actual = await original<typeof import('node:http')>();
  return { ...actual, request: (options: unknown, callback: (response: unknown) => void) => {
    fake.requests.push(options); const client = new EventEmitter();
    const response = Object.assign(new PassThrough(), { statusCode: 200 }); fake.responses.push(response);
    return Object.assign(client, { end() { queueMicrotask(() => callback(response)); }, destroy() { response.destroy(); } });
  } };
});
const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); for (const response of fake.responses.splice(0)) response.destroy(); vi.restoreAllMocks(); });
it('connects production onUsage to the private socket subscribers', async () => {
  const before = new Map((['SIGINT', 'SIGTERM'] as const).map(signal => [signal, process.listeners(signal)]));
  await import('../../gateway/src/index.js');
  const changed = vi.fn(); const stop = fake.options.usageEvents(changed);
  fake.options.onUsage({ role: 'main', status: 'ok', backendModel: 'example-model' });
  expect(changed).toHaveBeenCalledOnce(); stop(); fake.options.onUsage({ role: 'main', status: 'ok' }); expect(changed).toHaveBeenCalledOnce();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) for (const listener of process.listeners(signal)) if (!before.get(signal)!.includes(listener)) process.removeListener(signal, listener);
});
it('relays bounded private usage updates through the authenticated supervisor HTTP stream', async () => {
  const supervisor = createSupervisor({ config: configSchema.parse({ development: true, statusOnly: true, stateDir: '/home/me/fake-state' }), registry: [],
    keys: [{ name: 'server', scope: 'server', sha256: hashKey('fake-server') }], exec: { async run() { return 0; } },
    status: async () => ({ overall: 'ok', sentence: 'Ready', components: [], at: 1 }),
    usageEvents: publish => { const stop = gatewayUsageEvents('/run/example/admin.sock', publish); stops.push(stop); return stop; } });
  const req = Readable.from([]) as IncomingMessage; req.method = 'GET'; req.url = '/v1/events'; req.headers = { authorization: 'Bearer fake-server' };
  const frames: string[] = [];
  const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, writableLength: 0,
    writeHead() { this.headersSent = true; return this; }, write(frame: string) { frames.push(frame); return true; }, destroy() { this.destroyed = true; (this as unknown as EventEmitter).emit('close'); } });
  supervisor.socket.emit('request', req, res as unknown as ServerResponse);
  await vi.waitFor(() => expect(frames).toHaveLength(1));
  expect(fake.requests.at(-1)).toMatchObject({ socketPath: '/run/example/admin.sock', path: '/v1/usage/events', method: 'GET' });
  const response = fake.responses.at(-1)!;
  response.write('{"type":"usage_'); response.write('changed"}\n'); response.write('{"type":"usage_changed","prompt":"example"}\n');
  expect(frames).toHaveLength(2); expect(frames[1]).toContain('data: {"type":"usage_changed"}'); expect(frames.join('')).not.toContain('prompt');
  res.destroy();
});
it('starts the production usage observer from the configured gateway socket', async () => {
  const verbs = { initialize: vi.fn(async () => {}), usageSocket: vi.fn(async () => '/run/example/admin.sock') } as unknown as ConfigVerbs;
  const supervisor = createSupervisor({ config: configSchema.parse({ development: true, statusOnly: true, stateDir: '/home/me/fake-state' }), registry: [],
    keys: [], exec: { async run() { return 0; } }, configVerbs: verbs });
  vi.spyOn(supervisor.actions, 'initialize').mockResolvedValue();
  for (const listener of [supervisor.socket, supervisor.rescue]) {
    vi.spyOn(listener, 'listen').mockImplementation((...args: any[]) => { args.at(-1)(); return listener; });
    vi.spyOn(listener, 'close').mockImplementation(callback => { callback?.(); return listener; });
  }
  try {
    await supervisor.start();
    expect(verbs.usageSocket).toHaveBeenCalledOnce();
    expect(fake.requests.at(-1)).toMatchObject({ socketPath: '/run/example/admin.sock', path: '/v1/usage/events' });
  } finally { await supervisor.close(); }
});
