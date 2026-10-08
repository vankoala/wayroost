import { CheckRows } from './SettingsChecks.js';
import { SettingsRestart } from '../components/SettingsRestart.js';
import { OWNER_FILE_TARGETS, ROOT_TARGETS } from '../../../shared/settings.js';
import type { DrainRestartRun } from '../../../shared/supervisor-config.js';
// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseOperation, providerIdSchema, readViewValues } from '../../../shared/settings-ops.js';
import { settingsApplyBodySchema } from '../../../shared/settings.js';
import { pendingWorkerApprovals } from '../../../shared/safety.js';
import type { DeviceInfo } from '../../../shared/protocol.js';
import { api } from '../api.js';
import { agentsPage, modelsPage, safetyPage, recentChanges } from './settings-fixtures.js';
import { changeToastText, describeApplyResponse, settingsErrorText, timingSentence, type SettingsSectionPayload } from '../settingsModel.js';
import { applyEvent, getState, setState } from '../store.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/**
 * Settings → Agents, Models & accounts, Safety, and the Overview's
 * Recent changes: the level chip on every row, what a phone may and may not
 * write, when each change takes effect, the confirm code a phone taps, and
 * undo through the same pipeline the change ran through.
 */

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let nextReply: { status: number; body: unknown } | undefined;
let usagePayload: unknown;
let cloudAgentsPayload: unknown;
let workerPayload: unknown;
let sections: Record<string, unknown>;
let sectionStatus = 200;
let invalidWrites: unknown[] = [];
let sent: { url: string; init?: RequestInit }[] = [];

const desktop: DeviceInfo = { id: 'dv_000000000000000000000001', name: 'work-laptop', kind: 'desktop', scopes: ['chats', 'settings', 'pc-settings', 'power', 'devices'], created: Date.now(), lastSeen: Date.now() };
const phone: DeviceInfo = { id: 'dv_000000000000000000000002', name: 'Example phone', kind: 'phone', scopes: ['chats', 'settings', 'power-confirm'], created: Date.now(), lastSeen: Date.now() };

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  sections = { agents: sectionFor('desktop').agents, safety: { section: 'safety', views: [{ ok: true, view: 'hermes.managed', present: false }], operations: [] } };
  sectionStatus = 200;
  nextReply = undefined;
  usagePayload = { ok: true, generatedAt: 0, windows: [] };
  cloudAgentsPayload = undefined;
  workerPayload = undefined;
  sent = [];
  invalidWrites = [];
  installFetch();
  setState((s) => ({ ...s, rollout: { settingsPages: true, revokes: true, chatFirst: true }, device: desktop, toasts: [], unpaired: false, sessionExpired: false }));
});

function installFetch() {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/settings/apply') || url.includes('/api/settings/undo')) {
      sent.push({ url, init });
      if (url.includes('/apply')) {
        const body = settingsApplyBodySchema.parse(JSON.parse(String(init?.body)));
        if (!parseOperation(body.operation, body.params, 'server').ok) {
          invalidWrites.push(body);
          return Response.json({ status: 'refused', code: 'invalid_parameters' }, { status: 400 });
        }
      }
      const reply = nextReply ?? { status: 200, body: { status: 'applied', change: appliedChange } };
      return Response.json(reply.body, { status: reply.status });
    }
    if (url.includes('/api/settings/usage')) {
      return Response.json(usagePayload ?? { status: 'refused', code: 'not_configured' }, { status: usagePayload === undefined ? 503 : 200 });
    }
    if (url.includes('/api/settings/credential')) {
      sent.push({ url, init });
      return Response.json({ status: 'applied', change: { ...appliedChange, keys: ['gateway-credentials:<key>'] } });
    }
    if (url.includes('/api/cloud-agents')) {
      return Response.json(cloudAgentsPayload ?? { agents: [
        { id: 'claude', label: 'Claude Code', enabled: true, state: 'ready' },
        { id: 'codex', label: 'Codex', enabled: false, state: 'unavailable' },
        { id: 'copilot', label: 'Copilot', enabled: true, state: 'loading' },
      ] });
    }
    if (url.includes('/api/paseo/options')) {
      return Response.json({ providers: [{ id: 'claude', label: 'Claude Code', modes: [] }, { id: 'codex', label: 'Codex', modes: [] }, { id: 'hermes', label: 'Hermes', modes: [] }] });
    }
    if (url.includes('/api/safety-commands')) {
      return Response.json({ enabled: (sections.safety as SettingsSectionPayload)?.views?.find(view => view.view === 'wayroost.settings')?.values?.find(entry => entry.path.join('.') === 'safetyCommandsEnabled')?.value === true, commands: ['status', 'pause', 'resume', 'logs', 'restart', 'stop'] });
    }
    if (url.includes('/api/worker-approvals')) {
      return Response.json(workerPayload ?? { enabled: true, application: 'partial', choiceConfirmed: true, config: 'written', reload: 'applied', uncoveredProviders: [], limitations: [] });
    }
    if (url.includes('/api/settings/sections/')) {
      const section = url.split('/api/settings/sections/')[1]?.split('?')[0] ?? '';
      const payload = sections[section];
      if (payload === undefined) return Response.json({ status: 'refused', code: 'unknown_operation' }, { status: 404 });
      return Response.json(payload, { status: sectionStatus });
    }
    return Response.json({ status: 'refused', code: 'not_configured' }, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

const appliedChange = {
  id: '00000000-0000-4000-8000-000000000001',
  operation: 'hermes.reasoning-effort',
  target: 'hermes-config',
  keys: ['hermes.config:agent.reasoning_effort'],
  timing: [{ label: 'next-turn' as const, surface: 'messaging' as const }],
  effective: 'verified',
  undoable: true,
};

const confirmAnswer = { status: 'confirm', confirm: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA', summary: 'Reasoning effort: high', expiresAt: Date.now() + 120_000 };

function value(path: (string | number)[], v: unknown) {
  return { path, exists: true, value: v };
}

/** The section payload as the server sends it to a desktop on this PC. */
function sectionFor(kind: 'desktop' | 'phone') {
  const access = (levelOfValue: 'anywhere' | 'confirm' | 'pc-only'): 'editable' | 'confirm' | 'read-only' =>
    kind === 'desktop' ? 'editable' : levelOfValue === 'anywhere' ? 'editable' : levelOfValue === 'confirm' ? 'confirm' : 'read-only';
  return {
    access,
    agents: {
      section: 'agents',
      rollout: { settingsPages: true, revokes: true, chatFirst: true },
      agentAvailability: [{ id: 'copilot', installed: false, authenticated: null }],
      views: [
        { ok: true, view: 'hermes.agents', present: true, sha256: 'a'.repeat(64), values: [
          value(['agent', 'reasoning_effort'], 'medium'),
          value(['display', 'personality'], 'helpful'),
        ] },
        { ok: true, view: 'hermes.models', present: true, sha256: 'b'.repeat(64), values: [
          value(['delegation', 'max_concurrent_children'], 2),
          value(['delegation', 'max_iterations'], 30),
          value(['model', 'provider'], 'anthropic'),
          value(['model', 'default'], 'example-main-model'),
        ] },
        { ok: true, view: 'paseo.agents', present: true, sha256: 'c'.repeat(64), values: [
          value(['agents', 'providers', 'claude', 'enabled'], true),
          value(['agents', 'providers', 'codex', 'enabled'], false),
          value(['agents', 'providers', 'opencode', 'enabled'], false),
          value(['agents', 'providers', 'copilot', 'enabled'], false),
          value(['agents', 'providers', 'hermes', 'enabled'], true),
          value(['daemon', 'agentProfiles', 0, 'id'], 'paseo-coder'),
          value(['daemon', 'agentProfiles', 0, 'model'], 'pi/example-coder-model'),
          value(['daemon', 'appendSystemPrompt'], 'Route coding to the coder profile.'),
        ] },
      ],
      operations: [
        { operation: 'hermes.reasoning-effort', title: 'Reasoning effort', level: 'anywhere', access: access('anywhere') },
        { operation: 'hermes.personality', title: 'Personality', level: 'anywhere', access: access('anywhere') },
        { operation: 'hermes.delegation-limits', title: 'Delegation limits', level: 'confirm', access: access('confirm') },
        { operation: 'paseo.provider-enabled', title: 'Paseo agent on or off', level: 'confirm', access: access('confirm') },
        { operation: 'paseo.profile-model', title: 'Profile model', level: 'confirm', access: access('confirm') },
        { operation: 'paseo.routing-note', title: 'Routing note', level: 'pc-only', access: access('pc-only') },
      ],
    },
    models: {
      section: 'models',
      rollout: { settingsPages: true, revokes: true, chatFirst: true },
      agentAvailability: [{ id: 'claude', installed: true, authenticated: true }, { id: 'codex', installed: true, authenticated: false }, { id: 'copilot', installed: false, authenticated: null }],
      modelStatus: [{ role: 'main', health: 'up', inFlight: 2 }],
      views: [
        { ok: true, view: 'gateway.role-map', present: true, sha256: 'd'.repeat(64), values: [
          value(['roles', 'main'], 'anthropic-main'),
          value(['roles', 'coder'], 'pi-coder'),
          value(['backends', 'anthropic-main', 'provider'], 'anthropic'),
          value(['backends', 'anthropic-main', 'servedName'], 'example-main-model'),
          value(['backends', 'anthropic-main', 'contextLength'], 1000000),
          value(['backends', 'anthropic-main', 'maxOutputTokens'], 32000),
          value(['backends', 'pi-coder', 'provider'], 'openrouter'),
          value(['contracts', 'main', 'input'], ['text', 'image']),
          value(['contracts', 'main', 'toolCalling'], true),
          value(['contracts', 'main', 'thinkingLevels'], true),
          value(['contracts', 'main', 'maxOutputTokens'], 32000),
          value(['contracts', 'main', 'advertisedContext'], 1000000),
        ] },
        { ok: true, view: 'gateway.state', present: true, sha256: 'e'.repeat(64), values: [
          value(['state', 'overrides', 'coder', 'backend'], 'pi-coder'),
        ] },
        { ok: true, view: 'hermes.models', present: true, sha256: 'b'.repeat(64), values: [
          value(['model', 'provider'], 'anthropic'),
          value(['model', 'default'], 'example-main-model'),
          value(['model', 'base_url'], 'http://127.0.0.1:8893/v1'),
          value(['auxiliary', 'compression', 'provider'], 'anthropic'),
          value(['auxiliary', 'compression', 'model'], 'demo-helper'),
          value(['delegation', 'provider'], 'anthropic'),
          value(['delegation', 'model'], 'example-delegate-model'),
          value(['delegation', 'fallback_providers'], [{ provider: 'opencode-zen', model: 'example-research-model' }]),
        ] },
        { ok: false, view: 'codex.approvals', code: 'target_missing' },
      ],
      operations: [
        { operation: 'gateway.point', title: "A role's backend", level: 'confirm', access: access('confirm') },
        { operation: 'hermes.default-model', title: 'Default model', level: 'confirm', access: access('confirm') },
        { operation: 'hermes.delegation-model', title: 'Delegation model', level: 'confirm', access: access('confirm') },
        { operation: 'hermes.main-fallbacks', title: 'Main model fallbacks', level: 'confirm', access: access('confirm') },
        { operation: 'hermes.delegation-fallbacks', title: 'Delegation fallbacks', level: 'confirm', access: access('confirm') },
        { operation: 'hermes.helper-model', title: 'Helper model', level: 'confirm', access: access('confirm') },
        { operation: 'gateway.credential', title: 'API key', level: 'pc-only', access: access('pc-only') },
      ],
    },
    safety: {
      section: 'safety',
      rollout: { settingsPages: true, revokes: true, chatFirst: true },
      restartWhenIdleCertified: true,
      views: [
        { ok: true, view: 'hermes.safety', present: true, sha256: 'f'.repeat(64), values: [
          value(['approvals', 'mode'], 'smart'),
          value(['approvals', 'cron_mode'], 'deny'),
          value(['command_allowlist'], ['git status', 'sed -n 1,40p README.md']),
          value(['skills', 'write_approval'], false),
          value(['memory', 'write_approval'], true),
        ] },
        { ok: true, view: 'wayroost.settings', present: true, sha256: '2'.repeat(64), values: [value(['safetyCommandsEnabled'], false)] },
        { ok: true, view: 'codex.approvals', present: true, sha256: '0'.repeat(64), values: [
          value(['approval_policy'], 'on-request'),
          value(['sandbox_mode'], 'workspace-write'),
        ] },
        { ok: true, view: 'claude.permissions', present: false },
        { ok: true, view: 'opencode.permissions', present: false },
        { ok: true, view: 'hermes.managed', present: true, sha256: '1'.repeat(64), values: [
          value(['agent', 'reasoning_effort'], 'high'),
        ] },
      ],
      operations: [
        { operation: 'hermes.approval-mode', title: 'Approval mode', level: { byParam: 'mode', values: { manual: 'anywhere', smart: 'pc-only', off: 'pc-only' } }, access: access('anywhere'),
          accessByValue: { manual: access('anywhere'), smart: access('pc-only'), off: access('pc-only') } },
        { operation: 'hermes.revoke-always', title: 'Revoke an “always” entry', level: 'anywhere', access: access('anywhere') },
        { operation: 'hermes.skill-staging', title: 'Skill changes wait for your OK', level: { byParam: 'enabled', values: { true: 'anywhere', false: 'pc-only' } }, access: access('anywhere'),
          accessByValue: { true: access('anywhere'), false: access('pc-only') } },
        { operation: 'paseo.worker-approvals', title: "Workers' approvals come to me", level: { byParam: 'enabled', values: { true: 'anywhere', false: 'pc-only' } }, access: access('anywhere'),
          accessByValue: { true: access('anywhere'), false: access('pc-only') } },
        { operation: 'wayroost.safety-commands', title: 'Hermes safety commands', level: { byParam: 'enabled', values: { true: 'pc-only', false: 'anywhere' } }, access: access('anywhere'),
          accessByValue: { true: access('pc-only'), false: access('anywhere') } },
      ],
    },
  };
}

async function digest(value: string) { return (await import('../settingsModel.js')).entrySha256(value); }

async function projectedPhone(section: 'agents' | 'models' | 'safety'): Promise<SettingsSectionPayload> {
  const payload = sectionFor('phone')[section] as SettingsSectionPayload;
  for (const view of payload.views ?? []) {
    if (!view.ok || !view.present) continue;
    const document: Record<string, unknown> = {};
    for (const entry of view.values ?? []) {
      if (!entry.exists) continue;
      let parent: Record<string | number, unknown> = document;
      entry.path.forEach((segment, index) => {
        if (typeof segment === 'object') throw new Error('Unexpected fixture path');
        if (index === entry.path.length - 1) parent[segment] = entry.value;
        else parent = (parent[segment] ??= typeof entry.path[index + 1] === 'number' ? [] : {}) as Record<string | number, unknown>;
      });
    }
    view.values = (await readViewValues(view.view as Parameters<typeof readViewValues>[0], document, { scopes: phone.scopes, listener: 'main', pcOnlyWrites: true })).map(entry => ({ ...entry, path: [...entry.path] }));
  }
  if (section === 'agents') payload.profiles = [{ id: await digest('paseo-coder'), label: 'Profile 1' }];
  if (section === 'models') payload.backendChoices = [{ id: (await digest('anthropic-main')).slice(0, 63), label: 'Backend 1', currentRoles: ['main'] }, { id: (await digest('pi-coder')).slice(0, 63), label: 'Backend 2', currentRoles: ['coder'] }];
  if (section === 'safety') payload.allowlistEntries = [{ entrySha256: await digest('git status') }, { entrySha256: await digest('sed -n 1,40p README.md') }];
  return payload;
}

let root: Root | undefined;
let container: HTMLDivElement;

async function render(node: ReturnType<typeof agentsPage>) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(node); });
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(invalidWrites).toEqual([]);
});

const text = () => container.textContent ?? '';

function at(ariaLabel: string): HTMLElement {
  const node = [...container.querySelectorAll<HTMLElement>('[aria-label]')].find(node => node.getAttribute('aria-label') === ariaLabel) ?? null;
  expect(node, `control “${ariaLabel}”`).toBeTruthy();
  return node!;
}

function maybeAt(ariaLabel: string): HTMLElement | null {
  return container.querySelector(`[aria-label="${ariaLabel}"]`);
}

async function choose(ariaLabel: string, next: string) {
  const select = at(ariaLabel) as HTMLSelectElement;
  await act(async () => {
    select.value = next;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function type(ariaLabel: string, next: string) {
  const input = at(ariaLabel) as HTMLInputElement;
  const prototype = input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(ariaLabel: string) {
  await act(async () => { at(ariaLabel).click(); });
  if (ariaLabel.startsWith('Revoke ')) {
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(maybeAt(ariaLabel)?.matches(':disabled') ?? false).toBe(false);
    });
  }
}

async function clickText(prefix: string) {
  const button = [...container.querySelectorAll('button')]
    .find((node) => (node.textContent ?? '').trim().startsWith(prefix)) as HTMLButtonElement | undefined;
  expect(button, `button “${prefix}”`).toBeTruthy();
  await act(async () => { button!.click(); });
}

const writes = () => sent.filter((call) => call.url.includes('/api/settings/apply') || call.url.includes('/api/settings/undo'));
const writeBodyOf = (call: { init?: RequestInit }) => JSON.parse(String(call.init?.body)) as Record<string, unknown>;
const writeBody = (index: number) => writeBodyOf(writes()[index]!);
const levelChips = () => [...container.querySelectorAll<HTMLElement>('.level-chip')].map((chip) => chip.dataset.level);

function deferSettingsWrites() {
  const original = fetchMock.getMockImplementation()!;
  const requests: { resolve: (response: Response) => void; reject: (error: Error) => void }[] = [];
  fetchMock.mockImplementation((input, init) => {
    if (!String(input).includes('/api/settings/apply') && !String(input).includes('/api/settings/undo')) return original(input, init);
    sent.push({ url: String(input), init });
    return new Promise((resolve, reject) => { requests.push({ resolve, reject }); });
  });
  return requests;
}


describe('Settings → Agents', () => {
  beforeEach(() => { sections.agents = sectionFor('desktop').agents; });

  it('shows each row’s real level and the installed Paseo agents', async () => {
    await render(agentsPage());
    expect(text()).toContain('Reasoning effort');
    expect(levelChips()).toEqual(expect.arrayContaining(['anywhere', 'confirm', 'pc-only']));
    // Reasoning effort is anywhere: no chip calls it PC only.
    expect(text()).toContain('Medium');
    // An explicit installation report is required to say an agent is absent.
    expect(text()).toContain('Not installed');
    expect(text()).toContain('Official source');
    // The routing note is on the page for the desktop.
    expect(maybeAt('Routing note')).toBeTruthy();
  });

  it('a phone reads the PC-only rows and may still change the anywhere ones', async () => {
    setState((s) => ({ ...s, device: phone }));
    sections.agents = await projectedPhone('agents');
    await render(agentsPage());
    expect(maybeAt('Routing note')).toBeNull();
    expect(text()).toContain('The exact value is shown on the PC.');
    // confirm-level rows stay editable from a phone; only PC-only rows go read-only.
    expect(maybeAt('Delegated chats at once')).toBeTruthy();
    expect(maybeAt('Reasoning effort')).toBeTruthy();
  });

  it('applies an anywhere change and the toast repeats when it takes effect', async () => {
    await render(agentsPage());
    await choose('Reasoning effort', 'high');
    expect(writes().length).toBe(1);
    expect(writes()[0]!.url).toContain('/api/settings/apply');
    expect(writeBody(0)).toMatchObject({ operation: 'hermes.reasoning-effort', params: { effort: 'high' } });
    expect(getState().toasts.map((entry) => entry.text).join(' ')).toContain('Applied.');
    expect(getState().toasts.map((entry) => entry.text).join(' ')).toContain('next message');
  });

  it('a phone’s confirm-level change comes back with a code and is sent again with it', async () => {
    setState((s) => ({ ...s, device: phone }));
    sections.agents = await projectedPhone('agents');
    nextReply = { status: 200, body: confirmAnswer };
    await render(agentsPage());
    await choose('Reasoning effort', 'high'); // level anywhere: applied, not confirm
    nextReply = { status: 200, body: confirmAnswer };
    // A confirm-level change from the phone: the profile model.
    await type(`Model for profile ${await digest('paseo-coder')}`, 'pi/example-model');
    await press(`Save profile ${await digest('paseo-coder')}`);
    const profileWrite = writes().find((call) => JSON.parse(String(call.init?.body)).operation === 'paseo.profile-model');
    expect(profileWrite).toBeTruthy();
    expect(text()).toContain('AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA'); // the code, shown in the card
    expect(text()).toContain('Reasoning effort: high'); // what it will do, from the server
    await clickText('Confirm');
    const resend = JSON.parse(String(writes()[writes().length - 1]!.init?.body)) as Record<string, unknown>;
    expect(resend).toMatchObject({ operation: 'paseo.profile-model', confirm: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA' });
  });

  it('the delegation save carries both numbers', async () => {
    await render(agentsPage());
    await type('Delegated chats at once', '3');
    const firstSave = [...container.querySelectorAll('button')].filter((node) => (node.textContent ?? '').trim() === 'Save')[0] as HTMLButtonElement | undefined;
    expect(firstSave).toBeTruthy();
    await act(async () => { firstSave!.click(); });
    expect(writes().length).toBe(1);
    expect(writeBody(0)).toMatchObject({
      operation: 'hermes.delegation-limits',
      params: { maxConcurrentChildren: 3, maxIterations: 30 },
    });
  });

  it('refuses a PC-only write that came anyway and words the refusal', async () => {
    nextReply = { status: 403, body: { status: 'refused', code: 'pc_only' } };
    await render(agentsPage());
    await choose('Reasoning effort', 'high');
    expect(getState().toasts.map((entry) => entry.text).join(' ')).toContain('only be changed on the PC');
  });

  it('marks unavailable role-load measurements explicitly', async () => {
    await render(agentsPage());
    expect(text()).toContain('What each role loads');
    expect(text()).not.toContain('in flight');
    expect(text()).toContain('Role-load measurements unavailable');
  });
});

describe('Settings → Models & accounts', () => {
  beforeEach(() => {
    sections.models = sectionFor('desktop').models;
    usagePayload = {
      ok: true,
      generatedAt: Date.now(),
      windows: [
        { id: 'today', since: 0, rows: [
          { role: 'main', backend: 'anthropic-main', backendModel: 'example-main-model', requests: 40, errors: 1, inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 10, outputTokens: 20, estimatedCostUsd: 1.5 },
        ] },
        { id: 'week', since: 0, rows: [
          { role: 'main', backend: 'anthropic-main', backendModel: 'example-main-model', requests: 100, errors: 2, inputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, estimatedCostUsd: 3.25 },
        ] },
      ],
    };
  });

  it('names what serves each role, its window, contract and live status', async () => {
    await render(modelsPage());
    expect(text()).toContain('anthropic-main');
    expect(text()).toContain('example-main-model');
    expect(text()).toContain('window 1.0m');
    expect(text()).toContain('Contract:');
    expect(text()).toContain('Health: up · 2 in flight');
    expect(text()).toContain('Health unavailable');
  });

  it('labels the role rows confirm and says a manual point lasts until the next switch', async () => {
    await render(modelsPage());
    expect(levelChips()).toEqual(expect.arrayContaining(['confirm']));
    expect(text()).toContain('A manual change is in place: it lasts until the next model switch.');
  });

  it('points a role: gateway.point with role and backend', async () => {
    await render(modelsPage());
    await choose('Backend for the coder role', 'anthropic-main');
    await clickText('Point coder');
    expect(writes().length).toBe(1);
    expect(writeBody(0)).toMatchObject({ operation: 'gateway.point', params: { role: 'coder', backend: 'anthropic-main' } });
  });

  describe.each(['desktop', 'phone'] as const)('backend drafts on %s', kind => {
    it.each(['one', 'all'] as const)('disables an unavailable selection after removing %s backend choices', async removed => {
      if (kind === 'phone') {
        setState(state => ({ ...state, device: phone }));
        sections.models = await projectedPhone('models');
      }
      await render(modelsPage());
      const label = 'Backend for the coder role';
      const initial = at(label) as HTMLSelectElement;
      const pick = initial.options[0]!.value;
      const surviving = initial.options[1]!.value;
      await choose(label, pick);
      const payload = structuredClone(sections.models) as SettingsSectionPayload;
      if (payload.backendChoices) {
        payload.backendChoices = removed === 'all' ? [] : payload.backendChoices.filter(entry => entry.id !== pick);
      } else {
        const view = payload.views!.find(entry => entry.view === 'gateway.role-map')!;
        view.values = view.values!.filter(entry => entry.path[0] !== 'backends' || removed !== 'all' && entry.path[1] !== pick);
      }
      const original = sections.models;
      sections.models = payload;
      await act(async () => { applyEvent({ type: 'settings_changed', sections: ['models'], change: appliedChange.id }); });
      const select = at(label) as HTMLSelectElement;
      expect(select.value).toBe(pick);
      expect(select.selectedOptions[0]!.textContent).toContain('Selected backend unavailable');
      const point = select.closest('.setting-inline')!.querySelector<HTMLButtonElement>('button')!;
      expect(point.disabled).toBe(true);
      await clickText('Point coder');
      expect(writes()).toHaveLength(0);
      if (removed === 'all') {
        sections.models = original;
        await act(async () => { applyEvent({ type: 'settings_changed', sections: ['models'], change: appliedChange.id }); });
        expect((at(label) as HTMLSelectElement).value).toBe(pick);
        await clickText('Point coder');
        expect(writeBody(0)).toMatchObject({ params: { role: 'coder', backend: pick } });
      } else {
        await choose(label, surviving);
        expect(point.disabled).toBe(true);
        expect(writes()).toHaveLength(0);
      }
    });
  });

  it('writes a Hermes model change as provider and model, not one joined string', async () => {
    await render(modelsPage());
    await type('Default model provider', 'openrouter');
    await type('Default model model', 'example-vendor/example-research-model');
    await clickText('Save');
    const body = writes().map(writeBodyOf).find((entry) => entry.operation === 'hermes.default-model');
    expect(body).toMatchObject({ params: { provider: 'openrouter', model: 'example-vendor/example-research-model' } });
  });

  it('saves a fallback chain as the whole array', async () => {
    await render(modelsPage());
    await type('Delegation fallbacks provider 1', 'anthropic');
    await type('Delegation fallbacks model 1', 'example-tiny-model');
    await clickText('Save chain for Delegation fallbacks');
    const body = writes().map(writeBodyOf).find((entry) => entry.operation === 'hermes.delegation-fallbacks');
    expect(body).toMatchObject({ params: { chain: [{ provider: 'anthropic', model: 'example-tiny-model' }] } });
  });

  it('never echoes a stored key: the field is a password and starts empty', async () => {
    await render(modelsPage());
    const field = at('Key for anthropic') as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.value).toBe('');
    expect(JSON.stringify(sectionFor('desktop').models)).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it('a key is sent by the credential route with the secret in the body, never the query', async () => {
    await render(modelsPage());
    await type('Key for anthropic', 'a-key-not-to-be-shown');
    await press('Save key for anthropic');
    const call = sent.find((entry) => entry.url.includes('/api/settings/credential'));
    expect(call).toBeTruthy();
    expect(call!.url).not.toContain('?');
    expect(call!.init?.method).toBe('PUT'); // the secret rides in the body; DELETE removes; POST tests
    expect(call!.url).toContain('/api/settings/credentials/anthropic');
    expect(JSON.parse(String(call!.init?.body))).toEqual({ secret: 'a-key-not-to-be-shown' }); // the provider is in the path, the key in the body
  });

  it('a phone cannot manage keys: gateway.credential is pc-only', async () => {
    setState((s) => ({ ...s, device: phone }));
    sections.models = await projectedPhone('models');
    await render(modelsPage());
    expect(maybeAt('Key for anthropic')).toBeNull();
    expect(text()).toContain('shown on the PC');
  });

  it('shows subscriptions as signed in, signed out or not installed', async () => {
    await render(modelsPage());
    expect(text()).toContain('Claude Code');
    expect(text()).toContain('Signed in');
    expect(text()).toContain('Signed out'); // codex: unavailable
    expect(text()).toContain('Not installed'); // copilot is not in the options list
  });

  it('shows usage per role for today and the week, and costs are estimates', async () => {
    await render(modelsPage());
    expect(text()).toContain('40 req · 180 tok · $1.50');
    expect(text()).toContain('100 req · 300 tok · $3.25');
    expect(text()).toContain('0 req · 0 tok · $0');
    expect(text()).toContain('Estimated cost');
  });

  it('says the PC does not report usage when the summary is refused', async () => {
    usagePayload = undefined;
    await render(modelsPage());
    expect(text()).toContain('Usage is not reported by this PC yet');
  });
});

describe('settings request order', () => {
  beforeEach(() => { sections.models = sectionFor('desktop').models; });

  const olderOutcomes = ['confirm', 'applied', 'refused', 'refused-with-change', 'error'] as const;
  type OlderOutcome = (typeof olderOutcomes)[number];

  async function finish(request: ReturnType<typeof deferSettingsWrites>[number], outcome: OlderOutcome, summary = 'Older role change') {
    await act(async () => {
      if (outcome === 'error') request.reject(new Error('Older request failed.'));
      else request.resolve(Response.json(outcome === 'confirm' ? { ...confirmAnswer, summary }
        : outcome === 'applied' ? { status: 'applied', change: appliedChange }
        : { status: 'refused', code: 'precondition_changed', ...(outcome === 'refused-with-change' ? { change: appliedChange } : {}) }));
    });
  }

  async function prepare(kind: 'desktop' | 'phone') {
    if (kind === 'phone') {
      setState(state => ({ ...state, device: phone }));
      sections.models = await projectedPhone('models');
    }
    await render(modelsPage());
    const main = at('Backend for the main role') as HTMLSelectElement;
    const coder = at('Backend for the coder role') as HTMLSelectElement;
    await choose(main.getAttribute('aria-label')!, main.options[1]!.value);
    await choose(coder.getAttribute('aria-label')!, coder.options[0]!.value);
    return deferSettingsWrites();
  }

  describe.each(['desktop', 'phone'] as const)('confirmation during refresh on %s', kind => {
    it.each(['applied', 'refused-with-change'] as const)('retains a delayed confirmation disabled while an older %s response refreshes settings', async outcome => {
      const requests = await prepare(kind);
      await clickText('Point main');
      await clickText('Point coder');
      const original = fetchMock.getMockImplementation()!;
      let refresh!: (response: Response) => void;
      fetchMock.mockImplementation((input, init) => String(input).includes('/api/settings/sections/models')
        ? new Promise(resolve => { refresh = resolve; }) : original(input, init));
      await finish(requests[0]!, outcome);
      await finish(requests[1]!, 'confirm', 'Newer coder change');
      expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('Newer coder change');
      const confirm = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Confirm')!;
      expect(confirm.disabled).toBe(true);
      await clickText('Confirm');
      expect(requests).toHaveLength(2);
      await act(async () => { refresh(Response.json(sections.models)); });
      fetchMock.mockImplementation(original);
      expect(confirm.disabled).toBe(false);
      await clickText('Confirm');
      expect(writeBody(2)).toEqual({ ...writeBody(1), confirm: confirmAnswer.confirm });
      await finish(requests[2]!, 'applied');
    });

    it.each(['failed', 'restricted'] as const)('cancels a delayed confirmation when the refresh is %s', async result => {
      const requests = await prepare(kind);
      await clickText('Point main');
      await clickText('Point coder');
      const original = fetchMock.getMockImplementation()!;
      let refresh!: (response: Response) => void;
      fetchMock.mockImplementation((input, init) => String(input).includes('/api/settings/sections/models')
        ? new Promise(resolve => { refresh = resolve; }) : original(input, init));
      await finish(requests[0]!, 'applied');
      await finish(requests[1]!, 'confirm', 'Newer coder change');
      expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('Newer coder change');
      const payload = structuredClone(sections.models) as SettingsSectionPayload;
      payload.operations!.find(entry => entry.operation === 'gateway.point')!.access = 'read-only';
      await act(async () => { refresh(Response.json(result === 'failed' ? { status: 'refused', code: 'unavailable' } : payload)); });
      expect(container.querySelector('[role="alertdialog"]')).toBeNull();
      fetchMock.mockImplementation(original);
      await act(async () => { applyEvent({ type: 'settings_changed', sections: ['models'], change: appliedChange.id }); });
      expect(container.querySelector('[role="alertdialog"]')).toBeNull();
      expect(requests).toHaveLength(2);
    });

  });

  it.each(['desktop', 'phone'] as const)('keeps the newer %s role confirmation when overlapping requests answer in reverse order', async kind => {
    const requests = await prepare(kind);
    await clickText('Point main');
    await clickText('Point coder');
    expect(requests).toHaveLength(2);
    await finish(requests[1]!, 'confirm', 'Newer coder change');
    await finish(requests[0]!, 'confirm');
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('Newer coder change');
    expect(text()).not.toContain('Older role change');
    await clickText('Confirm');
    expect(writeBody(2)).toEqual({ ...writeBody(1), confirm: confirmAnswer.confirm });
    await finish(requests[2]!, 'applied');
  });

  it.each(olderOutcomes)('keeps a newer confirmation after an older row returns %s', async outcome => {
    const requests = await prepare('desktop');
    await clickText('Point main');
    await clickText('Point coder');
    await finish(requests[1]!, 'confirm', 'Newer coder change');
    await finish(requests[0]!, outcome);
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('Newer coder change');
    await clickText('Confirm');
    expect(writeBody(2)).toEqual({ ...writeBody(1), confirm: confirmAnswer.confirm });
    await finish(requests[2]!, 'applied');
  });

  it('ignores an older confirmation and keeps the newer row busy before its answer arrives', async () => {
    const requests = await prepare('desktop');
    await clickText('Point main');
    await clickText('Point coder');
    await finish(requests[0]!, 'confirm');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect((at('Backend for the coder role') as HTMLSelectElement).disabled).toBe(true);
    await clickText('Point coder');
    expect(requests).toHaveLength(2);
    await finish(requests[1]!, 'confirm', 'Newer coder change');
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('Newer coder change');
  });

  it.each(olderOutcomes)('ignores a superseded response of %s for the same row without changing current state', async outcome => {
    const requests = await prepare('desktop');
    await clickText('Point main');
    await clickText('Point coder');
    await clickText('Point main');
    expect(requests).toHaveLength(3);
    const version = getState().settingsVersion;
    const toasts = getState().toasts;
    await finish(requests[0]!, outcome);
    expect(getState().settingsVersion).toBe(version);
    expect(getState().toasts).toEqual(toasts);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect((at('Backend for the main role') as HTMLSelectElement).disabled).toBe(true);
    await finish(requests[2]!, 'confirm', 'Newest main change');
    await finish(requests[1]!, 'confirm');
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('Newest main change');
    await clickText('Confirm');
    expect(writeBody(3)).toEqual({ ...writeBody(2), confirm: confirmAnswer.confirm });
    await finish(requests[3]!, 'applied');
  });

  it.each(olderOutcomes)('keeps a newer confirmation when an earlier confirmation resend returns %s', async outcome => {
    const requests = await prepare('desktop');
    await clickText('Point main');
    await finish(requests[0]!, 'confirm', 'First main change');
    await clickText('Confirm');
    await clickText('Point coder');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    await finish(requests[2]!, 'confirm', 'Newer coder change');
    await finish(requests[1]!, outcome);
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('Newer coder change');
    await clickText('Confirm');
    expect(writeBody(3)).toEqual({ ...writeBody(2), confirm: confirmAnswer.confirm });
    await finish(requests[3]!, 'applied');
  });

  it('orders confirmations across separate sections of the same page', async () => {
    const requests = await prepare('desktop');
    await clickText('Point main');
    await type('Default model model', 'example-new-model');
    await act(async () => { at('Default model model').closest('.kv')!.querySelector<HTMLButtonElement>('button')!.click(); });
    await finish(requests[1]!, 'confirm', 'Newer default model change');
    await finish(requests[0]!, 'confirm');
    expect(container.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('Newer default model change');
    await clickText('Confirm');
    expect(writeBody(2)).toEqual({ ...writeBody(1), confirm: confirmAnswer.confirm });
    await finish(requests[2]!, 'applied');
  });

  it('does not revive an older confirmation after the newer prompt is cancelled', async () => {
    const requests = await prepare('desktop');
    await clickText('Point main');
    await clickText('Point coder');
    await finish(requests[1]!, 'confirm', 'Newer coder change');
    await clickText('Cancel');
    await finish(requests[0]!, 'confirm');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(writes()).toHaveLength(2);
  });
});

describe('Settings → Safety', () => {
  beforeEach(() => {
    sections.safety = sectionFor('desktop').safety;
    sections.agents = sectionFor('desktop').agents;
  });

  it('offers the three modes and explains each one', async () => {
    await render(safetyPage());
    expect(text()).toContain('Approval mode');
    expect(text()).toContain('Always ask');
    expect(text()).toContain('guardian');
    expect(text()).toContain('Never ask');
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[name="approval-mode"]')];
    expect(radios.map((radio) => radio.value)).toEqual(['manual', 'smart', 'off']);
    expect(radios.find((radio) => radio.value === 'smart')!.checked).toBe(true);
  });

  it('from a phone only “manual” is selectable', async () => {
    setState((s) => ({ ...s, device: phone }));
    sections.safety = await projectedPhone('safety');
    await render(safetyPage());
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[name="approval-mode"]')];
    expect(radios.find((radio) => radio.value === 'manual')!.disabled).toBe(false);
    expect(radios.find((radio) => radio.value === 'smart')!.disabled).toBe(true);
    expect(radios.find((radio) => radio.value === 'off')!.disabled).toBe(true);
    await act(async () => { radios.find((radio) => radio.value === 'manual')!.click(); });
    expect(writes().length).toBe(1);
    expect(writeBody(0)).toMatchObject({ operation: 'hermes.approval-mode', params: { mode: 'manual' } });
  });

  it('lists the always-allowed entries and revokes by hash only', async () => {
    await render(safetyPage());
    expect(text()).toContain('git status');
    expect(text()).toContain('sed -n 1,40p README.md');
    await press('Revoke git status');
    expect(writes().length).toBe(1);
    expect(writeBody(0)).toMatchObject({ operation: 'hermes.revoke-always' });
    expect((writeBody(0).params as Record<string, string>).entrySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(writeBody(0))).not.toContain('git status');
  });

  it('the revoke words every surface’s timing, including the session approval caveat', async () => {
    await render(safetyPage());
    expect(text()).toContain('the next chat');
    expect(text()).toContain("a required restart of Hermes' gateway");
    expect(text()).toContain('keeps it until that chat ends');
  });

  it('staging on is anywhere: the phone gets the switch; off is PC-only', async () => {
    await render(safetyPage());
    await press('Skill changes wait for your OK');
    expect(writes().length).toBe(1);
    expect(writeBody(0)).toMatchObject({ operation: 'hermes.skill-staging', params: { enabled: true } });
    setState((s) => ({ ...s, device: phone }));
    sections.safety = await projectedPhone('safety');
    await act(async () => { root!.render(safetyPage()); });
    expect(maybeAt('Skill changes wait for your OK')).toBeTruthy(); // still editable: on is anywhere
  });

  it('cron mode and memory writes are shown, not managed', async () => {
    await render(safetyPage());
    expect(text()).toContain('Scheduled jobs answer with: deny');
    expect(text()).toContain('Memory writes: wait for your OK');
  });

  it('the workers’ switch is on, off is PC-only from a phone', async () => {
    setState((s) => ({ ...s, device: phone }));
    sections.safety = await projectedPhone('safety');
    await render(safetyPage());
    expect(maybeAt('Workers’ approvals come to me')).toBeNull();
    expect(text()).toContain('On');
  });

  it('the safety-commands switch shows PC only: the offered move (off → on) is PC-only', async () => {
    setState((s) => ({ ...s, device: phone }));
    sections.safety = await projectedPhone('safety');
    await render(safetyPage());
    // From a phone with commands off, the offered write is pc-only: read-only display.
    expect(maybeAt('Hermes safety commands')).toBeNull();
    expect(text()).toContain('slash commands are blocked in chats');
  });

  it('shows the read-only side: Codex’s policy, absent Claude rules, pinned keys', async () => {
    await render(safetyPage());
    expect(text()).toContain('on-request');
    expect(text()).toContain('sandbox: workspace-write');
    expect(text()).toContain('1 key name the install pins');
    expect(text()).toContain('read-only');
  });
});

describe('Overview → Recent changes', () => {
  const changesPayload = {
    section: 'overview',
    rollout: { settingsPages: true, revokes: true, chatFirst: true },
    changes: [
      {
        id: 'ch_0000000000000000000000a1',
        at: Date.now(),
        action: 'apply',
        operation: 'hermes.reasoning-effort',
        target: 'hermes-config',
        keys: ['hermes.config:agent.reasoning_effort'],
        device: { id: 'dv_000000000000000000000002', name: 'Example phone', kind: 'phone' },
        level: 'anywhere',
        timing: [{ label: 'next-turn', surface: 'messaging' }],
        result: 'ok',
        undoable: true,
      },
      {
        id: 'ch_0000000000000000000000a2',
        at: Date.now() - 60_000,
        action: 'undo',
        operation: 'wayroost.safety-commands',
        target: 'wayroost-settings',
        keys: ['wayroost.settings:safetyCommandsEnabled'],
        device: { id: 'dv_000000000000000000000001', name: 'work-laptop', kind: 'desktop' },
        level: 'pc-only',
        timing: [{ label: 'now' }],
        result: 'undo_changed',
        undoable: false,
      },
    ],
  };

  beforeEach(() => { sections.overview = changesPayload; });

  it('lists changes with device, level and timing, and undoes the undoable one', async () => {
    await render(recentChanges());
    expect(text()).toContain('Reasoning effort');
    expect(text()).toContain('Example phone');
    expect(levelChips()).toEqual(expect.arrayContaining(['anywhere', 'pc-only']));
    expect(text()).toContain('Undo of Hermes safety commands');
    expect(text()).toContain('The file changed since that change');
    await press('Undo Reasoning effort');
    expect(writes().length).toBe(1);
    expect(writes()[0]!.url).toContain('/api/settings/undo');
    expect(writeBody(0)).toEqual({ change: 'ch_0000000000000000000000a1' });
  });

  it('cancels a held undo and locks recent changes after a refused refresh until recovery', async () => {
    nextReply = { status: 200, body: confirmAnswer };
    await render(recentChanges());
    await press('Undo Reasoning effort');
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    const saved = sections.overview;
    sections.overview = { status: 'refused', code: 'unavailable' };
    await act(async () => { applyEvent({ type: 'settings_changed', sections: ['overview'], change: appliedChange.id }); });
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect((at('Undo Reasoning effort') as HTMLButtonElement).disabled).toBe(true);
    await press('Undo Reasoning effort');
    expect(writes()).toHaveLength(1);
    sections.overview = saved;
    await clickText('Retry');
    expect((at('Undo Reasoning effort') as HTMLButtonElement).disabled).toBe(false);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('words the server’s refusal when the file moved since', async () => {
    nextReply = { status: 409, body: { status: 'refused', code: 'undo_changed' } };
    await render(recentChanges());
    await press('Undo Reasoning effort');
    expect(getState().toasts.map((entry) => entry.text).join(' ')).toContain('The file changed since that change');
  });

  it('a phone taps through the code for an undo that needs one', async () => {
    setState((s) => ({ ...s, device: phone }));
    nextReply = { status: 200, body: confirmAnswer };
    await render(recentChanges());
    await press('Undo Reasoning effort');
    expect(text()).toContain('AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA');
    await clickText('Confirm');
    expect(writes().length).toBe(2);
    expect(writeBody(1)).toEqual({ change: 'ch_0000000000000000000000a1', confirm: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA' });
  });

  function removeUndo(payload: SettingsSectionPayload, reason: 'consumed' | 'read-only' | 'removed') {
    if (reason === 'removed') payload.changes = [];
    else if (reason === 'consumed') payload.changes![0]!.undoable = false;
    else payload.changes![0]!.undoAccess = 'read-only';
  }

  it.each(['consumed', 'read-only', 'removed'] as const)('drops a held undo with a plain message when it becomes %s', async reason => {
    nextReply = { status: 200, body: confirmAnswer };
    await render(recentChanges());
    await press('Undo Reasoning effort');
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    const refreshed = structuredClone(changesPayload) as SettingsSectionPayload;
    removeUndo(refreshed, reason);
    sections.overview = refreshed;
    await act(async () => { applyEvent({ type: 'settings_changed', sections: ['overview'], change: appliedChange.id }); });
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(getState().toasts.map(entry => entry.text)).toContain('Undo is no longer available for this change.');
    expect(writes()).toHaveLength(1);
    sections.overview = changesPayload;
    await act(async () => { applyEvent({ type: 'settings_changed', sections: ['overview'], change: appliedChange.id }); });
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(writes()).toHaveLength(1);
  });

  it.each(['consumed', 'read-only', 'removed'] as const)('rechecks a %s undo at submission even before another render', async reason => {
    const current = structuredClone(changesPayload) as SettingsSectionPayload;
    vi.spyOn(api, 'settingsSection').mockResolvedValue(current);
    nextReply = { status: 200, body: confirmAnswer };
    await render(recentChanges());
    await press('Undo Reasoning effort');
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    removeUndo(current, reason);
    await clickText('Confirm');
    expect(writes()).toHaveLength(1);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(getState().toasts.map(entry => entry.text)).toContain('Undo is no longer available for this change.');
  });

  it('never holds a delayed confirmation for an undo consumed during its request', async () => {
    await render(recentChanges());
    const original = fetchMock.getMockImplementation()!;
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((input, init) => {
      if (!String(input).includes('/api/settings/undo')) return original(input, init);
      sent.push({ url: String(input), init });
      return new Promise(resolve => { finish = resolve; });
    });
    await press('Undo Reasoning effort');
    const refreshed = structuredClone(changesPayload) as SettingsSectionPayload;
    removeUndo(refreshed, 'consumed');
    sections.overview = refreshed;
    await act(async () => { applyEvent({ type: 'settings_changed', sections: ['overview'], change: appliedChange.id }); });
    await act(async () => { finish(Response.json(confirmAnswer)); });
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(getState().toasts.map(entry => entry.text)).toContain('Undo is no longer available for this change.');
    expect(writes()).toHaveLength(1);
  });

  it.each(['confirm', 'editable'] as const)('keeps an undo confirmation while its current access remains %s', async undoAccess => {
    nextReply = { status: 200, body: confirmAnswer };
    await render(recentChanges());
    await press('Undo Reasoning effort');
    const refreshed = structuredClone(changesPayload) as SettingsSectionPayload;
    refreshed.changes![0]!.undoAccess = undoAccess;
    sections.overview = refreshed;
    await act(async () => { applyEvent({ type: 'settings_changed', sections: ['overview'], change: appliedChange.id }); });
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    await clickText('Confirm');
    expect(writes()).toHaveLength(2);
    expect(writeBody(1)).toEqual({ change: changesPayload.changes[0]!.id, confirm: confirmAnswer.confirm });
  });
});

describe('the words the pages use', () => {
  it('every error code the server can answer with has its own words', () => {
    expect(settingsErrorText('pc_only')).toContain('only be changed on the PC');
    expect(settingsErrorText('confirm_invalid')).toContain('confirmation is used or expired');
    expect(settingsErrorText('undo_changed')).toContain('offered as a new change');
    expect(settingsErrorText('timeout')).toContain('took too long');
    expect(settingsErrorText('audit_unavailable')).toContain('Chats keep working');
  });

  it('reads the three levels as anywhere, confirm, PC only', async () => {
    sections.safety = sectionFor('desktop').safety;
    await render(safetyPage());
    expect(levelChips()).toContain('anywhere');
    expect(levelChips()).toContain('pc-only');
    expect(text()).toContain('Any device');
    expect(text()).toContain('PC only');
    expect(text()).not.toContain('Confirm</');
  });

  it('the toast repeats the timing and adds what the change result says', () => {
    expect(changeToastText({ ...appliedChange, lasts: 'until-next-switch' })).toContain('In place until the next model switch.');
    expect(changeToastText({ ...appliedChange, effective: 'pending' })).toContain('pick it up later');
    expect(changeToastText({ ...appliedChange, reloadOpenPages: true })).toContain('Reload any open Hermes settings page');
  });

  it('a confirm answer becomes the prompt, not a refusal', () => {
    expect(describeApplyResponse({ ...confirmAnswer, status: 'confirm' } as never)).toEqual({
      kind: 'confirm', code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA', summary: 'Reasoning effort: high', expiresAt: confirmAnswer.expiresAt,
    });
  });
});


describe('settings regressions', () => {
  beforeEach(() => {
    sections = sectionFor('desktop');
    (sections.safety as SettingsSectionPayload).views!.find(view => view.view === 'hermes.managed')!.values = [];
  });

  const refreshSettings = () => act(async () => {
    applyEvent({ type: 'settings_changed', sections: ['agents', 'models', 'safety'], change: appliedChange.id });
  });

  it('reports a required restart after revocation without claiming one is queued', async () => {
    nextReply = { status: 200, body: { status: 'applied', change: { ...appliedChange,
      operation: 'hermes.revoke-always', effective: 'pending', timing: [
        { surface: 'messaging', label: 'restart-when-idle:hermes' },
        { surface: 'api', label: 'restart-when-idle:hermes' },
      ],
    } } };
    await render(safetyPage());
    await press('Revoke git status');
    const toast = getState().toasts.map(entry => entry.text).join(' ');
    expect(toast).toContain("WhatsApp: after a required restart of Hermes' gateway");
    expect(toast).toContain("phone: after a required restart of Hermes' gateway");
    expect(toast).toContain('No restart has been scheduled');
    expect(text()).not.toContain('restarts on its own');
    expect(text()).not.toContain('verified three ways');
    expect(writes()).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/settings/restart'))).toBe(false);
  });

  it.each(['save', 'remove'] as const)('reports the gateway restart requirement after a credential %s', async action => {
    await render(modelsPage());
    if (action === 'save') {
      await type('Key for anthropic', 'fake-anthropic-key');
      await press('Save key for anthropic');
    } else {
      const row = at('Key for anthropic').closest('.kv')!;
      await act(async () => { [...row.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Remove')!.click(); });
    }
    expect(container.querySelector('.models-keys')!.textContent).toContain('Restart required');
    expect(container.querySelector('.models-keys')!.textContent).toContain('No restart has been scheduled');
    expect(text()).not.toContain('restarts on its own');
    expect(text()).not.toContain('Wayroost times for a quiet moment');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/settings/restart'))).toBe(false);
  });

  it('keeps another provider key draft through a credential save and settings_changed', async () => {
    await render(modelsPage());
    await type('Key for anthropic', 'fake-anthropic-key');
    await type('Key for openrouter', 'fake-openrouter-key');
    await press('Save key for anthropic');
    await refreshSettings();
    expect((at('Key for anthropic') as HTMLInputElement).value).toBe('');
    expect((at('Key for openrouter') as HTMLInputElement).value).toBe('fake-openrouter-key');
    expect((at('Save key for openrouter') as HTMLButtonElement).disabled).toBe(false);
    await press('Save key for openrouter');
    expect(JSON.parse(String(sent.filter(call => call.url.includes('/credentials/'))[1]!.init?.body))).toEqual({ secret: 'fake-openrouter-key' });
  });

  it('keeps routing, profile and delegation drafts after saving reasoning effort', async () => {
    await render(agentsPage());
    await type('Routing note', 'A new routing draft.');
    await type('Model for profile paseo-coder', 'pi/example-draft');
    await type('Steps per delegated chat', '40');
    const payload = sections.agents as SettingsSectionPayload;
    payload.views!.find(view => view.view === 'hermes.agents')!.values!.find(entry => entry.path.join('.') === 'agent.reasoning_effort')!.value = 'high';
    payload.views!.find(view => view.view === 'hermes.models')!.values!.find(entry => entry.path.join('.') === 'delegation.max_iterations')!.value = 35;
    const paseo = payload.views!.find(view => view.view === 'paseo.agents')!;
    paseo.values!.find(entry => entry.path.join('.') === 'daemon.appendSystemPrompt')!.value = 'A different saved routing note.';
    paseo.values!.find(entry => entry.path.join('.') === 'daemon.agentProfiles.0.model')!.value = 'pi/example-remote';
    await choose('Reasoning effort', 'high');
    expect((at('Reasoning effort') as HTMLSelectElement).value).toBe('high');
    expect((at('Routing note') as HTMLTextAreaElement).value).toBe('A new routing draft.');
    expect((at('Model for profile paseo-coder') as HTMLInputElement).value).toBe('pi/example-draft');
    expect((at('Steps per delegated chat') as HTMLInputElement).value).toBe('40');
    expect(writes()).toHaveLength(1);
  });

  it('keeps dirty model fields, chains, helper drafts and backend choices across changed saved values', async () => {
    await render(modelsPage());
    await type('Default model model', 'example-draft');
    await type('Delegation fallbacks model 1', 'example-fallback-draft');
    await type('Helper: compression model', 'example-helper-draft');
    await type('Helper provider', 'example');
    await type('Helper model', 'example-new-helper');
    await choose('Backend for the coder role', 'anthropic-main');
    const view = (sections.models as SettingsSectionPayload).views!.find(view => view.view === 'hermes.models')!;
    view.sha256 = '9'.repeat(64);
    view.values!.find(entry => entry.path.join('.') === 'model.provider')!.value = 'openrouter';
    view.values!.find(entry => entry.path.join('.') === 'model.default')!.value = 'example-remote-model';
    view.values!.find(entry => entry.path.join('.') === 'delegation.fallback_providers')!.value = [{ provider: 'example', model: 'example-remote-fallback' }];
    view.values!.find(entry => entry.path.join('.') === 'auxiliary.compression.model')!.value = 'example-remote-helper';
    const gateway = (sections.models as SettingsSectionPayload).views!.find(view => view.view === 'gateway.role-map')!;
    gateway.values!.find(entry => entry.path.join('.') === 'roles.coder')!.value = 'example-backend';
    gateway.values!.push({ path: ['backends', 'example-backend', 'provider'], exists: true, value: 'example' });
    await refreshSettings();
    expect((at('Default model provider') as HTMLInputElement).value).toBe('openrouter');
    expect((at('Default model model') as HTMLInputElement).value).toBe('example-draft');
    expect((at('Delegation fallbacks model 1') as HTMLInputElement).value).toBe('example-fallback-draft');
    expect((at('Helper: compression model') as HTMLInputElement).value).toBe('example-helper-draft');
    expect((at('Helper model') as HTMLInputElement).value).toBe('example-new-helper');
    expect((at('Helper provider') as HTMLInputElement).value).toBe('example');
    expect((at('Backend for the coder role') as HTMLSelectElement).value).toBe('anthropic-main');
    await act(async () => { at('Default model model').closest('.kv')!.querySelector<HTMLButtonElement>('button')!.click(); });
    expect(writeBody(0)).toMatchObject({ params: { provider: 'openrouter', model: 'example-draft' }, expected: { file: { sha256: '9'.repeat(64) } } });
  });

  it('clears a saved helper addition while preserving an unrelated model draft', async () => {
    await render(modelsPage());
    await type('Default model model', 'example-model-draft');
    await choose('Helper task to set', 'approval');
    await type('Helper provider', 'example');
    await type('Helper model', 'example-helper');
    await clickText('Set helper');
    expect(writeBody(0)).toMatchObject({ operation: 'hermes.helper-model', params: { task: 'approval', provider: 'example', model: 'example-helper' } });
    expect((at('Helper provider') as HTMLInputElement).value).toBe('');
    expect((at('Helper model') as HTMLInputElement).value).toBe('');
    expect((at('Default model model') as HTMLInputElement).value).toBe('example-model-draft');
  });

  it('clears a confirmed helper addition after it applies while preserving another model draft', async () => {
    setState(state => ({ ...state, device: phone }));
    sections.models = sectionFor('phone').models;
    nextReply = { status: 200, body: confirmAnswer };
    await render(modelsPage());
    await type('Default model model', 'example-model-draft');
    await choose('Helper task to set', 'approval');
    await type('Helper provider', 'example');
    await type('Helper model', 'example-helper');
    await clickText('Set helper');
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    expect((at('Helper provider') as HTMLInputElement).value).toBe('example');
    expect((at('Helper model') as HTMLInputElement).value).toBe('example-helper');
    const view = (sections.models as SettingsSectionPayload).views!.find(view => view.view === 'hermes.models')!;
    view.values!.push(
      { path: ['auxiliary', 'approval', 'provider'], exists: true, value: 'example' },
      { path: ['auxiliary', 'approval', 'model'], exists: true, value: 'example-helper' },
    );
    view.sha256 = '9'.repeat(64);
    const original = fetchMock.getMockImplementation()!;
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((input, init) => {
      if (!String(input).includes('/api/settings/apply')) return original(input, init);
      sent.push({ url: String(input), init });
      return new Promise(resolve => { finish = resolve; });
    });
    await clickText('Confirm');
    expect(writeBody(1)).toEqual({ ...writeBody(0), confirm: confirmAnswer.confirm });
    expect((at('Helper model') as HTMLInputElement).value).toBe('example-helper');
    await act(async () => { finish(Response.json({ status: 'applied', change: { ...appliedChange, operation: 'hermes.helper-model' } })); });
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect((at('Helper provider') as HTMLInputElement).value).toBe('');
    expect((at('Helper model') as HTMLInputElement).value).toBe('');
    expect((at('Default model model') as HTMLInputElement).value).toBe('example-model-draft');
    const setHelper = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Set helper')!;
    expect(setHelper.disabled).toBe(true);
    await clickText('Set helper');
    expect(writes()).toHaveLength(2);
  });

  it.each(['cancel', 'refused', 'refused-with-change'] as const)('keeps helper drafts when their confirmation is %s', async result => {
    setState(state => ({ ...state, device: phone }));
    sections.models = sectionFor('phone').models;
    nextReply = { status: 200, body: confirmAnswer };
    await render(modelsPage());
    await choose('Helper task to set', 'approval');
    await type('Helper provider', 'example');
    await type('Helper model', 'example-helper');
    await clickText('Set helper');
    if (result === 'cancel') await clickText('Cancel');
    else {
      nextReply = { status: 409, body: { status: 'refused', code: 'precondition_changed', ...(result === 'refused-with-change' ? { change: appliedChange } : {}) } };
      await clickText('Confirm');
    }
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect((at('Helper provider') as HTMLInputElement).value).toBe('example');
    expect((at('Helper model') as HTMLInputElement).value).toBe('example-helper');
    expect(writes()).toHaveLength(result === 'cancel' ? 1 : 2);
  });

  it('keeps helper addition drafts when a different model confirmation applies', async () => {
    setState(state => ({ ...state, device: phone }));
    sections.models = sectionFor('phone').models;
    nextReply = { status: 200, body: confirmAnswer };
    await render(modelsPage());
    await type('Helper provider', 'example');
    await type('Helper model', 'example-helper');
    await type('Default model model', 'example-model-draft');
    await act(async () => { at('Default model model').closest('.kv')!.querySelector<HTMLButtonElement>('button')!.click(); });
    nextReply = undefined;
    await clickText('Confirm');
    expect((at('Helper provider') as HTMLInputElement).value).toBe('example');
    expect((at('Helper model') as HTMLInputElement).value).toBe('example-helper');
    expect(writes()).toHaveLength(2);
  });

  it('updates clean agent fields while preserving dirty fields in the same refresh', async () => {
    await render(agentsPage());
    await type('Steps per delegated chat', '40');
    const payload = sections.agents as SettingsSectionPayload;
    const limits = payload.views!.find(view => view.view === 'hermes.models')!;
    limits.values!.find(entry => entry.path.join('.') === 'delegation.max_concurrent_children')!.value = 4;
    limits.values!.find(entry => entry.path.join('.') === 'delegation.max_iterations')!.value = 35;
    const paseo = payload.views!.find(view => view.view === 'paseo.agents')!;
    paseo.values!.find(entry => entry.path.join('.') === 'daemon.appendSystemPrompt')!.value = 'A saved routing note.';
    paseo.values!.find(entry => entry.path.join('.') === 'daemon.agentProfiles.0.model')!.value = 'pi/example-saved';
    await refreshSettings();
    expect((at('Delegated chats at once') as HTMLInputElement).value).toBe('4');
    expect((at('Steps per delegated chat') as HTMLInputElement).value).toBe('40');
    expect((at('Routing note') as HTMLTextAreaElement).value).toBe('A saved routing note.');
    expect((at('Model for profile paseo-coder') as HTMLInputElement).value).toBe('pi/example-saved');
    await type('Routing note', 'Another draft.');
    paseo.values!.find(entry => entry.path.join('.') === 'daemon.appendSystemPrompt')!.value = 'Another draft.';
    await act(async () => { at('Routing note').closest('.kv')!.querySelector<HTMLButtonElement>('button')!.click(); });
    expect(at('Routing note').closest('.kv')!.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
    paseo.values!.find(entry => entry.path.join('.') === 'daemon.appendSystemPrompt')!.value = 'A later saved note.';
    await refreshSettings();
    expect((at('Routing note') as HTMLTextAreaElement).value).toBe('A later saved note.');
  });

  const discardedMessage = "Your unsaved changes here were discarded because the settings couldn't be read";
  const assertLocked = () => {
    const controls = [...container.querySelectorAll<HTMLElement>('fieldset input, fieldset select, fieldset textarea, fieldset button')];
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every(control => control.matches(':disabled'))).toBe(true);
  };

  it.each(['codex.approvals', 'claude.permissions', 'opencode.permissions'] as const)('isolates an initially failed or missing %s view until recovery', async view => {
    const payload = sections.safety as SettingsSectionPayload;
    const good = payload.views!.find(entry => entry.view === view)!;
    payload.views = payload.views!.filter(entry => entry.view !== view).concat({ view, ok: false, code: 'parse_failed' });
    await render(safetyPage());
    expect((at('Skill changes wait for your OK') as HTMLButtonElement).matches(':disabled')).toBe(false);
    expect(text()).toContain("can't be parsed");
    expect(text()).not.toContain('This section is read-only');
    payload.views = payload.views!.filter(entry => entry.view !== view);
    await refreshSettings();
    expect((at('Skill changes wait for your OK') as HTMLButtonElement).matches(':disabled')).toBe(false);
    expect(text()).toContain('did not answer');
    payload.views.push(good);
    await clickText('Retry');
    expect(text()).not.toContain('did not answer');
    expect(sent).toEqual([]);
  });

  it.each([
    ['codex.approvals', 'failed'], ['codex.approvals', 'missing'],
    ['claude.permissions', 'failed'], ['claude.permissions', 'missing'],
    ['opencode.permissions', 'failed'], ['opencode.permissions', 'missing'],
  ] as const)('keeps a held safety confirmation after an unrelated %s view is %s', async (view, failure) => {
    nextReply = { status: 200, body: confirmAnswer };
    await render(safetyPage());
    await press('Skill changes wait for your OK');
    const payload = sections.safety as SettingsSectionPayload;
    payload.views = payload.views!.filter(entry => entry.view !== view);
    if (failure === 'failed') payload.views.push({ view, ok: false, code: 'parse_failed' });
    await refreshSettings();
    expect(text()).not.toContain('This section is read-only');
    expect(text()).not.toContain(discardedMessage);
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    nextReply = { status: 200, body: { status: 'applied', change: appliedChange } };
    await clickText('Confirm');
    expect(writes()).toHaveLength(2);
    expect(writeBody(1)).toMatchObject({ operation: 'hermes.skill-staging', confirm: confirmAnswer.confirm });
  });

  it.each(['codex.approvals', 'claude.permissions', 'opencode.permissions'] as const)('holds a delayed safety confirmation when only %s fails', async view => {
    await render(safetyPage());
    const original = fetchMock.getMockImplementation()!;
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((input, init) => {
      if (!String(input).includes('/api/settings/apply')) return original(input, init);
      sent.push({ url: String(input), init });
      return new Promise(resolve => { finish = resolve; });
    });
    await press('Skill changes wait for your OK');
    const payload = sections.safety as SettingsSectionPayload;
    payload.views = payload.views!.map(entry => entry.view === view ? { view, ok: false, code: 'parse_failed' } : entry);
    await refreshSettings();
    await act(async () => { finish(Response.json(confirmAnswer)); });
    expect(text()).not.toContain('This section is read-only');
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    expect(writes()).toHaveLength(1);
  });

  it.each([
    ['agents', 'network'], ['agents', 'http'], ['agents', 'refused'], ['agents', 'malformed'], ['agents', 'malformed-agent'],
    ['models', 'network'], ['models', 'http'], ['models', 'refused'], ['models', 'malformed'], ['models', 'malformed-agent'],
  ] as const)('preserves unrelated %s drafts and limits a %s availability failure to its controls', async (page, failure) => {
    nextReply = { status: 200, body: confirmAnswer };
    await render(page === 'agents' ? agentsPage() : modelsPage());
    const label = page === 'agents' ? 'Routing note' : 'Default model model';
    const saved = (at(label) as HTMLInputElement).value;
    await type(label, 'example-unsaved-draft');
    if (page === 'agents') {
      await type('Model for profile paseo-coder', 'pi/example-draft');
      await press('Claude Code');
    } else {
      await type('Key for openrouter', 'fake-openrouter-key');
      await type('Helper model', 'example-helper-draft');
      await act(async () => { at('Default model model').closest('.kv')!.querySelector<HTMLButtonElement>('button')!.click(); });
    }
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => {
      if (!String(input).includes('/api/cloud-agents')) return original(input, init);
      if (failure === 'network') return Promise.reject(new Error('This PC did not answer.'));
      const body = failure === 'malformed' ? {} : failure === 'malformed-agent'
        ? { agents: [{ id: 'claude', label: 'Claude Code', enabled: true, state: 'unknown' }] }
        : { status: 'refused', code: 'not_permitted' };
      return Promise.resolve(Response.json(body, { status: failure === 'http' ? 503 : 200 }));
    });
    await refreshSettings();
    expect((at(label) as HTMLInputElement).value).toBe('example-unsaved-draft');
    expect((at(label) as HTMLInputElement).matches(':disabled')).toBe(false);
    if (page === 'agents') {
      expect(at('Claude Code').matches(':disabled')).toBe(true);
      expect((at('Model for profile paseo-coder') as HTMLInputElement).value).toBe('pi/example-draft');
      expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    } else {
      expect((at('Key for openrouter') as HTMLInputElement).value).toBe('fake-openrouter-key');
      expect((at('Helper model') as HTMLInputElement).value).toBe('example-helper-draft');
      expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
      expect(text()).not.toContain(discardedMessage);
    }
    fetchMock.mockImplementation(original);
    await clickText('Retry');
    expect((at(label) as HTMLInputElement).value).toBe('example-unsaved-draft');
    expect(sent).toHaveLength(1);
  });

  it.each(['agents', 'models'] as const)('keeps unrelated %s controls usable while availability is pending or fails', async page => {
    const original = fetchMock.getMockImplementation()!;
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((input, init) => String(input).includes('/api/cloud-agents')
      ? new Promise(resolve => { finish = resolve; }) : original(input, init));
    await render(page === 'agents' ? agentsPage() : modelsPage());
    expect((at(page === 'agents' ? 'Routing note' : 'Default model model') as HTMLInputElement).matches(':disabled')).toBe(false);
    if (page === 'agents') expect(at('Claude Code').matches(':disabled')).toBe(true);
    await act(async () => { finish(Response.json({ status: 'refused', code: 'unavailable' })); });
    expect((at(page === 'agents' ? 'Routing note' : 'Default model model') as HTMLInputElement).matches(':disabled')).toBe(false);
    if (page === 'agents') expect(at('Claude Code').matches(':disabled')).toBe(true);
    if (page === 'agents') expect(text()).toContain('This section is read-only');
    fetchMock.mockImplementation(original);
    await clickText('Retry');
    expect(text()).not.toContain('This section is read-only');
    expect(sent).toEqual([]);
  });

  it.each(['agents', 'models'] as const)('keeps a delayed %s confirmation only when its dependencies remain readable', async page => {
    await render(page === 'agents' ? agentsPage() : modelsPage());
    const original = fetchMock.getMockImplementation()!;
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((input, init) => {
      if (!String(input).includes('/api/settings/apply')) return original(input, init);
      sent.push({ url: String(input), init });
      return new Promise(resolve => { finish = resolve; });
    });
    if (page === 'agents') await press('Claude Code');
    else {
      await type('Default model model', 'example-draft');
      await act(async () => { at('Default model model').closest('.kv')!.querySelector<HTMLButtonElement>('button')!.click(); });
    }
    fetchMock.mockImplementation((input, init) => String(input).includes('/api/cloud-agents')
      ? Promise.reject(new Error('This PC did not answer.')) : original(input, init));
    await refreshSettings();
    await act(async () => { finish(Response.json(confirmAnswer)); });
    expect((at(page === 'agents' ? 'Routing note' : 'Default model model') as HTMLInputElement).matches(':disabled')).toBe(false);
    if (page === 'agents') expect(at('Claude Code').matches(':disabled')).toBe(true);
    expect(Boolean(container.querySelector('[role="alertdialog"]'))).toBe(page === 'models');
    fetchMock.mockImplementation(original);
    await clickText('Retry');
    expect(Boolean(container.querySelector('[role="alertdialog"]'))).toBe(page === 'models');
    expect(sent).toHaveLength(1);
  });

  it.each(['agents', 'models'] as const)('pauses a held %s confirmation only for its availability dependency', async page => {
    nextReply = { status: 200, body: confirmAnswer };
    await render(page === 'agents' ? agentsPage() : modelsPage());
    if (page === 'agents') await press('Claude Code');
    else {
      await type('Default model model', 'example-draft');
      await act(async () => { at('Default model model').closest('.kv')!.querySelector<HTMLButtonElement>('button')!.click(); });
    }
    const original = fetchMock.getMockImplementation()!;
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((input, init) => String(input).includes('/api/cloud-agents')
      ? new Promise(resolve => { finish = resolve; }) : original(input, init));
    await refreshSettings();
    expect((at(page === 'agents' ? 'Routing note' : 'Default model model') as HTMLInputElement).matches(':disabled')).toBe(false);
    if (page === 'agents') expect(at('Claude Code').matches(':disabled')).toBe(true);
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    if (page === 'agents') { await clickText('Confirm'); expect(sent).toHaveLength(1); }
    await act(async () => { finish(await original('/api/cloud-agents')); });
    await clickText('Confirm');
    expect(writeBody(1)).toEqual({ ...writeBody(0), confirm: confirmAnswer.confirm });
    expect(sent).toHaveLength(2);
  });

  it.each(['agents', 'models'] as const)('isolates the latest %s availability failure even after a superseded success', async page => {
    await render(page === 'agents' ? agentsPage() : modelsPage());
    const original = fetchMock.getMockImplementation()!;
    const pending: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation((input, init) => String(input).includes('/api/cloud-agents')
      ? new Promise(resolve => { pending.push(resolve); }) : original(input, init));
    await refreshSettings();
    await refreshSettings();
    expect(pending).toHaveLength(2);
    await act(async () => { pending[1]!(Response.json({ status: 'refused', code: 'unavailable' })); });
    await act(async () => { pending[0]!(await original('/api/cloud-agents')); });
    expect((at(page === 'agents' ? 'Routing note' : 'Default model model') as HTMLInputElement).matches(':disabled')).toBe(false);
    if (page === 'agents') expect(at('Claude Code').matches(':disabled')).toBe(true);
    if (page === 'agents') expect(text()).toContain('This section is read-only');
    fetchMock.mockImplementation(original);
    await clickText('Retry');
    expect(text()).not.toContain('This section is read-only');
    expect(sent).toEqual([]);
  });

  it.each(['network', 'http', 'refused', 'malformed', 'malformed-row'] as const)('keeps model changes and credentials usable after a %s usage refresh failure', async failure => {
    nextReply = { status: 200, body: confirmAnswer };
    await render(modelsPage());
    await type('Default model model', 'example-draft');
    await type('Key for openrouter', 'fake-openrouter-key');
    await act(async () => { at('Default model model').closest('.kv')!.querySelector<HTMLButtonElement>('button')!.click(); });
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => {
      if (!String(input).includes('/api/settings/usage')) return original(input, init);
      if (failure === 'network') return Promise.reject(new Error('This PC did not answer.'));
      const body = failure === 'malformed' ? {} : failure === 'malformed-row'
        ? { ok: true, generatedAt: 0, windows: [{ id: 'today', since: 0, rows: [{}] }] }
        : { status: 'refused', code: 'not_configured' };
      return Promise.resolve(Response.json(body, { status: failure === 'http' ? 503 : 200 }));
    });
    await refreshSettings();
    expect(at('Default model model').matches(':disabled')).toBe(false);
    expect(text()).not.toContain(discardedMessage);
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    expect((at('Default model model') as HTMLInputElement).value).toBe('example-draft');
    expect((at('Key for openrouter') as HTMLInputElement).value).toBe('fake-openrouter-key');
    fetchMock.mockImplementation(original);
    await clickText('Retry');
    expect(text()).not.toContain('This section is read-only');
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    expect(sent).toHaveLength(1);
  });

  it('refreshes usage on usage events while keeping unsaved model drafts', async () => {
    await render(modelsPage());
    await type('Default model model', 'example-draft');
    const field = at('Default model model');
    const original = fetchMock.getMockImplementation()!;
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((input, init) => String(input).includes('/api/settings/usage')
      ? new Promise(resolve => { finish = resolve; }) : original(input, init));
    await act(async () => { setState(s => ({ ...s, usageVersion: s.usageVersion + 1 })); });
    expect(at('Default model model').matches(':disabled')).toBe(false);
    await act(async () => { finish(await original('/api/settings/usage')); });
    expect(at('Default model model')).toBe(field);
    expect((field as HTMLInputElement).value).toBe('example-draft');
    expect((field as HTMLInputElement).disabled).toBe(false);
    expect(sent).toEqual([]);
  });

  it('refreshes worker policy after a save and offers the opposite change', async () => {
    await render(safetyPage());
    const original = fetchMock.getMockImplementation()!;
    const before = fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/worker-approvals')).length;
    fetchMock.mockImplementation((input, init) => {
      if (String(input).includes('/api/settings/apply')) {
        workerPayload = { ...pendingWorkerApprovals(), enabled: JSON.parse(String(init?.body)).params.enabled, config: 'written', choiceConfirmed: true };
      }
      return original(input, init);
    });
    await press("Workers' approvals come to me");
    expect(writeBody(0)).toMatchObject({ operation: 'paseo.worker-approvals', params: { enabled: false } });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/worker-approvals')).length).toBeGreaterThan(before);
    expect(at("Workers' approvals come to me").getAttribute('aria-checked')).toBe('false');
    expect(at("Workers' approvals come to me").closest('.kv')!.textContent).toContain('Saved choice: Off');
    await press("Workers' approvals come to me");
    expect(writeBody(1)).toMatchObject({ operation: 'paseo.worker-approvals', params: { enabled: true } });
    expect(at("Workers' approvals come to me").getAttribute('aria-checked')).toBe('true');
  });

  it('refreshes worker policy on settings_changed and ignores superseded status responses', async () => {
    await render(safetyPage());
    const original = fetchMock.getMockImplementation()!;
    const pending: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation((input, init) => String(input).includes('/api/worker-approvals')
      ? new Promise(resolve => { pending.push(resolve); }) : original(input, init));
    await refreshSettings();
    expect(text()).toContain('Checking worker policy');
    expect((at('Skill changes wait for your OK') as HTMLButtonElement).matches(':disabled')).toBe(false);
    await refreshSettings();
    expect(pending).toHaveLength(2);
    await act(async () => { pending[1]!(Response.json({ ...pendingWorkerApprovals(), enabled: false, config: 'written', choiceConfirmed: true })); });
    await act(async () => { pending[0]!(Response.json({ ...pendingWorkerApprovals(), enabled: true })); });
    expect(at("Workers' approvals come to me").getAttribute('aria-checked')).toBe('false');
    expect(at("Workers' approvals come to me").closest('.kv')!.textContent).toContain('Saved choice: Off');
    expect((at("Workers' approvals come to me") as HTMLButtonElement).disabled).toBe(false);
    expect(sent).toEqual([]);
  });

  it.each(['worker-approvals', 'safety-commands'] as const)('locks only controls depending on the initial %s read', async endpoint => {
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => String(input).includes(`/api/${endpoint}`)
      ? Promise.reject(new Error('This PC did not answer.')) : original(input, init));
    await render(safetyPage());
    expect(text()).toContain('This section is read-only');
    expect(text()).toContain("Can't reach Wayroost");
    expect((at('Skill changes wait for your OK') as HTMLButtonElement).matches(':disabled')).toBe(false);
    fetchMock.mockImplementation(original);
    await clickText('Retry');
    expect(text()).not.toContain('This section is read-only');
    expect(sent).toEqual([]);
  });

  it.each([
    ['worker-approvals', 'network'], ['worker-approvals', 'http'], ['worker-approvals', 'refused'], ['worker-approvals', 'malformed'],
    ['safety-commands', 'network'], ['safety-commands', 'http'], ['safety-commands', 'refused'], ['safety-commands', 'malformed'],
  ] as const)('isolates a %s %s failure and preserves unrelated confirmations', async (endpoint, failure) => {
    nextReply = { status: 200, body: confirmAnswer };
    await render(safetyPage());
    await act(async () => { container.querySelector<HTMLInputElement>('input[value="manual"]')!.click(); });
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => {
      if (!String(input).includes(`/api/${endpoint}`)) return original(input, init);
      if (failure === 'network') return Promise.reject(new Error('This PC did not answer.'));
      return Promise.resolve(Response.json(failure === 'malformed' ? {} : { status: 'refused', code: 'not_permitted' }, { status: failure === 'http' ? 503 : 200 }));
    });
    await refreshSettings();
    expect(text()).toContain('This section is read-only');
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    expect(container.querySelector<HTMLButtonElement>('[role="alertdialog"] .btn-primary')!.matches(':disabled')).toBe(false);
    if (endpoint === 'worker-approvals') {
      expect(text()).toContain('Worker policy unavailable');
      expect(text()).not.toContain('Saved choice: On');
      expect(text()).not.toContain('Config: written');
    } else expect(text()).toContain('Safety-command status unavailable');
    expect(writes()).toHaveLength(1);
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((input, init) => String(input).includes(`/api/${endpoint}`)
      ? new Promise(resolve => { finish = resolve; }) : original(input, init));
    await clickText('Retry');
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    await act(async () => { finish(await original(`/api/${endpoint}`)); });
    expect(text()).not.toContain('This section is read-only');
    await clickText('Cancel');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(writes()).toHaveLength(1);
  });

  it('keeps worker policy unavailable after an older status succeeds following the latest failure', async () => {
    await render(safetyPage());
    const original = fetchMock.getMockImplementation()!;
    const pending: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation((input, init) => String(input).includes('/api/worker-approvals')
      ? new Promise(resolve => { pending.push(resolve); }) : original(input, init));
    await refreshSettings();
    await refreshSettings();
    expect(pending).toHaveLength(2);
    await act(async () => { pending[1]!(Response.json({ status: 'refused', code: 'unavailable' })); });
    await act(async () => { pending[0]!(Response.json(pendingWorkerApprovals())); });
    expect(text()).toContain('This section is read-only');
    expect(text()).toContain('Worker policy unavailable');
    expect((at('Skill changes wait for your OK') as HTMLButtonElement).matches(':disabled')).toBe(false);
    fetchMock.mockImplementation(original);
    await refreshSettings();
    expect(text()).not.toContain('This section is read-only');
    expect((at("Workers' approvals come to me") as HTMLButtonElement).disabled).toBe(false);
    expect(sent).toEqual([]);
  });

  it('keeps a schema-valid constructor provider draft empty and isolated from other keys', async () => {
    expect(providerIdSchema.parse('constructor')).toBe('constructor');
    const map = (sections.models as SettingsSectionPayload).views!.find(view => view.view === 'gateway.role-map')!;
    map.values!.find(entry => entry.path.join('.') === 'backends.anthropic-main.provider')!.value = 'constructor';
    await render(modelsPage());
    expect((at('Key for constructor') as HTMLInputElement).value).toBe('');
    expect((at('Save key for constructor') as HTMLButtonElement).disabled).toBe(true);
    await type('Key for constructor', 'fake-constructor-key');
    await type('Key for openrouter', 'fake-openrouter-key');
    expect((at('Save key for constructor') as HTMLButtonElement).disabled).toBe(false);
    await press('Save key for constructor');
    expect((at('Key for constructor') as HTMLInputElement).value).toBe('');
    expect((at('Save key for constructor') as HTMLButtonElement).disabled).toBe(true);
    expect((at('Key for openrouter') as HTMLInputElement).value).toBe('fake-openrouter-key');
    await press('Save key for openrouter');
    const credentials = sent.filter(call => call.url.includes('/credentials/'));
    expect(credentials.map(call => [call.url, JSON.parse(String(call.init?.body))])).toEqual([
      ['/api/settings/credentials/constructor', { secret: 'fake-constructor-key' }],
      ['/api/settings/credentials/openrouter', { secret: 'fake-openrouter-key' }],
    ]);
  });

  it.each(['agents', 'models', 'safety'] as const)('locks all %s writes and drops drafts after a refused refresh until recovery', async page => {
    await render(page === 'agents' ? agentsPage() : page === 'models' ? modelsPage() : safetyPage());
    if (page === 'agents') {
      await type('Routing note', 'A routing draft.');
      await type('Model for profile paseo-coder', 'pi/example-draft');
      await type('Steps per delegated chat', '40');
    } else if (page === 'models') {
      await type('Default model model', 'example-draft');
      await type('Key for openrouter', 'fake-openrouter-key');
      await type('Helper model', 'example-helper-draft');
    }
    const saved = sections[page];
    sections[page] = { status: 'refused', code: 'unavailable' };
    await refreshSettings();
    expect(text()).toContain('Could not refresh settings');
    expect(text()).toContain('This section is read-only');
    expect(text()).toContain(discardedMessage);
    assertLocked();
    await act(async () => { container.querySelectorAll<HTMLButtonElement>('fieldset button').forEach(button => button.click()); });
    expect(sent).toEqual([]);
    const original = fetchMock.getMockImplementation()!;
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((input, init) => String(input).includes(`/api/settings/sections/${page}`)
      ? new Promise(resolve => { finish = resolve; }) : original(input, init));
    await clickText('Retry');
    assertLocked();
    expect(text()).toContain('Could not refresh settings');
    sections[page] = saved;
    await act(async () => { finish(Response.json(saved)); });
    expect(text()).not.toContain('Could not refresh settings');
    expect(text()).not.toContain('This section is read-only');
    if (page === 'agents') {
      expect((at('Routing note') as HTMLTextAreaElement).value).toBe('Route coding to the coder profile.');
      expect((at('Model for profile paseo-coder') as HTMLInputElement).value).toBe('pi/example-coder-model');
      expect((at('Steps per delegated chat') as HTMLInputElement).value).toBe('30');
      expect((at('Claude Code') as HTMLButtonElement).disabled).toBe(false);
    } else if (page === 'models') {
      expect((at('Default model model') as HTMLInputElement).value).toBe('example-main-model');
      expect((at('Key for openrouter') as HTMLInputElement).value).toBe('');
      expect((at('Helper model') as HTMLInputElement).value).toBe('');
      expect((at('Default model provider') as HTMLInputElement).disabled).toBe(false);
    } else {
      expect((at('Skill changes wait for your OK') as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it.each(['hermes.agents', 'hermes.models', 'paseo.agents', 'gateway.role-map', 'gateway.state', 'hermes.safety', 'wayroost.settings'] as const)(
    'locks dependent controls and resets their drafts when %s fails or disappears', async view => {
      const page = view === 'hermes.agents' || view === 'paseo.agents' ? 'agents'
        : view === 'hermes.safety' || view === 'wayroost.settings' ? 'safety' : 'models';
      await render(page === 'agents' ? agentsPage() : page === 'models' ? modelsPage() : safetyPage());
      const payload = sections[page] as SettingsSectionPayload;
      const good = payload.views!.find(entry => entry.view === view)!;
      for (const missing of [false, true]) {
        if (page === 'agents') await type('Routing note', 'A routing draft.');
        if (page === 'models') {
          await type('Default model model', 'example-draft');
          await type('Key for openrouter', 'fake-openrouter-key');
        }
        payload.views = payload.views!.filter(entry => entry.view !== view);
        if (!missing) payload.views.push({ view, ok: false, code: 'parse_failed' });
        await refreshSettings();
        if (page === 'agents') {
          expect(at('Routing note').matches(':disabled')).toBe(view === 'paseo.agents');
          expect(at('Steps per delegated chat').matches(':disabled')).toBe(view !== 'paseo.agents');
        } else if (page === 'models') {
          expect(at('Default model model').matches(':disabled')).toBe(view === 'hermes.models');
          expect(at('Key for openrouter').matches(':disabled')).toBe(view === 'gateway.role-map');
        } else {
          const affected = view === 'hermes.safety' ? at('Skill changes wait for your OK') : at('Hermes safety commands');
          expect(affected.matches(':disabled')).toBe(true);
          const unaffected = view === 'hermes.safety' ? at('Hermes safety commands') : at('Skill changes wait for your OK');
          expect(unaffected.matches(':disabled')).toBe(false);
        }
        expect(text()).toContain(missing ? 'did not answer' : "can't be parsed");
        expect(text()).toContain(discardedMessage);
        if (page === 'agents') expect((at('Routing note') as HTMLTextAreaElement).value).toBe(view === 'paseo.agents' ? 'Route coding to the coder profile.' : 'A routing draft.');
        if (page === 'models') {
          expect((at('Default model model') as HTMLInputElement).value).toBe(view === 'hermes.models' ? 'example-main-model' : 'example-draft');
          expect((at('Key for openrouter') as HTMLInputElement).value).toBe(view === 'gateway.role-map' ? '' : 'fake-openrouter-key');
        }
        payload.views = payload.views!.filter(entry => entry.view !== view).concat(good);
        await clickText('Retry');
        expect(text()).not.toContain('This section is read-only');
      }
      expect(sent).toEqual([]);
    });

  it.each(['agents', 'models', 'safety'] as const)('cancels held %s confirmations after a failed read and never resends them after recovery', async page => {
    setState(state => ({ ...state, device: phone }));
    nextReply = { status: 200, body: confirmAnswer };
    await render(page === 'agents' ? agentsPage() : page === 'models' ? modelsPage() : safetyPage());
    if (page === 'agents') {
      await type('Model for profile paseo-coder', 'pi/example-draft');
      await press('Save profile paseo-coder');
    } else if (page === 'models') {
      await type('Default model model', 'example-draft');
      await act(async () => { at('Default model model').closest('.kv')!.querySelector<HTMLButtonElement>('button')!.click(); });
    } else {
      await press('Skill changes wait for your OK');
    }
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    const saved = sections[page];
    sections[page] = { status: 'refused', code: 'unavailable' };
    await refreshSettings();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    assertLocked();
    sections[page] = saved;
    await clickText('Retry');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(writes()).toHaveLength(1);
  });

  it.each(['failed', 'missing', 'refused'] as const)('discards only dependent model drafts when the managed view is %s', async failure => {
    await render(modelsPage());
    await type('Default model address', '');
    await press('Remove Delegation fallbacks step 1');
    await choose('Backend for the coder role', 'anthropic-main');
    await type('Key for openrouter', 'fake-openrouter-key');
    await type('Helper model', 'example-helper-draft');
    const saved = sections.safety;
    const payload = sections.safety as SettingsSectionPayload;
    const good = payload.views!.find(entry => entry.view === 'hermes.managed')!;
    if (failure === 'refused') sections.safety = { status: 'refused', code: 'unavailable' };
    else payload.views = payload.views!.filter(entry => entry.view !== 'hermes.managed')
      .concat(failure === 'failed' ? [{ view: 'hermes.managed', ok: false, code: 'parse_failed' }] : []);
    await refreshSettings();
    expect(at('Default model model').matches(':disabled')).toBe(true);
    expect(at('Key for openrouter').matches(':disabled')).toBe(false);
    expect(text()).toContain(discardedMessage);
    expect((at('Default model address') as HTMLInputElement).value).toBe('http://127.0.0.1:8893/v1');
    expect((at('Delegation fallbacks model 1') as HTMLInputElement).value).toBe('example-research-model');
    expect((at('Backend for the coder role') as HTMLSelectElement).value).toBe('anthropic-main');
    expect((at('Key for openrouter') as HTMLInputElement).value).toBe('fake-openrouter-key');
    expect((at('Helper model') as HTMLInputElement).value).toBe('');
    sections.safety = saved;
    payload.views = payload.views!.filter(entry => entry.view !== 'hermes.managed').concat(good);
    await clickText('Retry');
    expect(text()).not.toContain('This section is read-only');
    expect((at('Default model address') as HTMLInputElement).value).toBe('http://127.0.0.1:8893/v1');
    expect((at('Delegation fallbacks model 1') as HTMLInputElement).value).toBe('example-research-model');
    expect(sent).toEqual([]);
  });

  it.each(['failed', 'pinned'] as const)('cancels a held model confirmation when the managed view becomes %s', async failure => {
    setState(state => ({ ...state, device: phone }));
    nextReply = { status: 200, body: confirmAnswer };
    await render(modelsPage());
    await type('Default model model', 'example-draft');
    await act(async () => { at('Default model model').closest('.kv')!.querySelector<HTMLButtonElement>('button')!.click(); });
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    const payload = sections.safety as SettingsSectionPayload;
    const good = payload.views!.find(entry => entry.view === 'hermes.managed')!;
    if (failure === 'failed') payload.views = payload.views!.map(entry => entry.view === 'hermes.managed' ? { view: entry.view, ok: false, code: 'unavailable' } : entry);
    else good.values = [{ path: ['model', 'default'], exists: true }];
    await refreshSettings();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect((at('Default model model') as HTMLInputElement).disabled).toBe(true);
    expect(writes()).toHaveLength(1);
  });

  it.each(['agents', 'models', 'safety'] as const)('locks all %s controls if the section request throws or returns malformed data', async page => {
    await render(page === 'agents' ? agentsPage() : page === 'models' ? modelsPage() : safetyPage());
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => String(input).includes(`/api/settings/sections/${page}`)
      ? Promise.reject(new Error('Settings request failed.')) : original(input, init));
    await refreshSettings();
    expect(text()).toContain("Can't reach Wayroost");
    assertLocked();
    fetchMock.mockImplementation((input, init) => String(input).includes(`/api/settings/sections/${page}`)
      ? Promise.resolve(Response.json({ section: page, views: 'invalid' })) : original(input, init));
    await clickText('Retry');
    assertLocked();
    expect(text()).toContain('This PC did not answer');
    fetchMock.mockImplementation(original);
    await clickText('Retry');
    expect(text()).not.toContain('This section is read-only');
    expect(sent).toEqual([]);
  });

  it.each(['agents', 'safety'] as const)('locks Hermes controls when the %s managed projection fails', async page => {
    await render(page === 'agents' ? agentsPage() : safetyPage());
    if (page === 'agents') {
      await type('Routing note', 'A routing draft.');
      await type('Steps per delegated chat', '40');
    }
    const payload = sections.safety as SettingsSectionPayload;
    const good = payload.views!.find(entry => entry.view === 'hermes.managed')!;
    payload.views = payload.views!.map(entry => entry.view === good.view ? { view: good.view, ok: false, code: 'parse_failed' } : entry);
    await refreshSettings();
    if (page === 'agents') { expect(at('Steps per delegated chat').matches(':disabled')).toBe(true); expect(at('Routing note').matches(':disabled')).toBe(false); }
    else {
      expect(at('Skill changes wait for your OK').matches(':disabled')).toBe(true);
      expect(at('Hermes safety commands').matches(':disabled')).toBe(false);
    }
    expect(text()).toContain(discardedMessage);
    if (page === 'agents') {
      expect((at('Routing note') as HTMLTextAreaElement).value).toBe('A routing draft.');
      expect((at('Steps per delegated chat') as HTMLInputElement).value).toBe('30');
    }
    payload.views = payload.views!.map(entry => entry.view === good.view ? good : entry);
    await clickText('Retry');
    expect(text()).not.toContain('This section is read-only');
    expect(sent).toEqual([]);
  });

  it('locks the worker control when its provider settings dependency is refused', async () => {
    await render(safetyPage());
    const saved = sections.agents;
    sections.agents = { status: 'refused', code: 'unavailable' };
    await refreshSettings();
    expect(at("Workers' approvals come to me").matches(':disabled')).toBe(true);
    expect(at('Skill changes wait for your OK').matches(':disabled')).toBe(false);
    expect(text()).toContain('Could not refresh settings');
    sections.agents = saved;
    await clickText('Retry');
    expect((at("Workers' approvals come to me") as HTMLButtonElement).disabled).toBe(false);
    expect(sent).toEqual([]);
  });

  it.each([
    ['default', ['model', 'base_url']],
    ['fallback', ['delegation', 'fallback_providers']],
    ['helper', ['auxiliary', 'approval', 'model']],
    ['limits', ['delegation', 'max_iterations']],
  ] as const)('cancels a held %s confirmation when any key in its operation is pinned', async (editor, path) => {
    setState(state => ({ ...state, device: phone }));
    nextReply = { status: 200, body: confirmAnswer };
    await render(editor === 'limits' ? agentsPage() : modelsPage());
    if (editor === 'default') {
      await type('Default model model', 'example-draft');
      await act(async () => { at('Default model model').closest('.kv')!.querySelector<HTMLButtonElement>('button')!.click(); });
    } else if (editor === 'fallback') {
      await type('Delegation fallbacks model 1', 'example-fallback');
      await clickText('Save chain for Delegation fallbacks');
    } else if (editor === 'helper') {
      await choose('Helper task to set', 'approval');
      await type('Helper provider', 'example');
      await type('Helper model', 'example-helper');
      await clickText('Set helper');
    } else {
      await type('Steps per delegated chat', '40');
      await act(async () => { at('Steps per delegated chat').closest('.kv')!.querySelector<HTMLButtonElement>('button')!.click(); });
    }
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    const managed = (sections.safety as SettingsSectionPayload).views!.find(entry => entry.view === 'hermes.managed')!;
    managed.values = [{ path: [...path], exists: true }];
    await refreshSettings();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(writes()).toHaveLength(1);
  });

  it('never restores a confirmation response that arrives after the section failed', async () => {
    nextReply = { status: 200, body: confirmAnswer };
    await render(agentsPage());
    const original = fetchMock.getMockImplementation()!;
    let finish!: () => void;
    fetchMock.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      return String(input).includes('/api/settings/apply') ? new Promise(resolve => { finish = () => resolve(response); }) : response;
    });
    await press('Claude Code');
    expect(writes()).toHaveLength(1);
    const saved = sections.agents;
    sections.agents = { status: 'refused', code: 'unavailable' };
    await refreshSettings();
    await act(async () => { finish(); });
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    sections.agents = saved;
    await clickText('Retry');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(writes()).toHaveLength(1);
  });

  it('keeps a failed section locked when a superseded successful refresh arrives', async () => {
    await render(agentsPage());
    const original = fetchMock.getMockImplementation()!;
    const pending: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation((input, init) => String(input).includes('/api/settings/sections/agents')
      ? new Promise(resolve => { pending.push(resolve); }) : original(input, init));
    await refreshSettings();
    await refreshSettings();
    await act(async () => { pending[1]!(Response.json({ status: 'refused', code: 'unavailable' })); });
    assertLocked();
    await act(async () => { pending[0]!(Response.json(sections.agents)); });
    assertLocked();
    expect(text()).toContain('Could not refresh settings');
    expect(sent).toEqual([]);
  });

  it.each(['manual', 'smart', 'off'])('only describes specific chat slash commands when approval mode is %s', async mode => {
    const safety = (sections.safety as SettingsSectionPayload).views!.find(view => view.view === 'hermes.safety')!;
    safety.values!.find(entry => entry.path.join('.') === 'approvals.mode')!.value = mode;
    await render(safetyPage());
    const row = at('Hermes safety commands').closest('.kv')!;
    expect(row.textContent).toContain('only these slash commands are blocked in chats: /status, /pause, /resume, /logs, /restart, /stop');
    expect(row.textContent).toContain(`effective approval mode: ${mode}`);
    expect(row.textContent).not.toContain('Agents wait for you');
    const settings = (sections.safety as SettingsSectionPayload).views!.find(view => view.view === 'wayroost.settings')!;
    settings.values![0]!.value = true;
    await refreshSettings();
    expect(at('Hermes safety commands').closest('.kv')!.textContent).toContain('these slash commands are allowed in chats');
  });

  it('refreshes Paseo availability after a provider save while preserving profile drafts', async () => {
    await render(agentsPage());
    await type('Model for profile paseo-coder', 'pi/example-draft');
    const row = at('Claude Code').closest('.kv')!;
    expect(row.textContent).toContain('Ready');
    cloudAgentsPayload = { agents: [{ id: 'claude', label: 'Claude Code', enabled: false, state: 'off' }] };
    const view = (sections.agents as SettingsSectionPayload).views!.find(view => view.view === 'paseo.agents')!;
    view.values!.find(entry => entry.path.join('.') === 'agents.providers.claude.enabled')!.value = false;
    await press('Claude Code');
    expect(at('Claude Code').getAttribute('aria-checked')).toBe('false');
    expect(row.textContent).toContain('Switched off');
    expect(row.textContent).not.toContain('Ready');
    expect((at('Model for profile paseo-coder') as HTMLInputElement).value).toBe('pi/example-draft');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/cloud-agents'))).toHaveLength(2);
  });

  it.each(['agents', 'models'] as const)('refreshes %s availability on settings_changed without losing editor drafts', async page => {
    await render(page === 'agents' ? agentsPage() : modelsPage());
    const label = page === 'agents' ? 'Routing note' : 'Default model model';
    const draft = page === 'agents' ? 'A routing draft.' : 'example-model-draft';
    await type(label, draft);
    const field = at(label);
    const status = container.querySelector(page === 'agents' ? '.agents-paseo' : '.models-subscriptions')!;
    expect(status.textContent).toContain(page === 'agents' ? 'Ready' : 'Available to run');
    cloudAgentsPayload = { agents: [{ id: 'claude', label: 'Claude Code', enabled: false, state: 'off' }] };
    await refreshSettings();
    expect(status.textContent).toContain('Switched off');
    expect(status.textContent).not.toContain(page === 'agents' ? 'Ready' : 'Available to run');
    expect(at(label)).toBe(field);
    expect((field as HTMLInputElement).value).toBe(draft);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/cloud-agents'))).toHaveLength(2);
  });

  it.each(['agents', 'models'] as const)('reports a failed %s availability refresh and recovers on the next settings change', async page => {
    await render(page === 'agents' ? agentsPage() : modelsPage());
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => String(input).includes('/api/cloud-agents')
      ? Promise.reject(new Error('This PC did not answer.')) : original(input, init));
    const status = () => container.querySelector(page === 'agents' ? '.agents-paseo' : '.models-subscriptions')!;
    await refreshSettings();
    expect(status().textContent).toContain('Paseo status unavailable');
    expect(status().textContent).not.toContain(page === 'agents' ? 'Ready' : 'Available to run');
    cloudAgentsPayload = { agents: [{ id: 'claude', label: 'Claude Code', enabled: false, state: 'off' }] };
    fetchMock.mockImplementation(original);
    await refreshSettings();
    expect(status().textContent).toContain('Switched off');
    expect(status().textContent).not.toContain('Paseo status unavailable');
  });

  it.each(['agents', 'models'] as const)('ignores superseded %s availability responses while preserving drafts', async page => {
    await render(page === 'agents' ? agentsPage() : modelsPage());
    const label = page === 'agents' ? 'Routing note' : 'Default model model';
    await type(label, 'example-draft');
    const field = at(label);
    const pending: ((response: Response) => void)[] = [];
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => String(input).includes('/api/cloud-agents')
      ? new Promise(resolve => { pending.push(resolve); }) : original(input, init));
    await refreshSettings();
    const status = container.querySelector(page === 'agents' ? '.agents-paseo' : '.models-subscriptions')!;
    expect(status.textContent).toContain(page === 'agents' ? 'Checking Paseo status' : 'Checking availability');
    await refreshSettings();
    expect(pending).toHaveLength(2);
    await act(async () => { pending[1]!(Response.json({ agents: [{ id: 'claude', label: 'Claude Code', enabled: false, state: 'off' }] })); });
    await act(async () => { pending[0]!(Response.json({ agents: [{ id: 'claude', label: 'Claude Code', enabled: true, state: 'ready' }] })); });
    expect(status.textContent).toContain('Switched off');
    expect(status.textContent).not.toContain(page === 'agents' ? 'Ready' : 'Available to run');
    expect(at(label)).toBe(field);
    expect((field as HTMLInputElement).value).toBe('example-draft');
  });

  it.each([{ allowlist: [] }, { allowlist: ['echo example'] }])('qualifies manual approval even with $allowlist permanently allowed commands', async ({ allowlist }) => {
    const view = (sections.safety as SettingsSectionPayload).views!.find(view => view.view === 'hermes.safety')!;
    view.values!.find(entry => entry.path.join('.') === 'approvals.mode')!.value = 'manual';
    view.values!.find(entry => entry.path.join('.') === 'command_allowlist')!.value = allowlist;
    await render(safetyPage());
    const approvals = container.querySelector('.safety-approvals')!;
    expect(approvals.textContent).toContain('guarded actions that have not already been approved');
    expect(approvals.textContent).not.toContain('Nothing guarded runs until you say yes');
  });

  it.each(['desktop', 'phone'] as const)('honors projected managed agent keys on a %s', async kind => {
    const device = kind === 'phone' ? phone : desktop;
    setState(state => ({ ...state, device }));
    sections.agents = kind === 'phone' ? await projectedPhone('agents') : sections.agents;
    const managed = (sections.safety as SettingsSectionPayload).views!.find(view => view.view === 'hermes.managed')!;
    managed.values = (await readViewValues('hermes.managed', {
      agent: { reasoning_effort: 'high' }, display: { personality: 'concise' },
      delegation: { max_concurrent_children: 10, max_iterations: 250 },
    }, { scopes: device.scopes, listener: kind === 'phone' ? 'main' : 'local', pcOnlyWrites: true }))
      .map(entry => ({ ...entry, path: [...entry.path] }));
    await render(agentsPage());
    const behaviour = container.querySelector('.agents-behaviour')!;
    expect(behaviour.textContent).toContain('Pinned by the install');
    if (kind === 'phone') expect(behaviour.textContent).toContain('effective value is unavailable');
    expect(maybeAt('Reasoning effort')).toBeNull();
    expect(maybeAt('Personality')).toBeNull();
    expect(maybeAt('Delegated chats at once')).toBeNull();
    expect(behaviour.textContent).toContain('Medium');
    expect(behaviour.textContent).toContain('2 at a time');
    expect(writes()).toEqual([]);
  });

  it.each(['max_concurrent_children', 'max_iterations'])('blocks the paired delegation editor when only %s is pinned', async key => {
    const managed = (sections.safety as SettingsSectionPayload).views!.find(view => view.view === 'hermes.managed')!;
    managed.values = [{ path: ['delegation', key], exists: true }];
    await render(agentsPage());
    expect(maybeAt('Delegated chats at once')).toBeNull();
    expect(maybeAt('Steps per delegated chat')).toBeNull();
    expect((at('Reasoning effort') as HTMLSelectElement).disabled).toBe(false);
    expect(writes()).toEqual([]);
  });

  it.each(['agents', 'models'] as const)('allows unpinned %s edits when the managed file is absent', async page => {
    const managed = (sections.safety as SettingsSectionPayload).views!.find(view => view.view === 'hermes.managed')!;
    managed.present = false;
    managed.sha256 = undefined;
    managed.values = undefined;
    await render(page === 'agents' ? agentsPage() : modelsPage());
    expect((at(page === 'agents' ? 'Reasoning effort' : 'Default model provider') as HTMLInputElement).disabled).toBe(false);
  });

  it('blocks pinned model fields on a phone without presenting user-file values as effective', async () => {
    sections.models = await projectedPhone('models');
    sections.safety = await projectedPhone('safety');
    const managed = (sections.safety as SettingsSectionPayload).views!.find(view => view.view === 'hermes.managed')!;
    managed.values = [{ path: ['model', 'default'], exists: true }];
    setState(state => ({ ...state, device: phone }));
    await render(modelsPage());
    const row = at('Default model model').closest('.kv')!;
    expect(row.textContent).toContain('Pinned by the install; the effective value is unavailable');
    expect((at('Default model model') as HTMLInputElement).value).toBe('');
    expect([...row.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')].every(control => control.disabled)).toBe(true);
    expect(writes()).toEqual([]);
  });

  it.each([
    ['model', 'provider'], ['model', 'default'], ['model', 'base_url'],
    ['delegation', 'provider'], ['delegation', 'model'],
    ['delegation', 'fallback_providers'], ['fallback_providers'],
    ['auxiliary', 'compression', 'provider'], ['auxiliary', 'compression', 'model'],
  ])('blocks the model editor containing the managed key %j', async (...path) => {
    const managed = (sections.safety as SettingsSectionPayload).views!.find(view => view.view === 'hermes.managed')!;
    managed.values = [{ path, exists: true }];
    await render(modelsPage());
    const title = path[0] === 'model' ? 'Default model' : path[0] === 'auxiliary' ? 'Helper: compression'
      : path[0] === 'fallback_providers' ? 'Main chat fallbacks'
        : path[1] === 'fallback_providers' ? 'Delegation fallbacks' : 'Delegation model';
    const row = [...container.querySelectorAll('.models-hermes .kv')].find(row => row.textContent?.includes(title))!;
    expect(row.textContent).toContain('Pinned by the install');
    expect(row.textContent).toContain('Read-only here');
    expect([...row.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')].every(control => control.disabled)).toBe(true);
    await act(async () => { row.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.click()); });
    expect(writes()).toEqual([]);
  });

  it('prevents adding over a pinned helper slot and allows an unpinned slot', async () => {
    const managed = (sections.safety as SettingsSectionPayload).views!.find(view => view.view === 'hermes.managed')!;
    managed.values = [{ path: ['auxiliary', 'compression', 'model'], exists: true }];
    await render(modelsPage());
    await choose('Helper task to set', 'approval');
    await type('Helper provider', 'example');
    await type('Helper model', 'example-helper');
    await choose('Helper task to set', 'compression');
    const save = at('Helper task to set').closest('.setting-inline')!.querySelector<HTMLButtonElement>('button')!;
    expect(save.disabled).toBe(true);
    await act(async () => { save.click(); });
    expect(writes()).toEqual([]);
    await choose('Helper task to set', 'approval');
    expect(save.disabled).toBe(false);
    await act(async () => { save.click(); });
    expect(writeBody(0)).toMatchObject({ operation: 'hermes.helper-model', params: { task: 'approval', provider: 'example', model: 'example-helper' } });
  });

  it('shows a helper slot configured only by the install as unavailable and read-only', async () => {
    const models = (sections.models as SettingsSectionPayload).views!.find(view => view.view === 'hermes.models')!;
    models.values = models.values!.filter(entry => entry.path[0] !== 'auxiliary');
    const managed = (sections.safety as SettingsSectionPayload).views!.find(view => view.view === 'hermes.managed')!;
    managed.values = [{ path: ['auxiliary', 'compression', 'model'], exists: true }];
    await render(modelsPage());
    const row = at('Helper: compression model').closest('.kv')!;
    expect(row.textContent).toContain('Pinned by the install; the effective value is unavailable');
    expect([...row.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')].every(control => control.disabled)).toBe(true);
    expect(text()).not.toContain('No helper slot is set');
  });

  it.each(['agents', 'models'] as const)('keeps %s editors read-only when the managed projection fails, then retries', async page => {
    const payload = sections.safety as SettingsSectionPayload;
    const managed = payload.views!.find(view => view.view === 'hermes.managed')!;
    payload.views = [{ ok: false, view: 'hermes.managed', code: 'unavailable' }];
    await render(page === 'agents' ? agentsPage() : modelsPage());
    const group = container.querySelector(page === 'agents' ? '.agents-behaviour' : '.models-hermes')!;
    expect(group.textContent).toContain('effective value is unavailable');
    expect([...group.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')].every(control => control.disabled)).toBe(true);
    expect(writes()).toEqual([]);
    payload.views = [managed];
    await clickText('Retry');
    expect((at(page === 'agents' ? 'Reasoning effort' : 'Default model provider') as HTMLInputElement).disabled).toBe(false);
  });

  it.each(['max_concurrent_children', 'max_iterations'])('requires an explicit absent %s before saving delegation limits', async missing => {
    const view = (sections.agents as SettingsSectionPayload).views!.find(view => view.view === 'hermes.models')!;
    view.values = view.values!.filter(entry => entry.path.join('.') !== `delegation.${missing}`);
    await render(agentsPage());
    const missingLabel = missing === 'max_iterations' ? 'Steps per delegated chat' : 'Delegated chats at once';
    const changedLabel = missing === 'max_iterations' ? 'Delegated chats at once' : 'Steps per delegated chat';
    expect((at(missingLabel) as HTMLInputElement).value).toBe('');
    expect(at(missingLabel).getAttribute('placeholder')).toBe('Hermes default');
    await type(changedLabel, missing === 'max_iterations' ? '3' : '40');
    const save = at(missingLabel).closest('.kv')!.querySelector<HTMLButtonElement>('button')!;
    expect(save.disabled).toBe(true);
    await act(async () => { save.click(); });
    expect(writes()).toEqual([]);
    await type(missingLabel, missing === 'max_iterations' ? '250' : '10');
    expect(save.disabled).toBe(false);
    await act(async () => { save.click(); });
    expect(writeBody(0)).toMatchObject({ operation: 'hermes.delegation-limits', params: {
      maxConcurrentChildren: missing === 'max_iterations' ? 3 : 10,
      maxIterations: missing === 'max_iterations' ? 250 : 40,
    } });
  });

  it('clears a delegation draft when a previously configured limit disappears', async () => {
    await render(agentsPage());
    const view = (sections.agents as SettingsSectionPayload).views!.find(view => view.view === 'hermes.models')!;
    view.values = view.values!.filter(entry => entry.path.join('.') !== 'delegation.max_iterations');
    await act(async () => { setState(state => ({ ...state, settingsVersion: state.settingsVersion + 1 })); });
    expect((at('Steps per delegated chat') as HTMLInputElement).value).toBe('');
    const save = at('Steps per delegated chat').closest('.kv')!.querySelector<HTMLButtonElement>('button')!;
    expect(save.disabled).toBe(true);
  });

  it('shows a phone the serving window separately from a smaller advertised contract', async () => {
    const payload = await projectedPhone('models');
    payload.views!.find(view => view.view === 'gateway.role-map')!.values!
      .find(entry => entry.path.join('.') === 'contracts.main.advertisedContext')!.value = 8192;
    sections.models = payload;
    setState(state => ({ ...state, device: phone }));
    await render(modelsPage());
    const row = [...container.querySelectorAll('.models-roles .kv')].find(row => row.querySelector('code')?.textContent === 'main')!;
    expect(row.textContent).toContain('window 1.0m');
    expect(row.textContent).toContain('advertised 8192 tokens');
    expect(row.textContent).toContain('The serving backend is shown on the PC');
    expect(text()).not.toContain('anthropic-main');
    expect(text()).not.toContain('example-main-model');
  });

  it.each(['desktop', 'phone'] as const)('keeps pinned safety settings read-only on a %s without claiming user-file protections', async kind => {
    setState(state => ({ ...state, device: kind === 'phone' ? phone : desktop }));
    const payload = kind === 'phone' ? await projectedPhone('safety') : sectionFor('desktop').safety as SettingsSectionPayload;
    const view = payload.views!.find(view => view.view === 'hermes.safety')!;
    view.values!.find(entry => entry.path.join('.') === 'approvals.mode')!.value = 'manual';
    view.values!.find(entry => entry.path.join('.') === 'skills.write_approval')!.value = true;
    const managed = payload.views!.find(view => view.view === 'hermes.managed')!;
    managed.values = (await readViewValues('hermes.managed', { approvals: { mode: 'off', cron_mode: 'off' }, skills: { write_approval: false }, memory: { write_approval: false }, command_allowlist: ['echo example'] }, { scopes: (kind === 'phone' ? phone : desktop).scopes, listener: kind === 'phone' ? 'main' : 'local', pcOnlyWrites: true })).map(entry => ({ ...entry, path: [...entry.path] }));
    sections.safety = payload;
    await render(safetyPage());
    const approvals = container.querySelector('.safety-approvals')!;
    expect(approvals.textContent).toContain('Pinned by the install');
    expect(approvals.textContent).toContain('Always ask before guarded actions');
    expect([...approvals.querySelectorAll<HTMLInputElement>('input')].every(input => input.disabled)).toBe(true);
    expect(approvals.textContent).not.toContain('Always ask. Nothing guarded runs until you say yes.');
    const staging = container.querySelector('.safety-staging')!;
    expect(staging.textContent).toContain('Waiting for your OK');
    expect(staging.textContent).toContain('On: Hermes holds every skill');
    expect(maybeAt('Skill changes wait for your OK')).toBeNull();
    if (kind === 'desktop') expect(at('Revoke git status').matches(':disabled')).toBe(true);
    expect(maybeAt('Revoke hidden command 1')).toBeNull();
    if (kind === 'phone') expect(staging.textContent).toContain('Memory writes: wait for your OK');
    expect(text()).toContain('Scheduled jobs answer with: deny');
    expect(writes()).toEqual([]);
  });

  it('uses the delegation view hash when another view of the same file is newer', async () => {
    setState(state => ({ ...state, device: phone }));
    sections.agents = await projectedPhone('agents');
    nextReply = { status: 200, body: confirmAnswer };
    await render(agentsPage());
    await type('Steps per delegated chat', '40');
    const row = at('Steps per delegated chat').closest('.kv')!;
    await act(async () => { row.querySelector<HTMLButtonElement>('button')!.click(); });
    expect(writeBody(0)).toMatchObject({ operation: 'hermes.delegation-limits', params: { maxConcurrentChildren: 2, maxIterations: 40 }, expected: { file: { sha256: 'b'.repeat(64) } } });
    await clickText('Confirm');
    expect(writeBody(1)).toEqual({ ...writeBody(0), confirm: confirmAnswer.confirm });
  });

  it.each(['manual', 'smart', 'off'])('describes an empty allowlist without promising approval in %s mode', async mode => {
    const view = (sections.safety as SettingsSectionPayload).views!.find(view => view.view === 'hermes.safety')!;
    view.values!.find(entry => entry.path.join('.') === 'approvals.mode')!.value = mode;
    view.values!.find(entry => entry.path.join('.') === 'command_allowlist')!.value = [];
    await render(safetyPage());
    expect(container.querySelector('.safety-always')!.textContent).toContain('Nothing is on the list.');
    expect(text()).not.toContain('Hermes asks every time');
  });

  it.each(['desktop', 'phone'] as const)('shows projected permission rules appropriately on a %s', async kind => {
    setState(state => ({ ...state, device: kind === 'phone' ? phone : desktop }));
    const payload = sections.safety as SettingsSectionPayload;
    for (const [id, document] of [
      ['claude.permissions', { permissions: { defaultMode: 'default', allow: ['Bash(echo example:*)'], deny: ['Read(./private/**)'] } }],
      ['opencode.permissions', { permission: { bash: { 'echo example': 'allow', '*': 'ask' }, edit: 'deny' } }],
    ] as const) {
      const view = payload.views!.find(view => view.view === id)!;
      Object.assign(view, { present: true, sha256: '8'.repeat(64), values: (await readViewValues(id, document, { scopes: (kind === 'phone' ? phone : desktop).scopes, listener: kind === 'phone' ? 'main' : 'local', pcOnlyWrites: true })).map(entry => ({ ...entry, path: [...entry.path] })) });
    }
    await render(safetyPage());
    const shown = container.querySelector('.safety-shown')!;
    expect(shown.querySelectorAll('input,select,button').length).toBe(0);
    if (kind === 'desktop') {
      for (const rule of ['Bash(echo example:*)', 'Read(./private/**)', 'echo example', 'ask', 'deny']) expect(shown.textContent).toContain(rule);
    } else {
      expect(shown.textContent).toContain('Claude Code permission rules are shown on the PC');
      expect(shown.textContent).toContain('OpenCode permission rules are shown on the PC');
      expect(shown.textContent).not.toContain('echo example');
      expect(shown.textContent).not.toContain('private/**');
      expect(shown.textContent).not.toContain('"sha256"');
    }
  });

  it.each([null, {}, { error: 'Something went wrong' }, { section: 'models', changes: [] }, { section: 'overview' }, { section: 'overview', changes: [{}] }, { section: 'overview', changes: [] }])('rejects a malformed or failed section response %j and offers Retry', async payload => {
    sections.overview = payload;
    sectionStatus = 500;
    await render(recentChanges());
    expect(text()).not.toContain('Nothing has been changed');
    expect(text()).toMatch(/This PC did not answer|Can't reach Wayroost/);
    sections.overview = { section: 'overview', changes: [] };
    sectionStatus = 200;
    await clickText('Retry');
    expect(text()).toContain('Nothing has been changed');
  });

  it.each([{}, { section: 'models', changes: [] }, { section: 'overview' }, { section: 'overview', changes: [{}] }])('rejects a malformed successful section response %j', async payload => {
    sections.overview = payload;
    await render(recentChanges());
    expect(text()).toContain('This PC did not answer');
    expect(text()).not.toContain('Nothing has been changed');
    await clickText('Retry');
    expect(text()).not.toContain('Nothing has been changed');
  });

  it.each(['agents', 'models', 'safety'] as const)('rejects malformed views in the %s section', async section => {
    sections[section] = { section, views: [{ ok: true, view: 'hermes.models', present: true, values: 'invalid' }], operations: [] };
    await render(section === 'agents' ? agentsPage() : section === 'models' ? modelsPage() : safetyPage());
    expect(text()).toContain('This PC did not answer');
    expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Retry')).toBe(true);
  });

  it.each(['verify_mismatch', 'restart_unverified'] as const)('retains the committed change and refreshes settings after %s', async code => {
    const committed = { ...appliedChange, target: 'hermes-config' as const, operation: 'hermes.approval-mode', effective: 'mismatch' as const };
    expect(describeApplyResponse({ status: 'refused', code, change: committed })).toMatchObject({ kind: 'refused', code, change: committed });
    await render(safetyPage());
    const before = fetchMock.mock.calls.filter(([input]) => String(input).includes('/sections/safety')).length;
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => {
      if (String(input).includes('/api/settings/apply')) {
        const view = (sections.safety as SettingsSectionPayload).views!.find(view => view.view === 'hermes.safety')!;
        view.values!.find(entry => entry.path.join('.') === 'approvals.mode')!.value = 'manual';
        view.sha256 = '3'.repeat(64);
      }
      return original(input, init);
    });
    nextReply = { status: 409, body: { status: 'refused', code, change: committed } };
    await act(async () => { container.querySelector<HTMLInputElement>('input[value="manual"]')!.click(); });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/sections/safety')).length).toBeGreaterThan(before);
    expect(container.querySelector<HTMLInputElement>('input[value="manual"]')!.checked).toBe(true);
    expect(getState().toasts.at(-1)!.text).toBe(settingsErrorText(code));
    expect(getState().toasts.at(-1)!.text).not.toContain('Applied.');
    await act(async () => { container.querySelector<HTMLInputElement>('input[value="off"]')!.click(); });
    expect(writeBody(1)).toMatchObject({ expected: { file: { sha256: '3'.repeat(64) } } });
  });

  it('lets a phone clear an unknown personality', async () => {
    setState(state => ({ ...state, device: phone }));
    sections.agents = await projectedPhone('agents');
    await render(agentsPage());
    expect((at('Personality') as HTMLSelectElement).value).toBe('__hidden__');
    await choose('Personality', '');
    expect(writeBody(0)).toMatchObject({ operation: 'hermes.personality', params: { personality: '' }, expected: { file: { sha256: 'a'.repeat(64) } } });
  });

  it.each(['Delegation fallbacks', 'Main chat fallbacks'])('lets a phone explicitly clear hidden %s with confirmation', async title => {
    setState(state => ({ ...state, device: phone }));
    const payload = await projectedPhone('models');
    if (title === 'Main chat fallbacks') payload.views!.find(view => view.view === 'hermes.models')!.values!.push({ path: ['fallback_providers'], exists: true, value: { sha256: '9'.repeat(64), length: 80 } });
    sections.models = payload;
    nextReply = { status: 200, body: confirmAnswer };
    await render(modelsPage());
    await press(`Clear ${title}`);
    expect(writeBody(0)).toMatchObject({ operation: title === 'Delegation fallbacks' ? 'hermes.delegation-fallbacks' : 'hermes.main-fallbacks', params: { chain: [] }, expected: { file: { sha256: 'b'.repeat(64) } } });
    await clickText('Confirm');
    expect(writeBody(1)).toEqual({ ...writeBody(0), confirm: confirmAnswer.confirm });
  });

  it('treats an empty edited draft as a change when the fallback baseline is hidden', async () => {
    setState(state => ({ ...state, device: phone }));
    sections.models = await projectedPhone('models');
    await render(modelsPage());
    const row = [...container.querySelectorAll('.models-hermes > .kv')].find(row => row.textContent?.includes('Delegation fallbacks'))!;
    await act(async () => { [...row.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Add a step')!.click(); });
    await press('Remove Delegation fallbacks step 1');
    const save = [...row.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Save chain'))!;
    expect(save.disabled).toBe(false);
    await act(async () => { save.click(); });
    expect(writeBody(0)).toMatchObject({ params: { chain: [] } });
  });

  it('focuses Cancel, traps Tab, restores focus and dismisses confirmation on Escape', async () => {
    nextReply = { status: 200, body: confirmAnswer };
    await render(agentsPage());
    const trigger = at('Reasoning effort');
    trigger.focus();
    await choose('Reasoning effort', 'high');
    const dialog = container.querySelector<HTMLElement>('[role="alertdialog"]')!;
    const [cancel, confirm] = [...dialog.querySelectorAll<HTMLButtonElement>('button')];
    expect(document.activeElement).toBe(cancel);
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => [{ width: 1, height: 1 }] as unknown as DOMRectList);
    const reverseTab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    cancel!.dispatchEvent(reverseTab);
    expect(reverseTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(confirm);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    confirm!.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancel);
    await act(async () => { cancel!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(writes().length).toBe(1);
    vi.restoreAllMocks();
  });

  it.each([0, 1, 2])('counts only the %i existing managed keys in a complete projection', async count => {
    const managed = (sections.safety as SettingsSectionPayload).views!.find(view => view.view === 'hermes.managed')!;
    managed.values = (await readViewValues('hermes.managed', count === 0 ? {} : { agent: { reasoning_effort: 'high' }, ...(count === 2 ? { display: { personality: 'helpful' } } : {}) }, { scopes: desktop.scopes, listener: 'local', pcOnlyWrites: true })).map(entry => ({ ...entry, path: [...entry.path] }));
    await render(safetyPage());
    const shown = container.querySelector('.safety-shown')!.textContent!;
    if (count === 0) expect(shown).not.toContain('key name');
    else expect(shown).toContain(`${count} key name${count === 1 ? '' : 's'} the install pins`);
  });

  it('keeps key drafts and Save buttons separate for each provider', async () => {
    await render(modelsPage());
    await type('Key for anthropic', 'fake-anthropic-key');
    expect((at('Key for openrouter') as HTMLInputElement).value).toBe('');
    expect((at('Save key for openrouter') as HTMLButtonElement).disabled).toBe(true);
    await type('Key for openrouter', 'fake-openrouter-key');
    await press('Save key for anthropic');
    expect((at('Key for anthropic') as HTMLInputElement).value).toBe('');
    expect((at('Key for openrouter') as HTMLInputElement).value).toBe('fake-openrouter-key');
    await press('Save key for openrouter');
    const calls = sent.filter(call => call.url.includes('/credentials/'));
    expect(calls.map(call => JSON.parse(String(call.init?.body)))).toEqual([{ secret: 'fake-anthropic-key' }, { secret: 'fake-openrouter-key' }]);
  });

  it.each(['pending', 'partial'] as const)('shows the complete %s worker policy and failed reload', async application => {
    workerPayload = { ...pendingWorkerApprovals(), application, reload: 'failed', uncoveredProviders: ['example-provider'] };
    await render(safetyPage());
    expect(text()).toContain('Default choice: On');
    expect(text()).toContain(application === 'pending' ? 'Protection: not verified' : 'Protection: partial');
    expect(text()).toContain('reload: failed');
    expect(text()).toContain('Not covered: example-provider');
    expect(text()).toContain('Agents already running keep their old limits');
    expect(text()).toContain('CLI guard is not installed');
    expect(text()).toContain('policy has not been confirmed');
    expect(text()).not.toContain('Always on once');
  });

  it('binds a save and its confirm resend to the version displayed on the page', async () => {
    setState(state => ({ ...state, device: phone }));
    sections.models = await projectedPhone('models');
    nextReply = { status: 200, body: confirmAnswer };
    await render(modelsPage());
    await choose('Backend for the coder role', (await digest('anthropic-main')).slice(0, 63));
    await clickText('Point coder');
    expect(writeBody(0)).toMatchObject({ params: { role: 'coder', backend: (await digest('anthropic-main')).slice(0, 63) }, expected: { file: { sha256: 'd'.repeat(64) } } });
    await clickText('Confirm');
    expect(writeBody(1)).toEqual({ ...writeBody(0), confirm: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA' });
  });

  it('offers Hermes built-ins and configured names but never invented names', async () => {
    const payload = sections.agents as SettingsSectionPayload;
    payload.personalities = [{ id: '', label: 'Default' }, { id: 'concise', label: 'concise' }, { id: 'example-persona', label: 'example-persona' }];
    await render(agentsPage());
    const options = [...(at('Personality') as HTMLSelectElement).options];
    expect(options.map(option => option.value)).toContain('example-persona');
    expect(options.map(option => option.value)).not.toContain('friendly');
    await choose('Personality', 'example-persona');
    expect(writeBody(0)).toMatchObject({ operation: 'hermes.personality', params: { personality: 'example-persona' } });
  });

  it('uses a sibling profile id from an array projection', async () => {
    await render(agentsPage());
    await type('Model for profile paseo-coder', 'pi/demo-new');
    await press('Save profile paseo-coder');
    expect(writeBody(0)).toMatchObject({ operation: 'paseo.profile-model', params: { profile: 'paseo-coder', model: 'pi/demo-new' }, expected: { file: { sha256: 'c'.repeat(64) } } });
  });

  it('sends the existing helper task in a schema-valid save', async () => {
    await render(modelsPage());
    await type('Helper: compression model', 'demo-new-helper');
    const row = at('Helper: compression model').closest('.kv')!;
    await act(async () => { row.querySelector<HTMLButtonElement>('button')!.click(); });
    const body = writeBody(0);
    expect(body).toMatchObject({ operation: 'hermes.helper-model', params: { task: 'compression', provider: 'anthropic', model: 'demo-new-helper' } });
    expect(parseOperation(body.operation, body.params, 'server').ok).toBe(true);
  });

  it('treats an absent provider flag as on and toggles it off', async () => {
    const payload = sections.agents as SettingsSectionPayload;
    const view = payload.views!.find(view => view.view === 'paseo.agents')!;
    view.values = view.values!.filter(entry => entry.path.join('.') !== 'agents.providers.claude.enabled');
    await render(agentsPage());
    expect(at('Claude Code').getAttribute('aria-checked')).toBe('true');
    await press('Claude Code');
    expect(writeBody(0)).toMatchObject({ params: { provider: 'claude', enabled: false } });
  });

  it('keeps failed provider reads unknown and removes write controls', async () => {
    const payload = sections.agents as SettingsSectionPayload;
    Object.assign(payload.views!.find(view => view.view === 'paseo.agents')!, { ok: false, code: 'unavailable' });
    await render(agentsPage());
    expect(maybeAt('Claude Code')).toBeNull();
    expect(text()).toContain('This PC did not answer');
    expect(text()).not.toContain('No profile is saved');
  });

  it('does not infer installation or authentication from missing ready options', async () => {
    (sections.models as SettingsSectionPayload).agentAvailability = undefined;
    await render(modelsPage());
    expect(text()).toContain('Installation unknown');
    expect(text()).toContain('Sign-in status unknown');
    expect(text()).not.toContain('Not installed');
    expect(text()).not.toContain('Signed out');
    expect(sent.some(call => call.url.includes('/paseo/options'))).toBe(false);
  });

  it('disables every model editor when operation access is read-only', async () => {
    const payload = sections.models as SettingsSectionPayload;
    for (const operation of payload.operations!) operation.access = 'read-only';
    await render(modelsPage());
    for (const selector of ['.models-hermes input', '.models-hermes select', '.models-hermes button']) {
      for (const control of container.querySelectorAll<HTMLInputElement>(selector)) expect(control.disabled, control.getAttribute('aria-label') ?? control.textContent ?? '').toBe(true);
    }
    await press('Helper task to set');
    expect(writes()).toEqual([]);
  });

  it('lets a phone revoke a redacted command using only its hash', async () => {
    setState(state => ({ ...state, device: phone }));
    sections.safety = await projectedPhone('safety');
    await render(safetyPage());
    expect(text()).not.toContain('git status');
    await press('Revoke hidden command 1');
    expect(writeBody(0)).toMatchObject({ operation: 'hermes.revoke-always', params: { entrySha256: await digest('git status') }, expected: { file: { sha256: 'f'.repeat(64) } } });
  });

  it('keeps usage for two backends serving the same role distinct', async () => {
    const row = { role: 'main', requests: 1, errors: 0, inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 };
    usagePayload = { ok: true, generatedAt: 0, windows: [{ id: 'today', since: 0, rows: [
      { ...row, backend: 'example-a', backendModel: 'demo-a', estimatedCostUsd: 1 },
      { ...row, backend: 'example-b', backendModel: 'demo-b', estimatedCostUsd: 2 },
    ] }, { id: 'week', since: 0, rows: [] }] };
    await render(modelsPage());
    const rows = [...container.querySelectorAll('.models-usage .kv')];
    expect(rows.find(row => row.textContent?.includes('example-a'))?.textContent).toContain('1 req · 15 tok · $1.00');
    expect(rows.find(row => row.textContent?.includes('example-b'))?.textContent).toContain('1 req · 15 tok · $2.00');
    expect(text()).toContain('2 req · 30 tok · $3.00');
  });

  it('shows measured role composition against its target and budget', async () => {
    (sections.agents as SettingsSectionPayload).roleLoads = [{ role: 'example-role', harness: 'hermes', words: 120, tokens: 180, targetWords: 100, budgetWords: 150, parts: { shared: 20, dispatch: 10, role: 50, skills: 40 } }];
    await render(agentsPage());
    expect(text()).toContain('example-role · hermes');
    expect(text()).toContain('120 words · 180 estimated tokens · target 100 · budget 150');
    expect(text()).toContain('Shared rules 20 · dispatch 10 · role 50 · skills 40 words');
    expect(text()).toContain('Above target');
  });

  it.each(['overview', 'models', 'agents', 'safety'] as const)('shows a refused %s read and retries instead of looking empty', async section => {
    sections[section] = { status: 'refused', code: 'not_permitted' };
    await render(section === 'overview' ? recentChanges() : section === 'models' ? modelsPage() : section === 'agents' ? agentsPage() : safetyPage());
    expect(text()).toContain('This device may not make this change');
    expect(text()).not.toContain('Nothing has been changed');
    sections[section] = section === 'overview' ? { section, changes: [] } : sectionFor('desktop')[section];
    for (const retry of [...container.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent === 'Retry')) {
      await act(async () => { retry.click(); });
    }
    expect(text()).not.toContain('This device may not make this change');
  });

  it('shows initial loading separately from an empty change journal', async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
    await render(recentChanges());
    expect(text()).toContain('Reading settings');
    expect(text()).not.toContain('Nothing has been changed');
    await act(async () => { resolve(Response.json({ section: 'overview', changes: [] })); });
    expect(text()).toContain('Nothing has been changed');
  });

  it('disables phone Undo for PC-only restorations, including an Anywhere revoke', async () => {
    setState(state => ({ ...state, device: phone }));
    sections.overview = { section: 'overview', changes: [{ id: 'ch_000000000000000000000001', at: 0, action: 'apply', operation: 'hermes.revoke-always', target: 'hermes-config', keys: [], level: 'anywhere', timing: [{ label: 'now' }], result: 'ok', undoable: true, undoAccess: 'read-only' }] };
    await render(recentChanges());
    const button = at('Undo Revoke an "always" entry') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await press('Undo Revoke an "always" entry');
    expect(writes()).toEqual([]);
  });

  it('labels loosening approval modes PC-only on a permitted desktop', async () => {
    await render(safetyPage());
    for (const mode of ['smart', 'off']) {
      const label = container.querySelector(`input[value="${mode}"]`)!.closest('label')!;
      expect(label.querySelector<HTMLElement>('.level-chip')!.dataset.level).toBe('pc-only');
    }
  });

  it('explains both conditional timings for the default model', () => {
    const timing = timingSentence([{ surface: 'app-chats', label: 'next-turn', when: 'model-or-provider-changed' }, { surface: 'app-chats', label: 'next-chat', when: 'base-url-only' }]);
    expect(timing).toContain('the next message when the model or provider changes');
    expect(timing).toContain('the next chat when only the address changes');
  });
});


describe('settings integration flows', () => {
  beforeEach(() => {
    sections = sectionFor('desktop');
    (sections.safety as SettingsSectionPayload).views!.find(view => view.view === 'hermes.managed')!.values = [];
  });
  afterEach(() => vi.useRealTimers());
  const running = (): DrainRestartRun => ({ id: '00000000-0000-4000-8000-000000000001', component: 'hermes', when: 'idle', state: 'waiting',
    startedAt: 1, attempts: 0, probeAttempts: 0, busy: ['call'], protocol: 1 });

  it.each([...OWNER_FILE_TARGETS, ...ROOT_TARGETS])('sends the exact accept-current request for %s even with no target view', async target => {
    sections.checks = { section: 'checks', rollout: { settingsPages: true, revokes: true, chatFirst: true }, views: [], operations: [{ operation: 'settings.accept-current', title: 'Accept the current file as is', access: 'editable' }] };
    nextReply = { status: 200, body: confirmAnswer };
    const id = 'settings.blocked-' + target;
    await render(h(CheckRows, { rows: [{ id, state: 'fail', sentence: 'Accept the current file as is',
      fix: { operation: 'settings.accept-current', params: { target, change: 'ch_' + 'a'.repeat(24) } } }], read: { status: 'ready', reload() {} }, refresh() {} }));
    await press('Fix ' + id);
    expect(writeBody(0)).toEqual({ operation: 'settings.accept-current', params: { target, change: 'ch_' + 'a'.repeat(24) } });
    await clickText('Confirm');
    expect(writeBody(1)).toEqual({ ...writeBody(0), confirm: confirmAnswer.confirm });
  });

  it.each(['completed', 'refused'] as const)('follows accepted restarts through status-only reads to %s without losing tracking during refresh', async terminal => {
    vi.useFakeTimers(); const run = running();
    const original = fetchMock.getMockImplementation()!; let polls = 0;
    fetchMock.mockImplementation((input, init) => {
      if (!String(input).startsWith('/api/settings/restart')) return original(input, init);
      if (init?.method === 'POST') return Promise.resolve(Response.json({ status: 'accepted', run, timing: [{ label: 'restart-when-idle:hermes' }] }, { status: 202 }));
      polls++;
      return Promise.resolve(polls === 1 ? Response.json({ status: 'accepted', run }) : Response.json(terminal === 'completed'
        ? { status: 'completed', run: { ...run, busy: [], state: 'done', outcome: 'restarted', endedAt: 2 } }
        : { status: 'refused', code: 'still_busy', run: { ...run, state: 'still-busy', outcome: 'still_busy', endedAt: 2 } }, { status: terminal === 'refused' ? 409 : 200 }));
    });
    await render(h(SettingsRestart, { component: 'hermes' }));
    await clickText('Restart when idle');
    expect(text()).toContain('State: waiting');
    await act(async () => { root!.render(h(SettingsRestart, { component: 'hermes', disabled: true, refreshing: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(text()).toContain('State: waiting');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(text()).toContain(terminal === 'completed' ? 'Restart completed' : 'still-busy');
    const count = polls;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(polls).toBe(count);
  });

  it.each(['completed', 'accepted', 'refused'] as const)('accepts a %s restart POST response', async status => {
    const run = running(); const original = fetchMock.getMockImplementation()!;
    const body = status === 'accepted' ? { status } : status === 'completed'
      ? { status, run: { ...run, busy: [], state: 'done', outcome: 'restarted', endedAt: 2 } }
      : { status, code: 'still_busy', run: { ...run, state: 'still-busy', outcome: 'still_busy', endedAt: 2 } };
    fetchMock.mockImplementation((input, init) => String(input).includes('/api/settings/restart') ? Promise.resolve(Response.json(body, { status: status === 'refused' ? 409 : 200 })) : original(input, init));
    await render(h(SettingsRestart, { component: 'hermes' }));
    await clickText('Restart when idle');
    expect(text()).not.toContain('did not answer');
    expect(text()).toContain(status === 'accepted' ? 'Restart accepted' : status === 'completed' ? 'Restart completed' : 'still-busy');
  });

  it('waits for an automatically scheduled revoke run to end before confirming Restart now', async () => {
    vi.useFakeTimers();
    const run = running(); (sections.safety as SettingsSectionPayload).restartRuns = [run];
    const original = fetchMock.getMockImplementation()!; const requests: unknown[] = [];
    let finished = false;
    let unavailable = false;
    fetchMock.mockImplementation((input, init) => {
      if (!String(input).includes('/api/settings/restart')) return original(input, init);
      if (init?.method !== 'POST') return Promise.resolve(Response.json(unavailable ? { status: 'refused', code: 'unavailable' } : finished
        ? { status: 'refused', code: 'still_busy', run: { ...run, state: 'still-busy', outcome: 'still_busy', endedAt: 2 } }
        : { status: 'accepted', run }));
      requests.push(JSON.parse(String(init?.body)));
      return Promise.resolve(Response.json({ status: 'completed', run: { ...run, when: 'now', busy: [], state: 'done', outcome: 'restarted', endedAt: 2 } }));
    });
    await render(safetyPage());
    expect(text()).toContain('State: waiting'); expect(text()).toContain('call');
    const now = [...container.querySelectorAll('button')].find(button => button.textContent === 'Restart now')!;
    expect(now.closest('.setting-inline')!.querySelector('[data-level="confirm"]')).toBeTruthy();
    expect(now.disabled).toBe(true);
    await act(async () => now.click()); expect(requests).toEqual([]);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(now.disabled).toBe(true);
    unavailable = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(now.disabled).toBe(true);
    expect(text()).toContain('The restart status could not be read');
    unavailable = false;
    finished = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(text()).toContain('still-busy');
    expect(now.disabled).toBe(false);
    await act(async () => now.click()); expect(requests).toEqual([]);
    await clickText('Confirm'); expect(requests).toEqual([{ component: 'hermes', when: 'now' }]);
  });

  it('offers a confirmed Restart now when returning to Safety after a revoke timeout', async () => {
    const run: DrainRestartRun = { ...running(), state: 'still-busy', outcome: 'still_busy', endedAt: 2 };
    (sections.safety as SettingsSectionPayload).restartRuns = [run];
    const original = fetchMock.getMockImplementation()!; const requests: unknown[] = [];
    fetchMock.mockImplementation((input, init) => {
      if (!String(input).includes('/api/settings/restart')) return original(input, init);
      requests.push(JSON.parse(String(init?.body)));
      return Promise.resolve(Response.json({ status: 'completed', run: { ...run, id: '00000000-0000-4000-8000-000000000009', startedAt: run.startedAt + 5, when: 'now', busy: [], state: 'done', outcome: 'restarted', endedAt: run.startedAt + 6 } }));
    });
    await render(safetyPage());
    expect(text()).toContain('still-busy');
    await clickText('Restart now'); expect(requests).toEqual([]);
    await clickText('Confirm'); expect(requests).toEqual([{ component: 'hermes', when: 'now' }]);
    expect(text()).toContain('Restart completed');
  });

  it.each(['set', 'remove'] as const)('offers gateway restart choices after a credential %s', async action => {
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => String(input).includes('/api/settings/credentials/')
      ? Promise.resolve(Response.json({ status: 'applied', timing: [{ label: 'restart-when-idle:gateway' }] })) : original(input, init));
    await render(modelsPage());
    if (action === 'set') { await type('Key for anthropic', 'fake-example-key'); await press('Save key for anthropic'); }
    else await act(async () => [...at('Key for anthropic').closest('.kv')!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Remove')!.click());
    const row = container.querySelector('.models-keys')!;
    expect(row.textContent).toContain('Restart when idle'); expect(row.textContent).toContain('Restart now');
    expect(row.querySelector('[data-level="confirm"]')).toBeTruthy();
  });

  it.each([
    ['credential_missing', 'No key is stored'],
    ['credential_rejected', 'The provider refused the stored key'],
    ['backend_unavailable', 'The backend did not answer'],
    ['test_failed', 'The test request failed'],
  ])('shows the bounded %s probe result and keeps key writes available', async (code, message) => {
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => String(input).endsWith('/credentials/anthropic/test')
      ? Promise.resolve(Response.json({ status: 'refused', code, test: { ok: false, code } }, { status: 409 })) : original(input, init));
    await render(modelsPage()); await type('Key for anthropic', 'fake-example-key');
    const row = at('Key for anthropic').closest('.kv')!;
    await act(async () => [...row.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Test')!.click());
    expect(text()).toContain(message);
    expect((at('Key for anthropic') as HTMLInputElement).value).toBe('fake-example-key');
    expect((at('Save key for anthropic') as HTMLButtonElement).disabled).toBe(false);
    expect([...row.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Remove')!.disabled).toBe(false);
  });

  it.each(['wayroost.safety-commands', 'paseo.worker-approvals', 'paseo.provider-enabled'])('uses the legacy writer and effective status for %s without unrelated file reads', async operation => {
    const isAgent = operation === 'paseo.provider-enabled'; const section = sections[isAgent ? 'agents' : 'safety'] as SettingsSectionPayload;
    section.legacyRoutesViaPipeline = false;
    section.operations!.find(entry => entry.operation === operation)!.writer = 'legacy';
    const view = operation === 'wayroost.safety-commands' ? 'wayroost.settings' : 'paseo.agents';
    const fileSection = sections[isAgent || operation === 'paseo.worker-approvals' ? 'agents' : 'safety'] as SettingsSectionPayload;
    fileSection.views = fileSection.views!.map(entry => entry.view === view ? { view, ok: false, code: 'unavailable' } : entry);
    cloudAgentsPayload = { agents: ['claude', 'codex', 'opencode'].map(id => ({ id, label: id, enabled: false, state: 'off' })) };
    workerPayload = { ...pendingWorkerApprovals(), enabled: false };
    const endpoint = operation === 'wayroost.safety-commands' ? '/api/safety-commands' : operation === 'paseo.worker-approvals' ? '/api/worker-approvals' : '/api/cloud-agents/claude';
    const original = fetchMock.getMockImplementation()!; const writes: { url: string; body: unknown }[] = [];
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === '/api/safety-commands') {
        if (init?.method === 'PUT') writes.push({ url: String(input), body: JSON.parse(String(init.body)) });
        return Promise.resolve(Response.json({ enabled: true, commands: ['status'] }));
      }
      if (String(input) === endpoint && init?.method === 'PUT') { writes.push({ url: String(input), body: JSON.parse(String(init.body)) }); }
      return original(input, init);
    });
    await render(isAgent ? agentsPage() : safetyPage());
    const label = isAgent ? 'Claude Code' : operation === 'wayroost.safety-commands' ? 'Hermes safety commands' : "Workers' approvals come to me";
    expect(at(label).getAttribute('aria-checked')).toBe(operation === 'wayroost.safety-commands' ? 'true' : 'false');
    expect(at(label).matches(':disabled')).toBe(false);
    await press(label);
    expect(writes).toEqual([{ url: endpoint, body: { enabled: operation !== 'wayroost.safety-commands' } }]);
    expect(sent).toEqual([]);
  });
});
