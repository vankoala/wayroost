import { checkDeviceSignal, deviceSignal, actionSignal } from '../security/device-signal.js';
import type { HermesCredentials } from '../secrets.js';

// Signs in to the Hermes dashboard the way its own clients do: password login
// returns session cookies, whose values double as Bearer tokens; the refresh
// token is exchanged at /auth/native/refresh. Tokens never leave this process.

export type HermesAuthErrorKind = 'no_credentials' | 'bad_credentials' | 'throttled' | 'unavailable';

export class HermesAuthError extends Error {
  constructor(
    message: string,
    readonly kind: HermesAuthErrorKind,
    readonly status?: number,
  ) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 15_000;
const EXPIRY_MARGIN_MS = 2 * 60_000;
const FALLBACK_TTL_MS = 60 * 60_000;

/** Pull `hermes_session_at` / `hermes_session_rt` out of Set-Cookie headers. */
export function parseSessionCookies(setCookies: string[]): { access?: string; refresh?: string } {
  const out: { access?: string; refresh?: string } = {};
  for (const header of setCookies) {
    const first = header.split(';', 1)[0] ?? '';
    const eq = first.indexOf('=');
    if (eq === -1) continue;
    const name = first.slice(0, eq).trim().replace(/^__(Host|Secure)-/, '');
    let value = first.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!value) continue;
    if (name === 'hermes_session_at') out.access = value;
    else if (name === 'hermes_session_rt') out.refresh = value;
  }
  return out;
}

export class HermesAuth {
  private accessToken: string | undefined;
  private refreshToken: string | undefined;
  private expiresAt = 0;
  private inflight: Promise<void> | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly credentials: () => HermesCredentials | null,
  ) {}

  hasCredentials(): boolean {
    return this.credentials() !== null;
  }

  /** Forget tokens (e.g. after credentials change). */
  reset(): void {
    this.accessToken = undefined;
    this.refreshToken = undefined;
    this.expiresAt = 0;
  }

  /** Verify a username/password pair and adopt the resulting session. */
  async login(explicit?: HermesCredentials, signal = deviceSignal()): Promise<void> {
    const creds = explicit ?? this.credentials();
    if (!creds) throw new HermesAuthError('Sign in to Hermes in Settings.', 'no_credentials');

    let res: Response;
    try {
      checkDeviceSignal(signal);
      res = await fetch(`${this.baseUrl}/auth/password-login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ provider: 'basic', username: creds.username, password: creds.password, next: '' }),
        signal: actionSignal(AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal),
      });
    } catch {
      checkDeviceSignal(signal);
      throw new HermesAuthError("Can't reach the Hermes dashboard.", 'unavailable');
    }
    if (res.status === 401 || res.status === 422) {
      throw new HermesAuthError('Hermes rejected that username or password.', 'bad_credentials');
    }
    if (res.status === 429) {
      throw new HermesAuthError('Too many Hermes sign-in attempts. Try again in a minute.', 'throttled');
    }
    if (!res.ok) throw new HermesAuthError(`Hermes sign-in failed (${res.status}).`, 'unavailable');

    const { access, refresh } = parseSessionCookies(res.headers.getSetCookie());
    if (!access || !refresh) throw new HermesAuthError('Hermes sign-in returned no session.', 'unavailable');
    checkDeviceSignal(signal);
    this.accessToken = access;
    this.refreshToken = refresh;
    const expiry = await this.lookupExpiry(access, signal);
    checkDeviceSignal(signal);
    this.expiresAt = expiry;
  }

  /** A currently valid access token, refreshing or signing in again as needed. */
  async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - EXPIRY_MARGIN_MS) return this.accessToken;
    this.inflight ??= this.renew().finally(() => {
      this.inflight = undefined;
    });
    await this.inflight;
    return this.accessToken!;
  }

  /** fetch() against the dashboard with auth; retries once after a 401. */
  async fetch(path: string, init: RequestInit = {}, signal = deviceSignal()): Promise<Response> {
    const send = async () => {
      checkDeviceSignal(signal);
      const token = await this.token();
      checkDeviceSignal(signal);
      return fetch(`${this.baseUrl}${path}`, {
        ...init,
        redirect: 'manual',
        headers: { accept: 'application/json', ...init.headers, authorization: `Bearer ${token}` },
        signal: actionSignal(init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal),
      });
    };
    let res = await send();
    if (res.status === 401) {
      this.accessToken = undefined; // force refresh / re-login
      res = await send();
    }
    return res;
  }

  async json<T>(path: string, init: RequestInit = {}, signal = deviceSignal()): Promise<T> {
    const res = await this.fetch(path, init, signal);
    if (!res.ok) throw new HermesAuthError(`Hermes request failed (${res.status}).`, 'unavailable', res.status);
    return (await res.json()) as T;
  }

  private async renew(): Promise<void> {
    if (this.refreshToken) {
      let res: Response;
      try {
        checkDeviceSignal();
        res = await fetch(`${this.baseUrl}/auth/native/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ refresh_token: this.refreshToken, provider: 'basic' }),
          signal: actionSignal(AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
        });
      } catch {
        checkDeviceSignal();
        // Hermes is unreachable: retry later rather than sending the password
        // to whatever might be listening on its port.
        throw new HermesAuthError("Can't reach the Hermes dashboard.", 'unavailable');
      }
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          access_token?: string;
          refresh_token?: string;
          expires_at?: number;
        };
        if (body.access_token && body.refresh_token) {
          checkDeviceSignal();
          this.accessToken = body.access_token;
          this.refreshToken = body.refresh_token;
          this.expiresAt = body.expires_at ? body.expires_at * 1000 : Date.now() + FALLBACK_TTL_MS;
          return;
        }
      }
      // Only an explicit "session expired" (e.g. Hermes restarted with a new
      // signing secret) justifies signing in with the password again.
      if (res.status !== 401) throw new HermesAuthError(`Hermes sign-in refresh failed (${res.status}).`, 'unavailable');
    }
    this.reset();
    await this.login();
  }

  private async lookupExpiry(token: string, signal = deviceSignal()): Promise<number> {
    try {
      checkDeviceSignal(signal);
      const res = await fetch(`${this.baseUrl}/api/auth/me`, {
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        signal: actionSignal(AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal),
      });
      if (res.ok) {
        const me = (await res.json()) as { expires_at?: number };
        if (typeof me.expires_at === 'number') return me.expires_at * 1000;
      }
    } catch {
      checkDeviceSignal(signal);
      // use the fallback below
    }
    return Date.now() + FALLBACK_TTL_MS;
  }
}
