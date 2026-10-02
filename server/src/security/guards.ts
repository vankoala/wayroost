import type { IncomingHttpHeaders } from 'node:http';
import { REQUEST_MARKER_HEADER } from '../../../shared/protocol.js';

// Browser-side protections layered on top of the Access identity check. They
// stop other websites from driving the app through a logged-in browser
// (CSRF, cross-site WebSocket hijacking) and reject DNS-rebinding Host values.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export interface GuardConfig {
  publicOrigin: string;
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

/** Rules for JSON API calls made by our own frontend with fetch(). */
export function apiRequestProblem(
  method: string,
  headers: IncomingHttpHeaders,
  cfg: GuardConfig,
): string | null {
  if (header(headers, REQUEST_MARKER_HEADER) !== '1') return 'missing request marker';

  const site = header(headers, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin') return 'cross-site request';

  if (!SAFE_METHODS.has(method)) {
    if (header(headers, 'origin') !== cfg.publicOrigin) return 'bad origin';
    if (BODY_METHODS.has(method)) {
      const type = (header(headers, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (type !== 'application/json') return 'unsupported content type';
    }
  }
  return null;
}

/** Browsers always send Origin on WebSocket handshakes and page JS can't forge it. */
export function websocketProblem(headers: IncomingHttpHeaders, cfg: GuardConfig): string | null {
  if (header(headers, 'origin') !== cfg.publicOrigin) return 'bad websocket origin';
  const site = header(headers, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin') return 'cross-site websocket';
  return null;
}
