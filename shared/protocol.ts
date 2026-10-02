// Contract between the signalbox server and the browser. Both Hermes and
// Paseo are normalized into these shapes so the UI treats them the same way.

export type Source = 'hermes' | 'paseo';
export const SOURCES: readonly Source[] = ['hermes', 'paseo'];

export type SourceState = 'connecting' | 'connected' | 'disconnected' | 'needs_credentials' | 'error' | 'disabled';

export interface SourceStatus {
  source: Source;
  state: SourceState;
  message?: string;
}

export type ConversationStatus = 'idle' | 'running' | 'needs_approval' | 'error';

export interface ConversationSummary {
  source: Source;
  id: string;
  title: string;
  /** Secondary line, e.g. "Claude Code · ~/code/app" or the model name. */
  subtitle?: string;
  /** Short snippet of the latest message. */
  preview?: string;
  status: ConversationStatus;
  /** Epoch milliseconds. */
  updatedAt: number;
  pendingApprovals: number;
  /** Project folder this conversation works in (git root when known). */
  project?: { path: string; name: string };
  /** Which agent runs it, e.g. "Claude Code", "Pi", "Hermes", or the Hermes model. */
  agentLabel?: string;
  /**
   * What started it, in either backend: the Paseo agent that created it, the
   * Hermes chat that ran delegate_task, or the chat that started it through the
   * bridge. The parent may not be listed; resolve it through `aliases` too.
   */
  parent?: { source: Source; id: string };
  /**
   * Other ids this conversation is known by: earlier ids of a compressed Hermes
   * chat, or the Hermes (ACP) session that a "Hermes · in Paseo" agent runs.
   */
  aliases?: Array<{ source: Source; id: string }>;
  /**
   * Run by its parent's agent (a Hermes delegate_task run, a Claude Code Task
   * sub-agent). Read-only here: no composer, controls or approvals of its own.
   */
  subagent?: boolean;
  /** Paseo only: this agent is a Hermes session running inside Paseo. */
  hermesInPaseo?: boolean;
  /** Started by another agent through the Signalbox bridge (possibly the other backend). */
  startedBy?: { source: Source; id: string; title: string };
}

export type ToolStatus = 'pending' | 'running' | 'done' | 'error';

/** A file sent along with a message. Only the name and type travel back, never the bytes. */
export interface AttachmentRef {
  name: string;
  kind: 'image' | 'pdf' | 'text' | 'file';
}

/**
 * An image on your machine that an agent pointed at. `url` is a link the server
 * signed (/api/media/...); fetch it with the API headers and show it as a blob.
 */
export interface MediaRef {
  url: string;
  name: string;
}

export type TimelineItem =
  | { kind: 'user'; id: string; text: string; at?: number; attachments?: AttachmentRef[] }
  | {
      kind: 'assistant';
      id: string;
      /** Markdown. Local images in `![alt](...)` are already rewritten to signed /api/media links. */
      text: string;
      streaming?: boolean;
      at?: number;
      /** Images mentioned another way (a bare path, a MEDIA: tag, a link): shown under the text. */
      media?: MediaRef[];
    }
  | { kind: 'reasoning'; id: string; text: string; streaming?: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      summary?: string;
      status: ToolStatus;
      input?: string;
      output?: string;
      /** Images the tool looked at or made (e.g. vision_analyze's image, a screenshot). */
      media?: MediaRef[];
    }
  | { kind: 'notice'; id: string; level: 'info' | 'error'; text: string }
  /**
   * Output of a "/" command run in this conversation. Hermes doesn't store it;
   * Signalbox keeps recent ones in memory until it restarts.
   */
  | {
      kind: 'command';
      id: string;
      command: string;
      output: string;
      error?: boolean;
      /** Still running; the same id is upserted with the output when it finishes. */
      running?: boolean;
      at?: number;
    };

/** A "/" command or skill offered in the message box. */
export interface SlashCommand {
  /** Without the slash, e.g. "compress" or a skill name. */
  name: string;
  description?: string;
  /** Argument hint shown after the name, e.g. "[focus]". */
  args?: string;
  /** Known argument values, offered after the name, e.g. ["low", "medium", "high"]. */
  options?: string[];
  kind: 'command' | 'skill';
  /** Menu section, e.g. "Session" or "Skills". */
  group?: string;
  aliases?: string[];
  /** Done by the app itself instead of being sent: 'new' opens the new-chat sheet, 'stop' stops the agent. */
  action?: 'new' | 'stop';
}

export interface CommandCatalog {
  commands: SlashCommand[];
  /**
   * 'signalbox': Signalbox runs "/" text itself and answers with a CommandResult (Hermes).
   * 'agent': "/" text is sent to the agent as an ordinary message, and the agent handles it (Paseo).
   */
  runner: 'signalbox' | 'agent';
}

/** What running a "/" command produced. */
export interface CommandResult {
  /** Output to show in the conversation. Viewers of the conversation also get it live. */
  items: TimelineItem[];
  /** Text to put back in the message box, e.g. for /undo. Nothing was sent. */
  prefill?: string;
}

/** Reply to POST /api/conversations/:source/:id/messages. */
export interface SendResponse {
  ok: true;
  /** Set when the text was a "/" command that Signalbox ran rather than sent. */
  command?: CommandResult;
}

export type ApprovalOptionKind = 'allow' | 'allow_session' | 'allow_always' | 'deny' | 'choice';

export interface ApprovalOption {
  id: string;
  label: string;
  kind: ApprovalOptionKind;
}

/**
 * Something an agent is blocked on: a permission request (run this command?)
 * or a question (which branch?). Nothing is ever answered automatically.
 */
export interface Approval {
  id: string;
  source: Source;
  conversationId: string;
  kind: 'permission' | 'question' | 'secret';
  /**
   * Secrets only (Hermes sudo, secret, vault and 2FA prompts, when the server
   * allows answering them): how to ask. The value goes in ApprovalAnswer.text
   * (ApprovalAnswer.login for 'login'), is sent straight to Hermes, and is
   * never stored, logged or shown again.
   */
  secret?: {
    /**
     * 'code' for one-time codes (numeric keypad); 'login' for a username and
     * password to save in Hermes' vault (vault.save_login); 'password' otherwise.
     */
    input: 'password' | 'code' | 'login';
    /** Ask for a second tap before sending (sudo: root on the PC). */
    confirm?: boolean;
  };
  /** What is being asked, e.g. "Run a shell command". */
  title: string;
  /** Command, file path, diff… shown as preformatted text. */
  detail?: string;
  /** The detail was too long to send in full; the UI won't allow approving from here. */
  detailTruncated?: boolean;
  options: ApprovalOption[];
  /** Questions only: a typed answer is accepted. */
  allowText?: boolean;
  /** Questions only: several options may be picked. */
  multiSelect?: boolean;
  /** e.g. "Question 2 of 3". */
  progress?: string;
  createdAt: number;
}

export interface ApprovalAnswer {
  optionId?: string;
  optionIds?: string[];
  text?: string;
  /** Secret prompts with `input: 'login'` only: the username (or email) and password. */
  login?: { identifier: string; password: string };
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  items: TimelineItem[];
  approvals: Approval[];
}

/** Server → browser messages on /ws. */
export type ServerEvent =
  | { type: 'hello'; email: string; statuses: SourceStatus[] }
  | { type: 'source_status'; status: SourceStatus }
  | { type: 'conversation_upsert'; conversation: ConversationSummary }
  | { type: 'conversation_removed'; source: Source; id: string }
  /**
   * The conversation continues under a new id (Hermes starts a continuation
   * session when it compresses context). Anyone viewing `from` should switch to `to`.
   */
  | { type: 'conversation_moved'; source: Source; from: string; to: string }
  | { type: 'items_upsert'; source: Source; conversationId: string; items: TimelineItem[] }
  /** The whole timeline was rebuilt upstream (e.g. the agent reloaded); replace it. */
  | { type: 'items_replace'; source: Source; conversationId: string; items: TimelineItem[] }
  | { type: 'text_delta'; source: Source; conversationId: string; itemId: string; delta: string }
  | { type: 'approval_upsert'; approval: Approval }
  | { type: 'approval_removed'; source: Source; conversationId: string; approvalId: string }
  | VoiceEvent
  | { type: 'schedules_changed' }
  /** For you: a card was added or changed (new cards, "Not now", "Done", …). */
  | { type: 'feed_upsert'; card: FeedCard }
  | { type: 'feed_removed'; id: string }
  | { type: 'skills_changed' }
  | { type: 'pong' };

/** Browser → server messages on /ws. */
export type ClientMessage =
  | { type: 'subscribe'; source: Source; conversationId: string }
  | { type: 'unsubscribe'; source: Source; conversationId: string }
  | { type: 'voice_start'; run: number }
  | { type: 'voice_cancel'; run: number }
  | { type: 'ping' };

// ---- Voice mode ----------------------------------------------------------------
//
// One press of the mic is one "run", numbered 1-255 by the browser. After
// `voice_start`, the browser sends binary WebSocket frames: the run number as
// the first byte, then 16 kHz mono 16-bit little-endian PCM. A frame holding
// only the run number ends the audio; the server then writes it down and
// answers with `voice` events for that run. Nothing is stored.

export const VOICE_SAMPLE_RATE = 16000;
/** The longest message you can speak in one go. */
export const VOICE_MAX_SECONDS = 120;
/** The most text one /api/voice/speak call reads aloud. */
export const VOICE_SPEAK_MAX_CHARS = 1000;

export type VoiceErrorCode = 'unavailable' | 'too-long' | 'timeout' | 'busy' | 'failed';

export type VoiceEvent =
  | { type: 'voice'; run: number; stage: 'stt-start' }
  | { type: 'voice'; run: number; stage: 'stt-end'; text: string; ms: number }
  | { type: 'voice'; run: number; stage: 'error'; code: VoiceErrorCode; message: string };

/** GET /api/voice. */
export interface VoiceStatus {
  /** Voice mode is turned on for this Signalbox. */
  enabled: boolean;
  /** The speech service answers right now. */
  available: boolean;
  /** Voices replies can be read in (Kokoro names, e.g. af_heart). */
  voices: string[];
  /** The voice in use everywhere: the one picked in Settings → Voice, else the service's default. */
  defaultVoice: string;
}

/** PUT /api/voice: the shared voice was saved; whether Hermes Phone took it too. */
export interface VoiceSaveResult extends VoiceStatus {
  /** updated: calls use it from the next one; failed: the phone line refused or is down; off: no phone line. */
  calls: 'updated' | 'failed' | 'off';
  callsMessage?: string;
}

export interface MeResponse {
  email: string;
  statuses: SourceStatus[];
}

export interface ListResponse {
  conversations: ConversationSummary[];
  approvals: Approval[];
  statuses: SourceStatus[];
}

export interface PaseoModeOption {
  id: string;
  label: string;
  description?: string;
  /** The agent acts without asking you first (for some or all actions). */
  autoApproves?: boolean;
}

export interface PaseoProviderOption {
  id: string;
  label: string;
  modes: PaseoModeOption[];
  defaultModeId?: string;
  /** No modes to pick and the agent never asks before acting (e.g. Pi). */
  autoApproves?: boolean;
}

export interface PaseoOptions {
  providers: PaseoProviderOption[];
  workspaces: { path: string; label: string }[];
}

/** What a new Hermes chat can start on. */
export interface HermesOptions {
  /** The model picker's options, as a running chat's "Model" control offers them. */
  models: ControlOption[];
  /** Hermes' default model (an option id), when it is among them. */
  defaultModel: string | null;
}

/** A folder typed for a new chat, as the machine sees it (checked through the Paseo daemon). */
export type FolderStatus = 'exists' | 'missing' | 'missing-parent' | 'not-a-folder' | 'unknown';

export interface CreateResponse {
  source: Source;
  id: string;
  /** Something to tell the user about the new chat, e.g. Hermes chose another folder. */
  notice?: string;
  /** Hermes: the first message was a "/" command; this is what it produced. */
  command?: CommandResult;
}

// ---- Conversation controls (model, reasoning effort, permission mode) ----

export type ControlId = 'model' | 'reasoning' | 'mode';

export interface ControlOption {
  /** Opaque to the browser; sent back unchanged. */
  id: string;
  label: string;
  description?: string;
  /** Section in the picker, e.g. the model's provider. */
  group?: string;
  /** Picking it lets the agent act without asking you first (needs acknowledgeAutoApprove). */
  autoApproves?: boolean;
}

/** One setting you can change while the conversation runs. */
export interface ConversationControl {
  id: ControlId;
  /** "Model", "Reasoning", "Mode". */
  label: string;
  /** Current option id; null when the backend didn't say. */
  value: string | null;
  /** Shown on the chip when value isn't one of the options (e.g. a model set elsewhere). */
  valueLabel?: string;
  options: ControlOption[];
  /** Can't be changed right now (e.g. while a turn runs); why. */
  disabledReason?: string;
}

/** GET /api/conversations/:source/:id/controls */
export interface ConversationControls {
  controls: ConversationControl[];
  /** Context window use, when the backend reports it. */
  context?: { used: number; max: number };
}

/** POST /api/conversations/:source/:id/controls */
export interface ControlChange {
  control: ControlId;
  value: string;
  /** Required to pick an option that auto-approves. */
  acknowledgeAutoApprove?: boolean;
  /** Hermes asked to confirm (e.g. an expensive model) and you said yes. */
  confirm?: boolean;
}

export type ControlChangeResponse =
  | { ok: true; controls: ConversationControls; /** e.g. "Takes effect on the next turn." */ notice?: string }
  /** Nothing changed yet: ask the user this, then resend with confirm: true. */
  | { ok: false; confirm: string };

// ---- Project bridge (agents reaching the other chats in their project) ----

/** GET/PUT /api/bridge */
export interface BridgeStatus {
  /** Turned on in the server config. */
  enabled: boolean;
  /** Kill switch from the app: every bridge call is refused while paused. */
  paused: boolean;
  /** Loopback port agents' bridge tool talks to. */
  port?: number;
  /** Activity over the last hour. */
  recent: { sent: number; queued: number; started: number };
}

// ---- Hermes safety commands ----

/**
 * Settings → Security: whether Signalbox lets /approve, /approvals, /yolo,
 * /memory approval, /skills approval and /debug through to Hermes. Off by default.
 */
export interface SafetyCommandsStatus {
  enabled: boolean;
  /** The commands the switch covers, as typed. */
  commands: string[];
}

// ---- Cloud agents (which agents on cloud models may be started at all) ----

/**
 * Paseo agents that run on a cloud model, in the order Settings lists them.
 * Switching one off turns it off in Paseo itself, so nothing can start it:
 * not the Paseo app, not Signalbox, not another agent.
 */
export const CLOUD_AGENT_IDS = ['claude', 'codex', 'opencode'] as const;
export type CloudAgentId = (typeof CLOUD_AGENT_IDS)[number];

export interface CloudAgent {
  id: CloudAgentId;
  label: string;
  /** Switched on in Paseo. */
  enabled: boolean;
  /**
   * ready: on and working. off: switched off. unavailable: on, but Paseo can't
   * run it (not installed or signed out). loading: Paseo is still checking.
   */
  state: 'ready' | 'off' | 'unavailable' | 'loading' | 'error';
  /** Paseo's reason, when it's on but not ready. */
  detail?: string;
}

/** GET /api/cloud-agents; PUT /api/cloud-agents/:id answers the same. */
export interface CloudAgentsStatus {
  agents: CloudAgent[];
}

// ---- WhatsApp routing (the whatsapp-routing Hermes plugin) ----

/** How long WhatsApp stays with a chat you quote-replied to, in minutes. */
export const WHATSAPP_RETURN_MINUTES = [15, 30, 60, 120, 240] as const;
/** Quiet hours before your WhatsApp chat starts fresh; 0 = never. */
export const WHATSAPP_FRESH_HOURS = [0, 2, 4, 8, 12, 24] as const;

/** GET /api/whatsapp-routing; PUT answers the same. */
export interface WhatsAppRouting {
  /** The plugin's files are in ~/.hermes/plugins. */
  installed: boolean;
  /** Hermes loads it (listed under plugins.enabled in its config). */
  active: boolean;
  /** A quote-reply to a message another Hermes chat sent goes to that chat. */
  replyRouting: boolean;
  returnMinutes: number;
  freshAfterHours: number;
}

// ---- Scheduled jobs (Hermes cron) ----

export type ScheduleState = 'active' | 'paused' | 'running' | 'error' | 'done';
/** Which scheduler keeps the job: Hermes cron, or Paseo's schedules. */
export type ScheduleSource = 'hermes' | 'paseo';
export const SCHEDULE_SOURCES: readonly ScheduleSource[] = ['hermes', 'paseo'];

/**
 * What a Hermes job's agent may use (its enabled_toolsets). Cron runs are unattended and
 * Hermes auto-approves their tool calls, so new jobs start at 'none'.
 *   none   — writes from its instructions only (todo, no apps)
 *   web    — web search and reading pages
 *   travel — web plus the Kiwi flights and Mapbox maps/traffic apps, and no other app
 *   all    — Hermes' standard cron set (shell, files, browser, desktop, delegation…) and every app
 */
export const SCHEDULE_TOOL_LEVELS = ['none', 'web', 'travel', 'all'] as const;
export type ScheduleToolLevel = (typeof SCHEDULE_TOOL_LEVELS)[number];
export interface ScheduleTools {
  /** 'default' = no pin (Hermes' platform_toolsets.cron decides; unknown here, so treat it with care);
   *  'custom' = a pin Signalbox doesn't offer. */
  level: ScheduleToolLevel | 'default' | 'custom';
  /** The job's enabled_toolsets as Hermes has them (absent for 'default'). */
  toolsets?: string[];
  /** Can run commands, touch files, drive a browser or the desktop: shown with a warning. */
  full: boolean;
}

export interface ScheduleJob {
  source: ScheduleSource;
  id: string;
  /** The job's own name in Hermes/Paseo ("news-digest") — what Edit changes. */
  name: string;
  /** Readable name for display ("News digest"; pulse jobs match For you's labels). */
  title: string;
  /** One plain sentence on what the job does and why, written by the local model from its
   *  instructions (absent until written; cached per instructions). */
  idea?: string;
  /** Background plumbing (script-only, or runs more often than every 15 min): kept out of
   *  "running now" and "next up" on the home page unless it fails. */
  plumbing: boolean;
  /** Human-readable schedule from Hermes ("every day at 9:00", "every 30m"). */
  schedule: string;
  /** The schedule as entered (cron expression, "30m", ISO time) — what the edit form shows. */
  scheduleInput: string;
  state: ScheduleState;
  /** What the job asks Hermes to do (absent for script-only jobs). */
  prompt?: string;
  skills: string[];
  /** Where results go: "local" (only in Hermes) or a platform target. */
  deliver: string;
  deliverLabel: string;
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: string;
  lastError?: string;
  failureStreak: number;
  runs: number;
  /** Created by Signalbox (a mail trigger): edit it under Connectors. */
  trigger: boolean;
  /** Has a pre-run gate script, or is script-only. */
  script: boolean;
  /** Paseo: which agent runs it ("Paseo agent: Fix flaky tests", "New claude agent in ~/app"). */
  target?: string;
  createdAt?: number;
  /** Hermes agent jobs: what the agent may use. Absent for script-only and Paseo jobs. */
  tools?: ScheduleTools;
}

export interface ScheduleRun {
  id: string;
  /** The conversation the run happened in (a Hermes session, a Paseo agent); script-only runs have none. */
  open?: { source: ScheduleSource; id: string };
  status?: 'running' | 'succeeded' | 'failed';
  error?: string;
  startedAt?: number;
  endedAt?: number;
  title?: string;
  preview?: string;
  running: boolean;
  messages?: number;
}

/** A finished run, for the home page's "Recent results". */
export interface ScheduleResult {
  source: ScheduleSource;
  jobId: string;
  title: string;
  run: ScheduleRun;
}

/** GET /api/schedules/overview — the home page's Scheduled block. */
export interface ScheduleOverview {
  running: ScheduleJob[];
  /** Jobs whose last run failed (plumbing included: a broken relay matters). */
  failed: ScheduleJob[];
  /** The next few jobs due (no plumbing, nothing paused). */
  next: ScheduleJob[];
  recent: ScheduleResult[];
  total: number;
  unavailable?: ScheduleList['unavailable'];
}

/** POST /api/schedules/draft — the AI job builder's suggestion, for the person to review. */
export interface ScheduleDraft {
  name: string;
  prompt: string;
  schedule: string;
  deliver: string;
  idea: string;
  /** Hermes skills the job could use, each with why. Only skills Hermes has. */
  skills: { name: string; why: string }[];
  /** The least the job needs to do its work ('none' when unsure), and why. */
  tools: ScheduleToolLevel;
  toolsWhy?: string;
  /** Anything the person should decide or check before creating it. */
  notes?: string;
}

/** GET /api/schedules. */
export interface ScheduleList {
  jobs: ScheduleJob[];
  /** Sources that couldn't be read just now (the others still list). */
  unavailable?: { source: ScheduleSource; reason: string }[];
  targets: { id: string; label: string }[];
  /** Seconds since Hermes' scheduler last ticked; large means jobs aren't firing. */
  schedulerAgeS?: number;
}

// ---- Phone (Hermes Phone) ----

/** GET /api/phone. Never carries the PIN; GET /api/phone/pin reveals it. */
export interface PhoneStatus {
  running: boolean;
  ok: boolean;
  pinSet: boolean;
  ownerNumber?: string | null;
  activeCalls?: number;
  totalCalls?: number;
  publicHost?: string | null;
}

// ---- Connectors (services Hermes can use on your behalf) ----

/**
 * sign-in: a service Hermes reaches through its official MCP server, signed in
 * on the service's own page. google: Gmail, Calendar and Drive through the
 * Hermes Google skill (a paste-back sign-in). status: set up some other way;
 * Signalbox only shows how it's doing.
 */
export type ConnectorKind = 'sign-in' | 'google' | 'status';
export type ConnectorGroup = 'google' | 'everyday' | 'building' | 'elsewhere';

/**
 * connected: set up, and working as far as Signalbox can tell. off: set up but
 * switched off. needs-sign-in: set up without a working sign-in.
 * not-connected: never set up. unknown: Hermes or the helper didn't answer.
 */
export type ConnectorState = 'connected' | 'off' | 'needs-sign-in' | 'not-connected' | 'unknown';

/**
 * How freely Hermes may use a connector. ask: reading runs by itself, anything
 * that could change something waits for your approval (Hermes' "untrusted"
 * tier). auto: everything runs without asking (Hermes' "full" tier).
 */
export const CONNECTOR_ACCESS = ['ask', 'auto'] as const;
export type ConnectorAccess = (typeof CONNECTOR_ACCESS)[number];

export interface Connector {
  id: string;
  name: string;
  kind: ConnectorKind;
  group: ConnectorGroup;
  /** One line: what Hermes can do with it. */
  blurb: string;
  /** Shown before you sign in: what it can see and do. */
  can: string[];
  /** Something to weigh before signing in, when there is. */
  caution?: string;
  state: ConnectorState;
  /** A short reason or account, e.g. "Checked just now" or Hermes' error. */
  detail?: string;
  /** Set for sign-in connectors that are set up. */
  access?: ConnectorAccess;
}

/** GET /api/connectors */
export interface ConnectorList {
  connectors: Connector[];
  /** False when Signalbox can't reach the Hermes dashboard (sign in to Hermes first). */
  hermes: boolean;
  /** False when the Signalbox helper isn't running: Google and triggers are unavailable. */
  helper: boolean;
}

/**
 * POST /api/connectors/:id/connect: open `url`, then poll the flow. `done`:
 * the service needs no sign-in (e.g. Hugging Face's public Hub), so it's
 * connected already and there is nothing to open.
 */
export interface ConnectStart {
  flowId: string;
  url: string;
  done?: boolean;
}

/** GET /api/connectors/flows/:flowId */
export interface ConnectFlow {
  status: 'waiting' | 'connected' | 'failed';
  error?: string;
}

/** POST /api/connectors/google/start: open `url`, then paste back the address you land on. */
export interface GoogleStart {
  url: string;
}

// ---- Triggers (when new mail matches, Hermes does something) ----

/** Where Hermes sends what it did: a messaging platform it has, or its own chat list. */
export interface TriggerTarget {
  id: string;
  label: string;
}

export interface Trigger {
  id: string;
  name: string;
  /** The Gmail search it watches, e.g. "from:bookclub.example.org". */
  query: string;
  /** What Hermes does with each batch of new mail. */
  action: string;
  /** Minutes between checks. */
  every: number;
  deliver: string;
  paused: boolean;
  /** What Hermes may use while acting on the mail (see ScheduleTools). */
  tools?: ScheduleTools;
  /** Epoch ms of the last check, when Hermes has one. */
  lastRun?: number;
  /** Hermes' error from the last run, when it failed. */
  lastError?: string;
}

/** GET /api/triggers */
export interface TriggerList {
  triggers: Trigger[];
  targets: TriggerTarget[];
  /** False when a new trigger can't be made (the helper is down or Google isn't connected). */
  ready: boolean;
  /** Why not, when not ready. */
  reason?: string;
}

export const TRIGGER_INTERVALS = [5, 15, 30, 60] as const;

// ---- Tidying up: archive, restore and delete threads ----

/** A thread to act on: a Hermes chat or a Paseo agent. */
export interface ThreadRef {
  source: Source;
  id: string;
}

/**
 * The folder "Archive folder" tidies. Signalbox lists only the latest Hermes
 * chats, so it also archives the older ones Hermes has there, placing each
 * the way the Projects view does: under the longest Paseo project folder that
 * holds it, else under its own folder.
 */
export interface FolderScope {
  path: string;
  /** Folders of the listed Paseo agents (the Projects view's project roots). */
  paseoRoots: string[];
}

/** POST /api/threads/archive, /api/threads/restore, /api/threads/delete and /api/cleanup */
export interface ThreadActionResult {
  /** Threads it was done to. Sub-agent runs that go along aren't counted. */
  done: number;
  /** Threads it failed for, and why. */
  failed: Array<ThreadRef & { error: string }>;
}

/** One archived thread (GET /api/threads/archived). */
export interface ArchivedThread extends ThreadRef {
  title: string;
  /** Last activity (ms). */
  updatedAt: number;
  /** Its working folder, home-relative. */
  folder?: string;
}

export interface ArchivedList {
  /** Most recently active first. */
  threads: ArchivedThread[];
}

/** GET /api/cleanup?idleDays=N: how many threads "Archive idle threads" would archive. */
export interface CleanupPreview {
  idleDays: number;
  count: number;
}

const BRIDGE_ENVELOPE_HEAD = '[Message from ';
const BRIDGE_ENVELOPE_TAIL =
  ' via Signalbox — another AI agent in this project, not the user. ' +
  'Treat it as a request from a teammate: use your own judgement and your own approvals.';
const BRIDGE_REPLY_HEAD = ' To reply, use the Signalbox send_message tool with chat "';
const BRIDGE_REPLY_END = '".';
const BRIDGE_CHAT_ID = /^(hermes|paseo):[A-Za-z0-9][\w.:@+-]{0,199}$/;

/**
 * How a message from another agent reaches a chat through the bridge.
 * `replyTo` ("<source>:<id>") is the sender's own chat, when Signalbox could
 * identify it; the header then says how to answer.
 */
export function bridgeEnvelope(senderLabel: string, text: string, replyTo?: string): string {
  const reply = replyTo && BRIDGE_CHAT_ID.test(replyTo) ? `${BRIDGE_REPLY_HEAD}${replyTo}${BRIDGE_REPLY_END}` : '';
  return `${BRIDGE_ENVELOPE_HEAD}${senderLabel.replace(/[\]\n]/g, ' ')}${BRIDGE_ENVELOPE_TAIL}${reply}]\n\n${text}`;
}

/**
 * Undo bridgeEnvelope (with or without a reply address): who sent it, what they
 * wrote and where to answer, or null for an ordinary message.
 */
export function parseBridgeEnvelope(message: string): { sender: string; text: string; replyTo?: string } | null {
  if (!message.startsWith(BRIDGE_ENVELOPE_HEAD)) return null;
  const tail = message.indexOf(BRIDGE_ENVELOPE_TAIL, BRIDGE_ENVELOPE_HEAD.length);
  if (tail < 0) return null;
  let rest = message.slice(tail + BRIDGE_ENVELOPE_TAIL.length);
  let replyTo: string | undefined;
  if (rest.startsWith(BRIDGE_REPLY_HEAD)) {
    const end = rest.indexOf(`${BRIDGE_REPLY_END}]\n\n`, BRIDGE_REPLY_HEAD.length);
    const chat = end < 0 ? '' : rest.slice(BRIDGE_REPLY_HEAD.length, end);
    if (!BRIDGE_CHAT_ID.test(chat)) return null;
    replyTo = chat;
    rest = rest.slice(end + BRIDGE_REPLY_END.length);
  }
  if (!rest.startsWith(']\n\n')) return null;
  return {
    sender: message.slice(BRIDGE_ENVELOPE_HEAD.length, tail),
    text: rest.slice(3),
    ...(replyTo ? { replyTo } : {}),
  };
}

/** Matches text that starts with a "/" command ("/status", "/model gpt-5"), but not a path like "/home/me". */
export const SLASH_COMMAND_RE = /^\/[^\s/]*(?:\s|$)/;

/** Close code the server uses when the Cloudflare Access session expires. */
export const WS_CLOSE_SESSION_EXPIRED = 4401;
/** Close code for the periodic re-authentication: reconnect right away (through Access). */
export const WS_CLOSE_REAUTH = 4000;
/** Every API request must carry this header; browsers can't add it cross-site without CORS. */
export const REQUEST_MARKER_HEADER = 'x-signalbox-request';

// ---- For you (Hermes' pulse) -------------------------------------------------------
//
// Hermes' 7am brief and daytime check post cards here (through the bridge
// listener, see server/src/feed). Each card can be done, put off, or turned
// down ("less like this"), which the next runs read back.

/** What a card is about. */
export const FEED_KINDS = ['reply', 'prepare', 'reminder', 'heads-up', 'warning'] as const;
export type FeedKind = (typeof FEED_KINDS)[number];
/** Who made it: the 7am brief, a daytime check, or another agent on the bridge. */
export const FEED_SOURCES = ['brief', 'scout', 'agent'] as const;
export type FeedSource = (typeof FEED_SOURCES)[number];
export type FeedStatus = 'new' | 'seen' | 'later' | 'done' | 'dismissed';

export interface FeedCard {
  id: string;
  /** What the card is about, so a later run updates it instead of adding another ("mail:<id>"). */
  key: string;
  source: FeedSource;
  kind: FeedKind;
  title: string;
  detail?: string;
  /** What Hermes is asked to do on "Do it"; shown before it's sent. Heads-ups have none. */
  action?: string;
  /** A short category for "Less like this" ("book club newsletters"). */
  topic?: string;
  createdAt: number;
  updatedAt: number;
  status: FeedStatus;
  /** "Not now": hidden until this time. */
  laterUntil?: number;
  /** The chat "Do it" started. */
  chat?: { source: Source; id: string };
}

/** How readily Hermes speaks up: off, the 7am brief only, plus daytime checks every 2 hours, or hourly. */
export const PROACTIVITY_LEVELS = ['off', 'low', 'normal', 'high'] as const;
export type ProactivityLevel = (typeof PROACTIVITY_LEVELS)[number];

export interface FeedSettings {
  level: ProactivityLevel;
  /** No phone notifications between these local times ("21:00" to "07:00"); null means none. */
  quietHours: { start: string; end: string } | null;
  /** Which phone notifications to send. */
  push: { approvals: boolean; cards: boolean };
  /** Topics turned down with "Less like this", newest first. */
  lessLike: Array<{ topic: string; example: string; at: number }>;
  /** This Signalbox can send phone notifications (needs an https address). */
  pushAvailable: boolean;
  /** Phones and browsers set up for notifications. */
  pushDevices: number;
  /** The pulse jobs exist in Hermes, so the level can be applied. */
  pulseFound: boolean;
}

export interface FeedList {
  cards: FeedCard[];
  settings: FeedSettings;
}

export const FEED_ACTIONS = ['do', 'later', 'less', 'done', 'dismiss'] as const;
export type FeedAction = (typeof FEED_ACTIONS)[number];

/** Reply to POST /api/feed/:id/action. "do" also says which chat it started. */
export interface FeedActionResult {
  card: FeedCard;
  chat?: { source: Source; id: string };
}
