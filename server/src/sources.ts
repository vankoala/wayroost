import type { Attachment } from './attachments.js';
import type { MediaFile } from './media.js';
import type {
  Approval,
  ApprovalAnswer,
  ArchivedThread,
  CloudAgentId,
  CloudAgentsStatus,
  CommandResult,
  ControlChange,
  ControlChangeResponse,
  ConversationControls,
  ConversationDetail,
  ConversationSummary,
  FolderScope,
  FolderStatus,
  HermesOptions,
  PaseoOptions,
  SlashCommand,
  Source,
  SourceStatus,
  ThreadActionResult,
} from '../../shared/protocol.js';

/** Do `act` to each thread in turn, counting what worked and saying why the rest failed. */
export async function eachThread(
  source: Source,
  ids: readonly string[],
  act: (id: string) => Promise<unknown>,
): Promise<ThreadActionResult> {
  const result: ThreadActionResult = { done: 0, failed: [] };
  for (const id of ids) {
    try {
      await act(id);
      result.done += 1;
    } catch (err) {
      result.failed.push({ source, id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** An error whose message is safe to show in the UI. */
export class UserFacingError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

export interface ConversationSource {
  status(): SourceStatus;
  listConversations(): Promise<ConversationSummary[]>;
  /** Approvals currently waiting on the user, across all conversations. */
  listApprovals(): Approval[];
  getConversation(id: string): Promise<ConversationDetail>;
  /**
   * Send a message. For Hermes, "/" text without attachments is run as a
   * command instead, and what it produced is returned.
   */
  sendMessage(id: string, text: string, attachments?: Attachment[]): Promise<CommandResult | void>;
  interrupt(id: string): Promise<void>;
  respondToApproval(conversationId: string, approvalId: string, answer: ApprovalAnswer): Promise<void>;
  /** The "/" commands and skills this conversation offers. */
  listCommands(id: string): Promise<SlashCommand[]>;
  /**
   * Bytes of an image an agent showed in this conversation, read by the
   * backend (which runs as you and applies its own path rules).
   */
  readImage?(id: string, path: string): Promise<MediaFile>;
  /** Model, reasoning effort and mode, with what each can be changed to. */
  getControls?(id: string): Promise<ConversationControls>;
  setControl?(id: string, change: ControlChange): Promise<ControlChangeResponse>;
  /** Called when the first browser opens / the last browser closes a conversation. */
  setWatching?(id: string, watching: boolean): void;
  /**
   * Archive threads in the backend itself, so its own app hides them too.
   * `folder`: also archive the older chats there that the inbox doesn't list.
   */
  archiveThreads?(ids: string[], folder?: FolderScope): Promise<ThreadActionResult>;
  /** Bring archived threads back. */
  restoreThreads?(ids: string[]): Promise<ThreadActionResult>;
  /** Delete threads for good. */
  deleteThreads?(ids: string[]): Promise<ThreadActionResult>;
  /** Archived threads, most recently active first. */
  listArchived?(limit: number): Promise<ArchivedThread[]>;
  /**
   * Threads last active before `before` (ms): every one the backend has, not
   * only those the inbox lists, and never one that's working or waiting on you.
   */
  idleThreads?(before: number): Promise<string[]>;
}

export interface CreateResult {
  id: string;
  /** The first message was a "/" command; this is what it produced. */
  command?: CommandResult;
  /** Something to tell the user, e.g. Hermes started the chat in another folder. */
  notice?: string;
}

/** The chat that started another one through the Signalbox bridge. */
export type StartedBy = NonNullable<ConversationSummary['startedBy']>;

/** Extras when the Signalbox bridge starts a chat on another agent's behalf. */
export interface BridgeCreateOptions {
  /** Shown on the new chat's summary, so the app can show where it came from. */
  startedBy?: StartedBy;
  /** Set as the chat's title right away (otherwise it's titled from the bridge envelope). */
  title?: string;
}

/** Choices for a new Hermes chat: the bridge's extras, and the model the user picked. */
export interface HermesCreateOptions extends BridgeCreateOptions {
  /** A model option id from `newChatOptions`, set for this chat only. */
  model?: string;
  /** The user accepted the model's cost (Hermes asks before an expensive model). */
  confirmModel?: boolean;
}

export interface HermesSource extends ConversationSource {
  createConversation(
    text: string,
    cwd?: string,
    attachments?: Attachment[],
    options?: HermesCreateOptions,
  ): Promise<CreateResult>;
  /** Commands and skills for a chat that doesn't exist yet. */
  listNewChatCommands(): Promise<SlashCommand[]>;
  /** The models a new chat can start on, and Hermes' default. */
  newChatOptions(): Promise<HermesOptions>;
  setCredentials(username: string, password: string): Promise<SourceStatus>;
  clearCredentials(): Promise<SourceStatus>;
}

export interface CreatePaseoAgentInput {
  providerId: string;
  cwd: string;
  modeId?: string;
  text: string;
  /** Required when the chosen agent/mode acts without asking first. */
  acknowledgeAutoApprove?: boolean;
  attachments?: Attachment[];
  /** Bridge only: Paseo labels for the new agent (e.g. its parent agent). */
  labels?: Record<string, string>;
  /** Bridge only: the new agent's title (Paseo takes up to 200 characters). */
  title?: string;
  /** Bridge only: the chat that asked for this agent. */
  startedBy?: StartedBy;
}

export interface PaseoSource extends ConversationSource {
  options(): Promise<PaseoOptions>;
  createConversation(input: CreatePaseoAgentInput): Promise<string>;
  /** Whether a folder exists, as the Paseo daemon (running as the owner) sees it. */
  folderStatus(path: string): Promise<FolderStatus>;
  /** Create a new folder, one level below an existing one; Paseo also lists it as a project. */
  createFolder(path: string): Promise<string>;
  /** Settings → Cloud agents. Absent where the backend can't switch agents. */
  cloudAgents?(): Promise<CloudAgentsStatus>;
  /** Switch a cloud agent on or off in Paseo itself, for everyone. */
  setCloudAgentEnabled?(id: CloudAgentId, enabled: boolean): Promise<CloudAgentsStatus>;
}

export interface Sources {
  hermes: HermesSource;
  paseo: PaseoSource;
}
