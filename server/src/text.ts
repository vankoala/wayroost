// Small text helpers shared by the source adapters.

/** Largest tool input/output we forward to the browser; phones don't need megabytes. */
export const MAX_FIELD_CHARS = 16_000;
/**
 * Approval details (commands, diffs) are sent in full up to this size. Anything
 * longer is flagged as truncated and can only be denied from the phone, so a
 * payload can never hide past the end of what you were shown.
 */
export const MAX_APPROVAL_DETAIL = 60_000;

export function clip(text: string, max = MAX_FIELD_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${(text.length - max).toLocaleString('en-US')} more characters)`;
}

export function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Pretty-print JSON (or JSON-in-a-string); fall back to the raw text. */
export function pretty(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return value;
      }
    }
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

/** Inline base64 images (e.g. a vision tool's copy of a picture) are noise on a phone. */
export function stripDataUrls(text: string): string {
  return text.replace(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]{64,}/g, '[image]');
}

export function homeRelative(path: string): string {
  return path.replace(/^\/home\/[^/]+(?=\/|$)/, '~');
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function capitalize(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

const ARG_KEYS = ['command', 'cmd', 'path', 'file_path', 'filePath', 'query', 'url', 'pattern', 'description', 'prompt', 'name'];

/** One glanceable line describing a tool call's arguments. */
export function summarizeArgs(args: unknown): string | undefined {
  let value = args;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return str(value) ? oneLine(value as string, 120) : undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ARG_KEYS) {
    const v = record[key];
    if (typeof v === 'string' && v.trim()) return oneLine(v, 120);
  }
  for (const v of Object.values(record)) {
    if (typeof v === 'string' && v.trim()) return oneLine(v, 120);
  }
  return undefined;
}
