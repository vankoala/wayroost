import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as promises from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { EventHub } from '../src/hub.js';
import { Devices } from '../src/devices.js';
import { Notifications } from '../src/notifications/service.js';
import { NotificationSettingsStore } from '../src/notifications/settings.js';
import { FakeSettingsSupervisor } from './fake-settings-supervisor.js';
import { makeConfig, seedDevices, FakeHermes, FakePaseo, postHeaders, apiHeaders, PHONE_COOKIE, DESKTOP_COOKIE } from './helpers.js';
import { drainRunResult, settingsRestartResponseSchema, settingsCredentialResponseSchema, type DrainRestartRun, type ConfigApplyRequest, type DrainRestartRequest } from '../../shared/supervisor-config.js';
import { settingsApplyResponseSchema } from '../../shared/settings.js';
import type { SettingsCheckRow } from '../../shared/settings-checks.js';
import type { SupervisorApi, SupervisorStreamHandlers } from '../src/supervisor-client.js';
import type { SettingsOptions } from '../src/settings/routes.js';
import { SafetyCommandsSetting } from '../src/hermes/safety.js';
import { SettingsAudit } from '../src/settings/audit.js';
import { operationKeys, operationSpec, readViewValues } from '../../shared/settings-ops.js';
import { WORKER_APPROVAL_TOOLS } from '../../shared/safety.js';
import { Checks } from '../src/checks/index.js';
import { ChecksState } from '../src/checks/state.js';
import { fixtures, moveRecord, writtenKey } from './checks-fixtures.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const roots: string[] = [];
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});
const actualPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
beforeEach(() => {
  vi.mocked(promises.lstat).mockImplementation(async (path, options) => {
    const stat = await actualPromises.lstat(path, options);
    if (String(path) === '/') stat.uid = typeof stat.uid === 'bigint' ? 0n : 0;
    return stat;
  });
});
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(options: { checks?: SettingsOptions['checks']; supervisor?: FakeSettingsSupervisor; expectedStatusOnly?: boolean;
  pipeline?: boolean; local?: boolean; gate?: boolean } = {}) {
  const config = makeConfig(undefined, { settings: { legacyRoutesViaPipeline: options.pipeline ?? false },
    localListener: { port: 19014, pcOnlyWrites: options.gate ?? true }, origins: ['https://127.0.0.1:19014'] });
  rmSync(config.stateDir, { recursive: true, force: true }); config.stateDir = mkdtempSync(join(process.cwd(), '.settings-production-'));
  seedDevices(config.stateDir); roots.push(config.stateDir); config.paseo.enabled = false;
  if (options.expectedStatusOnly !== undefined) config.supervisor = { socket: '/run/example/supervisor.sock', keyFile: '/home/me/fake-key', expectedStatusOnly: options.expectedStatusOnly };
  const hub = new EventHub(); const events: unknown[] = []; hub.observe(event => events.push(event));
  const supervisor = options.supervisor ?? new FakeSettingsSupervisor();
  const notifications = new Notifications({ settings: new NotificationSettingsStore(config.stateDir), hub, log: { info() {}, warn() {} } });
  const devices = new Devices(config.stateDir);
  const safetyCommands = new SafetyCommandsSetting(config.stateDir);
  const dependencies = { config, hub, devices, supervisor, notifications, safetyCommands, sources: { hermes: new FakeHermes(), paseo: new FakePaseo() },
    verifier: async () => ({ email: 'you@example.com', exp: 2_000_000_000 }), logger: false as const, settings: options.checks ? { checks: options.checks } : {} };
  const open = async () => {
    const app = await buildApp(dependencies); apps.push(app);
    app.addHook('onRequest', async req => Object.defineProperty(req.raw.socket, 'localPort', { value: options.local === false ? 19010 : 19014, configurable: true })); return app;
  };
  const app = await open();
  const write = (operation: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/api/settings/apply', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }), payload: { operation, params, ...extra } });
  const audit = () => readFileSync(join(config.stateDir, 'settings-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'settings-change').map(row => row.data);
  return { app, open, write, audit, config, hub, events, notifications, supervisor, safetyCommands, devices };
}
const run = (outcome?: DrainRestartRun['outcome']): DrainRestartRun => ({ id: randomUUID(), component: 'hermes', when: 'idle', state: !outcome ? 'waiting' : outcome === 'restarted' || outcome === 'not_running' ? 'done' : outcome === 'still_busy' ? 'still-busy' : 'failed',
  startedAt: 1, ...(outcome ? { endedAt: 2, outcome } : {}), attempts: 0, probeAttempts: 0, busy: [], protocol: 1 });
describe('production settings pipeline', () => {
  it.each([false, true].flatMap(restart => ['before', 'intended', 'digest-shaped', 'unrelated-change', 'contradictory-scalars'].map(observation => ({ restart, observation }))))
    ('keeps uncertain files blocked with $observation observations and restart=$restart', async ({ restart, observation }) => {
      const f = await fixture({ pipeline: true });
      const before = structuredClone(f.supervisor.documents['paseo-config']!);
      const apply = f.supervisor.configApply.getMockImplementation()!;
      f.supervisor.configApply.mockImplementationOnce(async request => {
        if (observation !== 'before') await apply(request);
        if (observation === 'unrelated-change') (f.supervisor.documents['paseo-config']!.agents as any).providers.codex.enabled = false;
        if (observation === 'digest-shaped') f.supervisor.documents['paseo-config']!.extra = { sha256: 'a'.repeat(64), length: 12 };
        throw new Error('lost response');
      });
      expect((await f.write('paseo.routing-note', { text: 'Example note' })).json().code).toBe('outcome_unknown');
      const start = readFileSync(join(f.config.stateDir, 'settings-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        .find(row => row.type === 'settings-write-start');
      expect(start.data).not.toHaveProperty('comparison');
      expect(start.data.requestId).toBe(f.supervisor.configApply.mock.calls[0]![0].requestId);
      if (observation === 'before') expect(f.supervisor.documents['paseo-config']).toEqual(before);
      const read = f.supervisor.configRead.getMockImplementation()!;
      if (observation === 'contradictory-scalars') Object.assign(f.supervisor, { configRead: vi.fn<NonNullable<SupervisorApi['configRead']>>(async request => {
        const result = await read(request);
        return result.ok ? { ...result, values: [...result.values, { path: ['daemon', 'appendSystemPrompt'], exists: true, value: 'Contradictory note' }] } : result;
      }) });
      const app = restart ? (await f.app.close(), await f.open()) : f.app;
      const write = await app.inject({ method: 'POST', url: '/api/settings/apply', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }),
        payload: { operation: 'paseo.routing-note', params: { text: 'Another note' } } });
      expect(write.json()).toMatchObject({ status: 'refused', code: 'outcome_unknown' });
      expect(f.supervisor.configApply).toHaveBeenCalledOnce();
      const checks = (await app.inject({ url: '/api/settings/checks', headers: apiHeaders('fake') })).json();
      expect(checks.rows).toContainEqual(expect.objectContaining({ id: 'settings.blocked-paseo-config', state: 'fail',
        fix: { operation: 'settings.accept-current', params: { target: 'paseo-config', change: start.data.id } } }));
      expect(f.audit().at(-1)).toMatchObject({ result: 'outcome_unknown' });
      expect(f.audit().at(-1).observed).toBeUndefined();
    });

  it.each(['digest-shaped-provider', 'contradictory-scalars'] as const)('keeps an uncertain recorded Pi change blocked with %s', async observation => {
    const f = await fixture();
    const provider = { baseUrl: 'https://example.com', apiKey: 'invented-before-key' };
    const target = observation === 'digest-shaped-provider' ? 'pi-models' : 'pi-settings';
    const path = observation === 'digest-shaped-provider' ? ['providers', 'example'] : ['defaultModel'];
    const before = observation === 'digest-shaped-provider' ? provider : 'example-before';
    f.supervisor.documents[target] = observation === 'digest-shaped-provider' ? { providers: { example: provider } } : { defaultModel: before };
    f.supervisor.documents['gateway-state'] = { migration: { version: 1, consumers: { pi: {
      [target]: moveRecord([writtenKey(path, before, before)]),
    } } } };
    f.supervisor.configApply.mockImplementationOnce(async () => {
      const projected = (await readViewValues('pi.providers', { providers: { example: provider } }, { scopes: ['settings'] }))[0]!;
      if (observation === 'digest-shaped-provider' && projected.exists) f.supervisor.documents[target] = { providers: { example: projected.value } };
      throw new Error('lost response');
    });
    const params = { consumer: 'pi', target };
    expect((await f.write('gateway.reapply-intended', params)).json().code).toBe('outcome_unknown');
    if (observation === 'contradictory-scalars') {
      const read = f.supervisor.configRead.getMockImplementation()!;
      Object.assign(f.supervisor, { configRead: vi.fn<NonNullable<SupervisorApi['configRead']>>(async request => request.view === 'pi.settings'
        ? { ok: true, view: request.view, present: true, sha256: f.supervisor.sha(target), values: [
          { path: ['defaultModel'], exists: true, value: 'example-contradiction' }, { path: ['defaultModel'], exists: true, value: before },
        ] } : read(request)) });
    }
    expect((await f.write('gateway.reapply-intended', params)).json()).toMatchObject({ status: 'refused', code: 'outcome_unknown' });
    expect(f.supervisor.configApply).toHaveBeenCalledOnce();
    expect(f.audit().at(-1).observed).toBeUndefined();
  });

  it.each(['undo', 'credential'] as const)('persists the request identity and resolves a lost %s reply from the supervisor', async action => {
    const f = await fixture();
    let requestId: string;
    let change: string;
    if (action === 'undo') {
      const first = (await f.write('hermes.reasoning-effort', { effort: 'high' })).json();
      f.supervisor.configUndo.mockRejectedValueOnce(new Error('lost response'));
      expect((await f.app.inject({ method: 'POST', url: '/api/settings/undo', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }), payload: { change: first.change.id } })).json().code).toBe('outcome_unknown');
      const command = f.supervisor.configUndo.mock.calls[0]![0];
      requestId = command.requestId; change = command.origin!.change;
    } else {
      const write = vi.fn<NonNullable<SupervisorApi['credentialWrite']>>(async () => { throw new Error('lost response'); });
      Object.assign(f.supervisor, { credentialWrite: write });
      expect((await f.app.inject({ method: 'DELETE', url: '/api/settings/credentials/demo', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }), payload: {} })).json().code).toBe('outcome_unknown');
      requestId = write.mock.calls[0]![0].requestId; change = write.mock.calls[0]![0].origin!.change;
    }
    f.supervisor.configRequestStatus.mockResolvedValue({ ok: true, requestId, state: 'terminal', outcome: 'applied', row: {
      id: requestId, time: new Date(0).toISOString(), caller: 'server', verb: action === 'undo' ? 'config.undo' : 'credential.write',
      target: action === 'undo' ? 'hermes-config' : 'gateway-credentials', keys: [], change, result: 'ok',
      ...(action === 'undo' ? { operation: 'hermes.reasoning-effort' } : {}),
    } });
    await f.app.inject({ url: '/api/settings/changes', headers: apiHeaders('fake') });
    expect(f.audit().at(-1)).toMatchObject({ id: change, result: 'ok', observed: 'supervisor' });
    expect(f.supervisor.configRequestStatus).toHaveBeenCalledWith({ requestId });
  });

  it.each([false, true].flatMap(restart => ['applied', 'refused', 'pending', 'interrupted', 'missing', 'unknown', 'wrong-id', 'wrong-change', 'wrong-target', 'wrong-verb', 'committed-failure', 'unavailable', 'malformed'].map(outcome => ({ restart, outcome }))))
    ('resolves only terminal supervisor evidence with $outcome and restart=$restart', async ({ restart, outcome }) => {
      const f = await fixture();
      f.supervisor.configApply.mockRejectedValueOnce(new Error('lost response'));
      expect((await f.write('hermes.reasoning-effort', { effort: 'high' })).json().code).toBe('outcome_unknown');
      const command = f.supervisor.configApply.mock.calls[0]![0];
      const row = { id: command.requestId, time: new Date(0).toISOString(), caller: 'server', verb: 'config.apply', operation: command.operation,
        target: 'hermes-config', keys: [], change: command.origin!.change, result: outcome === 'applied' ? 'ok' : 'failed' };
      Object.assign(f.supervisor, { configRequestStatus: vi.fn(async () => outcome === 'unavailable' ? { ok: false, code: 'unavailable' }
        : outcome === 'malformed' ? { ok: true }
        : ['pending', 'interrupted', 'missing'].includes(outcome) ? { ok: true, requestId: command.requestId, state: outcome }
        : { ok: true, requestId: outcome === 'wrong-id' ? randomUUID() : command.requestId, state: 'terminal',
          outcome: outcome === 'unknown' ? 'outcome_unknown' : outcome === 'applied' ? 'applied' : 'refused',
          row: { ...row, ...(outcome === 'wrong-change' ? { change: 'ch_' + 'e'.repeat(24) } : {}),
            ...(outcome === 'wrong-target' ? { target: 'paseo-config' } : {}), ...(outcome === 'wrong-verb' ? { verb: 'config.undo' } : {}),
            ...(outcome === 'committed-failure' ? { writtenSha256: 'a'.repeat(64) } : {}) } } ) });
      f.supervisor.configRead.mockClear();
      const app = restart ? (await f.app.close(), await f.open()) : f.app;
      await app.inject({ url: '/api/settings/changes', headers: apiHeaders('fake') });
      expect(f.supervisor.configRead).not.toHaveBeenCalled();
      const checks = (await app.inject({ url: '/api/settings/checks', headers: apiHeaders('fake') })).json();
      const resolved = outcome === 'applied' || outcome === 'refused';
      expect(checks.rows.some((row: SettingsCheckRow) => row.id === 'settings.blocked-hermes-config')).toBe(!resolved);
      expect(f.audit().at(-1)).toMatchObject(resolved ? { result: outcome === 'applied' ? 'ok' : 'failed', observed: 'supervisor' } : { result: 'outcome_unknown' });
      expect(f.supervisor.configApply).toHaveBeenCalledOnce();
    });

  it('shows a blocked target and its Fix even when other Checks observations are unavailable', async () => {
    const f = await fixture({ checks: { rows: async () => { throw new Error('unavailable'); } } });
    f.supervisor.configApply.mockRejectedValueOnce(new Error('lost response'));
    await f.write('hermes.reasoning-effort', { effort: 'high' });
    const checks = (await f.app.inject({ url: '/api/settings/checks', headers: apiHeaders('fake') })).json();
    expect(checks.rows).toContainEqual(expect.objectContaining({ id: 'settings.blocked-hermes-config', fix: expect.any(Object) }));
    expect(checks.unavailable).toEqual(['unavailable']);
  });

  it('does not let an uncertain target block other targets', async () => {
    const f = await fixture();
    f.supervisor.configApply.mockRejectedValueOnce(new Error('lost response'));
    await f.write('hermes.reasoning-effort', { effort: 'high' });
    expect((await f.write('wayroost.notifications', { push: { approvals: true, cards: true }, quietHours: null, rules: [] })).json().status).toBe('applied');
    expect((await f.write('hermes.reasoning-effort', { effort: 'low' })).json().code).toBe('outcome_unknown');
  });

  it.each([{ local: false, gate: true, cookie: DESKTOP_COOKIE, code: 'pc_only' },
    { local: true, gate: true, cookie: PHONE_COOKIE, code: 'pc_only' },
    { local: true, gate: false, cookie: DESKTOP_COOKIE, code: 'pc_only_read_only' }])
    ('refuses acceptance with local=$local, gate=$gate and code=$code', async ({ local, gate, cookie, code }) => {
      const f = await fixture({ local, gate });
      f.supervisor.configApply.mockRejectedValueOnce(new Error('lost response'));
      await f.write('hermes.reasoning-effort', { effort: 'high' });
      const response = await f.app.inject({ method: 'POST', url: '/api/settings/apply', headers: postHeaders('fake', { cookie }),
        payload: { operation: 'settings.accept-current', params: { target: 'hermes-config', change: f.audit().at(-1).id } } });
      expect(response.json()).toEqual({ status: 'refused', code });
      expect(f.audit().at(-1).observed).toBeUndefined();
      expect(f.supervisor.configApply).toHaveBeenCalledOnce();
    });

  it.each([false, true])('accepts a blocked file only after confirmation without writing, restart=%s', async restart => {
    const f = await fixture();
    f.supervisor.configApply.mockRejectedValueOnce(new Error('lost response'));
    await f.write('hermes.reasoning-effort', { effort: 'high' });
    const id = f.audit().at(-1).id;
    const params = { target: 'hermes-config', change: id };
    const before = structuredClone(f.supervisor.documents);
    const prompt = (await f.write('settings.accept-current', params)).json();
    expect(prompt).toMatchObject({ status: 'confirm', summary: 'Accept the current file as is' });
    expect((await f.write('settings.accept-current', params, { confirm: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA' })).json()).toMatchObject({ status: 'refused', code: 'confirm_invalid' });
    const response = (await f.write('settings.accept-current', params, { confirm: prompt.confirm })).json();
    expect(settingsApplyResponseSchema.safeParse(response).success).toBe(true);
    expect(response).toMatchObject({ status: 'applied', change: { undoable: false } });
    expect(f.supervisor.documents).toEqual(before);
    expect(f.supervisor.configApply).toHaveBeenCalledOnce();
    expect(f.supervisor.configUndo).not.toHaveBeenCalled();
    expect(f.audit().at(-1)).toMatchObject({ id, result: 'outcome_unknown', observed: 'resolved-by-user' });
    expect(readFileSync(join(f.config.stateDir, 'settings-audit.jsonl'), 'utf8')).toContain('settings-resolved-by-user');
    const app = restart ? (await f.app.close(), await f.open()) : f.app;
    const checks = (await app.inject({ url: '/api/settings/checks', headers: apiHeaders('fake') })).json();
    expect(checks.rows.some((row: SettingsCheckRow) => row.id === 'settings.blocked-hermes-config')).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/settings/apply', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }),
      payload: { operation: 'hermes.reasoning-effort', params: { effort: 'high' } } })).json().status).toBe('applied');
    expect((await app.inject({ method: 'POST', url: '/api/settings/apply', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }),
      payload: { operation: 'settings.accept-current', params, confirm: prompt.confirm } })).json().code).toBe('precondition_changed');
  });

  it.each(['hermes-config', 'wayroost-settings'] as const)('keeps an interrupted %s write blocked at startup until acceptance', async target => {
    const f = await fixture(); await f.app.close();
    const audit = new SettingsAudit(f.config.stateDir);
    const id = 'ch_' + 'a'.repeat(24);
    audit.start({ id, at: 1, action: 'apply', operation: target === 'hermes-config' ? 'hermes.reasoning-effort' : 'wayroost.notifications',
      target, keys: [], level: 'anywhere', timing: ['now'], result: 'failed' }, [{ label: 'now' }], undefined, randomUUID());
    audit.close();
    const app = await f.open();
    const checks = (await app.inject({ url: '/api/settings/checks', headers: apiHeaders('fake') })).json();
    expect(checks.rows).toContainEqual(expect.objectContaining({ id: `settings.blocked-${target}` }));
    const post = (extra = {}) => app.inject({ method: 'POST', url: '/api/settings/apply', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }),
      payload: { operation: 'settings.accept-current', params: { target, change: id }, ...extra } });
    const prompt = (await post()).json();
    expect((await post({ confirm: prompt.confirm })).json().status).toBe('applied');
    expect(f.supervisor.configApply).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps nested migration credentials private with local=%s', async local => {
    const f = await fixture({ local });
    const secret = 'invented-api-key-123';
    f.supervisor.documents['gateway-state'] = { migration: { version: 1, consumers: { hermes: { 'hermes-config': { keys: [
      { path: ['providers', 'example'], kind: 'recorded', before: { exists: true, value: { nested: { apiKey: secret } } },
        intended: { exists: true, value: { nested: { apiKey: secret } } } },
    ] } } } } };
    const response = await f.app.inject({ url: '/api/settings/sections/models', headers: apiHeaders('fake', { cookie: local ? DESKTOP_COOKIE : PHONE_COOKIE }) });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(secret);
    const view = response.json().views.find((entry: { view: string }) => entry.view === 'gateway.state');
    expect(view.ok).toBe(true);
    expect(view.values.filter((entry: { path: string[] }) => entry.path.at(-1) === 'value')).toHaveLength(2);
  });
  it.each(['smart', 'off', ['smart'], null])('refuses delayed tightening with guard %s before dispatch', async value => {
    const f = await fixture();
    const response = await f.write('hermes.approval-mode', { mode: 'manual' }, { afterSeconds: 60, expected: { keys: [{ key: 0, value }] } });
    expect(response.json()).toEqual({ status: 'refused', code: 'invalid_parameters' });
    expect(f.supervisor.configApply).not.toHaveBeenCalled();
    expect(f.supervisor.documents['hermes-config']!.approvals).toEqual({ mode: 'smart' });
  });


  it.each(['lost', 'revoked', 'mismatched'] as const)('retains restart tracking through a %s response and server restart', async response => {
    const f = await fixture(); let command!: DrainRestartRequest;
    const device = (await f.app.inject({ url: '/api/me', headers: apiHeaders('fake', { cookie: PHONE_COOKIE }) })).json().device.id;
    const dispatch = vi.fn(async (request: DrainRestartRequest) => {
      command = request;
      const start = readFileSync(join(f.config.stateDir, 'settings-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(row => row.type === 'settings-write-start');
      expect(start.data).toMatchObject({ requestId: request.requestId, runId: request.requestId });
      if (response === 'lost') throw new Error('unavailable');
      if (response === 'revoked') expect(f.devices.revoke(device)).toBe(true);
      return { ok: true as const, run: { ...run(), id: response === 'mismatched' ? randomUUID() : request.requestId } };
    });
    const status = vi.fn(async (id: string) => ({ ok: true as const, run: { ...run('restarted'), id } }));
    Object.assign(f.supervisor, { drainRestart: dispatch, drainRestartRun: status });
    expect((await f.app.inject({ method: 'POST', url: '/api/settings/restart', headers: postHeaders('fake', { cookie: PHONE_COOKIE }), payload: { component: 'hermes', when: 'idle' } })).json().code).toBe('outcome_unknown');
    expect(f.audit().at(-1)).toMatchObject({ runId: command.requestId, result: 'outcome_unknown' });
    await f.app.close(); const app = await f.open();
    expect((await app.inject({ url: '/api/settings/restart/' + command.requestId, headers: apiHeaders('fake', { cookie: DESKTOP_COOKIE }) })).json().status).toBe('completed');
    expect(f.audit().at(-1)).toMatchObject({ runId: command.requestId, result: 'ok' }); expect(dispatch).toHaveBeenCalledOnce();
  });

  it('settles a restart interrupted after its durable start without dispatching again', async () => {
    const f = await fixture(); await f.app.close(); const id = randomUUID(); const change = 'ch_' + 'd'.repeat(24);
    const audit = new SettingsAudit(f.config.stateDir);
    audit.start({ id: change, runId: id, at: 1, action: 'restart', operation: 'service.restart-hermes', target: 'hermes', keys: [], level: 'anywhere', timing: ['restart-when-idle:hermes'], result: 'failed' }, [{ label: 'restart-when-idle:hermes' }], undefined, id);
    audit.close(); const dispatch = vi.fn(); const status = vi.fn(async (runId: string) => ({ ok: true as const, run: { ...run('still_busy'), id: runId } }));
    Object.assign(f.supervisor, { drainRestart: dispatch, drainRestartRun: status }); const app = await f.open();
    expect((await app.inject({ url: '/api/settings/changes', headers: apiHeaders('fake') })).statusCode).toBe(200);
    expect(f.audit().at(-1)).toMatchObject({ id: change, runId: id, result: 'still_busy' }); expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps unchanged pending drains quiet across reads and polling, restart=%s', async restart => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const f = await fixture(); let current = run();
    const start = vi.fn(async (request: DrainRestartRequest) => { current.id = request.requestId; return { ok: true as const, run: current }; });
    const status = vi.fn(async () => ({ ok: true as const, run: current }));
    Object.assign(f.supervisor, { drainRestart: start, drainRestartRun: status });
    const response = await f.app.inject({ method: 'POST', url: '/api/settings/restart', headers: postHeaders('fake', { cookie: PHONE_COOKIE }),
      payload: { component: 'hermes', when: 'idle' } });
    expect(response.json().status).toBe('accepted');
    const before = readFileSync(join(f.config.stateDir, 'settings-audit.jsonl'), 'utf8');
    f.events.length = 0; const alert = vi.spyOn(f.notifications, 'alert');
    const app = restart ? (await f.app.close(), await f.open()) : f.app;
    for (const url of ['/api/settings/sections/overview', '/api/settings/changes', '/api/settings/checks', '/api/settings/sections/overview']) {
      expect((await app.inject({ url, headers: apiHeaders('fake') })).statusCode).toBe(200);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(status).toHaveBeenCalled();
    expect(readFileSync(join(f.config.stateDir, 'settings-audit.jsonl'), 'utf8')).toBe(before);
    expect(f.events.filter((event: any) => event.type === 'settings_changed')).toHaveLength(0);
    expect(alert).not.toHaveBeenCalled();
    current = { ...current, code: 'outcome_unknown' };
    expect((await app.inject({ url: '/api/settings/restart/' + current.id, headers: apiHeaders('fake') })).json().code).toBe('outcome_unknown');
    expect(readFileSync(join(f.config.stateDir, 'settings-audit.jsonl'), 'utf8')).toBe(before);
    expect(alert).not.toHaveBeenCalled();
    current = { ...run('still_busy'), id: current.id };
    const result = await app.inject({ url: '/api/settings/restart/' + current.id, headers: apiHeaders('fake') });
    expect(result.json()).toMatchObject({ status: 'refused', code: 'still_busy' });
    expect(f.audit()).toHaveLength(2);
    expect(f.audit().at(-1)).toMatchObject({ result: 'still_busy', observed: 'supervisor' });
    expect(f.events.filter((event: any) => event.type === 'settings_changed')).toHaveLength(1);
    expect(alert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: 'settings-failed', source: 'hermes' }));
    await vi.advanceTimersByTimeAsync(2000);
    await app.inject({ url: '/api/settings/sections/overview', headers: apiHeaders('fake') });
    expect(f.audit()).toHaveLength(2); expect(start).toHaveBeenCalledOnce(); expect(alert).toHaveBeenCalledOnce();
  });

  it.each(['lost', 'interrupted'] as const)('tracks a pending drain after a %s request without re-recording it', async response => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const f = await fixture(); let current = run();
    const start = vi.fn(async (request: DrainRestartRequest) => { current.id = request.requestId; throw new Error('lost response'); });
    const status = vi.fn(async () => ({ ok: true as const, run: current }));
    Object.assign(f.supervisor, { drainRestart: start, drainRestartRun: status });
    if (response === 'lost') {
      expect((await f.app.inject({ method: 'POST', url: '/api/settings/restart', headers: postHeaders('fake', { cookie: PHONE_COOKIE }),
        payload: { component: 'hermes', when: 'idle' } })).json().code).toBe('outcome_unknown');
    }
    await f.app.close();
    if (response === 'interrupted') {
      const audit = new SettingsAudit(f.config.stateDir);
      audit.start({ id: 'ch_' + 'e'.repeat(24), runId: current.id, at: 1, action: 'restart', operation: 'service.restart-hermes',
        target: 'hermes', keys: [], level: 'anywhere', timing: ['restart-when-idle:hermes'], result: 'failed' },
      [{ label: 'restart-when-idle:hermes' }], undefined, current.id);
      audit.close();
    }
    const before = readFileSync(join(f.config.stateDir, 'settings-audit.jsonl'), 'utf8');
    f.events.length = 0; const alert = vi.spyOn(f.notifications, 'alert');
    const app = await f.open();
    for (let index = 0; index < 3; index++) await app.inject({ url: '/api/settings/sections/overview', headers: apiHeaders('fake') });
    await vi.advanceTimersByTimeAsync(2000);
    expect(readFileSync(join(f.config.stateDir, 'settings-audit.jsonl'), 'utf8')).toBe(before);
    expect(f.events.filter((event: any) => event.type === 'settings_changed')).toHaveLength(0);
    expect(alert).not.toHaveBeenCalled();
    current = { ...run('restarted'), id: current.id };
    expect((await app.inject({ url: '/api/settings/restart/' + current.id, headers: apiHeaders('fake') })).json().status).toBe('completed');
    expect(f.audit().at(-1)).toMatchObject({ result: 'ok', observed: 'supervisor' });
    expect(f.events.filter((event: any) => event.type === 'settings_changed')).toHaveLength(1);
    expect(alert).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledTimes(response === 'lost' ? 1 : 0);
  });

  it.each([false, true])('does not re-announce a terminal unknown drain after reads or a server restart, immediate=%s', async immediate => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const f = await fixture(); let current: DrainRestartRun = immediate ? { ...run(), state: 'cancelled', endedAt: 2 } : run();
    const start = vi.fn(async (request: DrainRestartRequest) => { current.id = request.requestId; return { ok: true as const, run: current }; });
    const status = vi.fn(async () => ({ ok: true as const, run: current }));
    Object.assign(f.supervisor, { drainRestart: start, drainRestartRun: status });
    const alert = vi.spyOn(f.notifications, 'alert');
    const response = await f.app.inject({ method: 'POST', url: '/api/settings/restart', headers: postHeaders('fake', { cookie: PHONE_COOKIE }),
      payload: { component: 'hermes', when: 'idle' } });
    expect(response.json().status).toBe(immediate ? 'refused' : 'accepted');
    if (!immediate) {
      current = { ...run(), id: current.id, state: 'cancelled', endedAt: 2 };
      expect((await f.app.inject({ url: '/api/settings/restart/' + current.id, headers: apiHeaders('fake') })).json())
        .toMatchObject({ status: 'refused', code: 'outcome_unknown' });
    }
    expect(f.audit().at(-1)).toMatchObject({ result: 'outcome_unknown', observed: 'supervisor' });
    const before = readFileSync(join(f.config.stateDir, 'settings-audit.jsonl'), 'utf8');
    const announcements = alert.mock.calls.filter(([entry]) => entry.event === 'settings-failed').length;
    expect(announcements).toBe(1);
    expect(f.events.filter((event: any) => event.type === 'settings_changed')).toHaveLength(immediate ? 1 : 2);
    f.events.length = 0;
    for (let index = 0; index < 3; index++) await f.app.inject({ url: '/api/settings/sections/overview', headers: apiHeaders('fake') });
    await vi.advanceTimersByTimeAsync(2000);
    await f.app.close(); const app = await f.open();
    for (let index = 0; index < 3; index++) await app.inject({ url: '/api/settings/sections/overview', headers: apiHeaders('fake') });
    await app.inject({ url: '/api/settings/restart/' + current.id, headers: apiHeaders('fake') });
    await vi.advanceTimersByTimeAsync(2000);
    expect(readFileSync(join(f.config.stateDir, 'settings-audit.jsonl'), 'utf8')).toBe(before);
    expect(f.events.filter((event: any) => event.type === 'settings_changed')).toHaveLength(0);
    expect(alert.mock.calls.filter(([entry]) => entry.event === 'settings-failed')).toHaveLength(announcements);
    expect(start).toHaveBeenCalledOnce();
  });





  it.each(['restarted', 'still_busy', 'restart_unverified', 'foreign_drain', 'marker_lost', 'drain_not_engaged', 'not_running'] as const)('releases the queue for a tracked drain and resolves %s from status after a server restart', async outcome => {
    const f = await fixture(); let current = run();
    const start = vi.fn(async (request: DrainRestartRequest) => { current.id = request.requestId; return { ok: true as const, run: current }; }); const status = vi.fn(async () => ({ ok: true as const, run: current }));
    Object.assign(f.supervisor, { drainRestart: start, drainRestartRun: status });
    const response = await f.app.inject({ method: 'POST', url: '/api/settings/restart', headers: postHeaders('fake', { cookie: PHONE_COOKIE }), payload: { component: 'hermes', when: 'idle' } });
    expect(response.json()).toMatchObject({ status: 'accepted', run: { id: current.id } });
    expect(settingsRestartResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(f.audit().at(-1)).toMatchObject({ runId: current.id, result: 'outcome_unknown' });
    expect((await f.write('hermes.approval-mode', { mode: 'manual' })).json().status).toBe('applied');
    await f.app.close(); const reopened = await f.open(); current = { ...run(outcome), id: current.id };
    const final = await reopened.inject({ url: '/api/settings/restart/' + current.id, headers: apiHeaders('fake') });
    const mapped = drainRunResult(current);
    expect(final.json()).toMatchObject(mapped === 'ok' ? { status: 'completed' } : { status: 'refused', code: mapped });
    expect(settingsRestartResponseSchema.safeParse(final.json()).success).toBe(true);
    expect(f.audit().filter(entry => entry.runId === current.id).at(-1).result).toBe(mapped);
    expect(start).toHaveBeenCalledOnce();
  });
  it('returns the restart contract after a revoke and requires confirmation for restart now', async () => {
    const f = await fixture(); const response = (await f.write('hermes.revoke-always', { entrySha256: createHash('sha256').update('echo example').digest('hex') })).json();
    expect(settingsApplyResponseSchema.safeParse(response).success).toBe(true);
    expect(response).toMatchObject({ status: 'applied', change: { restartRequired: { component: 'hermes', choices: ['idle', 'now'] }, effective: 'pending' } });
    const start = vi.fn(async (request: DrainRestartRequest) => ({ ok: true as const, run: { ...run(), id: request.requestId, when: 'now' as const } })); Object.assign(f.supervisor, { drainRestart: start });
    const restart = (confirm?: string) => f.app.inject({ method: 'POST', url: '/api/settings/restart', headers: postHeaders('fake', { cookie: PHONE_COOKIE }), payload: { component: 'hermes', when: 'now', ...(confirm ? { confirm } : {}) } });
    const challenge = (await restart()).json(); expect(challenge.status).toBe('confirm'); expect(start).not.toHaveBeenCalled();
    expect((await restart(challenge.confirm)).json().status).toBe('accepted');
  });
  it.each([{ component: 'gateway', when: 'idle' }, { component: 'gateway', when: 'now' }, { component: 'dashboard', when: 'now' }] as const)
    ('routes $component/$when through its level and confirmation rules', async ({ component, when }) => {
      const f = await fixture(); const current = { ...run(), component, when };
      const start = vi.fn(async (request: DrainRestartRequest) => { current.id = request.requestId; return { ok: true as const, run: current }; }); Object.assign(f.supervisor, { drainRestart: start });
      const request = (confirm?: string) => f.app.inject({ method: 'POST', url: '/api/settings/restart',
        headers: postHeaders('fake', { cookie: PHONE_COOKIE }), payload: { component, when, ...(confirm ? { confirm } : {}) } });
      let response = await request();
      if (when === 'now') {
        expect(response.json().status).toBe('confirm'); expect(start).not.toHaveBeenCalled();
        response = await request(response.json().confirm);
      }
      expect(response.json()).toMatchObject({ status: 'accepted', run: current });
      expect(start.mock.calls[0]?.[0]).toMatchObject({ component, when });
      expect(f.audit().at(-1).level).toBe(when === 'now' ? 'confirm' : 'anywhere');
    });
  it('sends the bounded owner scan to the supervisor in production', async () => {
    const f = await fixture(); const scan = vi.fn(async () => ({ ok: true as const, scan: { findings: [{ path: '.claude/settings.json', kind: 'runs-hooks' as const, providers: ['claude' as const], reason: 'Can run hooks before or after tool use.' }], errors: [] } }));
    Object.assign(f.supervisor, { projectScan: scan });
    const result = await f.app.inject({ method: 'POST', url: '/api/project-config', headers: postHeaders('fake'), payload: { path: '/home/me/project', provider: 'claude' } });
    expect(result.json().notices).toEqual([expect.objectContaining({ files: ['.claude/settings.json'] })]);
    expect(scan).toHaveBeenCalledWith({ folder: '/home/me/project', workspaceRoots: [] });
  });
  it.each([true, false])('uses owner observations and deployment statusOnly=%s through the Checks route', async expectedStatusOnly => {
    const supervisor = new FakeSettingsSupervisor(); const observe = vi.fn(async () => ({ ok: true as const, hermesStartedAt: 100,
      coderProcesses: [], drainMarker: { present: false, ours: false, requestedAt: 0, drainRunning: false, unreadable: false }, switchFlags: {} }));
    Object.assign(supervisor, { checksObserve: observe });
    supervisor.status.mockResolvedValue({ ...await supervisor.status(), components: [{ id: 'paseo', name: 'Paseo', state: 'up', since: 0, sentence: 'Ready', busy: false, actions: [] }] } as Awaited<ReturnType<FakeSettingsSupervisor['status']>>);
    const f = await fixture({ supervisor, expectedStatusOnly });
    const response = await f.app.inject({ url: '/api/settings/checks', headers: apiHeaders('fake') });
    expect(observe).toHaveBeenCalledOnce(); expect(response.json().rows.find((row: SettingsCheckRow) => row.id === 'supervisor.config-verbs').state).toBe(expectedStatusOnly ? 'ok' : 'warn');
    expect(response.json().rows.find((row: SettingsCheckRow) => row.id === 'hermes.drain-marker').state).not.toBe('unknown');
  });
  it.each(['committed', 'uncertain'] as const)('invalidates settings after a %s failure and sends its real notification source', async outcome => {
    const f = await fixture(); const alert = vi.spyOn(f.notifications, 'alert'); const original = f.supervisor.configApply.getMockImplementation()!;
    f.supervisor.configApply.mockImplementation(async request => {
      const result = await original(request);
      if (!result.ok || !('undo' in result)) throw new Error('unexpected');
      if (outcome === 'uncertain') throw new Error('unavailable');
      return { ok: false, code: 'verify_mismatch', committed: true, undo: result.undo };
    });
    f.events.length = 0; const response = await f.write('hermes.approval-mode', { mode: 'manual' });
    expect(response.json().status).toBe('refused'); expect(f.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'settings_changed' })]));
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ event: 'settings-failed', source: 'hermes' }));
    expect(alert.mock.calls.some(([entry]) => entry.event === 'settings-applied')).toBe(false);
    if (outcome === 'uncertain') {
      expect(alert.mock.calls.at(-1)?.[0]).toMatchObject({ title: 'The change outcome is unknown', url: '/#settings/checks' });
      expect(alert.mock.calls.at(-1)?.[0].body).toContain('accept the current file as is');
    }
  });
  it('uses the saved change source for undo', async () => {
    const f = await fixture(); const change = (await f.write('hermes.approval-mode', { mode: 'manual' })).json().change;
    const alert = vi.spyOn(f.notifications, 'alert'); f.supervisor.configUndo.mockResolvedValue({ ok: false, code: 'verify_mismatch' });
    await f.app.inject({ method: 'POST', url: '/api/settings/undo', headers: postHeaders('fake'), payload: { change: change.id } });
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ event: 'settings-failed', source: 'hermes' }));
  });
  it('routes mismatch rows and clears each deduplication when it resolves', async () => {
    let state: 'fail' | 'ok' = 'fail'; const checks = { rows: async () => ({ generatedAt: 1, rows: ['hermes.drift', 'allowlist.revoke-back'].map(id => ({ id, state, sentence: 'Saved settings differ.' })) }) };
    const f = await fixture({ checks }); const mismatch = vi.spyOn(f.notifications, 'mismatch'); const alert = vi.spyOn(f.notifications, 'alert');
    const get = () => f.app.inject({ url: '/api/settings/checks', headers: apiHeaders('fake') });
    await get(); await get(); expect(mismatch).toHaveBeenCalledWith('hermes', true, 'checks:allowlist.revoke-back');
    expect(alert.mock.calls.filter(([entry]) => entry.event === 'mismatch-warning')).toHaveLength(2);
    state = 'ok'; await get(); state = 'fail'; await get();
    expect(alert.mock.calls.filter(([entry]) => entry.event === 'mismatch-warning')).toHaveLength(4);
  });
  it.each(['paseo.switch-flags', 'paseo.profiles'] as const)('routes real %s mismatches through notification deduplication and resolution', async id => {
    let switchFlag = true;
    const profile = { id: 'example-profile', provider: 'pi', model: 'demo/demo-model' };
    const state = fixtures({ documents: { 'paseo-config': { agents: { providers: { codex: { enabled: false } } },
      daemon: { agentProfiles: [profile] } } }, sources: { switchFlags: async () => ({ codex: switchFlag }) } });
    const f = await fixture({ checks: new Checks(state.sources) });
    const mismatch = vi.spyOn(f.notifications, 'mismatch'); const alert = vi.spyOn(f.notifications, 'alert');
    const setMismatch = (found: boolean) => {
      switchFlag = id === 'paseo.switch-flags' && found;
      profile.model = id === 'paseo.profiles' && found ? 'demo/example-missing' : 'demo/demo-model';
    };
    const expected = id === 'paseo.switch-flags' ? 'warn' : 'fail';
    const get = async (expected: 'warn' | 'fail' | 'ok' | 'unknown') => {
      const response = await f.app.inject({ url: '/api/settings/checks', headers: apiHeaders('fake') });
      expect(response.statusCode).toBe(200);
      expect(response.json().rows.find((row: SettingsCheckRow) => row.id === id)?.state).toBe(expected);
    };
    const alerts = () => alert.mock.calls.filter(([entry]) => entry.event === 'mismatch-warning' && entry.source === 'paseo');
    setMismatch(true); await get(expected); await get(expected);
    expect(mismatch).toHaveBeenCalledWith('paseo', true, 'checks:' + id); expect(alerts()).toHaveLength(1);
    const source = id === 'paseo.switch-flags' ? 'switchFlags' : 'readView';
    const saved = state.sources[source];
    state.sources[source] = async () => { throw new Error('unavailable'); };
    await get('unknown'); expect(alerts()).toHaveLength(1);
    Object.assign(state.sources, { [source]: saved });
    await get(expected); expect(alerts()).toHaveLength(1);
    setMismatch(false); await get('ok');
    expect(mismatch).toHaveBeenCalledWith('paseo', false, 'checks:' + id);
    setMismatch(true); await get(expected); expect(alerts()).toHaveLength(2);
  });
  it.each(['hermes.drift', 'hermes.stale-page'])('alerts for real %s warnings until their comparison resolves', async id => {
    const state = fixtures({ documents: {
      'hermes-config': { approvals: { mode: 'manual' }, display: { personality: 'focused' } },
      'gateway-state': { migration: { version: 1, consumers: { hermes: {
        'hermes-config': moveRecord([writtenKey(['approvals', 'mode'], 'smart', 'manual'), writtenKey(['display', 'personality'], 'warm', 'focused')]),
      } } } },
    } });
    const checks = new Checks(state.sources);
    const f = await fixture({ checks });
    const mismatch = vi.spyOn(f.notifications, 'mismatch'); const alert = vi.spyOn(f.notifications, 'alert');
    const get = async (expected: 'warn' | 'ok' | 'unknown') => {
      const response = await f.app.inject({ url: '/api/settings/checks', headers: apiHeaders('fake') });
      expect(response.statusCode).toBe(200);
      expect(response.json().rows.find((row: SettingsCheckRow) => row.id === id)?.state).toBe(expected);
    };
    const drift = () => { state.documents['hermes-config'] = { approvals: { mode: id === 'hermes.drift' ? 'off' : 'smart' },
      display: { personality: id === 'hermes.drift' ? 'focused' : 'warm' } }; };
    const alerts = () => alert.mock.calls.filter(([entry]) => entry.event === 'mismatch-warning');
    drift(); await get('warn'); await get('warn');
    expect(mismatch).toHaveBeenCalledWith('hermes', true, 'checks:' + id);
    expect(alerts()).toHaveLength(1);
    const readView = state.sources.readView;
    state.sources.readView = async () => { throw new Error('unavailable'); }; await get('unknown');
    state.sources.readView = readView;
    drift(); await get('warn'); expect(alerts()).toHaveLength(1);
    state.documents['hermes-config'] = { approvals: { mode: 'manual' }, display: { personality: 'focused' } };
    await get('ok'); expect(mismatch).toHaveBeenCalledWith('hermes', false, 'checks:' + id);
    drift(); await get('warn'); expect(alerts()).toHaveLength(2);
  });
  it('relays usage invalidations from the supervisor stream to app clients', async () => {
    const supervisor = new FakeSettingsSupervisor(); let handlers: SupervisorStreamHandlers | undefined;
    Object.assign(supervisor, { events: vi.fn((next: SupervisorStreamHandlers) => { handlers = next; return () => {}; }) });
    const f = await fixture({ supervisor }); handlers!.event({ type: 'usage_changed' });
    expect(f.events).toEqual(expect.arrayContaining([{ type: 'usage_changed' }]));
  });

  // Until the startup switch hands the old routes to the pipeline, they keep M1's own checks.
  it.each([{ local: false, gate: true }, { local: true, gate: false }])
    ('keeps the paired desktop able to change Safety commands on the old route with local=$local and gate=$gate', async options => {
      const f = await fixture(options); const writer = vi.spyOn(f.safetyCommands, 'setEnabled');
      const response = await f.app.inject({ method: 'PUT', url: '/api/safety-commands', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }), payload: { enabled: true } });
      expect(response.statusCode).toBe(200);
      expect(writer).toHaveBeenCalledWith(true);
    });

  it('reads both worker approval choices from the pipeline without a helper and preserves other tools', async () => {
    const f = await fixture({ pipeline: true });
    f.supervisor.documents['paseo-config'] = { agents: { providers: { codex: { paseoTools: { enabled: true, disabledTools: ['example_tool'] } } } } };
    const alert = vi.spyOn(f.notifications, 'alert'); const mismatch = vi.spyOn(f.notifications, 'mismatch');
    for (const enabled of [true, false, true]) {
      const response = await f.app.inject({ method: 'PUT', url: '/api/worker-approvals', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }), payload: { enabled } });
      expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ enabled, application: 'pending', config: 'written' });
      expect((await f.app.inject({ url: '/api/worker-approvals', headers: apiHeaders('fake') })).json()).toMatchObject({ enabled, config: 'written' });
      const tools = (f.supervisor.documents['paseo-config']!.agents as any).providers.codex.paseoTools;
      expect(tools.enabled).toBe(true); expect(tools.disabledTools).toEqual(enabled ? ['example_tool', ...WORKER_APPROVAL_TOOLS] : ['example_tool']);
      expect(alert.mock.calls.at(-1)?.[0]).toMatchObject({ event: 'settings-applied', source: 'paseo' });
      expect(mismatch.mock.calls.at(-1)?.[1]).toBe(false);
    }
    expect(alert.mock.calls.filter(([entry]) => entry.event === 'settings-failed')).toHaveLength(0);
    const original = f.supervisor.configApply.getMockImplementation()!;
    f.supervisor.configApply.mockImplementationOnce(async request => { await original(request); throw new Error('unavailable'); });
    await f.app.inject({ method: 'PUT', url: '/api/worker-approvals', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }), payload: { enabled: false } });
    expect(alert.mock.calls.at(-1)?.[0]).toMatchObject({ event: 'settings-failed', source: 'paseo' });
    const observed = readFileSync(join(f.config.stateDir, 'settings-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .filter(row => row.type === 'settings-write-observed').at(-1);
    expect(observed).toBeUndefined();
    expect(operationKeys(operationSpec('paseo.worker-approvals')!, { enabled: false }, f.supervisor.documents['paseo-config'])).not.toBe('recorded');
  });

  it.each(['credential_rejected', 'backend_unavailable'] as const)('preserves a credential probe %s in its response and separate probe audit', async code => {
    const f = await fixture(); Object.assign(f.supervisor, { credentialTest: vi.fn(async () => ({ ok: false, code })) });
    const alert = vi.spyOn(f.notifications, 'alert');
    const response = await f.app.inject({ method: 'POST', url: '/api/settings/credentials/demo/test', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }), payload: { backend: 'example' } });
    expect(response.statusCode).toBe(code === 'backend_unavailable' ? 503 : 409);
    expect(response.json()).toEqual({ status: 'refused', code, test: { ok: false, code } });
    expect(settingsCredentialResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(f.audit()).toEqual([]);
    const journal = readFileSync(join(f.config.stateDir, 'settings-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(journal.find(row => row.type === 'settings-probe-result').data).toMatchObject({ result: code });
    expect(journal.some(row => row.type === 'settings-write-start')).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it('classifies a verified legacy worker write as applied while its activation is pending', async () => {
    const f = await fixture({ pipeline: true }); const alert = vi.spyOn(f.notifications, 'alert'); const mismatch = vi.spyOn(f.notifications, 'mismatch');
    const response = await f.app.inject({ method: 'PUT', url: '/api/worker-approvals', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }), payload: { enabled: true } });
    expect(response.json()).toMatchObject({ config: 'written', application: 'pending' });
    expect(alert.mock.calls.at(-1)?.[0]).toMatchObject({ event: 'settings-applied', source: 'paseo' });
    expect(mismatch.mock.calls.at(-1)?.[1]).toBe(false);
  });

  it('compares a worker write against the writer projection including unrelated disabled tools', async () => {
    const f = await fixture({ pipeline: true });
    f.supervisor.documents['paseo-config'] = { agents: { providers: { codex: { paseoTools: { enabled: true, disabledTools: ['example_tool'] } } } } };
    const apply = f.supervisor.configApply.getMockImplementation()!;
    f.supervisor.configApply.mockImplementationOnce(async request => { await apply(request); throw new Error('unavailable'); });
    expect((await f.write('paseo.worker-approvals', { enabled: true })).json()).toMatchObject({ status: 'refused', code: 'outcome_unknown' });
    const observed = readFileSync(join(f.config.stateDir, 'settings-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .filter(row => row.type === 'settings-write-observed').at(-1);
    expect(observed).toBeUndefined();
  });




  it.each(['before', 'intended', 'other'] as const)('keeps an uncertain local write blocked with %s values until the Checks confirmation', async observed => {
    const f = await fixture({ pipeline: true });
    expect((await f.write('wayroost.safety-commands', { enabled: true })).json().status).toBe('applied');
    const apply = f.notifications.configApply.bind(f.notifications);
    vi.spyOn(f.notifications, 'configApply').mockImplementationOnce(async request => {
      if (observed !== 'before') await apply(request);
      throw new Error('lost response');
    });
    const params = { push: { approvals: false, cards: true }, quietHours: null, rules: [] };
    expect((await f.write('wayroost.notifications', params)).json().code).toBe('outcome_unknown');
    if (observed === 'other') await apply({ requestId: randomUUID(), operation: 'wayroost.notifications', params: { ...params, quietHours: { start: '22:00', end: '06:00' } } });
    Object.assign(f.supervisor, { configRequestStatus: vi.fn(async () => { throw new Error('must not look up server writes'); }) });
    expect((await f.app.inject({ url: '/api/safety-commands', headers: apiHeaders('fake') })).json()).toMatchObject({ status: 'refused', code: 'outcome_unknown' });
    const change = f.audit().filter(entry => entry.operation === 'wayroost.notifications').at(-1).id;
    const fix = { target: 'wayroost-settings', change };
    const prompt = (await f.write('settings.accept-current', fix)).json();
    const file = readFileSync(join(f.config.stateDir, 'wayroost-settings.json'), 'utf8');
    expect((await f.write('settings.accept-current', fix, { confirm: prompt.confirm })).json().status).toBe('applied');
    expect(readFileSync(join(f.config.stateDir, 'wayroost-settings.json'), 'utf8')).toBe(file);
    expect((await f.app.inject({ url: '/api/safety-commands', headers: apiHeaders('fake') })).json().enabled).toBe(true);
    expect(f.supervisor.configRequestStatus).not.toHaveBeenCalled();
    expect(f.notifications.configApply).toHaveBeenCalledOnce();
  });
});

it.each(['hermes-config', 'pi-mcp', 'gateway-credentials', 'wayroost-settings'] as const)('resolves blocked %s through the production Checks route without a file precondition', async target => {
  const f = await fixture(); await f.app.close();
  const audit = new SettingsAudit(f.config.stateDir);
  const id = 'ch_' + 'f'.repeat(24);
  audit.start({ id, at: 1, action: 'apply', operation: 'hermes.reasoning-effort', target, keys: [], level: 'anywhere', timing: ['now'], result: 'outcome_unknown' }, [{ label: 'now' }]);
  audit.close();
  const app = await f.open();
  const write = (operation: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/api/settings/apply', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }), payload: { operation, params, ...extra } });
  const checks = (await app.inject({ url: '/api/settings/checks', headers: apiHeaders('fake', { cookie: DESKTOP_COOKIE }) })).json();
  const fix = checks.rows.find((row: SettingsCheckRow) => row.id === 'settings.blocked-' + target).fix;
  const confirm = (await write(fix.operation, fix.params)).json();
  expect(confirm.status).toBe('confirm');
  expect((await write(fix.operation, fix.params, { confirm: confirm.confirm })).json().status).toBe('applied');
  const after = (await app.inject({ url: '/api/settings/checks', headers: apiHeaders('fake', { cookie: DESKTOP_COOKIE }) })).json();
  expect(after.rows.some((row: SettingsCheckRow) => row.id === 'settings.blocked-' + target)).toBe(false);
  expect(f.supervisor.configApply).not.toHaveBeenCalled();
});

it('schedules and exposes a tracked Hermes gateway restart as part of a successful revoke', async () => {
  const f = await fixture();
  let current = run();
  const start = vi.fn(async (command: DrainRestartRequest) => {
    current = { ...current, id: command.requestId };
    return { ok: true as const, run: current };
  });
  Object.assign(f.supervisor, { drainRestart: start, drainRestartRun: async () => ({ ok: true, run: current }) });
  const digest = createHash('sha256').update('echo example').digest('hex');
  const response = (await f.write('hermes.revoke-always', { entrySha256: digest })).json();
  expect(response.status).toBe('applied');
  expect(response.change.restartRequired).toMatchObject({ component: 'hermes', runId: current.id });
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ component: 'hermes', when: 'idle', origin: expect.objectContaining({ level: 'anywhere' }) }));
  const safety = (await f.app.inject({ url: '/api/settings/sections/safety', headers: apiHeaders('fake', { cookie: DESKTOP_COOKIE }) })).json();
  expect(safety.restartRuns).toEqual([current]);
  expect(f.audit().filter(entry => entry.action === 'restart')).toHaveLength(1);
  current = { ...current, ...run('restarted'), id: current.id };
  expect((await f.app.inject({ url: '/api/settings/restart/' + current.id, headers: apiHeaders('fake') })).json().status).toBe('completed');
  expect(start).toHaveBeenCalledOnce();
});

it.each([false, true].flatMap(restart => [false, true].map(refused => ({ restart, refused }))))
  ('retains the latest revoke timeout after leaving Safety, server restart=$restart, later refusal=$refused', async ({ restart, refused }) => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const f = await fixture(); let current = run();
  const start = vi.fn(async (request: DrainRestartRequest) => {
    current = { ...current, id: request.requestId };
    return { ok: true as const, run: current };
  });
  Object.assign(f.supervisor, { drainRestart: start, drainRestartRun: async () => ({ ok: true, run: current }) });
  const digest = createHash('sha256').update('echo example').digest('hex');
  expect((await f.write('hermes.revoke-always', { entrySha256: digest })).json().status).toBe('applied');
  expect((await f.app.inject({ url: '/api/settings/sections/safety', headers: apiHeaders('fake') })).json().restartRuns).toEqual([current]);
  current = { ...run('still_busy'), id: current.id, endedAt: current.startedAt + 2 * 60 * 60 * 1000 };
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.audit().at(-1)).toMatchObject({ runId: current.id, result: 'still_busy', observed: 'supervisor' });
  if (refused) {
    const decline = vi.fn(async () => ({ ok: false, code: 'busy' }));
    Object.assign(f.supervisor, { drainRestart: decline });
    expect((await f.app.inject({ method: 'POST', url: '/api/settings/restart', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }),
      payload: { component: 'hermes', when: 'now' } })).json()).toEqual({ status: 'refused', code: 'busy' });
    expect(decline).toHaveBeenCalledOnce();
  }
  const before = readFileSync(join(f.config.stateDir, 'settings-audit.jsonl'), 'utf8');
  const app = restart ? (await f.app.close(), await f.open()) : f.app;
  for (let index = 0; index < 2; index++) {
    const safety = (await app.inject({ url: '/api/settings/sections/safety', headers: apiHeaders('fake') })).json();
    expect(safety.restartRuns).toEqual([current]);
  }
  expect(start).toHaveBeenCalledOnce();
  expect(readFileSync(join(f.config.stateDir, 'settings-audit.jsonl'), 'utf8')).toBe(before);
});

it.each(['rejected', 'malformed', 'revoked'] as const)('never reserves credentials or alerts about a %s probe', async failure => {
  const f = await fixture();
  const desktop = (await f.app.inject({ url: '/api/me', headers: apiHeaders('fake', { cookie: DESKTOP_COOKIE }) })).json().device.id;
  const test = vi.fn(async () => {
    if (failure === 'rejected') throw new Error('Fake transport failure.');
    if (failure === 'revoked') f.devices.revoke(desktop);
    return { ok: true, provider: 'demo', backend: 'example', secret: 'fake-private-value' };
  });
  const write = vi.fn(async () => ({ ok: true, provider: 'demo', timing: 'restart-when-idle:gateway' }));
  Object.assign(f.supervisor, { credentialTest: test, credentialWrite: write });
  const alert = vi.spyOn(f.notifications, 'alert');
  const result = await f.app.inject({ method: 'POST', url: '/api/settings/credentials/demo/test', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }), payload: { backend: 'example' } });
  expect(result.body).not.toContain('fake-private-value');
  expect(result.json().code).not.toBe('outcome_unknown');
  expect(alert).not.toHaveBeenCalled();
  await f.app.close();
  const audit = new SettingsAudit(f.config.stateDir);
  expect(audit.unresolved()).toEqual([]); audit.close();
  const app = await f.open();
  const paired = failure === 'revoked' ? f.devices.add('Example desktop', 'desktop').cookie : undefined;
  const cookie = paired ? 'wr_device=' + paired : DESKTOP_COOKIE;
  for (const method of ['PUT', 'DELETE'] as const) {
    const answer = await app.inject({ method, url: '/api/settings/credentials/demo', headers: postHeaders('fake', { cookie }), payload: method === 'PUT' ? { secret: 'fake-example-key' } : {} });
    expect(answer.json()).toEqual({ status: 'applied', timing: [{ label: 'restart-when-idle:gateway' }] });
  }
});

it.each([false, true])('reports actual writer ownership with the startup switch %s', async pipeline => {
  const f = await fixture({ pipeline });
  for (const [section, operation] of [['safety', 'wayroost.safety-commands'], ['safety', 'paseo.worker-approvals'], ['agents', 'paseo.provider-enabled']]) {
    const payload = (await f.app.inject({ url: '/api/settings/sections/' + section, headers: apiHeaders('fake', { cookie: DESKTOP_COOKIE }) })).json();
    expect(payload.legacyRoutesViaPipeline).toBe(pipeline);
    expect(payload.operations.find((entry: { operation: string }) => entry.operation === operation)).toMatchObject({ writer: pipeline ? 'pipeline' : 'legacy', access: 'editable' });
    const phone = (await f.app.inject({ url: '/api/settings/sections/' + section, headers: apiHeaders('fake', { cookie: PHONE_COOKIE }) })).json();
    if (!pipeline) expect(phone.operations.find((entry: { operation: string }) => entry.operation === operation).access).toBe('read-only');
  }
});

it('keeps timed approval reverts refused without dispatching a write', async () => {
  const f = await fixture();
  expect((await f.write('hermes.approval-mode', { mode: 'smart' }, { afterSeconds: 60 })).json()).toEqual({ status: 'refused', code: 'invalid_parameters' });
  expect(f.supervisor.configApply).not.toHaveBeenCalled();
});

it('projects a managed pin separately from its effective Hermes value', async () => {
  const f = await fixture();
  f.supervisor.documents['hermes-managed'] = { approvals: { mode: 'manual' } };
  f.supervisor.effectiveDocuments['hermes-config'] = { ...f.supervisor.documents['hermes-config'], approvals: { mode: 'manual' } };
  const safety = (await f.app.inject({ url: '/api/settings/sections/safety', headers: apiHeaders('fake', { cookie: DESKTOP_COOKIE }) })).json();
  expect(safety.views.find((view: { view: string }) => view.view === 'hermes.managed').values).toContainEqual({ path: ['approvals', 'mode'], exists: true });
  expect(safety.views.find((view: { view: string }) => view.view === 'hermes.safety').values).toContainEqual({ path: ['approvals', 'mode'], exists: true, value: 'manual' });
});
