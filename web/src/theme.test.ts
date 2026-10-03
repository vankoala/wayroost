// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyTheme, currentTheme, initTheme, setTheme, THEME_BACKGROUNDS } from './theme';

describe('theme', () => {
  it('defaults to system when nothing is stored', () => {
    localStorage.removeItem('wayroost.theme');
    expect(currentTheme()).toBe('system');
  });

  it('reads a stored choice and rejects anything else', () => {
    localStorage.setItem('wayroost.theme', 'dark');
    expect(currentTheme()).toBe('dark');
    localStorage.setItem('wayroost.theme', 'neon');
    expect(currentTheme()).toBe('system');
  });

  it('sets data-theme for light/dark and drops it for system', () => {
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('keeps the theme-color metas on the chosen palette', () => {
    const metas = () =>
      Array.from(document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')).map((m) => ({
        content: m.content,
        media: m.getAttribute('media'),
      }));
    applyTheme('light');
    expect(metas()).toEqual([{ content: THEME_BACKGROUNDS.light, media: null }]);
    applyTheme('dark');
    expect(metas()).toEqual([{ content: THEME_BACKGROUNDS.dark, media: null }]);
    applyTheme('system');
    expect(metas()).toEqual([
      { content: THEME_BACKGROUNDS.dark, media: '(prefers-color-scheme: dark)' },
      { content: THEME_BACKGROUNDS.light, media: '(prefers-color-scheme: light)' },
    ]);
  });

  it('persists setTheme under the wayroost.theme key', () => {
    setTheme('light');
    expect(localStorage.getItem('wayroost.theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    setTheme('system');
    expect(localStorage.getItem('wayroost.theme')).toBe('system');
  });

  it('initTheme applies the stored choice', () => {
    localStorage.setItem('wayroost.theme', 'dark');
    initTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    localStorage.removeItem('wayroost.theme');
    initTheme();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
