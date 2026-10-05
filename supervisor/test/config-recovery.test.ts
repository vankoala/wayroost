import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseOperation, RECOVERY_OPERATIONS } from '../../shared/settings-ops.js';
import { configRecoveryResultSchema, configWriteResultSchema } from '../../shared/supervisor-config.js';
import { settingsTargetsSchema } from '../../shared/settings-targets.js';
import { ConfigAudit } from '../src/config-audit.js';
import { executeRecovery, recoveryUnit } from '../src/config-recovery.js';
import { ConfigVerbs } from '../src/config-verbs.js';
import { type ConfigUnitRunner } from '../src/config-unit.js';
import { type ConfigCommand } from '../src/config-command.js';
import { DRAIN_UNIT, fileDrainIO } from '../src/drain-files.js';
import { hashKey, type Key } from '../src/keys.js';

const roots: string[] = [];
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
beforeEach(() => {
  vi.mocked(fs.lstat).mockImplementation(async (path, options) => {
    const stat = await actual.lstat(path, options);
    if (String(path) === '/') stat.uid = typeof stat.uid === 'bigint' ? 0n : 0;
    return stat;
  });
});
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const server: Key = { name: 'server', scope: 'server', sha256: hashKey('fake-server-key') };
const marker = { action: 'drain', principal: 'wayroost', requested_at: '2026-01-02T03:04:05.000Z',
  epoch: '01234567-89ab-cdef-0123-456789abcdef:123', suppress_notification: true };
const uid = process.getuid!();

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), '.tmp/config-recovery-')); roots.push(root);
  const stateDir = join(root, 'supervisor'); await mkdir(stateDir, { mode: 0o700 });
  const markerPath = join(root, 'marker.json');
  await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
  const site = settingsTargetsSchema.parse({ version: 1, configWrites: true, targets: { 'gateway-role-map': {
    path: join(root, 'map.json'), defaultMap: join(root, 'default-map.json'), adminSocket: join(root, 'admin.sock'),
    service: 'example-gateway.service', socket: 'example-gateway.socket',
  } }, hermes: {
    runAs: { user: 'me', uid }, gatewayUnit: 'example-hermes.service', dashboardUnit: { name: 'example-dashboard.service', scope: 'system' },
    stateFile: join(root, 'gateway-state.json'), cronJobs: join(root, 'cron.json'), profilesDir: join(root, 'profiles'),
    processesFile: join(root, 'processes.json'), stateDatabase: join(root, 'state.db'), drainStateDir: join(root, 'drain-state'),
    drainMarker: { path: markerPath, runAs: { user: 'me', uid } },
  } });
  const command = vi.fn<ConfigCommand>(async argv => argv.includes('is-active') ? { code: 3, stdout: 'inactive\n' }
    : argv.includes('show') ? { code: 0, stdout: 'Id=example-gateway.socket\nLoadState=loaded\nActiveState=active\nTriggers=example-gateway.service\n' }
      : { code: 0, stdout: '' });
  const runner = vi.fn<ConfigUnitRunner>(async unit => {
    const input = JSON.parse(unit.input);
    return { code: 0, stdout: JSON.stringify(await executeRecovery(input, { command,
      uid: input.operation === 'gateway.socket-recover' ? 0 : uid })) + '\n' };
  });
  const audit = new ConfigAudit(stateDir);
  const trust = vi.fn(async (path: string) => path);
  const verbs = new ConfigVerbs({ stateDir, site: async () => site, runner, audit, trust, executable: '/opt/example/node', serviceEntry: '/opt/example/service-entry.js' });
  const request = (operation: string) => ({ requestId: randomUUID(), operation, params: {} });
  return { root, stateDir, markerPath, site, command, runner, audit, trust, verbs, request };
}

describe('fixed catalogue recoveries', () => {
  it.each(RECOVERY_OPERATIONS)('accepts %s only from the server with no free parameters', operation => {
    expect(parseOperation(operation, {}, 'server').ok).toBe(true);
    for (const params of [{ unit: 'other.service' }, { path: '/home/me/marker' }, { force: true }]) {
      expect(parseOperation(operation, params, 'server')).toEqual({ ok: false, code: 'invalid_parameters' });
    }
    expect(parseOperation(operation, {}, 'launcher')).toEqual({ ok: false, code: 'not_permitted' });
  });

  it.each(RECOVERY_OPERATIONS)('audits and durably deduplicates %s without a fictional Undo', async operation => {
    const f = await fixture(); const request = f.request(operation);
    const result = await f.verbs.apply(request, server);
    expect(configRecoveryResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ ok: true, recovered: true, operation });
    expect(result).not.toHaveProperty('undo');
    expect((await f.audit.rows()).find(row => row.id === request.requestId)).toMatchObject({ operation, result: 'ok', keys: [] });
    const reopened = new ConfigVerbs({ stateDir: f.stateDir, site: async () => f.site, audit: new ConfigAudit(f.stateDir), runner: f.runner, trust: f.trust });
    expect(await reopened.apply(request, server)).toEqual(result);
    expect(f.runner).toHaveBeenCalledOnce();
    if (operation === 'gateway.socket-recover') expect(f.command.mock.calls.map(call => call[0])).toEqual([
      ['systemctl', 'reset-failed', 'example-gateway.service', 'example-gateway.socket'],
      ['systemctl', 'restart', 'example-gateway.socket'],
      ['systemctl', 'show', 'example-gateway.socket', '-p', 'Id', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'Triggers'],
    ]);
    else {
      await expect(readFile(f.markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(f.command.mock.calls.every(call => call[0].join(' ') === `systemctl is-active ${DRAIN_UNIT}`)).toBe(true);
    }
  });

  it('confines recovery units to root service commands or marker-owner storage', async () => {
    const f = await fixture();
    const socket = recoveryUnit(f.site, 'gateway.socket-recover');
    expect(socket.argv).toContain('--uid=0'); expect(socket.argv).toContain('--property=RestrictAddressFamilies=AF_UNIX');
    expect(socket.argv).toContain('--property=ReadWritePaths=');
    const drain = recoveryUnit(f.site, 'hermes.drain-marker-remove');
    expect(drain.argv).toContain(`--uid=${uid}`);
    expect(drain.argv).toContain(`--property=ReadWritePaths="${f.root}"`);
  });

  it.each(RECOVERY_OPERATIONS)('refuses %s when writes, caller, target or executable trust disallow it', async operation => {
    const f = await fixture();
    f.site.configWrites = false;
    expect(await f.verbs.apply(f.request(operation), server)).toEqual({ ok: false, code: 'config_writes_off' });
    f.site.configWrites = true;
    for (const key of [{ ...server, scope: 'rescue' as const }, { ...server, name: 'launcher' }]) {
      expect(await f.verbs.apply(f.request(operation), key)).toEqual({ ok: false, code: 'not_permitted' });
    }
    expect(await f.verbs.apply({ ...f.request(operation), params: { force: true } }, server)).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(await f.verbs.apply({ ...f.request(operation), preconditions: { keys: [{ key: 0, exists: false }] } }, server))
      .toEqual({ ok: false, code: 'invalid_parameters' });
    f.trust.mockRejectedValueOnce(new Error('refused'));
    expect(await f.verbs.apply(f.request(operation), server)).toEqual({ ok: false, code: 'unsafe_target' });
    if (operation === 'gateway.socket-recover') delete f.site.targets['gateway-role-map']; else delete f.site.hermes;
    expect(await f.verbs.apply(f.request(operation), server)).toEqual({ ok: false, code: 'not_configured' });
    expect(f.runner).not.toHaveBeenCalled();
  });

  it('retains an uncertain audited outcome after interrupted recovery instead of running it again', async () => {
    const f = await fixture(); const request = f.request('gateway.socket-recover');
    f.runner.mockResolvedValueOnce({ code: 124, stdout: '' });
    const result = await f.verbs.apply(request, server);
    expect(result).toEqual({ ok: false, code: 'outcome_unknown', target: 'gateway-role-map', backupId: null });
    expect(await f.verbs.apply(request, server)).toEqual(result);
    expect(f.runner).toHaveBeenCalledOnce();
    expect((await f.audit.rows()).find(row => row.id === request.requestId)?.result).toBe('outcome_unknown');
  });

  it('rejects a success for a different recovery and target', async () => {
    const f = await fixture();
    f.runner.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ ok: true, recovered: true,
      operation: 'hermes.drain-marker-remove', target: 'hermes-config' }) });
    expect(await f.verbs.apply(f.request('gateway.socket-recover'), server)).toMatchObject({ ok: false, code: 'outcome_unknown' });
    expect(configWriteResultSchema.safeParse({ ok: true, recovered: true, operation: 'gateway.socket-recover', target: 'hermes-config' }).success).toBe(false);
  });

  it.each(['active', 'activating', 'deactivating', 'reloading'])('leaves a marker alone while the executor is %s', async state => {
    const f = await fixture();
    f.command.mockResolvedValue({ code: state === 'active' ? 0 : 3, stdout: state + '\n' });
    expect(await f.verbs.apply(f.request('hermes.drain-marker-remove'), server)).toEqual({ ok: false, code: 'busy' });
    expect(JSON.parse(await readFile(f.markerPath, 'utf8'))).toEqual(marker);
  });

  it('leaves foreign, malformed and replaced markers intact and refuses uncertain executor states', async () => {
    const f = await fixture(); const input = { mode: 'recovery', site: f.site, operation: 'hermes.drain-marker-remove' };
    for (const foreign of [{ ...marker, principal: 'other' }, { principal: 'wayroost' }]) {
      await writeFile(f.markerPath, JSON.stringify(foreign));
      expect(await executeRecovery(input, { command: f.command })).toEqual({ ok: false, code: 'precondition_changed' });
      expect(JSON.parse(await readFile(f.markerPath, 'utf8'))).toEqual(foreign);
    }
    await writeFile(f.markerPath, JSON.stringify(marker));
    f.command.mockResolvedValueOnce({ code: 4, stdout: '' });
    await expect(executeRecovery(input, { command: f.command })).rejects.toMatchObject({ code: 'unavailable' });
    const foreign = { ...marker, principal: 'other' };
    const drainIO: typeof fileDrainIO = target => {
      const io = fileDrainIO(target);
      const remove = io.removeMarker.bind(io);
      io.removeMarker = async at => { await writeFile(f.markerPath, JSON.stringify(foreign)); await remove(at); };
      return io;
    };
    await expect(executeRecovery(input, { command: f.command, drainIO })).rejects.toMatchObject({ code: 'verify_mismatch' });
    expect(JSON.parse(await readFile(f.markerPath, 'utf8'))).toEqual(foreign);
    await rm(f.markerPath); await symlink(join(f.root, 'foreign.json'), f.markerPath);
    await writeFile(join(f.root, 'foreign.json'), JSON.stringify(marker));
    expect(await executeRecovery(input, { command: f.command })).toEqual({ ok: false, code: 'precondition_changed' });
    expect(JSON.parse(await readFile(join(f.root, 'foreign.json'), 'utf8'))).toEqual(marker);
  });

  it('rechecks the executor immediately before removing a marker', async () => {
    const f = await fixture();
    f.command.mockResolvedValueOnce({ code: 3, stdout: 'inactive\n' }).mockResolvedValueOnce({ code: 0, stdout: 'active\n' });
    expect(await f.verbs.apply(f.request('hermes.drain-marker-remove'), server)).toEqual({ ok: false, code: 'busy' });
    expect(JSON.parse(await readFile(f.markerPath, 'utf8'))).toEqual(marker);
  });

  it('does not launch a recovery without a durable audit and keeps final audit failures uncertain', async () => {
    const f = await fixture();
    const reconcile = vi.spyOn(f.audit, 'reconcile').mockRejectedValueOnce(new Error('unavailable'));
    expect(await f.verbs.apply(f.request('gateway.socket-recover'), server)).toEqual({ ok: false, code: 'failed' });
    expect(f.runner).not.toHaveBeenCalled(); reconcile.mockRestore();
    const append = vi.spyOn(f.audit, 'append').mockRejectedValue(new Error('unavailable'));
    const request = f.request('gateway.socket-recover');
    expect(await f.verbs.apply(request, server)).toMatchObject({ ok: false, code: 'outcome_unknown', backupId: null });
    append.mockRestore();
    expect(await f.verbs.apply(request, server)).toMatchObject({ ok: false, code: 'outcome_unknown' });
    expect(f.runner).toHaveBeenCalledOnce();
  });

  it('shares the drain gate while marker recovery is pending', async () => {
    const f = await fixture();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const run = f.runner.getMockImplementation()!;
    f.runner.mockImplementationOnce(async unit => { entered(); await waiting; return run(unit); });
    const recovery = f.verbs.apply(f.request('hermes.drain-marker-remove'), server);
    await running;
    expect(await f.verbs.apply(f.request('hermes.drain-marker-remove'), server)).toEqual({ ok: false, code: 'busy' });
    expect(await f.verbs.drainRestart({ requestId: randomUUID(), component: 'hermes', when: 'idle' }, server)).toEqual({ ok: false, code: 'busy' });
    release();
    expect(await recovery).toMatchObject({ ok: true, recovered: true });
    expect(f.runner).toHaveBeenCalledOnce();
  });

  it('verifies the socket identity, active state and service association after restarting', async () => {
    const f = await fixture();
    for (const properties of ['Id=other.socket\nLoadState=loaded\nActiveState=active\nTriggers=example-gateway.service',
      'Id=example-gateway.socket\nLoadState=loaded\nActiveState=failed\nTriggers=example-gateway.service',
      'Id=example-gateway.socket\nLoadState=loaded\nActiveState=active\nTriggers=other.service']) {
      f.command.mockResolvedValueOnce({ code: 0, stdout: '' }).mockResolvedValueOnce({ code: 0, stdout: '' })
        .mockResolvedValueOnce({ code: 0, stdout: properties });
      await expect(executeRecovery({ mode: 'recovery', site: f.site, operation: 'gateway.socket-recover' }, { command: f.command, uid: 0 }))
        .rejects.toMatchObject({ code: 'verify_mismatch' });
    }
  });
});
