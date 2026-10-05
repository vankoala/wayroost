import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startGateway, type GatewayOptions, type LogEntry } from '../src/gateway.js';
import { demoMap } from './map-fixture.js';
import { directoryMetadata } from './filesystem-fixture.js';
import type { RoleMap } from '../../shared/gateway.js';
import type { UsageEvent } from '../../shared/usage.js';

const fake = vi.hoisted(() => ({ servers: [] as unknown[], calls: [] as Array<{ url: URL; options: Record<string, unknown>; body: Buffer }>,
  reply: undefined as undefined | ((upstream: PassThrough) => void), upstream: undefined as undefined | PassThrough, holdHeaders: false }));
vi.mock('node:fs/promises', { spy: true });
vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  class FakeServer extends EventEmitter {
    listening = false; port = 0; unix = false; addressValue: unknown;
    constructor(handler: (...args: unknown[]) => void) { super(); this.on('request', handler); fake.servers.push(this); }
    listen(address: number | string | { fd: number }, hostOrReady: unknown, ready?: () => void) {
      this.unix = typeof address === 'string';
      this.port = typeof address === 'number' ? address : typeof address === 'object' ? 18010 + address.fd - 3 : 0;
      this.addressValue = typeof address === 'object' ? address : undefined;
      this.listening = true;
      void (async () => {
        if (this.unix) await (await import('node:fs/promises')).writeFile(address as string, '', { mode: 0o600 });
        (typeof hostOrReady === 'function' ? hostOrReady : ready as () => void)();
      })();
      return this;
    }
    address() { return { address: '127.0.0.1', port: this.port }; }
    close(callback?: () => void) { this.listening = false; callback?.(); return this; }
    closeAllConnections() {}
  }
  return { createServer: (handler: (...args: unknown[]) => void) => new FakeServer(handler), request: (url: URL, options: Record<string, unknown>, callback: (response: unknown) => void) => {
    const client = new EventEmitter() as EventEmitter & { setTimeout: () => void; end: (body: Buffer) => void; destroy: () => void };
    client.setTimeout = () => {};
    client.destroy = () => { fake.upstream?.destroy(); client.emit('error', new Error('Fake upstream stopped.')); };
    client.end = body => {
      if (typeof options.createConnection === 'function') options.createConnection();
      fake.calls.push({ url, options, body });
      const upstream = new PassThrough() as PassThrough & { headers: Record<string, string>; statusCode: number };
      upstream.headers = { 'content-type': 'application/json' }; upstream.statusCode = 200; fake.upstream = upstream;
      const signal = options.signal as AbortSignal;
      const abort = () => {
        if (fake.holdHeaders) { upstream.destroy(); client.emit('error', new Error('Fake request aborted.')); }
        else upstream.destroy(new Error('Fake request aborted.'));
      };
      signal.addEventListener('abort', abort, { once: true });
      upstream.once('close', () => signal.removeEventListener('abort', abort));
      if (!fake.holdHeaders) queueMicrotask(() => { fake.reply?.(upstream); callback(upstream); });
    };
    return client;
  } };
});
vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events');
  return { connect: () => {
    const socket = new EventEmitter() as EventEmitter & { destroy: () => void };
    socket.destroy = () => socket.emit('close'); queueMicrotask(() => socket.emit('connect')); return socket;
  } };
});

class Consumer extends EventEmitter {
  closed = false;
  reset = false;
  destroy() { if (!this.closed) { this.closed = true; this.emit('close'); } }
  resetAndDestroy() { this.reset = true; this.destroy(); }
}
class Response extends Writable {
  statusCode = 200;
  headersSent = false;
  headers: Record<string, unknown> = {};
  chunks: Buffer[] = [];
  setHeader(name: string, value: unknown) { this.headers[name] = value; }
  writeHead(status: number, headers: Record<string, unknown>) { this.statusCode = status; Object.assign(this.headers, headers); this.headersSent = true; }
  flushHeaders() { this.headersSent = true; }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) { this.chunks.push(Buffer.from(chunk)); done(); }
  get body() { return Buffer.concat(this.chunks).toString('utf8'); }
}
type FakeServer = Server & { port: number; unix: boolean; addressValue: unknown };

 describe('gateway with inherited listeners and fake connections', () => {
  let directory: string;
  let configFile: string;
  let gateway: Awaited<ReturnType<typeof startGateway>>;
  let events: UsageEvent[];
  let logs: LogEntry[];
  beforeEach(async () => {
    fake.servers = []; fake.calls = []; fake.holdHeaders = false; events = []; logs = [];
    const root = join(process.cwd(), 'gateway/.test-tmp'); await fs.mkdir(root, { recursive: true, mode: 0o700 });
    directory = await fs.mkdtemp(join(root, 'proxy-')); configFile = join(directory, 'role-map.json');
    await fs.writeFile(configFile, JSON.stringify(demoMap()), { mode: 0o600 });
    await directoryMetadata();
    const actualLstat = vi.mocked(fs.lstat).getMockImplementation()!;
    vi.mocked(fs.lstat).mockImplementation(async (...args) => {
      const stats = await actualLstat(...args);
      if (String(args[0]).endsWith('/admin.sock')) stats.isSocket = () => true;
      return stats;
    });
    fake.reply = upstream => upstream.end(JSON.stringify({ choices: [{ message: { content: 'Fake private answer.' } }], usage: { prompt_tokens: 20, completion_tokens: 3 } }));
  });
  afterEach(async () => { await gateway?.close(); vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });
  async function start(options: Partial<GatewayOptions> = {}, map?: RoleMap) {
    if (map) await fs.writeFile(configFile, JSON.stringify(map), { mode: 0o600 });
    gateway = await startGateway({ configFile, adminSocket: join(directory, 'admin.sock'), ports: { main: 8898 }, ownerLookup: async () => 0,
      onUsage: event => events.push(event), log: entry => logs.push(entry), ...options });
  }
  function server(admin = false): FakeServer { return (fake.servers as FakeServer[]).find(value => value.unix === admin)!; }
  function begin(path = '/v1/chat/completions', body: unknown = { model: 'main', messages: [{ role: 'user', content: 'Fake private prompt.' }] },
    options: { admin?: boolean; method?: string; headers?: Record<string, string>; upload?: boolean; port?: number } = {}) {
    const target = options.port === undefined ? server(options.admin) : (fake.servers as FakeServer[]).find(value => value.port === options.port)!; const socket = new Consumer();
    const request = new PassThrough() as PassThrough & { url: string; method: string; socket: Consumer; headers: Record<string, string> };
    request.url = path; request.method = options.method ?? 'POST'; request.socket = socket;
    request.headers = { host: `127.0.0.1:${target.port}`, 'content-type': 'application/json', ...options.headers };
    const response = new Response();
    const done = new Promise<Response>(resolve => { response.once('close', () => resolve(response)); socket.once('close', () => { if (!response.writableEnded) response.destroy(); }); });
    response.once('finish', () => socket.destroy());
    target.emit('connection', socket as unknown as Socket);
    if (!socket.closed) { target.emit('request', request as unknown as IncomingMessage, response as unknown as ServerResponse); }
    else response.destroy();
    if (!options.upload) queueMicrotask(() => request.end(JSON.stringify(body)));
    return { done, request, response, socket, finish: () => request.end(JSON.stringify(body)) };
  }
  async function send(path?: string, body?: unknown, options?: Parameters<typeof begin>[2]) { return await begin(path, body, options).done; }
  async function flush() { await new Promise(resolve => setImmediate(resolve)); }
  it.each([200, 401, 403, 400, 503])('probes the credential only through the admin socket and maps HTTP %i to a fixed result', async status => {
    const map = demoMap(); map.backends['demo-a']!.provider = 'example';
    await start({}, map);
    fake.reply = upstream => { Object.assign(upstream, { statusCode: status }); upstream.end('fake-stored-key upstream body'); };
    const probe = await send('/v1/credentials/example/test', { backend: 'demo-a', secret: 'fake-stored-key' }, { admin: true });
    expect(JSON.parse(probe.body)).toEqual(status === 200 ? { ok: true, provider: 'example', backend: 'demo-a' }
      : { ok: false, code: status === 401 || status === 403 ? 'credential_rejected' : status === 503 ? 'backend_unavailable' : 'test_failed' });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url.pathname).toBe('/v1/chat/completions');
    expect(fake.calls[0]!.options.headers).toMatchObject({ authorization: 'Bearer fake-stored-key' });
    expect(JSON.parse(fake.calls[0]!.body.toString())).toEqual({ model: 'demo-model-a', messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 1, stream: false });
    expect(JSON.stringify(logs)).not.toContain('fake-stored-key'); expect(JSON.stringify(events)).not.toContain('fake-stored-key');
    expect((await send('/v1/credentials/example/test', { backend: 'demo-a', secret: 'fake-stored-key' })).statusCode).toBe(404);
  });

  it.each(['unknown-backend', 'wrong-provider', 'invalid-body'] as const)('refuses a %s credential probe before contacting a backend', async scenario => {
    const map = demoMap(); map.backends['demo-a']!.provider = 'example'; await start({}, map);
    const response = await send('/v1/credentials/' + (scenario === 'wrong-provider' ? 'other' : 'example') + '/test',
      { backend: scenario === 'unknown-backend' ? 'missing' : 'demo-a', secret: 'fake-stored-key', ...(scenario === 'invalid-body' ? { prompt: 'custom prompt' } : {}) }, { admin: true });
    expect(JSON.parse(response.body)).toEqual({ ok: false, code: 'test_failed' }); expect(fake.calls).toEqual([]);
  });

  it('bounds a credential probe to five seconds without exposing upstream errors', async () => {
    const map = demoMap(); map.backends['demo-a']!.provider = 'example'; await start({}, map);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fake.holdHeaders = true;
      const probe = begin('/v1/credentials/example/test', { backend: 'demo-a', secret: 'fake-stored-key' }, { admin: true });
      await flush();
      expect(fake.calls).toHaveLength(1); expect(probe.response.writableEnded).toBe(false);
      await vi.advanceTimersByTimeAsync(4999); expect(probe.response.writableEnded).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(JSON.parse((await probe.done).body)).toEqual({ ok: false, code: 'backend_unavailable' });
      expect(JSON.stringify(logs) + JSON.stringify(events) + probe.response.body).not.toContain('fake-stored-key');
    } finally { vi.useRealTimers(); }
  });

  async function summary() { return JSON.parse((await send('/v1/usage/summary', { windows: [{ id: 'today', since: 0 }] }, { admin: true })).body); }

  it('inherits the three role descriptors and reports backend-independent health', async () => {
    await start({ ports: undefined, listeners: { main: 3, coder: 4, fast: 5 } });
    expect((fake.servers as FakeServer[]).filter(value => !value.unix).map(value => value.addressValue)).toEqual([{ fd: 3 }, { fd: 4 }, { fd: 5 }]);
    expect(JSON.parse((await send('/healthz', undefined, { method: 'GET' })).body)).toEqual({ status: 'ok' });
    expect(JSON.parse((await send('/healthz', undefined, { admin: true, method: 'GET' })).body)).toEqual({ status: 'ok' });
    expect(fake.calls).toHaveLength(0);
  });
  it('starts and serves health after an interrupted usage append', async () => {
    const record = { at: Date.now(), backend: 'demo-a', event: { role: 'main', backendModel: 'demo-model-a', status: 'ok', inputTokens: 3 } };
    await fs.writeFile(join(directory, 'usage.jsonl'), `${JSON.stringify(record)}\n{"at":`, { mode: 0o600 });
    await start();
    expect((await send('/healthz', undefined, { method: 'GET' })).statusCode).toBe(200);
    expect((await summary()).windows[0].rows[0]).toMatchObject({ requests: 1, inputTokens: 3 });
  });
  it('serves health on every listener with all roles unmapped without reading a body', async () => {
    const map = demoMap(); map.roles = { main: null, coder: null, fast: null };
    await start({ ports: { main: 8894, coder: 8895, fast: 8896 } }, map);
    for (const port of [8894, 8895, 8896]) {
      const consumer = begin('/healthz', undefined, { method: 'GET', port, upload: true });
      const response = await consumer.done;
      expect(response.statusCode).toBe(200); expect(response.headers.connection).toBe('close');
      expect(JSON.parse(response.body)).toEqual({ status: 'ok' }); expect(consumer.socket.reset).toBe(false);
    }
    expect(fake.calls).toHaveLength(0); expect(events).toHaveLength(0);
  });
  it.each([
    ['example-main', 'main', 'example-main', 'example-main-model'],
    ['example-coder', 'coder', 'example-coder', 'example-coder-model'],
    ['example-fast', 'fast', 'example-fast', 'example-fast-model'],
  ] as const)('authenticates the packaged %s mapping and uses its served model', async (id, role, provider, servedName) => {
    const credentials = join(directory, 'credentials'); await fs.mkdir(credentials, { mode: 0o700 });
    const key = join(credentials, provider); await fs.writeFile(key, 'obviously-fake-backend-key', { mode: 0o600 });
    const map = JSON.parse(await fs.readFile('gateway/role-map.default.json', 'utf8')) as RoleMap;
    for (const backend of Object.values(map.backends)) { backend.baseUrl = 'http://127.0.0.1:8899/v1'; backend.listenerUid = 0; }
    map.roles[role] = id; map.backends[id]!.provider = provider;
    fake.reply = stream => {
      const call = fake.calls.at(-1)!;
      const authenticated = (call.options.headers as Record<string, string>).authorization === 'Bearer obviously-fake-backend-key';
      const knownModel = JSON.parse(call.body.toString()).model === servedName;
      Object.assign(stream, { statusCode: !authenticated ? 401 : !knownModel ? 404 : 200 });
      stream.end(authenticated && knownModel ? '{}' : '{"error":{"message":"Invalid backend request"}}');
    };
    await start({ credentialsDirectory: credentials, ports: { [role]: 8898 } }, map);
    expect((await send(undefined, { model: role }, { headers: { authorization: 'Bearer obviously-fake-consumer-key' } })).statusCode).toBe(200);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.options.headers).toMatchObject({ authorization: 'Bearer obviously-fake-backend-key' });
    expect(JSON.parse(fake.calls[0]!.body.toString()).model).toBe(servedName);
    await fs.rm(key);
    const consumer = begin(undefined, { model: role }); await consumer.done;
    expect(consumer.socket.reset).toBe(true); expect(fake.calls).toHaveLength(1);
  });
  it('rewrites the model, caps output and reports current context across profile changes and restart', async () => {
    await start();
    const body = { model: 'main', messages: [{ role: 'tool', content: 'fake tool result' }], tools: [{ type: 'function', function: { name: 'demo' } }], stream_options: { include_usage: true } };
    const response = await send(undefined, body); expect(response.statusCode).toBe(200);
    expect(JSON.parse(fake.calls[0]!.body.toString())).toEqual({ ...body, model: 'demo-model-a', max_tokens: 4096 });
    expect(response.headers.connection).toBe('close');
    const models = async () => JSON.parse((await send('/v1/models', undefined, { method: 'GET' })).body).data[0];
    expect(await models()).toMatchObject({ context_length: 262144, max_model_len: 262144 });
    expect((await send('/v1/roles/main', { backend: 'demo-b' }, { admin: true, method: 'PUT' })).statusCode).toBe(200);
    expect(await models()).toMatchObject({ context_length: 65536, max_model_len: 65536 });
    await gateway.close(); fake.servers = []; await start();
    expect(await models()).toMatchObject({ context_length: 65536 });
    await send('/v1/roles/main', { backend: 'demo-a' }, { admin: true, method: 'PUT' });
    expect(await models()).toMatchObject({ context_length: 262144 });
  });
  it('atomically selects a complete profile row and reports newly unmapped roles', async () => {
    await start();
    const change = await send('/v1/profiles/example/profile', undefined, { admin: true, method: 'PUT' });
    expect(JSON.parse(change.body).roles).toEqual({ main: 'demo-b', coder: null, fast: null });
    expect(JSON.parse((await send('/v1/models', undefined, { method: 'GET' })).body).data[0].context_length).toBe(65536);
    expect((await send('/v1/profiles/missing/sglang', undefined, { admin: true, method: 'PUT' })).statusCode).toBe(400);
    const persisted = JSON.parse(await fs.readFile(configFile, 'utf8'));
    expect(persisted.roles).toEqual({ main: 'demo-b', coder: null, fast: null });
    const status = JSON.parse((await send('/v1/status', undefined, { admin: true, method: 'GET' })).body);
    expect(status.roles.coder.health).toBe('unmapped'); expect(status.roles.fast.health).toBe('unmapped');
  });
  it.each(['llamacpp', 'sglang', 'vllm', 'sglang-total'])('normalizes %s overflow using the mapped real limit', async engine => {
    await start(); await send('/v1/roles/main', { backend: 'demo-b' }, { admin: true, method: 'PUT' });
    const fixture = await fs.readFile(join(process.cwd(), `gateway/test/fixtures/${engine}-overflow.json`));
    fake.reply = stream => { Object.assign(stream, { statusCode: 400 }); stream.end(fixture); };
    const response = await send();
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: { code: 'context_length_exceeded', message: "This model's maximum context length is 65536 tokens", type: 'invalid_request_error', param: null } });
  });
  it.each(['example/vllm'])('reports the context of the packaged %s profile', async profile => {
    const map = JSON.parse(await fs.readFile('gateway/role-map.default.json', 'utf8')) as RoleMap;
    for (const backend of Object.values(map.backends)) { backend.baseUrl = 'http://127.0.0.1:8899/v1'; backend.listenerUid = 0; }
    await start({}, map);
    expect((await send(`/v1/profiles/${profile}`, undefined, { admin: true, method: 'PUT' })).statusCode).toBe(200);
    const models = JSON.parse((await send('/v1/models', undefined, { method: 'GET' })).body).data[0];
    expect(models).toMatchObject({ context_length: 32768, max_model_len: 32768 });
    const fixture = await fs.readFile('gateway/test/fixtures/sglang-overflow.json');
    fake.reply = stream => { Object.assign(stream, { statusCode: 400 }); stream.end(fixture); };
    const response = await send();
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: { code: 'context_length_exceeded',
      message: "This model's maximum context length is 32768 tokens", type: 'invalid_request_error', param: null } });
  });
  it.each([400, 401, 429, 502, 503, 504])('passes backend %s bytes and status unchanged', async status => {
    await start();
    const body = `backend error ${'x'.repeat(140000)}`;
    fake.reply = stream => { Object.assign(stream, { statusCode: status, headers: { 'content-type': 'text/plain', 'retry-after': '1', 'set-cookie': 'fake', connection: 'x-private', 'x-private': 'fake' } }); stream.end(body); };
    const response = await send(); expect(response.statusCode).toBe(status); expect(response.body).toBe(body);
    expect(response.headers.connection).toBe('close'); expect(response.headers['retry-after']).toBe('1');
    expect(response.headers['set-cookie']).toBeUndefined(); expect(response.headers['x-private']).toBeUndefined();
  });
  it('preserves validation errors containing echoed overflow phrases', async () => {
    await start();
    const fixtures = JSON.parse(await fs.readFile('gateway/test/fixtures/overflow-negative.json', 'utf8')) as unknown[];
    for (const fixture of fixtures) {
      const body = JSON.stringify(fixture);
      fake.reply = stream => { Object.assign(stream, { statusCode: 400 }); stream.end(body); };
      const response = await send(); expect(response.statusCode).toBe(400); expect(response.body).toBe(body);
    }
  });
  it('normalizes an overflow in the first SSE error event before sending response headers', async () => {
    await start();
    const fixture = await fs.readFile('gateway/test/fixtures/llamacpp-overflow.json', 'utf8');
    fake.reply = stream => {
      Object.assign(stream, { headers: { 'content-type': 'text/event-stream' } });
      stream.end(`data: ${fixture.trim()}\n\n`);
    };
    const response = await send(); expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.message).toBe("This model's maximum context length is 262144 tokens");
  });
  it('normalizes SGLang total-token overflow from an HTTP-200 SSE error before sending response headers', async () => {
    await start(); await send('/v1/roles/main', { backend: 'demo-b' }, { admin: true, method: 'PUT' });
    const fixture = await fs.readFile('gateway/test/fixtures/sglang-total-overflow.sse');
    fake.reply = stream => {
      Object.assign(stream, { headers: { 'content-type': 'text/event-stream' } });
      stream.end(fixture);
    };
    const response = await send();
    expect(response.statusCode).toBe(400); expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers.connection).toBe('close');
    expect(JSON.parse(response.body)).toEqual({ error: { code: 'context_length_exceeded',
      message: "This model's maximum context length is 65536 tokens", type: 'invalid_request_error', param: null } });
    await flush(); expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ status: 'error' });
  });
  it.each(['\n', '\r\n', '\r'])('reads the first SSE data event after split comment and empty-line preambles %#', async newline => {
    await start();
    const fixture = JSON.parse(await fs.readFile('gateway/test/fixtures/sglang-overflow.json', 'utf8'));
    const payload = [`data: {"error":`, `data: ${JSON.stringify(fixture.error)}}`, '', ''].join(newline);
    fake.reply = stream => {
      Object.assign(stream, { headers: { 'content-type': 'text/event-stream' } });
      stream.write(`${newline}: ping${newline}${newline}`);
      setImmediate(() => {
        stream.write(`: heartbeat${newline}${newline}event: error${newline}`);
        setImmediate(() => stream.end(payload));
      });
    };
    const response = await send();
    expect(response.statusCode).toBe(400); expect(response.headers['content-type']).toBe('application/json');
    expect(JSON.parse(response.body).error).toMatchObject({ code: 'context_length_exceeded',
      message: "This model's maximum context length is 262144 tokens" });
  });
  it('preserves SSE preambles and later overflows after a non-overflow first data event', async () => {
    await start();
    const fixture = (await fs.readFile('gateway/test/fixtures/sglang-overflow.json', 'utf8')).trim();
    const payload = `: ping\n\ndata: {"choices":[]}\n\ndata: ${fixture}\n\n`;
    fake.reply = stream => { Object.assign(stream, { headers: { 'content-type': 'text/event-stream' } }); stream.end(payload); };
    const response = await send(); expect(response.statusCode).toBe(200); expect(response.body).toBe(payload);
  });
  it('handles SSE field and CRLF delimiters split across response chunks', async () => {
    await start();
    const fixture = (await fs.readFile('gateway/test/fixtures/vllm-overflow.json', 'utf8')).trim();
    fake.reply = stream => {
      Object.assign(stream, { headers: { 'content-type': 'text/event-stream' } });
      stream.write(': ping\r');
      setImmediate(() => {
        stream.write('\n\r\n: heartbeat\r\n\r\nda');
        setImmediate(() => {
          stream.write(`ta: ${fixture}\r\n\r`);
          setImmediate(() => stream.end('\n'));
        });
      });
    };
    const response = await send(); expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('context_length_exceeded');
  });
  it('preserves an SSE response without a complete data event', async () => {
    await start();
    const fixture = (await fs.readFile('gateway/test/fixtures/vllm-overflow.json', 'utf8')).trim();
    for (const payload of [fixture, `data: ${fixture}`, ': ping\n\n']) {
      fake.reply = stream => { Object.assign(stream, { headers: { 'content-type': 'text/event-stream' } }); stream.end(payload); };
      const response = await send(); expect(response.statusCode).toBe(200); expect(response.body).toBe(payload);
    }
  });
  it.each(['/v1/chat/completions', '/v1/completions'])('normalizes only supported overflow wording on %s', async path => {
    await start();
    const fixture = await fs.readFile('gateway/test/fixtures/vllm-overflow.json', 'utf8');
    fake.reply = stream => { Object.assign(stream, { statusCode: 400 }); stream.end(fixture); };
    const response = await send(path); expect(JSON.parse(response.body).error.code).toBe('context_length_exceeded');
  });
  it.each(['/v1/responses', '/v1/embeddings'])('passes overflow answers through unchanged on %s', async path => {
    await start();
    const fixture = (await fs.readFile('gateway/test/fixtures/vllm-overflow.json', 'utf8')).trim();
    for (const streaming of [false, true]) {
      const payload = streaming ? `: ping\n\ndata: ${fixture}\n\n` : fixture;
      fake.reply = stream => {
        Object.assign(stream, { statusCode: streaming ? 200 : 400,
          headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' } });
        stream.end(payload);
      };
      const response = await send(path);
      expect(response.statusCode).toBe(streaming ? 200 : 400); expect(response.body).toBe(payload);
    }
  });
  it('resets unmapped inference after headers without reading a request body', async () => {
    const map = demoMap(); map.roles.main = null; await start({}, map);
    const consumer = begin(undefined, undefined, { upload: true }); await consumer.done;
    expect(consumer.socket.reset).toBe(true); expect(fake.calls).toHaveLength(0);
    expect(consumer.response.headersSent).toBe(false); await flush();
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ status: 'error' });
  });
  it('resets when a mapped backend owner is unexpected and sends no HTTP request', async () => {
    await start({ ownerLookup: async () => 424242 });
    const consumer = begin(); await consumer.done;
    expect(consumer.socket.reset).toBe(true); expect(fake.calls).toHaveLength(0);
    expect(events[0]).toMatchObject({ status: 'error' }); expect(events[0]?.inputTokens).toBeUndefined();
    const status = await send('/v1/status', undefined, { admin: true, method: 'GET' });
    expect(JSON.parse(status.body).roles.main).toMatchObject({ health: 'owner_mismatch', backendPort: 8899 });
  });
  it('resets connection failures while health stays a JSON 503', async () => {
    await start({ ownerLookup: async () => { throw new Error('Fake backend stopped.'); } });
    const consumer = begin(); await consumer.done; expect(consumer.socket.reset).toBe(true);
    const health = await send('/health', undefined, { method: 'GET' });
    expect(health.statusCode).toBe(503); expect(JSON.parse(health.body).status).toBe('down');
  });
  it('bounds owner verification by the backend header deadline', async () => {
    await start({ backendTimeoutMs: 10, ownerLookup: () => new Promise(() => {}) });
    const consumer = begin(); await consumer.done;
    expect(consumer.socket.reset).toBe(true); expect(fake.calls).toHaveLength(0);
  });
  it.each(['main', 'coder', 'fast'] as const)('reports context and rewrites the %s role', async role => {
    await start({ ports: { [role]: 8898 } });
    const models = await send('/v1/models', undefined, { method: 'GET' });
    expect(JSON.parse(models.body).data[0]).toMatchObject({ id: role, context_length: 262144 });
    expect((await send(undefined, { model: role })).statusCode).toBe(200);
    expect(JSON.parse(fake.calls[0]!.body.toString()).model).toBe('demo-model-a');
  });
  it.each(['coder', 'fast'] as const)('resets unmapped %s under the smaller-context profile', async role => {
    const map = demoMap(); map.roles = map.profiles['example/profile']!;
    await start({ ports: { [role]: 8898 } }, map);
    const consumer = begin(undefined, { model: role }); await consumer.done;
    expect(consumer.socket.reset).toBe(true); expect(fake.calls).toHaveLength(0);
  });
  it.each([
    { messages: [{ content: [{ type: 'image_url', image_url: { url: 'https://example.com/fake.png' } }] }] },
    { reasoning_effort: 'high' }, { max_tokens: 0 }, { max_completion_tokens: '4096' }, { max_output_tokens: -1 }, { model: 'coder' },
  ])('checks the request contract before forwarding %#', async override => {
    await start(); expect((await send(undefined, { model: 'main', ...override })).statusCode).toBe(400); expect(fake.calls).toHaveLength(0);
  });
  it.each([-1, -2, 0, null, '4096', 1.5])('rejects an invalid backend output alias even with a smaller OpenAI limit %#', async nPredict => {
    const map = demoMap(); map.contracts.main.maxOutputTokens = 8192;
    for (const backend of Object.values(map.backends)) backend.maxOutputTokens = 32768;
    await start({}, map);
    const response = await send(undefined, { model: 'main', max_tokens: 1, n_predict: nPredict });
    expect(response.statusCode).toBe(400); expect(response.body).toContain('8192 tokens'); expect(fake.calls).toHaveLength(0);
  });
  it.each([
    ['/v1/chat/completions', 'max_tokens'], ['/v1/completions', 'max_tokens'], ['/v1/responses', 'max_output_tokens'],
  ])('caps omitted output limits on %s independently of backend defaults', async (path, field) => {
    const map = demoMap(); map.backends['demo-a']!.maxOutputTokens = 32768;
    await start({}, map);
    expect((await send(path, { model: 'main' })).statusCode).toBe(200);
    expect(JSON.parse(fake.calls[0]!.body.toString())).toEqual({ model: 'demo-model-a', [field]: 4096 });
  });
  it.each([
    { n_predict: 4096 }, { max_completion_tokens: 4096 }, { max_output_tokens: 4096 },
    { max_tokens: 4, n_predict: 12 }, { max_tokens: 12, n_predict: 4 },
    { max_tokens: 12, max_completion_tokens: 8, max_output_tokens: 6, n_predict: 4 },
  ])('preserves supplied output fields and limits independently %#', async limits => {
    await start();
    for (const path of ['/v1/chat/completions', '/v1/completions', '/v1/responses']) {
      expect((await send(path, { model: 'main', ...limits })).statusCode).toBe(200);
      expect(JSON.parse(fake.calls.at(-1)!.body.toString())).toEqual({ model: 'demo-model-a', ...limits });
    }
  });
  it.each(['max_tokens', 'max_completion_tokens', 'max_output_tokens', 'n_predict'])('lowers only the supplied %s value above the contract cap', async field => {
    await start();
    const limits = { [field]: 8192, ...(field !== 'max_tokens' ? { max_tokens: 4 } : { max_completion_tokens: 4 }) };
    expect((await send(undefined, { model: 'main', ...limits })).statusCode).toBe(200);
    expect(JSON.parse(fake.calls.at(-1)!.body.toString())).toEqual({ model: 'demo-model-a', ...limits, [field]: 4096 });
  });
  it('preserves max_completion_tokens for a backend that rejects max_tokens', async () => {
    await start();
    fake.reply = stream => {
      const body = JSON.parse(fake.calls.at(-1)!.body.toString());
      Object.assign(stream, { statusCode: 'max_tokens' in body ? 400 : 200 }); stream.end('{}');
    };
    expect((await send(undefined, { model: 'main', max_completion_tokens: 12 })).statusCode).toBe(200);
    expect(JSON.parse(fake.calls.at(-1)!.body.toString())).toEqual({ model: 'demo-model-a', max_completion_tokens: 12 });
  });
  it.each([
    ['/v1/chat/completions', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/fake.png' } }] }] }],
    ['/v1/chat/completions', { messages: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/fake.png' }] }] }],
    ['/v1/responses', { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/fake.png' }] }] }],
    ['/v1/responses', { input: [{ type: 'message', role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/fake.png' } }] }] }],
  ])('rejects image parts in input message content on %s %#', async (path, input) => {
    await start(); expect((await send(path as string, { model: 'main', ...input as object })).statusCode).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });
  it.each(['/v1/chat/completions', '/v1/responses'])('preserves image-like metadata and schemas outside input content on %s', async path => {
    await start();
    const input = { model: 'main', metadata: { type: 'image' }, extra: { type: 'input_image' },
      tools: [{ type: 'function', function: { name: 'demo', parameters: { type: 'object', properties: { image: { type: 'image_url' } } } } }],
      messages: [{ role: 'user', metadata: { type: 'input_image' }, content: [{ type: 'text', text: 'Fake text', extra: { type: 'image_url' } }] }],
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Fake text' }], metadata: { type: 'image_url' } },
        { type: 'function_call', arguments: { type: 'input_image' }, content: [{ type: 'image_url' }] }] };
    expect((await send(path, input)).statusCode).toBe(200);
    expect(JSON.parse(fake.calls.at(-1)!.body.toString())).toMatchObject({ ...input, model: 'demo-model-a' });
  });
  it('allows image message content when the role contract accepts it', async () => {
    const map = demoMap(); map.contracts.main.input.push('image'); map.backends['demo-a']!.input.push('image');
    await start({}, map);
    const messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/fake.png' } }] }];
    expect((await send(undefined, { model: 'main', messages })).statusCode).toBe(200);
    expect(JSON.parse(fake.calls.at(-1)!.body.toString()).messages).toEqual(messages);
  });
  it('forwards embeddings without a generation limit', async () => {
    await start(); expect((await send('/v1/embeddings', { model: 'main', input: 'Fake input' })).statusCode).toBe(200);
    expect(JSON.parse(fake.calls[0]!.body.toString())).toEqual({ model: 'demo-model-a', input: 'Fake input' });
  });
  it('refuses tool calls on a role without that capability and unknown admin backends', async () => {
    const map = demoMap(); map.contracts.main.toolCalling = false; await start({}, map);
    expect((await send(undefined, { model: 'main', tools: [{ type: 'function' }] })).statusCode).toBe(400);
    expect((await send('/v1/roles/main', { backend: 'missing' }, { method: 'PUT', admin: true })).statusCode).toBe(400);
  });
  it('refuses an admin repoint outside the role contract without changing the stored map', async () => {
    const map = demoMap(); map.backends['demo-limited'] = { ...map.backends['demo-a']!, toolCalling: false, maxOutputTokens: 1 };
    await start({}, map);
    expect((await send('/v1/roles/main', { backend: 'demo-limited' }, { method: 'PUT', admin: true })).statusCode).toBe(400);
    expect(JSON.parse(await fs.readFile(configFile, 'utf8')).roles.main).toBe('demo-a');
  });
  it('rejects browser requests and arbitrary Host without forwarding consumer credentials', async () => {
    await start();
    expect((await send(undefined, undefined, { headers: { origin: 'https://example.com' } })).statusCode).toBe(403);
    expect((await send(undefined, undefined, { headers: { host: 'example.com:8898' } })).statusCode).toBe(403);
    await send(undefined, undefined, { headers: { authorization: 'Bearer fake-consumer', cookie: 'fake-cookie' } });
    expect(fake.calls[0]?.options.headers).not.toHaveProperty('authorization'); expect(fake.calls[0]?.options.headers).not.toHaveProperty('cookie');
  });
  it('uses only its named credential, rotates it, and keeps it out of logs and usage', async () => {
    const credentials = join(directory, 'credentials'); await fs.mkdir(credentials, { mode: 0o700 });
    const key = join(credentials, 'demo-provider'); await fs.writeFile(key, 'obviously-fake-provider-key', { mode: 0o600 });
    const map = demoMap(); map.backends['demo-a']!.provider = 'demo-provider';
    await start({ credentialsDirectory: credentials }, map);
    await send(undefined, undefined, { headers: { authorization: 'Bearer fake-consumer-key' } });
    expect(fake.calls[0]?.options.headers).toMatchObject({ authorization: 'Bearer obviously-fake-provider-key' });
    await fs.writeFile(key, 'obviously-fake-rotated-key'); await send();
    expect(fake.calls[1]?.options.headers).toMatchObject({ authorization: 'Bearer obviously-fake-rotated-key' });
    expect(JSON.stringify(logs) + JSON.stringify(events)).not.toMatch(/fake-provider-key|fake-rotated-key|fake-consumer-key|credentials/);
    await fs.rm(key); const consumer = begin(); await consumer.done;
    expect(consumer.socket.reset).toBe(true); expect(fake.calls).toHaveLength(2);
    expect((await send('/healthz', undefined, { method: 'GET' })).statusCode).toBe(200);
  });
  it('counts an uploading untagged consumer, serves it through drain, then closes the accepting handles', async () => {
    const restarted = vi.fn(); await start({ onDrained: restarted });
    const upload = begin(undefined, undefined, { upload: true });
    const status = await send('/v1/status', undefined, { admin: true, method: 'GET' });
    expect(JSON.parse(status.body).roles.main).toMatchObject({ openConnections: 1, inFlight: 1, backend: 'demo-a', health: 'up' });
    const draining = begin('/v1/drain', undefined, { admin: true }); await flush();
    expect(restarted).not.toHaveBeenCalled(); expect(server().listening).toBe(true);
    expect((await send()).statusCode).toBe(200); expect(restarted).not.toHaveBeenCalled();
    upload.finish(); expect((await upload.done).statusCode).toBe(200);
    expect(JSON.parse((await draining.done).body).status).toBe('drained'); await flush();
    expect(server().listening).toBe(false); expect(restarted).toHaveBeenCalledOnce();
  });
  it('calls off a busy drain without dropping an upload and refuses overlapping drains', async () => {
    await start({ drainTimeoutMs: 20 }); const upload = begin(undefined, undefined, { upload: true });
    const first = begin('/v1/drain', undefined, { admin: true }); await flush();
    expect((await send('/v1/drain', undefined, { admin: true })).statusCode).toBe(409);
    expect(JSON.parse((await first.done).body).status).toBe('still_busy'); expect(server().listening).toBe(true);
    upload.finish(); expect((await upload.done).statusCode).toBe(200);
  });
  it('streams unchanged with one private usage event and persistent summary', async () => {
    await start(); const payload = 'data: {"choices":[{"delta":{"content":"Fake private stream."}}]}\n\n'
      + 'data: {"usage":{"prompt_tokens":20,"prompt_tokens_details":{"cached_tokens":5},"completion_tokens":3}}\n\ndata: [DONE]\n\n';
    fake.reply = stream => { Object.assign(stream, { headers: { 'content-type': 'text/event-stream' } }); stream.end(payload); };
    expect((await send(undefined, { model: 'main', stream: true })).body).toBe(payload); await flush();
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ role: 'main', backendModel: 'demo-model-a', inputTokens: 15, cacheReadTokens: 5, outputTokens: 3, estimatedCostUsd: 0, status: 'ok' });
    expect(JSON.stringify(events) + JSON.stringify(logs)).not.toMatch(/Fake private|choices|delta|messages/);
    const result = await summary(); expect(result.windows[0].rows[0]).toMatchObject({ requests: 1, errors: 0, inputTokens: 15 });
    const stored = await fs.readFile(join(directory, 'usage.jsonl'), 'utf8'); expect(stored).not.toMatch(/Fake private|choices|delta|messages/);
    expect((await fs.stat(join(directory, 'usage.jsonl'))).mode & 0o777).toBe(0o600);
  });
  it('publishes private usage invalidations and lets a hook refresh await the current record', async () => {
    const bus = new EventEmitter(); const stop = vi.fn(); let observed: ReturnType<typeof summary> | undefined;
    await start({ onUsage: () => { bus.emit('changed'); observed = summary(); },
      usageEvents: publish => { bus.on('changed', publish); return () => { bus.off('changed', publish); stop(); }; } });
    const stream = begin('/v1/usage/events', undefined, { admin: true, method: 'GET' });
    await flush(); expect(stream.response.headers['content-type']).toBe('application/x-ndjson');
    await send();
    expect(stream.response.body).toBe('{"type":"usage_changed"}\n');
    expect((await observed).windows[0].rows[0].requests).toBe(1);
    stream.response.destroy(); await stream.done; expect(stop).toHaveBeenCalledOnce();
  });
  it.each([
    'data: {"error":{"type":"server_error","message":"Backend stopped"}}\n\n',
    'event: error\ndata: {"message":"Backend stopped"}\n\n',
    'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error"}}}\n\n',
  ])('records a terminal SSE error once and discards earlier success usage %#', async failure => {
    await start();
    const prefix = 'data: {"usage":{"prompt_tokens":20,"completion_tokens":3}}\n\n';
    const payload = prefix + failure + 'data: [DONE]\n\n';
    fake.reply = stream => {
      Object.assign(stream, { headers: { 'content-type': 'text/event-stream' } });
      stream.write(prefix); setImmediate(() => stream.end(failure + 'data: [DONE]\n\n'));
    };
    const response = await send(); expect(response.statusCode).toBe(200); expect(response.body).toBe(payload); await flush();
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ status: 'error' });
    for (const field of ['inputTokens', 'cacheReadTokens', 'outputTokens', 'estimatedCostUsd', 'reportedCostUsd']) expect(events[0]).not.toHaveProperty(field);
    expect((await summary()).windows[0].rows[0]).toMatchObject({ requests: 1, errors: 1, inputTokens: 0, outputTokens: 0 });
  });
  it.each([
    { status: 'failed', error: { code: 'server_error', message: 'Fake backend failure.' } },
    { status: 'failed', error: null }, { error: { code: 'server_error' } },
  ])('records failed non-streaming Responses once without counts or costs %#', async failure => {
    const map = demoMap(); map.backends['demo-a']!.price = { inputPerMillionUsd: 2, outputPerMillionUsd: 4 };
    await start({}, map);
    const payload = JSON.stringify({ usage: { input_tokens: 20, output_tokens: 3, cost: 0.1 }, output: [{ content: 'Fake response text '.repeat(10000) }], ...failure });
    fake.reply = stream => { stream.write(payload.slice(0, 79)); setImmediate(() => stream.end(payload.slice(79))); };
    const response = await send('/v1/responses', { model: 'main', input: 'Fake input' }); await flush();
    expect(response.statusCode).toBe(200); expect(response.body).toBe(payload); expect(response.headers.connection).toBe('close');
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ status: 'error' });
    for (const field of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'estimatedCostUsd', 'reportedCostUsd']) expect(events[0]).not.toHaveProperty(field);
    expect((await summary()).windows[0].rows[0]).toMatchObject({ requests: 1, errors: 1, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
    const stored = await fs.readFile(join(directory, 'usage.jsonl'), 'utf8');
    expect(stored.trim().split('\n')).toHaveLength(1); expect(stored).not.toMatch(/Fake response|Fake backend failure|server_error/);
  });
  it('captures streaming Responses usage and cached input in priced summaries', async () => {
    const map = demoMap(); map.backends['demo-a']!.price = { inputPerMillionUsd: 2, cacheReadPerMillionUsd: 0.5, outputPerMillionUsd: 4 };
    await start({}, map);
    const payload = 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":80},"output_tokens":5}}}\n\n';
    fake.reply = stream => { Object.assign(stream, { headers: { 'content-type': 'text/event-stream' } }); stream.end(payload); };
    expect((await send('/v1/responses', { model: 'main', input: 'Fake input', stream: true })).body).toBe(payload); await flush();
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ status: 'ok', inputTokens: 20, cacheReadTokens: 80, outputTokens: 5, estimatedCostUsd: 0.0001 });
    expect((await summary()).windows[0].rows[0]).toMatchObject({ requests: 1, errors: 0, inputTokens: 20, cacheReadTokens: 80, estimatedCostUsd: 0.0001 });
  });
  it('retains a stream mapping while a later request uses the new backend', async () => {
    await start(); let stream: PassThrough | undefined;
    fake.reply = upstream => { stream = upstream; Object.assign(upstream, { headers: { 'content-type': 'text/event-stream' } }); upstream.write('data: {"choices":[]}\n\n'); };
    const first = begin(); await flush();
    await send('/v1/roles/main', { backend: 'demo-b' }, { method: 'PUT', admin: true });
    fake.reply = upstream => upstream.end('{}'); await send();
    expect(fake.calls.map(call => JSON.parse(call.body.toString()).model)).toEqual(['demo-model-a', 'demo-model-b']);
    stream!.end('data: [DONE]\n\n'); expect((await first.done).body).toContain('[DONE]');
  });
  it('cancels the upstream stream when its consumer disconnects and emits one error event', async () => {
    await start();
    fake.reply = upstream => { Object.assign(upstream, { headers: { 'content-type': 'text/event-stream' } }); upstream.write('data: {"choices":[]}\n\n'); };
    const consumer = begin(); await flush(); consumer.socket.destroy(); await consumer.done; await flush();
    expect(fake.upstream?.destroyed).toBe(true); expect(events).toHaveLength(1); expect(events[0]?.status).toBe('error');
  });
  it('records an interrupted stream before closing its state handles on shutdown', async () => {
    await start();
    fake.reply = upstream => { Object.assign(upstream, { headers: { 'content-type': 'text/event-stream' } }); upstream.write('data: {"choices":[]}\n\n'); };
    const consumer = begin(); await flush(); await gateway.close(); await consumer.done;
    const records = (await fs.readFile(join(directory, 'usage.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(records).toHaveLength(1); expect(records[0].event.status).toBe('error');
  });
  it('keeps non-context validation errors unchanged and enforces body limits', async () => {
    await start({ maxRequestBytes: 32 });
    expect((await send(undefined, { model: 'main', prompt: 'x'.repeat(100) })).statusCode).toBe(413);
    expect((await send(undefined, {}, { headers: { 'content-encoding': 'gzip' } })).statusCode).toBe(415);
    expect((await send(undefined, {}, { headers: { 'content-type': 'text/plain' } })).statusCode).toBe(415);
    const upload = begin(undefined, undefined, { upload: true }); upload.request.end('not-json');
    expect((await upload.done).statusCode).toBe(400);
    fake.reply = stream => { Object.assign(stream, { statusCode: 400 }); stream.end('input image length exceeds the maximum size'); };
    expect((await send(undefined, { model: 'main' })).body).toBe('input image length exceeds the maximum size');
    expect(fake.calls).toHaveLength(1);
  });
});
