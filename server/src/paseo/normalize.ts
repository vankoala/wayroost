import { createHash } from 'node:crypto';
import type { ProviderSubagentListPayload } from '@getpaseo/client/internal/daemon-client';
import type {
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentTimelineItem,
  ToolCallDetail,
} from '@getpaseo/protocol/agent-types';
import type { AgentSnapshotPayload } from '@getpaseo/protocol/messages';
import type {
  Approval,
  ApprovalAnswer,
  ApprovalOption,
  AttachmentRef,
  ConversationControl,
  ConversationControls,
  ConversationStatus,
  ConversationSummary,
  SlashCommand,
  TimelineItem,
  ToolStatus,
} from '../../../shared/protocol.js';
import { CLOUD_AGENT_IDS, type CloudAgent } from '../../../shared/protocol.js';
import { readableBridgeText } from '../bridge/envelope.js';
import { MAX_APPROVAL_DETAIL, capitalize, clip, homeRelative, oneLine, pretty, str } from '../text.js';

// Pure mappings from Paseo 0.5.1 shapes to the shared protocol.

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
  hermes: 'Hermes',
  copilot: 'Copilot',
  cursor: 'Cursor',
  gemini: 'Gemini',
};

export function providerLabel(id: string, known?: ReadonlyMap<string, string>): string {
  return known?.get(id) ?? PROVIDER_LABELS[id] ?? capitalize(id);
}

/** What Paseo's provider snapshot says about one agent CLI. */
interface ProviderSnapshotEntryLike {
  provider: string;
  status: string;
  enabled?: boolean;
  label?: string;
  error?: string;
}

const CLOUD_AGENT_STATES: ReadonlySet<string> = new Set(['ready', 'loading', 'error', 'unavailable']);

/** Settings → Cloud agents: each cloud agent Paseo knows, in a fixed order. */
export function cloudAgentList(
  entries: readonly ProviderSnapshotEntryLike[],
  known?: ReadonlyMap<string, string>,
): CloudAgent[] {
  return CLOUD_AGENT_IDS.flatMap((id): CloudAgent[] => {
    const entry = entries.find((e) => e.provider === id);
    if (!entry) return [];
    // Paseo treats a provider without the flag as on.
    const enabled = entry.enabled !== false;
    const state: CloudAgent['state'] = !enabled
      ? 'off'
      : CLOUD_AGENT_STATES.has(entry.status)
        ? (entry.status as CloudAgent['state'])
        : 'error';
    const detail = enabled && state !== 'ready' && entry.error ? oneLine(entry.error, 300) : undefined;
    return [{ id, label: entry.label ?? providerLabel(id, known), enabled, state, ...(detail ? { detail } : {}) }];
  });
}

/**
 * How much a mode keeps a human in the loop:
 * - asks:    the agent waits for your approval before risky actions (offered normally)
 * - auto:    the agent acts on its own for some or all actions (needs an explicit OK)
 * - blocked: every safeguard is off (never started from the phone)
 * Known modes come from each provider's definitions in Paseo 0.5.1.
 */
export type ModeTier = 'asks' | 'auto' | 'blocked';

const KNOWN_MODES: Record<string, Record<string, ModeTier>> = {
  claude: { default: 'asks', plan: 'asks', acceptEdits: 'auto', auto: 'auto', bypassPermissions: 'blocked' },
  codex: { auto: 'asks', 'read-only': 'asks', 'auto-review': 'auto', 'full-access': 'blocked' },
  copilot: { agent: 'asks', plan: 'asks', 'allow-all': 'blocked' },
  opencode: { plan: 'asks', build: 'auto' },
  omp: { ask: 'asks', write: 'auto', full: 'blocked', yolo: 'blocked' },
  hermes: { default: 'asks', accept_edits: 'auto', dont_ask: 'blocked' },
};

const BLOCKED_MODE = /bypass|full[-_ ]?access|allow[-_ ]?all|dont[-_ ]?ask|don'?t ask|yolo|danger|unrestricted|skip[-_ ]?permission/i;
const ASKING_MODE_ID = /^(default|ask|plan|agent|read[-_ ]?only)$/i;
const DEFAULT_PREFERENCE = ['default', 'agent', 'auto', 'ask', 'plan', 'read-only'];

export function modeTier(providerId: string, mode: Pick<AgentMode, 'id' | 'label'>): ModeTier {
  const known = KNOWN_MODES[providerId]?.[mode.id];
  if (known) return known;
  if (BLOCKED_MODE.test(`${mode.id} ${mode.label ?? ''}`)) return 'blocked';
  return ASKING_MODE_ID.test(mode.id) ? 'asks' : 'auto';
}

/** Mode to start in: the provider's preference if it asks, else the most conservative asking mode. */
export function defaultMode(providerId: string, modes: readonly AgentMode[], preferred?: string | null): string | undefined {
  const asking = modes.filter((m) => modeTier(providerId, m) === 'asks');
  if (preferred && asking.some((m) => m.id === preferred)) return preferred;
  for (const id of DEFAULT_PREFERENCE) if (asking.some((m) => m.id === id)) return id;
  return asking[0]?.id;
}

/**
 * The agent is running in Paseo right now, not just stored. Paseo's snapshots
 * of stored agents always report `supportsStreaming: false`, and a closed agent
 * keeps its capabilities but reports `closed`.
 */
export function agentLoaded(agent: Pick<AgentSnapshotPayload, 'status' | 'capabilities'>): boolean {
  return agent.capabilities?.supportsStreaming === true && agent.status !== 'closed';
}

export function agentStatus(agent: AgentSnapshotPayload, pendingApprovals: number): ConversationStatus {
  if (pendingApprovals > 0) return 'needs_approval';
  if (agent.status === 'running' || agent.status === 'initializing') return 'running';
  if (agent.status === 'error') return 'error';
  return 'idle';
}

/**
 * Paseo's own label for the agent that started this one. Paseo treats an agent
 * carrying it as delegated (no attention events, archived with its parent), so
 * it only ever names a Paseo agent.
 */
export const PARENT_AGENT_LABEL = 'paseo.parent-agent-id';
/** Signalbox's label for the Hermes chat that started an agent through the bridge. Paseo ignores it. */
export const HERMES_PARENT_LABEL = 'signalbox.parent-hermes-chat';

type Parent = NonNullable<ConversationSummary['parent']>;

/** What started an agent, from its labels: a Paseo parent first, else a Hermes chat. */
export function labelledParent(labels: Record<string, string> | undefined): Parent | undefined {
  const paseo = str(labels?.[PARENT_AGENT_LABEL])?.trim();
  if (paseo) return { source: 'paseo', id: paseo };
  const hermes = str(labels?.[HERMES_PARENT_LABEL])?.trim();
  if (hermes) return { source: 'hermes', id: hermes };
  return undefined;
}

type Placement = {
  projectName?: string | null;
  checkout?: { mainRepoRoot?: string | null; worktreeRoot?: string | null } | null;
} | null;

/** The project folder an agent works in: its git root (worktrees group with their main repository), else its folder. */
export function agentProject(agent: Pick<AgentSnapshotPayload, 'cwd'>, placement: Placement = null): { path: string; name: string } {
  const root = placement?.checkout?.mainRepoRoot ?? placement?.checkout?.worktreeRoot ?? agent.cwd;
  const path = root.replace(/\/+$/, '') || '/';
  return { path, name: str(placement?.projectName) ?? (path.split('/').pop() || path) };
}

/**
 * When the agent last really did something: its last user message (a bridge
 * delivery counts), or when Signalbox saw it start or stop running. Not Paseo's
 * `updatedAt`, which also moves when an agent is merely reloaded or resumed.
 * Without either: when it was created, else `updatedAt`.
 */
export function lastActivity(
  agent: Pick<AgentSnapshotPayload, 'lastUserMessageAt' | 'createdAt' | 'updatedAt'>,
  lastSeenActive?: number,
): number {
  const base = [agent.lastUserMessageAt, agent.createdAt, agent.updatedAt]
    .map((at) => (at ? Date.parse(at) : Number.NaN))
    .find((at) => Number.isFinite(at));
  const known = [base, lastSeenActive].filter((at): at is number => at !== undefined && Number.isFinite(at));
  return known.length ? Math.max(...known) : Date.now();
}

export function agentSummary(
  agent: AgentSnapshotPayload,
  label: string,
  pendingApprovals: number,
  placement: Placement = null,
  /** When Signalbox last saw the agent start or stop running. */
  lastSeenActive?: number,
): ConversationSummary {
  let preview: string | undefined;
  if (agent.lastError) preview = `Error: ${oneLine(agent.lastError, 120)}`;
  else if (agent.requiresAttention && agent.attentionReason === 'finished') preview = 'Finished. Tap to review';
  const parent = labelledParent(agent.labels);
  const hermes = agent.provider === 'hermes';
  // Hermes in Paseo runs an ACP session, which Hermes knows by this id (e.g. as a delegate_task parent).
  // Only the id: the rest of the persistence handle is Paseo's launch config.
  const acpSession = hermes ? str(agent.persistence?.sessionId)?.trim() : undefined;
  return {
    source: 'paseo',
    id: agent.id,
    // Paseo may title an agent from its first message: a bridge envelope reads as who it's from.
    title: str(agent.title) ? oneLine(readableBridgeText(agent.title!), 80) : 'Untitled agent',
    subtitle: `${hermes ? 'Hermes in Paseo' : label} · ${homeRelative(agent.cwd)}`,
    ...(preview ? { preview } : {}),
    status: agentStatus(agent, pendingApprovals),
    updatedAt: lastActivity(agent, lastSeenActive),
    pendingApprovals,
    project: agentProject(agent, placement),
    agentLabel: label,
    ...(parent ? { parent } : {}),
    ...(acpSession ? { aliases: [{ source: 'hermes' as const, id: acpSession }] } : {}),
    ...(hermes ? { hermesInPaseo: true } : {}),
  };
}

// ---- provider sub-agents (Claude Code's Task tool and the like) ------------------

/** One sub-agent as Paseo describes it. */
export type ProviderSubagent = ProviderSubagentListPayload['subagents'][number];

/** Providers whose agents run sub-agents Paseo tracks. ACP agents, Hermes among them, never do. */
export const SUBAGENT_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex', 'opencode', 'omp']);

export const SUBAGENT_READ_ONLY =
  "This is a sub-agent: it's read-only here. Message the agent that started it instead.";

const SAFE_ID_TAIL = /^[\w.:@+-]{1,150}$/;

/**
 * A sub-agent's conversation id: "<parent agent id>:<sub-agent id>". Paseo
 * agent ids are UUIDs, so a colon never appears in a real agent's id. A
 * sub-agent id that couldn't travel in a URL is replaced by a digest of it.
 */
export function subagentRowId(parentAgentId: string, subagentId: string): string {
  const tail = SAFE_ID_TAIL.test(subagentId) ? subagentId : `h-${createHash('sha256').update(subagentId).digest('hex').slice(0, 32)}`;
  return `${parentAgentId}:${tail}`;
}

/** The id names a sub-agent row, known or not, rather than a Paseo agent. */
export const isSubagentRowId = (id: string): boolean => id.includes(':');

/** When a sub-agent started, for keeping the newest; 0 when Paseo's times don't parse. */
export function subagentStartedAt(subagent: Pick<ProviderSubagent, 'createdAt' | 'updatedAt'>): number {
  const at = [subagent.createdAt, subagent.updatedAt].map((t) => Date.parse(t)).find((t) => Number.isFinite(t));
  return at ?? 0;
}

/** A sub-agent as a read-only row under the agent that ran it, in that agent's project. */
export function subagentSummary(
  parent: Pick<ConversationSummary, 'id' | 'project'> & { cwd?: string },
  subagent: ProviderSubagent,
  label: string,
): ConversationSummary {
  const title = str(subagent.title) ?? str(subagent.description) ?? 'Sub-agent';
  // The task it was given reads better under a title like "general-purpose".
  const description = str(subagent.description);
  const preview = description && description !== title ? oneLine(description, 160) : undefined;
  const updatedAt = [subagent.updatedAt, subagent.createdAt].map((t) => Date.parse(t)).find((t) => Number.isFinite(t));
  return {
    source: 'paseo',
    id: subagentRowId(parent.id, subagent.id),
    title: oneLine(title, 80),
    // Where it works: the folder of the agent that ran it.
    subtitle: ['Sub-agent', parent.cwd ? homeRelative(parent.cwd) : undefined, label].filter(Boolean).join(' · '),
    ...(preview ? { preview } : {}),
    status: subagent.status === 'running' ? 'running' : subagent.status === 'failed' ? 'error' : 'idle',
    updatedAt: updatedAt ?? Date.now(),
    pendingApprovals: 0,
    ...(parent.project ? { project: parent.project } : {}),
    agentLabel: label,
    parent: { source: 'paseo', id: parent.id },
    subagent: true,
  };
}

// ---- timeline ----------------------------------------------------------------

type LooseDetail = Record<string, unknown> & { type: string };

function toolSummary(name: string, detail: ToolCallDetail): string | undefined {
  const d = detail as LooseDetail;
  const pick = (...keys: string[]) => {
    for (const k of keys) if (str(d[k])) return oneLine(String(d[k]), 120);
    return undefined;
  };
  switch (d.type) {
    case 'shell':
      return pick('command');
    case 'read':
    case 'edit':
    case 'write':
      return d.filePath ? homeRelative(String(d.filePath)) : undefined;
    case 'search':
      return pick('query');
    case 'fetch':
      return pick('url');
    case 'sub_agent':
      return pick('description', 'subAgentType');
    case 'plain_text':
      return pick('label', 'text');
    case 'plan':
      return 'Plan';
    case 'worktree_setup':
      return 'Setting up worktree';
    default:
      return name ? undefined : 'tool';
  }
}

function toolIO(detail: ToolCallDetail, error: unknown): { input?: string; output?: string } {
  const d = detail as LooseDetail;
  const s = (key: string) => (typeof d[key] === 'string' ? (d[key] as string) : undefined);
  let input: string | undefined;
  let output: string | undefined;
  switch (d.type) {
    case 'shell':
      input = s('command');
      output = s('output');
      if (typeof d.exitCode === 'number' && d.exitCode !== 0) output = `${output ?? ''}\n(exit code ${d.exitCode})`.trim();
      break;
    case 'read':
      output = s('content');
      break;
    case 'edit':
      output = s('unifiedDiff') ?? (s('oldString') || s('newString') ? `- ${s('oldString') ?? ''}\n+ ${s('newString') ?? ''}` : undefined);
      break;
    case 'write':
      output = s('content');
      break;
    case 'search':
      output = s('content') ?? (Array.isArray(d.filePaths) ? (d.filePaths as unknown[]).join('\n') : undefined);
      break;
    case 'fetch':
      output = s('result');
      break;
    case 'sub_agent':
      output = s('log');
      break;
    case 'plain_text':
    case 'plan':
      output = s('text');
      break;
    case 'unknown':
      input = d.input !== undefined ? pretty(d.input) : undefined;
      output = d.output !== undefined ? pretty(d.output) : undefined;
      break;
  }
  if (error) output = `${output ? `${output}\n\n` : ''}${typeof error === 'string' ? error : pretty(error)}`;
  return {
    ...(input ? { input: clip(input) } : {}),
    ...(output ? { output: clip(output) } : {}),
  };
}

const TOOL_STATUS: Record<string, ToolStatus> = {
  running: 'running',
  completed: 'done',
  failed: 'error',
  canceled: 'error',
};

/**
 * `files`: what was attached to this message. Paseo's timeline only keeps the
 * typed text, so the caller supplies what it remembers sending.
 */
export function timelineItem(key: string, item: AgentTimelineItem, files?: readonly AttachmentRef[]): TimelineItem | null {
  switch (item.type) {
    case 'user_message':
      if (!item.text.trim() && !files?.length) return null;
      return { kind: 'user', id: key, text: item.text, ...(files?.length ? { attachments: [...files] } : {}) };
    case 'assistant_message':
      if (item.text.startsWith('[System Error]')) {
        return { kind: 'notice', id: key, level: 'error', text: item.text.replace('[System Error]', '').trim() };
      }
      return { kind: 'assistant', id: key, text: item.text };
    case 'reasoning':
      return item.text.trim() ? { kind: 'reasoning', id: key, text: item.text } : null;
    case 'tool_call': {
      const summary = toolSummary(item.name, item.detail);
      return {
        kind: 'tool',
        id: key,
        name: item.name || 'tool',
        ...(summary ? { summary } : {}),
        status: TOOL_STATUS[item.status] ?? 'done',
        ...toolIO(item.detail, item.status === 'failed' ? item.error : undefined),
      };
    }
    case 'todo': {
      const done = item.items.filter((t) => t.completed || t.status === 'completed').length;
      return {
        kind: 'tool',
        id: key,
        name: 'Todo list',
        summary: `${done} of ${item.items.length} done`,
        status: 'done',
        output: item.items
          .map((t) => `${t.completed || t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▸' : '☐'} ${t.text}`)
          .join('\n'),
      };
    }
    case 'error':
      return { kind: 'notice', id: key, level: 'error', text: item.message };
    case 'compaction':
      return {
        kind: 'notice',
        id: key,
        level: 'info',
        text: item.status === 'loading' ? 'Compacting the conversation…' : 'Conversation compacted',
      };
    default:
      return null;
  }
}

// ---- "/" commands ------------------------------------------------------------------

/** One row of Paseo's `list_commands` reply. */
export interface PaseoCommandRow {
  name: string;
  description?: string;
  argumentHint?: string;
  kind?: 'command' | 'skill';
}

/** The agent's own commands and skills as the "/" menu shows them. */
export function slashCommands(rows: readonly PaseoCommandRow[]): SlashCommand[] {
  const out: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim().replace(/^\/+/, '');
    const lower = name.toLowerCase();
    if (!name || /\s/.test(name) || seen.has(lower)) continue;
    seen.add(lower);
    const description = str(row.description) ? oneLine(row.description!, 200) : undefined;
    const args = str(row.argumentHint) ? oneLine(row.argumentHint!, 80) : undefined;
    out.push({
      name,
      kind: row.kind === 'skill' ? 'skill' : 'command',
      ...(description ? { description } : {}),
      ...(args ? { args } : {}),
    });
  }
  return out;
}

// ---- model, reasoning and mode ----------------------------------------------------

/** What Paseo's providers snapshot says about the agent's provider. */
export interface ProviderCatalog {
  models?: AgentModelDefinition[];
  modes?: AgentMode[];
}

/** Hermes-in-Paseo refuses to switch models during a turn. */
export const HERMES_BUSY_MODEL = 'Hermes can switch models between turns.';

function findModel(models: readonly AgentModelDefinition[], id: string | null | undefined): AgentModelDefinition | undefined {
  const wanted = id?.trim();
  if (!wanted) return undefined;
  return models.find((m) => m.id === wanted) ?? models.find((m) => m.aliases?.includes(wanted));
}

/** Thinking levels as Paseo's app names them: "xhigh" → "Extra high", "max_effort" → "Max effort". */
export function thinkingLabel(option: { id: string; label?: string | null }): string {
  const raw = (option.label ?? option.id).trim();
  if ([option.id, raw].some((v) => v.replace(/[\s_-]+/g, '').toLowerCase() === 'xhigh')) return 'Extra high';
  const words = raw.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1).toLowerCase() : option.id;
}

/**
 * The model, reasoning and mode pickers, as Paseo's own composer offers them,
 * from snapshots only. Modes that switch every safeguard off are never offered;
 * modes that act without asking are flagged.
 */
export function agentControls(agent: AgentSnapshotPayload, catalog?: ProviderCatalog | null): ConversationControls {
  const controls: ConversationControl[] = [];

  // The model the agent reports running, else the one it was set to.
  const models = (catalog?.models ?? []).filter((m) => m.isSelectable !== false);
  const running = findModel(models, agent.runtimeInfo?.model);
  const wanted = running?.id ?? str(agent.model) ?? str(agent.runtimeInfo?.model);
  const model = findModel(models, wanted);
  if (models.length) {
    controls.push({
      id: 'model',
      label: 'Model',
      value: model?.id ?? null,
      ...(model ? {} : { valueLabel: wanted ?? 'Default' }),
      options: models.map((m) => ({
        id: m.id,
        label: m.label || m.id,
        ...(str(m.description) ? { description: oneLine(m.description!, 160) } : {}),
      })),
      ...(agent.provider === 'hermes' && agent.status === 'running' ? { disabledReason: HERMES_BUSY_MODEL } : {}),
    });
  }

  // Thinking levels belong to the model; like Paseo's app, only offer a real choice.
  const levels = model?.thinkingOptions ?? [];
  if (levels.length > 1) {
    const set = [agent.effectiveThinkingOptionId, agent.thinkingOptionId].find((id) => id && id !== 'default');
    const currentId = set ?? model?.defaultThinkingOptionId ?? null;
    const current = levels.find((o) => o.id === currentId);
    controls.push({
      id: 'reasoning',
      label: 'Reasoning',
      value: current?.id ?? null,
      ...(current ? {} : { valueLabel: currentId ? thinkingLabel({ id: currentId }) : 'Default' }),
      options: levels.map((o) => ({
        id: o.id,
        label: thinkingLabel(o),
        ...(str(o.description) ? { description: oneLine(o.description!, 160) } : {}),
      })),
    });
  }

  // A running agent reports its own modes; for one Paseo only has stored, use the provider's.
  const modes = (agentLoaded(agent) ? agent.availableModes : catalog?.modes) ?? [];
  const offered = modes.filter((m) => modeTier(agent.provider, m) !== 'blocked');
  if (offered.length) {
    const current = offered.find((m) => m.id === agent.currentModeId);
    const currentLabel = modes.find((m) => m.id === agent.currentModeId)?.label || agent.currentModeId;
    controls.push({
      id: 'mode',
      label: 'Mode',
      value: current?.id ?? null,
      ...(current ? {} : { valueLabel: currentLabel || 'Default' }),
      options: offered.map((m) => ({
        id: m.id,
        label: m.label || m.id,
        ...(str(m.description) ? { description: oneLine(m.description!, 160) } : {}),
        ...(modeTier(agent.provider, m) === 'auto' ? { autoApproves: true } : {}),
      })),
    });
  }

  const used = agent.lastUsage?.contextWindowUsedTokens;
  const max = agent.lastUsage?.contextWindowMaxTokens ?? model?.contextWindowMaxTokens;
  return {
    controls,
    ...(typeof used === 'number' && typeof max === 'number' && max > 0 ? { context: { used, max } } : {}),
  };
}

// ---- images an agent showed ------------------------------------------------------

/**
 * The folder Paseo reads an image path against, picked as Paseo's own app does:
 * "~" for home paths, the agent's folder for paths inside it (so Paseo refuses a
 * symlink that leads out of it), and "/" for any other absolute path.
 */
export function imageReadRoot(path: string, agentCwd: string): string {
  if (path === '~' || path.startsWith('~/')) return '~';
  const cwd = agentCwd.trim();
  if (!path.startsWith('/')) return cwd; // relative: resolved inside the agent's folder
  const root = cwd.replace(/\/+$/, '') || '/';
  const inside = cwd.startsWith('/') && (root === '/' || path === root || path.startsWith(`${root}/`));
  return inside ? cwd : '/';
}

// ---- permissions & questions ---------------------------------------------------

export interface PaseoQuestion {
  question: string;
  header: string;
  options: string[];
  multiSelect: boolean;
  allowText: boolean;
}

export const DISMISS_OPTION = '__dismiss';

/** `AskUserQuestion`-style requests (same parser rules as Paseo's question form). */
export function parseQuestions(request: AgentPermissionRequest): PaseoQuestion[] | null {
  if (request.kind !== 'question') return null;
  const raw = (request.input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: PaseoQuestion[] = [];
  for (const entry of raw) {
    const q = entry as Record<string, unknown>;
    if (typeof q.question !== 'string' || typeof q.header !== 'string' || !Array.isArray(q.options)) return null;
    const options = (q.options as unknown[]).map((o) => (o as { label?: unknown }).label);
    if (options.some((l) => typeof l !== 'string')) return null;
    out.push({
      question: q.question,
      header: q.header,
      options: options as string[],
      multiSelect: q.multiSelect === true,
      allowText: options.length === 0 || q.allowOther === true || q.isOther === true,
    });
  }
  return out;
}

function optionKind(action: { id: string; label: string; behavior: 'allow' | 'deny' }): ApprovalOption['kind'] {
  if (action.behavior === 'deny') return 'deny';
  const text = `${action.id} ${action.label}`;
  if (/always/i.test(text)) return 'allow_always';
  if (/session|chat/i.test(text)) return 'allow_session';
  return 'allow';
}

function permissionDetail(request: AgentPermissionRequest): string | undefined {
  const d = request.detail as LooseDetail | undefined;
  const s = (key: string) => (d && typeof d[key] === 'string' ? (d[key] as string) : undefined);
  if (d) {
    switch (d.type) {
      case 'shell':
        return s('command');
      case 'edit':
        return [s('filePath') && homeRelative(s('filePath')!), s('unifiedDiff')].filter(Boolean).join('\n\n') || undefined;
      case 'write':
        return [s('filePath') && homeRelative(s('filePath')!), s('content')].filter(Boolean).join('\n\n') || undefined;
      case 'read':
        return s('filePath') && homeRelative(s('filePath')!);
      case 'fetch':
        return s('url');
      case 'search':
        return s('query');
      case 'plain_text':
        return s('text') ?? s('label');
      case 'plan':
        return s('text');
    }
  }
  if (str(request.description)) return request.description;
  if (request.input && Object.keys(request.input).length > 0) return pretty(request.input);
  return undefined;
}

export function requestApprovals(
  agentId: string,
  request: AgentPermissionRequest,
  createdAt: number,
): { approvals: Approval[]; questions: PaseoQuestion[] | null } {
  const questions = parseQuestions(request);
  if (questions) {
    const approvals = questions.map((q, i): Approval => ({
      id: `${request.id}.q${i}`,
      source: 'paseo',
      conversationId: agentId,
      kind: 'question',
      title: oneLine(q.question, 300),
      options: [
        ...q.options.map((label, j) => ({ id: String(j), label, kind: 'choice' as const })),
        { id: DISMISS_OPTION, label: 'Dismiss', kind: 'deny' as const },
      ],
      ...(q.allowText ? { allowText: true } : {}),
      ...(q.multiSelect ? { multiSelect: true } : {}),
      ...(questions.length > 1 ? { progress: `Question ${i + 1} of ${questions.length}` } : {}),
      createdAt: createdAt + i,
    }));
    return { approvals, questions };
  }

  // Claude's "Implement" switches the agent to auto-accepting file edits; say so.
  const implementNote = (a: { intent?: string }) =>
    request.provider === 'claude' && (a.intent === 'implement' || a.intent === 'implement_resume');
  const options: ApprovalOption[] = request.actions?.length
    ? request.actions.map((a) => ({
        id: a.id,
        label: implementNote(a) ? `${a.label} (then auto-accepts edits)` : a.label,
        kind: optionKind(a),
      }))
    : [
        { id: 'allow', label: 'Allow', kind: 'allow' },
        { id: 'deny', label: 'Deny', kind: 'deny' },
      ];
  const detail = permissionDetail(request);
  return {
    approvals: [
      {
        id: request.id,
        source: 'paseo',
        conversationId: agentId,
        kind: 'permission',
        title: str(request.title) ? oneLine(request.title!, 200) : `Allow ${request.name}?`,
        ...(detail ? { detail: clip(detail, MAX_APPROVAL_DETAIL) } : {}),
        ...(detail && detail.length > MAX_APPROVAL_DETAIL ? { detailTruncated: true } : {}),
        options,
        createdAt,
      },
    ],
    questions: null,
  };
}

/** Translate a picked option into Paseo's response; null if the option isn't offered. */
export function permissionResponse(request: AgentPermissionRequest, optionId: string): AgentPermissionResponse | null {
  if (request.actions?.length) {
    const action = request.actions.find((a) => a.id === optionId);
    return action ? { behavior: action.behavior, selectedActionId: action.id } : null;
  }
  if (optionId === 'allow') return { behavior: 'allow' };
  if (optionId === 'deny') return { behavior: 'deny', message: 'Denied from Signalbox' };
  return null;
}

/** The answer string for one question, or null if the answer isn't valid. */
export function questionAnswer(q: PaseoQuestion, answer: ApprovalAnswer): string | null {
  const text = answer.text?.trim();
  if (text && q.allowText) return text;
  const ids = answer.optionIds ?? (answer.optionId !== undefined ? [answer.optionId] : []);
  if (ids.length === 0 || (!q.multiSelect && ids.length > 1)) return null;
  const labels: string[] = [];
  for (const id of ids) {
    const index = Number(id);
    if (!Number.isInteger(index) || index < 0 || index >= q.options.length) return null;
    labels.push(q.options[index]!);
  }
  return labels.join(', ');
}
