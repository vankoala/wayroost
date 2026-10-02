// Unsent message text, per conversation. Saved to localStorage (the composer
// debounces that) and mirrored in memory, so the latest keystrokes survive the
// composer unmounting or the conversation moving to a new id.

const PREFIX = 'signalbox:draft:';
const live = new Map<string, string>();

function stored(key: string): string {
  try {
    return localStorage.getItem(PREFIX + key) ?? '';
  } catch {
    return '';
  }
}

export function readDraft(key: string): string {
  return live.get(key) ?? stored(key);
}

/** The composer's current text; cheap enough for every change. */
export function noteDraft(key: string, text: string): void {
  live.set(key, text);
}

export function saveDraft(key: string, text: string): void {
  live.set(key, text);
  try {
    if (text) localStorage.setItem(PREFIX + key, text);
    else localStorage.removeItem(PREFIX + key);
  } catch {
    // drafts are a convenience only
  }
}

/** The conversation continues under a new key: its draft goes along. */
export function moveDraft(from: string, to: string): void {
  const text = readDraft(from);
  if (!text) return;
  if (!readDraft(to)) saveDraft(to, text);
  saveDraft(from, '');
}
