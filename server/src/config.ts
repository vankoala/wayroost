import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Everything here fails closed: a config that could expose the app, or talk to
// anything other than local services, is rejected at startup.

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const CLOUDFLARE_TEAM_RE = /^https:\/\/[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/;
export const DEFAULT_BRIDGE_PORT = 8792;
export const DEFAULT_HELPER_PORT = 8793;
export const DEFAULT_SPEECH_SOCKET = '/run/signalbox-speech.sock';
/** cloudflared's metrics server (deploy/cloudflared.yml.template). */
const CLOUDFLARED_METRICS_PORT = 8791;

const RawConfig = z
  .object({
    listen: z
      .object({
        host: z.string().default('127.0.0.1'),
        port: z.number().int().min(1).max(65535).default(8790),
      })
      .strict()
      .prefault({}),
    /** Public origin users reach through the tunnel, e.g. https://signalbox.example.com */
    publicOrigin: z.url(),
    access: z
      .object({
        /** https://<team>.cloudflareaccess.com */
        teamDomain: z.url(),
        /** Application Audience (AUD) tag of the Cloudflare Access application. */
        aud: z.string().min(1),
        allowedEmails: z.array(z.email().regex(/^[\x21-\x7e]+$/, 'emails must be plain ASCII')).min(1),
        /** Override for tests only; defaults to <teamDomain>/cdn-cgi/access/certs. */
        jwksUrl: z.url().optional(),
      })
      .strict(),
    hermes: z
      .object({
        enabled: z.boolean().default(true),
        url: z.url().default('http://127.0.0.1:9119'),
        /** Answer Hermes' sudo, secret, vault and 2FA prompts from the phone. Off unless turned on. */
        secretPrompts: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    paseo: z
      .object({ enabled: z.boolean().default(true), url: z.string().default('ws://127.0.0.1:6777') })
      .strict()
      .prefault({}),
    /** Project bridge: a loopback-only listener agents' bridge tool talks to. Off unless turned on. */
    bridge: z
      .object({
        enabled: z.boolean().default(false),
        port: z.number().int().min(1).max(65535).default(DEFAULT_BRIDGE_PORT),
      })
      .strict()
      .prefault({}),
    /**
     * The Connectors helper (deploy/setup-helper.sh): Google sign-in and mail
     * triggers, run as the Hermes user on 127.0.0.1. Off unless turned on; its
     * secret comes from systemd (LoadCredential=helper-token).
     */
    helper: z
      .object({
        enabled: z.boolean().default(false),
        port: z.number().int().min(1).max(65535).default(DEFAULT_HELPER_PORT),
      })
      .strict()
      .prefault({}),
    /**
     * Voice mode (deploy/setup-speech.sh): the local speech service's Unix socket,
     * which writes down what you say and reads replies aloud. Off unless turned on.
     */
    speech: z
      .object({
        enabled: z.boolean().default(false),
        socket: z.string().startsWith('/').default(DEFAULT_SPEECH_SOCKET),
      })
      .strict()
      .prefault({}),
    /**
     * For you: cards from Hermes' pulse (posted through the bridge listener) and
     * phone notifications. Off unless turned on; needs the bridge for the pulse to post.
     */
    feed: z
      .object({ enabled: z.boolean().default(false) })
      .strict()
      .prefault({}),
    /** Writable directory for credentials the UI saves (e.g. the Hermes login). */
    stateDir: z.string().startsWith('/'),
    /** Built web assets; defaults to ../web next to the server bundle. */
    staticDir: z.string().startsWith('/').optional(),
  })
  .strict();

export interface AppConfig {
  listen: { host: string; port: number };
  publicOrigin: string;
  /** Host header values accepted (public host plus the local listen address). */
  allowedHosts: Set<string>;
  access: { issuer: string; jwksUrl: string; aud: string; allowedEmails: string[] };
  /** `secretPrompts`: Hermes' password prompts become cards you can answer; otherwise only a notice. */
  hermes: { enabled: boolean; url: string; secretPrompts: boolean };
  paseo: { enabled: boolean; url: string };
  /** The bridge listens on 127.0.0.1:<port> only. */
  bridge: { enabled: boolean; port: number };
  /** The Connectors helper on 127.0.0.1:<port>. */
  helper: { enabled: boolean; port: number };
  /** Voice mode: the speech service's Unix socket. */
  speech: { enabled: boolean; socket: string };
  /** For you (Hermes' pulse feed) and phone notifications. */
  feed: { enabled: boolean };
  stateDir: string;
  staticDir?: string;
}

export class ConfigError extends Error {}

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

export interface ParseOptions {
  /**
   * Tests and local end-to-end checks only: accept a loopback Access issuer and
   * plain-http loopback origin. Never set in production (the systemd unit doesn't).
   */
  allowLocalDev?: boolean;
}

export function parseConfig(input: unknown, options: ParseOptions = {}): AppConfig {
  const dev = options.allowLocalDev === true;
  const parsed = RawConfig.safeParse(input);
  if (!parsed.success) {
    throw new ConfigError(`Invalid config: ${z.prettifyError(parsed.error)}`);
  }
  const raw = parsed.data;

  if (!isLoopback(raw.listen.host)) {
    throw new ConfigError('listen.host must be a loopback address; only the tunnel should reach this app');
  }

  const origin = new URL(raw.publicOrigin);
  if (origin.origin !== raw.publicOrigin.replace(/\/+$/, '')) {
    throw new ConfigError('publicOrigin must be a bare origin like https://signalbox.example.com (no path)');
  }
  if (origin.protocol !== 'https:' && !(dev && origin.protocol === 'http:' && isLoopback(origin.hostname))) {
    throw new ConfigError('publicOrigin must use https (plain http is only allowed for loopback testing)');
  }

  const issuer = raw.access.teamDomain.replace(/\/+$/, '');
  const issuerUrl = new URL(issuer);
  if (!CLOUDFLARE_TEAM_RE.test(issuer) && !(dev && isLoopback(issuerUrl.hostname))) {
    throw new ConfigError('access.teamDomain must look like https://<team>.cloudflareaccess.com');
  }
  const jwksUrl = raw.access.jwksUrl ?? `${issuer}/cdn-cgi/access/certs`;
  if (raw.access.jwksUrl && !jwksUrl.startsWith(`${issuer}/`)) {
    throw new ConfigError('access.jwksUrl must live under the team domain');
  }

  if (!raw.hermes.enabled && !raw.paseo.enabled) {
    throw new ConfigError('Enable at least one of hermes or paseo');
  }

  const hermesUrl = new URL(raw.hermes.url);
  if (!isLoopback(hermesUrl.hostname) || !['http:', 'https:'].includes(hermesUrl.protocol)) {
    throw new ConfigError('hermes.url must be an http:// or https:// loopback address');
  }
  const paseoUrl = new URL(raw.paseo.url);
  if (!isLoopback(paseoUrl.hostname) || !['ws:', 'wss:'].includes(paseoUrl.protocol)) {
    throw new ConfigError('paseo.url must be a ws:// or wss:// loopback address');
  }

  if (raw.bridge.port === raw.listen.port) {
    throw new ConfigError('bridge.port must differ from listen.port');
  }
  if (raw.bridge.port === CLOUDFLARED_METRICS_PORT) {
    throw new ConfigError(`bridge.port can't be ${CLOUDFLARED_METRICS_PORT}; cloudflared's metrics use it`);
  }

  if ([raw.listen.port, raw.bridge.port, CLOUDFLARED_METRICS_PORT].includes(raw.helper.port)) {
    throw new ConfigError('helper.port must differ from listen.port, bridge.port and cloudflared\'s metrics port');
  }

  const allowedHosts = new Set([
    origin.host.toLowerCase(),
    `127.0.0.1:${raw.listen.port}`,
    `localhost:${raw.listen.port}`,
  ]);

  return {
    listen: raw.listen,
    publicOrigin: origin.origin,
    allowedHosts,
    access: {
      issuer,
      jwksUrl,
      aud: raw.access.aud,
      allowedEmails: raw.access.allowedEmails.map((e) => e.toLowerCase()),
    },
    hermes: { enabled: raw.hermes.enabled, url: hermesUrl.origin, secretPrompts: raw.hermes.secretPrompts },
    paseo: { enabled: raw.paseo.enabled, url: raw.paseo.url.replace(/\/+$/, '') },
    bridge: { enabled: raw.bridge.enabled, port: raw.bridge.port },
    helper: { enabled: raw.helper.enabled, port: raw.helper.port },
    speech: { enabled: raw.speech.enabled, socket: raw.speech.socket },
    feed: { enabled: raw.feed.enabled },
    stateDir: raw.stateDir,
    ...(raw.staticDir ? { staticDir: raw.staticDir } : {}),
  };
}

export function loadConfig(path: string, options: ParseOptions = {}): AppConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read config at ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ConfigError(`Config at ${path} is not valid JSON`);
  }
  return parseConfig(json, options);
}
