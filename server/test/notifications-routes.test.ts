import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as promises from 'node:fs/promises';
import type { ServerEvent } from '../../shared/protocol.js';
import { DEFAULT_NOTIFICATION_RULES, SETTINGS_API } from '../../shared/settings.js';
import { currentConfigVerbs, type DrainRestartRequest } from '../../shared/supervisor-config.js';
import { BackgroundGate } from '../src/background.js';
import { Feed } from '../src/feed/service.js';
import { FeedStore } from '../src/feed/store.js';
import type { PushSender } from '../src/feed/push.js';
import { NotificationSettingsStore, WAYROOST_SETTINGS_AUDIT_DIR, WAYROOST_SETTINGS_FILE } from '../src/notifications/settings.js';
import { Notifications } from '../src/notifications/service.js';
import type { AppDeps } from '../src/app.js';
import { SafetyCommandsSetting } from '../src/hermes/safety.js';
import { WorkerApprovalsSetting, type SafetyDaemon } from '../src/paseo/safety-setting.js';
import { APPROVAL_TOOLS, applyApprovalsToMe, withRoleProviders } from '../src/paseo/safety-config.js';
import { FakeSettingsSupervisor } from './fake-settings-supervisor.js';
import { buildApp, changeRoutes } from '../src/app.js';
import { EventHub } from '../src/hub.js';
import { DESKTOP_COOKIE, PHONE_COOKIE, TEST_PHONE, apiHeaders, makeApp, makeKeys, makeToken, postHeaders, seedDevices } from './helpers.js';

// Notification settings routes: what a settings page reads and writes, who may write it, and what
// happens to everything else that reads the same hours and switches.

const quietLog = { info() {}, warn() {}, error() {} };
const NOON = () => new Date('2026-10-02T12:00:00Z').getTime();
const roots: string[] = [];
const apps: Awaited<ReturnType<typeof makeApp>>['app'][] = [];
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});
const actualPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
beforeEach(() => {
  // Fixtures model a trusted root on hosts with mapped mount ownership.
  vi.mocked(promises.lstat).mockImplementation(async (path, options) => {
    const stat = await actualPromises.lstat(path, options);
    if (String(path) === '/') stat.uid = typeof stat.uid === 'bigint' ? 0n : 0;
    return stat;
  });
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ROUTE = SETTINGS_API.notifications;
const body = (extra: Record<string, unknown> = {}) => ({
  rules: [{ event: 'agent-finished', source: 'hermes', delivery: 'toast' }],
  quietHours: { start: '22:00', end: '06:30' },
  push: { approvals: true, cards: true },
  ...extra,
});

describe('production event delivery', () => {
  it.each(['applied', 'confirm', 'refused', 'outcome_unknown', 'failed', 'accepted'].flatMap(status =>
    [false, true].map(sent => ({ status, sent }))))('alerts only for an applied result (status=$status, sent=$sent)', async ({ status, sent }) => {
    const t = await routeFixture();
    const alert = vi.spyOn(t.notifications, 'alert');
    t.app.post('/api/settings', async (_request, reply) => sent ? reply.send({ status }) : { status });
    const response = await t.app.inject({ method: 'POST', url: '/api/settings', headers: postHeaders(t.token), payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status });
    expect(alert.mock.calls.filter(([message]) => message.event === 'settings-applied'))
      .toHaveLength(status === 'applied' ? 1 : 0);
    expect(alert.mock.calls.filter(([message]) => message.title === 'A change applied'))
      .toHaveLength(status === 'applied' ? 1 : 0);
    expect(alert.mock.calls.filter(([message]) => message.event === 'settings-failed'))
      .toHaveLength(['refused', 'outcome_unknown', 'failed'].includes(status) ? 1 : 0);
  });

  it('does not announce a phone restart while confirmation or execution is pending', async () => {
    const supervisor = new FakeSettingsSupervisor();
    const drainRestart = vi.fn(async (request: DrainRestartRequest) => ({ ok: true as const, run: { id: request.requestId,
      component: 'hermes' as const, when: 'now' as const, state: 'waiting' as const, startedAt: 0, attempts: 0, busy: [] } }));
    Object.assign(supervisor, { drainRestart });
    const t = await routeFixture({ supervisor });
    const alert = vi.spyOn(t.notifications, 'alert');
    const request = (confirm?: string) => t.app.inject({ method: 'POST', url: '/api/settings/restart',
      headers: postHeaders(t.token, { cookie: PHONE_COOKIE }), payload: { component: 'hermes', when: 'now', ...(confirm ? { confirm } : {}) } });
    const challenge = await request();
    expect(challenge.statusCode).toBe(200);
    expect(challenge.json().status).toBe('confirm');
    expect(drainRestart).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    const accepted = await request(challenge.json().confirm);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe('accepted');
    expect(drainRestart).toHaveBeenCalledOnce();
    expect(alert).not.toHaveBeenCalled();
  });

  it('does not announce an unauthenticated request as a failed setting change', async () => {
    const t = await routeFixture();
    const alert = vi.spyOn(t.notifications, 'alert');
    const handler = vi.fn(async () => ({ status: 'applied' }));
    t.app.post('/api/settings', handler);
    const response = await t.app.inject({ method: 'POST', url: '/api/settings', headers: postHeaders(t.token, { cookie: '' }), payload: {} });
    expect(response.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it('binds push devices and serves phone setup with Feed disabled', async () => {
    const t = await routeFixture({ feedEnabled: false });
    const key = await t.app.inject({ method: 'GET', url: '/api/push/key', headers: apiHeaders(t.token) });
    expect(key.statusCode).toBe(200); expect(key.json()).toEqual({ publicKey: 'demo-key' });
    t.hub.publish({ type: 'approval_upsert', approval: { id: 'demo-approval', source: 'hermes', conversationId: 'demo-chat',
      kind: 'permission', title: 'An answer is needed', options: [], createdAt: 1 } });
    expect(t.pushes).toHaveLength(1);
    expect(t.events.filter((event) => event.type === 'notification')).toHaveLength(1);
  });
  it('saves shared hours and phone switches independently of rules with Feed disabled', async () => {
    const t = await routeFixture({ feedEnabled: false });
    expect((await t.put(body())).statusCode).toBe(200);
    expect((await t.put({ quietHours: null })).statusCode).toBe(200);
    expect(t.read()).toMatchObject({ quietHours: null, rules: body().rules, push: body().push });
    expect((await t.put({ push: { approvals: false, cards: true } })).statusCode).toBe(200);
    expect(t.read()).toMatchObject({ quietHours: null, rules: body().rules, push: { approvals: false, cards: true } });
  });
  it('routes approvals, questions, finished runs and failed runs without Feed', async () => {
    const t = await routeFixture({ feedEnabled: false });
    t.notifications.bindPresence(() => [{ device: 'dv_desktop', kind: 'desktop', state: 'active', at: NOON() }]);
    for (const kind of ['permission', 'question'] as const) t.hub.publish({ type: 'approval_upsert', approval: {
      id: `demo-${kind}`, source: 'hermes', conversationId: 'demo-chat', title: 'An answer is needed', kind, options: [], createdAt: 1,
    } });
    const conversation = { source: 'paseo' as const, id: 'demo-chat', title: 'Demo task', status: 'running' as const, updatedAt: 1, pendingApprovals: 0 };
    t.hub.publish({ type: 'conversation_upsert', conversation });
    t.hub.publish({ type: 'conversation_upsert', turnOutcome: 'complete', conversation: { ...conversation, status: 'idle' } });
    t.hub.publish({ type: 'conversation_upsert', conversation: { ...conversation, status: 'idle' } });
    t.hub.publish({ type: 'conversation_upsert', turnOutcome: 'error', conversation: { ...conversation, status: 'error' } });
    expect(t.events.filter((event) => event.type === 'notification').map((event) => event.notification.event))
      .toEqual(['agent-needs-you', 'agent-needs-you', 'agent-finished', 'agent-error']);
    expect(t.pushes).toEqual([]);
  });

  it('routes security cards and settings outcomes without treating pending application as a mismatch', async () => {
    const status = { enabled: true, application: 'pending' as const, config: 'written' as const, reload: 'pending' as const,
      choiceConfirmed: true, uncoveredProviders: [], limitations: [] };
    const t = await routeFixture({ workerApprovals: { status: async () => status, setEnabled: async () => status } });
    t.notifications.bindPresence(() => [{ device: 'dv_desktop', kind: 'desktop', state: 'active', at: NOON() }]);
    expect((await t.put(body({ rules: [{ event: 'security-card', source: '*', delivery: 'toast' },
      { event: 'settings-applied', source: '*', delivery: 'toast' }, { event: 'settings-failed', source: '*', delivery: 'toast' },
      { event: 'mismatch-warning', source: '*', delivery: 'toast' }] }))).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/worker-approvals', headers: apiHeaders(t.token) })).statusCode).toBe(200);
    await t.app.inject({ method: 'GET', url: '/api/worker-approvals', headers: apiHeaders(t.token) });
    expect((await t.put(body({ rules: [{ event: 'agent-needs-you', source: '*', delivery: 'neither' }] }))).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/devices/${TEST_PHONE.id}`, headers: postHeaders(t.token, { cookie: DESKTOP_COOKIE }), payload: {} })).statusCode).toBe(200);
    expect(t.events.filter((event) => event.type === 'notification').map((event) => event.notification.event))
      .toEqual(['settings-applied', 'settings-failed', 'security-card']);
  });
});

describe('worker approvals writer', () => {
  it.each([true, false].flatMap(enabled =>
    [true, false].map(wired => ({ enabled, wired }))))('returns the missing-helper error for enabled=$enabled with notifications wired=$wired', async ({ enabled, wired }) => {
    const supervisor = new FakeSettingsSupervisor();
    supervisor.status.mockResolvedValue({ overall: 'ok', sentence: 'Ready', components: [], at: 0, configVerbs: currentConfigVerbs(false) });
    const t = await routeFixture({ supervisor, wired });
    const alert = wired ? vi.spyOn(t.notifications, 'alert') : undefined;
    expect((await t.app.inject({ url: '/api/worker-approvals', headers: apiHeaders(t.token) })).json())
      .toMatchObject({ enabled: true, application: 'pending', config: 'pending' });
    const response = await t.app.inject({ method: 'PUT', url: '/api/worker-approvals', headers: postHeaders(t.token), payload: { enabled } });
    expect(response.statusCode).toBe(424);
    expect(response.json()).toEqual({ error: 'The Safety helper is not configured.' });
    expect(supervisor.configApply).not.toHaveBeenCalled();
    if (alert) expect(alert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: 'settings-failed', source: 'paseo' }));
  });

  it.each(['body check', 'later hook'])('retains the settings refusal when the device is lost during the %s', async stage => {
    const supervisor = new FakeSettingsSupervisor();
    const t = await routeFixture({ supervisor });
    const forget = () => { vi.spyOn(t.devices!, 'get').mockReturnValue(undefined); };
    if (stage === 'body check') forget();
    else t.app.addHook('preHandler', async () => { await Promise.resolve(); forget(); });
    const response = await t.app.inject({ method: 'PUT', url: '/api/worker-approvals', headers: postHeaders(t.token), payload: { enabled: false } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ status: 'refused', code: 'not_permitted' });
    expect(supervisor.configApply).not.toHaveBeenCalled();
  });

  it.each([true, false])('saves enabled=%s through the helper and retains it after restart', async enabled => {
    mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
    const root = mkdtempSync(join(process.cwd(), '.tmp', 'approvals-route-'));
    roots.push(root);
    const configPath = join(root, 'paseo-test.json');
    const statePath = join(root, 'worker-approvals.json');
    const baseline = withRoleProviders({ pi: { paseoTools: { disabledTools: ['kill_agent'] } } });
    const on = applyApprovalsToMe(baseline);
    writeFileSync(configPath, JSON.stringify({ unrelated: 'demo-original', agents: { providers: enabled ? baseline : on.providers } }), { mode: 0o600 });
    writeFileSync(statePath, JSON.stringify({ version: 1, enabled: !enabled, backup: enabled ? {} : on.backup, reloadPending: true }), { mode: 0o600 });
    const read = () => JSON.parse(readFileSync(configPath, 'utf8'));
    const daemon: SafetyDaemon = {
      providers: vi.fn(async () => ['pi']), effectiveProviders: vi.fn(async () => read().agents.providers),
      reload: vi.fn(async () => ({ appliedPaths: ['agents.providers'], restartRequiredPaths: [], overrideControlledPaths: [] })),
    };
    const helper = new WorkerApprovalsSetting(configPath, root, daemon);
    const write = vi.spyOn(helper, 'setEnabled');
    const supervisor = new FakeSettingsSupervisor();
    supervisor.status.mockResolvedValue({ overall: 'ok', sentence: 'Ready', components: [], at: 0, configVerbs: currentConfigVerbs(false) });
    supervisor.configApply.mockResolvedValue({ ok: false, code: 'not_configured' });
    const t = await routeFixture({ workerApprovals: helper, supervisor });
    const response = await t.app.inject({ method: 'PUT', url: '/api/worker-approvals', headers: postHeaders(t.token), payload: { enabled } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enabled, config: 'written', reload: 'applied', application: 'partial' });
    expect(write).toHaveBeenCalledExactlyOnceWith(enabled);
    expect(supervisor.configApply).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(statePath, 'utf8')).enabled).toBe(enabled);
    expect(read().unrelated).toBe('demo-original');
    expect(read().agents.providers.pi.paseoTools.disabledTools).toEqual(enabled ? ['kill_agent', ...APPROVAL_TOOLS] : ['kill_agent']);
    expect((await t.app.inject({ url: '/api/worker-approvals', headers: apiHeaders(t.token) })).json())
      .toMatchObject({ enabled, choiceConfirmed: true, config: 'written', reload: 'applied' });
    expect(await new WorkerApprovalsSetting(configPath, root, daemon).status())
      .toMatchObject({ enabled, choiceConfirmed: true, config: 'written', reload: 'applied' });
    expect(changeRoutes(t.app).filter(route => route === 'PUT /api/worker-approvals')).toHaveLength(1);
  });
});

async function routeFixture(options: { zone?: string; wired?: boolean; feedEnabled?: boolean; workerApprovals?: AppDeps['workerApprovals'];
  supervisor?: AppDeps['supervisor']; shadow?: boolean; local?: boolean; legacySafety?: boolean; pipeline?: boolean;
  initialSettings?: Record<string, unknown>; initialAudit?: string } = {}) {
  mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
  const keys = await makeKeys();
  const token = await makeToken(keys);
  // The write-through core wants a folder only this PC's user can write, as the service has.
  const state = mkdtempSync(join(process.cwd(), '.tmp', 'notification-route-'));
  roots.push(state);
  if (options.shadow) writeFileSync(join(state, '.wayroost-role'), 'shadow\n', { mode: 0o600 });
  seedDevices(state);
  if (options.legacySafety !== undefined) writeFileSync(join(state, 'hermes-safety-commands.json'),
    JSON.stringify({ enabled: options.legacySafety }), { mode: 0o600 });
  if (options.initialSettings) writeFileSync(join(state, WAYROOST_SETTINGS_FILE), JSON.stringify(options.initialSettings), { mode: 0o600 });
  if (options.initialAudit) writeFileSync(join(state, 'settings-audit.jsonl'), options.initialAudit, { mode: 0o600 });
  const events: ServerEvent[] = [];
  const pushes: Array<Record<string, unknown>> = [];
  let paired = false;
  const push = {
    devices: () => paired ? 1 : 0,
    send: async (message: Record<string, unknown>) => (pushes.push(message), { sent: 1, failed: 0, removed: 0 }),
    publicKey: () => 'demo-key',
    bindDevices: (devices: unknown) => { paired = Boolean(devices); },
    revokeDevice: () => {},
  } as unknown as PushSender;
  let feed!: Feed;
  let notifications!: Notifications;
  const safetyCommands = new SafetyCommandsSetting(state);
  const made = await makeApp(keys, {
    configExtra: { stateDir: state, role: options.shadow ? 'shadow' : 'primary',
      settings: { legacyRoutesViaPipeline: options.pipeline ?? false },
      ...(options.shadow ? { listen: { port: 19110 } } : {}), ...(options.local ? {
      localListener: { port: 19014, pcOnlyWrites: true }, origins: ['https://127.0.0.1:19014'],
    } : {}) },
    safetyCommands,
    ...(options.supervisor ? { supervisor: options.supervisor } : {}),
    ...(options.workerApprovals ? { workerApprovals: options.workerApprovals } : {}),
    ...(options.feedEnabled !== false ? { feed: ({ hub }: { hub: import('../src/hub.js').EventHub }) => {
      feed = new Feed({ background: new BackgroundGate('primary'), store: new FeedStore(state), hub,
        hermes: { createConversation: async () => ({ id: 'chat-1' }) }, push, log: quietLog,
        now: NOON, timeZone: options.zone ?? 'UTC' });
      return feed;
    } } : {}),
    ...(options.wired !== false ? { notifications: ({ hub }: { hub: import('../src/hub.js').EventHub }) => {
      hub.observe((event) => events.push(event));
      notifications = new Notifications({ settings: new NotificationSettingsStore(state), hub, push,
        ...(feed ? { feed } : {}), background: new BackgroundGate('primary'), log: quietLog, now: NOON,
        ...(options.zone ? { timeZone: options.zone } : {}) });
      feed?.useRouting(notifications);
      return notifications;
    } } : {}),
  });
  if (options.local) made.app.addHook('onRequest', async request => {
    Object.defineProperty(request.raw.socket, 'localPort', { configurable: true, value: 19014 });
  });
  apps.push(made.app);
  return {
    ...made,
    token,
    state,
    events,
    pushes,
    feed,
    notifications,
    safetyCommands,
    get: (cookie = DESKTOP_COOKIE) => made.app.inject({ method: 'GET', url: ROUTE, headers: apiHeaders(token, { cookie }) }),
    put: (payload: unknown, cookie = DESKTOP_COOKIE) =>
      made.app.inject({ method: 'PUT', url: ROUTE, headers: postHeaders(token, { cookie }), payload: payload as object }),
    read: () => JSON.parse(readFileSync(join(state, WAYROOST_SETTINGS_FILE), 'utf8')) as Record<string, unknown>,
  };
}

describe('reading them', () => {
  it('says what every install starts with, without writing a file', async () => {
    const t = await routeFixture();
    const response = await t.get();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      rules: DEFAULT_NOTIFICATION_RULES.map((rule) => ({ ...rule })),
      quietHours: { start: '21:00', end: '07:00' },
      push: { approvals: true, cards: false },
      pushAvailable: true,
      pushDevices: 1,
      presence: 'gone',
      // This site file names no time zone, so the hours are read on this machine.
      timeZoneConfigured: false,
    });
    expect(() => t.read()).toThrow();
  });

  it('returns a fixed refusal where no alerts are set up', async () => {
    const t = await routeFixture({ wired: false });
    const response = await t.get();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: 'refused', code: 'not_configured' });
  });

  it('lets a phone read it, and wants a paired device first', async () => {
    const t = await routeFixture();
    expect((await t.get(PHONE_COOKIE)).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: ROUTE, headers: apiHeaders(t.token, { cookie: '' }) })).statusCode).toBe(401);
  });

  it('says where the next alert would go, from the desktop’s own report', async () => {
    const t = await routeFixture();
    // The app binds the routing service to what the power page knows about the desktop.
    expect(t.notifications.currentPresence()).toBe('gone');
    t.notifications.bindPresence(() => [{ device: 'dv_desktop', kind: 'desktop', state: 'idle', at: NOON() }]);
    expect((await t.get()).json().presence).toBe('idle');
  });
});

describe('writing them', () => {
  it('blocks feed routing saves before any change when the settings audit is unavailable', async () => {
    const t = await routeFixture();
    await t.put(body());
    const before = readFileSync(join(t.state, WAYROOST_SETTINGS_FILE), 'utf8');
    const feedBefore = t.feed.settings();
    writeFileSync(join(t.state, 'settings-audit.jsonl'), 'broken audit\n');
    const write = vi.spyOn(t.notifications, 'configApply');
    const response = await t.app.inject({ method: 'PUT', url: '/api/feed/settings', headers: postHeaders(t.token),
      payload: { quietHours: null, push: { approvals: false }, removeLessLike: 'demo-topic' } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'refused', code: 'audit_unavailable' });
    expect(write).not.toHaveBeenCalled();
    expect(readFileSync(join(t.state, WAYROOST_SETTINGS_FILE), 'utf8')).toBe(before);
    expect(t.feed.settings()).toEqual(feedBefore);
  });

  it('audits feed routing saves and supports undo through the settings route', async () => {
    const t = await routeFixture();
    await t.put(body());
    const response = await t.app.inject({ method: 'PUT', url: '/api/feed/settings', headers: postHeaders(t.token, { cookie: PHONE_COOKIE }),
      payload: { quietHours: null, push: { cards: false } } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ quietHours: null, push: { approvals: true, cards: false } });
    const changes = (await t.app.inject({ url: '/api/settings/changes', headers: apiHeaders(t.token) })).json().changes;
    const saved = changes.find((entry: { device?: { kind: string } }) => entry.device?.kind === 'phone');
    expect(saved).toMatchObject({ operation: 'wayroost.notifications', result: 'ok', undoable: true });
    const restored = await t.app.inject({ method: 'POST', url: '/api/settings/undo', headers: postHeaders(t.token),
      payload: { change: saved.id } });
    expect(restored.json()).toMatchObject({ status: 'applied', change: { effective: 'verified' } });
    expect(t.read()).toEqual(body());
    expect(t.feed.settings()).toMatchObject({ quietHours: body().quietHours, push: body().push });
  });

  it('serializes feed and notification route saves on the same queue', async () => {
    const t = await routeFixture();
    const original = t.notifications.configApply.bind(t.notifications);
    let entered!: () => void;
    let feedEntered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const feedStarted = new Promise<void>(resolve => { feedEntered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    t.app.addHook('preHandler', async request => { if (request.routeOptions.url === '/api/feed/settings') feedEntered(); });
    await t.put(body());
    const feedWrite = vi.spyOn(t.feed, 'updateSettings');
    const write = vi.spyOn(t.notifications, 'configApply').mockImplementationOnce(async request => {
      entered();
      await held;
      return original(request);
    });
    const rules = [{ event: 'agent-finished', source: 'hermes', delivery: 'neither' }];
    const notificationSave = t.put({ rules });
    await started;
    const feedSave = t.app.inject({ method: 'PUT', url: '/api/feed/settings', headers: postHeaders(t.token),
      payload: { quietHours: null, push: { cards: false } } }).then(response => response);
    await feedStarted;
    await new Promise<void>(resolve => setImmediate(resolve));
    const callsWhileHeld = write.mock.calls.length;
    const feedCallsWhileHeld = feedWrite.mock.calls.length;
    release();
    const responses = await Promise.all([notificationSave, feedSave]);
    expect(callsWhileHeld).toBe(1);
    expect(feedCallsWhileHeld).toBe(0);
    expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
    expect(t.read()).toEqual({ rules, quietHours: null, push: { approvals: true, cards: false } });
  });

  it('retains the merge snapshot when routing changes before the authorizing read returns', async () => {
    const t = await routeFixture();
    await t.put(body());
    const original = t.notifications.configRead.bind(t.notifications);
    vi.spyOn(t.notifications, 'configRead').mockImplementationOnce(async request => {
      const snapshot = await original(request);
      await t.feed.updateSettings({ quietHours: null, push: { approvals: false, cards: false } });
      return snapshot;
    });
    const response = await t.put({ rules: [{ event: 'agent-finished', source: 'hermes', delivery: 'neither' }] });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: 'refused', code: 'precondition_changed' });
    expect(t.read()).toEqual({ ...body(), quietHours: null, push: { approvals: false, cards: false } });
  });

  it('retains the feed merge snapshot when another writer changes a push switch', async () => {
    const t = await routeFixture();
    await t.put(body());
    const original = t.notifications.configRead.bind(t.notifications);
    vi.spyOn(t.notifications, 'configRead').mockImplementationOnce(async request => {
      const snapshot = await original(request);
      await t.feed.updateSettings({ push: { approvals: false } });
      return snapshot;
    });
    const response = await t.app.inject({ method: 'PUT', url: '/api/feed/settings', headers: postHeaders(t.token),
      payload: { push: { cards: false } } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: 'refused', code: 'precondition_changed' });
    expect(t.read()).toEqual({ ...body(), push: { approvals: false, cards: true } });
  });

  it('refuses feed saves in shadow before changing routing or feed preferences', async () => {
    const t = await routeFixture({ shadow: true });
    const write = vi.spyOn(t.notifications, 'configApply');
    const feedWrite = vi.spyOn(t.feed, 'updateSettings');
    const response = await t.app.inject({ method: 'PUT', url: '/api/feed/settings', headers: postHeaders(t.token),
      payload: { quietHours: null, push: { cards: true } } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ status: 'refused', code: 'shadow_read_only' });
    expect(write).not.toHaveBeenCalled();
    expect(feedWrite).not.toHaveBeenCalled();
    expect(() => t.read()).toThrow();
  });

  it('requires confirmed PC acceptance before a legacy save after an uncertain local write', async () => {
    const t = await routeFixture({ pipeline: true, supervisor: new FakeSettingsSupervisor(), local: true, initialSettings: { ...body(), safetyCommandsEnabled: true } });
    vi.spyOn(t.notifications, 'configApply').mockRejectedValueOnce(new Error('demo-lost-reply'));
    const lost = await t.app.inject({ method: 'PUT', url: '/api/settings/safety-commands', headers: postHeaders(t.token),
      payload: { enabled: false } });
    expect(lost.json()).toMatchObject({ status: 'refused', code: 'outcome_unknown' });
    const checks = (await t.app.inject({ url: '/api/settings/checks', headers: apiHeaders(t.token) })).json();
    const fix = checks.rows.find((row: { id: string }) => row.id === 'settings.blocked-wayroost-settings').fix;
    const accept = (confirm?: string) => t.app.inject({ method: 'POST', url: '/api/settings/apply', headers: postHeaders(t.token),
      payload: { ...fix, ...(confirm ? { confirm } : {}) } });
    const prompt = (await accept()).json();
    expect(prompt.status).toBe('confirm');
    expect((await accept(prompt.confirm)).json().status).toBe('applied');
    const legacy = await t.app.inject({ method: 'PUT', url: '/api/safety-commands', headers: postHeaders(t.token),
      payload: { enabled: true } });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().enabled).toBe(true);
    const noop = await t.app.inject({ method: 'PUT', url: '/api/settings/safety-commands', headers: postHeaders(t.token),
      payload: { enabled: true } });
    expect(noop.json()).toMatchObject({ status: 'applied', change: { effective: 'verified', undoable: false } });
    expect(t.safetyCommands.enabled()).toBe(true);
    expect(t.read().safetyCommandsEnabled).toBe(true);
  });

  it('uses one local writer for notification apply, undo and legacy safety writes', async () => {
    const supervisor = new FakeSettingsSupervisor();
    const t = await routeFixture({ supervisor, pipeline: true });
    const changed = (await t.put(body())).json();
    expect(changed).toMatchObject({ status: 'applied', change: { effective: 'verified', undoable: true } });
    expect(supervisor.configApply).not.toHaveBeenCalled();
    expect(supervisor.configRead).not.toHaveBeenCalledWith({ view: 'wayroost.settings' });
    const localRead = await t.notifications.configRead({ view: 'wayroost.settings' });
    expect(localRead).toMatchObject({ ok: true, present: true, values: expect.arrayContaining([
      { path: ['quietHours'], exists: true, value: body().quietHours },
      { path: ['rules'], exists: true, value: body().rules },
    ]) });
    const restore = await t.app.inject({ method: 'POST', url: '/api/settings/undo', headers: postHeaders(t.token),
      payload: { change: changed.change.id } });
    expect(restore.json()).toMatchObject({ status: 'applied', change: { effective: 'verified', undoable: true } });
    expect(supervisor.configUndo).not.toHaveBeenCalled();
    expect((await t.get()).json()).toMatchObject({ rules: DEFAULT_NOTIFICATION_RULES, quietHours: { start: '21:00', end: '07:00' },
      push: { approvals: true, cards: false } });
    expect(t.feed.settings()).toMatchObject({ quietHours: { start: '21:00', end: '07:00' }, push: { approvals: true, cards: false } });
    expect(t.notifications.decide('agent-finished', 'hermes').delivery).toBe('toast');
    const redo = await t.app.inject({ method: 'POST', url: '/api/settings/undo', headers: postHeaders(t.token),
      payload: { change: restore.json().change.id } });
    expect(redo.json()).toMatchObject({ status: 'applied', change: { effective: 'verified' } });
    expect(t.read()).toMatchObject(body());
    const oldSafetyWriter = vi.spyOn(t.safetyCommands, 'setEnabled');
    const safety = await t.app.inject({ method: 'PUT', url: '/api/safety-commands', headers: postHeaders(t.token), payload: { enabled: false } });
    expect(safety.statusCode).toBe(200); expect(safety.json().enabled).toBe(false);
    expect(oldSafetyWriter).not.toHaveBeenCalled();
    expect(supervisor.configApply).not.toHaveBeenCalled();
    expect(t.read()).toEqual({ ...body(), safetyCommandsEnabled: false });
    expect((await t.get()).json()).toMatchObject(body());
    writeFileSync(join(t.state, WAYROOST_SETTINGS_FILE), JSON.stringify({ ...body(), safetyCommandsEnabled: true }));
    expect((await t.app.inject({ url: '/api/safety-commands', headers: apiHeaders(t.token) })).json().enabled).toBe(true);
    expect((await t.put({ quietHours: null })).json()).toMatchObject({ status: 'applied' });
    expect(t.read()).toEqual({ ...body(), quietHours: null, safetyCommandsEnabled: true });
    expect(t.safetyCommands.enabled()).toBe(true);
    for (const route of ['PUT /api/settings/notifications', 'PUT /api/settings/safety-commands', 'PUT /api/safety-commands',
      'PUT /api/cloud-agents/:id', 'PUT /api/worker-approvals']) expect(changeRoutes(t.app).filter(entry => entry === route)).toHaveLength(1);
  });

  it('refuses notification writes in shadow before touching the store', async () => {
    const t = await routeFixture({ shadow: true });
    const write = vi.spyOn(t.notifications, 'configApply');
    const response = await t.put(body());
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ status: 'refused', code: 'shadow_read_only' });
    expect(write).not.toHaveBeenCalled();
    expect(() => t.read()).toThrow();
  });

  it('blocks the local writer when the settings audit cannot be verified', async () => {
    const t = await routeFixture();
    await t.put(body());
    const before = readFileSync(join(t.state, WAYROOST_SETTINGS_FILE), 'utf8');
    writeFileSync(join(t.state, 'settings-audit.jsonl'), 'broken audit\n');
    const write = vi.spyOn(t.notifications, 'configApply');
    const response = await t.put({ quietHours: null });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'refused', code: 'audit_unavailable' });
    expect(write).not.toHaveBeenCalled();
    expect(readFileSync(join(t.state, WAYROOST_SETTINGS_FILE), 'utf8')).toBe(before);
  });

  it('refuses undo after a feed change has replaced the same settings', async () => {
    const t = await routeFixture();
    const changed = (await t.put(body())).json();
    await t.feed.updateSettings({ quietHours: null });
    const response = await t.app.inject({ method: 'POST', url: '/api/settings/undo', headers: postHeaders(t.token),
      payload: { change: changed.change.id } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: 'refused', code: 'undo_changed' });
    expect(t.read()).toMatchObject({ ...body(), quietHours: null });
  });

  it('guards an authorized notification save against a concurrent feed change', async () => {
    const t = await routeFixture();
    await t.put(body());
    const original = t.notifications.configApply.bind(t.notifications);
    vi.spyOn(t.notifications, 'configApply').mockImplementationOnce(async request => {
      await t.feed.updateSettings({ quietHours: null });
      return original(request);
    });
    const response = await t.put({ rules: [{ event: 'agent-finished', source: 'hermes', delivery: 'neither' }] });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: 'refused', code: 'precondition_changed' });
    expect(t.read()).toEqual({ ...body(), quietHours: null });
  });

  it('can undo a persisted notification change after rebuilding the application', async () => {
    const t = await routeFixture();
    const changed = (await t.put(body())).json();
    await t.app.close();
    const hub = new EventHub();
    const notifications = new Notifications({ settings: new NotificationSettingsStore(t.state), hub, log: quietLog,
      background: new BackgroundGate('primary'), now: NOON });
    const app = await buildApp({ config: t.config, hub, notifications, devices: t.devices,
      sources: { hermes: t.hermes, paseo: t.paseo }, logger: false,
      verifier: async () => ({ email: 'you@example.com', exp: 2_000_000_000 }) });
    apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/api/settings/undo', headers: postHeaders(t.token),
      payload: { change: changed.change.id } });
    expect(response.json()).toMatchObject({ status: 'applied', change: { effective: 'verified' } });
    expect(notifications.settings()).toMatchObject({ rules: DEFAULT_NOTIFICATION_RULES, quietHours: { start: '21:00', end: '07:00' },
      push: { approvals: true, cards: false } });
  });

  it('accepts rules-only saves without restoring older switches or quiet hours', async () => {
    const t = await routeFixture();
    await t.put(body());
    await t.feed.updateSettings({ quietHours: null, push: { approvals: false, cards: false } });
    const rules = [{ event: 'agent-finished', source: 'hermes', delivery: 'neither' }];
    expect((await t.put({ rules })).statusCode).toBe(200);
    expect(t.read()).toEqual({ rules, quietHours: null, push: { approvals: false, cards: false } });
  });
  it('keeps every rule, the hours and the switches, and tells the pages to read them again', async () => {
    const t = await routeFixture();
    const response = await t.put(body());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'applied', change: { operation: 'wayroost.notifications', target: 'wayroost-settings', effective: 'verified', undoable: true },
    });
    expect((await t.get()).json()).toMatchObject(body());
    expect(t.read()).toEqual({
      rules: [{ event: 'agent-finished', source: 'hermes', delivery: 'toast' }],
      quietHours: { start: '22:00', end: '06:30' },
      push: { approvals: true, cards: true },
    });
    expect(statSync(join(t.state, WAYROOST_SETTINGS_FILE)).mode & 0o777).toBe(0o600);
    expect(t.events.filter((event) => event.type === 'settings_changed')).toEqual([
      { type: 'settings_changed', sections: ['overview', 'notifications', 'checks'], change: response.json().change.id },
    ]);
    const changes = (await t.app.inject({ url: '/api/settings/changes', headers: apiHeaders(t.token) })).json().changes;
    expect(changes).toContainEqual(expect.objectContaining({ id: response.json().change.id, operation: 'wayroost.notifications', result: 'ok', undoable: true }));
    const audit = readFileSync(join(t.state, WAYROOST_SETTINGS_AUDIT_DIR, 'settings.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'apply',
      target: join(t.state, WAYROOST_SETTINGS_FILE),
      result: 'success',
      operations: [
        { type: 'set', path: ['rules'] },
        { type: 'set', path: ['quietHours'] },
        { type: 'set', path: ['push'] },
      ],
    });
  });

  it('names the desktop that asked, and can put the bytes back', async () => {
    const t = await routeFixture();
    await t.put(body());
    const change = await t.notifications.update({ quietHours: null }, { device: 'dv_test', level: 'anywhere' });
    expect(change.push).toEqual({ approvals: true, cards: true });
    const audit = readFileSync(join(t.state, WAYROOST_SETTINGS_AUDIT_DIR, 'settings.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit.at(-1)).toMatchObject({ device: 'dv_test', level: 'anywhere', result: 'success' });
  });

  it('takes the same write twice without writing it twice', async () => {
    const t = await routeFixture();
    await t.put(body());
    const bytes = readFileSync(join(t.state, WAYROOST_SETTINGS_FILE), 'utf8');
    expect((await t.put(body())).statusCode).toBe(200);
    expect(readFileSync(join(t.state, WAYROOST_SETTINGS_FILE), 'utf8')).toBe(bytes);
    expect(t.events.filter((event) => event.type === 'settings_changed')).toHaveLength(1);
  });

  it('lets a phone change them too, and records which one', async () => {
    const t = await routeFixture();
    expect((await t.put(body(), PHONE_COOKIE)).statusCode).toBe(200);
    const audit = readFileSync(join(t.state, WAYROOST_SETTINGS_AUDIT_DIR, 'settings.jsonl'), 'utf8');
    expect(audit).toContain('dv_');
  });

  it('wants a device it knows', async () => {
    const t = await routeFixture();
    const response = await t.app.inject({
      method: 'PUT',
      url: ROUTE,
      headers: postHeaders(t.token, { cookie: 'wr_device=dv_missing.' + 'a'.repeat(32) }),
      payload: body(),
    });
    expect(response.statusCode).toBe(401);
    expect(() => t.read()).toThrow();
  });

  it('returns a fixed refusal when the file is unsafe, and changes nothing', async () => {
    const t = await routeFixture();
    await t.put(body());
    // Not a file any more: the core will not write through something it can't check.
    rmSync(join(t.state, WAYROOST_SETTINGS_FILE));
    mkdirSync(join(t.state, WAYROOST_SETTINGS_FILE));
    const response = await t.put(body({ quietHours: { start: '20:00', end: '06:00' } }));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: 'refused', code: 'unsafe_target' });
    expect((await t.get()).json().quietHours).toEqual({ start: '21:00', end: '07:00' });
  });

  it.each([
    ['a rule for an event nobody named', { rules: [{ event: 'ghost', source: '*', delivery: 'toast' }] }],
    ['a rule for a source nobody named', { rules: [{ event: 'agent-finished', source: 'slack', delivery: 'toast' }] }],
    ['a rule that delivers nowhere named', { rules: [{ event: 'agent-finished', source: '*', delivery: 'email' }] }],
    ['the same event and source twice', { rules: [{ event: 'agent-finished', source: '*', delivery: 'toast' }, { event: 'agent-finished', source: '*', delivery: 'push' }] }],
    ['an agent waiting on an answer, switched off', { rules: [{ event: 'agent-needs-you', source: '*', delivery: 'neither' }] }],
    ['an agent waiting on an answer, kept off the app', { rules: [{ event: 'agent-needs-you', source: '*', delivery: 'push' }] }],
    ['a quiet hour that is not an hour', { quietHours: { start: '21:00', end: '25:00' } }],
    ['a time written as people say it', { quietHours: { start: '9pm', end: '07:00' } }],
    ['quiet hours with one end', { quietHours: { start: '21:00' } }],
    ['no quiet hours at all', { quietHours: { start: null, end: null } }],
    ['a switch nobody has', { push: { approvals: true, cards: false, locks: false } }],
    ['a key nobody reads', { extra: true }],
    ['the phone’s switch left out', { push: { approvals: true } }],
  ])('refuses %s and saves nothing', async (_what, extra) => {
    const t = await routeFixture();
    const response = await t.put(body(extra));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ status: 'refused', code: 'invalid_parameters' });
    expect(() => t.read()).toThrow();
    expect((await t.get()).json().rules).toEqual(DEFAULT_NOTIFICATION_RULES.map((rule) => ({ ...rule })));
  });

  it('says no to an empty body, which is not the same as no rules', async () => {
    const t = await routeFixture();
    expect((await t.put({})).statusCode).toBe(400);
  });

  it('writes the hours once and every reader says the same', async () => {
    const t = await routeFixture();
    await t.put(body());
    expect(t.feed.settings().quietHours).toEqual({ start: '22:00', end: '06:30' });
    expect(t.feed.settings().push).toEqual({ approvals: true, cards: true });
    const page = await t.app.inject({ method: 'GET', url: '/api/feed', headers: apiHeaders(t.token) });
    expect(page.json().settings.quietHours).toEqual({ start: '22:00', end: '06:30' });
    // And the other way round: the For-you page's own save is the same settings.
    const saved = await t.app.inject({
      method: 'PUT',
      url: '/api/feed/settings',
      headers: postHeaders(t.token, { cookie: DESKTOP_COOKIE }),
      payload: { quietHours: { start: '23:30', end: '05:00' }, push: { cards: false } },
    });
    expect(saved.statusCode).toBe(200);
    expect((await t.get()).json()).toMatchObject({
      quietHours: { start: '23:30', end: '05:00' },
      push: { approvals: true, cards: false },
    });
  });

  it('routes the next alert by what was just written', async () => {
    const t = await routeFixture();
    t.notifications.bindPresence(() => [{ device: 'dv_desktop', kind: 'desktop', state: 'active', at: NOON() }]);
    await t.put(body({ rules: [{ event: 'agent-finished', source: '*', delivery: 'both' }] }));
    expect(t.notifications.decide('agent-finished', 'hermes')).toMatchObject({ toast: true, push: false });
    await t.put(body({ rules: [{ event: 'agent-finished', source: '*', delivery: 'neither' }] }));
    expect(t.notifications.decide('agent-finished', 'hermes')).toMatchObject({ toast: false, push: false });
  });
});
