/// <reference types="node" />
import { createHash } from 'node:crypto';
import { INVISIBLE } from './invisible.js';

export const FrameKind = {
  BRIEF: 'BRIEF', STEER: 'STEER', EVENT: 'EVENT', CHECKPOINT: 'CHECKPOINT', QUOTE: 'QUOTE',
} as const;
export type FrameKind = typeof FrameKind[keyof typeof FrameKind];

export type UnframeResult =
  | { trusted: true; kind: FrameKind; payload: string }
  | { trusted: false; text: string };

const KINDS = new Set<string>(Object.values(FrameKind));
const MAX_TRIES = 8;
const FRAME = /^<<<WAYROOST-(BRIEF|STEER|EVENT|CHECKPOINT|QUOTE)-([0-9a-f]{16})\n([\s\S]*)\nWAYROOST-\1-\2>>>$/;

function escapeInvisible(payload: string): string {
  return payload.replace(INVISIBLE, (character) => {
    const point = character.codePointAt(0)!;
    return point <= 0xffff ? `\\u${point.toString(16).padStart(4, '0')}` : `\\u{${point.toString(16)}}`;
  });
}

/** The counter changes a delimiter if either spelling already appears in the payload. */
export function frame(kind: FrameKind, payload: string): string {
  if (!KINDS.has(kind)) throw new TypeError('Unknown frame kind');
  const safe = escapeInvisible(payload);
  const lower = safe.toLowerCase();
  for (let counter = 0; counter < MAX_TRIES; counter++) {
    const suffix = counter === 0 ? '' : `\0${counter}`;
    const nonce = createHash('sha256').update(`${kind}\0${safe}${suffix}`).digest('hex').slice(0, 16);
    const start = `<<<WAYROOST-${kind}-${nonce}`;
    const end = `WAYROOST-${kind}-${nonce}>>>`;
    if (!lower.includes(start.toLowerCase()) && !lower.includes(end.toLowerCase())) {
      return `${start}\n${safe}\n${end}`;
    }
  }
  throw new Error('Cannot derive a collision-free frame delimiter');
}

/** Only a complete, canonical frame is trusted; its hash is not authentication. */
export function unframe(text: string): UnframeResult {
  const untrusted: UnframeResult = { trusted: false, text };
  const match = FRAME.exec(text);
  if (!match || match[0] !== text) return untrusted;
  const kind = match[1] as FrameKind;
  const payload = match[3]!;
  try {
    return frame(kind, payload) === text ? { trusted: true, kind, payload } : untrusted;
  } catch {
    return untrusted;
  }
}
