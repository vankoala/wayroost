// @vitest-environment jsdom
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rollout } from '../../../shared/rollout.js';
import { pendingWorkerApprovals } from '../../../shared/safety.js';
import { api, refreshList, ROLLOUT_GATED_API, serializeNotificationSettingsSave } from '../api.js';
import { captureRollout, getRolloutGeneration, getState, setState } from '../store.js';
import { NotificationRules } from '../components/NotificationRules.js';
import { ForYouSettings } from '../components/ForYouSettings.js';
import { RecentChanges } from '../components/RecentChanges.js';
import { SettingsRestart } from '../components/SettingsRestart.js';
import { SettingsConfirmPrompt, SettingsSectionGuard, useSettingsChange, useSettingsSection, type SettingsChangeBody } from '../components/SettingsRows.js';
import { SettingsPage } from '../pages/Settings.js';
import { ModelsSettingsPage } from '../pages/SettingsModels.js';
import { SafetySettingsPage } from '../pages/SettingsSafety.js';
import { pushState } from '../push.js';
import type { SettingsSectionPayload } from '../settingsModel.js';

vi.mock('../push.js', async original => ({ ...await original<typeof import('../push.js')>(), pushState: vi.fn(async () => 'off') }));

const enabled: Rollout = { settingsPages: true, revokes: true, chatFirst: true };
const confirm = { status: 'confirm' as const, confirm: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA', summary: 'Change this setting?', expiresAt: Date.now() + 60_000 };
const notifications = { rules: [{ event: 'agent-finished' as const, source: '*' as const, delivery: 'toast' as const }], quietHours: { start: '21:00', end: '07:00' }, push: { approvals: true, cards: false }, pushAvailable: true, pushDevices: 1, presence: 'active' as const, timeZoneConfigured: false };
const feed = { cards: [], settings: { level: 'normal' as const, pulseFound: true, lessLike: [{ topic: 'Example topic', example: 'Example card', at: 0 }], quietHours: notifications.quietHours, push: notifications.push, pushAvailable: true, pushDevices: 1 } };
const workers = { ...pendingWorkerApprovals(), enabled: true, config: 'written' as const, reload: 'applied' as const, choiceConfirmed: true };
const cloud = { agents: [{ id: 'claude' as const, label: 'Example provider', enabled: true, state: 'ready' as const }] };
const recent = { id: 'ch_000000000000000000000001', operation: 'hermes.revoke-always', target: 'hermes-config' as const, action: 'apply' as const, at: 0, keys: [], level: 'anywhere' as const, timing: [{ label: 'now' as const }], result: 'ok' as const, undoable: true, undoAccess: 'editable' as const };
let root: Root;
let container: HTMLDivElement;
let payload: SettingsSectionPayload;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function render(element: ReactElement) { await act(async () => root.render(element)); }
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => (node.getAttribute('aria-label') ?? node.textContent?.trim()) === label);
  expect(found, label).toBeTruthy();
  return found!;
}
async function click(label: string) {
  const node = button(label);
  expect(node.matches(':disabled'), label).toBe(false);
  await act(async () => node.click());
}
async function select(label: string, value: string) {
  const node = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  expect(node, label).toBeTruthy();
  await act(async () => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function input(selector: string, value: string) {
  const node = container.querySelector<HTMLInputElement>(selector)!;
  expect(node, selector).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function cycle(key: keyof Rollout, missing = false) {
  await act(async () => {
    setState(s => ({ ...s, rollout: missing ? undefined : { ...enabled, [key]: false } }));
    setState(s => ({ ...s, rollout: enabled }));
  });
}

function ChangeControl({ body }: { body: SettingsChangeBody }) {
  const section = useSettingsSection('safety');
  const change = useSettingsChange(section.payload);
  return h('div', {}, h('button', { onClick: () => void change.run('save', body), disabled: change.busy !== null }, 'Save setting'),
    h(SettingsConfirmPrompt, { pending: change.pending, busy: change.busy !== null, onConfirm: () => void change.confirmNow(), onCancel: change.dismiss }));
}
function changeControl(body: SettingsChangeBody) {
  return h(SettingsSectionGuard, { section: 'safety', children: h(ChangeControl, { body }) });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.mocked(pushState).mockResolvedValue('off');
  payload = { section: 'safety', rollout: enabled, views: [{ ok: true, view: 'hermes.safety', present: true, sha256: 'a'.repeat(64), values: [] }, { ok: true, view: 'hermes.managed', present: false }], operations: [
    { operation: 'hermes.skill-staging', title: 'Stage skills', access: 'editable' },
    { operation: 'hermes.revoke-always', title: 'Revoke', access: 'editable' },
    { operation: 'hermes.approval-mode', title: 'Approvals', access: 'editable' },
    ...['wayroost.safety-commands', 'paseo.worker-approvals', 'paseo.provider-enabled'].map(operation => ({ operation, title: operation, access: 'editable' as const, writer: 'legacy' as const })),
  ], changes: [recent] };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'refused', code: 'not_configured' }, { status: 503 })));
  vi.spyOn(api, 'notificationSettings').mockResolvedValue(notifications);
  vi.spyOn(api, 'feed').mockResolvedValue(feed);
  vi.spyOn(api, 'workerApprovals').mockResolvedValue(workers);
  vi.spyOn(api, 'cloudAgents').mockResolvedValue(cloud);
  vi.spyOn(api, 'safetyCommands').mockResolvedValue({ enabled: false, commands: ['status'] });
  vi.spyOn(api, 'settingsSection').mockImplementation(async section => section === 'models'
    ? { section, rollout: enabled, views: [{ ok: true, view: 'gateway.role-map', present: true, sha256: 'a'.repeat(64), values: [{ path: ['backends', 'example', 'provider'], exists: true, value: 'example' }] }], operations: [{ operation: 'gateway.credential', title: 'Key', access: 'editable' }] }
    : { ...payload, section });
  vi.spyOn(api, 'settingsUsage').mockResolvedValue({ ok: true, generatedAt: 0, windows: [] });
  setState(s => ({ ...s, rollout: enabled, toasts: [], unpaired: false, sessionExpired: false,
    device: { id: 'dv_000000000000000000000001', name: 'Example desktop', kind: 'desktop', scopes: ['settings', 'pc-settings'], created: 0, lastSeen: 0 },
    statuses: { hermes: { source: 'hermes', state: 'connected' }, paseo: { source: 'paseo', state: 'connected' } } }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Control {
  name: string;
  file: string;
  calls: (keyof typeof api)[];
  keys?: (keyof Rollout)[];
  start(): Promise<() => Promise<void>>;
}
function notificationControl(name: string, start: () => Promise<void>): Control {
  return { name, file: 'components/NotificationRules.tsx', calls: ['setNotificationSettings'], async start() {
    const pending = deferred<typeof notifications>();
    const write = vi.spyOn(api, 'setNotificationSettings').mockReturnValueOnce(pending.promise);
    await render(h(NotificationRules));
    await start();
    expect(write).toHaveBeenCalledOnce();
    return async () => { const count = write.mock.calls.length; await act(async () => pending.resolve(notifications)); expect(write).toHaveBeenCalledTimes(count); };
  } };
}
function feedControl(name: string, start: () => Promise<void>): Control {
  return { name, file: 'components/ForYouSettings.tsx', calls: ['feedSettings'], async start() {
    const pending = deferred<typeof feed.settings>();
    const write = vi.spyOn(api, 'feedSettings').mockReturnValueOnce(pending.promise);
    await render(h(ForYouSettings));
    await start();
    expect(write).toHaveBeenCalledOnce();
    return async () => { await act(async () => pending.resolve(feed.settings)); expect(write).toHaveBeenCalledOnce(); };
  } };
}
function rowControl(name: string, operation: string, params: Record<string, unknown>, held = false): Control {
  return { name, file: 'components/SettingsRows.tsx', calls: ['settingsApply'], keys: ['hermes.skill-staging', 'hermes.revoke-always'].includes(operation) ? ['settingsPages', 'revokes'] : ['settingsPages'], async start() {
    const pending = deferred<typeof confirm>();
    const write = vi.spyOn(api, 'settingsApply').mockReturnValueOnce(held ? Promise.resolve(confirm) : pending.promise);
    await render(changeControl({ operation, params }));
    await click('Save setting');
    expect(write).toHaveBeenCalledOnce();
    if (held) expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    return async () => { await act(async () => pending.resolve(confirm)); expect(write).toHaveBeenCalledOnce(); };
  } };
}
function legacyRowControl(name: string, operation: string, call: 'setWorkerApprovals' | 'setSafetyCommands' | 'setCloudAgent'): Control {
  return { name, file: 'components/SettingsRows.tsx', calls: [call], async start() {
    const pending = deferred<typeof workers & typeof cloud & { commands: string[] }>();
    const write = vi.spyOn(api, call).mockReturnValueOnce(pending.promise);
    await render(changeControl({ operation, params: { enabled: true, provider: 'claude' } }));
    await click('Save setting');
    const version = getState().settingsVersion;
    return async () => { await act(async () => pending.resolve({ ...workers, ...cloud, enabled: true, commands: [] })); expect(write).toHaveBeenCalledOnce(); expect(getState().settingsVersion).toBe(version); };
  } };
}

function browserPush(kind: 'enable' | 'disable', stage?: string) {
  const pending = deferred<void>();
  const steps: string[] = [];
  function hold<T>(step: string, result: T): Promise<T> {
    steps.push(step);
    return step === stage ? pending.promise.then(() => result) : Promise.resolve(result);
  }
  const json = { endpoint: 'https://example.com/push/example', keys: { p256dh: 'example-key', auth: 'example-auth' } };
  const subscription = { endpoint: json.endpoint, options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
    toJSON: () => json, unsubscribe: vi.fn(() => hold('unsubscribe', true)) };
  const previous = { ...subscription, options: { applicationServerKey: new Uint8Array([4, 5, 6]).buffer } };
  const registration = { pushManager: {
    getSubscription: vi.fn(() => hold('lookup', kind === 'disable' ? subscription : stage === 'unsubscribe' ? previous : null)),
    subscribe: vi.fn(() => hold('subscribe', subscription)),
  } };
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn(() => hold('permission', 'granted')) });
  vi.stubGlobal('navigator', { userAgent: 'Example browser', platform: 'Linux', maxTouchPoints: 0, serviceWorker: {
    getRegistration: vi.fn(() => hold('registration', stage === 'register' ? undefined : registration)),
    register: vi.fn(() => hold('register', registration)),
    get ready() { return hold('ready', registration); },
  } });
  const key = vi.spyOn(api, 'pushKey').mockImplementation(() => hold('key', { publicKey: 'AQID' }));
  const add = vi.spyOn(api, 'pushAddDevice').mockImplementation(() => hold('add', { devices: 1 }));
  const remove = vi.spyOn(api, 'pushRemoveDevice').mockImplementation(() => hold('remove', { devices: 0 }));
  return { pending, steps, key, add, remove, registration, subscription, json };
}

function hermesSnapshotControl(kind: 'sign-in' | 'sign-out'): Control {
  return { name: `Hermes ${kind} pending list snapshot`, file: 'pages/Settings.tsx', calls: [kind === 'sign-in' ? 'setHermesCredentials' : 'clearHermesCredentials'], async start() {
    const pending = deferred<Awaited<ReturnType<typeof api.list>>>();
    const list = vi.spyOn(api, 'list').mockReturnValueOnce(pending.promise);
    if (kind === 'sign-in') {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      setState(s => ({ ...s, statuses: { ...s.statuses, hermes: { source: 'hermes', state: 'needs_credentials' } } }));
      vi.spyOn(api, 'setHermesCredentials').mockResolvedValue({ status: { source: 'hermes', state: 'connected' } });
    } else {
      vi.spyOn(api, 'clearHermesCredentials').mockResolvedValue({ status: { source: 'hermes', state: 'needs_credentials' } });
    }
    await render(h(SettingsPage));
    if (kind === 'sign-in') {
      await input('input[autocomplete="username"]', 'example');
      await input('input[autocomplete="current-password"]', 'example-password');
      await click('Connect Hermes');
      await act(async () => vi.advanceTimersByTimeAsync(1500));
    } else await click('Sign out');
    expect(list).toHaveBeenCalledOnce();
    await act(async () => setState(s => ({ ...s, toasts: [] })));
    return async () => {
      await act(async () => setState(s => ({ ...s, statuses: { ...s.statuses, hermes: { source: 'hermes', state: 'connected', message: 'Current connection' } } })));
      const state = getState();
      await act(async () => pending.resolve({ rollout: enabled, statuses: [{ source: 'hermes', state: 'needs_credentials' }], conversations: [], approvals: [] }));
      expect(list).toHaveBeenCalledOnce();
      expect(getState()).toBe(state);
      expect(container.querySelector('input[autocomplete="current-password"]')).toBeNull();
      expect(button('Sign out').matches(':disabled')).toBe(false);
    };
  } };
}
const controls: Control[] = [
  notificationControl('notification rules', async () => { await select('Alert 1 delivery', 'push'); await click('Save notification rules'); }),
  notificationControl('notification quiet hours', () => select('Quiet hours start', '22:00')),
  notificationControl('notification approval alerts', () => click('Notify when an agent needs you')),
  notificationControl('notification card alerts', () => click('Notify about new For-you cards')),
  ...['rules', 'quiet hours', 'approval alerts'].map((name): Control => ({ name: `queued notification ${name}`, file: 'components/NotificationRules.tsx', calls: ['setNotificationSettings'], async start() {
    const waiting = deferred<void>();
    const queued = serializeNotificationSettingsSave(() => waiting.promise);
    const write = vi.spyOn(api, 'setNotificationSettings');
    await render(h(NotificationRules));
    if (name === 'rules') { await select('Alert 1 delivery', 'push'); await click('Save notification rules'); }
    else if (name === 'quiet hours') await select('Quiet hours start', '22:00');
    else await click('Notify when an agent needs you');
    return async () => { const reads = vi.mocked(api.notificationSettings).mock.calls.length; await act(async () => { waiting.resolve(); await queued; }); expect(write).not.toHaveBeenCalled(); expect(api.notificationSettings).toHaveBeenCalledTimes(reads); };
  } })),
  { name: 'notification merge read', file: 'components/NotificationRules.tsx', calls: ['setNotificationSettings'], async start() {
    const pending = deferred<typeof notifications>();
    const write = vi.spyOn(api, 'setNotificationSettings');
    await render(h(NotificationRules));
    vi.mocked(api.notificationSettings).mockReturnValueOnce(pending.promise);
    await select('Quiet hours start', '22:00');
    return async () => { await act(async () => pending.resolve(notifications)); expect(write).not.toHaveBeenCalled(); };
  } },
  feedControl('For-you frequency', () => select('How often Hermes speaks up', 'low')),
  feedControl('For-you quiet hours', () => select('Quiet hours start', '22:00')),
  feedControl('For-you approval alerts', () => click('Notify when an agent needs you')),
  feedControl('For-you card alerts', () => click('Notify about new For-you cards')),
  feedControl('For-you topics', () => click('Bring back Example topic')),
  rowControl('settings apply', 'hermes.approval-mode', { mode: 'manual' }),
  rowControl('skill staging pending response', 'hermes.skill-staging', { enabled: true }),
  rowControl('skill staging held confirmation', 'hermes.skill-staging', { enabled: true }, true),
  rowControl('revoke pending response', 'hermes.revoke-always', { entrySha256: 'b'.repeat(64) }),
  { name: 'visible revoke pending digest', file: 'pages/SettingsSafety.tsx', calls: ['settingsApply'], keys: ['settingsPages', 'revokes'], async start() {
    payload.views![0]!.values = [{ path: ['command_allowlist'], exists: true, value: ['git status'] }];
    const pending = deferred<ArrayBuffer>();
    const digest = vi.fn().mockReturnValueOnce(pending.promise);
    vi.stubGlobal('crypto', { subtle: { digest } });
    const write = vi.spyOn(api, 'settingsApply').mockResolvedValue(confirm);
    await render(h(SafetySettingsPage));
    await click('Revoke git status');
    expect(digest).toHaveBeenCalledExactlyOnceWith('SHA-256', new TextEncoder().encode('git status'));
    expect(write).not.toHaveBeenCalled();
    return async () => {
      await act(async () => pending.resolve(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('git status'))));
      expect(write).not.toHaveBeenCalled();
      expect(button('Revoke git status').matches(':disabled')).toBe(false);
    };
  } },
  legacyRowControl('legacy safety commands in rows', 'wayroost.safety-commands', 'setSafetyCommands'),
  legacyRowControl('legacy worker approvals in rows', 'paseo.worker-approvals', 'setWorkerApprovals'),
  legacyRowControl('legacy provider in rows', 'paseo.provider-enabled', 'setCloudAgent'),
  { name: 'undo pending response', file: 'components/SettingsRows.tsx', calls: ['settingsUndo'], keys: ['settingsPages', 'revokes'], async start() {
    const pending = deferred<typeof confirm>();
    const write = vi.spyOn(api, 'settingsUndo').mockReturnValueOnce(pending.promise);
    await render(h(RecentChanges)); await click('Undo Revoke an "always" entry');
    return async () => { await act(async () => pending.resolve(confirm)); expect(write).toHaveBeenCalledOnce(); };
  } },
  { name: 'undo held confirmation', file: 'components/SettingsRows.tsx', calls: ['settingsUndo'], keys: ['settingsPages', 'revokes'], async start() {
    const write = vi.spyOn(api, 'settingsUndo').mockResolvedValueOnce(confirm);
    await render(h(RecentChanges)); await click('Undo Revoke an "always" entry');
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    return async () => { expect(write).toHaveBeenCalledOnce(); };
  } },
  ...[false, true].flatMap(requiresRevokes => [false, true].map((held): Control => ({ name: `restart ${held ? 'held' : 'pending'} ${requiresRevokes ? 'revoke' : 'ordinary'}`, file: 'components/SettingsRestart.tsx', calls: ['settingsRestart'], keys: requiresRevokes ? ['settingsPages', 'revokes'] : ['settingsPages'], async start() {
    const pending = deferred<typeof confirm>();
    const write = vi.spyOn(api, 'settingsRestart').mockReturnValueOnce(pending.promise);
    await render(h(SettingsRestart, { component: 'hermes', requiresRevokes }));
    await click(held ? 'Restart now' : 'Restart when idle');
    if (held) expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    return async () => { await act(async () => pending.resolve(confirm)); expect(write).toHaveBeenCalledTimes(held ? 0 : 1); };
  } }))),
  { name: 'worker approval held confirmation', file: 'pages/Settings.tsx', calls: ['setWorkerApprovals'], async start() {
    const write = vi.spyOn(api, 'setWorkerApprovals');
    await render(h(SettingsPage)); await click("Workers' approvals come to me");
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    return async () => { expect(write).not.toHaveBeenCalled(); };
  } },
  { name: 'worker approval pending write', file: 'pages/Settings.tsx', calls: ['setWorkerApprovals'], async start() {
    vi.mocked(api.workerApprovals).mockResolvedValue({ ...workers, enabled: false });
    const pending = deferred<typeof workers>();
    const write = vi.spyOn(api, 'setWorkerApprovals').mockReturnValueOnce(pending.promise);
    await render(h(SettingsPage)); await click("Workers' approvals come to me");
    return async () => { await act(async () => pending.resolve(workers)); expect(write).toHaveBeenCalledOnce(); expect(button("Workers' approvals come to me").getAttribute('aria-checked')).toBe('false'); };
  } },
  { name: 'safety commands held confirmation', file: 'pages/Settings.tsx', calls: ['setSafetyCommands'], async start() {
    const write = vi.spyOn(api, 'setSafetyCommands');
    await render(h(SettingsPage)); await click('Hermes safety commands');
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    return async () => { expect(write).not.toHaveBeenCalled(); };
  } },
  { name: 'cloud agent pending response', file: 'pages/Settings.tsx', calls: ['setCloudAgent'], async start() {
    const pending = deferred<typeof cloud>();
    const write = vi.spyOn(api, 'setCloudAgent').mockReturnValueOnce(pending.promise);
    await render(h(SettingsPage)); await click('Example provider');
    return async () => { await act(async () => pending.resolve({ agents: [{ ...cloud.agents[0]!, enabled: false }] })); expect(write).toHaveBeenCalledOnce(); expect(button('Example provider').getAttribute('aria-checked')).toBe('true'); };
  } },
  { name: 'Hermes sign-out pending response', file: 'pages/Settings.tsx', calls: ['clearHermesCredentials'], async start() {
    const pending = deferred<{ status: { source: 'hermes'; state: 'needs_credentials' } }>();
    const write = vi.spyOn(api, 'clearHermesCredentials').mockReturnValueOnce(pending.promise);
    const list = vi.spyOn(api, 'list');
    await render(h(SettingsPage)); await click('Sign out');
    return async () => { await act(async () => pending.resolve({ status: { source: 'hermes', state: 'needs_credentials' } })); expect(write).toHaveBeenCalledOnce(); expect(list).not.toHaveBeenCalled(); expect(getState().statuses.hermes.state).toBe('connected'); };
  } },
  { name: 'Hermes sign-in pending response', file: 'pages/Settings.tsx', calls: ['setHermesCredentials'], async start() {
    setState(s => ({ ...s, statuses: { ...s.statuses, hermes: { source: 'hermes', state: 'needs_credentials' } } }));
    const pending = deferred<{ status: { source: 'hermes'; state: 'connected' } }>();
    const write = vi.spyOn(api, 'setHermesCredentials').mockReturnValueOnce(pending.promise);
    await render(h(SettingsPage)); await input('input[autocomplete="username"]', 'example'); await input('input[autocomplete="current-password"]', 'example-password'); await click('Connect Hermes');
    return async () => { await act(async () => pending.resolve({ status: { source: 'hermes', state: 'connected' } })); expect(write).toHaveBeenCalledOnce(); expect(getState().statuses.hermes.state).toBe('needs_credentials'); };
  } },
  hermesSnapshotControl('sign-in'),
  hermesSnapshotControl('sign-out'),
  ...(['set', 'remove', 'test'] as const).map((kind): Control => ({ name: `gateway credential ${kind}`, file: 'pages/SettingsModels.tsx', calls: [kind === 'set' ? 'settingsCredentialSet' : kind === 'remove' ? 'settingsCredentialRemove' : 'settingsCredentialTest'], async start() {
    const pending = deferred<Awaited<ReturnType<typeof api.settingsCredentialSet>>>();
    const write = kind === 'set' ? vi.spyOn(api, 'settingsCredentialSet').mockReturnValueOnce(pending.promise)
      : kind === 'remove' ? vi.spyOn(api, 'settingsCredentialRemove').mockReturnValueOnce(pending.promise) : vi.spyOn(api, 'settingsCredentialTest').mockReturnValueOnce(pending.promise);
    await render(h(ModelsSettingsPage));
    if (kind === 'set') await input('input[aria-label="Key for example"]', 'example-key');
    await click(kind === 'set' ? 'Save key for example' : kind === 'remove' ? 'Remove' : 'Test');
    return async () => { await act(async () => pending.resolve({ status: 'applied', timing: [], test: { ok: true, provider: 'example', backend: 'example' } })); expect(write).toHaveBeenCalledOnce(); expect(container.textContent).not.toContain('Restart required:'); expect(container.textContent).not.toContain('The key worked'); expect([...container.querySelectorAll('button')].some(node => node.textContent === 'Restart now')).toBe(false); };
  } })),
];

describe('rollout continuations', () => {
  it.each(controls.flatMap(control => (control.keys ?? ['settingsPages'] as const).flatMap(key => [false, true].map(missing => ({ ...control, key, missing })))))
  ('$name cancels across batched $key closure, missing: $missing', async control => {
    const finish = await control.start();
    const writesBefore = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method && !['GET', 'HEAD'].includes(init.method)).length;
    await cycle(control.key, control.missing);
    await finish();
    expect(container.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
    expect(getState().toasts).toEqual([]);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method && !['GET', 'HEAD'].includes(init.method))).toHaveLength(writesBefore);
  });

  it('does not send a list refresh with a cancelled capture', async () => {
    const rollout = captureRollout('settingsPages');
    await cycle('settingsPages');
    const list = vi.spyOn(api, 'list');
    const state = getState();
    await act(async () => refreshList(rollout));
    expect(list).not.toHaveBeenCalled();
    expect(getState()).toBe(state);
  });

  it('applies a list refresh with a current capture', async () => {
    const snapshot = { rollout: enabled, statuses: [{ source: 'hermes' as const, state: 'needs_credentials' as const }], conversations: [], approvals: [] };
    const list = vi.spyOn(api, 'list').mockResolvedValue(snapshot);
    await act(async () => refreshList(captureRollout('settingsPages')));
    expect(list).toHaveBeenCalledOnce();
    expect(getState().statuses.hermes).toEqual(snapshot.statuses[0]);
    expect(getState().listLoaded).toBe(true);
  });

  it('allows a fresh visible revoke after a cancelled digest finishes', async () => {
    payload.views![0]!.values = [{ path: ['command_allowlist'], exists: true, value: ['git status'] }];
    const pending = deferred<ArrayBuffer>();
    const digest = vi.fn(webcrypto.subtle.digest.bind(webcrypto.subtle)).mockReturnValueOnce(pending.promise);
    vi.stubGlobal('crypto', { subtle: { digest } });
    const write = vi.spyOn(api, 'settingsApply').mockResolvedValue(confirm);
    await render(h(SafetySettingsPage));
    await click('Revoke git status');
    await cycle('revokes');
    await act(async () => pending.resolve(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('git status'))));
    expect(write).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    await click('Revoke git status');
    await act(async () => { await digest.mock.results.at(-1)!.value; });
    expect(write).toHaveBeenCalledExactlyOnceWith({ operation: 'hermes.revoke-always', params: {
      entrySha256: createHash('sha256').update('git status').digest('hex'),
    }, expected: { file: { sha256: 'a'.repeat(64) } } });
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    await click('Confirm');
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![0].confirm).toBe(confirm.confirm);
  });

  it('drops an old restart response without clearing a new confirmation', async () => {
    const pending = deferred<typeof confirm>();
    const write = vi.spyOn(api, 'settingsRestart').mockReturnValueOnce(pending.promise);
    await render(h(SettingsRestart, { component: 'hermes' }));
    await click('Restart when idle');
    await cycle('settingsPages');
    await click('Restart now');
    await act(async () => pending.resolve(confirm));
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('Restart now may interrupt');
    expect(write).toHaveBeenCalledOnce();
  });

  it('does not follow a cancelled notification write with another request', async () => {
    const pending = deferred<Response>();
    const request = vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    const saved = api.setNotificationSettings({ quietHours: null }).catch(error => error as Error);
    await cycle('settingsPages');
    await act(async () => pending.resolve(Response.json({ status: 'applied' })));
    expect(await saved).toBeInstanceOf(Error);
    expect(request).toHaveBeenCalledOnce();
    expect(api.notificationSettings).not.toHaveBeenCalled();
  });

  it.each(['settingsPages', 'revokes', 'chatFirst'] as const)('records every %s closure before React renders', async key => {
    const generation = getRolloutGeneration(key);
    const capture = captureRollout(key);
    expect(capture.still()).toBe(true);
    await cycle(key);
    expect(getRolloutGeneration(key)).toBe(generation + 1);
    expect(capture.still()).toBe(false);
    expect(captureRollout(key).still()).toBe(true);
  });

  it('refreshes snapshots and refuses a stale section before a write can read it', async () => {
    const stale = deferred<SettingsSectionPayload>();
    const read = vi.mocked(api.settingsSection).mockReturnValueOnce(stale.promise);
    await render(changeControl({ operation: 'hermes.skill-staging', params: { enabled: true } }));
    await cycle('revokes');
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => stale.resolve({ ...payload, rollout: { ...enabled, revokes: false } }));
    expect(button('Save setting').matches(':disabled')).toBe(false);
  });

  it('keeps the worker-approval and sign-out writes disabled without explicit rollout', async () => {
    await render(h(SettingsPage));
    await act(async () => setState(s => ({ ...s, rollout: undefined })));
    expect(button("Workers' approvals come to me").matches(':disabled')).toBe(true);
    expect(button('Sign out').matches(':disabled')).toBe(true);
  });
});

it('covers every caller of a rollout-gated API in the continuation table', () => {
  const source = dirname(dirname(fileURLToPath(import.meta.url)));
  const functions = new Map(ROLLOUT_GATED_API.map(entry => [entry.name, entry.key]));
  const uncovered: string[] = [];
  const visitFiles = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'test') visitFiles(file); continue; }
      if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\./.test(entry.name)) continue;
      const path = relative(source, file);
      const calls = readFileSync(file, 'utf8').matchAll(/\bapi\s*(?:\.\s*(\w+)|\[\s*['"](\w+)['"]\s*\])\s*\(/g);
      for (const call of calls) {
        const name = (call[1] ?? call[2]) as keyof typeof api;
        if (functions.has(name) && !controls.some(control => control.file === path && control.calls.includes(name))) uncovered.push(`${path}: api.${name}`);
      }
    }
  };
  visitFiles(source);
  expect(uncovered).toEqual([]);
  expect(new Set(controls.flatMap(control => control.calls))).toEqual(new Set(ROLLOUT_GATED_API.map(entry => entry.name)));
});

describe('device notifications independent of settings rollout', () => {
  it.each((['NotificationRules', 'ForYouSettings'] as const).flatMap(component => [false, true].map(initiallyEnabled => ({ component, initiallyEnabled }))))
  ('$component drops a device follow-up settings snapshot when rollout changes, initially enabled: $initiallyEnabled', async ({ component, initiallyEnabled }) => {
    setState(s => ({ ...s, rollout: { ...enabled, settingsPages: initiallyEnabled } }));
    browserPush('enable');
    await render(h(component === 'NotificationRules' ? NotificationRules : ForYouSettings));
    const pending = deferred<Awaited<ReturnType<typeof api.notificationSettings>>>();
    if (component === 'NotificationRules') vi.mocked(api.notificationSettings).mockReturnValueOnce(pending.promise);
    else vi.mocked(api.feed).mockReturnValueOnce(pending.promise.then(settings => ({ ...feed, settings: { ...feed.settings, quietHours: settings.quietHours } })));
    await click('Notifications on this device');
    expect(button('Notifications on this device').getAttribute('aria-checked')).toBe('true');
    if (initiallyEnabled) await cycle('settingsPages');
    else await act(async () => setState(s => ({ ...s, rollout: enabled })));
    await act(async () => pending.resolve({ ...notifications, quietHours: null }));
    expect(button('Quiet hours').getAttribute('aria-checked')).toBe('true');
    expect(button('Notifications on this device').getAttribute('aria-checked')).toBe('true');
    expect(button('Notifications on this device').matches(':disabled')).toBe(false);
  });

  it.each((['NotificationRules', 'ForYouSettings'] as const).flatMap(component =>
    [false, undefined, true].map(settingsPages => ({ component, settingsPages }))))
  ('$component re-registers and keeps device controls enabled with settingsPages $settingsPages', async ({ component, settingsPages }) => {
    setState(s => ({ ...s, rollout: settingsPages === undefined ? undefined : { ...enabled, settingsPages } }));
    const browser = browserPush('disable');
    const actual = await vi.importActual<typeof import('../push.js')>('../push.js');
    vi.mocked(pushState).mockImplementation(actual.pushState);
    const test = vi.spyOn(api, 'pushTest').mockResolvedValue({ sent: 1 });
    await render(h(component === 'NotificationRules' ? NotificationRules : ForYouSettings));
    expect(browser.add).toHaveBeenCalledExactlyOnceWith({ ...browser.json, label: 'Safari on Linux' });
    expect(button('Notifications on this device').getAttribute('aria-checked')).toBe('true');
    expect(button('Notifications on this device').matches(':disabled')).toBe(false);
    expect(button('Send a test').matches(':disabled')).toBe(false);
    expect(button('Quiet hours').matches(':disabled')).toBe(settingsPages !== true);
    await click('Send a test');
    expect(test).toHaveBeenCalledOnce();
    await click('Notifications on this device');
    expect(browser.remove).toHaveBeenCalledExactlyOnceWith(browser.json.endpoint);
    expect(browser.subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(button('Notifications on this device').getAttribute('aria-checked')).toBe('false');
    browser.registration.pushManager.getSubscription.mockResolvedValue(null);
    await click('Notifications on this device');
    expect(browser.add).toHaveBeenCalledTimes(2);
    expect(browser.registration.pushManager.subscribe).toHaveBeenCalledOnce();
    expect(button('Notifications on this device').getAttribute('aria-checked')).toBe('true');
  });

  it.each((['NotificationRules', 'ForYouSettings'] as const).flatMap(component =>
    [false, undefined].map(settingsPages => ({ component, settingsPages }))))
  ('$component reports off when subscription re-registration fails with settingsPages $settingsPages', async ({ component, settingsPages }) => {
    setState(s => ({ ...s, rollout: settingsPages === undefined ? undefined : { ...enabled, settingsPages } }));
    const browser = browserPush('disable');
    browser.add.mockRejectedValue(new Error('Registration refused'));
    const actual = await vi.importActual<typeof import('../push.js')>('../push.js');
    vi.mocked(pushState).mockImplementation(actual.pushState);
    await render(h(component === 'NotificationRules' ? NotificationRules : ForYouSettings));
    expect(browser.add).toHaveBeenCalledOnce();
    expect(button('Notifications on this device').getAttribute('aria-checked')).toBe('false');
    expect(button('Notifications on this device').matches(':disabled')).toBe(false);
  });

  it.each((['NotificationRules', 'ForYouSettings'] as const).flatMap(component => [
    ...['registration', 'lookup', 'add'].map(stage => ({ component, kind: 'status' as const, stage })),
    ...['permission', 'registration', 'register', 'ready', 'key', 'lookup', 'unsubscribe', 'subscribe', 'add'].map(stage => ({ component, kind: 'enable' as const, stage })),
    ...['registration', 'lookup', 'remove', 'unsubscribe'].map(stage => ({ component, kind: 'disable' as const, stage })),
  ]))
  ('$component completes device $kind pending $stage across a batched settings rollout closure', async ({ component, kind, stage }) => {
    const browser = browserPush(kind === 'enable' ? 'enable' : 'disable', stage);
    if (kind === 'status') {
      const actual = await vi.importActual<typeof import('../push.js')>('../push.js');
      vi.mocked(pushState).mockImplementationOnce(actual.pushState);
    } else vi.mocked(pushState).mockResolvedValue(kind === 'disable' ? 'on' : 'off');
    await render(h(component === 'NotificationRules' ? NotificationRules : ForYouSettings));
    if (kind !== 'status') await click('Notifications on this device');
    expect(browser.steps.at(-1)).toBe(stage);
    await cycle('settingsPages');
    if (kind !== 'status') expect(button('Notifications on this device').matches(':disabled')).toBe(true);
    await act(async () => browser.pending.resolve());
    expect(browser.add).toHaveBeenCalledTimes(kind === 'disable' ? 0 : 1);
    expect(browser.remove).toHaveBeenCalledTimes(kind === 'disable' ? 1 : 0);
    expect(button('Notifications on this device').getAttribute('aria-checked')).toBe(String(kind !== 'disable'));
    expect(button('Notifications on this device').matches(':disabled')).toBe(false);
  });
});
