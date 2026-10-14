import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { wayroostSettingsSchema } from '../../shared/wayroost-settings.js';
import { NOTIFICATION_EVENTS, settingsApplyResponseSchema } from '../../shared/settings.js';
import { settingsChecksResponseSchema } from '../../shared/settings-checks.js';
import type { ScheduleJob } from '../../shared/protocol.js';
import { settingsTargetsSchema } from '../../shared/settings-targets.js';
import { executeConfig } from '../../supervisor/src/config-executor.js';
import { withConsumerLock } from '../../supervisor/src/config-locks.js';
import type { ConfigWriteResult, ConfigApplyRequest, ConfigUndoRequest, ConfigRequestStatusResult } from '../../shared/supervisor-config.js';
import { buildApp, type AppDeps } from '../src/app.js';
import { BackgroundGate } from '../src/background.js';
import { EventHub } from '../src/hub.js';
import { EventJournal } from '../src/hub/journal.js';
import { WayroostSettingsStore } from '../src/settings/store.js';
import { Feed, BRIEF_JOB, SCOUT_JOB, SCOUT_SCHEDULES, type FeedDeps } from '../src/feed/service.js';
import { SafetyCommandsSetting } from '../src/hermes/safety.js';
import { NotificationSettingsStore, WAYROOST_SETTINGS_FILE } from '../src/notifications/settings.js';
import { createNotificationServices } from '../src/notifications/service.js';
import { FeedStore } from '../src/feed/store.js';
import { WorkerUpdatesSetting } from '../src/tasks/setting.js';
import { TaskRelay } from '../src/tasks/relay.js';
import { TaskStore, type TaskRecord } from '../src/tasks/store.js';
import type { SystemMessage } from '../src/bridge/service.js';
import type { WorkerSnapshot } from '../src/paseo/normalize.js';
import { VoiceSetting } from '../src/voice-setting.js';
import { DemoSpeech } from '../../scripts/demo-speech.js';
import { FakeSettingsSupervisor } from './fake-settings-supervisor.js';
import { FakeHermes, FakePaseo, apiHeaders, postHeaders, makeConfig, seedDevices } from './helpers.js';

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
beforeEach(() => { vi.mocked(fs.lstat).mockImplementation(async (path, options) => {
  const stat = await actual.lstat(path, options);
  if (String(path) === '/') stat.uid = typeof stat.uid === 'bigint' ? 0n : 0;
  return stat;
}); });
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const initial = { version: 1, safetyCommandsEnabled: false, quietHours: null, rules: [],
  push: { approvals: false, cards: false }, workerUpdates: { enabled: false, defaultMinutes: 60 },
  feed: { level: 'off', lessLike: [] }, voice: { appReadAloud: { provider: 'local' } } };

async function fixture(document: unknown = initial, pipeline = true, unavailable = false, schedules: FeedDeps['schedules'] | null = pulseSchedules().schedules,
  extra: Pick<AppDeps, 'speech' | 'cloudSpeech' | 'phone' | 'feed' | 'settings'> = {}) {
  const config = makeConfig(undefined, { settings: { legacyRoutesViaPipeline: pipeline },
    localListener: { port: 19014, pcOnlyWrites: true }, origins: ['https://127.0.0.1:19014'] });
  roots.push(config.stateDir);
  const root = mkdtempSync(join(process.cwd(), '.owner-settings-test-')); roots.push(root);
  config.stateDir = join(root, 'state'); mkdirSync(config.stateDir, { mode: 0o700 }); seedDevices(config.stateDir);
  const privateFeedBytes = JSON.stringify({ cards: [], notified: [], settings: {
    level: 'high', quietHours: null, push: { approvals: true, cards: true }, lessLike: [],
  } });
  writeFileSync(join(config.stateDir, 'feed.json'), privateFeedBytes, { mode: 0o600 });
  const path = join(root, 'settings.json');
  if (document !== null) writeFileSync(path, JSON.stringify(document), { mode: 0o600 });
  mkdirSync(join(root, 'backups'), { mode: 0o700 }); mkdirSync(join(root, 'audit'), { mode: 0o700 });
  const site = settingsTargetsSchema.parse({ version: 1, configWrites: true, targets: { 'wayroost-settings': {
    path, format: 'json', runAs: { user: 'fixture_owner', uid: process.getuid!() }, mode: 0o600,
    backupDir: join(root, 'backups'), auditDir: join(root, 'audit'), lock: { kind: 'file', path: path + '.wayroost-settings.lock' },
  } } });
  const execute = (verb: 'config.read' | 'config.apply' | 'config.undo', request: unknown, extra = {}) => executeConfig({ site, caller: 'server', verb, request, ...extra },
    { lock: (target, work) => withConsumerLock(target, work, async lockPath => lockPath) });
  const supervisor = new FakeSettingsSupervisor();
  const proofs = new Map<string, Extract<ConfigWriteResult, { ok: true; undo: unknown }>>();
  supervisor.configRead.mockImplementation(async request => request.view === 'wayroost.settings'
    ? await execute('config.read', request) as Awaited<ReturnType<typeof supervisor.configRead>>
    : { ok: false, code: 'not_configured' } as never);
  if (unavailable) supervisor.configRead.mockRejectedValue(new Error('invented unavailable authority'));
  const write = async (verb: 'config.apply' | 'config.undo', request: ConfigApplyRequest | ConfigUndoRequest): Promise<ConfigWriteResult> => {
    const token = 'token' in request ? request.token : undefined;
    const result = await execute(verb, request, token ? { undoProof: proofs.get(token.backupId) && {
      ...token, keys: proofs.get(token.backupId)!.keys,
    } } : {}) as ConfigWriteResult;
    if (result.ok && 'undo' in result) proofs.set(result.backupId, result);
    return result;
  };
  supervisor.configApply.mockImplementation(request => write('config.apply', request));
  supervisor.configUndo.mockImplementation(request => write('config.undo', request));
  const hub = new EventHub();
  const safety = new SafetyCommandsSetting(config.stateDir);
  safety.setEnabled(true);
  const workers = new WorkerUpdatesSetting(config.stateDir);
  const writes = [vi.spyOn(NotificationSettingsStore.prototype, 'initialize'), vi.spyOn(NotificationSettingsStore.prototype, 'change'),
    vi.spyOn(NotificationSettingsStore.prototype, 'configApply'), vi.spyOn(NotificationSettingsStore.prototype, 'configUndo'),
    vi.spyOn(FeedStore.prototype, 'updateSettings'), vi.spyOn(safety, 'setEnabled'), vi.spyOn(workers, 'update'),
    vi.spyOn(VoiceSetting.prototype, 'setVoice'), vi.spyOn(VoiceSetting.prototype, 'setAppReadAloud')];
  const { notifications, feed } = await createNotificationServices({ stateDir: config.stateDir, pipeline, feedEnabled: true,
    hub, hermes: new FakeHermes(), schedules: schedules ?? undefined, background: new BackgroundGate('primary'), log: { info() {}, warn() {} }, timeZone: 'UTC' });
  const open = async () => {
    const app = await buildApp({ config, hub, notifications, feed, supervisor, safetyCommands: safety, workerUpdates: workers,
      speech: new DemoSpeech(), cloudSpeech: { catalog: async () => ({ voices: [{ id: 'example_voice', name: 'Example voice', category: 'premade', preview: false }], models: [{ id: 'example_model', name: 'Example model' }] }), synthesize: async function* () {} },
      ...extra, sources: { hermes: new FakeHermes(), paseo: new FakePaseo() }, logger: false,
      verifier: async () => ({ email: 'fixture@example.com', exp: 2_000_000_000 }) });
    app.addHook('onRequest', async request => Object.defineProperty(request.raw.socket, 'localPort', { value: 19014, configurable: true }));
    apps.push(app);
    return app;
  };
  let app = await open();
  const restart = async (beforeOpen?: () => void) => { await app.close(); beforeOpen?.(); app = await open(); };
  const request = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) => app.inject({ method, url,
    headers: method === 'GET' ? apiHeaders('invented-jwt') : postHeaders('invented-jwt'), ...(payload ? { payload: payload as object } : {}) });
  return { config, path, site, supervisor, hub, notifications, feed: feed!, safety, workers, writes, request, restart, privateFeedBytes };
}

it('keeps absence distinct and rejects unversioned, future, unknown and invalid fields', () => {
  expect(wayroostSettingsSchema.parse({ version: 1 })).toEqual({ version: 1 });
  expect(wayroostSettingsSchema.parse({ version: 1, safetyCommandsEnabled: false, quietHours: null, rules: [], push: {} }))
    .toEqual({ version: 1, safetyCommandsEnabled: false, quietHours: null, rules: [], push: {} });
  for (const document of [{}, { version: 2 }, { version: 1, extra: true }, { version: 1, push: { extra: true } },
    { version: 1, workerUpdates: { defaultMinutes: 7 } }, { version: 1, timeZone: 'Invented/Invalid' },
    { version: 1, rules: [{ event: 'agent-needs-you', source: '*', delivery: 'neither' }] }]) expect(wayroostSettingsSchema.safeParse(document).success).toBe(false);
});

it('reads, applies and undoes using the owner target schema, lock, backups and audit, with no private setting writes', async () => {
  const f = await fixture();
  expect(f.safety.enabled()).toBe(false);
  expect((await f.request('GET', '/api/settings/notifications')).json().push).toEqual(initial.push);
  const changed = (await f.request('PUT', '/api/settings/notifications', { rules: [{ event: 'agent-finished', source: '*', delivery: 'toast' }] })).json();
  expect(changed).toMatchObject({ status: 'applied', change: { effective: 'verified', undoable: true } });
  expect(f.notifications.decide('agent-finished', 'hermes').delivery).toBe('toast');
  expect((await f.request('POST', '/api/settings/undo', { change: changed.change.id })).json().status).toBe('applied');
  expect(f.notifications.decide('agent-finished', 'hermes').delivery).toBe('neither');
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual(initial);
  expect(readFileSync(join(f.site.targets['wayroost-settings']!.auditDir, 'audit.jsonl'), 'utf8')).toContain('undo');
  expect(f.supervisor.configApply).toHaveBeenCalledOnce(); expect(f.supervisor.configUndo).toHaveBeenCalledOnce();
  for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
  expect(existsSync(join(f.config.stateDir, WAYROOST_SETTINGS_FILE))).toBe(false);
  expect(readFileSync(join(f.config.stateDir, 'feed.json'), 'utf8')).toBe(f.privateFeedBytes);
});

it('makes unavailable authority visible at startup and never seeds from permissive private feed settings', async () => {
  const f = await fixture(initial, true, true);
  expect((await f.request('GET', '/api/settings/notifications')).json()).toEqual({ status: 'refused', code: 'unavailable' });
  expect((await f.request('GET', '/api/voice')).json()).toMatchObject({ settingsUnavailable: 'unavailable', canChange: false });
  expect((await f.request('GET', '/api/worker-updates')).json()).toMatchObject({ status: 'refused', code: 'unavailable' });
  expect(f.safety.enabled()).toBe(false); expect(f.workers.enabled()).toBe(false);
  expect(f.feed.preferences().level).toBe('off'); expect(f.notifications.settings().push.cards).toBe(false);
  expect(readFileSync(join(f.config.stateDir, 'feed.json'), 'utf8')).toBe(f.privateFeedBytes);
  expect(existsSync(join(f.config.stateDir, 'settings-consumers.jsonl'))).toBe(false);
  for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
});

it('consumers react to verified Safety, feed, worker, time-zone and voice changes and undo', async () => {
  const f = await fixture();
  const observer = vi.fn(); f.workers.watch(observer);
  expect((await f.request('PUT', '/api/safety-commands', { enabled: true })).json().enabled).toBe(true);
  expect(f.safety.enabled()).toBe(true);
  expect((await f.request('PUT', '/api/worker-updates', { enabled: true, defaultMinutes: 30 })).json().enabled).toBe(true);
  expect(f.workers.defaultMinutes()).toBe(30); expect(observer).toHaveBeenCalled();
  expect((await f.request('PUT', '/api/voice', { voice: 'af_heart' })).json().defaultVoice).toBe('af_heart');
  expect((await f.request('PUT', '/api/feed/settings', { level: 'low', push: { cards: true } })).json()).toMatchObject({ level: 'low', push: { cards: true } });
  expect(f.feed.preferences().level).toBe('low');
  const changed = (await f.request('POST', '/api/settings/apply', { operation: 'wayroost.preferences', params: { timeZone: 'Etc/UTC' } })).json();
  expect(changed.status).toBe('applied'); expect(f.notifications.settings().timeZoneConfigured).toBe(true);
  expect((await f.request('POST', '/api/settings/undo', { change: changed.change.id })).json().status).toBe('applied');
  expect(f.notifications.settings().timeZoneConfigured).toBe(false);
  for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
});

it.each([null, {}, { version: 2 }, { version: 1, safetyCommandsEnabled: 'true' }])('fails visibly at startup without seeding or loosening: %j', async document => {
  const f = await fixture(document);
  const view = (await f.request('GET', '/api/settings/sections/notifications')).json().views[0];
  expect(view).toMatchObject({ ok: false, code: document === null ? 'target_missing' : 'parse_failed' });
  expect((await f.request('GET', '/api/settings/notifications')).json()).toMatchObject({ status: 'refused' });
  expect(f.safety.enabled()).toBe(false); expect(f.workers.enabled()).toBe(false);
  expect(f.feed.preferences().level).toBe('off'); expect(f.notifications.settings().push.cards).toBe(false);
  expect(f.notifications.decide('agent-needs-you', 'hermes').toast).toBe(true);
  expect(f.supervisor.configApply).not.toHaveBeenCalled(); for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
  expect(existsSync(join(f.config.stateDir, WAYROOST_SETTINGS_FILE))).toBe(false);
});

it('keeps legacy startup seeding and private writers', async () => {
  const f = await fixture(null, false);
  expect(f.writes[0]).toHaveBeenCalledOnce();
  expect(existsSync(join(f.config.stateDir, WAYROOST_SETTINGS_FILE))).toBe(true);
  expect(f.safety.enabled()).toBe(true); expect(f.workers.enabled()).toBe(true);
  expect((await f.request('PUT', '/api/safety-commands', { enabled: false })).json().enabled).toBe(false);
  expect(f.writes[5]).toHaveBeenCalledOnce(); expect(f.supervisor.configApply).not.toHaveBeenCalled();
  expect(existsSync(join(f.config.stateDir, 'settings-consumers.jsonl'))).toBe(false);
});

it('preserves absent notification fields on partial saves and empty push objects on reads', async () => {
  const f = await fixture({ version: 1, push: {} });
  const read = await f.supervisor.configRead({ view: 'wayroost.settings' });
  expect(read).toMatchObject({ values: expect.arrayContaining([{ path: ['push'], exists: true, value: {} }]) });
  expect((await f.request('PUT', '/api/settings/notifications', { rules: [] })).json().status).toBe('applied');
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual({ version: 1, push: {}, rules: [] });
  expect((await f.request('PUT', '/api/settings/notifications', { push: { cards: true } })).json().status).toBe('applied');
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual({ version: 1, push: { cards: true }, rules: [] });
});

it('discards a failed read and recovers through another read without private writes', async () => {
  const f = await fixture({ ...initial, safetyCommandsEnabled: true, workerUpdates: { enabled: true } });
  expect(f.safety.enabled()).toBe(true); expect(f.workers.enabled()).toBe(true);
  f.supervisor.configRead.mockRejectedValueOnce(new Error('invented failure'));
  expect((await f.request('GET', '/api/settings/notifications')).json()).toMatchObject({ status: 'refused', code: 'unavailable' });
  expect(f.safety.enabled()).toBe(false); expect(f.workers.enabled()).toBe(false);
  expect((await f.request('GET', '/api/settings/notifications')).statusCode).toBe(200);
  expect(f.safety.enabled()).toBe(true); for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
});

it('does not publish a snapshot whose hash differs from the apply receipt', async () => {
  const f = await fixture();
  const apply = f.supervisor.configApply.getMockImplementation()!;
  f.supervisor.configApply.mockImplementationOnce(async request => {
    const result = await apply(request);
    if (!result.ok || !('undo' in result)) return result;
    return { ...result, writtenSha256: 'a'.repeat(64), undo: { ...result.undo, writtenSha256: 'a'.repeat(64) } };
  });
  const response = await f.request('PUT', '/api/settings/safety-commands', { enabled: true });
  expect(response.json()).toMatchObject({ status: 'refused', code: 'verify_mismatch' });
  expect(f.safety.enabled()).toBe(false); expect(f.workers.enabled()).toBe(false);
  for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
});

it.each(['apply', 'undo'] as const)('keeps every consumer closed when the final %s audit fails', async action => {
  const f = await fixture({ ...initial, safetyCommandsEnabled: true,
    feed: { level: 'low' }, workerUpdates: { enabled: action === 'undo' } });
  const change = action === 'undo'
    ? (await f.request('POST', '/api/settings/apply', { operation: 'wayroost.worker-updates', params: { workerUpdates: { enabled: false } } })).json().change.id
    : undefined;
  const observed: boolean[] = [];
  f.workers.watch(() => observed.push(f.workers.enabled()));
  const append = EventJournal.prototype.append;
  let enabledBeforeCompletion: boolean | undefined;
  vi.spyOn(EventJournal.prototype, 'append').mockImplementation(function (this: EventJournal, input) {
    if (input.type === 'settings-change') {
      enabledBeforeCompletion = f.workers.enabled();
      throw new Error('invented audit write failure');
    }
    return append.call(this, input);
  });
  const response = action === 'apply'
    ? await f.request('POST', '/api/settings/apply', { operation: 'wayroost.worker-updates', params: { workerUpdates: { enabled: true } } })
    : await f.request('POST', '/api/settings/undo', { change });
  expect(response.json()).toMatchObject({ status: 'refused', code: 'audit_unavailable' });
  expect(enabledBeforeCompletion).toBe(false);
  expect(observed).not.toContain(true);
  expect(f.workers.enabled()).toBe(false); expect(f.safety.enabled()).toBe(false);
  expect(f.feed.preferences().level).toBe('off');
  expect(f.notifications.decide('agent-needs-you', 'hermes')).toMatchObject({ toast: true, push: false });
  expect((await f.request('GET', '/api/settings/notifications')).json()).toMatchObject({ status: 'refused', code: 'audit_unavailable' });
  expect(f.workers.enabled()).toBe(false);
  for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
});

it('refuses verification when Safety does not adopt the enabled snapshot', async () => {
  const f = await fixture();
  vi.spyOn(f.safety, 'enabled').mockReturnValue(false);
  expect((await f.request('PUT', '/api/settings/safety-commands', { enabled: true })).json())
    .toMatchObject({ status: 'refused', code: 'verify_mismatch', change: { effective: 'mismatch', undoable: true } });
  expect(f.workers.enabled()).toBe(false); expect(f.feed.preferences().level).toBe('off');
  for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
});

it('keeps already verified worker delivery enabled during an unrelated successful save', async () => {
  const f = await fixture({ ...initial, workerUpdates: { enabled: true } });
  const observed: boolean[] = [];
  f.workers.watch(() => observed.push(f.workers.enabled()));
  expect((await f.request('PUT', '/api/voice', { voice: 'af_heart' })).statusCode).toBe(200);
  expect(observed).not.toContain(false);
  expect(f.workers.enabled()).toBe(true);
  for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
});

it('disables all outbound notification routes during an outage while retaining requests for an answer', async () => {
  const f = await fixture();
  expect(f.notifications.decide('agent-needs-you', 'hermes')).toMatchObject({ toast: true, push: false });
  f.supervisor.configRead.mockRejectedValue(new Error('invented authority outage'));
  expect((await f.request('GET', '/api/settings/notifications')).json()).toMatchObject({ code: 'unavailable' });
  expect(f.notifications.settings().push).toEqual({ approvals: false, cards: false });
  for (const event of NOTIFICATION_EVENTS) expect(f.notifications.decide(event, 'hermes').push).toBe(false);
  expect(f.notifications.decide('agent-needs-you', 'hermes').toast).toBe(true);
});

it.each(['catalogue', 'supervisor'] as const)('merges partial groups through the %s without erasing siblings and undoes them exactly', async route => {
  const document = { version: 1, feed: { lessLike: [{ topic: 'Example topic', example: 'Invented card', at: 1 }] },
    workerUpdates: { defaultMinutes: 30 }, voice: { appReadAloud: { provider: 'local' } }, push: { approvals: false } };
  const f = await fixture(document);
  const apply = async (operation: string, params: Record<string, unknown>) => {
    if (route === 'catalogue') {
      const response = (await f.request('POST', '/api/settings/apply', { operation, params })).json();
      expect(response).toMatchObject({ status: 'applied', change: { effective: 'verified' } });
      return async () => expect((await f.request('POST', '/api/settings/undo', { change: response.change.id })).json().status).toBe('applied');
    }
    const result = await f.supervisor.configApply({ requestId: randomUUID(), operation, params });
    expect(result.ok).toBe(true);
    if (!result.ok || !('undo' in result)) throw new Error('missing undo token');
    return async () => expect((await f.supervisor.configUndo({ requestId: randomUUID(), token: result.undo })).ok).toBe(true);
  };
  for (const [operation, params, expected] of [
    ['wayroost.preferences', { feed: { level: 'low' } }, { ...document, feed: { ...document.feed, level: 'low' } }],
    ['wayroost.worker-updates', { workerUpdates: { enabled: true } }, { ...document, workerUpdates: { ...document.workerUpdates, enabled: true } }],
    ['wayroost.voice', { voice: { voice: 'af_heart' } }, { ...document, voice: { ...document.voice, voice: 'af_heart' } }],
    ['wayroost.notifications', { push: { cards: true } }, { ...document, push: { ...document.push, cards: true } }],
    ['wayroost.preferences', { feed: {} }, document],
    ['wayroost.worker-updates', { workerUpdates: {} }, document],
    ['wayroost.voice', { voice: {} }, document],
    ['wayroost.preferences', { feed: { lessLike: [] } }, { ...document, feed: { lessLike: [] } }],
    ['wayroost.worker-updates', { workerUpdates: { enabled: false } }, { ...document, workerUpdates: { ...document.workerUpdates, enabled: false } }],
    ['wayroost.notifications', { quietHours: null, rules: [] }, { ...document, quietHours: null, rules: [] }],
    ['wayroost.voice', { voice: { appReadAloud: { provider: 'elevenlabs', voiceId: 'example_voice', modelId: 'example_model' } } },
      { ...document, voice: { appReadAloud: { provider: 'elevenlabs', voiceId: 'example_voice', modelId: 'example_model' } } }],
  ] as const) {
    const before = readFileSync(f.path, 'utf8');
    const undo = await apply(operation, params);
    expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual(expected);
    await undo();
    expect(readFileSync(f.path, 'utf8')).toBe(before);
  }
});

it('serializes concurrent feedback deltas against the authoritative list before dismissing cards', async () => {
  const f = await fixture();
  f.feed.ingest('scout', [
    { key: 'example:first', kind: 'reply', title: 'Invented first card', topic: 'First topic' },
    { key: 'example:second', kind: 'reply', title: 'Invented second card', topic: 'Second topic' },
  ]);
  const cards = (await f.feed.list()).cards;
  const responses = await Promise.all(cards.map(card => f.request('POST', `/api/feed/${card.id}/action`, { action: 'less' })));
  for (const response of responses) expect(response.json()).toMatchObject({ card: { status: 'dismissed' } });
  expect(f.feed.preferences().lessLike.map(entry => entry.topic).sort()).toEqual(['First topic', 'Second topic']);
  expect(JSON.parse(readFileSync(f.path, 'utf8')).feed.lessLike).toHaveLength(2);
  expect((await f.feed.list()).cards).toEqual([]);
  for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
});

function pulseSchedules() {
  const jobs: ScheduleJob[] = [BRIEF_JOB, SCOUT_JOB].map((name, index) => ({
    source: 'hermes', id: `example-pulse-${index}`, name, title: name, plumbing: false,
    schedule: index ? SCOUT_SCHEDULES.normal : '0 7 * * *', scheduleInput: index ? SCOUT_SCHEDULES.normal : '0 7 * * *',
    state: 'paused', skills: [], deliver: 'local', deliverLabel: 'Local', failureStreak: 0, runs: 0, trigger: false, script: true,
  }));
  const schedules = {
    list: vi.fn(async () => ({ jobs, targets: [] })),
    setPaused: vi.fn<NonNullable<FeedDeps['schedules']>['setPaused']>(async (_source, id, paused) => {
      jobs.find(job => job.id === id)!.state = paused ? 'paused' : 'active';
    }),
    update: vi.fn<NonNullable<FeedDeps['schedules']>['update']>(async (_source, id, changes) => { jobs.find(job => job.id === id)!.scheduleInput = changes.schedule!; }),
  };
  return { jobs, schedules };
}

it('retries failed pulse changes for an unchanged level and only then reports verification', async () => {
  const { jobs, schedules } = pulseSchedules();
  const setPaused = schedules.setPaused.getMockImplementation()!;
  let fail = true;
  schedules.setPaused.mockImplementation(async (...args) => {
    if (fail) throw new Error('invented pulse failure');
    return setPaused(...args);
  });
  const f = await fixture(initial, true, false, schedules);
  expect(schedules.setPaused).not.toHaveBeenCalled();
  const save = () => f.request('POST', '/api/settings/apply', { operation: 'wayroost.preferences', params: { feed: { level: 'high' } } });
  expect((await save()).json()).toMatchObject({ status: 'refused', code: 'consumer_refused', change: { effective: 'mismatch', undoable: true } });
  expect((await f.request('GET', '/api/settings/checks')).json().rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'wayroost.pulse-drift', state: 'fail' }),
  ]));
  expect(JSON.parse(readFileSync(f.path, 'utf8')).feed.level).toBe('high');
  expect((await save()).json()).toMatchObject({ status: 'refused', code: 'consumer_refused', change: { effective: 'mismatch' } });
  expect(jobs.map(job => job.state)).toEqual(['paused', 'paused']);
  const calls = schedules.setPaused.mock.calls.length;
  await f.restart();
  expect(schedules.setPaused).toHaveBeenCalledTimes(calls);
  expect((await f.request('GET', '/api/settings/notifications')).statusCode).toBe(200);
  expect(schedules.setPaused).toHaveBeenCalledTimes(calls);
  fail = false;
  expect((await save()).json()).toMatchObject({ status: 'applied', change: { effective: 'verified' } });
  expect((await f.request('GET', '/api/settings/checks')).json().rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'wayroost.pulse-drift', state: 'ok' }),
  ]));
  expect(schedules.setPaused.mock.calls.length).toBeGreaterThan(calls);
  expect(jobs.map(job => job.state)).toEqual(['active', 'active']);
  expect(jobs[1]!.scheduleInput).toBe(SCOUT_SCHEDULES.high);
  for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
});

it.each(['apply', 'undo'] as const)('retains interrupted pulse work across restart after an owner %s', async action => {
  const { jobs, schedules } = pulseSchedules();
  const f = await fixture(initial, true, false, schedules);
  const payload = { operation: 'wayroost.preferences', params: { feed: { level: 'high' } } };
  const change = action === 'undo' ? (await f.request('POST', '/api/settings/apply', payload)).json().change.id : undefined;
  let entered!: () => void;
  const applying = new Promise<void>(resolve => { entered = resolve; });
  let interrupt!: () => void;
  const interrupted = new Promise<void>((_resolve, reject) => { interrupt = () => reject(new Error('invented interrupted consumer')); });
  const consumer = vi.spyOn(f.feed, 'applyPreferences').mockImplementationOnce(async () => { entered(); await interrupted; });
  const lost = f.request('POST', action === 'apply' ? '/api/settings/apply' : '/api/settings/undo', action === 'apply' ? payload : { change });
  await applying;
  const level = action === 'apply' ? 'high' : 'off';
  expect(JSON.parse(readFileSync(f.path, 'utf8')).feed.level).toBe(level);
  await f.restart();
  expect(consumer).toHaveBeenCalledOnce();
  expect((await f.request('GET', '/api/settings/notifications')).statusCode).toBe(200);
  expect(consumer).toHaveBeenCalledOnce();
  interrupt(); await lost;
  expect((await f.request('POST', '/api/settings/apply', { operation: 'wayroost.preferences', params: { feed: { level } } })).json())
    .toMatchObject({ status: 'applied', change: { effective: 'verified' } });
  expect(consumer).toHaveBeenCalledTimes(2);
  expect(jobs.map(job => job.state)).toEqual(action === 'apply' ? ['active', 'active'] : ['paused', 'paused']);
  if (action === 'apply') expect(jobs[1]!.scheduleInput).toBe(SCOUT_SCHEDULES.high);
  for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
});

it.each([false, true].flatMap(restart => [false, true].map(fail => ({ restart, fail }))))
('applies recovered pulse work immediately (restart: $restart, consumer failure: $fail)', async ({ restart, fail }) => {
  const { jobs, schedules } = pulseSchedules();
  const f = await fixture(initial, true, false, schedules);
  const apply = f.supervisor.configApply.getMockImplementation()!;
  let status!: ConfigRequestStatusResult;
  f.supervisor.configApply.mockImplementationOnce(async request => {
    const result = await apply(request);
    if (!result.ok || !('undo' in result)) throw new Error('missing apply receipt');
    status = { ok: true, requestId: request.requestId, state: 'terminal', outcome: 'applied', row: {
      id: request.requestId, time: '2026-01-01T00:00:00.000Z', caller: 'server', verb: 'config.apply',
      operation: result.operation, target: result.target, keys: result.keys, backupId: result.backupId,
      backupSha256: result.backupSha256, writtenSha256: result.writtenSha256, change: request.origin!.change, result: 'ok',
    } };
    throw new Error('invented lost supervisor reply');
  });
  const save = () => f.request('POST', '/api/settings/apply', { operation: 'wayroost.preferences', params: { feed: { level: 'high' } } });
  expect((await save()).json()).toMatchObject({ status: 'refused', code: 'outcome_unknown' });
  expect(schedules.setPaused).not.toHaveBeenCalled();
  if (fail) schedules.setPaused.mockRejectedValueOnce(new Error('invented schedule outage'));
  f.supervisor.configRequestStatus.mockResolvedValue(status);
  if (restart) await f.restart();
  const response = await f.request('GET', '/api/settings/notifications');
  if (!restart && fail) expect(response.json()).toMatchObject({ code: 'consumer_refused', change: { effective: 'mismatch' } });
  else expect(response.statusCode).toBe(200);
  expect((await f.request('GET', '/api/settings/changes')).json().changes[0]).toMatchObject({ result: fail ? 'consumer_refused' : 'ok' });
  expect((await f.request('GET', '/api/settings/checks')).json().rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'wayroost.pulse-drift', state: fail ? 'fail' : 'ok' }),
  ]));
  expect(jobs.map(job => job.state)).toEqual(fail ? ['paused', 'paused'] : ['active', 'active']);
  if (fail) {
    await f.restart();
    expect((await save()).json()).toMatchObject({ status: 'applied', change: { effective: 'verified' } });
  }
  expect(schedules.setPaused).toHaveBeenCalledTimes(fail ? 3 : 2);
  expect(jobs.map(job => job.state)).toEqual(['active', 'active']);
  expect(jobs[1]!.scheduleInput).toBe(SCOUT_SCHEDULES.high);
  for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
});

it('retains completed pulse work for retry when its durable completion fails', async () => {
  const { jobs, schedules } = pulseSchedules();
  const f = await fixture(initial, true, false, schedules);
  const append = EventJournal.prototype.append;
  const journal = vi.spyOn(EventJournal.prototype, 'append').mockImplementation(function (this: EventJournal, input) {
    if (input.type === 'settings-feed-work' && (input.data as { pending: boolean }).pending === false) throw new Error('invented consumer audit failure');
    return append.call(this, input);
  });
  const save = () => f.request('POST', '/api/settings/apply', { operation: 'wayroost.preferences', params: { feed: { level: 'high' } } });
  expect((await save()).json()).toMatchObject({ status: 'refused', code: 'audit_unavailable' });
  expect((await f.request('GET', '/api/settings/notifications')).json()).toMatchObject({ code: 'audit_unavailable' });
  expect(f.feed.preferences().level).toBe('off');
  expect(f.notifications.decide('agent-needs-you', 'hermes')).toMatchObject({ push: false });
  expect(schedules.setPaused).toHaveBeenCalledTimes(2);
  expect(jobs.map(job => job.state)).toEqual(['active', 'active']);
  journal.mockRestore();
  await f.restart();
  expect(schedules.setPaused).toHaveBeenCalledTimes(2);
  expect((await save()).json()).toMatchObject({ status: 'applied', change: { effective: 'verified' } });
  expect(schedules.setPaused).toHaveBeenCalledTimes(4);
  await f.restart();
  expect((await save()).json()).toMatchObject({ status: 'applied', change: { effective: 'verified' } });
  expect(schedules.setPaused).toHaveBeenCalledTimes(4);
  for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
});

it('does not create pulse work on startup, ordinary reads or unrelated successful saves', async () => {
  const { schedules } = pulseSchedules();
  const f = await fixture(initial, true, false, schedules);
  expect((await f.request('GET', '/api/settings/notifications')).statusCode).toBe(200);
  expect((await f.request('PUT', '/api/voice', { voice: 'af_heart' })).statusCode).toBe(200);
  await f.restart();
  expect((await f.request('GET', '/api/settings/notifications')).statusCode).toBe(200);
  expect(schedules.setPaused).not.toHaveBeenCalled(); expect(schedules.update).not.toHaveBeenCalled();
  expect(existsSync(join(f.config.stateDir, 'settings-consumers.jsonl'))).toBe(false);
  for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
});

it('does not recover feedback-only writes as pulse changes after a lost reply', async () => {
  const { schedules } = pulseSchedules();
  const f = await fixture({ ...initial, feed: { level: 'high', lessLike: [] } }, true, false, schedules);
  const apply = f.supervisor.configApply.getMockImplementation()!;
  let status!: ConfigRequestStatusResult;
  f.supervisor.configApply.mockImplementationOnce(async request => {
    const result = await apply(request);
    if (!result.ok || !('undo' in result)) throw new Error('missing receipt');
    status = { ok: true, requestId: request.requestId, state: 'terminal', outcome: 'applied', row: {
      id: request.requestId, time: '2026-01-01T00:00:00.000Z', caller: 'server', verb: 'config.apply',
      operation: result.operation, target: result.target, keys: result.keys, change: request.origin!.change, result: 'ok',
      backupId: result.backupId, backupSha256: result.backupSha256, writtenSha256: result.writtenSha256,
    } };
    throw new Error('invented lost reply');
  });
  expect((await f.request('POST', '/api/settings/apply', { operation: 'wayroost.preferences', params: {
    feed: { lessLike: [{ topic: 'Example', example: 'Invented card', at: 1 }] },
  } })).json()).toMatchObject({ code: 'outcome_unknown' });
  f.supervisor.configRequestStatus.mockResolvedValue(status);
  await f.restart();
  expect((await f.request('PUT', '/api/voice', { voice: 'af_heart' })).statusCode).toBe(200);
  expect(schedules.setPaused).not.toHaveBeenCalled();
  expect(schedules.update).not.toHaveBeenCalled();
});

it.each([false, true])('keeps actual pulse work through confirmed manual acceptance and restart (consumer failure: %s)', async fail => {
  const { jobs, schedules } = pulseSchedules();
  const f = await fixture(initial, true, false, schedules);
  const apply = f.supervisor.configApply.getMockImplementation()!;
  f.supervisor.configApply.mockImplementationOnce(async request => { await apply(request); throw new Error('invented lost reply'); });
  expect((await f.request('POST', '/api/settings/apply', { operation: 'wayroost.preferences', params: { feed: { level: 'high' } } })).json())
    .toMatchObject({ code: 'outcome_unknown' });
  const change = (await f.request('GET', '/api/settings/changes')).json().changes[0].id;
  const accept = (confirm?: string) => f.request('POST', '/api/settings/apply', { operation: 'settings.accept-current',
    params: { target: 'wayroost-settings', change }, ...(confirm ? { confirm } : {}) });
  const challenge = (await accept()).json();
  expect(challenge.status).toBe('confirm');
  if (fail) schedules.setPaused.mockRejectedValueOnce(new Error('invented schedule outage'));
  expect((await accept(challenge.confirm)).json()).toMatchObject(fail ? { status: 'refused', code: 'consumer_refused' } : { status: 'applied' });
  await f.restart();
  expect((await f.request('POST', '/api/settings/apply', { operation: 'wayroost.preferences', params: { feed: { level: 'high' } } })).json())
    .toMatchObject({ status: 'applied', change: { effective: 'verified' } });
  expect(jobs.map(job => job.state)).toEqual(['active', 'active']);
  expect(schedules.setPaused).toHaveBeenCalledTimes(fail ? 3 : 2);
});

it('refuses pulse application without schedules and retains work for a restored service', async () => {
  const f = await fixture(initial, true, false, null);
  const save = () => f.request('POST', '/api/settings/apply', { operation: 'wayroost.preferences', params: { feed: { level: 'high' } } });
  expect((await save()).json()).toMatchObject({ code: 'consumer_refused', change: { effective: 'mismatch' } });
  await f.restart();
  expect((await save()).json()).toMatchObject({ code: 'consumer_refused' });
  const { jobs, schedules } = pulseSchedules();
  // A restarted consumer uses the newly available schedule service.
  const consumer = new Feed({
    store: new FeedStore(f.config.stateDir, Date.now, true), hub: new EventHub(), hermes: new FakeHermes(),
    schedules, log: { info() {}, warn() {} },
  });
  consumer.useSettingsSource(() => ({ quietHours: null, push: { approvals: false, cards: false }, lessLike: [], level: 'high' }));
  vi.spyOn(f.feed, 'applyPreferences').mockImplementation(() => consumer.applyPreferences());
  expect((await save()).json()).toMatchObject({ status: 'applied', change: { effective: 'verified' } });
  expect(jobs.map(job => job.state)).toEqual(['active', 'active']);
});

it.each([false, true])('reports unrelated saves and dismisses less-like cards while pulse work is pending (restart: %s)', async restart => {
  const f = await fixture(initial, true, false, null);
  const consumer = vi.spyOn(f.feed, 'applyPreferences');
  expect((await f.request('POST', '/api/settings/apply', { operation: 'wayroost.preferences', params: { feed: { level: 'high' } } })).json())
    .toMatchObject({ status: 'refused', code: 'consumer_refused' });
  if (restart) await f.restart();
  const safety = await f.request('PUT', '/api/safety-commands', { enabled: true });
  expect(safety.statusCode).toBe(200);
  expect(safety.json()).toMatchObject({ enabled: true, warnings: ['pulse_pending'] });
  expect((await f.request('GET', '/api/safety-commands')).json().enabled).toBe(true);
  expect(f.safety.enabled()).toBe(true);
  const workers = await f.request('PUT', '/api/worker-updates', { enabled: true, defaultMinutes: 30 });
  expect(workers.statusCode).toBe(200);
  expect(workers.json()).toMatchObject({ enabled: true, defaultMinutes: 30, warnings: ['pulse_pending'] });
  const quietHours = { start: '22:00', end: '06:00' };
  const quiet = await f.request('PUT', '/api/settings/notifications', { quietHours });
  expect(quiet.statusCode).toBe(200);
  const changed = settingsApplyResponseSchema.parse(quiet.json());
  expect(changed).toMatchObject({ status: 'applied', change: { effective: 'verified' }, warnings: ['pulse_pending'] });
  expect(f.notifications.settings().quietHours).toEqual(quietHours);
  if (changed.status !== 'applied') throw new Error('missing change');
  expect((await f.request('POST', '/api/settings/undo', { change: changed.change.id })).json())
    .toMatchObject({ status: 'applied', change: { effective: 'verified' }, warnings: ['pulse_pending'] });
  expect((await f.request('PUT', '/api/feed/settings', { quietHours })).json())
    .toMatchObject({ quietHours, warnings: ['pulse_pending'] });
  f.feed.ingest('scout', [{ key: 'example:feedback', kind: 'reply', title: 'Invented card', topic: 'Example topic' }]);
  const card = (await f.feed.list()).cards[0]!;
  const less = await f.request('POST', `/api/feed/${card.id}/action`, { action: 'less' });
  expect(less.statusCode).toBe(200);
  expect(less.json()).toMatchObject({ card: { status: 'dismissed' }, warnings: ['pulse_pending'] });
  expect((await f.feed.list()).cards).toEqual([]);
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toMatchObject({ safetyCommandsEnabled: true, workerUpdates: { enabled: true },
    quietHours, feed: { level: 'high', lessLike: [{ topic: 'Example topic' }] } });
  expect(consumer).toHaveBeenCalledOnce();
  expect((await f.request('GET', '/api/settings/checks')).json().rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'wayroost.pulse-drift', state: 'fail', fix: { operation: 'wayroost.preferences', params: { feed: { level: 'high' } } } }),
  ]));
  const changes = (await f.request('GET', '/api/settings/changes')).json().changes;
  expect(changes.filter((change: { operation: string; result: string }) => change.operation !== 'wayroost.preferences').every((change: { result: string }) => change.result === 'ok')).toBe(true);
  for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
});

it.each(['quiet-hours', 'checks', 'recent changes'])('finishes failed recovery before running an unrelated %s request', async route => {
  const f = await fixture(initial, true, false, null);
  const consumer = vi.spyOn(f.feed, 'applyPreferences');
  const publish = vi.spyOn(f.hub, 'publish');
  const apply = f.supervisor.configApply.getMockImplementation()!;
  let status!: Extract<ConfigRequestStatusResult, { state: 'terminal' }>;
  f.supervisor.configApply.mockImplementationOnce(async request => {
    const result = await apply(request);
    if (!result.ok || !('undo' in result)) throw new Error('missing receipt');
    status = { ok: true, requestId: request.requestId, state: 'terminal', outcome: 'applied', row: {
      id: request.requestId, time: '2026-01-01T00:00:00.000Z', caller: 'server', verb: 'config.apply',
      operation: result.operation, target: result.target, keys: result.keys, change: request.origin!.change, result: 'ok',
      backupId: result.backupId, backupSha256: result.backupSha256, writtenSha256: result.writtenSha256,
    } };
    throw new Error('invented lost reply');
  });
  expect((await f.request('POST', '/api/settings/apply', { operation: 'wayroost.preferences', params: { feed: { level: 'high' } } })).json())
    .toMatchObject({ code: 'outcome_unknown' });
  f.supervisor.configRequestStatus.mockResolvedValue(status);
  publish.mockClear();
  if (route !== 'quiet-hours') {
    const read = await f.request('GET', route === 'checks' ? '/api/settings/checks' : '/api/settings/changes');
    expect(read.statusCode).toBe(200);
    if (route === 'checks') expect(read.json().rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'wayroost.pulse-drift', state: 'fail' }),
    ]));
    else expect(read.json().changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: status.row.change, result: 'consumer_refused' }),
    ]));
  }
  const quietHours = { start: '23:00', end: '05:00' };
  const response = await f.request('PUT', '/api/settings/notifications', { quietHours });
  expect(response.statusCode).toBe(200);
  const saved = settingsApplyResponseSchema.parse(response.json());
  expect(saved).toMatchObject({ status: 'applied', warnings: ['pulse_pending'], change: { operation: 'wayroost.notifications', effective: 'verified' } });
  if (saved.status !== 'applied') throw new Error('missing quiet-hours change');
  expect(saved.change.id).not.toBe(status.row.change);
  expect(JSON.parse(readFileSync(f.path, 'utf8')).quietHours).toEqual(quietHours);
  const changes = (await f.request('GET', '/api/settings/changes')).json().changes;
  expect(changes).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: status.row.change, result: 'consumer_refused', undoable: true }),
    expect.objectContaining({ id: saved.change.id, result: 'ok' }),
  ]));
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'settings_changed', change: status.row.change }));
  expect((await f.request('GET', '/api/settings/checks')).json().rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'wayroost.pulse-drift', state: 'fail' }),
  ]));
  expect(consumer).toHaveBeenCalledOnce();
  expect(f.supervisor.configApply).toHaveBeenCalledTimes(2);
  for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
});

it.each(['startup', 'runtime'] as const)('holds saved worker news and due nudges during %s unavailability', async scenario => {
  const f = await fixture({ ...initial, workerUpdates: { enabled: true } }, true, scenario === 'startup');
  const now = 1_800_000_000_000;
  const log = { info() {}, warn() {}, error() {} };
  const store = new TaskStore(f.config.stateDir, () => now, undefined, log);
  const records: TaskRecord[] = ['finished', 'running'].map((status, i) => ({
    id: `deadbeef-0000-0000-0000-00000000000${i}`, provider: 'pi', cwd: '/home/me/project', chat: 'example-chat',
    verified: true, via: 'bridge', createdAt: now - 600_000, startedAt: now - 600_000,
    dueMinutes: 1, dueAt: now - 540_000, status: status as TaskRecord['status'], round: 1,
    since: now - 300_000, changedAt: now - 300_000, lastSeen: now,
    relays: i ? [] : [{ id: 'finished#1', kind: 'update', attempts: 1, queuedAt: now - 200_000 }],
  }));
  for (const record of records) store.add(record);
  store.save();
  const snapshots: WorkerSnapshot[] = records.map(record => ({ id: record.id, provider: 'pi', cwd: '/home/me/project',
    createdAt: record.createdAt, loaded: true, pendingPermissions: 0, labels: {}, status: record.status === 'running' ? 'running' : 'idle' }));
  const messages: SystemMessage[] = [];
  const bridge = { deliverSystem: vi.fn((message: SystemMessage) => { messages.push(message); return 'queued' as const; }),
    withdrawSystem: vi.fn(() => true), watch() {}, status: () => ({ paused: false }) };
  const relay = new TaskRelay({ background: new BackgroundGate('primary'), setting: f.workers, store,
    hub: new EventHub(), bridge, log, now: () => now, tickMs: 0,
    workers: { agentsLoaded: true, workerSnapshot: id => snapshots.find(s => s.id === id), workerSnapshots: () => snapshots,
      lookUp: async id => snapshots.find(s => s.id === id) ?? null, lastMessage: async () => 'Invented completion' },
    chats: { connected: () => true, rows: async () => [], find: async () => undefined, origin: async () => undefined },
  });
  const observer = vi.fn(); f.workers.watch(observer);
  if (scenario === 'runtime') {
    relay.start();
    await relay.tick();
    expect(messages.length).toBeGreaterThan(0);
    f.supervisor.configRead.mockRejectedValue(new Error('invented owner outage'));
    await f.request('GET', '/api/settings/notifications');
  } else relay.start();
  try {
    expect(store.all().flatMap(task => task.relays).every(record => !record.skipped)).toBe(true);
    const handed = bridge.deliverSystem.mock.calls.length;
    await relay.tick();
    for (const message of messages) expect(await message.stillWanted!()).toBe(false);
    expect(bridge.deliverSystem).toHaveBeenCalledTimes(handed);
    expect(bridge.withdrawSystem).not.toHaveBeenCalled();
    expect(store.all().flatMap(task => task.relays).every(record => !record.skipped)).toBe(true);
    expect(JSON.parse(readFileSync(join(f.config.stateDir, 'tasks.json'), 'utf8')).tasks[0].relays[0].skipped).toBeUndefined();
    expect(observer).not.toHaveBeenCalled();
    expect(f.workers.state()).toBe('unknown');
    // Only a verified explicit off choice cancels queued updates.
    f.supervisor.configRead.mockImplementation(async request => request.view === 'wayroost.settings'
      ? await executeConfig({ site: f.site, caller: 'server', verb: 'config.read', request }) as Awaited<ReturnType<typeof f.supervisor.configRead>>
      : { ok: false, code: 'not_configured' } as never);
    writeFileSync(f.path, JSON.stringify({ ...initial, workerUpdates: { enabled: false } }), { mode: 0o600 });
    await f.request('GET', '/api/settings/notifications');
    expect(f.workers.state()).toBe('verified-off');
    expect(store.all().flatMap(task => task.relays).every(record => record.skipped === 'switched off')).toBe(true);
    expect(observer).toHaveBeenCalledOnce();
  } finally { relay.stop(); }
});

it.each(['recipient', 'composition'] as const)('retries worker news after settings disappear during awaited %s work', async stage => {
  const f = await fixture({ ...initial, workerUpdates: { enabled: true } });
  const now = 1_800_000_000_000;
  const log = { info() {}, warn() {}, error() {} };
  const store = new TaskStore(f.config.stateDir, () => now, undefined, log);
  const task = store.add({ id: 'deadbeef-0000-0000-0000-000000000000', provider: 'pi', cwd: '/home/me/project', chat: 'example-chat',
    verified: true, via: 'bridge', createdAt: now - 600_000, startedAt: now - 600_000,
    dueMinutes: 1, dueAt: now - 540_000, status: 'finished', round: 1,
    since: now - 300_000, changedAt: now - 300_000, lastSeen: now, relays: [] });
  store.save();
  const snapshot: WorkerSnapshot = { id: task.id, provider: 'pi', cwd: '/home/me/project', createdAt: task.createdAt,
    loaded: true, pendingPermissions: 0, labels: {}, status: 'idle' };
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const find = vi.fn(async () => undefined);
  const lastMessage = vi.fn(async () => 'Invented completion');
  if (stage === 'recipient') find.mockImplementationOnce(async () => undefined).mockImplementationOnce(async () => { entered(); await pending; return undefined; });
  else lastMessage.mockImplementationOnce(async () => { entered(); await pending; return 'Invented completion'; });
  const bridge = { deliverSystem: vi.fn((_message: SystemMessage) => 'queued' as const), withdrawSystem: vi.fn(() => true),
    watch() {}, status: () => ({ paused: false }) };
  const relay = new TaskRelay({ background: new BackgroundGate('primary'), setting: f.workers, store,
    hub: new EventHub(), bridge, log, now: () => now, tickMs: 0,
    workers: { agentsLoaded: true, workerSnapshot: () => snapshot, workerSnapshots: () => [snapshot], lookUp: async () => snapshot, lastMessage },
    chats: { connected: () => true, rows: async () => [], find, origin: async () => undefined } });
  relay.start();
  try {
    const tick = relay.tick();
    await waiting;
    const read = f.supervisor.configRead.getMockImplementation()!;
    f.supervisor.configRead.mockRejectedValue(new Error('invented owner outage'));
    await f.request('GET', '/api/settings/notifications');
    expect(f.workers.state()).toBe('unknown');
    release(); await tick;
    expect(bridge.deliverSystem).not.toHaveBeenCalled();
    expect(task.relays).toEqual([]);
    f.supervisor.configRead.mockImplementation(read);
    expect((await f.request('GET', '/api/settings/notifications')).statusCode).toBe(200);
    expect(f.workers.state()).toBe('verified-on');
    await relay.tick();
    expect(bridge.deliverSystem).toHaveBeenCalledOnce();
    expect(task.relays[0]).toMatchObject({ id: 'finished#1', attempts: 1, queuedAt: now });
    expect(JSON.parse(readFileSync(join(f.config.stateDir, 'tasks.json'), 'utf8')).tasks[0].relays[0]).toMatchObject({ queuedAt: now });
    await relay.tick();
    expect(bridge.deliverSystem).toHaveBeenCalledOnce();
  } finally { release(); relay.stop(); }
});

it('preserves opaque private feed preferences during ingest and notification bookkeeping', async () => {
  const f = await fixture();
  const path = join(f.config.stateDir, 'feed.json');
  const settings = { level: 'normal', lessLike: [{ topic: 'Example', example: 'Invented', at: 1 }], quietHours: null,
    push: { approvals: false, cards: true }, future: { enabled: false } };
  writeFileSync(path, JSON.stringify({ cards: [], notified: [], settings }));
  const store = new FeedStore(f.config.stateDir, () => 1_800_000_000_000, true);
  store.ingest('scout', [{ key: 'example:opaque', kind: 'reply', title: 'Invented card' }]);
  expect(JSON.parse(readFileSync(path, 'utf8')).settings).toEqual(settings);
  store.markNotified('example-approval');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ settings, notified: ['example-approval'] });
});

it('retries unavailable owner reads at startup with serialized bounded backoff', async () => {
  vi.useFakeTimers();
  const f = await fixture(initial, true, true);
  const calls = f.supervisor.configRead.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.supervisor.configRead.mock.calls.length - calls).toBeGreaterThan(1);
  expect(f.supervisor.configRead.mock.calls.length - calls).toBeLessThanOrEqual(5);
  expect(f.workers.state()).toBe('unknown');
  const restored = new FakeSettingsSupervisor();
  restored.documents['wayroost-settings'] = { ...initial, workerUpdates: { enabled: true }, safetyCommandsEnabled: true };
  f.supervisor.configRead.mockImplementation(restored.configRead);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.workers.state()).toBe('verified-on');
  expect(f.safety.enabled()).toBe(true);
  const recovered = f.supervisor.configRead.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.supervisor.configRead).toHaveBeenCalledTimes(recovered);
  for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
});

it('keeps cards and local speech available while their settings are missing', async () => {
  const f = await fixture(null);
  f.feed.ingest('scout', [{ key: 'example:readable', kind: 'reply', title: 'Invented card' }]);
  const feed = await f.request('GET', '/api/feed');
  expect(feed.statusCode).toBe(200);
  expect(feed.json()).toMatchObject({ cards: [{ title: 'Invented card' }], settings: { settingsUnavailable: 'target_missing', push: { approvals: false, cards: false } } });
  expect((await f.request('GET', '/api/voice')).json()).toMatchObject({ enabled: true, available: true,
    settingsUnavailable: 'target_missing', canChange: false, defaultVoice: 'af_heart' });
});

it('normalizes feedback and deduplicates topics case-insensitively in the serialized merge', async () => {
  const f = await fixture({ ...initial, feed: { level: 'off', lessLike: [{ topic: 'example topic', example: 'Earlier', at: 1 }] } });
  f.feed.ingest('scout', [{ key: 'example:normalized', kind: 'reply', title: 'Invented\n card https://example.com', topic: '  Example\nTopic\u200b ' }]);
  const card = (await f.feed.list()).cards[0]!;
  expect((await f.request('POST', `/api/feed/${card.id}/action`, { action: 'less' })).statusCode).toBe(200);
  expect(f.feed.preferences().lessLike).toEqual([{ topic: 'Example Topic', example: 'Invented card [link]' }]);
});

it.each(['locked', 'not_rolled_out', 'parse_failed'] as const)('reports the specific %s refusal without dismissing feedback', async code => {
  const f = await fixture();
  f.feed.ingest('scout', [{ key: 'example:refused', kind: 'reply', title: 'Invented card', topic: 'Example' }]);
  const card = (await f.feed.list()).cards[0]!;
  f.supervisor.configApply.mockResolvedValueOnce({ ok: false, code });
  const response = await f.request('POST', `/api/feed/${card.id}/action`, { action: 'less' });
  expect(response.statusCode).toBeGreaterThanOrEqual(400);
  expect(response.json().error).not.toContain('Owner-held settings are unavailable');
  expect((await f.feed.list()).cards[0]?.status).toBe('new');
});

it('validates direct voice choices and propagates verified applies and undo to phone voice', async () => {
  const setPhoneVoice = vi.fn(async () => {});
  const f = await fixture({ ...initial, voice: { voice: 'af_bella', appReadAloud: { provider: 'local' } } }, true, false, undefined,
    { phone: { setPhoneVoice } as unknown as NonNullable<AppDeps['phone']> });
  const save = (voice: object) => f.request('POST', '/api/settings/apply', { operation: 'wayroost.voice', params: { voice } });
  expect((await save({ voice: 'af_missing' })).json()).toMatchObject({ code: 'invalid_parameters' });
  expect((await save({ appReadAloud: { provider: 'elevenlabs', voiceId: 'missing_voice', modelId: 'example_model' } })).json())
    .toMatchObject({ code: 'invalid_parameters' });
  expect(f.supervisor.configApply).not.toHaveBeenCalled(); expect(setPhoneVoice).not.toHaveBeenCalled();
  const changed = (await save({ voice: 'af_heart' })).json();
  expect(changed).toMatchObject({ status: 'applied', change: { effective: 'verified' } });
  expect(setPhoneVoice).toHaveBeenLastCalledWith('af_heart');
  expect((await f.request('POST', '/api/settings/undo', { change: changed.change.id })).json().status).toBe('applied');
  expect(setPhoneVoice).toHaveBeenLastCalledWith('af_bella');
  expect(setPhoneVoice).toHaveBeenCalledTimes(2);
  expect((await f.request('PUT', '/api/voice', { voice: 'af_heart' })).json()).toMatchObject({ calls: 'updated' });
  expect(setPhoneVoice).toHaveBeenCalledTimes(3);
});

it.each(['apply', 'undo'].flatMap(action => ['ordinary', 'startup'].flatMap(resolution =>
  ['hash', 'read'].map(failure => ({ action, resolution, failure })))))
('retains committed phone work when $resolution $action verification fails at $failure', async ({ action, resolution, failure }) => {
  const setPhoneVoice = vi.fn(async () => {});
  const f = await fixture({ ...initial, voice: { voice: 'af_bella', appReadAloud: { provider: 'local' } } }, true, false, undefined,
    { phone: { setPhoneVoice } as unknown as NonNullable<AppDeps['phone']> });
  const save = () => f.request('POST', '/api/settings/apply', { operation: 'wayroost.voice', params: { voice: { voice: 'af_heart' } } });
  const previous = action === 'undo' ? (await save()).json().change.id : undefined;
  setPhoneVoice.mockClear();
  const receipt = async <T extends ConfigApplyRequest | ConfigUndoRequest>(request: T, write: (request: T) => Promise<ConfigWriteResult>) => {
    const result = await write(request);
    if (!result.ok || !('undo' in result)) throw new Error('missing receipt');
    if (failure === 'hash') writeFileSync(f.path, JSON.stringify({ ...JSON.parse(readFileSync(f.path, 'utf8')), timeZone: 'Etc/UTC' }));
    else f.supervisor.configRead.mockRejectedValue(new Error('invented verification outage'));
    if (resolution === 'startup') {
      f.supervisor.configRequestStatus.mockResolvedValue({ ok: true, requestId: request.requestId, state: 'terminal', outcome: 'applied', row: {
        id: request.requestId, time: '2026-01-01T00:00:00.000Z', caller: 'server', verb: action === 'apply' ? 'config.apply' : 'config.undo',
        operation: result.operation, target: result.target, keys: result.keys, change: request.origin!.change, result: 'ok',
        backupId: result.backupId, backupSha256: result.backupSha256, writtenSha256: result.writtenSha256,
      } });
      throw new Error('invented lost reply');
    }
    return result;
  };
  if (action === 'apply') {
    const write = f.supervisor.configApply.getMockImplementation()!;
    f.supervisor.configApply.mockImplementationOnce(request => receipt(request, write));
  } else {
    const write = f.supervisor.configUndo.getMockImplementation()!;
    f.supervisor.configUndo.mockImplementationOnce(request => receipt(request, write));
  }
  const changed = (await (action === 'apply' ? save() : f.request('POST', '/api/settings/undo', { change: previous }))).json();
  expect(changed).toMatchObject({ status: 'refused', code: resolution === 'startup' || failure === 'read' ? 'outcome_unknown' : 'verify_mismatch' });
  if (resolution === 'startup') await f.restart();
  expect(JSON.parse(readFileSync(f.path, 'utf8')).voice.voice).toBe(action === 'apply' ? 'af_heart' : 'af_bella');
  expect(setPhoneVoice).not.toHaveBeenCalled();
  const phoneRow = async () => settingsChecksResponseSchema.parse((await f.request('GET', '/api/settings/checks')).json())
    .rows.find(row => row.id === 'phone.voice');
  expect(await phoneRow()).toMatchObject({ state: 'warn', priority: 'high' });
  await f.restart();
  expect(await phoneRow()).toMatchObject({ state: 'warn', priority: 'high' });
  expect(setPhoneVoice).not.toHaveBeenCalled();
});

it('records each phone transition once and marks an outage high priority', async () => {
  const setPhoneVoice = vi.fn(async () => {});
  const f = await fixture(initial, true, false, undefined, { phone: { setPhoneVoice } as unknown as NonNullable<AppDeps['phone']> });
  const consumerPath = join(f.config.stateDir, 'settings-consumers.jsonl');
  const events = () => readFileSync(consumerPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(event => event.type === 'settings-phone-voice').map(event => event.data);
  const save = () => f.request('POST', '/api/settings/apply', { operation: 'wayroost.voice', params: { voice: { voice: 'af_heart' } } });
  const changed = (await save()).json();
  expect(changed).toMatchObject({ status: 'applied', calls: 'updated' });
  expect(events()).toEqual([{ change: changed.change.id, pending: true }, { change: changed.change.id, pending: false }]);
  setPhoneVoice.mockRejectedValueOnce(new Error('invented phone outage'));
  const failed = (await save()).json();
  expect(failed).toMatchObject({ status: 'applied', calls: 'failed' });
  expect(events().slice(2)).toEqual([{ change: failed.change.id, pending: true }]);
  const snapshot = settingsChecksResponseSchema.parse((await f.request('GET', '/api/settings/checks')).json());
  expect(snapshot.rows.find(row => row.id === 'phone.voice')).toMatchObject({ state: 'warn', priority: 'high', details: [failed.change.id] });
  await f.restart();
  const restarted = settingsChecksResponseSchema.parse((await f.request('GET', '/api/settings/checks')).json());
  expect(restarted.rows.find(row => row.id === 'phone.voice')).toMatchObject({ state: 'warn', details: [failed.change.id] });
});

it.each(['verify_mismatch', 'unavailable', 'outcome_unknown'] as const)('retains phone work when the executor reports a committed %s', async code => {
  const setPhoneVoice = vi.fn(async () => {});
  const f = await fixture(initial, true, false, undefined, { phone: { setPhoneVoice } as unknown as NonNullable<AppDeps['phone']> });
  const write = f.supervisor.configApply.getMockImplementation()!;
  f.supervisor.configApply.mockImplementationOnce(async request => {
    const result = await write(request);
    if (!result.ok || !('undo' in result)) throw new Error('missing receipt');
    return { ok: false, code, committed: true, undo: result.undo };
  });
  expect((await f.request('PUT', '/api/voice', { voice: 'af_heart' })).json()).toMatchObject({ status: 'refused', code });
  expect(JSON.parse(readFileSync(f.path, 'utf8')).voice.voice).toBe('af_heart');
  expect(setPhoneVoice).not.toHaveBeenCalled();
  const phoneRow = async () => settingsChecksResponseSchema.parse((await f.request('GET', '/api/settings/checks')).json())
    .rows.find(row => row.id === 'phone.voice');
  expect(await phoneRow()).toMatchObject({ state: 'warn', priority: 'high' });
  await f.restart();
  expect(await phoneRow()).toMatchObject({ state: 'warn', priority: 'high' });
  if (code !== 'outcome_unknown') {
    expect((await f.request('PUT', '/api/voice', { voice: 'af_heart' })).json()).toMatchObject({ calls: 'updated' });
    expect(await phoneRow()).toMatchObject({ state: 'ok' });
  }
});

it.each(['none', 'phone', 'feed'].flatMap(consumer => ['missing', 'corrupt', 'locked'].map(journal => ({ consumer, journal }))))
('keeps Checks available with $consumer consumers and a $journal consumer journal', async ({ consumer, journal }) => {
  const row = { id: 'example.health', state: 'ok' as const, sentence: 'Example check is available.' };
  const f = await fixture(initial, true, false, undefined, {
    ...(consumer !== 'feed' ? { feed: undefined } : {}),
    ...(consumer === 'phone' ? { phone: { setPhoneVoice: vi.fn(async () => {}) } as unknown as NonNullable<AppDeps['phone']> } : {}),
    settings: { checks: { rows: async () => ({ generatedAt: 0, rows: [row] }) } },
  });
  const consumerPath = join(f.config.stateDir, 'settings-consumers.jsonl');
  if (journal !== 'missing') writeFileSync(consumerPath, journal === 'corrupt' ? '{bad journal}\n' : '');
  if (journal === 'locked') mkdirSync(consumerPath + '.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await f.request('GET', '/api/settings/checks');
    expect(response.statusCode).toBe(200);
    const snapshot = settingsChecksResponseSchema.parse(response.json());
    expect(snapshot.rows).toContainEqual(row);
    expect(snapshot.unavailable).toBeUndefined();
    if (consumer === 'none') expect(snapshot.rows).toEqual([row]);
    else expect(snapshot.rows.find(entry => entry.id === (consumer === 'phone' ? 'phone.voice' : 'wayroost.pulse-drift')))
      .toMatchObject({ state: journal === 'missing' ? 'ok' : 'unknown' });
  }
});

it.each([false, true])('keeps Checks available when recovery cannot record phone work (restart: %s)', async restart => {
  const row = { id: 'example.health', state: 'ok' as const, sentence: 'Example check is available.' };
  const setPhoneVoice = vi.fn(async () => {});
  const f = await fixture(initial, true, false, undefined, {
    feed: undefined, phone: { setPhoneVoice } as unknown as NonNullable<AppDeps['phone']>,
    settings: { checks: { rows: async () => ({ generatedAt: 0, rows: [row] }) } },
  });
  const write = f.supervisor.configApply.getMockImplementation()!;
  f.supervisor.configApply.mockImplementationOnce(async request => {
    const result = await write(request);
    if (!result.ok || !('undo' in result)) throw new Error('missing receipt');
    f.supervisor.configRequestStatus.mockResolvedValue({ ok: true, requestId: request.requestId, state: 'terminal', outcome: 'applied', row: {
      id: request.requestId, time: '2026-01-01T00:00:00.000Z', caller: 'server', verb: 'config.apply',
      operation: result.operation, target: result.target, keys: result.keys, change: request.origin!.change, result: 'ok',
      backupId: result.backupId, backupSha256: result.backupSha256, writtenSha256: result.writtenSha256,
    } });
    throw new Error('invented lost reply');
  });
  expect((await f.request('PUT', '/api/voice', { voice: 'af_heart' })).json()).toMatchObject({ code: 'outcome_unknown' });
  writeFileSync(join(f.config.stateDir, 'settings-consumers.jsonl'), '{bad journal}\n');
  if (restart) await f.restart();
  const response = await f.request('GET', '/api/settings/checks');
  expect(response.statusCode).toBe(200);
  const snapshot = settingsChecksResponseSchema.parse(response.json());
  expect(snapshot.rows).toContainEqual(row);
  expect(snapshot.rows.find(entry => entry.id === 'phone.voice')).toMatchObject({ state: 'unknown', sentence: 'Phone voice status is unavailable.' });
  expect(snapshot.rows.find(entry => entry.id === 'settings.blocked-wayroost-settings')).toMatchObject({ state: 'fail' });
  expect(setPhoneVoice).not.toHaveBeenCalled();
});

it.each([false, true])('reports verified voice applies and undo as applied when phone propagation fails (pulse pending: %s)', async pending => {
  const setPhoneVoice = vi.fn(async () => { throw new Error('invented phone outage'); });
  const f = await fixture({ ...initial, voice: { voice: 'af_bella', appReadAloud: { provider: 'local' } } }, true, false, null,
    { phone: { setPhoneVoice } as unknown as NonNullable<AppDeps['phone']> });
  const consumer = vi.spyOn(f.feed, 'applyPreferences');
  if (pending) expect((await f.request('POST', '/api/settings/apply', { operation: 'wayroost.preferences', params: { feed: { level: 'high' } } })).json())
    .toMatchObject({ code: 'consumer_refused' });
  const direct = await f.request('POST', '/api/settings/apply', { operation: 'wayroost.voice', params: { voice: { voice: 'af_heart' } } });
  expect(direct.statusCode).toBe(200);
  const changed = settingsApplyResponseSchema.parse(direct.json());
  expect(changed).toMatchObject({ status: 'applied', change: { effective: 'verified', undoable: true }, calls: 'failed',
    callsMessage: 'App voice saved. The phone and car lines could not be updated; try saving the voice again.' });
  if (pending) expect(changed).toMatchObject({ warnings: ['pulse_pending'] });
  if (changed.status !== 'applied') throw new Error('missing voice change');
  const undone = await f.request('POST', '/api/settings/undo', { change: changed.change.id });
  expect(undone.statusCode).toBe(200);
  expect(settingsApplyResponseSchema.parse(undone.json())).toMatchObject({ status: 'applied', change: { effective: 'verified' }, calls: 'failed' });
  const legacy = await f.request('PUT', '/api/voice', { voice: 'af_heart' });
  expect(legacy.statusCode).toBe(200);
  expect(legacy.json()).toMatchObject({ defaultVoice: 'af_heart', calls: 'failed',
    callsMessage: 'App voice saved. The phone and car lines could not be updated; try saving the voice again.' });
  if (pending) expect(legacy.json()).toMatchObject({ warnings: ['pulse_pending'] });
  expect(setPhoneVoice.mock.calls).toEqual([['af_heart'], ['af_bella'], ['af_heart']]);
  expect((await f.request('GET', '/api/settings/changes')).json().changes.filter((change: { operation: string }) => change.operation === 'wayroost.voice')
    .every((change: { result: string }) => change.result === 'ok')).toBe(true);
  expect(consumer).toHaveBeenCalledTimes(pending ? 1 : 0);
  for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
});

it.each(['automatic', 'startup', 'manual'].flatMap(resolution => ['apply', 'undo'].flatMap(action => [false, true].map(fail => ({ resolution, action, fail })))))
('propagates $resolution voice $action resolution and reports phone failure: $fail', async ({ resolution, action, fail }) => {
  const setPhoneVoice = vi.fn(async () => {});
  const f = await fixture({ ...initial, voice: { voice: 'af_bella', appReadAloud: { provider: 'local' } } }, true, false, undefined,
    { phone: { setPhoneVoice } as unknown as NonNullable<AppDeps['phone']> });
  const save = () => f.request('POST', '/api/settings/apply', { operation: 'wayroost.voice', params: { voice: { voice: 'af_heart' } } });
  const previous = action === 'undo' ? (await save()).json().change.id : undefined;
  setPhoneVoice.mockClear();
  let status!: Extract<ConfigRequestStatusResult, { state: 'terminal' }>;
  const lostReply = async <T extends ConfigApplyRequest | ConfigUndoRequest>(request: T, write: (request: T) => Promise<ConfigWriteResult>) => {
    const result = await write(request);
    if (!result.ok || !('undo' in result)) throw new Error('missing receipt');
    status = { ok: true, requestId: request.requestId, state: 'terminal', outcome: 'applied', row: {
      id: request.requestId, time: '2026-01-01T00:00:00.000Z', caller: 'server', verb: action === 'apply' ? 'config.apply' : 'config.undo',
      operation: result.operation, target: result.target, keys: result.keys, change: request.origin!.change, result: 'ok',
      backupId: result.backupId, backupSha256: result.backupSha256, writtenSha256: result.writtenSha256,
    } };
    throw new Error('invented lost reply');
  };
  if (action === 'apply') {
    const write = f.supervisor.configApply.getMockImplementation()!;
    f.supervisor.configApply.mockImplementationOnce(request => lostReply(request, write));
  } else {
    const write = f.supervisor.configUndo.getMockImplementation()!;
    f.supervisor.configUndo.mockImplementationOnce(request => lostReply(request, write));
  }
  expect((await (action === 'apply' ? save() : f.request('POST', '/api/settings/undo', { change: previous }))).json()).toMatchObject({ code: 'outcome_unknown' });
  expect(setPhoneVoice).not.toHaveBeenCalled();
  if (fail) setPhoneVoice.mockRejectedValueOnce(new Error('invented phone outage'));
  let response;
  if (resolution !== 'manual') {
    f.supervisor.configRequestStatus.mockResolvedValue(status);
    if (resolution === 'startup') await f.restart();
    response = await f.request('GET', '/api/settings/notifications');
  } else {
    const accept = (confirm?: string) => f.request('POST', '/api/settings/apply', { operation: 'settings.accept-current',
      params: { target: 'wayroost-settings', change: status.row.change }, ...(confirm ? { confirm } : {}) });
    const challenge = (await accept()).json();
    expect(challenge.status).toBe('confirm');
    expect(setPhoneVoice).not.toHaveBeenCalled();
    response = await accept(challenge.confirm);
  }
  const voice = action === 'apply' ? 'af_heart' : 'af_bella';
  expect(setPhoneVoice).toHaveBeenCalledExactlyOnceWith(voice);
  expect(response.statusCode).toBe(200);
  if (resolution === 'manual') expect(settingsApplyResponseSchema.parse(response.json())).toMatchObject({ status: 'applied',
    change: { effective: 'verified' }, calls: fail ? 'failed' : 'updated' });
  expect((await f.request('GET', '/api/settings/changes')).json().changes[0]).toMatchObject({ result: resolution === 'manual' ? 'outcome_unknown' : 'ok' });
  expect((await f.request('GET', '/api/voice')).json().defaultVoice).toBe(voice);
  const phoneRow = async () => settingsChecksResponseSchema.parse((await f.request('GET', '/api/settings/checks')).json())
    .rows.find(row => row.id === 'phone.voice');
  expect(await phoneRow()).toMatchObject({ state: fail ? 'warn' : 'ok', ...(fail ? { sentence: 'Phone voice not updated; re-save the voice.' } : {}) });
  await f.restart();
  expect(await phoneRow()).toMatchObject({ state: fail ? 'warn' : 'ok' });
  expect(setPhoneVoice).toHaveBeenCalledTimes(1);
  expect((await f.request('PUT', '/api/safety-commands', { enabled: true })).json()).toMatchObject({ enabled: true });
  expect(await phoneRow()).toMatchObject({ state: fail ? 'warn' : 'ok' });
  setPhoneVoice.mockRejectedValueOnce(new Error('invented phone outage'));
  expect((await save()).json()).toMatchObject({ status: 'applied', calls: 'failed' });
  expect(await phoneRow()).toMatchObject({ state: 'warn' });
  setPhoneVoice.mockResolvedValue(undefined);
  expect((await f.request('PUT', '/api/voice', { voice })).json()).toMatchObject({ calls: 'updated' });
  expect(await phoneRow()).toMatchObject({ state: 'ok' });
  await f.restart();
  expect(await phoneRow()).toMatchObject({ state: 'ok' });
  for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
});

it.each(['creation', 'append', 'completion'].flatMap(failure => ['ordinary', 'automatic', 'manual'].flatMap(resolution =>
  ['apply', 'undo'].map(action => ({ failure, resolution, action })))))
('retains phone work after journal $failure failure during $resolution $action', async ({ failure, resolution, action }) => {
  const setPhoneVoice = vi.fn(async () => {});
  const f = await fixture({ ...initial, voice: { voice: 'af_bella', appReadAloud: { provider: 'local' } } }, true, false, undefined,
    { phone: { setPhoneVoice } as unknown as NonNullable<AppDeps['phone']> });
  const save = () => f.request('POST', '/api/settings/apply', { operation: 'wayroost.voice', params: { voice: { voice: 'af_heart' } } });
  const previous = action === 'undo' ? (await save()).json().change.id : undefined;
  const consumerPath = join(f.config.stateDir, 'settings-consumers.jsonl');
  if (action === 'undo') await f.restart(() => rmSync(consumerPath));
  setPhoneVoice.mockClear();
  let status!: Extract<ConfigRequestStatusResult, { state: 'terminal' }>;
  const receipt = async <T extends ConfigApplyRequest | ConfigUndoRequest>(request: T, write: (request: T) => Promise<ConfigWriteResult>) => {
    const result = await write(request);
    if (!result.ok || !('undo' in result)) throw new Error('missing receipt');
    status = { ok: true, requestId: request.requestId, state: 'terminal', outcome: 'applied', row: {
      id: request.requestId, time: '2026-01-01T00:00:00.000Z', caller: 'server', verb: action === 'apply' ? 'config.apply' : 'config.undo',
      operation: result.operation, target: result.target, keys: result.keys, change: request.origin!.change, result: 'ok',
      backupId: result.backupId, backupSha256: result.backupSha256, writtenSha256: result.writtenSha256,
    } };
    if (resolution !== 'ordinary') throw new Error('invented lost reply');
    return result;
  };
  if (action === 'apply') {
    const write = f.supervisor.configApply.getMockImplementation()!;
    f.supervisor.configApply.mockImplementationOnce(request => receipt(request, write));
  } else {
    const write = f.supervisor.configUndo.getMockImplementation()!;
    f.supervisor.configUndo.mockImplementationOnce(request => receipt(request, write));
  }
  const change = () => action === 'apply' ? save() : f.request('POST', '/api/settings/undo', { change: previous });
  if (resolution !== 'ordinary') expect((await change()).json()).toMatchObject({ code: 'outcome_unknown' });
  if (resolution === 'automatic') f.supervisor.configRequestStatus.mockResolvedValue(status);
  const accept = (confirm?: string) => f.request('POST', '/api/settings/apply', { operation: 'settings.accept-current',
    params: { target: 'wayroost-settings', change: status.row.change }, ...(confirm ? { confirm } : {}) });
  const challenge = resolution === 'manual' ? (await accept()).json() : undefined;
  if (challenge) expect(challenge.status).toBe('confirm');
  const append = EventJournal.prototype.append;
  const journal = vi.spyOn(EventJournal.prototype, 'append').mockImplementation(function (this: EventJournal, input) {
    if (failure === 'append' && input.type === 'settings-phone-voice' && (input.data as { pending: boolean }).pending)
      throw new Error('invented pending work append failure');
    const event = append.call(this, input);
    if (failure === 'completion' && input.type === 'settings-change' && (input.data as { id: string }).id === status.row.change)
      throw new Error('invented interruption after durable completion');
    return event;
  });
  if (failure === 'creation') mkdirSync(consumerPath + '.lock');
  const response = await (resolution === 'ordinary' ? change() : resolution === 'automatic'
    ? f.request('GET', '/api/settings/notifications') : accept(challenge.confirm));
  expect(response.json()).toMatchObject({ code: 'audit_unavailable' });
  expect(setPhoneVoice).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(f.path, 'utf8')).voice.voice).toBe(action === 'apply' ? 'af_heart' : 'af_bella');
  const changes = readFileSync(join(f.config.stateDir, 'settings-audit.jsonl'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line)).filter(event => event.type === 'settings-change' && event.data.id === status.row.change);
  if (failure === 'completion') {
    expect(changes.at(-1).data).toMatchObject(resolution === 'manual'
      ? { result: 'outcome_unknown', observed: 'resolved-by-user' } : { result: 'ok' });
    const pending = readFileSync(consumerPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .filter(event => event.type === 'settings-phone-voice');
    expect(pending.at(-1).data).toEqual({ change: status.row.change, pending: true });
  } else if (resolution === 'ordinary') expect(changes).toEqual([]);
  else expect(changes.at(-1).data).toMatchObject({ result: 'outcome_unknown' });
  if (failure === 'creation') expect(existsSync(consumerPath)).toBe(false);
  journal.mockRestore();
  f.supervisor.configRequestStatus.mockResolvedValue(status);
  if (failure !== 'completion') setPhoneVoice.mockRejectedValueOnce(new Error('invented phone outage'));
  await f.restart(() => { if (failure === 'creation') rmSync(consumerPath + '.lock', { recursive: true }); });
  const phoneRow = async () => settingsChecksResponseSchema.parse((await f.request('GET', '/api/settings/checks')).json())
    .rows.find(row => row.id === 'phone.voice');
  expect(await phoneRow()).toMatchObject({ state: 'warn', sentence: 'Phone voice not updated; re-save the voice.' });
  expect(setPhoneVoice).toHaveBeenCalledTimes(failure !== 'completion' ? 1 : 0);
  await f.restart();
  expect(await phoneRow()).toMatchObject({ state: 'warn' });
  expect(setPhoneVoice).toHaveBeenCalledTimes(failure !== 'completion' ? 1 : 0);
  setPhoneVoice.mockResolvedValue(undefined);
  expect((await save()).json()).toMatchObject({ status: 'applied', calls: 'updated' });
  expect(await phoneRow()).toMatchObject({ state: 'ok' });
});

it.each(['apply', 'undo'] as const)('releases the pending settings gate after a phone marker append failure during %s', async action => {
  const setPhoneVoice = vi.fn(async () => {});
  const f = await fixture({ ...initial, safetyCommandsEnabled: true,
    voice: { voice: 'af_bella', appReadAloud: { provider: 'local' } } }, true, false, undefined,
    { phone: { setPhoneVoice } as unknown as NonNullable<AppDeps['phone']> });
  const save = () => f.request('POST', '/api/settings/apply', { operation: 'wayroost.voice', params: { voice: { voice: 'af_heart' } } });
  const previous = action === 'undo' ? (await save()).json().change.id : undefined;
  expect(f.safety.enabled()).toBe(true);
  setPhoneVoice.mockClear();
  const append = EventJournal.prototype.append;
  vi.spyOn(EventJournal.prototype, 'append').mockImplementation(function (this: EventJournal, input) {
    if (input.type === 'settings-phone-voice' && (input.data as { pending: boolean }).pending)
      throw new Error('invented pending work append failure');
    return append.call(this, input);
  });
  expect((await (action === 'apply' ? save() : f.request('POST', '/api/settings/undo', { change: previous }))).json())
    .toMatchObject({ status: 'refused', code: 'audit_unavailable' });
  expect(JSON.parse(readFileSync(f.path, 'utf8')).voice.voice).toBe(action === 'apply' ? 'af_heart' : 'af_bella');
  expect(setPhoneVoice).not.toHaveBeenCalled();
  const safetySnapshot = vi.spyOn(WayroostSettingsStore.prototype, 'safetyCommandsEnabled');
  expect(f.safety.enabled()).toBe(false);
  expect(safetySnapshot).toHaveBeenCalledOnce();
  expect(settingsChecksResponseSchema.parse((await f.request('GET', '/api/settings/checks')).json())
    .rows.find(row => row.id === 'phone.voice')).toMatchObject({ state: 'unknown' });
});

it.each(['apply', 'undo'] as const)('clears interrupted phone %s work when the restart retry succeeds', async action => {
  const setPhoneVoice = vi.fn(async () => {});
  const f = await fixture({ ...initial, voice: { voice: 'af_bella', appReadAloud: { provider: 'local' } } }, true, false, undefined,
    { phone: { setPhoneVoice } as unknown as NonNullable<AppDeps['phone']> });
  const save = () => f.request('POST', '/api/settings/apply', { operation: 'wayroost.voice', params: { voice: { voice: 'af_heart' } } });
  const previous = action === 'undo' ? (await save()).json().change.id : undefined;
  setPhoneVoice.mockClear();
  const receipt = async <T extends ConfigApplyRequest | ConfigUndoRequest>(request: T, write: (request: T) => Promise<ConfigWriteResult>) => {
    const result = await write(request);
    if (!result.ok || !('undo' in result)) throw new Error('missing receipt');
    f.supervisor.configRequestStatus.mockResolvedValue({ ok: true, requestId: request.requestId, state: 'terminal', outcome: 'applied', row: {
      id: request.requestId, time: '2026-01-01T00:00:00.000Z', caller: 'server', verb: action === 'apply' ? 'config.apply' : 'config.undo',
      operation: result.operation, target: result.target, keys: result.keys, change: request.origin!.change, result: 'ok',
      backupId: result.backupId, backupSha256: result.backupSha256, writtenSha256: result.writtenSha256,
    } });
    return result;
  };
  if (action === 'apply') {
    const write = f.supervisor.configApply.getMockImplementation()!;
    f.supervisor.configApply.mockImplementationOnce(request => receipt(request, write));
  } else {
    const write = f.supervisor.configUndo.getMockImplementation()!;
    f.supervisor.configUndo.mockImplementationOnce(request => receipt(request, write));
  }
  const append = EventJournal.prototype.append;
  const journal = vi.spyOn(EventJournal.prototype, 'append').mockImplementation(function (this: EventJournal, input) {
    if (input.type === 'settings-phone-voice' && (input.data as { pending: boolean }).pending)
      throw new Error('invented pending work append failure');
    return append.call(this, input);
  });
  expect((await (action === 'apply' ? save() : f.request('POST', '/api/settings/undo', { change: previous }))).json())
    .toMatchObject({ code: 'audit_unavailable' });
  expect(setPhoneVoice).not.toHaveBeenCalled();
  journal.mockRestore();
  setPhoneVoice.mockResolvedValue(undefined);
  await f.restart();
  expect(setPhoneVoice).toHaveBeenCalledExactlyOnceWith(action === 'apply' ? 'af_heart' : 'af_bella');
  const phoneRow = async () => settingsChecksResponseSchema.parse((await f.request('GET', '/api/settings/checks')).json())
    .rows.find(row => row.id === 'phone.voice');
  expect(await phoneRow()).toMatchObject({ state: 'ok' });
  await f.restart();
  expect(await phoneRow()).toMatchObject({ state: 'ok' });
  expect(setPhoneVoice).toHaveBeenCalledTimes(1);
});

it('retains the phone voice warning when the phone is absent after restart', async () => {
  const setPhoneVoice = vi.fn(async (): Promise<void> => { throw new Error('invented phone outage'); });
  const extra: Pick<AppDeps, 'phone'> = { phone: { setPhoneVoice } as unknown as NonNullable<AppDeps['phone']> };
  const phone = extra.phone;
  const f = await fixture(initial, true, false, undefined, extra);
  const phoneRow = async () => settingsChecksResponseSchema.parse((await f.request('GET', '/api/settings/checks')).json())
    .rows.find(row => row.id === 'phone.voice');
  expect((await f.request('PUT', '/api/voice', { voice: 'af_heart' })).json()).toMatchObject({ calls: 'failed' });
  expect(await phoneRow()).toMatchObject({ state: 'warn', sentence: 'Phone voice not updated; re-save the voice.' });
  delete extra.phone;
  await f.restart();
  expect(await phoneRow()).toMatchObject({ state: 'warn', sentence: 'Pair the phone again and re-save the voice.' });
  expect((await f.request('PUT', '/api/voice', { voice: 'af_heart' })).json()).toMatchObject({ calls: 'off' });
  expect(await phoneRow()).toMatchObject({ state: 'warn', sentence: 'Pair the phone again and re-save the voice.' });
  extra.phone = phone;
  setPhoneVoice.mockImplementation(async () => {});
  await f.restart();
  expect((await f.request('PUT', '/api/voice', { voice: 'af_heart' })).json()).toMatchObject({ calls: 'updated' });
  expect(await phoneRow()).toMatchObject({ state: 'ok' });
});

it.each(['shadow', 'rollout', 'snapshot', 'hash'] as const)('holds recovered consumer writes when the %s check refuses', async refusal => {
  const { schedules } = pulseSchedules();
  const f = await fixture(initial, true, false, schedules);
  const apply = f.supervisor.configApply.getMockImplementation()!;
  let status!: Extract<ConfigRequestStatusResult, { state: 'terminal' }>;
  f.supervisor.configApply.mockImplementationOnce(async request => {
    const result = await apply(request);
    if (!result.ok || !('undo' in result)) throw new Error('missing receipt');
    status = { ok: true, requestId: request.requestId, state: 'terminal', outcome: 'applied', row: {
      id: request.requestId, time: '2026-01-01T00:00:00.000Z', caller: 'server', verb: 'config.apply',
      operation: result.operation, target: result.target, keys: result.keys, change: request.origin!.change, result: 'ok',
      backupId: result.backupId, backupSha256: result.backupSha256, writtenSha256: result.writtenSha256,
    } };
    throw new Error('invented lost reply');
  });
  expect((await f.request('POST', '/api/settings/apply', { operation: 'wayroost.preferences', params: { feed: { level: 'high' } } })).json())
    .toMatchObject({ code: 'outcome_unknown' });
  f.supervisor.configRequestStatus.mockResolvedValue(status);
  if (refusal === 'shadow' || refusal === 'rollout') {
    if (refusal === 'shadow') f.config.role = 'shadow';
    else f.config.rollout.settingsPages = false;
    await f.restart();
    expect((await f.request('GET', '/api/settings/notifications')).json()).toMatchObject({ code: 'outcome_unknown' });
  } else {
    if (refusal === 'snapshot') f.supervisor.configRead.mockRejectedValue(new Error('invented owner outage'));
    else writeFileSync(f.path, JSON.stringify({ ...initial, feed: { level: 'normal', lessLike: [] } }), { mode: 0o600 });
    expect((await f.request('GET', '/api/settings/notifications')).json()).toMatchObject({ code: refusal === 'snapshot' ? 'unavailable' : 'verify_mismatch' });
  }
  expect(f.feed.preferences().level).toBe('off');
  expect(schedules.setPaused).not.toHaveBeenCalled();
  expect(schedules.update).not.toHaveBeenCalled();
  for (const spy of f.writes) expect(spy).not.toHaveBeenCalled();
});

it('hides and refuses undo tokens issued by the private backend after pipeline cutover', async () => {
  const f = await fixture(initial, false);
  const changed = (await f.request('PUT', '/api/settings/notifications', { push: { approvals: false, cards: true }, quietHours: null, rules: [] })).json();
  expect(changed.status).toBe('applied');
  f.config.settings.legacyRoutesViaPipeline = true;
  await f.restart();
  expect((await f.request('GET', '/api/settings/changes')).json().changes.find((change: { id: string }) => change.id === changed.change.id).undoable).toBe(false);
  expect((await f.request('POST', '/api/settings/undo', { change: changed.change.id })).json()).toMatchObject({ code: 'undo_changed' });
  expect(f.supervisor.configUndo).not.toHaveBeenCalled();
});

it.each([false, true])('treats untagged notification undo as private-backend history (pipeline: %s)', async pipeline => {
  const f = await fixture(initial, false);
  const before = f.notifications.settings().push;
  const changed = (await f.request('PUT', '/api/settings/notifications', { push: { approvals: false, cards: false }, quietHours: null, rules: [] })).json();
  expect(changed.status).toBe('applied');
  f.config.settings.legacyRoutesViaPipeline = pipeline;
  await f.restart(() => {
    const path = join(f.config.stateDir, 'settings-audit.jsonl');
    const events = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    rmSync(path);
    const journal = new EventJournal(f.config.stateDir, Date.now, 'settings-audit.jsonl');
    try {
      for (const event of events) {
        delete event.data.backend;
        journal.append({ type: event.type, data: event.data });
      }
    } finally { journal.close(); }
  });
  const recent = (await f.request('GET', '/api/settings/changes')).json().changes.find((change: { id: string }) => change.id === changed.change.id);
  expect(recent.undoable).toBe(!pipeline);
  const response = await f.request('POST', '/api/settings/undo', { change: changed.change.id });
  expect(response.json()).toMatchObject(pipeline ? { status: 'refused', code: 'undo_changed' } : { status: 'applied' });
  if (!pipeline) expect(f.notifications.settings().push).toEqual(before);
  expect(f.supervisor.configUndo).not.toHaveBeenCalled();
});
