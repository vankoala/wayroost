import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import type { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigVerbs } from '../src/config-verbs.js';
import { ConfigAudit } from '../src/config-audit.js';
import { ConfigError } from '../src/config-paths.js';
import { configUnit, configUnitRunner, type ConfigUnit, type ConfigUnitRunner } from '../src/config-unit.js';
import { executeConfig } from '../src/config-executor.js';
import { readConfigInput } from '../src/config-entry.js';
import { withConsumerLock } from '../src/config-locks.js';
import { configSchema } from '../src/config.js';
import { createSupervisor } from '../src/server.js';
import { hashKey, type Key } from '../src/keys.js';
import { configVerbsStatusSchema, configWriteResultSchema, type ConfigWriteResult } from '../../shared/supervisor-config.js';
import { settingsTargetsSchema } from '../../shared/settings-targets.js';
import { collectSnapshot } from '../../server/src/checks/snapshot.js';
import { runChecks } from '../../server/src/checks/engine.js';

vi.mock('../src/config-hermes.js', () => ({ resolveHermesConfig: async (site: import('../../shared/settings-targets.js').SettingsTargets) => {
  const { readFile } = await import('node:fs/promises');
  const { yamlEditor } = await import('../../server/src/settings/editors/yaml.js');
  return yamlEditor.parse(await readFile(site.targets['hermes-config']!.path, 'utf8'));
} }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const roots: string[] = [];
const uid = process.getuid!();
const serverKey: Key = { name: 'server', scope: 'server', sha256: hashKey('fake-server-key') };
const launcherKey: Key = { name: 'launcher', scope: 'server', sha256: hashKey('fake-launcher-key') };
const rescueKey: Key = { name: 'rescue', scope: 'rescue', sha256: hashKey('fake-rescue-key') };
beforeEach(() => {
  vi.mocked(fs.open).mockImplementation(actual.open);
  vi.mocked(fs.lstat).mockImplementation(async (path, options) => {
    const stat = await actual.lstat(path, options);
    if (String(path) === '/') stat.uid = typeof stat.uid === 'bigint' ? 0n : 0;
    return stat;
  });
});
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(targetId: 'hermes-config' | 'paseo-config' = 'hermes-config') {
  const root = await mkdtemp(join(process.cwd(), '.config-runtime-test-')); roots.push(root);
  const path = join(root, targetId === 'hermes-config' ? 'config.yaml' : 'config.json');
  const stateDir = join(root, 'supervisor'); const backupDir = join(root, 'backups'); const auditDir = join(root, 'audit');
  await mkdir(stateDir, { mode: 0o700 }); await mkdir(backupDir, { mode: 0o700 }); await mkdir(auditDir, { mode: 0o700 });
  await writeFile(path, targetId === 'hermes-config' ? 'approvals:\n  mode: smart\n' : '{"version":1}\n', { mode: 0o600 });
  const site = settingsTargetsSchema.parse({ version: 1, configWrites: true, targets: { [targetId]: {
    path, runAs: { user: 'me', uid }, mode: 0o600, format: targetId === 'hermes-config' ? 'yaml' : 'json', backupDir, auditDir,
    lock: { kind: targetId === 'hermes-config' ? 'file' : 'paseo', path: path + (targetId === 'hermes-config' ? '.wayroost-settings.lock' : '.wayroost.lock') },
    ...(targetId === 'paseo-config' ? { loader: '/opt/example/loader.js' } : {}),
  } } });
  const runner = vi.fn<ConfigUnitRunner>(async unit => ({ code: 0, stdout: JSON.stringify(await executeConfig(JSON.parse(unit.input), { validatePaseo: async () => {},
    lock: (target, work) => withConsumerLock(target, work, async path => path) })) + '\n' }));
  const trust = vi.fn(async (path: string) => path);
  const reloadPaseo = vi.fn(async () => true);
  const audit = new ConfigAudit(stateDir);
  const verbs = new ConfigVerbs({ stateDir, site: async () => site, runner, trust, executable: '/opt/example/node', entry: '/opt/example/config-entry.js', reloadPaseo, audit });
  const request = () => ({ requestId: randomUUID(), operation: targetId === 'hermes-config' ? 'hermes.approval-mode' : 'paseo.provider-enabled',
    params: targetId === 'hermes-config' ? { mode: 'manual' } : { provider: 'codex', enabled: false } });
  return { root, path, site, stateDir, backupDir, auditDir, runner, trust, reloadPaseo, audit, verbs, request };
}
function written(result: ConfigWriteResult) {
  expect(configWriteResultSchema.safeParse(result).success).toBe(true);
  if (!result.ok || !('undo' in result)) throw new Error('expected an apply');
  return result;
}

describe('config verbs', () => {
  it.each([
    { code: 124, stdout: '' }, { code: 1, result: 'timeout', stdout: '' }, { code: 1, stdout: '' },
    { code: 0, stdout: '{invalid' }, { code: 0, stdout: '{}\n{}\n' }, { code: 0, stdout: 'x'.repeat(1024 * 1024 + 1) },
    { code: 0, stdout: JSON.stringify({ ok: false, code: 'parse_failed' }) },
    { code: 0, stdout: JSON.stringify({ ok: true, view: 'hermes.agents', present: false, values: [] }) },
    { code: 0, stdout: JSON.stringify({ ok: true, view: 'hermes.safety', present: false, values: [] }) },
  ])('normalizes effective unit failure %# and leaves dependent rows unknown', async output => {
    const f = await fixture(); f.runner.mockResolvedValue(output);
    const snapshot = await collectSnapshot({ readView: view => f.verbs.read({ view }, serverKey) }, {},
      { views: ['hermes.models', 'hermes.safety'] });
    for (const view of ['hermes.models', 'hermes.safety'] as const) expect(snapshot.views[view]).toMatchObject({ ok: false, code: 'unavailable' });
    for (const id of ['hermes.reader-parse', 'hermes.model-provider', 'hermes.approval-mode']) {
      expect(runChecks(snapshot).find(row => row.id === id)).toMatchObject({ state: 'unknown' });
    }
    expect((await f.audit.rows()).every(row => row.result === 'unavailable')).toBe(true);
  });

  it('deletes a reasoning override with checked preconditions, audit and undo', async () => {
    const f = await fixture();
    await writeFile(f.path, 'agent:\n  reasoning_effort: low\n  max_iterations: 50\napprovals:\n  mode: manual\n', { mode: 0o600 });
    const before = await f.verbs.read({ view: 'hermes.agents' }, serverKey);
    if (!before.ok) throw new Error('expected a read');
    const request = { requestId: randomUUID(), operation: 'hermes.reasoning-effort', params: { effort: null },
      preconditions: { file: { sha256: before.sha256! } } };
    const applied = written(await f.verbs.apply(request, serverKey));
    expect(await readFile(f.path, 'utf8')).not.toContain('reasoning_effort');
    expect(await readFile(f.path, 'utf8')).toContain('max_iterations: 50');
    expect(applied.keys).toEqual(['agent.reasoning_effort']);
    expect(await f.verbs.apply({ ...request, requestId: randomUUID() }, serverKey)).toMatchObject({ ok: false, code: 'outcome_unknown' });
    expect((await f.audit.rows()).find(row => row.id === request.requestId)).toMatchObject({
      operation: request.operation, result: 'ok', keys: ['agent.reasoning_effort'], backupId: applied.backupId,
    });
    const undone = written(await f.verbs.undo({ requestId: randomUUID(), token: applied.undo }, serverKey));
    expect(await readFile(f.path, 'utf8')).toContain('reasoning_effort: low');
    await f.verbs.undo({ requestId: randomUUID(), token: undone.undo }, serverKey);
    expect(await readFile(f.path, 'utf8')).not.toContain('reasoning_effort');
    await writeFile(f.path, 'agent:\n  reasoning_effort: high\n', { mode: 0o600 });
    const rejected = await executeConfig({ site: f.site, caller: 'server', verb: 'config.apply', request }, {
      lock: (target, work) => withConsumerLock(target, work, async path => path),
    });
    expect(rejected).toEqual({ ok: false, code: 'precondition_changed' });
    expect(await readFile(f.path, 'utf8')).toContain('reasoning_effort: high');
  });

  it('stops without restoring a result when final publication cannot sync its directory', async () => {
    const f = await fixture(); const request = f.request();
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    let finalizing = false;
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const file = await actual.open(path, flags, mode);
      if (basename(String(path)).startsWith('.config-request-')) {
        vi.spyOn(file, 'writeFile').mockImplementation(async (...args) => {
          if (String(args[0]).includes('"ok":true')) finalizing = true;
          return Reflect.apply(Object.getPrototypeOf(file).writeFile, file, args);
        });
      }
      if (String(path) === f.stateDir && finalizing) vi.spyOn(file, 'sync').mockRejectedValue(new Error('fake-storage-failure'));
      return file;
    });
    const save = f.audit.save.bind(f.audit);
    const saving = vi.spyOn(f.audit, 'save').mockImplementation(record => record.result?.ok === false
      ? Promise.reject(new ConfigError('audit_unavailable')) : save(record));
    const failed = await f.verbs.apply(request, serverKey);
    expect(failed).toMatchObject({ ok: false, code: 'outcome_unknown', backupId: expect.any(String) });
    saving.mockRestore(); vi.mocked(fs.open).mockImplementation(actual.open);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    await expect(f.audit.request(request.requestId)).rejects.toThrow('audit_unavailable');
    expect(await f.verbs.apply(f.request(), serverKey)).toEqual({ ok: false, code: 'audit_unavailable' });
    expect(f.runner).toHaveBeenCalledTimes(1);
  });

  it.each(['before', 'after'] as const)('stops after audit append fails %s writing without publishing a replacement', async failure => {
    const f = await fixture(); const request = f.request();
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const file = await actual.open(path, flags, mode);
      if (basename(String(path)) === 'config-audit.jsonl') {
        if (failure === 'before') vi.spyOn(file, 'writeFile').mockRejectedValue(new Error('fake-storage-failure'));
        else vi.spyOn(file, 'sync').mockRejectedValue(new Error('fake-storage-failure'));
      }
      return file;
    });
    const failed = await f.verbs.apply(request, serverKey);
    expect(failed).toMatchObject({ ok: false, code: 'outcome_unknown', backupId: expect.any(String) });
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    await expect(f.audit.request(request.requestId)).rejects.toThrow('audit_unavailable');
    expect(await f.verbs.apply(f.request(), serverKey)).toEqual({ ok: false, code: 'audit_unavailable' });
    const saved = JSON.parse(await readFile(join(f.stateDir, `config-request-${request.requestId}.json`), 'utf8'));
    expect(saved.row.result).toBe('outcome_unknown'); expect(saved.result).toBeUndefined();
    expect(f.runner).toHaveBeenCalledTimes(1);
  });

  it.each(['append', 'save-and-append'] as const)('repairs read launch rows after failed %s without persisting values', async failure => {
    const f = await fixture();
    const save = f.audit.save.bind(f.audit); let launches = 0;
    const run = f.runner.getMockImplementation()!;
    f.runner.mockImplementation(async unit => { launches++; return run(unit); });
    const saving = vi.spyOn(f.audit, 'save').mockImplementation(record => failure === 'save-and-append' && launches > 0
      ? Promise.reject(new ConfigError('audit_unavailable')) : save(record));
    const appending = vi.spyOn(f.audit, 'append').mockRejectedValue(new ConfigError('audit_unavailable'));
    expect(await f.verbs.read({ view: 'hermes.safety' }, serverKey)).toEqual({ ok: false, code: 'unavailable' });
    saving.mockRestore(); appending.mockRestore();
    const restarted = new ConfigVerbs({ stateDir: f.stateDir, site: async () => f.site, runner: f.runner, trust: f.trust });
    expect((await restarted.read({ view: 'hermes.safety' }, serverKey)).ok).toBe(true);
    await f.audit.reconcile(); await f.audit.reconcile();
    const source = await readFile(join(f.stateDir, 'config-audit.jsonl'), 'utf8');
    const rows = source.trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(2); expect(new Set(rows.map(row => row.id)).size).toBe(2);
    expect(rows.every(row => row.verb === 'config.read')).toBe(true);
    expect(rows[0].result).not.toBe('ok'); expect(rows[1].result).toBe('ok');
    expect(source).not.toContain('smart'); expect(source).not.toContain('"values"');
    for (const row of rows) {
      const record = await readFile(join(f.stateDir, `config-request-${row.id}.json`), 'utf8');
      expect(record).not.toContain('smart'); expect(record).not.toContain('"values"');
    }
    expect(f.runner).toHaveBeenCalledTimes(2);
  });

  it.each(['config.apply', 'config.undo'] as const)('binds the %s backup before launch and retains its identity after lost output', async verb => {
    const f = await fixture();
    const request = verb === 'config.apply' ? f.request() : { requestId: randomUUID(), token: written(await f.verbs.apply(f.request(), serverKey)).undo };
    const before = await readFile(f.path, 'utf8');
    const run = f.runner.getMockImplementation()!; let reserved: string | undefined;
    f.runner.mockImplementationOnce(async unit => {
      const payload = JSON.parse(unit.input); const record = (await f.audit.request(request.requestId))!;
      reserved = payload.backupId;
      expect(reserved).toEqual(expect.any(String)); expect(record.row.backupId).toBe(reserved);
      await run(unit); return { code: 0, stdout: '' };
    });
    const method = verb === 'config.apply' ? 'apply' : 'undo';
    const failed = await f.verbs[method](request, serverKey);
    expect(reserved).toEqual(expect.any(String));
    expect(failed).toEqual({ ok: false, code: 'outcome_unknown', target: 'hermes-config', backupId: reserved });
    expect(await readFile(join(f.backupDir, 'files', reserved!), 'utf8')).toBe(before);
    const restarted = new ConfigVerbs({ stateDir: f.stateDir, site: async () => f.site, runner: f.runner, trust: f.trust });
    expect(await restarted[method](request, serverKey)).toEqual(failed);
    expect((await f.audit.request(request.requestId))!.row.backupId).toBe(reserved);
    expect(f.runner).toHaveBeenCalledTimes(verb === 'config.apply' ? 1 : 2);
  });

  it.each(['hermes-config', 'paseo-config'] as const)('reconciles %s after lost output by reading the target', async target => {
    const f = await fixture(target);
    const view = target === 'hermes-config' ? 'hermes.safety' : 'paseo.agents';
    const before = await f.verbs.read({ view }, serverKey);
    const run = f.runner.getMockImplementation()!;
    f.runner.mockImplementationOnce(async unit => { await run(unit); return { code: 1, stdout: '' }; });
    const request = f.request();
    const failed = await f.verbs.apply(request, serverKey);
    expect(failed).toEqual({ ok: false, code: 'outcome_unknown', target, backupId: expect.any(String) });
    expect(await f.verbs.apply(request, serverKey)).toEqual(failed);
    const current = await f.verbs.read({ view }, serverKey);
    if (!before.ok || !current.ok) throw new Error('expected snapshots');
    expect(current.sha256).not.toBe(before.sha256);
    expect(current.values).toContainEqual(target === 'hermes-config'
      ? { path: ['approvals', 'mode'], exists: true, value: 'manual' }
      : { path: ['agents', 'providers', 'codex', 'enabled'], exists: true, value: false });
    expect(f.runner).toHaveBeenCalledTimes(3);
  });

  it('returns unknown with the backup id after the core audit fails following replacement', async () => {
    const f = await fixture();
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const file = await actual.open(path, flags, mode);
      if (basename(String(path)) === 'audit.jsonl') vi.spyOn(file, 'sync').mockRejectedValue(new Error('fake-storage-failure'));
      return file;
    });
    const failed = await f.verbs.apply(f.request(), serverKey);
    expect(failed).toMatchObject({ ok: false, code: 'outcome_unknown', target: 'hermes-config', backupId: expect.any(String) });
    if (failed.ok || !('backupId' in failed) || !failed.backupId) throw new Error('expected a backup id');
    expect(await readFile(join(f.backupDir, 'files', failed.backupId), 'utf8')).toContain('mode: smart');
    expect((await f.audit.rows())[0]).toMatchObject({ result: 'outcome_unknown', backupId: failed.backupId });
    expect(await readdir(f.auditDir)).toEqual(['audit.jsonl']);
    expect(f.runner).toHaveBeenCalledTimes(1);
  });

  it.each(['hermes-config', 'paseo-config'] as const)('returns an unknown outcome for lost %s results and reconciles by reading the file', async target => {
    for (const verb of ['config.apply', 'config.undo'] as const) for (const output of [
      { code: 124, stdout: '' }, { code: 1, stdout: '' }, { code: 0, stdout: '{broken\n' },
    ]) {
      const f = await fixture(target);
      const before = await f.verbs.read({ view: target === 'hermes-config' ? 'hermes.safety' : 'paseo.agents' }, serverKey);
      const request = verb === 'config.apply' ? f.request() : { requestId: randomUUID(), token: written(await f.verbs.apply(f.request(), serverKey)).undo };
      const run = f.runner.getMockImplementation()!;
      f.runner.mockImplementationOnce(async unit => { await run(unit); return output; });
      const method = verb === 'config.apply' ? 'apply' : 'undo';
      const start = f.runner.mock.calls.length;
      const failed = await f.verbs[method](request, serverKey);
      expect(failed).toEqual({ ok: false, code: 'outcome_unknown', target, backupId: expect.any(String) });
      expect(f.runner).toHaveBeenCalledTimes(start + 1);
      expect(await readdir(f.auditDir)).toEqual(['audit.jsonl']);
      const restarted = new ConfigVerbs({ stateDir: f.stateDir, site: async () => f.site, runner: f.runner, trust: f.trust, reloadPaseo: f.reloadPaseo });
      expect(await restarted[method](request, serverKey)).toEqual(failed);
      expect(f.runner).toHaveBeenCalledTimes(start + 1);
      expect((await f.audit.rows()).find(row => row.id === request.requestId)).toMatchObject({ verb, target, result: 'outcome_unknown' });
      const read = await restarted.read({ view: target === 'hermes-config' ? 'hermes.safety' : 'paseo.agents' }, serverKey);
      expect(read).toMatchObject({ ok: true, present: true });
      if (!read.ok || !before.ok) throw new Error('expected snapshots');
      if (verb === 'config.apply') expect(read.sha256).not.toBe(before.sha256);
      else expect(read.sha256).toBe(before.sha256);
      const log = (await readFile(join(f.stateDir, 'config-audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(log.filter(row => row.id === request.requestId)).toHaveLength(1);
      expect(f.runner.mock.calls.every(([unit]) => !('recovery' in JSON.parse(unit.input)))).toBe(true);
    }
  });

  it('does not launch recovery units when retrying failed launches', async () => {
    const f = await fixture();
    f.runner.mockRejectedValue(new Error('fake-private-text'));
    for (let index = 0; index < 3; index++) {
      const request = f.request();
      const failed = await f.verbs.apply(request, serverKey);
      expect(failed).toEqual({ ok: false, code: 'outcome_unknown', target: 'hermes-config', backupId: expect.any(String) });
      expect(await f.verbs.apply(request, serverKey)).toEqual(failed);
    }
    expect(f.runner).toHaveBeenCalledTimes(3);
    expect(await f.audit.rows()).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ result: 'outcome_unknown' })));
    const log = await readFile(join(f.stateDir, 'config-audit.jsonl'), 'utf8');
    expect(log.trim().split('\n')).toHaveLength(3);
    expect(log).not.toContain('fake-private-text'); expect(log).not.toContain('manual');
  });

  it('never replays an interrupted launch or takes a recovery lock', async () => {
    const f = await fixture(); const request = f.request();
    const result = written(await f.verbs.apply(request, serverKey));
    const saved = (await f.audit.request(request.requestId))!;
    await f.audit.save({ ...saved, result: undefined, row: { ...saved.row, result: 'outcome_unknown',
      backupSha256: undefined, writtenSha256: undefined } });
    await writeFile(join(f.stateDir, 'config-audit.jsonl'), '');
    const restarted = new ConfigVerbs({ stateDir: f.stateDir, site: async () => f.site, runner: f.runner, trust: f.trust });
    expect(await restarted.apply(request, serverKey)).toEqual({ ok: false, code: 'outcome_unknown', target: 'hermes-config', backupId: result.backupId });
    expect(f.runner).toHaveBeenCalledTimes(1);
    expect((await f.audit.rows())[0]).toMatchObject({ result: 'outcome_unknown' });
  });

  it('audits an interrupted launch for an unavailable target while another target is read', async () => {
    const f = await fixture();
    const row = { id: randomUUID(), time: new Date().toISOString(), caller: 'server', verb: 'config.apply' as const,
      target: 'paseo-config', operation: 'paseo.provider-enabled', keys: ['agents.providers.codex.enabled'], result: 'outcome_unknown' as const };
    await f.audit.save({ requestSha256: 'a'.repeat(64), callerSha256: 'b'.repeat(64), row });
    expect((await f.verbs.read({ view: 'hermes.safety' }, serverKey)).ok).toBe(true);
    expect(f.runner).toHaveBeenCalledTimes(1);
    const rows = (await readFile(join(f.stateDir, 'config-audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(2); expect(rows).toContainEqual(row);
  });

  it('keeps ten completed backups without receipts or acknowledgements', async () => {
    const f = await fixture();
    const firstRequest = f.request(); const first = written(await f.verbs.apply(firstRequest, serverKey));
    for (let index = 0; index < 12; index++) written(await f.verbs.apply(f.request(), serverKey));
    const names = await readdir(join(f.backupDir, 'files', first.backupId.split('/')[0]!));
    expect(names.filter(name => name.endsWith('.bak'))).toHaveLength(10);
    expect(names.filter(name => name.endsWith('.recovery.json'))).toHaveLength(0);
    expect(await readdir(f.auditDir)).toEqual(['audit.jsonl']);
    expect(await f.verbs.apply(firstRequest, serverKey)).toEqual(first);
  });

  it.each(['file', 'parent'] as const)('returns absent pi settings without a unit or lock when the %s is missing', async missing => {
    const f = await fixture();
    const path = join(f.root, ...(missing === 'parent' ? ['missing'] : []), 'settings.json');
    f.site = settingsTargetsSchema.parse({ version: 1, configWrites: true, targets: { 'pi-settings': {
      path, runAs: { user: 'me', uid }, mode: 0o600, format: 'json', backupDir: f.backupDir, auditDir: f.auditDir,
      lock: { kind: 'pi', path: path + '.lock' },
    } } });
    if (missing === 'file') await mkdir(path + '.lock');
    const verbs = new ConfigVerbs({ stateDir: f.stateDir, site: async () => f.site, runner: f.runner, trust: f.trust });
    expect(await verbs.read({ view: 'pi.settings' }, serverKey)).toEqual({ ok: true, view: 'pi.settings', present: false, values: [] });
    expect(f.runner).not.toHaveBeenCalled();
    expect(await f.audit.rows()).toEqual([]);
  });

  it('launches one owner unit per apply and undo and retains value-free audit rows', async () => {
    for (const target of ['hermes-config', 'paseo-config'] as const) {
      const f = await fixture(target); const request = f.request();
      const result = written(await f.verbs.apply(request, serverKey));
      expect(f.runner).toHaveBeenCalledTimes(1);
      expect(f.runner.mock.calls[0]![0].argv.join(' ')).not.toContain('manual');
      expect(await f.verbs.undo({ requestId: randomUUID(), token: result.undo }, serverKey)).toMatchObject({ ok: true });
      expect(f.runner).toHaveBeenCalledTimes(2);
      const rows = await f.audit.rows();
      expect(rows.map(row => row.verb)).toEqual(['config.apply', 'config.undo']);
      expect(rows[0]).toMatchObject({ id: request.requestId, result: 'ok', target, backupId: result.backupId,
        backupSha256: result.backupSha256, writtenSha256: result.writtenSha256 });
      expect(JSON.stringify(rows)).not.toContain('manual'); expect(JSON.stringify(rows)).not.toContain('"params"');
      for (const [unit] of f.runner.mock.calls) {
        expect(unit.argv).toContain('--uid=' + uid);
        expect(unit.argv).toContain('--property=PrivateNetwork=yes');
        expect(unit.argv).toContain('--property=ReadWritePaths=' + [f.root, f.backupDir, f.auditDir].map(path => `"${path}"`).join(' '));
        expect(JSON.parse(unit.input)).not.toHaveProperty('retainRecovery');
        expect(JSON.parse(unit.input)).not.toHaveProperty('acknowledgedRecovery');
      }
    }
  });

  it('advertises directory rows and gates writes before launch while reads remain available', async () => {
    const f = await fixture(); f.site.configWrites = false;
    const status = await f.verbs.status();
    expect(configVerbsStatusSchema.safeParse(status).success).toBe(true);
    expect(status).toMatchObject({ configWrites: false, verbs: ['config.read', 'config.request-status', 'config.apply', 'config.undo', 'credential.write', 'credential.test', 'service.drain-restart', 'service.drain-status', 'project.scan', 'checks.observe'] });
    expect(status.directories).toEqual(['target', 'backup', 'audit', 'lock'].map(storage => ({ target: 'hermes-config', storage, ok: true })));
    expect(await f.verbs.apply(f.request(), serverKey)).toEqual({ ok: false, code: 'config_writes_off' });
    expect(await f.verbs.undo({ requestId: randomUUID(), token: { operation: 'hermes.approval-mode', target: 'hermes-config', backupId: 'demo.bak', backupSha256: 'a'.repeat(64), writtenSha256: 'b'.repeat(64) } }, serverKey)).toEqual({ ok: false, code: 'config_writes_off' });
    expect(f.runner).not.toHaveBeenCalled();
    expect((await f.verbs.read({ view: 'hermes.safety' }, serverKey)).ok).toBe(true);
    expect((await f.audit.rows())[0]).toMatchObject({ verb: 'config.read', keys: [], result: 'ok' });
    await chmod(f.backupDir, 0o770);
    expect((await f.verbs.status()).directories).toContainEqual({ target: 'hermes-config', storage: 'backup', ok: false, code: 'unsafe_directory' });
    f.site.configWrites = true;
    expect(await f.verbs.apply(f.request(), serverKey)).toEqual({ ok: false, code: 'unsafe_directory' });
  });

  it.each([
    ['config.read', { view: 'hermes.safety', key: 'approvals.mode' }],
    ['config.apply', { requestId: randomUUID(), operation: 'hermes.approval-mode', params: { mode: 'manual' }, path: '/home/me/config.yaml' }],
    ['config.undo', { requestId: randomUUID(), token: {} }],
  ])('validates %s before launching', async (verb, request) => {
    const f = await fixture(); const method = verb.split('.')[1] as 'read' | 'apply' | 'undo';
    expect(await f.verbs[method](request, serverKey)).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(f.runner).not.toHaveBeenCalled();
  });

  it('restricts rescue and launcher keys and validates catalogue callers before launch', async () => {
    const f = await fixture();
    expect(await f.verbs.apply(f.request(), rescueKey)).toEqual({ ok: false, code: 'not_permitted' });
    expect(await f.verbs.read({ view: 'hermes.safety' }, rescueKey)).toEqual({ ok: false, code: 'not_permitted' });
    expect(await f.verbs.apply(f.request(), launcherKey)).toEqual({ ok: false, code: 'not_permitted' });
    expect(await f.verbs.apply({ ...f.request(), operation: 'gateway.record-override', params: { role: 'main', backend: null } }, serverKey)).toEqual({ ok: false, code: 'not_permitted' });
    expect(await f.verbs.apply({ ...f.request(), operation: 'not.known' }, serverKey)).toEqual({ ok: false, code: 'unknown_operation' });
    expect(f.runner).not.toHaveBeenCalled();
  });

  it.each([
    { code: 1, stdout: 'fake-private-text\n' }, { code: 0, stdout: 'fake-private-text\n' },
    { code: 0, stdout: '{"ok":false,"code":"failed","message":"fake-private-text"}\n' },
    { code: 0, stdout: '{"ok":false,"code":"failed"}\n{"ok":false,"code":"failed"}\n' },
    { code: 0, stdout: '{"ok":false,"code":"upstream-private-code"}\n' },
    { code: 0, stdout: '{"ok":true,"scheduled":true,"runAt":1}\n' },
    { code: 1, stdout: '', result: 'timeout' }, { code: 124, stdout: '' },
    { code: 0, stdout: '{"ok":false,"code":"locked"}\n' },
  ])('audits an unknown write outcome for post-launch failure without echoing stdout: %j', async output => {
    const f = await fixture(); f.runner.mockResolvedValue(output);
    expect(await f.verbs.apply(f.request(), serverKey)).toEqual({ ok: false, code: 'outcome_unknown', target: 'hermes-config', backupId: expect.any(String) });
    const rows = await f.audit.rows(); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: 'outcome_unknown', keys: ['approvals.mode'] });
    expect(JSON.stringify(rows)).not.toContain('fake-private-text'); expect(JSON.stringify(rows)).not.toContain('upstream-private-code');
  });

  it('keeps read errors fixed and refuses untrusted executables or failed audit preflight before launch', async () => {
    const f = await fixture();
    f.runner.mockResolvedValue({ code: 124, stdout: '' });
    expect(await f.verbs.read({ view: 'hermes.safety' }, serverKey)).toEqual({ ok: false, code: 'unavailable' });
    expect((await f.audit.rows())[0]!.result).toBe('unavailable');
    f.trust.mockRejectedValue(new Error('fake-private-text'));
    expect(await f.verbs.apply(f.request(), serverKey)).toEqual({ ok: false, code: 'unsafe_target' });
    expect(f.runner).toHaveBeenCalledTimes(1);
    f.trust.mockImplementation(async path => path);
    await writeFile(join(f.stateDir, 'config-audit.jsonl'), '{broken\n');
    expect(await f.verbs.apply(f.request(), serverKey)).toEqual({ ok: false, code: 'audit_unavailable' });
    expect(f.runner).toHaveBeenCalledTimes(1);
  });

  it('checks undo proof before launch and leaves an outside change intact', async () => {
    const f = await fixture(); const result = written(await f.verbs.apply(f.request(), serverKey));
    expect(await f.verbs.undo({ requestId: randomUUID(), token: { ...result.undo, backupSha256: 'c'.repeat(64) } }, serverKey)).toEqual({ ok: false, code: 'backup_mismatch' });
    expect(f.runner).toHaveBeenCalledTimes(1);
    await writeFile(f.path, 'approvals:\n  mode: off\n');
    expect(await f.verbs.undo({ requestId: randomUUID(), token: result.undo }, serverKey)).toEqual({ ok: false, code: 'outcome_unknown', target: 'hermes-config', backupId: expect.any(String) });
    expect(await readFile(f.path, 'utf8')).toContain('mode: off');
    expect((await f.audit.rows()).at(-1)).toMatchObject({ verb: 'config.undo', result: 'outcome_unknown' });
  });

  it.each(['reload', 'before', 'after'] as const)('returns unknown with the backup id when Paseo verification fails %s reload', async failure => {
    const f = await fixture('paseo-config');
    if (failure === 'reload') f.reloadPaseo.mockRejectedValue(new Error('fake-private-text'));
    if (failure === 'before') {
      const run = f.runner.getMockImplementation()!;
      f.runner.mockImplementation(async unit => { const result = await run(unit); await writeFile(f.path, '{"version":1}\n'); return result; });
    }
    if (failure === 'after') f.reloadPaseo.mockImplementation(async () => { await writeFile(f.path, '{"version":1}\n'); return true; });
    const failed = await f.verbs.apply(f.request(), serverKey);
    expect(failed).toMatchObject({ ok: false, code: 'outcome_unknown', target: 'paseo-config', backupId: expect.any(String) });
    expect(JSON.stringify(failed)).not.toContain('fake-private-text');
    expect(f.runner).toHaveBeenCalledTimes(1);
    if (failed.ok || !('backupId' in failed)) throw new Error('expected an unknown outcome');
    expect((await f.audit.rows())[0]).toMatchObject({ result: 'outcome_unknown', backupId: failed.backupId });
    if (failure === 'before') expect(f.reloadPaseo).not.toHaveBeenCalled();
  });

  it.each(['save', 'append', 'both'] as const)('returns unknown after %s fails and retries without another launch', async failure => {
    const f = await fixture(); const request = f.request();
    const save = f.audit.save.bind(f.audit);
    const saving = vi.spyOn(f.audit, 'save').mockImplementation(record => record.result && failure !== 'append'
      ? Promise.reject(new ConfigError('audit_unavailable')) : save(record));
    const appending = vi.spyOn(f.audit, 'append');
    if (failure !== 'save') appending.mockRejectedValue(new ConfigError('audit_unavailable'));
    const failed = await f.verbs.apply(request, serverKey);
    expect(failed).toMatchObject({ ok: false, code: 'outcome_unknown', target: 'hermes-config', backupId: expect.any(String) });
    expect(appending).toHaveBeenCalled();
    saving.mockRestore(); appending.mockRestore();
    const restarted = new ConfigVerbs({ stateDir: f.stateDir, site: async () => f.site, runner: f.runner, trust: f.trust });
    const retried = await restarted.apply(request, serverKey);
    expect(retried).toMatchObject({ ok: false, code: 'outcome_unknown', target: 'hermes-config' });
    if (failure !== 'both') expect(retried).toEqual(failed);
    expect(f.runner).toHaveBeenCalledTimes(1);
    expect((await f.audit.rows())[0]).toMatchObject({ result: 'outcome_unknown' });
    expect((await readFile(join(f.stateDir, 'config-audit.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('repairs a torn audit append without adding a second row for its launch', async () => {
    const f = await fixture(); const request = f.request();
    const append = vi.spyOn(f.audit, 'append').mockImplementation(async () => {
      await writeFile(join(f.stateDir, 'config-audit.jsonl'), '{"id":');
      throw new ConfigError('audit_unavailable');
    });
    expect(await f.verbs.apply(request, serverKey)).toMatchObject({ ok: false, code: 'outcome_unknown' });
    append.mockRestore();
    await f.verbs.apply(request, serverKey);
    const rows = (await readFile(join(f.stateDir, 'config-audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: request.requestId, result: 'outcome_unknown' });
    expect(f.runner).toHaveBeenCalledTimes(1);
  });

  it('keeps one unknown audit row when an append succeeds before reporting a sync failure', async () => {
    const f = await fixture(); const request = f.request();
    const append = f.audit.append.bind(f.audit);
    const appending = vi.spyOn(f.audit, 'append').mockImplementation(async row => { await append(row); throw new ConfigError('audit_unavailable'); });
    const failed = await f.verbs.apply(request, serverKey);
    expect(failed).toMatchObject({ ok: false, code: 'outcome_unknown' });
    appending.mockRestore();
    expect(await f.verbs.apply(request, serverKey)).toEqual(failed);
    const rows = (await readFile(join(f.stateDir, 'config-audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: request.requestId, result: 'outcome_unknown' });
    expect(f.runner).toHaveBeenCalledTimes(1);
  });

  it('keeps an interrupted request unknown if audit storage is still unavailable during retry', async () => {
    const f = await fixture(); const request = f.request();
    f.runner.mockRejectedValueOnce(new Error('fake-launch-error'));
    const failed = await f.verbs.apply(request, serverKey);
    const record = (await f.audit.request(request.requestId))!;
    await f.audit.save({ ...record, result: undefined });
    vi.spyOn(f.audit, 'save').mockRejectedValue(new ConfigError('audit_unavailable'));
    expect(await f.verbs.apply(request, serverKey)).toEqual(failed);
    expect(f.runner).toHaveBeenCalledTimes(1);
  });

  it('deduplicates simultaneous and completed requests across restart and rejects changed bindings', async () => {
    const f = await fixture(); const request = f.request();
    const [first, second] = await Promise.all([f.verbs.apply(request, serverKey), f.verbs.apply(request, serverKey)]);
    expect(first).toEqual(second); expect(f.runner).toHaveBeenCalledTimes(1);
    expect(await f.verbs.apply(request, serverKey)).toEqual(first);
    expect(await f.verbs.apply({ params: { mode: 'manual' }, operation: request.operation, requestId: request.requestId }, serverKey)).toEqual(first);
    const persisted = await readFile(join(f.stateDir, `config-request-${request.requestId}.json`), 'utf8');
    expect(persisted).not.toContain('manual'); expect(persisted).not.toContain('fake-server-key');
    const restarted = new ConfigVerbs({ stateDir: f.stateDir, site: async () => f.site, runner: f.runner, trust: f.trust });
    expect(await restarted.apply(request, serverKey)).toEqual(first);
    expect(await restarted.apply({ ...request, params: { mode: 'off' } }, serverKey)).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(await restarted.apply(request, { ...serverKey, name: 'other', sha256: hashKey('fake-other-key') })).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(f.runner).toHaveBeenCalledTimes(1); expect(await f.audit.rows()).toHaveLength(1);
    const result = written(first as ConfigWriteResult);
    expect((await restarted.undo({ requestId: randomUUID(), token: result.undo }, serverKey)).ok).toBe(true);
  });

  it('refuses changed callers and parameters while a request is still running', async () => {
    const f = await fixture(); const request = f.request();
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const run = f.runner.getMockImplementation()!;
    f.runner.mockImplementation(async unit => { await ready; return run(unit); });
    const pending = f.verbs.apply(request, serverKey);
    expect(await f.verbs.apply({ ...request, params: { mode: 'off' } }, serverKey)).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(await f.verbs.apply(request, { ...serverKey, name: 'other' })).toEqual({ ok: false, code: 'invalid_parameters' });
    release(); expect((await pending).ok).toBe(true);
    expect(f.runner).toHaveBeenCalledTimes(1);
  });

  it('reconciles uppercase request records without duplicating their launch row', async () => {
    const f = await fixture();
    const row = { id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', time: new Date().toISOString(), caller: 'server',
      verb: 'config.apply' as const, operation: 'hermes.approval-mode', target: 'hermes-config', keys: ['approvals.mode'], result: 'failed' as const };
    await f.audit.save({ requestSha256: 'a'.repeat(64), callerSha256: 'b'.repeat(64), row, result: { ok: false, code: 'failed' } });
    await f.audit.reconcile(); await f.audit.reconcile();
    expect((await readFile(join(f.stateDir, 'config-audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual([row]);
  });

  it('reads the log once and writes nothing when completed records are already audited', async () => {
    const f = await fixture();
    const rows = Array.from({ length: 100 }, () => ({ id: randomUUID(), time: new Date().toISOString(), caller: 'server', verb: 'config.apply' as const, keys: [], result: 'failed' as const }));
    for (const row of rows) await f.audit.save({ requestSha256: 'a'.repeat(64), callerSha256: 'b'.repeat(64), row, result: { ok: false, code: 'failed' } });
    await writeFile(join(f.stateDir, 'config-audit.jsonl'), rows.map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 });
    const reads = vi.fn(); const writes = vi.fn();
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const file = await actual.open(path, flags, mode);
      if (String(path) === join(f.stateDir, 'config-audit.jsonl')) {
        vi.spyOn(file, 'readFile').mockImplementation(async (...args) => { reads(); return Reflect.apply(Object.getPrototypeOf(file).readFile, file, args); });
        vi.spyOn(file, 'writeFile').mockImplementation(async (...args) => { writes(); return Reflect.apply(Object.getPrototypeOf(file).writeFile, file, args); });
      }
      return file;
    });
    await f.audit.reconcile(); expect(reads).toHaveBeenCalledTimes(1); expect(writes).not.toHaveBeenCalled();
  });
});

describe('transient unit argv', () => {
  it.each([0, 1001])('limits the unit for target owner %i', owner => {
    const unit = configUnit({ uid: owner, path: '/home/me/config.json', backupDir: '/home/me/backups', auditDir: '/home/me/audit' }, { params: { text: 'example text; $(example)' } }, '/opt/example/node', '/opt/example/config-entry.js');
    expect(unit.argv).toEqual(expect.arrayContaining(['--uid=' + owner, '--wait', '--pipe', '--quiet', '--property=CollectMode=inactive',
      '--property=PrivateNetwork=yes', '--property=NoNewPrivileges=yes', '--property=RuntimeMaxSec=30', '--property=ProtectSystem=strict',
      '--property=ProtectHome=read-only', '--property=UMask=0077', '--property=KillMode=control-group', '--property=StandardError=null',
      '--property=ReadWritePaths="/home/me" "/home/me/backups" "/home/me/audit"', '--', '/opt/example/node', '/opt/example/config-entry.js']));
    expect(unit.argv.some(arg => arg.includes('example text'))).toBe(false);
    expect(JSON.parse(unit.input)).toEqual({ params: { text: 'example text; $(example)' } });
  });
  it('escapes systemd path-list syntax and specifiers and grants reads only their lock directory', () => {
    const unit = configUnit({ path: '/home/me/config.json', uid: 1001, lockPath: '/home/me/config.json.lock' }, {});
    expect(unit.argv).toContain('--property=ReadWritePaths="/home/me"');
    const escaped = configUnit({ path: '/home/me/a b/config.json', uid: 1001, backupDir: '/home/me/b%u', auditDir: '/home/me/a"b' }, {});
    expect(escaped.argv).toContain('--property=ReadWritePaths="/home/me/a b" "/home/me/b%%u" "/home/me/a\\"b"');
  });
  it('refuses an untrusted entry before spawning the systemd client', async () => {
    const trust = vi.fn(async (path: string) => { if (path === '/opt/example/config-entry.js') throw new ConfigError('unsafe_target'); return path; });
    await expect(configUnitRunner(trust)(configUnit({ path: '/home/me/config.json', uid: 1001 }, {}, '/opt/example/node', '/opt/example/config-entry.js'))).rejects.toMatchObject({ code: 'unsafe_target' });
    expect(trust.mock.calls.map(call => call[0])).toEqual(['systemd-run', '/opt/example/node', '/opt/example/config-entry.js']);
  });
  it('captures the manager timeout before collecting a failed unit', async () => {
    const unit = configUnit({ path: '/home/me/config.json', uid: 1001 }, {}, '/opt/example/node', '/opt/example/config-entry.js');
    const launch = vi.fn((command: string, argv: readonly string[]) => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => {
        if (argv[0] === 'show') child.stdout.write('timeout\n');
        child.stdout.end(); child.emit('close', command === 'systemd-run' ? null : 0, command === 'systemd-run' ? 'SIGTERM' : null);
      });
      return child;
    });
    expect(await configUnitRunner(async command => command, launch as unknown as typeof spawn)(unit)).toEqual({ code: 1, stdout: '', result: 'timeout' });
    const name = unit.argv.find(argument => argument.startsWith('--unit='))!.slice(7) + '.service';
    expect(launch.mock.calls.map(([command, argv]) => [command, argv])).toEqual([
      ['systemd-run', unit.argv.slice(1)], ['systemctl', ['show', name, '--property=Result', '--value']], ['systemctl', ['reset-failed', name]],
    ]);
  });
});

it('wires status and fixed config routes independently of statusOnly without binding a port', async () => {
  const f = await fixture();
  const supervisor = createSupervisor({ config: configSchema.parse({ development: true, stateDir: f.stateDir, statusOnly: true }), registry: [], keys: [serverKey, launcherKey, rescueKey],
    exec: { async run() { return 0; } }, configVerbs: f.verbs,
    status: async () => ({ overall: 'ok', sentence: 'Everything is running.', components: [], busy: 'unknown', at: 1 }) });
  expect((await supervisor.status()).configVerbs).toMatchObject({ configWrites: true, verbs: ['config.read', 'config.request-status', 'config.apply', 'config.undo', 'credential.write', 'credential.test', 'service.drain-restart', 'service.drain-status', 'project.scan', 'checks.observe', 'usage.summary'] });
  async function call(path: string, body: unknown, token = 'fake-server-key', rescue = false) {
    const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
    req.method = 'POST'; req.url = path; req.headers = { authorization: 'Bearer ' + token };
    let resolve!: (result: { status: number; body: any }) => void;
    const answer = new Promise<{ status: number; body: any }>(done => { resolve = done; });
    const res = Object.assign(new EventEmitter(), { status: 0, headersSent: false, destroyed: false,
      writeHead(status: number) { this.status = status; return this; }, end(text: string) { resolve({ status: this.status, body: JSON.parse(text) }); }, destroy() {} });
    (rescue ? supervisor.rescue : supervisor.socket).emit('request', req, res as unknown as ServerResponse);
    return answer;
  }
  expect((await call('/v1/config/apply', f.request())).body.ok).toBe(true);
  expect((await call('/v1/actions', { verb: 'restart', target: 'paseo' })).status).toBe(403);
  expect((await call('/v1/config/apply', f.request(), 'fake-launcher-key')).body.code).toBe('not_permitted');
  expect((await call('/v1/config/read', { view: 'hermes.safety' }, 'fake-rescue-key', true)).status).toBe(403);
  expect((await call('/v1/busy', {}, 'fake-launcher-key')).status).toBe(403);
});

it('preserves multibyte text split across every byte in executor stdin', async () => {
  const request = { requestId: randomUUID(), operation: 'paseo.routing-note', params: { text: 'note 🦉 é' } };
  const chunks = [...Buffer.from(JSON.stringify(request))].map(byte => Buffer.from([byte]));
  expect(JSON.parse(await readConfigInput(Readable.from(chunks)))).toEqual(request);
  await expect(readConfigInput(Readable.from(chunks), 10)).rejects.toThrow();
});

it('preserves multibyte text split across every byte in the config HTTP body', async () => {
  const f = await fixture('paseo-config');
  const request = { requestId: randomUUID(), operation: 'paseo.routing-note', params: { text: 'note 🦉 é' } };
  const chunks = [...Buffer.from(JSON.stringify(request))].map(byte => Buffer.from([byte]));
  const supervisor = createSupervisor({ config: configSchema.parse({ development: true, stateDir: f.stateDir, statusOnly: true }), registry: [], keys: [serverKey],
    exec: { async run() { return 0; } }, configVerbs: f.verbs, status: async () => ({ overall: 'ok', sentence: 'Everything is running.', components: [], busy: 'unknown', at: 1 }) });
  const req = Readable.from(chunks) as IncomingMessage;
  req.method = 'POST'; req.url = '/v1/config/apply'; req.headers = { authorization: 'Bearer fake-server-key' };
  const response = new Promise<any>(resolve => {
    const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false,
      writeHead() { return this; }, end(text: string) { resolve(JSON.parse(text)); }, destroy() {} });
    supervisor.socket.emit('request', req, res as unknown as ServerResponse);
  });
  expect((await response).ok).toBe(true);
  expect(JSON.parse(await readFile(f.path, 'utf8')).daemon.appendSystemPrompt).toBe('note 🦉 é');
});

it('launches fixed availability probes as their configured owner with a read-only home', async () => {
  const f = await fixture();
  f.site.agentStatus = { home: f.root, runAs: { user: 'me', uid }, binaries: { claude: join(f.root, 'missing') } };
  const result = await f.verbs.read({ view: 'wayroost.agents' }, serverKey);
  expect(result).toMatchObject({ ok: true, view: 'wayroost.agents', values: [{ path: ['agents'], exists: true, value: [
    { id: 'claude', installed: false, authenticated: null }, { id: 'codex', installed: null, authenticated: null },
    { id: 'copilot', installed: null, authenticated: null },
  ] }] });
  expect(f.runner).toHaveBeenCalledTimes(1);
  const unit = f.runner.mock.calls[0]![0];
  expect(unit.argv).toEqual(expect.arrayContaining(['--uid=' + uid, '--property=ProtectHome=read-only',
    '--property=ProtectSystem=strict', '--property=PrivateNetwork=yes', '--property=ReadWritePaths=']));
  expect(unit.argv.join(' ')).not.toContain(f.root);
  expect(JSON.parse(unit.input).site.agentStatus).toEqual(f.site.agentStatus);
  expect(f.trust).toHaveBeenCalledWith('/opt/example/config-entry.js');
});

it('refuses availability probes under the server identity, root or an unsafe home', async () => {
  const f = await fixture();
  const request = { site: f.site, caller: 'server', verb: 'config.read', request: { view: 'wayroost.agents' } };
  expect(await f.verbs.read(request.request, serverKey)).toEqual({ ok: false, code: 'not_configured' });
  f.site.agentStatus = { home: f.root, runAs: { user: 'me', uid }, binaries: {} };
  expect(await executeConfig(request, { uid: uid + 1 })).toEqual({ ok: false, code: 'unsafe_target' });
  expect(await executeConfig(request, { uid: 0 })).toEqual({ ok: false, code: 'unsafe_target' });
  expect(await f.verbs.read(request.request, rescueKey)).toEqual({ ok: false, code: 'not_permitted' });
  await chmod(f.root, 0o777);
  try {
    expect(await f.verbs.read(request.request, serverKey)).toEqual({ ok: false, code: 'unsafe_directory' });
    expect(f.runner).not.toHaveBeenCalled();
  } finally { await chmod(f.root, 0o700); }
});

it('bounds availability unit failures and checks the observation identity', async () => {
  const f = await fixture();
  f.site.agentStatus = { home: f.root, runAs: { user: 'me', uid }, binaries: {} };
  f.runner.mockResolvedValueOnce({ code: 124, stdout: '' });
  expect(await f.verbs.read({ view: 'wayroost.agents' }, serverKey)).toEqual({ ok: false, code: 'timeout' });
  f.runner.mockResolvedValueOnce({ code: 0, stdout: 'x'.repeat(1024 * 1024 + 1) });
  expect(await f.verbs.read({ view: 'wayroost.agents' }, serverKey)).toEqual({ ok: false, code: 'unavailable' });
  f.runner.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ ok: true, view: 'hermes.safety', present: false, values: [] }) });
  expect(await f.verbs.read({ view: 'wayroost.agents' }, serverKey)).toEqual({ ok: false, code: 'verify_mismatch' });
  f.trust.mockRejectedValueOnce(new Error('untrusted'));
  expect(await f.verbs.read({ view: 'wayroost.agents' }, serverKey)).toEqual({ ok: false, code: 'unsafe_target' });
});
