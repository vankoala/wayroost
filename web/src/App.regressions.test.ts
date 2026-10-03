// @vitest-environment jsdom
import { act, createElement as h, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { getState, markSignedOut, setState } from './store';
import { navigate } from './router';
import type { ActResult } from './power';

const fixture = vi.hoisted(() => ({ mounts: 0, phone: false, powerAct: vi.fn() }));
vi.mock('./events', () => ({ startEvents: vi.fn(), onVoiceEvent: vi.fn() }));
vi.mock('./api', async (original) => ({
  ...await original<typeof import('./api')>(),
  refreshList: () => Promise.resolve(),
  api: new Proxy({}, { get: () => () => Promise.reject(new Error('Unavailable in this test')) }),
}));
vi.mock('./power', async (original) => ({
  ...await original<typeof import('./power')>(),
  usePower: () => ({
    status: { overall: 'ok', sentence: 'Demo power', at: 1, components: [
      { id: 'coder', name: 'Second model', state: 'up', sentence: 'Ready.', actions: ['restart', 'switch-model'],
        model: { live: 'demo-live', profiles: [
          { id: 'demo-live', name: 'Live fixture', gpus: [] },
          { id: 'demo-next', name: 'Next fixture', gpus: [] },
        ] },
      },
    ] },
    unavailable: false, loaded: true, sentence: 'Demo power', presence: [], completed: [], act: fixture.powerAct, refresh: vi.fn(),
    actionGuard: () => {
      const device = getState().device;
      return () => getState().device?.id === device?.id && getState().device?.kind === device?.kind && !getState().unpaired && !getState().sessionExpired;
    },
  }),
}));
vi.mock('./scheduleData', () => ({
  useScheduleOverview: () => ({ total: 1, failed: [], running: [], jobs: [] }),
}));
vi.mock('./components/ScheduledView', () => ({ ScheduledView: () => h('p', null, 'Scheduled fixture') }));
vi.mock('./components/SchedulesSheet', () => ({
  SchedulesSheet: () => h('section', { 'aria-label': 'Schedule' }, 'Schedule fixture'),
}));
vi.mock('./components/ConversationView', () => ({
  ConversationView: () => {
    useEffect(() => { fixture.mounts += 1; }, []);
    return h('section', { 'data-thread': true }, h('input', { 'aria-label': 'Thread draft', defaultValue: 'Draft fixture' }));
  },
}));

const initial = getState();
let root: Root;
let container: HTMLDivElement;
const click = async (selector: string) => {
  const button = container.querySelector<HTMLElement>(selector);
  expect(button, selector).not.toBeNull();
  await act(async () => button!.click());
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.phone = false;
  fixture.mounts = 0;
  fixture.powerAct.mockReset().mockResolvedValue({ kind: 'error', message: 'Demo fixture' });
  vi.stubGlobal('matchMedia', () => ({
    matches: fixture.phone, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
  localStorage.clear();
  history.replaceState(null, '', '/');
  setState(() => ({ ...initial, device: { id: 'demo-desktop', name: 'Demo desktop', kind: 'desktop', scopes: [], created: 1, lastSeen: 1 }, feed: {}, listLoaded: true, statuses: {
    hermes: { source: 'hermes', state: 'disabled' }, paseo: { source: 'paseo', state: 'disabled' },
  } }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shell routing and quick actions', () => {
  it('renders the settings schedule alias', async () => {
    history.replaceState(null, '', '/settings/schedule');
    await act(async () => root.render(h(App)));
    expect(container.querySelector('main [aria-label="Schedule"]')).not.toBeNull();
  });

  it.each(['attention', 'working'])('shows chats for a Home filter with Scheduled remembered: %s', async (filter) => {
    localStorage.setItem('signalbox:inbox-view', 'scheduled');
    history.replaceState(null, '', `/chats?filter=${filter}`);
    await act(async () => root.render(h(App)));
    const selected = container.querySelector('[role="tab"][aria-selected="true"]');
    expect(selected?.textContent).toContain('Recent');
    expect(container.querySelector('[aria-label="Filter"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Scheduled fixture');
  });

  it('selects chats when an existing inbox receives a filter URL', async () => {
    localStorage.setItem('signalbox:inbox-view', 'scheduled');
    history.replaceState(null, '', '/chats');
    await act(async () => root.render(h(App)));
    expect(container.textContent).toContain('Scheduled fixture');
    await act(async () => navigate('/chats?filter=working'));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Recent');
  });

  it('closes For you before opening its Settings page', async () => {
    history.replaceState(null, '', '/#for-you');
    await act(async () => root.render(h(App)));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await click('[role="dialog"] .link-btn');
    expect(location.pathname).toBe('/settings');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('.page-settings')).not.toBeNull();
  });

  it('replaces More when a For-you notification arrives', async () => {
    fixture.phone = true;
    await act(async () => root.render(h(App)));
    await click('[aria-label="More places"]');
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await act(async () => {
      history.replaceState(null, '', '/#for-you');
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('For you');
  });

  it('retains the open thread and its draft while changing and clearing filters', async () => {
    history.replaceState(null, '', '/c/hermes/demo-chat?keep=demo');
    await act(async () => root.render(h(App)));
    const input = container.querySelector<HTMLInputElement>('[aria-label="Thread draft"]')!;
    const push = vi.spyOn(history, 'pushState');
    const replace = vi.spyOn(history, 'replaceState');
    input.value = 'Unsaved fixture';
    const working = [...container.querySelectorAll<HTMLButtonElement>('.chip')].find((b) => b.textContent === 'Working')!;
    await act(async () => working.click());
    expect(location.pathname).toBe('/c/hermes/demo-chat');
    expect(new URLSearchParams(location.search).get('filter')).toBe('working');
    expect(new URLSearchParams(location.search).get('keep')).toBe('demo');
    expect(container.querySelector('[aria-label="Thread draft"]')).toBe(input);
    expect(input.value).toBe('Unsaved fixture');
    const all = [...container.querySelectorAll<HTMLButtonElement>('.chip')].find((b) => b.textContent === 'All')!;
    await act(async () => all.click());
    expect(location.pathname).toBe('/c/hermes/demo-chat');
    expect(new URLSearchParams(location.search).has('filter')).toBe(false);
    expect(fixture.mounts).toBe(1);
    expect(push).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(2);
  });

  it.each(['recent', 'projects'])('retains the active filter when opening threads from %s', async (view) => {
    localStorage.setItem('signalbox:inbox-view', view);
    setState((s) => ({ ...s, conversations: {
      'hermes:demo-working': { source: 'hermes', id: 'demo-working', title: 'Working fixture', status: 'running', updatedAt: 1, pendingApprovals: 0 },
      'hermes:demo-attention': { source: 'hermes', id: 'demo-attention', title: 'Attention fixture', status: 'needs_approval', updatedAt: 1, pendingApprovals: 1 },
      'hermes:demo-idle': { source: 'hermes', id: 'demo-idle', title: 'Unrelated fixture', status: 'idle', updatedAt: 1, pendingApprovals: 0 },
    } }));
    history.replaceState(null, '', '/chats?filter=working');
    await act(async () => root.render(h(App)));
    await click('.row');
    expect(location.pathname).toBe('/c/hermes/demo-working');
    expect(location.search).toBe('?filter=working');
    expect(container.querySelector('.chip[aria-pressed="true"]')?.textContent).toContain('Working');
    expect(container.querySelectorAll('.row')).toHaveLength(1);
    await act(async () => navigate('/chats?filter=attention'));
    await click('.row');
    expect(location.pathname).toBe('/c/hermes/demo-attention');
    expect(location.search).toBe('?filter=attention');
    expect(container.querySelector('.chip[aria-pressed="true"]')?.textContent).toContain('Needs you');
    expect(container.querySelectorAll('.row')).toHaveLength(1);
  });

  it.each(['navigation', 'browser back'])('dismisses an existing power confirmation on %s away from Status', async (leave) => {
    fixture.phone = true;
    fixture.powerAct.mockResolvedValue({ kind: 'confirm', confirm: { confirm: 'demo-confirm-token', summary: 'Restart Second model.' } });
    await act(async () => root.render(h(App)));
    await act(async () => navigate('/settings/status'));
    await click('.power-actions button');
    await click('[role="menuitem"]');
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    await act(async () => {
      if (leave === 'navigation') navigate('/');
      else await new Promise<void>((resolve) => {
        window.addEventListener('popstate', () => resolve(), { once: true });
        history.back();
      });
    });
    expect(location.pathname).toBe('/');
    expect(container.querySelector('[aria-modal="true"]')).toBeNull();
    await act(async () => navigate('/settings/status'));
    expect(container.querySelector('[aria-modal="true"]')).toBeNull();
    expect(fixture.powerAct).toHaveBeenCalledTimes(1);
  });

  it('replaces More with a delayed power confirmation and resends the exact request', async () => {
    fixture.phone = true;
    let resolve!: (result: ActResult) => void;
    fixture.powerAct.mockImplementationOnce(() => new Promise<ActResult>((done) => { resolve = done; }));
    history.replaceState(null, '', '/settings/status');
    await act(async () => root.render(h(App)));
    await click('.power-actions button');
    await click('[role="menuitem"]');
    await click('[aria-label="More places"]');
    expect(container.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
    await act(async () => resolve({ kind: 'confirm', confirm: { confirm: 'demo-confirm-token', summary: 'Restart Second model.' } }));
    expect(container.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('Restart Second model.');
    expect(container.querySelector('[role="alertdialog"]')?.contains(document.activeElement)).toBe(true);
    await click('[role="alertdialog"] .btn-primary');
    expect(fixture.powerAct).toHaveBeenLastCalledWith({ verb: 'restart', target: 'coder', when: 'now', confirm: 'demo-confirm-token' });
    expect(container.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it.each(['Restart', 'Switch model'].flatMap((action) => ['error', 'busy', 'queued'].map((outcome) => ({ action, outcome }))))(
    'restores $action focus after confirmation and a delayed $outcome response', async ({ action, outcome }) => {
      fixture.phone = true;
      let resolve!: (result: ActResult) => void;
      fixture.powerAct.mockResolvedValueOnce({ kind: 'confirm', confirm: { confirm: 'demo-confirm-token', summary: 'Demo action.' } });
      fixture.powerAct.mockImplementationOnce(() => new Promise<ActResult>((done) => { resolve = done; }));
      history.replaceState(null, '', '/settings/status');
      await act(async () => root.render(h(App)));
      const trigger = [...container.querySelectorAll<HTMLButtonElement>('.power-actions button')].find((b) => b.textContent === action)!;
      trigger.focus();
      await act(async () => trigger.click());
      await click('[role="menuitem"]');
      expect(container.querySelector('[role="alertdialog"]')?.contains(document.activeElement)).toBe(true);
      await click('[role="alertdialog"] .btn-primary');
      expect(trigger.disabled).toBe(true);
      expect(fixture.powerAct).toHaveBeenLastCalledWith({
        verb: action === 'Restart' ? 'restart' : 'switch-model', target: 'coder', when: 'now',
        ...(action === 'Switch model' ? { profile: 'demo-next' } : {}), confirm: 'demo-confirm-token',
      });
      const summary = { id: 'demo-action', verb: 'restart' as const, target: 'coder', state: 'queued' as const, caller: 'demo', startedAt: 1 };
      await act(async () => resolve(outcome === 'queued' ? { kind: 'queued', action: summary }
        : outcome === 'busy' ? { kind: 'busy', running: summary, message: 'Demo busy' }
          : { kind: 'error', message: 'Demo failure' }));
      expect(trigger.disabled).toBe(false);
      expect(document.activeElement).toBe(trigger);
    },
  );

  it.each(['Cancel', 'Escape', 'backdrop'])('returns to the power trigger when confirmation is dismissed by %s', async (dismissal) => {
    fixture.phone = true;
    fixture.powerAct.mockResolvedValueOnce({ kind: 'confirm', confirm: { confirm: 'demo-confirm-token', summary: 'Demo action.' } });
    history.replaceState(null, '', '/settings/status');
    await act(async () => root.render(h(App)));
    const trigger = container.querySelector<HTMLButtonElement>('.power-actions button')!;
    trigger.focus();
    await click('.power-actions button');
    await click('[role="menuitem"]');
    await act(async () => {
      const dialog = container.querySelector<HTMLElement>('[role="alertdialog"]')!;
      if (dismissal === 'Cancel') dialog.querySelector<HTMLButtonElement>('.btn-secondary')!.click();
      else if (dismissal === 'Escape') document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      else dialog.parentElement!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(container.querySelector('[aria-modal="true"]')).toBeNull();
    expect(fixture.powerAct).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the new focus owner when a confirmed power request finishes late', async () => {
    let resolve!: (result: ActResult) => void;
    fixture.powerAct.mockResolvedValueOnce({ kind: 'confirm', confirm: { confirm: 'demo-confirm-token', summary: 'Demo action.' } });
    fixture.powerAct.mockImplementationOnce(() => new Promise<ActResult>((done) => { resolve = done; }));
    history.replaceState(null, '', '/settings/status');
    await act(async () => root.render(h(App)));
    await click('.power-actions button');
    await click('[role="menuitem"]');
    await click('[role="alertdialog"] .btn-primary');
    const details = container.querySelector<HTMLElement>('.power-details summary')!;
    await act(async () => details.focus());
    await act(async () => resolve({ kind: 'error', message: 'Demo failure' }));
    expect(document.activeElement).toBe(details);
  });

  it('replaces a power confirmation with a new quick action without submitting it', async () => {
    fixture.phone = true;
    fixture.powerAct.mockResolvedValue({ kind: 'confirm', confirm: { confirm: 'demo-confirm-token', summary: 'Restart Second model.' } });
    history.replaceState(null, '', '/settings/status');
    await act(async () => root.render(h(App)));
    await click('.power-actions button');
    await click('[role="menuitem"]');
    await click('[aria-label="More places"]');
    expect(container.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(fixture.powerAct).toHaveBeenCalledTimes(1);
  });

  it('discards a power confirmation if its page was left while the response was pending', async () => {
    let resolve!: (result: ActResult) => void;
    fixture.powerAct.mockImplementationOnce(() => new Promise<ActResult>((done) => { resolve = done; }));
    history.replaceState(null, '', '/settings/status');
    await act(async () => root.render(h(App)));
    await click('.power-actions button');
    await click('[role="menuitem"]');
    await act(async () => navigate('/'));
    await act(async () => resolve({ kind: 'confirm', confirm: { confirm: 'demo-confirm-token', summary: 'Restart Second model.' } }));
    expect(container.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('dismisses a power confirmation and hides controls when the session expires', async () => {
    fixture.powerAct.mockResolvedValue({ kind: 'confirm', confirm: { confirm: 'demo-confirm-token', summary: 'Restart Second model.' } });
    history.replaceState(null, '', '/settings/status');
    await act(async () => root.render(h(App)));
    await click('.power-actions button');
    await click('[role="menuitem"]');
    expect(container.querySelector('.confirm-card')).not.toBeNull();
    await act(async () => markSignedOut());
    expect(container.querySelector('.confirm-card')).toBeNull();
    expect(container.querySelector('.power-actions')).toBeNull();
    expect(container.querySelector('[aria-label="Session expired"]')).not.toBeNull();
    expect(fixture.powerAct).toHaveBeenCalledTimes(1);
  });

  it('discards a confirmation returned after session expiry', async () => {
    let resolve!: (result: ActResult) => void;
    fixture.powerAct.mockImplementationOnce(() => new Promise<ActResult>((done) => { resolve = done; }));
    history.replaceState(null, '', '/settings/status');
    await act(async () => root.render(h(App)));
    await click('.power-actions button');
    await click('[role="menuitem"]');
    await act(async () => markSignedOut());
    await act(async () => resolve({ kind: 'confirm', confirm: { confirm: 'demo-confirm-token', summary: 'Restart Second model.' } }));
    expect(container.querySelector('.confirm-card')).toBeNull();
    expect(container.querySelector('[aria-label="Session expired"]')).not.toBeNull();
  });
});
