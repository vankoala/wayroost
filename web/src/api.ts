import {
  REQUEST_MARKER_HEADER,
  type Approval,
  type ApprovalAnswer,
  type ArchivedList,
  type BridgeStatus,
  type CleanupPreview,
  type CloudAgentId,
  type CloudAgentsStatus,
  type ProjectConfigReport,
  type SafetyCommandsStatus,
  type WorkerUpdatesStatus,
  type TaskList,
  type Capabilities,
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
  type DeviceInfo,
  type DeviceKind,
  type DeviceList,
  type PairOffer,
  type PairResult,
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
import type { WorkerApprovalsStatus } from '../../shared/safety';
import type { NotificationSettingsView } from '../../shared/protocol';
import { SETTINGS_API, type RecentChange, type SettingsApplyResponse, type SettingsNotificationsWriteBody, type SettingsSection } from '../../shared/settings.js';
import type { SettingsChecksResponse } from '../../shared/settings-checks.js';
import type { DrainRestartComponent } from '../../shared/settings.js';
import type { SettingsCredentialPayload, SettingsRefusal, SettingsRestartPayload, SettingsSectionPayload, SettingsUsagePayload } from './settingsModel.js';
import { isApprovalDetail, isApprovalSnapshot } from '../../shared/approval-validation';
import { captureRollout, approvalKey, convKey, getAuthenticationGeneration, markUnpaired, setState, toast, withEarlyItems } from './store.js';
import { ApiError, beginAuthenticatedRequest, checkAuthentication, checkAuthenticationGeneration, reportAuthenticationAnomaly } from './authentication';
import { authenticationEndpoint } from '../../shared/authentication';
import { speechRequest } from './voice/request';

export interface Upload {
  name: string;
  mimeType: string;
  data: string;
}

export { ApiError, markUnpaired };

let notificationSettingsSaves: Promise<void> = Promise.resolve();

/** Both settings editors read and save shared preferences one at a time. */
export function serializeNotificationSettingsSave<T>(save: () => Promise<T>): Promise<T> {
  const saved = notificationSettingsSaves.then(save);
  notificationSettingsSaves = saved.then(() => {}, () => {});
  return saved;
}

export async function request<T>(method: string, path: string, body?: unknown, validate?: (value: unknown) => value is T): Promise<T> {
  const generation = beginAuthenticatedRequest(method === 'POST' && path === '/api/pair');
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
    if (path === '/api/me') reportAuthenticationAnomaly(generation);
    throw new ApiError("Can't reach Wayroost. Check your connection.", 'network');
  }
  await checkAuthentication(res, generation, authenticationEndpoint(path));
  // A success whose body can't be read (a cut connection, or a navigation
  // that aborts the read) is a failed request, not an empty answer: callers
  // destructure what they asked for.
  let parsed = true;
  const raw: unknown = await res.json().catch(() => {
    parsed = false;
    return undefined;
  });
  const data = (raw ?? {}) as { error?: string; code?: string };
  checkAuthenticationGeneration(generation);
  if (!res.ok) {
    throw new ApiError(data.error ?? (data.code ? `Settings change refused: ${data.code.replaceAll('_', ' ')}.` : `Request failed (${res.status})`), 'http', res.status);
  }
  if (!parsed && authenticationEndpoint(path)) reportAuthenticationAnomaly(generation);
  if (!parsed) throw new ApiError("Can't reach Wayroost. Check your connection.", 'network');
  return processResponse(generation, () => {
    if (validate && !validate(raw)) throw new ApiError('Invalid approval response.', 'network');
    return raw as T;
  });
}

/** Validation and presentation failures signal only the generation that received the response. */
function processResponse<T>(generation: number, process: () => T): T {
  try {
    checkAuthenticationGeneration(generation);
    return process();
  } catch (error) {
    reportAuthenticationAnomaly(generation);
    throw error;
  }
}

/**
 * The settings routes answer a refusal with a fixed code in the body, whatever the HTTP status;
 * return the body as it is, so each page words the code itself. Transport and authentication
 * failures still throw.
 */
async function settingsCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const generation = beginAuthenticatedRequest(false);
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { [REQUEST_MARKER_HEADER]: '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    throw new ApiError("Can't reach Wayroost. Check your connection.", 'network');
  }
  await checkAuthentication(res, generation, authenticationEndpoint(path));
  const raw: unknown = await res.json().catch(() => undefined);
  checkAuthenticationGeneration(generation);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError("Can't reach Wayroost. Check your connection.", 'network');
  if (!res.ok && (!('status' in raw) || raw.status !== 'refused')) throw new ApiError('This PC did not answer. Try again.', 'http', res.status);
  return raw as T;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MEDIA_ERRORS: Record<number, string> = {
  403: "This image can't be shown.",
  404: 'Image unavailable — reopen this chat.',
  413: 'This image is too large to show.',
  415: "That file isn't an image Wayroost can show.",
  502: "The agent couldn't read this image.",
};

/** An image an agent showed, from a link the server signed. Only real image types come back. */
export async function fetchMedia(url: string): Promise<Blob> {
  const generation = beginAuthenticatedRequest();
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { [REQUEST_MARKER_HEADER]: '1' },
      credentials: 'same-origin',
      redirect: 'manual',
    });
  } catch {
    throw new ApiError("Can't reach Wayroost. Check your connection.", 'network');
  }
  await checkAuthentication(res, generation);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(data.error ?? MEDIA_ERRORS[res.status] ?? `Couldn't load the image (${res.status}).`, 'http', res.status);
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!IMAGE_TYPES.has(type)) throw new ApiError(MEDIA_ERRORS[415]!, 'http', 415);
  // Typed from the checked header, so opening it in a tab can only ever show an image.
  const bytes = await res.arrayBuffer();
  checkAuthenticationGeneration(generation);
  return new Blob([bytes], { type });
}

/** A reply read aloud: WAV audio from the speech service on your PC. */
export async function speakAudio(text: string, voice?: string, speed?: number): Promise<ArrayBuffer> {
  const generation = beginAuthenticatedRequest();
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
    throw new ApiError("Can't reach Wayroost. Check your connection.", 'network');
  }
  await checkAuthentication(res, generation);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(data.error ?? `Couldn't read that aloud (${res.status}).`, 'http', res.status);
  }
  const bytes = await res.arrayBuffer();
  checkAuthenticationGeneration(generation);
  return bytes;
}

/** PCM frames can play as they arrive; a fallback discards the partial cloud rendering. */
export async function* streamSpeech(text: string, speed: number, signal: AbortSignal, fallback = () => toast('ElevenLabs is unavailable. Reading in the local voice.')): AsyncGenerator<ArrayBuffer | 'reset'> {
  const generation = beginAuthenticatedRequest();
  const owned = await speechRequest(signal);
  try {
    signal.throwIfAborted();
    let res: Response;
    try {
      res = await fetch(owned.url, {
        method: 'POST', headers: { [REQUEST_MARKER_HEADER]: '1', 'content-type': 'application/json' },
        body: JSON.stringify({ text, speed, stream: true }), credentials: 'same-origin', cache: 'no-store', redirect: 'manual', signal: owned.signal,
      });
    } catch (error) {
      // Stopping playback aborts the request; that is no sign-in trouble.
      if (signal.aborted) throw error;
      throw new ApiError("Can't reach Wayroost. Check your connection.", 'network');
    }
    // The same sign-in classifier as every other request (on the desktop, main decides).
    await checkAuthentication(res, generation);
    if (!res.ok || !res.body) throw new ApiError("Couldn't read that aloud.", 'http', res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let line = '';
    let pending = new Uint8Array(0);
    let format = '';
    let ended = false;
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        // A suspended sign-in stops playback at once.
        checkAuthenticationGeneration(generation);
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 16 * 1024 * 1024) throw new Error('Voice response is too large.');
        line += decoder.decode(part.value, { stream: true });
        let end: number;
        while ((end = line.indexOf('\n')) >= 0) {
          const frame = JSON.parse(line.slice(0, end)) as import('../../shared/voice').SpeechFrame;
          line = line.slice(end + 1);
          if (frame.type === 'error') throw new Error(frame.message);
          if (frame.type === 'start' || frame.type === 'reset') {
            format = frame.format; pending = new Uint8Array(0);
            if (frame.type === 'reset') yield 'reset';
            if (frame.reason) fallback();
          }
          if (frame.type === 'audio') {
            const audio = Uint8Array.from(atob(frame.data), c => c.charCodeAt(0));
            if (format === 'wav') { yield audio.buffer; continue; }
            const merged = new Uint8Array(pending.length + audio.length);
            merged.set(pending); merged.set(audio, pending.length); pending = merged;
            // About 125 ms per clip, independent of network chunk boundaries.
            while (pending.length >= 6000) { yield pcmClip(pending.slice(0, 6000), speed); pending = pending.slice(6000); }
          }
          if (frame.type === 'end') {
            if (pending.length % 2) throw new Error('Voice stream ended mid-sample.');
            if (pending.length) yield pcmClip(pending, speed);
            pending = new Uint8Array(0); ended = true;
          }
        }
      }
      if (!ended || line.trim()) throw new Error('Voice stream stopped before it finished.');
    } finally { await owned.cancel(); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } finally { await owned.dispose(); }
}

function pcmClip(pcm: Uint8Array, speed: number): ArrayBuffer {
  const wav = new ArrayBuffer(44 + pcm.length);
  const bytes = new Uint8Array(wav);
  const view = new DataView(wav);
  const word = (at: number, text: string) => bytes.set(new TextEncoder().encode(text), at);
  word(0, 'RIFF'); view.setUint32(4, 36 + pcm.length, true); word(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  // Local WAVs already include their speed; adjust only cloud PCM playback.
  const rate = Math.round(24000 * (Number.isFinite(speed) && speed >= 0.5 && speed <= 2 ? speed : 1));
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  word(36, 'data'); view.setUint32(40, pcm.length, true); bytes.set(pcm, 44);
  return wav;
}

export const api = {
  me: () => request<MeResponse>('GET', '/api/me'),
  /** Pairs this browser with a code; the server sets its device cookie. */
  pair: (code: string, name: string) => request<PairResult>('POST', '/api/pair', { code, name }),
  pairOffer: (kind: DeviceKind) => request<PairOffer>('POST', '/api/pair/offer', { kind }),
  unlockPairing: () => request<{ pairingLocked: false }>('DELETE', '/api/pair/lock'),
  devices: () => request<DeviceList>('GET', '/api/devices'),
  renameDevice: (id: string, name: string) =>
    request<DeviceInfo>('PATCH', `/api/devices/${encodeURIComponent(id)}`, { name }),
  revokeDevice: (id: string) => request<{ ok: true }>('DELETE', `/api/devices/${encodeURIComponent(id)}`),
  voice: () => request<VoiceStatus>('GET', '/api/voice'),
  voiceCatalog: () => request<NonNullable<VoiceStatus['cloud']>>('GET', '/api/voice/catalog'),
  setAppVoice: (appReadAloud: import('../../shared/voice').AppVoice) => request<VoiceSaveResult>('PUT', '/api/voice', { appReadAloud }),
  setVoice: (voice: string) => request<VoiceSaveResult>('PUT', '/api/voice', { voice }),
  list: () => request<ListResponse>('GET', '/api/conversations', undefined, isApprovalSnapshot),
  openConversation: (source: Source, id: string) =>
    request<ConversationDetail>('POST', `/api/conversations/${source}/${encodeURIComponent(id)}/open`, undefined, isApprovalDetail),
  conversation: (source: Source, id: string) =>
    request<ConversationDetail>('GET', `/api/conversations/${source}/${encodeURIComponent(id)}`, undefined, isApprovalDetail),
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
  /** What a folder's own files would let an agent do there, before it starts (names, never content). */
  projectConfig: (path: string, provider: string) =>
    request<ProjectConfigReport>('POST', '/api/project-config', { path, provider }),
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
  workerUpdates: () => request<WorkerUpdatesStatus>('GET', '/api/worker-updates'),
  tasks: () => request<TaskList>('GET', '/api/tasks'),
  capabilities: () => request<Capabilities>('GET', '/api/capabilities'),
  setWorkerUpdates: (patch: { enabled?: boolean; defaultMinutes?: number }) =>
    request<WorkerUpdatesStatus>('PUT', '/api/worker-updates', patch),
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
  workerApprovals: () => request<WorkerApprovalsStatus>('GET', '/api/worker-approvals'),
  /** A paired desktop only; the server refuses a phone. */
  setWorkerApprovals: (enabled: boolean) =>
    request<WorkerApprovalsStatus>('PUT', '/api/worker-approvals', { enabled }),
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
  notificationSettings: () => request<NotificationSettingsView>('GET', '/api/settings/notifications'),
  /** Settings, sections and all: rows for the pages below. A refusal comes back as a fixed code, not a throw. */
  settingsSection: (section: SettingsSection) => settingsCall<SettingsSectionPayload>('GET', SETTINGS_API.section(section)),
  settingsChanges: () => settingsCall<{ changes: RecentChange[] }>('GET', SETTINGS_API.changes),
  settingsApply: (body: { operation: string; params: Record<string, unknown>; expected?: unknown; confirm?: string }) =>
    settingsCall<SettingsApplyResponse>('POST', SETTINGS_API.apply, body),
  settingsUndo: (body: { change: string; confirm?: string }) =>
    settingsCall<SettingsApplyResponse>('POST', SETTINGS_API.undo, body),
  settingsUsage: () => settingsCall<SettingsUsagePayload>('GET', SETTINGS_API.usage),
  settingsChecks: () => settingsCall<SettingsChecksResponse | SettingsRefusal>('GET', SETTINGS_API.checks),
  /** The field never echoes the key back: the answer is the timing, or a fixed code. */
  settingsCredentialSet: (provider: string, secret: string) =>
    settingsCall<SettingsCredentialPayload>('PUT', SETTINGS_API.credential(provider), { secret }),
  settingsCredentialRemove: (provider: string) =>
    settingsCall<SettingsCredentialPayload>('DELETE', SETTINGS_API.credential(provider)),
  settingsCredentialTest: (provider: string, backend: string) =>
    settingsCall<SettingsCredentialPayload>('POST', SETTINGS_API.credentialTest(provider), { backend }),
  settingsRestartRun: (id: string) => settingsCall<SettingsRestartPayload>('GET', `/api/settings/restart/${encodeURIComponent(id)}`),
  settingsRestart: (component: DrainRestartComponent, when: 'idle' | 'now', confirm?: string) =>
    settingsCall<SettingsRestartPayload>('POST', SETTINGS_API.restart, { component, when, ...(confirm ? { confirm } : {}) }),
  setNotificationSettings: async (body: SettingsNotificationsWriteBody): Promise<NotificationSettingsView> => {
    const rollout = captureRollout('settingsPages');
    if (!rollout.still()) throw new Error('This setting was turned off on this site');
    const result = await request<SettingsApplyResponse>('PUT', '/api/settings/notifications', body);
    if (!rollout.still()) throw new Error('This setting was turned off on this site');
    if (result.status !== 'applied') throw new ApiError(result.status === 'refused'
      ? `Settings change refused: ${result.code.replaceAll('_', ' ')}.` : 'This settings change needs confirmation.', 'http');
    return api.notificationSettings();
  },
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

/** Client writes refused when settings pages have not rolled out. */
export const ROLLOUT_GATED_API = [
  'settingsApply', 'settingsUndo', 'settingsRestart', 'settingsCredentialSet', 'settingsCredentialRemove',
  'settingsCredentialTest', 'setNotificationSettings', 'feedSettings', 'setSafetyCommands', 'setCloudAgent',
  'setWorkerApprovals', 'setHermesCredentials', 'clearHermesCredentials',
].map(name => ({ name: name as keyof typeof api, key: 'settingsPages' as const }));

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

export async function refreshList(rollout?: ReturnType<typeof captureRollout>): Promise<void> {
  if (rollout && !rollout.still()) return;
  const generation = getAuthenticationGeneration();
  const data = await api.list();
  if (rollout && !rollout.still()) return;
  processResponse(generation, () => setState((s) => ({
    ...s,
    listLoaded: true,
    rollout: data.rollout ?? { settingsPages: false, revokes: false, chatFirst: false },
    statuses: Object.fromEntries(data.statuses.map((st) => [st.source, st])) as typeof s.statuses,
    conversations: Object.fromEntries(data.conversations.map((c) => [convKey(c.source, c.id), c])),
    approvals: Object.fromEntries(data.approvals.map((a) => [approvalKey(a), a])),
  })));
}

/** Load (or reload) one conversation's timeline. */
export async function loadConversation(source: Source, id: string, deliberateOpen = false): Promise<void> {
  const generation = getAuthenticationGeneration();
  const key = convKey(source, id);
  setState((s) => ({
    ...s,
    details: { ...s.details, [key]: { status: 'loading', items: s.details[key]?.items ?? [] } },
  }));
  try {
    const detail = await (deliberateOpen ? api.openConversation(source, id) : api.conversation(source, id));
    processResponse(generation, () => {
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
        details: { ...s.details, [key]: { status: 'ready', items, ...(detail.needsOpen !== undefined ? { needsOpen: detail.needsOpen } : {}) } },
      }));
    });
  } catch (err) {
    if (generation !== getAuthenticationGeneration()) return;
    setState((s) => ({
      ...s,
      details: {
        ...s.details,
        [key]: { status: 'error', items: s.details[key]?.items ?? [], error: (err as Error).message },
      },
    }));
  }
}
