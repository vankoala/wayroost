import { join, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Approval } from '../../shared/protocol.js';
import { WS_CLOSE_DEVICE_REVOKED, WS_CLOSE_SESSION_EXPIRED } from '../../shared/protocol.js';
import type { LiveSocket } from '../src/server-client.js';

const mocks = vi.hoisted(() => {
  const emitter = () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    return {
      on: vi.fn((name: string, listener: (...args: unknown[]) => void) => { listeners.set(name, [...listeners.get(name) ?? [], listener]); }),
      emit: (name: string, ...args: unknown[]) => { for (const listener of listeners.get(name) ?? []) listener(...args); },
      removeListener: vi.fn((name: string, listener: (...args: unknown[]) => void) => { listeners.set(name, (listeners.get(name) ?? []).filter((item) => item !== listener)); }),
      hasListeners: (name: string) => (listeners.get(name) ?? []).length > 0,
      clear: () => listeners.clear(),
    };
  };
  const windows: Window[] = [];
  const loadFailure = vi.fn<(url: string) => number | undefined>();
  const loadPending = vi.fn<(url: string, stage: 'commit' | 'finish') => Promise<void> | undefined>();
  const loadFilePending = vi.fn<() => Promise<void> | undefined>();
  class Window {
    visible = false;
    destroyed = false;
    url = '';
    events = emitter();
    webContents = {
      ...emitter(), id: windows.length + 1, mainFrame: { url: '' },
      stop: vi.fn(), setWindowOpenHandler: vi.fn(), send: vi.fn(),
      getURL: () => this.url, isLoading: () => false,
    };
    on = this.events.on;
    show = vi.fn(() => { this.visible = true; });
    hide = vi.fn(() => { this.visible = false; });
    focus = vi.fn();
    destroy = vi.fn(() => {
      this.destroyed = true; this.visible = false;
      if (windows.every((item) => item.destroyed)) {
        app.emit('window-all-closed');
        if (!app.hasListeners('window-all-closed')) app.quit();
      }
    });
    isVisible = () => this.visible;
    isDestroyed = () => this.destroyed;
    loadURL = vi.fn(async (url: string) => {
      this.webContents.emit('did-start-navigation', {}, url, false, true);
      this.url = url;
      this.webContents.mainFrame.url = url;
      await loadPending(url, 'commit');
      const code = loadFailure(url);
      if (code !== undefined) {
        this.webContents.emit('did-fail-load', {}, code, 'Demo load failed', url, true);
        this.webContents.emit('dom-ready');
        throw new Error('Demo load failed');
      }
      this.webContents.emit('did-navigate', {}, url);
      this.webContents.emit('dom-ready');
      await loadPending(url, 'finish');
    });
    loadFile = vi.fn(async () => { await loadFilePending(); });
    constructor(readonly options: { webPreferences: { additionalArguments?: string[] } }) { windows.push(this); }
  }
  const paths = new Map<string, string>();
  const files = new Map<string, Buffer>();
  const app = { ...emitter(), isPackaged: false, whenReady: vi.fn(async () => {}),
    requestSingleInstanceLock: vi.fn(() => true), quit: vi.fn(), relaunch: vi.fn(), setAppUserModelId: vi.fn(),
    setAsDefaultProtocolClient: vi.fn(), getAppPath: () => '/home/me/demo', getPath: (name: string) => paths.get(name) ?? '/home/me/demo', setPath: vi.fn((name: string, path: string) => paths.set(name, path)), setLoginItemSettings: vi.fn(),
  };
  const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'demo-encrypted', encryptString: vi.fn((value: string) => Buffer.from(value)), decryptString: vi.fn((value: Buffer) => value.toString()) };
  const fs = { existsSync: vi.fn((path: string) => !path.endsWith('listener-pins') && !path.endsWith('login-configured') || files.has(path)), readFileSync: vi.fn((path: string) => files.get(path)), writeFileSync: vi.fn((path: string, value: Buffer) => files.set(path, value)), mkdirSync: vi.fn() };
  const partition = { fetch: vi.fn(), setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(),
    setCertificateVerifyProc: vi.fn(), closeAllConnections: vi.fn(), clearStorageData: vi.fn(), clearCache: vi.fn(), cookies: { set: vi.fn(), flushStore: vi.fn() },
    webRequest: { onBeforeSendHeaders: vi.fn(), onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn(), onBeforeRedirect: vi.fn(), onCompleted: vi.fn(), onErrorOccurred: vi.fn() },
  };
  const rescueSession = { ...partition, setCertificateVerifyProc: vi.fn(), webRequest: { ...partition.webRequest, onBeforeSendHeaders: vi.fn() } };
  const rescueStatus = vi.fn(async () => ({ overall: 'ok', sentence: 'Demo is running.', components: [], at: 0 }));
  const rescueRestart = vi.fn(async () => ({}));
  const rescueCredentials = vi.fn();
  const rescueKeyCheck = vi.fn();
  const pairPinned = vi.fn();
  const notifications: Array<{ options: { toastXml?: string }; show: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }> = [];
  class Notification {
    show = vi.fn(); close = vi.fn(); on = vi.fn();
    constructor(readonly options: { toastXml?: string }) { notifications.push(this); }
  }
  return { windows, Window, loadFailure, loadPending, loadFilePending, app, paths, files, fs, storage, partition, rescueSession, rescueStatus, rescueRestart, rescueCredentials, rescueKeyCheck, pairPinned, Notification, notifications, socketOpened: vi.fn(), sockets: [] as LiveSocket[],
    ipcMain: { ...emitter(), handle: vi.fn() }, contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { ...emitter(), send: vi.fn() },
    tray: { update: vi.fn(), open: vi.fn(), setup: vi.fn() }, shell: { openExternal: vi.fn() }, powerMonitor: { ...emitter(), getSystemIdleTime: () => 0 },
  };
});
vi.mock('electron', () => ({
  app: mocks.app, BrowserWindow: mocks.Window, Notification: mocks.Notification,
  ipcMain: mocks.ipcMain, contextBridge: mocks.contextBridge, ipcRenderer: mocks.ipcRenderer, Menu: { setApplicationMenu: vi.fn() },
  session: { fromPartition: (name: string) => name === 'wayroost-rescue' ? mocks.rescueSession : mocks.partition, defaultSession: mocks.rescueSession },
  net: { WebSocket: class {
    onopen = null; onmessage = null; onerror = null; onclose: LiveSocket['onclose'] = null;
    close = vi.fn(() => this.onclose?.({ code: 1000 }));
    constructor(url: string, options: unknown) { mocks.socketOpened(url, options); mocks.sockets.push(this); }
  } },
  safeStorage: mocks.storage, shell: mocks.shell, powerMonitor: mocks.powerMonitor,
}));
vi.mock('node:fs', () => mocks.fs);
vi.mock('../src/tray.js', () => ({ createTray: (_icon: string, open: () => void, _quit: () => void, setup?: () => void) => { mocks.tray.open.mockImplementation(open); mocks.tray.setup.mockImplementation(() => setup?.()); return mocks.tray; } }));
vi.mock('../src/rescue-client.js', () => ({ RescueClient: class {
  constructor(_origin: string, private readonly key: () => Promise<string>, private readonly transport: { pin?: () => string | undefined } = {}) {}
  private async credentials() { const pin = this.transport.pin?.(); mocks.rescueCredentials(await this.key(), pin); }
  status = async () => { await this.credentials(); return mocks.rescueStatus(); };
  restart = async () => { await this.credentials(); return mocks.rescueRestart(); };
}, checkRescueKey: mocks.rescueKeyCheck }));
vi.mock('../src/tls.js', async original => ({ ...await original<object>(), pairPinnedDesktop: mocks.pairPinned }));

const origin = 'http://127.0.0.1:8896';
/** The mock app's folder (getAppPath, and getPath before setPath); the app joins file names onto it with the platform's separator. */
const home = '/home/me/demo';
const demoPath = (...parts: string[]) => join(home, ...parts);
const approval: Approval = { id: 'demo-approval', source: 'hermes', conversationId: 'demo:chat', kind: 'permission', title: 'Run the demo check.', detail: 'npm test', options: [{ id: 'once', label: 'Allow once', kind: 'allow' }], createdAt: 0 };
// The server routes each pending approval's toast to the device it picked (presence routing);
// a snapshot here routes every approval to this desktop unless a test says otherwise.
const routedApproval = (item: { id: string; source: string; conversationId: string; createdAt: number }) => ({
  event: 'agent-needs-you', source: item.source, title: 'An agent needs you', url: `/c/${item.source}/${encodeURIComponent(item.conversationId)}`, at: 1,
  approval: { id: item.id, source: item.source, conversationId: item.conversationId, createdAt: item.createdAt },
});
const json = (body: unknown, status = 200) => {
  if (body && typeof body === 'object' && 'approvals' in body && Array.isArray(body.approvals) && !('approvalNotifications' in body)) {
    body = { ...body, approvalNotifications: body.approvals.filter((item): item is Parameters<typeof routedApproval>[0] => !!item && typeof item === 'object').map(routedApproval) };
  }
  return new Response(JSON.stringify(body), { status });
};
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };
const toastActivation = (action: string) => {
  const url = mocks.notifications[0]!.options.toastXml!.match(new RegExp(`wayroost(?:-dev)?://approval/demo-approval/${action}/[A-Za-z0-9_-]{22}`))?.[0];
  expect(url).toBeDefined();
  return url!;
};

function reset() {
  mocks.app.emit('before-quit'); mocks.app.clear(); mocks.powerMonitor.clear(); mocks.ipcMain.clear();
  mocks.ipcRenderer.clear();
  mocks.windows.length = 0; mocks.sockets.length = 0; mocks.notifications.length = 0;
  mocks.loadFailure.mockReset();
  mocks.loadPending.mockReset();
  mocks.loadFilePending.mockReset();
  mocks.partition.fetch.mockReset();
  mocks.partition.closeAllConnections.mockReset(); mocks.partition.clearStorageData.mockReset(); mocks.partition.clearCache.mockReset();
  mocks.paths.clear(); mocks.files.clear(); mocks.app.isPackaged = false;
  mocks.rescueStatus.mockReset(); mocks.rescueStatus.mockResolvedValue({ overall: 'ok', sentence: 'Demo is running.', components: [], at: 0 });
  mocks.rescueRestart.mockReset(); mocks.rescueRestart.mockResolvedValue({});
  mocks.rescueKeyCheck.mockReset(); mocks.pairPinned.mockReset();
  vi.clearAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules();
}
afterEach(reset);

const identity = { device: { id: 'demo-device', kind: 'desktop' } };
const list = { role: 'primary', notifications: true, conversations: [], approvals: [approval], statuses: [] };
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function start(hidden = false) {
  vi.useFakeTimers(); process.argv = [...process.argv.filter(arg => arg !== '--wayroost-desktop-dev'), '--wayroost-desktop-dev']; vi.stubEnv('WAYROOST_URL', origin); vi.stubEnv('WAYROOST_RESCUE_URL', 'http://127.0.0.1:8897');
  mocks.partition.fetch.mockImplementation(async (url) => json(String(url).endsWith('/api/me') ? identity : list));
  const { ServerClient } = await import('../src/server-client.js');
  const connection = vi.spyOn(ServerClient.prototype, 'connect');
  const argv = process.argv;
  try {
    if (hidden) process.argv = [...argv, '--hidden'];
    await import('../src/main.js'); await flush();
  } finally { process.argv = argv; }
  const client = connection.mock.contexts[0] as InstanceType<typeof ServerClient>;
  connection.mockRestore();
  return client;
}
async function unpair(client: Awaited<ReturnType<typeof start>>) {
  client.suspend(client.pairingGeneration);
  mocks.partition.fetch.mockResolvedValueOnce(json({ error: 'unpaired' }, 401));
  await client.revalidateAuthentication(client.pairingGeneration); await flush();
}
const frameEvent = (target = mocks.windows.at(-1)!) => ({ sender: target.webContents, senderFrame: target.webContents.mainFrame });

describe('main authentication authority', () => {
  it('keeps native toasts and the Tasks window when playback deliberately aborts, with frame and generation ownership', async () => {
    const client = await start(); mocks.sockets[0]!.onopen?.({}); await flush();
    const target = mocks.windows[0]!;
    const begin = mocks.ipcMain.handle.mock.calls.find(([channel]) => channel === 'speech:begin')![1];
    const cancel = mocks.ipcMain.handle.mock.calls.find(([channel]) => channel === 'speech:cancel')![1];
    expect(begin(frameEvent(target), 1)).toBeUndefined();
    expect(begin({ ...frameEvent(target), senderFrame: { url: origin } }, 0)).toBeUndefined();
    const owner = begin(frameEvent(target), 0);
    const before = mocks.partition.webRequest.onBeforeRequest.mock.calls.at(-1)![1];
    before({ id: 1, url: `${origin}/api/voice/speak?speechRequest=${owner}`, method: 'POST', resourceType: 'xhr', webContentsId: target.webContents.id }, vi.fn());
    expect(cancel(frameEvent(target), 1, owner)).toBe(false);
    expect(cancel(frameEvent(target), 0, owner)).toBe(true);
    const failure = mocks.partition.webRequest.onErrorOccurred.mock.calls.at(-1)![1];
    failure({ id: 1, error: 'net::ERR_ABORTED' });
    expect(client.authenticationState).toBe('verified'); expect(client.approvals.size).toBe(1);
    expect(mocks.notifications[0]!.close).not.toHaveBeenCalled(); expect(mocks.windows).toHaveLength(1);
    before({ id: 2, url: `${origin}/api/tasks`, method: 'GET', resourceType: 'xhr', webContentsId: target.webContents.id }, vi.fn());
    const headers = mocks.partition.webRequest.onHeadersReceived.mock.calls.at(-1)![1];
    const delivered = vi.fn(); headers({ id: 2, statusCode: 404 }, delivered);
    expect(delivered).toHaveBeenCalledWith({});
    expect(client.authenticationState).toBe('verified'); expect(mocks.windows).toHaveLength(1);
  });

  it('closes toasts and retires activation tickets after repeated invalid socket approval payloads', async () => {
    const client = await start(); mocks.sockets[0]!.onopen?.({}); await flush();
    const activation = toastActivation('allow-once');
    const calls = mocks.partition.fetch.mock.calls.length;
    const socket = mocks.sockets[0]!;
    const data = JSON.stringify({ type: 'approval_upsert', approval: { ...approval, options: [null] } });
    socket.onmessage?.({ data }); await flush();
    expect(client.authenticationState).toBe('verified');
    expect(mocks.partition.fetch).toHaveBeenCalledTimes(calls);
    socket.onmessage?.({ data }); socket.onmessage?.({ data });
    expect(client.authenticationState).toBe('unverified');
    expect(mocks.notifications[0]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.tray.update.mock.calls.at(-1)![1]).toEqual([]);
    mocks.app.emit('second-instance', {}, [activation]); await flush();
    expect(mocks.partition.fetch.mock.calls.some(([url]) => String(url).includes('/approvals/'))).toBe(false);
    await client.revalidateAuthentication(client.pairingGeneration); await flush();
    mocks.app.emit('second-instance', {}, [activation]); await flush();
    expect(mocks.partition.fetch.mock.calls.some(([url]) => String(url).includes('/approvals/'))).toBe(false);
  });

  it('closes existing toasts and retires their activation tickets when a snapshot has a null option', async () => {
    const client = await start(); mocks.sockets[0]!.onopen?.({}); await flush();
    const activation = toastActivation('allow-once');
    mocks.partition.fetch.mockResolvedValueOnce(json({ ...list, approvals: [approval, { ...approval, id: 'demo-invalid-approval', options: [null] }] }));
    await expect(client.refresh()).rejects.toThrow('Invalid approval snapshot');
    expect(client.authenticationState).toBe('unverified');
    expect(mocks.notifications[0]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.notifications).toHaveLength(1);
    expect(mocks.tray.update.mock.calls.at(-1)![1]).toEqual([]);
    mocks.app.emit('second-instance', {}, [activation]); await flush();
    expect(mocks.partition.fetch.mock.calls.some(([url]) => String(url).includes('/approvals/'))).toBe(false);
    await client.revalidateAuthentication(client.pairingGeneration); await flush();
    expect(client.authenticationState).toBe('verified');
    mocks.app.emit('second-instance', {}, [activation]); await flush();
    expect(mocks.partition.fetch.mock.calls.some(([url]) => String(url).includes('/approvals/'))).toBe(false);
  });

  it.each(['net::ERR_ABORTED', 'net::ERR_BLOCKED_BY_CLIENT'])('keeps repeated verified recoveries stable after a guard cancellation reports %s', async (errorCode) => {
    const client = await start();
    const loading = deferred<void>();
    mocks.loadPending.mockImplementation((url, stage) => url === origin && stage === 'commit' ? loading.promise : undefined);
    for (let id = 30; id < 33; id += 1) {
      const target = mocks.windows.at(-1)!;
      client.suspend(client.pairingGeneration);
      const pending = target.loadURL(origin);
      const before = mocks.partition.webRequest.onBeforeRequest.mock.calls.at(-1)![1];
      const error = mocks.partition.webRequest.onErrorOccurred.mock.calls.at(-1)![1];
      before({ id, url: origin, method: 'GET', webContentsId: target.webContents.id, resourceType: 'mainFrame' }, vi.fn());
      await client.revalidateAuthentication(client.pairingGeneration); await flush();
      expect(target.destroy).toHaveBeenCalledTimes(1);
      const headers = mocks.partition.webRequest.onHeadersReceived.mock.calls.at(-1)![1];
      const cancelled = vi.fn(); headers({ id, statusCode: 200, responseHeaders: {} }, cancelled);
      expect(cancelled).toHaveBeenCalledWith({ cancel: true, responseHeaders: {} });
      error({ id, error: errorCode });
      expect(client.authenticationState).toBe('verified');
      if (id === 32) { loading.resolve(); await pending; }
    }
    await flush();
    expect(client.authenticationState).toBe('verified');
    await client.refresh(); await client.allowOnce(`hermes/${approval.conversationId}/${approval.id}`);
    expect(mocks.partition.fetch).toHaveBeenLastCalledWith(expect.stringContaining('/approvals/demo-approval'), expect.objectContaining({ method: 'POST' }));
  });

  it.each(['/api/tasks', '/api/conversations'])('keeps approvals and their toast tickets across navigation cancellation of %s', async path => {
    const client = await start(); const target = mocks.windows[0]!;
    mocks.sockets[0]!.onopen?.({}); await flush();
    const activation = toastActivation('allow-once');
    const before = mocks.partition.webRequest.onBeforeRequest.mock.calls.at(-1)![1];
    const headers = mocks.partition.webRequest.onHeadersReceived.mock.calls.at(-1)![1];
    before({ id: 20, url: `${origin}${path}`, method: 'GET', webContentsId: target.webContents.id, resourceType: 'xhr' }, vi.fn());
    headers({ id: 20, statusCode: 200, responseHeaders: {} }, vi.fn());
    await target.loadURL(`${origin}/tasks`);
    mocks.partition.webRequest.onErrorOccurred.mock.calls.at(-1)![1]({ id: 20, error: 'net::ERR_ABORTED' });
    expect(client.authenticationState).toBe('verified'); expect(client.approvals.size).toBe(1);
    expect(mocks.notifications[0]!.close).not.toHaveBeenCalled();
    mocks.app.emit('second-instance', {}, [activation]); await flush();
    expect(mocks.partition.fetch.mock.calls.some(([url]) => String(url).includes('/approvals/'))).toBe(true);
  });

  it.each(['queued reload 401', 'app-document redirect'])('closes toasts and blocks their approval activation on %s', async (loss) => {
    const client = await start(); const target = mocks.windows[0]!;
    mocks.sockets[0]!.onopen?.({}); await flush();
    const activation = toastActivation('allow-once');
    const before = mocks.partition.webRequest.onBeforeRequest.mock.calls.at(-1)![1];
    const headers = mocks.partition.webRequest.onHeadersReceived.mock.calls.at(-1)![1];
    before({ id: 20, url: `${origin}${loss === 'queued reload 401' ? '/api/conversations' : '/chats'}`,
      method: 'GET', webContentsId: target.webContents.id, resourceType: loss === 'queued reload 401' ? 'xhr' : 'mainFrame' }, vi.fn());
    if (loss === 'queued reload 401') await target.loadURL(origin);
    headers({ id: 20, statusCode: loss === 'queued reload 401' ? 401 : 302, responseHeaders: {} }, vi.fn());
    if (loss === 'app-document redirect') {
      mocks.partition.webRequest.onBeforeRedirect.mock.calls.at(-1)![1]({ id: 20, redirectURL: 'https://access.example.com/login' });
    }
    expect(client.authenticationState).toBe('unverified');
    expect(mocks.notifications[0]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.tray.update.mock.calls.at(-1)![1]).toEqual([]);
    mocks.app.emit('second-instance', {}, [activation]); await flush();
    expect(mocks.partition.fetch.mock.calls.some(([url]) => String(url).includes('/approvals/'))).toBe(false);
    const probe = deferred<Response>(); mocks.partition.fetch.mockImplementationOnce(() => probe.promise);
    const check = client.revalidateAuthentication(0);
    expect(client.authenticationBlocked).toBe(true);
    expect(mocks.partition.fetch).toHaveBeenLastCalledWith(`${origin}/api/me`, expect.objectContaining({ method: 'GET' }));
    probe.resolve(json(identity)); await check; await flush();
    expect(client.authenticationState).toBe('verified');
  });

  it('checks the native session on startup and publishes suspension again into a reloaded document', async () => {
    const client = await start(); const old = mocks.windows[0]!;
    expect(mocks.partition.fetch).toHaveBeenCalledWith(`${origin}/api/me`, expect.objectContaining({ method: 'GET' }));
    client.suspend(0);
    const probe = deferred<Response>(); mocks.partition.fetch.mockImplementationOnce(() => probe.promise);
    await old.loadURL(origin); await flush();
    expect(old.webContents.send).toHaveBeenCalledWith('pairing:state', 'unverified', 0);
    expect(client.authenticationBlocked).toBe(true);
    probe.resolve(json(identity)); await flush();
    expect(client.authenticationState).toBe('verified');
    expect(old.destroy).toHaveBeenCalledTimes(1);
  });

  it.each(['pairing:anomaly', 'pairing:socket-closed'])('accepts %s only from the current main frame and generation', async (channel) => {
    const client = await start(); const old = mocks.windows[0]!; const event = frameEvent(old);
    mocks.ipcMain.emit(channel, { ...event, sender: {} }, 0, 4403);
    mocks.ipcMain.emit(channel, { ...event, senderFrame: { url: origin } }, 0, 4403);
    old.webContents.mainFrame.url = 'https://example.com/'; mocks.ipcMain.emit(channel, event, 0, 4403); old.webContents.mainFrame.url = origin;
    for (const generation of [undefined, null, '0', -1, 1, NaN, Infinity, {}]) mocks.ipcMain.emit(channel, event, generation, 4403);
    expect(client.authenticationState).toBe('verified');
    mocks.ipcMain.emit(channel, event, 0, 4403);
    expect(client.authenticationState).toBe('unverified');
    await client.revalidateAuthentication(0); await flush();
    expect(client.authenticationState).toBe('verified');
    mocks.ipcMain.emit(channel, event, 0, 4403);
    expect(client.authenticationState).toBe('verified');
  });

  it('ignores a renderer socket close without an authentication code', async () => {
    const client = await start();
    mocks.ipcMain.emit('pairing:socket-closed', frameEvent(), 0, 'demo-unexpected-code');
    expect(client.authenticationState).toBe('verified');
  });

  it.each([4401, 4403])('closes native toasts/tickets immediately on socket %s and prevents its old approval activation', async (code) => {
    const client = await start(); mocks.sockets[0]!.onopen?.({}); await flush();
    const activation = toastActivation('allow-once');
    mocks.partition.fetch.mockImplementation(async () => json({}, 503));
    mocks.sockets[0]!.onclose?.({ code });
    expect(mocks.notifications[0]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.tray.update.mock.calls.at(-1)![1]).toEqual([]);
    mocks.app.emit('second-instance', {}, [activation]); await flush();
    expect(mocks.partition.fetch.mock.calls.some(([url]) => String(url).includes('/approvals/'))).toBe(false);
    expect(client.authenticationState).toBe('unverified');
    expect(mocks.windows[0]!.webContents.send).toHaveBeenCalledWith('pairing:state', 'unverified', 0);
  });

  it.each(['native body pending', 'renderer body pending'])('quarantines delayed renderer socket revocation with %s replacement pairing', async (stage) => {
    const client = await start(); const old = mocks.windows[0]!;
    mocks.sockets[0]!.onopen?.({}); await flush();
    process.argv.push('--wayroost-pairing-generation=0');
    try { await import('../src/preload.js'); } finally { process.argv.pop(); }
    mocks.ipcRenderer.send.mockImplementation((channel, ...args) => mocks.ipcMain.emit(channel, frameEvent(old), ...args));
    const bridge = mocks.contextBridge.exposeInMainWorld.mock.calls[0]![1] as { socketClosed?(code: number): void; unpaired?(): void };
    const body = deferred<unknown>(); const reading = deferred<void>();
    const before = mocks.partition.webRequest.onBeforeRequest.mock.calls.at(-1)![1];
    const headers = mocks.partition.webRequest.onHeadersReceived.mock.calls.at(-1)![1];
    const complete = mocks.partition.webRequest.onCompleted.mock.calls.at(-1)![1];
    let pairing: Promise<unknown>;
    if (stage === 'native body pending') {
      mocks.partition.fetch.mockResolvedValueOnce({ status: 200, ok: true, json: () => { reading.resolve(); return body.promise; } });
      pairing = client.pair('demo-code', 'Demo desktop').catch((error: unknown) => error); await reading.promise;
    } else {
      before({ id: 20, url: `${origin}/api/pair`, method: 'POST', webContentsId: old.webContents.id }, vi.fn());
      headers({ id: 20, statusCode: 200, responseHeaders: {} }, vi.fn()); pairing = Promise.resolve();
    }
    if (bridge.socketClosed) bridge.socketClosed(4403); else bridge.unpaired?.();
    expect(client.unpaired).toBe(false);
    if (stage === 'native body pending') { body.resolve(identity); expect(await pairing).not.toBeInstanceOf(Error); }
    else { complete({ id: 20, statusCode: 200 }); await flush(); }
    expect(client.authenticationBlocked).toBe(false);
    expect(client.pairingGeneration).toBe(1);
    expect(old.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.windows.at(-1)!.loadURL).toHaveBeenCalledWith(origin);
  });

  it('immediately suspends native redirect rejections, clears toasts, and rejects late snapshots and POSTs', async () => {
    const client = await start(); mocks.sockets[0]!.onopen?.({}); await flush();
    const activation = toastActivation('allow-once');
    const body = deferred<unknown>(); const reading = deferred<void>();
    mocks.partition.fetch.mockResolvedValueOnce({ status: 200, ok: true, json: () => { reading.resolve(); return body.promise; } });
    const late = client.refresh().catch((error: unknown) => error); await reading.promise;
    mocks.partition.fetch.mockRejectedValueOnce(new TypeError('Demo redirect error'));
    await client.request('/api/me').catch(() => {});
    expect(client.authenticationBlocked).toBe(true);
    expect(mocks.notifications[0]!.close).toHaveBeenCalledTimes(1);
    body.resolve(list); expect(await late).toBeInstanceOf(Error);
    mocks.partition.fetch.mockImplementation(async () => json({}, 503));
    mocks.app.emit('second-instance', {}, [activation]); await flush();
    expect(client.approvals.size).toBe(0);
    expect(mocks.partition.fetch.mock.calls.some(([url]) => String(url).includes('/approvals/'))).toBe(false);
  });

  it('preload replays the latest main state and cannot forward another generation', async () => {
    const client = await start();
    process.argv.push('--wayroost-pairing-generation=0');
    try { await import('../src/preload.js'); } finally { process.argv.pop(); }
    const bridge = mocks.contextBridge.exposeInMainWorld.mock.calls[0]![1] as { anomaly(): void; onAuthentication(listener: (state: string) => void): void };
    const listener = vi.fn(); bridge.onAuthentication(listener); expect(listener).toHaveBeenCalledWith('unverified');
    mocks.ipcRenderer.emit('pairing:state', {}, 'verified', 0);
    expect(listener).toHaveBeenLastCalledWith('verified');
    mocks.ipcRenderer.emit('pairing:state', {}, 'verified', 1);
    expect(listener).toHaveBeenCalledTimes(2);
    mocks.ipcRenderer.emit('pairing:state', {}, 'unverified', 1);
    expect(listener).toHaveBeenLastCalledWith('unverified');
    bridge.anomaly(); expect(mocks.ipcRenderer.send).toHaveBeenCalledWith('pairing:anomaly', 0);
    expect(client.authenticationState).toBe('verified');
  });

  it('opens the native development socket on the app session with the desktop marker', async () => {
    await start();
    expect(mocks.socketOpened).toHaveBeenCalledExactlyOnceWith('ws://127.0.0.1:8896/ws', { session: mocks.partition, useSessionCookies: true, origin, headers: { 'x-wayroost-app': 'desktop' } });
  });

  it('ignores stale tray hints and removed renderer classification channels', async () => {
    const client = await start(); const calls = mocks.partition.fetch.mock.calls.length; const event = frameEvent();
    mocks.ipcMain.emit('tray:update', event, 1, { type: 'approval_upsert' });
    for (const channel of ['pairing:classified', 'pairing:revoked', 'pairing:expired', 'pairing:suspended']) mocks.ipcMain.emit(channel, event, 0, null, 'unpaired');
    await flush(); expect(client.authenticationState).toBe('verified');
    expect(mocks.partition.fetch).toHaveBeenCalledTimes(calls);
  });
});

describe('window visibility through authentication recovery', () => {
  it.each(['ordinary', 'hidden', 'closed'])('preserves the %s launch preference through verified replacement', async (visibility) => {
    const client = await start(visibility === 'hidden'); const old = mocks.windows[0]!;
    if (visibility === 'closed') old.events.emit('close', { preventDefault: vi.fn() });
    await unpair(client);
    expect(old.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.windows.at(-1)!.loadURL).toHaveBeenCalledWith(`${origin}/pair`);
    expect(mocks.windows.at(-1)!.isVisible()).toBe(visibility === 'ordinary');
    await client.pair('demo-code', 'Demo desktop'); await flush();
    expect(mocks.windows.at(-1)!.loadURL).toHaveBeenCalledWith(origin);
    expect(mocks.windows.at(-1)!.isVisible()).toBe(visibility === 'ordinary');
    expect(mocks.app.quit).not.toHaveBeenCalled();
  });

  it.each(['tray', 'activate', 'second-instance'])('keeps recovery in front on %s until a verified app document commits', async (action) => {
    const client = await start();
    mocks.loadFailure.mockImplementation((url) => url === `${origin}/pair` ? -102 : undefined);
    await unpair(client); const pairing = mocks.windows[1]!; const rescue = mocks.windows[2]!;
    expect(rescue.isVisible()).toBe(true);
    const commit = deferred<void>();
    mocks.loadPending.mockImplementation((url, stage) => url === origin && stage === 'commit' ? commit.promise : undefined);
    await client.pair('demo-code', 'Demo desktop'); await flush(); const current = mocks.windows[3]!;
    if (action === 'tray') mocks.tray.open(); else if (action === 'activate') mocks.app.emit('activate'); else mocks.app.emit('second-instance', {}, []);
    await flush(); expect(rescue.isVisible()).toBe(true); expect(current.isVisible()).toBe(false);
    commit.resolve(); await flush(); expect(rescue.isVisible()).toBe(false); expect(current.isVisible()).toBe(true);
    expect(pairing.destroy).toHaveBeenCalledTimes(1);
  });

  it.each(['ordinary', 'hidden'])('honors closing an %s replacement window before its pending load fails', async (visibility) => {
    const client = await start(visibility === 'hidden');
    const commit = deferred<void>();
    mocks.loadPending.mockImplementation((url, stage) => url.endsWith('/pair') && stage === 'commit' ? commit.promise : undefined);
    mocks.loadFailure.mockImplementation((url) => url.endsWith('/pair') ? -102 : undefined);
    await unpair(client); const pairing = mocks.windows[1]!;
    pairing.events.emit('close', { preventDefault: vi.fn() }); commit.resolve(); await flush();
    expect(pairing.isVisible()).toBe(false); expect(mocks.windows[2]!.isVisible()).toBe(false);
    mocks.loadFailure.mockReset(); await vi.advanceTimersByTimeAsync(2000);
    expect(pairing.isVisible()).toBe(false); expect(mocks.windows[2]!.isVisible()).toBe(false);
  });

  it.each(['ready', 'loading'])('honors closing %s recovery while the replacement document is pending', async (readiness) => {
    const client = await start();
    const rescueLoad = deferred<void>();
    if (readiness === 'loading') mocks.loadFilePending.mockImplementation(() => rescueLoad.promise);
    mocks.windows[0]!.webContents.emit('did-fail-load', {}, -102, 'Demo load failed', origin, true); await flush();
    const rescue = mocks.windows[1]!; const commit = deferred<void>();
    mocks.loadPending.mockImplementation((url, stage) => url.endsWith('/pair') && stage === 'commit' ? commit.promise : undefined);
    await unpair(client); const pairing = mocks.windows[2]!;
    rescue.events.emit('close', { preventDefault: vi.fn() }); rescueLoad.resolve(); await flush();
    commit.resolve(); await flush(); expect(rescue.isVisible()).toBe(false); expect(pairing.isVisible()).toBe(false);
  });

  it.each(['visible', 'hidden', 'closed'])('retries a failed pairing page while preserving %s visibility and blocked authentication', async (visibility) => {
    const client = await start(visibility === 'hidden');
    if (visibility === 'closed') mocks.windows[0]!.events.emit('close', { preventDefault: vi.fn() });
    mocks.loadFailure.mockImplementation((url) => url.endsWith('/pair') ? -102 : undefined);
    await unpair(client); const pairing = mocks.windows[1]!; const rescue = mocks.windows[2]!;
    expect(rescue.isVisible()).toBe(visibility === 'visible'); expect(client.authenticationState).toBe('unpaired');
    mocks.loadFailure.mockReset(); await vi.advanceTimersByTimeAsync(2000);
    expect(rescue.isVisible()).toBe(false); expect(pairing.isVisible()).toBe(visibility === 'visible');
    expect(client.authenticationBlocked).toBe(true);
  });

  it.each(['open', 'allow-once'])('carries a hidden %s activation into the current pairing surface after the fresh check reports unpaired', async (action) => {
    const client = await start(true); mocks.sockets[0]!.onopen?.({}); await flush();
    const activation = toastActivation(action);
    mocks.partition.fetch.mockResolvedValue(json({ error: 'unpaired' }, 401));
    mocks.app.emit('second-instance', {}, [activation]); await flush();
    await client.revalidateAuthentication(0); await flush();
    expect(mocks.windows.at(-1)!.isVisible()).toBe(true);
    expect(mocks.partition.fetch.mock.calls.some(([url]) => String(url).includes('/approvals/'))).toBe(false);
  });

  it.each(['commit', 'finish'])('preserves launch intent when the initial page is waiting for %s during revocation', async (stage) => {
    const pending = deferred<void>(); mocks.loadPending.mockImplementation((url, current) => url === origin && current === stage ? pending.promise : undefined);
    const client = await start(); await unpair(client);
    expect(mocks.windows[0]!.show).not.toHaveBeenCalled(); expect(mocks.windows[1]!.isVisible()).toBe(true);
    pending.resolve(); await flush(); expect(mocks.windows[0]!.show).not.toHaveBeenCalled();
  });

  it('keeps recovery visible on an activation while a new pairing generation is pending', async () => {
    const client = await start();
    mocks.windows[0]!.webContents.emit('did-fail-load', {}, -102, 'Demo failure', origin, true); await flush();
    const rescue = mocks.windows[1]!;
    const body = deferred<unknown>(); const reading = deferred<void>();
    mocks.partition.fetch.mockResolvedValueOnce({ status: 200, ok: true, json: () => { reading.resolve(); return body.promise; } });
    const pairing = client.pair('demo-code', 'Demo desktop').catch((error: unknown) => error); await reading.promise;
    mocks.tray.open(); mocks.app.emit('activate'); await flush(); expect(rescue.isVisible()).toBe(true);
    body.resolve(identity); await pairing; await flush(); expect(mocks.windows.at(-1)!.isVisible()).toBe(true);
  });
});

const serverPin = 'sha256/' + Buffer.alloc(32, 1).toString('base64');
const rescuePin = 'sha256/' + Buffer.alloc(32, 2).toString('base64');
const token = JSON.stringify({ code: 'a'.repeat(26), serverPin, rescuePin });
async function production(saved: { serverPin: string; rescuePin: string } | null = { serverPin, rescuePin }, packaged = true) {
  vi.useFakeTimers();
  const argv = process.argv;
  process.argv = argv.filter(arg => arg !== '--wayroost-desktop-dev');
  mocks.app.isPackaged = packaged;
  if (saved) mocks.files.set(demoPath('listener-pins'), Buffer.from(JSON.stringify(saved)));
  mocks.files.set(demoPath('rescue-key'), Buffer.from('demo-rescue-key'));
  mocks.partition.fetch.mockImplementation(async url => json(String(url).endsWith('/api/me') ? identity : list));
  const { ServerClient } = await import('../src/server-client.js');
  const connection = vi.spyOn(ServerClient.prototype, 'connect');
  try { await import('../src/main.js'); await flush(); }
  finally { process.argv = argv; }
  const client = connection.mock.contexts[0] as InstanceType<typeof ServerClient>;
  connection.mockRestore();
  return client;
}
const rescueRequest = () => {
  const handler = mocks.ipcMain.handle.mock.calls.find(([name]) => name === 'rescue:request')![1] as (event: unknown, action: string, setup?: unknown) => Promise<{ sentence: string }>;
  const page = mocks.windows.find(item => item.loadFile.mock.calls.length)!;
  return (action: string, setup?: unknown) => handler(frameEvent(page), action, setup);
};
const headerGuard = (rescue = false) => (rescue ? mocks.rescueSession : mocks.partition).webRequest.onBeforeSendHeaders.mock.calls.at(-1)![1] as (details: unknown, callback: ReturnType<typeof vi.fn>) => void;

describe('protocol launch isolation', () => {
  it('replays the registered development command without opening installed credentials', async () => {
    await start(); mocks.sockets[0]!.onopen?.({}); await flush();
    const [scheme, executable, args] = mocks.app.setAsDefaultProtocolClient.mock.calls[0]! as [string, string, string[]];
    const activation = toastActivation('open');
    reset();
    vi.useFakeTimers();
    const savedPins = Buffer.from(JSON.stringify({ serverPin, rescuePin }));
    const savedKey = Buffer.from('demo-installed-key');
    mocks.files.set(demoPath('listener-pins'), savedPins);
    mocks.files.set(demoPath('rescue-key'), savedKey);
    mocks.files.set(demoPath('wayroost-desktop-dev', 'rescue-key'), Buffer.from('demo-dev-key'));
    mocks.partition.fetch.mockImplementation(async url => json(String(url).endsWith('/api/me') ? identity : list));
    const argv = process.argv;
    try {
      process.argv = [executable, ...args, activation];
      await import('../src/main.js'); await flush();
      await vi.advanceTimersByTimeAsync(10000);
    } finally { process.argv = argv; }
    expect(mocks.app.setPath).toHaveBeenCalledWith('userData', demoPath('wayroost-desktop-dev'));
    expect(mocks.app.setPath).toHaveBeenCalledWith('sessionData', demoPath('wayroost-desktop-dev'));
    expect(mocks.app.setPath.mock.invocationCallOrder[0]).toBeLessThan(mocks.app.requestSingleInstanceLock.mock.invocationCallOrder[0]!);
    expect(mocks.fs.readFileSync.mock.calls.every(([path]) => ![demoPath('listener-pins'), demoPath('rescue-key')].includes(path))).toBe(true);
    expect(mocks.storage.decryptString).not.toHaveBeenCalledWith(savedPins);
    expect(mocks.storage.decryptString).not.toHaveBeenCalledWith(savedKey);
    expect(mocks.rescueCredentials).toHaveBeenCalledWith('demo-dev-key', undefined);
    expect(mocks.rescueCredentials.mock.calls.every(([key, pin]) => key === 'demo-dev-key' && pin === undefined)).toBe(true);
    expect(mocks.files.get(demoPath('listener-pins'))).toBe(savedPins);
    expect(mocks.files.get(demoPath('rescue-key'))).toBe(savedKey);
    expect(mocks.fs.writeFileSync).not.toHaveBeenCalled();
    expect(mocks.app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(mocks.windows[0]!.loadURL).toHaveBeenCalledWith(origin);
    expect(mocks.windows[0]!.isVisible()).toBe(true);
    expect(mocks.partition.fetch.mock.calls.every(([url]) => String(url).startsWith(origin))).toBe(true);
    expect(scheme).toBe('wayroost-dev');
    expect(activation).toMatch(/^wayroost-dev:\/\//);
    expect(args).toEqual([home, '--wayroost-desktop-dev']);
    expect(mocks.app.setAsDefaultProtocolClient).toHaveBeenCalledExactlyOnceWith(scheme, executable, args);
  });
  it.each(['second-instance', 'open-url'])('keeps development %s activations in isolated storage', async event => {
    const savedPins = Buffer.from(JSON.stringify({ serverPin, rescuePin }));
    const savedKey = Buffer.from('demo-installed-key');
    mocks.files.set(demoPath('listener-pins'), savedPins);
    mocks.files.set(demoPath('rescue-key'), savedKey);
    mocks.files.set(demoPath('wayroost-desktop-dev', 'rescue-key'), Buffer.from('demo-dev-key'));
    await start(); mocks.sockets[0]!.onopen?.({}); await flush();
    const [scheme, executable, args] = mocks.app.setAsDefaultProtocolClient.mock.calls[0]! as [string, string, string[]];
    const activation = toastActivation('open');
    if (event === 'second-instance') mocks.app.emit(event, {}, [executable, ...args, activation]);
    else {
      const preventDefault = vi.fn(); mocks.app.emit(event, { preventDefault }, activation);
      expect(preventDefault).toHaveBeenCalledOnce();
    }
    await flush();
    expect(mocks.windows[0]!.loadURL).toHaveBeenCalledWith(`${origin}/c/hermes/demo%3Achat#approval-demo-approval`);
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.storage.decryptString).not.toHaveBeenCalledWith(savedPins);
    expect(mocks.storage.decryptString).not.toHaveBeenCalledWith(savedKey);
    expect(mocks.rescueCredentials).toHaveBeenCalledWith('demo-dev-key', undefined);
    expect(mocks.rescueCredentials.mock.calls.every(([key, pin]) => key === 'demo-dev-key' && pin === undefined)).toBe(true);
    expect(mocks.fs.readFileSync.mock.calls.every(([path]) => path.startsWith(demoPath('wayroost-desktop-dev') + sep))).toBe(true);
    expect(mocks.app.setAsDefaultProtocolClient).toHaveBeenCalledExactlyOnceWith('wayroost-dev', executable, [home, '--wayroost-desktop-dev']);
    expect(scheme).toBe('wayroost-dev');
  });
  it('keeps packaged protocol registration and transports pinned even with a development flag', async () => {
    const argv = process.argv;
    try {
      process.argv = [...argv, '--wayroost-desktop-dev'];
      mocks.app.isPackaged = true;
      await start();
    } finally { process.argv = argv; }
    expect(mocks.app.setAsDefaultProtocolClient).toHaveBeenCalledExactlyOnceWith('wayroost', process.execPath, []);
    expect(mocks.app.setPath).not.toHaveBeenCalled();
    expect(mocks.partition.setCertificateVerifyProc).toHaveBeenCalledOnce();
    expect(mocks.rescueSession.setCertificateVerifyProc).toHaveBeenCalledOnce();
    expect(mocks.partition.fetch).not.toHaveBeenCalled();
    expect(mocks.sockets).toHaveLength(0);
  });
  it('selects isolated storage before a second development process exits at the instance lock', async () => {
    mocks.files.set(demoPath('listener-pins'), Buffer.from(JSON.stringify({ serverPin, rescuePin })));
    mocks.files.set(demoPath('rescue-key'), Buffer.from('demo-installed-key'));
    mocks.app.requestSingleInstanceLock.mockReturnValueOnce(false);
    await start();
    expect(mocks.app.setPath).toHaveBeenCalledWith('userData', demoPath('wayroost-desktop-dev'));
    expect(mocks.app.setPath.mock.invocationCallOrder[0]).toBeLessThan(mocks.app.requestSingleInstanceLock.mock.invocationCallOrder[0]!);
    expect(mocks.app.quit).toHaveBeenCalledOnce();
    expect(mocks.fs.readFileSync).not.toHaveBeenCalled();
    expect(mocks.storage.decryptString).not.toHaveBeenCalled();
    expect(mocks.app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });
  it('preserves the installed protocol for unpackaged HTTPS launches', async () => {
    await production({ serverPin, rescuePin }, false);
    expect(mocks.app.setAsDefaultProtocolClient).toHaveBeenCalledExactlyOnceWith('wayroost', process.execPath, [home]);
    expect(mocks.app.setPath).not.toHaveBeenCalled();
    expect(mocks.partition.fetch).toHaveBeenCalledWith('https://127.0.0.1:8881/api/me', expect.anything());
  });
});

describe('automatic login registration', () => {
  it('leaves installed autostart untouched on the first development launch', async () => {
    mocks.files.set(demoPath('login-configured'), Buffer.from('1'));
    await start();
    expect(mocks.app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(mocks.fs.writeFileSync.mock.calls.some(([path]) => path.endsWith('login-configured'))).toBe(false);
    expect(mocks.files.has(demoPath('wayroost-desktop-dev', 'login-configured'))).toBe(false);
  });
  it('also skips automatic registration for unpackaged pinned HTTPS launches', async () => {
    await production({ serverPin, rescuePin }, false);
    expect(mocks.app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(mocks.files.has(demoPath('login-configured'))).toBe(false);
  });
  it('registers a packaged first launch to start hidden and saves its marker', async () => {
    await production();
    expect(mocks.app.setLoginItemSettings).toHaveBeenCalledExactlyOnceWith({ openAtLogin: true, args: ['--hidden'] });
    expect(mocks.files.get(demoPath('login-configured'))).toBe('1');
  });
  it('preserves the installed login preference after it has been configured', async () => {
    mocks.files.set(demoPath('login-configured'), Buffer.from('1'));
    await production();
    expect(mocks.app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(mocks.fs.writeFileSync.mock.calls.some(([path]) => path.endsWith('login-configured'))).toBe(false);
  });
});

describe('production TLS wiring', () => {
  it('installs both certificate verifiers and request gates before the first app load, fetch or socket', async () => {
    await production();
    const before = Math.min(mocks.windows[0]!.loadURL.mock.invocationCallOrder[0]!, mocks.partition.fetch.mock.invocationCallOrder[0]!, mocks.socketOpened.mock.invocationCallOrder[0]!);
    for (const hook of [mocks.partition.setCertificateVerifyProc, mocks.rescueSession.setCertificateVerifyProc, mocks.partition.webRequest.onBeforeSendHeaders, mocks.rescueSession.webRequest.onBeforeSendHeaders]) {
      expect(hook).toHaveBeenCalledOnce();
      expect(hook.mock.invocationCallOrder[0]).toBeLessThan(before);
    }
    for (const url of ['https://127.0.0.1:8881/api/me', 'wss://127.0.0.1:8881/ws']) {
      const callback = vi.fn(); headerGuard()({ url, requestHeaders: { Cookie: 'wr_device=demo-cookie' } }, callback);
      expect(callback).toHaveBeenCalledWith({ requestHeaders: { Cookie: 'wr_device=demo-cookie', 'x-wayroost-app': 'desktop' } });
    }
    for (const url of ['http://127.0.0.1:8881', 'https://127.0.0.1:8880', 'https://example.com']) {
      const callback = vi.fn(); headerGuard()({ url, requestHeaders: {} }, callback); expect(callback).toHaveBeenCalledWith({ cancel: true });
    }
    const callback = vi.fn(); headerGuard(true)({ url: 'https://127.0.0.1:8881/api/me' }, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: true });
  });
  it('sends the desktop marker on the native socket only to the pinned app origin, after the certificate verifier', async () => {
    await production();
    expect(mocks.socketOpened).toHaveBeenCalledExactlyOnceWith('wss://127.0.0.1:8881/ws', { session: mocks.partition, useSessionCookies: true, origin: 'https://127.0.0.1:8881', headers: { 'x-wayroost-app': 'desktop' } });
    expect(mocks.partition.setCertificateVerifyProc.mock.invocationCallOrder[0]).toBeLessThan(mocks.socketOpened.mock.invocationCallOrder[0]!);
    expect(mocks.socketOpened.mock.calls.every(([, options]) => (options as { session: unknown }).session !== mocks.rescueSession)).toBe(true);
  });
  it.each([undefined, { serverPin: '', rescuePin }])('blocks every app request and opens no native socket without a server pin (%j)', async saved => {
    const client = await production(saved ?? null);
    const callback = vi.fn(); headerGuard()({ url: 'https://127.0.0.1:8881/api/me', requestHeaders: {} }, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: true });
    expect(mocks.partition.fetch).not.toHaveBeenCalled(); expect(mocks.sockets).toHaveLength(0);
    expect(mocks.windows[0]!.loadURL).not.toHaveBeenCalled();
    await expect(client.refresh()).rejects.toThrow('sign-in is checked');
    await client.revalidateAuthentication(client.pairingGeneration);
    expect(mocks.partition.fetch).not.toHaveBeenCalled(); expect(mocks.sockets).toHaveLength(0);
    expect(mocks.windows.filter(item => item.loadFile.mock.calls.length)).toHaveLength(1);
  });
  it('isolates development key and cookie storage before taking the single instance lock', async () => {
    mocks.files.set(demoPath('rescue-key'), Buffer.from('demo-installed-key'));
    await start(); await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.app.setPath).toHaveBeenCalledWith('userData', demoPath('wayroost-desktop-dev'));
    expect(mocks.app.setPath).toHaveBeenCalledWith('sessionData', demoPath('wayroost-desktop-dev'));
    expect(mocks.app.setPath.mock.invocationCallOrder[0]).toBeLessThan(mocks.app.requestSingleInstanceLock.mock.invocationCallOrder[0]!);
    expect(mocks.fs.readFileSync.mock.calls.every(([path]) => ![demoPath('rescue-key'), demoPath('listener-pins')].includes(path))).toBe(true);
  });
  it('keeps a healthy app visible through repeated supervisor identity failures and clears them on success', async () => {
    const { ListenerIdentityError } = await import('../src/tls.js');
    mocks.rescueStatus.mockRejectedValue(new ListenerIdentityError());
    await production();
    const appWindow = mocks.windows[0]!;
    expect(appWindow.visible).toBe(true);
    await vi.advanceTimersByTimeAsync(20000);
    await appWindow.loadURL('https://127.0.0.1:8881'); await flush();
    expect(appWindow.visible).toBe(true); expect(mocks.windows).toHaveLength(1);
    expect(mocks.tray.update.mock.calls.at(-1)![0].sentence).toContain('supervisor');
    mocks.rescueStatus.mockResolvedValue({ overall: 'ok', sentence: 'Demo is running.', components: [], at: 0 });
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.tray.update.mock.calls.at(-1)![0].sentence).not.toContain('fingerprint');
  });
  it('reopens recovery beside a healthy app after supervisor rotation and requires a fresh token to re-pin', async () => {
    const { ListenerIdentityError } = await import('../src/tls.js');
    mocks.rescueStatus.mockRejectedValue(new ListenerIdentityError());
    await production();
    await vi.advanceTimersByTimeAsync(20000);
    const appWindow = mocks.windows[0]!;
    mocks.tray.setup(); await flush();
    const page = mocks.windows.find(item => item.loadFile.mock.calls.length);
    expect(page).toBeDefined();
    expect(page!.webContents.send).toHaveBeenCalledWith('rescue:mode', 'setup');
    expect(page!.isVisible()).toBe(true); expect(appWindow.isVisible()).toBe(true);
    page!.events.emit('close', { preventDefault: vi.fn() });
    expect(page!.isVisible()).toBe(false); expect(appWindow.isVisible()).toBe(true);
    mocks.tray.setup(); await flush();
    expect(page!.isVisible()).toBe(true);
    expect(mocks.windows).toHaveLength(2);
    const rotatedPin = 'sha256/' + Buffer.alloc(32, 3).toString('base64');
    const request = rescueRequest();
    expect((await request('setup', { key: 'demo-rescue-key', rescuePin: rotatedPin })).sentence).toContain('fresh desktop pairing token');
    expect(mocks.rescueKeyCheck).not.toHaveBeenCalled(); expect(mocks.pairPinned).not.toHaveBeenCalled();
    mocks.rescueKeyCheck.mockResolvedValue({}); mocks.pairPinned.mockResolvedValue('demo-cookie');
    const rotatedToken = JSON.stringify({ code: 'b'.repeat(26), serverPin, rescuePin: rotatedPin });
    expect((await request('setup', { code: rotatedToken, key: 'demo-rescue-key' })).sentence).toContain('Desktop paired');
    const options = mocks.rescueKeyCheck.mock.calls[0]![2];
    expect(options.pin()).toBe(rotatedPin);
    expect(mocks.pairPinned).toHaveBeenCalledWith('https://127.0.0.1:8881', { code: 'b'.repeat(26), serverPin, rescuePin: rotatedPin });
    expect(JSON.parse(mocks.files.get(demoPath('listener-pins'))!.toString())).toEqual({ serverPin, rescuePin: rotatedPin });
    expect(mocks.app.relaunch).toHaveBeenCalledOnce(); expect(mocks.app.quit).toHaveBeenCalledOnce();
  });
  it('does not poll an untrusted supervisor or repeatedly focus recovery on upgrades', async () => {
    await production(null);
    const page = mocks.windows.find(item => item.loadFile.mock.calls.length)!;
    const focuses = page.focus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(mocks.rescueStatus).not.toHaveBeenCalled();
    expect(page.focus).toHaveBeenCalledTimes(focuses);
    expect((await rescueRequest()('status')).sentence).toContain('has not been trusted');
  });
  it('keeps the last verified status unchanged when reporting a rescue certificate failure', async () => {
    const snapshot = { overall: 'ok', sentence: 'Demo is running.', components: [], at: 0 };
    mocks.rescueStatus.mockResolvedValue(snapshot);
    const client = await production();
    const verify = mocks.rescueSession.setCertificateVerifyProc.mock.calls[0]![0];
    verify({ hostname: '127.0.0.1', certificate: { data: 'demo-invalid-cert' } }, vi.fn());
    await client.refresh(); await client.refresh();
    expect(snapshot.sentence).toBe('Demo is running.');
    expect(mocks.tray.update.mock.calls.at(-1)![0].sentence.match(/This is not your Wayroost supervisor/g)).toHaveLength(1);
    expect(mocks.windows[0]!.visible).toBe(true);
  });
  it('clears a server identity error after the next verified app response', async () => {
    const client = await production();
    const verify = mocks.partition.setCertificateVerifyProc.mock.calls[0]![0];
    verify({ hostname: '127.0.0.1', certificate: { data: 'demo-invalid-cert' } }, vi.fn()); await flush();
    expect((await rescueRequest()('status')).sentence).toContain('This is not your Wayroost server');
    await client.refresh(); await flush();
    expect((await rescueRequest()('status')).sentence).toContain('Demo is running.');
  });
  it('validates a rescue key before spending a token, then saves pins before cookies and relaunch', async () => {
    await production(null);
    const request = rescueRequest();
    mocks.rescueKeyCheck.mockRejectedValueOnce(new Error('Demo key refused'));
    expect((await request('setup', { code: token, key: 'demo-incorrect-key' })).sentence).toBe('Demo key refused');
    expect(mocks.pairPinned).not.toHaveBeenCalled();
    mocks.rescueKeyCheck.mockResolvedValue({}); mocks.pairPinned.mockResolvedValue('demo-cookie');
    expect((await request('setup', { code: token, key: 'demo-rescue-key' })).sentence).toContain('Desktop paired');
    expect(mocks.rescueKeyCheck.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.pairPinned.mock.invocationCallOrder[0]!);
    const pinWrite = mocks.fs.writeFileSync.mock.calls.findIndex(([path]) => path.endsWith('listener-pins'));
    const keyWrite = mocks.fs.writeFileSync.mock.calls.findIndex(([path]) => path.endsWith('rescue-key'));
    expect(mocks.fs.writeFileSync.mock.invocationCallOrder[pinWrite]).toBeLessThan(mocks.fs.writeFileSync.mock.invocationCallOrder[keyWrite]!);
    expect(mocks.fs.writeFileSync.mock.invocationCallOrder[pinWrite]).toBeLessThan(mocks.partition.cookies.set.mock.invocationCallOrder[0]!);
    expect(mocks.partition.cookies.flushStore.mock.invocationCallOrder[0]).toBeLessThan(mocks.app.relaunch.mock.invocationCallOrder[0]!);
    expect(JSON.parse(mocks.files.get(demoPath('listener-pins'))!.toString())).toEqual({ serverPin, rescuePin });
  });
  it.each(['closeAllConnections', 'clearStorageData', 'clearCache'] as const)('blocks rescue traffic while replacement credentials await %s and relaunch', async stage => {
    await production(); mocks.tray.setup(); await flush();
    const request = rescueRequest();
    const rotatedPin = 'sha256/' + Buffer.alloc(32, 3).toString('base64');
    const rotatedToken = JSON.stringify({ code: 'b'.repeat(26), serverPin, rescuePin: rotatedPin });
    const cleanup = deferred<void>();
    mocks.partition[stage].mockImplementationOnce(() => cleanup.promise);
    mocks.rescueKeyCheck.mockResolvedValue({}); mocks.pairPinned.mockResolvedValue('demo-cookie');
    const pairing = request('setup', { code: rotatedToken, key: 'demo-replacement-key' });
    await flush();
    expect(mocks.partition[stage]).toHaveBeenCalled();
    const sent = mocks.rescueCredentials.mock.calls.length;
    const callback = vi.fn(); headerGuard(true)({ url: 'https://127.0.0.1:8880/v1/status' }, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: true });
    await vi.advanceTimersByTimeAsync(20000);
    for (const action of ['status', 'restart', 'setup']) {
      expect((await request(action, { code: rotatedToken, key: 'demo-replacement-key' })).sentence).toMatch(/in progress|identity is changing/);
    }
    expect(mocks.rescueCredentials).toHaveBeenCalledTimes(sent);
    expect(mocks.rescueCredentials.mock.calls.every(([key, pin]) => key === 'demo-rescue-key' && pin === rescuePin)).toBe(true);
    expect(mocks.rescueRestart).not.toHaveBeenCalled();
    cleanup.resolve();
    expect((await pairing).sentence).toContain('Desktop paired');
    expect(mocks.files.get(demoPath('rescue-key'))!.toString()).toBe('demo-replacement-key');
    expect(JSON.parse(mocks.files.get(demoPath('listener-pins'))!.toString()).rescuePin).toBe(rotatedPin);
    await vi.advanceTimersByTimeAsync(10000);
    expect((await request('status')).sentence).toContain('identity is changing');
    expect(mocks.rescueCredentials).toHaveBeenCalledTimes(sent);
  });
  it('pauses rescue during validation and resumes the old credential after a refused replacement', async () => {
    await production(); mocks.tray.setup(); await flush();
    const request = rescueRequest();
    const validation = deferred<unknown>();
    mocks.rescueKeyCheck.mockImplementationOnce(() => validation.promise);
    const pairing = request('setup', { code: token, key: 'demo-replacement-key' });
    const sent = mocks.rescueCredentials.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect((await request('restart')).sentence).toContain('in progress');
    expect(mocks.rescueCredentials).toHaveBeenCalledTimes(sent);
    validation.reject(new Error('Demo key refused'));
    expect((await pairing).sentence).toBe('Demo key refused');
    expect((await request('status')).sentence).toContain('Demo is running');
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.rescueCredentials.mock.calls.length).toBeGreaterThan(sent);
    expect(mocks.rescueCredentials.mock.calls.every(([key, pin]) => key === 'demo-rescue-key' && pin === rescuePin)).toBe(true);
    expect(mocks.files.get(demoPath('rescue-key'))!.toString()).toBe('demo-rescue-key');
    expect(mocks.pairPinned).not.toHaveBeenCalled();
  });
  it.each(['cleanup', 'pin storage'] as const)('keeps rescue blocked without publishing a replacement key if %s fails', async failure => {
    await production(); mocks.tray.setup(); await flush();
    const request = rescueRequest();
    mocks.rescueKeyCheck.mockResolvedValue({}); mocks.pairPinned.mockResolvedValue('demo-cookie');
    const replace = () => request('setup', { code: token, key: 'demo-replacement-key' });
    const error = new Error('Demo persistence failed');
    if (failure === 'cleanup') {
      mocks.partition.clearCache.mockRejectedValueOnce(error);
      expect((await replace()).sentence).toBe(error.message);
    } else {
      await mocks.fs.writeFileSync.withImplementation((path, value) => {
        if (path.endsWith('listener-pins')) throw error;
        return mocks.files.set(path, value);
      }, async () => { expect((await replace()).sentence).toBe(error.message); });
    }
    expect(mocks.files.get(demoPath('rescue-key'))!.toString()).toBe('demo-rescue-key');
    const sent = mocks.rescueCredentials.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20000);
    for (const action of ['status', 'restart', 'setup']) expect((await request(action)).sentence).toContain('identity is changing');
    expect(mocks.rescueCredentials).toHaveBeenCalledTimes(sent);
    expect(mocks.app.relaunch).not.toHaveBeenCalled();
  });
  it('keeps a published replacement key bound to its new pin if cookie persistence fails', async () => {
    await production(); mocks.tray.setup(); await flush();
    const request = rescueRequest();
    const rotatedPin = 'sha256/' + Buffer.alloc(32, 3).toString('base64');
    const rotatedToken = JSON.stringify({ code: 'b'.repeat(26), serverPin, rescuePin: rotatedPin });
    mocks.rescueKeyCheck.mockResolvedValue({}); mocks.pairPinned.mockResolvedValue('demo-cookie');
    mocks.partition.cookies.flushStore.mockRejectedValueOnce(new Error('Demo cookie persistence failed'));
    expect((await request('setup', { code: rotatedToken, key: 'demo-replacement-key' })).sentence).toBe('Demo cookie persistence failed');
    expect(mocks.files.get(demoPath('rescue-key'))!.toString()).toBe('demo-replacement-key');
    expect(JSON.parse(mocks.files.get(demoPath('listener-pins'))!.toString()).rescuePin).toBe(rotatedPin);
    const sent = mocks.rescueCredentials.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect((await request('status')).sentence).toContain('identity is changing');
    expect(mocks.rescueCredentials).toHaveBeenCalledTimes(sent);
  });
  it('discards a poll completing under the old identity during replacement cleanup', async () => {
    await production(); mocks.tray.setup(); await flush();
    const request = rescueRequest();
    const status = deferred<{ overall: string; sentence: string; components: never[]; at: number }>();
    mocks.rescueStatus.mockImplementationOnce(() => status.promise);
    await vi.advanceTimersByTimeAsync(10000);
    const cleanup = deferred<void>(); mocks.partition.clearCache.mockImplementationOnce(() => cleanup.promise);
    mocks.rescueKeyCheck.mockResolvedValue({}); mocks.pairPinned.mockResolvedValue('demo-cookie');
    const pairing = request('setup', { code: token, key: 'demo-replacement-key' }); await flush();
    mocks.tray.update.mockClear();
    status.resolve({ overall: 'ok', sentence: 'Demo old supervisor answer.', components: [], at: 0 }); await flush();
    expect(mocks.tray.update).not.toHaveBeenCalled();
    cleanup.resolve(); await pairing;
  });
  it('keeps rescue-only key replacement paused until the new process starts', async () => {
    await production(); mocks.tray.setup(); await flush();
    const request = rescueRequest();
    const validation = deferred<unknown>(); mocks.rescueKeyCheck.mockImplementationOnce(() => validation.promise);
    const pairing = request('setup', { key: 'demo-replacement-key' });
    const sent = mocks.rescueCredentials.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect((await request('status')).sentence).toContain('in progress');
    validation.resolve({});
    expect((await pairing).sentence).toBe('Rescue key saved.');
    await vi.advanceTimersByTimeAsync(10000);
    expect((await request('restart')).sentence).toContain('identity is changing');
    expect(mocks.rescueCredentials).toHaveBeenCalledTimes(sent);
    expect(mocks.files.get(demoPath('rescue-key'))!.toString()).toBe('demo-replacement-key');
    expect(mocks.app.relaunch).toHaveBeenCalledOnce();
  });
  it('resumes development rescue after saving only the isolated development key', async () => {
    mocks.files.set(demoPath('rescue-key'), Buffer.from('demo-installed-key'));
    mocks.files.set(demoPath('wayroost-desktop-dev', 'rescue-key'), Buffer.from('demo-dev-key'));
    await start(); mocks.tray.setup(); await flush();
    const request = rescueRequest();
    mocks.rescueKeyCheck.mockResolvedValue({});
    expect((await request('setup', { key: 'demo-replacement-key' })).sentence).toBe('Rescue key saved.');
    expect((await request('status')).sentence).toContain('Demo is running');
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.rescueCredentials).toHaveBeenLastCalledWith('demo-replacement-key', undefined);
    expect(mocks.files.get(demoPath('rescue-key'))!.toString()).toBe('demo-installed-key');
    expect(mocks.app.relaunch).not.toHaveBeenCalled();
  });
  it('requires an explicit rescue-only fingerprint and a fresh token for changing a saved fingerprint', async () => {
    await production({ serverPin: '', rescuePin });
    const request = rescueRequest();
    expect((await request('setup', { key: 'demo-rescue-key', rescuePin: serverPin })).sentence).toContain('fresh desktop pairing token');
    expect(mocks.rescueKeyCheck).not.toHaveBeenCalled();
    expect((await request('setup', { key: 'demo-rescue-key' })).sentence).toContain('Rescue key saved');
    expect(mocks.pairPinned).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.files.get(demoPath('listener-pins'))!.toString()).serverPin).toBe('');
  });
  it.each(['linux', 'win32'] as const)('on %s, decides whether saved fingerprints can be opened from that platform\'s storage', async platform => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const backend = vi.spyOn(mocks.storage, 'getSelectedStorageBackend').mockReturnValue('basic_text');
    Object.defineProperty(process, 'platform', { ...original, value: platform });
    try { await production(); }
    finally { Object.defineProperty(process, 'platform', original); backend.mockRestore(); }
    if (platform === 'linux') {
      // Linux's plaintext backend is not secure storage: the saved pins stay closed and the app is not loaded.
      expect(mocks.storage.decryptString).not.toHaveBeenCalled();
      expect(mocks.windows[0]!.loadURL).not.toHaveBeenCalled();
      expect((await rescueRequest()('status')).sentence).toContain('Saved fingerprints are unavailable');
    } else {
      // Windows encryption (DPAPI) has no backend to ask: the pins open and the pinned app loads.
      expect(backend).not.toHaveBeenCalled();
      expect(mocks.storage.decryptString).toHaveBeenCalled();
      expect(mocks.windows[0]!.loadURL).toHaveBeenCalledWith('https://127.0.0.1:8881');
    }
  });
  it('saves a first rescue fingerprint only when explicitly supplied and never infers a server pin', async () => {
    await production(null);
    const request = rescueRequest();
    expect((await request('setup', { key: 'demo-rescue-key' })).sentence).toContain('Enter the supervisor rescue fingerprint');
    expect(mocks.rescueKeyCheck).not.toHaveBeenCalled();
    expect((await request('setup', { key: 'demo-rescue-key', rescuePin })).sentence).toContain('Rescue key saved');
    expect(JSON.parse(mocks.files.get(demoPath('listener-pins'))!.toString())).toEqual({ serverPin: '', rescuePin });
    expect(mocks.pairPinned).not.toHaveBeenCalled(); expect(mocks.sockets).toHaveLength(0);
  });
});
