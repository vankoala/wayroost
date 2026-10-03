import type { Menu, SafeStorage, Session, WebPreferences, WebSocketOptions } from 'electron';
/**
 * Every window's web preferences: isolated, sandboxed, no Node, and no DevTools in a packaged build
 * (a page or anyone at the keyboard could otherwise open a console in the app's session).
 */
export function secureWebPreferences(packaged: boolean, preferences: { preload: string; session?: Session; additionalArguments?: string[] }): WebPreferences {
  return { ...preferences, contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: !packaged };
}
/** A packaged build has no application menu: Electron's default one carries reload and Toggle Developer Tools. */
export function applyProductionMenu(packaged: boolean, menu: Pick<typeof Menu, 'setApplicationMenu'>) {
  if (packaged) menu.setApplicationMenu(null);
}
/**
 * A development override from the environment (WAYROOST_URL, WAYROOST_RESCUE_URL), honoured only when
 * running unpacked. A packaged app always uses its fixed loopback origins, so an environment variable
 * can't make it trust another origin with the device cookie, pairing codes or the rescue key.
 */
export function developmentSetting(value: string | undefined, packaged: boolean, fixed: string): string {
  return !packaged && value ? value : fixed;
}
/**
 * Whether safeStorage really encrypts. isEncryptionAvailable() is the whole answer on Windows (DPAPI) and macOS
 * (Keychain). On Linux it is also true for the 'basic_text' backend, a fixed key that is not secure storage;
 * Linux is the only platform with a backend to ask, so getSelectedStorageBackend is never called elsewhere.
 */
export function secureStorageAvailable(storage: Pick<SafeStorage, 'isEncryptionAvailable' | 'getSelectedStorageBackend'>, platform: NodeJS.Platform): boolean {
  if (!storage.isEncryptionAvailable()) return false;
  return platform !== 'linux' || storage.getSelectedStorageBackend() !== 'basic_text';
}
/** The one permission the app page gets: clipboard writes for its copy buttons, from its own top frame. */
const PAGE_PERMISSIONS = new Set(['clipboard-sanitized-write']);
/** Whether a permission request or check passes: only a page permission, from the main frame, at the app origin. */
export function permissionAllowed(origin: string | undefined, permission: string, isMainFrame: boolean, requestingUrl: string | undefined): boolean {
  if (!origin || !PAGE_PERMISSIONS.has(permission) || !isMainFrame || !requestingUrl) return false;
  try { return new URL(requestingUrl).origin === origin; } catch { return false; }
}
/**
 * Installs deny-by-default request, check and device handlers on a session. Without a check handler
 * Electron's default checks grant most permissions. `origin` is the app origin whose top frame may use
 * PAGE_PERMISSIONS; omit it (the rescue page's session) to deny everything.
 */
export function hardenSession(target: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'setDevicePermissionHandler'>, origin?: string) {
  target.setPermissionRequestHandler((_contents, permission, callback, details) => callback(permissionAllowed(origin, permission, details.isMainFrame, details.requestingUrl)));
  target.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => permissionAllowed(origin, permission, details.isMainFrame, details.requestingUrl ?? requestingOrigin));
  target.setDevicePermissionHandler(() => false);
}
/** The marker the server's local origin requires before it takes a device cookie. */
export const APP_HEADER = 'x-wayroost-app';
export const APP_HEADER_VALUE = 'desktop';
/** The app origin and the origin of its WebSocket: `http://127.0.0.1:8881` and `ws://127.0.0.1:8881`. */
export function appOrigins(origin: string): { http: string; ws: string } {
  const url = new URL(origin);
  return { http: url.origin, ws: `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}` };
}
/** Whether a request goes to the app or to its socket: the only requests that carry the desktop marker. */
export function marksAppRequest(url: string, origin: string): boolean {
  try {
    const target = new URL(url).origin;
    const { http, ws } = appOrigins(origin);
    return target === http || target === ws;
  } catch { return false; }
}
/**
 * Marks every request the app's session makes to the app with the desktop header: the window's pages and
 * their fetches and WebSockets, and the main process's session.fetch on the same session (the main process's
 * net.WebSocket bypasses this hook and takes appSocketOptions instead). Install it on `persist:wayroost`
 * before any window loads or socket opens. Other origins never get it, and neither does the rescue page's
 * session. A session takes one onBeforeSendHeaders listener: this is it.
 */
export function installAppHeader(target: Pick<Session, 'webRequest'>, origin: string, allowed: (url: string) => boolean = () => true) {
  target.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    if (!allowed(details.url)) { callback({ cancel: true }); return; }
    const requestHeaders = { ...details.requestHeaders };
    for (const key of Object.keys(requestHeaders)) if (key.toLowerCase() === APP_HEADER) delete requestHeaders[key];
    if (marksAppRequest(details.url, origin)) requestHeaders[APP_HEADER] = APP_HEADER_VALUE;
    callback({ requestHeaders });
  });
}
/**
 * Options for the main process's own net.WebSocket on the app session. No webRequest hook sees that socket
 * (a real Windows run calls none of them for it), so installAppHeader can neither mark nor cancel it: it applies
 * the same rule itself. It is refused when `allowed` refuses its URL, and carries the marker only to the app's
 * socket origin. The session's certificate verifier still checks the TLS handshake before the upgrade request.
 */
export function appSocketOptions(url: string, origin: string, session: Session, allowed: (url: string) => boolean = () => true): WebSocketOptions {
  if (!allowed(url)) throw new Error('This socket is not allowed in the app session.');
  return { session, useSessionCookies: true, origin, headers: marksAppRequest(url, origin) ? { [APP_HEADER]: APP_HEADER_VALUE } : {} };
}
