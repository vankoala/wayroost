import { vi } from 'vitest';
import type { Session } from 'electron';
import type { Approval } from '../../shared/protocol.js';
import { ServerClient, type LiveSocket } from '../src/server-client.js';
import { ToastTickets } from '../src/approvals.js';
import { monitorPairing } from '../src/pairing.js';

export const origin = 'https://wayroost.example.com';
export const approval: Approval = { id: 'demo-approval', source: 'hermes', conversationId: 'demo-chat', kind: 'permission',
  title: 'Run the demo check.', detail: 'npm test', options: [{ id: 'once', label: 'Allow once', kind: 'allow' }], createdAt: 0 };
export const snapshot = { role: 'primary', notifications: true, conversations: [], approvals: [approval], statuses: [] };
export const identity = { device: { id: 'demo-device', kind: 'desktop' }, statuses: [] };
export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
/** A socket that never opened and lost its connection, as Electron words it: a network failure, not a refusal. */
export const connectionLost = { code: 1006, reason: 'Connection closed before receiving a handshake response (net::ERR_EMPTY_RESPONSE)' };
export function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
export async function fixture(verified = true) {
  const fetch = vi.fn(async (url: string, _init?: RequestInit): Promise<Response> => json(url.endsWith('/api/me') ? identity : snapshot));
  const webRequest = { onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn(), onBeforeRedirect: vi.fn(), onCompleted: vi.fn(), onErrorOccurred: vi.fn() };
  const session = { fetch, webRequest } as unknown as Session;
  const tickets = new ToastTickets();
  const handlers = { notify: vi.fn((item: Approval) => tickets.issue(item)), removed: vi.fn((key: string) => tickets.forget(key)),
    changed: vi.fn(), authentication: vi.fn(), paired: vi.fn(), unpaired: vi.fn(), answered: vi.fn(), link: vi.fn() };
  const client = new ServerClient(origin, session, handlers);
  if (verified) { await client.revalidateAuthentication(0); fetch.mockClear(); }
  const sockets: LiveSocket[] = [];
  client.connect(() => {
    const socket: LiveSocket = { onopen: null, onmessage: null, onerror: null, onclose: null, close: vi.fn(() => socket.onclose?.({ code: 1000 })) };
    sockets.push(socket); return socket;
  });
  const discard = monitorPairing(session, origin, 42, client);
  const start = (id: number, path = '/api/conversations', contentsId = 42, method = 'GET', resourceType = 'xhr') => {
    const callback = vi.fn();
    webRequest.onBeforeRequest.mock.calls.at(-1)![1]({ id, url: path.startsWith('wss:') ? path : `${origin}${path}`, method, resourceType, webContentsId: contentsId }, callback);
    return callback;
  };
  const receive = (id: number, statusCode = 200) => {
    const callback = vi.fn();
    webRequest.onHeadersReceived.mock.calls.at(-1)![1]({ id, statusCode, responseHeaders: { 'Set-Cookie': ['wr_device=demo-replacement'], 'Content-Type': ['application/json'] } }, callback);
    return callback;
  };
  const finish = (id: number, statusCode = 200) => webRequest.onCompleted.mock.calls.at(-1)![1]({ id, statusCode });
  const fail = (id: number, error = 'net::ERR_FAILED') => webRequest.onErrorOccurred.mock.calls.at(-1)![1]({ id, error });
  const redirect = (id: number, redirectURL?: string) => webRequest.onBeforeRedirect.mock.calls.at(-1)![1]({ id, redirectURL });
  return { client, fetch, handlers, tickets, sockets, start, receive, finish, fail, redirect, discard };
}
