import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { Devices } from '../src/devices.js';
import { EventHub } from '../src/hub.js';
import { EventJournal } from '../src/hub/journal.js';
import { Checks } from '../src/checks/index.js';
import type { SettingsOptions } from '../src/settings/routes.js';
import { SettingsAudit } from '../src/settings/audit.js';
import { blockedReason, parseSlash } from '../src/hermes/commands.js';
import { settingsApplyResponseSchema, SETTINGS_ERROR_CODES, recentChangeSchema } from '../../shared/settings.js';
import { FakeSettingsSupervisor } from './fake-settings-supervisor.js';
import { SafetyCommandsSetting } from '../src/hermes/safety.js';
import { pendingWorkerApprovals, WorkerApprovalsStatus } from '../../shared/safety.js';
import { configReadResultSchema, settingsCredentialResponseSchema, type ConfigApplyRequest, type ConfigUndoRequest, type DrainRestartRequest } from '../../shared/supervisor-config.js';
import { makeConfig, FakeHermes, FakePaseo, postHeaders, apiHeaders, PHONE_COOKIE, DESKTOP_COOKIE, TEST_DESKTOP } from './helpers.js';

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(options: { local?: boolean; gate?: boolean; shadow?: boolean; supervisor?: boolean; logs?: string[]; consumers?: boolean; checks?: SettingsOptions['checks'] } = {}) {
  let now = 1_800_000_000_000;
  const config = makeConfig(undefined, { settings: { legacyRoutesViaPipeline: true },
    localListener: { port: 19014, pcOnlyWrites: options.gate ?? true }, origins: ['https://127.0.0.1:19014'] });
  if (options.shadow) config.role = 'shadow';
  roots.push(config.stateDir);
  const hub = new EventHub();
  const events: unknown[] = [];
  hub.observe(event => { if (event.type === 'settings_changed') events.push(event); });
  const supervisor = new FakeSettingsSupervisor();
  const safetyCommands = new SafetyCommandsSetting(config.stateDir);
  if (options.consumers) supervisor.documents['wayroost-settings']!.safetyCommandsEnabled = true;
  const devices = new Devices(config.stateDir);
  const app = await buildApp({ config, hub, devices, sources: { hermes: new FakeHermes(), paseo: new FakePaseo() },
    verifier: async () => ({ email: 'you@example.com', exp: 2_000_000_000 }),
    logger: options.logs ? { level: 'trace', stream: { write: (line: string) => { options.logs!.push(line); } } } : false,
    ...(options.supervisor === false ? {} : { supervisor }), settings: { now: () => now, ...(options.checks ? { checks: options.checks } : {}) },
    ...(options.consumers ? { safetyCommands, workerApprovals: { status: async () => pendingWorkerApprovals(),
      setEnabled: vi.fn(async (enabled: boolean) => ({ ...pendingWorkerApprovals(), enabled })) } } : {}) });
  // Injection supplies a transport socket without opening a listener.
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'localPort', { configurable: true, value: options.local ? 19014 : 19010 }); });
  apps.push(app);
  const write = async (operation: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}, phone = false) => {
    const response = await app.inject({ method: 'POST', url: '/api/settings/apply', headers: postHeaders('fake', { cookie: phone ? PHONE_COOKIE : DESKTOP_COOKIE }),
      payload: { operation, params, ...extra } });
    expect(settingsApplyResponseSchema.safeParse(response.json()).success).toBe(true);
    return response;
  };
  const undo = (change: string, confirm?: string, phone = false) => app.inject({ method: 'POST', url: '/api/settings/undo',
    headers: postHeaders('fake', { cookie: phone ? PHONE_COOKIE : DESKTOP_COOKIE }), payload: { change, ...(confirm ? { confirm } : {}) } });
  const rows = () => readFileSync(join(config.stateDir, 'settings-audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { app, config, supervisor, events, devices, write, undo, rows, safetyCommands, hub,
    advance: (ms: number) => { now += ms; } };
}

it('lists the unknown write outcome once and accepts it in refusal responses', () => {
  expect(SETTINGS_ERROR_CODES.filter(code => code === 'outcome_unknown')).toEqual(['outcome_unknown']);
  expect(settingsApplyResponseSchema.safeParse({ status: 'refused', code: 'outcome_unknown', backupId: null }).success).toBe(true);
});

it('updates live Safety commands on apply, undo and reload', async () => {
  const f = await fixture({ local: true, consumers: true });
  const changed = (await f.write('wayroost.safety-commands', { enabled: false })).json();
  expect(changed).toMatchObject({ status: 'applied', change: { effective: 'verified' } });
  expect(f.safetyCommands.enabled()).toBe(false);
  expect((await f.app.inject({ url: '/api/safety-commands', headers: apiHeaders('fake') })).json().enabled).toBe(false);
  expect((await f.undo(changed.change.id)).json().status).toBe('applied');
  expect(f.safetyCommands.enabled()).toBe(true);
  await f.app.close();
  const safetyCommands = new SafetyCommandsSetting(f.config.stateDir);
  const reloaded = await buildApp({ config: f.config, hub: new EventHub(), devices: f.devices, supervisor: f.supervisor,
    sources: { hermes: new FakeHermes(), paseo: new FakePaseo() }, safetyCommands, logger: false,
    verifier: async () => ({ email: 'you@example.com', exp: 2_000_000_000 }) });
  apps.push(reloaded);
  expect(safetyCommands.enabled()).toBe(true);
});

it.each(['apply', 'undo'] as const)('releases a definitively refused Safety %s after a failed refresh', async action => {
  const f = await fixture({ local: true, consumers: true });
  const first = action === 'undo' ? (await f.write('wayroost.safety-commands', { enabled: false })).json() : undefined;
  f.events.length = 0;
  const method = action === 'apply' ? f.supervisor.configApply : f.supervisor.configUndo;
  method.mockImplementationOnce(async () => {
    f.supervisor.documents['wayroost-settings']!.safetyCommandsEnabled = true;
    f.supervisor.configRead.mockRejectedValueOnce(new Error('demo-unavailable'));
    return { ok: false, code: 'precondition_changed' };
  });
  const response = action === 'apply' ? await f.write('wayroost.safety-commands', { enabled: false }) : await f.undo(first.change.id);
  expect(response.json()).toEqual({ status: 'refused', code: 'precondition_changed' });
  expect(f.safetyCommands.enabled()).toBe(false);
  expect((await f.app.inject({ url: '/api/safety-commands', headers: apiHeaders('fake') })).json().enabled).toBe(true);
  expect(f.safetyCommands.enabled()).toBe(true);
  expect(method).toHaveBeenCalledOnce();
  expect(f.events).toEqual([]);
});

it('refuses verification when live Safety differs from the saved settings', async () => {
  const f = await fixture({ consumers: true });
  vi.spyOn(f.safetyCommands, 'enabled').mockReturnValue(true);
  const response = await f.write('wayroost.safety-commands', { enabled: false });
  expect(response.json()).toMatchObject({ status: 'refused', code: 'verify_mismatch', change: { effective: 'mismatch', undoable: true } });
  expect(f.events).toEqual([expect.objectContaining({ type: 'settings_changed' })]);
});

it('refreshes a live consumer even when the supervisor reports a failure after committing', async () => {
  const f = await fixture({ consumers: true });
  const apply = f.supervisor.configApply.getMockImplementation()!;
  f.supervisor.configApply.mockImplementationOnce(async request => {
    const result = await apply(request);
    if (!result.ok || !('undo' in result)) throw new Error('demo-unexpected-result');
    return { ok: false, code: 'consumer_refused', committed: true, undo: result.undo };
  });
  expect((await f.write('wayroost.safety-commands', { enabled: false })).json()).toMatchObject({ status: 'refused', code: 'consumer_refused' });
  expect(f.safetyCommands.enabled()).toBe(false);
  expect(f.events).toEqual([expect.objectContaining({ type: 'settings_changed' })]);
});

it.each(['apply', 'undo'] as const)('keeps an uncertain %s blocked without replaying it in another request', async action => {
  const f = await fixture();
  const first = action === 'undo' ? (await f.write('hermes.reasoning-effort', { effort: 'high' })).json() : undefined;
  const method = action === 'apply' ? f.supervisor.configApply : f.supervisor.configUndo;
  const original = method.getMockImplementation()!;
  method.mockImplementationOnce(async (request: ConfigApplyRequest | ConfigUndoRequest) => {
    await original(request as ConfigApplyRequest & ConfigUndoRequest);
    throw new Error('demo-lost-reply');
  });
  const lost = action === 'apply' ? await f.write('hermes.reasoning-effort', { effort: 'high' }) : await f.undo(first.change.id);
  expect(lost.json()).toEqual({ status: 'refused', code: 'outcome_unknown', backupId: null });
  const starts = f.rows().filter(row => row.type === 'settings-write-start');
  const observed = f.rows().find(row => row.type === 'settings-write-observed' && row.data.id === starts.at(-1).data.id);
  expect(observed).toBeUndefined();
  expect(f.rows().filter(row => row.type === 'settings-change').at(-1).data.result).toBe('outcome_unknown');
  expect(method).toHaveBeenCalledOnce();
  expect((await f.write('hermes.reasoning-effort', { effort: 'low' }, {}, true)).json()).toMatchObject({ status: 'refused', code: 'outcome_unknown' });
  expect(f.supervisor.configUndo).toHaveBeenCalledTimes(action === 'undo' ? 1 : 0);
  const ids = f.supervisor.configApply.mock.calls.map(([request]) => request.requestId);
  expect(new Set(ids).size).toBe(ids.length);
  expect(f.supervisor.documents['hermes-config']!.agent).toEqual({ reasoning_effort: action === 'undo' ? 'medium' : 'high' });
});

it.each(['uncommitted', 'committed', 'unreadable'] as const)("never executes a revoked device's uncertain privileged write: %s", async outcome => {
  const f = await fixture({ local: true });
  const original = f.supervisor.configApply.getMockImplementation()!;
  f.supervisor.configApply.mockImplementationOnce(async request => {
    if (outcome === 'committed') await original(request);
    if (outcome === 'unreadable') f.supervisor.configRead.mockRejectedValueOnce(new Error('demo-unavailable'));
    throw new Error('demo-lost-reply');
  });
  const lost = await f.write('hermes.approval-mode', { mode: 'off' });
  expect(lost.json()).toEqual({ status: 'refused', code: 'outcome_unknown', backupId: null });
  expect(f.supervisor.configApply).toHaveBeenCalledOnce();
  expect(f.events).toEqual([expect.objectContaining({ type: 'settings_changed' })]);
  expect(f.devices.revoke(TEST_DESKTOP.id)).toBe(true);
  expect((await f.write('hermes.reasoning-effort', { effort: 'high' }, {}, true)).json()).toMatchObject({ status: 'refused', code: 'outcome_unknown' });
  expect((await f.write('hermes.approval-mode', { mode: 'off' }, {}, true)).json())
    .toMatchObject({ status: 'refused', code: 'outcome_unknown' });
  expect(f.supervisor.configApply.mock.calls.map(([request]) => request.operation)).toEqual(['hermes.approval-mode']);
  expect(f.supervisor.documents['hermes-config']!.approvals).toEqual({ mode: outcome === 'committed' ? 'off' : 'smart' });
  expect(f.rows().filter(row => row.type === 'settings-write-observed')).toEqual([]);
});

it('drops a queued write when its device is revoked', async () => {
  const f = await fixture({ local: true });
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const original = f.supervisor.configApply.getMockImplementation()!;
  f.supervisor.configApply.mockImplementationOnce(async request => { entered(); await waiting; return original(request); });
  const first = f.write('hermes.reasoning-effort', { effort: 'high' }, {}, true);
  await started;
  const queued = f.write('hermes.approval-mode', { mode: 'off' });
  await new Promise(resolve => setImmediate(resolve));
  expect(f.devices.revoke(TEST_DESKTOP.id)).toBe(true);
  release();
  expect((await first).json().status).toBe('applied');
  expect((await queued).json()).toEqual({ status: 'refused', code: 'not_permitted' });
  expect(f.supervisor.configApply).toHaveBeenCalledOnce();
  expect(f.supervisor.documents['hermes-config']!.approvals).toEqual({ mode: 'smart' });
});

it.each([
  { reply: 'committed', revoked: true }, { reply: 'unknown', revoked: true },
  ...['lost', 'malformed', 'unknown-without-token'].flatMap(reply => [false, true].map(revoked => ({ reply, revoked }))),
].flatMap(outcome => [false, true].map(restart => ({ ...outcome, restart }))))(
  'preserves undo linkage after a $reply reply with revoked=$revoked and restart=$restart', async ({ reply, revoked, restart }) => {
  const f = await fixture();
  const first = (await f.write('hermes.reasoning-effort', { effort: 'high' })).json();
  const writtenSha256 = f.supervisor.sha('hermes-config');
  f.events.length = 0;
  const original = f.supervisor.configUndo.getMockImplementation()!;
  f.supervisor.configUndo.mockImplementationOnce(async request => {
    expect(f.rows().filter(row => row.type === 'settings-write-start').at(-1).data)
      .toMatchObject({ action: 'undo', undoOf: first.change.id });
    const result = await original(request);
    if (revoked) expect(f.devices.revoke(TEST_DESKTOP.id)).toBe(true);
    if (reply === 'lost') throw new Error('demo-lost-reply');
    if (reply === 'malformed') return {} as never;
    if (reply === 'unknown-without-token') return { ok: false, code: 'outcome_unknown' };
    if (reply === 'unknown') {
      if (!result.ok || !('undo' in result)) throw new Error('demo-unexpected-result');
      return { ok: false, code: 'outcome_unknown', committed: true, undo: result.undo };
    }
    return result;
  });
  const response = await f.undo(first.change.id);
  const backupId = reply === 'committed' || reply === 'unknown' ? 'backup-1' : null;
  expect(response.json()).toEqual({ status: 'refused', code: 'outcome_unknown', backupId });
  expect(settingsApplyResponseSchema.safeParse(response.json()).success).toBe(true);
  const final = f.rows().filter(row => row.type === 'settings-change').at(-1).data;
  expect(final).toMatchObject({ action: 'undo', operation: 'hermes.reasoning-effort', result: 'outcome_unknown', undoOf: first.change.id,
    ...(backupId ? { backupId, backupSha256: writtenSha256, writtenSha256: f.supervisor.sha('hermes-config') } : {}) });
  expect(f.rows().filter(row => row.type === 'settings-write-observed')).toHaveLength(0);
  expect(f.events).toEqual([expect.objectContaining({ type: 'settings_changed' })]);
  let app = f.app;
  if (restart) {
    await app.close();
    app = await buildApp({ config: f.config, hub: new EventHub(), devices: f.devices, supervisor: f.supervisor,
      sources: { hermes: new FakeHermes(), paseo: new FakePaseo() }, logger: false,
      verifier: async () => ({ email: 'you@example.com', exp: 2_000_000_000 }) });
    apps.push(app);
  }
  const headers = postHeaders('fake', { cookie: PHONE_COOKIE });
  const changes = (await app.inject({ url: '/api/settings/changes', headers: apiHeaders('fake', { cookie: PHONE_COOKIE }) })).json().changes;
  expect(changes.find((change: { id: string }) => change.id === final.id)).toMatchObject({ result: 'outcome_unknown' });
  expect(f.rows().find(row => row.type === 'settings-change' && row.data.id === final.id).data.undoOf).toBe(first.change.id);
  const currentSha256 = f.supervisor.sha('hermes-config');
  const later = await app.inject({ method: 'POST', url: '/api/settings/apply', headers,
    payload: { operation: 'hermes.reasoning-effort', params: { effort: 'high' } } });
  expect(later.json()).toMatchObject({ status: 'refused', code: 'outcome_unknown' });
  expect(f.supervisor.sha('hermes-config')).toBe(currentSha256);
  expect(changes.find((change: { id: string }) => change.id === first.change.id).undoable).toBe(false);
  expect((await app.inject({ method: 'POST', url: '/api/settings/undo', headers, payload: { change: first.change.id } })).json())
    .toEqual({ status: 'refused', code: 'undo_changed' });
  expect(f.supervisor.configApply).toHaveBeenCalledOnce();
  expect(f.supervisor.configUndo).toHaveBeenCalledOnce();
});

it.each(['failed', 'precondition_changed', 'backup_mismatch', 'undo_changed'] as const)(
  'spends an accepted undo before a definitive %s reply and keeps it spent after restart', async code => {
  const f = await fixture();
  const first = (await f.write('hermes.reasoning-effort', { effort: 'high' })).json();
  const writtenSha256 = f.supervisor.sha('hermes-config');
  f.events.length = 0;
  f.supervisor.configUndo.mockImplementationOnce(async () => {
    expect(f.rows().filter(row => row.type === 'settings-write-start').at(-1).data)
      .toMatchObject({ action: 'undo', undoOf: first.change.id });
    return { ok: false, code };
  });
  expect((await f.undo(first.change.id)).json()).toEqual({ status: 'refused', code });
  expect(f.rows().filter(row => row.type === 'settings-change').at(-1).data)
    .toMatchObject({ action: 'undo', result: code, undoOf: first.change.id });
  expect(f.events).toEqual([]);
  expect((await f.undo(first.change.id, undefined, true)).json()).toEqual({ status: 'refused', code: 'undo_changed' });
  await f.app.close();
  const app = await buildApp({ config: f.config, hub: new EventHub(), devices: f.devices, supervisor: f.supervisor,
    sources: { hermes: new FakeHermes(), paseo: new FakePaseo() }, logger: false,
    verifier: async () => ({ email: 'you@example.com', exp: 2_000_000_000 }) });
  apps.push(app);
  const changes = (await app.inject({ url: '/api/settings/changes', headers: apiHeaders('fake') })).json().changes;
  expect(changes.find((change: { id: string }) => change.id === first.change.id).undoable).toBe(false);
  expect(f.supervisor.sha('hermes-config')).toBe(writtenSha256);
  expect((await app.inject({ method: 'POST', url: '/api/settings/undo', headers: postHeaders('fake', { cookie: PHONE_COOKIE }),
    payload: { change: first.change.id } })).json()).toEqual({ status: 'refused', code: 'undo_changed' });
  expect(f.supervisor.configUndo).toHaveBeenCalledOnce();
});

it.each([false, true])('spends an undo at audit acceptance with an unfinished write=%s', async unfinished => {
  const f = await fixture();
  const first = (await f.write('hermes.reasoning-effort', { effort: 'high' })).json();
  await f.app.close();
  const audit = new SettingsAudit(f.config.stateDir);
  const record = { id: `ch_${'b'.repeat(24)}`, at: 0, action: 'undo' as const, operation: 'hermes.reasoning-effort',
    target: 'hermes-config' as const, keys: ['agent.reasoning_effort'], level: 'anywhere' as const,
    timing: ['next-turn' as const], result: 'failed' as const };
  const timing = [{ label: 'next-turn' as const }];
  try {
    expect(audit.token(first.change.id)).toBeDefined();
    audit.start(record, timing, first.change.id);
    expect(audit.token(first.change.id)).toBeUndefined();
    if (!unfinished) audit.record(record, timing);
  } finally { audit.close(); }
  const reopened = new SettingsAudit(f.config.stateDir);
  try {
    expect(reopened.token(first.change.id)).toBeUndefined();
  } finally { reopened.close(); }
});

it('keeps a token spent when the accepting device is revoked before supervisor dispatch', async () => {
  const f = await fixture();
  const first = (await f.write('hermes.reasoning-effort', { effort: 'high' })).json();
  const start = SettingsAudit.prototype.start;
  vi.spyOn(SettingsAudit.prototype, 'start').mockImplementation(function (this: SettingsAudit, record, timing, undoOf) {
    start.call(this, record, timing, undoOf);
    expect(f.devices.revoke(TEST_DESKTOP.id)).toBe(true);
  });
  expect((await f.undo(first.change.id)).json()).toEqual({ status: 'refused', code: 'not_permitted' });
  expect((await f.undo(first.change.id, undefined, true)).json()).toEqual({ status: 'refused', code: 'undo_changed' });
  expect(f.supervisor.configUndo).not.toHaveBeenCalled();
});

it('keeps the successful legacy response shapes', async () => {
  const f = await fixture({ local: true, consumers: true });
  const put = (url: string, payload: unknown) => f.app.inject({ method: 'PUT', url, payload: JSON.stringify(payload), headers: postHeaders('fake') });
  expect((await put('/api/cloud-agents/codex', { enabled: false })).json()).toMatchObject({ agents: [
    { id: 'claude', enabled: true }, { id: 'codex', enabled: false, state: 'off' },
  ] });
  const safety = (await put('/api/safety-commands', { enabled: false })).json();
  expect(safety.enabled).toBe(false);
  expect(safety.commands.join()).toContain('/yolo');
  expect(WorkerApprovalsStatus.safeParse((await put('/api/worker-approvals', { enabled: true })).json()).success).toBe(true);
});

it('drops a lost credential write without retaining or recording its secret', async () => {
  const f = await fixture({ local: true });
  const credentialWrite = vi.fn(async () => { throw new Error('demo-lost-reply'); });
  Object.assign(f.supervisor, { credentialWrite });
  const response = await f.app.inject({ method: 'PUT', url: '/api/settings/credentials/demo', headers: postHeaders('fake'),
    payload: { secret: 'obviously-fake-credential' } });
  expect(response.json()).toEqual({ status: 'refused', code: 'outcome_unknown', backupId: null });
  expect((await f.write('hermes.reasoning-effort', { effort: 'high' })).json().status).toBe('applied');
  expect(f.supervisor.configApply).toHaveBeenCalledOnce();
  expect(credentialWrite.mock.calls).toHaveLength(1);
  expect(JSON.stringify(f.rows())).not.toContain('obviously-fake-credential');
});

it.each([false, true])('preserves absence preconditions against a file created during dispatch with explicit expected=%s', async explicit => {
  const f = await fixture({ consumers: true });
  delete f.supervisor.documents['wayroost-settings'];
  const apply = f.supervisor.configApply.getMockImplementation()!;
  f.supervisor.configApply.mockImplementationOnce(async request => {
    f.supervisor.documents['wayroost-settings'] = { push: { approvals: false, cards: true } };
    return apply(request);
  });
  const response = explicit
    ? await f.write('wayroost.notifications', { push: { approvals: true, cards: false }, quietHours: null }, { expected: { keys: [0, 1, 2].map(key => ({ key, exists: false })) } })
    : await f.write('wayroost.notifications', { push: { approvals: true, cards: false }, quietHours: null });
  expect(response.json()).toEqual({ status: 'refused', code: 'precondition_changed' });
  expect(f.supervisor.documents['wayroost-settings']).toEqual({ push: { approvals: false, cards: true } });
  expect(f.supervisor.configApply.mock.calls[0]![0].preconditions).toEqual({
    keys: [0, 1, 2].map(key => ({ key, exists: false })),
  });
  expect(f.events).toEqual([]);
});

it('creates absent settings under key preconditions without replacing unrelated fields', async () => {
  const f = await fixture({ consumers: true });
  delete f.supervisor.documents['wayroost-settings'];
  const apply = f.supervisor.configApply.getMockImplementation()!;
  f.supervisor.configApply.mockImplementationOnce(async request => {
    f.supervisor.documents['wayroost-settings'] = { safetyCommandsEnabled: true };
    return apply(request);
  });
  expect((await f.write('wayroost.notifications', { push: { approvals: true, cards: false }, quietHours: null })).json())
    .toMatchObject({ status: 'applied', change: { effective: 'verified' } });
  expect(f.supervisor.documents['wayroost-settings']!.push).toEqual({ approvals: true, cards: false });
  expect(f.supervisor.documents['wayroost-settings']!.safetyCommandsEnabled).toBe(true);
  expect(f.supervisor.configApply.mock.calls[0]![0].preconditions).toEqual({ keys: [0, 1, 2].map(key => ({ key, exists: false })) });
});

it('requires confirmed PC acceptance before another request and preserves the resolution after restart', async () => {
  const f = await fixture({ local: true, consumers: true });
  f.supervisor.configApply.mockRejectedValueOnce(new Error('demo-lost-reply'));
  expect((await f.write('wayroost.safety-commands', { enabled: true })).json())
    .toEqual({ status: 'refused', code: 'outcome_unknown', backupId: null });
  expect((await f.write('wayroost.safety-commands', { enabled: true }, {}, true)).json())
    .toMatchObject({ status: 'refused', code: 'outcome_unknown' });
  const params = { target: 'wayroost-settings', change: f.rows().filter(row => row.type === 'settings-change').at(-1).data.id };
  const prompt = (await f.write('settings.accept-current', params)).json();
  expect((await f.write('settings.accept-current', params, { confirm: prompt.confirm })).json().status).toBe('applied');
  await f.app.close();
  const safetyCommands = new SafetyCommandsSetting(f.config.stateDir);
  const app = await buildApp({ config: f.config, hub: new EventHub(), devices: f.devices, supervisor: f.supervisor, safetyCommands,
    sources: { hermes: new FakeHermes(), paseo: new FakePaseo() }, logger: false,
    verifier: async () => ({ email: 'you@example.com', exp: 2_000_000_000 }) });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'localPort', { configurable: true, value: 19014 }); });
  apps.push(app);
  expect(safetyCommands.enabled()).toBe(true);
  expect(f.supervisor.configApply).toHaveBeenCalledOnce();
  expect((await app.inject({ url: '/api/safety-commands', headers: apiHeaders('fake') })).json().enabled).toBe(true);
  const response = await app.inject({ method: 'POST', url: '/api/settings/apply', headers: postHeaders('fake'),
    payload: { operation: 'wayroost.safety-commands', params: { enabled: true } } });
  expect(response.json().status).toBe('applied');
  expect(safetyCommands.enabled()).toBe(true);
  const ids = f.supervisor.configApply.mock.calls.map(([request]) => request.requestId);
  expect(new Set(ids).size).toBe(2);
});

describe('settings level decisions', () => {
  it.each([false, true])('allows Anywhere from a %s phone flag and confirms supervisor provenance', async phone => {
    const f = await fixture();
    const response = await f.write('hermes.reasoning-effort', { effort: 'high' }, {}, phone);
    expect(response.json()).toMatchObject({ status: 'applied', change: { effective: 'pending', undoable: true } });
    expect(f.supervisor.configApply.mock.calls[0]![0]).toMatchObject({ origin: { level: 'anywhere', device: { kind: phone ? 'phone' : 'desktop' } },
      preconditions: { file: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
  });

  it.each([false, true])('a desktop needs no Confirm code on local=%s', async local => {
    const f = await fixture({ local });
    expect((await f.write('hermes.default-model', { provider: 'demo', model: 'other-model', baseUrl: 'http://127.0.0.1:18010' })).json().status).toBe('applied');
  });

  it('requires one exact, single-use phone code', async () => {
    const f = await fixture();
    const params = { provider: 'demo', model: 'other-model', baseUrl: 'http://127.0.0.1:18010' };
    const challenge = (await f.write('hermes.default-model', params, {}, true)).json();
    expect(challenge).toMatchObject({ status: 'confirm', expiresAt: 1_800_000_060_000 });
    expect(f.supervisor.configApply).not.toHaveBeenCalled();
    expect((await f.write('hermes.default-model', { ...params, model: 'changed-model' }, { confirm: challenge.confirm }, true)).json()).toEqual({ status: 'refused', code: 'confirm_invalid' });
    expect((await f.write('hermes.default-model', params, { confirm: challenge.confirm }, true)).json().status).toBe('applied');
    expect((await f.write('hermes.default-model', params, { confirm: challenge.confirm }, true)).json()).toEqual({ status: 'refused', code: 'confirm_invalid' });
    expect(f.supervisor.configApply).toHaveBeenCalledOnce();
  });

  it.each(['device', 'file', 'preconditions', 'operation', 'expiry'] as const)('denies a code when its %s changes', async changed => {
    const f = await fixture();
    const params = { maxConcurrentChildren: 2, maxIterations: 20 };
    const challenge = (await f.write('hermes.delegation-limits', params, {}, true)).json();
    if (changed === 'file') f.supervisor.documents['hermes-config']!.unrelated = true;
    if (changed === 'expiry') f.advance(60_000);
    if (changed === 'device') {
      const phone = f.devices.add('Second phone', 'phone');
      const response = await f.app.inject({ method: 'POST', url: '/api/settings/apply', headers: postHeaders('fake', { cookie: `wr_device=${phone.cookie}` }),
        payload: { operation: 'hermes.delegation-limits', params, confirm: challenge.confirm } });
      expect(response.json()).toEqual({ status: 'refused', code: 'confirm_invalid' });
    } else {
      const response = await f.write(changed === 'operation' ? 'hermes.default-model' : 'hermes.delegation-limits',
        changed === 'operation' ? { provider: 'demo', model: 'demo-model', baseUrl: 'http://127.0.0.1:18010' } : params,
        { confirm: challenge.confirm, ...(changed === 'preconditions' ? { expected: { file: { sha256: f.supervisor.sha('hermes-config') } } } : {}) }, true);
      expect(response.json()).toEqual({ status: 'refused', code: 'confirm_invalid' });
    }
    expect(f.supervisor.configApply).not.toHaveBeenCalled();
    if (changed === 'expiry') expect(f.rows()).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'approval-code-expired', data: expect.objectContaining({ decision: 'deny' }) })]));
  });

  it.each([
    { local: true, gate: true, phone: false, code: undefined },
    { local: false, gate: true, phone: false, code: 'pc_only' },
    { local: true, gate: true, phone: true, code: 'pc_only' },
    { local: false, gate: true, phone: true, code: 'pc_only' },
    { local: true, gate: false, phone: false, code: 'pc_only_read_only' },
    { local: false, gate: false, phone: false, code: 'pc_only_read_only' },
  ])('enforces PC-only on $local/$gate/$phone', async ({ local, gate, phone, code }) => {
    const f = await fixture({ local, gate });
    const response = await f.write('paseo.routing-note', { text: 'Use the demo provider.' }, {}, phone);
    expect(response.json()).toMatchObject(code ? { status: 'refused', code } : { status: 'applied' });
    expect(f.supervisor.configApply).toHaveBeenCalledTimes(code ? 0 : 1);
  });

  it.each([
    ['hermes.approval-mode', { mode: 'manual' }, 'applied'], ['hermes.approval-mode', { mode: 'off' }, 'refused'],
    ['hermes.skill-staging', { enabled: true }, 'applied'], ['hermes.skill-staging', { enabled: false }, 'refused'],
    ['wayroost.safety-commands', { enabled: false }, 'applied'], ['wayroost.safety-commands', { enabled: true }, 'refused'],
    ['paseo.worker-approvals', { enabled: true }, 'applied'], ['paseo.worker-approvals', { enabled: false }, 'refused'],
  ])('tightens and loosens %s according to its parameters', async (operation, params, status) => {
    const f = await fixture();
    expect((await f.write(operation as string, params as Record<string, unknown>, {}, true)).json().status).toBe(status);
  });

  it.each(['POST /api/settings/apply', 'POST /api/settings/undo', 'POST /api/settings/restart', 'PUT /api/settings/credentials/demo',
    'DELETE /api/settings/credentials/demo', 'POST /api/settings/credentials/demo/test', 'PUT /api/settings/notifications',
    'PUT /api/settings/safety-commands', 'PUT /api/settings/hermes', 'PUT /api/safety-commands', 'PUT /api/cloud-agents/codex',
    'PUT /api/worker-approvals'])('refuses %s in shadow before any backend call', async route => {
    const f = await fixture({ shadow: true, local: true });
    const [method, url] = route.split(' ');
    const response = await f.app.inject({ method: method as 'PUT', url: url!, headers: postHeaders('fake'), payload: {} });
    expect(response.json()).toEqual({ status: 'refused', code: 'shadow_read_only' });
    expect(f.supervisor.configApply).not.toHaveBeenCalled();
    expect(f.supervisor.configRead).not.toHaveBeenCalled();
  });
});

it.each([{ local: false, gate: true, phone: false }, { local: true, gate: false, phone: false },
  { local: true, gate: true, phone: true }, { local: true, gate: true, phone: false }])('redacts secret-capable values for %j', async options => {
  const f = await fixture(options);
  const text = 'Example routing note with a fake bearer string.';
  f.supervisor.documents['paseo-config']!.daemon = { appendSystemPrompt: text,
    agentProfiles: [{ id: 'demo-private-id', model: 'demo/model', name: 'Demo name' }] };
  const response = await f.app.inject({ url: '/api/settings/sections/agents', headers: apiHeaders('fake', { cookie: options.phone ? PHONE_COOKIE : DESKTOP_COOKIE }) });
  expect(response.statusCode).toBe(200);
  const entry = response.json().views.find((view: { view: string }) => view.view === 'paseo.agents').values.find((entry: { path: string[] }) => entry.path.join('.') === 'daemon.appendSystemPrompt');
  const pc = options.local && options.gate && !options.phone;
  expect(entry.value).toEqual(pc ? text : { sha256: createHash('sha256').update(text).digest('hex'), length: Buffer.byteLength(text) });
  expect(response.body.includes('demo-private-id')).toBe(pc);
});

it('redacts unexpected public value shapes, nested secrets and dynamic names', async () => {
  const f = await fixture();
  f.supervisor.documents['hermes-config']!.agent = { reasoning_effort: { authorization: 'obviously-fake-nested-value' } };
  f.supervisor.documents['hermes-config']!.providers = { 'demo-private-name': { base_url: 'https://example.com/fake-private-path' } };
  const response = await f.app.inject({ url: '/api/settings/sections/agents', headers: apiHeaders('fake') });
  expect(response.body).not.toContain('obviously-fake-nested-value');
  expect(response.body).not.toContain('demo-private-name');
  expect(response.body).not.toContain('fake-private-path');
  expect(response.body).toContain('sha256');
});

it('persists metadata without values, publishes only verified changes, and restores an absent key after reopening', async () => {
  const f = await fixture({ local: true });
  const before = structuredClone(f.supervisor.documents['paseo-config']);
  const response = (await f.write('paseo.routing-note', { text: 'obviously-fake-sensitive-text' })).json();
  const rows = f.rows().filter(row => row.type === 'settings-change');
  expect(rows).toHaveLength(1);
  expect(rows[0].data).toMatchObject({ keys: ['daemon.appendSystemPrompt'], level: 'pc-only', timing: ['next-chat'], result: 'ok',
    backupId: expect.any(String), backupSha256: expect.stringMatching(/^[a-f0-9]{64}$/), device: { kind: 'desktop' } });
  expect(JSON.stringify(f.rows())).not.toContain('obviously-fake-sensitive-text');
  expect(f.events).toEqual([{ type: 'settings_changed', sections: ['overview', 'agents', 'checks'], change: response.change.id }]);
  await f.app.close();
  const config = f.config;
  const app = await buildApp({ config, hub: new EventHub(), sources: { hermes: new FakeHermes(), paseo: new FakePaseo() },
    verifier: async () => ({ email: 'you@example.com', exp: 2_000_000_000 }), supervisor: f.supervisor, logger: false });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'localPort', { configurable: true, value: 19014 }); });
  apps.push(app);
  const undone = await app.inject({ method: 'POST', url: '/api/settings/undo', headers: postHeaders('fake'), payload: { change: response.change.id } });
  expect(undone.json()).toMatchObject({ status: 'applied', change: { timing: [{ label: 'next-chat' }] } });
  expect(f.supervisor.documents['paseo-config']).toEqual(before);
  expect(f.rows().filter(row => row.type === 'settings-change').map(row => row.data.action)).toEqual(['apply', 'undo']);
  const changes = (await app.inject({ url: '/api/settings/changes', headers: apiHeaders('fake') })).json().changes;
  changes.forEach((change: unknown) => expect(recentChangeSchema.safeParse(change).success).toBe(true));
  expect(changes.find((change: { id: string }) => change.id === response.change.id).undoable).toBe(false);
});

it.each(['hermes.approval-mode', 'hermes.revoke-always'])('undoing %s requires the higher restoration level', async operation => {
  const f = await fixture();
  const params = operation === 'hermes.approval-mode' ? { mode: 'manual' } : { entrySha256: 'a'.repeat(64) };
  const response = (await f.write(operation, params, {}, true)).json();
  expect((await f.undo(response.change.id, undefined, true)).json()).toEqual({ status: 'refused', code: 'pc_only' });
  expect(f.supervisor.configUndo).not.toHaveBeenCalled();
});

it('requires Confirm for a phone undo and refuses drift or backup tampering', async () => {
  const f = await fixture();
  const params = { maxConcurrentChildren: 2, maxIterations: 10 };
  const applied = (await f.write('hermes.delegation-limits', params)).json();
  const challenge = (await f.undo(applied.change.id, undefined, true)).json();
  expect(challenge.status).toBe('confirm');
  expect((await f.undo(applied.change.id, challenge.confirm, true)).json().status).toBe('applied');
  const second = (await f.write('hermes.delegation-limits', params)).json();
  f.supervisor.documents['hermes-config']!.unrelated = true;
  expect((await f.undo(second.change.id)).json()).toEqual({ status: 'refused', code: 'undo_changed' });
  delete f.supervisor.documents['hermes-config']!.unrelated;
  const token = f.rows().filter(row => row.type === 'settings-change' && row.data.id === second.change.id)[0].data;
  f.supervisor.backups.set(token.backupId, {});
  expect((await f.undo(second.change.id)).json()).toEqual({ status: 'refused', code: 'backup_mismatch' });
});

it.each(['hash', 'tail', 'replacement'] as const)('refuses all writes after live audit %s damage', async damage => {
  const f = await fixture();
  const applied = (await f.write('hermes.reasoning-effort', { effort: 'high' })).json();
  const path = join(f.config.stateDir, 'settings-audit.jsonl');
  if (damage === 'hash') writeFileSync(path, readFileSync(path, 'utf8').replace('"result":"ok"', '"result":"failed"'));
  else if (damage === 'tail') appendFileSync(path, '{');
  else { rmSync(path); writeFileSync(path, ''); }
  expect((await f.write('hermes.reasoning-effort', { effort: 'low' })).json()).toEqual({ status: 'refused', code: 'audit_unavailable' });
  expect((await f.undo(applied.change.id)).json()).toEqual({ status: 'refused', code: 'audit_unavailable' });
  expect(f.supervisor.configApply).toHaveBeenCalledOnce();
  expect(f.supervisor.configUndo).not.toHaveBeenCalled();
});

it('refuses a broken audit at startup and leaves chat reads available', async () => {
  const f = await fixture();
  writeFileSync(join(f.config.stateDir, 'settings-audit.jsonl'), '{"bad":"row"}\n');
  expect((await f.write('hermes.reasoning-effort', { effort: 'high' })).json()).toEqual({ status: 'refused', code: 'audit_unavailable' });
  expect(f.supervisor.configApply).not.toHaveBeenCalled();
  expect((await f.app.inject({ url: '/api/me', headers: apiHeaders('fake') })).statusCode).toBe(200);
});

it('refuses writes after reopening an audit with an unfinished write', async () => {
  const f = await fixture();
  const audit = new SettingsAudit(f.config.stateDir);
  audit.start({ id: `ch_${'a'.repeat(24)}`, at: 0, action: 'apply', operation: 'hermes.reasoning-effort', target: 'hermes-config',
    keys: ['agent.reasoning_effort'], level: 'anywhere', timing: ['next-turn'], result: 'failed' }, [{ label: 'next-turn' }]);
  audit.close();
  expect((await f.write('hermes.reasoning-effort', { effort: 'high' })).json()).toMatchObject({ status: 'refused', code: 'outcome_unknown' });
  expect(f.supervisor.configApply).not.toHaveBeenCalled();
});

it('shows the last 30 file changes even after credential activity', async () => {
  const f = await fixture();
  const audit = new SettingsAudit(f.config.stateDir);
  for (let index = 0; index < 33; index++) {
    const credential = index >= 31;
    audit.record({ id: `ch_${index.toString(16).padStart(24, '0')}`, at: index, action: credential ? 'credential' : 'apply',
      operation: credential ? 'gateway.credential' : 'hermes.reasoning-effort', target: credential ? 'gateway-credentials' : 'hermes-config',
      keys: [], level: credential ? 'pc-only' : 'anywhere', timing: ['now'], result: 'ok' }, [{ label: 'now' }]);
  }
  audit.close();
  const changes = (await f.app.inject({ url: '/api/settings/changes', headers: apiHeaders('fake') })).json().changes;
  expect(changes).toHaveLength(30);
  expect(changes[0].at).toBe(30);
  expect(changes[29].at).toBe(1);
  expect(changes.every((change: { action: string }) => change.action === 'apply')).toBe(true);
});

it('reports the catalogue timing on every surface', async () => {
  const f = await fixture();
  const response = (await f.write('hermes.personality', { personality: 'friendly' })).json();
  expect(response.change.timing).toEqual([{ surface: 'messaging', label: 'next-turn' }, { surface: 'api', label: 'not-used' },
    { surface: 'app-chats', label: 'next-chat' }, { surface: 'jobs', label: 'not-used' }]);
});

it.each(SETTINGS_ERROR_CODES)('returns and audits the fixed upstream code %s', async code => {
  const f = await fixture();
  f.supervisor.configApply.mockResolvedValueOnce({ ok: false, code });
  expect((await f.write('hermes.reasoning-effort', { effort: 'high' })).json()).toEqual({ status: 'refused', code,
    ...(code === 'outcome_unknown' ? { backupId: null } : {}) });
  expect(f.rows().filter(row => row.type === 'settings-change')[0].data.result).toBe(code);
  expect(f.events).toEqual(code === 'outcome_unknown' ? [expect.objectContaining({ type: 'settings_changed' })] : []);
});

it.each(['throw', 'shape', 'token'] as const)('never exposes untrusted upstream %s text', async failure => {
  const logs: string[] = [];
  const f = await fixture({ logs });
  if (failure === 'throw') f.supervisor.configApply.mockRejectedValueOnce(new Error('obviously-fake-private-error'));
  if (failure === 'shape') f.supervisor.configApply.mockResolvedValueOnce({ ok: false, code: 'bad', text: 'obviously-fake-private-error' } as never);
  if (failure === 'token') {
    const apply = f.supervisor.configApply.getMockImplementation()!;
    f.supervisor.configApply.mockImplementationOnce(async request => {
      const result = await apply(request);
      if (result.ok && 'undo' in result) result.undo.operation = 'wayroost.notifications';
      return result;
    });
  }
  const response = await f.write('hermes.reasoning-effort', { effort: 'high' });
  expect(response.json()).toMatchObject({ status: 'refused', code: 'outcome_unknown' });
  expect(response.body + JSON.stringify(f.rows()) + logs.join('')).not.toContain('obviously-fake-private-error');
  expect(f.events).toEqual([expect.objectContaining({ type: 'settings_changed' })]);
});

it('verifies the written hash before publishing, even if the supervisor reports success', async () => {
  const f = await fixture();
  const apply = f.supervisor.configApply.getMockImplementation()!;
  f.supervisor.configApply.mockImplementationOnce(async request => {
    const result = await apply(request);
    f.supervisor.documents['hermes-config']!.unrelated = 'demo-racing-writer';
    return result;
  });
  expect((await f.write('hermes.reasoning-effort', { effort: 'high' })).json()).toMatchObject({
    status: 'refused', code: 'verify_mismatch', change: { undoable: true },
  });
  expect(f.events).toEqual([expect.objectContaining({ type: 'settings_changed' })]);
});

it('refuses a write before dispatch if the audit cannot append', async () => {
  const f = await fixture();
  vi.spyOn(EventJournal.prototype, 'append').mockImplementation(() => { throw new Error('obviously-fake-audit-error'); });
  expect((await f.write('hermes.reasoning-effort', { effort: 'high' })).json()).toEqual({ status: 'refused', code: 'audit_unavailable' });
  expect(f.supervisor.configApply).not.toHaveBeenCalled();
});

it('reports a committed change when the final audit append fails and stops later writes', async () => {
  const f = await fixture();
  const append = EventJournal.prototype.append;
  vi.spyOn(EventJournal.prototype, 'append').mockImplementation(function (this: EventJournal, input) {
    if (input.type === 'settings-change') throw new Error('obviously-fake-audit-error');
    return append.call(this, input);
  });
  expect((await f.write('hermes.reasoning-effort', { effort: 'high' })).json()).toMatchObject({ status: 'refused', code: 'audit_unavailable', change: { undoable: false } });
  expect((await f.write('hermes.reasoning-effort', { effort: 'low' })).json()).toEqual({ status: 'refused', code: 'audit_unavailable' });
  expect(f.supervisor.configApply).toHaveBeenCalledOnce();
  expect(f.events).toEqual([expect.objectContaining({ type: 'settings_changed' })]);
});

it.each((['apply', 'undo'] as const).flatMap(action => (['settings-change'] as const)
  .flatMap(event => [false, true].map(backup => ({ action, event, backup })))))(
  'preserves an unknown $action outcome when $event fails with backup=$backup', async ({ action, event, backup }) => {
  const f = await fixture({ local: true, consumers: true });
  const first = action === 'undo' ? (await f.write('wayroost.safety-commands', { enabled: false })).json() : undefined;
  f.events.length = 0;
  const method = action === 'apply' ? f.supervisor.configApply : f.supervisor.configUndo;
  const original = method.getMockImplementation()!;
  method.mockImplementationOnce(async (request: ConfigApplyRequest | ConfigUndoRequest) => {
    const result = await original(request as ConfigApplyRequest & ConfigUndoRequest);
    if (backup && result.ok && 'undo' in result) return { ok: false, code: 'outcome_unknown', committed: true, undo: result.undo };
    throw new Error('demo-lost-reply');
  });
  const append = EventJournal.prototype.append;
  vi.spyOn(EventJournal.prototype, 'append').mockImplementation(function (this: EventJournal, input) {
    if (input.type === event) throw new Error('obviously-fake-audit-error');
    return append.call(this, input);
  });
  const response = action === 'apply' ? await f.write('wayroost.safety-commands', { enabled: false }) : await f.undo(first.change.id);
  const backupId = backup ? action === 'apply' ? 'backup-0' : 'backup-1' : null;
  expect(response.json()).toEqual({ status: 'refused', code: 'outcome_unknown', backupId });
  expect(f.safetyCommands.enabled()).toBe(false);
  expect((await f.write('wayroost.notifications', { push: { approvals: false, cards: false }, quietHours: null })).json())
    .toEqual({ status: 'refused', code: 'audit_unavailable' });
  expect(f.supervisor.configApply).toHaveBeenCalledOnce();
  expect(f.supervisor.configUndo).toHaveBeenCalledTimes(action === 'undo' ? 1 : 0);
  expect(f.events).toEqual([expect.objectContaining({ type: 'settings_changed' })]);
});

it.each((['apply', 'undo'] as const).flatMap(action => [false, true].map(backup => ({ action, backup }))))(
  'preserves an unknown $action outcome and audits it after a contradictory observation with backup=$backup', async ({ action, backup }) => {
  const f = await fixture();
  const first = action === 'undo' ? (await f.write('hermes.reasoning-effort', { effort: 'high' })).json() : undefined;
  f.events.length = 0;
  const method = action === 'apply' ? f.supervisor.configApply : f.supervisor.configUndo;
  const original = method.getMockImplementation()!;
  method.mockImplementationOnce(async (request: ConfigApplyRequest | ConfigUndoRequest) => {
    const result = await original(request as ConfigApplyRequest & ConfigUndoRequest);
    f.supervisor.configRead.mockImplementationOnce(async ({ view }) => {
      const observed = { ok: true as const, view, present: true, sha256: f.supervisor.sha('hermes-config'), values: [
        { path: ['agent'], exists: true as const, value: 'obviously-fake-observation-value' },
        { path: ['agent', 'reasoning_effort'], exists: true as const, value: 'medium' },
      ] };
      expect(configReadResultSchema.safeParse(observed).success).toBe(true);
      return observed as never;
    });
    if (backup && result.ok && 'undo' in result) return { ok: false, code: 'outcome_unknown', committed: true, undo: result.undo };
    return { ok: false, code: 'outcome_unknown' };
  });
  const response = action === 'apply' ? await f.write('hermes.reasoning-effort', { effort: 'high' }) : await f.undo(first.change.id);
  const backupId = backup ? action === 'apply' ? 'backup-0' : 'backup-1' : null;
  expect(response.json()).toEqual({ status: 'refused', code: 'outcome_unknown', backupId });
  const final = f.rows().filter(row => row.type === 'settings-change').at(-1).data;
  expect(final).toMatchObject({ action, result: 'outcome_unknown', ...(backup ? { backupId, backupSha256: expect.any(String) } : {}),
    ...(action === 'undo' ? { undoOf: first.change.id } : {}) });
  expect(response.body + JSON.stringify(f.rows())).not.toContain('obviously-fake-observation-value');
  expect(f.events).toEqual([expect.objectContaining({ type: 'settings_changed' })]);
  const blocked = true;
  expect((await f.write('hermes.personality', { personality: 'friendly' })).json()).toMatchObject(blocked
    ? { status: 'refused', code: 'outcome_unknown' } : { status: 'applied' });
  expect(f.supervisor.configApply).toHaveBeenCalledTimes(blocked ? 1 : 2);
  expect(f.supervisor.configUndo).toHaveBeenCalledTimes(action === 'undo' ? 1 : 0);
});

it.each((['credential-set', 'credential-remove', 'credential-test', 'restart-refusal', 'restart-run'] as const)
  .flatMap(operation => [false, true].map(auditFailure => ({ operation, auditFailure }))))(
  'handles a structured uncertain $operation result with auditFailure=$auditFailure', async ({ operation, auditFailure }) => {
  const logs: string[] = [];
  const f = await fixture({ local: true, logs });
  const unknown = { ok: false as const, code: 'outcome_unknown' as const };
  const credentialWrite = vi.fn(async () => unknown);
  const credentialTest = vi.fn(async () => unknown);
  const drainRestart = vi.fn(async (request: DrainRestartRequest) => operation === 'restart-run'
    ? { ok: true as const, run: { id: request.requestId, component: 'hermes' as const,
      when: 'idle' as const, state: 'waiting' as const, startedAt: 0, attempts: 0, busy: [], code: 'outcome_unknown' as const } }
    : unknown);
  Object.assign(f.supervisor, { credentialWrite, credentialTest, drainRestart });
  if (auditFailure) {
    const append = EventJournal.prototype.append;
    vi.spyOn(EventJournal.prototype, 'append').mockImplementation(function (this: EventJournal, input) {
      if (input.type === 'settings-change') throw new Error('obviously-fake-audit-error');
      return append.call(this, input);
    });
  }
  const restart = operation.startsWith('restart-');
  const response = await f.app.inject({ method: restart || operation === 'credential-test' ? 'POST'
    : operation === 'credential-remove' ? 'DELETE' : 'PUT',
    url: restart ? '/api/settings/restart' : `/api/settings/credentials/demo${operation === 'credential-test' ? '/test' : ''}`,
    headers: postHeaders('fake'), payload: restart ? { component: 'hermes', when: 'idle' }
      : operation === 'credential-test' ? { backend: 'demo-backend' }
      : operation === 'credential-set' ? { secret: 'obviously-fake-credential' } : {} });
  expect(response.json()).toEqual(operation === 'credential-test'
    ? { status: 'refused', code: 'unavailable', test: { ok: false, code: 'unavailable' } }
    : { status: 'refused', code: 'outcome_unknown', backupId: null });
  expect(settingsCredentialResponseSchema.safeParse(response.json()).success).toBe(true);
  const final = f.rows().filter(row => row.type === 'settings-change');
  if (auditFailure || operation === 'credential-test') expect(final).toEqual([]);
  else expect(final.at(-1).data).toMatchObject({ action: restart ? 'restart' : 'credential', result: 'outcome_unknown' });
  expect(f.events).toEqual(operation === 'credential-test' ? [] : [expect.objectContaining({ type: 'settings_changed' })]);
  expect(response.body + JSON.stringify(f.rows()) + logs.join('')).not.toContain('obviously-fake-credential');
  if (operation === 'credential-test') vi.restoreAllMocks();
  const later = (await f.write('hermes.reasoning-effort', { effort: 'high' })).json();
  if (auditFailure && operation !== 'credential-test') expect(later).toEqual({ status: 'refused', code: 'audit_unavailable' });
  else expect(later.status).toBe('applied');
  expect(f.supervisor.configApply).toHaveBeenCalledTimes(auditFailure && operation !== 'credential-test' ? 0 : 1);
  expect(credentialWrite).toHaveBeenCalledTimes(!restart && operation !== 'credential-test' ? 1 : 0);
  expect(credentialTest).toHaveBeenCalledTimes(operation === 'credential-test' ? 1 : 0);
  expect(drainRestart).toHaveBeenCalledTimes(restart ? 1 : 0);
});

it('uses next-chat for an app chat when only the model address changes', async () => {
  const f = await fixture();
  const response = (await f.write('hermes.default-model', { provider: 'demo', model: 'demo-model', baseUrl: 'http://127.0.0.1:18011' })).json();
  expect(response.change.timing.filter((note: { surface: string }) => note.surface === 'app-chats'))
    .toEqual([{ surface: 'app-chats', label: 'next-chat', keys: ['model.base_url'], when: 'base-url-only' }]);
});

it('keeps unchanged writes out of events and undo', async () => {
  const f = await fixture();
  const apply = f.supervisor.configApply.getMockImplementation()!;
  f.supervisor.configApply.mockImplementationOnce(async request => ({ ...await apply(request), unchanged: true } as never));
  const response = (await f.write('hermes.reasoning-effort', { effort: 'medium' })).json();
  expect(response.change.undoable).toBe(false);
  expect(f.events).toEqual([]);
  expect((await f.undo(response.change.id)).json()).toEqual({ status: 'refused', code: 'undo_changed' });
});

it('does not write after a device is revoked during the precondition read', async () => {
  const f = await fixture();
  const read = f.supervisor.configRead.getMockImplementation()!;
  f.supervisor.configRead.mockImplementationOnce(async request => {
    const result = await read(request);
    f.devices.revoke((await f.app.inject({ url: '/api/me', headers: apiHeaders('fake') })).json().device.id);
    return result;
  });
  expect((await f.write('hermes.reasoning-effort', { effort: 'high' })).json()).toEqual({ status: 'refused', code: 'not_permitted' });
  expect(f.supervisor.configApply).not.toHaveBeenCalled();
});

it.each([
  { local: false, gate: true, code: 'pc_only' }, { local: true, gate: false, code: 'pc_only_read_only' },
  { local: true, gate: true, code: undefined },
])('keeps every credential operation on the gated local desktop listener: %j', async options => {
  const logs: string[] = [];
  const f = await fixture({ ...options, logs });
  const credentialWrite = vi.fn(async () => ({ ok: true as const, provider: 'demo', timing: 'restart-when-idle:gateway' as const }));
  const credentialTest = vi.fn(async () => ({ ok: true as const, provider: 'demo', backend: 'demo-backend' }));
  Object.assign(f.supervisor, { credentialWrite, credentialTest });
  for (const [method, url, payload] of [
    ['PUT', '/api/settings/credentials/demo', { secret: 'obviously-fake-credential' }],
    ['DELETE', '/api/settings/credentials/demo', {}], ['POST', '/api/settings/credentials/demo/test', { backend: 'demo-backend' }],
  ] as const) {
    const response = await f.app.inject({ method, url, headers: postHeaders('fake'), ...(payload ? { payload } : {}) });
    expect(response.json()).toMatchObject(options.code ? { status: 'refused', code: options.code } : { status: 'applied' });
    expect(response.body).not.toContain('obviously-fake-credential');
  }
  expect(credentialWrite).toHaveBeenCalledTimes(options.code ? 0 : 2);
  expect(credentialTest).toHaveBeenCalledTimes(options.code ? 0 : 1);
  expect(JSON.stringify(f.rows()) + logs.join('')).not.toContain('obviously-fake-credential');
});

it('sends a confirmed phone restart through the supervisor verb', async () => {
  const f = await fixture();
  const drainRestart = vi.fn(async (request: DrainRestartRequest) => ({ ok: true as const, run: { id: request.requestId,
    component: 'hermes' as const, when: 'now' as const, state: 'waiting' as const, startedAt: 0, attempts: 0, busy: [] } }));
  Object.assign(f.supervisor, { drainRestart });
  const request = (confirm?: string) => f.app.inject({ method: 'POST', url: '/api/settings/restart', headers: postHeaders('fake', { cookie: PHONE_COOKIE }),
    payload: { component: 'hermes', when: 'now', ...(confirm ? { confirm } : {}) } });
  const challenge = (await request()).json();
  expect(challenge.status).toBe('confirm');
  expect(drainRestart).not.toHaveBeenCalled();
  expect((await request(challenge.confirm)).json()).toMatchObject({ status: 'accepted', timing: [{ label: 'restart-now:hermes' }] });
  expect(drainRestart).toHaveBeenCalledWith(expect.objectContaining({ component: 'hermes', when: 'now', protocol: 1, origin: { change: expect.any(String),
    device: { id: expect.any(String), kind: 'phone' }, level: 'confirm' } }));
});

it('preserves undo after a committed verification failure without emitting success', async () => {
  const f = await fixture();
  const apply = f.supervisor.configApply.getMockImplementation()!;
  f.supervisor.configApply.mockImplementationOnce(async request => {
    const result = await apply(request);
    if (!result.ok || !('undo' in result)) throw new Error('Missing test token');
    return { ok: false, code: 'verify_mismatch', committed: true, undo: result.undo };
  });
  const response = (await f.write('hermes.reasoning-effort', { effort: 'high' })).json();
  expect(response).toMatchObject({ status: 'refused', code: 'verify_mismatch', change: { undoable: true, effective: 'mismatch' } });
  expect(f.events).toEqual([expect.objectContaining({ type: 'settings_changed' })]);
  expect((await f.undo(response.change.id)).json().status).toBe('applied');
});

it('refuses malformed or internal operations and stale preconditions', async () => {
  const f = await fixture();
  expect((await f.write('demo.unknown', {})).json()).toEqual({ status: 'refused', code: 'unknown_operation' });
  expect((await f.write('gateway.record-override', { role: 'main', backend: 'demo' })).json()).toEqual({ status: 'refused', code: 'not_permitted' });
  expect((await f.write('hermes.reasoning-effort', { effort: 'high', path: '/home/me/demo' })).json()).toEqual({ status: 'refused', code: 'invalid_parameters' });
  expect((await f.write('hermes.reasoning-effort', { effort: 'high' }, { expected: { file: { sha256: 'a'.repeat(64) } } })).json()).toEqual({ status: 'refused', code: 'precondition_changed' });
  expect((await f.write('hermes.reasoning-effort', { effort: 'high' }, { expected: { keys: [{ key: 0, value: 'low' }] } })).json()).toEqual({ status: 'refused', code: 'precondition_changed' });
  expect(f.supervisor.configApply).not.toHaveBeenCalled();
});

it('routes migrated settings switches through the supervisor without invoking owner helpers', async () => {
  const f = await fixture({ local: true });
  for (const [url, body] of [['/api/cloud-agents/codex', { enabled: false }],
    ['/api/safety-commands', { enabled: true }]] as const) {
    const response = await f.app.inject({ method: 'PUT', url, headers: postHeaders('fake'), payload: body });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBeUndefined();
  }
  expect(f.supervisor.configApply.mock.calls.map(([request]) => request.operation)).toEqual([
    'paseo.provider-enabled', 'wayroost.safety-commands',
  ]);
});

it('refuses missing config verbs and device scopes', async () => {
  const f = await fixture({ supervisor: false });
  expect((await f.write('hermes.reasoning-effort', { effort: 'high' })).json()).toEqual({ status: 'refused', code: 'config_writes_off' });
  const authenticate = f.devices.authenticate.bind(f.devices);
  vi.spyOn(f.devices, 'authenticate').mockImplementation(cookies => { const signedIn = authenticate(cookies);
    return signedIn ? { ...signedIn, device: { ...signedIn.device, scopes: [] } } : null; });
  const response = await f.write('hermes.reasoning-effort', { effort: 'high' });
  expect(response.json()).toEqual({ status: 'refused', code: 'not_permitted' });
});

it('does not promote a main-listener request using local Host and Origin headers', async () => {
  const f = await fixture();
  const response = await f.app.inject({ method: 'POST', url: '/api/settings/apply', headers: postHeaders('fake', {
    host: '127.0.0.1:19014', origin: 'https://127.0.0.1:19014', 'x-wayroost-app': 'desktop',
  }), payload: { operation: 'paseo.routing-note', params: { text: 'Demo note' } } });
  expect(response.json()).toEqual({ status: 'refused', code: 'pc_only' });
  expect(f.supervisor.configApply).not.toHaveBeenCalled();
});

it('refuses settings routes missing from the shared policy', async () => {
  const f = await fixture();
  expect((await f.app.inject({ method: 'POST', url: '/api/settings/unknown', headers: postHeaders('fake'), payload: {} })).json())
    .toEqual({ status: 'refused', code: 'not_permitted' });
});


it('keeps the settings audit and event journal locks independent', async () => {
  const f = await fixture();
  const journal = new EventJournal(f.config.stateDir);
  try {
    journal.append({ type: 'demo-event', data: {} });
    expect((await f.write('hermes.reasoning-effort', { effort: 'high' })).json().status).toBe('applied');
    expect(journal.load().map(event => event.type)).toEqual(['demo-event']);
    expect(f.rows().some(row => row.type === 'settings-change')).toBe(true);
    expect(() => new EventJournal(f.config.stateDir, Date.now, '../other.jsonl')).toThrow('invalid journal filename');
  } finally { journal.close(); }
});


it('never transfers a revoked desktop write to a phone request', async () => {
  const f = await fixture({ local: true });
  f.supervisor.configApply.mockRejectedValueOnce(new Error('demo-lost-reply'));
  const lost = await f.app.inject({ method: 'POST', url: '/api/settings/apply', headers: postHeaders('fake'),
    payload: { operation: 'hermes.approval-mode', params: { mode: 'off' } } });
  expect(lost.json().status).toBe('refused');
  expect(f.devices.revoke(TEST_DESKTOP.id)).toBe(true);
  expect((await f.write('hermes.reasoning-effort', { effort: 'high' }, {}, true)).json()).toMatchObject({ status: 'refused', code: 'outcome_unknown' });
  expect(f.supervisor.documents['hermes-config']!.approvals).toEqual({ mode: 'smart' });
  expect(f.supervisor.configApply.mock.calls.map(([request]) => request.operation)).toEqual(['hermes.approval-mode']);
});

it('returns the supplied backup id when a post-write read is unavailable', async () => {
  const f = await fixture();
  const apply = f.supervisor.configApply.getMockImplementation()!;
  f.supervisor.configApply.mockImplementationOnce(async request => {
    const result = await apply(request);
    f.supervisor.configRead.mockRejectedValueOnce(new Error('demo-unavailable'));
    return result;
  });
  const response = await f.write('hermes.reasoning-effort', { effort: 'high' });
  expect(response.json()).toEqual({ status: 'refused', code: 'outcome_unknown', backupId: 'backup-0' });
  expect(f.rows().filter(row => row.type === 'settings-change').at(-1).data)
    .toMatchObject({ result: 'outcome_unknown', backupId: 'backup-0', backupSha256: expect.any(String) });
  expect(f.supervisor.configApply).toHaveBeenCalledOnce();
  expect(f.events).toEqual([expect.objectContaining({ type: 'settings_changed' })]);
});

it.each((['apply', 'undo'] as const).flatMap(action => [false, true].map(auditFailure => ({ action, auditFailure }))))(
  'retains the backup and audits a successful $action after contradictory verification with auditFailure=$auditFailure', async ({ action, auditFailure }) => {
  const logs: string[] = [];
  const f = await fixture({ logs });
  const first = action === 'undo' ? (await f.write('hermes.reasoning-effort', { effort: 'high' })).json() : undefined;
  f.events.length = 0;
  const method = action === 'apply' ? f.supervisor.configApply : f.supervisor.configUndo;
  const original = method.getMockImplementation()!;
  method.mockImplementationOnce(async (request: ConfigApplyRequest | ConfigUndoRequest) => {
    const result = await original(request as ConfigApplyRequest & ConfigUndoRequest);
    f.supervisor.configRead.mockImplementationOnce(async ({ view }) => {
      const observed = { ok: true as const, view, present: true, sha256: f.supervisor.sha('hermes-config'), values: [
        { path: ['agent'], exists: true as const, value: 'obviously-fake-verification-value' },
        { path: ['agent', 'reasoning_effort'], exists: true as const, value: 'medium' },
      ] };
      expect(configReadResultSchema.safeParse(observed).success).toBe(true);
      return observed as never;
    });
    return result;
  });
  if (auditFailure) {
    const append = EventJournal.prototype.append;
    vi.spyOn(EventJournal.prototype, 'append').mockImplementation(function (this: EventJournal, input) {
      if (input.type === 'settings-change') throw new Error('obviously-fake-audit-error');
      return append.call(this, input);
    });
  }
  const response = action === 'apply' ? await f.write('hermes.reasoning-effort', { effort: 'high' }) : await f.undo(first.change.id);
  const backupId = action === 'apply' ? 'backup-0' : 'backup-1';
  expect(response.json()).toEqual({ status: 'refused', code: 'outcome_unknown', backupId });
  expect(settingsApplyResponseSchema.safeParse(response.json()).success).toBe(true);
  const rows = f.rows();
  const started = rows.filter(row => row.type === 'settings-write-start').at(-1).data;
  if (action === 'undo') expect(started.undoOf).toBe(first.change.id);
  const final = rows.find(row => row.type === 'settings-change' && row.data.id === started.id);
  if (auditFailure) expect(final).toBeUndefined();
  else expect(final.data).toMatchObject({ action, result: 'outcome_unknown', backupId,
    backupSha256: expect.any(String), writtenSha256: f.supervisor.sha('hermes-config'),
    ...(action === 'undo' ? { undoOf: first.change.id } : {}) });
  expect(response.body + JSON.stringify(rows) + logs.join('')).not.toContain('obviously-fake-verification-value');
  expect(f.events).toEqual([expect.objectContaining({ type: 'settings_changed' })]);
  await f.app.close();
  const app = await buildApp({ config: f.config, hub: new EventHub(), devices: f.devices, supervisor: f.supervisor,
    sources: { hermes: new FakeHermes(), paseo: new FakePaseo() }, logger: false,
    verifier: async () => ({ email: 'you@example.com', exp: 2_000_000_000 }) });
  apps.push(app);
  const changes = (await app.inject({ url: '/api/settings/changes', headers: apiHeaders('fake') })).json();
  if (auditFailure) expect(changes.changes).toHaveLength(action === 'apply' ? 0 : 1);
  else expect(changes.changes[0]).toMatchObject({ id: started.id, result: 'outcome_unknown', undoable: true });
  if (action === 'undo') {
    if (!auditFailure) expect(changes.changes.find((change: { id: string }) => change.id === first.change.id).undoable).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/settings/undo', headers: postHeaders('fake'),
      payload: { change: first.change.id } })).json()).toEqual({ status: 'refused', code: 'undo_changed' });
  }
  const later = (await app.inject({ method: 'POST', url: '/api/settings/apply', headers: postHeaders('fake'),
    payload: { operation: 'hermes.personality', params: { personality: 'friendly' } } })).json();
  expect(later).toMatchObject({ status: 'refused', code: 'outcome_unknown' });
  expect(f.supervisor.configApply).toHaveBeenCalledOnce();
  expect(f.supervisor.configUndo).toHaveBeenCalledTimes(action === 'undo' ? 1 : 0);
});

it('never replays an uncertain restart during a later settings request', async () => {
  const f = await fixture({ local: true });
  const drainRestart = vi.fn(async () => { throw new Error('demo-lost-reply'); });
  Object.assign(f.supervisor, { drainRestart });
  expect((await f.app.inject({ method: 'POST', url: '/api/settings/restart', headers: postHeaders('fake'),
    payload: { component: 'hermes', when: 'idle' } })).json())
    .toEqual({ status: 'refused', code: 'outcome_unknown', backupId: null });
  expect((await f.write('hermes.reasoning-effort', { effort: 'high' }, {}, true)).json().status).toBe('applied');
  expect(drainRestart).toHaveBeenCalledOnce();
});


it.each(['apply', 'undo'] as const)('keeps recovery and completes the audit when %s intent confirmation cannot persist', async action => {
  const checks = new Checks({});
  const f = await fixture({ checks });
  const first = action === 'undo' ? (await f.write('hermes.reasoning-effort', { effort: 'high' })).json() : undefined;
  vi.spyOn(checks, action === 'apply' ? 'confirmIntent' : 'confirmUndo').mockRejectedValueOnce(Object.assign(new Error('unavailable'), { code: 'ENOSPC' }));
  const response = action === 'apply' ? await f.write('hermes.reasoning-effort', { effort: 'high' }) : await f.undo(first.change.id);
  expect(response.json()).toEqual({ status: 'refused', code: 'outcome_unknown', backupId: action === 'apply' ? 'backup-0' : 'backup-1' });
  expect(f.supervisor.documents['hermes-config']!.agent).toEqual({ reasoning_effort: action === 'apply' ? 'high' : 'medium' });
  const final = f.rows().filter(row => row.type === 'settings-change').at(-1).data;
  expect(final).toMatchObject({ action, result: 'outcome_unknown', backupId: response.json().backupId,
    backupSha256: expect.any(String), writtenSha256: expect.any(String) });
  expect(f.rows().filter(row => row.type === 'settings-write-observed')).toEqual([]);
  await f.app.close();
  const app = await buildApp({ config: f.config, hub: new EventHub(), devices: f.devices, supervisor: f.supervisor,
    sources: { hermes: new FakeHermes(), paseo: new FakePaseo() }, logger: false, settings: { checks: new Checks({}) },
    verifier: async () => ({ email: 'you@example.com', exp: 2_000_000_000 }) });
  apps.push(app);
  const overview = (await app.inject({ url: '/api/settings/sections/overview', headers: apiHeaders('fake') })).json();
  expect(overview.changes.find((change: { id: string }) => change.id === final.id)).toMatchObject({ undoable: true, result: 'outcome_unknown' });
  const undone = await app.inject({ method: 'POST', url: '/api/settings/undo', headers: postHeaders('fake'), payload: { change: final.id } });
  expect(undone.json()).toMatchObject({ status: 'refused', code: 'outcome_unknown' });
  expect(f.supervisor.configApply).toHaveBeenCalledTimes(1);
  expect(f.supervisor.configUndo).toHaveBeenCalledTimes(action === 'apply' ? 0 : 1);
});
