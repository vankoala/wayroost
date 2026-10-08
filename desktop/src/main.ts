import { app, BrowserWindow, ipcMain, Menu, net, Notification, powerMonitor, safeStorage, session, shell } from 'electron';
import { localListenerOrigin, parseListenerPins, desktopOrigin, installCertificatePin, ListenerIdentityError, ListenerNotPairedError, parsePairingToken, pairPinnedDesktop, pinnedOriginRequest, type DesktopPins } from './tls.js';
import { ListenerCertificateDateError, parsePin } from '../../lib/loopback-tls.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { activationFromArgv, APPROVAL_ID, navigationKind, type ApprovalActivation } from './protocol.js';
import { toastXml } from './toast.js';
import { createTray } from './tray.js';
import { checkRescueKey, RescueClient } from './rescue-client.js';
import { ServerClient, UnpairedError, type LiveSocket } from './server-client.js';
import { approvalKey, approvalWords, openApprovalView, runActivation, toastCanAllow, ToastTickets } from './approvals.js';
import type { Approval } from '../../shared/protocol.js';
import { monitorPresence } from './presence.js';
import { monitorPairing } from './pairing.js';
import type { SupervisorStatus } from '../../shared/supervisor.js';
import { WS_CLOSE_REAUTH } from '../../shared/protocol.js';
import { healthStatus } from './tray-state.js';
import { AppLink, AppPage, presentRescue, restoreShowsApp, shared } from './connection.js';
import { applyProductionMenu, appSocketOptions, developmentSetting, hardenSession, installAppHeader, secureStorageAvailable, secureWebPreferences } from './hardening.js';

const development = !app.isPackaged && process.argv.includes('--wayroost-desktop-dev');
const protocol = development ? 'wayroost-dev' : 'wayroost';
if (development) {
  const directory = join(app.getPath('appData'), 'wayroost-desktop-dev');
  mkdirSync(directory, { recursive: true });
  app.setPath('userData', directory);
  app.setPath('sessionData', directory);
}
let origin = desktopOrigin(developmentSetting(development ? process.env.WAYROOST_URL : undefined, app.isPackaged, development ? 'http://127.0.0.1:8896' : localListenerOrigin()), development);
let pins: DesktopPins | undefined;
let identityProblem: string | undefined;
let rescueIdentityProblem: string | undefined;
let switchingIdentity = false;
let savingRecovery = false;
function secureStorage() {
  if (!secureStorageAvailable(safeStorage, process.platform)) throw new Error('Secure key storage is unavailable.');
}
let window: BrowserWindow;
let windowGeneration = -1;
let appPage: AppPage | undefined;
let discardAppDocument: ReturnType<typeof monitorPairing> | undefined;
/** Carries the current window's intended visibility through a replacement before its first show. */
let showOnLoad = false;
/** Explicit activations carry visibility through revocation; closing either window cancels them. */
const activeActivations = new Set<symbol>();
let recovery: BrowserWindow | undefined;
let client: ServerClient;
/** Toasts still on screen or in Action Center, by approvalKey; closed once their approval resolves. */
const toasts = new Map<string, Notification>();
const tickets = new ToastTickets();
let quitting = false;
let pending = activationFromArgv(process.argv, protocol);
/** Started at sign-in: stay in the tray until someone asks for the app. */
const hiddenStart = process.argv.includes('--hidden');
/** The supervisor's last answer over the rescue listener; undefined when it isn't answering or no key is saved. */
let supervisor: SupervisorStatus | undefined;
/** Repaints the tray; set once the tray and client exist. */
let refreshTray = () => {};
const appLink = new AppLink({ changed: () => refreshTray(), retry: retryPage });

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setAppUserModelId('org.wayroost.desktop');
  app.on('second-instance', (_event, argv) => {
    const activation = activationFromArgv(argv, protocol);
    if (client) void activate(activation); else pending = activation;
  });
  app.on('open-url', (event, url) => { event.preventDefault(); const activation = activationFromArgv([url], protocol); if (client) void activate(activation); else pending = activation; });
  app.on('before-quit', () => { quitting = true; });
  // Replacing the only renderer during pairing must leave the companion running in the tray.
  app.on('window-all-closed', () => {});
  void app.whenReady().then(start);
}
function currentWindow(generation: number, target = window) { return generation === client.pairingGeneration && generation === windowGeneration && target === window; }
function wantsVisibility() { return showOnLoad || window.isVisible() || recovery?.isVisible() === true; }
/** All window presentation follows the current surface; recovery keeps priority until a real page loads. */
function presentSurface(generation = windowGeneration, asked = false) {
  if (generation !== windowGeneration) return;
  if (asked) showOnLoad = true;
  if (!wantsVisibility()) return;
  if (appLink.surface === 'recovery') {
    window.hide();
    if (!appLink.presented || !recovery) return;
    recovery.show(); recovery.focus();
  } else if (appLink.surface === 'setup') {
    window.show(); recovery?.show(); recovery?.focus();
  } else {
    showOnLoad = false;
    recovery?.hide(); window.show(); window.focus();
  }
}
async function loadAppPage(url: string, generation = client.pairingGeneration) {
  const target = window;
  if (!currentWindow(generation)) throw new UnpairedError();
  await target.loadURL(url);
  if (!currentWindow(generation, target)) throw new UnpairedError();
}
function openApproval(approval: Approval | undefined) {
  const current = approval && client.approvals.get(approvalKey(approval));
  const generation = client.pairingGeneration;
  if (approval && (client.authenticationBlocked || current?.createdAt !== approval.createdAt)) return Promise.resolve();
  showOnLoad = true;
  // A failed load is handled by did-fail-load (rescue page and reload back-off); it must stay in front.
  return openApprovalView(origin, current, {
    load: (url) => loadAppPage(url, generation), show: () => presentSurface(generation), reveal: () => presentSurface(generation),
  });
}
function activate(activation: ApprovalActivation | null) {
  const generation = client.pairingGeneration;
  const visibility = Symbol();
  activeActivations.add(visibility);
  return runActivation(activation, {
    approvals: client.approvals, tickets, refresh: () => client.refresh(),
    open: (approval) => {
      if (!activeActivations.has(visibility)) return Promise.resolve();
      if (client.authenticationBlocked) { presentSurface(windowGeneration, true); return Promise.resolve(); }
      return currentWindow(generation) ? openApproval(approval) : Promise.resolve();
    }, reveal: () => { if (activeActivations.has(visibility)) presentSurface(generation, true); },
    allowOnce: async (approval) => {
      if (!currentWindow(generation)) throw new UnpairedError();
      const words = approvalWords(approval, client.conversationOf(approval));
      await client.allowOnce(approvalKey(approval));
      if (!currentWindow(generation) || client.authenticationBlocked) return;
      new Notification({ title: words.role, body: `Allowed once: ${words.title}`, silent: true }).show();
    },
    rescue: async () => {
      if (!activeActivations.has(visibility)) return;
      if (client.authenticationBlocked) presentSurface(windowGeneration, true); else if (currentWindow(generation)) await showRescue(true);
    },
  }).finally(() => activeActivations.delete(visibility));
}
/**
 * Loads the app page again after the server came back: the page the window was showing when it is an app
 * page, else the app's start page. A load already under way (a scheduled reload, say) is left to finish.
 */
function retryPage() {
  if (!window || window.webContents.isLoading()) return;
  const current = window.webContents.getURL();
  void loadAppPage(client.unpaired ? `${origin}/pair` : navigationKind(current, origin) === 'internal' ? current : origin).catch(() => {});
}
function secureWindow(target: BrowserWindow) {
  const navigate = (event: Electron.Event, url: string) => {
    if (target !== window) { event.preventDefault(); return; }
    const kind = navigationKind(url, origin);
    if (kind !== 'internal') { event.preventDefault(); if (kind === 'external') void shell.openExternal(url); }
  };
  target.webContents.on('will-navigate', navigate);
  target.webContents.on('will-redirect', navigate);
  target.webContents.setWindowOpenHandler(({ url }) => {
    if (target !== window) return { action: 'deny' };
    const kind = navigationKind(url, origin);
    if (kind === 'external') void shell.openExternal(url);
    else if (kind === 'internal' && target === window && !client.unpaired) void loadAppPage(url).catch(() => {});
    return { action: 'deny' };
  });
  target.webContents.on('will-attach-webview', (event) => event.preventDefault());
}
/** The rescue page's window, made and loaded once; callers during its first load wait for that load. */
const recoveryWindow = shared(async (): Promise<BrowserWindow> => {
  const page = new BrowserWindow({ width: 720, height: 520, show: false, webPreferences: secureWebPreferences(app.isPackaged, {
    preload: join(__dirname, 'rescue.cjs'), session: session.fromPartition('wayroost-rescue'),
  }) });
  recovery = page;
  page.webContents.on('will-navigate', (event) => event.preventDefault());
  page.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  page.on('close', (event) => { if (!quitting) {
    event.preventDefault(); showOnLoad = false; activeActivations.clear(); page.hide();
    if (appLink.surface === 'setup') appLink.endRecovery(client.unpaired ? 'pairing' : 'app');
  } });
  try { await page.loadFile(join(__dirname, 'rescue.html')); }
  catch (error) { recovery = undefined; page.destroy(); throw error; }
  return page;
});
/**
 * The server can't be reached: the rescue page replaces the main window. `asked`: someone activated the app.
 * When the app came back while the rescue page was still loading, the rescue page stays hidden (and an asked-for
 * app comes forward as it is).
 */
function showRescue(asked = false) {
  if (asked) showOnLoad = true;
  return presentRescue(appLink, recoveryWindow, (page) => {
    page.webContents.send('rescue:mode', 'down');
    presentSurface();
  }, asked ? () => presentSurface() : undefined);
}
/** Recovery setup and re-pairing use the same page, beside a working main window. */
async function showSetup() {
  const page = await recoveryWindow();
  page.webContents.send('rescue:mode', 'setup');
  appLink.startSetup();
  presentSurface(windowGeneration, true);
}
async function start() {
  app.setAsDefaultProtocolClient(protocol, process.execPath, app.isPackaged ? [] : [app.getAppPath(), ...(development ? ['--wayroost-desktop-dev'] : [])]);
  const loginMarker = join(app.getPath('userData'), 'login-configured');
  if (app.isPackaged && !existsSync(loginMarker)) {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
    writeFileSync(loginMarker, '1');
  }
  const pinPath = join(app.getPath('userData'), 'listener-pins');
  if (!development && existsSync(pinPath)) {
    try {
      secureStorage();
      const saved = JSON.parse(safeStorage.decryptString(readFileSync(pinPath))) as DesktopPins;
      pins = parseListenerPins(saved);
      origin = localListenerOrigin(pins);
    } catch { identityProblem = 'Saved fingerprints are unavailable. Pair this desktop again using sudo wayroost pair-desktop.'; }
  }
  const partition = session.fromPartition('persist:wayroost');
  const rescueSession = session.fromPartition('wayroost-rescue');
  const rescueUrl = desktopOrigin(developmentSetting(development ? process.env.WAYROOST_RESCUE_URL : undefined, app.isPackaged, development ? 'http://127.0.0.1:8898' : 'https://127.0.0.1:8880'), development);
  const pinFailed = (error: Error) => {
    identityProblem = error.message;
    recovery?.webContents.send('rescue:error', identityProblem);
    if (window && !(error instanceof ListenerNotPairedError)) void showRescue();
  };
  const rescuePinFailed = (error: Error) => {
    rescueIdentityProblem = error instanceof ListenerIdentityError ? 'This is not your Wayroost supervisor. No rescue credentials were sent. Run sudo wayroost pair-desktop on this PC to pair again.' : error.message;
    recovery?.webContents.send('rescue:error', rescueIdentityProblem);
    refreshTray();
  };
  const installPins = () => {
    installCertificatePin(partition, origin, () => pins?.serverPin, pinFailed, () => { identityProblem = undefined; });
    installCertificatePin(rescueSession, rescueUrl, () => pins?.rescuePin, rescuePinFailed, () => { rescueIdentityProblem = undefined; });
  };
  if (!development) {
    installPins();
    rescueSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => callback({ cancel: details.url !== pathToFileURL(join(__dirname, 'rescue.html')).href && (savingRecovery || switchingIdentity || !pinnedOriginRequest(details.url, rescueUrl, pins?.rescuePin)) }));
  }
  hardenSession(partition, origin);
  // Before any window loads or socket opens: the server's local origin takes the device cookie only from
  // requests that carry the desktop marker. The rescue session never gets it.
  const appRequestAllowed = (url: string) => !switchingIdentity && (development || pinnedOriginRequest(url, origin, pins?.serverPin));
  installAppHeader(partition, origin, appRequestAllowed);
  // The rescue page and the unused default session need no permissions.
  hardenSession(session.defaultSession);
  hardenSession(rescueSession);
  applyProductionMenu(app.isPackaged, Menu);
  const tray = createTray(join(__dirname, 'mark.png'), () => presentSurface(windowGeneration, true), () => app.quit(), () => { void showSetup(); });
  const updateTray = () => {
    const generation = client.pairingGeneration;
    const status = { ...healthStatus(supervisor, appLink.link, Date.now(), client.shadow) };
    if (rescueIdentityProblem) { if (status.overall === 'ok') status.overall = 'attention'; status.sentence += ` ${rescueIdentityProblem}`; }
    tray.update(status, [...client.approvals.values()].map((approval) => {
      const words = approvalWords(approval, client.conversationOf(approval));
      return { label: `${words.role}: ${words.title}`, open: () => { if (currentWindow(generation)) void openApproval(approval); } };
    }));
  };
  client = new ServerClient(origin, partition, { changed: updateTray, answered: () => { identityProblem = undefined; appLink.answered(); }, removed: (key) => { toasts.get(key)?.close(); toasts.delete(key); tickets.forget(key); }, notify: (approval) => {
    // The approval route can't address an id outside the server's grammar either; the tray still lists it.
    if (!APPROVAL_ID.test(approval.id)) { console.warn('Approval id outside the server grammar; no toast shown.'); return; }
    // The same role and words as the approval's card.
    const words = approvalWords(approval, client.conversationOf(approval));
    const notification = new Notification({ toastXml: toastXml(words.role, words.sentence, approval.id, tickets.issue(approval), {
      ...(approval.detail ? { detail: approval.detail } : {}), allowOnce: toastCanAllow(approval), protocol,
    }) });
    const key = approvalKey(approval);
    const generation = client.pairingGeneration;
    notification.on('click', () => { if (currentWindow(generation)) void openApproval(client.approvals.get(key)); });
    toasts.set(key, notification);
    notification.show();
  }, notification: (alert) => {
    const notification = new Notification({ title: alert.title, body: alert.body ?? '' });
    const generation = client.pairingGeneration;
    notification.on('click', () => {
      if (!currentWindow(generation) || client.authenticationBlocked) return;
      showOnLoad = true;
      void loadAppPage(new URL(alert.url, origin).href, generation).then(() => presentSurface(generation)).catch(() => {});
    });
    notification.show();
  }, link: (open, code) => {
    if (open) { appLink.socketOpened(); void pollStatus(); return; }
    // The server recycles every socket every 30 minutes; that reconnect isn't news.
    if (code === WS_CLOSE_REAUTH) return;
    appLink.socketClosed();
    // An unpaired desktop isn't a PC that is down: the page shows pairing.
    const generation = client.pairingGeneration;
    if (window.isVisible()) void client.refresh().catch((error) => { if (currentWindow(generation) && !(error instanceof UnpairedError)) void showRescue(); });
  }, authentication: (state, generation) => { window?.webContents.send('pairing:state', state, generation); },
  unpaired: () => { replaceAppWindow(); updateTray(); }, paired: () => { replaceAppWindow(); } }, () => {
    if (!development && !pins?.serverPin) throw new ListenerNotPairedError();
  });
  refreshTray = updateTray;
  app.on('before-quit', () => client.stop());
  const keyPath = join(app.getPath('userData'), 'rescue-key');
  const rescue = new RescueClient(rescueUrl, async () => {
    secureStorage();
    if (!existsSync(keyPath)) throw new Error('Save the supervisor rescue key using the recovery form.');
    return safeStorage.decryptString(readFileSync(keyPath));
  }, { development, pin: () => pins?.rescuePin });
  const pollStatus = async () => {
    if (savingRecovery || switchingIdentity || (!development && !pins?.rescuePin)) return;
    try {
      const snapshot = await rescue.status();
      if (savingRecovery || switchingIdentity) return;
      supervisor = snapshot; rescueIdentityProblem = undefined;
    }
    catch (error) {
      if (savingRecovery || switchingIdentity) return;
      supervisor = undefined; if (error instanceof ListenerIdentityError || error instanceof ListenerCertificateDateError) rescuePinFailed(error);
    }
    updateTray();
  };
  const statusTimer = setInterval(() => { void pollStatus(); }, 10000);
  app.on('before-quit', () => clearInterval(statusTimer));
  function makeAppWindow(visible = !hiddenStart) {
    const generation = client.pairingGeneration;
    showOnLoad = visible;
    const target = new BrowserWindow({ width: 1200, height: 850, show: false, webPreferences: secureWebPreferences(app.isPackaged, {
      session: partition, preload: join(__dirname, 'preload.cjs'),
      additionalArguments: [`--wayroost-pairing-generation=${generation}`],
    }) });
    window = target; windowGeneration = generation;
    secureWindow(target);
    target.on('close', (event) => { if (!quitting) { event.preventDefault(); if (target === window) { showOnLoad = false; activeActivations.clear(); } target.hide(); } });
    const discardDocument = monitorPairing(partition, origin, target.webContents.id, client);
    discardAppDocument = discardDocument;
    target.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace && currentWindow(generation, target)) discardDocument();
    });
    target.webContents.on('render-process-gone', () => { if (currentWindow(generation, target)) discardDocument('failure'); });
    target.webContents.on('destroyed', () => { if (currentWindow(generation, target)) discardDocument('failure'); });
    const page = new AppPage(appLink, {
      load: () => { if (currentWindow(generation, target)) void loadAppPage(client.unpaired ? `${origin}/pair` : origin, generation).catch(() => {}); },
      rescue: () => { void showRescue(); },
      restore: () => {
        const rescueWouldFront = showOnLoad || target.isVisible();
        const visible = restoreShowsApp({ rescueVisible: recovery?.isVisible() === true, rescuePresented: appLink.presented, rescueWouldFront });
        appLink.endRecovery(client.unpaired ? 'pairing' : 'app');
        if (visible) presentSurface(generation);
      },
      loaded: () => {
        void pollStatus();
        target.webContents.send('pairing:state', client.authenticationState, generation);
        void client.revalidateAuthentication(generation).catch(() => {});
      },
    });
    appPage = page;
    target.webContents.on('did-navigate', (_event, url) => {
      if (!currentWindow(generation, target)) return;
      const internal = navigationKind(url, origin) === 'internal';
      page.navigated(internal);
    });
    target.webContents.on('dom-ready', () => { if (currentWindow(generation, target)) page.domReady(); });
    target.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame && currentWindow(generation, target)) page.failed(code);
    });
  }
  function replaceAppWindow() {
    const visible = wantsVisibility() || activeActivations.size > 0;
    if (!appLink.recovering) appLink.endRecovery(client.unpaired ? 'pairing' : 'app');
    appPage?.stop();
    discardAppDocument?.('replacement');
    // Destroying the renderer discards its store, sockets and outstanding responses before pairing is shown.
    window.hide(); window.webContents.stop(); window.destroy();
    makeAppWindow(visible);
    const generation = client.pairingGeneration;
    void loadAppPage(client.unpaired ? `${origin}/pair` : origin, generation).then(() => {
      if (showOnLoad) presentSurface(generation);
    }).catch((error) => { if (currentWindow(generation) && !(error instanceof UnpairedError)) void showRescue(); });
  }
  makeAppWindow();
  void client.revalidateAuthentication(client.pairingGeneration);
  // The session's header hook never sees this socket: it takes the same gate and marker explicitly.
  client.connect((url) => new net.WebSocket(url, appSocketOptions(url, origin, partition, appRequestAllowed)) as unknown as LiveSocket);
  app.on('before-quit', () => appPage?.stop());
  ipcMain.handle('rescue:request', async (event, action: unknown, setup?: unknown) => {
    if (event.sender !== recovery?.webContents || event.senderFrame !== recovery.webContents.mainFrame) return { sentence: 'Request refused.' };
    if (switchingIdentity) return { sentence: 'Desktop identity is changing. Restart Wayroost to finish pairing.' };
    if (savingRecovery) return { sentence: 'Recovery setup is already in progress.' };
    const saving = action === 'setup';
    if (saving) savingRecovery = true;
    try {
      if (action === 'setup' && setup && typeof setup === 'object') {
        const { code, key, rescuePin } = setup as { code?: unknown; key?: unknown; rescuePin?: unknown };
        if (!development && code) {
          if (typeof code !== 'string') throw new Error('Paste the desktop pairing token.');
          const token = parsePairingToken(code);
          secureStorage();
          if (key) {
            if (typeof key !== 'string' || key.length > 4096) throw new Error('Enter the rescue key.');
            await checkRescueKey(rescueUrl, key, { pin: () => token.rescuePin });
          }
          const pairingOrigin = localListenerOrigin(token);
          const cookie = await pairPinnedDesktop(pairingOrigin, token);
          // A pin is fixed for the network service's lifetime: restart rather than reuse cached decisions.
          switchingIdentity = true; client.stop();
          if (!window.isDestroyed()) { window.webContents.stop(); window.destroy(); }
          await partition.closeAllConnections();
          await partition.clearStorageData({ storages: ['cookies', 'serviceworkers', 'cachestorage'] });
          await partition.clearCache();
          // Save trust first so a failed update cannot leave the replacement key beside the old pin.
          writeFileSync(pinPath, safeStorage.encryptString(JSON.stringify({ serverPin: token.serverPin, rescuePin: token.rescuePin, localPort: token.localPort })), { mode: 0o600 });
          if (typeof key === 'string' && key) writeFileSync(keyPath, safeStorage.encryptString(key), { mode: 0o600 });
          await partition.cookies.set({ url: pairingOrigin, name: 'wr_device', value: cookie, httpOnly: true, secure: true, sameSite: 'strict', path: '/', expirationDate: Date.now() / 1000 + 400 * 86400 });
          await partition.cookies.flushStore();
          app.relaunch(); app.quit();
          return { sentence: 'Desktop paired and fingerprints saved. Restarting Wayroost…' };
        }
        const candidateRescuePin = !development ? (rescuePin ? parsePin(rescuePin) : pins?.rescuePin) : undefined;
        if (!development && !candidateRescuePin) throw new Error('Enter the supervisor rescue fingerprint printed on this PC.');
        if (typeof key !== 'string' || !key || key.length > 4096 || (code !== undefined && typeof code !== 'string')) throw new Error('Enter the rescue key.');
        secureStorage();
        if (!development && pins?.rescuePin && candidateRescuePin !== pins.rescuePin) throw new Error('Changing a saved fingerprint requires a fresh desktop pairing token.');
        // Check and save the supervisor key independently: rescue must work while the server is down.
        supervisor = await checkRescueKey(rescueUrl, key, { development, pin: () => candidateRescuePin }); updateTray();
        if (!development) switchingIdentity = true;
        if (!development && candidateRescuePin) {
          if (!pins) {
            // Rescue-only setup works while the server is down; no server fingerprint is inferred.
            pins = { serverPin: '', rescuePin: candidateRescuePin, localPort: 8883 };
          }
          writeFileSync(pinPath, safeStorage.encryptString(JSON.stringify(pins)), { mode: 0o600 });
        }
        writeFileSync(keyPath, safeStorage.encryptString(key), { mode: 0o600 });
        if (!development) { app.relaunch(); app.quit(); }
        if (!code || !development) return { sentence: 'Rescue key saved.' };
        try { await client.pair(code, 'Wayroost desktop'); return { sentence: 'Rescue key saved. Desktop paired.' }; }
        catch (error) { return { sentence: `Rescue key saved. Pairing didn’t go through: ${error instanceof Error ? error.message : 'try again later.'}` }; }
      }
      if (action === 'open') {
        const generation = client.pairingGeneration;
        showOnLoad = true;
        await loadAppPage(client.unpaired ? `${origin}/pair` : origin, generation); presentSurface(generation);
        return { sentence: 'Opening Wayroost…' };
      }
      if (action === 'restart') {
        await rescue.restart();
        if (savingRecovery || switchingIdentity) return { sentence: 'Recovery setup is already in progress.' };
        return { sentence: 'Restart requested. Open Wayroost when it is ready.' };
      }
      if (action !== 'status') return { sentence: 'Request refused.' };
      if (!development && !pins?.rescuePin) return { sentence: identityProblem ?? 'Pair this desktop with the token from sudo wayroost pair-desktop. The server has not been trusted yet.' };
      const snapshot = await rescue.status();
      if (savingRecovery || switchingIdentity) return { sentence: 'Recovery setup is already in progress.' };
      supervisor = snapshot; rescueIdentityProblem = undefined; updateTray();
      return { sentence: identityProblem ?? snapshot.sentence + '\n' + snapshot.components.map((item) => `${item.name}: ${item.sentence}`).join('\n') };
    } catch (error) {
      if (!saving && (savingRecovery || switchingIdentity)) return { sentence: 'Recovery setup is already in progress.' };
      if ((action === 'status' || action === 'restart') && (error instanceof ListenerIdentityError || error instanceof ListenerCertificateDateError)) { rescuePinFailed(error); return { sentence: rescueIdentityProblem! }; }
      return { sentence: error instanceof Error ? error.message : 'Recovery failed. Try again.' };
    }
    finally { if (saving) savingRecovery = false; }
  });
  for (const channel of ['pairing:anomaly', 'pairing:socket-closed']) {
    ipcMain.on(channel, (event, generation: unknown, code: unknown) => {
      if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation !== client.pairingGeneration) return;
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || navigationKind(event.senderFrame.url, origin) !== 'internal') return;
      if (channel === 'pairing:socket-closed' && code !== 4401 && code !== 4403) return;
      client.suspend(generation);
    });
  }
  const speechOwner = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent, generation: unknown) =>
    generation === client.pairingGeneration && generation === windowGeneration && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && navigationKind(event.senderFrame.url, origin) === 'internal';
  ipcMain.handle('speech:begin', (event, generation: unknown) => {
    if (speechOwner(event, generation)) return discardAppDocument?.beginSpeech();
    return undefined;
  });
  ipcMain.handle('speech:cancel', (event, generation: unknown, id: unknown) =>
    speechOwner(event, generation) && typeof id === 'string' && discardAppDocument?.cancelSpeech(id) === true);
  ipcMain.on('speech:end', (event, generation: unknown, id: unknown) => {
    if (speechOwner(event, generation) && typeof id === 'string') discardAppDocument?.endSpeech(id);
  });
  // The page may hint that approvals changed; main only refreshes its own authenticated snapshot.
  ipcMain.on('tray:update', (event, generation: unknown, data: unknown) => {
    if (generation !== client.pairingGeneration) return;
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || navigationKind(event.senderFrame.url, origin) !== 'internal') return;
    if (!data || typeof data !== 'object' || !('type' in data)) return;
    if (data.type === 'approval_upsert' || data.type === 'approval_removed') client.hint();
  });
  updateTray();
  const stopPresence = monitorPresence((state) => client.presence(state), powerMonitor);
  app.on('before-quit', stopPresence);
  app.on('activate', () => presentSurface(windowGeneration, true));
  const generation = client.pairingGeneration;
  try {
    if (!development && !pins?.serverPin) throw new ListenerNotPairedError();
    await loadAppPage(origin, generation); if (showOnLoad) presentSurface(generation);
  }
  catch (error) { if (currentWindow(generation) && !(error instanceof UnpairedError)) await showRescue(); }
  if (!existsSync(keyPath) && !appLink.recovering && !hiddenStart) await showSetup();
  if (pending) { await activate(pending); pending = null; }
}
