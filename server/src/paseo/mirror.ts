import type { DaemonClient, FetchAgentTimelinePayload } from '@getpaseo/client/internal/daemon-client';
import type { AgentTimelineItem } from '@getpaseo/protocol/agent-types';
import type { SessionOutboundMessage } from '@getpaseo/protocol/messages';

// Keeps one agent's timeline in sync: projected tail on load, live events gated
// on (epoch, seq), canonical catch-up on gaps/reconnects, full reload when the
// epoch changes. Adapted from the Paseo 0.5.1 app's reconciliation rules.

export type AgentStreamMsg = Extract<SessionOutboundMessage, { type: 'agent_stream' }>['payload'];
export type AgentStreamEvent = AgentStreamMsg['event'];
type TimelineEntry = FetchAgentTimelinePayload['entries'][number];

export interface MirrorRow {
  key: string;
  item: AgentTimelineItem;
  turnId?: string;
  timestamp: string;
  seqStart: number;
  seqEnd: number;
}

export interface MirrorSink {
  /** Replace everything (first load, epoch change, reset). */
  reset(rows: readonly MirrorRow[]): void;
  /** A row was added or changed. */
  upsert(row: MirrorRow): void;
  /** Text was appended to an assistant/reasoning row. */
  append(row: MirrorRow, delta: string): void;
  /** turn_started / turn_failed / turn_canceled / … */
  status(event: AgentStreamEvent, timestamp: string): void;
  failure(error: unknown): void;
}

export class AgentTimelineMirror {
  rows: MirrorRow[] = [];
  lastUsed = Date.now();
  private cursor: { epoch: string; startSeq: number; endSeq: number } | null = null;
  private baselineReady = false;
  private buffered: AgentStreamMsg[] = [];
  private catchingUp = false;
  private liveCounter = 0;

  constructor(
    private readonly client: DaemonClient,
    readonly agentId: string,
    private readonly sink: MirrorSink,
  ) {}

  get loaded(): boolean {
    return this.baselineReady;
  }

  /**
   * Note: loading a stored agent's timeline makes Paseo resume that agent.
   * Returns the agent as Paseo reported it with the page.
   */
  async loadTail(limit = 120): Promise<FetchAgentTimelinePayload['agent']> {
    const page = await this.client.fetchAgentTimeline(this.agentId, {
      direction: 'tail',
      limit,
      projection: 'projected',
      timeout: 90_000,
    });
    this.replaceWith(page);
    return page.agent ?? null;
  }

  handleLive(message: AgentStreamMsg): void {
    if (message.agentId !== this.agentId) return;
    const { event } = message;
    if (event.type !== 'timeline') {
      this.sink.status(event, message.timestamp);
      return;
    }
    if (typeof message.seq !== 'number' || typeof message.epoch !== 'string') {
      // Live-only progress rows are not part of history and never move the cursor.
      if (this.baselineReady) {
        this.apply({
          item: event.item,
          ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
          timestamp: message.timestamp,
          seqStart: -1,
          seqEnd: -1,
        }, '');
      }
      return;
    }
    if (!this.baselineReady || this.catchingUp) {
      this.buffered.push(message);
      return;
    }
    this.applySequenced(message);
  }

  /** Fetch canonical rows after the cursor; call after every reconnect. */
  async catchUp(): Promise<void> {
    const cursor = this.cursor;
    if (this.catchingUp || !cursor) return;
    this.catchingUp = true;
    try {
      const page = await this.client.fetchAgentTimeline(this.agentId, {
        direction: 'after',
        cursor: { epoch: cursor.epoch, seq: cursor.endSeq },
        limit: 0,
        projection: 'canonical',
        timeout: 90_000,
      });
      if (page.reset || page.epoch !== cursor.epoch) {
        await this.reloadNow();
      } else {
        for (const entry of page.entries) {
          if (entry.seqStart <= cursor.endSeq) continue;
          cursor.endSeq = entry.seqEnd;
          this.apply(toRowInput(entry), page.epoch);
        }
      }
    } finally {
      this.catchingUp = false;
    }
    this.drainBuffer();
  }

  private applySequenced(message: AgentStreamMsg): void {
    const { event, seq, epoch } = message;
    if (event.type !== 'timeline' || typeof seq !== 'number' || typeof epoch !== 'string') return;
    const cursor = this.cursor;
    if (!cursor) {
      this.cursor = { epoch, startSeq: seq, endSeq: seq };
    } else if (cursor.epoch !== epoch) {
      this.background(this.reload()); // agent was reloaded → new epoch
      return;
    } else if (seq <= cursor.endSeq) {
      return; // already part of a fetched page
    } else if (seq > cursor.endSeq + 1) {
      this.background(this.catchUp()); // gap
      return;
    } else {
      cursor.endSeq = seq;
    }
    this.apply(
      {
        item: event.item,
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        timestamp: message.timestamp,
        seqStart: seq,
        seqEnd: seq,
      },
      epoch,
    );
  }

  private async reload(): Promise<void> {
    if (this.catchingUp) return;
    this.catchingUp = true;
    try {
      await this.reloadNow();
    } finally {
      this.catchingUp = false;
    }
    this.drainBuffer();
  }

  private async reloadNow(): Promise<void> {
    const page = await this.client.fetchAgentTimeline(this.agentId, {
      direction: 'tail',
      limit: 120,
      projection: 'projected',
      timeout: 90_000,
    });
    this.replaceWith(page);
  }

  private replaceWith(page: FetchAgentTimelinePayload): void {
    this.rows = [];
    for (const entry of page.entries) this.merge(toRowInput(entry), page.epoch);
    this.cursor =
      page.endCursor && page.startCursor
        ? { epoch: page.epoch, startSeq: page.startCursor.seq, endSeq: page.endCursor.seq }
        : { epoch: page.epoch, startSeq: page.window.nextSeq, endSeq: page.window.nextSeq - 1 };
    this.baselineReady = true;
    this.sink.reset(this.rows);
    this.drainBuffer();
  }

  private drainBuffer(): void {
    if (this.catchingUp) return;
    const pending = this.buffered;
    this.buffered = [];
    for (const message of pending) this.applySequenced(message);
  }

  private background(task: Promise<void>): void {
    task.catch((error: unknown) => this.sink.failure(error));
  }

  private apply(input: Omit<MirrorRow, 'key'>, epoch: string): void {
    const { row, delta } = this.merge(input, epoch);
    if (delta) this.sink.append(row, delta);
    else this.sink.upsert(row);
  }

  /** Same rules as Paseo's projection: join text chunks, collapse tool lifecycles, dedupe user echoes. */
  private merge(input: Omit<MirrorRow, 'key'>, epoch: string): { row: MirrorRow; delta?: string } {
    const last = this.rows.at(-1);
    const { item } = input;

    if (
      item.type === 'assistant_message' &&
      last?.item.type === 'assistant_message' &&
      last.turnId === input.turnId &&
      (item.messageId === undefined || item.messageId === last.item.messageId)
    ) {
      last.item = { ...last.item, text: last.item.text + item.text };
      last.seqEnd = Math.max(last.seqEnd, input.seqEnd);
      last.timestamp = input.timestamp;
      return { row: last, delta: item.text };
    }
    if (item.type === 'reasoning' && last?.item.type === 'reasoning' && last.turnId === input.turnId) {
      last.item = { ...last.item, text: last.item.text + item.text };
      last.seqEnd = Math.max(last.seqEnd, input.seqEnd);
      last.timestamp = input.timestamp;
      return { row: last, delta: item.text };
    }
    if (item.type === 'tool_call') {
      const existing = this.rows.find((r) => r.item.type === 'tool_call' && r.item.callId === item.callId);
      if (existing && existing.item.type === 'tool_call') {
        const detail =
          item.detail.type === 'unknown' && existing.item.detail.type !== 'unknown' ? existing.item.detail : item.detail;
        existing.item = { ...existing.item, ...item, detail } as AgentTimelineItem;
        existing.seqEnd = Math.max(existing.seqEnd, input.seqEnd);
        existing.timestamp = input.timestamp;
        return { row: existing };
      }
    }
    if (item.type === 'user_message' && item.clientMessageId) {
      const existing = this.rows.find(
        (r) => r.item.type === 'user_message' && r.item.clientMessageId === item.clientMessageId,
      );
      if (existing) {
        Object.assign(existing, input, { key: existing.key });
        return { row: existing };
      }
    }

    const key =
      item.type === 'tool_call'
        ? `tc-${item.callId}`
        : input.seqStart >= 0
          ? `s-${epoch}-${input.seqStart}`
          : `l-${++this.liveCounter}`;
    const row: MirrorRow = { key, ...input };
    this.rows.push(row);
    return { row };
  }
}

function toRowInput(entry: TimelineEntry): Omit<MirrorRow, 'key'> {
  return {
    item: entry.item,
    ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
    timestamp: entry.timestamp,
    seqStart: entry.seqStart,
    seqEnd: entry.seqEnd,
  };
}
