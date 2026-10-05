import { checkDeviceSignal, deviceSignal, deviceClient, withDeviceSignal } from '../security/device-signal.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPaseoApi, type OwnedSubscription, type PaseoApi } from '@getpaseo/client';
import {
  DaemonClient,
  type ConnectionState,
  type FetchAgentsEntry,
  type FileReadResult,
  type WebSocketLike,
} from '@getpaseo/client/internal/daemon-client';
import type {
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentProviderNotice,
} from '@getpaseo/protocol/agent-types';
import type {
  AgentAttachment,
  AgentSnapshotPayload,
  ProjectPlacementPayload,
  SessionOutboundMessage,
  WorkspaceDescriptorPayload,
} from '@getpaseo/protocol/messages';
import WebSocket from 'ws';
import type {
  Approval,
  ApprovalAnswer,
  ArchivedThread,
  AttachmentRef,
  CloudAgentId,
  CloudAgentsStatus,
  ControlChange,
  ControlChangeResponse,
  ConversationControls,
  ConversationDetail,
  ConversationSummary,
  FolderScope,
  FolderStatus,
  PaseoOptions,
  SlashCommand,
  SourceState,
  SourceStatus,
  ThreadActionResult,
  TimelineItem,
} from '../../../shared/protocol.js';
import type { PaseoConfigWriter } from '../../../shared/safety.js';
import type { Attachment } from '../attachments.js';
import { splitFolder } from '../folders.js';
import type { Logger } from '../hermes/adapter.js';
import type { EventHub } from '../hub.js';
import { MAX_MEDIA_BYTES, type MediaFile } from '../media.js';
import { UserFacingError, eachThread, type CreatePaseoAgentInput, type PaseoSource, type StartedBy } from '../sources.js';
import { homeRelative, oneLine, str } from '../text.js';
import { isRunRowId, runRowId, runSessionId, type Lineage, type RunRecord } from '../lineage.js';
import { AgentTimelineMirror, type AgentStreamEvent, type MirrorRow, type MirrorSink } from './mirror.js';
import {
  DISMISS_OPTION,
  PARENT_AGENT_LABEL,
  SUBAGENT_PROVIDERS,
  SUBAGENT_READ_ONLY,
  agentControls,
  agentLoaded,
  agentProject,
  agentSummary,
  cloudAgentList,
  imageReadRoot,
  isSubagentRowId,
  permissionResponse,
  providerLabel,
  questionAnswer,
  defaultMode,
  modeTier,
  requestApprovals,
  slashCommands,
  subagentRowId,
  subagentStartedAt,
  subagentSummary,
  timelineItem,
  workerSnapshotOf,
  type PaseoQuestion,
  type ProviderCatalog,
  type ProviderSubagent,
  type WorkerSnapshot,
} from './normalize.js';
import type { BackgroundGate } from '../background.js';
import { guardDaemonClient } from './device-client.js';

// Talks to the local Paseo daemon with the 0.9.2 client the Paseo CLI uses.

/**
 * The @getpaseo/client version Signalbox is built with, sent as the app version (a test
 * checks it against the installed package). Must be >= 0.1.45 or the daemon hides custom
 * providers such as hermes and pi.
 */
export const APP_VERSION = '0.9.2';
const MAX_MIRRORS = 12;
const COMMANDS_TTL_MS = 5 * 60_000;
const MAX_COMMAND_LISTS = 50;
/** Messages whose files are remembered; Paseo's timeline keeps only the typed text. */
const MAX_REMEMBERED_MESSAGES = 500;
/** Text files up to this size go to the agent inline; bigger ones are uploaded for it to read. */
const MAX_INLINE_TEXT_BYTES = 100 * 1024;
/** Paseo's providers snapshot (models, thinking levels, modes), per folder. */
const CATALOG_TTL_MS = 5 * 60_000;
const MAX_CATALOGS = 20;
/** How long to wait while Paseo is still asking the agent CLIs what they offer. */
const CATALOG_WAIT_MS = 10_000;
/** Agents the project bridge started, remembered (in memory) with who started them. */
const MAX_STARTED_BY = 500;
/** Provider sub-agents kept per agent (the newest), and in all. */
const MAX_SUBAGENTS_PER_AGENT = 20;
const MAX_SUBAGENTS = 200;
const SUBAGENT_LIST_TIMEOUT_MS = 15_000;

type SubagentUpdate = Extract<SessionOutboundMessage, { type: 'agent.provider_subagents.update' }>['payload'];

interface SubagentRow {
  /** The agent that runs it. */
  agentId: string;
  subagent: ProviderSubagent;
}

/** Files as `sendAgentMessage` / `createAgent` take them. */
interface PreparedFiles {
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: AgentAttachment[];
}

type ProviderEntries = Awaited<ReturnType<DaemonClient['getProvidersSnapshot']>>['entries'];

interface PendingPermission {
  agentId: string;
  request: AgentPermissionRequest;
  approvals: Approval[];
  questions: PaseoQuestion[] | null;
  answers: Record<string, string>;
}

interface ProviderEntry {
  id: string;
  label: string;
  modes: AgentMode[];
  defaultModeId?: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Why Paseo wouldn't read a file, in its own words. */
function readRefusal(err: unknown): UserFacingError {
  const text = message(err);
  if (/outside of workspace|not allowed|EACCES|EPERM|permission denied/i.test(text)) return new UserFacingError(text, 403);
  if (/ENOENT|ENOTDIR|ELOOP|no such file|not found/i.test(text)) return new UserFacingError(text, 404);
  if (/too large/i.test(text)) return new UserFacingError(text, 413);
  return new UserFacingError(`Paseo: ${text}`);
}

export type ClientFactory = (url: string, clientId: string, log: Logger) => DaemonClient;

/**
 * The Paseo daemon's password (`paseo daemon set-password`), which systemd hands Signalbox
 * (LoadCredential=paseo-password:...). None means the daemon has no password. Read when the
 * client is made, so restarting Signalbox picks up a new one. The client sends it as a bearer
 * header and as the `paseo.bearer.<password>` WebSocket subprotocol.
 */
export function readPaseoPassword(): string | undefined {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (!dir) return undefined;
  try {
    return readFileSync(join(dir, 'paseo-password'), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The password rides as a bearer token and as a WebSocket subprotocol: HTTP token characters only. */
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const createDaemonClient: ClientFactory = (url, clientId, log) => {
  let password = readPaseoPassword();
  if (password && !HTTP_TOKEN.test(password)) {
    // ws would throw on the subprotocol and the client would retry forever: say why instead.
    log.error({}, "the paseo-password credential has a character Paseo can't carry (space, comma, quote, slash); not using it");
    password = undefined;
  }
  return new DaemonClient({
    url,
    clientId,
    ...(password ? { password } : {}),
    clientType: 'cli',
    appVersion: APP_VERSION,
    connectTimeoutMs: 10_000,
    reconnect: { enabled: true, baseDelayMs: 1_500, maxDelayMs: 15_000 },
    webSocketFactory: (target, options) =>
      new WebSocket(target, options?.protocols, { headers: options?.headers }) as unknown as WebSocketLike,
    logger: { debug() {}, info() {}, warn: (o, m) => log.warn(o, m), error: (o, m) => log.error(o, m) },
  });
};

function daemonUrl(url: string): string {
  const u = new URL(url);
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
  return u.toString();
}

/** A Claude Code run as a read-only sub-agent row in its own folder. */
function runSummary(sessionId: string, run: RunRecord, status: RunRecord['status'], parent: NonNullable<ConversationSummary['parent']>): ConversationSummary {
  const task = run.task?.trim();
  const path = run.cwd?.replace(/\/+$/, '') || undefined;
  const finalLine = run.final?.trim();
  return {
    source: 'paseo',
    id: runRowId(sessionId),
    title: task ? oneLine(task, 80) : 'Claude Code run',
    subtitle: ['Claude Code · claude -p', path ? homeRelative(path) : undefined].filter(Boolean).join(' · '),
    ...(finalLine ? { preview: oneLine(finalLine, 160) } : {}),
    status: status === 'running' ? 'running' : status === 'error' ? 'error' : 'idle',
    updatedAt: run.updatedAt,
    pendingApprovals: 0,
    ...(path ? { project: { path, name: path.split('/').pop() || path } } : {}),
    agentLabel: 'Claude Code',
    parent,
    subagent: true,
  };
}

export class PaseoAdapter implements PaseoSource {
  private client: DaemonClient | undefined;
  /** One SDK API per connection; its provider subscriptions are released with it. */
  private api: PaseoApi | undefined;
  /** The agent list stream; the daemon assigns its id and forgets it when the socket drops. */
  private agentSubscription: OwnedSubscription<unknown> | undefined;
  /** Approvals, turn outcomes and sub-agent delivery; recreated on each connection. */
  private eventSubscription: OwnedSubscription<unknown> | undefined;
  private eventUnsubscribe: (() => void) | undefined;
  private connectionGeneration = 0;
  private statusValue: SourceStatus = { source: 'paseo', state: 'connecting' };
  private readonly agents = new Map<string, AgentSnapshotPayload>();
  private readonly placements = new Map<string, ProjectPlacementPayload | null>();
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly mirrors = new Map<string, AgentTimelineMirror>();
  private readonly mirrorReaders = new Map<AgentTimelineMirror, number>();
  private readonly watched = new Set<string>();
  private readonly lastPublished = new Map<string, string>();
  private readonly lastTurnOutcome = new Map<string, string>();
  private readonly labels = new Map<string, string>();
  /** clientMessageId → the files sent with that message. */
  private readonly sentFiles = new Map<string, AttachmentRef[]>();
  private readonly commandLists = new Map<string, { at: number; commands: SlashCommand[] }>();
  /** Keyed by provider and folder. */
  private readonly catalogs = new Map<string, { at: number; catalog: ProviderCatalog }>();
  /** Agent id → the chat that started it through the bridge. */
  private readonly startedBy = new Map<string, StartedBy>();
  /**
   * When Signalbox saw each agent start or stop running. Paseo's `updatedAt`
   * also moves on reloads and resumes, so it can't say which agents were active.
   * In memory only: after a restart, the last user message stands in.
   */
  private readonly lastActive = new Map<string, number>();
  /**
   * Sub-agents an agent runs (Claude Code's Task tool and the like), by row id,
   * shown as read-only rows under it while Paseo has the agent running.
   */
  private readonly subagents = new Map<string, SubagentRow>();
  private providers: ProviderEntry[] | undefined;
  private workspaces: WorkspaceDescriptorPayload[] = [];
  private listLoaded = false;
  private previousState: ConnectionState['status'] | null = null;
  private refusedReason: string | undefined;   // the last password refusal logged, so a retry loop logs once
  private unsubscribers: Array<() => void> = [];

  constructor(
    private readonly url: string,
    private readonly hub: EventHub,
    private readonly log: Logger,
    private readonly clientId: string,
    private readonly createClient: ClientFactory = createDaemonClient,
    private readonly background: BackgroundGate,
  ) {}

  private lineage: Lineage | undefined;
  private configWriter: PaseoConfigWriter | undefined;

  useConfigWriter(writer: PaseoConfigWriter | undefined): void { this.configWriter = writer; }

  /**
   * Claude Code runs agents start from a shell (`claude -p`) show here as read-only rows
   * under whatever started them, like the Task sub-agents of Paseo's own Claude agents.
   */
  useLineage(lineage: Lineage): void {
    this.lineage = lineage;
    lineage.setStartLookup('paseo', (id) => {
      const created = this.agents.get(id)?.createdAt;
      const at = created ? Date.parse(created) : Number.NaN;
      return Number.isFinite(at) ? at : undefined;
    });
    lineage.setClaudeOwner((sessionId) => {
      for (const agent of this.agents.values()) if (str(agent.persistence?.sessionId)?.trim() === sessionId) return agent.id;
      return undefined;
    });
    lineage.onChange((change) => {
      if (change.kind !== 'run') return;
      const row = this.runRow(change.sessionId);
      if (row) this.publish(row);
    });
  }

  /** Claude session ids of Paseo's own agents: a run reported for one of those is that agent itself. */
  private ownClaudeSessions(): Set<string> {
    const ids = new Set<string>();
    for (const agent of this.agents.values()) {
      const id = str(agent.persistence?.sessionId)?.trim();
      if (id) ids.add(id);
    }
    return ids;
  }

  private runRow(sessionId: string, own = this.ownClaudeSessions()): ConversationSummary | undefined {
    const run = this.lineage?.run(sessionId);
    if (!run || own.has(sessionId)) return undefined;
    // Listed once it has a task or an answer: a launch that failed before its prompt did nothing to show.
    if (!run.task?.trim() && !run.final?.trim()) return undefined;
    const parent = this.lineage!.parentOf(run.candidates, run.startedAt);
    if (!parent) return undefined;
    return runSummary(sessionId, run, this.lineage!.runStatus(run), parent);
  }

  private runRows(): ConversationSummary[] {
    if (!this.lineage) return [];
    const own = this.ownClaudeSessions();
    return this.lineage.runs().flatMap(([id]) => this.runRow(id, own) ?? []);
  }

  /** Opening a Claude run: the task it was given and its final answer, read-only. */
  private runDetail(rowId: string): ConversationDetail {
    const sessionId = runSessionId(rowId);
    const conversation = this.runRow(sessionId);
    const run = this.lineage?.run(sessionId);
    if (!conversation || !run) throw new UserFacingError('That Claude Code run is no longer listed.', 404);
    const items: ConversationDetail['items'] = [
      {
        kind: 'notice',
        id: 'run',
        level: 'info',
        text: 'A Claude Code run an agent started from its shell (claude -p). Read-only: its steps stay in Claude Code; this shows its task and final answer.',
      },
    ];
    if (run.task) items.push({ kind: 'user', id: 'task', text: run.task, at: run.startedAt });
    if (run.final) items.push({ kind: 'assistant', id: 'final', text: run.final, at: run.updatedAt });
    return { conversation, items, approvals: [] };
  }

  // ---- lifecycle ------------------------------------------------------------

  start(): void {
    if (this.client) return;
    const client = this.createClient(daemonUrl(this.url), this.clientId, this.log);
    guardDaemonClient(client);
    this.client = client;
    this.api = createPaseoApi(deviceClient(client));
    const safely =
      <T>(handler: (value: T) => void) =>
      (value: T) => {
        try {
          handler(value);
        } catch (err) {
          this.log.error({ err: message(err) }, 'paseo event handler failed');
        }
      };
    this.unsubscribers.push(
      client.subscribeConnectionStatus(safely((state: ConnectionState) => this.onConnection(state))),
      client.on('agent_update', safely((m) => this.onAgentUpdate(m.payload))),
    );
    client.connect().catch((err) => this.log.warn({ err: message(err) }, 'paseo connect failed'));
  }

  stop(): void {
    this.connectionGeneration += 1;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    for (const id of this.mirrors.keys()) this.dropMirror(id);
    this.dropAgentSubscription();
    this.dropEventSubscription();
    void this.api?.dispose().catch(() => {});
    void this.client?.close().catch(() => {});
    this.client = undefined;
    this.api = undefined;
    this.eventSubscription = undefined;
    this.previousState = null;
    this.listLoaded = false;
  }

  status(): SourceStatus {
    return this.statusValue;
  }

  private setStatus(state: SourceState, statusMessage?: string): void {
    const next: SourceStatus = { source: 'paseo', state, ...(statusMessage ? { message: statusMessage } : {}) };
    if (next.state === this.statusValue.state && next.message === this.statusValue.message) return;
    this.statusValue = next;
    this.hub.publish({ type: 'source_status', status: next });
  }

  private onConnection(state: ConnectionState): void {
    const previous = this.previousState;
    this.previousState = state.status;
    if (state.status !== previous) this.connectionGeneration += 1;
    if (state.status === 'connected' && previous !== 'connected') {
      this.refusedReason = undefined;
      void this.bootstrap();
    } else if (state.status === 'connecting' && this.statusValue.state !== 'connected') {
      this.setStatus('connecting');
    } else if (state.status === 'disconnected') {
      this.dropAgentSubscription();
      this.dropEventSubscription();
      // The daemon closes with "Password required" / "Incorrect password" (paseo daemon set-password).
      const refused = state.reason && /password/i.test(state.reason) ? state.reason : undefined;
      if (refused && refused !== this.refusedReason) {
        this.log.warn({ reason: refused, credential: readPaseoPassword() ? 'set' : 'missing' }, 'Paseo refused the connection');
      }
      this.refusedReason = refused;
      this.setStatus('disconnected', refused ? `Paseo refused Wayroost: ${refused.toLowerCase()} (credential paseo-password)` : 'Reconnecting to Paseo…');
    }
  }

  private dropEventSubscription(expected?: OwnedSubscription<unknown>): void {
    if (expected && this.eventSubscription !== expected) return;
    this.eventUnsubscribe?.();
    this.eventUnsubscribe = undefined;
    void this.eventSubscription?.release().catch(() => {});
    this.eventSubscription = undefined;
  }

  private dropAgentSubscription(expected?: OwnedSubscription<unknown>): void {
    if (expected && this.agentSubscription !== expected) return;
    void this.agentSubscription?.release().catch(() => {});
    this.agentSubscription = undefined;
  }

  private subscribeEvents(api: PaseoApi): OwnedSubscription<unknown> {
    this.dropEventSubscription();
    const subscription = api.observeEvents([
      'agent_permission_request', 'agent_permission_resolved', 'agent.provider_subagents.update', 'agent_attention_required',
    ]);
    this.eventSubscription = subscription;
    this.eventUnsubscribe = subscription.subscribe({
      snapshot() {},
      update: (m: SessionOutboundMessage) => {
        try {
          if (m.type === 'agent_permission_request') this.addPermission(m.payload.agentId, m.payload.request);
          else if (m.type === 'agent_permission_resolved') this.removePermission(m.payload.requestId);
          else if (m.type === 'agent.provider_subagents.update') this.onSubagentUpdate(m.payload);
          else if (m.type === 'agent_attention_required') this.onTurnOutcome(m.payload);
        } catch (err) {
          this.log.error({ err: message(err) }, 'paseo event handler failed');
        }
      },
      error: (err) => {
        if (this.eventSubscription !== subscription) return;
        this.dropEventSubscription(subscription);
        this.log.warn({ err: message(err) }, 'paseo event subscription failed');
        this.setStatus('error', "Couldn't subscribe to Paseo alerts and sub-agents.");
      },
    });
    return subscription;
  }

  /** Runs on every (re)connect: the daemon forgets our subscriptions when the socket drops. */
  private async bootstrap(): Promise<void> {
    const generation = this.connectionGeneration;
    try {
      if (!this.api) return;
      const subscription = this.subscribeEvents(this.api);
      await subscription.ready;
      if (generation !== this.connectionGeneration || this.eventSubscription !== subscription) return;
      const entries = await this.listAgentsAndSubscribe(generation);
      if (generation !== this.connectionGeneration || this.eventSubscription !== subscription) return;
      const ids = new Set(entries.map((e) => e.agent.id));
      for (const id of [...this.agents.keys()]) if (!ids.has(id)) this.forgetAgent(id);
      for (const { agent, project } of entries) {
        this.keepAgent(agent, false);
        this.placements.set(agent.id, project ?? null);
      }

      const live = new Set<string>();
      for (const { agent } of entries) {
        for (const request of agent.pendingPermissions) {
          live.add(request.id);
          // Rebuild question sets we had partly answered; the answers weren't sent yet.
          const existing = this.permissions.get(request.id);
          if (existing?.questions && existing.approvals.length !== existing.questions.length) {
            this.removePermission(request.id);
          }
          this.addPermission(agent.id, request);
        }
      }
      for (const id of [...this.permissions.keys()]) if (!live.has(id)) this.removePermission(id);

      this.listLoaded = true;
      this.setStatus('connected');
      for (const { agent } of entries) this.publishSummary(agent.id);
      // Sub-agents may have come and gone while the socket was down.
      for (const { agent } of entries) this.seedSubagents(agent);
      void this.loadProviders().catch(() => {});
      for (const mirror of this.mirrors.values()) {
        mirror.catchUp().catch((err) => {
          this.dropMirror(mirror.agentId, mirror);
          this.log.warn({ err: message(err) }, 'paseo catch-up failed');
        });
      }
    } catch (err) {
      if (generation !== this.connectionGeneration) return;
      this.log.warn({ err: message(err) }, 'paseo bootstrap failed');
      this.setStatus('error', "Couldn't load Paseo agents.");
    }
  }

  private async listAgentsAndSubscribe(generation: number): Promise<FetchAgentsEntry[]> {
    const client = this.rawClient();
    this.dropAgentSubscription();
    // Own the handle before ready: the SDK can restore an unfinished subscription.
    const subscription = client.observeAgents({
      scope: 'active',
      filter: { includeArchived: false },
      sort: [{ key: 'updated_at', direction: 'desc' }],
      page: { limit: 200 },
    });
    this.agentSubscription = subscription;
    const current = () => generation === this.connectionGeneration && this.agentSubscription === subscription;
    try {
      const firstPage = await subscription.ready;
      if (!current()) return [];
      const entries = [...firstPage.entries];
      let cursor = firstPage.pageInfo.hasMore ? (firstPage.pageInfo.nextCursor ?? undefined) : undefined;
      while (cursor) {
        const page = await client.fetchAgents({
          scope: 'active',
          filter: { includeArchived: false },
          sort: [{ key: 'updated_at', direction: 'desc' }],
          page: { limit: 200, cursor },
        });
        if (!current()) return [];
        entries.push(...page.entries);
        cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
      }
      return entries;
    } catch (error) {
      this.dropAgentSubscription(subscription);
      throw error;
    } finally {
      if (!current()) void subscription.release().catch(() => {});
    }
  }

  // ---- inbox ----------------------------------------------------------------

  async listConversations(): Promise<ConversationSummary[]> {
    if (!this.listLoaded) return [];
    const agents = [...this.agents.keys()].map((id) => this.summaryFor(id));
    return [...agents, ...[...this.subagents.keys()].flatMap((id) => this.subagentRow(id) ?? []), ...this.runRows()];
  }

  listApprovals(): Approval[] {
    return [...this.permissions.values()].flatMap((p) => p.approvals);
  }

  // ---- for the task log (read-only) --------------------------------------------

  /** Paseo's agent list has loaded since the last (re)connect: an agent missing from it is gone. */
  get agentsLoaded(): boolean {
    return this.listLoaded;
  }

  /** What Paseo last said about an agent; undefined for one it doesn't have (or a sub-agent or run row). */
  workerSnapshot(agentId: string): WorkerSnapshot | undefined {
    const agent = this.agents.get(agentId);
    return agent && this.liveWorkerSnapshot(agent);
  }

  workerSnapshots(): WorkerSnapshot[] {
    return this.listLoaded ? [...this.agents.values()].map((agent) => this.liveWorkerSnapshot(agent)) : [];
  }

  private liveWorkerSnapshot(agent: AgentSnapshotPayload): WorkerSnapshot {
    const pendingPermissions = [...this.permissions.values()].filter((p) => p.agentId === agent.id).length;
    return { ...workerSnapshotOf(agent), pendingPermissions };
  }

  /**
   * Ask Paseo about an agent that isn't in the list (archived ones included).
   * Null when Paseo no longer has it; throws when Paseo can't be asked.
   */
  async lookUpWorker(agentId: string): Promise<WorkerSnapshot | null> {
    const client = this.requireClient(); // throws when Paseo can't be asked
    try {
      const found = await client.fetchAgent({ agentId });
      return found ? workerSnapshotOf(found.agent) : null;
    } catch (err) {
      // The daemon answers an unknown id with "Agent not found: …", which the client throws.
      if (/agent not found/i.test(message(err))) return null;
      throw err;
    }
  }

  private approvalsFor(agentId: string): Approval[] {
    return this.listApprovals().filter((a) => a.conversationId === agentId);
  }

  private summaryFor(agentId: string): ConversationSummary {
    const agent = this.agents.get(agentId)!;
    const summary = agentSummary(
      agent,
      providerLabel(agent.provider, this.labels),
      this.approvalsFor(agentId).length,
      this.placements.get(agentId) ?? null,
      this.lastActive.get(agentId),
    );
    const startedBy = this.startedBy.get(agentId);
    if (!startedBy) return summary;
    // Agents started before the bridge labelled its children still nest, while Signalbox remembers them.
    return { ...summary, parent: summary.parent ?? { source: startedBy.source, id: startedBy.id }, startedBy };
  }

  /** Send a summary to browsers unless it's what they already have. True if it was sent. */
  private publish(conversation: ConversationSummary): boolean {
    const json = JSON.stringify(conversation);
    if (this.lastPublished.get(conversation.id) === json) return false;
    this.lastPublished.set(conversation.id, json);
    this.hub.publish({ type: 'conversation_upsert', conversation });
    return true;
  }

  private publishSummary(agentId: string): void {
    if (!this.agents.has(agentId)) return;
    if (!this.publish(this.summaryFor(agentId))) return;
    // Its sub-agents show its project.
    for (const [id, row] of this.subagents) if (row.agentId === agentId) this.publishSubagent(id);
  }

  /** Live attention outcomes distinguish completed turns from reloads and canceled turns. */
  private onTurnOutcome(outcome: Extract<SessionOutboundMessage, { type: 'agent_attention_required' }>['payload']): void {
    const { agentId, reason, timestamp } = outcome;
    if (reason === 'permission' || !this.agents.has(agentId)) return;
    const key = `${timestamp}/${reason}`;
    if (this.lastTurnOutcome.get(agentId) === key) return;
    this.lastTurnOutcome.set(agentId, key);
    this.hub.publish({ type: 'conversation_upsert', conversation: this.summaryFor(agentId),
      turnOutcome: reason === 'finished' ? 'complete' : 'error' });
  }

  /**
   * Keep an agent's latest snapshot, noting when it starts or stops running.
   * Only changes to or from a live `running` count: not reloads, resumes, closed →
   * idle, or the stale status of an agent Paseo only has stored. A run keeps the
   * time it was seen starting, so its summary stays the same while it runs.
   * Its sub-agents are asked for once Paseo has it running (unless `seed` is
   * false: the caller asks), and forgotten once it doesn't.
   */
  private keepAgent(agent: AgentSnapshotPayload, seed = true): void {
    const before = this.agents.get(agent.id);
    const running = (a: AgentSnapshotPayload) => a.status === 'running' && a.capabilities?.supportsStreaming === true;
    if (before && running(before) !== running(agent)) this.lastActive.set(agent.id, Date.now());
    this.agents.set(agent.id, agent);
    if (!agentLoaded(agent)) this.clearSubagents(agent.id);
    else if (seed && !(before && agentLoaded(before))) this.seedSubagents(agent);
  }

  private forgetAgent(agentId: string): void {
    this.clearSubagents(agentId);
    this.agents.delete(agentId);
    this.lastActive.delete(agentId);
    this.placements.delete(agentId);
    this.lastPublished.delete(agentId);
    this.lastTurnOutcome.delete(agentId);
    this.dropMirror(agentId);
    this.commandLists.delete(agentId);
    this.startedBy.delete(agentId);
    for (const [id, p] of [...this.permissions]) if (p.agentId === agentId) this.removePermission(id);
    this.hub.publish({ type: 'conversation_removed', source: 'paseo', id: agentId });
  }

  private onAgentUpdate(
    update:
      | { kind: 'upsert'; agent: AgentSnapshotPayload; project?: ProjectPlacementPayload | null }
      | { kind: 'remove'; agentId: string },
  ): void {
    if (update.kind === 'remove') {
      this.forgetAgent(update.agentId);
      return;
    }
    const { agent } = update;
    this.keepAgent(agent);
    if (update.project !== undefined) this.placements.set(agent.id, update.project);
    for (const request of agent.pendingPermissions) this.addPermission(agent.id, request);
    this.publishSummary(agent.id);
  }

  // ---- provider sub-agents ----------------------------------------------------
  // Claude Code's Task tool (and Codex, OpenCode and OMP equivalents) run
  // sub-agents inside an agent. Paseo tells every client about them as they
  // start, change and go; Signalbox lists them as read-only rows under the
  // agent that runs them. Their work shows in that agent's tool cards.

  private onSubagentUpdate(update: SubagentUpdate): void {
    if (update.kind === 'upsert') {
      const { subagent } = update;
      const parent = this.agents.get(subagent.parentAgentId);
      if (!parent || !agentLoaded(parent)) return;
      const id = subagentRowId(parent.id, subagent.id);
      this.subagents.set(id, { agentId: parent.id, subagent });
      this.trimSubagents(parent.id);
      this.publishSubagent(id);
    } else if (update.kind === 'remove') {
      this.dropSubagent(subagentRowId(update.parentAgentId, update.subagentId));
    }
    // 'timeline': what a sub-agent does; the agent's own tool card shows it.
  }

  /**
   * Ask Paseo which sub-agents an agent has, in case some started before we
   * listened. Only for agents Paseo has running, of providers that have them:
   * asking about a stored agent would make Paseo resume it.
   */
  private seedSubagents(agent: AgentSnapshotPayload): void {
    const client = this.client;
    if (this.background.role !== 'primary' || !client || !SUBAGENT_PROVIDERS.has(agent.provider) || !agentLoaded(agent)) return;
    if (client.getLastServerInfoMessage()?.features?.providerSubagents !== true) return;
    const agentId = agent.id;
    void (async () => {
      try {
        const reply = await client.listProviderSubagents(agentId, { timeout: SUBAGENT_LIST_TIMEOUT_MS });
        this.replaceSubagents(agentId, reply.subagents);
      } catch (err) {
        this.log.warn({ err: message(err), agentId }, 'paseo sub-agent list failed');
      }
    })();
  }

  /** Paseo's full list for an agent: the sub-agents it no longer has go. */
  private replaceSubagents(agentId: string, list: readonly ProviderSubagent[]): void {
    const agent = this.agents.get(agentId);
    if (!agent || !agentLoaded(agent)) return;
    const ids = list.map((subagent) => subagentRowId(agentId, subagent.id));
    for (const [id, row] of [...this.subagents]) if (row.agentId === agentId && !ids.includes(id)) this.dropSubagent(id);
    list.forEach((subagent, i) => this.subagents.set(ids[i]!, { agentId, subagent }));
    this.trimSubagents(agentId);
    for (const id of ids) this.publishSubagent(id);
  }

  /** Keep the newest sub-agents: MAX_SUBAGENTS_PER_AGENT per agent, MAX_SUBAGENTS in all. */
  private trimSubagents(agentId: string): void {
    const newestFirst = (rows: Array<[string, SubagentRow]>) =>
      rows.sort(([, a], [, b]) => subagentStartedAt(b.subagent) - subagentStartedAt(a.subagent));
    const own = newestFirst([...this.subagents].filter(([, row]) => row.agentId === agentId));
    for (const [id] of own.slice(MAX_SUBAGENTS_PER_AGENT)) this.dropSubagent(id);
    if (this.subagents.size <= MAX_SUBAGENTS) return;
    for (const [id] of newestFirst([...this.subagents]).slice(MAX_SUBAGENTS)) this.dropSubagent(id);
  }

  private dropSubagent(id: string): void {
    if (!this.subagents.delete(id)) return;
    // One trimmed as soon as it came was never shown.
    if (this.lastPublished.delete(id)) this.hub.publish({ type: 'conversation_removed', source: 'paseo', id });
  }

  private clearSubagents(agentId: string): void {
    for (const [id, row] of [...this.subagents]) if (row.agentId === agentId) this.dropSubagent(id);
  }

  private subagentRow(id: string): ConversationSummary | undefined {
    const row = this.subagents.get(id);
    const parent = row && this.agents.get(row.agentId);
    if (!row || !parent) return undefined;
    const project = agentProject(parent, this.placements.get(parent.id) ?? null);
    return subagentSummary({ id: parent.id, project, cwd: parent.cwd }, row.subagent, providerLabel(row.subagent.provider, this.labels));
  }

  private publishSubagent(id: string): void {
    const conversation = this.subagentRow(id);
    if (conversation) this.publish(conversation);
  }

  /** Opening a sub-agent: what it is and where its work shows. Nothing is fetched from Paseo. */
  private subagentDetail(id: string): ConversationDetail {
    const conversation = this.subagentRow(id);
    const agentId = this.subagents.get(id)?.agentId;
    if (!conversation || !agentId) throw new UserFacingError('That sub-agent is no longer listed.', 404);
    const parentTitle = this.summaryFor(agentId).title;
    return {
      conversation,
      items: [
        {
          kind: 'notice',
          id: 'subagent',
          level: 'info',
          text: `This is a sub-agent of “${parentTitle}”. Its work shows in the tool cards of that agent.`,
        },
      ],
      approvals: [],
    };
  }

  /** Sub-agents are run by their agent: nothing can be sent to them or changed from here. */
  private refuseSubagent(id: string): void {
    if (isSubagentRowId(id)) throw new UserFacingError(SUBAGENT_READ_ONLY, 400);
  }

  // ---- one agent ------------------------------------------------------------

  async getConversation(agentId: string, deliberateOpen = false): Promise<ConversationDetail> {
    if (isRunRowId(agentId)) return this.runDetail(agentId);
    if (isSubagentRowId(agentId)) return this.subagentDetail(agentId);
    const signal = deviceSignal();
    checkDeviceSignal(signal);
    const client = this.requireClient(signal);
    if (!this.agents.has(agentId)) {
      const found = await client.fetchAgent({ agentId }).catch(() => null);
      if (!found) throw new UserFacingError('That Paseo agent no longer exists.', 404);
      this.keepAgent(found.agent);
      this.placements.set(found.agent.id, found.project ?? null);
    }
    const activate = deliberateOpen || this.background.role === 'primary';
    if (!activate) {
      const cached = this.mirrors.get(agentId);
      if (cached) cached.lastUsed = Date.now();
      return {
        conversation: this.summaryFor(agentId), items: this.toItems(cached?.rows ?? []),
        approvals: this.approvalsFor(agentId), needsOpen: !cached?.loaded,
      };
    }
    let mirror = this.mirrors.get(agentId);
    if (!mirror) {
      checkDeviceSignal(signal);
      // The shared subscription belongs to the server; each explicit load keeps its caller's client.
      mirror = withDeviceSignal(undefined, () => new AgentTimelineMirror(this.rawClient(), agentId, this.sinkFor(agentId), this.background));
      this.mirrors.set(agentId, mirror);
    }
    this.mirrorReaders.set(mirror, (this.mirrorReaders.get(mirror) ?? 0) + 1);
    this.evictMirrors();
    mirror.lastUsed = Date.now();
    try {
      if (!mirror.loaded) {
        let live: AgentSnapshotPayload | null;
        try {
          live = await mirror.loadTail(120, client);
          checkDeviceSignal(signal);
        } catch (err) {
          // A revoked reader cannot retire a subscription another device is using.
          checkDeviceSignal(signal);
          this.dropMirror(agentId, mirror);
          throw new UserFacingError(`Couldn't open this agent: ${message(err)}`);
        }
        // Opening the timeline made Paseo load the agent; replace a snapshot taken from storage.
        const known = this.agents.get(agentId);
        if (live && known && !agentLoaded(known)) {
          this.keepAgent(live);
          this.publishSummary(agentId);
        }
      }
      if (deliberateOpen) {
        await this.listCommands(agentId, true).catch(err => {
          this.log.warn({ agentId, err: message(err) }, 'paseo command discovery failed after opening history');
        });
      }
      checkDeviceSignal(signal);
      return {
        conversation: this.summaryFor(agentId),
        ...(this.background.role === 'shadow' ? { needsOpen: !mirror.loaded } : {}),
        items: this.toItems(mirror.rows),
        approvals: this.approvalsFor(agentId),
      };
    } finally {
      const readers = this.mirrorReaders.get(mirror)! - 1;
      if (readers) this.mirrorReaders.set(mirror, readers);
      else this.mirrorReaders.delete(mirror);
      this.evictMirrors();
    }
  }

  setWatching(agentId: string, watching: boolean): void {
    if (watching) this.watched.add(agentId);
    else this.watched.delete(agentId);
    const mirror = this.mirrors.get(agentId);
    if (mirror) mirror.lastUsed = Date.now();
    this.evictMirrors();
  }

  private evictMirrors(): void {
    if (this.mirrors.size <= MAX_MIRRORS) return;
    const idle = [...this.mirrors.values()]
      .filter((m) => !this.watched.has(m.agentId) && !this.mirrorReaders.has(m))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const mirror of idle.slice(0, this.mirrors.size - MAX_MIRRORS)) this.dropMirror(mirror.agentId);
  }

  /** Remove a mirror, dropping its timeline subscription with it. */
  private dropMirror(agentId: string, expected?: AgentTimelineMirror): void {
    if (expected && this.mirrors.get(agentId) !== expected) return;
    this.mirrors.get(agentId)?.close();
    this.mirrors.delete(agentId);
  }

  private toItems(rows: readonly MirrorRow[]): TimelineItem[] {
    const items: TimelineItem[] = [];
    for (const row of rows) {
      const item = this.itemFor(row);
      if (item) items.push(item);
    }
    return items;
  }

  private itemFor(row: MirrorRow): TimelineItem | null {
    const sentAs = row.item.type === 'user_message' ? row.item.clientMessageId : undefined;
    return timelineItem(row.key, row.item, sentAs ? this.sentFiles.get(sentAs) : undefined);
  }

  private sinkFor(agentId: string): MirrorSink {
    const publish = (items: TimelineItem[]) =>
      this.hub.publish({ type: 'items_upsert', source: 'paseo', conversationId: agentId, items });
    return {
      reset: (rows) =>
        this.hub.publish({ type: 'items_replace', source: 'paseo', conversationId: agentId, items: this.toItems(rows) }),
      upsert: (row) => {
        const item = this.itemFor(row);
        if (item) publish([item]);
      },
      append: (row, delta) => {
        const item = this.itemFor(row);
        if (!item) return;
        if (item.kind === 'assistant' || item.kind === 'reasoning') {
          this.hub.publish({ type: 'text_delta', source: 'paseo', conversationId: agentId, itemId: row.key, delta });
        } else {
          publish([item]);
        }
      },
      status: (event: AgentStreamEvent) => {
        if (event.type !== 'turn_completed' && event.type !== 'turn_failed' && event.type !== 'turn_canceled') return;
        // Re-send the tail without the streaming flag so the typing cursor stops.
        const mirror = this.mirrors.get(agentId);
        if (mirror) publish(this.toItems(mirror.rows.slice(-3)));
        const id = `turn-${agentId}-${Date.now()}`;
        if (event.type === 'turn_failed') {
          publish([{ kind: 'notice', id, level: 'error', text: oneLine(String(event.error ?? 'The agent hit an error.'), 400) }]);
        } else if (event.type === 'turn_canceled') {
          publish([{ kind: 'notice', id, level: 'info', text: 'Stopped' }]);
        }
      },
      failure: (err) => {
        this.dropMirror(agentId);
        this.log.warn({ err: message(err), agentId }, 'paseo timeline sync failed');
      },
    };
  }

  // ---- actions --------------------------------------------------------------

  async sendMessage(agentId: string, text: string, attachments: Attachment[] = []): Promise<void> {
    this.refuseSubagent(agentId);
    const client = this.requireClient();
    const files = await this.prepareFiles(client, attachments);
    checkDeviceSignal();
    // Paseo's own app sends it this way too: while the agent works, a message steers
    // the running turn where the provider can; other providers stop it and start this one.
    const steer = this.agents.get(agentId)?.status === 'running';
    const messageId = randomUUID();
    this.rememberFiles(messageId, attachments);
    try {
      await client.sendAgentMessage(agentId, text, {
        messageId,
        ...(steer ? { activeTurnBehavior: 'steer' as const } : {}),
        ...files,
      });
    } catch (err) {
      this.sentFiles.delete(messageId);
      checkDeviceSignal();
      throw new UserFacingError(`Paseo: ${message(err)}`);
    }
  }

  /**
   * Images go to the agent inline, and so do small text files. PDFs and big
   * text files are uploaded to Paseo first (it keeps them in ~/.paseo/uploads),
   * and the agent is told where to read them, as Paseo's own app does.
   */
  private async prepareFiles(client: DaemonClient, attachments: readonly Attachment[]): Promise<PreparedFiles> {
    const images: Array<{ data: string; mimeType: string }> = [];
    const others: AgentAttachment[] = [];
    for (const file of attachments) {
      if (file.kind === 'image') {
        images.push({ data: file.bytes.toString('base64'), mimeType: file.mimeType });
      } else if (file.kind === 'text' && file.bytes.length <= MAX_INLINE_TEXT_BYTES) {
        // Agents see only the text of a text attachment, so it names the file itself.
        const text = `Attached file: ${file.name}\n\n${file.bytes.toString('utf8')}`;
        others.push({ type: 'text', mimeType: 'text/plain', title: file.name, text });
      } else {
        others.push(await this.upload(client, file));
      }
    }
    return { ...(images.length ? { images } : {}), ...(others.length ? { attachments: others } : {}) };
  }

  private async upload(client: DaemonClient, file: Attachment): Promise<AgentAttachment> {
    const reply = await client.uploadFile({ fileName: file.name, mimeType: file.mimeType, bytes: file.bytes }).catch((err) => {
      checkDeviceSignal();
      throw new UserFacingError(`Paseo couldn't take ${file.name}: ${message(err)}`);
    });
    if (!reply.file) throw new UserFacingError(`Paseo couldn't take ${file.name}: ${reply.error ?? 'the upload failed'}`);
    return reply.file;
  }

  /** Paseo's timeline keeps only the typed text; remember the files so the message can still show them. */
  private rememberFiles(messageId: string, attachments: readonly Attachment[]): void {
    if (!attachments.length) return;
    this.sentFiles.set(messageId, attachments.map((a) => ({ name: a.name, kind: a.kind })));
    if (this.sentFiles.size > MAX_REMEMBERED_MESSAGES) this.sentFiles.delete(this.sentFiles.keys().next().value!);
  }

  async listCommands(agentId: string, deliberate = false): Promise<SlashCommand[]> {
    this.refuseSubagent(agentId);
    const client = this.requireClient();
    const hit = this.commandLists.get(agentId);
    if (hit && Date.now() - hit.at < COMMANDS_TTL_MS) return hit.commands;
    if (!deliberate && this.background.role !== 'primary') return hit?.commands ?? [];
    // Asking a stored agent for its commands makes Paseo resume it; only ask agents that are up.
    const agent = this.agents.get(agentId);
    if (!agent || !agentLoaded(agent)) return [];
    const reply = await client.listCommands(agentId).catch((err) => {
      checkDeviceSignal();
      throw new UserFacingError(`Paseo: ${message(err)}`);
    });
    if (reply.error) {
      // Paseo's own app shows no commands then, too.
      this.log.warn({ agentId, err: reply.error }, 'paseo listCommands failed');
      return [];
    }
    const commands = slashCommands(reply.commands);
    // An agent that just started may not have announced its commands yet; ask again next time.
    if (commands.length) {
      this.commandLists.delete(agentId);
      this.commandLists.set(agentId, { at: Date.now(), commands });
      if (this.commandLists.size > MAX_COMMAND_LISTS) this.commandLists.delete(this.commandLists.keys().next().value!);
    }
    return commands;
  }

  async interrupt(agentId: string): Promise<void> {
    this.refuseSubagent(agentId);
    const client = this.requireClient();
    const agent = this.agents.get(agentId);
    if (agent && agent.status !== 'running' && agent.status !== 'initializing') return;
    try {
      await client.cancelAgent(agentId);
    } catch (err) {
      checkDeviceSignal();
      throw new UserFacingError(`Paseo: ${message(err)}`);
    }
  }

  async respondToApproval(agentId: string, approvalId: string, answer: ApprovalAnswer): Promise<void> {
    this.refuseSubagent(agentId);
    const split = approvalId.lastIndexOf('.q');
    const requestId = split > 0 ? approvalId.slice(0, split) : approvalId;
    const pending = this.permissions.get(requestId);
    if (!pending || pending.agentId !== agentId || !pending.approvals.some((a) => a.id === approvalId)) {
      throw new UserFacingError('That request is no longer waiting.', 409);
    }

    if (pending.questions) {
      const question = pending.questions[Number(approvalId.slice(split + 2))];
      if (!question) throw new UserFacingError('Unknown question.', 400);
      if (answer.optionId === DISMISS_OPTION) {
        await this.respond(pending, { behavior: 'deny', message: 'Dismissed by user' });
        return;
      }
      const value = questionAnswer(question, answer);
      if (value === null) throw new UserFacingError('Choose an option or type an answer.', 400);
      const remaining = pending.approvals.filter((a) => a.id !== approvalId);
      if (remaining.length > 0) {
        pending.answers[question.header] = value;
        pending.approvals = remaining;
        this.hub.publish({ type: 'approval_removed', source: 'paseo', conversationId: agentId, approvalId });
        this.publishSummary(agentId);
        return;
      }
      // Last question: send first; the card only goes away once Paseo has the answers.
      await this.respond(pending, {
        behavior: 'allow',
        updatedInput: { ...(pending.request.input ?? {}), answers: { ...pending.answers, [question.header]: value } },
      });
      return;
    }

    const response = answer.optionId ? permissionResponse(pending.request, answer.optionId) : null;
    if (!response) throw new UserFacingError('Pick one of the offered options.', 400);
    await this.respond(pending, response);
  }

  private async respond(pending: PendingPermission, response: AgentPermissionResponse): Promise<void> {
    const client = this.requireClient();
    try {
      await client.respondToPermissionAndWait(pending.agentId, pending.request.id, response, 15_000);
    } catch (err) {
      checkDeviceSignal();
      throw new UserFacingError(`Paseo: ${message(err)}`);
    }
    checkDeviceSignal();
    this.removePermission(pending.request.id);
  }

  private addPermission(agentId: string, request: AgentPermissionRequest): void {
    if (this.permissions.has(request.id)) return;
    const { approvals, questions } = requestApprovals(agentId, request, Date.now());
    this.permissions.set(request.id, { agentId, request, approvals, questions, answers: {} });
    for (const approval of approvals) this.hub.publish({ type: 'approval_upsert', approval });
    this.publishSummary(agentId);
  }

  private removePermission(requestId: string): void {
    const pending = this.permissions.get(requestId);
    if (!pending) return;
    this.permissions.delete(requestId);
    for (const approval of pending.approvals) {
      this.hub.publish({
        type: 'approval_removed',
        source: 'paseo',
        conversationId: pending.agentId,
        approvalId: approval.id,
      });
    }
    this.publishSummary(pending.agentId);
  }

  // ---- images an agent showed -----------------------------------------------

  /**
   * An image the agent pointed at, read by Paseo's file explorer as its own app
   * reads them. Once: after "outside of workspace" there's no second try against "/".
   * A file-explorer read, not an agent call, so it never wakes a stored agent.
   */
  async readImage(agentId: string, path: string): Promise<MediaFile> {
    const client = this.requireClient();
    const agent = this.agents.get(agentId);
    if (!agent) throw new UserFacingError('That Paseo agent no longer exists.', 404);
    let file: FileReadResult;
    try {
      file = await client.readFile(imageReadRoot(path, agent.cwd), path, undefined, MAX_MEDIA_BYTES);
    } catch (err) {
      throw readRefusal(err);
    }
    if (file.kind !== 'image') throw new UserFacingError("That file isn't an image Wayroost can show.", 415);
    return { bytes: Buffer.from(file.bytes) };
  }

  // ---- model, reasoning and mode ---------------------------------------------

  /** The pickers, from snapshots only: reading them never wakes an agent Paseo has stored. */
  async getControls(agentId: string): Promise<ConversationControls> {
    this.refuseSubagent(agentId);
    this.requireClient();
    const agent = this.agents.get(agentId);
    if (!agent) return { controls: [] };
    const catalog = await this.providerCatalog(agent).catch((err) => {
      this.log.warn({ err: message(err), agentId }, 'paseo providers snapshot failed');
      return undefined;
    });
    return agentControls(agent, catalog);
  }

  /** Change one setting, only to an offered option; modes that act on their own need an explicit OK. */
  async setControl(agentId: string, change: ControlChange): Promise<ControlChangeResponse> {
    this.refuseSubagent(agentId);
    const client = this.requireClient();
    const control = (await this.getControls(agentId)).controls.find((c) => c.id === change.control);
    const option = control?.options.find((o) => o.id === change.value);
    if (!control || !option) throw new UserFacingError('Pick one of the offered options.', 400);
    if (control.disabledReason) throw new UserFacingError(control.disabledReason, 409);
    if (option.autoApproves && change.acknowledgeAutoApprove !== true) {
      throw new UserFacingError(`In ${option.label} mode the agent acts without asking you first. Confirm to switch.`, 400);
    }
    // Paseo loads a stored agent to change it; that's fine for something you asked for.
    let notice: AgentProviderNotice | null = null;
    try {
      if (change.control === 'model') await client.setAgentModel(agentId, option.id);
      else if (change.control === 'reasoning') notice = await client.setAgentThinkingOption(agentId, option.id);
      else notice = await client.setAgentMode(agentId, option.id);
    } catch (err) {
      checkDeviceSignal();
      throw new UserFacingError(`Paseo: ${message(err)}`);
    }
    await this.refreshAgent(agentId);
    const text = str(notice?.message);
    return { ok: true, controls: await this.getControls(agentId), ...(text ? { notice: text } : {}) };
  }

  /** The agent's provider as Paseo's snapshot for the agent's folder describes it, as Paseo's app reads it. */
  private async providerCatalog(agent: AgentSnapshotPayload): Promise<ProviderCatalog | undefined> {
    const key = `${agent.provider}\n${agent.cwd}`;
    const hit = this.catalogs.get(key);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.catalog;
    const client = this.rawClient();
    const find = (entries: ProviderEntries) => entries.find((e) => e.provider === agent.provider);
    let snapshot = await client.getProvidersSnapshot({ cwd: agent.cwd });
    if (find(snapshot.entries)?.status === 'loading') {
      // Paseo is still asking the agent CLI what it offers.
      const ready = async () => this.api!.providers.waitForReady({ cwd: agent.cwd, timeoutMs: CATALOG_WAIT_MS });
      snapshot = await ready().catch(() => snapshot);
    }
    const entry = find(snapshot.entries);
    if (entry?.status !== 'ready') return undefined;
    const catalog: ProviderCatalog = { models: entry.models ?? [], modes: entry.modes ?? [] };
    this.catalogs.delete(key);
    this.catalogs.set(key, { at: Date.now(), catalog });
    if (this.catalogs.size > MAX_CATALOGS) this.catalogs.delete(this.catalogs.keys().next().value!);
    return catalog;
  }

  /** Re-read an agent after changing it, so the pickers show what Paseo applied. */
  private async refreshAgent(agentId: string): Promise<void> {
    const found = await this.rawClient()
      .fetchAgent({ agentId })
      .catch(() => null);
    if (!found || !this.agents.has(agentId)) return;
    this.keepAgent(found.agent);
    this.placements.set(agentId, found.project ?? null);
    this.publishSummary(agentId);
  }

  // ---- new agents -------------------------------------------------------------

  private async loadProviders(): Promise<ProviderEntry[]> {
    const client = this.rawClient();
    const ready = async () => this.api!.providers.waitForReady({ timeoutMs: 20_000 });
    const snapshot = await ready().catch(() => client.getProvidersSnapshot());
    const providers = snapshot.entries
      .filter((e) => e.enabled && e.status === 'ready')
      .map((e): ProviderEntry => {
        const label = e.label ?? providerLabel(e.provider);
        this.labels.set(e.provider, label);
        const defaultModeId = defaultMode(e.provider, e.modes ?? [], e.defaultModeId);
        return { id: e.provider, label, modes: e.modes ?? [], ...(defaultModeId ? { defaultModeId } : {}) };
      });
    this.providers = providers;
    for (const id of this.agents.keys()) this.publishSummary(id);
    return providers;
  }

  async options(): Promise<PaseoOptions> {
    const client = this.requireClient();
    const [providers, workspaces, projects] = await Promise.all([
      this.loadProviders(),
      client.fetchWorkspaces({ sort: [{ key: 'activity_at', direction: 'desc' }], page: { limit: 50 } }),
      client.listProjects().catch(() => ({ projects: [] })),
    ]);
    this.workspaces = workspaces.entries;

    const seen = new Set<string>();
    const folders: PaseoOptions['workspaces'] = [];
    const add = (path: string | null | undefined, label: string | null | undefined) => {
      if (!path || seen.has(path) || folders.length >= 10) return;
      seen.add(path);
      folders.push({ path, label: label || homeRelative(path) });
    };
    for (const w of workspaces.entries) add(w.workspaceDirectory ?? w.projectRootPath, w.projectDisplayName ?? w.name);
    for (const p of projects.projects) add(p.projectRootPath, p.projectDisplayName);

    return {
      providers: providers.map((p) => ({
        id: p.id,
        label: p.label,
        modes: p.modes
          .filter((m) => modeTier(p.id, m) !== 'blocked')
          .map((m) => ({
            id: m.id,
            label: m.label ?? m.id,
            ...(m.description ? { description: m.description } : {}),
            ...(modeTier(p.id, m) === 'auto' ? { autoApproves: true } : {}),
          })),
        ...(p.defaultModeId ? { defaultModeId: p.defaultModeId } : {}),
        // No modes to choose means we can't vouch that it asks (Pi never does).
        ...(p.modes.length === 0 ? { autoApproves: true } : {}),
      })),
      workspaces: folders,
    };
  }

  async createConversation(input: CreatePaseoAgentInput): Promise<string> {
    const client = this.requireClient();
    const providers = this.providers ?? (await this.loadProviders());
    const provider = providers.find((p) => p.id === input.providerId);
    if (!provider) throw new UserFacingError("That agent isn't available right now.", 400);

    let modeId: string | undefined;
    let actsWithoutAsking: boolean;
    if (provider.modes.length === 0) {
      if (input.modeId !== undefined) throw new UserFacingError('This agent has no permission modes.', 400);
      actsWithoutAsking = true;
    } else {
      // Always send an explicit, vetted mode; never fall back to the daemon's default.
      modeId = input.modeId ?? provider.defaultModeId;
      const mode = provider.modes.find((m) => m.id === modeId);
      if (!mode) throw new UserFacingError('Pick a permission mode for this agent.', 400);
      const tier = modeTier(provider.id, mode);
      if (tier === 'blocked') {
        throw new UserFacingError("That mode turns off every safeguard, so it can't be started from Wayroost.", 400);
      }
      actsWithoutAsking = tier === 'auto';
    }
    if (actsWithoutAsking && input.acknowledgeAutoApprove !== true) {
      throw new UserFacingError('This agent will act without asking you first. Confirm to launch it.', 400);
    }

    const workspace = this.workspaces.find((w) => (w.workspaceDirectory ?? w.projectRootPath) === input.cwd);
    const attachments = input.attachments ?? [];
    const files = await this.prepareFiles(client, attachments);
    checkDeviceSignal();
    const messageId = randomUUID();
    this.rememberFiles(messageId, attachments);
    let agent: AgentSnapshotPayload;
    try {
      agent = await client.createAgent({
        provider: input.providerId,
        cwd: input.cwd,
        ...(modeId ? { modeId } : {}),
        ...(input.title?.trim() ? { title: input.title.trim().slice(0, 200) } : {}),
        initialPrompt: input.text,
        clientMessageId: messageId,
        ...files,
        ...(workspace ? { workspaceId: workspace.id } : {}),
        // Bridge only: the label naming the chat that started it, so the Projects view nests it.
        ...(input.labels && Object.keys(input.labels).length ? { labels: input.labels } : {}),
        // Paseo's ACP auto-accept would skip Hermes' approval prompts; keep it off.
        ...(input.providerId === 'hermes' ? { featureValues: { auto_accept: false } } : {}),
      });
    } catch (err) {
      this.sentFiles.delete(messageId);
      checkDeviceSignal();
      throw new UserFacingError(`Paseo: ${message(err)}`);
    }
    // The daemon has likely already moved on: live updates for the new agent beat the
    // create response home, so this snapshot is stale. Take the current one.
    const current = await client.fetchAgent(agent.id).catch(() => null);
    if (current?.agent) agent = current.agent;
    if (input.startedBy) {
      this.startedBy.set(agent.id, input.startedBy);
      if (this.startedBy.size > MAX_STARTED_BY) this.startedBy.delete(this.startedBy.keys().next().value!);
    }
    this.keepAgent(agent);
    this.publishSummary(agent.id);
    return agent.id;
  }

  // ---- tidying up ----------------------------------------------------------------

  /** Archive agents in Paseo itself, so its app hides them too. */
  async archiveThreads(ids: string[], _folder?: FolderScope, signal = deviceSignal()): Promise<ThreadActionResult> {
    const client = this.requireClient(signal);
    // Paseo takes an agent's delegated children along; archive those first.
    return eachThread('paseo', this.childrenFirst(ids), async (id) => {
      await client.archiveAgent(id);
      this.forgetAgent(id);
    }, signal);
  }

  /** Paseo un-archives an agent when it reloads it from disk. */
  async restoreThreads(ids: string[], signal = deviceSignal()): Promise<ThreadActionResult> {
    const client = this.requireClient(signal);
    return eachThread('paseo', ids, async (id) => {
      await client.refreshAgent(id);
      // Normally Paseo's own update brings it back; don't wait for that.
      const found = await client.fetchAgent({ agentId: id }).catch(() => null);
      if (found && !found.agent.archivedAt) {
        this.keepAgent(found.agent);
        this.placements.set(id, found.project ?? null);
        this.publishSummary(id);
      }
    }, signal);
  }

  async deleteThreads(ids: string[], signal = deviceSignal()): Promise<ThreadActionResult> {
    const client = this.requireClient(signal);
    return eachThread('paseo', this.childrenFirst(ids), async (id) => {
      await client.deleteAgent(id);
      this.forgetAgent(id);
    }, signal);
  }

  async listArchived(limit: number): Promise<ArchivedThread[]> {
    const client = this.requireClient();
    const archived: ArchivedThread[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 10 && archived.length < limit; pages++) {
      const page = await client.fetchAgents({
        filter: { includeArchived: true },
        sort: [{ key: 'updated_at', direction: 'desc' }],
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      for (const { agent } of page.entries) {
        if (!agent.archivedAt) continue;
        archived.push({
          source: 'paseo',
          id: agent.id,
          title: agent.title?.trim() || `${providerLabel(agent.provider, this.labels)} agent`,
          updatedAt: Date.parse(agent.updatedAt) || 0,
          ...(agent.cwd ? { folder: homeRelative(agent.cwd) } : {}),
        });
      }
      cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
      if (!cursor) break;
    }
    return archived.slice(0, limit);
  }

  /** Every listed agent idle since `before` (Paseo lists them all), except sub-agents and working ones. */
  async idleThreads(before: number): Promise<string[]> {
    this.requireClient();
    return [...this.agents.keys()].filter((id) => {
      const summary = this.summaryFor(id);
      if (summary.subagent || summary.status === 'running' || summary.status === 'needs_approval') return false;
      return summary.updatedAt < before;
    });
  }

  /** Deepest first, by the parent labels among `ids`. */
  private childrenFirst(ids: string[]): string[] {
    const set = new Set(ids);
    const parentOf = (id: string) => str(this.agents.get(id)?.labels?.[PARENT_AGENT_LABEL]);
    const depth = (id: string) => {
      let d = 0;
      for (let p = parentOf(id); p && set.has(p) && d < 50; p = parentOf(p)) d += 1;
      return d;
    };
    return [...set].sort((a, b) => depth(b) - depth(a));
  }

  // ---- cloud agents ---------------------------------------------------------------

  /** Settings → Cloud agents: which agents on cloud models Paseo will start. */
  async cloudAgents(): Promise<CloudAgentsStatus> {
    const snapshot = await this.requireClient().getProvidersSnapshot();
    return { agents: cloudAgentList(snapshot.entries, this.labels) };
  }

  /**
   * Switch a cloud agent on or off in Paseo's own config. Paseo saves it and
   * then refuses to start a switched-off agent for anyone: its app, Signalbox,
   * other agents. Agents already running aren't stopped.
   */
  async setCloudAgentEnabled(id: CloudAgentId, enabled: boolean): Promise<CloudAgentsStatus> {
    const client = this.requireClient();
    if (!this.configWriter) throw new UserFacingError('The Safety helper is required to switch cloud agents safely.', 424);
    try {
      await this.configWriter.setCloudAgentEnabled(id, enabled);
    } catch (err) {
      if (err instanceof UserFacingError) throw err;
      checkDeviceSignal();
      throw new UserFacingError(`Paseo: ${message(err)}`);
    }
    this.log.info({ provider: id, enabled }, 'cloud agent switched');
    // New agents and the bridge go by the ready list; load it again next time.
    this.providers = undefined;
    // Have Paseo check the agent again, so one switched on shows whether it can run.
    await client.refreshProvidersSnapshot({ providers: [id] }).catch((err) => {
      this.log.warn({ err: message(err), provider: id }, 'paseo provider refresh failed');
    });
    return this.cloudAgents();
  }

  // ---- Folders for new chats (the daemon runs as the owner; Signalbox can't see their home) ----

  /** Whether a typed folder exists, can be created (its parent exists), or is something else. */
  /**
   * Whether a folder exists, as the daemon (running as the owner) sees it. Listing
   * the folder itself follows symlinks, like an agent starting there would.
   */
  async folderStatus(typed: string): Promise<FolderStatus> {
    if (!this.client || this.statusValue.state !== 'connected') return 'unknown';
    const { path, parent } = splitFolder(typed);
    try {
      await this.client.listDirectory(path, '.');
      return 'exists';
    } catch (err) {
      const text = message(err);
      if (/Requested path is not a directory/i.test(text)) return 'not-a-folder';
      if (/ENOTDIR/.test(text)) return 'missing-parent'; // a file on the way there
      if (!/ENOENT/.test(text)) return 'unknown';
    }
    if (path === '/') return 'unknown';
    try {
      await this.client.listDirectory(parent, '.');
      return 'missing';
    } catch (err) {
      return /ENOENT|ENOTDIR|not a directory/i.test(message(err)) ? 'missing-parent' : 'unknown';
    }
  }

  async createFolder(typed: string): Promise<string> {
    const { parent, name } = splitFolder(typed);
    const result = await this.requireClient().createProjectDirectory({ parentPath: parent, name });
    // Made in the meantime (e.g. by an agent): that's the folder the chat wanted.
    if (result.errorCode === 'directory_exists' && (await this.folderStatus(typed)) === 'exists') return splitFolder(typed).path;
    if (result.error || !result.directoryPath) {
      throw new UserFacingError(`Couldn't create the folder "${name}": ${result.error ?? 'Paseo gave no reason'}.`, 400);
    }
    this.log.info({ folder: homeRelative(result.directoryPath) }, 'paseo created a folder for a new chat');
    return result.directoryPath;
  }

  /** The client even while (re)bootstrapping; for internal use. */
  private rawClient(): DaemonClient {
    if (!this.client) throw new UserFacingError('Paseo is not connected.', 503);
    return deviceClient(this.client);
  }

  /** The client once the inbox is in sync; for user actions. */
  // ---- schedules (Settings → Scheduled jobs) -------------------------------------
  // Paseo keeps and runs its schedules; these are thin calls through the daemon client.

  private async scheduleCall<T extends { error: string | null }>(work: (c: DaemonClient) => Promise<T>): Promise<T> {
    const reply = await work(this.requireClient()).catch((err: unknown) => {
      checkDeviceSignal();
      throw new UserFacingError(`Paseo: ${message(err)}`);
    });
    if (reply.error) throw new UserFacingError(`Paseo: ${reply.error}`, /not found/i.test(reply.error) ? 404 : 400);
    return reply;
  }

  async schedulesList() {
    return (await this.scheduleCall((c) => c.scheduleList())).schedules;
  }

  async scheduleRuns(id: string) {
    return (await this.scheduleCall((c) => c.scheduleLogs({ id }))).runs;
  }

  async schedulePaused(id: string, paused: boolean): Promise<void> {
    await this.scheduleCall((c) => (paused ? c.schedulePause({ id }) : c.scheduleResume({ id })));
  }

  async scheduleRunOnce(id: string): Promise<void> {
    await this.scheduleCall((c) => c.scheduleRunOnce({ id }));
  }

  async scheduleUpdate(id: string, changes: { name?: string; prompt?: string; cron?: string }): Promise<void> {
    await this.scheduleCall((c) =>
      c.scheduleUpdate({
        id,
        ...(changes.name !== undefined ? { name: changes.name } : {}),
        ...(changes.prompt !== undefined ? { prompt: changes.prompt } : {}),
        ...(changes.cron !== undefined ? { cadence: { type: 'cron' as const, expression: changes.cron } } : {}),
      }),
    );
  }

  async scheduleDelete(id: string): Promise<void> {
    await this.scheduleCall((c) => c.scheduleDelete({ id }));
  }

  /** A Paseo agent's title, for "which agent runs this schedule". */
  agentTitle(agentId: string): string | undefined {
    const agent = this.agents.get(agentId) as { title?: unknown } | undefined;
    return typeof agent?.title === 'string' && agent.title ? agent.title : undefined;
  }

  private requireClient(signal = deviceSignal()): DaemonClient {
    if (!this.client || this.statusValue.state !== 'connected') {
      throw new UserFacingError('Paseo is reconnecting. Try again in a moment.', 503);
    }
    return deviceClient(this.client, signal);
  }
}
