import type { IncomingHttpHeaders } from 'node:http';
import {
  DESKTOP_APP_HEADER,
  DESKTOP_APP_HEADER_VALUE,
  LEGACY_REQUEST_MARKER_HEADER,
  REQUEST_MARKER_HEADER,
} from '../../../shared/protocol.js';
import type { SiteOrigin } from '../config.js';

// Browser-side protections layered on top of the sign-in checks. They stop
// other websites from driving the app through a signed-in browser (CSRF,
// cross-site WebSocket hijacking) and reject DNS-rebinding Host values.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
/** Headers Cloudflare adds to every request it forwards; a request carrying one came through the tunnel. */
const TUNNEL_HEADERS = ['cf-ray', 'cf-connecting-ip'];

export interface GuardConfig {
  /** The main public origin: what a request on the bare listen address must come from. */
  publicOrigin: string;
  origins: readonly SiteOrigin[];
  allowedHosts: Set<string>;
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function hostProblem(headers: IncomingHttpHeaders, cfg: GuardConfig): string | null {
  const host = header(headers, 'host')?.toLowerCase();
  return host && cfg.allowedHosts.has(host) ? null : 'unexpected host';
}

/**
 * The configured origin a request was made to, by its Host header (already
 * checked by hostProblem). Undefined for the bare listen address when it isn't
 * one of the origins: that counts as public, and its Origin must be the main one.
 */
export function siteFor(headers: IncomingHttpHeaders, cfg: GuardConfig): SiteOrigin | undefined {
  const host = header(headers, 'host')?.toLowerCase();
  return cfg.origins.find((o) => o.host === host);
}

/** The Origin header a state-changing request or WebSocket to this site must carry. */
export function expectedOrigin(site: SiteOrigin | undefined, cfg: GuardConfig): string {
  return site?.origin ?? cfg.publicOrigin;
}

/**
 * A local origin is reached on this machine. A request for one that carries
 * Cloudflare's headers came through the tunnel with a forged Host: refuse it
 * rather than let it skip Access.
 */
export function tunnelProblem(headers: IncomingHttpHeaders, site: SiteOrigin | undefined): string | null {
  if (!site?.local) return null;
  return TUNNEL_HEADERS.some((name) => headers[name] !== undefined) ? 'tunnel request for a local origin' : null;
}

/**
 * Whether a device may pair or sign in through this site. A local origin is on
 * a loopback host (http:// or https://), where a browser shares one cookie jar
 * between every port: a device cookie there would also reach any other local
 * web server the browser opens (an agent's dev server, say), so only the
 * desktop app, with its own cookie jar, signs in there. Not a secret and not
 * proof of the app: page script on our own origin could send it too. It keeps
 * our own web app, in a browser, from ever taking a cookie on a local origin;
 * other sites can't send it (a custom header needs CORS, which we never grant).
 */
export function deviceSignInAllowed(headers: IncomingHttpHeaders, site: SiteOrigin | undefined): boolean {
  return !site?.local || header(headers, DESKTOP_APP_HEADER) === DESKTOP_APP_HEADER_VALUE;
}

function hasRequestMarker(headers: IncomingHttpHeaders): boolean {
  return header(headers, REQUEST_MARKER_HEADER) === '1' || header(headers, LEGACY_REQUEST_MARKER_HEADER) === '1';
}

/** Rules for JSON API calls made by our own frontend with fetch(). */
export function apiRequestProblem(method: string, headers: IncomingHttpHeaders, origin: string): string | null {
  if (!hasRequestMarker(headers)) return 'missing request marker';

  const site = header(headers, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin') return 'cross-site request';

  if (!SAFE_METHODS.has(method)) {
    if (header(headers, 'origin') !== origin) return 'bad origin';
    if (BODY_METHODS.has(method)) {
      const type = (header(headers, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (type !== 'application/json') return 'unsupported content type';
    }
  }
  return null;
}

/** Browsers always send Origin on WebSocket handshakes and page JS can't forge it. */
export function websocketProblem(headers: IncomingHttpHeaders, origin: string): string | null {
  if (header(headers, 'origin') !== origin) return 'bad websocket origin';
  const site = header(headers, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin') return 'cross-site websocket';
  return null;
}
