import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { HermesAuth } from './auth.js';

// JSON-RPC 2.0 over the dashboard's /api/ws. Mirrors the reference client in
// hermes-agent/apps/shared/src/json-rpc-channel.ts: fresh single-use ticket per
// dial, advertise server_requests (otherwise Hermes withdraws approvals),
// gateway.ping heartbeat, and jittered reconnects.

export interface GatewayEvent {
  type: string;
  session_id?: string;
  payload?: Record<string, unknown>;
  seq?: number;
}

export interface ServerRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
  /** Which connection it arrived on; response frames are only valid there. */
  generation: number;
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export type GatewayState = 'idle' | 'connecting' | 'ready' | 'closed';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const HEARTBEAT_MS = 15_000;
const SILENCE_LIMIT_MS = 45_000;
const STABLE_AFTER_MS = 5_000;
const MIN_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 15_000;

export interface HermesGatewayEvents {
  state: [GatewayState];
  ready: [{ epoch: string | undefined }];
  event: [GatewayEvent];
  request: [ServerRequest];
  failure: [Error];
}

export class HermesGateway extends EventEmitter<HermesGatewayEvents> {
  state: GatewayState = 'idle';
  epoch: string | undefined;
  /** Increments with every new socket. */
  generation = 0;

  private ws: WebSocket | undefined;
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private attempts = 0;
  private stopped = true;
  private lastInbound = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly auth: HermesAuth,
  ) {
    super();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.teardown(new Error('gateway stopped'));
    this.setState('idle');
  }

  /** Reconnect now (e.g. after new credentials). */
  restart(): void {
    this.stop();
    this.attempts = 0;
    this.start();
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || (this.state !== 'ready' && method !== 'client.capabilities')) {
      return Promise.reject(new RpcError(-1, 'Hermes is not connected'));
    }
    const id = `wc-${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(-2, `Hermes did not answer ${method} in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** Answer a server→client request, only on the connection it arrived on. */
  respond(id: string, result: Record<string, unknown>, generation: number): boolean {
    if (generation !== this.generation || this.state !== 'ready' || this.ws?.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
    return true;
  }

  private setState(state: GatewayState) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setState('connecting');

    let ticket: string;
    try {
      const res = await this.auth.fetch('/api/auth/ws-ticket', { method: 'POST' });
      if (!res.ok) throw new Error(`ticket request failed (${res.status})`);
      ticket = ((await res.json()) as { ticket: string }).ticket;
      if (typeof ticket !== 'string' || !ticket) throw new Error('no ticket');
    } catch (err) {
      this.emit('failure', err as Error);
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;

    const url = `${this.baseUrl.replace(/^http/, 'ws')}/api/ws?ticket=${encodeURIComponent(ticket)}`;
    const ws = new WebSocket(url, { handshakeTimeout: 15_000, maxPayload: 64 * 1024 * 1024 });
    this.ws = ws;
    this.generation += 1;
    this.lastInbound = Date.now();

    ws.on('message', (data, isBinary) => {
      if (isBinary || ws !== this.ws) return;
      this.lastInbound = Date.now();
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      this.onFrame(frame);
    });
    ws.on('close', () => {
      if (ws !== this.ws) return;
      this.teardown(new RpcError(-1, 'Hermes connection closed'));
      this.setState('closed');
      this.scheduleReconnect();
    });
    ws.on('error', (err) => {
      if (ws === this.ws) this.emit('failure', err);
    });
  }

  private onFrame(frame: Record<string, unknown>): void {
    const { id, method } = frame;

    // Server → client request (approval, clarify, …)
    if (typeof id === 'string' && typeof method === 'string' && method !== 'event') {
      this.emit('request', {
        id,
        method,
        params: (frame.params ?? {}) as Record<string, unknown>,
        generation: this.generation,
      });
      return;
    }

    // Response to one of our calls
    if (id !== undefined && id !== null && ('result' in frame || 'error' in frame)) {
      const pending = this.pending.get(String(id));
      if (!pending) return;
      this.pending.delete(String(id));
      clearTimeout(pending.timer);
      const error = frame.error as { code?: number; message?: string } | undefined;
      if (error) pending.reject(new RpcError(error.code ?? -32603, error.message ?? 'Hermes error'));
      else pending.resolve(frame.result);
      return;
    }

    if (method === 'event') {
      const event = frame.params as GatewayEvent | undefined;
      if (!event || typeof event.type !== 'string') return;
      if (event.type === 'gateway.ready') {
        this.epoch = (event.payload?.replay_epoch as string | undefined) ?? undefined;
        void this.onReady();
        return;
      }
      this.emit('event', event);
    }
  }

  private async onReady(): Promise<void> {
    try {
      await this.call('client.capabilities', { server_requests: true }, 10_000);
    } catch (err) {
      this.emit('failure', err as Error);
      this.ws?.terminate();
      return;
    }
    this.setState('ready');
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastInbound > SILENCE_LIMIT_MS) {
        this.ws?.terminate();
        return;
      }
      this.call('gateway.ping', {}, 10_000).catch(() => {});
    }, HEARTBEAT_MS);
    clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.attempts = 0;
    }, STABLE_AFTER_MS);
    this.emit('ready', { epoch: this.epoch });
  }

  private teardown(reason: Error): void {
    clearInterval(this.heartbeat);
    clearTimeout(this.stableTimer);
    this.heartbeat = undefined;
    const ws = this.ws;
    this.ws = undefined;
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.terminate();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
      this.pending.delete(id);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const cap = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** this.attempts);
    this.attempts += 1;
    const delay = Math.max(MIN_BACKOFF_MS, Math.random() * cap);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }
}
