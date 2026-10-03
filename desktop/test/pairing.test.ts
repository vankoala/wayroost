import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';
import type { Approval, ConversationSummary } from '../../shared/protocol.js';
import { APP_HEADER, appOrigins, appSocketOptions, installAppHeader, marksAppRequest } from '../src/hardening.js';
import { ServerClient } from '../src/server-client.js';
import { approvalWords, toastCanAllow } from '../src/approvals.js';

// The desktop is a paired device like any other: it marks its requests to the app so
// the server's local origin takes its cookie, and losing its pairing is pairing state, not an outage.

const origin = 'http://127.0.0.1:8896';
const approval: Approval = { id: 'demo-approval', source: 'hermes', conversationId: 'demo:chat', kind: 'permission', title: 'Run the demo check.', detail: 'npm test', options: [{ id: 'once', label: 'Allow once', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' }], createdAt: 0 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
describe('the desktop marker', () => {
  it('marks requests to the app and its socket, and nothing else', () => {
    expect(appOrigins(origin)).toEqual({ http: origin, ws: 'ws://127.0.0.1:8896' });
    expect(appOrigins('https://wayroost.example.com').ws).toBe('wss://wayroost.example.com');
    expect(marksAppRequest(`${origin}/api/conversations`, origin)).toBe(true);
    expect(marksAppRequest('ws://127.0.0.1:8896/ws', origin)).toBe(true);
    for (const other of ['http://127.0.0.1:8897/api', 'ws://127.0.0.1:8897/ws', 'https://127.0.0.1:8896/', 'http://localhost:8896/', 'https://example.com/', 'not a url']) {
      expect(marksAppRequest(other, origin), other).toBe(false);
    }
  });

  it('runs the session hook for every URL, marking only the app and its socket', () => {
    let filter: { urls: string[] } | undefined;
    let listener: ((details: { url: string; requestHeaders: Record<string, string> }, callback: (response: { requestHeaders: Record<string, string> }) => void) => void) | undefined;
    const session = { webRequest: { onBeforeSendHeaders: vi.fn((f, l) => { filter = f; listener = l; }) } } as unknown as Pick<Session, 'webRequest'>;
    installAppHeader(session, origin);
    expect(filter).toEqual({ urls: ['<all_urls>'] });
    const send = (url: string, requestHeaders: Record<string, string> = {}) => {
      let sent: Record<string, string> | undefined;
      listener!({ url, requestHeaders }, (response) => { sent = response.requestHeaders; });
      return sent!;
    };
    expect(send(`${origin}/api/me`)[APP_HEADER]).toBe('desktop');
    expect(send('ws://127.0.0.1:8896/ws', { Cookie: 'wr_device=demo' })).toEqual({ Cookie: 'wr_device=demo', [APP_HEADER]: 'desktop' });
    // A redirected request can retain headers from its previous destination, with any casing.
    const marked = send(`${origin}/redirect`, { 'X-Wayroost-App': 'old', Accept: 'text/plain' });
    expect(marked).toEqual({ Accept: 'text/plain', [APP_HEADER]: 'desktop' });
    for (const url of ['https://example.com/', 'http://127.0.0.1:8897/', 'ws://127.0.0.1:8897/ws', 'not a url']) {
      expect(send(url, { ...marked, 'X-WAYROOST-APP': 'desktop' })).toEqual({ Accept: 'text/plain' });
    }
  });

  it('gives the main process socket the marker itself, only for the app socket origin and only through the gate', () => {
    const session = { webRequest: {} } as unknown as Session;
    expect(appSocketOptions('ws://127.0.0.1:8896/ws', origin, session)).toEqual({ session, useSessionCookies: true, origin, headers: { [APP_HEADER]: 'desktop' } });
    expect(appSocketOptions('wss://127.0.0.1:8881/ws', 'https://127.0.0.1:8881', session).headers).toEqual({ [APP_HEADER]: 'desktop' });
    for (const other of ['ws://127.0.0.1:8897/ws', 'wss://127.0.0.1:8896/ws', 'ws://localhost:8896/ws', 'wss://example.com/ws']) {
      expect(appSocketOptions(other, origin, session).headers, other).toEqual({});
    }
    // The same gate as the session's header hook: a refused URL gets no socket at all.
    const allowed = vi.fn((url: string) => url === 'ws://127.0.0.1:8896/ws');
    expect(() => appSocketOptions('ws://127.0.0.1:8897/ws', origin, session, allowed)).toThrow('not allowed');
    expect(appSocketOptions('ws://127.0.0.1:8896/ws', origin, session, allowed).headers).toEqual({ [APP_HEADER]: 'desktop' });
    expect(allowed.mock.calls).toEqual([['ws://127.0.0.1:8897/ws'], ['ws://127.0.0.1:8896/ws']]);
  });

  it('is installed on the app session before its window or socket, and never on the rescue session', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    const hook = main.indexOf('installAppHeader(partition, origin,');
    expect(hook).toBeGreaterThan(0);
    expect(hook).toBeLessThan(main.indexOf('const target = new BrowserWindow('));
    expect(hook).toBeLessThan(main.indexOf('client.connect('));
    expect(main.match(/installAppHeader\(/g)).toHaveLength(1);
    expect(main).toContain('monitorPairing(partition, origin, target.webContents.id, client)');
    const navigation = main.slice(main.indexOf("target.webContents.on('did-navigate'"), main.indexOf("target.webContents.on('dom-ready'"));
    expect(navigation).not.toContain('resume');
  });

  it('carries the marker on the main process requests too', async () => {
    const fetch = vi.fn(async () => json({ conversations: [], approvals: [], statuses: [] }));
    const client = new ServerClient(origin, { fetch } as unknown as Session, { notify: vi.fn(), changed: vi.fn(), removed: vi.fn() });
    fetch.mockResolvedValueOnce(json({ device: { id: 'demo-device', kind: 'desktop' } }));
    await client.revalidateAuthentication(0);
    await client.refresh();
    client.stop();
    expect(fetch).toHaveBeenCalledWith(`${origin}/api/conversations`, expect.objectContaining({ headers: expect.objectContaining({ [APP_HEADER]: 'desktop' }) }));
  });
});

describe('toast words', () => {
  const coder: ConversationSummary = {
    source: 'paseo', id: 'demo-task', title: 'Demo task', subtitle: 'Claude Code', status: 'needs_approval', updatedAt: 0, pendingApprovals: 1, agentLabel: 'Claude Code',
  } as ConversationSummary;

  it('names the role that asks and the request the way its card does', () => {
    const asking = { ...approval, source: 'paseo' as const, conversationId: 'demo-task' };
    const words = approvalWords(asking, coder);
    expect(words.role).toBe('Coder');
    expect(words.sentence).toBe(`Coder is asking: ${words.title}`);
    expect(words.title).toBe('Run the demo check.');
    // Without the conversation, a Hermes chat is the Manager's.
    expect(approvalWords(approval).role).toBe('Manager');
  });

  it('never lets the card take "Allow once" for a request it calls High', () => {
    expect(toastCanAllow({ ...approval, detail: 'npm test' })).toBe(true);
    expect(toastCanAllow({ ...approval, detail: 'rm -rf build' })).toBe(false);
  });
});
