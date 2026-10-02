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
  WS_CLOSE_REAUTH,
  WS_CLOSE_SESSION_EXPIRED,
  type ArchivedList,
  type BridgeStatus,
  type CleanupPreview,
  type CloudAgentsStatus,
  type SafetyCommandsStatus,
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
import type { Bridge } from './bridge/service.js';
import type { AppConfig } from './config.js';
import type { HelperApi } from './connectors/helper.js';
import { DraftInput, ScheduleInput, ScheduleUpdate, type Schedules } from './schedules.js';
import type { Skills } from './skills.js';
import { SKILL_NAME, SKILL_PLACE, type MarketPreview, type MarketSearch, type SkillList } from '../../shared/skills.js';
import { CALLBACK_PREFIX, type Connectors } from './connectors/service.js';
import type { EventHub } from './hub.js';
import { ACCESS_JWT_HEADER, AccessDenied, type AccessIdentity, type AccessVerifier } from './security/access.js';
import { apiRequestProblem, hostProblem, websocketProblem } from './security/guards.js';
import { securityHeaders } from './security/headers.js';
import { ATTACHMENT_BODY_LIMIT, AttachmentInput, decodeAttachments, safeFileName, sniffImage } from './attachments.js';
import { MAX_MEDIA_BYTES, MediaLinks, mediaPathProblem } from './media.js';
import { VoiceSession, type SpeechService } from './speech.js';
import { VOICE_NAME, VoiceSetting } from './voice-setting.js';
import type { Feed } from './feed/service.js';
import { HHMM } from './feed/store.js';
import { PushSubscriptionInput } from './feed/push.js';
import { UserFacingError, type Sources } from './sources.js';

declare module 'fastify' {
  interface FastifyRequest {
    identity?: AccessIdentity;
  }
}

export interface AppDeps {
  config: AppConfig;
  verifier: AccessVerifier;
  hub: EventHub;
  sources: Sources;
  /** Fastify logger options; false in tests. */
  logger?: boolean | Record<string, unknown>;
  /** Longest a live socket may stay open before re-authenticating through Access. */
  wsMaxLifetimeMs?: number;
  /** The project bridge, when it's turned on and listening. */
  bridge?: Pick<Bridge, 'status' | 'setPaused'>;
  /** Settings → Connectors, when Hermes is on. */
  connectors?: Connectors;
  /** Voice mode, when it's turned on (deploy/setup-speech.sh). */
  speech?: SpeechService;
  /** For you (Hermes' pulse feed) and phone notifications, when turned on. */
  feed?: Feed;
  /** Settings → WhatsApp, through the helper, when Hermes is on and the helper is set up. */
  whatsappRouting?: Pick<HelperApi, 'whatsappRouting' | 'setWhatsappRouting'>;
  /** Settings → Scheduled jobs (Hermes cron), when Hermes is on. */
  schedules?: Schedules;
  /** Settings → Security → "Hermes safety commands", when Hermes is on. */
  safetyCommands?: SafetyCommandsSetting;
  /** Settings → Phone (Hermes Phone line status and PIN), through the helper. */
  phone?: Pick<HelperApi, 'phone' | 'phonePin' | 'setPhonePin' | 'setPhoneVoice'>;
  /** Settings → Skills, through the helper. */
  skills?: Skills;
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
const VoiceBody = z.object({ voice: z.string().regex(VOICE_NAME) }).strict();

const SpeakBody = z
  .object({
    text: z.string().trim().min(1).max(VOICE_SPEAK_MAX_CHARS),
    voice: z.string().regex(/^[a-z]{2}_[a-z]{2,20}$/).optional(),
    speed: z.number().min(0.5).max(2).optional(),
  })
  .strict();
/** Replies read aloud at once, across every open page: enough to read ahead, not to flood the CPU. */
const MAX_SPEAKING = 4;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, verifier, hub, sources } = deps;
  const app = Fastify({
    logger: deps.logger ?? { level: 'info' },
    bodyLimit: 256 * 1024,
    trustProxy: false,
    // Default request logs include URLs and client details; we log denials ourselves.
    logController: new LogController({ disableRequestLogging: true }),
    return503OnClosing: true,
  });

  const headers = securityHeaders(config.publicOrigin, { microphone: Boolean(deps.speech) });
  const statuses = (): SourceStatus[] => [sources.hermes.status(), sources.paseo.status()];
  const media = new MediaLinks();
  hub.setTransform((event) => media.event(event));

  const deny = (req: FastifyRequest, reply: FastifyReply, status: number, reason: string) => {
    req.log.warn({ reason, method: req.method, path: req.url.split('?')[0] }, 'request denied');
    const error = status === 401 ? 'unauthorized' : status === 421 ? 'misdirected' : 'forbidden';
    return reply.code(status).header('cache-control', 'no-store').send({ error });
  };

  await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 } });

  // Every request passes Host → Access identity → CSRF checks, in that order.
  app.addHook('onRequest', async (req, reply) => {
    for (const [name, value] of Object.entries(headers)) reply.header(name, value);

    const hostIssue = hostProblem(req.headers, config);
    if (hostIssue) return deny(req, reply, 421, hostIssue);

    const path = req.url.split('?')[0]!;
    if (req.method === 'GET' && INSTALL_ASSETS.has(path)) return;

    try {
      req.identity = await verifier(firstHeader(req.headers[ACCESS_JWT_HEADER]));
    } catch (err) {
      if (err instanceof AccessDenied) return deny(req, reply, err.status, err.reason);
      throw err;
    }

    // Classify by the route the router matched (it percent-decodes paths, so
    // "/%61pi/me" reaches "/api/me"), and hold every non-GET request to the
    // API rules whatever its path.
    const route = req.routeOptions.url ?? '';
    if (route === '/ws') {
      const problem = websocketProblem(req.headers, config);
      if (problem) return deny(req, reply, 403, problem);
    } else if (route.startsWith('/api/') || path.startsWith('/api/') || !SAFE_METHODS.has(req.method)) {
      const problem = apiRequestProblem(req.method, req.headers, config);
      if (problem) return deny(req, reply, 403, problem);
      reply.header('cache-control', 'no-store');
    }
  });

  // Never echo or log a request body here: an approval answer can carry a
  // password (Hermes secret prompts). Validation errors name the fields only.
  app.setErrorHandler((err, req, reply) => {
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
    email: req.identity!.email,
    statuses: statuses(),
  }));

  // ---- Voice mode -----------------------------------------------------------

  // One voice everywhere (Settings → Voice): every device reads replies in it, and
  // Hermes Phone speaks with it from its next call. A device can still preview
  // another voice by naming it in /api/voice/speak.
  const voiceSetting = deps.speech ? new VoiceSetting(config.stateDir) : undefined;
  const sharedVoice = (voices: string[], fallback: string) => {
    const chosen = voiceSetting?.voice() ?? '';
    return chosen && voices.includes(chosen) ? chosen : fallback;
  };

  app.get('/api/voice', async (): Promise<VoiceStatus> => {
    const speech = deps.speech;
    if (!speech) return { enabled: false, available: false, voices: [], defaultVoice: '' };
    try {
      const health = await speech.health();
      return { enabled: true, available: true, voices: health.voices, defaultVoice: sharedVoice(health.voices, health.defaultVoice) };
    } catch {
      return { enabled: true, available: false, voices: [], defaultVoice: '' };
    }
  });

  app.put('/api/voice', async (req): Promise<VoiceSaveResult> => {
    const speech = deps.speech;
    if (!speech || !voiceSetting) throw new UserFacingError('Voice mode is off.', 404);
    const { voice } = VoiceBody.parse(req.body);
    const health = await speech.health();
    if (!health.voices.includes(voice)) throw new UserFacingError("That voice isn't available.", 400);
    voiceSetting.setVoice(voice);
    let calls: VoiceSaveResult['calls'] = 'off';
    let callsMessage: string | undefined;
    if (deps.phone) {
      try {
        await deps.phone.setPhoneVoice(voice);
        calls = 'updated';
      } catch (err) {
        calls = 'failed';
        callsMessage = err instanceof UserFacingError ? err.message : "The phone line didn't take it.";
        req.log.warn({ err: String(err) }, 'phone voice not updated');
      }
    }
    req.log.info({ voice, calls }, 'voice set');
    return { enabled: true, available: true, voices: health.voices, defaultVoice: voice, calls, ...(callsMessage ? { callsMessage } : {}) };
  });

  let speaking = 0;
  app.post('/api/voice/speak', async (req, reply) => {
    const speech = deps.speech;
    if (!speech) throw new UserFacingError('Voice mode is off.', 404);
    const body = SpeakBody.parse(req.body);
    if (speaking >= MAX_SPEAKING) throw new UserFacingError('Already reading several replies aloud; try again in a moment.', 429);
    speaking += 1;
    try {
      const health = await speech.health();
      const voice = body.voice && health.voices.includes(body.voice) ? body.voice : sharedVoice(health.voices, health.defaultVoice);
      const wav = await speech.speak(body.text, voice, body.speed ?? 1);
      return reply.type('audio/wav').send(wav);
    } finally {
      speaking -= 1;
    }
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
      approvals: [...sources.hermes.listApprovals(), ...sources.paseo.listApprovals()],
      statuses: statuses(),
    };
  });

  app.get('/api/conversations/:source/:id', async (req) => {
    const { source, id } = ConversationParams.parse(req.params);
    return media.detail(await sources[source].getConversation(id));
  });

  // An image an agent showed. Only links this server signed are served, the
  // backend reads the file, and the bytes must really be an image.
  app.get('/api/media/:source/:id', async (req, reply) => {
    const { source, id } = ConversationParams.parse(req.params);
    const { p, s } = MediaQuery.parse(req.query);
    const path = media.verify(source, id, p, s);
    if (!path) throw new UserFacingError('This image link has expired. Reopen the conversation.', 404);
    const problem = mediaPathProblem(path);
    if (problem) throw new UserFacingError(`Signalbox doesn't show files from there (${problem}).`, 403);
    const from = sources[source];
    if (!from.readImage) throw new UserFacingError("Images can't be shown from this agent yet.", 404);
    const { bytes } = await from.readImage(id, path);
    if (bytes.length > MAX_MEDIA_BYTES) throw new UserFacingError('That image is too large to show here.', 413);
    const type = sniffImage(bytes);
    if (!type) throw new UserFacingError("That file isn't an image Signalbox can show.", 415);
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
    if (!deps.bridge) throw new UserFacingError('The Signalbox bridge is turned off in the server config.', 409);
    return deps.bridge.setPaused(paused);
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
    return sources.paseo.setCloudAgentEnabled(id, enabled);
  });

  // Whether /yolo, /approve, /debug and the other safeguard commands may run from here.
  const safetyCommands = () => {
    if (!deps.safetyCommands) throw new UserFacingError('Hermes safety commands need Hermes.', 404);
    return deps.safetyCommands;
  };
  const safetyStatus = (enabled: boolean): SafetyCommandsStatus => ({ enabled, commands: SAFETY_COMMANDS });

  app.get('/api/safety-commands', async (): Promise<SafetyCommandsStatus> => safetyStatus(safetyCommands().enabled()));

  app.put('/api/safety-commands', async (req): Promise<SafetyCommandsStatus> => {
    const { enabled } = SafetyCommandsBody.parse(req.body);
    const result = safetyStatus(safetyCommands().setEnabled(enabled));
    req.log.warn({ enabled }, 'hermes safety commands switched');
    return result;
  });

  // ---- WhatsApp routing --------------------------------------------------------
  // The whatsapp-routing Hermes plugin reads its settings file on every message,
  // so a change here applies at once; the helper writes it as the Hermes user.

  const whatsappRouting = () => {
    if (!deps.whatsappRouting) throw new UserFacingError('WhatsApp settings need Hermes and the Signalbox helper.', 404);
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

  app.post('/api/push/devices', async (req) => ({ devices: feed().addDevice(PushSubscriptionInput.parse(req.body)) }));

  app.post('/api/push/devices/remove', async (req) => ({
    devices: feed().removeDevice(PushEndpointBody.parse(req.body).endpoint),
  }));

  app.post('/api/push/test', async () => feed().testPush());

  // ---- Skills -----------------------------------------------------------------
  // Every agent's skill folders through the helper (which keeps them the same as the
  // shared folder), and Hermes' skills hub as the marketplace. Logs name skills only.

  const skills = () => {
    if (!deps.skills) throw new UserFacingError('Skills need the Signalbox helper (deploy/setup-helper.sh).', 404);
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
    if (!deps.phone) throw new UserFacingError('Phone settings need the Signalbox helper.', 404);
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

  // Where a service sends the browser after you approve. A plain page load
  // (so Cloudflare Access has already checked who you are); Hermes' own
  // callback checks the code belongs to the sign-in it started.
  app.get(`${CALLBACK_PREFIX}:id`, async (req, reply) => {
    const { id } = ConnectorParams.parse(req.params);
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
    const result =
      !query || query.length > CALLBACK_QUERY_MAX
        ? { ok: false, message: 'That sign-in link is incomplete. Go back to Signalbox and start again.' }
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
  const tidy = async (action: TidyAction, threads: readonly ThreadRef[], folder?: FolderScope) => {
    const result: ThreadActionResult = { done: 0, failed: [] };
    for (const source of SOURCES) {
      const ids = [...new Set(threads.filter((t) => t.source === source).map((t) => t.id))];
      // Only Hermes has more chats than the inbox lists, so only Hermes sweeps a folder.
      const sweep = action === 'archive' && source === 'hermes' ? folder : undefined;
      if (!ids.length && !sweep) continue;
      const from = sources[source];
      const run =
        action === 'archive'
          ? from.archiveThreads && ((xs: string[]) => from.archiveThreads!(xs, sweep))
          : action === 'restore'
            ? from.restoreThreads?.bind(from)
            : from.deleteThreads?.bind(from);
      if (!run) {
        for (const id of ids) result.failed.push({ source, id, error: `${BACKEND_NAMES[source]} can't do that from here.` });
        continue;
      }
      const done = await run(ids);
      result.done += done.done;
      result.failed.push(...done.failed);
    }
    app.log.info({ action, done: result.done, failed: result.failed.length }, 'threads tidied');
    return result;
  };

  app.post('/api/threads/archive', async (req): Promise<ThreadActionResult> => {
    const { threads, folder } = ArchiveBody.parse(req.body);
    return tidy('archive', threads, folder);
  });

  app.post('/api/threads/restore', async (req): Promise<ThreadActionResult> =>
    tidy('restore', ThreadsBody.parse(req.body).threads),
  );

  app.post('/api/threads/delete', async (req): Promise<ThreadActionResult> =>
    tidy('delete', ThreadsBody.parse(req.body).threads),
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
    return threads.length ? tidy('archive', threads) : { done: 0, failed: [] };
  });

  // ---- Live events --------------------------------------------------------

  app.get('/ws', { websocket: true }, (socket, req) => {
    const identity = req.identity!;
    const client = hub.add(socket, identity.email);

    // Sockets never outlive the Access token, and are recycled every 30 minutes
    // so a sign-out or revoked session takes effect: the browser must pass
    // through Cloudflare Access again to reconnect.
    const expiresIn = Math.max(0, identity.exp * 1000 - Date.now());
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
    const voice = deps.speech ? new VoiceSession(deps.speech, (event) => hub.sendTo(client, event)) : null;

    socket.on('message', (data, isBinary) => {
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

    socket.on('close', () => {
      clearTimeout(expiry);
      clearInterval(heartbeat);
      voice?.close();
      hub.remove(client);
    });

    hub.sendTo(client, { type: 'hello', email: identity.email, statuses: statuses() });
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

    app.get('/', async (_req, reply) => sendIndex(reply));

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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Signalbox</title></head><body><h1>${title}</h1><p>${message}</p><p><a href="/">Back to Signalbox</a></p></body></html>`;
}
