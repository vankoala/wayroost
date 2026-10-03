import { useSyncExternalStore } from 'react';
import { PAIR_PATH, type Source } from '../../shared/protocol';

/**
 * Every place in the app is a page with its own URL. Sheets are
 * only quick actions — New task, For you, pickers — and never stack on a page.
 */
export type Route =
  | { name: 'home' }
  | { name: 'chats' }
  | { name: 'conversation'; source: Source; id: string }
  | { name: 'tasks' }
  | { name: 'schedule' }
  | { name: 'team' }
  | { name: 'settings'; page: SettingsPage }
  /** Pairing this browser, outside the shell; the code is in the URL fragment. */
  | { name: 'pair' };

/** Settings pages that exist today. The rest of the groups arrive with M2. */
export type SettingsPage = 'overview' | 'status' | 'devices' | 'voice' | 'connectors' | 'schedule' | 'skills' | 'archived';

/** Settings → Devices & access. */
export const DEVICES_PATH = '/settings/devices';

/** The Chats filters, addressable so a Home tile can open its own filtered page. */
export type ChatsFilter = 'all' | 'attention' | 'working' | 'hermes' | 'paseo';

const NAV_EVENT = 'signalbox:navigate';

const SETTINGS_PAGES: Record<string, SettingsPage> = {
  '': 'overview',
  overview: 'overview',
  status: 'status',
  devices: 'devices',
  voice: 'voice',
  connectors: 'connectors',
  schedule: 'schedule',
  skills: 'skills',
  archived: 'archived',
};

export function parseRoute(pathname: string): Route {
  // A query (?filter=attention) and a fragment (#for-you) say nothing about the page.
  const path = (pathname.split(/[?#]/)[0] ?? '/').replace(/\/+$/, '') || '/';
  if (path === PAIR_PATH) return { name: 'pair' };
  const match = /^\/c\/(hermes|paseo)\/([^/]+)$/.exec(path);
  if (match) {
    try {
      return { name: 'conversation', source: match[1] as Source, id: decodeURIComponent(match[2]!) };
    } catch {
      return { name: 'chats' };
    }
  }
  switch (path) {
    case '/':
      return { name: 'home' };
    case '/chats':
      return { name: 'chats' };
    case '/tasks':
      return { name: 'tasks' };
    case '/schedule':
      return { name: 'schedule' };
    case '/team':
      return { name: 'team' };
  }
  const settings = /^\/settings(?:\/([^/]+))?$/.exec(path);
  if (settings) {
    const key = settings[1] ?? '';
    return { name: 'settings', page: Object.hasOwn(SETTINGS_PAGES, key) ? SETTINGS_PAGES[key]! : 'overview' };
  }
  // Anything else we don't know opens the inbox, like it did before.
  return { name: 'chats' };
}

export function conversationPath(source: Source, id: string, filter: ChatsFilter = 'all'): string {
  const path = `/c/${source}/${encodeURIComponent(id)}`;
  return filter === 'all' ? path : `${path}?filter=${filter}`;
}

/** The chats page, optionally at one filter. */
export function chatsPath(filter: ChatsFilter = 'all'): string {
  return filter === 'all' ? '/chats' : `/chats?filter=${filter}`;
}

export function settingsPath(page: SettingsPage = 'overview'): string {
  return page === 'overview' ? '/settings' : `/settings/${page}`;
}

/** The scheduled-jobs page, optionally at one job (`"source:id"`) or straight into the builder. */
export function schedulePath(opts: { focus?: string; startNew?: boolean } = {}): string {
  if (opts.focus) return `/schedule?focus=${encodeURIComponent(opts.focus)}`;
  return opts.startNew ? '/schedule?new=1' : '/schedule';
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const here = location.pathname + location.search;
  if (path === here) return;
  // Mark entries we pushed so "back" knows it can pop instead of leaving the app.
  if (options.replace) history.replaceState(history.state, '', path);
  else history.pushState({ signalbox: true }, '', path);
  window.dispatchEvent(new Event(NAV_EVENT));
}

/** Go back if we navigated here in-app, otherwise replace the direct visit with a fallback page. */
export function goBackTo(fallback: string): void {
  if ((history.state as { signalbox?: boolean } | null)?.signalbox) history.back();
  else navigate(fallback, { replace: true });
}

/** Go back if we navigated here in-app, otherwise to the inbox. */
export function goBack(): void {
  goBackTo(chatsPath(parseChatsFilter(location.pathname + location.search)));
}

function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  window.addEventListener(NAV_EVENT, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(NAV_EVENT, listener);
  };
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => location.pathname);
}

/** The current URL (path + query), so a filter can live in the address bar. */
export function useUrl(): string {
  return useSyncExternalStore(subscribe, () => location.pathname + location.search);
}

/** The Chats filter the URL asks for; anything unknown opens the full list. */
export function parseChatsFilter(url: string): ChatsFilter {
  const asked = new URL(url, 'http://localhost').searchParams.get('filter') ?? 'all';
  const known: string[] = ['all', 'attention', 'working', 'hermes', 'paseo'];
  return known.includes(asked) ? (asked as ChatsFilter) : 'all';
}

/** A query parameter of the current URL (e.g. ?focus=hermes:4). */
export function param(url: string, name: string): string | null {
  return new URL(url, 'http://localhost').searchParams.get(name);
}

/**
 * The location hash (the desktop app's approval links, `#approval-<id>`), kept current
 * across fragment changes, back and forward, and in-app navigation.
 */
export function useHash(): string {
  return useSyncExternalStore(subscribeHash, () => location.hash);
}

function subscribeHash(listener: () => void) {
  window.addEventListener('hashchange', listener);
  const stop = subscribe(listener);
  return () => {
    window.removeEventListener('hashchange', listener);
    stop();
  };
}
