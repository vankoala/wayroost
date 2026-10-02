import type { TimelineItem } from '../../shared/protocol';

// Thumbnails for photos sent from this browser. The server only echoes each
// file's name and kind, so the blob: URL made when the photo was picked is
// kept and shown on the message it went out with: first on the optimistic
// copy, then on the server's copy once that arrives. Names repeat (iPhones
// call every photo "image.jpg"), so previews pair with the newest messages
// first and never with a message that existed before they were sent.

const MAX_KEPT = 20;
/** How long a preview may wait for the server's copy of its message. */
const MATCH_WINDOW_MS = 10 * 60_000;

interface Kept {
  /** Conversation key. */
  key: string;
  name: string;
  url: string;
  /** The message showing it; null until the server's copy is found. */
  itemId: string | null;
  /** Its position among that message's attachments. */
  slot: number;
  /** Timeline items that existed when it was sent. */
  before: ReadonlySet<string>;
  at: number;
}

let kept: Kept[] = [];
const stable = new Map<string, (string | undefined)[]>();

/**
 * Keep image previews of files just sent. `itemId` is the optimistic message
 * showing them, or null when there is none (a new conversation).
 * Takes ownership of the URLs: they're revoked when dropped.
 */
export function keepPreviews(
  key: string,
  itemId: string | null,
  files: ReadonlyArray<{ name: string; previewUrl?: string }>,
  existing: Iterable<string>,
  now = Date.now(),
): void {
  const before = new Set(existing);
  files.forEach((file, slot) => {
    if (file.previewUrl) kept.push({ key, name: file.name, url: file.previewUrl, itemId, slot, before, at: now });
  });
  while (kept.length > MAX_KEPT) URL.revokeObjectURL(kept.shift()!.url);
}

/** The send failed and the files went back in the message box, which owns their URLs again. */
export function forgetPreviews(key: string, itemId: string): void {
  kept = kept.filter((k) => !(k.key === key && k.itemId === itemId));
}

/** The conversation continues under a new key. */
export function movePreviews(from: string, to: string): void {
  for (const k of kept) if (k.key === from) k.key = to;
}

/** Preview URLs for a conversation's messages, by item id, in attachment order. */
export function previewsFor(
  key: string,
  items: readonly TimelineItem[],
  now = Date.now(),
): ReadonlyMap<string, (string | undefined)[]> {
  const result = new Map<string, (string | undefined)[]>();
  const mine = kept.filter((k) => k.key === key);
  if (!mine.length) return result;

  const present = new Set(items.map((i) => i.id));
  const slotKey = (id: string, slot: number) => `${id}\u0000${slot}`;
  const taken = new Set(mine.filter((k) => k.itemId !== null && present.has(k.itemId)).map((k) => slotKey(k.itemId!, k.slot)));
  // Previews whose message isn't in the timeline: the optimistic copy was just
  // replaced, dropped by a reload, or never existed.
  const loose = mine.filter((k) => (k.itemId === null || !present.has(k.itemId)) && now - k.at < MATCH_WINDOW_MS);
  for (let i = items.length - 1; i >= 0 && loose.length; i--) {
    const item = items[i]!;
    if (item.kind !== 'user' || !item.attachments) continue;
    for (let slot = item.attachments.length - 1; slot >= 0; slot--) {
      const file = item.attachments[slot]!;
      if (file.kind !== 'image' || taken.has(slotKey(item.id, slot))) continue;
      const match = loose.findLast((k) => k.name === file.name && !k.before.has(item.id));
      if (!match) continue;
      match.itemId = item.id;
      match.slot = slot;
      taken.add(slotKey(item.id, slot));
      loose.splice(loose.indexOf(match), 1);
    }
  }

  for (const k of mine) {
    if (k.itemId === null || !present.has(k.itemId)) continue;
    const urls = result.get(k.itemId) ?? [];
    urls[k.slot] = k.url;
    result.set(k.itemId, urls);
  }
  // Same URLs, same array: memoized rows don't re-render on every update.
  for (const [id, urls] of result) {
    const cacheKey = `${key}\u0000${id}`;
    const previous = stable.get(cacheKey);
    if (previous && previous.length === urls.length && previous.every((u, i) => u === urls[i])) result.set(id, previous);
    else stable.set(cacheKey, urls);
  }
  if (stable.size > MAX_KEPT * 4) stable.clear();
  return result;
}
