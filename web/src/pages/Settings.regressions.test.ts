// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './Settings';
import { getState, setState } from '../store';
import { pendingWorkerApprovals, type WorkerApprovalsStatus } from '../../../shared/safety';

const fixture = vi.hoisted(() => ({ bridge: false, whatsapp: true, pinSet: false, cloudAgents: vi.fn(), setCloudAgent: vi.fn(), setSafetyCommands: vi.fn(), workerApprovals: vi.fn(), setWorkerApprovals: vi.fn(), setBridgePaused: vi.fn(), setWorkerUpdates: vi.fn() }));
vi.mock('../voice', () => ({
  useVoiceStatus: () => ({ enabled: true, available: true, defaultVoice: 'af_heart', voices: ['af_heart'] }),
  useVoiceSettings: () => ({ readReplies: true, autoSend: false, speed: 1 }),
  SPEEDS: [1], setVoiceSettings: vi.fn(), setVoiceStatus: vi.fn(), readMessage: vi.fn(),
}));
vi.mock('../push', () => ({ pushState: () => Promise.resolve('on') }));
vi.mock('../api', () => ({ api: {
  bridge: () => Promise.resolve({ enabled: fixture.bridge, paused: false, recent: { sent: 0, queued: 0, started: 0 } }),
  setBridgePaused: fixture.setBridgePaused,
  cloudAgents: fixture.cloudAgents,
  setCloudAgent: fixture.setCloudAgent,
  safetyCommands: () => Promise.resolve({ enabled: false, commands: [] }),
  setSafetyCommands: fixture.setSafetyCommands,
  workerApprovals: fixture.workerApprovals,
  setWorkerApprovals: fixture.setWorkerApprovals,
  workerUpdates: () => Promise.resolve({ enabled: true, defaultMinutes: 60, timeBoxes: [30, 60, 120] }),
  setWorkerUpdates: fixture.setWorkerUpdates,
  phone: () => Promise.resolve({ running: true, ok: true, pinSet: fixture.pinSet }),
  whatsappRouting: () => Promise.resolve({ installed: true, active: fixture.whatsapp, replyRouting: true, returnMinutes: 30, freshAfterHours: 24 }),
  cleanupPreview: () => Promise.resolve({ count: 0 }),
  feed: () => Promise.resolve({ settings: {
    level: 'normal', pulseFound: true, quietHours: { start: '21:00', end: '07:00' },
    pushAvailable: true, pushDevices: 1, push: { approvals: true, cards: false },
    lessLike: [{ topic: 'Demo topic', example: 'Demo example' }],
  } }),
} }));

let root: Root;
let container: HTMLDivElement;
const initial = getState();
const safetyStatus = (enabled: boolean): WorkerApprovalsStatus => ({
  enabled, application: 'partial', config: 'written', reload: 'applied', uncoveredProviders: [],
  limitations: ['existing_agents', 'caller_identity', 'same_user_config', 'cli_guard_not_installed'],
});
beforeEach(async () => {
  fixture.bridge = false;
  fixture.whatsapp = true;
  fixture.pinSet = false;
  fixture.cloudAgents.mockReset().mockResolvedValue({ agents: [{ id: 'claude', label: 'Cloud fixture', enabled: true, state: 'ready' }] });
  fixture.setCloudAgent.mockReset().mockResolvedValue({ agents: [{ id: 'claude', label: 'Cloud fixture', enabled: false, state: 'off' }] });
  fixture.setSafetyCommands.mockReset().mockResolvedValue({ enabled: true, commands: [] });
  fixture.workerApprovals.mockReset().mockResolvedValue(safetyStatus(true));
  fixture.setWorkerApprovals.mockReset();
  fixture.setBridgePaused.mockReset().mockResolvedValue({ enabled: true, paused: true, recent: { sent: 0, queued: 0, started: 0 } });
  fixture.setWorkerUpdates.mockReset().mockResolvedValue({ enabled: true, defaultMinutes: 30, timeBoxes: [30, 60, 120] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  setState(() => ({ ...initial, email: 'owner@example.com', statuses: {
    hermes: { source: 'hermes', state: 'connected' }, paseo: { source: 'paseo', state: 'connected' },
  } }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(h(SettingsPage)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});
const search = async (query: string) => {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('settings timing and search', () => {
  it.each(['Set a PIN', 'New PIN', 'Set PIN'])('finds the phone PIN control: %s', async (label) => {
    expect(container.querySelector('[aria-label="New PIN"]')).not.toBeNull();
    await search(label);
    expect(container.querySelector('[aria-label="New PIN"]')).not.toBeNull();
    expect(container.querySelector('.settings-empty')).toBeNull();
  });

  it.each(['Change PIN', 'New PIN', 'Show PIN', 'Change'])('finds a configured phone PIN control: %s', async (label) => {
    fixture.pinSet = true;
    await act(async () => root.render(h(SettingsPage, { key: 'demo-pin-set' })));
    expect(container.querySelector('[aria-label="Show PIN"]')).not.toBeNull();
    await search(label);
    expect(container.querySelector('[aria-label="New PIN"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Show PIN"]')).not.toBeNull();
  });

  it.each(['Password', 'Hermes dashboard username', 'Connect Hermes'])('finds a Hermes sign-in control: %s', async (label) => {
    await act(async () => setState((s) => ({ ...s, statuses: { ...s.statuses, hermes: { source: 'hermes', state: 'needs_credentials' } } })));
    expect(container.querySelector('input[autocomplete="current-password"]')).not.toBeNull();
    await search(label);
    expect(container.querySelector('input[autocomplete="current-password"]')).not.toBeNull();
    expect(container.querySelector('.settings-empty')).toBeNull();
  });

  it('finds both sign-out controls', async () => {
    await search('Sign out');
    expect([...container.querySelectorAll('.settings-group:not([hidden]) > .side-label')].map((e) => e.textContent)).toEqual(['Overview', 'Safety & access']);
    expect(container.querySelector('a[href="/cdn-cgi/access/logout"]')).not.toBeNull();
    expect(container.textContent?.match(/Sign out/g)).toHaveLength(2);
  });

  it('finds the archived-thread View control', async () => {
    await search('View');
    expect(container.querySelector('.tidy-settings button')?.textContent).toBe('View');
  });

  it.each(['Notify when an agent needs you', 'Notify about new For-you cards', 'Bring back Demo topic'])('finds a notification control by its accessible name: %s', async (label) => {
    expect(container.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    await search(label);
    expect(container.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    expect(container.querySelector('.settings-empty')).toBeNull();
  });

  it('finds an API-provided cloud-agent name, including after clearing and searching again', async () => {
    expect(container.querySelector('[aria-label="Cloud fixture"]')).not.toBeNull();
    await search('Cloud fixture');
    expect(container.querySelector('[aria-label="Cloud fixture"]')).not.toBeNull();
    expect(container.querySelector('.settings-empty')).toBeNull();
    await search('demo-no-match');
    await search('');
    await search('Cloud fixture');
    expect(container.querySelector('[aria-label="Cloud fixture"]')).not.toBeNull();
    expect(container.querySelector('.settings-empty')).toBeNull();
  });

  it.each(['Claude Code', 'Demo remote worker'])('indexes a delayed initial cloud-agent response while searching for %s', async (label) => {
    let resolve!: (result: object) => void;
    fixture.cloudAgents.mockImplementationOnce(() => new Promise<object>((done) => { resolve = done; }));
    await act(async () => root.render(h(SettingsPage, { key: 'demo-pending' })));
    expect(container.querySelector(`[aria-label="${label}"]`)).toBeNull();
    await search(label);
    expect(container.querySelector('.settings-empty')).not.toBeNull();
    const calls = fixture.cloudAgents.mock.calls.length;
    await act(async () => resolve({ agents: [{ id: 'claude', label, enabled: true, state: 'ready' }] }));
    expect(container.querySelector('.settings-group:not([hidden]) [aria-label="' + label + '"]')).not.toBeNull();
    expect(container.querySelector('.settings-empty')).toBeNull();
    await search('demo-no-match');
    await search(label);
    expect(container.querySelector('.settings-group:not([hidden]) [aria-label="' + label + '"]')).not.toBeNull();
    expect(fixture.cloudAgents).toHaveBeenCalledTimes(calls);
  });

  it('keeps loaded settings and unsaved drafts when search hides and shows their groups', async () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="New PIN"]')!;
    const cloud = container.querySelector('[aria-label="Cloud fixture"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '0000');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const calls = fixture.cloudAgents.mock.calls.length;
    await search('demo-no-match');
    expect(container.querySelectorAll('.settings-group:not([hidden])')).toHaveLength(0);
    await search('Cloud fixture');
    expect([...container.querySelectorAll('.settings-group:not([hidden]) > .side-label')].map((e) => e.textContent)).toEqual(['Your AI']);
    expect(container.querySelector('.settings-empty')).toBeNull();
    expect(container.querySelector('[aria-label="Cloud fixture"]')).toBe(cloud);
    expect(fixture.cloudAgents).toHaveBeenCalledTimes(calls);
    await search('');
    expect(container.querySelector('[aria-label="New PIN"]')).toBe(input);
    expect(input.value).toBe('0000');
  });

  it.each(['Quiet hours', 'Quiet hours start', 'Quiet hours end', 'Speed', 'Read replies aloud', 'How often Hermes speaks up', 'Send what you say right away', 'Less like this', 'New For-you cards', 'Theme', 'Text size and language'])('finds the visible You control: %s', async (label) => {
    expect(container.textContent).toContain(label.replace(/ (start|end)$/, ''));
    await search(label);
    expect([...container.querySelectorAll('.settings-group:not([hidden]) > .side-label')].map((e) => e.textContent)).toEqual(['You']);
    expect(container.querySelector('.settings-empty')).toBeNull();
    expect(container.textContent).toContain(label.replace(/ (start|end)$/, ''));
  });

  it('labels every active settings control with its timing', () => {
    const controls = container.querySelectorAll('[role="switch"], select, [aria-label="New PIN"]');
    expect(controls.length).toBeGreaterThan(10);
    for (const control of controls) {
      expect(control.closest('.kv')?.querySelector('.setting-timing'), control.getAttribute('aria-label') ?? 'select').not.toBeNull();
    }
    expect(container.querySelector('.cloud-agents .setting-timing')?.textContent).toBe('From the next chat');
    expect(container.querySelector('.bridge-settings .setting-timing')?.textContent).toBe('Needs a restart');
    expect(container.querySelector('.whatsapp-routing .setting-timing')?.textContent).toBe('Applies now');
  });

  it('does not show an empty-search message when groups match', async () => {
    await search('status');
    expect([...container.querySelectorAll('.settings-group:not([hidden]) > .side-label')].map((e) => e.textContent)).toEqual(['Overview', 'This PC']);
    expect(container.querySelector('.settings-empty')).toBeNull();
    await search('demo-no-match');
    expect(container.querySelectorAll('.settings-group:not([hidden])')).toHaveLength(0);
    expect(container.querySelector('.settings-empty')?.textContent).toContain('Nothing here matches');
    await search('   ');
    expect(container.querySelector('.settings-empty')).toBeNull();
    expect(container.querySelectorAll('.settings-group:not([hidden])')).toHaveLength(6);
  });

  it('distinguishes active switches, unconfigured plugins, and sign-in timing', async () => {
    fixture.bridge = true;
    fixture.whatsapp = false;
    await act(async () => {
      setState((s) => ({ ...s, statuses: { ...s.statuses, hermes: { source: 'hermes', state: 'needs_credentials' } } }));
      root.render(h(SettingsPage, { key: 'demo-changed' }));
    });
    expect(container.querySelector('.bridge-settings .setting-timing')?.textContent).toBe('Applies now');
    for (const label of ['Worker updates', 'Time box for workers']) {
      expect(container.querySelector(`.bridge-settings [aria-label="${label}"]`)?.closest('.kv')?.querySelector('.setting-timing')?.textContent, label).toBe('Applies now');
    }
    const whatsappTiming = [...container.querySelectorAll('.whatsapp-routing .setting-timing')].map((label) => label.textContent);
    expect(whatsappTiming).toHaveLength(4);
    expect(whatsappTiming.every((label) => label === 'Needs a restart')).toBe(true);
    expect(container.querySelector('input[autocomplete="username"]')?.closest('.field')?.querySelector('.setting-timing')?.textContent).toBe('Applies now');
  });
});

it('allows bridge and worker-update changes only on a paired desktop', async () => {
  fixture.bridge = true;
  await act(async () => root.render(h(SettingsPage, { key: 'demo-bridge-access' })));
  const controls = () => [
    container.querySelector<HTMLButtonElement>('.bridge-settings button[aria-pressed]')!,
    container.querySelector<HTMLButtonElement>('[aria-label="Worker updates"]')!,
    container.querySelector<HTMLSelectElement>('[aria-label="Time box for workers"]')!,
  ];
  for (const kind of [undefined, 'phone', 'desktop'] as const) {
    await act(async () => setState(s => ({ ...s, device: kind ? { id: `dv_demo_${kind}`, name: 'Demo device', kind, scopes: [], created: 1, lastSeen: 1 } : undefined })));
    expect(controls().every(control => control.disabled)).toBe(kind !== 'desktop');
    if (kind !== 'desktop') {
      expect(container.querySelector('.bridge-settings')?.textContent).toContain('Change this on a paired desktop.');
      await act(async () => { controls()[0]!.click(); controls()[1]!.click(); });
      expect(fixture.setBridgePaused).not.toHaveBeenCalled();
      expect(fixture.setWorkerUpdates).not.toHaveBeenCalled();
    }
  }
  await act(async () => controls()[0]!.click());
  expect(fixture.setBridgePaused).toHaveBeenCalledExactlyOnceWith(true);
  await act(async () => {
    const select = controls()[2]!;
    select.value = '30';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(fixture.setWorkerUpdates).toHaveBeenCalledExactlyOnceWith({ defaultMinutes: 30 });
});

it('allows cloud and Hermes safety setting changes only on a paired desktop', async () => {
  const cloud = () => container.querySelector<HTMLButtonElement>('[aria-label="Cloud fixture"]')!;
  const safety = () => container.querySelector<HTMLButtonElement>('[aria-label="Hermes safety commands"]')!;
  for (const kind of [undefined, 'phone', 'desktop'] as const) {
    await act(async () => setState(s => ({ ...s, device: kind ? { id: `dv_demo_${kind}`, name: 'Demo device', kind, scopes: [], created: 1, lastSeen: 1 } : undefined })));
    expect(cloud().disabled).toBe(kind !== 'desktop');
    expect(safety().disabled).toBe(kind !== 'desktop');
    if (kind !== 'desktop') {
      await act(async () => { cloud().click(); safety().click(); });
      expect(fixture.setCloudAgent).not.toHaveBeenCalled();
      expect(fixture.setSafetyCommands).not.toHaveBeenCalled();
      expect(container.querySelector('.modal')).toBeNull();
    }
  }
  await act(async () => cloud().click());
  expect(fixture.setCloudAgent).toHaveBeenCalledExactlyOnceWith('claude', false);
  await act(async () => safety().click());
  const allow = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Allow')!;
  expect(allow()).toBeDefined();
  // A confirmation opened by a desktop must not survive loss of that identity.
  await act(async () => setState(s => ({ ...s, device: undefined })));
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Allow')).toBe(false);
  expect(fixture.setSafetyCommands).not.toHaveBeenCalled();
  await act(async () => setState(s => ({ ...s, device: { id: 'dv_demo_desktop', name: 'Demo desktop', kind: 'desktop', scopes: [], created: 1, lastSeen: 1 } })));
  await act(async () => safety().click());
  await act(async () => allow().click());
  expect(fixture.setSafetyCommands).toHaveBeenCalledExactlyOnceWith(true);
});

describe("workers' approvals", () => {
  const toggle = () => container.querySelector<HTMLButtonElement>(".worker-approvals [role='switch']");
  const device = (kind: 'desktop' | 'phone') => ({ id: `dv_demo_${kind}`, name: `Demo ${kind}`, kind, scopes: [], created: 1, lastSeen: 1 });
  const turnOff = async () => {
    await act(async () => setState(s => ({ ...s, device: device('desktop') })));
    await act(async () => toggle()!.click());
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === 'Turn off')!;
    await act(async () => confirm.click());
  };

  it.each([true, false])('lets a paired desktop apply a freshly read pending choice (%s)', async enabled => {
    fixture.workerApprovals.mockResolvedValue({ ...safetyStatus(enabled), choiceConfirmed: true, config: 'pending', reload: 'pending', application: 'pending' });
    fixture.setWorkerApprovals.mockResolvedValue(safetyStatus(enabled));
    await act(async () => {
      setState(s => ({ ...s, device: device('desktop') }));
      root.render(h(SettingsPage, { key: 'demo-pending-application' }));
    });
    expect(toggle()).toBeNull();
    const apply = [...container.querySelectorAll<HTMLButtonElement>('.worker-approvals button')].find(button => button.textContent === 'Apply saved setting');
    expect(apply).toBeDefined();
    expect(apply!.disabled).toBe(false);
    await act(async () => apply!.click());
    expect(fixture.setWorkerApprovals).toHaveBeenCalledExactlyOnceWith(enabled);
    expect(toggle()?.getAttribute('aria-checked')).toBe(String(enabled));
  });

  it('offers no pending apply action after a failed read or an unavailable helper fallback', async () => {
    fixture.workerApprovals.mockResolvedValue({ ...safetyStatus(false), choiceConfirmed: true, config: 'pending' });
    await act(async () => {
      setState(s => ({ ...s, device: device('desktop') }));
      root.render(h(SettingsPage, { key: 'demo-read-before-failure' }));
    });
    fixture.workerApprovals.mockRejectedValue(new Error('demo-read-unavailable'));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(container.querySelector('.worker-approvals')?.textContent).not.toContain('Apply saved setting');
    fixture.workerApprovals.mockResolvedValue(pendingWorkerApprovals());
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(container.querySelector('.worker-approvals')?.textContent).not.toContain('Apply saved setting');
    expect(fixture.setWorkerApprovals).not.toHaveBeenCalled();
  });

  it('keeps pending application read-only for phones and unknown devices', async () => {
    fixture.workerApprovals.mockResolvedValue({ ...safetyStatus(false), choiceConfirmed: true, config: 'pending' });
    for (const paired of [undefined, device('phone')]) {
      await act(async () => {
        setState(s => ({ ...s, device: paired }));
        root.render(h(SettingsPage, { key: paired?.id ?? 'demo-unknown-device' }));
      });
      const apply = [...container.querySelectorAll<HTMLButtonElement>('.worker-approvals button')].find(button => button.textContent === 'Apply saved setting');
      expect(apply?.disabled).toBe(true);
    }
    expect(fixture.setWorkerApprovals).not.toHaveBeenCalled();
  });

  it('rereads the setting when a write commits but its response fails', async () => {
    let saved = true;
    fixture.workerApprovals.mockImplementation(async () => safetyStatus(saved));
    fixture.setWorkerApprovals.mockImplementation(async () => {
      saved = false;
      throw new Error('demo-lost-response');
    });
    await turnOff();
    expect(saved).toBe(false);
    expect(fixture.workerApprovals).toHaveBeenCalledTimes(2);
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('shows an unconfirmed state if both save and verification fail, then recovers', async () => {
    fixture.setWorkerApprovals.mockRejectedValue(new Error('demo-lost-response'));
    fixture.workerApprovals.mockRejectedValue(new Error('demo-read-unavailable'));
    await turnOff();
    const row = container.querySelector('.worker-approvals')!;
    expect(row.textContent).toContain('not confirmed');
    expect(row.textContent).not.toContain('In place');
    expect(row.textContent).not.toContain('On:');
    expect(toggle()).toBeNull();
    fixture.workerApprovals.mockResolvedValue(safetyStatus(false));
    await act(async () => [...row.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check again')!.click());
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
  });

  it('does not confirm the helper client\'s cached fallback after a failed save', async () => {
    fixture.setWorkerApprovals.mockRejectedValue(new Error('demo-lost-response'));
    fixture.workerApprovals.mockResolvedValue({ ...safetyStatus(true), config: 'pending', reload: 'pending', application: 'pending' });
    await turnOff();
    expect(toggle()).toBeNull();
    const text = container.querySelector('.worker-approvals')!.textContent;
    expect(text).toContain('not confirmed');
    expect(text).not.toContain('On:');
    expect(text).not.toContain('In place');
  });

  it('shows an unconfirmed setting when the save response reports concurrent policy drift', async () => {
    fixture.setWorkerApprovals.mockResolvedValue({ ...safetyStatus(false), config: 'pending', reload: 'pending', application: 'pending' });
    await turnOff();
    const text = container.querySelector('.worker-approvals')!.textContent;
    expect(text).toContain('not confirmed');
    expect(text).not.toContain('On:');
    expect(text).not.toContain('Off:');
    expect(text).not.toContain('Saved');
    expect(text).not.toContain('In place');
    expect(toggle()).toBeNull();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('keeps a post-write configuration conflict unconfirmed after save and refresh', async () => {
    const pending = { ...safetyStatus(false), config: 'pending' as const, reload: 'pending' as const, application: 'pending' as const,
      message: 'Paseo configuration conflict after writing. The setting is not confirmed; its undo backup was kept.' };
    fixture.setWorkerApprovals.mockResolvedValue(pending);
    fixture.workerApprovals.mockResolvedValue(pending);
    await turnOff();
    await act(async () => window.dispatchEvent(new Event('focus')));
    const text = container.querySelector('.worker-approvals')!.textContent;
    expect(text).toContain('configuration conflict');
    expect(text).toContain('undo backup was kept');
    expect(text).toContain('not confirmed');
    expect(text).not.toContain('In place');
    expect(text).not.toContain('Off:');
    expect(toggle()).toBeNull();
  });

  it('refreshes while Settings stays open, including failures and focus recovery', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(h(SettingsPage, { key: 'demo-safety-refresh' })));
    fixture.workerApprovals.mockResolvedValue(safetyStatus(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    fixture.workerApprovals.mockRejectedValue(new Error('demo-read-unavailable'));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(toggle()).toBeNull();
    expect(container.querySelector('.worker-approvals')?.textContent).toContain('not confirmed');
    fixture.workerApprovals.mockResolvedValue(safetyStatus(true));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    await act(async () => root.unmount());
    const reads = fixture.workerApprovals.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    window.dispatchEvent(new Event('focus'));
    expect(fixture.workerApprovals).toHaveBeenCalledTimes(reads);
  });

  it('discards an old refresh arriving after a verified write', async () => {
    let resolve!: (status: WorkerApprovalsStatus) => void;
    fixture.workerApprovals.mockImplementationOnce(() => new Promise<WorkerApprovalsStatus>(done => { resolve = done; }));
    await act(async () => window.dispatchEvent(new Event('focus')));
    fixture.setWorkerApprovals.mockResolvedValue(safetyStatus(false));
    await turnOff();
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    await act(async () => resolve(safetyStatus(true)));
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
  });

  it('verifies a failed write while an older read is still pending', async () => {
    let resolve!: (status: WorkerApprovalsStatus) => void;
    fixture.workerApprovals.mockImplementationOnce(() => new Promise<WorkerApprovalsStatus>(done => { resolve = done; }));
    await act(async () => window.dispatchEvent(new Event('focus')));
    fixture.workerApprovals.mockRejectedValue(new Error('demo-verification-unavailable'));
    fixture.setWorkerApprovals.mockRejectedValue(new Error('demo-lost-response'));
    await turnOff();
    expect(fixture.workerApprovals).toHaveBeenCalledTimes(3);
    expect(toggle()).toBeNull();
    await act(async () => resolve(safetyStatus(true)));
    expect(toggle()).toBeNull();
    expect(container.querySelector('.worker-approvals')?.textContent).toContain('not confirmed');
  });

  it('shows an unconfirmed setting when the initial read fails', async () => {
    fixture.workerApprovals.mockRejectedValue(new Error('demo-read-unavailable'));
    await act(async () => root.render(h(SettingsPage, { key: 'demo-safety-unconfirmed' })));
    expect(toggle()).toBeNull();
    expect(container.querySelector('.worker-approvals')?.textContent).toContain('not confirmed');
  });

  it('says what it protects and its known gaps, and only a paired desktop may change it', async () => {
    await act(async () => setState((s) => ({ ...s, device: device('phone') })));
    const row = container.querySelector('.worker-approvals')!;
    expect(row.textContent).toContain('can’t answer another agent’s permission request');
    expect(row.textContent).toContain('keep their old limits until they restart');
    expect(row.textContent).toContain('guardrail');
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(toggle()?.disabled).toBe(true);
    expect(row.textContent).toContain('Change this on a paired desktop.');

    await act(async () => setState((s) => ({ ...s, device: device('desktop') })));
    expect(toggle()?.disabled).toBe(false);
    expect(container.querySelector('.worker-approvals')!.textContent).not.toContain('Change this on a paired desktop.');
  });

  it('is found by searching for it', async () => {
    await search("Workers' approvals come to me");
    expect(container.querySelector('.worker-approvals')?.closest('.settings-group')?.hasAttribute('hidden')).toBe(false);
  });
});
