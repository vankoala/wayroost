/* Theme setting: data-theme on <html> from localStorage key "wayroost.theme"
   ("light" | "dark" | "system", default system). tokens.css follows the OS
   colour scheme unless data-theme overrides it. No UI for it yet. The
   theme-color metas (phone status bar, installed-app title bar) follow too. */

export type Theme = 'light' | 'dark' | 'system';

const THEME_KEY = 'wayroost.theme';

/** --bg of each palette in tokens.css; index.html and the manifest carry the same values. */
export const THEME_BACKGROUNDS = { light: '#f2ede3', dark: '#1c1814' } as const;

/** One theme-color meta for a forced theme; the media-qualified pair for system. */
function applyThemeColor(theme: Theme): void {
  for (const meta of Array.from(document.head.querySelectorAll('meta[name="theme-color"]'))) meta.remove();
  const schemes = theme === 'system' ? (['dark', 'light'] as const) : [theme];
  for (const scheme of schemes) {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = THEME_BACKGROUNDS[scheme];
    if (theme === 'system') meta.setAttribute('media', `(prefers-color-scheme: ${scheme})`);
    document.head.append(meta);
  }
}

export function currentTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
  applyThemeColor(theme);
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // localStorage unavailable (private mode); the choice just does not persist.
  }
  applyTheme(theme);
}

export function initTheme(): void {
  applyTheme(currentTheme());
}
