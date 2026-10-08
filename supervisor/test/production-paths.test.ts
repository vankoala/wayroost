import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigVerbs } from '../src/config-verbs.js';
import { ConfigAudit } from '../src/config-audit.js';
import { createSupervisor } from '../src/server.js';
import { configSchema } from '../src/config.js';
import { hashKey } from '../src/keys.js';
import { settingsTargetsSchema } from '../../shared/settings-targets.js';
import { CONFIG_VERBS, CONFIG_ROUTES, drainRunResult, type ConfigAuditRow, type DrainRestartRun } from '../../shared/supervisor-config.js';
import type { ConfigUnitRunner } from '../src/config-unit.js';
import { executeObservation, projectScanUnit } from '../src/owner-observations.js';
import { executeConfig } from '../src/config-executor.js';
import { executeComponentRestart } from '../src/component-restart.js';
import { readConfigFile } from '../src/config-paths.js';
import { withConsumerLock } from '../src/config-locks.js';
import { configOperations } from '../src/config-operations.js';
import { ConfigError } from '../src/config-paths.js';
import { WORKER_APPROVAL_TOOLS } from '../../shared/safety.js';
import { settingComparisonJson } from '../../shared/settings.js';

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});
vi.mock('../src/credential-executor.js', async original => ({ ...await original<object>(), credentialProviders: async () => ['demo'] }));
vi.mock('../src/config-paths.js', async original => ({ ...await original<object>(), readConfigFile: vi.fn() }));
vi.mock('../src/config-hermes.js', () => ({ resolveHermesConfig: async (site: import('../../shared/settings-targets.js').SettingsTargets) => {
  const { yamlEditor } = await import('../../server/src/settings/editors/yaml.js');
  return yamlEditor.parse(await fs.readFile(site.targets['hermes-config']!.path, 'utf8'));
} }));
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const paths = await vi.importActual<typeof import('../src/config-paths.js')>('../src/config-paths.js');
const roots: string[] = [];
const drainRecords: Array<{ audit: ConfigAudit; id: string }> = [];
const uid = process.getuid!();
const serverKey = { name: 'server', scope: 'server' as const, sha256: hashKey('fake-server') };
beforeEach(() => {
  vi.mocked(fs.open).mockImplementation(actual.open);
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  vi.mocked(fs.lstat).mockImplementation(async (path, options) => { const stat = await actual.lstat(path, options); if (String(path) === '/') stat.uid = typeof stat.uid === 'bigint' ? 0n : 0; return stat; });
  vi.mocked(readConfigFile).mockImplementation(paths.readConfigFile);
});
afterEach(async () => {
  for (const { audit, id } of drainRecords.splice(0)) await vi.waitFor(async () => {
    const result = (await audit.request(id))?.drainResult;
    expect(result?.ok && result.run.endedAt !== undefined || result?.ok === false).toBe(true);
  });
  vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(process.cwd(), '.production-paths-')); roots.push(root);
  for (const name of ['state', 'backups', 'audit', 'drain', 'markers']) await mkdir(join(root, name), { mode: 0o700 });
  const path = join(root, 'config.yaml'); await writeFile(path, 'approvals:\n  mode: smart\n', { mode: 0o600 });
  const site = settingsTargetsSchema.parse({ version: 1, configWrites: true, targets: {
    'hermes-config': { path, runAs: { user: 'me', uid }, format: 'yaml', mode: 0o600, backupDir: join(root, 'backups'), auditDir: join(root, 'audit'), lock: { kind: 'file', path: path + '.wayroost-settings.lock' } },
    'gateway-role-map': { path: join(root, 'map.json'), defaultMap: join(root, 'default.json'), adminSocket: '/run/example/admin.sock', service: 'example-gateway.service', socket: 'example-gateway.socket' },
    'gateway-credentials': { directory: join(root, 'credentials'), dropIn: '/etc/systemd/system/example-gateway.service.d/credentials.conf', service: 'example-gateway.service', lockFile: join(root, 'credentials.lock'), backupDir: join(root, 'credential-backups') },
  }, hermes: { runAs: { user: 'me', uid }, gatewayUnit: 'example-hermes.service', dashboardUnit: { name: 'example-dashboard.service', scope: 'user' },
    stateFile: join(root, 'gateway.json'), cronJobs: join(root, 'cron.json'), profilesDir: join(root, 'profiles'), processesFile: join(root, 'processes.json'),
    stateDatabase: join(root, 'database.db'), drainStateDir: join(root, 'drain'), drainMarker: { path: join(root, 'markers/drain.json'), runAs: { user: 'me', uid } } } });
  const exit = vi.fn<(code: number) => void>();
  const audit = new ConfigAudit(join(root, 'state'), uid, exit);
  const runner = vi.fn<ConfigUnitRunner>(async unit => ({ code: 0, stdout: JSON.stringify(await executeConfig(JSON.parse(unit.input),
    { lock: (target, work) => withConsumerLock(target, work, async path => path) })) + '\n' }));
  const command = vi.fn(async (_argv: readonly string[]) => ({ code: 3, stdout: 'inactive\n' }));
  const admin = vi.fn(async () => ({ ok: true, provider: 'demo', backend: 'example' }));
  const options = { stateDir: audit.directory, site: async () => site, audit, runner, trust: async (path: string) => path, serviceCommand: command, serviceAdmin: admin };
  const verbs = new ConfigVerbs(options);
  const supervisor = createSupervisor({ config: configSchema.parse({ development: true, statusOnly: true, restartWhenIdleCertified: true, stateDir: audit.directory }), registry: [], keys: [serverKey,
    { name: 'launcher', scope: 'server', sha256: hashKey('fake-launcher') }, { name: 'rescue', scope: 'rescue', sha256: hashKey('fake-rescue') }], exec: { async run() { return 0; } }, configVerbs: verbs,
    status: async () => ({ overall: 'ok', sentence: 'Ready', components: [], at: 1 }) });
  async function http(path: string, body: unknown = {}, method = 'POST', token = 'fake-server') {
    const req = Readable.from([JSON.stringify(body)]) as IncomingMessage; req.url = path; req.method = method; req.headers = { authorization: 'Bearer ' + token };
    const result = await new Promise<{ status: number; body: any }>(resolve => {
      const res = Object.assign(new EventEmitter(), { status: 0, headersSent: false, destroyed: false,
        writeHead(status: number) { this.status = status; return this; }, end(text: string) { resolve({ status: this.status, body: JSON.parse(text) }); } });
      supervisor.socket.emit('request', req, res as unknown as ServerResponse);
    });
    if (method === 'POST' && path === '/v1/config/drain-restart' && result.body.ok) drainRecords.push({ audit, id: result.body.run.id });
    return result;
  }
  return { root, path, site, audit, exit, runner, command, admin, options, verbs, supervisor, http };
}
describe('authenticated supervisor production verbs', () => {
  it.each(['fake-launcher', 'fake-rescue', 'wrong-key'])('refuses request audit reads with %s', async token => {
    const f = await fixture();
    expect((await f.http(CONFIG_ROUTES.requestStatus, { requestId: randomUUID() }, 'POST', token)).status).toBe(token === 'wrong-key' ? 401 : 403);
  });

  it('returns missing, pending and interrupted request evidence without running an executor', async () => {
    const f = await fixture();
    const requestId = randomUUID();
    expect((await f.http(CONFIG_ROUTES.requestStatus, { requestId })).body).toEqual({ ok: true, requestId, state: 'missing' });
    expect((await f.http(CONFIG_ROUTES.requestStatus, { requestId: 'bad' })).body).toEqual({ ok: false, code: 'invalid_parameters' });
    const row: ConfigAuditRow = { id: requestId, time: new Date(0).toISOString(), caller: 'server', verb: 'config.apply',
      target: 'hermes-config', operation: 'hermes.approval-mode', keys: [], result: 'outcome_unknown' };
    await f.audit.save({ row, requestSha256: 'a'.repeat(64), callerSha256: 'b'.repeat(64) });
    expect((await f.http(CONFIG_ROUTES.requestStatus, { requestId })).body).toEqual({ ok: true, requestId, state: 'pending' });
    delete f.site.hermes;
    await f.verbs.initialize();
    expect((await f.http(CONFIG_ROUTES.requestStatus, { requestId })).body).toEqual({ ok: true, requestId, state: 'interrupted' });
    expect((await f.audit.request(requestId))?.interrupted).toBe(true);
    await f.verbs.initialize();
    expect(f.runner).not.toHaveBeenCalled();
  });

  it('reads a successful write terminal record over HTTP without inspecting the target', async () => {
    const f = await fixture();
    const requestId = randomUUID();
    const result = (await f.http(CONFIG_ROUTES.apply, { requestId, operation: 'hermes.approval-mode', params: { mode: 'manual' } })).body;
    expect(result.ok).toBe(true);
    const calls = f.runner.mock.calls.length;
    await writeFile(f.path, 'approvals:\n  mode: off\n', { mode: 0o600 });
    const status = (await f.http(CONFIG_ROUTES.requestStatus, { requestId })).body;
    expect(status).toMatchObject({ ok: true, requestId, state: 'terminal', outcome: 'applied', row: { id: requestId, result: 'ok' } });
    expect(f.runner).toHaveBeenCalledTimes(calls);
    expect((await f.verbs.status()).verbs).toContain('config.request-status');
  });

  it.each(['refused', 'unknown', 'committed'] as const)('keeps terminal %s outcomes truthful', async outcome => {
    const f = await fixture();
    const requestId = randomUUID();
    const row: ConfigAuditRow = { id: requestId, time: new Date(0).toISOString(), caller: 'server', verb: 'config.apply',
      target: 'hermes-config', operation: 'hermes.approval-mode', keys: [], result: outcome === 'unknown' ? 'outcome_unknown' : 'failed' };
    const token = { operation: row.operation!, target: 'hermes-config' as const, backupId: 'example-backup', backupSha256: 'a'.repeat(64), writtenSha256: 'b'.repeat(64) };
    const result = outcome === 'unknown' ? { ok: false as const, code: 'outcome_unknown' as const, target: 'hermes-config' as const, backupId: null }
      : outcome === 'committed' ? { ok: false as const, code: 'failed' as const, committed: true as const, undo: token } : { ok: false as const, code: 'failed' as const };
    await f.audit.save({ row, result, requestSha256: 'a'.repeat(64), callerSha256: 'b'.repeat(64) });
    await f.audit.append(row);
    expect((await f.http(CONFIG_ROUTES.requestStatus, { requestId })).body).toMatchObject({ ok: true, state: 'terminal', outcome: outcome === 'refused' ? 'refused' : 'outcome_unknown' });
    expect(f.runner).not.toHaveBeenCalled();
  });

  it('preserves a terminal log record when startup finds pending launch metadata', async () => {
    const f = await fixture();
    const requestId = randomUUID();
    const row: ConfigAuditRow = { id: requestId, time: new Date(0).toISOString(), caller: 'server', verb: 'config.apply',
      target: 'hermes-config', operation: 'hermes.approval-mode', keys: [], result: 'outcome_unknown' };
    await f.audit.save({ row, requestSha256: 'a'.repeat(64), callerSha256: 'b'.repeat(64) });
    await f.audit.append({ ...row, result: 'ok' });
    delete f.site.hermes;
    await f.verbs.initialize();
    expect((await f.http(CONFIG_ROUTES.requestStatus, { requestId })).body).toMatchObject({ state: 'terminal', outcome: 'applied', row: { result: 'ok' } });
    expect(f.runner).not.toHaveBeenCalled();
  });

  it('refuses a server-held resolution as a supervisor write before dispatch', async () => {
    const f = await fixture();
    const response = await f.http(CONFIG_ROUTES.apply, { requestId: randomUUID(), operation: 'settings.accept-current',
      params: { target: 'hermes-config', change: 'ch_' + 'a'.repeat(24) } });
    expect(response.body).toEqual({ ok: false, code: 'not_permitted' });
    expect(f.runner).not.toHaveBeenCalled();
  });

  it('fails closed if marking a pending startup request interrupted cannot be synced', async () => {
    const f = await fixture();
    const id = randomUUID();
    await f.audit.save({ requestSha256: 'a'.repeat(64), callerSha256: 'b'.repeat(64), row: {
      id, time: new Date(0).toISOString(), caller: 'server', verb: 'config.apply', keys: [], target: 'hermes-config', result: 'outcome_unknown',
    } });
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('unavailable'), { code: 'EIO' }));
    await expect(f.audit.initialize()).rejects.toMatchObject({ code: 'audit_unavailable' });
    expect(f.exit).toHaveBeenCalledWith(1);
    expect(await f.verbs.apply({ requestId: randomUUID(), operation: 'hermes.approval-mode', params: { mode: 'manual' } }, serverKey))
      .toEqual({ ok: false, code: 'audit_unavailable' });
    expect(f.runner).not.toHaveBeenCalled();
  });

  it('reads complete pi provider digests through the owner executor over HTTP', async () => {
    const f = await fixture();
    const path = join(f.root, 'models.json');
    const backupDir = join(f.root, 'pi-backups'); const auditDir = join(f.root, 'pi-audit');
    await mkdir(backupDir, { mode: 0o700 }); await mkdir(auditDir, { mode: 0o700 });
    f.site.targets['pi-models'] = { path, format: 'json', runAs: { user: 'me', uid }, mode: 0o600,
      backupDir, auditDir, lock: { kind: 'file', path: path + '.wayroost-settings.lock' } };
    const before = { baseUrl: 'https://example.com/models', api: 'openai-completions', apiKey: 'invented-before-key',
      models: [{ id: 'example-model', headers: { 'x-example': 'invented-before-header' } }] };
    const digest = (value: typeof before) => {
      const text = settingComparisonJson(value);
      return { sha256: createHash('sha256').update(text).digest('hex'), length: Buffer.byteLength(text) };
    };
    for (const provider of [before, { ...before, apiKey: 'invented-after-key' },
      { ...before, models: [{ id: 'example-model', headers: { 'x-example': 'invented-after-header' } }] }]) {
      const source = JSON.stringify({ providers: { example: provider }, unrelated: 'invented-unrelated-value' });
      await writeFile(path, source, { mode: 0o600 });
      const response = await f.http(CONFIG_ROUTES.read, { view: 'pi.providers' });
      expect(response).toEqual({ status: 200, body: { ok: true, view: 'pi.providers', present: true,
        sha256: createHash('sha256').update(source).digest('hex'),
        values: [{ path: ['providers', 'example'], exists: true, value: digest(provider) }] } });
      expect(JSON.stringify(response.body)).not.toMatch(/invented-(?:before|after)-(?:key|header)|invented-unrelated-value/);
    }
    expect(f.runner).toHaveBeenCalledTimes(3);
    expect(await fs.readdir(backupDir)).toEqual([]);
  });
  it.each(['smart', 'off', ['smart'], null])('refuses delayed applies with guard %s before doing work', async value => {
    const f = await fixture();
    const body = { requestId: randomUUID(), operation: 'hermes.approval-mode', params: { mode: 'manual' }, afterSeconds: 60,
      preconditions: { keys: [{ key: 0, value }] } };
    expect((await f.http(CONFIG_ROUTES.apply, body)).body).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(f.runner).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
    expect(await fs.readFile(f.path, 'utf8')).toContain('mode: smart');
    expect(await fs.readdir(f.audit.directory)).toEqual([]);
    expect((await f.verbs.status()).verbs).toEqual(CONFIG_VERBS.filter(verb => verb !== 'usage.summary'));
  });

  it('advertises the credential probe and fails closed before reading a key when its map is unavailable', async () => {
    const f = await fixture();
    expect((await f.verbs.status()).verbs).toContain('credential.test');
    expect(CONFIG_VERBS).toContain('credential.test');
    vi.mocked(readConfigFile).mockClear();
    expect((await f.http('/v1/config/credential/test', { requestId: randomUUID(), provider: 'demo', backend: 'example' })).body).toEqual({ ok: false, code: 'backend_unavailable' });
    expect(f.admin).not.toHaveBeenCalled(); expect(readConfigFile).not.toHaveBeenCalled();
  });

  it.each(['append', 'save'] as const)('keeps a drain pending until its final audit %s finishes', async method => {
    const f = await fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let reached = false;
    const pause = async (row: ConfigAuditRow) => {
      if (row.verb === 'service.drain-restart' && row.result === 'ok') { reached = true; await gate; throw new Error('unavailable'); }
    };
    if (method === 'append') {
      const append = f.audit.append.bind(f.audit);
      vi.spyOn(f.audit, 'append').mockImplementation(async row => { await pause(row); await append(row); });
    } else {
      const save = f.audit.save.bind(f.audit);
      vi.spyOn(f.audit, 'save').mockImplementation(async record => { await pause(record.row); await save(record); });
    }
    f.runner.mockResolvedValue({ code: 0, stdout: '{"outcome":"restarted"}' });
    const id = randomUUID();
    await f.verbs.drainRestart({ requestId: id, component: 'hermes', when: 'idle' }, serverKey);
    try {
      await vi.waitFor(() => expect(reached).toBe(true));
      const response = await f.http('/v1/config/drain-restart/' + id, {}, 'GET');
      expect(drainRunResult(response.body.run)).toBe('pending');
    } finally { release(); }
    await vi.waitFor(async () => {
      const response = await f.http('/v1/config/drain-restart/' + id, {}, 'GET');
      expect(drainRunResult(response.body.run)).toBe('outcome_unknown'); expect(response.status).toBe(409);
    });
    expect((await f.audit.rows()).find(row => row.id === id)?.result).toBe('outcome_unknown');
  });
  it('advertises exactly the reachable config verbs', async () => { const f = await fixture(); expect((await f.supervisor.status()).configVerbs?.verbs).toEqual(expect.arrayContaining([...CONFIG_VERBS])); });
  it('serves credential writes and refuses keys without that capability', async () => {
    const f = await fixture(); const write = vi.spyOn(f.verbs, 'credential').mockResolvedValue({ ok: true, provider: 'demo', timing: 'restart-when-idle:gateway' });
    expect((await f.http('/v1/config/credential', { requestId: randomUUID(), provider: 'demo', action: 'remove' })).body.ok).toBe(true);
    expect((await f.http('/v1/config/credential', {}, 'POST', 'fake-launcher')).status).toBe(403);
    expect((await f.http('/v1/config/credential', {}, 'POST', 'missing')).status).toBe(401); expect(write).toHaveBeenCalledOnce();
  });
  it('validates and authenticates the credential test route', async () => {
    const f = await fixture();
    const body = { requestId: randomUUID(), provider: 'demo', backend: 'example' };
    expect((await f.http('/v1/config/credential/test', body)).body).toEqual({ ok: false, code: 'backend_unavailable' });
    expect((await f.http('/v1/config/credential/test', { ...body, prompt: 'unapproved' })).body.code).toBe('invalid_parameters');
    expect(f.admin).not.toHaveBeenCalled();
    expect((await f.http('/v1/config/credential/test', body, 'POST', 'fake-launcher')).status).toBe(403);
  });
  it.each(['restarted', 'still_busy', 'restart_unverified', 'foreign_drain', 'marker_lost', 'drain_not_engaged', 'not_running'] as const)('tracks %s independently and uses the same response and audit outcome', async outcome => {
    const f = await fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    f.runner.mockImplementation(async (_unit, onLine) => { onLine?.('{"progress":{"state":"draining","attempts":1}}'); await gate; return { code: 0, stdout: JSON.stringify({ outcome }) }; });
    const id = randomUUID();
    const accepted = await f.http('/v1/config/drain-restart', { requestId: id, component: 'hermes', when: 'idle' });
    expect(accepted).toMatchObject({ status: 202, body: { ok: true, run: { id, state: 'waiting' } } });
    await vi.waitFor(async () => expect((await f.http('/v1/config/drain-restart/' + id, {}, 'GET')).body.run.state).toBe('draining'));
    expect((await f.http('/v1/config/drain-restart/' + id, {}, 'GET', 'fake-launcher')).status).toBe(403);
    release();
    await vi.waitFor(async () => expect((await f.audit.request(id))?.drainResult).toMatchObject({ run: { outcome } }));
    const finished = await f.http('/v1/config/drain-restart/' + id, {}, 'GET');
    const mapped = drainRunResult(finished.body.run as DrainRestartRun);
    expect(finished.status).toBe(mapped === 'ok' ? 200 : 409); expect((await f.audit.rows()).at(-1)?.result).toBe(mapped);
    expect((await new ConfigVerbs(f.options).drainRestartRun(id))).toEqual(finished.body);
  });
  it('refuses Restart now during an idle drain and accepts it after the timeout is recorded', async () => {
    const f = await fixture(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.runner.mockImplementationOnce(async () => { await gate; return { code: 0, stdout: '{"outcome":"still_busy"}' }; });
    const id = randomUUID();
    try {
      expect(await f.http('/v1/config/drain-restart', { requestId: id, component: 'hermes', when: 'idle' }))
        .toMatchObject({ status: 202, body: { ok: true, run: { id } } });
      expect(await f.http('/v1/config/drain-restart', { requestId: randomUUID(), component: 'hermes', when: 'now' }))
        .toMatchObject({ body: { ok: false, code: 'busy' } });
      expect(f.runner).toHaveBeenCalledOnce();
    } finally { release(); }
    await vi.waitFor(async () => expect((await f.audit.request(id))?.drainResult)
      .toMatchObject({ ok: true, run: { outcome: 'still_busy' } }));
    expect(await f.http('/v1/config/drain-restart/' + id, {}, 'GET'))
      .toMatchObject({ status: 409, body: { ok: true, run: { id, state: 'still-busy', outcome: 'still_busy', endedAt: expect.any(Number) } } });
    f.runner.mockResolvedValueOnce({ code: 0, stdout: '{"outcome":"restarted"}' });
    const next = randomUUID();
    expect(await f.http('/v1/config/drain-restart', { requestId: next, component: 'hermes', when: 'now' }))
      .toMatchObject({ status: 202, body: { ok: true, run: { id: next, when: 'now' } } });
    await vi.waitFor(async () => expect((await f.audit.request(next))?.drainResult)
      .toMatchObject({ ok: true, run: { outcome: 'restarted' } }));
    expect(f.runner).toHaveBeenCalledTimes(2);
  });

  it('runs project scans as the folder owner over HTTP and retains bounded observations', async () => {
    const f = await fixture(); await mkdir(join(f.root, '.claude')); await writeFile(join(f.root, '.claude/settings.json'), '{"hooks":{"PreToolUse":[{"command":"echo example"}]}}');
    f.runner.mockImplementation(async unit => ({ code: 0, stdout: JSON.stringify(await executeObservation(JSON.parse(unit.input))) }));
    const scan = await f.http('/v1/project/scan', { folder: f.root }); expect(scan.body.ok).toBe(true); expect(scan.body.scan.findings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'runs-hooks' })]));
    expect(f.runner.mock.calls[0]![0].argv).toContain('--uid=' + uid); expect(f.runner.mock.calls[0]![0].argv).toContain('--property=ReadWritePaths=');
    expect((await f.http('/v1/project/scan', { folder: f.root }, 'POST', 'fake-launcher')).status).toBe(403);
    expect((await f.http('/v1/checks/observe', { path: '/home/me' })).body.code).toBe('invalid_parameters');
    expect((await f.http('/v1/checks/observe')).body).toMatchObject({ ok: true, hermesStartedAt: null });
    expect((await f.http('/v1/checks/observe', {}, 'POST', 'fake-launcher')).status).toBe(403);
  });
  it('observes each configured owner and leaves oversized or unavailable probes unknown', async () => {
    const f = await fixture();
    f.site.coderMcp = { original: '/home/me/coder.py', gatewayCopy: '/home/me/gateway-coder.py' };
    f.site.switchFlags = { path: '/home/me/flags.json', runAs: { user: 'example', uid: uid + 1 } };
    f.runner.mockImplementation(async unit => {
      const input = JSON.parse(unit.input);
      expect(unit.argv).toContain('--uid=' + input.uid);
      const observed = { ok: true, hermesStartedAt: null, coderProcesses: null, drainMarker: null, switchFlags: null };
      if (input.kind === 'hermes') throw new Error('unavailable');
      if (input.kind === 'coder') return { code: 0, stdout: JSON.stringify({ ...observed,
        coderProcesses: Array.from({ length: 257 }, () => ({ script: 'original', startedAt: 1000 })) }) };
      expect(input.uid).toBe(uid + 1);
      return { code: 0, stdout: JSON.stringify({ ...observed, switchFlags: { example: true } }) };
    });
    expect((await f.http('/v1/checks/observe')).body).toEqual({ ok: true, hermesStartedAt: null,
      coderProcesses: null, drainMarker: null, switchFlags: { example: true } });
    expect(f.runner).toHaveBeenCalledTimes(3);
    await expect(executeObservation({ mode: 'checks-observe', site: f.site, uid, kind: 'hermes' }, uid + 1)).rejects.toThrow('unsafe_target');
  });
});


describe('fixed component restart executors', () => {
  it.each(['gateway', 'dashboard'] as const)('verifies a new PID for %s and runs outside statusOnly', async component => {
    const f = await fixture(); let restarted = false; let clock = 0;
    const command = vi.fn(async (argv: readonly string[]) => {
      if (argv.includes('restart')) restarted = true;
      return { code: 0, stdout: argv.includes('show') ? restarted ? '102\n' : '101\n' : 'active\n' };
    });
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(component === 'gateway' ? 0 : uid);
    expect(await executeComponentRestart(f.site, component, 'now', () => {}, { command, admin: f.admin, now: () => clock, sleep: async ms => { clock += ms; } })).toEqual({ outcome: 'restarted' });
    expect(command.mock.calls.find(([argv]) => argv.includes('restart'))?.[0]).toEqual(component === 'gateway' ? ['systemctl', 'restart', 'example-gateway.service'] : ['systemctl', '--user', 'restart', 'example-dashboard.service']);
    getuid.mockRestore();
    f.runner.mockResolvedValue({ code: 0, stdout: '{"outcome":"restarted"}' });
    expect((await f.http('/v1/config/drain-restart', { requestId: randomUUID(), component, when: 'now' })).status).toBe(202);
  });
  it('waits for the gateway admin drain before verifying its automatic restart', async () => {
    const f = await fixture(); const getuid = vi.spyOn(process, 'getuid').mockReturnValue(0); let restarted = false;
    const admin = vi.fn(async () => { restarted = true; return { status: 'drained' }; });
    const command = vi.fn(async (argv: readonly string[]) => ({ code: 0, stdout: argv.includes('show') ? restarted ? '2' : '1' : 'active' }));
    expect(await executeComponentRestart(f.site, 'gateway', 'idle', () => {}, { command, admin, now: () => 0, sleep: async () => {} })).toEqual({ outcome: 'restarted' });
    expect(admin).toHaveBeenCalledWith('/run/example/admin.sock', '/v1/drain', {}, 610000); expect(command.mock.calls.some(([argv]) => argv.includes('restart'))).toBe(false); getuid.mockRestore();
  });
});




it('selects the closest containing workspace before checking its owner', async () => {
  const f = await fixture(); const nested = join(f.root, 'project'); await mkdir(nested, { mode: 0o700 });
  const unit = await projectScanUnit({ folder: nested, workspaceRoots: ['/home/me/unrelated', '/home/me/missing', f.root] });
  expect(JSON.parse(unit.input).request.workspaceRoots).toEqual([f.root]);
  const scan = await executeObservation(JSON.parse(unit.input)); expect(scan.ok).toBe(true);
  await fs.chmod(f.root, 0o777);
  try { await expect(projectScanUnit({ folder: nested, workspaceRoots: [f.root] })).rejects.toThrow('unsafe_directory'); }
  finally { await fs.chmod(f.root, 0o700); }
});

it('uses the shared worker approval projection while preserving other tool choices', async () => {
  const f = await fixture(); const current = { agents: { providers: { codex: { paseoTools: { enabled: false, disabledTools: ['example_tool'] } } } } };
  for (const enabled of [true, false]) {
    const projected = configOperations('paseo.worker-approvals', { enabled }, 'server', current, f.site).operations;
    const codex = projected.find(operation => operation.path.includes('codex'));
    expect(codex).toMatchObject({ type: 'set', value: { enabled: false, disabledTools: enabled ? ['example_tool', ...WORKER_APPROVAL_TOOLS] : ['example_tool'] } });
  }
});

it('serializes request updates and supervisor appends from different processes without losing rows', async () => {
  const f = await fixture(); const id = randomUUID();
  const row = { id, time: new Date().toISOString(), caller: 'server', verb: 'config.apply' as const,
    operation: 'hermes.approval-mode', target: 'hermes-config', keys: ['approvals.mode'], result: 'outcome_unknown' as const };
  await f.audit.append(row);
  const source = `import { ConfigAudit } from ${JSON.stringify(new URL('../src/config-audit.ts', import.meta.url).href)};
    import { randomUUID } from 'node:crypto';
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const lstat = fs.lstat;
    fs.lstat = async (...args) => { const stat = await lstat(...args); if (String(args[0]) === '/') stat.uid = 0; return stat; };
    syncBuiltinESMExports();
    const audit = new ConfigAudit(process.argv[1]);
    const row = JSON.parse(process.argv[2]);
    for (let i = 0; i < 12; i++) await audit.append(process.argv[3] === 'worker'
      ? { ...row, caller: 'server', result: i % 2 ? 'ok' : 'verify_mismatch' }
      : { ...row, id: randomUUID(), caller: 'server', result: 'ok' });`;
  const run = (kind: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, f.audit.directory, JSON.stringify(row), kind], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk; }); child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(errors)));
  });
  const results = await Promise.allSettled([run('worker'), run('server')]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const rows = await f.audit.rows(); expect(rows).toHaveLength(13);
  expect(rows.find(entry => entry.id === id)).toMatchObject({ caller: 'server', result: 'ok' });
});

it('waits for an audit lock released between its ownership check and descriptor open', async () => {
  const f = await fixture(); const lock = join(f.audit.directory, 'config-audit.lock');
  await writeFile(lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  let released = false;
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    if (String(path) === lock && flags === (constants.O_RDONLY | constants.O_NOFOLLOW) && !released) {
      released = true; await actual.unlink(lock);
      throw Object.assign(new Error('Lock released'), { code: 'ENOENT' });
    }
    return actual.open(path, flags, mode);
  });
  const id = randomUUID(); await f.audit.append({ id, time: new Date().toISOString(), caller: 'server', verb: 'config.apply',
    operation: 'hermes.approval-mode', target: 'hermes-config', keys: ['approvals.mode'], result: 'ok' });
  expect(released).toBe(true); expect((await f.audit.rows()).find(row => row.id === id)?.result).toBe('ok');
});

it('waits for a concurrent audit publisher before admitting a write', async () => {
  const f = await fixture(); const id = randomUUID();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let syncing = false;
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    if (String(path) === f.audit.directory && Number(flags) & constants.O_DIRECTORY && !syncing) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => { syncing = true; await gate; await sync(); });
    }
    return handle;
  });
  const saving = new ConfigAudit(f.audit.directory).save({ row: { id, time: new Date().toISOString(), caller: 'server', verb: 'config.apply', keys: [], result: 'ok' },
    requestSha256: 'a'.repeat(64), callerSha256: 'b'.repeat(64) });
  await vi.waitFor(() => expect(syncing).toBe(true));
  const admitted = f.http(CONFIG_ROUTES.apply, { requestId: randomUUID(), operation: 'hermes.approval-mode', params: { mode: 'manual' } });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(f.runner).not.toHaveBeenCalled();
  } finally { release(); }
  await saving;
  expect((await admitted).body).toMatchObject({ ok: true });
  expect(f.runner).toHaveBeenCalledOnce();
});

it('admits a write after a publisher left a stale ownership lock', async () => {
  const f = await fixture();
  await writeFile(join(f.audit.directory, 'config-audit.lock'), JSON.stringify({ pid: process.pid, birth: 'expired-process-identity' }), { mode: 0o600 });
  expect((await f.http(CONFIG_ROUTES.apply, { requestId: randomUUID(), operation: 'hermes.approval-mode', params: { mode: 'manual' } })).body).toMatchObject({ ok: true });
  expect(f.runner).toHaveBeenCalledOnce();
});

it.each(['write', 'file-sync', 'directory-sync', 'rename'] as const)('stops writes without restoring records after %s failure', async fault => {
  const f = await fixture(); const id = randomUUID();
  const record = { row: { id, time: new Date().toISOString(), caller: 'server', verb: 'config.apply' as const, keys: [], result: 'outcome_unknown' as const },
    requestSha256: 'a'.repeat(64), callerSha256: 'b'.repeat(64) };
  await f.audit.save(record);
  let publications = 0;
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    publications++;
    if (fault === 'rename') throw new Error('unavailable');
    return actual.rename(from, to);
  });
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    if (String(path).includes('/.config-request-')) {
      if (fault === 'write') vi.spyOn(handle, 'writeFile').mockRejectedValue(new Error('unavailable'));
      if (fault === 'file-sync') vi.spyOn(handle, 'sync').mockRejectedValue(new Error('unavailable'));
    }
    if (String(path) === f.audit.directory && Number(flags) & constants.O_DIRECTORY && fault === 'directory-sync') {
      vi.spyOn(handle, 'sync').mockRejectedValue(new Error('unavailable'));
    }
    return handle;
  });
  await expect(f.audit.save({ ...record, row: { ...record.row, result: 'ok' } })).rejects.toThrow('audit_unavailable');
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(publications).toBe(fault === 'directory-sync' || fault === 'rename' ? 1 : 0);
  await expect(f.audit.save(record)).rejects.toThrow('audit_unavailable');
  expect((await f.http(CONFIG_ROUTES.apply, { requestId: randomUUID(), operation: 'hermes.approval-mode', params: { mode: 'manual' } })).body).toEqual({ ok: false, code: 'audit_unavailable' });
  expect(f.runner).not.toHaveBeenCalled(); expect(f.exit).toHaveBeenCalledOnce();
});

it.each(['write', 'file-sync', 'directory-sync'] as const)('exits when an audit append has a %s failure', async fault => {
  const f = await fixture();
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    if (String(path).endsWith('/config-audit.jsonl')) {
      if (fault === 'write') vi.spyOn(handle, 'writeFile').mockRejectedValue(new Error('unavailable'));
      if (fault === 'file-sync') vi.spyOn(handle, 'sync').mockRejectedValue(new Error('unavailable'));
    }
    if (String(path) === f.audit.directory && Number(flags) & constants.O_DIRECTORY && fault === 'directory-sync') vi.spyOn(handle, 'sync').mockRejectedValue(new Error('unavailable'));
    return handle;
  });
  await expect(f.audit.append({ id: randomUUID(), time: new Date().toISOString(), caller: 'server', verb: 'config.apply', keys: [], result: 'ok' })).rejects.toThrow('audit_unavailable');
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
  await expect(f.audit.request(randomUUID())).rejects.toThrow('audit_unavailable');
});

it('terminates the process on a failed directory sync before returning success', async () => {
  const f = await fixture();
  const source = `import fs from 'node:fs/promises';
    import { constants } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const lstat = fs.lstat; const open = fs.open;
    fs.lstat = async (...args) => { const stat = await lstat(...args); if (String(args[0]) === '/') stat.uid = 0; return stat; };
    fs.open = async (...args) => { const handle = await open(...args); if (Number(args[1]) & constants.O_DIRECTORY) handle.sync = async () => { throw new Error('unavailable'); }; return handle; };
    syncBuiltinESMExports();
    const { ConfigAudit } = await import(${JSON.stringify(new URL('../src/config-audit.ts', import.meta.url).href)});
    await new ConfigAudit(process.argv[1]).save({ requestSha256: 'a'.repeat(64), callerSha256: 'b'.repeat(64),
      row: { id: '00000000-0000-4000-8000-000000000001', time: new Date().toISOString(), caller: 'server', verb: 'config.apply', keys: [], result: 'ok' } });
    process.stdout.write('success');`;
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, f.audit.directory], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); child.on('error', reject);
    child.on('exit', code => resolve({ code, output }));
  });
  expect(result).toEqual({ code: 1, output: '' });
});
