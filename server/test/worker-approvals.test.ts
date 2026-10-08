import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerApprovalsSetting, type SafetyDaemon } from '../src/paseo/safety-setting.js';
import { APPROVAL_TOOLS, applyApprovalsToMe, undoApprovalsToMe, withRoleProviders, type Providers } from '../src/paseo/safety-config.js';
import { pendingWorkerApprovals } from '../../shared/safety.js';
import { buildApp } from '../src/app.js';
import { EventHub } from '../src/hub.js';
import { FakeHermes, FakePaseo, PHONE_COOKIE, apiHeaders, makeApp, makeConfig, makeKeys, makeToken, postHeaders } from './helpers.js';

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(providers: Providers = {}, enabled = true, applied = true) {
  const root = mkdtempSync(join(tmpdir(), 'wayroost-safety-test-'));
  roots.push(root);
  const path = join(root, 'paseo-test.json');
  // Start with either an installed policy or a fresh owner configuration.
  const on = applyApprovalsToMe(withRoleProviders(providers));
  const savedProviders = applied ? enabled ? on.providers : withRoleProviders(providers) : providers;
  let effective = structuredClone(savedProviders);
  const load = () => { effective = structuredClone(config().agents.providers); };
  const daemon: SafetyDaemon = {
    providers: vi.fn(async () => Object.keys(providers)),
    effectiveProviders: vi.fn(async () => structuredClone(effective)),
    reload: vi.fn(async () => {
      const appliedPaths = isDeepStrictEqual(effective, config().agents.providers) ? [] : ['agents.providers'];
      load();
      return { appliedPaths, restartRequiredPaths: [], overrideControlledPaths: [] };
    }),
  };
  writeFileSync(path, JSON.stringify({ version: 1, unrelated: { keep: true }, agents: { extra: 'keep', providers: savedProviders } }), { mode: 0o600 });
  if (applied) writeFileSync(join(root, 'worker-approvals.json'), JSON.stringify({ version: 1, enabled, backup: enabled ? on.backup : {}, reloadPending: true }), { mode: 0o600 });
  const setting = new WorkerApprovalsSetting(path, root, daemon);
  const config = () => JSON.parse(readFileSync(path, 'utf8'));
  const edit = (providers: Providers) => writeFileSync(path, JSON.stringify({ ...config(), agents: { ...config().agents, providers } }));
  const state = () => JSON.parse(readFileSync(join(root, 'worker-approvals.json'), 'utf8'));
  const ownerApply = (enabled: boolean) => {
    const roles = withRoleProviders(config().agents.providers);
    edit(enabled ? applyApprovalsToMe(roles, state().backup).providers : withRoleProviders(undoApprovalsToMe(roles, state().backup)));
  };
  const ownerApplyAndSelect = (enabled: boolean) => {
    ownerApply(enabled);
    return setting.setEnabled(enabled);
  };
  return { root, path, daemon, setting, config, edit, state, load, ownerApply, ownerApplyAndSelect };
}

it('inspects Safety status without writing or reloading, before and after policy drift', async () => {
  const f = fixture({}, true, false);
  const before = readFileSync(f.path, 'utf8');
  expect(await f.setting.status()).toMatchObject({ choiceConfirmed: true, application: 'pending', config: 'pending' });
  expect(readFileSync(f.path, 'utf8')).toBe(before);
  expect(readdirSync(f.root)).toEqual(['paseo-test.json']);
  expect(f.daemon.reload).not.toHaveBeenCalled();
});

it('reads settled and drifted Safety policy without updating files or retrying reload', async () => {
  const f = fixture();
  await f.setting.setEnabled(true);
  const files = () => readdirSync(f.root).sort().map(name => [name, readFileSync(join(f.root, name), 'utf8')]);
  const before = files();
  vi.mocked(f.daemon.reload).mockClear();
  expect(await f.setting.status()).toMatchObject({ reload: 'applied', application: 'partial' });
  vi.mocked(f.daemon.effectiveProviders).mockResolvedValue({});
  expect(await f.setting.status()).toMatchObject({ reload: 'pending', application: 'pending' });
  expect(files()).toEqual(before);
  expect(f.daemon.reload).not.toHaveBeenCalled();
});

it.each(['providers', 'effectiveProviders'] as const)('does not confirm a pure status read when files change during %s', async phase => {
  for (const target of ['state', 'config', 'missing state'] as const) {
    const f = fixture({}, true, target !== 'missing state');
    // A fresh unapplied config needs no live policy read; install a matching
    // policy without state to exercise creation across the final await.
    if (target === 'missing state') f.edit(applyApprovalsToMe(withRoleProviders({})).providers);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const delayed = new Promise<void>(resolve => { release = resolve; });
    const oldPolicy = structuredClone(f.config().agents.providers);
    const wait = async () => { entered(); await delayed; };
    if (phase === 'providers') vi.mocked(f.daemon.providers).mockImplementationOnce(async () => { await wait(); return []; });
    else vi.mocked(f.daemon.effectiveProviders).mockImplementationOnce(async () => { await wait(); return oldPolicy; });
    const read = f.setting.status();
    await started;
    if (target === 'config') f.edit({ ...f.config().agents.providers, pi: { paseoTools: { enabled: false } } });
    else writeFileSync(join(f.root, 'worker-approvals.json'), JSON.stringify({ version: 1, enabled: false, backup: {}, reloadPending: true }));
    const files = () => readdirSync(f.root).sort().map(name => [name, readFileSync(join(f.root, name), 'utf8'), statSync(join(f.root, name)).mtimeMs]);
    const afterWriter = files();
    release();
    expect(await read).toMatchObject({ choiceConfirmed: false, config: 'pending', reload: 'pending', application: 'pending' });
    expect(files()).toEqual(afterWriter);
    expect(f.daemon.reload).not.toHaveBeenCalled();
  }
});

describe('owner-side worker approval policy', () => {
  it('defaults on and writes the approval guardrail into the fake daemon', async () => {
    const f = fixture({ codex: { paseoTools: { disabledTools: ['kill_agent'] } } }, true, false);
    const before = readFileSync(f.path, 'utf8');
    expect(await f.setting.reconcile()).toMatchObject({ enabled: true, application: 'partial', config: 'written', reload: 'applied' });
    expect(readFileSync(f.path, 'utf8')).not.toBe(before);
    expect(f.config().unrelated).toEqual({ keep: true });
    expect(f.config().agents.extra).toBe('keep');
    expect(f.config().agents.providers.codex.paseoTools.disabledTools).toEqual(['kill_agent', ...APPROVAL_TOOLS]);
    expect(await f.daemon.effectiveProviders()).toEqual(f.config().agents.providers);
    expect(f.state()).toMatchObject({ enabled: true, reloadPending: false });
    expect(f.state().backup.codex.before.disabledTools).toEqual(['kill_agent']);
    expect(statSync(join(f.root, 'worker-approvals.json')).mode & 0o777).toBe(0o600);
    expect(f.daemon.reload).toHaveBeenCalledOnce();
  });

  it('restores legacy backups and keeps later owner restrictions when disabling', async () => {
    const f = fixture({ codex: { paseoTools: { disabledTools: ['update_agent', 'kill_agent'] } } });
    await f.setting.reconcile();
    f.edit({ ...f.config().agents.providers, codex: { order: 3, paseoTools: { disabledTools: [...f.config().agents.providers.codex.paseoTools.disabledTools, 'create_terminal'] } } });
    const restarted = new WorkerApprovalsSetting(f.path, f.root, f.daemon);
    expect(await restarted.setEnabled(false)).toMatchObject({ enabled: false, config: 'written', reload: 'applied' });
    expect(f.config().agents.providers.codex).toEqual({ order: 3, paseoTools: { disabledTools: ['update_agent', 'kill_agent', 'create_terminal'] } });
    expect(f.state().backup).toEqual({});
    expect(await new WorkerApprovalsSetting(f.path, f.root, f.daemon).reconcile()).toMatchObject({ enabled: false, config: 'written' });
    expect(f.config().agents.providers['coder-worker'].paseoTools.enabled).toBe(false);
    expect(f.config().agents.providers.reviewer.paseoTools.enabled).toBe(false);
  });

  it.each([true, false])('applies policy to new providers and repairs role edits (enabled=%s)', async enabled => {
    const f = fixture({}, enabled);
    await f.setting.reconcile();
    f.edit({ ...f.config().agents.providers, 'demo-extra': { extends: 'pi', label: 'Demo extra', paseoTools: { disabledTools: ['kill_agent'] } }, reviewer: { extends: 'pi', label: 'Demo reviewer', paseoTools: { enabled: true } } });
    expect(await f.setting.reconcile()).toMatchObject({ enabled, config: 'written', reload: 'applied' });
    expect(f.config().agents.providers['demo-extra'].paseoTools.disabledTools).toEqual(['kill_agent', ...(enabled ? APPROVAL_TOOLS : [])]);
    expect(f.config().agents.providers.reviewer).toMatchObject({ label: 'Demo reviewer', paseoTools: { enabled: false } });
    expect(await f.daemon.effectiveProviders()).toEqual(f.config().agents.providers);
  });

  it('reports plugin providers as uncovered without creating conflicting entries', async () => {
    const f = fixture({ 'demo-plugin': { paseoTools: { enabled: true }, extra: 'keep' } }, true, false);
    vi.mocked(f.daemon.providers).mockResolvedValue(['pi', 'demo-plugin', 'coder-worker']);
    const result = await f.setting.reconcile();
    expect(result.uncoveredProviders).toEqual(['demo-plugin', 'coder-worker']);
    expect(f.config().agents.providers['demo-plugin']).toEqual({ paseoTools: { enabled: true }, extra: 'keep' });
    expect(f.config().agents.providers['coder-worker']).toBeUndefined();
  });

  it.each([true, false])('leaves a plugin without a config entry uncovered (enabled=%s)', async enabled => {
    const f = fixture({}, enabled, false);
    vi.mocked(f.daemon.providers).mockResolvedValue(['pi', 'example-plugin']);
    const result = await f.setting.setEnabled(enabled);
    expect(result).toMatchObject({ enabled, application: 'partial', uncoveredProviders: ['example-plugin'] });
    expect(f.config().agents.providers).not.toHaveProperty('example-plugin');
    expect(f.state().backup).not.toHaveProperty('example-plugin');
    expect(await f.daemon.effectiveProviders()).not.toHaveProperty('example-plugin');
  });

  it('uses Paseo validation for custom entries and leaves invalid plugin overrides untouched', async () => {
    const f = fixture({ 'demo-plugin': { extends: 'unsupported', label: 'Demo plugin', extra: 'keep' }, 'demo-acp': { extends: 'acp', label: 'Demo ACP' } }, true, false);
    expect((await f.setting.reconcile()).uncoveredProviders).toEqual(['demo-plugin', 'demo-acp']);
    expect(f.config().agents.providers['demo-plugin']).toEqual({ extends: 'unsupported', label: 'Demo plugin', extra: 'keep' });
    expect(f.config().agents.providers['demo-acp']).toEqual({ extends: 'acp', label: 'Demo ACP' });
  });

  it.each([true, false])('retains an uncovered provider backup across reconciliation and restart (enabled=%s)', async enabled => {
    const f = fixture({ 'demo-extra': { extends: 'pi', label: 'Demo extra' } });
    const backup = f.state().backup;
    f.edit({ ...f.config().agents.providers, 'demo-extra': { ...f.config().agents.providers['demo-extra'], extends: 'unsupported' } });
    await f.setting.setEnabled(enabled);
    await new WorkerApprovalsSetting(f.path, f.root, f.daemon).reconcile();
    expect(f.state().backup).toEqual(enabled ? backup : { 'demo-extra': backup['demo-extra'] });
    expect(f.config().agents.providers['demo-extra'].extends).toBe('unsupported');
  });

  it('reports failed reloads, retries them, and never claims complete enforcement', async () => {
    const f = fixture();
    vi.mocked(f.daemon.reload).mockRejectedValueOnce(new Error('obviously-fake-reload-failure'));
    expect(await f.setting.reconcile()).toMatchObject({ application: 'pending', config: 'pending', reload: 'failed' });
    expect(f.state().reloadPending).toBe(true);
    const result = await f.setting.reconcile();
    expect(result).toMatchObject({ application: 'partial', reload: 'applied' });
    expect(result.limitations).toEqual(expect.arrayContaining(['existing_agents', 'caller_identity', 'same_user_config', 'cli_guard_not_installed']));
    expect(f.state().reloadPending).toBe(false);
  });

  it.each([true, false])('leaves confirmation pending after an owner edit during reload (enabled=%s)', async enabled => {
    const f = fixture({ pi: { paseoTools: { disabledTools: ['kill_agent'] } } });
    await f.ownerApplyAndSelect(!enabled);
    let edited!: Providers;
    vi.mocked(f.daemon.reload).mockImplementationOnce(async () => {
      edited = { ...f.config().agents.providers, pi: { label: 'Demo owner edit', paseoTools: { disabledTools: ['kill_agent', 'create_terminal', ...(!enabled ? APPROVAL_TOOLS : [])] } } };
      f.edit(edited);
      f.load();
      return { appliedPaths: ['agents.providers'], restartRequiredPaths: [], overrideControlledPaths: [] };
    });

    expect(await f.ownerApplyAndSelect(enabled)).toMatchObject({ enabled, config: 'pending', reload: 'pending', application: 'pending' });
    expect(f.config().agents.providers).toEqual(edited);
    expect(await f.daemon.effectiveProviders()).toEqual(edited);
    expect(f.state().reloadPending).toBe(true);
    expect(await f.setting.reconcile()).toMatchObject({ enabled, config: 'written', reload: 'applied' });
    f.ownerApply(enabled);
    expect(await f.setting.reconcile()).toMatchObject({ enabled, config: 'written', reload: 'applied', application: 'partial' });
    expect(f.config().agents.providers.pi).toMatchObject({ label: 'Demo owner edit', paseoTools: { disabledTools: ['kill_agent', 'create_terminal', ...APPROVAL_TOOLS] } });
  });

  it.each([true, false])('checks disk after the final awaited policy read on a settled setting (enabled=%s)', async enabled => {
    const f = fixture({ pi: { paseoTools: { disabledTools: ['kill_agent'] } } });
    await f.ownerApplyAndSelect(enabled);
    const saved = f.config().agents.providers;
    let edited!: Providers;
    vi.mocked(f.daemon.reload).mockClear();
    vi.mocked(f.daemon.effectiveProviders).mockImplementation(async () => {
      const snapshot = structuredClone(saved);
      await Promise.resolve();
      edited = { ...saved, pi: { label: 'Demo owner edit', paseoTools: { disabledTools: ['kill_agent', 'create_terminal', ...(!enabled ? APPROVAL_TOOLS : [])] } } };
      f.edit(edited);
      f.load();
      return snapshot;
    });

    expect(await f.setting.reconcile()).toMatchObject({ enabled, config: 'pending', reload: 'pending', application: 'pending' });
    expect(f.config().agents.providers).toEqual(edited);
    expect(f.state().reloadPending).toBe(true);
    expect(f.daemon.reload).not.toHaveBeenCalled();
    vi.mocked(f.daemon.effectiveProviders).mockImplementation(async () => structuredClone(f.config().agents.providers));
    f.ownerApply(enabled);
    expect(await f.setting.reconcile()).toMatchObject({ enabled, config: 'written', reload: 'applied', application: 'partial' });
    expect(f.daemon.reload).toHaveBeenCalledOnce();
  });

  it.each([true, false])('does not confirm even an unrelated owner edit during final policy verification (enabled=%s)', async enabled => {
    const f = fixture();
    await f.ownerApplyAndSelect(enabled);
    vi.mocked(f.daemon.effectiveProviders).mockImplementationOnce(async () => {
      const config = f.config();
      writeFileSync(f.path, JSON.stringify({ ...config, unrelated: { keep: true, owner: 'demo-edit' } }));
      return config.agents.providers;
    });

    expect(await f.setting.reconcile()).toMatchObject({ enabled, config: 'pending', reload: 'pending', application: 'pending' });
    expect(f.config().unrelated).toEqual({ keep: true, owner: 'demo-edit' });
    expect(f.state().reloadPending).toBe(true);
    expect(await f.setting.reconcile()).toMatchObject({ enabled, config: 'written', reload: 'applied', application: 'partial' });
    expect(f.config().unrelated).toEqual({ keep: true, owner: 'demo-edit' });
  });

  it('invalidates confirmation if the config becomes unreadable during final policy verification', async () => {
    const f = fixture();
    await f.setting.reconcile();
    vi.mocked(f.daemon.effectiveProviders).mockImplementationOnce(async () => {
      const providers = f.config().agents.providers;
      rmSync(f.path);
      return providers;
    });

    expect(await f.setting.reconcile()).toMatchObject({ config: 'pending', reload: 'failed', application: 'pending' });
    expect(f.state().reloadPending).toBe(true);
  });

  it('rechecks effective policy after persisting reload success before confirming', async () => {
    const f = fixture();
    await f.setting.reconcile();
    const saved = f.config().agents.providers;
    const drifted = { ...saved, pi: { paseoTools: { disabledTools: [] } } };
    vi.mocked(f.daemon.effectiveProviders).mockClear().mockResolvedValueOnce(saved).mockResolvedValue(drifted);

    expect(await new WorkerApprovalsSetting(f.path, f.root, f.daemon).reconcile()).toMatchObject({ config: 'pending', reload: 'pending', application: 'pending' });
    expect(f.daemon.effectiveProviders).toHaveBeenCalledTimes(2);
    expect(f.state().reloadPending).toBe(true);
    expect(f.config().agents.providers).toEqual(saved);
  });

  it.each([true, false])('keeps a newly observed effective provider pending through reload and final verification (enabled=%s)', async enabled => {
    const f = fixture();
    await f.ownerApplyAndSelect(enabled);
    const saved = f.config().agents.providers;
    const before = readFileSync(f.path, 'utf8');
    const extra = { ...saved, 'demo-unaccounted': {} };
    vi.mocked(f.daemon.effectiveProviders).mockResolvedValue(extra);
    vi.mocked(f.daemon.reload).mockClear();

    expect(await f.setting.reconcile()).toMatchObject({ enabled, config: 'pending', reload: 'pending', application: 'pending' });
    expect(f.state().reloadPending).toBe(true);
    expect(f.daemon.reload).toHaveBeenCalledOnce();
    expect(readFileSync(f.path, 'utf8')).toBe(before);

    vi.mocked(f.daemon.effectiveProviders).mockResolvedValue(saved);
    expect(await f.setting.reconcile()).toMatchObject({ enabled, config: 'written', reload: 'applied', application: 'partial' });
    expect(f.state().reloadPending).toBe(false);
  });

  it.each([true, false])('rejects a provider first appearing in the final effective snapshot (enabled=%s)', async enabled => {
    const f = fixture();
    await f.ownerApplyAndSelect(enabled);
    const saved = f.config().agents.providers;
    const extra = { ...saved, 'demo-unaccounted': { paseoTools: { enabled: true, disabledTools: [] } } };
    vi.mocked(f.daemon.effectiveProviders).mockClear().mockResolvedValueOnce(saved).mockResolvedValue(extra);

    expect(await new WorkerApprovalsSetting(f.path, f.root, f.daemon).reconcile()).toMatchObject({ enabled, config: 'pending', reload: 'pending', application: 'pending' });
    expect(f.daemon.effectiveProviders).toHaveBeenCalledTimes(2);
    expect(f.state().reloadPending).toBe(true);
    expect(f.config().agents.providers).toEqual(saved);
  });

  it('accounts for discovered uncovered providers and removed default-policy entries', async () => {
    const f = fixture();
    await f.setting.reconcile();
    vi.mocked(f.daemon.providers).mockResolvedValue(['pi', 'demo-plugin']);
    vi.mocked(f.daemon.effectiveProviders).mockImplementation(async () => ({
      ...f.config().agents.providers, pi: {}, 'demo-plugin': {},
    }));

    expect(await f.ownerApplyAndSelect(false)).toMatchObject({ enabled: false, config: 'written', reload: 'applied', application: 'partial', uncoveredProviders: ['demo-plugin'] });
    expect(f.state().reloadPending).toBe(false);
  });

  it.each([true, false])('returns an unconfirmed API response for a provider appearing at the end of a save (enabled=%s)', async enabled => {
    const f = fixture({}, enabled);
    let reads = 0;
    vi.mocked(f.daemon.effectiveProviders).mockImplementation(async () => ({
      ...f.config().agents.providers, ...(reads++ ? { 'demo-unaccounted': {} } : {}),
    }));
    const keys = await makeKeys();
    const { app } = await makeApp(keys, { workerApprovals: f.setting });
    apps.push(app);
    const token = await makeToken(keys);
    const response = await app.inject({ method: 'PUT', url: '/api/worker-approvals', headers: postHeaders(token), payload: { enabled } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enabled, config: 'pending', reload: 'pending', application: 'pending' });
    expect(f.state().reloadPending).toBe(true);
  });

  it.each([true, false])('accepts an already-loaded policy after helper restart (enabled=%s)', async enabled => {
    const f = fixture({ pi: { paseoTools: { disabledTools: ['kill_agent'] } } });
    await f.setting.reconcile();
    if (!enabled) await f.ownerApplyAndSelect(false);
    const before = readFileSync(f.path, 'utf8');
    const backup = f.state().backup;
    vi.mocked(f.daemon.reload).mockClear();
    const restarted = new WorkerApprovalsSetting(f.path, f.root, f.daemon);
    expect(await restarted.reconcile()).toMatchObject({ enabled, reload: 'applied', application: 'partial' });
    expect(await vi.mocked(f.daemon.reload).mock.results[0]!.value).toMatchObject({ appliedPaths: [] });
    expect(f.state()).toMatchObject({ backup, reloadPending: false });
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    await restarted.reconcile();
    await restarted.reconcile();
    expect(f.daemon.reload).toHaveBeenCalledOnce();
  });

  it.each([true, false])('recovers after a reload applies but its response is lost (enabled=%s)', async enabled => {
    const f = fixture({ pi: { paseoTools: { disabledTools: ['kill_agent'] } } });
    if (!enabled) await f.setting.reconcile();
    vi.mocked(f.daemon.reload).mockClear().mockImplementationOnce(async () => {
      f.load();
      throw new Error('obviously-fake-lost-reload-response');
    });
    expect(await f.ownerApplyAndSelect(enabled)).toMatchObject({ enabled, reload: 'failed', application: 'pending' });
    expect(f.state().reloadPending).toBe(true);
    expect(await f.setting.reconcile()).toMatchObject({ enabled, reload: 'applied', application: 'partial' });
    expect(await vi.mocked(f.daemon.reload).mock.results.at(-1)!.value).toEqual({ appliedPaths: [], restartRequiredPaths: [], overrideControlledPaths: [] });
    expect(f.state().reloadPending).toBe(false);
    await f.setting.reconcile();
    expect(f.daemon.reload).toHaveBeenCalledTimes(2);
    expect(f.config().agents.providers.pi.paseoTools.disabledTools).toEqual(enabled ? ['kill_agent', ...APPROVAL_TOOLS] : ['kill_agent']);
  });

  it.each([true, false])('reconciles live policy drift after the pending flag clears (enabled=%s)', async enabled => {
    const f = fixture({ pi: { paseoTools: { disabledTools: ['kill_agent'] } } });
    await f.setting.reconcile();
    if (!enabled) await f.ownerApplyAndSelect(false);
    const saved = f.config().agents.providers;
    const backup = f.state().backup;
    f.edit({ ...saved, pi: { paseoTools: { disabledTools: enabled ? ['kill_agent'] : ['kill_agent', ...APPROVAL_TOOLS] } } });
    await f.daemon.reload();
    f.edit(saved);
    const before = readFileSync(f.path, 'utf8');
    vi.mocked(f.daemon.reload).mockClear();
    expect(f.state().reloadPending).toBe(false);

    expect(await f.setting.reconcile()).toMatchObject({ enabled, reload: 'applied', application: 'partial' });
    expect(await f.daemon.effectiveProviders()).toEqual(saved);
    expect(f.state()).toMatchObject({ backup, reloadPending: false });
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    for (let i = 0; i < 3; i++) await f.setting.reconcile();
    await f.ownerApplyAndSelect(enabled);
    expect(f.daemon.reload).toHaveBeenCalledOnce();
  });

  it('persists and retries live policy drift on status reads and unchanged setting writes', async () => {
    const f = fixture();
    await f.setting.reconcile();
    const saved = f.config().agents.providers;
    const backup = f.state().backup;
    f.edit({});
    await f.daemon.reload();
    f.edit(saved);
    vi.mocked(f.daemon.reload).mockClear().mockImplementation(async () => {
      expect(f.state().reloadPending).toBe(true);
      return { appliedPaths: [], restartRequiredPaths: [], overrideControlledPaths: [] };
    });

    expect(await f.setting.setEnabled(true)).toMatchObject({ enabled: true, reload: 'pending', application: 'pending' });
    for (let i = 0; i < 3; i++) {
      expect(await f.setting.reconcile()).toMatchObject({ reload: 'pending', application: 'pending' });
      expect(f.state()).toMatchObject({ backup, reloadPending: true });
    }
    expect(f.daemon.reload).toHaveBeenCalledTimes(4);
    vi.mocked(f.daemon.reload).mockImplementationOnce(async () => {
      f.load();
      return { appliedPaths: ['agents.providers'], restartRequiredPaths: [], overrideControlledPaths: [] };
    });
    expect(await f.setting.reconcile()).toMatchObject({ reload: 'applied', application: 'partial' });
    expect(f.state()).toMatchObject({ backup, reloadPending: false });
    expect(await f.daemon.effectiveProviders()).toEqual(saved);
  });

  it('marks a settled policy pending if live policy verification fails and retries', async () => {
    const f = fixture();
    await f.setting.reconcile();
    const backup = f.state().backup;
    vi.mocked(f.daemon.reload).mockClear();
    vi.mocked(f.daemon.effectiveProviders).mockRejectedValueOnce(new Error('obviously-fake-effective-config-unavailable'));
    expect(await f.setting.reconcile()).toMatchObject({ reload: 'failed', application: 'pending' });
    expect(f.state()).toMatchObject({ backup, reloadPending: true });
    expect(f.daemon.reload).not.toHaveBeenCalled();
    expect(await f.setting.reconcile()).toMatchObject({ reload: 'applied', application: 'partial' });
    expect(f.state()).toMatchObject({ backup, reloadPending: false });
    expect(f.daemon.reload).toHaveBeenCalledOnce();
  });

  it.each([
    { id: 'pi', policy: { disabledTools: ['respond_to_permission', 'set_agent_mode'] } },
    { id: 'coder-worker', policy: { enabled: true, disabledTools: [...APPROVAL_TOOLS] } },
    { id: 'reviewer', policy: { enabled: true, disabledTools: [...APPROVAL_TOOLS] } },
    { id: 'demo-extra', policy: undefined },
  ].flatMap(entry => [[], ['agents.providers']].map(appliedPaths => ({ ...entry, appliedPaths }))))('keeps a reload pending when effective policy differs: %j', async ({ id, policy, appliedPaths }) => {
    const f = fixture({ 'demo-extra': { extends: 'pi', label: 'Demo extra' } });
    await f.setting.reconcile();
    vi.mocked(f.daemon.reload).mockResolvedValue({ appliedPaths, restartRequiredPaths: [], overrideControlledPaths: [] });
    vi.mocked(f.daemon.effectiveProviders).mockResolvedValue({ ...f.config().agents.providers, [id]: { paseoTools: policy } });
    const restarted = new WorkerApprovalsSetting(f.path, f.root, f.daemon);
    expect(await restarted.reconcile()).toMatchObject({ reload: 'pending', application: 'pending' });
    expect(f.state().reloadPending).toBe(true);
  });

  it('checks that removed provider limits have actually been undone', async () => {
    const f = fixture();
    await f.setting.reconcile();
    const old = f.config().agents.providers;
    vi.mocked(f.daemon.reload).mockResolvedValue({ appliedPaths: [], restartRequiredPaths: [], overrideControlledPaths: [] });
    vi.mocked(f.daemon.effectiveProviders).mockResolvedValue(old);
    expect(await f.ownerApplyAndSelect(false)).toMatchObject({ enabled: false, reload: 'pending', application: 'pending' });
    expect(f.config().agents.providers.pi).toBeUndefined();
    expect(f.state().reloadPending).toBe(true);
  });

  it('compares tool policy semantics without unrelated fields, ordering or explicit defaults', async () => {
    const f = fixture();
    await f.setting.reconcile();
    const effective: Providers = Object.fromEntries(Object.entries(f.config().agents.providers as Providers).map(([id, entry]) => [id, {
      enabled: false, label: 'Demo effective label',
      paseoTools: { enabled: entry.paseoTools?.enabled ?? true, disabledTools: [...APPROVAL_TOOLS].reverse() },
    }]));
    vi.mocked(f.daemon.effectiveProviders).mockResolvedValue(effective);
    const restarted = new WorkerApprovalsSetting(f.path, f.root, f.daemon);
    expect(await restarted.reconcile()).toMatchObject({ reload: 'applied', application: 'partial' });
    expect(f.state().reloadPending).toBe(false);
  });

  it('keeps the reload pending and retries if reading effective config fails', async () => {
    const f = fixture();
    vi.mocked(f.daemon.effectiveProviders).mockRejectedValueOnce(new Error('obviously-fake-effective-config-unavailable'));
    expect(await f.setting.reconcile()).toMatchObject({ config: 'pending', reload: 'failed', application: 'pending' });
    expect(f.state().reloadPending).toBe(true);
    expect(await f.setting.reconcile()).toMatchObject({ reload: 'applied', application: 'partial' });
    expect(f.state().reloadPending).toBe(false);
  });

  it.each([
    { appliedPaths: [], restartRequiredPaths: ['agents.providers'], overrideControlledPaths: [] },
    { appliedPaths: ['agents.providers'], restartRequiredPaths: [], overrideControlledPaths: ['agents.providers.pi'] },
  ])('reports actual reload results as pending: %j', async reply => {
    const f = fixture();
    vi.mocked(f.daemon.effectiveProviders).mockImplementation(async () => f.config().agents.providers);
    vi.mocked(f.daemon.reload).mockResolvedValue(reply);
    expect(await f.setting.reconcile()).toMatchObject({ config: 'pending', application: 'pending', reload: 'pending' });
    expect(f.state().reloadPending).toBe(true);
    expect(f.daemon.effectiveProviders).not.toHaveBeenCalled();
  });

  it('accepts matching provider policy when only unrelated reload paths changed', async () => {
    const f = fixture();
    await f.setting.reconcile();
    vi.mocked(f.daemon.reload).mockResolvedValue({ appliedPaths: ['relay'], restartRequiredPaths: ['listen'], overrideControlledPaths: ['relay'] });
    expect(await new WorkerApprovalsSetting(f.path, f.root, f.daemon).reconcile()).toMatchObject({ application: 'partial', reload: 'applied' });
    expect(f.state().reloadPending).toBe(false);
  });

  it('leaves the saved choice unchanged if authenticated discovery fails', async () => {
    const f = fixture();
    await f.setting.reconcile();
    vi.mocked(f.daemon.providers).mockRejectedValue(new Error('obviously-fake-auth-refusal'));
    expect(await f.setting.setEnabled(false)).toMatchObject({ enabled: true, config: 'pending', reload: 'failed', application: 'pending' });
    expect(f.state().enabled).toBe(true);
  });

  it.each([true, false])('invalidates config confirmation on discovery failure without a known owner edit (enabled=%s)', async enabled => {
    const f = fixture();
    expect(await f.ownerApplyAndSelect(enabled)).toMatchObject({ enabled, config: 'written', reload: 'applied' });
    const before = readFileSync(f.path, 'utf8');
    const state = f.state();
    vi.mocked(f.daemon.providers).mockRejectedValue(new Error('obviously-fake-discovery-failure'));

    expect(await f.setting.reconcile()).toMatchObject({ enabled, config: 'pending', reload: 'failed', application: 'pending' });
    expect(await f.setting.setEnabled(!enabled)).toMatchObject({ enabled, config: 'pending', reload: 'failed', application: 'pending' });
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(f.state()).toEqual(state);

    vi.mocked(f.daemon.providers).mockResolvedValue([]);
    expect(await f.setting.reconcile()).toMatchObject({ enabled, config: 'written', reload: 'applied', application: 'partial' });
  });

  it.each([true, false])('invalidates cached confirmation when owner policy changes before discovery fails (enabled=%s)', async enabled => {
    const f = fixture({ pi: { paseoTools: { disabledTools: ['kill_agent'] } } });
    expect(await f.ownerApplyAndSelect(enabled)).toMatchObject({ enabled, config: 'written', reload: 'applied' });
    const state = f.state();
    f.edit({ pi: { paseoTools: { disabledTools: ['kill_agent', 'create_terminal'] } } });
    await f.daemon.reload();
    expect(await f.daemon.effectiveProviders()).toEqual(f.config().agents.providers);
    expect(f.config().agents.providers.pi.paseoTools.disabledTools).not.toContain('respond_to_permission');
    expect(f.config().agents.providers.reviewer).toBeUndefined();
    const before = readFileSync(f.path, 'utf8');
    vi.mocked(f.daemon.reload).mockClear();
    vi.mocked(f.daemon.effectiveProviders).mockClear();
    vi.mocked(f.daemon.providers).mockRejectedValue(new Error('obviously-fake-discovery-failure'));

    for (let i = 0; i < 2; i++) {
      expect(await f.setting.reconcile()).toMatchObject({ enabled, config: 'pending', reload: 'failed', application: 'pending' });
    }
    expect(await f.setting.setEnabled(!enabled)).toMatchObject({ enabled, config: 'pending', reload: 'failed', application: 'pending' });
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(f.state()).toEqual(state);
    expect(f.daemon.reload).not.toHaveBeenCalled();
    expect(f.daemon.effectiveProviders).not.toHaveBeenCalled();

    vi.mocked(f.daemon.providers).mockResolvedValue(['pi']);
    expect(await f.setting.reconcile()).toMatchObject({ enabled, config: 'written', reload: 'applied' });
    f.ownerApply(enabled);
    expect(await f.setting.reconcile()).toMatchObject({ enabled, config: 'written', reload: 'applied', application: 'partial' });
    expect(await f.daemon.effectiveProviders()).toEqual(f.config().agents.providers);
    expect(f.config().agents.providers.pi.paseoTools.disabledTools).toEqual(['kill_agent', 'create_terminal', ...(enabled ? APPROVAL_TOOLS : [])]);
    expect(f.config().agents.providers.reviewer.paseoTools.enabled).toBe(false);
    expect(f.daemon.reload).toHaveBeenCalledOnce();
  });

  it('serializes concurrent choices and preserves owner settings and undo records', async () => {
    const f = fixture({ pi: { paseoTools: { disabledTools: ['kill_agent'] } } });
    const before = f.config();
    const backup = f.state().backup;
    await Promise.all([f.setting.setEnabled(true), f.setting.setEnabled(false), f.setting.setEnabled(true)]);
    expect(f.state().enabled).toBe(true);
    expect(f.state().backup).toEqual(backup);
    expect(f.config()).toEqual(before);
  });

  it('refuses malformed persisted state and config instead of losing undo records', async () => {
    const f = fixture();
    await f.setting.reconcile();
    writeFileSync(join(f.root, 'worker-approvals.json'), '{');
    expect(() => new WorkerApprovalsSetting(f.path, f.root, f.daemon)).toThrow(/restore its backup/);
    const before = readFileSync(f.path, 'utf8');
    writeFileSync(f.path, '{');
    await expect(f.setting.reconcile()).rejects.toThrow();
    expect(readFileSync(f.path, 'utf8')).toBe('{');
    expect(before).toContain('providers');
  });
});

describe('worker approval API', () => {
  it.each([true, false])('returns pending through the authenticated API after an owner edit during reload (enabled=%s)', async enabled => {
    const f = fixture({ pi: { paseoTools: { disabledTools: ['kill_agent'] } } }, enabled);
    vi.mocked(f.daemon.reload).mockImplementationOnce(async () => {
      f.edit({ ...f.config().agents.providers, pi: { paseoTools: { disabledTools: ['kill_agent', ...(!enabled ? APPROVAL_TOOLS : [])] } }, reviewer: { ...f.config().agents.providers.reviewer, paseoTools: { enabled: true } } });
      f.load();
      return { appliedPaths: ['agents.providers'], restartRequiredPaths: [], overrideControlledPaths: [] };
    });
    const keys = await makeKeys();
    const { app } = await makeApp(keys, { workerApprovals: f.setting });
    apps.push(app);
    const token = await makeToken(keys);
    const response = await app.inject({ method: 'PUT', url: '/api/worker-approvals', headers: postHeaders(token), payload: { enabled } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enabled, config: 'pending', reload: 'pending', application: 'pending' });
    // Status reads are pure: they report the owner's edit as pending and repair nothing.
    const edited = readFileSync(f.path, 'utf8');
    expect((await app.inject({ url: '/api/worker-approvals', headers: apiHeaders(token) })).json()).toMatchObject({ enabled, config: 'pending', reload: 'pending', application: 'pending' });
    expect(readFileSync(f.path, 'utf8')).toBe(edited);
    expect(f.daemon.reload).toHaveBeenCalledOnce();
    f.ownerApply(enabled);
    await f.setting.reconcile();
    expect((await app.inject({ url: '/api/worker-approvals', headers: apiHeaders(token) })).json()).toMatchObject({ enabled, config: 'written', reload: 'applied', application: 'partial' });
  });

  it.each([true, false])('saves and verifies a policy change through the API (enabled=%s)', async enabled => {
    const f = fixture({ pi: { paseoTools: { disabledTools: ['kill_agent', 'update_agent'] } } }, !enabled);
    const keys = await makeKeys();
    const { app } = await makeApp(keys, { workerApprovals: f.setting });
    apps.push(app);
    const token = await makeToken(keys);
    const response = await app.inject({ method: 'PUT', url: '/api/worker-approvals', headers: postHeaders(token), payload: { enabled } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enabled, config: 'written', reload: 'applied', application: 'partial' });
    expect((await app.inject({ url: '/api/worker-approvals', headers: apiHeaders(token) })).json()).toMatchObject({ enabled, config: 'written', reload: 'applied' });
    expect(f.state().enabled).toBe(enabled);
    expect(f.config().unrelated).toEqual({ keep: true });
    expect(f.config().agents.providers.pi.paseoTools.disabledTools).toEqual(['kill_agent', 'update_agent', ...(enabled ? ['respond_to_permission', 'set_agent_mode'] : [])]);
    expect(await f.daemon.effectiveProviders()).toEqual(f.config().agents.providers);
    expect(f.daemon.reload).toHaveBeenCalledOnce();
  });

  it('authenticates reads and permits writes only from a paired desktop', async () => {
    const keys = await makeKeys();
    const token = await makeToken(keys);
    const service = { status: vi.fn(async () => pendingWorkerApprovals()), setEnabled: vi.fn(async (enabled: boolean) => ({ ...pendingWorkerApprovals(), enabled })) };
    const { app } = await makeApp(keys, { workerApprovals: service });
    apps.push(app);
    expect((await app.inject({ url: '/api/worker-approvals' })).statusCode).toBe(421);
    expect((await app.inject({ url: '/api/worker-approvals', headers: apiHeaders(token, { cookie: '' }) })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/worker-approvals', headers: apiHeaders(token, { cookie: PHONE_COOKIE }) })).statusCode).toBe(200);
    const put = (payload: Record<string, unknown>, extra: Record<string, string> = {}) => app.inject({ method: 'PUT', url: '/api/worker-approvals', headers: postHeaders(token, extra), payload });
    expect((await put({ enabled: false }, { cookie: PHONE_COOKIE })).statusCode).toBe(403);
    expect((await put({ enabled: false }, { origin: 'https://other.example.com' })).statusCode).toBe(403);
    expect((await put({ enabled: false, configPath: '/home/me/other.json' })).statusCode).toBe(400);
    expect((await put({ enabled: 'false' })).statusCode).toBe(400);
    expect(service.setEnabled).not.toHaveBeenCalled();
    expect((await put({ enabled: false })).json()).toMatchObject({ enabled: false });
    expect(service.setEnabled).toHaveBeenCalledWith(false);
  });

  it('rejects Access-only writes even when pairing is disabled', async () => {
    const config = makeConfig(undefined, { devices: { enabled: false } });
    const service = { status: vi.fn(async () => pendingWorkerApprovals()), setEnabled: vi.fn(async () => pendingWorkerApprovals()) };
    const app = await buildApp({ config, verifier: async () => ({ email: 'you@example.com', exp: Math.floor(Date.now() / 1000) + 60 }), hub: new EventHub(), sources: { hermes: new FakeHermes(), paseo: new FakePaseo() }, workerApprovals: service, logger: false });
    apps.push(app);
    expect((await app.inject({ method: 'PUT', url: '/api/worker-approvals', headers: postHeaders('obviously-fake-jwt'), payload: { enabled: false } })).statusCode).toBe(403);
    expect(service.setEnabled).not.toHaveBeenCalled();
  });

  it('exposes pending default-on status when the helper has not been set up', async () => {
    const keys = await makeKeys();
    const { app } = await makeApp(keys);
    apps.push(app);
    const token = await makeToken(keys);
    expect((await app.inject({ url: '/api/worker-approvals', headers: apiHeaders(token) })).json()).toMatchObject({ enabled: true, application: 'pending', config: 'pending' });
    expect((await app.inject({ method: 'PUT', url: '/api/worker-approvals', headers: postHeaders(token), payload: { enabled: false } })).statusCode).toBe(424);
  });
});
