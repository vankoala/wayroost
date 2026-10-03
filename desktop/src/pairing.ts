import type { Session } from 'electron';
import type { ServerClient } from './server-client.js';
import { appOrigins } from './hardening.js';
import { authenticationEndpoint, authenticationHttpFailure } from '../../shared/authentication.js';
import { randomUUID } from 'node:crypto';

type RequestOwner = { generation: number; renderer: boolean; document: boolean; pair: boolean; socket: boolean;
  authenticated: boolean; mainFrame: boolean; probe: boolean; signal: AbortSignal; authenticationSignal: AbortSignal;
  bearing: boolean; identity: boolean; status?: number; speech?: { cancelled: boolean; request?: RequestOwner };
  contentsId?: number; retired?: boolean; navigationCancelled?: boolean; guardCancelled?: boolean; attempt?: symbol; native: boolean; timer?: ReturnType<typeof setTimeout> };
/** Ownership survives document replacement, including responses already queued in Chromium. */
const requests = new WeakMap<object, Map<number, RequestOwner>>();

export function monitorPairing(target: Pick<Session, 'webRequest'>, origin: string, contentsId: number,
  client: Pick<ServerClient, 'pairingGeneration' | 'authenticationBlocked' | 'requestSignal' | 'snapshotSignal' | 'nativePairingAttempt' | 'nativePairingSignal' |
    'reauthenticationSignal' | 'beginPairing' | 'ownsPairing' | 'endPairing' | 'acceptPairing' | 'resume' | 'suspend'>) {
  const documentGeneration = client.pairingGeneration;
  let documentWork = new AbortController();
  let pending = requests.get(target);
  if (!pending) { pending = new Map(); requests.set(target, pending); }
  const owners = pending;
  const speech = new Map<string, NonNullable<RequestOwner['speech']>>();
  const cancel = (id: number) => {
    const request = owners.get(id);
    if (request) { request.guardCancelled = true; clearTimeout(request.timer); }
  };
  const filter = { urls: [`${origin}/*`, `${appOrigins(origin).ws}/*`] };
  const current = (request: RequestOwner | undefined): request is RequestOwner => !!request &&
    request.generation === client.pairingGeneration && !request.signal.aborted && !request.retired &&
    (!request.probe || request.signal === client.reauthenticationSignal) &&
    (!request.attempt || client.ownsPairing(request.generation, request.attempt));
  // Reloads cancel cookie delivery, but only suspension, replacement or shutdown retires authentication evidence.
  const authenticating = (request: RequestOwner | undefined): request is RequestOwner => !!request &&
    request.generation === client.pairingGeneration && !request.authenticationSignal.aborted &&
    request.authenticated && !request.pair && !request.probe;
  const statusLoss = (request: RequestOwner, status: number) => status === 401 ||
    (request.socket && status === 403) || (!request.mainFrame && authenticationHttpFailure(status));
  const ordinaryError = (request: RequestOwner) => request.status !== undefined && request.status >= 400 && request.status !== 401 && request.status !== 403;
  const successful = (request: RequestOwner) => request.status !== undefined && request.status >= 200 && request.status < 300;
  const stripCookies = (headers: Record<string, string[]> | undefined) => Object.fromEntries(
    Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() !== 'set-cookie'));
  target.webRequest.onBeforeRequest(filter, (details, callback) => {
    let path: string; let decoded: string;
    try { path = new URL(details.url).pathname; decoded = decodeURIComponent(path); }
    catch { cancel(details.id); callback({ cancel: true }); return; }
    const api = path === '/api' || path.startsWith('/api/');
    if (path !== decoded && ((!api && (decoded === '/api' || decoded.startsWith('/api/'))) || decoded === '/api/pair')) {
      cancel(details.id); callback({ cancel: true }); return;
    }
    const previous = owners.get(details.id);
    const pair = path === '/api/pair' && details.method === 'POST';
    const native = details.webContentsId === undefined || details.webContentsId <= 0;
    const probe = details.url === `${origin}/api/me` && details.method === 'GET' && native && !!client.reauthenticationSignal &&
      (previous?.probe || ![...owners.values()].some((owner) => owner.probe && owner.signal === client.reauthenticationSignal));
    const socket = details.url.startsWith(`${appOrigins(origin).ws}/`);
    const mainFrame = !api && !socket && details.webContentsId === contentsId && details.resourceType === 'mainFrame';
    const authenticated = api || socket || mainFrame;
    if ((previous && !current(previous)) || (!native && details.webContentsId !== contentsId) ||
      (client.authenticationBlocked && authenticated && !mainFrame && !pair && !probe)) { cancel(details.id); callback({ cancel: true }); return; }
    if (!previous) {
      const attempt = pair ? (native ? client.nativePairingAttempt : undefined) ?? Symbol() : undefined;
      if (attempt && ([...owners.values()].some((owner) => owner.attempt === attempt) || !client.beginPairing(client.pairingGeneration, attempt))) {
        cancel(details.id); callback({ cancel: true }); return;
      }
      const renderer = details.webContentsId === contentsId;
      const document = renderer && details.resourceType !== 'mainFrame';
      const signal = pair && native ? client.nativePairingSignal : probe ? client.reauthenticationSignal :
        native && path === '/api/conversations' ? AbortSignal.any([client.requestSignal, client.snapshotSignal]) : client.requestSignal;
      const request: RequestOwner = { generation: renderer && !pair ? documentGeneration : client.pairingGeneration, renderer, document, pair, socket, authenticated, mainFrame, probe,
        bearing: authenticationEndpoint(path), identity: path === '/api/me', signal: document ? AbortSignal.any([documentWork.signal, signal!]) : signal!, authenticationSignal: signal!, contentsId: details.webContentsId, attempt, native: pair && native };
      const speechId = new URL(details.url).searchParams.get('speechRequest');
      const owner = renderer && path === '/api/voice/speak' && details.method === 'POST' && speechId ? speech.get(speechId) : undefined;
      if (owner && !owner.request) { request.speech = owner; owner.request = request; }
      if ((request.bearing || pair) && !socket && !probe && (!pair || renderer)) request.timer = setTimeout(() => {
        if (request.attempt) {
          if (current(request)) { owners.delete(details.id); client.endPairing(request.generation, request.attempt); }
        } else if (!request.retired && !request.navigationCancelled && !ordinaryError(request) && authenticating(request) && (request.identity || successful(request))) client.suspend(request.generation);
      }, 10000);
      owners.set(details.id, request);
    }
    callback({});
  });
  target.webRequest.onHeadersReceived(filter, (details, callback) => {
    const request = owners.get(details.id);
    if (request) { request.status = details.statusCode; if (ordinaryError(request)) clearTimeout(request.timer); }
    if (authenticating(request) &&
      statusLoss(request, details.statusCode)) {
      client.suspend(request.generation);
    }
    if (current(request) && (!client.authenticationBlocked || !request.authenticated || request.mainFrame || request.pair || request.probe)) {
      if (request.attempt && details.statusCode >= 200 && details.statusCode < 300) client.acceptPairing(request.generation, request.attempt);
      callback({}); return;
    }
    cancel(details.id);
    callback({ cancel: true, responseHeaders: stripCookies(details.responseHeaders) });
  });
  target.webRequest.onBeforeRedirect(filter, (details) => {
    const request = owners.get(details.id);
    if (!authenticating(request)) return;
    if (request.mainFrame && details.redirectURL) {
      try {
        const destination = new URL(details.redirectURL);
        if (destination.origin === origin && !/^\/(pair|login|cdn-cgi\/access)(\/|$)/.test(destination.pathname)) return;
      } catch { /* An unreadable redirect cannot establish an app document. */ }
    }
    client.suspend(request.generation);
  });
  target.webRequest.onCompleted(filter, (details) => {
    const request = owners.get(details.id);
    if (!request) return;
    clearTimeout(request.timer); owners.delete(details.id);
    if (authenticating(request) && statusLoss(request, details.statusCode)) client.suspend(request.generation);
    if (request.attempt && !request.native) {
      const successful = current(request) && details.statusCode >= 200 && details.statusCode < 300;
      client.endPairing(request.generation, request.attempt);
      if (successful) client.resume(request.generation);
    }
  });
  target.webRequest.onErrorOccurred(filter, (details) => {
    const request = owners.get(details.id);
    if (!request) return;
    clearTimeout(request.timer); owners.delete(details.id);
    const cancelled = (request.guardCancelled && (details.error === 'net::ERR_ABORTED' || details.error === 'net::ERR_BLOCKED_BY_CLIENT')) ||
      ((request.retired || request.navigationCancelled || request.speech?.cancelled) && details.error === 'net::ERR_ABORTED');
    if (authenticating(request) && !cancelled && !ordinaryError(request) && (request.identity || request.bearing && successful(request) ||
      details.error === 'net::ERR_ABORTED' || details.error === 'net::ERR_BLOCKED_BY_CLIENT')) client.suspend(request.generation);
    if (request.attempt && !request.native) client.endPairing(request.generation, request.attempt);
  });
  const discard = (reason: 'reload' | 'replacement' | 'failure' = 'reload') => {
    documentWork.abort(); documentWork = new AbortController();
    speech.clear();
    for (const request of owners.values()) {
      if (!request.renderer || request.contentsId !== contentsId) continue;
      if (reason !== 'failure' && (request.document || request.mainFrame)) { request.navigationCancelled = true; clearTimeout(request.timer); }
      // A deliberate replacement owns ERR_ABORTED, never queued failures or redirects.
      if (reason === 'replacement') { request.retired = true; clearTimeout(request.timer); }
      if (request.document && request.attempt && !request.native) {
        clearTimeout(request.timer); client.endPairing(request.generation, request.attempt);
      }
    }
  };
  return Object.assign(discard, {
    beginSpeech: () => {
      if (documentGeneration !== client.pairingGeneration || client.authenticationBlocked || documentWork.signal.aborted || speech.size >= 16) return undefined;
      const id = randomUUID(); speech.set(id, { cancelled: false }); return id;
    },
    cancelSpeech: (id: string) => {
      const owner = speech.get(id);
      if (!owner || documentGeneration !== client.pairingGeneration) return false;
      owner.cancelled = true; clearTimeout(owner.request?.timer); return true;
    },
    endSpeech: (id: string) => { speech.delete(id); },
  });
}
