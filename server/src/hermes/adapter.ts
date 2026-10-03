import { checkDeviceSignal, deviceSignal, withDeviceSignal } from '../security/device-signal.js';
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import type {
  Approval,
  ApprovalAnswer,
  ArchivedThread,
  CommandResult,
  ControlChange,
  ControlChangeResponse,
  ControlOption,
  ConversationControl,
  ConversationControls,
  ConversationDetail,
  ConversationStatus,
  ConversationSummary,
  FolderScope,
  HermesOptions,
  SlashCommand,
  SourceState,
  SourceStatus,
  ThreadActionResult,
  TimelineItem,
} from '../../../shared/protocol.js';
import type { Attachment } from '../attachments.js';
import { canonicalFolder, isBareFolder, within } from '../bridge/project.js';
import type { EventHub } from '../hub.js';
import { MAX_MEDIA_BYTES, readCapped, type MediaFile } from '../media.js';
import type { SecretStore } from '../secrets.js';
import {
  UserFacingError,
  transientFailure,
  eachThread,
  type CreateResult,
  type HermesCreateOptions,
  type HermesSource,
  type StartedBy,
} from '../sources.js';
import { clip, homeRelative, oneLine, pretty, str, stripDataUrls, summarizeArgs } from '../text.js';
import { HermesAuth, HermesAuthError } from './auth.js';
import {
  blockedReason,
  canonicalName,
  catalogCommands,
  commandLabel,
  parseSlash,
  plainOutput,
  type DispatchResult,
  type HermesCatalog,
  type ParsedCommand,
} from './commands.js';
import { HermesGateway, RpcError, type GatewayEvent, type ServerRequest } from './gateway.js';
import {
  activeStatus,
  clarifyAnswer,
  clarifyQuestions,
  formatToolResult,
  messagesToItems,
  permissionApproval,
  questionApproval,
  secretAnswer,
  secretApproval,
  sessionSummary,
  shortModel,
  toolResultStatus,
  type ClarifyQuestion,
  type HermesMessageRow,
  type HermesSessionRow,
} from './normalize.js';
import { isDelegateRun, resolveSubagents, subagentSummary, type SubagentEntry } from './subagents.js';
import type { Lineage } from '../lineage.js';
import type { BackgroundGate } from '../background.js';
import { ChatIdentity } from './identity.js';

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

interface ResumeSnapshot {
  session_id: string;
  running?: boolean;
  status?: string;
  /** `display_kind: 'auto_continue'`: the turn running is Hermes re-running one it lost. */
  inflight?: { assistant?: string; streaming?: boolean; display_kind?: string } | null;
  open_requests?: Array<{ id: string; method: string; params?: Record<string, unknown> }> | null;
  /** Same shape as the `session.info` event. */
  info?: Record<string, unknown> | null;
  /** A cold resume after a crash: Hermes scheduled the lost turn to re-run (session_auto_continue.py). */
  auto_continue?: { attempt?: number; interrupted_at?: number } | null;
}

type AttachmentFrame = { event: GatewayEvent } | {
  request: Pick<ServerRequest, 'id' | 'method' | 'params'>;
  generation: number | null;
};

/** What `session.info` last said about a chat's model and context. */
interface SessionSettings {
  model?: string;
  provider?: string;
  reasoning?: string;
  contextUsed?: number;
  contextMax?: number;
}

/** `model.options` (tui_gateway/contracts/config_free_tier_control.py). */
interface ModelOptions {
  providers?: Array<{
    slug?: string;
    name?: string;
    models?: string[];
    authenticated?: boolean | null;
    unavailable_models?: string[] | null;
    capabilities?: Record<string, { reasoning?: boolean; can_disable_reasoning?: boolean | null }> | null;
    pricing?: Record<string, { input?: string; output?: string; free?: boolean }> | null;
  }>;
  model?: string;
  provider?: string;
}

interface ClarifyBatch {
  srq: string;
  answers: Record<string, string>;
  remaining: Set<string>;
}

interface PendingRequest {
  approval: Approval;
  srq: string;
  /**
   * How Hermes wants it answered: `approval`, `clarify`, or 'value' for a
   * password prompt (sudo, secret, vault unlock, 2FA code) answered `{ value }`.
   */
  method: 'approval' | 'clarify' | 'value';
  /** Connection it arrived on (null when replayed from a snapshot); frames only answer there. */
  generation: number | null;
  question?: ClarifyQuestion;
  batch?: ClarifyBatch;
}

interface LiveTurn {
  counter: number;
  segment: number;
  assistantId?: string;
  assistantText: string;
  reasoningId?: string;
  reasoningText: string;
  anyAssistant: boolean;
}

type CommandItem = Extract<TimelineItem, { kind: 'command' }>;

interface CommandOutcome {
  output?: string;
  error?: boolean;
  prefill?: string;
}

/** Files uploaded to a session ahead of the prompt that uses them. */
interface Staged {
  /** `@file:` references to put in the prompt. */
  refs: string[];
  /** Image paths queued on the session (consumed by the next prompt). */
  images: string[];
}

const LIST_TTL_MS = 3_000;
const ACTIVE_POLL_MS = 5_000;
/** After a turn ends or a session stops: long enough for Hermes to settle it. */
const ACTIVE_CHECK_DELAY_MS = 300;
const LIST_QUERY = '/api/sessions?limit=60&order=recent&archived=exclude&min_messages=1&exclude_sources=cron,acp';
/**
 * The same list with delegate_task runs in it: excluding `subagent` is how a list asks for them,
 * and Hermes adds them when `sessions.show_subagents` is on (hermes_cli/session_listing.py).
 */
const SUBAGENT_QUERY = '/api/sessions?limit=100&order=recent&archived=exclude&min_messages=1&exclude_sources=cron,acp,subagent';
/** Hermes-in-Paseo (ACP) sessions, for runs whose parent is one under a later id. */
const ACP_QUERY = '/api/sessions?source=acp&limit=100&order=recent&archived=include';
/** Tidying up pages through every top-level chat, this many at a time, up to TIDY_PAGES pages. */
const TIDY_PAGE = 100;
const TIDY_PAGES = 50;
const TIDY_QUERY = `/api/sessions?limit=${TIDY_PAGE}&order=recent&archived=exclude&min_messages=1&exclude_sources=cron,acp`;
const SUBAGENT_TTL_MS = 10_000;
const ACP_TTL_MS = 60_000;
/** Where Hermes runs a chat with no folder of its own (its dashboard's `default_cwd` for new chats). */
const DEFAULT_FOLDER_QUERY = '/api/chat/workspaces';
const DEFAULT_FOLDER_TTL_MS = 10 * 60_000;
const MAX_CREDENTIAL_ATTEMPTS_PER_MINUTE = 5;
const CATALOG_TTL_MS = 5 * 60_000;
/**
 * How long a request waits for a "/" command. Longer ones answer "running" and
 * deliver their output live, well before Cloudflare gives up on the request (100 s).
 */
const COMMAND_WAIT_MS = 15_000;
const MAX_COMMAND_ITEMS = 20;
const MAX_COMMAND_CONVERSATIONS = 100;
const LONG_COMMANDS = new Set(['compress', 'compact', 'update', 'learn', 'init', 'refine', 'review']);
/** Commands that rewrite the stored transcript; the open timeline is reloaded after them. */
const REWRITES_HISTORY = new Set(['undo', 'retry', 'compress', 'compact']);
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Hermes requests that ask for a password or secret. Without `secretPrompts`
 * they only get a notice; with it, they become secret cards.
 */
const PASSWORD_REQUESTS = new Set(['sudo', 'secret', 'vault.unlock_prompt', 'vault.save_login', 'vault.code']);
/** Chats the project bridge started, remembered (in memory) with who started them. */
const MAX_STARTED_BY = 500;
const MODEL_OPTIONS_TTL_MS = 60_000;
// hermes-agent apps/shared/src/reasoning-effort.ts
const REASONING_LEVELS: Array<[string, string]> = [
  ['none', 'Off'],
  ['minimal', 'Minimal'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra high'],
  ['max', 'Max'],
  ['ultra', 'Ultra'],
];

function priceLabel(price: { input?: string; output?: string; free?: boolean } | undefined): string | undefined {
  if (!price) return undefined;
  if (price.free) return 'Free';
  return price.input && price.output ? `${price.input} in · ${price.output} out per M tokens` : undefined;
}

/** "/home/me/app/" and "/home/me/./app" are the folder Hermes calls "/home/me/app". */
function sameFolder(a: string, b: string): boolean {
  const clean = (path: string) => posix.normalize(path).replace(/(.)\/+$/, '$1');
  return clean(a) === clean(b);
}

/** The model picker's options: each signed-in provider's usable models, id = [provider, model]. */
function modelChoices(options: ModelOptions): ControlOption[] {
  const models: ControlOption[] = [];
  for (const p of options.providers ?? []) {
    if (!p.slug || p.authenticated === false) continue;
    const unavailable = new Set(p.unavailable_models ?? []);
    for (const m of p.models ?? []) {
      if (typeof m !== 'string' || unavailable.has(m)) continue;
      const description = priceLabel(p.pricing?.[m]);
      models.push({
        id: JSON.stringify([p.slug, m]),
        label: shortModel(m) ?? m,
        group: p.name || p.slug,
        ...(description ? { description } : {}),
      });
    }
  }
  return models;
}

/** File references first, then the typed text, the way the Hermes desktop app sends them. */
function composePrompt(text: string, staged: Staged): string {
  const typed = text.trim() || (staged.images.length && !staged.refs.length ? 'What do you see in this image?' : '');
  return [staged.refs.join('\n'), typed].filter(Boolean).join('\n\n');
}

/** Hermes picks the image type from the file name's extension, so make it match the bytes. */
function imageFileName(file: Attachment): string {
  const stem = file.name.replace(/\.[^.]*$/, '') || 'image';
  return `${stem}.${IMAGE_EXTENSIONS[file.mimeType] ?? 'png'}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/** Put command output back among the stored messages, by time. */
function mergeByTime(items: TimelineItem[], extras: CommandItem[]): TimelineItem[] {
  if (!extras.length) return items;
  const out: TimelineItem[] = [];
  let next = 0;
  for (const item of items) {
    const at = (item as { at?: number }).at;
    if (at !== undefined) while (next < extras.length && (extras[next]!.at ?? 0) <= at) out.push(extras[next++]!);
    out.push(item);
  }
  return out.concat(extras.slice(next));
}

export class HermesAdapter implements HermesSource {
  private readonly auth: HermesAuth;
  private readonly gateway: HermesGateway;
  private readonly nonce = randomBytes(3).toString('hex');
  private statusValue: SourceStatus = { source: 'hermes', state: 'connecting' };
  private readonly rows = new Map<string, HermesSessionRow>();
  private readonly activeByStored = new Map<string, string>();
  private activityRevision = 0;
  private latestActivityPoll = 0;
  private activityPoll?: { revision: number; attachmentGeneration: number; result: Promise<Set<string> | undefined> };
  private readonly activityRevisions = new Map<string, number>();
  private readonly runtimeByStored = new Map<string, string>();
  private readonly storedByRuntime = new Map<string, string>();
  private readonly attaching = new Map<string, Promise<string>>();
  private readonly attachmentFrames = new Map<string, AttachmentFrame[]>();
  private attachmentGeneration = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly turns = new Map<string, LiveTurn>();
  private readonly watched = new Set<string>();
  private readonly lastPublished = new Map<string, string>();
  /** `commands.catalog` answers, by runtime session id ('' = no session). */
  private readonly catalogs = new Map<string, { at: number; catalog: HermesCatalog }>();
  /** Recent "/" command output per conversation; Hermes doesn't store it. */
  private readonly commandItems = new Map<string, CommandItem[]>();
  /** Old stored id → the id the chat continues under. */
  readonly chatIdentity: ChatIdentity;
  private readonly movedTo: Map<string, string>;
  /** Stored id → the chat that started it through the bridge. */
  private readonly startedBy = new Map<string, StartedBy>();
  private commandSeq = 0;
  private readonly settings = new Map<string, SessionSettings>();
  private readonly modelOptions = new Map<string, { at: number; options: ModelOptions }>();
  /** Cached session ids from the last list query; summaries are always built fresh. */
  /** Chats archived or deleted from Signalbox: not kept in the list just because we're attached. */
  private readonly tidied = new Set<string>();
  private listCache: { at: number; ids: string[] } | undefined;
  /** delegate_task runs from the last listing, by id, with the chat each nests under. */
  private subagents = new Map<string, SubagentEntry>();
  private subagentRows: { at: number; rows: HermesSessionRow[] } | undefined;
  /** The run list being fetched, shared by lists that overlap (the one after connecting, and yours). */
  private subagentFetch: Promise<HermesSessionRow[]> | undefined;
  private acpRows: { at: number; rows: HermesSessionRow[] } | undefined;
  /** The folder Hermes runs a chat with no folder of its own in (see refreshDefaultFolder). */
  private defaultFolder: string | undefined;
  private defaultFolderAt = 0;
  private defaultFolderLoading: Promise<void> | undefined;
  /** Whether this Hermes can list sub-agent runs; asked once per connection. */
  private subagentSupport: Promise<boolean> | undefined;
  /** Chats a detail row showed to be delegate_task runs (read-only here). */
  private readonly delegateRuns = new Set<string>();
  private listRefresh: ReturnType<typeof setTimeout> | undefined;
  private activeTimer: ReturnType<typeof setInterval> | undefined;
  private activeCheck: ReturnType<typeof setTimeout> | undefined;
  private credentialAttempts: number[] = [];

  constructor(
    private readonly baseUrl: string,
    private readonly hub: EventHub,
    private readonly secrets: SecretStore,
    private readonly log: Logger,
    private readonly options: {
      background: BackgroundGate;
      commandWaitMs?: number;
      /** Durable chat movement reports, also used by the task relay. A shadow keeps them in memory only. */
      stateDir?: string;
      /** How often to ask Hermes which chats are live while a browser is connected (tests). */
      activePollMs?: number;
      /** Turn Hermes' password prompts into cards the phone can answer (config `hermes.secretPrompts`). */
      secretPrompts?: boolean;
      /** Who started what, for chats agents start from a shell or through the bridge. */
      lineage?: Lineage;
      /** Settings → Security → "Hermes safety commands": let /yolo, /approve, /debug and the like through. */
      allowSafetyCommands?: () => boolean;
    },
  ) {
    // The file only matters to the completion relay, which runs only in primary: a shadow writes none.
    this.chatIdentity = new ChatIdentity(options.background.run(() => options.stateDir) ?? null);
    this.movedTo = this.chatIdentity.moves;
    this.auth = new HermesAuth(baseUrl, () => secrets.readHermes());
    options.lineage?.setStartLookup('hermes', (id) => {
      const started = this.rows.get(id)?.started_at;
      return typeof started === 'number' ? started * 1000 : undefined;
    });
    // A launch report can arrive before or after the chat is listed: show it either way.
    options.lineage?.onChange((change) => {
      if (change.kind !== 'launch') return;
      if (this.rows.has(change.hermesId)) this.publishSummary(change.hermesId);
      this.scheduleListRefresh();
    });
    this.gateway = new HermesGateway(baseUrl, this.auth, options.background);
    this.gateway.on('state', (state) => this.onGatewayState(state));
    this.gateway.on('ready', () => void this.onReady());
    this.gateway.on('event', (event) => this.onEvent(event));
    this.gateway.on('request', (request) => this.onRequest(request, request.generation));
    this.gateway.on('failure', (err) => this.onFailure(err));
  }

  // ---- Connectors -----------------------------------------------------------

  /** The signed-in dashboard client for Settings → Connectors, or undefined before sign-in. */
  dashboard(): HermesAuth | undefined {
    return this.auth.hasCredentials() ? this.auth : undefined;
  }

  /** Reload MCP tools in Hermes' chats after a connector changes (the same as /reload-mcp now). */
  async reloadTools(): Promise<void> {
    if (!this.auth.hasCredentials()) return;
    await this.call('reload.mcp', { confirm: true }, 60_000);
  }

  // ---- lifecycle ------------------------------------------------------------

  start(): void {
    if (!this.auth.hasCredentials()) {
      this.setStatus('needs_credentials', 'Sign in with your Hermes dashboard username and password.');
      return;
    }
    this.setStatus('connecting');
    this.gateway.start();
    this.activeTimer ??= setInterval(() => {
      if (this.gateway.state === 'ready' && this.hub.size > 0) void this.refreshActive();
    }, this.options.activePollMs ?? ACTIVE_POLL_MS);
  }

  stop(): void {
    clearInterval(this.activeTimer);
    this.activeTimer = undefined;
    clearTimeout(this.listRefresh);
    clearTimeout(this.activeCheck);
    this.activeCheck = undefined;
    this.gateway.stop();
  }

  status(): SourceStatus {
    return this.statusValue;
  }

  private setStatus(state: SourceState, message?: string): void {
    const next: SourceStatus = { source: 'hermes', state, ...(message ? { message } : {}) };
    if (next.state === this.statusValue.state && next.message === this.statusValue.message) return;
    this.statusValue = next;
    this.hub.publish({ type: 'source_status', status: next });
  }

  private onGatewayState(state: string): void {
    if (state !== 'ready') this.attachmentFrames.clear();
    if (this.statusValue.state === 'needs_credentials') return;
    if (state === 'connecting') this.setStatus('connecting');
    else if (state === 'closed') this.setStatus('disconnected', 'Reconnecting to Hermes…');
  }

  private onFailure(err: Error): void {
    if (err instanceof HermesAuthError) {
      if (err.kind === 'bad_credentials' || err.kind === 'no_credentials') {
        // Stop retrying: repeated bad logins would trip Hermes' rate limiter.
        this.gateway.stop();
        this.setStatus('needs_credentials', 'Hermes rejected the saved sign-in. Sign in again in Settings.');
        return;
      }
      this.setStatus('disconnected', err.message);
      return;
    }
    this.log.warn({ err: err.message }, 'hermes connection problem');
  }

  private async onReady(): Promise<void> {
    this.setStatus('connected');
    // Attachments belonged to the previous socket.
    this.attachmentGeneration++;
    this.runtimeByStored.clear();
    this.storedByRuntime.clear();
    this.catalogs.clear();
    this.modelOptions.clear();
    this.listCache = undefined;
    this.defaultFolderAt = 0;
    // Hermes may have been upgraded or reconfigured while we were away.
    this.subagentSupport = undefined;
    this.subagentRows = undefined;
    this.acpRows = undefined;
    // Attachments are rebuilt only for chats that are live in Hermes (refreshActive).
    await this.refreshActive();
    this.scheduleListRefresh(0);
  }

  // ---- inbox ----------------------------------------------------------------

  async listConversations(): Promise<ConversationSummary[]> {
    if (this.statusValue.state === 'needs_credentials') return [];
    if (!this.listCache || Date.now() - this.listCache.at >= LIST_TTL_MS) {
      let data: { sessions?: HermesSessionRow[] };
      try {
        data = await this.auth.json<{ sessions?: HermesSessionRow[] }>(LIST_QUERY);
      } catch (err) {
        if (err instanceof HermesAuthError && (err.status === undefined || err.status === 503)) this.onFailure(err);
        throw this.userError(err);
      }
      for (const row of data.sessions ?? []) {
        this.rows.set(row.id, row);
        // Listed again (say, Hermes un-archived it on new activity): it shows as usual.
        this.tidied.delete(row.id);
      }
      const ids = new Set((data.sessions ?? []).map((r) => r.id));
      // Keep chats we're attached to even if the list query filtered them out,
      // unless they were archived or deleted from here.
      for (const stored of this.runtimeByStored.keys()) if (!this.tidied.has(stored)) ids.add(stored);
      this.listCache = { at: Date.now(), ids: [...ids] };
    }
    const chats = this.listCache.ids;
    await this.refreshDefaultFolder();
    // Sub-agent runs come on top; they never take a chat's place, and never break the list.
    await this.refreshSubagents().catch((err) => this.log.warn({ err: String(err) }, "couldn't list hermes sub-agents"));
    return [...chats, ...[...this.subagents.keys()].filter((id) => !chats.includes(id))].map((id) => this.summaryFor(id));
  }

  /**
   * Where Hermes runs a chat that has no folder of its own: its launch folder, or `terminal.cwd`.
   * Its dashboard reports it for new chats. Asked now and then; a Hermes that can't say keeps the
   * last answer (or none: those chats' headers then name no folder).
   */
  private refreshDefaultFolder(): Promise<void> {
    if (Date.now() - this.defaultFolderAt < DEFAULT_FOLDER_TTL_MS) return Promise.resolve();
    this.defaultFolderLoading ??= (async () => {
      try {
        const data = await this.auth.json<{ default_cwd?: unknown }>(DEFAULT_FOLDER_QUERY);
        const path = str(data.default_cwd);
        if (path?.startsWith('/')) this.defaultFolder = path;
      } catch (err) {
        this.log.warn({ err: err instanceof Error ? err.message : String(err) }, "couldn't ask hermes where chats without a folder run");
      } finally {
        this.defaultFolderAt = Date.now();
        this.defaultFolderLoading = undefined;
      }
    })();
    return this.defaultFolderLoading;
  }

  /** The delegate_task runs of the listed chats (see resolveSubagents). */
  private async refreshSubagents(): Promise<void> {
    if (!(await this.subagentsSupported())) {
      this.subagents.clear();
      return;
    }
    if (!this.subagentRows || Date.now() - this.subagentRows.at >= SUBAGENT_TTL_MS) {
      this.subagentFetch ??= this.auth
        .json<{ sessions?: HermesSessionRow[] }>(SUBAGENT_QUERY)
        .then((data) => data.sessions ?? [])
        .finally(() => {
          this.subagentFetch = undefined;
        });
      this.subagentRows = { at: Date.now(), rows: await this.subagentFetch };
    }
    const acpFresh = this.acpRows && Date.now() - this.acpRows.at < ACP_TTL_MS;
    const input = {
      listed: (this.listCache?.ids ?? []).map((id) => this.rows.get(id) ?? { id }),
      rows: this.subagentRows.rows,
      movedTo: this.movedTo,
    };
    let result = resolveSubagents(acpFresh ? { ...input, acp: this.acpRows!.rows } : input);
    if (result.needsAcp) {
      // Only now: some run's parent may be an ACP session under a later id.
      const data = await this.auth.json<{ sessions?: HermesSessionRow[] }>(ACP_QUERY).catch(() => ({ sessions: [] }));
      this.acpRows = { at: Date.now(), rows: data.sessions ?? [] };
      result = resolveSubagents({ ...input, acp: this.acpRows.rows });
    }
    this.subagents = new Map(result.entries.map((entry) => [entry.row.id, entry]));
  }

  /** `sessions.show_subagents` is in Hermes' defaults only in versions that can list runs. */
  private subagentsSupported(): Promise<boolean> {
    this.subagentSupport ??= this.auth
      .json<{ sessions?: unknown }>('/api/config/defaults')
      .then(({ sessions }) => typeof sessions === 'object' && sessions !== null && 'show_subagents' in sessions)
      .catch(() => false);
    return this.subagentSupport;
  }

  // ---- tidying up ----------------------------------------------------------------

  /**
   * Archive chats in Hermes itself (its app hides them too), each with its
   * whole compression lineage. With a folder, also the older chats Hermes has
   * there that the inbox doesn't list.
   */
  async archiveThreads(ids: string[], folder?: FolderScope, signal = deviceSignal()): Promise<ThreadActionResult> {
    const archive = async (id: string) => {
      await this.patchSession(id, { archived: true }, signal);
      this.dropFromList(id);
    };
    const result = await eachThread('hermes', ids, archive, signal);
    if (folder) {
      const listed = new Set(ids);
      const older = (await this.chatsIn(folder)).filter((id) => !listed.has(id));
      const swept = await eachThread('hermes', older, archive, signal);
      result.done += swept.done;
      result.failed.push(...swept.failed);
    }
    return result;
  }

  async restoreThreads(ids: string[], signal = deviceSignal()): Promise<ThreadActionResult> {
    const result = await eachThread('hermes', ids, async (id) => {
      await this.patchSession(id, { archived: false }, signal);
      this.tidied.delete(id);
    }, signal);
    this.scheduleListRefresh(0);
    return result;
  }

  /**
   * Delete chats for good: every id of a compressed chat's lineage, each taking
   * its delegate_task runs along. Archived first, so no part of it shows meanwhile.
   */
  async deleteThreads(ids: string[], signal = deviceSignal()): Promise<ThreadActionResult> {
    return eachThread('hermes', ids, async (id) => {
      const lineage = await this.lineageOf(id);
      checkDeviceSignal(signal);
      await this.patchSession(id, { archived: true }, signal);
      this.dropFromList(id);
      for (const member of [id, ...lineage.filter((m) => m !== id)]) {
        checkDeviceSignal(signal);
        await this.auth.json(`/api/sessions/${encodeURIComponent(member)}`, { method: 'DELETE' }, signal);
      }
    }, signal);
  }

  async listArchived(limit: number): Promise<ArchivedThread[]> {
    const data = await this.auth.json<{ sessions?: HermesSessionRow[] }>(
      `/api/sessions?limit=${Math.min(Math.max(limit, 1), 100)}&order=recent&archived=only&min_messages=1&exclude_sources=cron,acp`,
    );
    return (data.sessions ?? []).map((row): ArchivedThread => {
      const summary = sessionSummary(row, 'idle', 0);
      return {
        source: 'hermes',
        id: row.id,
        title: summary.title,
        updatedAt: summary.updatedAt,
        ...(summary.project ? { folder: homeRelative(summary.project.path) } : {}),
      };
    });
  }

  async idleThreads(before: number): Promise<string[]> {
    const ids: string[] = [];
    await this.eachChatPage('', (row) => {
      if (sessionSummary(row, 'idle', 0).updatedAt < before && !this.workingNow(row.id)) ids.push(row.id);
    });
    return ids;
  }

  /** The chats Hermes has that the Projects view would file under `folder`. */
  private async chatsIn(folder: FolderScope): Promise<string[]> {
    const path = canonicalFolder(folder.path);
    if (!path || isBareFolder(path)) return [];
    const roots = folder.paseoRoots
      .map((root) => canonicalFolder(root))
      .filter((root): root is string => root !== null && !isBareFolder(root))
      .sort((a, b) => b.length - a.length);
    // As the Projects view: the longest Paseo project folder holding it, else its own folder.
    const projectOf = (at: string) => roots.find((root) => within(at, root)) ?? at;
    const ids: string[] = [];
    await this.eachChatPage(`&cwd_prefix=${encodeURIComponent(path)}`, (row) => {
      const at = canonicalFolder(sessionSummary(row, 'idle', 0).project?.path);
      if (at && !isBareFolder(at) && projectOf(at) === path && !this.workingNow(row.id)) ids.push(row.id);
    });
    return ids;
  }

  /** Every non-archived top-level chat, a page at a time. Collect first, act after: acting shifts the pages. */
  private async eachChatPage(extra: string, visit: (row: HermesSessionRow) => void): Promise<void> {
    for (let page = 0; page < TIDY_PAGES; page++) {
      const data = await this.auth.json<{ sessions?: HermesSessionRow[] }>(
        `${TIDY_QUERY}&offset=${page * TIDY_PAGE}${extra}`,
      );
      const rows = data.sessions ?? [];
      rows.forEach(visit);
      if (rows.length < TIDY_PAGE) return;
    }
  }

  private workingNow(stored: string): boolean {
    const { status } = this.summaryFor(stored);
    return status === 'running' || status === 'needs_approval';
  }

  /** Every id of a compressed chat's lineage, as Hermes reports it. */
  private async lineageOf(id: string): Promise<string[]> {
    const known = this.rows.get(id)?._lineage_ids;
    if (known?.length) return known;
    const row = await this.auth
      .json<HermesSessionRow>(`/api/sessions/${encodeURIComponent(id)}`)
      .catch(() => undefined);
    return row?._lineage_ids ?? [];
  }

  private patchSession(id: string, change: { archived: boolean }, signal = deviceSignal()): Promise<unknown> {
    return this.auth.json(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(change),
    }, signal);
  }

  /** Take an archived or deleted chat, and the runs folded under it, out of the inbox now. */
  private dropFromList(id: string): void {
    this.tidied.add(id);
    const runs = [...this.subagents.values()]
      .filter((entry) => entry.parent?.source === 'hermes' && entry.parent.id === id)
      .map((entry) => entry.row.id);
    for (const stored of [id, ...runs]) {
      this.subagents.delete(stored);
      this.lastPublished.delete(stored);
      this.hub.publish({ type: 'conversation_removed', source: 'hermes', id: stored });
    }
    if (this.listCache) this.listCache = { ...this.listCache, ids: this.listCache.ids.filter((x) => x !== id) };
    this.subagentRows = undefined;
  }

  listApprovals(): Approval[] {
    return [...this.pending.values()].map((p) => p.approval);
  }

  private approvalsFor(stored: string): Approval[] {
    return this.listApprovals().filter((a) => a.conversationId === stored);
  }

  /** Follow explicit compression reports without relying on a recent-chat listing. */
  resolveChat(stored: string): string {
    return this.chatIdentity.resolve(stored);
  }

  /** A missed compression is held until Hermes' session row confirms the listed continuation. */
  async resolveListedChat(stored: string, list: readonly ConversationSummary[]): Promise<string> {
    const current = this.resolveChat(stored);
    const candidates = list.filter((c) => c.id !== current && c.aliases?.some((a) => a.source === 'hermes' && a.id === current));
    if (!candidates.length) return current;
    if (candidates.length !== 1) throw new UserFacingError('Hermes recipient identity is awaiting confirmation.', 503);
    let row: HermesSessionRow;
    try {
      row = await this.auth.json<HermesSessionRow>(`/api/sessions/${encodeURIComponent(candidates[0]!.id)}`);
    } catch (err) { throw this.userError(err); }
    const ids = row._lineage_ids;
    if (row.id !== candidates[0]!.id || !Array.isArray(ids) || ids.at(-1) !== row.id || !ids.includes(current) ||
        new Set(ids).size !== ids.length || !ids.every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id))) {
      throw new UserFacingError('Hermes recipient identity is awaiting confirmation.', 503);
    }
    // Persist authoritative compression lineage before any relay can use it.
    this.chatIdentity.recordLineage(ids);
    this.rows.set(row.id, row);
    return this.resolveChat(stored);
  }

  /** The current chat's live readiness, including chats omitted from the recent list. */
  summaryOf(stored: string): ConversationSummary | undefined {
    if (this.statusValue.state === 'needs_credentials') return undefined;
    const current = this.resolveChat(stored);
    const active = this.activeByStored.get(current);
    if (!['idle', 'waiting', 'working', 'starting', 'streaming', 'resuming'].includes(active ?? '') &&
        !this.turns.has(current) && !this.approvalsFor(current).length) return undefined;
    return this.summaryFor(current);
  }

  async deliverySummary(stored: string): Promise<ConversationSummary | undefined> {
    this.requireReady();
    const current = this.resolveChat(stored);
    // An omitted delegate must be classified before a resume can make it look writable.
    if (await this.isSubagent(current, true)) return undefined;
    // Known busy chats need no attachment; idle or unknown ones need a live snapshot.
    const known = this.summaryOf(current);
    if (known && (known.status !== 'idle' || known.pendingApprovals)) return known;
    try {
      // A queued delivery attaches to establish readiness. Only the bridge delivers, and only a primary runs it.
      await this.ensureAttached(current, 'act');
      if (this.resolveChat(stored) !== current) return undefined;
      if (!this.summaryOf(current)) await this.refreshActive();
      return this.summaryOf(current);
    } catch (err) { throw this.userError(err); }
  }

  private summaryFor(stored: string): ConversationSummary {
    const run = this.subagents.get(stored);
    if (run) return subagentSummary(run, this.defaultFolder);
    const row = this.rows.get(stored) ?? { id: stored };
    if (this.delegateRuns.has(stored)) return subagentSummary({ row }, this.defaultFolder);
    const approvals = this.approvalsFor(stored).length;
    let status: ConversationStatus = activeStatus(this.activeByStored.get(stored));
    if (this.turns.has(stored) && status === 'idle') status = 'running';
    if (approvals > 0) status = 'needs_approval';
    const summary = sessionSummary(row, status, approvals, this.defaultFolder);
    const startedBy = this.startedByOf(stored);
    // A chat an agent started through the bridge nests under the chat that started it.
    if (startedBy) return { ...summary, startedBy, parent: summary.parent ?? { source: startedBy.source, id: startedBy.id } };
    // One an agent started from a shell (`hermes chat --oneshot`) is that agent's run: it folds
    // under it wherever it ran, read-only like a delegate_task run.
    const launch = this.options.lineage?.launchOf([stored, ...(summary.aliases ?? []).map((a) => a.id)]);
    const parent = launch && this.options.lineage!.parentOf(launch.candidates, launch.startedAt);
    return parent ? { ...summary, parent, subagent: true } : summary;
  }

  /** The bridge's record of who started a chat: in memory, else the persisted copy (it survives restarts). */
  private startedByOf(stored: string): StartedBy | undefined {
    return this.startedBy.get(stored) ?? this.options.lineage?.startedBy(`hermes:${stored}`);
  }

  private publishSummary(stored: string): void {
    const conversation = this.summaryFor(stored);
    const json = JSON.stringify(conversation);
    if (this.lastPublished.get(stored) === json) return;
    this.lastPublished.set(stored, json);
    this.hub.publish({ type: 'conversation_upsert', conversation });
  }

  private scheduleListRefresh(delay = 800): void {
    clearTimeout(this.listRefresh);
    this.listRefresh = setTimeout(async () => {
      this.listCache = undefined;
      try {
        for (const c of await this.listConversations()) this.publishSummary(c.id);
      } catch {
        // surfaced through status
      }
    }, delay);
  }

  // No activeTurns() count: /api/status normalizes missing or invalid runtime counts
  // to zero, and gateway_running=false also covers failed identity probes. Neither
  // it nor session.active_list establishes host-wide activity: independent desktop
  // backends have their own session registries. busy.ts keeps an unavailable count
  // unknown until Hermes offers authoritative evidence covering every backend.

  /**
   * What Hermes' live sessions are doing. Also the safety net for cards: a
   * session Hermes calls idle, or doesn't list (it restarted, or the session
   * closed), has no request open, so its cards are leftovers that no
   * request.cancel will ever clear. Only reads; never resumes a session that
   * isn't live, which could restart a turn Hermes lost in a crash. Returns the
   * stored ids of the live sessions, or undefined when Hermes didn't answer.
   */
  private refreshActive(): Promise<Set<string> | undefined> {
    const revision = ++this.activityRevision;
    this.latestActivityPoll = revision;
    const attachmentGeneration = this.attachmentGeneration;
    const result = this.readActive(revision);
    this.activityPoll = { revision, attachmentGeneration, result };
    return result;
  }

  private async readActive(revision: number): Promise<Set<string> | undefined> {
    // Only cards and turns from before asking: one that starts meanwhile may postdate the answer.
    const earlier = [...this.pending.keys()];
    const turnsBefore = new Map(this.turns);
    const attachmentGeneration = this.attachmentGeneration;
    const gatewayGeneration = this.gateway.generation;
    for (const stored of new Set([...this.activityRevisions.keys(), ...this.activeByStored.keys(),
      ...this.runtimeByStored.keys(), ...this.turns.keys(), ...[...this.pending.values()].map((entry) => entry.approval.conversationId)])) {
      this.activityRevisions.set(stored, revision);
    }
    const current = (stored: string) => this.activityRevisions.get(stored) === revision ||
      (!this.activityRevisions.has(stored) && this.latestActivityPoll === revision);
    let result: { sessions?: Array<{ id?: string; session_key?: string; status?: string }> };
    try {
      result = await this.call('session.active_list', {}, 15_000);
    } catch {
      return undefined;
    }
    // A retired runtime cannot restore readiness or clear the replacement's cards and turn.
    if (attachmentGeneration !== this.attachmentGeneration || gatewayGeneration !== this.gateway.generation ||
        this.gateway.state !== 'ready' || this.attaching.size > 0) return undefined;
    try {
      for (const session of result.sessions ?? []) {
        const stored = session.session_key;
        if (!stored) continue;
        const runtime = this.runtimeByStored.get(stored);
        if (this.resolveChat(stored) !== stored || (runtime && runtime !== session.id)) return undefined;
      }
    } catch (err) {
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, "couldn't confirm Hermes activity identity");
      return undefined;
    }
    const seen = new Set<string>();
    /** Stored and runtime ids of sessions that aren't idle: they may still be waiting on you. */
    const notIdle = new Set<string>();
    for (const s of result.sessions ?? []) {
      const stored = s.session_key;
      if (!stored || !current(stored)) continue;
      this.activityRevisions.set(stored, revision);
      seen.add(stored);
      const active = s.status !== 'idle';
      if (active) {
        notIdle.add(stored);
        if (s.id) notIdle.add(s.id);
      }
      if (this.activeByStored.get(stored) !== s.status) {
        if (s.status) this.activeByStored.set(stored, s.status);
        else this.activeByStored.delete(stored);
        this.publishSummary(stored);
      }
      // Listed means live, so attaching is a warm resume. Attach to chats open on a phone (to
      // stream), chats waiting on you (started elsewhere, e.g. the desktop app), and live chats
      // whose cards need checking against a snapshot (after a reconnect).
      const wanted = this.watched.has(stored) || (active && (s.status === 'waiting' || this.approvalsFor(stored).length > 0));
      if (wanted && !this.runtimeByStored.has(stored)) {
        this.options.background.run(() => {
          void this.ensureAttached(stored).catch(() => {});
        });
      }
    }
    for (const stored of [...this.activeByStored.keys()]) {
      if (current(stored) && !seen.has(stored)) {
        this.activeByStored.delete(stored);
        this.publishSummary(stored);
      }
    }
    for (const id of earlier) {
      const entry = this.pending.get(id);
      if (!entry || !current(entry.approval.conversationId)) continue;
      const runtime = this.runtimeByStored.get(entry.approval.conversationId);
      if (!notIdle.has(entry.approval.conversationId) && !(runtime && notIdle.has(runtime))) this.removePending(id);
    }
    // Same for a turn we saw start: if Hermes shows the chat idle or doesn't list it (it was
    // killed mid-turn), no message.complete will come; close the turn, or it stays "running".
    for (const [stored, turn] of turnsBefore) {
      if (!current(stored)) continue;
      if (this.turns.get(stored) !== turn) continue;
      const runtime = this.runtimeByStored.get(stored);
      if (notIdle.has(stored) || (runtime && notIdle.has(runtime))) continue;
      this.sealText(stored);
      this.turns.delete(stored);
      this.publishSummary(stored);
    }
    return seen;
  }

  /** New submissions and gateway activity invalidate older polls for this chat. */
  private noteActivity(stored: string): void {
    this.activityRevisions.set(stored, ++this.activityRevision);
  }

  /**
   * The chat's runtime id if we're attached or it's live in Hermes (attaching then is a warm
   * resume); otherwise undefined, and nothing is resumed. A cold resume, of a chat that isn't
   * live, can make Hermes re-run a turn that was killed with it, so only a user action that
   * needs the chat running (sending, a command, changing a control) does one.
   */
  private async attachIfLive(stored: string): Promise<string | undefined> {
    const runtime = this.runtimeByStored.get(stored);
    if (runtime) return runtime;
    if (this.gateway.state !== 'ready') return undefined;
    const generation = this.gateway.generation;
    void this.refreshActive();
    let poll = this.activityPoll!;
    for (;;) {
      const live = await poll.result;
      if (this.gateway.state !== 'ready' || generation !== this.gateway.generation) return undefined;
      const attached = this.runtimeByStored.get(stored);
      if (attached) return attached;
      // Keep this call's open intent while a newer poll owns live membership.
      // Joining its read does not give background polling permission to attach.
      if (this.activityPoll !== poll) { poll = this.activityPoll!; continue; }
      if (poll.attachmentGeneration !== this.attachmentGeneration || this.attaching.size > 0) {
        // Another chat's resume invalidated this read. Keep the open pending until
        // attachments settle, then verify membership again before resuming this chat.
        await Promise.allSettled([...this.attaching.values()]);
        if (this.gateway.state !== 'ready' || generation !== this.gateway.generation) return undefined;
        if (this.activityPoll === poll) void this.refreshActive();
        poll = this.activityPoll!;
        continue;
      }
      return live?.has(stored) && this.activityRevisions.get(stored) === poll.revision ? this.ensureAttached(stored) : undefined;
    }
  }

  /** Soon after a turn ends or a session stops, check what Hermes still has open. */
  private scheduleActiveCheck(): void {
    if (this.activeCheck) return;
    this.activeCheck = setTimeout(() => {
      this.activeCheck = undefined;
      if (this.gateway.state === 'ready') void this.refreshActive();
    }, ACTIVE_CHECK_DELAY_MS);
  }

  // ---- one conversation -----------------------------------------------------

  async getConversation(stored: string, deliberateOpen = false): Promise<ConversationDetail> {
    this.requireCredentials();
    const [page] = await Promise.all([
      this.auth
        .json<{ messages?: HermesMessageRow[] }>(
          `/api/sessions/${encodeURIComponent(stored)}/messages?limit=200&order=latest`,
        )
        .catch((err) => {
          throw new UserFacingError(
            err instanceof HermesAuthError ? err.message : "Couldn't load this Hermes chat.",
          );
        }),
      // History comes from the REST API, which only reads. Attach just to stream, and only if
      // live; never to a sub-agent's run (it's never live on its own anyway).
      this.subagents.has(stored) || this.delegateRuns.has(stored) ? undefined
        : deliberateOpen ? this.attachIfLive(stored).catch(() => undefined)
        : this.options.background.run(() => this.attachIfLive(stored).catch(() => undefined)),
      this.rows.has(stored) ? undefined : this.loadRow(stored),
    ]);
    const items = mergeByTime(messagesToItems(page.messages ?? []), this.commandItems.get(stored) ?? []);
    const turn = this.turns.get(stored);
    if (turn?.reasoningId) items.push({ kind: 'reasoning', id: turn.reasoningId, text: turn.reasoningText, streaming: true });
    if (turn?.assistantId) items.push({ kind: 'assistant', id: turn.assistantId, text: turn.assistantText, streaming: true });
    return { conversation: this.summaryFor(stored), items, approvals: this.approvalsFor(stored),
      ...(this.options.background.role === 'shadow' ? { needsOpen: !this.runtimeByStored.has(stored) && !this.subagents.has(stored) && !this.delegateRuns.has(stored) } : {}) };
  }

  private async loadRow(stored: string, required = false): Promise<void> {
    try {
      const row = await this.auth.json<HermesSessionRow>(`/api/sessions/${encodeURIComponent(stored)}`);
      if (!row?.id || (required && row.id !== stored)) {
        if (required) throw new UserFacingError('Hermes recipient identity is unknown.', 503);
        return;
      }
      // Only the detail row says whether a chat is a delegate_task run; keep just that of its config.
      if (isDelegateRun(row)) this.delegateRuns.add(row.id);
      const { model_config: _config, ...rest } = row;
      this.rows.set(row.id, rest);
    } catch (err) {
      if (required) throw this.userError(err);
      // title falls back to "New chat"
    }
  }

  /** A delegate_task run: the parent's agent runs it, so it's read-only here. */
  private async isSubagent(stored: string, forDelivery = false): Promise<boolean> {
    if (this.subagents.has(stored) || this.delegateRuns.has(stored)) return true;
    if (this.listCache?.ids.includes(stored) || (!forDelivery && this.runtimeByStored.has(stored))) return false;
    if (forDelivery || !this.rows.has(stored)) await this.loadRow(stored, forDelivery);
    return this.delegateRuns.has(stored);
  }

  private async requireNotSubagent(stored: string): Promise<void> {
    if (await this.isSubagent(stored)) {
      throw new UserFacingError("This is a sub-agent's run. The chat that started it runs it, so it can only be read here.", 400);
    }
  }

  setWatching(stored: string, watching: boolean): void {
    if (!watching) {
      this.watched.delete(stored);
      return;
    }
    this.watched.add(stored);
    // Stream it now if it's live; if it becomes live later, refreshActive attaches it then.
    this.options.background.run(() => this.attachIfLive(stored).catch((err) => this.log.warn({ err: String(err) }, 'hermes attach failed')));
  }

  /**
   * Attach to a chat (`session.resume`). `purpose` matters only for a chat that isn't live: if
   * Hermes lost a turn there in a crash, it schedules a re-run of that turn. A message you send
   * ('send') starts first and Hermes drops the re-run; for anything else ('act') Signalbox
   * cancels it, so it's never the reason a killed turn runs again.
   */
  private ensureAttached(stored: string, purpose: 'send' | 'act' = 'act'): Promise<string> {
    const runtime = this.runtimeByStored.get(stored);
    if (runtime) return Promise.resolve(runtime);
    let attaching = this.attaching.get(stored);
    if (!attaching) {
      this.attachmentGeneration++;
      attaching = (async () => {
        checkDeviceSignal();
        await this.gateway.enableServerRequests();
        // The cards we had before the snapshot: it says which of them Hermes still has open.
        const earlier = this.approvalsFor(stored).map((a) => a.id);
        const snap = await this.call<ResumeSnapshot>(
          'session.resume',
          { session_id: stored, cols: 100, omit_messages: true },
          60_000,
        );
        checkDeviceSignal();
        this.bind(stored, snap.session_id);
        const current = str(snap.info?.stored_session_id) ?? stored;
        if (current !== stored) this.moveConversation(stored, current, snap.session_id);
        this.applySnapshot(current, snap, earlier);
        const frames = this.attachmentFrames.get(snap.session_id) ?? [];
        this.attachmentFrames.delete(snap.session_id);
        withDeviceSignal(undefined, () => {
          for (const frame of frames) {
            if ('event' in frame) this.onEvent(frame.event);
            else this.onRequest(frame.request, frame.generation);
          }
        });
        if (snap.auto_continue && purpose !== 'send') await this.cancelRerun(current, snap.session_id);
        return snap.session_id;
      })().finally(() => {
        this.attaching.delete(stored);
        if (!this.attaching.size) this.attachmentFrames.clear();
      });
      this.attaching.set(stored, attaching);
    }
    return attaching;
  }

  /** Hermes is re-running a turn it lost when it stopped (auto-continue). */
  private noteRerun(stored: string): void {
    this.publishItems(stored, [
      { kind: 'notice', id: `resuming-${this.nonce}-${Date.now()}`, level: 'info', text: 'Hermes is resuming the interrupted turn.' },
    ]);
  }

  /**
   * Cancel Hermes' pending re-run of a turn it lost. `session.interrupt` sets the flag the
   * re-run checks before it starts, and retires the crash marker (methods_session.py).
   */
  private async cancelRerun(stored: string, runtime: string): Promise<void> {
    try {
      await this.call('session.interrupt', { session_id: runtime }, 15_000);
    } catch (err) {
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, "couldn't cancel Hermes' re-run of a lost turn");
      return;
    }
    this.publishItems(stored, [
      {
        kind: 'notice',
        id: `rerun-${this.nonce}-${Date.now()}`,
        level: 'info',
        text: 'Hermes was about to re-run the turn that was interrupted. Wayroost cancelled that.',
      },
    ]);
  }

  private bind(stored: string, runtime: string): void {
    this.attachmentGeneration++;
    const previous = this.runtimeByStored.get(stored);
    if (previous && previous !== runtime) this.storedByRuntime.delete(previous);
    this.runtimeByStored.set(stored, runtime);
    this.storedByRuntime.set(runtime, stored);
  }

  private unbind(stored: string): void {
    this.attachmentGeneration++;
    this.noteActivity(stored);
    const runtime = this.runtimeByStored.get(stored);
    if (runtime) this.storedByRuntime.delete(runtime);
    this.runtimeByStored.delete(stored);
    this.activeByStored.delete(stored);
  }

  private applySnapshot(stored: string, snap: ResumeSnapshot, earlier: string[] = []): void {
    this.noteActivity(stored);
    if (snap.info) this.noteSettings(stored, snap.info);
    if (snap.running === true || snap.running === false || snap.status) {
      this.activeByStored.set(stored, snap.running && (!snap.status || snap.status === 'idle') ? 'working'
        : snap.status ?? (snap.running ? 'working' : 'idle'));
    } else this.activeByStored.delete(stored); // A new runtime must prove its own readiness.
    const inflight = snap.inflight?.assistant;
    if (snap.running && typeof inflight === 'string' && inflight) {
      const turn = this.startTurn(stored);
      turn.assistantId = this.itemId(turn);
      turn.assistantText = inflight;
      turn.anyAssistant = true;
      this.publishItems(stored, [{ kind: 'assistant', id: turn.assistantId, text: inflight, streaming: true }]);
    }
    // Attached while Hermes re-runs a turn it lost: its "resuming" status went out before we did.
    if (snap.running && snap.inflight?.display_kind === 'auto_continue') this.noteRerun(stored);
    // Open requests count only while the session can still be waiting on you: a turn is
    // running, or Hermes says it's waiting (background work can ask after a turn ends).
    const open = snap.running === true || snap.status === 'waiting' ? (snap.open_requests ?? []) : [];
    for (const request of open) {
      // No connection: a restored request is answered with request.answer, which confirms it.
      this.onRequest({ id: request.id, method: request.method, params: { ...(request.params ?? {}), session_id: snap.session_id } }, null);
    }
    // Earlier cards the snapshot doesn't list are gone from Hermes: it restarted, or we
    // missed their request.cancel while disconnected.
    const listed = new Set(open.map((request) => request.id));
    for (const id of earlier) {
      const entry = this.pending.get(id);
      if (entry && !listed.has(entry.srq)) this.removePending(id);
    }
    this.publishSummary(stored);
  }

  // ---- actions --------------------------------------------------------------

  async sendMessage(stored: string, text: string, attachments: Attachment[] = []): Promise<CommandResult | void> {
    this.requireReady();
    await this.requireNotSubagent(stored);
    // Like every Hermes client, "/" text runs as a command; with files attached it's a prompt.
    const command = attachments.length ? null : parseSlash(text);
    if (command) return this.runCommand(stored, command);
    if (attachments.length && this.isBusy(stored)) {
      // Staged files would be consumed by whatever prompt comes next; don't let a running turn take them.
      throw new UserFacingError('Hermes is still working on this chat. Wait for it to finish, or stop it, before sending files.', 409);
    }
    checkDeviceSignal();
    await this.submitPrompt(stored, { text, attachments });
  }

  async sendMessageWhenIdle(stored: string, text: string, beforeSubmit?: () => Promise<void>): Promise<void> {
    this.requireReady();
    await this.requireNotSubagent(stored);
    await this.submitPrompt(stored, { text, whenIdle: true, beforeSubmit });
  }

  private isBusy(stored: string): boolean {
    return this.turns.has(stored) || activeStatus(this.activeByStored.get(stored)) !== 'idle';
  }

  /** Upload any files, send the prompt, and show the user's message. */
  private async submitPrompt(
    stored: string,
    prompt: { text: string; display?: string; attachments?: Attachment[]; whenIdle?: boolean; beforeSubmit?: () => Promise<void> },
  ): Promise<void> {
    const attachments = prompt.attachments ?? [];
    const submit = async () => {
      // A prompt that follows at once starts before any re-run Hermes scheduled. Uploads come
      // first, so with files the re-run is cancelled instead: it could start, and take them.
      stored = this.resolveChat(stored);
      const runtime = await this.ensureAttached(stored, attachments.length || prompt.whenIdle ? 'act' : 'send');
      stored = this.resolveChat(stored);
      const staged = await this.stageAttachments(runtime, attachments);
      // The bridge keeps this delivery cancellable through attachment and stale-runtime retries.
      if (prompt.beforeSubmit) await prompt.beforeSubmit();
      stored = this.resolveChat(stored);
      if (prompt.whenIdle) {
        const summary = this.summaryOf(stored);
        if (this.resolveChat(stored) !== stored || this.runtimeByStored.get(stored) !== runtime ||
            !summary || summary.status !== 'idle' || summary.pendingApprovals > 0) {
          throw new UserFacingError('Hermes recipient is busy, awaiting approval, or its readiness is unknown.', 503);
        }
      }
      checkDeviceSignal();
      this.noteActivity(stored);
      this.activeByStored.set(stored, 'working');
      this.publishSummary(stored);
      try {
        return await this.call<{ status?: string; user_row_id?: number }>(
          'prompt.submit',
          { session_id: runtime, text: composePrompt(prompt.text, staged) },
          30_000,
        );
      } catch (err) {
        // Refresh readiness after a failed submission (the bridge's delivery runs only in primary).
        this.scheduleActiveCheck();
        await this.detachImages(runtime, staged.images);
        throw err;
      }
    };
    let result: { status?: string; user_row_id?: number };
    try {
      result = await submit();
    } catch (err) {
      if (err instanceof RpcError && (err.code === 4001 || err.code === 4007)) {
        stored = this.resolveChat(stored);
        this.unbind(stored);
        result = await submit().catch((e) => {
          throw this.userError(e);
        });
      } else {
        throw this.userError(err);
      }
    }
    stored = this.resolveChat(stored);
    const id = result.user_row_id ? `m${result.user_row_id}` : `u-${this.nonce}-${Date.now()}`;
    this.publishItems(stored, [
      {
        kind: 'user',
        id,
        text: prompt.display ?? prompt.text.trim(),
        at: Date.now(),
        ...(attachments.length ? { attachments: attachments.map((a) => ({ name: a.name, kind: a.kind })) } : {}),
      },
    ]);
  }

  /**
   * Upload files to the session, one at a time, before the prompt (as the
   * desktop app does). Images queue on the session for the next prompt; other
   * files are saved by Hermes and referenced from the prompt text. Bytes are
   * always sent inline; Signalbox never passes Hermes a path to read.
   */
  private async stageAttachments(runtime: string, attachments: Attachment[]): Promise<Staged> {
    const staged: Staged = { refs: [], images: [] };
    try {
      for (const file of attachments) {
        const base64 = file.bytes.toString('base64');
        if (file.kind === 'image') {
          const result = await this.call<{ path?: unknown }>(
            'image.attach_bytes',
            { session_id: runtime, content_base64: base64, filename: imageFileName(file) },
            60_000,
          );
          if (typeof result.path === 'string') staged.images.push(result.path);
        } else {
          const result = await this.call<{ ref_text?: unknown }>(
            'file.attach',
            { session_id: runtime, name: file.name, path: '', data_url: `data:${file.mimeType};base64,${base64}` },
            120_000,
          );
          if (typeof result.ref_text !== 'string' || !result.ref_text) {
            throw new UserFacingError(`Hermes couldn't take ${file.name}.`);
          }
          staged.refs.push(result.ref_text);
        }
      }
    } catch (err) {
      await this.detachImages(runtime, staged.images);
      if (err instanceof RpcError && err.code >= 4000 && err.code !== 4001 && err.code !== 4007) {
        throw new UserFacingError(`Hermes couldn't take the attachment: ${err.message}`, 400);
      }
      throw err;
    }
    return staged;
  }

  private async detachImages(runtime: string, paths: string[]): Promise<void> {
    await Promise.allSettled(paths.map((path) => this.call('image.detach', { session_id: runtime, path }, 10_000)));
  }

  // ---- images agents show -----------------------------------------------------

  /**
   * An image an agent showed, read by the Hermes dashboard, which runs as you
   * and applies its own sensitive-file rules. Same call the desktop app uses.
   */
  async readImage(stored: string, path: string): Promise<MediaFile> {
    this.requireCredentials();
    const query = new URLSearchParams({ path, session_id: stored });
    let res: Response;
    try {
      res = await this.auth.fetch(`/api/fs/download?${query}`, {
        headers: { accept: '*/*' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw this.userError(err);
    }
    const tooLarge = new UserFacingError('That image is too large to show here.', 413);
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 403) throw new UserFacingError("Hermes won't share that file.", 403);
      if (res.status === 404) throw new UserFacingError('That image no longer exists.', 404);
      if (res.status === 413) throw tooLarge;
      throw new UserFacingError("Hermes couldn't read that image.", 502);
    }
    if (Number(res.headers.get('content-length') ?? 0) > MAX_MEDIA_BYTES) {
      await res.body?.cancel();
      throw tooLarge;
    }
    const bytes = await readCapped(res);
    if (!bytes) throw tooLarge;
    return { bytes };
  }

  // ---- model and reasoning --------------------------------------------------

  private noteSettings(stored: string, info: Record<string, unknown>): void {
    const next: SessionSettings = { ...this.settings.get(stored) };
    if (str(info.model)) next.model = info.model as string;
    if (str(info.provider)) next.provider = info.provider as string;
    if (typeof info.reasoning_effort === 'string') next.reasoning = info.reasoning_effort;
    const usage = info.usage as Record<string, unknown> | null | undefined;
    if (usage && typeof usage === 'object') {
      if (typeof usage.context_used === 'number') next.contextUsed = usage.context_used;
      if (typeof usage.context_max === 'number') next.contextMax = usage.context_max;
    }
    this.settings.set(stored, next);
  }

  /** Without a runtime: Hermes' configured options, for a chat that isn't live. */
  private async fetchModelOptions(runtime?: string): Promise<ModelOptions> {
    const key = runtime ?? '';
    const hit = this.modelOptions.get(key);
    if (hit && Date.now() - hit.at < MODEL_OPTIONS_TTL_MS) return hit.options;
    const options = await this.call<ModelOptions>(
      'model.options',
      { ...(runtime ? { session_id: runtime } : {}), explicit_only: true },
      30_000,
    );
    this.modelOptions.set(key, { at: Date.now(), options });
    if (this.modelOptions.size > 50) this.modelOptions.delete(this.modelOptions.keys().next().value!);
    return options;
  }

  /** The model and reasoning pickers, as the desktop app's composer offers them. */
  async getControls(stored: string): Promise<ConversationControls> {
    this.requireReady();
    // A sub-agent's model is its parent's business.
    if (await this.isSubagent(stored)) return { controls: [] };
    let runtime: string | undefined;
    let options: ModelOptions;
    try {
      // Opening a chat shows these; a chat that isn't live isn't resumed for them.
      runtime = this.runtimeByStored.get(stored) ?? await this.options.background.run(() => this.attachIfLive(stored));
      options = await this.fetchModelOptions(runtime);
    } catch (err) {
      throw this.userError(err);
    }
    const settings = this.settings.get(stored) ?? {};
    // Not live: the chat's stored model, not Hermes' current default.
    const model = settings.model ?? (runtime ? str(options.model) : str(this.rows.get(stored)?.model));
    const provider = settings.provider ?? (runtime ? str(options.provider) : undefined);

    const models = modelChoices(options);
    const currentModel = model && provider ? JSON.stringify([provider, model]) : null;
    const controls: ConversationControl[] = [
      {
        id: 'model',
        label: 'Model',
        value: models.some((o) => o.id === currentModel) ? currentModel : null,
        ...(model ? { valueLabel: shortModel(model) ?? model } : {}),
        options: models,
      },
    ];

    // Reasoning effort, unless this model has none to set.
    const capabilities = options.providers?.find((p) => p.slug === provider)?.capabilities?.[model ?? ''];
    if (capabilities?.reasoning !== false) {
      const levels = REASONING_LEVELS.filter(([id]) => id !== 'none' || capabilities?.can_disable_reasoning !== false);
      const reasoning = settings.reasoning || null;
      controls.push({
        id: 'reasoning',
        label: 'Reasoning',
        value: levels.some(([id]) => id === reasoning) ? reasoning : null,
        valueLabel: reasoning ? (REASONING_LEVELS.find(([id]) => id === reasoning)?.[1] ?? reasoning) : 'Default',
        options: levels.map(([id, label]) => ({ id, label })),
      });
    }

    const { contextUsed, contextMax } = settings;
    return {
      controls,
      ...(contextUsed !== undefined && contextMax ? { context: { used: contextUsed, max: contextMax } } : {}),
    };
  }

  /** Switch model or reasoning for this chat only; Hermes' saved defaults stay as they are. */
  async setControl(stored: string, change: ControlChange): Promise<ControlChangeResponse> {
    await this.requireNotSubagent(stored);
    const current = await this.getControls(stored);
    const control = current.controls.find((c) => c.id === change.control);
    if (!control?.options.some((o) => o.id === change.value)) {
      throw new UserFacingError('Pick one of the offered options.', 400);
    }
    const runtime = await this.ensureAttached(stored);
    let notice: string | undefined;
    try {
      if (change.control === 'model') {
        const [provider, model] = JSON.parse(change.value) as [string, string];
        const result = await this.call<Record<string, unknown>>(
          'config.set',
          {
            session_id: runtime,
            key: 'model',
            value: `${model} --provider ${provider} --session`,
            ...(change.confirm ? { confirm_expensive_model: true } : {}),
          },
          30_000,
        );
        if (result.confirm_required === true) {
          return { ok: false, confirm: str(result.confirm_message) ?? `Switch to ${shortModel(model) ?? model}?` };
        }
        this.noteSettings(stored, { model, provider });
        const row = this.rows.get(stored);
        if (row) row.model = model;
        this.publishSummary(stored);
        notice = result.deferred === true ? 'Takes effect on the next turn.' : str(result.warning);
      } else {
        const result = await this.call<Record<string, unknown>>(
          'config.set',
          { session_id: runtime, key: 'reasoning', value: change.value },
          30_000,
        );
        this.noteSettings(stored, { reasoning_effort: change.value });
        notice = str(result.warning);
      }
    } catch (err) {
      throw err instanceof RpcError && err.code >= 4000 ? new UserFacingError(`Hermes: ${err.message}`, 400) : this.userError(err);
    }
    return { ok: true, controls: await this.getControls(stored), ...(notice ? { notice } : {}) };
  }

  /** The models a new chat can start on, and Hermes' default, for the new-chat sheet. */
  async newChatOptions(): Promise<HermesOptions> {
    this.requireReady();
    let options: ModelOptions;
    try {
      options = await this.fetchModelOptions();
    } catch (err) {
      throw this.userError(err);
    }
    const models = modelChoices(options);
    const model = str(options.model);
    const provider = str(options.provider);
    const current = model && provider ? JSON.stringify([provider, model]) : null;
    return { models, defaultModel: models.some((o) => o.id === current) ? current : null };
  }

  // ---- "/" commands ---------------------------------------------------------

  async listCommands(stored: string): Promise<SlashCommand[]> {
    this.requireReady();
    await this.requireNotSubagent(stored);
    // A chat that isn't live gets the general menu rather than being resumed for it.
    const runtime = this.runtimeByStored.get(stored) ?? await this.options.background.run(() => this.attachIfLive(stored).catch((err) => {
      throw this.userError(err);
    }));
    return catalogCommands(await this.fetchCatalog(runtime), { allowSafety: this.allowSafety() });
  }

  private allowSafety(): boolean {
    return this.options.allowSafetyCommands?.() ?? false;
  }

  async listNewChatCommands(): Promise<SlashCommand[]> {
    this.requireReady();
    return catalogCommands(await this.fetchCatalog(), { newChat: true, allowSafety: this.allowSafety() });
  }

  private async fetchCatalog(runtime?: string): Promise<HermesCatalog> {
    const key = runtime ?? '';
    const hit = this.catalogs.get(key);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.catalog;
    let catalog: HermesCatalog;
    try {
      catalog = await this.call<HermesCatalog>('commands.catalog', runtime ? { session_id: runtime } : {}, 30_000);
    } catch (err) {
      throw this.userError(err);
    }
    this.catalogs.set(key, { at: Date.now(), catalog });
    if (this.catalogs.size > 50) this.catalogs.delete(this.catalogs.keys().next().value!);
    return catalog;
  }

  private cachedCatalog(stored: string): HermesCatalog | undefined {
    const runtime = this.runtimeByStored.get(stored);
    return (runtime ? this.catalogs.get(runtime)?.catalog : undefined) ?? this.catalogs.get('')?.catalog;
  }

  /**
   * Run a "/" command the way the desktop app does. Quick ones answer in the
   * reply; slow ones answer "running" and finish live.
   */
  private async runCommand(stored: string, typed: ParsedCommand): Promise<CommandResult> {
    const cmd = { ...typed, name: canonicalName(typed.name, this.cachedCatalog(stored)) };
    const item: CommandItem = {
      kind: 'command',
      id: `cmd-${this.nonce}-${++this.commandSeq}`,
      command: commandLabel(typed),
      output: '',
      at: Date.now(),
    };
    const state = { published: false, done: false };
    const blocked = blockedReason(cmd, this.allowSafety());
    if (blocked) return this.finishCommand(stored, item, { output: blocked, error: true }, state);

    const work = this.executeCommand(stored, cmd, 0)
      .catch((err): CommandOutcome => ({ output: this.commandError(err), error: true }))
      .then((outcome) => this.finishCommand(stored, item, outcome, state));
    const early = await Promise.race([work, delay(this.options.commandWaitMs ?? COMMAND_WAIT_MS)]);
    if (early) return early;
    if (state.done) return work;
    state.published = true;
    const running: CommandItem = { ...item, running: true };
    this.upsertCommandItem(stored, running);
    return { items: [running] };
  }

  private async executeCommand(stored: string, cmd: ParsedCommand, depth: number): Promise<CommandOutcome> {
    this.requireReady();
    switch (cmd.name) {
      case 'new':
      case 'reset':
      case 'clear':
        return { output: 'Start a new chat with the New button.' };
      case 'resume':
      case 'sessions':
      case 'switch':
        return { output: 'Open your other chats from the inbox.' };
      case 'stop': {
        // The desktop app's /stop: end the reply, then background processes. Nothing runs in
        // a chat that isn't live, and resuming it to stop it could start a re-run.
        const runtime = await this.attachIfLive(stored);
        if (runtime) await this.call('session.interrupt', { session_id: runtime }, 15_000);
        await this.call('process.stop', {}, 15_000).catch(() => undefined);
        return {
          output: runtime
            ? 'Stopped the reply and any background processes.'
            : 'Nothing was running in this chat. Stopped any background processes.',
        };
      }
      case 'title':
        return this.titleCommand(stored, cmd.arg);
    }

    const runtime = await this.ensureAttached(stored);
    const timeout = LONG_COMMANDS.has(cmd.name) ? 11 * 60_000 : 3 * 60_000;
    let result: DispatchResult;
    try {
      result = await this.call<DispatchResult>(
        'slash.exec',
        { session_id: runtime, command: `${cmd.name}${cmd.arg ? ` ${cmd.arg}` : ''}` },
        timeout,
      );
    } catch (err) {
      // Skills and some built-ins answer "use command.dispatch"; the desktop app
      // retries any command error that way. Connection problems aren't retried.
      if (!(err instanceof RpcError) || err.code === -1 || err.code === -2) throw err;
      try {
        result = await this.call<DispatchResult>(
          'command.dispatch',
          { session_id: runtime, name: cmd.name, arg: cmd.arg },
          timeout,
        );
      } catch (again) {
        if (again instanceof RpcError && /not a quick\/plugin\/bundle\/skill command/.test(again.message)) throw err;
        throw again;
      }
    }
    return this.applyDispatch(stored, cmd, result, depth);
  }

  private async applyDispatch(
    stored: string,
    cmd: ParsedCommand,
    result: DispatchResult,
    depth: number,
  ): Promise<CommandOutcome> {
    const type = str(result.type);
    const notice = str(result.notice);
    switch (type) {
      case 'alias': {
        const target = parseSlash(`/${(str(result.target) ?? str(result.command) ?? str(result.name) ?? '').replace(/^\/+/, '')}`);
        if (!target || depth >= 4) return { output: `Couldn't follow the alias /${cmd.name}.`, error: true };
        const next = { name: target.name, arg: [target.arg, cmd.arg].filter(Boolean).join(' ') };
        const blocked = blockedReason(next, this.allowSafety());
        if (blocked) return { output: blocked, error: true };
        return this.executeCommand(stored, next, depth + 1);
      }
      case 'send':
      case 'skill': {
        // Skills expand into a long prompt; the chat shows what was typed instead.
        const message = str(result.message);
        if (!message) return { output: notice ?? 'Nothing to send.' };
        if (REWRITES_HISTORY.has(cmd.name)) await this.refreshTimeline(stored);
        await this.submitPrompt(stored, { text: message, display: str(result.display) ?? commandLabel(cmd) });
        return { output: notice ?? '' };
      }
      case 'prefill':
        if (REWRITES_HISTORY.has(cmd.name)) await this.refreshTimeline(stored);
        return { output: notice ?? '', prefill: str(result.message) ?? '' };
      default: {
        if (REWRITES_HISTORY.has(cmd.name)) void this.refreshTimeline(stored);
        const output = [str(result.warning), str(result.output) ?? str(result.message) ?? notice].filter(Boolean).join('\n\n');
        return { output: output || '(no output)' };
      }
    }
  }

  private async titleCommand(stored: string, title: string): Promise<CommandOutcome> {
    const runtime = await this.ensureAttached(stored);
    if (!title) {
      const current = await this.call<{ title?: unknown }>('session.title', { session_id: runtime }, 15_000);
      return { output: str(current.title) ? `Title: ${current.title}` : 'This chat has no title yet.' };
    }
    const result = await this.call<{ title?: unknown }>('session.title', { session_id: runtime, title }, 15_000);
    const saved = str(result.title) ?? title;
    const row = this.rows.get(stored) ?? { id: stored };
    row.title = saved;
    this.rows.set(stored, row);
    this.publishSummary(stored);
    return { output: `Title set to “${oneLine(saved, 120)}”.` };
  }

  private finishCommand(
    stored: string,
    item: CommandItem,
    outcome: CommandOutcome,
    state: { published: boolean; done: boolean },
  ): CommandResult {
    state.done = true;
    const prefill = outcome.prefill !== undefined ? { prefill: outcome.prefill } : {};
    const output = plainOutput(outcome.output ?? '');
    // A skill or prefill with nothing to say leaves no trace; the prompt or the draft is the result.
    if (!output && !state.published) return { items: [], ...prefill };
    const final: CommandItem = { ...item, output: clip(output || 'Done.'), ...(outcome.error ? { error: true } : {}) };
    this.upsertCommandItem(stored, final);
    return { items: [final], ...prefill };
  }

  private commandError(err: unknown): string {
    // The gateway's own messages ("undo: invalid count…") say more than a generic line.
    if (err instanceof RpcError && err.code >= 4000) return err.message;
    return this.userError(err).message;
  }

  private upsertCommandItem(stored: string, item: CommandItem): void {
    const key = this.movedTo.get(stored) ?? stored;
    const list = [...(this.commandItems.get(key) ?? [])];
    const index = list.findIndex((i) => i.id === item.id);
    if (index >= 0) list[index] = item;
    else list.push(item);
    this.commandItems.delete(key);
    this.commandItems.set(key, list.slice(-MAX_COMMAND_ITEMS));
    if (this.commandItems.size > MAX_COMMAND_CONVERSATIONS) this.commandItems.delete(this.commandItems.keys().next().value!);
    this.publishItems(key, [item]);
  }

  /** Reload the whole timeline for viewers after Hermes rewrote it (undo, retry, compress). */
  private async refreshTimeline(stored: string): Promise<void> {
    try {
      const { items } = await this.getConversation(stored);
      this.hub.publish({ type: 'items_replace', source: 'hermes', conversationId: stored, items });
    } catch {
      // the next open shows it
    }
  }

  async interrupt(stored: string): Promise<void> {
    this.requireReady();
    await this.requireNotSubagent(stored);
    try {
      // Nothing runs in a chat that isn't live, and resuming it to stop it could start a re-run.
      const runtime = await this.attachIfLive(stored);
      if (!runtime) return;
      await this.call('session.interrupt', { session_id: runtime }, 15_000);
    } catch (err) {
      throw this.userError(err);
    }
    // Hermes withdraws the session's requests itself (request.cancel); this catches any that don't say so.
    this.scheduleActiveCheck();
  }

  async createConversation(
    text: string,
    cwd?: string,
    attachments: Attachment[] = [],
    options: HermesCreateOptions = {},
  ): Promise<CreateResult> {
    this.requireReady();
    await this.gateway.enableServerRequests();
    // A picked model is checked before the chat exists, so a bad pick leaves nothing behind.
    let chosen: [string, string] | undefined;
    if (options.model !== undefined) {
      let offered: ControlOption[];
      try {
        offered = modelChoices(await this.fetchModelOptions());
      } catch (err) {
        throw this.userError(err);
      }
      if (!offered.some((o) => o.id === options.model)) throw new UserFacingError('Pick one of the offered models.', 400);
      chosen = JSON.parse(options.model) as [string, string];
    }
    let stored: string;
    let runtime: string;
    let folderNotice: string | undefined;
    try {
      const created = await this.call<{ session_id: string; stored_session_id: string; info?: { cwd?: unknown } }>(
        'session.create',
        { cols: 100, ...(cwd ? { cwd } : {}) },
        60_000,
      );
      stored = created.stored_session_id;
      runtime = created.session_id;
      this.bind(stored, runtime);
      // Hermes keeps only a folder that exists; otherwise it quietly starts in its default one.
      const kept = str(created.info?.cwd);
      if (cwd && kept && !sameFolder(kept, cwd)) {
        folderNotice = `Hermes started this chat in ${homeRelative(kept)}, not ${homeRelative(cwd)}.`;
      } else if (cwd && kept) {
        // Its folder shows (and places it in Projects) before the list next says so.
        this.rows.set(stored, { ...(this.rows.get(stored) ?? { id: stored }), cwd: kept });
      }
    } catch (err) {
      throw this.userError(err);
    }
    if (chosen) {
      const [provider, model] = chosen;
      let result: Record<string, unknown>;
      try {
        // For this chat only, like the chat's own model control; Hermes' default stays.
        result = await this.call<Record<string, unknown>>(
          'config.set',
          {
            session_id: runtime,
            key: 'model',
            value: `${model} --provider ${provider} --session`,
            ...(options.confirmModel ? { confirm_expensive_model: true } : {}),
          },
          30_000,
        );
      } catch (err) {
        throw err instanceof RpcError && err.code >= 4000 ? new UserFacingError(`Hermes: ${err.message}`, 400) : this.userError(err);
      }
      if (result.confirm_required === true) {
        throw new UserFacingError(
          `${str(result.confirm_message) ?? `${shortModel(model) ?? model} needs confirming.`} Tick the cost box and start again.`,
          409,
        );
      }
      this.noteSettings(stored, { model, provider });
    }
    const now = Date.now() / 1000;
    const preview = text.trim() || attachments.map((a) => a.name).join(', ');
    this.rows.set(stored, { id: stored, preview, started_at: now, last_active: now, cwd: cwd ?? null, ...(chosen ? { model: chosen[1] } : {}) });
    this.listCache = undefined;
    if (options.startedBy) {
      this.startedBy.set(stored, options.startedBy);
      if (this.startedBy.size > MAX_STARTED_BY) this.startedBy.delete(this.startedBy.keys().next().value!);
      this.options.lineage?.setStartedBy(`hermes:${stored}`, options.startedBy);
    }

    // A new chat can start with a skill or command, as in the desktop app.
    const command = attachments.length ? null : parseSlash(text);
    if (command) {
      const result = await this.runCommand(stored, command);
      if (options.title) await this.nameChat(stored, options.title);
      this.publishSummary(stored);
      return { id: stored, command: result, ...(folderNotice ? { notice: folderNotice } : {}) };
    }
    checkDeviceSignal();
    await this.submitPrompt(stored, { text, attachments });
    if (options.title) await this.nameChat(stored, options.title);
    return { id: stored, ...(folderNotice ? { notice: folderNotice } : {}) };
  }

  /**
   * Title a chat the bridge started. Otherwise Hermes would title it from the
   * first message, which is the bridge envelope. Best effort.
   */
  private async nameChat(stored: string, title: string): Promise<void> {
    try {
      const runtime = await this.ensureAttached(stored);
      const result = await this.call<{ title?: unknown }>('session.title', { session_id: runtime, title }, 15_000);
      const row = this.rows.get(stored) ?? { id: stored };
      row.title = str(result.title) ?? title;
      this.rows.set(stored, row);
      this.publishSummary(stored);
    } catch (err) {
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, "hermes couldn't title a new chat");
    }
  }

  async respondToApproval(stored: string, approvalId: string, answer: ApprovalAnswer): Promise<void> {
    await this.requireNotSubagent(stored);
    checkDeviceSignal();
    const entry = this.pending.get(approvalId);
    if (!entry || entry.approval.conversationId !== stored) {
      throw new UserFacingError('That request is no longer waiting.', 409);
    }

    if (entry.method === 'value') {
      // A password, secret, code or login: checked, sent to Hermes and dropped. It
      // never goes into a log, a notice, an event, the card or an error message.
      const result = secretAnswer(entry.approval.secret?.input ?? 'password', answer);
      if ('problem' in result) throw new UserFacingError(result.problem, 400);
      if (result.value && entry.approval.detailTruncated) {
        // You couldn't see all of what it's for.
        throw new UserFacingError('This is too long to check here. Decline it, or answer it on your PC.', 400);
      }
      await this.answerRequest(entry, result, true);
      this.removeBySrq(entry.srq);
      return;
    }
    // A username and password only ever answer a login card.
    if (answer.login !== undefined) throw new UserFacingError("That answer doesn't fit this request.", 400);

    if (entry.method === 'approval') {
      const choice = answer.optionId;
      if (!choice || !entry.approval.options.some((o) => o.id === choice)) {
        throw new UserFacingError('Pick one of the offered options.', 400);
      }
      await this.answerRequest(entry, { choice });
      this.removeBySrq(entry.srq);
      return;
    }

    const question = entry.question!;
    const value = clarifyAnswer(question, answer);
    if (value === null) throw new UserFacingError('Choose an option or type an answer.', 400);

    if (entry.batch && question.qid) {
      entry.batch.answers[question.qid] = value;
      entry.batch.remaining.delete(question.qid);
      if (entry.batch.remaining.size > 0) {
        this.removePending(approvalId);
        return;
      }
      await this.answerRequest(entry, { answers: entry.batch.answers });
    } else {
      await this.answerRequest(entry, { answer: value });
    }
    this.removeBySrq(entry.srq);
  }

  /**
   * Answer a Hermes request. For a `sensitive` answer (a password or code),
   * Hermes' error text is neither shown nor logged, in case it quotes the answer.
   */
  private async answerRequest(entry: PendingRequest, result: Record<string, unknown>, sensitive = false): Promise<void> {
    checkDeviceSignal();
    if (entry.generation !== null && this.gateway.respond(entry.srq, result, entry.generation)) return;
    this.requireReady();
    let reply: { status?: string };
    try {
      reply = await this.call<{ status?: string }>('request.answer', { id: entry.srq, result }, 30_000);
    } catch (err) {
      checkDeviceSignal();
      if (!sensitive) throw this.userError(err);
      const unreachable = err instanceof RpcError && (err.code === -1 || err.code === -2);
      throw new UserFacingError(
        unreachable ? "Couldn't reach Hermes. Try again in a moment." : "Hermes didn't take the answer. Try again, or answer on your PC.",
      );
    }
    if (reply.status === 'expired') {
      this.removeBySrq(entry.srq);
      throw new UserFacingError('That request already expired.', 410);
    }
  }

  async setCredentials(username: string, password: string): Promise<SourceStatus> {
    const now = Date.now();
    this.credentialAttempts = this.credentialAttempts.filter((t) => now - t < 60_000);
    if (this.credentialAttempts.length >= MAX_CREDENTIAL_ATTEMPTS_PER_MINUTE) {
      throw new UserFacingError('Too many attempts. Wait a minute and try again.', 429);
    }
    this.credentialAttempts.push(now);

    // Verify before saving so a typo never replaces working credentials.
    const probe = new HermesAuth(this.baseUrl, () => null);
    try {
      await probe.login({ username, password });
    } catch (err) {
      if (err instanceof HermesAuthError) {
        throw new UserFacingError(err.message, err.kind === 'bad_credentials' ? 400 : 502);
      }
      throw err;
    }
    this.secrets.writeHermes({ username, password });
    // The saved configuration owns the shared gateway and timers, not the device
    // that saved it. User actions continue to carry their own device signal.
    withDeviceSignal(undefined, () => {
      this.auth.reset();
      this.statusValue = { source: 'hermes', state: 'disconnected' };
      this.gateway.stop();
      this.start();
    });
    return this.statusValue;
  }

  async clearCredentials(): Promise<SourceStatus> {
    this.secrets.clearHermes();
    this.auth.reset();
    this.gateway.stop();
    this.attachmentGeneration++;
    this.runtimeByStored.clear();
    this.storedByRuntime.clear();
    for (const id of [...this.pending.keys()]) this.removePending(id);
    this.rows.clear();
    this.listCache = undefined;
    this.setStatus('needs_credentials', 'Sign in with your Hermes dashboard username and password.');
    return this.statusValue;
  }

  // ---- gateway traffic ------------------------------------------------------

  /** A resume reply and its next frames can arrive before the awaiting caller binds. */
  private bufferAttachmentFrame(runtime: string, frame: AttachmentFrame): void {
    if (!this.attaching.size) return;
    const frames = this.attachmentFrames.get(runtime) ?? [];
    frames.push(frame);
    this.attachmentFrames.set(runtime, frames);
  }

  /** `generation`: the connection a live request arrived on; null for one restored from a snapshot. */
  private onRequest(request: Pick<ServerRequest, 'id' | 'method' | 'params'>, generation: number | null): void {
    const runtime = String(request.params.session_id ?? '');
    const stored = this.storedByRuntime.get(runtime);
    if (!stored) {
      this.bufferAttachmentFrame(runtime, { request, generation });
      return;
    }
    this.noteActivity(stored);

    if (request.method === 'approval') {
      const existing = this.pending.get(request.id);
      if (existing) {
        if (generation !== null) existing.generation = generation;
        return;
      }
      this.addPending({
        approval: permissionApproval(request.id, stored, request.params, Date.now()),
        srq: request.id,
        method: 'approval',
        generation,
      });
      return;
    }

    if (request.method === 'clarify') {
      const questions = clarifyQuestions(request.params);
      if (questions.length === 0) return;
      const first = questions[0]!;
      if (questions.length === 1 && first.qid === null) {
        const existingQuestion = this.pending.get(request.id);
        if (existingQuestion) {
          if (generation !== null) existingQuestion.generation = generation;
          return;
        }
        this.addPending({
          approval: questionApproval(request.id, stored, first, Date.now()),
          srq: request.id,
          method: 'clarify',
          generation,
          question: first,
        });
        return;
      }
      const locked = (request.params.answers ?? {}) as Record<string, string>;
      const batch: ClarifyBatch = {
        srq: request.id,
        answers: { ...locked },
        remaining: new Set(questions.map((q) => q.qid!)),
      };
      const total = questions.length + Object.keys(locked).length;
      questions.forEach((q, i) => {
        const id = `${request.id}.${q.qid}`;
        const existingPart = this.pending.get(id);
        if (existingPart) {
          if (generation !== null) existingPart.generation = generation;
          return;
        }
        const progress = total > 1 ? `Question ${Object.keys(locked).length + i + 1} of ${total}` : undefined;
        this.addPending({
          approval: questionApproval(id, stored, q, Date.now() + i, progress),
          srq: request.id,
          method: 'clarify',
          generation,
          question: q,
          batch,
        });
      });
      return;
    }

    if (PASSWORD_REQUESTS.has(request.method)) {
      const existing = this.pending.get(request.id);
      if (existing) {
        if (generation !== null) existing.generation = generation;
        return;
      }
      const approval = this.options.secretPrompts
        ? secretApproval(request.id, stored, request.method, request.params, Date.now())
        : null;
      if (approval) {
        this.addPending({ approval, srq: request.id, method: 'value', generation });
        return;
      }
      this.publishItems(stored, [
        {
          kind: 'notice',
          id: `req-${request.id}`,
          level: 'info',
          text: 'Hermes is asking for a password or secret. For safety, answer it in the Hermes desktop app or terminal.',
        },
      ]);
    }
    // Desktop-only surfaces (preview.*, window.read, tour…) are left for the desktop app.
  }

  /** Hermes continues this chat under a new stored id (context compression); follow it. */
  private moveConversation(from: string, to: string, runtime: string): void {
    this.chatIdentity.record(from, to);
    this.noteActivity(from);
    this.noteActivity(to);
    this.runtimeByStored.delete(from);
    this.bind(to, runtime);

    const turn = this.turns.get(from);
    if (turn) this.turns.set(to, turn);
    this.turns.delete(from);
    const active = this.activeByStored.get(from);
    if (active) this.activeByStored.set(to, active);
    this.activeByStored.delete(from);
    const commands = this.commandItems.get(from);
    if (commands) this.commandItems.set(to, commands);
    this.commandItems.delete(from);
    const settings = this.settings.get(from);
    if (settings) this.settings.set(to, settings);
    const startedBy = this.startedByOf(from);
    if (startedBy) {
      this.startedBy.set(to, startedBy);
      this.options.lineage?.setStartedBy(`hermes:${to}`, startedBy);
    }
    if (this.watched.delete(from)) this.watched.add(to);
    const row = this.rows.get(from);
    // The title belonged to the old session; the list refresh brings the new one's.
    if (row && !this.rows.has(to)) this.rows.set(to, { ...row, id: to, title: null });

    for (const entry of this.pending.values()) {
      if (entry.approval.conversationId !== from) continue;
      this.hub.publish({ type: 'approval_removed', source: 'hermes', conversationId: from, approvalId: entry.approval.id });
      entry.approval = { ...entry.approval, conversationId: to };
      this.hub.publish({ type: 'approval_upsert', approval: entry.approval });
    }
    this.listCache = undefined;
    this.hub.publish({ type: 'conversation_moved', source: 'hermes', from, to });
    this.publishSummary(to);
    this.publishSummary(from);
    this.scheduleListRefresh();
  }

  private addPending(entry: PendingRequest): void {
    this.pending.set(entry.approval.id, entry);
    this.hub.publish({ type: 'approval_upsert', approval: entry.approval });
    this.publishSummary(entry.approval.conversationId);
  }

  private removePending(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.hub.publish({
      type: 'approval_removed',
      source: 'hermes',
      conversationId: entry.approval.conversationId,
      approvalId: id,
    });
    this.publishSummary(entry.approval.conversationId);
  }

  private removeBySrq(srq: string): void {
    for (const [id, entry] of [...this.pending]) if (entry.srq === srq) this.removePending(id);
  }

  private onEvent(event: GatewayEvent): void {
    const payload = (event.payload ?? {}) as Record<string, unknown>;

    if (!event.session_id) {
      if (event.type === 'sessions.changed') {
        this.subagentRows = undefined;
        this.scheduleListRefresh();
      }
      // A cron job was claimed, finished, added or changed: open Scheduled-jobs pages refetch.
      if (event.type === 'cron.changed') this.hub.publish({ type: 'schedules_changed' });
      return;
    }
    let stored =
      this.storedByRuntime.get(event.session_id) ??
      (event.type === 'session.title' ? str(payload.session_id) : undefined);
    if (!stored) {
      this.bufferAttachmentFrame(event.session_id, { event });
      return;
    }

    // After compressing context, Hermes continues the chat under a new stored id.
    const continuation = event.type === 'session.info' ? str(payload.stored_session_id) : undefined;
    if (continuation && continuation !== stored && this.storedByRuntime.get(event.session_id) === stored) {
      try {
        this.moveConversation(stored, continuation, event.session_id);
      } catch (err) {
        this.log.warn({ err: err instanceof Error ? err.message : String(err) }, "couldn't persist Hermes chat continuation");
        return;
      }
      stored = continuation;
    }
    this.noteActivity(stored);

    const text = typeof payload.text === 'string' ? payload.text : '';

    switch (event.type) {
      case 'message.start':
        this.startTurn(stored);
        this.activeByStored.set(stored, 'working');
        this.publishSummary(stored);
        return;
      case 'message.delta':
        if (text) this.appendAssistant(stored, text);
        return;
      case 'reasoning.delta':
        if (text) this.appendReasoning(stored, text);
        return;
      case 'reasoning.available': {
        const turn = this.turnFor(stored);
        if (!turn.reasoningId && text) this.appendReasoning(stored, text);
        return;
      }
      case 'message.interim': {
        const turn = this.turnFor(stored);
        if (payload.already_streamed !== true && text) {
          turn.assistantId ??= this.itemId(turn);
          turn.assistantText = text;
          turn.anyAssistant = true;
        }
        this.sealText(stored);
        return;
      }
      case 'tool.start': {
        this.sealText(stored);
        const args = payload.args ?? payload.args_text;
        const summary = str(payload.context) ? oneLine(String(payload.context), 120) : summarizeArgs(args);
        this.publishItems(stored, [
          {
            kind: 'tool',
            id: `t${String(payload.tool_id ?? `${this.nonce}-${Date.now()}`)}`,
            name: str(payload.name) ?? 'tool',
            ...(summary ? { summary } : {}),
            status: 'running',
            ...(args !== undefined ? { input: clip(stripDataUrls(pretty(args))) } : {}),
          },
        ]);
        return;
      }
      case 'tool.complete': {
        // A skill was created or changed: the "/" menu should show it.
        if (payload.name === 'skill_manage') this.catalogs.clear();
        const summary = str(payload.summary) ?? summarizeArgs(payload.args);
        this.publishItems(stored, [
          {
            kind: 'tool',
            id: `t${String(payload.tool_id ?? `${this.nonce}-${Date.now()}`)}`,
            name: str(payload.name) ?? 'tool',
            ...(summary ? { summary: oneLine(summary, 120) } : {}),
            status: toolResultStatus(payload.result),
            ...(payload.args !== undefined ? { input: clip(stripDataUrls(pretty(payload.args))) } : {}),
            output: formatToolResult(payload.result),
          },
        ]);
        return;
      }
      case 'message.complete':
        if (payload.usage) this.noteSettings(stored, { usage: payload.usage });
        this.completeTurn(stored, payload);
        this.scheduleActiveCheck();
        return;
      case 'session.usage':
        this.noteSettings(stored, { usage: payload.usage });
        return;
      case 'session.info': {
        this.noteSettings(stored, payload);
        if (typeof payload.running === 'boolean') {
          this.activeByStored.set(stored, payload.running ? 'working' : 'idle');
          if (!payload.running) {
            this.turns.delete(stored);
            this.scheduleActiveCheck();
          }
        }
        const title = str(payload.title);
        const row = this.rows.get(stored);
        if (title && row) row.title = title;
        this.publishSummary(stored);
        return;
      }
      case 'session.title': {
        const title = str(payload.title);
        const row = this.rows.get(stored) ?? { id: stored };
        if (title) row.title = title;
        this.rows.set(stored, row);
        this.publishSummary(stored);
        return;
      }
      case 'request.cancel': {
        const id = str(payload.id);
        if (id) this.removeBySrq(id);
        return;
      }
      case 'status.update':
        // Hermes re-running a turn it lost. `kind: 'process'` is shared with background-process
        // notices, so only the text tells this one apart.
        if (payload.kind === 'process' && /resum/i.test(text) && /interrupt/i.test(text)) this.noteRerun(stored);
        return;
      case 'subagent.start':
      case 'subagent.complete':
        // A delegate_task run in this chat started or finished: list it under the chat.
        this.subagentRows = undefined;
        this.scheduleListRefresh();
        return;
      case 'session.reclaimed':
        this.unbind(stored);
        this.options.background.run(() => {
          if (this.watched.has(stored)) void this.attachIfLive(stored).catch(() => {});
        });
        return;
      case 'error':
        this.publishItems(stored, [
          { kind: 'notice', id: `err-${this.nonce}-${Date.now()}`, level: 'error', text: str(payload.message) ?? 'Hermes reported an error.' },
        ]);
        return;
      default:
        return;
    }
  }

  // ---- live turn assembly ---------------------------------------------------

  private startTurn(stored: string): LiveTurn {
    const previous = this.turns.get(stored);
    const turn: LiveTurn = {
      counter: (previous?.counter ?? 0) + 1,
      segment: 0,
      assistantText: '',
      reasoningText: '',
      anyAssistant: false,
    };
    this.turns.set(stored, turn);
    return turn;
  }

  private turnFor(stored: string): LiveTurn {
    return this.turns.get(stored) ?? this.startTurn(stored);
  }

  private itemId(turn: LiveTurn): string {
    return `live-${this.nonce}-${turn.counter}-${turn.segment++}`;
  }

  private appendAssistant(stored: string, text: string): void {
    const turn = this.turnFor(stored);
    if (turn.reasoningId) this.sealReasoning(stored, turn);
    turn.anyAssistant = true;
    if (!turn.assistantId) {
      turn.assistantId = this.itemId(turn);
      turn.assistantText = text;
      this.publishItems(stored, [{ kind: 'assistant', id: turn.assistantId, text, streaming: true }]);
      return;
    }
    turn.assistantText += text;
    this.hub.publish({ type: 'text_delta', source: 'hermes', conversationId: stored, itemId: turn.assistantId, delta: text });
  }

  private appendReasoning(stored: string, text: string): void {
    const turn = this.turnFor(stored);
    if (!turn.reasoningId) {
      turn.reasoningId = this.itemId(turn);
      turn.reasoningText = text;
      this.publishItems(stored, [{ kind: 'reasoning', id: turn.reasoningId, text, streaming: true }]);
      return;
    }
    turn.reasoningText += text;
    this.hub.publish({ type: 'text_delta', source: 'hermes', conversationId: stored, itemId: turn.reasoningId, delta: text });
  }

  private sealReasoning(stored: string, turn: LiveTurn): void {
    if (!turn.reasoningId) return;
    this.publishItems(stored, [{ kind: 'reasoning', id: turn.reasoningId, text: turn.reasoningText }]);
    turn.reasoningId = undefined;
    turn.reasoningText = '';
  }

  private sealText(stored: string): void {
    const turn = this.turns.get(stored);
    if (!turn) return;
    this.sealReasoning(stored, turn);
    if (turn.assistantId) {
      this.publishItems(stored, [{ kind: 'assistant', id: turn.assistantId, text: turn.assistantText }]);
      turn.assistantId = undefined;
      turn.assistantText = '';
    }
  }

  private completeTurn(stored: string, payload: Record<string, unknown>): void {
    const turn = this.turnFor(stored);
    const finalText = typeof payload.text === 'string' ? payload.text : undefined;
    this.sealReasoning(stored, turn);
    if (turn.assistantId) {
      this.publishItems(stored, [
        { kind: 'assistant', id: turn.assistantId, text: finalText?.trim() ? finalText : turn.assistantText },
      ]);
    } else if (!turn.anyAssistant && finalText?.trim()) {
      this.publishItems(stored, [{ kind: 'assistant', id: this.itemId(turn), text: finalText }]);
    }
    const outcome = payload.status;
    if (outcome === 'error') {
      this.publishItems(stored, [
        { kind: 'notice', id: this.itemId(turn), level: 'error', text: str(payload.error) ?? 'Hermes ran into an error.' },
      ]);
    } else if (outcome === 'interrupted') {
      this.publishItems(stored, [{ kind: 'notice', id: this.itemId(turn), level: 'info', text: 'Stopped' }]);
    }
    this.turns.delete(stored);
    this.activeByStored.set(stored, 'idle');
    const row = this.rows.get(stored);
    if (row) row.last_active = Date.now() / 1000;
    this.publishSummary(stored);
    this.scheduleListRefresh(1500);
  }

  private publishItems(stored: string, items: TimelineItem[]): void {
    this.hub.publish({ type: 'items_upsert', source: 'hermes', conversationId: stored, items });
  }

  // ---- errors ---------------------------------------------------------------

  private requireCredentials(): void {
    if (this.statusValue.state === 'needs_credentials') {
      throw new UserFacingError('Sign in to Hermes in Settings first.', 409);
    }
  }

  /** All RPC actions, including attachment uploads and command retries, share the request signal. */
  private call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000, signal = deviceSignal()): Promise<T> {
    checkDeviceSignal(signal);
    return this.gateway.call<T>(method, params, timeoutMs, signal);
  }

  private requireReady(): void {
    this.requireCredentials();
    if (this.gateway.state !== 'ready') {
      throw new UserFacingError('Hermes is reconnecting. Try again in a moment.', 503);
    }
  }

  private userError(err: unknown): UserFacingError {
    checkDeviceSignal();
    if (err instanceof UserFacingError) return err;
    if (transientFailure(err)) return new UserFacingError("Couldn't reach Hermes. Try again in a moment.", 503);
    if (err instanceof HermesAuthError) return new UserFacingError(err.message, err.status ?? (err.kind === 'unavailable' ? 503 : 502));
    if (err instanceof RpcError) {
      const messages: Record<number, string> = {
        4001: 'This Hermes chat was closed. Reopen it and try again.',
        4007: "Hermes couldn't find this chat.",
        4009: 'Hermes is busy with this chat. Try again shortly.',
        4090: 'Hermes has too many active chats right now.',
        4130: 'This chat is too large to open here.',
        5035: 'Hermes is restarting. Try again in a moment.',
      };
      const missing = err.code === 4007 || /session not found|stored (?:chat|session).*not found/i.test(err.message);
      const unavailable = err.code === -1 || err.code === -2 || err.code === 5035;
      return new UserFacingError(messages[err.code] ?? `Hermes: ${err.message}`, missing ? 404 : unavailable ? 503 : 502);
    }
    this.log.error({ err: String(err) }, 'unexpected hermes error');
    return new UserFacingError('Something went wrong talking to Hermes.');
  }
}
