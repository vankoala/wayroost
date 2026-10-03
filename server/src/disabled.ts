import type {
  Approval,
  ConversationDetail,
  ConversationSummary,
  FolderStatus,
  HermesOptions,
  PaseoOptions,
  SlashCommand,
  Source,
  SourceStatus,
} from '../../shared/protocol.js';
import { UserFacingError, type CreateResult, type HermesSource, type PaseoSource } from './sources.js';

// Stand-in for a source turned off in the config (Hermes-only or Paseo-only setups).

const NAMES: Record<Source, string> = { hermes: 'Hermes', paseo: 'Paseo' };

class DisabledSource {
  constructor(private readonly source: Source) {}

  status(): SourceStatus {
    return { source: this.source, state: 'disabled' };
  }
  async listConversations(): Promise<ConversationSummary[]> {
    return [];
  }
  listApprovals(): Approval[] {
    return [];
  }
  setWatching(): void {}
  start(): void {}
  stop(): void {}

  protected off(): never {
    throw new UserFacingError(`${NAMES[this.source]} isn't enabled in this Wayroost.`, 404);
  }
  async getConversation(): Promise<ConversationDetail> {
    return this.off();
  }
  async sendMessage(): Promise<void> {
    this.off();
  }
  async interrupt(): Promise<void> {
    this.off();
  }
  async respondToApproval(): Promise<void> {
    this.off();
  }
  async listCommands(): Promise<SlashCommand[]> {
    return this.off();
  }
}

export class DisabledHermes extends DisabledSource implements HermesSource {
  constructor() {
    super('hermes');
  }
  async createConversation(): Promise<CreateResult> {
    return this.off();
  }
  async listNewChatCommands(): Promise<SlashCommand[]> {
    return this.off();
  }
  async newChatOptions(): Promise<HermesOptions> {
    return this.off();
  }
  async setCredentials(): Promise<SourceStatus> {
    return this.off();
  }
  async clearCredentials(): Promise<SourceStatus> {
    return this.off();
  }
}

export class DisabledPaseo extends DisabledSource implements PaseoSource {
  constructor() {
    super('paseo');
  }
  async folderStatus(): Promise<FolderStatus> {
    return 'unknown';
  }
  async createFolder(): Promise<string> {
    return this.off();
  }
  async options(): Promise<PaseoOptions> {
    return this.off();
  }
  async createConversation(): Promise<string> {
    return this.off();
  }
}
