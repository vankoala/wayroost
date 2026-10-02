import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

// Cloudflare Access puts a signed JWT in `Cf-Access-Jwt-Assertion` on every
// request it lets through. We verify it ourselves on every request, so the app
// stays closed even if a tunnel route or Access policy is misconfigured.
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

export interface AccessIdentity {
  email: string;
  /** Token expiry, epoch seconds. */
  exp: number;
}

export class AccessDenied extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly reason: string,
  ) {
    super(reason);
  }
}

export type AccessVerifier = (token: string | undefined) => Promise<AccessIdentity>;

export interface AccessVerifierOptions {
  issuer: string;
  jwksUrl: string;
  aud: string;
  allowedEmails: string[];
  /** Injected key source for tests. */
  keySource?: JWTVerifyGetKey;
}

const MAX_TOKEN_LENGTH = 8192;
const PLAIN_ASCII = /^[\x21-\x7e]+$/;

/** Lowercase ASCII only; Unicode case folding could map look-alikes (e.g. "\u212A" → "k"). */
function normalizeEmail(email: string): string | null {
  return PLAIN_ASCII.test(email) ? email.replace(/[A-Z]/g, (ch) => ch.toLowerCase()) : null;
}

/**
 * Cloudflare's Access signing keys, fetched once and kept warm so a sign-in
 * never waits on a cold (slow first DNS lookup under WSL) key fetch. Unknown
 * key ids still trigger an immediate refetch, so key rotation just works.
 */
export function remoteAccessKeys(jwksUrl: string, onError: (err: unknown) => void) {
  const keySource = createRemoteJWKSet(new URL(jwksUrl), {
    timeoutDuration: 15_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 6 * 60 * 60_000,
  });
  const warm = () => keySource.reload().catch(onError);
  void warm();
  const timer = setInterval(warm, 30 * 60_000);
  timer.unref();
  return { keySource, stop: () => clearInterval(timer) };
}

export function createAccessVerifier(opts: AccessVerifierOptions): AccessVerifier {
  const keys =
    opts.keySource ??
    createRemoteJWKSet(new URL(opts.jwksUrl), {
      timeoutDuration: 15_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 6 * 60 * 60_000,
    });
  const allowed = new Set(opts.allowedEmails.map((e) => normalizeEmail(e)).filter((e): e is string => e !== null));

  return async (token) => {
    if (!token) throw new AccessDenied(401, 'missing access token');
    if (token.length > MAX_TOKEN_LENGTH) throw new AccessDenied(401, 'oversized access token');

    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer: opts.issuer,
        audience: opts.aud,
        algorithms: ['RS256'],
        clockTolerance: 30,
        requiredClaims: ['exp', 'iat'],
      }));
    } catch (err) {
      const code = (err as { code?: string }).code ?? (err as Error).name;
      throw new AccessDenied(401, `invalid access token (${code})`);
    }

    // Service tokens carry `common_name` instead of `email`; only people get in.
    const email = typeof payload.email === 'string' ? normalizeEmail(payload.email) : null;
    if (!email || !allowed.has(email)) throw new AccessDenied(403, 'identity not allowed');
    return { email, exp: payload.exp as number };
  };
}
