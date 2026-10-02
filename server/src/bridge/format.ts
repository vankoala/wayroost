import { parseBridgeEnvelope, type ConversationStatus, type ConversationSummary, type TimelineItem } from '../../../shared/protocol.js';
import { oneLine } from '../text.js';

// How chats and timelines look to an agent calling the bridge: plain, short,
// and without reasoning, approvals or anything else only the user acts on.

export type ChatStatus = 'working' | 'idle' | 'needs_approval' | 'error';

const STATUS: Record<ConversationStatus, ChatStatus> = {
  running: 'working',
  idle: 'idle',
  needs_approval: 'needs_approval',
  error: 'error',
};

export interface ChatEntry {
  chat: string;
  title: string;
  backend: ConversationSummary['source'];
  agent: string;
  status: ChatStatus;
  updated?: string;
  preview?: string;
  started_by?: { chat: string; title: string };
}

export const chatKey = (c: { source: string; id: string }) => `${c.source}:${c.id}`;

/** Which agent runs a chat, e.g. "Claude Code" or "Hermes (claude-sonnet-5)". */
export function agentName(c: ConversationSummary): string {
  if (c.source === 'hermes') return c.agentLabel ? `Hermes (${c.agentLabel})` : 'Hermes';
  return c.agentLabel ?? 'Paseo agent';
}

export function chatEntry(c: ConversationSummary): ChatEntry {
  return {
    chat: chatKey(c),
    title: c.title,
    backend: c.source,
    agent: agentName(c),
    status: STATUS[c.status] ?? 'idle',
    ...(Number.isFinite(c.updatedAt) ? { updated: new Date(c.updatedAt).toISOString() } : {}),
    ...(c.preview ? { preview: oneLine(c.preview, 200) } : {}),
    ...(c.startedBy ? { started_by: { chat: chatKey(c.startedBy), title: c.startedBy.title } } : {}),
  };
}

export interface TranscriptItem {
  /** "agent": a message another agent sent through the bridge, not the user. */
  role: 'user' | 'agent' | 'assistant' | 'tool' | 'notice';
  text: string;
  /** For role "agent": who sent it. */
  from?: string;
  /** For role "agent": the sender's chat, when Signalbox knew it. */
  reply_to?: string;
}

export const MAX_ITEM_CHARS = 2_000;
export const MAX_TRANSCRIPT_CHARS = 16_000;

export function cut(text: string, max = MAX_ITEM_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function transcriptItem(item: TimelineItem): TranscriptItem | null {
  switch (item.kind) {
    case 'user': {
      const files = item.attachments?.length ? `[attached: ${item.attachments.map((a) => a.name).join(', ')}]` : '';
      const envelope = parseBridgeEnvelope(item.text);
      const text = [envelope ? envelope.text : item.text, files].filter(Boolean).join('\n');
      if (!envelope) return { role: 'user', text: cut(text) };
      return {
        role: 'agent',
        from: oneLine(envelope.sender, 200),
        ...(envelope.replyTo ? { reply_to: envelope.replyTo } : {}),
        text: cut(text),
      };
    }
    case 'assistant':
      return item.text.trim() ? { role: 'assistant', text: cut(item.text) } : null;
    case 'tool': {
      const summary = item.summary ? `: ${oneLine(item.summary, 200)}` : '';
      return { role: 'tool', text: `[tool] ${oneLine(item.name, 80)}${summary} (${item.status})` };
    }
    case 'notice':
      return { role: 'notice', text: cut(item.text) };
    default:
      // Reasoning and "/" command output stay out.
      return null;
  }
}

/**
 * The newest `limit` items, oldest first, each clipped to 2,000 characters and
 * together to 16,000 (older items are dropped to fit).
 */
export function transcript(items: readonly TimelineItem[], limit: number): { items: TranscriptItem[]; omitted: number } {
  const all: TranscriptItem[] = [];
  for (const item of items) {
    const rendered = transcriptItem(item);
    if (rendered) all.push(rendered);
  }
  const out = all.slice(-limit);
  const size = (i: TranscriptItem) => i.text.length + (i.from?.length ?? 0) + (i.reply_to?.length ?? 0);
  let total = out.reduce((sum, i) => sum + size(i), 0);
  while (out.length > 1 && total > MAX_TRANSCRIPT_CHARS) total -= size(out.shift()!);
  return { items: out, omitted: all.length - out.length };
}
