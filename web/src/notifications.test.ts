import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotificationSettingsView } from '../../shared/protocol';
import type { SettingsNotificationsBody } from '../../shared/settings';
import { api, request } from './api';
import { applyEvent, getState, setState } from './store';

// Notifications in the app: the server says what the rules allowed, and this page only shows it.

const initial = getState();
afterEach(() => {
  setState(() => initial);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const view = (extra: Partial<NotificationSettingsView> = {}): NotificationSettingsView => ({
  rules: [{ event: 'agent-needs-you', source: '*', delivery: 'both' }],
  quietHours: { start: '21:00', end: '07:00' },
  push: { approvals: true, cards: false },
  pushAvailable: true,
  pushDevices: 1,
  presence: 'active',
  timeZoneConfigured: false,
  ...extra,
});

const desktop = { id: 'dv_desktop', name: 'This PC', kind: 'desktop' as const, scopes: [], created: 1, lastSeen: 1 };
const phone = { ...desktop, id: 'dv_phone', name: 'An phone', kind: 'phone' as const };

describe('an alert the server sent to the app', () => {
  it('shows mandatory alerts on an open phone app', () => {
    setState((s) => ({ ...s, device: phone }));
    applyEvent({ type: 'notification', notification: { event: 'agent-needs-you', source: 'hermes', title: 'An answer is needed', url: '/x', at: 1 } });
    expect(getState().toasts.map((toast) => toast.text)).toEqual(['An answer is needed']);
  });
  it('shows with its title and its one line of text', () => {
    setState((s) => ({ ...s, device: desktop }));
    applyEvent({
      type: 'notification',
      notification: { event: 'agent-finished', source: 'hermes', title: 'Hermes is done', body: 'The report is ready', url: '/c/hermes/conv-9', at: 1 },
    });
    expect(getState().toasts).toEqual([{ id: expect.any(Number), text: 'Hermes is done · The report is ready', tone: 'info' }]);
  });

  it('shows the title alone when there is nothing to add', () => {
    setState((s) => ({ ...s, device: desktop }));
    applyEvent({ type: 'notification', notification: { event: 'agent-error', source: 'paseo', title: 'Paseo failed', url: '/x', at: 1 } });
    expect(getState().toasts.map((toast) => toast.text)).toEqual(['Paseo failed']);
  });

  it('stops interrupting after a few seconds, and keeps the newest of them', () => {
    setState((s) => ({ ...s, device: desktop }));
    vi.useFakeTimers();
    for (const title of ['One', 'Two', 'Three']) {
      applyEvent({ type: 'notification', notification: { event: 'agent-finished', source: 'hermes', title, url: '/x', at: 1 } });
    }
    expect(getState().toasts.map((toast) => toast.text)).toEqual(['One', 'Two', 'Three']);
    vi.advanceTimersByTime(4_500);
    expect(getState().toasts).toEqual([]);
  });

  it.each([['a phone', phone], ['a browser nobody paired', undefined]])('says nothing on %s', (_what, device) => {
    setState((s) => ({ ...s, device }));
    // The rules kept this alert off the PC's screen, so the server sent no event at all.
    applyEvent({ type: 'notification', notification: { event: 'agent-finished', source: 'hermes', title: 'Hermes is done', url: '/x', at: 1 } });
    expect(getState().toasts).toEqual([]);
  });
});

describe('the settings request', () => {
  it('reads the rules and the hours from Wayroost’s own settings', async () => {
    const calls: Array<[string, string, unknown]> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      calls.push([init.method ?? 'GET', String(input), init.body ? JSON.parse(String(init.body)) : undefined]);
      return Response.json(view());
    }));
    expect(await api.notificationSettings()).toEqual(view());
    expect(calls).toEqual([['GET', '/api/settings/notifications', undefined]]);
  });

  it('sends every rule, the hours and the switches when it saves', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const body: SettingsNotificationsBody = {
      rules: [{ event: 'feed-card', source: '*', delivery: 'both' }],
      quietHours: null,
      push: { approvals: true, cards: true },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      calls.push([init.method ?? 'GET', String(input), init.body ? JSON.parse(String(init.body)) : undefined]);
      return Response.json(init.method === 'PUT' ? { status: 'applied' } : view(body));
    }));
    expect(await api.setNotificationSettings(body)).toEqual(view(body));
    expect(calls).toEqual([['PUT', '/api/settings/notifications', body], ['GET', '/api/settings/notifications', undefined]]);
  });

  it('reports a fixed settings refusal without treating it as a saved view', async () => {
    const fetch = vi.fn(async () => Response.json({ status: 'refused', code: 'audit_unavailable' }, { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    await expect(api.setNotificationSettings({ quietHours: null })).rejects.toThrow('Settings change refused: audit unavailable.');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not refresh or report success for a confirmation response', async () => {
    const fetch = vi.fn(async () => Response.json({ status: 'confirm', confirm: 'DEMO', summary: 'Save', expiresAt: 1 }));
    vi.stubGlobal('fetch', fetch);
    await expect(api.setNotificationSettings({ quietHours: null })).rejects.toThrow('needs confirmation');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('reports a server that refuses the rules', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'each event and source once' }, { status: 400 })));
    await expect(request('PUT', '/api/settings/notifications', {})).rejects.toThrow('each event and source once');
  });
});
