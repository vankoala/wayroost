import { checkDeviceSignal, withDeviceSignal, actionSignal } from './security/device-signal.js';
import { listenerTls } from '../../lib/loopback-tls.js';
import { wayroostEnv } from './environment.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CLOUD_AGENT_IDS,
  CONNECTOR_ACCESS,
  SOURCES,
  SCHEDULE_TOOL_LEVELS,
  TRIGGER_INTERVALS,
  VOICE_SPEAK_MAX_CHARS,
  FEED_ACTIONS,
  PROACTIVITY_LEVELS,
  DEVICE_KINDS,
  WS_CLOSE_DEVICE_REVOKED,
  WS_CLOSE_REAUTH,
  WS_CLOSE_SESSION_EXPIRED,
  type DeviceInfo,
  type DeviceList,
  type PairOffer,
  type PairResult,
  PAIR_PATH,
  type ArchivedList,
  type BridgeStatus,
  type CleanupPreview,
  type CloudAgentsStatus,
  type SafetyCommandsStatus,
  WORKER_TIME_BOXES,
  type WorkerUpdatesStatus,
  type TaskList,
  type CommandCatalog,
  type ConnectFlow,
  type ConnectStart,
  type ConnectorList,
  type ControlChangeResponse,
  type ConversationControls,
  type CreateResponse,
  type ListResponse,
  type MeResponse,
  type SendResponse,
  type FolderScope,
  type FolderStatus,
  type Source,
  type SourceStatus,
  type ThreadActionResult,
  type ThreadRef,
  type TriggerList,
  type VoiceSaveResult,
  type VoiceStatus,
  type FeedActionResult,
  type FeedList,
  type FeedSettings,
  WHATSAPP_FRESH_HOURS,
  WHATSAPP_RETURN_MINUTES,
  type WhatsAppRouting,
  type PhoneStatus,
  SCHEDULE_SOURCES,
  type ScheduleDraft,
  type ScheduleList,
  type ScheduleOverview,
  type ScheduleRun,
} from '../../shared/protocol.js';
import { SAFETY_COMMANDS } from './hermes/commands.js';
import type { SafetyCommandsSetting } from './hermes/safety.js';
import type { WorkerUpdatesSetting } from './tasks/setting.js';
import type { TaskRelay } from './tasks/relay.js';
import type { Bridge } from './bridge/service.js';
import type { AppConfig } from './config.js';
import type { HelperApi } from './connectors/helper.js';
import { DraftInput, ScheduleInput, ScheduleUpdate, type Schedules } from './schedules.js';
import type { Skills } from './skills.js';
import { SKILL_NAME, SKILL_PLACE, type MarketPreview, type MarketSearch, type SkillList } from '../../shared/skills.js';
import { CALLBACK_PREFIX, type Connectors } from './connectors/service.js';
import type { EventHub } from './hub.js';
import { ACCESS_JWT_HEADER, AccessDenied, type AccessIdentity, type AccessVerifier } from './security/access.js';
import {
  apiRequestProblem,
  deviceSignInAllowed,
  expectedOrigin,
  hostProblem,
  siteFor,
  tunnelProblem,
  websocketProblem,
} from './security/guards.js';
import {
  DeviceIdParam,
  DeviceName,
  Devices,
  PairingRefused,
  clearedDeviceCookie,
  deviceCookie,
  deviceKind,
  isDeviceCookieValue,
  readDeviceCookies,
  requestDevice,
  type PairRefusal,
  type RequestDevice,
} from './devices.js';
import { securityHeaders } from './security/headers.js';
import { ATTACHMENT_BODY_LIMIT, AttachmentInput, decodeAttachments, safeFileName, sniffImage } from './attachments.js';
import { MAX_MEDIA_BYTES, MediaLinks, mediaPathProblem } from './media.js';
import { pcmWav, readAloud, VoiceSession, type SpeechService } from './speech.js';
import { CloudSpeechError, type CloudSpeechService } from './cloud-speech.js';
import { CLOUD_ID, type SpeechFrame } from '../../shared/voice.js';
import { Readable } from 'node:stream';
import { VOICE_NAME, VoiceSetting } from './voice-setting.js';
import type { Feed } from './feed/service.js';
import { HHMM } from './feed/store.js';
import { PushSubscriptionInput } from './feed/push.js';
import { UserFacingError, type Sources } from './sources.js';
import type { SupervisorApi } from './supervisor-client.js';
import { Power, type PowerOptions } from './power.js';
import { PRESENCE_STATES, type PowerActionResponse, type PowerStatus } from '../../shared/protocol.js';
import { SUPERVISOR_VERBS } from '../../shared/supervisor.js';
import type { ActionRequest, SupervisorVerb } from '../../shared/supervisor.js';
import { WorkerApprovalsWrite, pendingWorkerApprovals, type WorkerApprovalsApi, type WorkerApprovalsStatus } from '../../shared/safety.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The Cloudflare Access identity, on requests through a public origin when Access is configured. */
    identity?: AccessIdentity;
    /** The paired device making the request. */
    device?: DeviceInfo;
    deviceSignal?: AbortSignal;
  }
  interface FastifyContextConfig {
    /** Reachable without a paired device: the pairing call and the app shell that hosts the pairing page. */
    deviceOptional?: boolean;
  }
}

export interface AppDeps {
  config: AppConfig;
  /** Checks Cloudflare Access tokens; required when `config.access` is set. */
  verifier?: AccessVerifier;
  /** Paired devices; made from `config.stateDir` when device sign-in is on and none is given. */
  devices?: Devices;
  hub: EventHub;
  sources: Sources;
  /** Fastify logger options; false in tests. */
  logger?: boolean | Record<string, unknown>;
  /** Longest a live socket may stay open before signing in again (through Access, or the device check). */
  wsMaxLifetimeMs?: number;
  /** The project bridge, when it's turned on and listening. */
  bridge?: Pick<Bridge, 'status' | 'setPaused'>;
  /** Settings → Connectors, when Hermes is on. */
  connectors?: Connectors;
  /** Voice mode, when it's turned on (deploy/setup-speech.sh). */
  speech?: SpeechService;
  cloudSpeech?: CloudSpeechService;
  /** For you (Hermes' pulse feed) and phone notifications, when turned on. */
  feed?: Feed;
  /** Settings → WhatsApp, through the helper, when Hermes is on and the helper is set up. */
  whatsappRouting?: Pick<HelperApi, 'whatsappRouting' | 'setWhatsappRouting'>;
  /** Settings → Scheduled jobs (Hermes cron), when Hermes is on. */
  schedules?: Schedules;
  /** Settings → Security → "Hermes safety commands", when Hermes is on. */
  safetyCommands?: SafetyCommandsSetting;
  workerApprovals?: WorkerApprovalsApi;
  /** Settings → Phone (Hermes Phone line status and PIN), through the helper. */
  phone?: Pick<HelperApi, 'phone' | 'phonePin' | 'setPhonePin' | 'setPhoneVoice'>;
  /** Settings → Skills, through the helper. */
  skills?: Skills;
  /**
   * The supervisor (Status & power). Absent means this Signalbox has no
   * supervisor to talk to, and the power API says so in one plain line.
   */
  supervisor?: SupervisorApi;
  /** Tests: a short confirm life, a clock they control. */
  power?: PowerOptions;
  /** Settings → Project bridge → Worker updates, when the task log runs (bridge, Hermes and Paseo all on). */
  workerUpdates?: Pick<WorkerUpdatesSetting, 'status' | 'update'>;
  /** The authenticated, read-only task ledger, when worker updates are available. */
  tasks?: Pick<TaskRelay, 'status'>;
}

// Files a browser may fetch while installing the app to the home screen. They
// hold nothing sensitive, and Cloudflare Access still gates them at the edge.
const INSTALL_ASSETS = new Set([
  '/manifest.webmanifest',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const CHANGE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * Changes that must work without a paired device, as "METHOD /route": redeeming a
 * pairing code. Recovery runs over the pairing socket (pairing-socket.ts), not here.
 * Every other change is re-checked against the live device store (see buildApp).
 */
export const LIVE_DEVICE_EXEMPT: readonly string[] = ['POST /api/pair'];
const CHANGE_ROUTES = new WeakMap<FastifyInstance, string[]>();
/** Every mutating route an app registered, as "METHOD /route" (for the test that holds them all to the check). */
export function changeRoutes(app: FastifyInstance): readonly string[] {
  return CHANGE_ROUTES.get(app) ?? [];
}
const MAX_TIMER_MS = 2 ** 31 - 1;
const WS_MAX_LIFETIME_MS = 30 * 60_000;
const HEARTBEAT_MS = 30_000;

const SourceParam = z.enum(['hermes', 'paseo']);
// Hermes stored ids look like 20260101_120000_abc123; Paseo uses UUIDs; approval ids like srq-3f2a9c1b.q0.
// Must start with a letter or digit so "." and ".." can never reach an upstream path.
const IdParam = z.string().regex(/^[A-Za-z0-9][\w.:@+-]{0,199}$/, 'invalid id');
const ConversationParams = z.object({ source: SourceParam, id: IdParam });
const ApprovalParams = ConversationParams.extend({ approvalId: IdParam });
// A message needs text, attachments, or both.
const MessageBody = z
  .object({
    text: z.string().trim().max(100_000).default(''),
    attachments: z.array(AttachmentInput).max(4).optional(),
  })
  .strict()
  .refine((b) => b.text.length > 0 || (b.attachments?.length ?? 0) > 0, 'empty message');
// A permission answer picks one of the offered options; a question may take free text instead.
// A Hermes secret card's text (or login) is a password, code or sign-in: the
// adapter checks it and passes it to Hermes, and nothing else keeps it.
const ApprovalBody = z
  .object({
    optionId: z.string().min(1).max(200).optional(),
    optionIds: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
    text: z.string().max(20_000).optional(),
    login: z.object({ identifier: z.string().max(20_000), password: z.string().max(20_000) }).strict().optional(),
  })
  .strict()
  .refine(
    (b) => b.optionId !== undefined || b.optionIds !== undefined || b.text !== undefined || b.login !== undefined,
    'empty answer',
  );
const FolderQuery = z.object({ path: z.string().min(1).max(4096).startsWith('/') }).strict();
const FolderBody = FolderQuery;

const HermesCreateBody = z
  .object({
    text: z.string().trim().max(100_000).default(''),
    cwd: z.string().min(1).max(4096).startsWith('/').optional(),
    attachments: z.array(AttachmentInput).max(4).optional(),
    /** A model option id from GET /api/hermes/options, for this chat only. */
    model: z.string().min(1).max(500).optional(),
    confirmModel: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.text.length > 0 || (b.attachments?.length ?? 0) > 0, 'empty message');
const PaseoCreateBody = z
  .object({
    providerId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    cwd: z.string().min(1).max(4096).startsWith('/'),
    modeId: z.string().min(1).max(200).optional(),
    text: z.string().trim().max(100_000).default(''),
    acknowledgeAutoApprove: z.boolean().optional(),
    attachments: z.array(AttachmentInput).max(4).optional(),
  })
  .strict()
  .refine((b) => b.text.length > 0 || (b.attachments?.length ?? 0) > 0, 'empty message');
const MediaQuery = z.object({ p: z.string().min(1).max(6000), s: z.string().min(1).max(100) }).strict();
const ControlChangeBody = z
  .object({
    control: z.enum(['model', 'reasoning', 'mode']),
    value: z.string().min(1).max(500),
    acknowledgeAutoApprove: z.boolean().optional(),
    confirm: z.boolean().optional(),
  })
  .strict();
// Hermes runs "/" text itself; Paseo agents get it as an ordinary message.
const COMMAND_RUNNER: Record<Source, CommandCatalog['runner']> = { hermes: 'signalbox', paseo: 'agent' };
const HermesCredentialsBody = z
  .object({ username: z.string().trim().min(1).max(256), password: z.string().min(1).max(1024) })
  .strict();
const BridgeBody = z.object({ paused: z.boolean() }).strict();
const CloudAgentParams = z.object({ id: z.enum(CLOUD_AGENT_IDS) });
const CloudAgentBody = z.object({ enabled: z.boolean() }).strict();
const SafetyCommandsBody = z.object({ enabled: z.boolean() }).strict();
const WorkerUpdatesBody = z
  .object({
    enabled: z.boolean().optional(),
    defaultMinutes: z
      .number()
      .refine((n) => (WORKER_TIME_BOXES as readonly number[]).includes(n), 'not one of the offered time boxes')
      .optional(),
  })
  .strict();
const WhatsAppRoutingBody = z
  .object({
    replyRouting: z.boolean(),
    returnMinutes: z.number().refine((n) => (WHATSAPP_RETURN_MINUTES as readonly number[]).includes(n)),
    freshAfterHours: z.number().refine((n) => (WHATSAPP_FRESH_HOURS as readonly number[]).includes(n)),
  })
  .strict();
const ThreadRefBody = z.object({ source: SourceParam, id: IdParam }).strict();
const ThreadsBody = z.object({ threads: z.array(ThreadRefBody).min(1).max(500) }).strict();
const FolderPath = z.string().min(1).max(4096).startsWith('/');
// "Archive folder" names the folder too, so Signalbox can archive the chats there it hasn't listed.
const ArchiveBody = z
  .object({
    threads: z.array(ThreadRefBody).max(500),
    folder: z.object({ path: FolderPath, paseoRoots: z.array(FolderPath).max(500) }).strict().optional(),
  })
  .strict()
  .refine((b) => b.threads.length > 0 || b.folder !== undefined, 'nothing to archive');
const IdleDays = z.number().int().min(1).max(3650);
const CleanupQuery = z.object({ idleDays: z.coerce.number().pipe(IdleDays) }).strict();
const CleanupBody = z.object({ idleDays: IdleDays }).strict();
const ConnectorParams = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) });
const FlowParams = z.object({ flowId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/) });
const AccessBody = z.object({ access: z.enum(CONNECTOR_ACCESS) }).strict();
const GoogleFinishBody = z.object({ redirect: z.string().trim().min(1).max(4100) }).strict();
const OneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]*$/, 'one line');
const TriggerBody = z
  .object({
    name: OneLine(80),
    query: OneLine(500),
    action: z.string().trim().min(1).max(2000),
    every: z.union(TRIGGER_INTERVALS.map((n) => z.literal(n)) as [z.ZodLiteral<5>, z.ZodLiteral<15>, z.ZodLiteral<30>, z.ZodLiteral<60>]),
    deliver: z.string().min(1).max(200),
    tools: z.enum(SCHEDULE_TOOL_LEVELS).optional(),
  })
  .strict();
const TriggerParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });
const PausedBody = z.object({ paused: z.boolean() }).strict();
const CALLBACK_QUERY_MAX = 8192;
const ARCHIVED_LIMIT = 100;
const DAY_MS = 86_400_000;
const BACKEND_NAMES: Record<Source, string> = { hermes: 'Hermes', paseo: 'Paseo' };
const FeedParams = z.object({ id: z.string().regex(/^[a-f0-9]{16}$/) });
const FeedActionBody = z.object({ action: z.enum(FEED_ACTIONS) }).strict();
const FeedSettingsBody = z
  .object({
    level: z.enum(PROACTIVITY_LEVELS).optional(),
    quietHours: z.object({ start: HHMM, end: HHMM }).strict().nullable().optional(),
    push: z.object({ approvals: z.boolean().optional(), cards: z.boolean().optional() }).strict().optional(),
    removeLessLike: z.string().trim().min(1).max(40).optional(),
  })
  .strict();
const PushEndpointBody = z.object({ endpoint: z.string().min(1).max(2000) }).strict();
const VoiceRun = z.number().int().min(1).max(255);
const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('subscribe'), source: SourceParam, conversationId: IdParam }),
  z.object({ type: z.literal('unsubscribe'), source: SourceParam, conversationId: IdParam }),
  z.object({ type: z.literal('voice_start'), run: VoiceRun }),
  z.object({ type: z.literal('voice_cancel'), run: VoiceRun }),
]);
const AppVoiceBody = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('local') }).strict(),
  z.object({ provider: z.literal('elevenlabs'), voiceId: z.string().regex(CLOUD_ID), modelId: z.string().regex(CLOUD_ID) }).strict(),
]);
const VoiceBody = z.object({ voice: z.string().regex(VOICE_NAME).optional(), appReadAloud: AppVoiceBody.optional() }).strict()
  .refine(body => body.voice !== undefined || body.appReadAloud !== undefined);
const PairBody = z
  .object({ code: z.string().min(1).max(100), name: DeviceName, kind: z.enum(DEVICE_KINDS).optional() })
  .strict();
const PairOfferBody = z.object({ kind: z.enum(DEVICE_KINDS).default('phone') }).strict();
const DeviceParams = z.object({ id: DeviceIdParam });
const DeviceRenameBody = z.object({ name: DeviceName }).strict();
const PAIRING_REFUSED: Record<PairRefusal, [number, string]> = {
  invalid: [403, "That pairing code isn't valid any more. Ask for a new one."],
  'rate-limited': [429, 'Too many tries. Wait a minute, then try again.'],
  locked: [
    423,
    'Pairing is locked after too many wrong codes. Unlock it on a paired desktop (Settings → Devices), or run sudo wayroost pair on the PC.',
  ],
  full: [409, 'Too many paired devices. Revoke one you no longer use first.'],
};

const SpeakBody = z
  .object({
    text: z.string().trim().min(1).max(VOICE_SPEAK_MAX_CHARS),
    voice: z.string().regex(/^[a-z]{2}_[a-z]{2,20}$/).optional(),
    speed: z.number().min(0.5).max(2).optional(),
    stream: z.boolean().optional(),
  })
  .strict();
/** Replies read aloud at once, across every open page: enough to read ahead, not to flood the CPU. */
const MAX_SPEAKING = 4;

// Status & power: the verbs are the supervisor's fixed list, and the target is a
// registry id. `confirm` is the token a phone was handed for this exact request.
// Component and profile ids take the registry's own shape (lowercase letters,
// digits and hyphens, so "demo-helper" is one); whether the id is in the
// registry is the supervisor's call. The length cap is the one the client
// applies to ids the supervisor sends back.
const REGISTRY_ID = /^[a-z0-9-]{1,200}$/;
const PowerActionBody = z
  .object({
    verb: z.enum(SUPERVISOR_VERBS as unknown as [SupervisorVerb, ...SupervisorVerb[]]),
    target: z.string().regex(REGISTRY_ID, 'invalid component'),
    profile: z.string().regex(REGISTRY_ID, 'invalid profile').optional(),
    when: z.enum(['now', 'idle']).default('now'),
    confirm: z
      .string()
      .regex(/^[0-9a-f]{32}$/, 'invalid confirmation')
      .optional(),
  })
  .strict();
const PresenceBody = z.object({ state: z.enum(PRESENCE_STATES) }).strict();

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, verifier, hub, sources } = deps;
  if (config.access && !verifier) throw new Error('Cloudflare Access is configured but no token verifier was given');
  const devices = config.devices.enabled ? (deps.devices ?? new Devices(config.stateDir)) : undefined;
  deps.feed?.bindDevices(devices);
  const app = Fastify({
    ...(config.tls ? { https: listenerTls(config.tls, process.env, wayroostEnv('DEV_ALLOW_LOOPBACK') === '1') } : {}),
    logger: deps.logger ?? { level: 'info' },
    bodyLimit: 256 * 1024,
    trustProxy: false,
    // Default request logs include URLs and client details; we log denials ourselves.
    logController: new LogController({ disableRequestLogging: true }),
    return503OnClosing: true,
  });
  const stopPushRevokeWatch = devices?.onRevoke((id) => withDeviceSignal(undefined, () => deps.feed?.revokeDevice(id)));
  app.addHook('onClose', async () => stopPushRevokeWatch?.());
  const changes: string[] = [];
  CHANGE_ROUTES.set(app, changes);
  const checkLiveChange = (req: FastifyRequest): void => {
    if (!devices || !CHANGE_METHODS.has(req.method)) return;
    checkDeviceSignal(req.deviceSignal);
    if (LIVE_DEVICE_EXEMPT.includes(`${req.method} ${req.routeOptions.url}`)) return;
    requestDevice(req, devices);
  };
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) if (CHANGE_METHODS.has(method)) changes.push(`${method} ${route.url}`);
    // The upgrade handler sends the existing revocation close frame after accepting a socket.
    if (route.url === '/ws') return;
    // Hooks can await after the body check. Enter every mutating handler with a live device.
    const handler = route.handler;
    route.handler = function (req, reply) {
      checkLiveChange(req);
      return withDeviceSignal(req.deviceSignal, () => handler.call(this, req, reply));
    };
  });

  // Each origin gets its own CSP (its WebSocket address) and, on https, HSTS.
  const headerSets = new Map(
    [config.publicOrigin, ...config.origins.map((o) => o.origin)].map((origin) => [
      origin,
      securityHeaders(origin, { microphone: Boolean(deps.speech) }),
    ]),
  );
  const statuses = (): SourceStatus[] => [sources.hermes.status(), sources.paseo.status()];
  const media = new MediaLinks();
  hub.setTransform((event) => media.event(event));

  const deny = (req: FastifyRequest, reply: FastifyReply, status: number, reason: string, error?: string) => {
    req.log.warn({ reason, method: req.method, path: req.url.split('?')[0] }, 'request denied');
    error ??= status === 401 ? 'unauthorized' : status === 421 ? 'misdirected' : 'forbidden';
    return reply.code(status).header('cache-control', 'no-store').send({ error });
  };

  /** Secure cookies everywhere but a plain-http loopback origin (browsers drop them there). */
  const secureCookie = (req: FastifyRequest) => (siteFor(req.headers, config)?.origin ?? `http://${req.headers.host}`).startsWith('https://');

  /** Requests that need no paired device: the pairing call, and the app shell and its files. */
  const deviceOptional = (req: FastifyRequest): boolean => {
    const routeConfig = req.routeOptions.config as { deviceOptional?: boolean; file?: unknown } | undefined;
    if (routeConfig?.deviceOptional === true) return true;
    if (!SAFE_METHODS.has(req.method)) return false;
    if (typeof routeConfig?.file === 'string') return true; // a built web file (@fastify/static)
    if (req.routeOptions.url !== undefined) return false;
    // Nothing matched: the not-found handler only ever serves the shell or a 404.
    const path = req.url.split('?')[0]!;
    return !path.startsWith('/api/') && path !== '/ws';
  };

  await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 } });

  // Every request passes Host → Access identity (public origins) → device → CSRF
  // checks, in that order.
  app.addHook('onRequest', async (req, reply) => {
    const hostIssue = hostProblem(req.headers, config);
    const site = hostIssue ? undefined : siteFor(req.headers, config);
    for (const [name, value] of Object.entries(headerSets.get(site?.origin ?? config.publicOrigin)!)) reply.header(name, value);
    if (hostIssue) return deny(req, reply, 421, hostIssue);
    const tunnelIssue = tunnelProblem(req.headers, site);
    if (tunnelIssue) return deny(req, reply, 421, tunnelIssue);

    const path = req.url.split('?')[0]!;
    if (req.method === 'GET' && INSTALL_ASSETS.has(path)) return;

    // Cloudflare Access guards the public origins; local ones rely on the device alone.
    if (config.access && !site?.local) {
      try {
        req.identity = await verifier!(firstHeader(req.headers[ACCESS_JWT_HEADER]));
      } catch (err) {
        if (err instanceof AccessDenied) return deny(req, reply, err.status, err.reason);
        throw err;
      }
    }

    const route = req.routeOptions.url ?? '';
    if (devices) {
      // On a local origin only the desktop app signs in (see deviceSignInAllowed):
      // a browser's cookies there are ignored, and never cleared, since they
      // may belong to another port.
      const allowed = deviceSignInAllowed(req.headers, site);
      const presented = allowed ? readDeviceCookies(req.headers.cookie) : [];
      const signedIn = devices.authenticate(presented);
      if (signedIn) {
        req.device = signedIn.device;
        req.deviceSignal = devices.signal(signedIn.device.id);
        // Renewed on use (at most hourly), so a device in use never runs out.
        // Not on a WebSocket upgrade: it can't carry Set-Cookie, and touching
        // there would use up the hour's renewal before the next HTTP call.
        if (route !== '/ws' && devices.touch(signedIn.device.id)) {
          reply.header('set-cookie', deviceCookie(signedIn.cookie, secureCookie(req)));
        }
      } else {
        // Clear a cookie only when it's plainly ours and stale. Several, or a
        // malformed one, may have been set by another site on the same host
        // with a narrower Path, and a Path=/ clear would sign out the real one.
        if (presented.length === 1 && isDeviceCookieValue(presented[0]!) && route !== '/ws') {
          reply.header('set-cookie', clearedDeviceCookie(secureCookie(req)));
        }
        if (!deviceOptional(req)) return deny(req, reply, 401, 'no paired device', 'unpaired');
      }
    }

    // Classify by the route the router matched (it percent-decodes paths, so
    // "/%61pi/me" reaches "/api/me"), and hold every non-GET request to the
    // API rules whatever its path.
    const origin = expectedOrigin(site, config);
    if (route === '/ws') {
      const problem = websocketProblem(req.headers, origin);
      if (problem) return deny(req, reply, 403, problem);
    } else if (route.startsWith('/api/') || path.startsWith('/api/') || !SAFE_METHODS.has(req.method)) {
      const problem = apiRequestProblem(req.method, req.headers, origin);
      if (problem) return deny(req, reply, 403, problem);
      reply.header('cache-control', 'no-store');
    }
  });

  // Every change, after its body has arrived and right before its handler: the device that
  // signed the request in onRequest must still be in the live store. A revoke that landed
  // while the body was uploading wins. With device sign-in off there is no device to check;
  // Access alone signs requests in, as before.
  app.addHook('preHandler', async (req) => { checkLiveChange(req); });
  /** The live paired device at the action, including after any intervening await. */
  const changeDevice = (req: FastifyRequest): RequestDevice => requestDevice(req, devices);
  /** A change only a still-paired desktop may make. */
  const requireDesktopChange = (req: FastifyRequest): void => {
    if (changeDevice(req).kind !== 'desktop') throw new UserFacingError('Only a paired desktop can do that.', 403);
  };

  // Never echo or log a request body here: an approval answer can carry a
  // password (Hermes secret prompts). Validation errors name the fields only.
  app.setErrorHandler((err, req, reply) => {
    if (req.deviceSignal?.aborted) return reply.code(403).send({ error: 'Pair this device before controlling the PC.' });
    if (err instanceof UserFacingError) {
      // Cloudflare swaps an origin's 502 and 504 for its own error page, which
      // would hide the message; 424 ("a service we depend on failed") gets through.
      return reply.code(err.status === 502 || err.status === 504 ? 424 : err.status).send({ error: err.message });
    }
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: 'Invalid request', issues: err.issues.map((i) => i.path.join('.')) });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: status === 413 ? 'Request too large' : 'Bad request' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'Something went wrong' });
  });

  // ---- JSON API -----------------------------------------------------------

  app.get('/api/me', async (req): Promise<MeResponse> => ({
    ...(req.identity ? { email: req.identity.email } : {}),
    ...(req.device ? { device: req.device } : {}),
    statuses: statuses(),
  }));

  // ---- Devices and pairing ----------------------------------------------------
  // Logs name a device by id and kind only, never a code, secret or cookie.

  const pairing = () => {
    if (!devices) throw new UserFacingError('Device sign-in is turned off in the server config.', 404);
    return devices;
  };
  const requireDesktop = (req: FastifyRequest) => {
    if (!req.device || deviceKind(req) !== 'desktop') throw new UserFacingError('Only a paired desktop can do that.', 403);
  };
  /** A desktop manages every device; a phone only itself. */
  const requireSelfOrDesktop = (req: FastifyRequest, id: string) => {
    if (req.device?.id !== id) requireDesktop(req);
  };

  app.post('/api/pair', { config: { deviceOptional: true } }, async (req, reply): Promise<PairResult> => {
    const store = pairing();
    if (!deviceSignInAllowed(req.headers, siteFor(req.headers, config))) {
      req.log.warn({ reason: 'local-browser' }, 'pairing refused');
      throw new UserFacingError(
        "A browser can't sign in at this PC's own address. Pair the Wayroost desktop app here, or open Wayroost at its https:// address.",
        403,
      );
    }
    const { code, name, kind } = PairBody.parse(req.body);
    let paired;
    try {
      paired = store.pair(code, name, kind);
    } catch (err) {
      if (!(err instanceof PairingRefused)) throw err;
      req.log.warn({ reason: err.reason }, 'pairing refused');
      const [status, message] = PAIRING_REFUSED[err.reason];
      throw new UserFacingError(message, status);
    }
    reply.header('set-cookie', deviceCookie(paired.cookie, secureCookie(req)));
    req.log.info({ device: paired.device.id, kind: paired.device.kind }, 'device paired');
    return { device: paired.device };
  });

  app.post('/api/pair/offer', async (req): Promise<PairOffer> => {
    const store = pairing();
    requireDesktop(req);
    const { kind } = PairOfferBody.parse(req.body ?? {});
    const made = store.createCode(kind, { issuer: req.device!.id });
    req.log.info({ by: req.device!.id, kind }, 'pairing code offered');
    // The code rides in the fragment, which browsers never send to a server.
    return { ...made, url: `${config.publicOrigin}${PAIR_PATH}#${made.code}` };
  });

  app.delete('/api/pair/lock', async (req) => {
    const store = pairing();
    requireDesktop(req);
    store.unlockPairing();
    req.log.warn({ by: req.device!.id }, 'pairing unlocked');
    return { pairingLocked: false };
  });

  app.get('/api/devices', async (req): Promise<DeviceList> => {
    const store = pairing();
    return { devices: store.list(), currentId: req.device?.id ?? null, pairingLocked: store.pairingLocked() };
  });

  app.patch('/api/devices/:id', async (req): Promise<DeviceInfo> => {
    const store = pairing();
    const { id } = DeviceParams.parse(req.params);
    const { name } = DeviceRenameBody.parse(req.body);
    requireSelfOrDesktop(req, id);
    const device = store.rename(id, name);
    if (!device) throw new UserFacingError('That device is no longer paired.', 404);
    req.log.info({ device: id }, 'device renamed');
    return device;
  });

  app.delete('/api/devices/:id', async (req, reply) => {
    const store = pairing();
    const { id } = DeviceParams.parse(req.params);
    requireSelfOrDesktop(req, id);
    const release = await deps.workerApprovals?.cancelPending?.(store.signal(id));
    try {
      requireSelfOrDesktop(req, id);
      changeDevice(req);
      if (!store.revoke(id)) throw new UserFacingError('That device is no longer paired.', 404);
    } finally { release?.(); }
    if (req.device?.id === id) reply.header('set-cookie', clearedDeviceCookie(secureCookie(req)));
    req.log.warn({ device: id, by: req.device?.id }, 'device revoked');
    return { ok: true };
  });

  // ---- Voice mode -----------------------------------------------------------

  const voiceSetting = deps.speech ? new VoiceSetting(config.stateDir) : undefined;
  const sharedVoice = (voices: string[], fallback: string) => {
    const chosen = voiceSetting?.voice() ?? '';
    return chosen && voices.includes(chosen) ? chosen : fallback;
  };
  // Only explicit signed-in requests reach the cloud. No startup probes or timers.
  type CloudStatus = NonNullable<VoiceStatus['cloud']>;
  let catalogCache: { until: number; value: CloudStatus } | undefined;
  const emptyCatalog = (): CloudStatus => ({ available: false, voices: [], models: [] });
  const loadCatalog = (signal?: AbortSignal): Promise<CloudStatus> => {
    checkDeviceSignal(signal);
    if (catalogCache && catalogCache.until > Date.now()) return Promise.resolve(catalogCache.value);
    return (async () => {
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let value = emptyCatalog();
      try {
        if (deps.cloudSpeech) {
          const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new CloudSpeechError('timeout')); abort.abort(); }, 2_000); });
          value = { ...await Promise.race([deps.cloudSpeech.catalog(actionSignal(abort.signal, signal)), timeout]), available: true };
        }
      } catch (err) { checkDeviceSignal(signal); value.error = err instanceof CloudSpeechError ? err.code : 'failed'; }
      finally { clearTimeout(timer); abort.abort(); }
      checkDeviceSignal(signal);
      catalogCache = { until: Date.now() + (value.available ? 300_000 : 60_000), value };
      return value;
    })();
  };
  const voiceStatus = async (req: FastifyRequest): Promise<VoiceStatus> => {
    const appReadAloud = voiceSetting?.appReadAloud() ?? { provider: 'local' as const };
    const canChange = !!req.device && deviceKind(req) === 'desktop';
    // Status checks never probe the vendor, including when local speech is down.
    const cloud = catalogCache?.value ?? emptyCatalog();
    const base = { appReadAloud, canChange, cloud };
    if (!deps.speech) return { enabled: false, available: false, voices: [], defaultVoice: '', ...base };
    try {
      const health = await deps.speech.health();
      return { enabled: true, available: true, voices: health.voices, defaultVoice: sharedVoice(health.voices, health.defaultVoice), ...base };
    } catch { return { enabled: true, available: false, voices: [], defaultVoice: '', ...base }; }
  };
  app.get('/api/voice', voiceStatus);
  // A read, so the preHandler hook doesn't cover it: it checks the live device itself, before
  // and after the vendor call.
  app.get('/api/voice/catalog', async (req): Promise<CloudStatus> => {
    requireDesktop(req);
    if (requestDevice(req, devices).kind !== 'desktop') throw new UserFacingError('Only a paired desktop can do that.', 403);
    const catalog = await loadCatalog(req.deviceSignal);
    if (requestDevice(req, devices).kind !== 'desktop') throw new UserFacingError('Only a paired desktop can do that.', 403);
    return catalog;
  });

  app.put('/api/voice', async (req): Promise<VoiceSaveResult> => {
    requireDesktop(req);
    if (!deps.speech || !voiceSetting) throw new UserFacingError('Voice mode is off.', 404);
    const body = VoiceBody.parse(req.body);
    if (body.voice) {
      const health = await deps.speech.health();
      if (!health.voices.includes(body.voice)) throw new UserFacingError("That voice isn't available.", 400);
    }
    if (body.appReadAloud?.provider === 'elevenlabs') {
      const choice = body.appReadAloud;
      // A local health check may have awaited before this outward catalog request.
      requestDevice(req, devices);
      const catalog = await loadCatalog(req.deviceSignal);
      if (!catalog.available) throw new UserFacingError('ElevenLabs is unavailable. The local voice is still available.', 503);
      if (!catalog.voices.some(v => v.id === choice.voiceId) || !catalog.models.some(m => m.id === choice.modelId)) throw new UserFacingError("That ElevenLabs voice or model isn't available.", 400);
    }
    // The preHandler hook checked the device before the handler; the vendor catalog and the
    // speech service are awaited since, so check it again right before saving.
    if (requestDevice(req, devices).kind !== 'desktop') throw new UserFacingError('Only a paired desktop can do that.', 403);
    if (body.voice) voiceSetting.setVoice(body.voice);
    if (body.appReadAloud) voiceSetting.setAppReadAloud(body.appReadAloud);
    let calls: VoiceSaveResult['calls'] = 'off';
    let callsMessage: string | undefined;
    if (body.voice && deps.phone) {
      try { await deps.phone.setPhoneVoice(body.voice); calls = 'updated'; }
      catch { calls = 'failed'; callsMessage = 'App voice saved. The phone and car lines could not be updated; try saving the voice again.'; }
    }
    return { ...await voiceStatus(req), calls, ...(callsMessage ? { callsMessage } : {}) };
  });

  let speaking = 0;
  app.post('/api/voice/speak', async (req, reply) => {
    const speech = deps.speech;
    if (!speech) throw new UserFacingError('Voice mode is off.', 404);
    const body = SpeakBody.parse(req.body);
    if (speaking >= MAX_SPEAKING) throw new UserFacingError('Already reading several replies aloud; try again in a moment.', 429);
    const health = await speech.health();
    // Health can wait while pairing is revoked. Check again before text leaves the server.
    checkDeviceSignal(req.deviceSignal);
    const voice = body.voice && health.voices.includes(body.voice) ? body.voice : sharedVoice(health.voices, health.defaultVoice);
    const choice = body.voice ? { provider: 'local' as const } : voiceSetting!.appReadAloud();
    if (reply.raw.destroyed || req.raw.aborted) return reply;
    if (speaking >= MAX_SPEAKING) throw new UserFacingError('Already reading several replies aloud; try again in a moment.', 429);
    speaking += 1;
    let released = false;
    const abort = new AbortController();
    let stream: Readable | undefined;
    const closed = () => { abort.abort(); stream?.destroy(); if (!reply.raw.destroyed) reply.raw.destroy(); };
    const signal = actionSignal(abort.signal, req.deviceSignal)!;
    req.deviceSignal?.addEventListener('abort', closed, { once: true });
    const release = () => {
      if (!released) { released = true; speaking -= 1; reply.raw.off('close', closed); req.deviceSignal?.removeEventListener('abort', closed); }
    };
    reply.raw.once('close', closed);
    if (body.stream) {
      let started = false;
      const frames = async function* () {
        started = true;
        try {
          if (reply.raw.destroyed || abort.signal.aborted) return;
          if (devices) requestDevice(req, devices);
          for await (const frame of readAloud(speech, deps.cloudSpeech, choice, body.text, voice, body.speed ?? 1, signal)) yield `${JSON.stringify(frame)}\n`;
        } catch { if (!abort.signal.aborted) yield `${JSON.stringify({ type: 'error', message: "Couldn't read that aloud." })}\n`; }
        finally { release(); }
      };
      stream = Readable.from(frames());
      // An unstarted generator never runs its finally; active work keeps its permit.
      stream.once('close', () => { if (!started) release(); });
      try { return reply.type('application/x-ndjson').send(stream); }
      catch (err) { stream.destroy(); if (!started) release(); throw err; }
    }
    try {
      let start: Extract<SpeechFrame, { type: 'start' | 'reset' }> | undefined;
      const audio: Buffer[] = [];
      for await (const frame of readAloud(speech, deps.cloudSpeech, choice, body.text, voice, body.speed ?? 1, signal)) {
        if (frame.type === 'start' || frame.type === 'reset') { start = frame; audio.length = 0; }
        if (frame.type === 'audio') audio.push(Buffer.from(frame.data, 'base64'));
      }
      if (abort.signal.aborted) return reply;
      const data = Buffer.concat(audio);
      return reply.header('x-wayroost-voice-provider', start!.provider).header('x-wayroost-voice', start!.voice)
        .header('x-wayroost-voice-fallback', start!.reason ?? '').type('audio/wav').send(start!.format === 'pcm_24000' ? pcmWav(data, body.speed ?? 1) : data);
    } finally { release(); }
  });

  app.get('/api/conversations', async (req): Promise<ListResponse> => {
    const results = await Promise.allSettled([
      sources.hermes.listConversations(),
      sources.paseo.listConversations(),
    ]);
    const conversations = results.flatMap((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      req.log.warn({ source: i === 0 ? 'hermes' : 'paseo', err: String(r.reason) }, 'list failed');
      return [];
    });
    conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      conversations,
      role: config.role,
      notifications: config.role === 'primary',
      approvals: [...sources.hermes.listApprovals(), ...sources.paseo.listApprovals()],
      statuses: statuses(),
    };
  });

  app.get('/api/conversations/:source/:id', async (req) => {
    const { source, id } = ConversationParams.parse(req.params);
    return media.detail(await sources[source].getConversation(id));
  });

  app.post('/api/conversations/:source/:id/open', async (req) => {
    if (!req.device) throw new UserFacingError('Only a paired device can open a live chat.', 403);
    const { source, id } = ConversationParams.parse(req.params);
    return media.detail(await sources[source].getConversation(id, true));
  });

  // An image an agent showed. Only links this server signed are served, the
  // backend reads the file, and the bytes must really be an image.
  app.get('/api/media/:source/:id', async (req, reply) => {
    const { source, id } = ConversationParams.parse(req.params);
    const { p, s } = MediaQuery.parse(req.query);
    const path = media.verify(source, id, p, s);
    if (!path) throw new UserFacingError('This image link has expired. Reopen the conversation.', 404);
    const problem = mediaPathProblem(path);
    if (problem) throw new UserFacingError(`Wayroost doesn't show files from there (${problem}).`, 403);
    const from = sources[source];
    if (!from.readImage) throw new UserFacingError("Images can't be shown from this agent yet.", 404);
    const { bytes } = await from.readImage(id, path);
    if (bytes.length > MAX_MEDIA_BYTES) throw new UserFacingError('That image is too large to show here.', 413);
    const type = sniffImage(bytes);
    if (!type) throw new UserFacingError("That file isn't an image Wayroost can show.", 415);
    return reply
      .header('content-type', type)
      .header('content-disposition', `inline; filename="${safeFileName(path).replace(/"/g, '')}"`)
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, max-age=600')
      .send(bytes);
  });

  app.post('/api/conversations/:source/:id/messages', { bodyLimit: ATTACHMENT_BODY_LIMIT }, async (req) => {
    const { source, id } = ConversationParams.parse(req.params);
    const { text, attachments } = MessageBody.parse(req.body);
    const command = await sources[source].sendMessage(id, text, decodeAttachments(attachments));
    const reply: SendResponse = { ok: true, ...(command ? { command } : {}) };
    return reply;
  });

  app.get('/api/conversations/:source/:id/controls', async (req): Promise<ConversationControls> => {
    const { source, id } = ConversationParams.parse(req.params);
    const from = sources[source];
    return from.getControls ? from.getControls(id) : { controls: [] };
  });

  app.post('/api/conversations/:source/:id/controls', async (req): Promise<ControlChangeResponse> => {
    const { source, id } = ConversationParams.parse(req.params);
    const change = ControlChangeBody.parse(req.body);
    const from = sources[source];
    if (!from.setControl) throw new UserFacingError("This agent's settings can't be changed from here.", 404);
    return from.setControl(id, change);
  });

  app.get('/api/conversations/:source/:id/commands', async (req): Promise<CommandCatalog> => {
    const { source, id } = ConversationParams.parse(req.params);
    return { commands: await sources[source].listCommands(id), runner: COMMAND_RUNNER[source] };
  });

  app.post('/api/conversations/:source/:id/interrupt', async (req) => {
    const { source, id } = ConversationParams.parse(req.params);
    await sources[source].interrupt(id);
    return { ok: true };
  });

  app.post('/api/conversations/:source/:id/approvals/:approvalId', async (req) => {
    const { source, id, approvalId } = ApprovalParams.parse(req.params);
    const answer = ApprovalBody.parse(req.body);
    // Only Hermes asks for a login; don't hand one to a backend that would ignore it.
    if (answer.login && source !== 'hermes') throw new UserFacingError("That answer doesn't fit this request.", 400);
    await sources[source].respondToApproval(id, approvalId, answer);
    return { ok: true };
  });

  app.post('/api/hermes/conversations', { bodyLimit: ATTACHMENT_BODY_LIMIT }, async (req): Promise<CreateResponse> => {
    const { text, cwd, attachments, model, confirmModel } = HermesCreateBody.parse(req.body);
    const { id, command, notice } = await sources.hermes.createConversation(text, cwd, decodeAttachments(attachments), {
      ...(model ? { model } : {}),
      ...(confirmModel ? { confirmModel } : {}),
    });
    return { source: 'hermes', id, ...(command ? { command } : {}), ...(notice ? { notice } : {}) };
  });

  // Folders for new chats: whether one exists, and making a new one (through Paseo, running as the owner).
  app.get('/api/folders', async (req): Promise<{ status: FolderStatus }> => {
    const { path } = FolderQuery.parse(req.query);
    return { status: await sources.paseo.folderStatus(path) };
  });

  app.post('/api/folders', async (req) => {
    const { path } = FolderBody.parse(req.body);
    return { path: await sources.paseo.createFolder(path) };
  });

  app.get('/api/hermes/options', async () => sources.hermes.newChatOptions());

  app.get('/api/hermes/commands', async (): Promise<CommandCatalog> => ({
    commands: await sources.hermes.listNewChatCommands(),
    runner: COMMAND_RUNNER.hermes,
  }));

  app.get('/api/paseo/options', async () => sources.paseo.options());

  app.post('/api/paseo/conversations', { bodyLimit: ATTACHMENT_BODY_LIMIT }, async (req) => {
    const { attachments, ...input } = PaseoCreateBody.parse(req.body);
    return {
      source: 'paseo',
      id: await sources.paseo.createConversation({ ...input, attachments: decodeAttachments(attachments) }),
    };
  });

  app.put('/api/settings/hermes', async (req) => {
    const { username, password } = HermesCredentialsBody.parse(req.body);
    return { status: await sources.hermes.setCredentials(username, password) };
  });

  app.delete('/api/settings/hermes', async () => ({ status: await sources.hermes.clearCredentials() }));

  // The project bridge's kill switch. The bridge itself listens on its own loopback port.
  app.get('/api/bridge', async (): Promise<BridgeStatus> =>
    deps.bridge?.status() ?? { enabled: false, paused: false, recent: { sent: 0, queued: 0, started: 0 } },
  );

  app.put('/api/bridge', async (req): Promise<BridgeStatus> => {
    const { paused } = BridgeBody.parse(req.body);
    if (!deps.bridge) throw new UserFacingError('The Wayroost bridge is turned off in the server config.', 409);
    requireDesktopChange(req);
    return deps.bridge.setPaused(paused);
  });

  // Worker updates: whether the task log tells a Hermes chat about the Paseo workers it started.
  const workerUpdates = () => {
    if (!deps.workerUpdates) throw new UserFacingError('Worker updates need the bridge, Hermes and Paseo.', 404);
    return deps.workerUpdates;
  };

  app.get('/api/worker-updates', async (): Promise<WorkerUpdatesStatus> => workerUpdates().status());

  app.get('/api/tasks', async (): Promise<TaskList> => {
    if (!deps.tasks) throw new UserFacingError('Tasks need the bridge, Hermes and Paseo.', 404);
    return deps.tasks.status();
  });

  app.get('/api/capabilities', async () => ({ tasks: !!deps.tasks }));

  app.put('/api/worker-updates', async (req): Promise<WorkerUpdatesStatus> => {
    const patch = WorkerUpdatesBody.parse(req.body);
    const setting = workerUpdates();
    requireDesktopChange(req);
    const result = setting.update({
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.defaultMinutes !== undefined ? { defaultMinutes: patch.defaultMinutes } : {}),
    });
    req.log.warn({ enabled: result.enabled, defaultMinutes: result.defaultMinutes }, 'worker updates changed');
    return result;
  });

  // Which agents on cloud models may be started at all. Paseo keeps the switch,
  // so it holds everywhere: Paseo's own app, Signalbox, agents starting agents.
  app.get('/api/cloud-agents', async (): Promise<CloudAgentsStatus> => {
    if (!sources.paseo.cloudAgents) throw new UserFacingError("Cloud agents can't be switched from here.", 404);
    return sources.paseo.cloudAgents();
  });

  app.put('/api/cloud-agents/:id', async (req): Promise<CloudAgentsStatus> => {
    const { id } = CloudAgentParams.parse(req.params);
    const { enabled } = CloudAgentBody.parse(req.body);
    if (!sources.paseo.setCloudAgentEnabled) {
      throw new UserFacingError("Cloud agents can't be switched from here.", 404);
    }
    requireDesktopChange(req);
    return sources.paseo.setCloudAgentEnabled(id, enabled);
  });

  // Whether /yolo, /approve, /debug and the other safeguard commands may run from here.
  const safetyCommands = () => {
    if (!deps.safetyCommands) throw new UserFacingError('Hermes safety commands need Hermes.', 404);
    return deps.safetyCommands;
  };
  const safetyStatus = (enabled: boolean): SafetyCommandsStatus => ({ enabled, commands: SAFETY_COMMANDS });

  app.get('/api/safety-commands', async (): Promise<SafetyCommandsStatus> => safetyStatus(safetyCommands().enabled()));

  app.get('/api/worker-approvals', async (): Promise<WorkerApprovalsStatus> =>
    deps.workerApprovals ? deps.workerApprovals.status() : pendingWorkerApprovals());

  app.put('/api/worker-approvals', async (req): Promise<WorkerApprovalsStatus> => {
    const { enabled } = WorkerApprovalsWrite.parse(req.body);
    if (!deps.workerApprovals) throw new UserFacingError('The Safety helper is not configured.', 424);
    requireDesktopChange(req);
    return deps.workerApprovals.setEnabled(enabled);
  });

  app.put('/api/safety-commands', async (req): Promise<SafetyCommandsStatus> => {
    const { enabled } = SafetyCommandsBody.parse(req.body);
    const setting = safetyCommands();
    requireDesktopChange(req);
    const result = safetyStatus(setting.setEnabled(enabled));
    req.log.warn({ enabled }, 'hermes safety commands switched');
    return result;
  });

  // ---- WhatsApp routing --------------------------------------------------------
  // The whatsapp-routing Hermes plugin reads its settings file on every message,
  // so a change here applies at once; the helper writes it as the Hermes user.

  const whatsappRouting = () => {
    if (!deps.whatsappRouting) throw new UserFacingError('WhatsApp settings need Hermes and the Wayroost helper.', 404);
    return deps.whatsappRouting;
  };

  app.get('/api/whatsapp-routing', async (): Promise<WhatsAppRouting> => whatsappRouting().whatsappRouting());

  app.put('/api/whatsapp-routing', async (req): Promise<WhatsAppRouting> => {
    const settings = WhatsAppRoutingBody.parse(req.body);
    const result = await whatsappRouting().setWhatsappRouting(settings);
    req.log.info(settings, 'whatsapp routing settings changed');
    return result;
  });

  // ---- Scheduled jobs (Hermes cron) ---------------------------------------------
  // Hermes keeps and runs the jobs; these routes go through its dashboard. Logs never carry
  // a job's prompt.

  const schedules = () => {
    if (!deps.schedules) throw new UserFacingError('Scheduled jobs need Hermes, which is turned off here.', 404);
    return deps.schedules;
  };
  // Hermes job ids are hex; Paseo schedule ids are opaque but plain.
  const ScheduleParams = z
    .object({ source: z.enum(SCHEDULE_SOURCES as unknown as ['hermes', 'paseo']), id: z.string() })
    .refine((p) => (p.source === 'hermes' ? /^[a-f0-9]{6,32}$/ : /^[A-Za-z0-9_-]{4,64}$/).test(p.id), { message: 'bad id' });
  const PausedBody = z.object({ paused: z.boolean() }).strict();
  const RunsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

  app.get('/api/schedules', async (): Promise<ScheduleList> => schedules().list());

  // The home page's Scheduled block: running, failed, next up, recent results.
  app.get('/api/schedules/overview', async (): Promise<ScheduleOverview> => schedules().overview());

  // The AI job builder: a draft for the person to review (nothing is created here).
  app.post('/api/schedules/draft', async (req): Promise<ScheduleDraft> => {
    const draft = await schedules().draft(DraftInput.parse(req.body).goal);
    req.log.info({ skills: draft.skills.length }, 'schedule drafted');
    return draft;
  });

  app.get('/api/schedules/:source/:id/runs', async (req): Promise<{ runs: ScheduleRun[] }> => {
    const { source, id } = ScheduleParams.parse(req.params);
    return { runs: await schedules().runs(source, id, RunsQuery.parse(req.query).limit) };
  });

  // New jobs are Hermes jobs (a Paseo schedule needs an agent, provider and folder: set up in Paseo).
  app.post('/api/schedules', async (req, reply) => {
    await schedules().create(ScheduleInput.parse(req.body));
    reply.code(201);
    return schedules().list();
  });

  app.put('/api/schedules/:source/:id', async (req) => {
    const { source, id } = ScheduleParams.parse(req.params);
    const changes = ScheduleUpdate.parse(req.body);
    if (!Object.keys(changes).length) throw new UserFacingError('Nothing to change.', 400);
    await schedules().update(source, id, changes);
    return schedules().list();
  });

  app.put('/api/schedules/:source/:id/paused', async (req) => {
    const { source, id } = ScheduleParams.parse(req.params);
    await schedules().setPaused(source, id, PausedBody.parse(req.body).paused);
    return schedules().list();
  });

  app.post('/api/schedules/:source/:id/run', async (req, reply) => {
    const { source, id } = ScheduleParams.parse(req.params);
    await schedules().runNow(source, id);
    reply.code(202);
    return schedules().list();
  });

  app.delete('/api/schedules/:source/:id', async (req) => {
    const { source, id } = ScheduleParams.parse(req.params);
    await schedules().remove(source, id);
    return schedules().list();
  });

  // ---- For you ------------------------------------------------------------------
  // Cards from Hermes' pulse (posted on the bridge listener), what you do with them,
  // the proactivity level and quiet hours, and phone notifications (Web Push).

  const feed = () => {
    if (!deps.feed) throw new UserFacingError('For you is turned off here.', 404);
    return deps.feed;
  };

  app.get('/api/feed', async (): Promise<FeedList> => feed().list());

  app.post('/api/feed/seen', async () => {
    feed().markSeen();
    return { ok: true };
  });

  app.post('/api/feed/:id/action', async (req): Promise<FeedActionResult> => {
    const { id } = FeedParams.parse(req.params);
    return feed().act(id, FeedActionBody.parse(req.body).action);
  });

  app.put('/api/feed/settings', async (req): Promise<FeedSettings> =>
    feed().updateSettings(FeedSettingsBody.parse(req.body)),
  );

  app.get('/api/push/key', async () => ({ publicKey: feed().pushKey() }));

  app.post('/api/push/devices', async (req) => ({ devices: feed().addDevice(PushSubscriptionInput.parse(req.body), changeDevice(req).id) }));

  app.post('/api/push/devices/remove', async (req) => ({
    devices: feed().removeDevice(PushEndpointBody.parse(req.body).endpoint, changeDevice(req).id),
  }));

  app.post('/api/push/test', async () => feed().testPush());

  // ---- Skills -----------------------------------------------------------------
  // Every agent's skill folders through the helper (which keeps them the same as the
  // shared folder), and Hermes' skills hub as the marketplace. Logs name skills only.

  const skills = () => {
    if (!deps.skills) throw new UserFacingError('Skills need the Wayroost helper (deploy/setup-helper.sh).', 404);
    return deps.skills;
  };
  const SkillName = z.string().regex(SKILL_NAME, 'invalid skill name');
  const SkillPlace = z.string().regex(SKILL_PLACE, 'invalid folder');
  const SkillRef = z.object({ place: SkillPlace, name: SkillName }).strict();
  const SkillShareBody = SkillRef.extend({ confirmCaution: z.boolean().default(false) }).strict();
  const SkillExcludedBody = z.object({ name: SkillName, place: SkillPlace, excluded: z.boolean() }).strict();
  const HubIdentifier = z.string().regex(/^[\w.@:+-]+(\/[\w.@:+-]+){0,6}$/, 'invalid skill id').max(300);
  const HubQuery = z.object({ q: z.string().trim().min(1).max(100) });
  const HubIdQuery = z.object({ identifier: HubIdentifier });
  const HubInstallBody = z.object({ identifier: HubIdentifier, confirmCaution: z.boolean().default(false) }).strict();

  app.get('/api/skills', async (): Promise<SkillList> => skills().list());
  app.get('/api/skills/content', async (req) => {
    const { place, name } = SkillRef.parse(req.query);
    return skills().content(place, name);
  });
  app.post('/api/skills/refresh', async () => {
    await skills().refresh();
    return skills().list();
  });
  app.post('/api/skills/scan', async (req) => {
    const { place, name } = SkillRef.parse(req.body);
    return skills().scan(place, name);
  });
  app.post('/api/skills/share', async (req) => {
    const { place, name, confirmCaution } = SkillShareBody.parse(req.body);
    return skills().share(place, name, confirmCaution);
  });
  app.post('/api/skills/take-shared', async (req) => {
    const { place, name } = SkillRef.parse(req.body);
    await skills().takeShared(place, name);
    return skills().list();
  });
  app.put('/api/skills/excluded', async (req) => {
    const { name, place, excluded } = SkillExcludedBody.parse(req.body);
    await skills().setExcluded(name, place, excluded);
    return skills().list();
  });
  app.post('/api/skills/remove', async (req) => {
    const { name } = z.object({ name: SkillName }).strict().parse(req.body);
    await skills().remove(name);
    return skills().list();
  });
  app.get('/api/skills/market', async (req): Promise<MarketSearch> => skills().search(HubQuery.parse(req.query).q));
  app.get('/api/skills/market/preview', async (req): Promise<MarketPreview> =>
    skills().preview(HubIdQuery.parse(req.query).identifier),
  );
  app.post('/api/skills/market/scan', async (req) => skills().hubScan(HubIdQuery.parse(req.body).identifier));
  app.post('/api/skills/market/install', async (req) => {
    const { identifier, confirmCaution } = HubInstallBody.parse(req.body);
    return skills().install(identifier, confirmCaution);
  });

  // ---- Phone ------------------------------------------------------------------
  // Hermes Phone's line status and PIN. The PIN stays in the encrypted vault: the helper
  // asks the phone server for it. Logs never carry the digits.

  const phone = () => {
    if (!deps.phone) throw new UserFacingError('Phone settings need the Wayroost helper.', 404);
    return deps.phone;
  };
  const PhonePinBody = z.object({ pin: z.string().regex(/^\d{4,12}$/, 'The PIN must be 4 to 12 digits.') }).strict();

  app.get('/api/phone', async (): Promise<PhoneStatus> => phone().phone());

  app.get('/api/phone/pin', async (req, reply): Promise<{ pin: string | null }> => {
    reply.header('cache-control', 'no-store');
    const result = await phone().phonePin();
    req.log.info({}, 'phone pin revealed');
    return result;
  });

  app.put('/api/phone/pin', async (req): Promise<PhoneStatus> => {
    const { pin } = PhonePinBody.parse(req.body);
    const result = await phone().setPhonePin(pin);
    req.log.info({}, 'phone pin changed');
    return result;
  });

  // ---- Connectors and triggers ----------------------------------------------
  // Hermes keeps every token and setting; Signalbox drives its dashboard (and
  // the helper, for Google and trigger folders). Logs name the connector only.

  const connectors = () => {
    if (!deps.connectors) throw new UserFacingError('Connectors need Hermes, which is turned off here.', 404);
    return deps.connectors;
  };

  app.get('/api/connectors', async (): Promise<ConnectorList> => connectors().list());

  app.post('/api/connectors/google/start', async () => connectors().googleStart());

  app.post('/api/connectors/google/finish', async (req) => {
    const { redirect } = GoogleFinishBody.parse(req.body);
    return { state: await connectors().googleFinish(redirect) };
  });

  app.post('/api/connectors/google/disconnect', async () => {
    await connectors().googleDisconnect();
    return { ok: true };
  });

  app.get('/api/connectors/flows/:flowId', async (req): Promise<ConnectFlow> =>
    connectors().flow(FlowParams.parse(req.params).flowId),
  );

  app.delete('/api/connectors/flows/:flowId', async (req) => {
    await connectors().cancelFlow(FlowParams.parse(req.params).flowId);
    return { ok: true };
  });

  app.post('/api/connectors/:id/connect', async (req): Promise<ConnectStart> =>
    connectors().connect(ConnectorParams.parse(req.params).id),
  );

  app.put('/api/connectors/:id/access', async (req) => {
    const { id } = ConnectorParams.parse(req.params);
    await connectors().setAccess(id, AccessBody.parse(req.body).access);
    return { ok: true };
  });

  app.post('/api/connectors/:id/check', async (req) => {
    await connectors().check(ConnectorParams.parse(req.params).id);
    return { ok: true };
  });

  app.post('/api/connectors/:id/disconnect', async (req) => {
    await connectors().disconnect(ConnectorParams.parse(req.params).id);
    return { ok: true };
  });

  // Where a service sends the browser after you approve. It arrives from the
  // service's own site, and a SameSite=Strict device cookie doesn't come along
  // on that hop, so this page needs no device; without Access, anyone can call
  // it. Connectors forwards it to Hermes only while a sign-in a signed-in
  // device started for that connector is open (10 minutes, a few tries), and
  // Hermes then checks its OAuth state. Access, when configured, still guards
  // it on public origins.
  app.get(`${CALLBACK_PREFIX}:id`, { config: { deviceOptional: true } }, async (req, reply) => {
    const { id } = ConnectorParams.parse(req.params);
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
    const result =
      !query || query.length > CALLBACK_QUERY_MAX
        ? { ok: false, message: 'That sign-in link is incomplete. Go back to Wayroost and start again.' }
        : await connectors().callback(id, query);
    req.log.info({ connector: id, ok: result.ok }, 'connector callback');
    return reply
      .code(result.ok ? 200 : 400)
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(callbackPage(result.ok, result.message));
  });

  app.get('/api/triggers', async (): Promise<TriggerList> => connectors().triggers());

  app.post('/api/triggers', async (req) => {
    await connectors().createTrigger(TriggerBody.parse(req.body));
    return { ok: true };
  });

  app.put('/api/triggers/:id/paused', async (req) => {
    const { id } = TriggerParams.parse(req.params);
    await connectors().pauseTrigger(id, PausedBody.parse(req.body).paused);
    return { ok: true };
  });

  app.delete('/api/triggers/:id', async (req) => {
    await connectors().deleteTrigger(TriggerParams.parse(req.params).id);
    return { ok: true };
  });

  // ---- Tidying up: archive, restore and delete threads ---------------------
  // Each backend's own archive, so its app hides the threads too. Logs say how
  // many, never which or what they're called.

  type TidyAction = 'archive' | 'restore' | 'delete';
  const tidy = async (req: FastifyRequest, action: TidyAction, threads: readonly ThreadRef[], folder?: FolderScope) => {
    const result: ThreadActionResult = { done: 0, failed: [] };
    for (const source of SOURCES) {
      const ids = [...new Set(threads.filter((t) => t.source === source).map((t) => t.id))];
      // Only Hermes has more chats than the inbox lists, so only Hermes sweeps a folder.
      const sweep = action === 'archive' && source === 'hermes' ? folder : undefined;
      if (!ids.length && !sweep) continue;
      const from = sources[source];
      const signal = req.deviceSignal;
      const run =
        action === 'archive'
          ? from.archiveThreads && ((xs: string[]) => from.archiveThreads!(xs, sweep, signal))
          : action === 'restore'
            ? from.restoreThreads && ((xs: string[]) => from.restoreThreads!(xs, signal))
            : from.deleteThreads && ((xs: string[]) => from.deleteThreads!(xs, signal));
      if (!run) {
        for (const id of ids) result.failed.push({ source, id, error: `${BACKEND_NAMES[source]} can't do that from here.` });
        continue;
      }
      checkLiveChange(req);
      const done = await run(ids);
      result.done += done.done;
      result.failed.push(...done.failed);
    }
    app.log.info({ action, done: result.done, failed: result.failed.length }, 'threads tidied');
    return result;
  };

  app.post('/api/threads/archive', async (req): Promise<ThreadActionResult> => {
    const { threads, folder } = ArchiveBody.parse(req.body);
    return tidy(req, 'archive', threads, folder);
  });

  app.post('/api/threads/restore', async (req): Promise<ThreadActionResult> =>
    tidy(req, 'restore', ThreadsBody.parse(req.body).threads),
  );

  app.post('/api/threads/delete', async (req): Promise<ThreadActionResult> =>
    tidy(req, 'delete', ThreadsBody.parse(req.body).threads),
  );

  app.get('/api/threads/archived', async (req): Promise<ArchivedList> => {
    const results = await Promise.allSettled(SOURCES.map(async (source) => (await sources[source].listArchived?.(ARCHIVED_LIMIT)) ?? []));
    const threads = results.flatMap((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      req.log.warn({ source: SOURCES[i], err: String(r.reason) }, 'archived list failed');
      return [];
    });
    threads.sort((a, b) => b.updatedAt - a.updatedAt);
    return { threads };
  });

  /** Every thread idle for `idleDays`, from both backends; a backend that can't answer stops it. */
  const idleThreads = async (idleDays: number): Promise<ThreadRef[]> => {
    const before = Date.now() - idleDays * DAY_MS;
    const lists = await Promise.all(
      SOURCES.map(async (source) => {
        const from = sources[source];
        if (!from.idleThreads || from.status().state === 'disabled') return [];
        try {
          return (await from.idleThreads(before)).map((id) => ({ source, id }));
        } catch (err) {
          if (err instanceof UserFacingError) throw err;
          throw new UserFacingError(`Couldn't ask ${BACKEND_NAMES[source]} which threads are idle. Try again in a moment.`);
        }
      }),
    );
    return lists.flat();
  };

  app.get('/api/cleanup', async (req): Promise<CleanupPreview> => {
    const { idleDays } = CleanupQuery.parse(req.query);
    return { idleDays, count: (await idleThreads(idleDays)).length };
  });

  app.post('/api/cleanup', async (req): Promise<ThreadActionResult> => {
    const { idleDays } = CleanupBody.parse(req.body);
    const threads = await idleThreads(idleDays);
    checkLiveChange(req);
    return threads.length ? tidy(req, 'archive', threads) : { done: 0, failed: [] };
  });

  // ---- Status & power -------------------------------------------------------
  // The supervisor's view of the PC, cached from its event stream, and the one
  // place a phone may start something on it. Nothing here is stored on disk.

  // Who asks is the paired device itself (its id and kind), never an Access
  // sign-in alone. Reads and changes both check it against the live store at the action.
  const power = new Power(deps.supervisor, hub, app.log, deps.power ?? {});
  power.start();
  // A revoked device's confirm taps and presence go with it.
  const stopPowerRevokeWatch = devices?.onRevoke((id) => power.forget(id));
  app.addHook('onClose', async () => {
    stopPowerRevokeWatch?.();
    power.stop();
  });
  const deviceOf = (req: FastifyRequest) => requestDevice(req, devices);

  // The latest snapshot, so the status block and the Status & power page have
  // something to show, or one plain line when the supervisor isn't running.
  app.get('/api/power', async (req): Promise<PowerStatus> => {
    deviceOf(req);
    return power.view();
  });

  // One action with its progress lines: a page that opened halfway through a
  // model switch hasn't seen them on its socket yet.
  app.get('/api/power/actions/:id', async (req) => {
    deviceOf(req);
    const { id } = z.object({ id: IdParam }).parse(req.params);
    const detail = await power.action(id);
    if (!detail) throw new UserFacingError('That action is not here any more.', 404);
    return detail;
  });

  // A desktop's request is forwarded at once; a phone gets a confirm tap first.
  app.post('/api/power/actions', async (req, reply): Promise<PowerActionResponse> => {
    const { verb, target, profile, when, confirm } = PowerActionBody.parse(req.body);
    const request: ActionRequest = { verb, target, ...(profile ? { profile } : {}), when };
    const result = await power.act(changeDevice(req), request, confirm, req.deviceSignal);
    if ('busy' in result) return reply.code(409).send(result.busy);
    reply.code(202);
    return result;
  });

  // The desktop app's lock and idle events. M1 records them and shows them on
  // the power page; alerts get routed by presence with Notifications (M2).
  app.post('/api/presence', async (req): Promise<{ ok: true }> => {
    const { state } = PresenceBody.parse(req.body);
    power.setPresence(changeDevice(req), state);
    return { ok: true };
  });

  // ---- Live events --------------------------------------------------------

  // How to cut off each open socket, by device, so revoking a device ends them at once.
  const deviceSockets = new Map<string, Set<() => void>>();
  const stopRevokeWatch = devices?.onRevoke((id) => {
    for (const cut of deviceSockets.get(id) ?? []) cut();
    deviceSockets.delete(id);
  });
  app.addHook('onClose', async () => stopRevokeWatch?.());

  app.get('/ws', { websocket: true }, (socket, req) => {
    const identity = req.identity;
    const device = req.device;
    // The device was checked in onRequest, before the handshake: a revoke that
    // landed since found no socket to close. Check again here, in the same
    // synchronous step that registers the socket, so none slips through.
    if (device && !devices?.get(device.id)) {
      socket.close(WS_CLOSE_DEVICE_REVOKED, 'device revoked');
      return;
    }
    // Power snapshots, actions and lines belong to paired devices only, even
    // when Access alone signs this socket in. Recheck before every delivery.
    const client = hub.add(socket, identity?.email ?? '', (event) =>
      !event.type.startsWith('power_') || Boolean(device && devices?.get(device.id)),
    );

    // Sockets never outlive the Access token, and are recycled every 30 minutes
    // so a sign-out or revoked session takes effect: the browser must pass the
    // sign-in checks (Cloudflare Access, the device cookie) again to reconnect.
    const expiresIn = identity ? Math.max(0, identity.exp * 1000 - Date.now()) : Number.POSITIVE_INFINITY;
    const lifetime = deps.wsMaxLifetimeMs ?? WS_MAX_LIFETIME_MS;
    const expiry =
      expiresIn <= lifetime
        ? setTimeout(() => socket.close(WS_CLOSE_SESSION_EXPIRED, 'session expired'), Math.min(expiresIn, MAX_TIMER_MS))
        : setTimeout(() => socket.close(WS_CLOSE_REAUTH, 'reauthenticate'), Math.min(lifetime, MAX_TIMER_MS));

    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, HEARTBEAT_MS);
    socket.on('pong', () => {
      alive = true;
    });

    // Voice input: binary frames carry audio (see VoiceSession); text frames are JSON.
    const voice = deps.speech ? new VoiceSession(deps.speech, (event) => hub.sendTo(client, event), undefined, req.deviceSignal) : null;

    // Stops everything this socket does. A close is only a request: frames keep
    // arriving until the client answers it, and none of them may be acted on.
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      clearTimeout(expiry);
      clearInterval(heartbeat);
      voice?.close();
      hub.remove(client);
      if (device) deviceSockets.get(device.id)?.delete(cut);
    };
    const cut = () => {
      end();
      socket.close(WS_CLOSE_DEVICE_REVOKED, 'device revoked');
      // A client that doesn't answer the close is cut off.
      setTimeout(() => socket.terminate(), 1_000).unref();
    };
    if (device) {
      const open = deviceSockets.get(device.id) ?? new Set();
      open.add(cut);
      deviceSockets.set(device.id, open);
    }

    socket.on('message', (data, isBinary) => {
      // Closing, for whatever reason: nothing more is done for this client.
      if (ended || req.deviceSignal?.aborted || socket.readyState !== socket.OPEN) return;
      return withDeviceSignal(req.deviceSignal, () => {
        if (isBinary) {
          if (!voice) return;
          alive = true;
          voice.frame(Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));
          return;
        }
        let message: z.infer<typeof ClientMessage>;
        try {
          message = ClientMessage.parse(JSON.parse(data.toString()));
        } catch {
          return;
        }
        alive = true;
        if (message.type === 'ping') hub.sendTo(client, { type: 'pong' });
        else if (message.type === 'subscribe') hub.subscribe(client, message.source, message.conversationId);
        else if (message.type === 'unsubscribe') hub.unsubscribe(client, message.source, message.conversationId);
        else if (message.type === 'voice_start') voice?.start(message.run);
        else voice?.cancel(message.run);
      });
    });

    socket.on('close', end);

    hub.sendTo(client, {
      type: 'hello',
      ...(identity ? { email: identity.email } : {}),
      ...(device ? { device } : {}),
      statuses: statuses(),
    });
    // The status block is part of the shell, so it gets its first snapshot here
    // rather than waiting for the page to ask for it.
    hub.sendTo(client, { type: 'power_status', power: power.view() });
  });

  // ---- Web app ------------------------------------------------------------

  const staticDir = config.staticDir;
  if (staticDir && existsSync(join(staticDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: '/',
      wildcard: false, // only files present at startup are routable
      index: false,
      dotfiles: 'deny',
      cacheControl: false,
      setHeaders(reply, filePath) {
        // Hashed build assets never change; everything else must revalidate.
        reply.header(
          'cache-control',
          filePath.startsWith(join(staticDir, 'assets')) ? 'private, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });

    const sendIndex = (reply: FastifyReply) =>
      reply.header('cache-control', 'no-cache').type('text/html').sendFile('index.html');

    app.get('/', { config: { deviceOptional: true } }, async (_req, reply) => sendIndex(reply));

    // Client-side routes (e.g. /c/hermes/<id>) load the app shell.
    app.setNotFoundHandler(async (req, reply) => {
      const path = req.url.split('?')[0]!;
      const wantsHtml = (req.headers.accept ?? '').includes('text/html');
      if (req.method === 'GET' && wantsHtml && !path.startsWith('/api/') && path !== '/ws') {
        return sendIndex(reply);
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}

/** The page a service's sign-in lands on. Static text: nothing from the request is echoed. */
function callbackPage(ok: boolean, message: string): string {
  const title = ok ? 'Signed in' : 'Sign-in not finished';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Wayroost</title></head><body><h1>${title}</h1><p>${message}</p><p><a href="/">Back to Wayroost</a></p></body></html>`;
}
