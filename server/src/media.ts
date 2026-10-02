import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';
import type { ConversationDetail, MediaRef, ServerEvent, Source, TimelineItem } from '../../shared/protocol.js';

// Images on your machine that an agent shows in a reply. The server rewrites
// each local path in a markdown image into a link it signed, so the browser only
// ever fetches images an agent itself pointed at, and never sends a path. The
// bytes come through Hermes or Paseo (Signalbox can't read your files), and must
// really be an image.

export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export interface MediaFile {
  bytes: Buffer;
}

/** Read a response body, giving up as soon as it passes `max` bytes. */
export async function readCapped(res: Response, max = MAX_MEDIA_BYTES): Promise<Buffer | null> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}

const IMAGE_PATH = /\.(png|jpe?g|gif|webp)$/i;
const IMAGE_EXT = 'png|jpe?g|gif|webp';
// ![alt](target "title"): target may be <bracketed> when it has spaces.
const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)((?:\s+"[^"\n]*")?)\s*\)/g;
// [text](target): a link, not an image (checked separately).
const MARKDOWN_LINK = /(?<!!)\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g;
// MEDIA:<path>, how Hermes agents deliver files (hermes-agent apps/desktop/src/lib/chat-messages/parts.ts).
const MEDIA_TAG = new RegExp(
  `[\`"']?MEDIA:\\s*(\`[^\`\\n]+\`|"[^"\\n]+"|'[^'\\n]+'|(?:~/|/)\\S+?(?:[^\\S\\n]+\\S+?)*?\\.(?:${IMAGE_EXT})(?=[\\s\`"'*_,;:)\\]}]|MEDIA:|$)|[^\\s\`"]+)[\`"']?`,
  'gi',
);
// A bare absolute or ~/ path (hermes-agent gateway/platforms/base.py): not inside a URL or a relative path.
const BARE_PATH = new RegExp(`(?<![/:\\w.])(?:~/|/)(?:[\\w.\\-]+/)*[\\w.\\-]+\\.(?:${IMAGE_EXT})\\b`, 'gi');
const FENCED_CODE = /(^|\n)(```|~~~)[\s\S]*?(\n\2|$)/g;
// Tool fields that hold an image the tool looked at or produced.
const TOOL_IMAGE_KEYS = ['image_url', 'image_path', 'path', 'file_path', 'host_image', 'image', 'screenshot_path'];
const MAX_MEDIA_PER_ITEM = 4;

// Places images are never read from, even if an agent points there: Hermes'
// own media-delivery denylist (gateway/platforms/base.py), plus the Hermes and
// Paseo stores other than their image and upload folders.
const DENIED_PREFIXES = ['/etc', '/proc', '/sys', '/dev', '/root', '/boot', '/var/log', '/var/lib', '/var/run', '/run'];
const DENIED_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config', '.azure', '.gcloud', 'Keychains']);
const HERMES_MEDIA_DIRS = new Set(['images', 'screenshots', 'cache', 'attachments']);

/** Why an image at this path must not be shown, or null. */
export function mediaPathProblem(path: string): string | null {
  const normalized = posix.normalize(path.startsWith('~/') ? `/~${path.slice(1)}` : path);
  if (DENIED_PREFIXES.some((p) => normalized === p || normalized.startsWith(`${p}/`))) return 'system folder';
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => DENIED_SEGMENTS.has(part))) return 'credentials folder';
  const hermes = parts.indexOf('.hermes');
  if (hermes >= 0) {
    // ~/.hermes/<media dir>/… or ~/.hermes/profiles/<name>/<media dir>/…
    const rest = parts.slice(hermes + 1);
    const dir = rest[0] === 'profiles' ? rest[2] : rest[0];
    if (!dir || !HERMES_MEDIA_DIRS.has(dir) || rest.some((p) => p.startsWith('bws_cache'))) return 'Hermes data';
  }
  const paseo = parts.indexOf('.paseo');
  if (paseo >= 0 && parts[paseo + 1] !== 'uploads') return 'Paseo data';
  return null;
}

function basename(path: string): string {
  return path.split('/').pop() || path;
}

/** A local image path as an agent wrote it, or null when it isn't one. */
export function localImagePath(target: string): string | null {
  let value = target.trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
  try {
    if (/^file:\/\//i.test(value)) {
      const url = new URL(value);
      if (url.hostname && url.hostname !== 'localhost') return null;
      value = decodeURIComponent(url.pathname);
    } else if (value.startsWith('/') || value.startsWith('~/')) {
      value = decodeURIComponent(value);
    } else {
      return null;
    }
  } catch {
    return null;
  }
  if (value.startsWith('/api/') || value.length > 4096 || value.includes('\0')) return null;
  return IMAGE_PATH.test(value) ? value : null;
}

export class MediaLinks {
  /** Per process: links stop working after a restart, and reloading the chat makes new ones. */
  private readonly key = randomBytes(32);

  private signature(source: Source, conversationId: string, path: string): string {
    return createHmac('sha256', this.key).update(`${source}\n${conversationId}\n${path}`).digest('base64url');
  }

  url(source: Source, conversationId: string, path: string): string {
    const p = Buffer.from(path).toString('base64url');
    return `/api/media/${source}/${encodeURIComponent(conversationId)}?p=${p}&s=${this.signature(source, conversationId, path)}`;
  }

  /** The path a link was signed for, or null when it wasn't signed by this server for this conversation. */
  verify(source: Source, conversationId: string, p: string, s: string): string | null {
    const path = Buffer.from(p, 'base64url').toString('utf8');
    const expected = Buffer.from(this.signature(source, conversationId, path));
    const given = Buffer.from(s);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const plausible = (path.startsWith('/') || path.startsWith('~/')) && IMAGE_PATH.test(path) && !path.includes('\0');
    return plausible ? path : null;
  }

  /** Point local images in an agent's markdown at signed links. */
  rewrite(source: Source, conversationId: string, text: string): string {
    if (!text.includes('![')) return text;
    return text.replace(MARKDOWN_IMAGE, (whole, alt: string, target: string, title: string) => {
      const path = localImagePath(target);
      return path && !mediaPathProblem(path) ? `![${alt}](${this.url(source, conversationId, path)}${title})` : whole;
    });
  }

  private ref(source: Source, conversationId: string, path: string): MediaRef {
    return { url: this.url(source, conversationId, path), name: basename(path) };
  }

  /**
   * An assistant reply: inline markdown images are signed in place; images it
   * names any other way (MEDIA: tags, links, bare paths) come back as `media`.
   * MEDIA: tags are replaced by the file name, as the Hermes apps do.
   */
  assistant(source: Source, conversationId: string, text: string): { text: string; media: MediaRef[] } {
    const inline = new Set<string>();
    for (const match of text.matchAll(MARKDOWN_IMAGE)) {
      const path = localImagePath(match[2]!);
      if (path) inline.add(path);
    }
    const found: string[] = [];
    const add = (candidate: string | null) => {
      if (candidate && !inline.has(candidate) && !found.includes(candidate) && !mediaPathProblem(candidate)) {
        found.push(candidate);
      }
    };

    let out = text.replace(MEDIA_TAG, (whole, value: string) => {
      const path = localImagePath(value.replace(/^[`"']|[`"']$/g, ''));
      if (!path) return whole;
      add(path);
      return basename(path);
    });
    for (const match of out.matchAll(MARKDOWN_LINK)) add(localImagePath(match[2]!));
    // Bare paths outside fenced code: coding agents print paths in logs and
    // listings there, which aren't requests to show anything.
    const prose = out.replace(FENCED_CODE, (block) => ' '.repeat(block.length));
    for (const match of prose.matchAll(BARE_PATH)) add(localImagePath(match[0]));

    out = this.rewrite(source, conversationId, out);
    return { text: out, media: found.slice(0, MAX_MEDIA_PER_ITEM).map((p) => this.ref(source, conversationId, p)) };
  }

  /** Images a tool looked at or produced, from well-known fields of its input and output. */
  tool(source: Source, conversationId: string, input: string | undefined, output: string | undefined): MediaRef[] {
    const found: string[] = [];
    const visit = (value: unknown, depth: number) => {
      if (depth > 4 || found.length >= MAX_MEDIA_PER_ITEM || !value || typeof value !== 'object') return;
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'string' && TOOL_IMAGE_KEYS.includes(key)) {
          const path = localImagePath(v);
          if (path && !mediaPathProblem(path) && !found.includes(path)) found.push(path);
        } else if (typeof v === 'object') {
          visit(v, depth + 1);
        }
      }
    };
    for (const text of [input, output]) {
      if (!text) continue;
      const trimmed = text.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          visit(JSON.parse(trimmed), 0);
        } catch {
          // not JSON; MEDIA: tags below
        }
      }
      for (const match of text.matchAll(MEDIA_TAG)) {
        const path = localImagePath(match[1]!.replace(/^[`"']|[`"']$/g, ''));
        if (path && !mediaPathProblem(path) && !found.includes(path)) found.push(path);
      }
    }
    return found.slice(0, MAX_MEDIA_PER_ITEM).map((p) => this.ref(source, conversationId, p));
  }

  items(source: Source, conversationId: string, items: TimelineItem[]): TimelineItem[] {
    return items.map((item) => {
      if (item.kind === 'assistant') {
        const { text, media } = this.assistant(source, conversationId, item.text);
        const merged = [...(item.media ?? []), ...media];
        return { ...item, text, ...(merged.length ? { media: merged } : {}) };
      }
      if (item.kind === 'tool') {
        const media = [...(item.media ?? []), ...this.tool(source, conversationId, item.input, item.output)];
        return media.length ? { ...item, media } : item;
      }
      return item;
    });
  }

  detail(detail: ConversationDetail): ConversationDetail {
    const { source, id } = detail.conversation;
    return { ...detail, items: this.items(source, id, detail.items) };
  }

  event(event: ServerEvent): ServerEvent {
    if (event.type !== 'items_upsert' && event.type !== 'items_replace') return event;
    return { ...event, items: this.items(event.source, event.conversationId, event.items) };
  }
}
