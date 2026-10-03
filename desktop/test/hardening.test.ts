import { describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';
import { applyProductionMenu, developmentSetting, hardenSession, permissionAllowed, secureStorageAvailable, secureWebPreferences } from '../src/hardening.js';

describe('window hardening', () => {
  it('turns DevTools off in packaged builds and keeps every window isolated', () => {
    for (const packaged of [true, false]) {
      expect(secureWebPreferences(packaged, { preload: '/demo/preload.cjs' })).toEqual({
        preload: '/demo/preload.cjs', contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: !packaged,
      });
    }
  });
  it('removes the default menu (reload, Toggle Developer Tools) from packaged builds only', () => {
    const menu = { setApplicationMenu: vi.fn() };
    applyProductionMenu(false, menu);
    expect(menu.setApplicationMenu).not.toHaveBeenCalled();
    applyProductionMenu(true, menu);
    expect(menu.setApplicationMenu).toHaveBeenCalledWith(null);
  });
  it('honours WAYROOST_URL-style overrides only when running unpacked', () => {
    expect(developmentSetting('https://attacker.example', true, 'http://127.0.0.1:8881')).toBe('http://127.0.0.1:8881');
    expect(developmentSetting('http://127.0.0.1:8896', false, 'http://127.0.0.1:8881')).toBe('http://127.0.0.1:8896');
    expect(developmentSetting(undefined, false, 'http://127.0.0.1:8880')).toBe('http://127.0.0.1:8880');
    expect(developmentSetting('', false, 'http://127.0.0.1:8880')).toBe('http://127.0.0.1:8880');
  });
  it('denies permission requests, checks and devices on both sessions, except clipboard writes from the app page', () => {
    const origin = 'http://127.0.0.1:8896';
    const fake = () => {
      const handlers: { request?: Function; check?: Function; device?: Function } = {};
      const target = {
        setPermissionRequestHandler: (handler: Function) => { handlers.request = handler; },
        setPermissionCheckHandler: (handler: Function) => { handlers.check = handler; },
        setDevicePermissionHandler: (handler: Function) => { handlers.device = handler; },
      } as unknown as Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'setDevicePermissionHandler'>;
      return { handlers, target };
    };
    const request = (handler: Function, permission: string, isMainFrame: boolean, requestingUrl: string) => {
      let granted: boolean | undefined; handler({}, permission, (value: boolean) => { granted = value; }, { isMainFrame, requestingUrl }); return granted;
    };
    const app = fake(); hardenSession(app.target, origin);
    for (const permission of ['media', 'geolocation', 'notifications', 'openExternal', 'clipboard-read', 'hid', 'fullscreen']) {
      expect(request(app.handlers.request!, permission, true, `${origin}/c/hermes/demo`)).toBe(false);
      expect(app.handlers.check!(null, permission, origin, { isMainFrame: true, requestingUrl: `${origin}/` })).toBe(false);
    }
    expect(request(app.handlers.request!, 'clipboard-sanitized-write', true, `${origin}/c/hermes/demo`)).toBe(true);
    expect(app.handlers.check!(null, 'clipboard-sanitized-write', origin, { isMainFrame: true })).toBe(true);
    // Never from a subframe or another origin.
    expect(request(app.handlers.request!, 'clipboard-sanitized-write', false, `${origin}/`)).toBe(false);
    expect(request(app.handlers.request!, 'clipboard-sanitized-write', true, 'https://example.com/')).toBe(false);
    expect(app.handlers.check!(null, 'clipboard-sanitized-write', 'https://example.com', { isMainFrame: true })).toBe(false);
    expect(app.handlers.device!({ deviceType: 'usb', origin })).toBe(false);
    // The rescue page's session denies everything.
    const rescue = fake(); hardenSession(rescue.target);
    expect(request(rescue.handlers.request!, 'clipboard-sanitized-write', true, 'file:///demo/rescue.html')).toBe(false);
    expect(rescue.handlers.check!(null, 'media', 'file://', { isMainFrame: true })).toBe(false);
    expect(rescue.handlers.device!({ deviceType: 'hid', origin: 'file://' })).toBe(false);
    expect(permissionAllowed(origin, 'clipboard-sanitized-write', true, 'not a url')).toBe(false);
  });
});

describe('secure key storage by platform', () => {
  const storage = (available: boolean, backend: ReturnType<Electron.SafeStorage['getSelectedStorageBackend']>) => ({
    isEncryptionAvailable: vi.fn(() => available), getSelectedStorageBackend: vi.fn(() => backend),
  });
  it.each(['win32', 'darwin'] as const)('on %s, trusts the system encryption answer and never asks for a Linux backend', (platform) => {
    const ready = storage(true, 'basic_text');
    expect(secureStorageAvailable(ready, platform)).toBe(true);
    expect(ready.getSelectedStorageBackend).not.toHaveBeenCalled();
    expect(secureStorageAvailable(storage(false, 'unknown'), platform)).toBe(false);
  });
  it('on linux, refuses the plaintext basic_text backend and unavailable encryption', () => {
    expect(secureStorageAvailable(storage(true, 'basic_text'), 'linux')).toBe(false);
    for (const backend of ['gnome_libsecret', 'kwallet5', 'kwallet6'] as const) expect(secureStorageAvailable(storage(true, backend), 'linux'), backend).toBe(true);
    const unavailable = storage(false, 'gnome_libsecret');
    expect(secureStorageAvailable(unavailable, 'linux')).toBe(false);
    expect(unavailable.getSelectedStorageBackend).not.toHaveBeenCalled();
  });
});
