import { afterEach, expect, it, vi } from 'vitest';
import { WS_CLOSE_DEVICE_REVOKED, WS_CLOSE_REAUTH, WS_CLOSE_SESSION_EXPIRED } from '../../shared/protocol';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules(); });

it.each([
  [WS_CLOSE_DEVICE_REVOKED, true, false, 1],
  [WS_CLOSE_SESSION_EXPIRED, false, true, 1],
  [WS_CLOSE_REAUTH, false, false, 2],
])('classifies socket close %s separately from routine reconnects', async (code, unpaired, sessionExpired, count) => {
  vi.useFakeTimers();
  const revoked = vi.fn();
  vi.stubGlobal('window', { wayroostTray: { unpaired: revoked } });
  vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:8896' });
  const sockets: Array<{ onclose: ((event: { code: number }) => void) | null }> = [];
  vi.stubGlobal('WebSocket', class {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0; onclose = null;
    close = vi.fn();
    constructor() { sockets.push(this); }
  });
  const { connect } = await import('./events');
  const { getState } = await import('./store');
  connect(); sockets[0]!.onclose?.({ code });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(getState()).toMatchObject({ unpaired, sessionExpired });
  expect(revoked).not.toHaveBeenCalled();
  expect(sockets).toHaveLength(count);
});

it('suspends the renderer from the native bridge without echoing and ignores subsequent socket work', async () => {
  vi.useFakeTimers();
  let publish!: (state: 'verified' | 'unverified' | 'unpaired') => void;
  const bridge = { anomaly: vi.fn(), onAuthentication: vi.fn((listener: typeof publish) => { publish = listener; }) };
  vi.stubGlobal('window', { wayroostTray: bridge });
  vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:8896' });
  const sockets: DemoSocket[] = [];
  class DemoSocket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 1;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    close = vi.fn(); send = vi.fn();
    constructor() { sockets.push(this); }
  }
  vi.stubGlobal('WebSocket', DemoSocket);
  const { connect, sendVoiceControl, socketOpen } = await import('./events');
  const { getState, setState, toast } = await import('./store');
  const approval = { id: 'demo-approval', source: 'hermes' as const, conversationId: 'demo-chat', kind: 'permission' as const,
    title: 'Demo check', options: [], createdAt: 0 };
  setState((s) => ({ ...s, approvals: { 'demo-approval': approval } }));
  toast('Demo old toast.');
  connect();
  publish('unverified');
  publish('unverified');
  expect(getState()).toMatchObject({ sessionExpired: true, unpaired: false, approvals: {}, toasts: [] });
  expect(sockets[0]!.close).toHaveBeenCalledTimes(1);
  expect(socketOpen()).toBe(false);
  expect(sendVoiceControl({ type: 'voice_start', run: 1 })).toBe(false);
  sockets[0]!.onopen?.({});
  sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'approval_upsert', approval }) });
  toast('Demo late toast.');
  connect();
  expect(getState()).toMatchObject({ approvals: {}, toasts: [] });
  expect(sockets).toHaveLength(1);
  expect(sockets[0]!.send).not.toHaveBeenCalled();
  expect(bridge.anomaly).not.toHaveBeenCalled();
});
