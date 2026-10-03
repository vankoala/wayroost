import type { WebSocket } from 'ws';
import type { ServerEvent, Source } from '../../shared/protocol.js';

// Fans events out to connected browsers. List-level events (statuses,
// conversation summaries, approvals) go to everyone; timeline events only go
// to browsers that have that conversation open.

const OPEN = 1;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_SUBSCRIPTIONS_PER_CLIENT = 32;

export interface HubClient {
  readonly socket: WebSocket;
  readonly email: string;
  readonly subscriptions: Set<string>;
  /** Checked for each direct or published event, so access can change while connected. */
  readonly accepts: (event: ServerEvent) => boolean;
}

export type WatchListener = (source: Source, conversationId: string, watching: boolean) => void;

const keyOf = (source: Source, conversationId: string) => `${source}:${conversationId}`;

function conversationKey(event: ServerEvent): string | null {
  switch (event.type) {
    case 'items_upsert':
    case 'items_replace':
    case 'text_delta':
      return keyOf(event.source, event.conversationId);
    default:
      return null;
  }
}

export class EventHub {
  private readonly clients = new Set<HubClient>();
  private readonly watchCounts = new Map<string, number>();
  private readonly listeners: WatchListener[] = [];
  private readonly observers: Array<(event: ServerEvent) => void> = [];
  private transform: (event: ServerEvent) => ServerEvent = (event) => event;

  onWatchChange(listener: WatchListener): void {
    this.listeners.push(listener);
  }

  /** See every published event on the server side (e.g. to notify a phone about an approval). */
  observe(observer: (event: ServerEvent) => void): void {
    this.observers.push(observer);
  }

  /** Last step before events leave the server (e.g. signing image links). */
  setTransform(transform: (event: ServerEvent) => ServerEvent): void {
    this.transform = transform;
  }

  add(socket: WebSocket, email: string, accepts: (event: ServerEvent) => boolean = () => true): HubClient {
    const client: HubClient = { socket, email, subscriptions: new Set(), accepts };
    this.clients.add(client);
    return client;
  }

  remove(client: HubClient): void {
    if (!this.clients.delete(client)) return;
    for (const key of client.subscriptions) this.release(key);
    client.subscriptions.clear();
  }

  subscribe(client: HubClient, source: Source, conversationId: string): void {
    const key = keyOf(source, conversationId);
    // A client already removed would hold the watch open for good: remove() is done with it.
    if (!this.clients.has(client)) return;
    if (client.subscriptions.has(key) || client.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CLIENT) return;
    client.subscriptions.add(key);
    const count = (this.watchCounts.get(key) ?? 0) + 1;
    this.watchCounts.set(key, count);
    if (count === 1) this.notify(source, conversationId, true);
  }

  unsubscribe(client: HubClient, source: Source, conversationId: string): void {
    const key = keyOf(source, conversationId);
    if (client.subscriptions.delete(key)) this.release(key);
  }

  isWatched(source: Source, conversationId: string): boolean {
    return (this.watchCounts.get(keyOf(source, conversationId)) ?? 0) > 0;
  }

  publish(event: ServerEvent): void {
    for (const observer of this.observers) {
      try {
        observer(event);
      } catch {
        // An observer must never break delivery to browsers.
      }
    }
    const key = conversationKey(event);
    let payload: string | undefined;
    for (const client of this.clients) {
      if (!client.accepts(event)) continue;
      if (key !== null && !client.subscriptions.has(key)) continue;
      payload ??= JSON.stringify(this.transform(event));
      this.sendRaw(client, payload);
    }
  }

  sendTo(client: HubClient, event: ServerEvent): void {
    if (!client.accepts(event)) return;
    this.sendRaw(client, JSON.stringify(event));
  }

  get size(): number {
    return this.clients.size;
  }

  private sendRaw(client: HubClient, payload: string): void {
    if (client.socket.readyState !== OPEN) return;
    // A client that can't keep up is dropped; it reconnects and refetches.
    if (client.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      client.socket.terminate();
      return;
    }
    client.socket.send(payload);
  }

  private release(key: string): void {
    const count = (this.watchCounts.get(key) ?? 0) - 1;
    if (count > 0) {
      this.watchCounts.set(key, count);
      return;
    }
    this.watchCounts.delete(key);
    const split = key.indexOf(':');
    this.notify(key.slice(0, split) as Source, key.slice(split + 1), false);
  }

  private notify(source: Source, conversationId: string, watching: boolean): void {
    for (const listener of this.listeners) {
      try {
        listener(source, conversationId, watching);
      } catch {
        // A misbehaving listener must not break event delivery.
      }
    }
  }
}
