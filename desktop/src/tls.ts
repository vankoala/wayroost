import type { Session } from 'electron';
import { Agent, request as httpsRequest } from 'node:https';
import { connect, type TLSSocket } from 'node:tls';
import { ListenerIdentityError, ListenerNotPairedError, parsePin, verifyPinnedCertificate } from '../../lib/loopback-tls.js';
import { CODE_RE, normalizePairingCode } from '../../shared/pairing-code.js';
import { appOrigins } from './hardening.js';

export { ListenerIdentityError, ListenerNotPairedError };
export interface DesktopPins { serverPin: string; rescuePin: string }
export interface DesktopPairingToken extends DesktopPins { code: string }
export function parsePairingToken(value: string): DesktopPairingToken {
  if (value.length > 4096) throw new Error('Invalid desktop pairing token.');
  let token: Partial<DesktopPairingToken>;
  try { token = JSON.parse(value); } catch { throw new Error('Paste the desktop pairing token printed by sudo wayroost pair-desktop.'); }
  if (!token || typeof token.code !== 'string' || !CODE_RE.test(normalizePairingCode(token.code))) throw new Error('Invalid desktop pairing token.');
  return { code: normalizePairingCode(token.code), serverPin: parsePin(token.serverPin), rescuePin: parsePin(token.rescuePin) };
}

/** Enrollment uses the pasted pin on each socket, before any code or cookie is sent. */
export async function pairPinnedDesktop(origin: string, token: DesktopPairingToken): Promise<string> {
  const headers = { 'Content-Type': 'application/json', 'x-wayroost-request': '1', 'x-wayroost-app': 'desktop', Origin: origin };
  const paired = await pinnedRequest(new URL('/api/pair', origin), token.serverPin, headers, JSON.stringify({ code: token.code, name: 'Wayroost desktop' }));
  if (!paired.ok) throw new Error('The pairing code was refused. Run sudo wayroost pair-desktop again.');
  const cookie = /^wr_device=([A-Za-z0-9_.-]+);/.exec(paired.headers.get('set-cookie') ?? '')?.[1];
  if (!cookie) throw new Error('Pairing did not return a device cookie.');
  const identity = await pinnedRequest(new URL('/api/me', origin), token.serverPin, { ...headers, Cookie: `wr_device=${cookie}` });
  const data: unknown = identity.ok ? await identity.json() : undefined;
  if (!data || typeof data !== 'object' || !('device' in data) || !data.device || typeof data.device !== 'object' ||
    !('kind' in data.device) || data.device.kind !== 'desktop') throw new Error('The paired desktop identity was not verified.');
  return cookie;
}

export function desktopOrigin(value: string, development = false): string {
  const url = new URL(value);
  if (url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    !(url.protocol === 'https:' || (development && url.protocol === 'http:'))) throw new Error('Wayroost requires pinned loopback HTTPS; HTTP is only for desktop:dev.');
  return url.origin;
}

/** Certificate verification precedes every HTTP request and WebSocket upgrade in this session. */
export function installCertificatePin(target: Pick<Session, 'setCertificateVerifyProc'>, origin: string, pin: () => string | undefined, failed: (error: Error) => void = () => {}, accepted: () => void = () => {}) {
  const hostname = new URL(origin).hostname;
  target.setCertificateVerifyProc((request, callback) => {
    if (request.hostname !== hostname) { callback(-2); return; }
    try { verifyPinnedCertificate(request.certificate.data, pin(), hostname); callback(0); accepted(); }
    catch (error) { callback(-2); failed(error instanceof Error ? error : new ListenerIdentityError()); }
  });
}

/** The verify proc receives a hostname, so the request guard also restricts scheme and port. */
export function pinnedOriginRequest(url: string, origin: string, pin: string | undefined): boolean {
  try { const target = new URL(url).origin; const allowed = appOrigins(origin); return !!pin && (target === allowed.http || target === allowed.ws); }
  catch { return false; }
}

/** No HTTP bytes are handed to the socket until its own TLS handshake passes the pin check. */
export async function pinnedRequest(url: URL, pin: string | undefined, headers: Record<string, string>, body?: string, signal = AbortSignal.timeout(5000)): Promise<Response> {
  desktopOrigin(url.origin);
  if (!pin) throw new ListenerNotPairedError();
  parsePin(pin);
  const socket = await new Promise<TLSSocket>((resolve, reject) => {
    const connection = connect({ host: url.hostname, port: Number(url.port || 443), rejectUnauthorized: false, minVersion: 'TLSv1.2',
      ...(url.hostname === 'localhost' ? { servername: 'localhost' } : {}) });
    const abort = () => connection.destroy(signal.reason instanceof Error ? signal.reason : new Error('TLS request cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    connection.once('close', () => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
    connection.once('error', reject);
    connection.once('secureConnect', () => {
      try { verifyPinnedCertificate(connection.getPeerCertificate().raw, pin, url.hostname); resolve(connection); }
      catch (error) { connection.destroy(); reject(error); }
    });
  });
  const agent = new Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = () => socket;
  return new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(url, { method: body === undefined ? 'GET' : 'POST', headers, signal, agent }, (response) => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) request.destroy(new Error('Rescue response is too large.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        resolve(new Response(Buffer.concat(chunks).toString('utf8'), { status: response.statusCode ?? 500, headers: responseHeaders }));
      });
    });
    request.once('error', reject);
    request.once('close', () => { socket.destroy(); agent.destroy(); });
    request.end(body);
  });
}
