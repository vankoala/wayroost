const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact, glanceable timestamps for the inbox: "now", "5m", "3h", "Mon", "Sep 3". */
export function shortTime(ms: number, now = Date.now()): string {
  const diff = now - ms;
  if (diff < MINUTE) return 'now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY && new Date(ms).getDate() === new Date(now).getDate()) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 7 * DAY) return new Date(ms).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** When something is next due: "now", "in 5m", "in 3h", "tomorrow 9:00", "Mon 9:00", "Sep 3". */
export function inTime(ms: number, now = Date.now()): string {
  const diff = ms - now;
  if (diff < MINUTE) return 'now';
  if (diff < HOUR - 30_000) return `in ${Math.round(diff / MINUTE)}m`;
  const at = new Date(ms);
  const clock = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);
  if (days === 0) return diff < 6 * HOUR ? `in ${Math.round(diff / HOUR)}h` : `today ${clock}`;
  if (days === 1) return `tomorrow ${clock}`;
  if (days < 7) return `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${clock}`;
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function homeRelative(path: string): string {
  return path.replace(/^\/home\/[^/]+/, '~');
}

/**
 * The owner's home folder with a trailing slash ("/home/me/"), from the folders their chats and
 * projects use: the most common /home/<name>. Prefills a folder field so it needn't be typed.
 */
export function homeFolder(paths: Iterable<string | undefined>): string | undefined {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const home = path?.match(/^\/home\/[^/]+(?=\/|$)/)?.[0];
    if (home) counts.set(home, (counts.get(home) ?? 0) + 1);
  }
  let best: [string, number] | undefined;
  for (const entry of counts) if (!best || entry[1] > best[1]) best = entry;
  return best && `${best[0]}/`;
}

/** A folder as typed, without the trailing slash a prefill leaves ("/home/me/" → "/home/me"). */
export function folderPath(typed: string): string {
  const path = typed.trim();
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

export function oneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
