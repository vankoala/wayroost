import {
  REQUEST_MARKER_HEADER,
  type Approval,
  type ApprovalAnswer,
  type ArchivedList,
  type BridgeStatus,
  type CleanupPreview,
  type CloudAgentId,
  type CloudAgentsStatus,
  type SafetyCommandsStatus,
  type WhatsAppRouting,
  type PhoneStatus,
  type ScheduleDraft,
  type ScheduleList,
  type ScheduleOverview,
  type FeedAction,
  type FeedActionResult,
  type FeedList,
  type FeedSettings,
  type ProactivityLevel,
  type ScheduleRun,
  type ScheduleSource,
  type ScheduleToolLevel,
  type CommandCatalog,
  type ConnectFlow,
  type ConnectStart,
  type ConnectorAccess,
  type ConnectorList,
  type ConnectorState,
  type ControlChange,
  type ControlChangeResponse,
  type ConversationControls,
  type ConversationDetail,
  type CreateResponse,
  type HermesOptions,
  type FolderScope,
  type FolderStatus,
  type ListResponse,
  type MeResponse,
  type PaseoOptions,
  type SendResponse,
  type Source,
  type SourceStatus,
  type ThreadActionResult,
  type ThreadRef,
  type TriggerList,
  type VoiceSaveResult,
  type VoiceStatus,
} from '../../shared/protocol';
import { approvalKey, convKey, setState, toast, withEarlyItems } from './store';

export interface Upload {
  name: string;
  mimeType: string;
  data: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'auth' | 'http',
    readonly status?: number,
  ) {
    super(message);
  }
}

function markSessionExpired() {
  setState((s) => (s.sessionExpired ? s : { ...s, sessionExpired: true }));
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        [REQUEST_MARKER_HEADER]: '1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      // Cloudflare Access answers an expired session with a redirect to its
      // login page; don't follow it, surface "sign in again" instead.
      redirect: 'manual',
    });
  } catch {
    throw new ApiError("Can't reach Signalbox. Check your connection.", 'network');
  }
  if (res.type === 'opaqueredirect' || res.status === 401) {
    markSessionExpired();
    throw new ApiError('Your sign-in expired.', 'auth');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status === 403 ? 'auth' : 'http', res.status);
  }
  return data as T;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MEDIA_ERRORS: Record<number, string> = {
  403: "This image can't be shown.",
  404: 'Image unavailable — reopen this chat.',
  413: 'This image is too large to show.',
  415: "That file isn't an image Signalbox can show.",
  502: "The agent couldn't read this image.",
};

/** An image an agent showed, from a link the server signed. Only real image types come back. */
export async function fetchMedia(url: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { [REQUEST_MARKER_HEADER]: '1' },
      credentials: 'same-origin',
      redirect: 'manual',
    });
  } catch {
    throw new ApiError("Can't reach Signalbox. Check your connection.", 'network');
  }
  if (res.type === 'opaqueredirect' || res.status === 401) {
    markSessionExpired();
    throw new ApiError('Your sign-in expired.', 'auth', 401);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(data.error ?? MEDIA_ERRORS[res.status] ?? `Couldn't load the image (${res.status}).`, 'http', res.status);
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!IMAGE_TYPES.has(type)) throw new ApiError(MEDIA_ERRORS[415]!, 'http', 415);
  // Typed from the checked header, so opening it in a tab can only ever show an image.
  return new Blob([await res.arrayBuffer()], { type });
}

/** A reply read aloud: WAV audio from the speech service on your PC. */
export async function speakAudio(text: string, voice?: string, speed?: number): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch('/api/voice/speak', {
      method: 'POST',
      headers: { [REQUEST_MARKER_HEADER]: '1', 'content-type': 'application/json' },
      body: JSON.stringify({ text, ...(voice ? { voice } : {}), ...(speed && speed !== 1 ? { speed } : {}) }),
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    throw new ApiError("Can't reach Signalbox. Check your connection.", 'network');
  }
  if (res.type === 'opaqueredirect' || res.status === 401) {
    markSessionExpired();
    throw new ApiError('Your sign-in expired.', 'auth', 401);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(data.error ?? `Couldn't read that aloud (${res.status}).`, 'http', res.status);
  }
  return res.arrayBuffer();
}

export const api = {
  me: () => request<MeResponse>('GET', '/api/me'),
  voice: () => request<VoiceStatus>('GET', '/api/voice'),
  setVoice: (voice: string) => request<VoiceSaveResult>('PUT', '/api/voice', { voice }),
  list: () => request<ListResponse>('GET', '/api/conversations'),
  conversation: (source: Source, id: string) =>
    request<ConversationDetail>('GET', `/api/conversations/${source}/${encodeURIComponent(id)}`),
  send: (source: Source, id: string, text: string, attachments: Upload[] = []) =>
    request<SendResponse>('POST', `/api/conversations/${source}/${encodeURIComponent(id)}/messages`, {
      text,
      ...(attachments.length ? { attachments } : {}),
    }),
  commands: (source: Source, id: string) =>
    request<CommandCatalog>('GET', `/api/conversations/${source}/${encodeURIComponent(id)}/commands`),
  hermesCommands: () => request<CommandCatalog>('GET', '/api/hermes/commands'),
  controls: (source: Source, id: string) =>
    request<ConversationControls>('GET', `/api/conversations/${source}/${encodeURIComponent(id)}/controls`),
  setControl: (source: Source, id: string, change: ControlChange) =>
    request<ControlChangeResponse>('POST', `/api/conversations/${source}/${encodeURIComponent(id)}/controls`, change),
  interrupt: (source: Source, id: string) =>
    request<{ ok: true }>('POST', `/api/conversations/${source}/${encodeURIComponent(id)}/interrupt`, {}),
  respond: (approval: Approval, answer: ApprovalAnswer) =>
    request<{ ok: true }>(
      'POST',
      `/api/conversations/${approval.source}/${encodeURIComponent(approval.conversationId)}/approvals/${encodeURIComponent(approval.id)}`,
      answer,
    ),
  hermesOptions: () => request<HermesOptions>('GET', '/api/hermes/options'),
  createHermes: (input: { text: string; cwd?: string; attachments?: Upload[]; model?: string; confirmModel?: boolean }) =>
    request<CreateResponse>('POST', '/api/hermes/conversations', {
      text: input.text,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.confirmModel ? { confirmModel: true } : {}),
    }),
  paseoOptions: () => request<PaseoOptions>('GET', '/api/paseo/options'),
  /** Whether a folder for a new chat exists (asked through Paseo, which runs as you). */
  folderStatus: (path: string) => request<{ status: FolderStatus }>('GET', `/api/folders?path=${encodeURIComponent(path)}`),
  /** Make a new folder, one level below an existing one; Paseo lists it as a project too. */
  createFolder: (path: string) => request<{ path: string }>('POST', '/api/folders', { path }),
  createPaseo: (input: {
    providerId: string;
    cwd: string;
    modeId?: string;
    text: string;
    acknowledgeAutoApprove?: boolean;
    attachments?: Upload[];
  }) =>
    request<CreateResponse>('POST', '/api/paseo/conversations', input),
  bridge: () => request<BridgeStatus>('GET', '/api/bridge'),
  setBridgePaused: (paused: boolean) => request<BridgeStatus>('PUT', '/api/bridge', { paused }),
  cloudAgents: () => request<CloudAgentsStatus>('GET', '/api/cloud-agents'),
  archiveThreads: (threads: ThreadRef[], folder?: FolderScope) =>
    request<ThreadActionResult>('POST', '/api/threads/archive', { threads, ...(folder ? { folder } : {}) }),
  restoreThreads: (threads: ThreadRef[]) => request<ThreadActionResult>('POST', '/api/threads/restore', { threads }),
  deleteThreads: (threads: ThreadRef[]) => request<ThreadActionResult>('POST', '/api/threads/delete', { threads }),
  archived: () => request<ArchivedList>('GET', '/api/threads/archived'),
  cleanupPreview: (idleDays: number) => request<CleanupPreview>('GET', `/api/cleanup?idleDays=${idleDays}`),
  cleanup: (idleDays: number) => request<ThreadActionResult>('POST', '/api/cleanup', { idleDays }),
  setCloudAgent: (id: CloudAgentId, enabled: boolean) =>
    request<CloudAgentsStatus>('PUT', `/api/cloud-agents/${id}`, { enabled }),
  safetyCommands: () => request<SafetyCommandsStatus>('GET', '/api/safety-commands'),
  setSafetyCommands: (enabled: boolean) =>
    request<SafetyCommandsStatus>('PUT', '/api/safety-commands', { enabled }),
  whatsappRouting: () => request<WhatsAppRouting>('GET', '/api/whatsapp-routing'),
  feed: () => request<FeedList>('GET', '/api/feed'),
  feedSeen: () => request<{ ok: true }>('POST', '/api/feed/seen', {}),
  feedAction: (id: string, action: FeedAction) =>
    request<FeedActionResult>('POST', `/api/feed/${encodeURIComponent(id)}/action`, { action }),
  feedSettings: (patch: {
    level?: ProactivityLevel;
    quietHours?: { start: string; end: string } | null;
    push?: { approvals?: boolean; cards?: boolean };
    removeLessLike?: string;
  }) => request<FeedSettings>('PUT', '/api/feed/settings', patch),
  pushKey: () => request<{ publicKey: string }>('GET', '/api/push/key'),
  pushAddDevice: (subscription: { endpoint: string; keys: { p256dh: string; auth: string }; label?: string }) =>
    request<{ devices: number }>('POST', '/api/push/devices', subscription),
  pushRemoveDevice: (endpoint: string) => request<{ devices: number }>('POST', '/api/push/devices/remove', { endpoint }),
  pushTest: () => request<{ sent: number }>('POST', '/api/push/test', {}),
  schedules: () => request<ScheduleList>('GET', '/api/schedules'),
  scheduleOverview: () => request<ScheduleOverview>('GET', '/api/schedules/overview'),
  draftSchedule: (goal: string) => request<ScheduleDraft>('POST', '/api/schedules/draft', { goal }),
  scheduleRuns: (source: ScheduleSource, id: string) =>
    request<{ runs: ScheduleRun[] }>('GET', `/api/schedules/${source}/${encodeURIComponent(id)}/runs`),
  createSchedule: (input: {
    name: string;
    prompt: string;
    schedule: string;
    deliver: string;
    skills?: string[];
    idea?: string;
    tools?: ScheduleToolLevel;
  }) =>
    request<ScheduleList>('POST', '/api/schedules', input),
  updateSchedule: (
    source: ScheduleSource,
    id: string,
    changes: Partial<{ name: string; prompt: string; schedule: string; deliver: string; tools: ScheduleToolLevel }>,
  ) => request<ScheduleList>('PUT', `/api/schedules/${source}/${encodeURIComponent(id)}`, changes),
  pauseSchedule: (source: ScheduleSource, id: string, paused: boolean) =>
    request<ScheduleList>('PUT', `/api/schedules/${source}/${encodeURIComponent(id)}/paused`, { paused }),
  runSchedule: (source: ScheduleSource, id: string) =>
    request<ScheduleList>('POST', `/api/schedules/${source}/${encodeURIComponent(id)}/run`, {}),
  deleteSchedule: (source: ScheduleSource, id: string) =>
    request<ScheduleList>('DELETE', `/api/schedules/${source}/${encodeURIComponent(id)}`),
  phone: () => request<PhoneStatus>('GET', '/api/phone'),
  phonePin: () => request<{ pin: string | null }>('GET', '/api/phone/pin'),
  setPhonePin: (pin: string) => request<PhoneStatus>('PUT', '/api/phone/pin', { pin }),
  setWhatsappRouting: (settings: Omit<WhatsAppRouting, 'installed' | 'active'>) =>
    request<WhatsAppRouting>('PUT', '/api/whatsapp-routing', settings),
  setHermesCredentials: (username: string, password: string) =>
    request<{ status: SourceStatus }>('PUT', '/api/settings/hermes', { username, password }),
  clearHermesCredentials: () => request<{ status: SourceStatus }>('DELETE', '/api/settings/hermes'),
  connectors: () => request<ConnectorList>('GET', '/api/connectors'),
  connect: (id: string) => request<ConnectStart>('POST', `/api/connectors/${encodeURIComponent(id)}/connect`, {}),
  connectFlow: (flowId: string) => request<ConnectFlow>('GET', `/api/connectors/flows/${encodeURIComponent(flowId)}`),
  cancelConnect: (flowId: string) => request<{ ok: true }>('DELETE', `/api/connectors/flows/${encodeURIComponent(flowId)}`),
  setConnectorAccess: (id: string, access: ConnectorAccess) =>
    request<{ ok: true }>('PUT', `/api/connectors/${encodeURIComponent(id)}/access`, { access }),
  checkConnector: (id: string) => request<{ ok: true }>('POST', `/api/connectors/${encodeURIComponent(id)}/check`, {}),
  disconnectConnector: (id: string) =>
    request<{ ok: true }>('POST', `/api/connectors/${encodeURIComponent(id)}/disconnect`, {}),
  googleStart: () => request<{ url: string }>('POST', '/api/connectors/google/start', {}),
  googleFinish: (redirect: string) =>
    request<{ state: ConnectorState }>('POST', '/api/connectors/google/finish', { redirect }),
  googleDisconnect: () => request<{ ok: true }>('POST', '/api/connectors/google/disconnect', {}),
  triggers: () => request<TriggerList>('GET', '/api/triggers'),
  createTrigger: (input: { name: string; query: string; action: string; every: number; deliver: string; tools?: ScheduleToolLevel }) =>
    request<{ ok: true }>('POST', '/api/triggers', input),
  pauseTrigger: (id: string, paused: boolean) =>
    request<{ ok: true }>('PUT', `/api/triggers/${encodeURIComponent(id)}/paused`, { paused }),
  deleteTrigger: (id: string) => request<{ ok: true }>('DELETE', `/api/triggers/${encodeURIComponent(id)}`),
};

/** Fetch the inbox and replace list state wholesale (used on load and reconnect). */
/** Take threads out of the inbox now; the server confirms with conversation_removed. */
export function dropThreads(threads: readonly ThreadRef[]): void {
  setState((s) => {
    const conversations = { ...s.conversations };
    for (const t of threads) delete conversations[convKey(t.source, t.id)];
    return { ...s, conversations };
  });
}

const threadCount = (n: number) => `${n} ${n === 1 ? 'thread' : 'threads'}`;

/**
 * Say how an archive, restore or delete went. Returns the threads it worked
 * for, so they can leave the list.
 */
export function reportTidy(verb: string, asked: readonly ThreadRef[], result: ThreadActionResult): ThreadRef[] {
  const failed = new Set(result.failed.map((f) => convKey(f.source, f.id)));
  if (result.failed.length === 0) toast(`${capitalized(verb)} ${threadCount(result.done)}`, 'info');
  else if (result.done === 0) toast(`Couldn't ${verbBase(verb)} ${threadCount(result.failed.length)}: ${result.failed[0]!.error}`);
  else toast(`${capitalized(verb)} ${threadCount(result.done)}; ${result.failed.length} failed: ${result.failed[0]!.error}`);
  return asked.filter((t) => !failed.has(convKey(t.source, t.id)));
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const verbBase = (verb: string) => ({ archived: 'archive', restored: 'restore', deleted: 'delete' })[verb] ?? verb;

/** For you: load the cards (quietly does nothing where it's turned off). */
export async function loadFeed(): Promise<FeedSettings | null> {
  try {
    const list = await api.feed();
    setState((s) => ({ ...s, feed: Object.fromEntries(list.cards.map((c) => [c.id, c])) }));
    return list.settings;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) setState((s) => (s.feed === null ? s : { ...s, feed: null }));
    return null;
  }
}

export async function refreshList(): Promise<void> {
  const data = await api.list();
  setState((s) => ({
    ...s,
    listLoaded: true,
    statuses: Object.fromEntries(data.statuses.map((st) => [st.source, st])) as typeof s.statuses,
    conversations: Object.fromEntries(data.conversations.map((c) => [convKey(c.source, c.id), c])),
    approvals: Object.fromEntries(data.approvals.map((a) => [approvalKey(a), a])),
  }));
}

/** Load (or reload) one conversation's timeline. */
export async function loadConversation(source: Source, id: string): Promise<void> {
  const key = convKey(source, id);
  setState((s) => ({
    ...s,
    details: { ...s.details, [key]: { status: 'loading', items: s.details[key]?.items ?? [] } },
  }));
  try {
    const detail = await api.conversation(source, id);
    const items = withEarlyItems(key, detail.items);
    setState((s) => ({
      ...s,
      conversations: { ...s.conversations, [key]: detail.conversation },
      approvals: {
        ...Object.fromEntries(
          Object.entries(s.approvals).filter(([, a]) => !(a.source === source && a.conversationId === id)),
        ),
        ...Object.fromEntries(detail.approvals.map((a) => [approvalKey(a), a])),
      },
      details: { ...s.details, [key]: { status: 'ready', items } },
    }));
  } catch (err) {
    setState((s) => ({
      ...s,
      details: {
        ...s.details,
        [key]: { status: 'error', items: s.details[key]?.items ?? [], error: (err as Error).message },
      },
    }));
  }
}
