import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { EventHub } from '../src/hub.js';

describe('EventHub', () => {
  it('lets no removed client hold a conversation watch open', () => {
    const hub = new EventHub();
    const watches: boolean[] = [];
    hub.onWatchChange((_source, _id, watching) => watches.push(watching));
    const socket = { readyState: 1, bufferedAmount: 0, send() {}, terminate() {} } as unknown as WebSocket;
    const client = hub.add(socket, 'you@example.com');
    hub.subscribe(client, 'hermes', 'chat-1');
    hub.remove(client);
    hub.subscribe(client, 'hermes', 'chat-2');
    expect(hub.isWatched('hermes', 'chat-1')).toBe(false);
    expect(hub.isWatched('hermes', 'chat-2')).toBe(false);
    expect(watches).toEqual([true, false]);
  });
});
