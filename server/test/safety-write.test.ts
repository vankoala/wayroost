import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkerApprovalsSetting, type SafetyDaemon } from '../src/paseo/safety-setting.js';
import { APPROVAL_TOOLS, applyApprovalsToMe, withRoleProviders } from '../src/paseo/safety-config.js';
import { apiHeaders, makeApp, makeKeys, makeToken, postHeaders } from './helpers.js';

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), writeFileSync: vi.fn(actual.writeFileSync), fsyncSync: vi.fn(actual.fsyncSync) };
});
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const roots: string[] = [];
afterEach(() => {
  vi.mocked(fs.renameSync).mockReset().mockImplementation(actual.renameSync);
  vi.mocked(fs.writeFileSync).mockReset().mockImplementation(actual.writeFileSync);
  vi.mocked(fs.fsyncSync).mockReset().mockImplementation(actual.fsyncSync);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(enabled = false) {
  const root = fs.mkdtempSync(join(tmpdir(), 'wayroost-safety-write-'));
  roots.push(root);
  const configPath = join(root, 'paseo-test.json');
  const statePath = join(root, 'worker-approvals.json');
  const baseline = withRoleProviders({ pi: { paseoTools: { disabledTools: ['kill_agent'] } } });
  const on = applyApprovalsToMe(baseline);
  fs.writeFileSync(configPath, JSON.stringify({ unrelated: 'demo-original', agents: { providers: enabled ? on.providers : baseline } }));
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, enabled, backup: enabled ? on.backup : {}, reloadPending: true }));
  const read = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const state = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const daemon: SafetyDaemon = {
    providers: vi.fn(async () => ['pi']), effectiveProviders: vi.fn(async () => read().agents.providers),
    reload: vi.fn(async () => ({ appliedPaths: ['agents.providers'], restartRequiredPaths: [], overrideControlledPaths: [] })),
  };
  return { root, configPath, statePath, read, state, daemon, setting: new WorkerApprovalsSetting(configPath, root, daemon) };
}

function largePolicyFixture() {
  const f = fixture();
  const ownerTool = `demo-owner-tool-${'x'.repeat(1_100_000)}`;
  const config = f.read();
  config.agents.providers.pi.paseoTools.disabledTools = [ownerTool];
  actual.writeFileSync(f.configPath, JSON.stringify(config));
  expect(fs.statSync(f.configPath).size).toBeLessThan(2 * 1024 * 1024);
  return { ...f, ownerTool };
}

it('checks cancellation immediately before publishing a prepared write', async () => {
  const f = fixture(true);
  const beforeConfig = fs.readFileSync(f.configPath);
  const beforeState = fs.readFileSync(f.statePath);
  const controller = new AbortController();
  vi.mocked(fs.writeFileSync).mockImplementationOnce((...args) => {
    actual.writeFileSync(...args);
    controller.abort();
  });
  await expect(f.setting.setEnabled(false, controller.signal)).rejects.toThrow();
  expect(fs.readFileSync(f.configPath)).toEqual(beforeConfig);
  expect(fs.readFileSync(f.statePath)).toEqual(beforeState);
  expect(fs.renameSync).not.toHaveBeenCalled();
  expect(f.daemon.reload).not.toHaveBeenCalled();
  expect(fs.readdirSync(f.root).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

it('keeps a large undo backup readable across status, cloud writes, restart and undo', async () => {
  const f = largePolicyFixture();
  expect(await f.setting.setEnabled(true)).toMatchObject({ enabled: true, config: 'written', reload: 'applied' });
  expect(fs.statSync(f.statePath).size).toBeGreaterThan(2 * 1024 * 1024);
  const restarted = new WorkerApprovalsSetting(f.configPath, f.root, f.daemon);
  expect(await restarted.reconcile()).toMatchObject({ enabled: true, config: 'written', reload: 'applied' });
  await restarted.setCloudAgentEnabled('codex', false);
  expect(await restarted.setEnabled(false)).toMatchObject({ enabled: false, config: 'written', reload: 'applied' });
  expect(f.read().agents.providers.pi.paseoTools.disabledTools).toEqual([f.ownerTool]);
  expect(f.read().agents.providers.codex.enabled).toBe(false);
  expect(f.state().backup).toEqual({});
  expect(await new WorkerApprovalsSetting(f.configPath, f.root, f.daemon).reconcile()).toMatchObject({ enabled: false, config: 'written' });
});

it.each([true, false])('recovers a large journal after a failed configuration sync (enabled=%s)', async enabled => {
  const f = largePolicyFixture();
  if (!enabled) await f.setting.setEnabled(true);
  let replaced = false;
  let failed = false;
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    actual.renameSync(from, to);
    if (to === f.configPath) replaced = true;
  });
  vi.mocked(fs.fsyncSync).mockImplementation(fd => {
    if (replaced && !failed) { failed = true; throw new Error('obviously-fake-ENOSPC'); }
    actual.fsyncSync(fd);
  });
  await expect(f.setting.setEnabled(enabled)).rejects.toThrow('ENOSPC');
  expect(failed).toBe(true);
  expect(f.state().prepared).toBeDefined();
  expect(fs.statSync(f.statePath).size).toBeGreaterThan(2 * 1024 * 1024);
  expect(await new WorkerApprovalsSetting(f.configPath, f.root, f.daemon).reconcile()).toMatchObject({ enabled, config: 'written', reload: 'applied' });
  expect(f.state().prepared).toBeUndefined();
  expect(f.read().agents.providers.pi.paseoTools.disabledTools).toEqual([f.ownerTool, ...(enabled ? APPROVAL_TOOLS : [])]);
  if (enabled) await new WorkerApprovalsSetting(f.configPath, f.root, f.daemon).setEnabled(false);
  expect(f.read().agents.providers.pi.paseoTools.disabledTools).toEqual([f.ownerTool]);
  expect(fs.readdirSync(f.root).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

it.each(['safety', 'cloud'])('rejects serialized config growth before replacing the %s config', async writer => {
  const f = fixture();
  const config = f.read();
  config.unrelated = '';
  const available = 2 * 1024 * 1024 - 64 - Buffer.byteLength(JSON.stringify(config));
  config.unrelated = 'é'.repeat(Math.floor(available / 2));
  const before = JSON.stringify(config);
  const beforeState = fs.readFileSync(f.statePath, 'utf8');
  actual.writeFileSync(f.configPath, before);
  expect(Buffer.byteLength(before)).toBeLessThan(2 * 1024 * 1024);
  expect(Buffer.byteLength(JSON.stringify(config, null, 2))).toBeGreaterThan(2 * 1024 * 1024);
  await expect(writer === 'safety' ? f.setting.setEnabled(true) : f.setting.setCloudAgentEnabled('codex', false)).rejects.toThrow(/2 MiB/);
  expect(revision(fs.readFileSync(f.configPath, 'utf8'))).toBe(revision(before));
  expect(f.state()).toMatchObject({ enabled: false, backup: {} });
  expect(f.state().prepared).toBeUndefined();
  if (writer === 'safety') expect(fs.readFileSync(f.statePath, 'utf8')).toBe(beforeState);
  expect(f.daemon.reload).not.toHaveBeenCalled();
  expect(vi.mocked(fs.renameSync).mock.calls.some(([, to]) => to === f.configPath)).toBe(false);
  expect(fs.readdirSync(f.root).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

it('rejects oversized UTF-8 recovery state before replacing config or its existing undo records', async () => {
  const f = fixture();
  const config = f.read();
  config.agents.providers['demo-plugin'] = { demo: 'demo-owner-plugin' };
  actual.writeFileSync(f.configPath, JSON.stringify(config));
  const state = { ...f.state(), backup: { 'demo-plugin': {
    entry: 'existing', before: { disabledTools: [`demo-old-tool-${'é'.repeat(2_850_000)}`] },
    applied: { disabledTools: ['demo-applied-tool'] },
  } } };
  actual.writeFileSync(f.statePath, JSON.stringify(state));
  const beforeConfig = fs.readFileSync(f.configPath, 'utf8');
  const beforeState = fs.readFileSync(f.statePath, 'utf8');
  await expect(f.setting.setEnabled(true)).rejects.toThrow(/16 MiB/);
  expect(revision(fs.readFileSync(f.configPath, 'utf8'))).toBe(revision(beforeConfig));
  expect(revision(fs.readFileSync(f.statePath, 'utf8'))).toBe(revision(beforeState));
  expect(f.daemon.reload).not.toHaveBeenCalled();
  expect(fs.readdirSync(f.root).filter(name => name.endsWith('.tmp'))).toEqual([]);
  expect(await new WorkerApprovalsSetting(f.configPath, f.root, f.daemon).reconcile()).toMatchObject({ enabled: false, config: 'written', reload: 'applied' });
  expect(revision(JSON.stringify(f.state().backup))).toBe(revision(JSON.stringify(state.backup)));
});

it.each([true, false])('retries an owner edit before the final revision check and preserves it on undo (%s)', async enabled => {
  const f = fixture(!enabled);
  let edited = false;
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    if (to === f.statePath && !edited) {
      const config = f.read();
      config.unrelated = 'demo-owner-edit';
      config.agents.providers.pi.paseoTools.disabledTools.push('create_terminal', ...(enabled ? ['update_agent'] : []));
      actual.writeFileSync(f.configPath, JSON.stringify(config));
      edited = true;
    }
    actual.renameSync(from, to);
  });
  expect(await f.setting.setEnabled(enabled)).toMatchObject({ enabled, config: 'written', reload: 'applied', application: 'partial' });
  expect(edited).toBe(true);
  expect(f.read().unrelated).toBe('demo-owner-edit');
  expect(f.read().agents.providers.pi.paseoTools.disabledTools).toContain('create_terminal');
  expect(f.state().prepared).toBeUndefined();
  await new WorkerApprovalsSetting(f.configPath, f.root, f.daemon).setEnabled(false);
  expect(f.read().agents.providers.pi.paseoTools.disabledTools).toEqual(['kill_agent', 'create_terminal', ...(enabled ? ['update_agent'] : [])]);
  expect(fs.readdirSync(f.root).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

it('rechecks metadata even when the content hash is unchanged', async () => {
  const f = fixture();
  let prepared = 0;
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    actual.renameSync(from, to);
    if (to !== f.statePath || !f.state().prepared) return;
    if (++prepared === 1) actual.utimesSync(f.configPath, 1, 1);
  });
  expect(await f.setting.setEnabled(true)).toMatchObject({ config: 'written', reload: 'applied' });
  expect(prepared).toBe(2);
});

it('bounds revision retries, retains the choice and original backup, and returns conflict', async () => {
  const f = fixture();
  const backup = f.state().backup;
  let edits = 0;
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    actual.renameSync(from, to);
    if (to !== f.statePath || !f.state().prepared) return;
    actual.writeFileSync(f.configPath, JSON.stringify({ ...f.read(), unrelated: `demo-edit-${++edits}` }));
  });
  expect(await f.setting.setEnabled(true)).toMatchObject({ enabled: true, config: 'pending', reload: 'pending', application: 'pending', message: expect.stringContaining('conflict') });
  expect(edits).toBe(3);
  expect(f.read().unrelated).toBe('demo-edit-3');
  expect(f.state()).toMatchObject({ enabled: true, backup, reloadPending: true });
  expect(f.state().prepared).toBeUndefined();
  expect(f.daemon.reload).not.toHaveBeenCalled();
  expect(fs.renameSync).not.toHaveBeenCalledWith(expect.anything(), f.configPath);
});

it.each([true, false].flatMap(enabled => ['unrelated', 'policy', 'missing'].map(change => ({ enabled, change }))))('returns conflict and keeps the undo backup after writing %j', async ({ enabled, change }) => {
  const f = fixture(!enabled);
  let edited = false;
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    actual.renameSync(from, to);
    if (to !== f.configPath || edited) return;
    edited = true;
    if (change === 'missing') { actual.unlinkSync(f.configPath); return; }
    const config = f.read();
    if (change === 'unrelated') config.unrelated = 'demo-post-write-edit';
    else config.agents.providers.pi.paseoTools.disabledTools = ['kill_agent', ...(!enabled ? APPROVAL_TOOLS : [])];
    actual.writeFileSync(f.configPath, JSON.stringify(config));
  });
  expect(await f.setting.setEnabled(enabled)).toMatchObject({ enabled, config: 'pending', reload: 'pending', application: 'pending', message: expect.stringContaining('conflict') });
  expect(edited).toBe(true);
  expect(f.state().backup.pi.before.disabledTools).toEqual(['kill_agent']);
  expect(f.state().reloadPending).toBe(true);
  expect(f.daemon.reload).not.toHaveBeenCalled();
  if (change === 'missing') return;
  expect(await f.setting.reconcile()).toMatchObject({ config: 'written', reload: 'applied' });
  expect(f.read().agents.providers.pi.paseoTools.disabledTools).toEqual(['kill_agent', ...(enabled ? APPROVAL_TOOLS : [])]);
  if (!enabled) expect(f.state().backup).toEqual({});
  if (change === 'unrelated') expect(f.read().unrelated).toBe('demo-post-write-edit');
});

it('returns an unconfirmed API response for a post-write conflict, then verifies recovery', async () => {
  const f = fixture();
  let edited = false;
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    actual.renameSync(from, to);
    if (to !== f.configPath || edited) return;
    edited = true;
    actual.writeFileSync(f.configPath, JSON.stringify({ ...f.read(), unrelated: 'demo-api-owner-edit' }));
  });
  const keys = await makeKeys();
  const { app } = await makeApp(keys, { workerApprovals: f.setting });
  try {
    const token = await makeToken(keys);
    const response = await app.inject({ method: 'PUT', url: '/api/worker-approvals', headers: postHeaders(token), payload: { enabled: true } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enabled: true, config: 'pending', reload: 'pending', application: 'pending', message: expect.stringContaining('conflict') });
    expect(f.daemon.reload).not.toHaveBeenCalled();
    expect(f.state().backup.pi.before.disabledTools).toEqual(['kill_agent']);
    const recovered = await app.inject({ url: '/api/worker-approvals', headers: apiHeaders(token) });
    expect(recovered.json()).toMatchObject({ enabled: true, config: 'written', reload: 'applied', application: 'partial' });
    expect(f.read().unrelated).toBe('demo-api-owner-edit');
  } finally { await app.close(); }
});

it('serializes separate helpers through flock and reloads fresh state after acquisition', async () => {
  const f = fixture();
  const second = new WorkerApprovalsSetting(f.configPath, f.root, f.daemon);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(f.daemon.reload).mockImplementationOnce(async () => {
    await gate;
    return { appliedPaths: ['agents.providers'], restartRequiredPaths: [], overrideControlledPaths: [] };
  });
  const on = f.setting.setEnabled(true);
  await vi.waitFor(() => expect(f.daemon.reload).toHaveBeenCalledOnce());
  const off = second.setEnabled(false);
  expect(spawnSync('/usr/bin/flock', ['--nonblock', `${f.configPath}.wayroost.lock`, '/bin/true']).status).toBe(1);
  expect(f.daemon.providers).toHaveBeenCalledOnce();
  release();
  expect(await on).toMatchObject({ enabled: true, config: 'written', reload: 'applied' });
  expect(await off).toMatchObject({ enabled: false, config: 'written', reload: 'applied' });
  expect(f.read().agents.providers.pi.paseoTools.disabledTools).toEqual(['kill_agent']);
  expect(f.state()).toMatchObject({ enabled: false, backup: {}, reloadPending: false });
  expect(f.daemon.providers).toHaveBeenCalledTimes(2);
});

it.each([true, false])('checks the disk revision after persisting reload success (%s)', async enabled => {
  const f = fixture(enabled);
  let edited = false;
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    actual.renameSync(from, to);
    if (to !== f.statePath || edited || f.state().reloadPending) return;
    edited = true;
    actual.writeFileSync(f.configPath, JSON.stringify({ ...f.read(), unrelated: 'demo-owner-edit' }));
  });
  expect(await f.setting.reconcile()).toMatchObject({ enabled, config: 'pending', reload: 'pending', application: 'pending' });
  expect(edited).toBe(true);
  expect(f.state().reloadPending).toBe(true);
  expect(f.read().unrelated).toBe('demo-owner-edit');
  expect(await f.setting.reconcile()).toMatchObject({ enabled, config: 'written', reload: 'applied', application: 'partial' });
});

it.each(['prepare', 'rename', 'sync'])('preserves config and undo records if the private state write fails during %s', async phase => {
  const f = fixture(true);
  const before = fs.readFileSync(f.configPath, 'utf8');
  const backup = f.state().backup;
  if (phase === 'prepare') vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw new Error('obviously-fake-ENOSPC'); });
  if (phase === 'rename') vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('obviously-fake-ENOSPC'); });
  if (phase === 'sync') vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error('obviously-fake-ENOSPC'); });
  await expect(f.setting.setEnabled(false)).rejects.toThrow('ENOSPC');
  expect(fs.readFileSync(f.configPath, 'utf8')).toBe(before);
  expect(f.state().backup).toEqual(backup);
  expect(fs.readdirSync(f.root).filter(name => name.endsWith('.tmp'))).toEqual([]);
  expect(f.daemon.reload).not.toHaveBeenCalled();
  expect(await f.setting.setEnabled(false)).toMatchObject({ enabled: false, config: 'written' });
});

it.each(['prepare', 'rename', 'sync'])('recovers a failed config write during %s with the correct backup', async phase => {
  const f = fixture(true);
  const backup = f.state().backup;
  let hit = false;
  vi.mocked(fs.writeFileSync).mockImplementation((path, ...args) => {
    if (phase === 'prepare' && typeof path === 'number' && String(args[0]).includes('demo-original')) {
      hit = true;
      throw new Error('obviously-fake-ENOSPC');
    }
    Reflect.apply(actual.writeFileSync, actual, [path, ...args]);
  });
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    if (to === f.configPath) {
      hit = true;
      if (phase === 'rename') throw new Error('obviously-fake-ENOSPC');
    }
    actual.renameSync(from, to);
  });
  vi.mocked(fs.fsyncSync).mockImplementation(fd => {
    if (phase === 'sync' && hit) throw new Error('obviously-fake-ENOSPC');
    actual.fsyncSync(fd);
  });
  await expect(f.setting.setEnabled(false)).rejects.toThrow('ENOSPC');
  expect(hit).toBe(true);
  expect(f.state().backup).toEqual(backup);
  if (phase === 'sync') expect(f.state().prepared.committedBackup).toEqual({});
  else expect(f.state().prepared).toBeUndefined();
  vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync);
  vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
  vi.mocked(fs.fsyncSync).mockImplementation(actual.fsyncSync);
  expect(await new WorkerApprovalsSetting(f.configPath, f.root, f.daemon).reconcile()).toMatchObject({ enabled: false, config: 'written', reload: 'applied' });
  expect(f.state().backup).toEqual({});
  expect(f.read().agents.providers.pi.paseoTools.disabledTools).toEqual(['kill_agent']);
});

it.each(['prepare', 'rename', 'sync'])('recovers the journal if committing the private state fails during %s', async phase => {
  const f = fixture(true);
  let replaced = false;
  let failed = false;
  const fail = () => { failed = true; throw new Error('obviously-fake-ENOSPC'); };
  vi.mocked(fs.writeFileSync).mockImplementation((path, ...args) => {
    if (phase === 'prepare' && replaced && !failed) fail();
    Reflect.apply(actual.writeFileSync, actual, [path, ...args]);
  });
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    if (phase === 'rename' && to === f.statePath && replaced && !failed) fail();
    actual.renameSync(from, to);
    if (to === f.configPath) replaced = true;
  });
  vi.mocked(fs.fsyncSync).mockImplementation(fd => {
    if (phase === 'sync' && replaced && !failed && actual.fstatSync(fd).isFile()) fail();
    actual.fsyncSync(fd);
  });
  await expect(f.setting.setEnabled(false)).rejects.toThrow('ENOSPC');
  expect(failed).toBe(true);
  expect(f.read().agents.providers.pi.paseoTools.disabledTools).toEqual(['kill_agent']);
  expect(f.state().prepared).toBeDefined();
  expect(await new WorkerApprovalsSetting(f.configPath, f.root, f.daemon).reconcile()).toMatchObject({ enabled: false, config: 'written', reload: 'applied' });
  expect(f.state()).toMatchObject({ enabled: false, backup: {}, reloadPending: false });
  expect(f.state().prepared).toBeUndefined();
  expect(fs.statSync(f.configPath).mode & 0o777).toBe(0o600);
});

const revision = (contents: string) => createHash('sha256').update(contents).digest('hex');
it.each(['before', 'after'])('recovers a legacy journal matching the %s content revision', async phase => {
  const f = fixture(false);
  const contents = fs.readFileSync(f.configPath, 'utf8');
  const previousBackup = {};
  const committedBackup = applyApprovalsToMe(withRoleProviders({ pi: { paseoTools: { disabledTools: ['kill_agent'] } } })).backup;
  const prepared = { beforeRevision: revision(phase === 'before' ? contents : 'demo-before'), afterRevision: revision(phase === 'after' ? contents : 'demo-after'), previousBackup, committedBackup };
  fs.writeFileSync(f.statePath, JSON.stringify({ ...f.state(), enabled: false, prepared }));
  expect(await new WorkerApprovalsSetting(f.configPath, f.root, f.daemon).reconcile()).toMatchObject({ enabled: false, config: 'written', reload: 'applied' });
  expect(f.state().backup).toEqual({});
  expect(f.state().prepared).toBeUndefined();
  expect(f.read().agents.providers.pi.paseoTools.disabledTools).toEqual(['kill_agent']);
});

it('retains an ambiguous legacy journal and owner config for manual recovery', async () => {
  const f = fixture();
  const prepared = { beforeRevision: revision('demo-before'), afterRevision: revision('demo-after'), previousBackup: {}, committedBackup: {} };
  fs.writeFileSync(f.statePath, JSON.stringify({ ...f.state(), prepared }));
  const before = fs.readFileSync(f.configPath, 'utf8');
  const journal = fs.readFileSync(f.statePath, 'utf8');
  await expect(new WorkerApprovalsSetting(f.configPath, f.root, f.daemon).setEnabled(true)).rejects.toThrow(/unconfirmed.*config changed/i);
  expect(fs.readFileSync(f.configPath, 'utf8')).toBe(before);
  expect(fs.readFileSync(f.statePath, 'utf8')).toBe(journal);
  expect(f.daemon.reload).not.toHaveBeenCalled();
});

it('serializes a cloud switch with Safety, preserving limits, undo records and owner edits', async () => {
  const f = fixture();
  const cloudWriter = new WorkerApprovalsSetting(f.configPath, f.root, f.daemon);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(f.daemon.reload).mockImplementationOnce(async () => {
    await gate;
    return { appliedPaths: ['agents.providers'], restartRequiredPaths: [], overrideControlledPaths: [] };
  });
  const on = f.setting.setEnabled(true);
  await vi.waitFor(() => expect(f.daemon.reload).toHaveBeenCalledOnce());
  const switched = cloudWriter.setCloudAgentEnabled('codex', false);
  expect(spawnSync('/usr/bin/flock', ['--nonblock', `${f.configPath}.wayroost.lock`, '/bin/true']).status).toBe(1);
  release();
  await on;
  const backup = f.state().backup;
  await switched;
  expect(f.read().unrelated).toBe('demo-original');
  expect(f.read().agents.providers.codex).toMatchObject({ enabled: false, paseoTools: { disabledTools: [...APPROVAL_TOOLS] } });
  expect(f.state().backup).toEqual(backup);
  expect(await f.setting.reconcile()).toMatchObject({ enabled: true, config: 'written', reload: 'applied' });
  expect(f.read().agents.providers.codex.enabled).toBe(false);
  await f.setting.setEnabled(false);
  expect(f.read().agents.providers.codex).toEqual({ enabled: false });
});

it('retries cloud switches from fresh owner content and verifies the daemon flag', async () => {
  const f = fixture(true);
  let edited = false;
  vi.mocked(fs.writeFileSync).mockImplementation((path, ...args) => {
    Reflect.apply(actual.writeFileSync, actual, [path, ...args]);
    if (typeof path !== 'number' || !String(args[0]).includes('demo-original') || edited) return;
    edited = true;
    actual.writeFileSync(f.configPath, JSON.stringify({ ...f.read(), unrelated: 'demo-cloud-owner-edit' }));
  });
  await f.setting.setCloudAgentEnabled('codex', false);
  expect(f.read().unrelated).toBe('demo-cloud-owner-edit');
  expect(f.read().agents.providers.codex.enabled).toBe(false);
  const backup = f.state().backup;
  vi.mocked(f.daemon.effectiveProviders).mockResolvedValue({ ...f.read().agents.providers, codex: { enabled: false } });
  await expect(f.setting.setCloudAgentEnabled('codex', true)).rejects.toThrow(/changed while verifying/);
  expect(f.state()).toMatchObject({ backup, reloadPending: true });
});

it('keeps cloud switches unconfirmed after a post-write owner edit', async () => {
  const f = fixture(true);
  const backup = f.state().backup;
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    actual.renameSync(from, to);
    if (to === f.configPath) actual.writeFileSync(f.configPath, JSON.stringify({ ...f.read(), unrelated: 'demo-cloud-conflict' }));
  });
  await expect(f.setting.setCloudAgentEnabled('codex', false)).rejects.toThrow('conflict');
  expect(f.state()).toMatchObject({ backup, reloadPending: true });
  expect(f.daemon.reload).not.toHaveBeenCalled();
});

it('bounds cloud revision retries without losing the owner config or Safety backup', async () => {
  const f = fixture(true);
  const backup = f.state().backup;
  let edits = 0;
  vi.mocked(fs.writeFileSync).mockImplementation((path, ...args) => {
    Reflect.apply(actual.writeFileSync, actual, [path, ...args]);
    if (typeof path !== 'number' || !String(args[0]).includes('unrelated')) return;
    actual.writeFileSync(f.configPath, JSON.stringify({ ...f.read(), unrelated: `demo-cloud-edit-${++edits}` }));
  });
  await expect(f.setting.setCloudAgentEnabled('codex', false)).rejects.toThrow('all three attempts');
  expect(edits).toBe(3);
  expect(f.read().unrelated).toBe('demo-cloud-edit-3');
  expect(f.read().agents.providers.codex.enabled).toBeUndefined();
  expect(f.state()).toMatchObject({ backup, reloadPending: true });
  expect(f.daemon.reload).not.toHaveBeenCalled();
});
