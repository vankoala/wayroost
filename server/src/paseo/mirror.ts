import type { DaemonClient, FetchAgentTimelinePayload } from '@getpaseo/client/internal/daemon-client';
import type { AgentTimelineItem } from '@getpaseo/protocol/agent-types';
import type { SessionOutboundMessage } from '@getpaseo/protocol/messages';
import { shadowBackground, type BackgroundGate } from '../background.js';
import { withDeviceSignal } from '../security/device-signal.js';

// Keeps one agent's timeline in sync: projected tail on load, live events gated
// on (epoch, seq), projected catch-up on gaps/reconnects, full reload when the
// epoch changes. Fetched rows are cumulative snapshots; live text is a delta.

export type AgentStreamMsg = Extract<SessionOutboundMessage, { type: 'agent_stream' }>['payload'];
export type AgentStreamEvent = AgentStreamMsg['event'];
type TimelineEntry = FetchAgentTimelinePayload['entries'][number];

/** What `DaemonClient.subscribeAgentTimeline` delivers. */
type TimelineMessage =
  | { type: 'agent_stream'; payload: AgentStreamMsg }
  | { type: 'agent.timeline.replacement'; payload: { agentId: string; epoch: string } }
  | { type: 'agent.timeline.subscription_restored'; payload: { agentId: string; subscriptionId: string } }
  | { type: 'agent.timeline.error'; payload: { agentId: string; error: string } };

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
  /**
   * Since Paseo 0.9.2, an agent streams its timeline only to clients that
   * subscribed to it; the mirror owns that subscription for its lifetime.
   */
  private readonly unsubscribe: ReturnType<DaemonClient['subscribeAgentTimeline']>;
  private readonly liveReady: Promise<void>;
  private cursor: { epoch: string; startSeq: number; endSeq: number } | null = null;
  private baselineReady = false;
  private needsRefresh = false;
  private buffered: AgentStreamMsg[] = [];
  private catchingUp = false;
  private tailReads = 0;
  private requestCounter = 0;
  private replacementVersion = 0;
  private reloadPending = false;
  private liveCounter = 0;
  private closed = false;
  private failureReason: unknown;

  constructor(
    private readonly client: DaemonClient,
    readonly agentId: string,
    private readonly sink: MirrorSink,
    /** Unattended reloads and catch-ups run only on the primary; a shadow waits for the next open. */
    private readonly background: BackgroundGate = shadowBackground,
  ) {
    this.unsubscribe = client.subscribeAgentTimeline(this.agentId, (message) => withDeviceSignal(undefined, () => this.onTimeline(message)));
    this.liveReady = this.unsubscribe.ready;
  }

  get loaded(): boolean {
    return this.baselineReady && !this.needsRefresh;
  }

  /** Drops the timeline subscription. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.baselineReady = false;
    this.buffered = [];
    withDeviceSignal(undefined, () => this.unsubscribe());
  }

  private assertOpen(): void {
    if (this.closed) throw this.failureReason ?? new Error('Timeline subscription closed');
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.failureReason = error;
    this.close();
    this.sink.failure(error);
  }

  /** Shared catch-up and reloads never inherit the device that triggered them. */
  private runBackground<T>(work: () => T): T | undefined {
    return this.background.run(() => withDeviceSignal(undefined, work));
  }

  private onTimeline(message: TimelineMessage): void {
    if (this.closed) return;
    if (message.type === 'agent_stream') {
      this.handleLive(message.payload);
    } else if (message.type === 'agent.timeline.replacement') {
      // The agent was reloaded: its history is gone, and with it the epoch. A
      // shadow doesn't fetch it again on its own; the next open does.
      if (this.runBackground(() => { this.follow(this.reload()); return true; })) return;
      this.invalidateReplacement();
      this.needsRefresh = true;
      this.rows = [];
      this.sink.reset(this.rows);
    } else if (message.type === 'agent.timeline.subscription_restored') {
      // Live delivery came back after a reconnect; history may have been missed.
      if (this.baselineReady) this.follow(this.catchUp());
    } else if (message.type === 'agent.timeline.error') {
      this.fail(new Error(message.payload.error));
    }
  }

  /**
   * Note: loading a stored agent's timeline makes Paseo resume that agent.
   * Returns the agent as Paseo reported it with the page.
   */
  async loadTail(limit = 120, client = this.client): Promise<FetchAgentTimelinePayload['agent']> {
    // Only after the daemon confirmed the subscription do streamed events get
    // buffered and applied on top of the page.
    await this.liveReady;
    this.assertOpen();
    this.tailReads += 1;
    try {
      const page = await this.loadCurrentTail(limit, client);
      this.assertOpen();
      return page?.agent ?? null;
    } finally {
      this.tailReads -= 1;
      this.drainBuffer();
    }
  }

  handleLive(message: AgentStreamMsg): void {
    if (this.closed || message.agentId !== this.agentId) return;
    const { event } = message;
    if (event.type !== 'timeline') {
      this.sink.status(event, message.timestamp);
      return;
    }
    if (this.tailReads) {
      // An epoch change still invalidates an in-flight shadow read immediately.
      if (this.background.role === 'shadow' && this.baselineReady && this.cursor &&
          typeof message.seq === 'number' && typeof message.epoch === 'string' && this.cursor.epoch !== message.epoch) {
        this.applySequenced(message);
      } else {
        this.buffered.push(message);
      }
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

  /** Reconcile projected snapshots after the cursor; call after every reconnect. */
  async catchUp(): Promise<void> {
    this.assertOpen();
    const task = this.runBackground(() => this.catchUpNow());
    if (task) await task;
    else this.needsRefresh = this.baselineReady;
  }

  private async catchUpNow(): Promise<void> {
    const cursor = this.cursor;
    if (this.catchingUp || !cursor) return;
    this.catchingUp = true;
    const version = this.replacementVersion;
    const request = ++this.requestCounter;
    try {
      let page: FetchAgentTimelinePayload | undefined;
      try {
        page = await this.client.fetchAgentTimeline(this.agentId, {
          direction: 'after',
          cursor: { epoch: cursor.epoch, seq: cursor.endSeq },
          limit: 0,
          projection: 'projected',
          timeout: 90_000,
        });
      } catch (error) {
        // A replacement also invalidates errors from the old history request.
        if (request === this.requestCounter && version === this.replacementVersion) throw error;
      }
      this.assertOpen();
      if (request !== this.requestCounter) return;
      if (!page || version !== this.replacementVersion || this.reloadPending || page.reset || page.epoch !== cursor.epoch) {
        if (!await this.reloadNow()) return;
      } else {
        for (const entry of page.entries) {
          this.applySnapshot(toRowInput(entry), page.epoch);
        }
        cursor.endSeq = Math.max(cursor.endSeq, page.endCursor?.seq ?? cursor.endSeq);
      }
      while (this.reloadPending) {
        if (!await this.reloadNow()) return;
      }
    } finally {
      this.catchingUp = false;
      this.drainBuffer();
    }
  }

  private applySequenced(message: AgentStreamMsg): void {
    const { event, seq, epoch } = message;
    if (event.type !== 'timeline' || typeof seq !== 'number' || typeof epoch !== 'string') return;
    const cursor = this.cursor;
    if (!cursor) {
      this.cursor = { epoch, startSeq: seq, endSeq: seq };
    } else if (cursor.epoch !== epoch) {
      if (this.runBackground(() => { this.follow(this.reload()); return true; })) return;
      this.invalidateReplacement();
      this.needsRefresh = true;
      this.rows = [];
      this.sink.reset(this.rows);
      this.cursor = { epoch, startSeq: seq, endSeq: seq };
    } else if (seq <= cursor.endSeq) {
      return; // already part of a fetched page
    } else if (seq > cursor.endSeq + 1) {
      if (this.runBackground(() => { this.follow(this.catchUp()); return true; })) return;
      this.needsRefresh = true;
      cursor.endSeq = seq;
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

  private invalidateReplacement(): void {
    this.replacementVersion += 1;
    this.reloadPending = true;
    this.baselineReady = false;
    this.buffered = [];
  }

  private async reload(): Promise<void> {
    this.invalidateReplacement();
    if (this.catchingUp) return;
    this.catchingUp = true;
    try {
      do {
        if (!await this.reloadNow()) break;
      } while (this.reloadPending);
    } finally {
      this.catchingUp = false;
      this.drainBuffer();
    }
  }

  private async reloadNow(): Promise<FetchAgentTimelinePayload | null> {
    this.baselineReady = false;
    return this.loadCurrentTail(120);
  }

  private async loadCurrentTail(limit: number, client = this.client): Promise<FetchAgentTimelinePayload | null> {
    for (;;) {
      this.assertOpen();
      const version = this.replacementVersion;
      const request = ++this.requestCounter;
      try {
        const page = await client.fetchAgentTimeline(this.agentId, {
          direction: 'tail', limit, projection: 'projected', timeout: 90_000,
        });
        this.assertOpen();
        // A newer deliberate or passive read owns the mirror, even if it failed.
        if (request !== this.requestCounter) return null;
        if (version !== this.replacementVersion && this.background.role !== 'primary') {
          return null;
        }
        if (version === this.replacementVersion) {
          this.reloadPending = false;
          this.replaceWith(page);
          return page;
        }
      } catch (error) {
        this.assertOpen();
        if (request !== this.requestCounter) return null;
        if (version === this.replacementVersion) throw error;
        if (this.background.role !== 'primary') return null;
      }
    }
  }

  private replaceWith(page: FetchAgentTimelinePayload): void {
    this.rows = [];
    for (const entry of page.entries) this.merge(toRowInput(entry), page.epoch);
    this.cursor =
      page.endCursor && page.startCursor
        ? { epoch: page.epoch, startSeq: page.startCursor.seq, endSeq: page.endCursor.seq }
        : { epoch: page.epoch, startSeq: page.window.nextSeq, endSeq: page.window.nextSeq - 1 };
    this.baselineReady = true;
    this.needsRefresh = false;
    this.sink.reset(this.rows);
    this.drainBuffer();
  }

  private drainBuffer(): void {
    if (this.catchingUp || this.tailReads) return;
    const pending = this.buffered;
    this.buffered = [];
    for (const message of pending) {
      if (typeof message.seq === 'number' && typeof message.epoch === 'string') this.applySequenced(message);
      else if (this.baselineReady) this.handleLive(message);
    }
  }

  private follow(task: Promise<void>): void {
    task.catch((error: unknown) => this.fail(error));
  }

  private apply(input: Omit<MirrorRow, 'key'>, epoch: string): void {
    const { row, delta } = this.merge(input, epoch);
    if (delta) this.sink.append(row, delta);
    else this.sink.upsert(row);
  }

  private applySnapshot(input: Omit<MirrorRow, 'key'>, epoch: string): void {
    const existing = this.rows.find((row) => row.seqStart === input.seqStart || (
      input.item.type === 'tool_call' && row.item.type === 'tool_call' && row.item.callId === input.item.callId
    ));
    if (existing) {
      Object.assign(existing, input);
      this.sink.upsert(existing);
    } else {
      const row: MirrorRow = {
        ...input,
        key: input.item.type === 'tool_call' ? `tc-${input.item.callId}` : `s-${epoch}-${input.seqStart}`,
      };
      this.rows.push(row);
      this.rows.sort((a, b) => a.seqStart - b.seqStart);
      this.sink.upsert(row);
    }
  }

  /** Same rules as Paseo's projection: join text chunks, collapse tool lifecycles, dedupe user echoes. */
  private merge(input: Omit<MirrorRow, 'key'>, epoch: string): { row: MirrorRow; delta?: string } {
    const last = this.rows.at(-1);
    const { item } = input;

    if (
      item.type === 'assistant_message' &&
      last?.item.type === 'assistant_message' &&
      last.seqEnd + 1 === input.seqStart &&
      last.turnId === input.turnId &&
      (item.messageId === undefined || item.messageId === last.item.messageId)
    ) {
      last.item = { ...last.item, text: last.item.text + item.text };
      last.seqEnd = Math.max(last.seqEnd, input.seqEnd);
      last.timestamp = input.timestamp;
      return { row: last, delta: item.text };
    }
    if (item.type === 'reasoning' && last?.item.type === 'reasoning' && last.seqEnd + 1 === input.seqStart && last.turnId === input.turnId) {
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
