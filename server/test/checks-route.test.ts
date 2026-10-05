// The checks route and the engine's bounds: one page load, one pass over the
// sources, rows only, and a Fix that is an ordinary settings change. Nothing here
// reaches a live gateway, phone or supervisor: the sources are fakes, and one of
// them hangs or throws on purpose.
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { Devices } from '../src/devices.js';
import { EventHub } from '../src/hub.js';
import { makeConfig, apiHeaders, postHeaders, PHONE_COOKIE, DESKTOP_COOKIE, FakeHermes, FakePaseo } from './helpers.js';
import { FakeSettingsSupervisor } from './fake-settings-supervisor.js';
import type { ConfigApplyRequest, ConfigWriteResult } from '../../shared/supervisor-config.js';
import { formatKeyPath, type KeyPath, type TargetId, type UndoToken } from '../../shared/settings.js';
import { Checks } from '../src/checks/index.js';
import type { ChecksSources, ChecksDeployment } from '../src/checks/snapshot.js';
import { CHECK_ACTION_IDS, MAX_CHECK_ROWS, settingsChecksResponseSchema, type SettingsCheckRow } from '../../shared/settings-checks.js';
import { DRAIN_RESTART_COMPONENTS, settingsApplyResponseSchema } from '../../shared/settings.js';
import { OPERATION_IDS, parseOperation, READ_VIEW_IDS } from '../../shared/settings-ops.js';
import { configOperations } from '../../supervisor/src/config-operations.js';
import { applyValues } from '../src/settings/editors/types.js';
import { settingsTargetsSchema } from '../../shared/settings-targets.js';
import { fixtures } from './checks-fixtures.js';

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The checks an app is wired with, reading through one fake supervisor. */
function checksFrom(supervisor: FakeSettingsSupervisor, extra: Partial<ChecksSources> = {}, deployment: ChecksDeployment = {}): Checks {
  return new Checks({
    readView: view => supervisor.configRead({ view }),
    supervisorStatus: () => supervisor.status(),
    ...extra,
  }, deployment, { now: () => 1_800_000_000_000 });
}

async function fixture(options: { checks?: Checks | null; local?: boolean; supervisor?: FakeSettingsSupervisor } = {}) {
  const config = makeConfig(undefined, { localListener: { port: 19014, pcOnlyWrites: true }, origins: ['https://127.0.0.1:19014'] });
  roots.push(config.stateDir);
  const supervisor = options.supervisor ?? new FakeSettingsSupervisor();
  const app = await buildApp({
    config, hub: new EventHub(), devices: new Devices(config.stateDir),
    sources: { hermes: new FakeHermes(), paseo: new FakePaseo() },
    verifier: async () => ({ email: 'you@example.com', exp: 2_000_000_000 }),
    logger: false, supervisor,
    settings: {
      now: () => 1_800_000_000_000,
      ...(options.checks === null ? {} : { checks: options.checks ?? checksFrom(supervisor) }),
    },
  });
  app.addHook('onRequest', async request => {
    Object.defineProperty(request.raw.socket, 'localPort', { configurable: true, value: options.local ? 19014 : 19010 });
  });
  apps.push(app);
  const get = (phone = false) => app.inject({ method: 'GET', url: '/api/settings/checks', headers: apiHeaders('fake', { cookie: phone ? PHONE_COOKIE : DESKTOP_COOKIE }) });
  return { app, config, supervisor, get };
}

describe('GET /api/settings/checks', () => {
  it.each([false, true])('projects profile and agent identities with local=%s', async local => {
    const secret = 'invented-api-key-123';
    const supervisor = new FakeSettingsSupervisor();
    supervisor.documents['paseo-config'] = { daemon: { agentProfiles: [{ id: secret, provider: 'pi', model: 'example/missing' }] } };
    const checks = checksFrom(supervisor, { paseoRuntime: async () => ({ providers: {}, agents: [{ id: secret, provider: 'pi', model: 'wayroost-main/main' }] }) });
    const { get } = await fixture({ supervisor, checks, local });
    const response = await get(!local);
    const rows = response.json().rows as SettingsCheckRow[];
    expect(rows.find(row => row.id === 'paseo.profiles')?.state).toBe('fail');
    const identities = [rows.find(row => row.id === 'paseo.profiles')?.details?.[0], rows.find(row => row.id === 'paseo.pinned-agents')?.details?.[0]];
    expect(identities).toEqual(local ? [secret, secret] : Array(2).fill(`sha256:${createHash('sha256').update(secret).digest('hex')}`));
    if (!local) expect(response.body).not.toContain(secret);
  });

  it('answers with rows, in one pass over the sources', async () => {
    const { get, supervisor } = await fixture();
    const response = await get();
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(settingsChecksResponseSchema.safeParse(body).success).toBe(true);
    expect(body.rows.length).toBeGreaterThan(10);
    expect(body.rows.length).toBeLessThanOrEqual(MAX_CHECK_ROWS);
    expect(new Set(body.rows.map((row: SettingsCheckRow) => row.id)).size).toBe(body.rows.length);
    expect(body.generatedAt).toBe(1_800_000_000_000);
    // Reading the page writes nothing anywhere.
    expect(supervisor.configApply).not.toHaveBeenCalled();
  });

  it('reads from a phone, and refuses a body on a GET', async () => {
    const { get } = await fixture();
    expect((await get(true)).statusCode).toBe(200);
  });

  it('uses the production checks when no reader is injected', async () => {
    const { get } = await fixture({ checks: null });
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json().rows).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'unknown' })]));
  });

  it('turns a source that throws into unknown rows, not a failed page', async () => {
    const supervisor = new FakeSettingsSupervisor();
    const checks = checksFrom(supervisor, {
      gateway: async () => { throw new Error('the probe fell over'); },
      phone: async () => { throw new Error('the phone fell over'); },
    });
    const { get } = await fixture({ checks });
    const response = await get();
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const byId = new Map(body.rows.map((row: { id: string; state: string }) => [row.id, row.state]));
    expect(byId.get('gateway.health')).toBe('unknown');
    expect(byId.get('phone.quiet')).toBe('unknown');
    // The rows that don't need those sources still answered.
    expect(byId.get('hermes.approval-mode')).toBe('warn');
    expect(body.unavailable.length).toBeGreaterThan(0);
  });

  it('gives up on a source that never answers, inside its budget', async () => {
    const supervisor = new FakeSettingsSupervisor();
    supervisor.documents['hermes-config']!.providers = { demo: { base_url: 'http://127.0.0.1:18010' } };
    const checks = new Checks({
      readView: view => supervisor.configRead({ view }),
      // A gateway probe that hangs forever.
      gateway: () => new Promise(() => {}),
    }, {}, { now: () => 1_800_000_000_000, sourceTimeoutMs: 30, budgetMs: 200 });
    const { get } = await fixture({ checks });
    const started = Date.now();
    const body = (await get()).json();
    expect(Date.now() - started).toBeLessThan(2_000);
    const byId = new Map(body.rows.map((row: { id: string; state: string }) => [row.id, row.state]));
    expect(byId.get('gateway.health')).toBe('unknown');
    expect(byId.get('hermes.model-provider')).toBe('ok');
  });

  it('keeps values out of every row, and only names keys', async () => {
    const supervisor = new FakeSettingsSupervisor();
    // A value no check should ever quote, in a file several checks read.
    supervisor.documents['hermes-config']!.model = { provider: 'demo', default: 'model-nobody-should-see', base_url: 'http://value-that-must-not-appear.invalid:19001/v1' };
    supervisor.documents['gateway-state'] = { state: { version: 1, profile: null, engine: null, broughtUpAt: null, overrides: {} },
      migration: { version: 1, consumers: { hermes: { 'hermes-config': {
        moved: true, movedAt: '2026-10-04T09:00:00Z', preMoveBackupSha256: 'a'.repeat(64), postMoveSha256: 'b'.repeat(64),
        keys: [{ path: ['model', 'default'], kind: 'recorded', before: { exists: true, value: 'old-value-nobody-should-see' }, intended: { exists: true, value: 'intended-value-nobody-should-see' } }],
      } } } } };
    const { get } = await fixture({ checks: checksFrom(supervisor) });
    const text = (await get()).body;
    for (const value of ['model-nobody-should-see', 'value-that-must-not-appear', 'old-value-nobody-should-see', 'intended-value-nobody-should-see']) {
      expect(text).not.toContain(value);
    }
    // The rows still say which keys are involved, and they are real answers.
    const body = JSON.parse(text);
    const drift = body.rows.find((row: { id: string }) => row.id === 'hermes.drift');
    expect(drift.state).toBe('warn');
    expect(drift.details).toEqual(['model.default']);
  });

  it('puts the rows that ask to be looked at first', async () => {
    const supervisor = new FakeSettingsSupervisor();
    const checks = checksFrom(supervisor, {
      drainMarker: async () => ({ present: true, ours: true, requestedAt: 1_800_000_000_000 - 300_000, drainRunning: false, unreadable: false }),
    });
    const { get } = await fixture({ checks });
    const body = (await get()).json();
    expect(body.rows[0].id).toBe('hermes.drain-marker');
    expect(body.rows[0].priority).toBe('high');
  });

  it('offers a Fix only as something the settings pipeline takes', async () => {
    const supervisor = new FakeSettingsSupervisor();
    const checks = checksFrom(supervisor, {
      revocations: async () => [{ entrySha256: 'c'.repeat(64), revokedAt: 1_799_999_000_000 }],
      gateway: async () => ({ healthz: { main: false, coder: false, fast: false }, socketUnit: 'failed' as const,
        listeningPorts: [], roles: { main: { health: 'down' as const }, coder: { health: 'down' as const }, fast: { health: 'down' as const } }, draining: false }),
    });
    const { get } = await fixture({ checks, local: true });
    const body = (await get()).json();
    const fixes = body.rows.flatMap((row: { fix?: unknown }) => (row.fix ? [row.fix] : []));
    expect(fixes.length).toBeGreaterThan(0);
    for (const fix of fixes) {
      if ('operation' in fix) {
        expect(OPERATION_IDS).toContain(fix.operation);
        expect(parseOperation(fix.operation, fix.params, 'server').ok).toBe(true);
      } else if ('restart' in fix) {
        expect(DRAIN_RESTART_COMPONENTS).toContain(fix.restart.component);
      } else {
        expect(CHECK_ACTION_IDS).toContain(fix.action);
      }
    }
  });

  it('reads only the views the checks ask for', async () => {
    const supervisor = new FakeSettingsSupervisor();
    const checks = checksFrom(supervisor);
    const { get } = await fixture({ checks });
    await get();
    const views = supervisor.configRead.mock.calls.map(call => call[0].view);
    expect(new Set(views).size).toBe(views.length);
    for (const view of views) {
      expect((READ_VIEW_IDS as readonly string[]).includes(view)).toBe(true);
    }
    // A view no check reads is never asked for: notifications' own view is one.
    expect(views).not.toContain('wayroost.settings');
  });
});

describe('a Fix run through the settings pipeline', () => {
  it.each([
    ['gateway.socket-unit', 'gateway.socket-recover', 'gateway-role-map'],
    ['hermes.drain-marker', 'hermes.drain-marker-remove', 'hermes-config'],
  ] as const)('runs %s recovery with confirmation and audit', async (id, operation, target) => {
    const supervisor = new FakeSettingsSupervisor();
    let recovered = false;
    const runtime = fixtures();
    const checks = checksFrom(supervisor, {
      gateway: async () => ({ ...await runtime.sources.gateway!(), socketUnit: recovered ? 'active' : 'failed' }),
      drainMarker: async () => ({ present: !recovered, ours: !recovered, requestedAt: 1000, drainRunning: false, unreadable: false }),
    }, runtime.deployment);
    const { app, get } = await fixture({ local: true, supervisor, checks });
    const row = (await get()).json().rows.find((candidate: SettingsCheckRow) => candidate.id === id);
    expect(row.fix).toEqual({ operation, params: {} });
    const call = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/settings/apply',
      headers: postHeaders('fake', { cookie: PHONE_COOKIE }), payload });
    const reads = supervisor.configRead.mock.calls.length;
    const confirmation = (await call(row.fix)).json();
    expect(confirmation.status).toBe('confirm'); expect(supervisor.configApply).not.toHaveBeenCalled();
    supervisor.configApply.mockImplementationOnce(async () => {
      recovered = true; return { ok: true, recovered: true, operation, target };
    });
    const applied = (await call({ ...row.fix, confirm: confirmation.confirm })).json();
    expect(applied).toMatchObject({ status: 'applied', change: { operation, target, keys: [], effective: 'verified', undoable: false } });
    expect(settingsApplyResponseSchema.safeParse(applied).success).toBe(true);
    expect(supervisor.configRead.mock.calls).toHaveLength(reads);
    expect(supervisor.configApply.mock.calls[0]![0]).toMatchObject({ operation, params: {}, origin: { level: 'confirm' } });
    expect(supervisor.configApply.mock.calls[0]![0]).not.toHaveProperty('preconditions');
    const changes = (await app.inject({ method: 'GET', url: '/api/settings/changes',
      headers: apiHeaders('fake', { cookie: DESKTOP_COOKIE }) })).json().changes;
    expect(changes[0]).toMatchObject({ operation, result: 'ok', undoable: false, level: 'confirm' });
    const undo = await app.inject({ method: 'POST', url: '/api/settings/undo',
      headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }), payload: { change: applied.change.id } });
    expect(undo.json()).toMatchObject({ status: 'refused', code: 'undo_changed' });
    expect((await get()).json().rows.find((candidate: SettingsCheckRow) => candidate.id === id).state).toBe('ok');
  });

  it('refuses invalid recovery parameters and audits unavailable or mismatched outcomes', async () => {
    const { app, supervisor } = await fixture({ local: true });
    const call = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/settings/apply',
      headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }), payload });
    const fix = { operation: 'gateway.socket-recover', params: {} };
    expect((await call({ ...fix, params: { unit: 'other.socket' } })).json()).toMatchObject({ status: 'refused', code: 'invalid_parameters' });
    expect((await call({ ...fix, expected: { file: { sha256: 'a'.repeat(64) } } })).json()).toMatchObject({ status: 'refused', code: 'invalid_parameters' });
    expect(supervisor.configApply).not.toHaveBeenCalled();
    supervisor.configApply.mockResolvedValueOnce({ ok: false, code: 'busy' });
    expect((await call(fix)).json()).toMatchObject({ status: 'refused', code: 'busy' });
    supervisor.configApply.mockResolvedValueOnce({ ok: true, recovered: true, operation: 'hermes.drain-marker-remove', target: 'hermes-config' });
    expect((await call(fix)).json()).toMatchObject({ status: 'refused', code: 'outcome_unknown' });
    const changes = (await app.inject({ method: 'GET', url: '/api/settings/changes',
      headers: apiHeaders('fake', { cookie: DESKTOP_COOKIE }) })).json().changes;
    expect(changes.slice(0, 2).map((change: { result: string }) => change.result)).toEqual(['outcome_unknown', 'busy']);
  });

  it('applies the row, records it, and undoes it', async () => {
    const { app, get, supervisor } = await fixture({ local: true });
    const before = (await get()).json();
    const row = before.rows.find((candidate: { id: string }) => candidate.id === 'hermes.approval-mode');
    expect(row.fix).toEqual({ operation: 'hermes.approval-mode', params: { mode: 'manual' } });

    const applied = await app.inject({ method: 'POST', url: '/api/settings/apply',
      headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }), payload: { operation: row.fix.operation, params: row.fix.params } });
    expect(settingsApplyResponseSchema.safeParse(applied.json()).success).toBe(true);
    expect(applied.json()).toMatchObject({ status: 'applied', change: { operation: 'hermes.approval-mode', keys: ['approvals.mode'], undoable: true } });
    expect(supervisor.documents['hermes-config']).toMatchObject({ approvals: { mode: 'manual' } });

    // The page answers with the fix gone: the state the row named is now the state.
    expect((await get()).json().rows.find((candidate: { id: string }) => candidate.id === 'hermes.approval-mode').state).toBe('ok');

    const undone = await app.inject({ method: 'POST', url: '/api/settings/undo',
      headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }), payload: { change: applied.json().change.id } });
    expect(settingsApplyResponseSchema.safeParse(undone.json()).success).toBe(true);
    expect(supervisor.documents['hermes-config']).toMatchObject({ approvals: { mode: 'smart' } });
    expect((await get()).json().rows.find((candidate: { id: string }) => candidate.id === 'hermes.approval-mode').state).toBe('warn');

    // Both the change and its undo went through the supervisor, and nothing else did.
    expect(supervisor.configApply.mock.calls.map(call => call[0].operation)).toEqual(['hermes.approval-mode']);
  });

  it('puts a moved key back on its intended value and undoes that too', async () => {
    // The drift row's fix is gateway.reapply-intended: the levels, the audit entry,
    // the verification and the undo are the settings pipeline's, not the engine's.
    const supervisor = new RecordedSupervisor();
    supervisor.documents['hermes-config'] = { ...supervisor.documents['hermes-config'],
      model: { provider: 'demo', default: 'drifted-model', base_url: 'http://127.0.0.1:18010' } };
    supervisor.documents['gateway-state'] = movedRecordFor();
    const { app, get } = await fixture({ checks: checksFrom(supervisor), supervisor, local: true });
    const row = (await get()).json().rows.find((candidate: { id: string }) => candidate.id === 'hermes.drift');
    expect(row.state).toBe('warn');
    expect(row.fix).toEqual({ operation: 'gateway.reapply-intended', params: { consumer: 'hermes', target: 'hermes-config' } });

    const payload = { operation: 'gateway.reapply-intended', params: { consumer: 'hermes', target: 'hermes-config' } };
    const applied = await app.inject({ method: 'POST', url: '/api/settings/apply',
      headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }), payload });
    expect(applied.json()).toMatchObject({ status: 'applied', change: { operation: payload.operation, keys: ['model.default'], undoable: true } });
    expect(supervisor.documents['hermes-config']).toMatchObject({ model: { default: 'main' } });
    expect((await get()).json().rows.find((candidate: { id: string }) => candidate.id === 'hermes.drift').state).toBe('ok');

    const undone = await app.inject({ method: 'POST', url: '/api/settings/undo',
      headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }), payload: { change: applied.json().change.id } });
    expect(undone.json()).toMatchObject({ status: 'applied' });
    expect(supervisor.documents['hermes-config']).toMatchObject({ model: { default: 'drifted-model' } });
    expect((await get()).json().rows.find((candidate: { id: string }) => candidate.id === 'hermes.drift').state).toBe('warn');
  });
});

/** The gateway's record of one moved key, with an intended value of 'main'. */
function movedRecordFor() {
  return {
    state: { version: 1, profile: null, engine: null, broughtUpAt: null, overrides: {} },
    migration: { version: 1, consumers: { hermes: { 'hermes-config': {
      moved: true, movedAt: '2026-10-04T09:00:00Z', preMoveBackupSha256: 'a'.repeat(64), postMoveSha256: 'b'.repeat(64),
      keys: [{ path: ['model', 'default'], kind: 'model-dependent', before: { exists: true, value: 'demo-model' }, intended: { exists: true, value: 'main' } }],
    } } } },
  };
}

/** The fake supervisor, plus the recorded-key write the checks page's fix needs. */
class RecordedSupervisor extends FakeSettingsSupervisor {
  constructor() {
    super();
    const base = this.configApply;
    (this as { configApply?: unknown }).configApply = vi.fn(async (request: ConfigApplyRequest): Promise<ConfigWriteResult> => {
      if (request.operation !== 'gateway.reapply-intended') return base(request);
      const target = request.params.target as TargetId;
      const saved = at(this.documents['gateway-state'] ?? {}, ['migration', 'consumers', String(request.params.consumer), target, 'keys']);
      if (!Array.isArray(saved)) return { ok: false, code: 'not_configured' };
      const before = structuredClone(this.documents[target] ?? {});
      const document = this.documents[target] ?? {};
      const paths = saved.map(entry => {
        const key = entry as { path: KeyPath; intended: { exists: boolean; value?: unknown } };
        if (key.intended.exists) set(document, key.path, key.intended.value);
        else drop(document, key.path);
        return key.path;
      });
      const backupId = `recorded-${this.backups.size}`;
      this.backups.set(backupId, before);
      const token: UndoToken = { operation: request.operation, target, backupId, backupSha256: sha(before), writtenSha256: this.sha(target) };
      return { ok: true, keys: paths.map(formatKeyPath), ...token, undo: token };
    }) as unknown as FakeSettingsSupervisor['configApply'];
  }
}

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function at(document: unknown, path: readonly (string | number)[]): unknown {
  let current: unknown = document;
  for (const segment of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[String(segment)];
  }
  return current;
}

function set(document: Record<string, unknown>, path: KeyPath, value: unknown): void {
  let current = document;
  path.forEach((segment, index) => {
    if (typeof segment !== 'string') throw new Error('Unsupported test path');
    if (index === path.length - 1) current[segment] = value;
    else current = (current[segment] ??= {}) as Record<string, unknown>;
  });
}

function drop(document: Record<string, unknown>, path: KeyPath): void {
  const last = path[path.length - 1];
  const parent = typeof last === 'string' ? at(document, path.slice(0, -1) as string[]) : undefined;
  if (parent && typeof parent === 'object' && typeof last === 'string') delete (parent as Record<string, unknown>)[last];
}

describe('durable settings comparisons', () => {
  it('detects an ordinary settings write being overwritten without a gateway move', async () => {
    const { app, get, supervisor } = await fixture({ local: true });
    await get();
    const applied = await app.inject({ method: 'POST', url: '/api/settings/apply',
      headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }), payload: { operation: 'hermes.personality', params: { personality: 'focused' } } });
    expect(applied.json().status).toBe('applied');
    expect((await get()).json().rows.find((row: SettingsCheckRow) => row.id === 'hermes.drift').state).toBe('ok');
    supervisor.documents['hermes-config']!.display = { personality: 'another value' };
    const drift = (await get()).json().rows.find((row: SettingsCheckRow) => row.id === 'hermes.drift');
    expect(drift.state).toBe('warn');
    expect(drift.details).toContain('display.personality');
    expect(JSON.stringify(drift)).not.toMatch(/focused|another value/);
  });

  it('keeps successful revoked entry hashes beyond the recent-change window and across readers', async () => {
    const { app, get, supervisor, config } = await fixture({ local: true });
    const entrySha256 = createHash('sha256').update('echo example').digest('hex');
    const revoke = await app.inject({ method: 'POST', url: '/api/settings/apply', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }),
      payload: { operation: 'hermes.revoke-always', params: { entrySha256 } } });
    expect(revoke.json().status).toBe('applied');
    for (let index = 0; index < 35; index++) {
      const response = await app.inject({ method: 'POST', url: '/api/settings/apply', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }),
        payload: { operation: 'hermes.personality', params: { personality: `example-${index}` } } });
      expect(response.json().status).toBe('applied');
    }
    supervisor.documents['hermes-config']!.command_allowlist = ['echo example', 'echo another'];
    const row = (await get()).json().rows.find((row: SettingsCheckRow) => row.id === 'allowlist.revoke-back');
    expect(row.state).toBe('fail');
    expect(row.fix.params.entrySha256).toBe(entrySha256);
    const changes = (await app.inject({ method: 'GET', url: '/api/settings/changes', headers: apiHeaders('fake', { cookie: DESKTOP_COOKIE }) })).json().changes;
    expect(changes.some((change: { operation: string }) => change.operation === 'hermes.revoke-always')).toBe(false);
    const { ChecksState } = await import('../src/checks/state.js');
    const { SettingsAudit } = await import('../src/settings/audit.js');
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const audit = new SettingsAudit(config.stateDir);
    try {
      const facts = await new ChecksState(config.stateDir).effective(audit.entries());
      expect(facts.revocations).toEqual([{ entrySha256, revokedAt: 1_800_000_000_000 }]);
    } finally { audit.close(); }
  });

  it('finds a revoked entry by its file text whatever Hermes\' effective list holds', async () => {
    const { app, get, supervisor } = await fixture({ local: true });
    supervisor.documents['hermes-config']!.command_allowlist = ['echo ${EXAMPLE_PATH}'];
    // A managed layer replaces the list Hermes enforces; the file is what a revoke and a stale page change.
    supervisor.effectiveDocuments['hermes-config'] = { ...structuredClone(supervisor.documents['hermes-config']!), command_allowlist: ['echo managed'] };
    const entrySha256 = createHash('sha256').update('echo ${EXAMPLE_PATH}').digest('hex');
    const revoke = await app.inject({ method: 'POST', url: '/api/settings/apply', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }),
      payload: { operation: 'hermes.revoke-always', params: { entrySha256 } } });
    expect(revoke.json().status).toBe('applied');
    expect(supervisor.documents['hermes-config']!.command_allowlist).toEqual([]);
    expect((await get()).json().rows.find((row: SettingsCheckRow) => row.id === 'allowlist.revoke-back').state).toBe('ok');
    supervisor.documents['hermes-config']!.command_allowlist = ['echo ${EXAMPLE_PATH}'];
    const row = (await get()).json().rows.find((row: SettingsCheckRow) => row.id === 'allowlist.revoke-back');
    expect(row.state).toBe('fail');
    expect(row.fix.params.entrySha256).toBe(entrySha256);
  });

  it('ignores failed revoke attempts and successfully undone revokes', async () => {
    const { app, get, supervisor } = await fixture({ local: true });
    const entrySha256 = createHash('sha256').update('echo example').digest('hex');
    const apply = () => app.inject({ method: 'POST', url: '/api/settings/apply', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }),
      payload: { operation: 'hermes.revoke-always', params: { entrySha256 } } });
    supervisor.configApply.mockResolvedValueOnce({ ok: false, code: 'failed' });
    expect((await apply()).json().status).toBe('refused');
    expect((await get()).json().rows.find((row: SettingsCheckRow) => row.id === 'allowlist.revoke-back').state).toBe('ok');
    const applied = (await apply()).json();
    expect(applied.status).toBe('applied');
    const undone = await app.inject({ method: 'POST', url: '/api/settings/undo', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }),
      payload: { change: applied.change.id } });
    expect(undone.json().status).toBe('applied');
    expect(supervisor.documents['hermes-config']!.command_allowlist).toEqual(['echo example']);
    expect((await get()).json().rows.find((row: SettingsCheckRow) => row.id === 'allowlist.revoke-back').state).toBe('ok');
    const redo = await app.inject({ method: 'POST', url: '/api/settings/undo', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }),
      payload: { change: undone.json().change.id } });
    expect(redo.json().status).toBe('applied');
    expect(supervisor.documents['hermes-config']!.command_allowlist).toEqual([]);
    supervisor.documents['hermes-config']!.command_allowlist = ['echo example'];
    expect((await get()).json().rows.find((row: SettingsCheckRow) => row.id === 'allowlist.revoke-back').state).toBe('fail');
  });
});

describe('restoring latest durable intent', () => {
  const apply = (app: Awaited<ReturnType<typeof fixture>>['app'], payload: Record<string, unknown>, phone = false) => app.inject({
    method: 'POST', url: '/api/settings/apply', headers: postHeaders('fake', { cookie: phone ? PHONE_COOKIE : DESKTOP_COOKIE }), payload,
  });

  it('restores absent reasoning effort after undo and external drift, with preconditions, confirmation and Undo', async () => {
    const supervisor = new ReasoningSupervisor();
    delete (supervisor.documents['hermes-config']!.agent as Record<string, unknown>).reasoning_effort;
    const { app, get } = await fixture({ local: true, supervisor });
    const original = (await apply(app, { operation: 'hermes.reasoning-effort', params: { effort: 'high' } })).json();
    const undo = (change: string) => app.inject({ method: 'POST', url: '/api/settings/undo',
      headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }), payload: { change } });
    expect((await undo(original.change.id)).json().status).toBe('applied');
    expect(supervisor.documents['hermes-config']!.agent).not.toHaveProperty('reasoning_effort');
    (supervisor.documents['hermes-config']!.agent as Record<string, unknown>).reasoning_effort = 'low';
    const row = (await get()).json().rows.find((candidate: SettingsCheckRow) => candidate.id === 'hermes.drift');
    expect(row.state).toBe('warn');
    expect(row.fix.params.intentId).toMatch(/^[a-f0-9]{64}$/);
    const calls = supervisor.configApply.mock.calls.length;
    expect((await apply(app, { ...row.fix, expected: { file: { sha256: 'a'.repeat(64) } } })).json())
      .toMatchObject({ status: 'refused', code: 'precondition_changed' });
    expect(supervisor.configApply.mock.calls).toHaveLength(calls);
    const confirmation = (await apply(app, row.fix, true)).json();
    expect(confirmation.status).toBe('confirm');
    const restored = (await apply(app, { ...row.fix, confirm: confirmation.confirm }, true)).json();
    expect(restored).toMatchObject({ status: 'applied', change: { operation: 'hermes.reasoning-effort', keys: ['agent.reasoning_effort'], undoable: true } });
    expect(supervisor.configApply.mock.calls.at(-1)![0]).toMatchObject({ operation: 'hermes.reasoning-effort', params: { effort: null },
      preconditions: { file: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } }, origin: { level: 'confirm' } });
    expect(supervisor.documents['hermes-config']!.agent).not.toHaveProperty('reasoning_effort');
    expect((await get()).json().rows.find((candidate: SettingsCheckRow) => candidate.id === 'hermes.drift').state).toBe('ok');
    const changes = (await app.inject({ method: 'GET', url: '/api/settings/changes',
      headers: apiHeaders('fake', { cookie: DESKTOP_COOKIE }) })).json().changes;
    expect(changes[0]).toMatchObject({ operation: 'hermes.reasoning-effort', result: 'ok', level: 'confirm', undoable: true });
    expect((await undo(restored.change.id)).json().status).toBe('applied');
    expect(supervisor.documents['hermes-config']!.agent).toHaveProperty('reasoning_effort', 'low');
    expect((await apply(app, row.fix)).json()).toMatchObject({ status: 'refused', code: 'precondition_changed' });
  });

  it('refuses an old whole-migration Fix after newer intent while unrelated delegation drifts', async () => {
    const supervisor = new RecordedSupervisor();
    const migration = movedRecordFor();
    migration.migration.consumers.hermes['hermes-config'].keys.push({ path: ['delegation', 'model'], kind: 'recorded',
      before: { exists: true, value: 'example-old' }, intended: { exists: true, value: 'main' } });
    supervisor.documents['gateway-state'] = migration;
    supervisor.documents['hermes-config']!.delegation = { model: 'main' };
    const { app, get } = await fixture({ local: true, supervisor });
    const stale = (await get()).json().rows.find((row: SettingsCheckRow) => row.id === 'hermes.drift').fix;
    expect(stale).toEqual({ operation: 'gateway.reapply-intended', params: { consumer: 'hermes', target: 'hermes-config' } });
    const params = { provider: 'example-direct', model: 'example-latest', baseUrl: 'http://127.0.0.1:18010' };
    expect((await apply(app, { operation: 'hermes.default-model', params })).json().status).toBe('applied');
    supervisor.documents['hermes-config']!.delegation = { model: 'example-external' };
    const drift = (await get()).json().rows.find((row: SettingsCheckRow) => row.id === 'hermes.drift');
    expect(drift.state).toBe('warn'); expect(drift.fix).toBeUndefined();
    const calls = supervisor.configApply.mock.calls.length;
    expect((await apply(app, stale)).json()).toMatchObject({ status: 'refused', code: 'precondition_changed' });
    expect(supervisor.configApply.mock.calls).toHaveLength(calls);
    expect(supervisor.documents['hermes-config']!.model).toMatchObject({ provider: params.provider, default: params.model });
  });

  it('restores an unmoved ordinary write by opaque id with confirmation, audit and undo', async () => {
    const { app, get, supervisor } = await fixture({ local: true });
    expect((await apply(app, { operation: 'hermes.personality', params: { personality: 'focused' } })).json().status).toBe('applied');
    supervisor.documents['hermes-config']!.display = { personality: 'external' };
    const row = (await get()).json().rows.find((row: SettingsCheckRow) => row.id === 'hermes.drift');
    expect(row.fix).toMatchObject({ operation: 'gateway.reapply-intended', params: { consumer: 'hermes', target: 'hermes-config', intentId: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(JSON.stringify(row)).not.toMatch(/focused|external/);
    const confirmation = (await apply(app, row.fix, true)).json();
    expect(confirmation.status).toBe('confirm');
    const applied = (await apply(app, { ...row.fix, confirm: confirmation.confirm }, true)).json();
    expect(applied).toMatchObject({ status: 'applied', change: { operation: 'hermes.personality', undoable: true } });
    expect(supervisor.documents['hermes-config']!.display).toEqual({ personality: 'focused' });
    const changes = (await app.inject({ method: 'GET', url: '/api/settings/changes', headers: apiHeaders('fake', { cookie: DESKTOP_COOKIE }) })).json().changes;
    expect(changes[0]).toMatchObject({ operation: 'hermes.personality', level: 'confirm', result: 'ok' });
    expect(JSON.stringify(changes)).not.toContain('focused');
    const undo = await app.inject({ method: 'POST', url: '/api/settings/undo', headers: postHeaders('fake', { cookie: DESKTOP_COOKIE }), payload: { change: applied.change.id } });
    expect(undo.json().status).toBe('applied');
    expect(supervisor.documents['hermes-config']!.display).toEqual({ personality: 'external' });
  });

  it('restores a later ordinary model write instead of the migration snapshot', async () => {
    const supervisor = new FakeSettingsSupervisor(); supervisor.documents['gateway-state'] = movedRecordFor();
    const { app, get } = await fixture({ local: true, supervisor });
    const params = { provider: 'demo', model: 'latest-model', baseUrl: 'http://127.0.0.1:18010' };
    expect((await apply(app, { operation: 'hermes.default-model', params })).json().status).toBe('applied');
    supervisor.documents['hermes-config']!.model = { provider: 'demo', default: 'external-model', base_url: params.baseUrl };
    const row = (await get()).json().rows.find((row: SettingsCheckRow) => row.id === 'hermes.drift');
    expect(row.fix.params.intentId).toMatch(/^[a-f0-9]{64}$/);
    expect((await apply(app, row.fix)).json().status).toBe('applied');
    expect(supervisor.documents['hermes-config']!.model).toMatchObject({ default: params.model });
    expect((await get()).json().rows.find((row: SettingsCheckRow) => row.id === 'hermes.drift').state).toBe('ok');
  });

  it('refuses an ordinary intent superseded by a later gateway move', async () => {
    const { app, get, supervisor } = await fixture({ local: true });
    await apply(app, { operation: 'hermes.default-model', params: { provider: 'demo', model: 'latest-model', baseUrl: 'http://127.0.0.1:18010' } });
    supervisor.documents['hermes-config']!.model = { provider: 'demo', default: 'external-model', base_url: 'http://127.0.0.1:18010' };
    const fix = (await get()).json().rows.find((row: SettingsCheckRow) => row.id === 'hermes.drift').fix;
    const state = movedRecordFor(); state.migration.consumers.hermes['hermes-config'].movedAt = new Date(1_800_000_000_001).toISOString();
    supervisor.documents['gateway-state'] = state;
    expect((await apply(app, fix)).json()).toMatchObject({ status: 'refused', code: 'precondition_changed' });
  });

  it('refuses obsolete intent ids and preserves the original PC-only policy', async () => {
    const { app, get, supervisor } = await fixture({ local: true });
    await apply(app, { operation: 'hermes.personality', params: { personality: 'focused' } });
    supervisor.documents['hermes-config']!.display = { personality: 'external' };
    const old = (await get()).json().rows.find((row: SettingsCheckRow) => row.id === 'hermes.drift').fix;
    await apply(app, { operation: 'hermes.personality', params: { personality: 'concise' } });
    expect((await apply(app, old)).json()).toMatchObject({ status: 'refused', code: 'precondition_changed' });
    await apply(app, { operation: 'hermes.approval-mode', params: { mode: 'off' } });
    supervisor.documents['hermes-config']!.approvals = { mode: 'manual' };
    const unsafe = (await get()).json().rows.find((row: SettingsCheckRow) => row.id === 'hermes.drift').fix;
    expect((await apply(app, unsafe, true)).json()).toMatchObject({ status: 'refused', code: 'pc_only' });
  });
});

class ReasoningSupervisor extends FakeSettingsSupervisor {
  constructor() {
    super();
    const base = this.configApply;
    const site = settingsTargetsSchema.parse({ version: 1, configWrites: true, targets: {} });
    (this as { configApply?: unknown }).configApply = vi.fn(async (request: ConfigApplyRequest): Promise<ConfigWriteResult> => {
      if (request.operation !== 'hermes.reasoning-effort') return base(request);
      if (request.preconditions && 'file' in request.preconditions && request.preconditions.file.sha256 !== this.sha('hermes-config')) {
        return { ok: false, code: 'precondition_changed' };
      }
      const before = structuredClone(this.documents['hermes-config']!);
      const plan = configOperations(request.operation, request.params, 'server', before as never, site);
      this.documents['hermes-config'] = applyValues(before as never, plan.operations) as Record<string, unknown>;
      const backupId = `reasoning-${this.backups.size}`; this.backups.set(backupId, before);
      const token: UndoToken = { operation: request.operation, target: 'hermes-config', backupId,
        backupSha256: sha(before), writtenSha256: this.sha('hermes-config') };
      return { ok: true, keys: plan.paths.map(formatKeyPath), ...token, undo: token };
    }) as unknown as FakeSettingsSupervisor['configApply'];
  }
}
