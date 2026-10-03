// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigate, settingsPath } from '../router';
import { ArchivedPage, ConnectorsPage, SkillsPage } from './SettingsPages';

vi.mock('../api', () => ({ api: {
  connectors: () => Promise.resolve({ connectors: [], hermes: false, helper: false }),
  triggers: () => Promise.resolve({ triggers: [], targets: [], ready: false }),
  archived: () => Promise.resolve({ threads: [] }),
} }));
vi.mock('../skillsApi', () => ({ skillsApi: {
  list: () => Promise.resolve({ version: 0, checkedAt: 0, skills: [], places: [], apps: [], events: [], installs: [] }),
} }));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  history.replaceState(null, '', '/chats?filter=attention');
});
afterEach(() => vi.restoreAllMocks());

const pages = [
  { page: 'connectors', component: ConnectorsPage },
  { page: 'skills', component: SkillsPage },
  { page: 'archived', component: ArchivedPage },
] as const;

function pop(): Promise<void> {
  return new Promise((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));
}

describe('Back from settings subpages', () => {
  it.each(pages)('consumes the in-app $page entry before browser Back returns to Chats', async ({ page, component }) => {
    navigate(settingsPath());
    navigate(settingsPath(page));
    const length = history.length;
    const push = vi.spyOn(history, 'pushState');
    const replace = vi.spyOn(history, 'replaceState');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(h(component)));
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!.click());
      expect(push).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      if (location.pathname !== '/settings') await act(async () => { await pop(); });
      expect(location.pathname + location.search).toBe('/settings');
      expect(history.length).toBe(length);
      const popped = pop();
      await act(async () => { history.back(); await popped; });
      expect(location.pathname + location.search).toBe('/chats?filter=attention');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it.each(pages)('replaces a directly visited $page entry with Settings', async ({ page, component }) => {
    history.pushState(null, '', settingsPath(page));
    const length = history.length;
    const back = vi.spyOn(history, 'back');
    const push = vi.spyOn(history, 'pushState');
    const replace = vi.spyOn(history, 'replaceState');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(h(component)));
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!.click());
      expect(location.pathname + location.search).toBe('/settings');
      expect(history.length).toBe(length);
      expect(history.state).toBeNull();
      expect(back).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      expect(replace).toHaveBeenCalledWith(null, '', '/settings');
      const popped = pop();
      await act(async () => { history.back(); await popped; });
      expect(location.pathname + location.search).toBe('/chats?filter=attention');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
