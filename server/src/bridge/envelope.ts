import { parseBridgeEnvelope } from '../../../shared/protocol.js';

// Messages that arrive through the bridge carry an envelope (see bridgeEnvelope
// in shared/protocol.ts). Hermes builds a chat's preview, and sometimes its
// title, from the first message, cut short, so those would all read
// "[Message from … via Signalbox — another AI agent…". These helpers make them
// readable again.

const HEAD = '[Message from ';
const VIA = ' via Signalbox';

/**
 * A preview or title that starts with a bridge envelope, made readable:
 * "<sender>: <text>" when the whole envelope is there, "From <sender>" when it
 * was cut short. Anything else comes back unchanged. Works for envelopes with
 * and without a reply address.
 */
export function readableBridgeText(text: string): string {
  const parsed = parseBridgeEnvelope(text);
  if (parsed) return parsed.text.trim() ? `${parsed.sender}: ${parsed.text}` : `From ${parsed.sender}`;
  if (!text.startsWith(HEAD)) return text;

  // Cut short, or with its line breaks flattened into spaces. The sender label
  // can't contain "]", so the first "]" closes the bracketed header.
  const flat = text.replace(/\s+/g, ' ');
  const close = flat.indexOf(']', HEAD.length);
  const via = flat.indexOf(VIA, HEAD.length);
  const senderEnd = via >= 0 && (close < 0 || via < close) ? via : close >= 0 ? close : flat.length;
  const sender = flat.slice(HEAD.length, senderEnd).trim();
  if (!sender) return text;
  const body = close >= 0 ? flat.slice(close + 1).trim() : '';
  return body ? `${sender}: ${body}` : `From ${sender}`;
}

/** Title for a chat an agent starts without naming it: the first line of its message. */
export function defaultChatTitle(text: string): string {
  const first = text.trim().split('\n')[0]!.replace(/\s+/g, ' ').trim();
  return first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first;
}
