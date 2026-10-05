import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as promises from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.js';
import { buildApp, changeRoutes } from '../src/app.js';
import { EventHub } from '../src/hub.js';
import { Devices } from '../src/devices.js';
import { SafetyCommandsSetting } from '../src/hermes/safety.js';
import { blockedReason, parseSlash } from '../src/hermes/commands.js';
import { BackgroundGate } from '../src/background.js';
import { Notifications } from '../src/notifications/service.js';
import { WAYROOST_SETTINGS_FILE, NotificationSettingsStore } from '../src/notifications/settings.js';
import { currentConfigVerbs } from '../../shared/supervisor-config.js';
import { pendingWorkerApprovals } from '../../shared/safety.js';
import type { SupervisorApi } from '../src/supervisor-client.js';
import { FakeSettingsSupervisor } from './fake-settings-supervisor.js';
import { FakeHermes, FakePaseo, PHONE_COOKIE, apiHeaders, makeConfig, postHeaders, seedDevices } from './helpers.js';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const roots: string[] = [];
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

type Mode = 'none' | 'missing' | 'off' | 'unavailable' | 'on';
const modes: Mode[] = ['none', 'missing', 'off', 'unavailable', 'on'];
async function fixture(mode: Mode, options: { pipeline?: boolean; local?: boolean; legacySafety?: boolean;
  notificationsWired?: boolean; sharedSafety?: boolean; initialSettings?: Record<string, unknown> } = {}) {
  const config = makeConfig(undefined, { settings: { legacyRoutesViaPipeline: options.pipeline ?? false },
    localListener: { port: 19014, pcOnlyWrites: true }, origins: ['https://127.0.0.1:19014'] });
  roots.push(config.stateDir);
  if (options.notificationsWired) {
    mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
    config.stateDir = mkdtempSync(join(process.cwd(), '.tmp', 'legacy-writers-'));
    roots.push(config.stateDir);
    seedDevices(config.stateDir);
    const initialSettings = options.initialSettings ?? (options.sharedSafety !== undefined ? { safetyCommandsEnabled: options.sharedSafety } : undefined);
    if (initialSettings) writeFileSync(join(config.stateDir, WAYROOST_SETTINGS_FILE), JSON.stringify(initialSettings), { mode: 0o600 });
  }
  if (options.legacySafety !== undefined) new SafetyCommandsSetting(config.stateDir).setEnabled(options.legacySafety);
  const supervisor = new FakeSettingsSupervisor();
  if (options.sharedSafety !== undefined) supervisor.documents['wayroost-settings']!.safetyCommandsEnabled = options.sharedSafety;
  let currentMode = mode;
  const status = vi.fn<SupervisorApi['status']>(async () => currentMode === 'unavailable' ? null : {
    overall: 'ok', sentence: 'Ready', components: [], at: 0,
    ...(currentMode === 'missing' ? {} : { configVerbs: currentConfigVerbs(currentMode === 'on') }),
  });
  Object.assign(supervisor, { status });
  const paseo = new FakePaseo();
  const cloudWrite = vi.spyOn(paseo, 'setCloudAgentEnabled');
  let workerEnabled = true;
  const workerApprovals = {
    status: vi.fn(async () => ({ ...pendingWorkerApprovals(), enabled: workerEnabled })),
    setEnabled: vi.fn(async (enabled: boolean) => {
      workerEnabled = enabled;
      return { ...pendingWorkerApprovals(), enabled, choiceConfirmed: true, config: 'written' as const };
    }),
  };
  const devices = new Devices(config.stateDir);
  const start = async () => {
    const hub = new EventHub();
    const safetyCommands = new SafetyCommandsSetting(config.stateDir);
    const safetyWrite = vi.spyOn(safetyCommands, 'setEnabled');
    const safetySource = vi.spyOn(safetyCommands, 'useSettingsSource');
    const notifications = options.notificationsWired ? new Notifications({ settings: new NotificationSettingsStore(config.stateDir), hub,
      background: new BackgroundGate('primary'), log: { info() {}, warn() {} } }) : undefined;
    const notificationWrite = notifications ? vi.spyOn(notifications, 'configApply') : undefined;
    const notificationUndo = notifications ? vi.spyOn(notifications, 'configUndo') : undefined;
    const app = await buildApp({ config, hub, devices, sources: { hermes: new FakeHermes(), paseo },
      ...(mode === 'none' ? {} : { supervisor }), safetyCommands, workerApprovals, logger: false,
      ...(notifications ? { notifications } : {}),
      verifier: async () => ({ email: 'you@example.com', exp: 2_000_000_000 }) });
    app.addHook('onRequest', async request => {
      Object.defineProperty(request.raw.socket, 'localPort', { configurable: true, value: options.local ? 19014 : 19010 });
    });
    apps.push(app);
    const put = (url: string, payload: unknown, phone = false) => app.inject({ method: 'PUT', url, payload: JSON.stringify(payload),
      headers: postHeaders('obviously-fake-jwt', phone ? { cookie: PHONE_COOKIE } : {}) });
    const get = (url: string) => app.inject({ url, headers: apiHeaders('obviously-fake-jwt') });
    const rows = () => readFileSync(join(config.stateDir, 'settings-audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: JSON.stringify(payload),
      headers: postHeaders('obviously-fake-jwt') });
    return { app, safetyCommands, safetyWrite, safetySource, notifications, notificationWrite, notificationUndo, put, get, post, rows };
  };
  return { ...await start(), config, devices, supervisor, cloudWrite, workerApprovals, reopen: start,
    setMode: (next: Mode) => { currentMode = next; } };
}

const writes = [
  { url: '/api/cloud-agents/codex', route: '/api/cloud-agents/:id', operation: 'paseo.provider-enabled', enabled: false },
  { url: '/api/safety-commands', route: '/api/safety-commands', operation: 'wayroost.safety-commands', enabled: true },
  { url: '/api/worker-approvals', route: '/api/worker-approvals', operation: 'paseo.worker-approvals', enabled: false },
] as const;
const params = (operation: string, enabled: boolean) => operation === 'paseo.provider-enabled' ? { provider: 'codex', enabled } : { enabled };

it('defaults the startup writer setting to false', () => {
  const input = { publicOrigin: 'https://example.com' };
  expect(parseConfig(input, { env: {} }).settings).toEqual({ legacyRoutesViaPipeline: false });
  expect(parseConfig({ ...input, settings: {} }, { env: {} }).settings).toEqual({ legacyRoutesViaPipeline: false });
  expect(parseConfig({ ...input, settings: { legacyRoutesViaPipeline: true } }, { env: {} }).settings)
    .toEqual({ legacyRoutesViaPipeline: true });
});

it.each(['true', 1, null])('rejects a non-boolean startup writer setting (%j)', value => {
  expect(() => parseConfig({ publicOrigin: 'https://example.com', settings: { legacyRoutesViaPipeline: value } }, { env: {} }))
    .toThrow(ConfigError);
});

it.each(modes.flatMap(mode => writes.map(write => ({ mode, ...write }))))(
  'uses the existing writer for $url with the startup switch off and config verbs $mode', async ({ mode, url, route, operation, enabled }) => {
  const f = await fixture(mode, { local: operation === 'wayroost.safety-commands' });
  const statusCalls = f.supervisor.status.mock.calls.length;
  const response = await f.put(url, { enabled });
  expect(response.statusCode).toBe(200);
  if (operation === 'paseo.provider-enabled') {
    expect(f.cloudWrite).toHaveBeenCalledExactlyOnceWith('codex', enabled);
    expect(response.json().agents.find((agent: { id: string }) => agent.id === 'codex')).toMatchObject({ enabled, state: 'off' });
    expect((await f.get('/api/cloud-agents')).json()).toEqual(response.json());
  } else if (operation === 'wayroost.safety-commands') {
    expect(f.safetyWrite).toHaveBeenCalledExactlyOnceWith(enabled);
    expect(response.json()).toMatchObject({ enabled, commands: expect.arrayContaining(['/yolo']) });
    expect((await f.get(url)).json()).toEqual(response.json());
    expect(new SafetyCommandsSetting(f.config.stateDir).enabled()).toBe(enabled);
  } else {
    expect(f.workerApprovals.setEnabled).toHaveBeenCalledExactlyOnceWith(enabled);
    expect(response.json()).toMatchObject({ enabled, choiceConfirmed: true, config: 'written' });
    expect((await f.get(url)).json().enabled).toBe(enabled);
  }
  expect(f.supervisor.configApply).not.toHaveBeenCalled();
  expect(f.supervisor.configRead).not.toHaveBeenCalled();
  expect(f.supervisor.status).toHaveBeenCalledTimes(statusCalls);
  expect(f.safetySource).not.toHaveBeenCalled();
  expect(changeRoutes(f.app).filter(candidate => candidate === `PUT ${route}`)).toHaveLength(1);
});

it.each(writes)('uses only the settings pipeline for $url with the startup switch on', async ({ url, route, operation, enabled }) => {
  const f = await fixture('on', { pipeline: true, local: true });
  expect(f.supervisor.configApply).not.toHaveBeenCalled();
  const response = await f.put(url, { enabled });
  expect(response.statusCode).toBe(200);
  expect(response.json().status).toBeUndefined();
  expect(f.supervisor.configApply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation, params: params(operation, enabled) }));
  expect(f.cloudWrite).not.toHaveBeenCalled();
  expect(f.safetyWrite).not.toHaveBeenCalled();
  expect(f.workerApprovals.setEnabled).not.toHaveBeenCalled();
  expect(f.rows().filter(row => row.type === 'settings-change').at(-1).data).toMatchObject({ operation, result: 'ok' });
  expect(changeRoutes(f.app).filter(candidate => candidate === `PUT ${route}`)).toHaveLength(1);
});

it.each(writes.flatMap(write => [false, true].map(pipeline => ({ ...write, pipeline }))))(
  'retains the startup writer for $url across capability changes and config mutation (pipeline=$pipeline)', async ({ url, route, operation, pipeline }) => {
  const f = await fixture('off', { pipeline, local: true });
  f.config.settings.legacyRoutesViaPipeline = !pipeline;
  for (const [index, mode] of (['on', 'off', 'missing', 'unavailable', 'on'] as const).entries()) {
    f.setMode(mode);
    const enabled = index % 2 === 0;
    expect((await f.put(url, { enabled })).statusCode).toBe(200);
  }
  expect(f.supervisor.configApply).toHaveBeenCalledTimes(pipeline ? 5 : 0);
  expect(f.cloudWrite).toHaveBeenCalledTimes(!pipeline && operation === 'paseo.provider-enabled' ? 5 : 0);
  expect(f.safetyWrite).toHaveBeenCalledTimes(!pipeline && operation === 'wayroost.safety-commands' ? 5 : 0);
  expect(f.workerApprovals.setEnabled).toHaveBeenCalledTimes(!pipeline && operation === 'paseo.worker-approvals' ? 5 : 0);
  expect(changeRoutes(f.app).filter(candidate => candidate === `PUT ${route}`)).toHaveLength(1);
});

it.each(writes.flatMap(write => [false, true].map(pipeline => ({ ...write, pipeline }))))(
  'retains authorization and strict parameters for $url (pipeline=$pipeline)', async ({ url, operation, enabled, pipeline }) => {
  const f = await fixture('on', { pipeline, local: true });
  const phone = await f.put(url, { enabled }, true);
  if (pipeline && operation === 'paseo.provider-enabled') expect(phone.json().status).toBe('confirm');
  else expect(phone.statusCode).toBe(403);
  expect((await f.put(url, { enabled, extra: true })).statusCode).toBe(400);
  expect((await f.put(url, { enabled: 'false' })).statusCode).toBe(400);
  expect(f.cloudWrite).not.toHaveBeenCalled();
  expect(f.safetyWrite).not.toHaveBeenCalled();
  expect(f.workerApprovals.setEnabled).not.toHaveBeenCalled();
  expect(f.supervisor.configApply).not.toHaveBeenCalled();
});

it.each(writes.flatMap(write => [false, true].map(pipeline => ({ ...write, pipeline }))))(
  'retains the revoked-device refusal for $url (pipeline=$pipeline)', async ({ url, enabled, pipeline }) => {
  const f = await fixture('on', { pipeline, local: true });
  f.app.addHook('preHandler', async () => {
    await Promise.resolve();
    vi.spyOn(f.devices, 'get').mockReturnValue(undefined);
  });
  const response = await f.put(url, { enabled });
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused', code: 'not_permitted' });
  expect(f.cloudWrite).not.toHaveBeenCalled();
  expect(f.safetyWrite).not.toHaveBeenCalled();
  expect(f.workerApprovals.setEnabled).not.toHaveBeenCalled();
  expect(f.supervisor.configApply).not.toHaveBeenCalled();
});

it.each(writes.flatMap(write => (['refused', 'lost'] as const).map(outcome => ({ ...write, outcome }))))(
  'never falls back after a $outcome pipeline write for $url', async ({ url, operation, enabled, outcome }) => {
  const f = await fixture('on', { pipeline: true, local: true });
  f.supervisor.configApply.mockImplementationOnce(async () => {
    f.setMode('off');
    if (outcome === 'lost') throw new Error('demo-lost-reply');
    return { ok: false, code: 'config_writes_off' };
  });
  const code = outcome === 'lost' ? 'outcome_unknown' : 'config_writes_off';
  expect((await f.put(url, { enabled })).json()).toMatchObject({ status: 'refused', code });
  expect(f.supervisor.configApply).toHaveBeenCalledOnce();
  expect(f.cloudWrite).not.toHaveBeenCalled();
  expect(f.safetyWrite).not.toHaveBeenCalled();
  expect(f.workerApprovals.setEnabled).not.toHaveBeenCalled();
  expect(f.rows().filter(row => row.type === 'settings-change').at(-1).data).toMatchObject({ operation, result: code });
});

it.each(writes)('does not use the existing writer for $url when the pipeline has no supervisor', async ({ url, enabled }) => {
  const f = await fixture('none', { pipeline: true, local: true, legacySafety: true });
  expect((await f.put(url, { enabled })).json()).toEqual({ status: 'refused', code: 'config_writes_off' });
  expect(f.cloudWrite).not.toHaveBeenCalled();
  expect(f.safetyWrite).not.toHaveBeenCalled();
  expect(f.workerApprovals.setEnabled).not.toHaveBeenCalled();
  expect(f.safetyCommands.enabled()).toBe(false);
});

it('enforces PC-only Safety commands at the main listener in pipeline mode', async () => {
  const f = await fixture('on', { pipeline: true });
  expect((await f.put('/api/safety-commands', { enabled: true })).json()).toEqual({ status: 'refused', code: 'pc_only' });
  expect(f.safetyWrite).not.toHaveBeenCalled();
  expect(f.supervisor.configApply).not.toHaveBeenCalled();
  expect(f.safetyCommands.enabled()).toBe(false);
  expect(f.rows().filter(row => row.type === 'settings-change').at(-1).data).toMatchObject({ operation: 'wayroost.safety-commands', result: 'pc_only' });
});

it.each(writes.flatMap(write => [false, true].map(enabled => ({ ...write, enabled }))))(
  'refuses shared $operation writes while the startup switch is off (enabled=$enabled)', async ({ operation, enabled }) => {
  const f = await fixture('on', { local: true, legacySafety: !enabled, notificationsWired: true });
  const response = await f.post('/api/settings/apply', { operation, params: params(operation, enabled) });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ status: 'refused', code: 'config_writes_off' });
  if (operation === 'wayroost.safety-commands') {
    expect((await f.put('/api/settings/safety-commands', { enabled })).json()).toEqual({ status: 'refused', code: 'config_writes_off' });
  }
  expect(f.safetyCommands.enabled()).toBe(!enabled);
  expect(new SafetyCommandsSetting(f.config.stateDir).enabled()).toBe(!enabled);
  expect(f.notificationWrite).not.toHaveBeenCalled();
  expect(f.supervisor.configApply).not.toHaveBeenCalled();
  expect(f.cloudWrite).not.toHaveBeenCalled();
  expect(f.workerApprovals.setEnabled).not.toHaveBeenCalled();
});

it.each(writes)('refuses saved $operation undo after restarting with the startup switch off', async ({ operation, enabled }) => {
  const f = await fixture('on', { pipeline: true, local: true });
  const changed = (await f.post('/api/settings/apply', { operation, params: params(operation, enabled) })).json();
  expect(changed).toMatchObject({ status: 'applied', change: { undoable: true } });
  await f.app.close();
  f.config.settings.legacyRoutesViaPipeline = false;
  const reloaded = await f.reopen();
  const response = await reloaded.post('/api/settings/undo', { change: changed.change.id });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ status: 'refused', code: 'config_writes_off' });
  expect(f.supervisor.configUndo).not.toHaveBeenCalled();
  expect(f.supervisor.configApply).toHaveBeenCalledOnce();
});

it.each([false, true].flatMap(pipeline => [false, true].flatMap(enabled => [false, true].flatMap(wired =>
  (['off', 'on'] as const).map(restartMode => ({ pipeline, enabled, wired, restartMode }))))))(
  'preserves the chosen safety writer across restart (pipeline=$pipeline, enabled=$enabled, notifications=$wired, config verbs=$restartMode)', async ({ pipeline, enabled, wired, restartMode }) => {
  const f = await fixture(pipeline ? 'on' : 'off', { pipeline, local: true, legacySafety: !enabled, sharedSafety: !enabled, notificationsWired: wired });
  expect((await f.put('/api/safety-commands', { enabled })).json().enabled).toBe(enabled);
  f.setMode('off');
  expect((await f.get('/api/safety-commands')).json().enabled).toBe(enabled);
  await f.app.close();
  f.setMode(restartMode);
  const reloaded = await f.reopen();
  expect(reloaded.safetyCommands.enabled()).toBe(enabled);
  expect((await reloaded.get('/api/safety-commands')).json().enabled).toBe(enabled);
  expect(blockedReason(parseSlash('/yolo')!, reloaded.safetyCommands.enabled()) === null).toBe(enabled);
  expect(reloaded.safetyWrite).not.toHaveBeenCalled();
  if (pipeline) {
    expect(new SafetyCommandsSetting(f.config.stateDir).enabled()).toBe(!enabled);
    expect(reloaded.safetySource).toHaveBeenCalledOnce();
    if (wired) expect(reloaded.notificationWrite).not.toHaveBeenCalled();
    else expect(f.supervisor.configApply).toHaveBeenCalledOnce();
  } else {
    expect(new SafetyCommandsSetting(f.config.stateDir).enabled()).toBe(enabled);
    expect(reloaded.safetySource).not.toHaveBeenCalled();
    expect(f.supervisor.configApply).not.toHaveBeenCalled();
    if (wired) expect(JSON.parse(readFileSync(join(f.config.stateDir, WAYROOST_SETTINGS_FILE), 'utf8')).safetyCommandsEnabled).toBe(!enabled);
    else expect(f.supervisor.documents['wayroost-settings']!.safetyCommandsEnabled).toBe(!enabled);
  }
});

it.each([false, true])('never copies the legacy safety choice during pipeline startup (notifications=%s)', async wired => {
  const f = await fixture('on', { pipeline: true, local: true, legacySafety: true, notificationsWired: wired });
  if (!wired) {
    delete f.supervisor.documents['wayroost-settings']!.safetyCommandsEnabled;
    await f.app.close();
  }
  const current = wired ? f : await f.reopen();
  expect(current.safetyCommands.enabled()).toBe(false);
  expect((await current.get('/api/safety-commands')).json().enabled).toBe(false);
  expect(f.supervisor.configApply).not.toHaveBeenCalled();
  if (wired) expect(f.notificationWrite).not.toHaveBeenCalled();
  expect(new SafetyCommandsSetting(f.config.stateDir).enabled()).toBe(true);
});

it.each([false, true])('keeps the existing safety choice during notification apply and undo (enabled=%s)', async enabled => {
  const f = await fixture('on', { local: true, legacySafety: enabled, sharedSafety: !enabled, notificationsWired: true });
  const bytes = readFileSync(join(f.config.stateDir, 'hermes-safety-commands.json'), 'utf8');
  const changed = (await f.put('/api/settings/notifications', {
    push: { approvals: false, cards: true }, quietHours: null, rules: [],
  })).json();
  expect(changed).toMatchObject({ status: 'applied', change: { effective: 'verified' } });
  expect((await f.get('/api/safety-commands')).json().enabled).toBe(enabled);
  expect((await f.post('/api/settings/undo', { change: changed.change.id })).json().status).toBe('applied');
  expect((await f.get('/api/safety-commands')).json().enabled).toBe(enabled);
  expect(readFileSync(join(f.config.stateDir, 'hermes-safety-commands.json'), 'utf8')).toBe(bytes);
  expect(JSON.parse(readFileSync(join(f.config.stateDir, WAYROOST_SETTINGS_FILE), 'utf8')).safetyCommandsEnabled).toBe(!enabled);
  expect(f.safetyWrite).not.toHaveBeenCalled();
  expect(f.safetySource).not.toHaveBeenCalled();
});

it.each([false, true])('recovers from a notification conflict on a fresh safety request (notifications=%s)', async wired => {
  const f = await fixture('on', { pipeline: true, local: true, sharedSafety: false, notificationsWired: wired });
  const writer = wired ? f.notificationWrite! : f.supervisor.configApply;
  const apply = wired ? Notifications.prototype.configApply.bind(f.notifications!) : f.supervisor.configApply.getMockImplementation()!;
  writer.mockImplementationOnce(async request => {
    if (wired) {
      const notification = await apply({ ...request, operation: 'wayroost.notifications',
        params: { push: { approvals: false, cards: true }, quietHours: null, rules: [] } });
      expect(notification.ok).toBe(true);
    } else f.supervisor.documents['wayroost-settings']!.push = { approvals: false, cards: true };
    return apply(request);
  });
  const conflict = await f.put('/api/safety-commands', { enabled: true });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json()).toEqual({ status: 'refused', code: 'precondition_changed' });
  expect(f.safetyCommands.enabled()).toBe(false);
  expect((await f.put('/api/safety-commands', { enabled: true })).json().enabled).toBe(true);
  expect(f.safetyCommands.enabled()).toBe(true);
  expect((await f.get('/api/safety-commands')).json().enabled).toBe(true);
  expect(writer).toHaveBeenCalledTimes(2);
  const document = wired ? JSON.parse(readFileSync(join(f.config.stateDir, WAYROOST_SETTINGS_FILE), 'utf8')) : f.supervisor.documents['wayroost-settings'];
  expect(document).toMatchObject({ safetyCommandsEnabled: true, push: { approvals: false, cards: true } });
  expect(f.rows().filter(row => row.type === 'settings-change').map(row => row.data.result)).toEqual(['precondition_changed', 'ok']);
  expect(f.safetyWrite).not.toHaveBeenCalled();
});

it.each([false, true])('keeps a damaged audit isolated from the selected safety writer (pipeline=%s)', async pipeline => {
  const f = await fixture('on', { pipeline, local: true, legacySafety: true, sharedSafety: true, notificationsWired: true });
  await f.app.close();
  writeFileSync(join(f.config.stateDir, 'settings-audit.jsonl'), 'broken audit\n');
  const reloaded = await f.reopen();
  expect(reloaded.safetyCommands.enabled()).toBe(!pipeline);
  const response = await reloaded.put('/api/safety-commands', { enabled: true });
  if (pipeline) expect(response.json()).toEqual({ status: 'refused', code: 'audit_unavailable' });
  else expect(response.json().enabled).toBe(true);
  expect(reloaded.notificationWrite).not.toHaveBeenCalled();
  expect(f.supervisor.configApply).not.toHaveBeenCalled();
});

it('keeps startup read-only and accepts a fresh authorized safety enable after a notification conflict', async () => {
  const apply = Notifications.prototype.configApply;
  const writer = vi.spyOn(Notifications.prototype, 'configApply').mockImplementationOnce(async function (this: Notifications, request) {
    expect((await apply.call(this, { ...request, operation: 'wayroost.notifications',
      params: { push: { approvals: false, cards: true }, quietHours: null, rules: [] } })).ok).toBe(true);
    return apply.call(this, request);
  });
  const f = await fixture('on', { pipeline: true, local: true, legacySafety: true, notificationsWired: true,
    initialSettings: { push: { approvals: true, cards: false }, quietHours: null, rules: [] } });
  expect(writer).not.toHaveBeenCalled();
  expect(f.safetyCommands.enabled()).toBe(false);
  expect((await f.put('/api/safety-commands', { enabled: true })).json()).toEqual({ status: 'refused', code: 'precondition_changed' });
  expect((await f.put('/api/safety-commands', { enabled: true })).json().enabled).toBe(true);
  expect(f.safetyCommands.enabled()).toBe(true);
  expect(f.safetyWrite).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(join(f.config.stateDir, WAYROOST_SETTINGS_FILE), 'utf8')))
    .toMatchObject({ safetyCommandsEnabled: true, push: { approvals: false, cards: true } });
});
