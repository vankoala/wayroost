import { createServer as createSecureServer } from 'node:https';
import { listenerTls } from '../../lib/loopback-tls.js';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { chmod, lstat } from 'node:fs/promises';
import { SUPERVISOR_ROUTES } from '../../shared/supervisor.js';
import type { ComponentStatus, SupervisorEvent, SupervisorStatus } from '../../shared/supervisor.js';
import type { Config } from './config.js';
import { NOT_SET_UP_SENTENCE, isReady, type Component } from './registry.js';
import { busyCountsSchema } from './busy.js';
import type { Exec } from './probes.js';
import type { Key } from './keys.js';
import { authenticate, permits } from './keys.js';
import { installation, liveProfile, probe } from './probes.js';
import { Actions, BusyError, RequestError, StatusOnlyError, summary } from './actions.js';
import { EventStream } from './sse.js';
import { prepareSocketDirectory, recoverSocket } from './socket.js';
import type { Trust } from './trust.js';

/** `signal` ends a status collection (its probes included) once nobody needs the answer. */
export type StatusSource = (signal?: AbortSignal) => Promise<SupervisorStatus>;
export interface SupervisorOptions { config: Config; registry: Component[]; keys: Key[]; exec: Exec; actions?: Actions; status?: StatusSource; trust?: Trust }
export function createSupervisor(options: SupervisorOptions) {
  const { config, registry, keys, exec } = options;
  const actions = options.actions ?? new Actions(registry, exec, config, undefined, options.trust);
  const since = new Map<string, { state: string; at: number }>();
  /** Aborted first by close(): pending status collections and request bodies end with it. */
  const shutdown = new AbortController();
  const status: StatusSource = options.status ?? (async (signal?: AbortSignal): Promise<SupervisorStatus> => {
    const components: ComponentStatus[] = [];
    const notSetUp: { id: string; name: string; sentence: string }[] = [];
    for (const entry of registry) {
      // An ended probe answers like a failed one: never report those answers.
      signal?.throwIfAborted();
      // Hide an add-on only when it is confirmed absent; a failed query keeps it visible.
      if (entry.optional && entry.installed && await installation(entry.installed, exec, signal) === 'absent') continue;
      if (!isReady(entry)) { notSetUp.push({ id: entry.id, name: entry.name, sentence: NOT_SET_UP_SENTENCE }); continue; }
      // For the main model the live profile is the one whose health answers;
      // none answering means down or starting, never a guess.
      let live: string | null = null;
      let healthy: boolean;
      if (entry.profiles) {
        live = (await liveProfile(entry, exec, signal))?.id ?? null;
        healthy = live !== null;
      } else healthy = await probe(entry.health, exec, false, signal);
      let held = false;
      if (entry.holdFile) { try { held = (await lstat(entry.holdFile)).isFile(); } catch {} }
      const state = held ? 'held' : actions.running?.target === entry.id && actions.running.state === 'running' ? 'starting' : healthy ? 'up' : 'down';
      if (since.get(entry.id)?.state !== state) since.set(entry.id, { state, at: Date.now() });
      const liveName = live === null ? undefined : entry.profiles!.find(profile => profile.id === live)!.name;
      components.push({ id: entry.id, name: entry.name, state, since: since.get(entry.id)!.at,
        sentence: liveName !== undefined ? liveName + ' is answering.'
          : entry.name + (state === 'up' ? ' is running.' : state === 'held' ? ' is held.' : state === 'starting' ? ' is starting.' : ' is stopped.'),
        busy: (await probe(entry.busy, exec, true, signal)) || actions.busy.componentBusy(entry.id),
        actions: config.statusOnly ? [] : [state === 'up' ? 'restart' : 'start', ...(entry.stop ? ['stop' as const] : []), ...(entry.holdFile ? [held ? 'release' as const : 'hold' as const] : []), ...(entry.profiles ? ['switch-model' as const] : [])],
        ...(entry.profiles ? { model: { live, profiles: entry.profiles.map(({ argv: _argv, health: _health, ...profile }) => profile) } } : {}),
        details: { gpus: entry.gpus.join(', '), ...(entry.unit ? { unit: entry.unit.name } : {}),
          ...(entry.health.kind === 'http' ? { port: new URL(entry.health.url).port } : {}) } });
    }
    signal?.throwIfAborted();
    const overall = components.some(entry => entry.state === 'down' || entry.state === 'failing') ? 'down' : components.some(entry => entry.state !== 'up') ? 'attention' : 'ok';
    return { overall, sentence: overall === 'ok' ? 'Everything is running.' : 'Some components need attention.', components,
      ...(notSetUp.length > 0 ? { notSetUp } : {}), busy: actions.busy.state(), at: Date.now(), ...(actions.running ? { running: summary(actions.running) } : {}) };
  });
  const clients = new Map<ServerResponse, { stream: EventStream; scope: Key['scope'] }>();
  const sendEvent = (event: SupervisorEvent) => {
    if (event.type === 'action') event = { type: 'action', action: summary(event.action) };
    if (event.type === 'status' && event.status.running) event = { type: 'status', status: { ...event.status, running: summary(event.status.running) } };
    const data = 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n';
    for (const { stream, scope } of clients.values()) if (scope === 'server' || event.type === 'status') stream.send(data);
  };
  actions.on('event', sendEvent);
  // During shutdown a kept-alive connection would hold server.close() until it times out.
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', ...(shutdown.signal.aborted ? { connection: 'close' } : {}) });
    res.end(JSON.stringify(body));
  };
  /** Ends with shutdown, or once this response closes (its client left): its probes stop. */
  const requestSignal = (res: ServerResponse): AbortSignal => {
    const left = new AbortController();
    res.once('close', () => left.abort());
    return AbortSignal.any([shutdown.signal, left.signal]);
  };
  async function handler(req: IncomingMessage, res: ServerResponse, listener: 'server' | 'rescue') {
    try {
      const header = req.headers.authorization;
      const key = authenticate(header?.startsWith('Bearer ') ? header.slice(7) : '', keys);
      if (!key) { json(res, 401, { message: 'A valid key is required.' }); return; }
      if (key.scope !== listener) { json(res, 403, { message: 'This key cannot use this connection.' }); return; }
      const path = req.url?.split('?')[0];
      if (req.method === 'GET' && path === SUPERVISOR_ROUTES.status) { json(res, 200, await status(requestSignal(res))); return; }
      if (req.method === 'GET' && path === SUPERVISOR_ROUTES.events) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const stream = new EventStream(res);
        clients.set(res, { stream, scope: key.scope });
        res.on('close', () => { clients.delete(res); if (!clients.size) poll?.abort(); });
        stream.send('event: status\ndata: ' + JSON.stringify({ type: 'status', status: await status(requestSignal(res)) }) + '\n\n');
        return;
      }
      const readBody = async (): Promise<unknown> => {
        const signal = requestSignal(res);
        const abort = () => { req.destroy(); };
        signal.throwIfAborted();
        signal.addEventListener('abort', abort, { once: true });
        let body = '';
        try {
          for await (const chunk of req) {
            body += String(chunk);
            if (Buffer.byteLength(body) > 8192) throw new RequestError('The request body is too large.');
          }
          signal.throwIfAborted();
        } finally { signal.removeEventListener('abort', abort); }
        try { return JSON.parse(body); } catch { throw new RequestError('Send valid JSON.'); }
      };
      if (req.method === 'POST' && path === SUPERVISOR_ROUTES.busy) {
        if (key.scope !== 'server') { json(res, 403, { message: 'This key cannot report busy counts.' }); return; }
        const counts = busyCountsSchema.safeParse(await readBody());
        if (!counts.success) throw new RequestError('Send paseoRunning, hermesRunning and calls as counts.');
        actions.busy.record(counts.data);
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'POST' && path === SUPERVISOR_ROUTES.actions) {
        if (config.statusOnly) throw new StatusOnlyError();
        const input = await readBody();
        if (key.scope === 'rescue' && input && typeof input === 'object') {
          const candidate = input as Record<string, unknown>;
          if (candidate.verb !== 'restart' || candidate.target !== 'wayroost-server') {
            json(res, 403, { message: 'This key cannot run that action.' }); return;
          }
        }
        const request = actions.validate(input);
        if (!permits(key, request)) { json(res, 403, { message: 'This key cannot run that action.' }); return; }
        const action = await actions.start(request, key.name);
        json(res, 202, { actionId: action.id });
        return;
      }
      if (req.method === 'GET' && path?.startsWith(SUPERVISOR_ROUTES.actions + '/')) {
        if (key.scope !== 'server') { json(res, 403, { message: 'This key can only read status and events.' }); return; }
        const action = await actions.get(decodeURIComponent(path.slice(SUPERVISOR_ROUTES.actions.length + 1)));
        json(res, action ? 200 : 404, action ?? { message: 'That action was not found.' });
        return;
      }
      json(res, 404, { message: 'That route was not found.' });
    } catch (error) {
      // A client that left (its status collection was ended for it) gets no answer.
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      if (shutdown.signal.aborted) json(res, 503, { message: 'The supervisor is shutting down.' });
      else if (error instanceof BusyError) json(res, 409, { error: 'busy', message: error.message, running: error.running });
      else if (error instanceof StatusOnlyError) json(res, error.status, { message: error.message });
      else if (error instanceof RequestError) json(res, 400, { message: error.message });
      else json(res, 500, { message: 'The request could not finish. Try again.' });
    }
  }
  const socket = createServer((req, res) => { void handler(req, res, 'server'); });
  if (!config.tls && !config.development) throw new Error('Installed rescue listener requires TLS. Set development only in a local dev config.');
  if (config.tls?.keyFile && !config.development) throw new Error('Installed TLS keys require LoadCredential.');
  const rescueHandler = (req: IncomingMessage, res: ServerResponse) => { void handler(req, res, 'rescue'); };
  const rescue = config.tls ? createSecureServer(listenerTls(config.tls, process.env, config.development), rescueHandler) : createServer(rescueHandler);
  let timer: NodeJS.Timeout | undefined;
  /** The status poll in progress for the event clients; aborted by shutdown or when the last one leaves. */
  let poll: AbortController | undefined;
  const listen = (server: Server, address: string | number) => new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const ready = () => { server.off('error', reject); resolve(); };
    if (typeof address === 'string') server.listen(address, ready); else server.listen(address, config.rescueHost, ready);
  });
  return {
    actions, socket, rescue, status,
    async start() {
      await actions.initialize();
      await prepareSocketDirectory(config.socket);
      await recoverSocket(config.socket);
      await listen(socket, config.socket);
      try { await chmod(config.socket, 0o660); await listen(rescue, config.rescuePort); }
      catch (error) { await new Promise<void>(resolve => socket.close(() => resolve())); throw error; }
      timer = setInterval(() => {
        if (poll || !clients.size) return;
        const current = poll = new AbortController();
        void status(AbortSignal.any([shutdown.signal, current.signal])).then(value => sendEvent({ type: 'status', status: value }))
          .catch(() => {}).finally(() => { if (poll === current) poll = undefined; });
      }, config.pollMs);
      timer.unref();
    },
    async close() {
      // End pending probes and uploads before closing the listeners.
      shutdown.abort();
      clearInterval(timer);
      actions.off('event', sendEvent);
      for (const client of clients.keys()) client.destroy();
      clients.clear();
      await actions.close();
      await Promise.all([socket, rescue].map(server => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        // Let ended status requests send their 503, then close even incomplete HTTP headers.
        setImmediate(() => server.closeAllConnections());
      })));
    },
  };
}
