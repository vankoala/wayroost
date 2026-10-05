import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { connect as connectSocket } from 'node:net';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { ConfigError, ConfigStore, readCredential, ROLE_PORTS, ROLES, type Backend,
  type Role } from './config.js';
import { TrustedDirectory } from './directory.js';
import { gatewayCredentialTestBodySchema, gatewayRepointBodySchema, isLoopbackUrl, type RoleContract } from '../../shared/gateway.js';
import { usageEvent, type UsageEvent, type UsageEventInput } from '../../shared/usage.js';
import { usageSummaryRequestSchema } from '../../shared/supervisor-config.js';
import { inheritedListeners } from './activation.js';
import { ownedConnection, lookupOwner, BackendOwnerError, type OwnerLookup } from './owner.js';
import { ConsumerDrain } from './drain.js';
import { UsageStore, UsageTap } from './usage.js';
import { firstSseData, isContextOverflow } from './overflow.js';

export interface LogEntry {
  event: 'request' | 'reload' | 'repoint';
  role?: Role;
  route?: 'models' | 'health' | 'inference' | 'admin' | 'unknown';
  status?: number;
  durationMs?: number;
  ok?: boolean;
}

export interface GatewayOptions {
  configFile: string;
  adminSocket: string;
  /** Absolute directory holding the provider keys. Backends may only name credential files inside it. */
  credentialsDirectory?: string;
  /** Only supplied roles listen. Omit to use all three stable role addresses. */
  ports?: Partial<Record<Role, number>>;
  host?: '127.0.0.1';
  maxRequestBytes?: number;
  /** Deadline for the backend's response headers; a non-streaming completion sends them only when it is done. */
  backendTimeoutMs?: number;
  /** Longest silence allowed once the response has started, such as a long prefill inside a stream. */
  idleTimeoutMs?: number;
  healthTimeoutMs?: number;
  log?: (entry: LogEntry) => void;
  ownerLookup?: OwnerLookup;
  listeners?: Partial<Record<Role, number>>;
  onUsage?: (event: UsageEvent) => void;
  usageEvents?: (publish: () => void) => () => void;
  onDrained?: () => void;
  drainTimeoutMs?: number;
}

const INFERENCE_ROUTES = new Set(['/v1/chat/completions', '/v1/completions', '/v1/embeddings', '/v1/responses']);
const OVERFLOW_ROUTES = new Set(['/v1/chat/completions', '/v1/completions']);
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'authorization', 'set-cookie']);
const AdminBody = gatewayRepointBodySchema;
const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]'];

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function checkRequestContract(input: Record<string, unknown>, contract: RoleContract, path: string): void {
  const messages = path === '/v1/chat/completions' ? input.messages : path === '/v1/responses' ? input.input : undefined;
  const image = Array.isArray(messages) && messages.some(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    const fields = message as Record<string, unknown>;
    if (path === '/v1/responses' && fields.type !== undefined && fields.type !== 'message') return false;
    const content = fields.content;
    return Array.isArray(content) && content.some(part => part && typeof part === 'object'
      && ['image_url', 'input_image'].includes((part as Record<string, unknown>).type as string));
  });
  if (!contract.input.includes('image') && image) throw new RequestError(400, 'This role accepts text input only.');
  if (!contract.toolCalling && (Array.isArray(input.tools) && input.tools.length > 0 || Array.isArray(input.functions) && input.functions.length > 0)) {
    throw new RequestError(400, 'This role does not support tool calling.');
  }
  const reasoning = input.reasoning as { effort?: unknown } | undefined;
  if (!contract.thinkingLevels && (['reasoning_effort', 'thinking_level', 'thinkingLevel'].some(key => input[key] !== undefined) || reasoning?.effort !== undefined)) {
    throw new RequestError(400, 'This role does not accept a thinking level.');
  }
  const outputFields = ['max_tokens', 'max_completion_tokens', 'max_output_tokens', 'n_predict'];
  let hasOutputLimit = false;
  for (const key of outputFields) {
    if (input[key] === undefined) continue;
    if (!Number.isSafeInteger(input[key]) || Number(input[key]) < 1) {
      throw new RequestError(400, `The output limit for this role is ${contract.maxOutputTokens} tokens.`);
    }
    hasOutputLimit = true;
    input[key] = Math.min(Number(input[key]), contract.maxOutputTokens);
  }
  if (path !== '/v1/embeddings' && !hasOutputLimit) {
    input[path === '/v1/responses' ? 'max_output_tokens' : 'max_tokens'] = contract.maxOutputTokens;
  }
}

function plain(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'connection': 'close' });
  response.end(`${message}\n`);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  response.end(JSON.stringify(value));
}

/** DNS rebinding makes a web page same-origin with a loopback port, so accept only loopback Host names and no browser origin. */
function loopbackClient(request: IncomingMessage, port: number): boolean {
  const host = request.headers.host?.toLowerCase();
  return host !== undefined && LOOPBACK_NAMES.some(name => host === `${name}:${port}`)
    && request.headers.origin === undefined && request.headers['sec-fetch-site'] === undefined;
}

function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  if (Number(request.headers['content-length']) > limit) {
    request.pause();
    return Promise.reject(new RequestError(413, 'Request is too large.'));
  }
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
    return Promise.reject(new RequestError(415, 'Use an uncompressed JSON request.'));
  }
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    return Promise.reject(new RequestError(415, 'Use application/json.'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off('data', data); request.off('end', end); request.off('error', error); request.off('aborted', aborted);
    };
    const error = () => { cleanup(); reject(new RequestError(400, 'Could not read the request.')); };
    const aborted = () => error();
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        cleanup(); request.pause(); reject(new RequestError(413, 'Request is too large.'));
      } else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new RequestError(400, 'Request must be valid JSON.')); }
    };
    request.on('data', data); request.once('end', end); request.once('error', error); request.once('aborted', aborted);
  });
}

async function authorization(backend: Backend, credentialsDirectory: TrustedDirectory | undefined): Promise<Record<string, string>> {
  if (!backend.provider) return {};
  if (!credentialsDirectory) throw new Error('Credential unavailable.');
  const key = await readCredential(`${credentialsDirectory.path}/${backend.provider}`, credentialsDirectory);
  if (!/^[\x21-\x7e]+$/.test(key)) throw new Error('Credential unavailable.');
  return { authorization: `Bearer ${key}` };
}

async function connect(backend: Backend, path: string, method: string, headers: Record<string, string>,
  body: Buffer | undefined, timeout: { headers: number; idle: number }, signal: AbortSignal, owner: OwnerLookup): Promise<IncomingMessage> {
  const url = new URL(`${backend.baseUrl}${path}`);
  const deadline = new AbortController();
  const combined = AbortSignal.any([signal, deadline.signal]);
  const headersTimer = setTimeout(() => deadline.abort(), timeout.headers);
  headersTimer.unref();
  try {
    const socket = isLoopbackUrl(backend.baseUrl) ? await ownedConnection(url, backend.listenerUid!, owner, combined) : undefined;
    return await new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers, signal: combined,
        ...(socket ? { createConnection: () => url.protocol === 'https:' ? tlsConnect({ socket, servername: url.hostname }) : socket } : { agent: false }),
      }, response => {
        clearTimeout(headersTimer);
        request.setTimeout(timeout.idle, () => request.destroy(new Error('Backend went silent.')));
        resolve(response);
      });
      request.on('error', error => { socket?.destroy(); reject(error); });
      request.once('close', () => socket?.destroy());
      request.end(body);
    });
  } finally { clearTimeout(headersTimer); }
}

function listen(server: Server, address: number | string | { fd: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const ready = () => { server.off('error', reject); resolve(); };
    if (typeof address === 'number') server.listen(address, '127.0.0.1', ready);
    else server.listen(address, ready);
  });
}

/**
 * A crash or kill leaves the admin socket behind. Remove it only when it is our own socket and nothing answers on it;
 * refuse anything else, since it may belong to another process.
 */
async function clearStaleSocket(path: string): Promise<void> {
  const existing = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!existing) return;
  if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error('Admin socket path already exists.');
  const live = await new Promise<boolean>(resolve => {
    const probe = connectSocket({ path });
    const done = (value: boolean) => { probe.destroy(); resolve(value); };
    probe.once('connect', () => done(true));
    probe.once('error', error => done((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED'));
    probe.setTimeout(1000, () => done(true));
  });
  if (live) throw new Error('Admin socket path already exists and is in use.');
  const current = await lstat(path);
  if (current.dev !== existing.dev || current.ino !== existing.ino) throw new Error('Admin socket path already exists.');
  await unlink(path);
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

export async function startGateway(options: GatewayOptions): Promise<{ close(): Promise<void> }> {
  if (options.host !== undefined && options.host !== '127.0.0.1') throw new Error('Gateway must bind to 127.0.0.1.');
  if (!isAbsolute(options.adminSocket) || !basename(options.adminSocket)
    || options.adminSocket !== resolve(options.adminSocket) || options.adminSocket.includes('\0')) {
    throw new Error('Admin socket must use a canonical absolute path.');
  }
  const listeners = options.listeners ?? inheritedListeners(process.env, process.pid);
  if (listeners && options.ports) throw new Error('Socket activation cannot be combined with explicit ports.');
  if (listeners && (ROLES.some(role => !Number.isInteger(listeners[role]) || listeners[role]! < 3)
    || new Set(Object.values(listeners)).size !== 3)) throw new Error('Invalid inherited listeners.');
  const ports = options.ports ?? ROLE_PORTS;
  const entries = Object.entries(ports);
  if (entries.length === 0 || entries.some(([role, port]) => !ROLES.includes(role as Role)
    || !Number.isInteger(port) || port < 1 || port > 65535)
    || new Set(Object.values(ports)).size !== entries.length) throw new Error('Invalid listener ports.');
  const limit = options.maxRequestBytes ?? 64 * 1024 * 1024;
  const timeout = { headers: options.backendTimeoutMs ?? 15 * 60_000, idle: options.idleTimeoutMs ?? 10 * 60_000 };
  const healthTimeout = options.healthTimeoutMs ?? 3000;
  const drainTimeout = options.drainTimeoutMs ?? 600_000;
  if (![limit, timeout.headers, timeout.idle, healthTimeout, drainTimeout].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Limits and timeouts must be positive integers.');
  }
  let credentials: TrustedDirectory | undefined;
  if (options.credentialsDirectory !== undefined) {
    try { credentials = await TrustedDirectory.open(options.credentialsDirectory); }
    catch { throw new Error('Credentials directory and its ancestors must be absolute directories only the gateway user or root can change.'); }
  }
  const log = (entry: LogEntry) => { try { options.log?.(entry); } catch { /* Logging must not interrupt requests. */ } };
  let store: ConfigStore;
  try { store = await ConfigStore.load(options.configFile, ok => log({ event: 'reload', ok }), options.credentialsDirectory); }
  catch (error) { await credentials?.close(); throw error; }
  let adminDirectory: TrustedDirectory;
  try { adminDirectory = await TrustedDirectory.open(dirname(options.adminSocket), 0o077); }
  catch {
    await store.close(); await credentials?.close();
    throw new Error('Admin socket directory must be private (mode 0700), owned by the gateway user or root, with trusted ancestors.');
  }
  const adminSocket = adminDirectory.entry(basename(options.adminSocket));
  const servers: Server[] = [];
  const active = new Set<AbortController>();
  const requests = new Set<Promise<void>>();
  const roleServers: Server[] = [];
  const drain = new ConsumerDrain(() => { for (const server of roleServers) server.close(); });
  const inFlight: Record<Role, number> = { main: 0, coder: 0, fast: 0 };
  const owner = options.ownerLookup ?? lookupOwner;
  const usage = await UsageStore.open(store.directory).catch(async error => {
    await store.close(); await credentials?.close(); await adminDirectory.close(); throw error;
  });
  const emitUsage = async (role: Role, backendId: string | null, backend: Backend | undefined, started: number, status: 'ok' | 'error', counts: Partial<UsageEventInput>) => {
    const event = usageEvent({ role, backendModel: backend?.servedName ?? '', ...counts, latencyMs: Date.now() - started, status },
      backend?.price ?? { inputPerMillionUsd: 0, cacheReadPerMillionUsd: 0, cacheWritePerMillionUsd: 0, outputPerMillionUsd: 0 });
    const recorded = usage.record(backendId, event);
    try { options.onUsage?.(event); } catch {}
    await recorded.catch(() => log({ event: 'request', role, route: 'inference', ok: false }));
  };
  let ownsSocket = false;
  let socketIdentity: { dev: number; ino: number } | undefined;

  const handleRole = async (role: Role, port: number, request: IncomingMessage, response: ServerResponse) => {
    const started = Date.now();
    let route: LogEntry['route'] = 'unknown';
    response.once('close', () => log({ event: 'request', role, route, status: response.statusCode,
      durationMs: Date.now() - started }));
    const controller = new AbortController();
    active.add(controller);
    const cancel = () => controller.abort();
    response.once('close', cancel);
    request.once('aborted', cancel);
    // A request keeps its backend snapshot even when the next request sees a switch.
    const snapshot = store.snapshot();
    const backendId = snapshot.roles[role];
    const backend = backendId === null ? undefined : snapshot.backends[backendId];
    let counts: Partial<UsageEventInput> = {};
    let success = false;
    inFlight[role]++;
    let finished = false;
    const finish = () => { if (!finished) { finished = true; inFlight[role]--; } };
    response.once('close', finish);
    try {
      const path = request.url?.split('?')[0];
      response.setHeader('connection', 'close');
      if (path && INFERENCE_ROUTES.has(path) && request.method === 'POST') route = 'inference';
      if (!loopbackClient(request, port)) plain(response, 403, 'Use a loopback address from a local program, not a web page.');
      else if (path === '/healthz' && request.method === 'GET') json(response, 200, { status: 'ok' });
      else if (!backend) request.socket.resetAndDestroy();
      else if (path === '/v1/models' && request.method === 'GET') {
        route = 'models';
        json(response, 200, { object: 'list', data: [{ id: role, object: 'model', created: 0, owned_by: 'wayroost', context_length: backend.contextLength, max_model_len: backend.contextLength }] });
      } else if (path === '/health' && request.method === 'GET') {
        route = 'health';
        const probe = await connect(backend, '/models', 'GET', await authorization(backend, credentials), undefined,
          { headers: healthTimeout, idle: healthTimeout }, controller.signal, owner);
        const ok = probe.statusCode === 200;
        probe.destroy();
        json(response, ok ? 200 : 503, { role, status: ok ? 'up' : 'down' });
      } else if (path && INFERENCE_ROUTES.has(path) && request.method === 'POST') {
        route = 'inference';
        const input = await readBody(request, limit);
        if (!input || typeof input !== 'object' || Array.isArray(input) || !('model' in input) || input.model !== role) {
          throw new RequestError(400, `Use the ${role} model alias at this address.`);
        }
        checkRequestContract(input as Record<string, unknown>, snapshot.contracts[role], path);
        const body = Buffer.from(JSON.stringify({ ...input, model: backend.servedName }));
        const headers = { 'content-type': 'application/json', 'content-length': String(body.length),
          accept: request.headers.accept ?? '*/*', ...await authorization(backend, credentials) };
        const suffix = request.url!.slice('/v1'.length);
        const upstream = await connect(backend, suffix, 'POST', headers, body, timeout, controller.signal, owner);
        let errorBody: Buffer | undefined;
        const errorStatus = (upstream.statusCode ?? 200) >= 400;
        const sse = String(upstream.headers['content-type']).includes('text/event-stream');
        if (OVERFLOW_ROUTES.has(path) && (errorStatus || sse)) {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of upstream.iterator({ destroyOnReturn: false })) {
            chunks.push(Buffer.from(chunk)); size += chunk.length;
            if (size >= 64 * 1024 || sse && firstSseData(Buffer.concat(chunks).toString('utf8')) !== undefined) break;
          }
          errorBody = Buffer.concat(chunks);
          const prefix = errorBody.toString('utf8');
          if (isContextOverflow(prefix, sse)) {
            upstream.destroy();
            json(response, 400, { error: { message: `This model's maximum context length is ${backend.contextLength} tokens`,
              type: 'invalid_request_error', param: null, code: 'context_length_exceeded' } });
            return;
          }
        }
        const excluded = new Set(HOP_HEADERS);
        for (const header of (upstream.headers.connection ?? '').split(',')) excluded.add(header.trim().toLowerCase());
        const responseHeaders = Object.fromEntries(Object.entries(upstream.headers)
          .filter(([name, value]) => value !== undefined && !excluded.has(name))) as Record<string, string | string[]>;
        response.writeHead(upstream.statusCode ?? 502, { ...responseHeaders, connection: 'close' });
        response.flushHeaders();
        const tap = new UsageTap(sse);
        const source = errorBody ? Readable.from((async function* () { yield errorBody; yield* upstream; })()) : upstream;
        await pipeline(source, tap, response);
        success = (upstream.statusCode ?? 502) < 400 && !tap.failed;
        if (success) counts = tap.usage;
      } else plain(response, 404, 'Route not found.');
    } catch (error) {
      if (route === 'health' && !response.headersSent && !response.destroyed) json(response, 503, { role, status: 'down' });
      else if (error instanceof RequestError) plain(response, error.status, error.message);
      else request.socket.resetAndDestroy();
    } finally {
      controller.abort(); active.delete(controller);
      if (route === 'inference') await emitUsage(role, backendId, backend, started, success ? 'ok' : 'error', counts);
      response.off('close', cancel); request.off('aborted', cancel);
    }
  };

  const admin = createServer((request, response) => {
    void (async () => {
      let role: Role | undefined;
      response.once('close', () => log({ event: 'request', route: 'admin', status: response.statusCode }));
      try {
        if (request.method === 'GET' && request.url === '/healthz') { json(response, 200, { status: 'ok' }); return; }
        if (request.method === 'GET' && request.url === '/v1/status') {
          const snapshot = store.snapshot();
          const roles = Object.fromEntries(await Promise.all(ROLES.map(async role => {
            const id = snapshot.roles[role]; const backend = id === null ? undefined : snapshot.backends[id];
            let health = backend ? 'down' : 'unmapped';
            if (backend) {
              try {
                const probe = await connect(backend, '/models', 'GET', await authorization(backend, credentials), undefined,
                  { headers: healthTimeout, idle: healthTimeout }, AbortSignal.timeout(healthTimeout), owner);
                health = probe.statusCode === 200 ? 'up' : 'down'; probe.destroy();
              } catch (error) { if (error instanceof BackendOwnerError) health = 'owner_mismatch'; }
            }
            return [role, { backend: id, backendModel: backend?.servedName ?? null, contextLength: backend?.contextLength ?? null,
              contract: snapshot.contracts[role], health, backendPort: backend && isLoopbackUrl(backend.baseUrl) ? Number(new URL(backend.baseUrl).port || 80) : null,
              inFlight: inFlight[role], openConnections: drain.count(role) }];
          })));
          json(response, 200, { roles, draining: drain.draining }); return;
        }
        if (request.method === 'GET' && request.url === '/v1/usage/events' && options.usageEvents) {
          response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
          response.flushHeaders();
          const stop = options.usageEvents(() => {
            if (response.writableLength > 4096) response.destroy();
            else response.write('{"type":"usage_changed"}\n');
          });
          const heartbeat = setInterval(() => {
            if (response.writableLength > 4096) response.destroy(); else response.write('\n');
          }, 15000); heartbeat.unref();
          response.once('close', () => { clearInterval(heartbeat); stop(); });
          return;
        }
        const credentialTest = /^\/v1\/credentials\/([a-z0-9][a-z0-9-]{0,31})\/test$/.exec(request.url ?? '');
        if (request.method === 'POST' && credentialTest) {
          const provider = credentialTest[1]!;
          try {
            const parsed = gatewayCredentialTestBodySchema.safeParse(await readBody(request, 16 * 1024));
            if (!parsed.success) { json(response, 200, { ok: false, code: 'test_failed' }); return; }
            const { backend: id, secret } = parsed.data;
            const snapshot = store.snapshot();
            const backend = Object.hasOwn(snapshot.backends, id) ? snapshot.backends[id] : undefined;
            if (!backend || backend.provider !== provider) { json(response, 200, { ok: false, code: 'test_failed' }); return; }
            const body = Buffer.from(JSON.stringify({ model: backend.servedName, messages: [{ role: 'user', content: 'Reply OK.' }],
              max_tokens: 1, stream: false }));
            const probe = await connect(backend, '/chat/completions', 'POST', { 'content-type': 'application/json',
              'content-length': String(body.length), authorization: `Bearer ${secret}` }, body,
              { headers: 5000, idle: 5000 }, AbortSignal.timeout(5000), owner);
            const status = probe.statusCode;
            probe.destroy();
            json(response, 200, status && status >= 200 && status < 300 ? { ok: true, provider, backend: id }
              : { ok: false, code: status === 401 || status === 403 ? 'credential_rejected'
                : status && status >= 500 ? 'backend_unavailable' : 'test_failed' });
          } catch { json(response, 200, { ok: false, code: 'backend_unavailable' }); }
          return;
        }
        if (request.method === 'POST' && request.url === '/v1/usage/summary') {
          const body = usageSummaryRequestSchema.safeParse(await readBody(request, 16 * 1024));
          if (!body.success) throw new RequestError(400, 'Supply summary windows.');
          json(response, 200, await usage.summary(body.data)); return;
        }
        if (request.method === 'POST' && request.url === '/v1/drain') {
          if (drain.draining || drain.stopped) throw new RequestError(409, 'A drain is already active.');
          const ready = await drain.wait(drainTimeout);
          json(response, 200, { status: ready ? 'drained' : 'still_busy' });
          if (ready) setImmediate(() => options.onDrained?.());
          return;
        }
        const profile = /^\/v1\/profiles\/([a-z0-9-]+\/[a-z0-9-]+)$/.exec(request.url ?? '');
        if (request.method === 'PUT' && profile) {
          await store.selectProfile(profile[1]!);
          log({ event: 'repoint', ok: true });
          json(response, 200, { roles: store.snapshot().roles, applied: true }); return;
        }
        const match = /^\/v1\/roles\/(main|coder|fast)$/.exec(request.url ?? '');
        if (request.method !== 'PUT' || !match) { plain(response, 404, 'Route not found.'); return; }
        role = match[1] as Role;
        const result = AdminBody.safeParse(await readBody(request, Math.min(limit, 16 * 1024)));
        if (!result.success) throw new RequestError(400, 'Supply a backend object.');
        await store.repoint(role, result.data.backend);
        log({ event: 'repoint', role, ok: true });
        json(response, 200, { role, backend: result.data.backend, applied: true });
      } catch (error) {
        log({ event: 'repoint', role, ok: false });
        plain(response, error instanceof RequestError ? error.status : error instanceof ConfigError ? 400 : 503,
        error instanceof RequestError ? error.message : 'Could not apply the backend. Check the config and file permissions.');
      }
    })();
  });
  servers.push(admin);

  const performStop = async () => {
    drain.cancel();
    for (const controller of active) controller.abort();
    await Promise.all(servers.map(close));
    await Promise.allSettled([...requests]);
    if (ownsSocket && socketIdentity) {
      const current = await lstat(adminSocket).catch(() => undefined);
      if (current?.isSocket() && current.dev === socketIdentity.dev && current.ino === socketIdentity.ino) {
        await unlink(adminSocket).catch(() => {});
      }
    }
    await usage.close();
    await store.close();
    await credentials?.close();
    await adminDirectory.close();
  };
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= performStop();
  try {
    await adminDirectory.assertValid();
    await clearStaleSocket(adminSocket);
    await listen(admin, adminSocket);
    ownsSocket = true;
    const identity = await lstat(adminSocket);
    socketIdentity = { dev: identity.dev, ino: identity.ino };
    await chmod(adminSocket, 0o600);
    await adminDirectory.assertValid();
    for (const [role, port] of entries) {
      const server = createServer((request, response) => {
        const task = handleRole(role as Role, port, request, response);
        requests.add(task);
        void task.catch(() => response.destroy()).finally(() => requests.delete(task));
      });
      servers.push(server); roleServers.push(server);
      server.on('connection', socket => {
        drain.accept(socket, role as Role);
      });
      await listen(server, listeners ? { fd: listeners[role as Role]! } : port);
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.port !== port) {
        throw new Error('Inherited listener must match its loopback role address.');
      }
    }
    store.watch();
    await store.reload();
    return { close: stop };
  } catch (error) { await stop(); throw error; }
}
