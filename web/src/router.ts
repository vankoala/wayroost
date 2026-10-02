import { useSyncExternalStore } from 'react';
import type { Source } from '../../shared/protocol';

export type Route = { name: 'inbox' } | { name: 'conversation'; source: Source; id: string };

const NAV_EVENT = 'signalbox:navigate';

export function parseRoute(pathname: string): Route {
  const match = /^\/c\/(hermes|paseo)\/([^/]+)\/?$/.exec(pathname);
  if (match) {
    try {
      return { name: 'conversation', source: match[1] as Source, id: decodeURIComponent(match[2]!) };
    } catch {
      return { name: 'inbox' };
    }
  }
  return { name: 'inbox' };
}

export function conversationPath(source: Source, id: string): string {
  return `/c/${source}/${encodeURIComponent(id)}`;
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (path === location.pathname) return;
  // Mark entries we pushed so "back" knows it can pop instead of leaving the app.
  if (options.replace) history.replaceState(history.state, '', path);
  else history.pushState({ signalbox: true }, '', path);
  window.dispatchEvent(new Event(NAV_EVENT));
}

/** Go back if we navigated here in-app, otherwise to the inbox. */
export function goBack(): void {
  if ((history.state as { signalbox?: boolean } | null)?.signalbox) history.back();
  else navigate('/', { replace: true });
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
