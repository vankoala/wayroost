import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPaseoApi } from '@getpaseo/client';
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
  FolderStatus,
  PaseoOptions,
  SlashCommand,
  SourceState,
  SourceStatus,
  ThreadActionResult,
  TimelineItem,
} from '../../../shared/protocol.js';
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
  type PaseoQuestion,
  type ProviderCatalog,
  type ProviderSubagent,
} from './normalize.js';

// Talks to the local Paseo daemon with the same 0.5.1 client the Paseo CLI uses.

/** Must be >= 0.1.45 or the daemon hides custom providers such as hermes and pi. */
const APP_VERSION = '0.5.1';
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
  private statusValue: SourceStatus = { source: 'paseo', state: 'connecting' };
  private readonly agents = new Map<string, AgentSnapshotPayload>();
  private readonly placements = new Map<string, ProjectPlacementPayload | null>();
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly mirrors = new Map<string, AgentTimelineMirror>();
  private readonly watched = new Set<string>();
  private readonly lastPublished = new Map<string, string>();
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
  ) {}

  private lineage: Lineage | undefined;

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
    this.client = client;
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
      client.on('agent_stream', safely((m) => this.mirrors.get(m.payload.agentId)?.handleLive(m.payload))),
      client.on('agent_permission_request', safely((m) => this.addPermission(m.payload.agentId, m.payload.request))),
      client.on('agent_permission_resolved', safely((m) => this.removePermission(m.payload.requestId))),
      client.on('agent.provider_subagents.update', safely((m) => this.onSubagentUpdate(m.payload))),
    );
    client.connect().catch((err) => this.log.warn({ err: message(err) }, 'paseo connect failed'));
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    void this.client?.close().catch(() => {});
    this.client = undefined;
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
    if (state.status === 'connected' && previous !== 'connected') {
      this.refusedReason = undefined;
      void this.bootstrap();
    } else if (state.status === 'connecting' && this.statusValue.state !== 'connected') {
      this.setStatus('connecting');
    } else if (state.status === 'disconnected') {
      // The daemon closes with "Password required" / "Incorrect password" (paseo daemon set-password).
      const refused = state.reason && /password/i.test(state.reason) ? state.reason : undefined;
      if (refused && refused !== this.refusedReason) {
        this.log.warn({ reason: refused, credential: readPaseoPassword() ? 'set' : 'missing' }, 'Paseo refused the connection');
      }
      this.refusedReason = refused;
      this.setStatus('disconnected', refused ? `Paseo refused Signalbox: ${refused.toLowerCase()} (credential paseo-password)` : 'Reconnecting to Paseo…');
    }
  }

  /** Runs on every (re)connect: the daemon forgets our subscriptions when the socket drops. */
  private async bootstrap(): Promise<void> {
    try {
      const entries = await this.listAgentsAndSubscribe();
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
        mirror.catchUp().catch((err) => this.log.warn({ err: message(err) }, 'paseo catch-up failed'));
      }
    } catch (err) {
      this.log.warn({ err: message(err) }, 'paseo bootstrap failed');
      this.setStatus('error', "Couldn't load Paseo agents.");
    }
  }

  private async listAgentsAndSubscribe(): Promise<FetchAgentsEntry[]> {
    const client = this.rawClient();
    const entries: FetchAgentsEntry[] = [];
    let cursor: string | undefined;
    let first = true;
    do {
      const page = await client.fetchAgents({
        scope: 'active',
        filter: { includeArchived: false },
        sort: [{ key: 'updated_at', direction: 'desc' }],
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
        ...(first ? { subscribe: { subscriptionId: 'signalbox-agents' } } : {}),
      });
      entries.push(...page.entries);
      cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
      first = false;
    } while (cursor);
    return entries;
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
    this.mirrors.delete(agentId);
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
    if (!client || !SUBAGENT_PROVIDERS.has(agent.provider) || !agentLoaded(agent)) return;
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

  async getConversation(agentId: string): Promise<ConversationDetail> {
    if (isRunRowId(agentId)) return this.runDetail(agentId);
    if (isSubagentRowId(agentId)) return this.subagentDetail(agentId);
    const client = this.requireClient();
    if (!this.agents.has(agentId)) {
      const found = await client.fetchAgent({ agentId }).catch(() => null);
      if (!found) throw new UserFacingError('That Paseo agent no longer exists.', 404);
      this.keepAgent(found.agent);
      this.placements.set(found.agent.id, found.project ?? null);
    }
    let mirror = this.mirrors.get(agentId);
    if (!mirror) {
      mirror = new AgentTimelineMirror(client, agentId, this.sinkFor(agentId));
      this.mirrors.set(agentId, mirror);
      this.evictMirrors();
    }
    mirror.lastUsed = Date.now();
    if (!mirror.loaded) {
      let live: AgentSnapshotPayload | null;
      try {
        live = await mirror.loadTail();
      } catch (err) {
        this.mirrors.delete(agentId);
        throw new UserFacingError(`Couldn't open this agent: ${message(err)}`);
      }
      // Opening the timeline made Paseo load the agent; replace a snapshot taken from storage.
      const known = this.agents.get(agentId);
      if (live && known && !agentLoaded(known)) {
        this.keepAgent(live);
        this.publishSummary(agentId);
      }
    }
    return {
      conversation: this.summaryFor(agentId),
      items: this.toItems(mirror.rows),
      approvals: this.approvalsFor(agentId),
    };
  }

  setWatching(agentId: string, watching: boolean): void {
    if (watching) this.watched.add(agentId);
    else this.watched.delete(agentId);
    const mirror = this.mirrors.get(agentId);
    if (mirror) mirror.lastUsed = Date.now();
  }

  private evictMirrors(): void {
    if (this.mirrors.size <= MAX_MIRRORS) return;
    const idle = [...this.mirrors.values()]
      .filter((m) => !this.watched.has(m.agentId))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const mirror of idle.slice(0, this.mirrors.size - MAX_MIRRORS)) this.mirrors.delete(mirror.agentId);
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
      failure: (err) => this.log.warn({ err: message(err), agentId }, 'paseo timeline sync failed'),
    };
  }

  // ---- actions --------------------------------------------------------------

  async sendMessage(agentId: string, text: string, attachments: Attachment[] = []): Promise<void> {
    this.refuseSubagent(agentId);
    const client = this.requireClient();
    const files = await this.prepareFiles(client, attachments);
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

  async listCommands(agentId: string): Promise<SlashCommand[]> {
    this.refuseSubagent(agentId);
    const client = this.requireClient();
    const hit = this.commandLists.get(agentId);
    if (hit && Date.now() - hit.at < COMMANDS_TTL_MS) return hit.commands;
    // Asking a stored agent for its commands makes Paseo resume it; only ask agents that are up.
    const agent = this.agents.get(agentId);
    if (!agent || !agentLoaded(agent)) return [];
    const reply = await client.listCommands(agentId).catch((err) => {
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
      throw new UserFacingError(`Paseo: ${message(err)}`);
    }
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
    if (file.kind !== 'image') throw new UserFacingError("That file isn't an image Signalbox can show.", 415);
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
      const ready = async () => createPaseoApi(client).providers.waitForReady({ cwd: agent.cwd, timeoutMs: CATALOG_WAIT_MS });
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
    const snapshot = await (async () => createPaseoApi(client).providers.waitForReady({ timeoutMs: 20_000 }))().catch(
      () => client.getProvidersSnapshot(),
    );
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
        throw new UserFacingError("That mode turns off every safeguard, so it can't be started from Signalbox.", 400);
      }
      actsWithoutAsking = tier === 'auto';
    }
    if (actsWithoutAsking && input.acknowledgeAutoApprove !== true) {
      throw new UserFacingError('This agent will act without asking you first. Confirm to launch it.', 400);
    }

    const workspace = this.workspaces.find((w) => (w.workspaceDirectory ?? w.projectRootPath) === input.cwd);
    const attachments = input.attachments ?? [];
    const files = await this.prepareFiles(client, attachments);
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
      throw new UserFacingError(`Paseo: ${message(err)}`);
    }
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
  async archiveThreads(ids: string[]): Promise<ThreadActionResult> {
    const client = this.requireClient();
    // Paseo takes an agent's delegated children along; archive those first.
    return eachThread('paseo', this.childrenFirst(ids), async (id) => {
      await client.archiveAgent(id);
      this.forgetAgent(id);
    });
  }

  /** Paseo un-archives an agent when it reloads it from disk. */
  async restoreThreads(ids: string[]): Promise<ThreadActionResult> {
    const client = this.requireClient();
    return eachThread('paseo', ids, async (id) => {
      await client.refreshAgent(id);
      // Normally Paseo's own update brings it back; don't wait for that.
      const found = await client.fetchAgent({ agentId: id }).catch(() => null);
      if (found && !found.agent.archivedAt) {
        this.keepAgent(found.agent);
        this.placements.set(id, found.project ?? null);
        this.publishSummary(id);
      }
    });
  }

  async deleteThreads(ids: string[]): Promise<ThreadActionResult> {
    const client = this.requireClient();
    return eachThread('paseo', this.childrenFirst(ids), async (id) => {
      await client.deleteAgent(id);
      this.forgetAgent(id);
    });
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
    try {
      await client.patchDaemonConfig({ providers: { [id]: { enabled } } });
    } catch (err) {
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
    return this.client;
  }

  /** The client once the inbox is in sync; for user actions. */
  // ---- schedules (Settings → Scheduled jobs) -------------------------------------
  // Paseo keeps and runs its schedules; these are thin calls through the daemon client.

  private async scheduleCall<T extends { error: string | null }>(work: (c: DaemonClient) => Promise<T>): Promise<T> {
    const reply = await work(this.requireClient()).catch((err: unknown) => {
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

  private requireClient(): DaemonClient {
    if (!this.client || this.statusValue.state !== 'connected') {
      throw new UserFacingError('Paseo is reconnecting. Try again in a moment.', 503);
    }
    return this.client;
  }
}
