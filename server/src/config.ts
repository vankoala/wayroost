import type { ListenerTls } from '../../lib/loopback-tls.js';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SUPERVISOR_DEFAULTS } from '../../shared/supervisor.js';
import { isLoopbackHost as isLoopback } from '../../shared/gateway.js';
import { parseSupervisorKey } from './supervisor-key.js';
import type { ServerRole } from './background.js';
import { wayroostEnv } from './environment.js';
import { PRIMARY_STATE_DIR, SHADOW_STATE_DIR, validateStateDirectory } from './state-directory.js';

// Everything here fails closed: a config that could expose the app, or talk to
// anything other than local services, is rejected at startup.

const CLOUDFLARE_TEAM_RE = /^https:\/\/[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/;
export const DEFAULT_BRIDGE_PORT = 19012;
export const DEFAULT_HELPER_PORT = 19013;
export const DEFAULT_SPEECH_SOCKET = '/run/signalbox-speech.sock';
/** cloudflared's metrics server (deploy/cloudflared.yml.template). */
const CLOUDFLARED_METRICS_PORT = 19011;

/**
 * An absolute path with no control characters, at most maxBytes of it — counted in
 * bytes, because that is what the kernel counts: a Unix socket path has to fit
 * sun_path, 108 bytes with its NUL, so SUPERVISOR_SOCKET_PATH_BYTES is 107 of the
 * whole path including the leading slash.
 */
export const SUPERVISOR_SOCKET_PATH_BYTES = 107;

const absolutePath = (maxBytes: number) =>
  z
    .string()
    .regex(/^\/[^\u0000-\u001f\u007f]+$/, 'an absolute path without control characters')
    .refine((path) => Buffer.byteLength(path, 'utf8') <= maxBytes, `a path of at most ${maxBytes} bytes`);

/** An http address on loopback only: what the gateway's roles and the phone answer on. */
const loopbackHttp = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' && isLoopback(url.hostname) && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  }, 'an http address on a loopback address');
const unitName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,200}\.service$/, 'a systemd unit name');
const socketUnitName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,200}\.socket$/, 'a systemd socket unit name');

/** Whether this PC's own time-zone database knows the name; a quiet-hours span needs a real zone. */
function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const RawConfig = z
  .object({
    role: z.enum(['shadow', 'primary']).default('primary'),
    listen: z
      .object({
        host: z.string().default('127.0.0.1'),
        port: z.number().int().min(1).max(65535).default(19010),
      })
      .strict()
      .prefault({}),
    tls: z.object({ certFile: absolutePath(4096), keyFile: absolutePath(4096).optional() }).strict().optional(),
    /**
     * The local listener: a second loopback port for the paired desktop app on
     * this PC, which the tunnel never targets. A PC-only setting needs the
     * desktop app's request to arrive here. `pcOnlyWrites` stays off until the
     * desktop app is confirmed to reach this port; until then PC-only settings
     * are read-only on every device.
     */
    localListener: z
      .object({
        host: z.string().default('127.0.0.1'),
        port: z.number().int().min(1).max(65535),
        pcOnlyWrites: z.boolean().default(false),
      })
      .strict()
      .optional(),
    /** Public origin users reach through the tunnel, e.g. https://wayroost.example.com. One entry of the origins below. */
    publicOrigin: z.url().optional(),
    /**
     * Every origin the app is opened from: https:// ones (tunnel, tailnet, relay)
     * and local http://127.0.0.1:<port> ones (the PC's own app and browser).
     */
    origins: z.array(z.url()).max(16).optional(),
    /** Cloudflare Access: optional. When set, requests through a public origin need its token as well as a device. */
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
      .strict()
      .optional(),
    /** Device sign-in (pairing). Required in shadow; primary may use Access alone. */
    devices: z
      .object({ enabled: z.boolean().default(true) })
      .strict()
      .prefault({}),
    hermes: z
      .object({
        enabled: z.boolean().default(true),
        url: z.url().default('http://127.0.0.1:19006'),
        /** Answer Hermes' sudo, secret, vault and 2FA prompts from the phone. Off unless turned on. */
        secretPrompts: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    paseo: z
      .object({ enabled: z.boolean().default(true), url: z.string().default('ws://127.0.0.1:19007') })
      .strict()
      .prefault({}),
    /** Owner-side Safety RPC. Its shared key is supplied as safety-helper-key by systemd. */
    safetyHelper: z.object({ socket: z.string().startsWith('/').max(100).regex(/^[^\x00-\x1f]+$/) }).strict().optional(),
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
        cloudSocket: absolutePath(SUPERVISOR_SOCKET_PATH_BYTES).default('/run/wayroost-voice-cloud/voice.sock'),
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
    /**
     * Alerts: the owner's time zone, which quiet hours are read in. An IANA name as this
     * PC knows it ("Europe/Berlin", "UTC"); unset means the PC's own zone.
     */
    notifications: z
      .object({
        timeZone: z
          .string()
          .regex(/^[A-Za-z][A-Za-z0-9_+-]{1,31}(?:\/[A-Za-z0-9_+-]{1,31}){0,2}$/, 'an IANA time zone name')
          .refine(isKnownTimeZone, 'a time zone this PC knows')
          .optional(),
      })
      .strict()
      .prefault({}),
    /** Select the settings pipeline for the earlier settings routes at startup. */
    settings: z
      .object({ legacyRoutesViaPipeline: z.boolean().default(false),
        packBuildFile: absolutePath(4096).optional(),
        agentStatus: z.object({ home: absolutePath(4096), binaries: z.object({
          claude: absolutePath(4096).optional(), codex: absolutePath(4096).optional(), copilot: absolutePath(4096).optional(),
        }).strict() }).strict().optional(),
      })
      .strict()
      .prefault({}),
    /**
     * What the Checks page may look at directly on this PC: the role addresses,
     * the gateway's units, the coder MCP's two scripts, the phone's health answers,
     * Hermes' drain marker and the desktop switch's flag file. A check whose source
     * isn't given here answers "unknown"; none of these paths is one Wayroost writes.
     */
    checks: z
      .object({
        roleAddresses: z
          .object({ main: loopbackHttp, coder: loopbackHttp, fast: loopbackHttp })
          .strict()
          .optional(),
        gatewayUnits: z.object({ service: unitName, socket: socketUnitName }).strict().optional(),
        hermesGatewayUnit: unitName.optional(),
        coderMcp: z.object({ original: absolutePath(4096), gatewayCopy: absolutePath(4096) }).strict().optional(),
        phone: z.object({ server: loopbackHttp, bridge: loopbackHttp }).strict().optional(),
        drainMarker: z.object({ path: absolutePath(4096), stateFile: absolutePath(4096).optional(), executorUnit: unitName.optional() }).strict().optional(),
        switchFlagsFile: absolutePath(4096).optional(),
      })
      .strict()
      .optional(),
    /**
     * The supervisor: root's service on a Unix socket, which the
     * Status & power pages read and the power actions go through. Off when the
     * block is absent. In production its key comes as the systemd credential
     * supervisor-server-key (deploy/wayroost-server.service); `keyFile` is for
     * development. The server validates the key at startup and never logs it.
     */
    supervisor: z
      .object({
        expectedStatusOnly: z.boolean().default(true),
        socket: absolutePath(SUPERVISOR_SOCKET_PATH_BYTES).default(SUPERVISOR_DEFAULTS.socket),
        keyFile: absolutePath(4096).optional(),
      })
      .strict()
      .optional(),
    /** Writable directory for credentials the UI saves (e.g. the Hermes login). */
    stateDir: z.string().startsWith('/').optional(),
    /** Built web assets; defaults to ../web next to the server bundle. */
    staticDir: z.string().startsWith('/').optional(),
  })
  .strict();

/** One origin the app is opened from. */
export interface SiteOrigin {
  /** e.g. https://wayroost.example.com or http://127.0.0.1:8881 */
  origin: string;
  /** Its Host header value, lowercase. */
  host: string;
  /**
   * A local origin (a loopback host listed in `origins`, http:// or https://):
   * requests need a device only, from the desktop app. Every other origin is
   * public: Access too, when it's configured.
   */
  local: boolean;
}

/** What the Checks page may look at directly, besides what the settings reads answer. */
export interface ChecksConfig {
  roleAddresses?: Partial<Record<'main' | 'coder' | 'fast', string>>;
  gatewayUnits?: { service: string; socket: string };
  hermesGatewayUnit?: string;
  coderMcp?: { original: string; gatewayCopy: string };
  phone?: { server: string; bridge: string };
  drainMarker?: { path: string; stateFile?: string };
  switchFlagsFile?: string;
}

export interface AppConfig {
  role: ServerRole;
  listen: { host: string; port: number };
  /** The desktop app's PC-only port, when configured; it serves the same app over the same TLS. */
  localListener?: { host: string; port: number; pcOnlyWrites: boolean };
  tls?: ListenerTls;
  /** The main public origin: `publicOrigin`, else the first https:// origin, else the first origin. */
  publicOrigin: string;
  /** Every configured origin, `publicOrigin` first. */
  origins: SiteOrigin[];
  /** Host header values accepted (every origin's host plus the local listen address). */
  allowedHosts: Set<string>;
  /** Cloudflare Access, when configured. */
  access?: { issuer: string; jwksUrl: string; aud: string; allowedEmails: string[] };
  /** Device sign-in (pairing). */
  devices: { enabled: boolean };
  /** `secretPrompts`: Hermes' password prompts become cards you can answer; otherwise only a notice. */
  hermes: { enabled: boolean; url: string; secretPrompts: boolean };
  paseo: { enabled: boolean; url: string };
  safetyHelper?: { socket: string };
  /** The bridge listens on 127.0.0.1:<port> only. */
  bridge: { enabled: boolean; port: number };
  /** The Connectors helper on 127.0.0.1:<port>. */
  helper: { enabled: boolean; port: number };
  /** Voice mode: the speech service's Unix socket. */
  speech: { enabled: boolean; socket: string; cloudSocket: string };
  /** For you: cards from Hermes' pulse and phone notifications. */
  feed: { enabled: boolean };
  /** Alerts: the owner's time zone for quiet hours; unset means this PC's own zone. */
  notifications: { timeZone?: string };
  settings: { legacyRoutesViaPipeline: boolean; packBuildFile?: string;
    agentStatus?: { home: string; binaries: { claude?: string; codex?: string; copilot?: string } } };
  /** What the Checks page may probe here; every absent source makes its rows unknown. */
  checks?: ChecksConfig;
  /** The supervisor's Unix socket and key file; absent means the power API says it isn't running. */
  supervisor?: { socket: string; keyFile: string; expectedStatusOnly?: boolean };
  stateDir: string;
  staticDir?: string;
}

export class ConfigError extends Error {}

/** A hostname as written or as URL gives it ([::1]), lower-cased and without brackets. */
function bare(hostname: string): string {
  const host = hostname.toLowerCase();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Whether a browser opening this origin's host lands on the PC itself, for the
 * origin rules (a local origin is the desktop app's alone and is never the
 * public one). Wider than isLoopback, on purpose: a trailing dot (localhost.),
 * any *.localhost name (browsers send those to loopback), and the unspecified
 * addresses, which reach the PC's own listeners too. Origins come from URL,
 * which has already turned 127.1, 0x7f.1 and 2130706433 into 127.0.0.1.
 */
function isLocalHost(hostname: string): boolean {
  const host = bare(hostname).replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0' || host === '::' || host === '::ffff:0:0') return true;
  // Browser-local mapped addresses are protected as origins, but cannot be listener or backend hosts.
  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(host);
  if (mapped && (Number.parseInt(mapped[1]!, 16) >>> 8) === 127) return true;
  return isLoopback(host);
}

export interface ParseOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Tests and local end-to-end checks only: accept a loopback Access issuer and
   * plain-http loopback origin. Never set in production (the systemd unit doesn't).
   */
  allowLocalDev?: boolean;
  /**
   * The supervisor key systemd handed over as a credential, if any: its path,
   * $CREDENTIALS_DIRECTORY/supervisor-server-key (see supervisorKeyCredential).
   * It wins over supervisor.keyFile. Passed in, not looked up, so parsing never
   * depends on the environment or the disk.
   */
  supervisorKeyCredential?: string;
  /** Tools that never call the supervisor (the pairing recovery tool) don't need its key. */
  withoutSupervisor?: boolean;
}

export function resolveRole(role: ServerRole, env: NodeJS.ProcessEnv): ServerRole {
  const override = wayroostEnv('ROLE', env);
  if (override !== undefined && override !== 'shadow' && override !== 'primary') {
    throw new ConfigError('WAYROOST_ROLE (or SIGNALBOX_ROLE) must be shadow or primary');
  }
  return role === 'shadow' || override === 'shadow' ? 'shadow' : 'primary';
}

/** The systemd credential name the supervisor's server key comes under. */
export const SUPERVISOR_KEY_CREDENTIAL = 'supervisor-server-key';

/** Undefined only outside credential mode; a broken production credential refuses startup. */
export function supervisorKeyCredential(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = env.CREDENTIALS_DIRECTORY;
  if (dir === undefined) return undefined;
  if (!absolutePath(4096).safeParse(dir).success) {
    throw new ConfigError('CREDENTIALS_DIRECTORY must be an absolute path without control characters');
  }
  const path = join(dir, SUPERVISOR_KEY_CREDENTIAL);
  let text: string;
  try {
    if (!statSync(path).isFile()) throw new Error('not a regular file');
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`Cannot read the systemd credential ${SUPERVISOR_KEY_CREDENTIAL}`);
  }
  if (!parseSupervisorKey(text)) {
    throw new ConfigError(`Invalid systemd credential ${SUPERVISOR_KEY_CREDENTIAL}`);
  }
  return path;
}

function validateRawConfig(input: unknown): z.infer<typeof RawConfig> {
  const parsed = RawConfig.safeParse(input);
  if (!parsed.success) {
    throw new ConfigError(`Invalid config: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** One spelling per host, so an expanded IPv6 address matches its short form in an origin. */
function canonicalHost(host: string): string {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!bare.includes(':')) return bare;
  try {
    return new URL(`http://[${bare}]/`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return bare;
  }
}

export function parseConfig(input: unknown, options: ParseOptions = {}): AppConfig {
  const dev = options.allowLocalDev === true;
  const raw = validateRawConfig(input);
  const role = resolveRole(raw.role, options.env ?? process.env);
  let stateDir = raw.stateDir ?? (role === 'shadow' ? SHADOW_STATE_DIR : PRIMARY_STATE_DIR);
  if (role === 'shadow') {
    if (!raw.devices.enabled) {
      throw new ConfigError('Shadow requires device sign-in (devices.enabled)');
    }
    const explicit = input as { listen?: { port?: number } };
    if (explicit.listen?.port === undefined) {
      throw new ConfigError('Shadow requires explicit listen.port');
    }
    if ([19010, CLOUDFLARED_METRICS_PORT, DEFAULT_BRIDGE_PORT, DEFAULT_HELPER_PORT].includes(raw.listen.port)) {
      throw new ConfigError('Shadow listen.port must not use a primary service port');
    }
    try {
      stateDir = validateStateDirectory(stateDir, role);
    } catch (err) {
      throw new ConfigError((err as Error).message);
    }
  }

  if (!isLoopback(raw.listen.host)) {
    throw new ConfigError('listen.host must be a loopback address; only the tunnel should reach this app');
  }

  const origins: SiteOrigin[] = [];
  const declared = [
    ...(raw.publicOrigin ? [{ value: raw.publicOrigin, field: 'publicOrigin', listed: false }] : []),
    ...(raw.origins ?? []).map((value) => ({ value, field: 'origins', listed: true })),
  ];
  if (declared.length === 0) {
    throw new ConfigError('Set publicOrigin or origins: the addresses Wayroost is opened from');
  }
  for (const { value, field, listed } of declared) {
    const url = new URL(value);
    if (url.origin !== value.replace(/\/+$/, '')) {
      throw new ConfigError(`${field} entries must be bare origins like https://wayroost.example.com (no path)`);
    }
    // A plain-http origin is only ever a loopback one: listed in `origins`, it's
    // local (device sign-in, so devices must be on); as publicOrigin it's for tests.
    const loopback = isLocalHost(url.hostname);
    const localHttp = url.protocol === 'http:' && loopback;
    if (url.protocol !== 'https:' && !(localHttp && (listed || dev))) {
      throw new ConfigError(
        listed
          ? 'origins must use https, apart from local http://127.0.0.1:<port> (or localhost) ones'
          : 'publicOrigin must use https (plain http is only allowed for loopback testing)',
      );
    }
    // Local is a matter of the host, not the scheme: a browser shares its
    // cookies (Secure ones included) between every port of a loopback host,
    // so https:// there gets the same desktop-app-only rule as http://.
    if (loopback && !listed && !dev) {
      throw new ConfigError("publicOrigin is the address phones open, so it can't be a loopback one; list the PC's own address in origins");
    }
    const local = listed && loopback;
    if (local && !raw.devices.enabled) {
      throw new ConfigError('Local origins (127.0.0.1, localhost) need device sign-in (devices.enabled)');
    }
    const host = url.host.toLowerCase();
    // A request names its site by Host alone, so two origins on one Host
    // (http:// and https:// on the same loopback port) can't be told apart:
    // the Origin check and the Access rule would follow whichever came first.
    if (origins.some((o) => o.host === host && o.origin !== url.origin)) {
      throw new ConfigError(`${url.origin} shares its host with another origin; list only one scheme for ${host}`);
    }
    if (!origins.some((o) => o.origin === url.origin)) origins.push({ origin: url.origin, host, local });
  }

  // There is no unauthenticated mode: at least one of the two sign-ins is on.
  if (!raw.devices.enabled && !raw.access) {
    throw new ConfigError('Turn on device sign-in (devices.enabled) or configure access; Wayroost never runs without sign-in');
  }

  let access: AppConfig['access'];
  if (raw.access) {
    const issuer = raw.access.teamDomain.replace(/\/+$/, '');
    const issuerUrl = new URL(issuer);
    if (!CLOUDFLARE_TEAM_RE.test(issuer) && !(dev && isLoopback(issuerUrl.hostname))) {
      throw new ConfigError('access.teamDomain must look like https://<team>.cloudflareaccess.com');
    }
    const jwksUrl = raw.access.jwksUrl ?? `${issuer}/cdn-cgi/access/certs`;
    if (raw.access.jwksUrl && !jwksUrl.startsWith(`${issuer}/`)) {
      throw new ConfigError('access.jwksUrl must live under the team domain');
    }
    access = { issuer, jwksUrl, aud: raw.access.aud, allowedEmails: raw.access.allowedEmails.map((e) => e.toLowerCase()) };
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

  let localListener: AppConfig['localListener'];
  if (raw.localListener) {
    const local = raw.localListener;
    if (!isLoopback(local.host)) {
      throw new ConfigError('localListener.host must be a loopback address');
    }
    if (!raw.devices.enabled) {
      throw new ConfigError('The local listener is for the paired desktop app; turn on device sign-in (devices.enabled)');
    }
    if ([raw.listen.port, raw.bridge.port, raw.helper.port, CLOUDFLARED_METRICS_PORT].includes(local.port)) {
      throw new ConfigError("localListener.port must differ from listen.port, bridge.port, helper.port and cloudflared's metrics port");
    }
    if (role === 'shadow' && [19010, DEFAULT_BRIDGE_PORT, DEFAULT_HELPER_PORT].includes(local.port)) {
      throw new ConfigError('Shadow localListener.port must not use a primary service port');
    }
    // The desktop app opens this port by its own origin, which must be a listed local one.
    if (!origins.some((o) => {
      const origin = new URL(o.origin);
      const port = Number(origin.port || (origin.protocol === 'https:' ? 443 : 80));
      return o.local && canonicalHost(origin.hostname) === canonicalHost(local.host) && port === local.port;
    })) {
      throw new ConfigError(`List the local listener's address in origins (for example https://127.0.0.1:${local.port})`);
    }
    localListener = { host: local.host, port: local.port, pcOnlyWrites: local.pcOnlyWrites };
  }

  const allowedHosts = new Set([
    ...origins.map((o) => o.host),
    `127.0.0.1:${raw.listen.port}`,
    `localhost:${raw.listen.port}`,
  ]);
  const primary = raw.publicOrigin ? origins[0]! : (origins.find((o) => !o.local) ?? origins[0]!);

  // The systemd credential first; keyFile is the development fallback. A
  // supervisor block with neither has nothing to call with, so it's refused.
  let supervisor: AppConfig['supervisor'];
  if (raw.supervisor && !options.withoutSupervisor) {
    const credential = options.supervisorKeyCredential;
    if (credential !== undefined && !absolutePath(4096).safeParse(credential).success) {
      throw new ConfigError('The supervisor key credential must be an absolute path without control characters');
    }
    const keyFile = credential ?? raw.supervisor.keyFile;
    if (!keyFile) {
      throw new ConfigError(
        `The supervisor needs its key: the systemd credential ${SUPERVISOR_KEY_CREDENTIAL}, or supervisor.keyFile in development`,
      );
    }
    supervisor = { socket: raw.supervisor.socket, keyFile, expectedStatusOnly: raw.supervisor.expectedStatusOnly };
  }

  return {
    role,
    listen: raw.listen,
    ...(localListener ? { localListener } : {}),
    ...(raw.tls ? { tls: raw.tls } : {}),
    publicOrigin: primary.origin,
    origins,
    allowedHosts,
    ...(access ? { access } : {}),
    devices: { enabled: raw.devices.enabled },
    hermes: { enabled: raw.hermes.enabled, url: hermesUrl.origin, secretPrompts: raw.hermes.secretPrompts },
    paseo: { enabled: raw.paseo.enabled, url: raw.paseo.url.replace(/\/+$/, '') },
    ...(raw.safetyHelper ? { safetyHelper: raw.safetyHelper } : {}),
    bridge: { enabled: raw.bridge.enabled, port: raw.bridge.port },
    helper: { enabled: raw.helper.enabled, port: raw.helper.port },
    speech: { enabled: raw.speech.enabled, socket: raw.speech.socket, cloudSocket: raw.speech.cloudSocket },
    feed: { enabled: raw.feed.enabled },
    notifications: raw.notifications.timeZone ? { timeZone: raw.notifications.timeZone } : {},
    settings: raw.settings,
    ...(raw.checks ? { checks: raw.checks } : {}),
    ...(supervisor ? { supervisor } : {}),
    stateDir,
    ...(raw.staticDir ? { staticDir: raw.staticDir } : {}),
  };
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return wayroostEnv('CONFIG', env) ?? '/etc/wayroost/config.json';
}

export function loadConfig(path: string, options: ParseOptions = {}): AppConfig {
  return parseConfig(readConfigFile(path), options);
}

/** Resolve startup credentials separately from the deterministic config parser. */
export function loadStartupConfig(path: string, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const json = readConfigFile(path);
  const raw = validateRawConfig(json);
  const credential = raw.supervisor ? supervisorKeyCredential(env) : undefined;
  // The file as written, so the shadow's explicit-port rule sees what the config says.
  const parsed = parseConfig(json, {
    env,
    allowLocalDev: wayroostEnv('DEV_ALLOW_LOOPBACK', env) === '1',
    ...(credential ? { supervisorKeyCredential: credential } : {}),
  });
  const desktopListener = parsed.role === 'shadow' || parsed.localListener !== undefined || (parsed.devices.enabled && parsed.origins.some(origin => origin.local));
  if (desktopListener && !parsed.tls && wayroostEnv('DEV_ALLOW_LOOPBACK', env) !== '1') throw new ConfigError('Installed listeners require TLS; HTTP is only available with WAYROOST_DEV_ALLOW_LOOPBACK=1 in development.');
  if (parsed.tls?.keyFile && wayroostEnv('DEV_ALLOW_LOOPBACK', env) !== '1') throw new ConfigError('Installed TLS keys must use LoadCredential, not tls.keyFile.');
  return parsed;
}

function readConfigFile(path: string): unknown {
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
  return json;
}
