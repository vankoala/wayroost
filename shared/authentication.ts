import { WS_CLOSE_DEVICE_REVOKED, WS_CLOSE_SESSION_EXPIRED } from './protocol.js';

export type AuthenticationLoss = 'unpaired' | 'session-expired';
export interface AuthenticationSignal {
  status?: number;
  type?: string;
  error?: unknown;
  code?: number;
}
export interface AuthenticationDecision {
  loss: AuthenticationLoss | null;
  retire: boolean;
}

/** Device revocation and Access expiration mean different recovery steps on every client path. */
export function authenticationLoss(signal: AuthenticationSignal): AuthenticationLoss | null {
  if (signal.code === WS_CLOSE_DEVICE_REVOKED) return 'unpaired';
  if (signal.type === 'opaqueredirect' || signal.code === WS_CLOSE_SESSION_EXPIRED) return 'session-expired';
  if (signal.status === 401) return signal.error === 'unpaired' || typeof signal.error !== 'string' || !signal.error.trim() ? 'unpaired' : 'session-expired';
  return null;
}

/**
 * A socket's own authentication signal: an authentication close (4401, 4403), or the status of an upgrade the
 * server refused before the socket opened. As for HTTP requests, 401 and 403 are sign-in losses and a redirect
 * is an expired sign-in; an upgrade response has no body to read, so 401 and 403 take the stricter unpaired path.
 * Anything else (5xx, network failures, ordinary closes) is not an authentication loss.
 */
export function socketAuthenticationLoss({ code, status }: { code?: number; status?: number }): AuthenticationLoss | null {
  if (status === 401 || status === 403) return authenticationLoss({ status: 401 });
  if (status !== undefined && status >= 300 && status < 400) return authenticationLoss({ type: 'opaqueredirect' });
  return authenticationLoss({ code });
}

/** Unverified 401s and device revocation require complete retirement. */
export function authenticationDecision(signal: AuthenticationSignal): AuthenticationDecision {
  const loss = authenticationLoss(signal);
  return { loss, retire: loss === 'unpaired' };
}

export const AUTHENTICATION_TIMEOUT_MS = 2000;
/** Identity and approval responses carry the authority used by the desktop. */
export function authenticationEndpoint(path: string): boolean {
  const route = path.split('?')[0];
  return route === '/api/me' || route === '/api/conversations' || !!route?.startsWith('/api/conversations/');
}

export function authenticationHttpFailure(status: number): boolean {
  return status === 401 || (status >= 300 && status < 400);
}

export function authenticationError(error: unknown): boolean {
  return typeof error === 'string' && /^(unpaired|session expired|sign in again\.?|pair this device before controlling the PC\.?)$/i.test(error);
}

const BODY_MAX_BYTES = 4096;
interface AuthenticationResponse {
  status: number; type?: string; body?: ReadableStream<Uint8Array> | null; json(): Promise<unknown>;
}

/** Suspend at the status, before reading; an unverified body always takes the stricter recovery path. */
export async function responseAuthenticationDecision(response: AuthenticationResponse, suspend?: () => void): Promise<AuthenticationDecision> {
  if (response.status !== 401) return authenticationDecision(response);
  suspend?.();
  if (response.type === 'opaqueredirect') return authenticationDecision(response);
  try {
    const data = await readAuthenticationBody(response);
    const error = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
    return authenticationDecision({ status: 401, error });
  } catch { return authenticationDecision({ status: 401 }); }
}

/** Authentication errors and identity responses have a small, bounded body. */
export async function readAuthenticationBody(response: Pick<AuthenticationResponse, 'body' | 'json'>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.body?.getReader();
    const read = async (): Promise<unknown> => {
      if (!reader) {
        // Non-stream response implementations still get a deadline and a size check.
        const data = await response.json();
        if (new TextEncoder().encode(JSON.stringify(data)).byteLength > BODY_MAX_BYTES) throw new Error('Authentication body too large.');
        return data;
      }
      let bytes = 0;
      let text = '';
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > BODY_MAX_BYTES) throw new Error('Authentication body too large.');
        text += decoder.decode(chunk.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode()) as unknown;
    };
    return await Promise.race([read(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Authentication body timed out.')), AUTHENTICATION_TIMEOUT_MS);
    })]);
  } finally {
    clearTimeout(timer);
    // Cancellation itself may stall; it must never delay retirement.
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

export async function responseAuthenticationLoss(response: AuthenticationResponse): Promise<AuthenticationLoss | null> {
  return (await responseAuthenticationDecision(response)).loss;
}
