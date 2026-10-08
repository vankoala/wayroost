// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationSettingsView } from '../../shared/protocol';
import { NotificationRules } from './components/NotificationRules';
import { ForYouSettings } from './components/ForYouSettings';
import { api, serializeNotificationSettingsSave } from './api.js';
import { disablePush, enablePush, pushState } from './push';
import { getState, setState } from './store';

// The notification rules page: the rules as an owner changes them, and what the page says about them.

const fixture = vi.hoisted(() => ({
  view: {
    rules: [
      { event: 'agent-needs-you', source: '*', delivery: 'both' },
      { event: 'agent-finished', source: '*', delivery: 'toast' },
    ],
    quietHours: { start: '21:00', end: '07:00' },
    push: { approvals: true, cards: false },
    pushAvailable: true,
    pushDevices: 1,
    presence: 'active',
    timeZoneConfigured: false,
  } as unknown as NotificationSettingsView,
  saved: [] as unknown[],
  failure: '' as string,
  feedEnabled: false,
}));

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api.js')>('./api.js');
  const feedSettings = () => ({
    level: 'normal', pulseFound: true, lessLike: [],
    quietHours: fixture.view.quietHours, push: fixture.view.push,
    pushAvailable: fixture.view.pushAvailable, pushDevices: fixture.view.pushDevices,
  });
  return { ...actual, api: {
    feed: async () => {
      if (!fixture.feedEnabled) throw new Error('For you is disabled.');
      return { settings: feedSettings() };
    },
    feedSettings: async (patch: { quietHours?: NotificationSettingsView['quietHours'] }) => {
      fixture.view = { ...fixture.view, ...patch };
      return feedSettings();
    },
    pushTest: vi.fn(async () => ({ sent: 1 })),
    pushKey: async () => ({ publicKey: 'AQID' }),
    pushAddDevice: vi.fn(async () => { fixture.view = { ...fixture.view, pushDevices: 1 }; return { devices: 1 }; }),
    notificationSettings: vi.fn(async () => fixture.view),
    setNotificationSettings: (body: unknown) => {
      if (fixture.failure) return Promise.reject(new Error(fixture.failure));
      fixture.saved.push(body);
      // The server's answer is what the page shows afterwards, rules and all.
      const saved = body as { rules: NotificationSettingsView['rules']; quietHours: NotificationSettingsView['quietHours']; push: NotificationSettingsView['push'] };
      fixture.view = { ...fixture.view, ...saved };
      return Promise.resolve(fixture.view);
    },
  } };
});

vi.mock('./push', () => ({
  pushState: vi.fn(async () => 'off'),
  enablePush: vi.fn(async () => { fixture.view = { ...fixture.view, pushDevices: 1 }; return 'on'; }),
  disablePush: vi.fn(async () => { fixture.view = { ...fixture.view, pushDevices: 0 }; return 'off'; }),
}));

const initial = getState();
const startingView = fixture.view;
beforeEach(() => setState(s => ({ ...s, rollout: { settingsPages: true, revokes: true, chatFirst: true } })));
let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(withFeed = false): Promise<HTMLDivElement> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(h('div', {}, h(NotificationRules), withFeed && h(ForYouSettings))));
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  setState(() => initial);
  fixture.saved.length = 0;
  fixture.failure = '';
  fixture.feedEnabled = false;
  fixture.view = startingView;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(api.notificationSettings).mockReset().mockImplementation(async () => fixture.view);
  vi.unstubAllGlobals();
  vi.mocked(pushState).mockResolvedValue('off');
  vi.mocked(enablePush).mockImplementation(async () => { fixture.view = { ...fixture.view, pushDevices: 1 }; return 'on'; });
});

const select = (box: HTMLElement, label: string): HTMLSelectElement =>
  box.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
const button = (box: HTMLElement, label: string): HTMLButtonElement =>
  box.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;

describe('notification write rollout', () => {
  it.each(['quiet hours', 'phone alerts'].flatMap(control => [false, undefined].map(settingsPages => ({ control, settingsPages }))))
  ('cancels a delayed $control save when settings metadata becomes $settingsPages', async ({ control, settingsPages }) => {
    const box = await render();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(api.notificationSettings).mockImplementationOnce(async () => { await waiting; return fixture.view; });
    await act(async () => {
      if (control === 'quiet hours') {
        const start = select(box, 'Quiet hours start');
        start.value = '22:00';
        start.dispatchEvent(new Event('change', { bubbles: true }));
      } else button(box, 'Notify when an agent needs you').click();
    });
    await act(async () => setState(s => ({ ...s, rollout: settingsPages === undefined ? undefined
      : { settingsPages, revokes: false, chatFirst: false } })));
    await act(async () => release());
    expect(fixture.saved).toEqual([]);
    expect(fixture.view.quietHours).toEqual(startingView.quietHours);
    expect(fixture.view.push).toEqual(startingView.push);
    expect(select(box, 'Quiet hours start').matches(':disabled')).toBe(true);
  });

  it.each(['rules', 'quiet hours', 'phone alerts'])('cancels a queued %s save before it reads or writes', async control => {
    const box = await render();
    await act(async () => {
      const delivery = select(box, 'Alert 2 delivery');
      delivery.value = 'push';
      delivery.dispatchEvent(new Event('change', { bubbles: true }));
    });
    let release!: () => void;
    const queued = serializeNotificationSettingsSave(() => new Promise<void>(resolve => { release = resolve; }));
    await act(async () => {
      button(box, control === 'rules' ? 'Save notification rules' : control === 'quiet hours' ? 'Quiet hours' : 'Notify when an agent needs you').click();
    });
    await act(async () => setState(s => ({ ...s, rollout: undefined })));
    const reads = vi.mocked(api.notificationSettings).mock.calls.length;
    await act(async () => { release(); await queued; });
    expect(vi.mocked(api.notificationSettings)).toHaveBeenCalledTimes(reads);
    expect(fixture.saved).toEqual([]);
  });

  it('does not resume a cancelled save when settings rollout reopens before its read returns', async () => {
    const box = await render();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(api.notificationSettings).mockImplementationOnce(async () => { await waiting; return fixture.view; });
    await act(async () => {
      const start = select(box, 'Quiet hours start');
      start.value = '22:00';
      start.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => setState(s => ({ ...s, rollout: { settingsPages: false, revokes: false, chatFirst: false } })));
    await act(async () => setState(s => ({ ...s, rollout: { settingsPages: true, revokes: false, chatFirst: false } })));
    await act(async () => release());
    expect(fixture.saved).toEqual([]);
    await act(async () => button(box, 'Quiet hours').click());
    expect(fixture.saved).toEqual([{ quietHours: null }]);
  });
});

describe('For-you rollout', () => {
  it.each([false, undefined, true])('requires explicit enabled settings metadata for every write, received %s', async settingsPages => {
    fixture.feedEnabled = true;
    const feed = api.feed;
    vi.spyOn(api, 'feed').mockImplementation(async () => {
      const list = await feed();
      return { ...list, settings: { ...list.settings, lessLike: [{ topic: 'Example topic', example: 'Example card', at: 0 }] } };
    });
    setState(s => ({ ...s, rollout: settingsPages === undefined ? undefined : { settingsPages, revokes: false, chatFirst: false } }));
    const save = vi.spyOn(api, 'feedSettings');
    const box = (await render(true)).querySelector<HTMLElement>('.foryou-settings')!;
    expect(box.textContent).toContain('Quiet hours');
    expect(button(box, 'Bring back Example topic')).toBeTruthy();
    const deviceSwitch = button(box, 'Notifications on this device');
    const deviceTest = [...box.querySelectorAll<HTMLButtonElement>('button')].find(control => control.textContent?.trim() === 'Send a test')!;
    expect(deviceSwitch.matches(':disabled')).toBe(false);
    expect(deviceTest.matches(':disabled')).toBe(false);
    const controls = [...box.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select')].filter(control => control !== deviceSwitch && control !== deviceTest);
    expect(controls.length).toBeGreaterThan(5);
    for (const control of controls) expect(control.matches(':disabled'), control.getAttribute('aria-label') ?? control.textContent).toBe(settingsPages !== true);
    await act(async () => button(box, 'Quiet hours').click());
    expect(save).toHaveBeenCalledTimes(settingsPages === true ? 1 : 0);
    if (settingsPages !== true) {
      await act(async () => {
        for (const control of controls) {
          if (control.tagName === 'SELECT') control.dispatchEvent(new Event('change', { bubbles: true }));
          else control.click();
        }
      });
      expect(save).not.toHaveBeenCalled();
      expect(enablePush).not.toHaveBeenCalled();
      expect(disablePush).not.toHaveBeenCalled();
      expect(api.pushTest).not.toHaveBeenCalled();
    }
  });

  it('locks already loaded For-you controls when settings rollout disappears', async () => {
    fixture.feedEnabled = true;
    const save = vi.spyOn(api, 'feedSettings');
    const box = (await render(true)).querySelector<HTMLElement>('.foryou-settings')!;
    expect(button(box, 'Quiet hours').disabled).toBe(false);
    await act(async () => setState(s => ({ ...s, rollout: undefined })));
    expect(button(box, 'Quiet hours').disabled).toBe(true);
    await act(async () => button(box, 'Quiet hours').click());
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a quiet-hours save if rollout is disabled while its current values are loading', async () => {
    fixture.feedEnabled = true;
    const box = (await render(true)).querySelector<HTMLElement>('.foryou-settings')!;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const feed = api.feed;
    vi.spyOn(api, 'feed').mockImplementationOnce(async () => { await pending; return feed(); });
    const save = vi.spyOn(api, 'feedSettings');
    await act(async () => {
      const control = select(box, 'Quiet hours start');
      control.value = '22:00';
      control.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => setState(s => ({ ...s, rollout: { settingsPages: false, revokes: false, chatFirst: false } })));
    await act(async () => release());
    expect(save).not.toHaveBeenCalled();
    expect(select(box, 'Quiet hours start').disabled).toBe(true);
  });

  it.each(['read', 'queue'].flatMap(wait => [false, undefined].flatMap(settingsPages =>
    [false, true].map(batched => ({ wait, settingsPages, batched })))))
  ('cancels a quiet-hours save waiting on $wait after rollout becomes $settingsPages and reopens, batched: $batched', async ({ wait, settingsPages, batched }) => {
    fixture.feedEnabled = true;
    const box = (await render(true)).querySelector<HTMLElement>('.foryou-settings')!;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const feed = api.feed;
    const read = vi.spyOn(api, 'feed');
    if (wait === 'read') read.mockImplementationOnce(async () => { await waiting; return feed(); });
    const queued = wait === 'queue' ? serializeNotificationSettingsSave(() => waiting) : undefined;
    const save = vi.spyOn(api, 'feedSettings');
    await act(async () => {
      const start = select(box, 'Quiet hours start');
      start.value = '22:00';
      start.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const close = () => setState(s => ({ ...s, rollout: settingsPages === undefined ? undefined
      : { settingsPages, revokes: false, chatFirst: false } }));
    const reopen = () => setState(s => ({ ...s, rollout: { settingsPages: true, revokes: false, chatFirst: false } }));
    if (batched) await act(async () => { close(); reopen(); });
    else {
      await act(async () => close());
      await act(async () => reopen());
    }
    const reads = read.mock.calls.length;
    await act(async () => { release(); await queued; });
    expect(read).toHaveBeenCalledTimes(reads);
    expect(save).not.toHaveBeenCalled();
    expect(fixture.view.quietHours).toEqual(startingView.quietHours);
    expect(select(box, 'Quiet hours start').value).toBe('21:00');
    expect(select(box, 'Quiet hours start').disabled).toBe(false);
    await act(async () => {
      const start = select(box, 'Quiet hours start');
      start.value = '22:00';
      start.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(save).toHaveBeenCalledExactlyOnceWith({ quietHours: { start: '22:00', end: '07:00' } });
  });

  it.each(['quiet hours', 'phone alerts', 'proactivity', 'topic'])('cancels a queued %s write through a missing-metadata and reenable cycle', async control => {
    fixture.feedEnabled = true;
    const feed = api.feed;
    vi.spyOn(api, 'feed').mockImplementation(async () => {
      const list = await feed();
      return { ...list, settings: { ...list.settings, lessLike: [{ topic: 'Example topic', example: 'Example card', at: 0 }] } };
    });
    const box = (await render(true)).querySelector<HTMLElement>('.foryou-settings')!;
    let release!: () => void;
    const queued = serializeNotificationSettingsSave(() => new Promise<void>(resolve => { release = resolve; }));
    const save = vi.spyOn(api, 'feedSettings');
    await act(async () => {
      if (control === 'proactivity') {
        const level = select(box, 'How often Hermes speaks up');
        level.value = 'low';
        level.dispatchEvent(new Event('change', { bubbles: true }));
      } else button(box, control === 'quiet hours' ? 'Quiet hours'
        : control === 'phone alerts' ? 'Notify when an agent needs you' : 'Bring back Example topic').click();
    });
    await act(async () => {
      setState(s => ({ ...s, rollout: undefined }));
      setState(s => ({ ...s, rollout: { settingsPages: true, revokes: false, chatFirst: false } }));
    });
    await act(async () => { release(); await queued; });
    expect(save).not.toHaveBeenCalled();
    expect(button(box, 'Quiet hours').disabled).toBe(false);
    await act(async () => button(box, 'Quiet hours').click());
    expect(save).toHaveBeenCalledExactlyOnceWith({ quietHours: null });
  });
});

describe('phone controls without For you', () => {
  it('subscribes an HTTPS browser from the settings switch with For you disabled', async () => {
    fixture.view = { ...fixture.view, pushDevices: 0 };
    const requestPermission = vi.fn(async () => 'granted');
    const subscription = { toJSON: () => ({ endpoint: 'https://example.com/push/demo', keys: { p256dh: 'demo-public-key', auth: 'demo-auth' } }) };
    const subscribe = vi.fn(async () => subscription);
    const registration = { pushManager: { getSubscription: async () => null, subscribe } };
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('Notification', { permission: 'default', requestPermission });
    vi.stubGlobal('PushManager', class {});
    vi.stubGlobal('navigator', { userAgent: 'Example browser', platform: 'Linux', maxTouchPoints: 0,
      serviceWorker: { getRegistration: async () => registration, ready: Promise.resolve(registration) } });
    const actual = await vi.importActual<typeof import('./push')>('./push');
    vi.mocked(enablePush).mockImplementation(actual.enablePush);
    const box = await render(true);
    await act(async () => button(box, 'Notifications on this device').click());
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2, 3]) });
    expect(api.pushAddDevice).toHaveBeenCalledWith({ endpoint: 'https://example.com/push/demo',
      keys: { p256dh: 'demo-public-key', auth: 'demo-auth' }, label: 'Safari on Linux' });
    expect(button(box, 'Notifications on this device').getAttribute('aria-checked')).toBe('true');
  });

  it('registers and removes this device when For you is disabled', async () => {
    fixture.view = { ...fixture.view, pushDevices: 0 };
    const box = await render(true);
    expect(box.querySelector('.foryou-settings')).toBeNull();
    expect(button(box, 'Notifications on this device')).not.toBeNull();
    await act(async () => button(box, 'Notifications on this device').click());
    expect(enablePush).toHaveBeenCalledOnce();
    expect(button(box, 'Notifications on this device').getAttribute('aria-checked')).toBe('true');
    expect(box.textContent).toContain('1 device can be pushed to');
    expect(Array.from(box.querySelectorAll('button')).some((item) => item.textContent?.includes('Send a test'))).toBe(true);
    await act(async () => Array.from(box.querySelectorAll('button')).find((item) => item.textContent === 'Send a test')!.click());
    expect(api.pushTest).toHaveBeenCalledOnce();
    await act(async () => button(box, 'Notifications on this device').click());
    expect(disablePush).toHaveBeenCalledOnce();
    expect(button(box, 'Notifications on this device').getAttribute('aria-checked')).toBe('false');
    expect(box.textContent).toContain('No device can be pushed to');
  });

  it.each([
    ['denied', 'Blocked for this site'], ['needs-install', 'Home Screen'], ['unsupported', "can't show notifications"],
  ] as const)('explains %s instead of showing an unusable subscription switch', async (state, help) => {
    vi.mocked(pushState).mockResolvedValue(state);
    const box = await render(true);
    expect(box.textContent).toContain(help);
    expect(button(box, 'Notifications on this device')).toBeNull();
  });

  it('edits shared quiet hours and push switches while preserving draft rules', async () => {
    const box = await render(true);
    for (const label of ['Quiet hours start', 'Quiet hours end']) {
      expect(select(box, label).closest('.kv')?.querySelector('.setting-timing')?.textContent).toBe('From the next alert');
    }
    await act(async () => {
      const delivery = select(box, 'Alert 2 delivery');
      delivery.value = 'push'; delivery.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => button(box, 'Quiet hours').click());
    expect(fixture.saved.at(-1)).toEqual({ quietHours: null });
    expect(button(box, 'Quiet hours').getAttribute('aria-checked')).toBe('false');
    await act(async () => button(box, 'Quiet hours').click());
    expect(fixture.saved.at(-1)).toEqual({ quietHours: { start: '21:00', end: '07:00' } });
    await act(async () => {
      const start = select(box, 'Quiet hours start');
      start.value = '20:30'; start.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(fixture.saved.at(-1)).toEqual({ quietHours: { start: '20:30', end: '07:00' } });
    await act(async () => button(box, 'Notify when an agent needs you').click());
    expect(fixture.saved.at(-1)).toEqual({ push: { approvals: false, cards: false } });
    await act(async () => button(box, 'Notify about new For-you cards').click());
    expect(fixture.saved.at(-1)).toEqual({ push: { approvals: false, cards: true } });
    expect(fixture.view.rules).toEqual(startingView.rules);
    expect(select(box, 'Alert 2 delivery').value).toBe('push');
    expect(button(box, 'Save notification rules').disabled).toBe(false);
  });

  it('preserves a phone switch changed elsewhere before saving the other one', async () => {
    const box = await render(true);
    fixture.view = { ...fixture.view, push: { approvals: true, cards: true } };
    await act(async () => button(box, 'Notify when an agent needs you').click());
    expect(fixture.saved.at(-1)).toEqual({ push: { approvals: false, cards: true } });
  });

  it('keeps the shared controls unchanged after a refused save', async () => {
    const box = await render(true);
    fixture.failure = 'Settings could not be saved.';
    await act(async () => button(box, 'Quiet hours').click());
    expect(button(box, 'Quiet hours').getAttribute('aria-checked')).toBe('true');
    expect(select(box, 'Quiet hours start').value).toBe('21:00');
    expect(getState().toasts.map((toast) => toast.text)).toEqual(['Settings could not be saved.']);
  });
});

describe('refreshing shared settings', () => {
  const changeSelect = async (box: HTMLElement, label: string, value: string) => {
    await act(async () => {
      const el = select(box, label);
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  it.each(['.foryou-settings', '.notification-rules'].flatMap((first) =>
    ['start', 'end'].flatMap((endpoint) => ['read', 'write'].map((delay) => ({ first, endpoint, delay })))))
  ('preserves overlapping $endpoint edits from $first with a delayed $delay', async ({ first, endpoint, delay }) => {
    fixture.feedEnabled = true;
    const box = await render(true);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    if (first === '.foryou-settings') {
      if (delay === 'read') {
        const read = api.feed;
        vi.spyOn(api, 'feed').mockImplementationOnce(async () => {
          const snapshot = await read();
          await pending;
          return snapshot;
        });
      } else {
        const write = api.feedSettings;
        vi.spyOn(api, 'feedSettings').mockImplementationOnce(async (patch) => {
          await pending;
          return write(patch);
        });
      }
    } else if (delay === 'read') {
      const read = api.notificationSettings;
      vi.spyOn(api, 'notificationSettings').mockImplementationOnce(async () => {
        const snapshot = await read();
        await pending;
        return snapshot;
      });
    } else {
      const write = api.setNotificationSettings;
      vi.spyOn(api, 'setNotificationSettings').mockImplementationOnce(async (patch) => {
        await pending;
        return write(patch);
      });
    }
    const second = first === '.foryou-settings' ? '.notification-rules' : '.foryou-settings';
    await changeSelect(box.querySelector(first)!, `Quiet hours ${endpoint}`, endpoint === 'start' ? '22:00' : '08:00');
    await changeSelect(box.querySelector(second)!, `Quiet hours ${endpoint === 'start' ? 'end' : 'start'}`,
      endpoint === 'start' ? '08:00' : '22:00');
    await act(async () => release());
    expect(fixture.view.quietHours).toEqual({ start: '22:00', end: '08:00' });
    expect(select(box.querySelector(second)!, 'Quiet hours start').value).toBe('22:00');
    expect(select(box.querySelector(second)!, 'Quiet hours end').value).toBe('08:00');
  });

  it('allows the other editor to save after a quiet-hours save fails', async () => {
    fixture.feedEnabled = true;
    const box = await render(true);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(api, 'feedSettings').mockImplementationOnce(async () => {
      await pending;
      throw new Error('Settings could not be saved.');
    });
    await changeSelect(box.querySelector('.foryou-settings')!, 'Quiet hours start', '22:00');
    await changeSelect(box.querySelector('.notification-rules')!, 'Quiet hours end', '08:00');
    await act(async () => release());
    expect(fixture.view.quietHours).toEqual({ start: '21:00', end: '08:00' });
    expect(select(box.querySelector('.foryou-settings')!, 'Quiet hours start').value).toBe('21:00');
    expect(select(box.querySelector('.notification-rules')!, 'Quiet hours end').value).toBe('08:00');
    expect(select(box.querySelector('.notification-rules')!, 'Quiet hours end').disabled).toBe(false);
    expect(getState().toasts.map((toast) => toast.text)).toEqual(['Settings could not be saved.']);
  });

  it.each(['before', 'during'])('discards a subscription refresh started %s a successful rule save', async (when) => {
    let resolvePush!: (state: Awaited<ReturnType<typeof pushState>>) => void;
    vi.mocked(pushState).mockReturnValueOnce(new Promise((resolve) => { resolvePush = resolve; }));
    const box = await render();
    const snapshot = fixture.view;
    let releaseRead!: (settings: NotificationSettingsView) => void;
    vi.mocked(api.notificationSettings).mockReturnValueOnce(new Promise((resolve) => { releaseRead = resolve; }));
    let releaseWrite!: () => void;
    const pendingWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const write = api.setNotificationSettings;
    vi.spyOn(api, 'setNotificationSettings').mockImplementationOnce(async (patch) => {
      await pendingWrite;
      return write(patch);
    });
    if (when === 'before') await act(async () => resolvePush('on'));
    await changeSelect(box, 'Alert 2 delivery', 'neither');
    await act(async () => button(box, 'Save notification rules').click());
    if (when === 'during') await act(async () => resolvePush('on'));
    await act(async () => releaseWrite());
    expect(fixture.view.rules[1]!.delivery).toBe('neither');
    await act(async () => releaseRead(snapshot));
    expect(select(box, 'Alert 2 delivery').value).toBe('neither');
    expect(button(box, 'Save notification rules').disabled).toBe(true);
    await changeSelect(box, 'Alert 1 delivery', 'toast');
    await act(async () => button(box, 'Save notification rules').click());
    expect(fixture.view.rules.map((rule) => rule.delivery)).toEqual(['toast', 'neither']);
  });

  it.each([
    ['.foryou-settings', '.notification-rules'],
    ['.notification-rules', '.foryou-settings'],
  ])('preserves the start changed in %s when editing the end in %s', async (first, second) => {
    fixture.feedEnabled = true;
    const box = await render(true);
    await changeSelect(box.querySelector(first)!, 'Quiet hours start', '22:00');
    await changeSelect(box.querySelector(second)!, 'Quiet hours end', '08:00');
    expect(fixture.view.quietHours).toEqual({ start: '22:00', end: '08:00' });
    expect(select(box.querySelector(second)!, 'Quiet hours start').value).toBe('22:00');
  });

  it.each([
    ['.foryou-settings', '.notification-rules'],
    ['.notification-rules', '.foryou-settings'],
  ])('preserves the end changed in %s when editing the start in %s', async (first, second) => {
    fixture.feedEnabled = true;
    const box = await render(true);
    await changeSelect(box.querySelector(first)!, 'Quiet hours end', '08:00');
    await changeSelect(box.querySelector(second)!, 'Quiet hours start', '22:00');
    expect(fixture.view.quietHours).toEqual({ start: '22:00', end: '08:00' });
    expect(select(box.querySelector(second)!, 'Quiet hours end').value).toBe('08:00');
  });

  it.each(['quiet hours', 'push switch', 'subscription'])('refreshes clean rules after a %s save', async (control) => {
    const box = await render();
    fixture.view = { ...fixture.view, rules: [startingView.rules[0]!,
      { event: 'agent-finished', source: '*', delivery: 'neither' }] };
    await act(async () => {
      button(box, control === 'quiet hours' ? 'Quiet hours'
        : control === 'push switch' ? 'Notify when an agent needs you' : 'Notifications on this device').click();
    });
    expect(select(box, 'Alert 2 delivery').value).toBe('neither');
    expect(button(box, 'Save notification rules').disabled).toBe(true);
    await changeSelect(box, 'Alert 1 delivery', 'toast');
    await act(async () => button(box, 'Save notification rules').click());
    expect(fixture.view.rules[1]!.delivery).toBe('neither');
  });

  it('refreshes clean rules when an existing subscription refreshes settings', async () => {
    let resolve!: (state: Awaited<ReturnType<typeof pushState>>) => void;
    vi.mocked(pushState).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const box = await render();
    fixture.view = { ...fixture.view, rules: [startingView.rules[0]!,
      { event: 'agent-finished', source: '*', delivery: 'neither' }] };
    await act(async () => resolve('on'));
    expect(select(box, 'Alert 2 delivery').value).toBe('neither');
    expect(button(box, 'Save notification rules').disabled).toBe(true);
  });

  it('refreshes untouched rules while keeping the edited row', async () => {
    const box = await render();
    await changeSelect(box, 'Alert 2 delivery', 'push');
    fixture.view = { ...fixture.view, rules: [
      { event: 'agent-needs-you', source: '*', delivery: 'toast' },
      { event: 'agent-finished', source: '*', delivery: 'neither' },
      { event: 'agent-error', source: 'hermes', delivery: 'both' },
    ] };
    await act(async () => button(box, 'Quiet hours').click());
    expect(select(box, 'Alert 1 delivery').value).toBe('toast');
    expect(select(box, 'Alert 2 delivery').value).toBe('push');
    expect(select(box, 'Alert 3').value).toBe('agent-error');
    await act(async () => button(box, 'Save notification rules').click());
    expect(fixture.view.rules.map((rule) => rule.delivery)).toEqual(['toast', 'push', 'both']);
  });

  it('refreshes a rule again after its local edit is undone', async () => {
    const box = await render();
    await changeSelect(box, 'Alert 2 delivery', 'push');
    await changeSelect(box, 'Alert 2 delivery', 'toast');
    fixture.view = { ...fixture.view, rules: [startingView.rules[0]!,
      { event: 'agent-finished', source: '*', delivery: 'neither' }] };
    await act(async () => button(box, 'Quiet hours').click());
    expect(select(box, 'Alert 2 delivery').value).toBe('neither');
    expect(button(box, 'Save notification rules').disabled).toBe(true);
  });

  it('keeps an edited source when a subscription refreshes other rules', async () => {
    let resolve!: (state: Awaited<ReturnType<typeof pushState>>) => void;
    vi.mocked(pushState).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const box = await render();
    await changeSelect(box, 'Alert 2 source', 'paseo');
    fixture.view = { ...fixture.view, rules: [
      { event: 'agent-needs-you', source: '*', delivery: 'toast' },
      { event: 'agent-finished', source: '*', delivery: 'neither' },
    ] };
    await act(async () => resolve('on'));
    expect(select(box, 'Alert 1 delivery').value).toBe('toast');
    expect(select(box, 'Alert 2 source').value).toBe('paseo');
    expect(select(box, 'Alert 2 delivery').value).toBe('toast');
    await act(async () => button(box, 'Save notification rules').click());
    expect(fixture.view.rules[1]).toEqual({ event: 'agent-finished', source: 'paseo', delivery: 'toast' });
  });

  it('drops remotely deleted clean rows and retains an edited row through refreshes', async () => {
    const box = await render();
    await changeSelect(box, 'Alert 2 delivery', 'push');
    fixture.view = { ...fixture.view, rules: [] };
    await act(async () => button(box, 'Quiet hours').click());
    await act(async () => button(box, 'Quiet hours').click());
    expect(select(box, 'Alert 1').value).toBe('agent-finished');
    expect(select(box, 'Alert 1 delivery').value).toBe('push');
    expect(select(box, 'Alert 2')).toBeNull();
    expect(button(box, 'Save notification rules').disabled).toBe(false);
    await act(async () => button(box, 'Save notification rules').click());
    expect(fixture.view.rules).toEqual([{ event: 'agent-finished', source: '*', delivery: 'push' }]);
  });

  it('keeps a removed row and an added row through repeated refreshes', async () => {
    const box = await render();
    await act(async () => button(box, 'Remove alert 2').click());
    await act(async () => button(box, 'Add a rule').click());
    await changeSelect(box, 'Alert 2 source', 'paseo');
    await act(async () => button(box, 'Quiet hours').click());
    await act(async () => button(box, 'Quiet hours').click());
    expect(select(box, 'Alert 2 source').value).toBe('paseo');
    expect(select(box, 'Alert 3')).toBeNull();
    await act(async () => button(box, 'Save notification rules').click());
    expect(fixture.view.rules).toEqual([startingView.rules[0],
      { event: 'agent-finished', source: 'paseo', delivery: 'toast' }]);
  });
});

describe('the rules as written', () => {
  it('names where the next alert would go before showing a single rule', async () => {
    const box = await render();
    expect(box.textContent).toContain('You are at this PC');
    expect(box.textContent).toContain('1 device can be pushed to');
  });

  it.each([
    ['idle', 'you stepped away'],
    ['locked', 'the screen is locked'],
    ['gone', 'two minutes'],
  ])('says what a desktop that is %s means for an alert', async (presence, words) => {
    fixture.view = { ...fixture.view, presence: presence as NotificationSettingsView['presence'] };
    const box = await render();
    expect(box.textContent).toContain(words);
  });

  it('says so when there is no phone to reach', async () => {
    fixture.view = { ...fixture.view, pushAvailable: false, pushDevices: 0 };
    const box = await render();
    expect(box.textContent).toContain('needs an https address');
  });

  it('shows the rules this install has, one row each', async () => {
    fixture.view = {
      ...fixture.view,
      rules: [
        { event: 'agent-needs-you', source: '*', delivery: 'both' },
        { event: 'agent-finished', source: 'hermes', delivery: 'toast' },
        { event: 'feed-card', source: '*', delivery: 'push' },
      ] as NotificationSettingsView['rules'],
    };
    const box = await render();
    expect(select(box, 'Alert 1').value).toBe('agent-needs-you');
    expect(select(box, 'Alert 1 delivery').value).toBe('both');
    expect(select(box, 'Alert 2 source').value).toBe('hermes');
    expect(select(box, 'Alert 3 delivery').value).toBe('push');
  });

  it('shows an explicitly empty list without adding default rules', async () => {
    fixture.view = { ...fixture.view, rules: [] } as NotificationSettingsView;
    const box = await render();
    expect(select(box, 'Alert 1')).toBeNull();
    expect(button(box, 'Save notification rules').disabled).toBe(true);
  });

  it('will not offer to switch off an agent waiting on an answer', async () => {
    const box = await render();
    const options = Array.from(select(box, 'Alert 1 delivery').options).map((option) => option.value);
    expect(options).toEqual(['both', 'toast']);
  });
});

describe('changing them', () => {
  const setDelivery = async (box: HTMLElement, index: number, value: string) => {
    const el = select(box, `Alert ${index} delivery`);
    await act(async () => {
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  it('saves rules without restoring older hours or switches', async () => {
    const box = await render();
    fixture.view = { ...fixture.view, quietHours: null, push: { approvals: false, cards: true } };
    expect(button(box, 'Save notification rules').disabled).toBe(true);
    await setDelivery(box, 2, 'neither');
    expect(button(box, 'Save notification rules').disabled).toBe(false);
    await act(async () => button(box, 'Save notification rules').click());
    expect(fixture.saved[0]).toEqual({
      rules: [
        { event: 'agent-needs-you', source: '*', delivery: 'both' },
        { event: 'agent-finished', source: '*', delivery: 'neither' },
      ],
    });
    expect(fixture.view.quietHours).toBeNull();
    expect(fixture.view.push).toEqual({ approvals: false, cards: true });
    expect(select(box, 'Alert 2 delivery').value).toBe('neither');
    expect(getState().toasts.map((toast) => toast.text)).toEqual(['Saved.']);
  });

  it.each(['push', 'neither'])('normalizes %s when changing a rule to needs-you', async (delivery) => {
    fixture.view = { ...fixture.view, rules: [{ event: 'agent-finished', source: '*', delivery: delivery as 'push' | 'neither' }] };
    const box = await render();
    await act(async () => {
      const event = select(box, 'Alert 1');
      event.value = 'agent-needs-you'; event.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const expected = delivery === 'push' ? 'both' : 'toast';
    expect(select(box, 'Alert 1 delivery').value).toBe(expected);
    await act(async () => button(box, 'Save notification rules').click());
    expect(fixture.saved[0]).toEqual({ rules: [{ event: 'agent-needs-you', source: '*', delivery: expected }] });
  });

  it('adds a rule for one source and takes one away again', async () => {
    const box = await render();
    await act(async () => button(box, 'Add a rule').click());
    const last = 3;
    expect(select(box, `Alert ${last}`).value).toBe('agent-finished');
    await act(async () => {
      const source = select(box, `Alert ${last} source`);
      source.value = 'paseo';
      source.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => button(box, 'Save notification rules').click());
    expect(fixture.saved[0]).toMatchObject({
      rules: [expect.anything(), expect.anything(), { event: 'agent-finished', source: 'paseo', delivery: 'toast' }],
    });
    await act(async () => button(box, `Remove alert ${last}`).click());
    expect(select(box, `Alert ${last}`)).toBeNull();
  });

  it('keeps the save down when the same event and source is written twice', async () => {
    const box = await render();
    await act(async () => button(box, 'Add a rule').click());
    await act(async () => {
      const el = select(box, 'Alert 3');
      el.value = 'agent-needs-you';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(button(box, 'Save notification rules').disabled).toBe(true);
    expect(button(box, 'Save notification rules').textContent).toContain('Same rule twice');
  });

  it('says what the server refused and leaves the page as it was', async () => {
    fixture.failure = 'each event and source once';
    const box = await render();
    await setDelivery(box, 2, 'push');
    await act(async () => button(box, 'Save notification rules').click());
    expect(getState().toasts.map((toast) => toast.text)).toEqual(['each event and source once']);
    expect(select(box, 'Alert 2 delivery').value).toBe('push');
  });
});
