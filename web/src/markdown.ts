import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import { isMediaUrl } from './media';

// Agent output is untrusted (prompt injection can make an agent emit anything),
// so rendering is locked down three ways: markdown-it with raw HTML disabled,
// DOMPurify on the result, and the page CSP (no inline script, no remote images).

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });

const SAFE_LINK = /^(https?:|mailto:)/i;

// Links the server signed for images on your machine are accepted too; they
// only ever become image placeholders (below), never links.
md.validateLink = (url) => SAFE_LINK.test(url.trim()) || isMediaUrl(url.trim());

md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx]!;
  const src = String(token.attrGet('src') ?? '');
  const alt = md.utils.escapeHtml(token.content || 'image');
  // An image from your machine: media.ts fetches it and fills this in.
  if (isMediaUrl(src)) {
    return `<button type="button" class="md-media" data-media="${md.utils.escapeHtml(src)}" data-alt="${alt}" aria-label="${alt}">${alt}</button>`;
  }
  // Remote images would be blocked by the CSP (and could leak data), so show them as links.
  if (!SAFE_LINK.test(src)) return `<span class="md-image">[${alt}]</span>`;
  return `<a class="md-image" href="${md.utils.escapeHtml(src)}">🖼 ${alt}</a>`;
};

// A plain link to such an image would need the API headers to open: keep just its text.
md.core.ruler.push('media_links', (state) => {
  for (const block of state.tokens) {
    const children = block.children;
    if (!children) continue;
    for (let i = 0; i < children.length; i++) {
      const token = children[i]!;
      if (token.type !== 'link_open' || !isMediaUrl(String(token.attrGet('href') ?? ''))) continue;
      const close = children.findIndex((t, j) => j > i && t.type === 'link_close');
      if (close !== -1) children.splice(close, 1);
      children.splice(i, 1);
      i -= 1;
    }
  }
});

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]!;
  const lang = md.utils.escapeHtml(token.info.trim().split(/\s+/)[0] ?? '');
  const code = md.utils.escapeHtml(token.content);
  return (
    `<div class="md-code"><div class="md-code-bar"><span>${lang || 'code'}</span>` +
    `<button type="button" class="md-copy" data-copy>Copy</button></div>` +
    `<pre><code>${code}</code></pre></div>`
  );
};

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
    // Links can carry data out if tapped; always show where they go.
    node.setAttribute('title', node.getAttribute('href') ?? '');
  }
});

const PURIFY_OPTIONS = {
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select', 'iframe', 'object', 'embed', 'svg', 'math'],
  FORBID_ATTR: ['style', 'srcset'],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ['target', 'data-copy', 'title', 'data-media', 'data-alt'],
  // Inert text for media.ts, which only fetches links the server signed.
  ADD_URI_SAFE_ATTR: ['data-media', 'data-alt'],
};

const cache = new Map<string, string>();

export function renderMarkdown(text: string): string {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const html = DOMPurify.sanitize(md.render(text), PURIFY_OPTIONS) as unknown as string;
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  cache.set(text, html);
  return html;
}
