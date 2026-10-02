import { z } from 'zod';
import {
  bridgeEnvelope,
  parseBridgeEnvelope,
  type BridgeStatus,
  type ConversationSummary,
  type PaseoProviderOption,
  type Source,
} from '../../../shared/protocol.js';
import type { Logger } from '../hermes/adapter.js';
import type { EventHub } from '../hub.js';
import { HERMES_PARENT_LABEL, PARENT_AGENT_LABEL, modeTier } from '../paseo/normalize.js';
import type { Lineage } from '../lineage.js';
import { UserFacingError, type Sources, type StartedBy } from '../sources.js';
import { defaultChatTitle } from './envelope.js';
import { chatEntry, chatKey, cut, transcript, type ChatStatus } from './format.js';
import { LOOP_NOTICE, SendLimits, SlidingWindow } from './limits.js';
import { NOT_A_PROJECT, ProjectIndex, canonicalFolder, isBareFolder, type ProjectRef } from './project.js';

// The project bridge: agents working in a project list, read, message and start
// the other chats in the same project (as the Projects view groups them),
// across Hermes and Paseo, and wait for each other's answers. Approvals,
// permissions, modes and models are never reachable from here: those stay with
// the user. Every agent runs as the same OS user, so this is a guard against
// accidents and loops, not a sandbox.

export const BRIDGE_TOOLS = ['list_chats', 'read_chat', 'send_message', 'start_chat', 'wait_for_reply'] as const;
export type BridgeTool = (typeof BRIDGE_TOOLS)[number];
export const isBridgeTool = (name: string): name is BridgeTool => (BRIDGE_TOOLS as readonly string[]).includes(name);
/** Launch reports from the Hermes plugin and the Claude Code hook: accepted on the same listener, never offered to agents. */
export const REPORT_TOOLS = ['note_launch', 'note_run'] as const;
export type ReportTool = (typeof REPORT_TOOLS)[number];
export const isReportTool = (name: string): name is ReportTool => (REPORT_TOOLS as readonly string[]).includes(name);

export const PAUSED_MESSAGE = 'The user paused the Signalbox bridge.';
export const SLASH_MESSAGE = "Slash commands can't be sent through the bridge.";
export const NOT_IN_PROJECT = "That chat isn't in this project.";
export const WAIT_NEEDS_IDENTITY = 'wait_for_reply needs a chat Signalbox can identify';

/** What the tools tell the calling agent to do next. */
export const NOTES = {
  sent: "Delivered. They'll see your reply address; use wait_for_reply to wait for their answer.",
  sentAnonymous: "Delivered. Signalbox couldn't identify your chat, so they can't reply to you through the bridge.",
  queued: (position: number) =>
    `They're busy, so your message waits (number ${position} in line) and goes out when they're idle. Use wait_for_reply to wait for their answer.`,
  queuedAnonymous: (position: number) =>
    `They're busy, so your message waits (number ${position} in line) and goes out when they're idle.`,
  handedOver: 'They were waiting for your reply and got it.',
  started: "Started. It sees your message and your reply address; use wait_for_reply to wait for its answer.",
  startedAnonymous: 'Started.',
  anonymous: "Signalbox couldn't identify your chat, so other chats can't reply to you and wait_for_reply won't work.",
  finished: 'They finished without replying through the bridge; this is their latest message.',
  finishedSilent: 'They finished without replying through the bridge, and wrote nothing new.',
  timedOut: (status: ChatStatus) =>
    status === 'needs_approval'
      ? "No reply yet: they're waiting for the user to approve something. Call wait_for_reply again to keep waiting."
      : status === 'working'
        ? "No reply yet; they're still working. Call wait_for_reply again to keep waiting."
        : 'No reply yet. Call wait_for_reply again to keep waiting.',
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_LISTED = 50;
const MAX_WAITING_PER_CHAT = 5;
const QUEUE_TTL_MS = HOUR;
const POLL_MS = 3_000;
/** After a delivery, a chat counts as done with it once seen busy, or after this long idle. */
const SETTLE_MS = 10_000;
const MAX_DELIVERY_ATTEMPTS = 3;
const MAX_STARTS_PER_HOUR = 3;
const MAX_STARTED_WORKING = 2;
/** A chat that was just started may not be listed yet; it counts as working meanwhile. */
const STARTING_GRACE_MS = 2 * MINUTE;
const STARTED_MEMORY_MS = 24 * HOUR;
const MAX_STARTED_REMEMBERED = 200;
const SLASH = /^\s*\//;

/** Who is calling, from the wrapper's headers. Each id is only a claim, checked against the chats Signalbox knows. */
export interface BridgeIdentity {
  /** X-Bridge-Paseo-Agent: the caller's Paseo agent id, when Paseo runs it. */
  paseoAgent?: string;
  /** X-Bridge-Hermes-Session: the caller's Hermes stored session id, from the Hermes plugin. */
  hermesSession?: string;
  /** X-Bridge-Cwd: the caller's working folder. */
  cwd?: string;
}

export interface CallOptions {
  /** Aborted when the caller hangs up (e.g. its tool call timed out); a pending wait is dropped then. */
  signal?: AbortSignal;
}

export interface BridgeOptions {
  sources: Sources;
  hub: EventHub;
  log: Logger;
  /** Loopback port the listener uses, reported in the status. */
  port?: number;
  now?: () => number;
  /** How often waiting messages and waits are checked; 0 turns the timer off (tests call tick). */
  pollMs?: number;
  /** Where launch reports from the Hermes plugin and the Claude Code hook are kept. */
  lineage?: Lineage;
}

interface Caller {
  /** Identity for rate limits: the chat key when identified, else derived from the folder. */
  key: string;
  /** What goes to the log: the chat key when identified, else "unverified". */
  logAs: string;
  /** How its messages are signed. */
  label: string;
  /** The caller's own chat; only set when identified. */
  chat?: StartedBy;
  /** Folder its project is resolved from. */
  start?: string;
}

interface Queued {
  target: { source: Source; id: string };
  envelope: string;
  /** Kept to hand it to a wait_for_reply instead, if the recipient starts waiting for it. */
  text: string;
  callerKey: string;
  callerLog: string;
  at: number;
  attempts: number;
}

interface StartedChat {
  project: string;
  at: number;
  /** Unset while it's being created. */
  chat?: { source: Source; id: string };
}

export type WaitResult =
  | { from: string; kind: 'reply'; text: string }
  | { from: string; kind: 'finished'; last_message: string; note: string }
  | { from: string; kind: 'timed_out'; status: ChatStatus; note: string };

interface Waiter {
  callerKey: string;
  target: { source: Source; id: string };
  targetKey: string;
  /** Work counts from here: the caller's last delivery to the target, else when the wait began. */
  since: number;
  /** `since` is a delivery: once it has settled, an idle chat is done with it. */
  afterDelivery: boolean;
  /** The target was seen working after `since`. */
  busySeen: boolean;
  /**
   * The target's own activity time when this period began. It moving on means
   * it did something; it's never compared with our clock, which may differ.
   */
  baseline?: number;
  finishing: boolean;
  done: boolean;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (result: WaitResult) => void;
  reject: (err: unknown) => void;
}

interface CallLog {
  tool: string;
  caller: string;
  target?: string;
  outcome?: string;
}

const ChatArg = z
  .string()
  .regex(/^(hermes|paseo):[A-Za-z0-9][\w.:@+-]{0,199}$/, 'must be a chat id from list_chats, like "paseo:<id>"');
const TextArg = z
  .string()
  .max(8000)
  .refine((t) => t.trim().length > 0, 'must not be empty');
const common = {
  project: z.string().max(4096).startsWith('/', 'must be an absolute folder path').optional(),
  backend_hint: z.string().max(40).optional(),
};
const ListArgs = z.object(common).strict();

// Launch reports: sent by the Hermes plugin and the Claude Code hook, never offered to agents as tools.
const HermesId = z.string().regex(/^\d{8}_\d{6}_[0-9A-Za-z]{1,64}$/);
const RunId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const LaunchCandidate = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hermes'), id: HermesId }).strict(),
  z.object({ kind: z.literal('paseo'), id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/) }).strict(),
  z.object({ kind: z.literal('claude'), id: RunId }).strict(),
]);
const Candidates = z.array(LaunchCandidate).min(1).max(6);
const EpochSeconds = z.number().finite().positive().max(4_102_444_800);
const NoteLaunchArgs = z.object({ child: HermesId, candidates: Candidates, started_at: EpochSeconds.optional() }).strict();
const NoteRunArgs = z
  .object({
    session: RunId,
    event: z.enum(['start', 'prompt', 'stop', 'end']),
    candidates: Candidates.optional(),
    cwd: z.string().max(4096).startsWith('/').optional(),
    entrypoint: z.string().max(40).optional(),
    task: z.string().max(4000).optional(),
    final: z.string().max(16000).optional(),
    error: z.boolean().optional(),
    started_at: EpochSeconds.optional(),
  })
  .strict();
/** Reports per minute, across all reporters: a runaway loop can't flood the store. */
const MAX_REPORTS_PER_MINUTE = 600;
const ReadArgs = z.object({ ...common, chat: ChatArg, limit: z.number().int().min(1).max(50).default(20) }).strict();
const SendArgs = z.object({ ...common, chat: ChatArg, text: TextArg }).strict();
const StartArgs = z
  .object({
    ...common,
    backend: z.enum(['hermes', 'paseo']),
    text: TextArg,
    agent: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, 'must be a Paseo agent id, like "claude"').optional(),
    mode: z.string().min(1).max(200).optional(),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
const WaitArgs = z
  .object({ ...common, chat: ChatArg, timeout_seconds: z.number().min(1).max(120).default(45) })
  .strict();

type CommonArgs = z.infer<typeof ListArgs>;

function parseArgs<T extends z.ZodType>(schema: T, args: unknown): z.infer<T> {
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((i) => `${i.path.length ? i.path.join('.') : 'arguments'}: ${i.message}`);
  throw new UserFacingError(`Invalid arguments. ${problems.join('; ')}`, 400);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const isIdle = (c: ConversationSummary) => (c.status === 'idle' || c.status === 'error') && c.pendingApprovals === 0;
const pairKey = (from: string, to: string) => `${from}>${to}`;

type ChatRef = { source: Source; id: string };
const sameChat = (a: ChatRef, b: ChatRef) => a.source === b.source && a.id === b.id;
/** How many sub-agents deep a caller is followed up to the chat that runs it. */
const MAX_SUBAGENT_DEPTH = 8;

/** The chat an id names: by its own id first, else by another id it's known by (e.g. a Hermes-in-Paseo agent's session). */
function findChat(conversations: readonly ConversationSummary[], ref: ChatRef): ConversationSummary | undefined {
  return conversations.find((c) => sameChat(c, ref)) ?? conversations.find((c) => c.aliases?.some((a) => sameChat(a, ref)));
}

/** Who a chat acts as: itself, or for a sub-agent the top-most chat above it that isn't one (if it's listed). */
function actingChat(conversations: readonly ConversationSummary[], chat: ConversationSummary): ConversationSummary | undefined {
  let current: ConversationSummary | undefined = chat;
  for (let depth = 0; current?.subagent; depth++) {
    if (!current.parent || depth >= MAX_SUBAGENT_DEPTH) return undefined;
    current = findChat(conversations, current.parent);
  }
  return current;
}

export class Bridge {
  private paused = false;
  private stopped = false;
  private readonly limits = new SendLimits();
  /** Chat key → messages waiting for it to become idle, oldest first. */
  private readonly queues = new Map<string, Queued[]>();
  /** Chat key → when the bridge last delivered to it, and whether it was seen busy since. */
  private readonly deliveries = new Map<string, { at: number; sawBusy: boolean }>();
  /** "caller>target" → when the caller's last message reached the target. */
  private readonly lastDelivered = new Map<string, number>();
  /** Waiting caller's chat key → its wait_for_reply (one each). */
  private readonly waiters = new Map<string, Waiter>();
  private readonly started: StartedChat[] = [];
  private readonly recent = {
    sent: new SlidingWindow(HOUR),
    queued: new SlidingWindow(HOUR),
    started: new SlidingWindow(HOUR),
  };
  private timer: ReturnType<typeof setInterval> | undefined;
  private delivering = false;
  private ticking = false;
  private readonly now: () => number;

  constructor(private readonly options: BridgeOptions) {
    this.now = options.now ?? Date.now;
  }

  // ---- the app's controls ---------------------------------------------------

  status(): BridgeStatus {
    const now = this.now();
    return {
      enabled: true,
      paused: this.paused,
      ...(this.options.port ? { port: this.options.port } : {}),
      recent: {
        sent: this.recent.sent.count('*', now),
        queued: this.recent.queued.count('*', now),
        started: this.recent.started.count('*', now),
      },
    };
  }

  /** Kill switch. Waits end at once; waiting messages stay (up to an hour) and go out once resumed. */
  setPaused(paused: boolean): BridgeStatus {
    if (paused !== this.paused) this.options.log.info({ paused }, paused ? 'bridge paused' : 'bridge resumed');
    this.paused = paused;
    if (paused) for (const waiter of [...this.waiters.values()]) this.settle(waiter, new UserFacingError(PAUSED_MESSAGE, 503));
    else this.ensurePolling();
    return this.status();
  }

  /** How many wait_for_reply calls are open right now. */
  get activeWaits(): number {
    return this.waiters.size;
  }

  stop(): void {
    this.stopped = true;
    this.stopPolling();
    for (const waiter of [...this.waiters.values()]) {
      this.settle(waiter, new UserFacingError('Signalbox is shutting down.', 503));
    }
  }

  // ---- tool calls -------------------------------------------------------------

  /** Refuse while paused; checked again right before anything is sent, started or waited on. */
  private stillOn(): void {
    if (this.paused) throw new UserFacingError(PAUSED_MESSAGE, 503);
  }

  /** Run one tool. Throws UserFacingError (with an HTTP status) when refused. */
  async call(tool: string, args: unknown, identity: BridgeIdentity = {}, options: CallOptions = {}): Promise<unknown> {
    if (isReportTool(tool)) return this.report(tool, args);
    const log: CallLog = { tool, caller: 'unknown' };
    try {
      this.stillOn();
      let result: unknown;
      switch (tool) {
        case 'list_chats':
          result = await this.listChats(parseArgs(ListArgs, args), identity, log);
          break;
        case 'read_chat':
          result = await this.readChat(parseArgs(ReadArgs, args), identity, log);
          break;
        case 'send_message':
          result = await this.sendMessage(parseArgs(SendArgs, args), identity, log);
          break;
        case 'start_chat':
          result = await this.startChat(parseArgs(StartArgs, args), identity, log);
          break;
        case 'wait_for_reply':
          result = await this.waitForReply(parseArgs(WaitArgs, args), identity, log, options.signal);
          break;
        default:
          throw new UserFacingError('Unknown tool.', 404);
      }
      log.outcome ??= 'ok';
      return result;
    } catch (err) {
      log.outcome = err instanceof UserFacingError ? `refused ${err.status}` : 'failed';
      throw err;
    } finally {
      // Never the message text, the title or the folder.
      this.options.log.info({ ...log }, 'bridge call');
    }
  }

  private reportTimes: number[] = [];

  /**
   * A launch report: which launchers a new Hermes chat's or Claude Code run's environment
   * named. Metadata only, so it works while the bridge is paused; it never carries
   * approvals or messages.
   */
  private report(tool: ReportTool, args: unknown): { ok: true } {
    const lineage = this.options.lineage;
    if (!lineage) throw new UserFacingError('Launch reports are off.', 404);
    const now = this.now();
    this.reportTimes = this.reportTimes.filter((t) => now - t < 60_000);
    if (this.reportTimes.length >= MAX_REPORTS_PER_MINUTE) throw new UserFacingError('Too many launch reports; slow down.', 429);
    this.reportTimes.push(now);
    let outcome = 'ok';
    try {
      if (tool === 'note_launch') {
        const a = parseArgs(NoteLaunchArgs, args);
        lineage.noteLaunch(a.child, a.candidates, a.started_at ? a.started_at * 1000 : now);
      } else {
        const a = parseArgs(NoteRunArgs, args);
        lineage.noteRun(a.session, a.event, {
          ...(a.candidates ? { candidates: a.candidates } : {}),
          ...(a.cwd ? { cwd: a.cwd } : {}),
          ...(a.entrypoint ? { entrypoint: a.entrypoint } : {}),
          ...(a.task ? { task: a.task } : {}),
          ...(a.final ? { final: a.final } : {}),
          ...(a.error ? { error: true } : {}),
          ...(a.started_at ? { startedAt: a.started_at * 1000 } : {}),
        });
      }
      return { ok: true };
    } catch (err) {
      outcome = err instanceof UserFacingError ? `refused ${err.status}` : 'failed';
      throw err;
    } finally {
      // Never the task, the answer or the folder.
      this.options.log.info({ tool, outcome }, 'bridge report');
    }
  }

  private async listChats(args: CommonArgs, identity: BridgeIdentity, log: CallLog) {
    const { caller, project, members } = await this.context(args, identity, log);
    const others = members
      .filter((c) => !caller.chat || chatKey(c) !== chatKey(caller.chat))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      project,
      ...(caller.chat ? { you: { chat: chatKey(caller.chat), title: caller.chat.title } } : {}),
      chats: others.slice(0, MAX_LISTED).map(chatEntry),
      ...(others.length > MAX_LISTED ? { more_not_listed: others.length - MAX_LISTED } : {}),
      ...(caller.chat ? {} : { note: NOTES.anonymous }),
    };
  }

  private async readChat(args: z.infer<typeof ReadArgs>, identity: BridgeIdentity, log: CallLog) {
    const { members } = await this.context(args, identity, log);
    log.target = args.chat;
    const target = this.member(members, args.chat);
    // Opening a chat may make its backend load (resume) it; that's fine for reading.
    const detail = await this.options.sources[target.source].getConversation(target.id);
    const entry = chatEntry(detail.conversation);
    const { items, omitted } = transcript(detail.items, args.limit);
    return {
      chat: args.chat,
      title: entry.title,
      agent: entry.agent,
      status: entry.status,
      items,
      ...(omitted ? { older_items_not_shown: omitted } : {}),
    };
  }

  private async sendMessage(args: z.infer<typeof SendArgs>, identity: BridgeIdentity, log: CallLog) {
    if (SLASH.test(args.text)) throw new UserFacingError(SLASH_MESSAGE, 400);
    const { caller, members } = await this.context(args, identity, log);
    log.target = args.chat;
    const target = this.member(members, args.chat);
    const key = chatKey(target);
    if (caller.chat && chatKey(caller.chat) === key) {
      throw new UserFacingError("That's your own chat. Message the other chats in the project.", 400);
    }

    // Look at the target again right before deciding: a busy chat is never interrupted or steered.
    const fresh = await this.freshSummary(target);
    this.stillOn();
    const now = this.now();
    this.tidy(now);
    const refusal = this.limits.check(caller.key, key, now);
    if (refusal) {
      if (refusal.tripped && caller.chat) this.breakLoop(caller.chat, target, now);
      throw new UserFacingError(refusal.message, 429);
    }

    // The chat is waiting for exactly this answer: hand it over, and don't also deliver it.
    const waiter = this.waiters.get(key);
    if (waiter && !waiter.done && waiter.targetKey === caller.key) {
      this.limits.record(caller.key, key, now);
      this.lastDelivered.set(pairKey(caller.key, key), now);
      this.recent.sent.add('*', now);
      this.settle(waiter, { from: caller.key, kind: 'reply', text: args.text });
      log.outcome = 'handed over';
      return { delivered: 'now' as const, note: NOTES.handedOver };
    }

    const envelope = bridgeEnvelope(caller.label, args.text, caller.chat ? chatKey(caller.chat) : undefined);
    const waiting = this.queues.get(key);
    if (!waiting?.length && fresh && this.ready(key, fresh, now)) {
      this.limits.record(caller.key, key, now);
      const previous = this.deliveries.get(key);
      this.deliveries.set(key, { at: now, sawBusy: false });
      try {
        await this.options.sources[target.source].sendMessage(target.id, envelope);
      } catch (err) {
        if (previous) this.deliveries.set(key, previous);
        else this.deliveries.delete(key);
        throw err;
      }
      this.delivered(caller.key, key, now);
      log.outcome = 'delivered';
      return { delivered: 'now' as const, note: caller.chat ? NOTES.sent : NOTES.sentAnonymous };
    }

    if ((waiting?.length ?? 0) >= MAX_WAITING_PER_CHAT) {
      throw new UserFacingError(
        `That chat already has ${MAX_WAITING_PER_CHAT} messages waiting for it to finish. Try again later.`,
        429,
      );
    }
    this.limits.record(caller.key, key, now);
    const queue = waiting ?? [];
    queue.push({
      target: { source: target.source, id: target.id },
      envelope,
      text: args.text,
      callerKey: caller.key,
      callerLog: caller.logAs,
      at: now,
      attempts: 0,
    });
    this.queues.set(key, queue);
    this.recent.queued.add('*', now);
    this.ensurePolling();
    log.outcome = 'queued';
    const position = queue.length;
    return { delivered: 'queued' as const, position, note: caller.chat ? NOTES.queued(position) : NOTES.queuedAnonymous(position) };
  }

  private async startChat(args: z.infer<typeof StartArgs>, identity: BridgeIdentity, log: CallLog) {
    if (SLASH.test(args.text)) throw new UserFacingError(SLASH_MESSAGE, 400);
    if (args.backend === 'hermes' && (args.agent !== undefined || args.mode !== undefined)) {
      throw new UserFacingError('"agent" and "mode" are only for Paseo chats.', 400);
    }
    const { caller, project, conversations } = await this.context(args, identity, log);
    const launch = args.backend === 'paseo' ? await this.paseoLaunch(args.agent, args.mode) : undefined;
    this.stillOn();

    // Check the caps and hold a place in one step, so parallel calls can't both get through.
    const now = this.now();
    this.forgetOldStarts(now);
    const here = this.started.filter((s) => s.project === project.path);
    if (here.filter((s) => now - s.at < HOUR).length >= MAX_STARTS_PER_HOUR) {
      throw new UserFacingError(
        `Agents have already started ${MAX_STARTS_PER_HOUR} chats in this project in the last hour. Ask the user, or try again later.`,
        429,
      );
    }
    if (here.filter((s) => this.stillWorking(s, conversations, now)).length >= MAX_STARTED_WORKING) {
      throw new UserFacingError(
        `${MAX_STARTED_WORKING} chats that agents started in this project are still working. Wait for one to finish.`,
        429,
      );
    }
    const place: StartedChat = { project: project.path, at: now };
    this.started.push(place);

    const startedBy = caller.chat;
    const envelope = bridgeEnvelope(caller.label, args.text, startedBy ? chatKey(startedBy) : undefined);
    const title = args.title ?? defaultChatTitle(args.text);
    let id: string;
    try {
      if (launch) {
        id = await this.options.sources.paseo.createConversation({
          providerId: launch.providerId,
          cwd: project.path,
          modeId: launch.modeId,
          text: envelope,
          title,
          // Nests the new agent under the chat that started it in the Projects view. Paseo's
          // own label makes it a delegated agent of its parent, so only a Paseo parent gets it.
          ...(startedBy
            ? { labels: { [startedBy.source === 'paseo' ? PARENT_AGENT_LABEL : HERMES_PARENT_LABEL]: startedBy.id } }
            : {}),
          ...(startedBy ? { startedBy } : {}),
        });
      } else {
        ({ id } = await this.options.sources.hermes.createConversation(envelope, project.path, [], {
          title,
          ...(startedBy ? { startedBy } : {}),
        }));
      }
    } catch (err) {
      const held = this.started.indexOf(place);
      if (held >= 0) this.started.splice(held, 1);
      throw err;
    }
    place.chat = { source: args.backend, id };
    this.recent.started.add('*', now);
    log.target = chatKey(place.chat);
    log.outcome = 'started';
    // Its first message came from the caller: waiting on it counts from now.
    if (startedBy) this.lastDelivered.set(pairKey(caller.key, log.target), now);
    return { chat: log.target, title, note: startedBy ? NOTES.started : NOTES.startedAnonymous };
  }

  /** A Paseo agent and a mode that asks before acting, or a refusal saying what can be started. */
  private async paseoLaunch(agent: string | undefined, mode: string | undefined) {
    const { providers } = await this.options.sources.paseo.options();
    const asking = (p: PaseoProviderOption) => p.modes.filter((m) => modeTier(p.id, m) === 'asks');
    const startable = providers.filter((p) => asking(p).length > 0).map((p) => p.id);
    const choices = startable.length
      ? `Agents that can be started: ${startable.join(', ')}.`
      : 'No Paseo agent that asks before acting is available right now.';
    if (!agent) throw new UserFacingError(`Say which Paseo agent to start with "agent". ${choices}`, 400);
    const provider = providers.find((p) => p.id === agent);
    if (!provider) throw new UserFacingError(`${agent} isn't available in Paseo right now. ${choices}`, 400);

    const modes = asking(provider);
    // No modes means it never asks (e.g. Pi): only the user may start those.
    if (provider.autoApproves || provider.modes.length === 0 || modes.length === 0) {
      throw new UserFacingError(`${provider.label} doesn't ask before acting, so agents can't start it; ask the user.`, 403);
    }
    const modeId = mode ?? provider.defaultModeId;
    const chosen = modes.find((m) => m.id === modeId);
    if (!chosen) {
      const list = `Modes that ask first: ${modes.map((m) => m.id).join(', ')}.`;
      throw new UserFacingError(
        mode
          ? `Agents can only start ${provider.label} in a mode that asks before acting. ${list}`
          : `${provider.label}'s default mode doesn't ask before acting; name one that does. ${list}`,
        403,
      );
    }
    return { providerId: provider.id, modeId: chosen.id };
  }

  // ---- waiting for an answer ----------------------------------------------------------

  /**
   * Resolves when the chat answers the caller through the bridge ("reply"), or
   * when it goes idle after working ("finished", with its latest message), or
   * at the timeout ("timed_out"). One wait per caller: a new one replaces it.
   */
  private async waitForReply(
    args: z.infer<typeof WaitArgs>,
    identity: BridgeIdentity,
    log: CallLog,
    signal: AbortSignal | undefined,
  ): Promise<WaitResult> {
    const { caller, members } = await this.context(args, identity, log);
    log.target = args.chat;
    if (!caller.chat) throw new UserFacingError(WAIT_NEEDS_IDENTITY, 400);
    const target = this.member(members, args.chat);
    const targetKey = chatKey(target);
    if (targetKey === caller.key) throw new UserFacingError("That's your own chat. Wait for one of the other chats.", 400);
    const summary = await this.freshSummary(target);
    this.stillOn();
    if (signal?.aborted) throw new UserFacingError('The wait was cancelled.', 499);

    const previous = this.waiters.get(caller.key);
    if (previous) this.settle(previous, new UserFacingError('A newer wait_for_reply replaced this one.', 409));
    const now = this.now();
    const delivered = this.lastDelivered.get(pairKey(caller.key, targetKey));
    const result = await new Promise<WaitResult>((resolve, reject) => {
      const waiter: Waiter = {
        callerKey: caller.key,
        target: { source: target.source, id: target.id },
        targetKey,
        since: delivered ?? now,
        afterDelivery: delivered !== undefined,
        busySeen: false,
        ...(summary ? { baseline: summary.updatedAt } : {}),
        finishing: false,
        done: false,
        resolve,
        reject,
      };
      this.waiters.set(caller.key, waiter);
      waiter.timer = setTimeout(() => void this.timeOut(waiter), args.timeout_seconds * 1000);
      waiter.timer.unref?.();
      signal?.addEventListener('abort', () => this.settle(waiter, new UserFacingError('The wait was cancelled.', 499)), {
        once: true,
      });
      // Their answer may already be waiting to reach the caller.
      if (this.takeQueuedReply(waiter)) return;
      this.observe(waiter, summary, now);
      this.ensurePolling();
    });
    log.outcome = result.kind;
    return result;
  }

  /** An answer from the target that was queued for the caller goes to the wait instead. */
  private takeQueuedReply(waiter: Waiter): boolean {
    const queue = this.queues.get(waiter.callerKey);
    const index = queue?.findIndex((m) => m.callerKey === waiter.targetKey) ?? -1;
    if (!queue || index < 0) return false;
    const [message] = queue.splice(index, 1);
    if (!queue.length) this.queues.delete(waiter.callerKey);
    this.recent.sent.add('*', this.now());
    this.settle(waiter, { from: waiter.targetKey, kind: 'reply', text: message!.text });
    return true;
  }

  /** Is the target done working (on the caller's message, if it sent one)? */
  private observe(waiter: Waiter, summary: ConversationSummary | undefined, now: number): void {
    if (waiter.done || waiter.finishing || !summary) return;
    // A turn too quick to see still moves the chat's own activity time.
    const moved = waiter.baseline !== undefined && summary.updatedAt > waiter.baseline;
    waiter.baseline ??= summary.updatedAt;
    if (!isIdle(summary)) {
      waiter.busySeen = true;
      return;
    }
    // The caller's own message hasn't reached them yet.
    if (this.queues.get(waiter.targetKey)?.some((m) => m.callerKey === waiter.callerKey)) return;
    const worked = waiter.busySeen || moved || (waiter.afterDelivery && now - waiter.since >= SETTLE_MS);
    if (worked) void this.finishWait(waiter);
  }

  private async finishWait(waiter: Waiter): Promise<void> {
    if (waiter.done || waiter.finishing) return;
    waiter.finishing = true;
    let lastMessage = '';
    try {
      const { items } = await this.options.sources[waiter.target.source].getConversation(waiter.target.id);
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]!;
        // Nothing written since the caller's own message: an older answer isn't one to it.
        if (item.kind === 'user' && parseBridgeEnvelope(item.text)?.replyTo === waiter.callerKey) break;
        if (item.kind === 'assistant' && item.text.trim()) {
          lastMessage = cut(item.text);
          break;
        }
      }
    } catch (err) {
      this.options.log.warn({ target: waiter.targetKey, err: errorText(err) }, "bridge couldn't read a finished chat");
    }
    this.settle(waiter, {
      from: waiter.targetKey,
      kind: 'finished',
      last_message: lastMessage,
      note: lastMessage ? NOTES.finished : NOTES.finishedSilent,
    });
  }

  private async timeOut(waiter: Waiter): Promise<void> {
    if (waiter.done) return;
    const summary = await this.freshSummary(waiter.target);
    const status = summary ? chatEntry(summary).status : 'idle';
    this.settle(waiter, { from: waiter.targetKey, kind: 'timed_out', status, note: NOTES.timedOut(status) });
  }

  private settle(waiter: Waiter, outcome: WaitResult | Error): void {
    if (waiter.done) return;
    waiter.done = true;
    clearTimeout(waiter.timer);
    if (this.waiters.get(waiter.callerKey) === waiter) this.waiters.delete(waiter.callerKey);
    if (outcome instanceof Error) waiter.reject(outcome);
    else waiter.resolve(outcome);
  }

  /** A message from `callerKey` reached `targetKey`: any wait for its answer counts from now. */
  private delivered(callerKey: string, targetKey: string, at: number): void {
    this.recent.sent.add('*', at);
    this.lastDelivered.set(pairKey(callerKey, targetKey), at);
    const waiter = this.waiters.get(callerKey);
    if (waiter && waiter.targetKey === targetKey) {
      waiter.since = at;
      waiter.afterDelivery = true;
      waiter.busySeen = false;
      delete waiter.baseline; // taken again at the next look
    }
  }

  // ---- who's calling, and their project ----------------------------------------

  private async context(args: CommonArgs, identity: BridgeIdentity, log: CallLog) {
    const conversations = await this.allConversations();
    const caller = this.identify(identity, args, conversations);
    log.caller = caller.logAs;
    // Sub-agents are never members (see ProjectIndex): they can't be listed, read, messaged or waited on.
    const index = new ProjectIndex(conversations);
    const project: ProjectRef | null = index.resolve(caller.start);
    if (!project) throw new UserFacingError(NOT_A_PROJECT, 400);
    return { caller, project, conversations, members: index.members(project.path) };
  }

  private identify(identity: BridgeIdentity, args: CommonArgs, conversations: ConversationSummary[]): Caller {
    const cwd = canonicalFolder(identity.cwd) ?? undefined;
    // A claimed id counts only if it's a chat Signalbox knows; the Paseo one is checked first.
    // A sub-agent (a Claude Code Task, a Hermes delegate_task run) acts as the chat that runs it.
    const claimed = (source: Source, id: string | undefined) => {
      const chat = id ? findChat(conversations, { source, id }) : undefined;
      return chat && actingChat(conversations, chat);
    };
    const own = claimed('paseo', identity.paseoAgent) ?? claimed('hermes', identity.hermesSession);
    if (own) {
      // Its own project wins over anything it names.
      const agent = own.source === 'hermes' ? 'Hermes' : own.agentLabel;
      return {
        key: chatKey(own),
        logAs: chatKey(own),
        label: agent ? `${own.title} (${agent})` : own.title,
        chat: { source: own.source, id: own.id, title: own.title },
        start: own.project?.path ?? args.project ?? cwd,
      };
    }
    // Anyone else is taken at their word for their folder only; chat ids in args are never trusted.
    const hermes = args.backend_hint === 'hermes';
    const folder = cwd && !isBareFolder(cwd) ? cwd.split('/').pop() : undefined;
    return {
      key: `${hermes ? 'hermes-chat' : 'agent'}@${cwd ?? '?'}`,
      logAs: hermes ? 'unverified hermes' : 'unverified',
      label: `${hermes ? 'A Hermes chat' : 'An agent'}${folder ? ` in ${folder}` : ''}`,
      start: args.project ?? cwd,
    };
  }

  private async allConversations(): Promise<ConversationSummary[]> {
    const { hermes, paseo } = this.options.sources;
    const results = await Promise.allSettled([hermes.listConversations(), paseo.listConversations()]);
    return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  }

  private member(members: ConversationSummary[], chat: string): ConversationSummary {
    const found = members.find((c) => chatKey(c) === chat);
    if (!found) throw new UserFacingError(NOT_IN_PROJECT, 403);
    return found;
  }

  private async freshSummary(target: { source: Source; id: string }): Promise<ConversationSummary | undefined> {
    const list = await this.options.sources[target.source].listConversations().catch(() => []);
    return list.find((c) => c.id === target.id);
  }

  /**
   * The chat can take a message now: idle (or stopped on an error), nothing
   * waiting on the user, and settled since the bridge's last delivery to it.
   */
  private ready(key: string, summary: ConversationSummary, now: number): boolean {
    const last = this.deliveries.get(key);
    if (!isIdle(summary)) {
      if (last) last.sawBusy = true;
      return false;
    }
    if (!last) return true;
    if (!last.sawBusy && now - last.at < SETTLE_MS) return false;
    this.deliveries.delete(key);
    return true;
  }

  // ---- loops -----------------------------------------------------------------------

  private breakLoop(a: { source: Source; id: string }, b: { source: Source; id: string }, now: number): void {
    const keys = new Set([chatKey(a), chatKey(b)]);
    // Messages already waiting between the two are dropped as well.
    let dropped = 0;
    for (const [key, queue] of [...this.queues]) {
      if (!keys.has(key)) continue;
      const keep = queue.filter((m) => !(keys.has(m.callerKey) && m.callerKey !== key));
      dropped += queue.length - keep.length;
      if (keep.length) queue.splice(0, queue.length, ...keep);
      else this.queues.delete(key);
    }
    for (const chat of [a, b]) {
      this.options.hub.publish({
        type: 'items_upsert',
        source: chat.source,
        conversationId: chat.id,
        items: [{ kind: 'notice', id: `bridge-loop-${now}`, level: 'info', text: LOOP_NOTICE }],
      });
    }
    this.options.log.warn({ chats: [...keys], dropped }, 'bridge paused a message loop');
  }

  // ---- starting chats ------------------------------------------------------------

  private stillWorking(s: StartedChat, conversations: readonly ConversationSummary[], now: number): boolean {
    if (!s.chat) return true; // being created right now
    const { source, id } = s.chat;
    const summary = conversations.find((c) => c.source === source && c.id === id);
    if (!summary) return now - s.at < STARTING_GRACE_MS;
    return summary.status === 'running' || summary.status === 'needs_approval';
  }

  private forgetOldStarts(now: number): void {
    const keep = this.started.filter((s) => !s.chat || now - s.at < STARTED_MEMORY_MS).slice(-MAX_STARTED_REMEMBERED);
    this.started.splice(0, this.started.length, ...keep);
  }

  // ---- the poll: waiting messages and waits ------------------------------------------

  /** One round: deliver what can go out, then check the waits. Runs every few seconds while needed. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.deliverQueued();
      await this.checkWaits();
    } finally {
      this.ticking = false;
      if (!this.queues.size && !this.waiters.size) this.stopPolling();
    }
  }

  /** Look at each waited-on chat once. */
  async checkWaits(): Promise<void> {
    for (const waiter of [...this.waiters.values()]) {
      if (waiter.done || waiter.finishing) continue;
      const summary = await this.freshSummary(waiter.target);
      this.observe(waiter, summary, this.now());
    }
  }

  /** Deliver waiting messages to chats that became idle: the oldest first, one per chat at a time. */
  async deliverQueued(): Promise<void> {
    if (this.delivering) return;
    this.delivering = true;
    try {
      this.expire(this.now());
      for (const [key, queue] of [...this.queues]) {
        if (this.paused) return;
        const head = queue[0];
        if (!head) continue;
        const summary = await this.freshSummary(head.target);
        const now = this.now();
        // The queue may have changed while we looked (the loop breaker, a wait, a pause).
        if (this.paused || this.queues.get(key) !== queue || queue[0] !== head) continue;
        if (!summary || !this.ready(key, summary, now)) continue;
        queue.shift();
        if (!queue.length) this.queues.delete(key);
        this.deliveries.set(key, { at: now, sawBusy: false });
        try {
          await this.options.sources[head.target.source].sendMessage(head.target.id, head.envelope);
          this.delivered(head.callerKey, key, now);
          this.options.log.info({ caller: head.callerLog, target: key, waitedMs: now - head.at }, 'bridge delivered a waiting message');
        } catch (err) {
          this.deliveries.delete(key);
          head.attempts += 1;
          const gone = err instanceof UserFacingError && err.status === 404;
          if (!gone && head.attempts < MAX_DELIVERY_ATTEMPTS) {
            const current = this.queues.get(key) ?? [];
            current.unshift(head);
            this.queues.set(key, current);
          } else {
            this.options.log.warn(
              { caller: head.callerLog, target: key, err: errorText(err) },
              'bridge dropped a message it could not deliver',
            );
          }
        }
      }
    } finally {
      this.delivering = false;
    }
  }

  private expire(now: number): void {
    for (const [key, queue] of [...this.queues]) {
      const keep = queue.filter((m) => now - m.at < QUEUE_TTL_MS);
      if (keep.length === queue.length) continue;
      this.options.log.info({ target: key, dropped: queue.length - keep.length }, 'bridge dropped messages that waited over an hour');
      if (keep.length) queue.splice(0, queue.length, ...keep);
      else this.queues.delete(key);
    }
    this.tidy(now);
  }

  /** Forget old bookkeeping, so memory stays bounded however long Signalbox runs. */
  private tidy(now: number): void {
    for (const [key, last] of [...this.deliveries]) if (now - last.at > HOUR) this.deliveries.delete(key);
    for (const [key, at] of [...this.lastDelivered]) if (now - at > HOUR) this.lastDelivered.delete(key);
    this.limits.sweep(now);
  }

  private ensurePolling(): void {
    const every = this.options.pollMs ?? POLL_MS;
    if (this.timer || this.stopped || every <= 0 || (!this.queues.size && !this.waiters.size)) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.options.log.error({ err: errorText(err) }, 'bridge poll failed'));
    }, every);
    this.timer.unref?.();
  }

  private stopPolling(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
