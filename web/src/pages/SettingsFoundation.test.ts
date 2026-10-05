// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceInfo } from '../../../shared/protocol.js';
import type { SettingsChecksResponse } from '../../../shared/settings-checks.js';
import { parseOperation, readViewValues, SETTINGS_OPERATIONS } from '../../../shared/settings-ops.js';
import { settingsApplyBodySchema } from '../../../shared/settings.js';
import { pendingWorkerApprovals } from '../../../shared/safety.js';
import { drainRestartRunSchema } from '../../../shared/supervisor-config.js';
import { setState } from '../store.js';
import { entrySha256, isSettingsSectionPayload, type SettingsSectionPayload } from '../settingsModel.js';
import { SafetySettingsPage } from './SettingsSafety.js';
import { ModelsSettingsPage } from './SettingsModels.js';
import { ChecksSettingsPage } from './SettingsChecks.js';
import { parseRoute, settingsPath } from '../router.js';
import { SettingsRestart } from '../components/SettingsRestart.js';

const phone: DeviceInfo = { id: 'dv_000000000000000000000001', name: 'Example phone', kind: 'phone', scopes: ['settings'], created: 0, lastSeen: 0 };
const desktop: DeviceInfo = { ...phone, id: 'dv_000000000000000000000002', name: 'Example desktop', kind: 'desktop', scopes: ['settings', 'pc-settings'] };
const confirm = { status: 'confirm', confirm: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA', summary: 'Restart Hermes now.', expiresAt: 0 };
const run = { id: '00000000-0000-4000-8000-000000000001', component: 'hermes', when: 'idle', state: 'waiting', startedAt: 0, attempts: 0, busy: ['call'] };
let sections: Record<string, SettingsSectionPayload>;
let checks: SettingsChecksResponse;
let restartReply: unknown;
let applyReply: unknown;
let writes: { url: string; body: Record<string, unknown> }[];
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let root: Root;
let container: HTMLDivElement;

function view(id: string, values: Record<string, unknown> = {}) {
  return { ok: true, view: id, present: true, sha256: 'a'.repeat(64), values: Object.entries(values).map(([path, value]) => ({ path: path.split('.'), exists: true, value })) };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  sections = {
    safety: { section: 'safety', views: [
      view('hermes.safety', { 'approvals.mode': 'off', command_allowlist: ['git status'], 'skills.write_approval': false }),
      view('hermes.allowlist', { command_allowlist: ['git status'] }),
      { ok: true, view: 'hermes.managed', present: false },
      view('wayroost.settings', { safetyCommandsEnabled: true }),
      view('codex.approvals'), view('claude.permissions'), view('opencode.permissions'),
    ], operations: [] },
    agents: { section: 'agents', views: [view('paseo.agents'), view('hermes.agents'), view('hermes.models')], operations: [] },
    models: { section: 'models', views: [view('gateway.role-map'), view('gateway.state'), view('hermes.models'), view('pi.settings'), view('pi.models')], operations: [] },
    checks: { section: 'checks', views: [view('hermes.models'), view('gateway.state'), { ok: true, view: 'hermes.managed', present: false }], operations: [] },
  } as Record<string, SettingsSectionPayload>;
  for (const [operation, spec] of Object.entries(SETTINGS_OPERATIONS)) {
    sections[spec.section]?.operations?.push({ operation, title: spec.title, access: 'editable', ...('byParam' in spec.level ? { accessByValue: Object.fromEntries(Object.entries(spec.level.values).map(([value, level]) => [value, level === 'pc-only' ? 'read-only' : 'editable'])) } : {}) });
  }
  checks = { generatedAt: 0, rows: [] };
  restartReply = { status: 'accepted', run, timing: [{ label: 'restart-when-idle:hermes' }] };
  applyReply = { status: 'applied', change: { id: 'ch_000000000000000000000001', operation: 'hermes.revoke-always', target: 'hermes-config', keys: [], timing: [{ label: 'restart-when-idle:hermes' }], effective: 'pending', undoable: true } };
  writes = [];
  fetchMock = vi.fn(async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      writes.push({ url, body });
      if (url.endsWith('/apply')) {
        const parsed = settingsApplyBodySchema.parse(body);
        expect(parseOperation(parsed.operation, parsed.params, 'server').ok).toBe(true);
        return Response.json(applyReply);
      }
      return Response.json(await restartReply);
    }
    if (url.includes('/sections/')) return Response.json(sections[url.split('/sections/')[1]!] ?? { status: 'refused', code: 'not_configured' });
    if (url.endsWith('/checks')) return Response.json(checks);
    if (url.endsWith('/usage')) return Response.json({ ok: true, generatedAt: 0, windows: [] });
    if (url.endsWith('/cloud-agents')) return Response.json({ agents: [] });
    if (url.endsWith('/safety-commands')) return Response.json({ enabled: true, commands: ['status'] });
    if (url.endsWith('/worker-approvals')) return Response.json(pendingWorkerApprovals());
    return Response.json({ status: 'refused', code: 'not_configured' });
  });
  vi.stubGlobal('fetch', fetchMock);
  setState(s => ({ ...s, device: desktop, toasts: [], unpaired: false, sessionExpired: false }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(element: ReactElement) { await act(async () => root.render(element)); }
async function refresh() { await act(async () => setState(s => ({ ...s, settingsVersion: s.settingsVersion + 1 }))); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function click(label: string) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(el => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label);
  expect(button, label).toBeTruthy();
  expect(button!.matches(':disabled'), label).toBe(false);
  await act(async () => button!.click());
  if (label.startsWith('Revoke ')) {
    await vi.waitFor(async () => {
      await act(async () => {});
      const current = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(el => el.getAttribute('aria-label') === label);
      expect(current?.matches(':disabled') ?? false).toBe(false);
    });
  }
}
function control(label: string) { return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!; }
async function visibility(value: 'visible' | 'hidden') {
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
const usageRequests = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/usage')).length;

describe('Safety allowlist ownership', () => {
  async function setAllowlist(effective: string[] | string, saved: string[], pinned: boolean, device = desktop) {
    setState(s => ({ ...s, device }));
    const context = { scopes: device.scopes, listener: device.kind === 'phone' ? 'main' as const : 'local' as const, pcOnlyWrites: true };
    const payload = sections.safety!;
    for (const [id, document] of [
      ['hermes.safety', { command_allowlist: effective }],
      ['hermes.allowlist', { command_allowlist: saved }],
      ['hermes.managed', pinned ? { command_allowlist: effective } : {}],
    ] as const) {
      const result = payload.views!.find(result => result.view === id)!;
      Object.assign(result, { present: true, sha256: 'a'.repeat(64), values: await readViewValues(id, document, context),
        ...(id === 'hermes.safety' ? { effective: true } : {}) });
    }
    expect(isSettingsSectionPayload(payload, 'safety')).toBe(true);
  }

  it.each([
    { format: 'array', effective: ['echo managed-example'] },
    { format: 'flow sequence string', effective: '["echo managed-example"]' },
    { format: 'block sequence string', effective: '- echo managed-example\n' },
  ].flatMap(({ format, effective }) => [[], ['echo user-example']].map(saved => ({ format, effective, saved }))))('shows effective pinned commands from a $format when the saved list is $saved', async ({ effective, saved }) => {
    await setAllowlist(effective, saved, true);
    await render(createElement(SafetySettingsPage));
    const group = container.querySelector('.safety-always')!;
    expect(group.textContent).toContain('echo managed-example');
    expect(group.textContent).not.toContain('echo user-example');
    expect(group.textContent).not.toContain('Nothing is on the list');
    expect(group.textContent).toContain('Pinned by the install. Read-only here.');
    const revoke = control('Revoke echo managed-example');
    expect(revoke.matches(':disabled')).toBe(true);
    await act(async () => revoke.click());
    expect(writes).toEqual([]);
  });

  it.each([{ effective: [] }, { effective: '[]' }])('labels an empty effective pinned list $effective read-only without showing saved commands', async ({ effective }) => {
    await setAllowlist(effective, ['echo user-example'], true);
    await render(createElement(SafetySettingsPage));
    const group = container.querySelector('.safety-always')!;
    expect(group.textContent).toContain('Nothing is on the list');
    expect(group.textContent).toContain('Pinned by the install. Read-only here.');
    expect(group.textContent).not.toContain('echo user-example');
    expect(group.querySelector('button')).toBeNull();
  });

  it.each([{ effective: ['echo managed-example'] }, { effective: '["echo managed-example"]' }])('keeps a phone’s effective pinned commands $effective hidden and read-only', async ({ effective }) => {
    await setAllowlist(effective, ['echo user-example'], true, phone);
    sections.safety!.allowlistEntries = [{ entrySha256: await entrySha256('echo user-example') }];
    await render(createElement(SafetySettingsPage));
    const group = container.querySelector('.safety-always')!;
    expect(group.textContent).toContain('Pinned by the install; the effective value is unavailable. Read-only here.');
    expect(group.textContent).not.toContain('echo managed-example');
    expect(group.textContent).not.toContain('echo user-example');
    expect(group.querySelector('button')).toBeNull();
    expect(writes).toEqual([]);
  });

  it.each(['[', 'echo managed-example', '["echo managed-example", 1]', 'command: echo managed-example', 'null'])('keeps an invalid effective pinned list %j unavailable and read-only', async effective => {
    await setAllowlist(effective, ['echo user-example'], true);
    await render(createElement(SafetySettingsPage));
    const group = container.querySelector('.safety-always')!;
    expect(group.textContent).toContain('Pinned by the install; the effective value is unavailable. Read-only here.');
    expect(group.textContent).not.toContain('Nothing is on the list');
    expect(group.textContent).not.toContain('echo managed-example');
    expect(group.textContent).not.toContain('echo user-example');
    expect(group.querySelector('button')).toBeNull();
    expect(writes).toEqual([]);
  });

  it('does not fall back to saved commands when the pinned effective list is missing', async () => {
    await setAllowlist(['echo managed-example'], ['echo user-example'], true);
    sections.safety!.views!.find(result => result.view === 'hermes.safety')!.values = [];
    await render(createElement(SafetySettingsPage));
    const group = container.querySelector('.safety-always')!;
    expect(group.textContent).toContain('Pinned by the install; the effective value is unavailable. Read-only here.');
    expect(group.textContent).not.toContain('echo user-example');
    expect(group.querySelector('button')).toBeNull();
  });

  it('revokes the saved entry when an unpinned effective list differs', async () => {
    await setAllowlist(['echo effective-example'], ['git status'], false);
    await render(createElement(SafetySettingsPage));
    const group = container.querySelector('.safety-always')!;
    expect(group.textContent).not.toContain('echo effective-example');
    expect(group.textContent).not.toContain('Pinned by the install');
    await click('Revoke git status');
    expect(writes[0]).toEqual({ url: '/api/settings/apply', body: {
      operation: 'hermes.revoke-always', params: { entrySha256: await entrySha256('git status') }, expected: { file: { sha256: 'a'.repeat(64) } },
    } });
  });

  it('keeps revocation unavailable when the saved allowlist read fails', async () => {
    await setAllowlist(['echo effective-example'], ['git status'], false);
    sections.safety!.views = sections.safety!.views!.map(result => result.view === 'hermes.allowlist' ? { view: result.view, ok: false, code: 'unavailable' } : result);
    await render(createElement(SafetySettingsPage));
    const group = container.querySelector('.safety-always')!;
    expect(group.textContent).not.toContain('echo effective-example');
    expect(group.querySelector('button')).toBeNull();
    expect(writes).toEqual([]);
  });
});

describe('Safety read dependencies', () => {
  it.each(['codex.approvals', 'claude.permissions', 'opencode.permissions'])('isolates a failed %s read from editable controls', async id => {
    sections.safety!.views = sections.safety!.views!.map(entry => entry.view === id ? { view: id, ok: false, code: 'not_configured' } : entry);
    await render(createElement(SafetySettingsPage));
    expect(container.textContent).toContain('This PC has no such setting set up yet.');
    await click('Revoke git status');
    expect(writes[0]!.body.operation).toBe('hermes.revoke-always');
    await click('Skill changes wait for your OK');
    expect(writes[1]!.body.operation).toBe('hermes.skill-staging');
    await click('Hermes safety commands');
    expect(writes[2]!.body.operation).toBe('wayroost.safety-commands');
  });

  it('guards the worker switch alone when its provider read fails', async () => {
    sections.agents!.views = [{ ok: false, view: 'paseo.agents', code: 'unavailable' }];
    await render(createElement(SafetySettingsPage));
    expect(control("Workers' approvals come to me")?.matches(':disabled') ?? true).toBe(true);
    await click('Skill changes wait for your OK');
    await click('Hermes safety commands');
    expect(writes).toHaveLength(2);
  });

  it('keeps Hermes changes read-only when their managed read fails', async () => {
    sections.safety!.views = sections.safety!.views!.map(entry => entry.view === 'hermes.managed' ? { view: entry.view, ok: false, code: 'unavailable' } : entry);
    await render(createElement(SafetySettingsPage));
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Revoke git status"]')?.matches(':disabled') ?? true).toBe(true);
    expect(control('Skill changes wait for your OK')?.matches(':disabled') ?? true).toBe(true);
    expect(container.textContent).toContain('The effective value is unavailable. Read-only here.');
    await click('Hermes safety commands');
    expect(writes[0]!.body.operation).toBe('wayroost.safety-commands');
  });
});

describe('Checks', () => {
  it('has a route and shows every server row, with high priority and failures first', async () => {
    expect(parseRoute('/settings/checks')).toEqual({ name: 'settings', page: 'checks' });
    expect(settingsPath('checks')).toBe('/settings/checks');
    checks.rows = [
      { id: 'demo.ok', state: 'ok', sentence: 'Server says this is okay.' },
      { id: 'demo.unknown', state: 'unknown', sentence: 'The server could not read this.' },
      { id: 'demo.warn', state: 'warn', sentence: 'Server warning.', details: ['Saved keys: 2'] },
      { id: 'demo.fail', state: 'fail', sentence: 'Server mismatch.', details: ['model.default'] },
      { id: 'demo.priority', state: 'warn', priority: 'high', sentence: 'Look here first.' },
    ];
    await render(createElement(ChecksSettingsPage));
    expect(Array.from(container.querySelectorAll('[data-check-id]')).map(row => row.getAttribute('data-check-id'))).toEqual(['demo.priority', 'demo.fail', 'demo.ok', 'demo.unknown', 'demo.warn']);
    for (const row of checks.rows) {
      const text = container.querySelector(`[data-check-id="${row.id}"]`)!.textContent!;
      expect(text).toContain({ ok: 'OK', warn: 'Warning', fail: 'Needs attention', unknown: 'Unknown' }[row.state]);
      expect(text).toContain(row.sentence);
      for (const detail of row.details ?? []) expect(text).toContain(detail);
    }
    expect(container.textContent).toContain('Priority: high');
    checks.rows = [{ id: 'demo.ok', state: 'fail', sentence: 'The server now reports a mismatch.' }];
    await click('Refresh checks');
    expect(container.querySelector('[data-check-id="demo.ok"]')!.getAttribute('data-state')).toBe('fail');
    expect(container.textContent).toContain('The server now reports a mismatch.');
  });

  it('applies an anywhere Fix with its snapshot and exact server parameters', async () => {
    checks.rows = [{ id: 'demo.effort', state: 'fail', sentence: 'Reasoning differs.', fix: { operation: 'hermes.reasoning-effort', params: { effort: 'high' } } }];
    await render(createElement(ChecksSettingsPage));
    expect(container.textContent).toContain('Any device');
    expect(container.textContent).toContain('Takes effect');
    await click('Fix demo.effort');
    expect(writes[0]).toEqual({ url: '/api/settings/apply', body: { operation: 'hermes.reasoning-effort', params: { effort: 'high' }, expected: { file: { sha256: 'a'.repeat(64) } } } });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/checks')).length).toBeGreaterThan(1);
  });

  it('refreshes Fix preconditions even when the server returns the same Fix', async () => {
    checks.rows = [{ id: 'demo.effort', state: 'fail', sentence: 'Reasoning differs.', fix: { operation: 'hermes.reasoning-effort', params: { effort: 'high' } } }];
    await render(createElement(ChecksSettingsPage));
    for (const entry of sections.agents!.views!) entry.sha256 = 'b'.repeat(64);
    await click('Refresh checks');
    await click('Fix demo.effort');
    expect(writes[0]!.body.expected).toEqual({ file: { sha256: 'b'.repeat(64) } });
  });

  it('holds a confirm Fix on a phone and resends exactly its request with the code', async () => {
    setState(s => ({ ...s, device: phone }));
    sections.models!.operations!.find(info => info.operation === 'gateway.point')!.access = 'confirm';
    checks.rows = [{ id: 'demo.role', state: 'fail', sentence: 'Role differs.', fix: { operation: 'gateway.point', params: { role: 'coder', backend: 'demo-backend' } } }];
    applyReply = { ...confirm, summary: 'Point coder to demo-backend.', expiresAt: Date.now() + 60_000 };
    await render(createElement(ChecksSettingsPage));
    expect(container.textContent).toContain('Confirm');
    await click('Fix demo.role');
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    expect(writes).toHaveLength(1);
    applyReply = { status: 'refused', code: 'precondition_changed' };
    await click('Confirm');
    expect(writes[1]!.body).toEqual({ ...writes[0]!.body, confirm: confirm.confirm });
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('shows PC-only fixes read-only using the server access', async () => {
    setState(s => ({ ...s, device: phone }));
    checks.rows = [{ id: 'demo.safety', state: 'warn', sentence: 'Approval differs.', fix: { operation: 'hermes.approval-mode', params: { mode: 'off' } } }];
    await render(createElement(ChecksSettingsPage));
    expect(container.textContent).toContain('PC only');
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Fix demo.safety"]')!.matches(':disabled')).toBe(true);
    expect(writes).toEqual([]);
  });

  it.each(['gateway.socket-recover', 'hermes.drain-marker-remove'] as const)('runs the server recovery %s through apply without file preconditions', async action => {
    checks.rows = [{ id: 'demo.recovery', state: 'fail', sentence: 'Recovery needed.', fix: { action } }];
    await render(createElement(ChecksSettingsPage));
    await click('Fix demo.recovery');
    expect(writes[0]!.body).toEqual({ operation: action, params: {} });
  });

  it('runs a recorded Fix using the server intent without deriving its values', async () => {
    const params = { consumer: 'hermes', target: 'hermes-config', intentId: 'b'.repeat(64) };
    checks.rows = [{ id: 'demo.intent', state: 'warn', sentence: 'Saved intent differs.', fix: { operation: 'gateway.reapply-intended', params } }];
    await render(createElement(ChecksSettingsPage));
    await click('Fix demo.intent');
    expect(writes[0]!.body).toEqual({ operation: 'gateway.reapply-intended', params });
  });

  it('runs a restart Fix using its supplied timing and reports the server state', async () => {
    checks.rows = [{ id: 'demo.restart', state: 'warn', sentence: 'Restart needed.', fix: { restart: { component: 'hermes', when: 'idle' } } }];
    await render(createElement(ChecksSettingsPage));
    await click('Restart when idle');
    expect(writes[0]).toEqual({ url: '/api/settings/restart', body: { component: 'hermes', when: 'idle' } });
    expect(container.textContent).toContain('State: waiting. Waiting for: call.');
    expect(container.textContent).not.toContain('Restart now');
  });

  it('keeps following the first restart run when a second request is refused as busy', async () => {
    vi.useFakeTimers();
    checks.rows = [{ id: 'demo.restart', state: 'warn', sentence: 'Restart needed.', fix: { restart: { component: 'hermes', when: 'idle' } } }];
    const original = fetchMock.getMockImplementation()!;
    let polls = 0;
    fetchMock.mockImplementation((input, init) => String(input).startsWith('/api/settings/restart/')
      ? (polls++, Promise.resolve(Response.json({ status: 'completed', run: { ...run, state: 'done', busy: [], endedAt: 1, outcome: 'restarted' } })))
      : original(input, init));
    await render(createElement(ChecksSettingsPage));
    await click('Restart when idle');
    expect(container.textContent).toContain('State: waiting');
    restartReply = { status: 'refused', code: 'busy' };
    await click('Restart when idle');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(polls).toBeGreaterThan(0);
    expect(container.textContent).toContain('State: done. Outcome: restarted.');
  });

  it('keeps a newer run state when an older page snapshot arrives, and clears a stale read error on a final answer', async () => {
    vi.useFakeTimers();
    const waiting = { ...run, startedAt: 10 };
    const ended = { ...run, startedAt: 10, state: 'still-busy', outcome: 'still_busy', endedAt: 20 };
    const original = fetchMock.getMockImplementation()!;
    let pollFails = false;
    fetchMock.mockImplementation((input, init) => String(input).startsWith('/api/settings/restart/')
      ? (pollFails ? Promise.reject(new Error('offline')) : Promise.resolve(Response.json({ status: 'refused', code: 'still_busy', run: ended })))
      : original(input, init));
    const element = (initialRun: typeof run) => createElement(SettingsRestart, { component: 'hermes', initialRun } as never);
    await render(element(waiting));
    expect(container.textContent).toContain('State: waiting');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(container.textContent).toContain('still-busy');
    await render(element({ ...waiting }));
    expect(container.textContent).toContain('still-busy');
    expect(container.textContent).not.toContain('State: waiting');
    pollFails = true;
    restartReply = { status: 'accepted', run: { ...run, id: '00000000-0000-4000-8000-000000000002', startedAt: 30 } };
    await click('Restart when idle');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(container.textContent).toContain('Checking again');
    restartReply = { status: 'completed', run: { ...run, id: '00000000-0000-4000-8000-000000000003', startedAt: 40, state: 'done', busy: [], endedAt: 41, outcome: 'restarted' } };
    await click('Restart when idle');
    expect(container.textContent).toContain('State: done. Outcome: restarted.');
    expect(container.textContent).not.toContain('Checking again');
  });

  it('keeps a newer completed run when an older snapshot arrives together with a timing change', async () => {
    const older = { ...run, startedAt: 10, state: 'still-busy', outcome: 'still_busy', endedAt: 11 };
    restartReply = { status: 'completed', run: { ...run, id: '00000000-0000-4000-8000-00000000000b', startedAt: 20, state: 'done', busy: [], endedAt: 21, outcome: 'restarted' } };
    await render(createElement(SettingsRestart, { component: 'hermes' } as never));
    await click('Restart when idle');
    expect(container.textContent).toContain('State: done. Outcome: restarted.');
    await render(createElement(SettingsRestart, { component: 'hermes', initialRun: older, when: 'now' } as never));
    expect(container.textContent).toContain('State: done. Outcome: restarted.');
    expect(container.textContent).not.toContain('still-busy');
  });

  it.each(['checks', 'restart'] as const)('keeps a pending restart through refresh when %s responds first', async first => {
    checks.rows = [{ id: 'demo.restart', state: 'warn', sentence: 'Restart needed.', fix: { restart: { component: 'hermes', when: 'idle' } } }];
    const restart = deferred<unknown>();
    const answer = restartReply;
    restartReply = restart.promise;
    await render(createElement(ChecksSettingsPage));
    await click('Restart when idle');
    const checked = deferred<Response>();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => String(url).endsWith('/checks') ? checked.promise.then(response => response.clone()) : original(url, init));
    await click('Refresh checks');
    const button = () => container.querySelector<HTMLButtonElement>('[data-check-id="demo.restart"] button')!;
    expect(button().disabled).toBe(true);
    expect(button().querySelector('.spin')).toBeTruthy();

    if (first === 'checks') {
      await act(async () => checked.resolve(Response.json(checks)));
      expect(button().disabled).toBe(true);
      expect(button().querySelector('.spin')).toBeTruthy();
      expect(container.textContent).not.toContain('Restart accepted.');
      await act(async () => restart.resolve(answer));
    } else {
      await act(async () => restart.resolve(answer));
      expect(button().disabled).toBe(true);
      expect(button().querySelector('.spin')).toBeNull();
      expect(container.textContent).toContain('State: waiting. Waiting for: call.');
      await act(async () => checked.resolve(Response.json(checks)));
    }

    expect(container.textContent).toContain('State: waiting. Waiting for: call.');
    expect(button().disabled).toBe(false);
    expect(writes).toEqual([{ url: '/api/settings/restart', body: { component: 'hermes', when: 'idle' } }]);
    fetchMock.mockImplementation(original);
    await click('Refresh checks');
    expect(container.textContent).toContain('State: waiting. Waiting for: call.');
  });

  it('holds a restart confirmation received during refresh until the same Fix is ready', async () => {
    setState(s => ({ ...s, device: phone }));
    checks.rows = [{ id: 'demo.restart', state: 'warn', sentence: 'Restart needed.', fix: { restart: { component: 'hermes', when: 'idle' } } }];
    const restart = deferred<unknown>();
    const answer = restartReply;
    restartReply = restart.promise;
    await render(createElement(ChecksSettingsPage));
    await click('Restart when idle');
    const checked = deferred<Response>();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => String(url).endsWith('/checks') ? checked.promise.then(response => response.clone()) : original(url, init));
    await click('Refresh checks');
    await act(async () => restart.resolve({ ...confirm, expiresAt: Date.now() + 60_000 }));
    const confirmButton = () => container.querySelector<HTMLButtonElement>('[role="alertdialog"] .btn-primary')!;
    expect(confirmButton()).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);
    expect(writes).toHaveLength(1);
    await act(async () => checked.resolve(Response.json(checks)));
    expect(confirmButton().disabled).toBe(false);
    restartReply = answer;
    await click('Confirm');
    expect(writes[1]).toEqual({ url: '/api/settings/restart', body: { component: 'hermes', when: 'idle', confirm: confirm.confirm } });
    expect(container.textContent).toContain('State: waiting. Waiting for: call.');
  });

  it.each([
    { component: 'gateway', when: 'idle' },
    { component: 'hermes', when: 'now' },
  ] as const)('discards a delayed restart response when the Fix changes to $component/$when', async fix => {
    checks.rows = [{ id: 'demo.restart', state: 'warn', sentence: 'Restart needed.', fix: { restart: { component: 'hermes', when: 'idle' } } }];
    const restart = deferred<unknown>();
    const answer = restartReply;
    restartReply = restart.promise;
    await render(createElement(ChecksSettingsPage));
    await click('Restart when idle');
    checks.rows[0]!.fix = { restart: fix };
    await click('Refresh checks');
    const reads = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/checks')).length;
    await act(async () => restart.resolve(answer));
    expect(container.textContent).not.toContain('Restart accepted.');
    expect(container.querySelector<HTMLButtonElement>('[data-check-id="demo.restart"] button')!.disabled).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/checks'))).toHaveLength(reads);
    expect(writes).toHaveLength(1);
  });

  it.each(['pending', 'accepted'] as const)('invalidates the %s restart when settings access is revoked', async state => {
    checks.rows = [{ id: 'demo.restart', state: 'warn', sentence: 'Restart needed.', fix: { restart: { component: 'hermes', when: 'idle' } } }];
    const restart = deferred<unknown>();
    const answer = restartReply;
    restartReply = restart.promise;
    await render(createElement(ChecksSettingsPage));
    await click('Restart when idle');
    if (state === 'accepted') {
      await act(async () => restart.resolve(answer));
      expect(container.textContent).toContain('State: waiting.');
    }
    await act(async () => setState(s => ({ ...s, device: { ...desktop, scopes: [] } })));
    expect(container.querySelector<HTMLButtonElement>('[data-check-id="demo.restart"] button')!.disabled).toBe(true);
    await act(async () => restart.resolve(answer));
    await act(async () => setState(s => ({ ...s, device: desktop })));
    expect(container.textContent).not.toContain('Restart accepted.');
    expect(container.querySelector<HTMLButtonElement>('[data-check-id="demo.restart"] button')!.disabled).toBe(false);
    expect(writes).toHaveLength(1);
  });

  it('ignores a delayed restart response after leaving and returning to Checks', async () => {
    checks.rows = [{ id: 'demo.restart', state: 'warn', sentence: 'Restart needed.', fix: { restart: { component: 'hermes', when: 'idle' } } }];
    const restart = deferred<unknown>();
    const answer = restartReply;
    restartReply = restart.promise;
    await render(createElement(ChecksSettingsPage));
    await click('Restart when idle');
    await render(createElement('div'));
    await render(createElement(ChecksSettingsPage));
    const reads = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/checks')).length;
    await act(async () => restart.resolve(answer));
    expect(container.textContent).not.toContain('Restart accepted.');
    expect(container.querySelector<HTMLButtonElement>('[data-check-id="demo.restart"] button')!.disabled).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/checks'))).toHaveLength(reads);
    expect(writes).toHaveLength(1);
  });

  it('confirms a now restart Fix before sending its exact component and timing', async () => {
    checks.rows = [{ id: 'demo.restart', state: 'warn', sentence: 'Restart the model gateway.', fix: { restart: { component: 'gateway', when: 'now' } } }];
    await render(createElement(ChecksSettingsPage));
    await click('Restart now');
    expect(writes).toEqual([]);
    expect(container.querySelector('[role="alertdialog"]')!.textContent).toContain('may interrupt active work');
    restartReply = { status: 'accepted', run: { ...run, component: 'gateway', when: 'now', state: 'restarting', busy: [] }, timing: [{ label: 'restart-now:gateway' }] };
    await click('Confirm');
    expect(writes[0]).toEqual({ url: '/api/settings/restart', body: { component: 'gateway', when: 'now' } });
    expect(container.textContent).toContain('State: restarting.');
  });

  it('cancels a held Fix when its own section fails and never resends after recovery', async () => {
    checks.rows = [{ id: 'demo.role', state: 'fail', sentence: 'Role differs.', fix: { operation: 'gateway.point', params: { role: 'coder', backend: 'demo-backend' } } }];
    applyReply = { ...confirm, expiresAt: Date.now() + 60_000 };
    await render(createElement(ChecksSettingsPage));
    await click('Fix demo.role');
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => String(url).endsWith('/sections/models') ? Promise.resolve(Response.json({ status: 'refused', code: 'unavailable' })) : original(url, init));
    await refresh();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    fetchMock.mockImplementation(original);
    await refresh();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(writes).toHaveLength(1);
  });

  it('drops a held request when the server changes the row’s Fix', async () => {
    checks.rows = [{ id: 'demo.role', state: 'fail', sentence: 'Role differs.', fix: { operation: 'gateway.point', params: { role: 'coder', backend: 'demo-backend' } } }];
    applyReply = { ...confirm, expiresAt: Date.now() + 60_000 };
    await render(createElement(ChecksSettingsPage));
    await click('Fix demo.role');
    checks.rows[0]!.fix = { operation: 'gateway.point', params: { role: 'coder', backend: 'other-demo-backend' } };
    await click('Refresh checks');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(writes).toHaveLength(1);
  });

  it.each([{ status: 'refused', code: 'not_configured' }, { generatedAt: 0, rows: [{ id: 'demo.bad', state: 'invented', sentence: 'Invalid state.' }] }])('reports an unreadable check response and recovers by retrying', async answer => {
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => String(url).endsWith('/api/settings/checks') ? Promise.resolve(Response.json(answer)) : original(url, init));
    await render(createElement(ChecksSettingsPage));
    expect(container.querySelector('[data-check-id]')).toBeNull();
    expect(container.textContent).not.toContain('The server returned no check rows');
    fetchMock.mockImplementation(original);
    await click('Retry');
    expect(container.textContent).toContain('The server returned no check rows.');
  });
});

describe('Revoke and restart', () => {
  function delaySafetyRead() {
    const response = deferred<Response>();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => String(url).endsWith('/sections/safety')
      ? response.promise.then(answer => answer.clone()) : original(url, init));
    return { response, original };
  }
  const restartButton = () => Array.from(container.querySelectorAll<HTMLButtonElement>('.safety-always button'))
    .find(button => button.textContent?.trim() === 'Restart when idle')!;
  const confirmButton = () => container.querySelector<HTMLButtonElement>('[role="alertdialog"] .btn-primary')!;

  it.each(['poll', 'snapshot'].flatMap(observation => [
    { observation, state: 'done', outcome: 'restarted', status: 'completed', code: undefined },
    { observation, state: 'failed', outcome: 'restart_unverified', status: 'refused', code: 'restart_unverified' },
  ]))('keeps a $state run observed through a $observation when its pending POST arrives later', async ({ observation, state, outcome, status, code }) => {
    vi.useFakeTimers();
    sections.safety!.restartRuns = [drainRestartRunSchema.parse({ ...run, state: 'done', busy: [], endedAt: 1, outcome: 'restarted' })];
    const active = drainRestartRunSchema.parse({ ...run, id: '00000000-0000-4000-8000-000000000002', when: 'now', startedAt: 2, state: 'restarting', busy: [] });
    const ended = drainRestartRunSchema.parse({ ...active, state, outcome, endedAt: 3 });
    const restart = deferred<unknown>();
    restartReply = restart.promise;
    const original = fetchMock.getMockImplementation()!;
    let polls = 0;
    fetchMock.mockImplementation((input, init) => String(input).startsWith('/api/settings/restart/')
      ? (++polls === 1 ? Promise.resolve(Response.json({ status, ...(code ? { code } : {}), run: ended }))
        : Promise.reject(new Error('Status unavailable'))) : original(input, init));
    const now = () => Array.from(container.querySelectorAll<HTMLButtonElement>('.safety-always button'))
      .find(button => button.textContent?.trim() === 'Restart now')!;

    await render(createElement(SafetySettingsPage));
    await click('Restart now');
    await click('Confirm');
    sections.safety!.restartRuns = [active];
    await refresh();
    expect(container.textContent).toContain('State: restarting.');
    if (observation === 'poll') {
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(polls).toBe(1);
    } else {
      sections.safety!.restartRuns = [ended];
      await refresh();
      expect(polls).toBe(0);
    }
    const terminalText = `State: ${state}. Outcome: ${outcome}.`;
    expect(container.textContent).toContain(terminalText);
    expect(now().matches(':disabled')).toBe(true);

    await act(async () => restart.resolve({ status: 'accepted', run: active }));
    expect(container.textContent).toContain(terminalText);
    expect(container.textContent).not.toContain('Restart accepted.');
    expect(now().matches(':disabled')).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(polls).toBe(observation === 'poll' ? 1 : 0);
    expect(container.textContent).not.toContain('The restart status could not be read');
    expect(now().matches(':disabled')).toBe(false);
    expect(writes).toEqual([{ url: '/api/settings/restart', body: { component: 'hermes', when: 'now' } }]);
  });

  it('offers idle and confirmed now restarts only after an applied revoke', async () => {
    vi.useFakeTimers();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => String(input).startsWith('/api/settings/restart/')
      ? Promise.resolve(Response.json({ status: 'refused', code: 'still_busy', run: { ...run, state: 'still-busy', outcome: 'still_busy', endedAt: 1 } }))
      : original(input, init));
    await render(createElement(SafetySettingsPage));
    expect(container.textContent).not.toContain('Restart when idle');
    applyReply = { status: 'refused', code: 'precondition_changed' };
    await click('Revoke git status');
    expect(container.textContent).not.toContain('Restart when idle');
    applyReply = { status: 'applied', change: { id: 'ch_000000000000000000000001', operation: 'hermes.revoke-always', target: 'hermes-config', keys: [], timing: [{ label: 'restart-when-idle:hermes' }], effective: 'pending', undoable: true } };
    await click('Revoke git status');
    expect(container.textContent).toContain('may keep honouring the revoked entry until its tracked restart finishes');
    await click('Restart when idle');
    expect(writes.at(-1)!.body).toEqual({ component: 'hermes', when: 'idle' });
    expect(container.textContent).toContain('State: waiting');
    expect([...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Restart now')!.disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(container.textContent).toContain('still-busy');
    const before = writes.length;
    await click('Restart now');
    expect(writes).toHaveLength(before);
    await click('Cancel');
    expect(writes).toHaveLength(before);
    expect(container.textContent).toContain('still-busy');
    await click('Restart now');
    restartReply = { status: 'completed', run: { ...run, id: '00000000-0000-4000-8000-000000000009', startedAt: 5, when: 'now', state: 'done', busy: [], endedAt: 6, outcome: 'restarted' }, timing: [{ label: 'restart-now:hermes' }] };
    await click('Confirm');
    expect(writes.at(-1)!.body).toEqual({ component: 'hermes', when: 'now' });
    expect(container.textContent).toContain('State: done. Outcome: restarted.');
  });

  it.each([
    { state: 'done', outcome: 'restarted', status: 'Restart completed. State: done. Outcome: restarted.' },
    { state: 'still-busy', outcome: 'still_busy', status: 'State: still-busy. Waiting for: call. Outcome: still_busy.' },
  ] as const)('clears a failed status poll when a Safety refresh supplies a $state run', async ({ state, outcome, status }) => {
    vi.useFakeTimers();
    const active = drainRestartRunSchema.parse(run);
    sections.safety!.restartRuns = [active];
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => String(input).startsWith('/api/settings/restart/')
      ? Promise.reject(new Error('Status unavailable')) : original(input, init));
    const statusReads = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/settings/restart/')).length;
    await render(createElement(SafetySettingsPage));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(statusReads()).toBe(1);
    expect(container.textContent).toContain('The restart status could not be read. Checking again…');
    const { response } = delaySafetyRead();
    await refresh();
    expect(container.textContent).toContain('The restart status could not be read. Checking again…');
    sections.safety!.restartRuns = [{ ...active, state, outcome, endedAt: 1,
      busy: state === 'done' ? [] : ['call'] }];
    await act(async () => response.resolve(Response.json(sections.safety)));
    expect(container.textContent).toContain(status);
    expect(container.textContent).not.toContain('The restart status could not be read');
    const now = Array.from(container.querySelectorAll<HTMLButtonElement>('.safety-always button'))
      .find(button => button.textContent?.trim() === 'Restart now')!;
    expect(now.matches(':disabled')).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(statusReads()).toBe(1);
    expect(container.textContent).toContain(status);
    expect(writes).toEqual([]);
  });

  it.each([
    { answer: { status: 'accepted', run, timing: [{ label: 'restart-when-idle:hermes' }] }, text: 'State: waiting. Waiting for: call.' },
    { answer: { status: 'refused', code: 'still_busy' }, text: 'It never went quiet in time' },
  ])('keeps the server restart result "$text" across a Safety refresh', async ({ answer, text }) => {
    await render(createElement(SafetySettingsPage));
    await click('Revoke git status');
    restartReply = answer;
    await click('Restart when idle');
    expect(container.textContent).toContain(text);
    const { response } = delaySafetyRead();
    await refresh();
    expect(restartButton().matches(':disabled')).toBe(true);
    expect(container.textContent).toContain(text);
    await act(async () => response.resolve(Response.json(sections.safety)));
    expect(restartButton().matches(':disabled')).toBe(answer.status === 'accepted');
    expect(container.textContent).toContain(text);
    expect(writes).toHaveLength(2);
  });

  it.each(['settings', 'restart'] as const)('keeps a pending Safety restart when %s responds first', async first => {
    await render(createElement(SafetySettingsPage));
    await click('Revoke git status');
    const restart = deferred<unknown>();
    const answer = restartReply;
    restartReply = restart.promise;
    await click('Restart when idle');
    const { response, original } = delaySafetyRead();
    await refresh();
    expect(restartButton().matches(':disabled')).toBe(true);
    expect(restartButton().querySelector('.spin')).toBeTruthy();

    if (first === 'settings') {
      await act(async () => response.resolve(Response.json(sections.safety)));
      expect(restartButton().matches(':disabled')).toBe(true);
      expect(restartButton().querySelector('.spin')).toBeTruthy();
      expect(container.textContent).not.toContain('Restart accepted.');
      await act(async () => restart.resolve(answer));
    } else {
      await act(async () => restart.resolve(answer));
      expect(restartButton().matches(':disabled')).toBe(true);
      expect(restartButton().querySelector('.spin')).toBeNull();
      expect(container.textContent).toContain('State: waiting. Waiting for: call.');
      await act(async () => response.resolve(Response.json(sections.safety)));
    }

    expect(container.textContent).toContain('State: waiting. Waiting for: call.');
    expect(restartButton().matches(':disabled')).toBe(true);
    expect(writes.at(-1)).toEqual({ url: '/api/settings/restart', body: { component: 'hermes', when: 'idle' } });
    expect(writes).toHaveLength(2);
    fetchMock.mockImplementation(original);
    await refresh();
    expect(container.textContent).toContain('State: waiting. Waiting for: call.');
  });

  it.each(['before', 'during'] as const)('holds a server restart confirmation received %s a Safety refresh', async arrival => {
    setState(s => ({ ...s, device: phone }));
    await render(createElement(SafetySettingsPage));
    await click('Revoke git status');
    const restart = deferred<unknown>();
    const answer = restartReply;
    const prompt = { ...confirm, expiresAt: Date.now() + 60_000 };
    restartReply = arrival === 'before' ? prompt : restart.promise;
    await click('Restart when idle');
    const { response } = delaySafetyRead();
    await refresh();
    if (arrival === 'during') await act(async () => restart.resolve(prompt));
    expect(container.querySelector('[role="alertdialog"]')!.textContent).toContain(confirm.confirm);
    expect(confirmButton().matches(':disabled')).toBe(true);
    await act(async () => confirmButton().click());
    expect(writes).toHaveLength(2);
    await act(async () => response.resolve(Response.json(sections.safety)));
    expect(confirmButton().matches(':disabled')).toBe(false);
    restartReply = answer;
    await click('Confirm');
    expect(writes.at(-1)).toEqual({ url: '/api/settings/restart', body: { component: 'hermes', when: 'idle', confirm: confirm.confirm } });
    expect(container.textContent).toContain('State: waiting. Waiting for: call.');
  });

  it('holds the Restart now confirmation disabled until a Safety refresh completes', async () => {
    await render(createElement(SafetySettingsPage));
    await click('Revoke git status');
    await click('Restart now');
    const { response } = delaySafetyRead();
    await refresh();
    expect(container.querySelector('[role="alertdialog"]')!.textContent).toContain('Restart now may interrupt active work. Continue?');
    expect(confirmButton().matches(':disabled')).toBe(true);
    await act(async () => confirmButton().click());
    expect(writes).toHaveLength(1);
    await act(async () => response.resolve(Response.json(sections.safety)));
    expect(confirmButton().matches(':disabled')).toBe(false);
    restartReply = { status: 'completed', run: { ...run, id: '00000000-0000-4000-8000-000000000009', startedAt: 5, when: 'now', state: 'done', busy: [], endedAt: 6, outcome: 'restarted' }, timing: [{ label: 'restart-now:hermes' }] };
    await click('Confirm');
    expect(writes.at(-1)).toEqual({ url: '/api/settings/restart', body: { component: 'hermes', when: 'now' } });
    expect(container.textContent).toContain('State: done. Outcome: restarted.');
  });

  it.each(['pending', 'accepted', 'confirmation'] as const)('invalidates the %s Safety restart when settings access is revoked', async state => {
    await render(createElement(SafetySettingsPage));
    await click('Revoke git status');
    const restart = deferred<unknown>();
    const answer = restartReply;
    restartReply = state === 'confirmation' ? { ...confirm, expiresAt: Date.now() + 60_000 } : restart.promise;
    await click('Restart when idle');
    if (state === 'accepted') {
      await act(async () => restart.resolve(answer));
      expect(container.textContent).toContain('State: waiting.');
    } else if (state === 'confirmation') expect(confirmButton()).toBeTruthy();
    await act(async () => setState(s => ({ ...s, device: { ...desktop, scopes: [] } })));
    expect(restartButton().matches(':disabled')).toBe(true);
    await act(async () => restart.resolve(answer));
    await act(async () => setState(s => ({ ...s, device: desktop })));
    expect(container.textContent).not.toContain('Restart accepted.');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(restartButton().matches(':disabled')).toBe(false);
    expect(writes).toHaveLength(2);
  });

  it.each(['failed', 'missing-view'] as const)('discards a pending Safety restart when the refreshed read is %s', async failure => {
    await render(createElement(SafetySettingsPage));
    await click('Revoke git status');
    const restart = deferred<unknown>();
    const answer = restartReply;
    restartReply = restart.promise;
    await click('Restart when idle');
    const { response, original } = delaySafetyRead();
    await refresh();
    const payload = structuredClone(sections.safety!);
    payload.views = payload.views!.map(entry => entry.view === 'hermes.managed' ? { view: entry.view, ok: false, code: 'unavailable' } : entry);
    await act(async () => response.resolve(Response.json(failure === 'failed' ? { status: 'refused', code: 'unavailable' } : payload)));
    await act(async () => restart.resolve(answer));
    expect(container.textContent).not.toContain('Restart accepted.');
    expect(restartButton()).toBeUndefined();
    fetchMock.mockImplementation(original);
    await refresh();
    expect(restartButton()).toBeUndefined();
    expect(container.textContent).not.toContain('Restart accepted.');
    expect(writes).toHaveLength(2);
  });

  it('ignores a delayed restart response after leaving and returning to Safety', async () => {
    await render(createElement(SafetySettingsPage));
    await click('Revoke git status');
    const restart = deferred<unknown>();
    const answer = restartReply;
    restartReply = restart.promise;
    await click('Restart when idle');
    await act(async () => root.render(null));
    await render(createElement(SafetySettingsPage));
    await click('Revoke git status');
    await act(async () => restart.resolve(answer));
    expect(container.textContent).not.toContain('Restart accepted.');
    expect(restartButton().matches(':disabled')).toBe(false);
  });

  it('repeats a phone restart with only the server confirmation code added', async () => {
    setState(s => ({ ...s, device: phone }));
    await render(createElement(SafetySettingsPage));
    await click('Revoke git status');
    restartReply = { ...confirm, expiresAt: Date.now() + 60_000 };
    await click('Restart when idle');
    expect(container.querySelector('[role="alertdialog"]')!.textContent).toContain(confirm.confirm);
    restartReply = { status: 'refused', code: 'still_busy' };
    await click('Confirm');
    expect(writes.at(-1)!.body).toEqual({ component: 'hermes', when: 'idle', confirm: confirm.confirm });
    expect(container.textContent).toContain('It never went quiet in time');
  });

  it.each([{ status: 'accepted', run: { ...run, state: 'invented' }, timing: [{ label: 'now' }] }, { status: 'applied', change: {} }])('does not invent a successful state from a malformed restart response', async answer => {
    await render(createElement(SafetySettingsPage));
    await click('Revoke git status');
    restartReply = answer;
    await click('Restart when idle');
    expect(container.textContent).toContain('This PC did not answer.');
    expect(container.textContent).not.toContain('Restart accepted.');
  });
});

describe('Visible usage refresh', () => {
  it('starts its timer only when visible and removes the visibility listener on exit', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await render(createElement(ModelsSettingsPage));
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(usageRequests()).toBe(1);
    await visibility('visible');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(usageRequests()).toBe(2);
    await act(async () => root.render(null));
    await visibility('hidden');
    await visibility('visible');
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(usageRequests()).toBe(2);
  });

  it('polls once a minute, stops while hidden and after leaving, and follows usageVersion', async () => {
    vi.useFakeTimers();
    await render(createElement(ModelsSettingsPage));
    expect(usageRequests()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
    expect(usageRequests()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(usageRequests()).toBe(2);
    await visibility('hidden');
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
    expect(usageRequests()).toBe(2);
    await visibility('visible');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(usageRequests()).toBe(3);
    await act(async () => setState(s => ({ ...s, usageVersion: s.usageVersion + 1 })));
    expect(usageRequests()).toBe(4);
    await act(async () => root.render(null));
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(usageRequests()).toBe(4);
  });
});
