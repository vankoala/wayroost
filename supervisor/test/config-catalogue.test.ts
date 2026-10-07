import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsTargetsSchema, type SettingsTargets } from '../../shared/settings-targets.js';
import { GATEWAY_ROLES, ROLE_PROVIDERS, roleMapSchema, gatewayMigrationSchema, type RoleMap, type MigrationTargetRecord } from '../../shared/gateway.js';
import { MAX_OPERATION_KEYS } from '../../shared/settings.js';
import { configWriteResultSchema, type ConfigWriteResult } from '../../shared/supervisor-config.js';
import { executeConfig } from '../src/config-executor.js';
import { ConfigVerbs } from '../src/config-verbs.js';
import { GatewayConfigState } from '../src/config-gateway-state.js';
import { executeGatewayPoint, gatewayAdminRequest } from '../src/config-gateway-point.js';
import { gatewayPointUnit, type ConfigUnitRunner } from '../src/config-unit.js';
import { ConfigAudit } from '../src/config-audit.js';
import { ConfigError, digest } from '../src/config-paths.js';
import { withConsumerLock } from '../src/config-locks.js';
import { configOperations } from '../src/config-operations.js';
import { hashKey, type Key } from '../src/keys.js';
import { yamlEditor } from '../../server/src/settings/editors/yaml.js';
import { z } from 'zod';

vi.mock('../src/config-hermes.js', () => ({ resolveHermesConfig: async (site: import('../../shared/settings-targets.js').SettingsTargets) => {
  const { readFile } = await import('node:fs/promises');
  const { yamlEditor } = await import('../../server/src/settings/editors/yaml.js');
  return yamlEditor.parse(await readFile(site.targets['hermes-config']!.path, 'utf8'));
} }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat), rename: vi.fn(actual.rename) };
});
vi.mock('node:http', () => ({ request: vi.fn() }));
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const roots: string[] = [];
const uid = process.getuid!();
const server: Key = { name: 'server', scope: 'server', sha256: hashKey('fake-server-key') };
const launcher: Key = { name: 'launcher', scope: 'server', sha256: hashKey('fake-launcher-key') };
beforeEach(() => {
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  vi.mocked(fs.lstat).mockImplementation(async (path, options) => {
    const stat = await actual.lstat(path, options);
    if (String(path) === '/') stat.uid = typeof stat.uid === 'bigint' ? 0n : 0;
    return stat;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function mapFixture(): RoleMap {
  const contracts = Object.fromEntries(GATEWAY_ROLES.map((role, index) => [role, {
    input: role === 'main' ? ['text'] : ['text', 'image'], toolCalling: true, thinkingLevels: role !== 'main',
    advertisedContext: 65536 * (index + 1), maxOutputTokens: 4096 * (index + 1),
  }]));
  const backend = { baseUrl: 'http://127.0.0.1:19041/v1', servedName: 'demo-model', listenerUid: uid,
    contextLength: 200000, maxOutputTokens: 16384, input: ['text', 'image'], toolCalling: true, thinkingLevels: true };
  return roleMapSchema.parse({ version: 2, contracts, backends: { 'demo-a': backend, 'demo-b': { ...backend, servedName: 'next-model' } },
    profiles: { 'demo/engine': { main: 'demo-a', coder: 'demo-a', fast: 'demo-a' } }, roles: { main: 'demo-a', coder: 'demo-a', fast: 'demo-a' } });
}

async function fixture() {
  const root = await fs.mkdtemp(join(process.cwd(), '.catalogue-test-')); roots.push(root);
  const sources = {
    'hermes-config': '# keep\nmodel:\n  provider: local-old\n  default: old-model\n  base_url: http://127.0.0.1:19041/v1\ndelegation:\n  provider: local-old\n  model: old-model\n  fallback_providers: []\nmcp_servers:\n  coder:\n    command: python3\n    args: [/home/me/demo/helper-mcp.py, --example]\nunrelated: yes # untouched\n',
    'pi-settings': '{"other":true,"defaultProvider":"local-old","defaultModel":"old-model"}\n',
    'pi-models': '{"other":1,"providers":{"local-old":{"baseUrl":"http://127.0.0.1:19041/v1","apiKey":"fake-key","models":[]},"local-next":{"models":[]},"extra":{"models":[]}}}\n',
    'pi-mcp': '{"mcpServers":{"coder":{"command":"python3","args":["/home/me/demo/helper-mcp.py","--example"]},"other":{"command":"example"}}}\n',
    'paseo-config': '{"version":1,"daemon":{"agentProfiles":[{"id":"demo","model":"local-old/old-model"}]},"agents":{"providers":{"pi":{"paseoTools":{"enabled":false,"disabledTools":["example_tool"]}},"custom":{"extends":"pi","label":"Demo","paseoTools":{"disabledTools":["example_tool","respond_to_permission"]}}}}}\n',
  };
  const targets: Record<string, unknown> = {};
  const paths: Record<keyof typeof sources, string> = {} as Record<keyof typeof sources, string>;
  for (const [id, source] of Object.entries(sources)) {
    const path = join(root, `${id}.${id === 'hermes-config' ? 'yaml' : 'json'}`);
    paths[id as keyof typeof sources] = path;
    await fs.writeFile(path, source, { mode: 0o600 });
    const backupDir = join(root, `${id}-backups`); const auditDir = join(root, `${id}-audit`);
    await fs.mkdir(backupDir, { mode: 0o700 }); await fs.mkdir(auditDir, { mode: 0o700 });
    const kind = id === 'pi-settings' ? 'pi' : id === 'paseo-config' ? 'paseo' : 'file';
    targets[id] = { path, format: id === 'hermes-config' ? 'yaml' : 'json', runAs: { user: 'me', uid }, mode: 0o600,
      backupDir, auditDir, lock: { kind, path: path + (kind === 'pi' ? '.lock' : kind === 'paseo' ? '.wayroost.lock' : '.wayroost-settings.lock') },
      ...(id === 'paseo-config' ? { loader: '/opt/example/paseo-loader.js' } : {}) };
  }
  targets['gateway-state'] = { directory: join(root, 'gateway-state'), backupDir: join(root, 'gateway-backups') };
  targets['gateway-role-map'] = { path: join(root, 'role-map.json'), defaultMap: join(root, 'default-map.json'), adminSocket: join(root, 'admin.sock'),
    service: 'example-gateway.service', socket: 'example-gateway.socket' };
  const site = settingsTargetsSchema.parse({ version: 1, configWrites: true, targets,
    roleAddresses: { main: 'http://127.0.0.1:18010/v1', coder: 'http://127.0.0.1:18011/v1', fast: 'http://127.0.0.1:18012/v1' },
    coderMcp: { original: '/home/me/demo/helper-mcp.py', gatewayCopy: '/opt/example/helper-mcp.py' } });
  let map = mapFixture();
  const roleMap = vi.fn(async () => ({ map: structuredClone(map), sha256: digest(JSON.stringify(map)) }));
  const store = new GatewayConfigState(site, uid, async (_path, _uid, work) => work());
  const reload = vi.fn(async () => true);
  const validatePaseo = vi.fn(async (source: string) => {
    z.object({ version: z.literal(1), daemon: z.object({ agentProfiles: z.array(z.object({ id: z.string(), model: z.string() }).strict()) }).strict(),
      agents: z.object({ providers: z.record(z.string(), z.object({ enabled: z.boolean().optional(), extends: z.string().optional(), label: z.string().optional(),
        paseoTools: z.object({ enabled: z.boolean().optional(), disabledTools: z.array(z.string()).optional() }).strict().optional() }).strict()) }).strict() }).strict().parse(JSON.parse(source));
  });
  const send = vi.fn(async (_socket: string, route: string, source: string) => {
    const role = GATEWAY_ROLES.find(role => route.endsWith(`/${role}`))!;
    const { backend } = JSON.parse(source) as { backend: string | null };
    map = roleMapSchema.parse({ ...map, roles: { ...map.roles, [role]: backend } });
    return { role, backend, applied: true };
  });
  const runner = vi.fn<ConfigUnitRunner>(async unit => {
    const payload = JSON.parse(unit.input);
    const result = 'socket' in payload ? await executeGatewayPoint(payload, send) : await executeConfig(payload, {
      validatePaseo, lock: (target, work) => withConsumerLock(target, work, async path => path),
    });
    return { code: 0, stdout: JSON.stringify(result) + '\n' };
  });
  const stateDir = join(root, 'supervisor'); const audit = new ConfigAudit(stateDir);
  const options = { stateDir, site: async () => site, runner, trust: async (path: string) => path, gatewayState: () => store, roleMap,
    executable: '/opt/example/node', entry: '/opt/example/config-entry.js', gatewayEntry: '/opt/example/config-gateway-entry.js', reloadPaseo: reload, audit };
  const verbs = new ConfigVerbs(options);
  const apply = (operation: string, params: Record<string, unknown> = {}, key = launcher) => verbs.apply({ requestId: randomUUID(), operation, params }, key);
  const read = async (target: keyof typeof sources) => {
    const source = await fs.readFile(paths[target], 'utf8');
    return target === 'hermes-config' ? yamlEditor.parse(source) as Record<string, any> : JSON.parse(source);
  };
  const renames = (target: keyof typeof sources) => vi.mocked(fs.rename).mock.calls.filter(([, path]) => String(path).endsWith('/' + paths[target].split('/').at(-1)!));
  return { root, sources, site, paths, store, verbs, options, audit, apply, read, renames, runner, roleMap, send, reload, validatePaseo };
}
function written(result: ConfigWriteResult) {
  expect(configWriteResultSchema.safeParse(result).success).toBe(true);
  if (!result.ok || !('undo' in result)) throw new Error('expected a verified write');
  return result;
}
const moveHermes = { helperTasks: ['compression', 'approval'], directFallback: { provider: 'local-next', model: 'next-model' } };

async function fillMigration(f: Awaited<ReturnType<typeof fixture>>, count = 32) {
  const value = '😀'.repeat(16_000);
  const record: MigrationTargetRecord = { moved: true, preMoveBackupSha256: 'a'.repeat(64), postMoveSha256: 'b'.repeat(64),
    keys: Array.from({ length: count }, (_, index) => ({ path: ['saved', String(index)], kind: 'recorded',
      before: { exists: true, value }, intended: { exists: true, value } })) };
  await f.store.withLock(() => f.store.recordMigration({ consumer: 'pi', target: 'pi-models', change: 'move' }, record, true));
  const path = join(f.site.targets['gateway-state']!.directory, 'gateway-migration.json');
  const source = await fs.readFile(path, 'utf8');
  expect(Buffer.byteLength(source)).toBeLessThan(4 * 1024 * 1024);
  expect(source.length).toBeLessThan(4 * 1024 * 1024);
  return { path, source };
}

describe('consumer moves and recorded values', () => {
  it.each(['apply', 'unchanged', 'undo'] as const)('filters recovery backups by the current path during %s after retargeting', async mode => {
    const f = await fixture(); const run = f.runner.getMockImplementation()!;
    const target = f.site.targets['pi-settings']!;
    const oldPath = target.path; const oldLock = target.lock.path;
    f.runner.mockImplementation(async unit => { await run(unit); return { code: 124, stdout: '' }; });
    const unresolved = await f.apply('pi.default-move');
    if (unresolved.ok || unresolved.code !== 'outcome_unknown' || !('backupId' in unresolved) || !unresolved.backupId) throw new Error('expected an unresolved move');
    const oldFolder = join(target.backupDir, 'files', digest(oldPath));
    const oldBackups = await fs.readdir(oldFolder);
    const oldBackup = await fs.readFile(join(target.backupDir, 'files', unresolved.backupId), 'utf8');
    const oldSource = await fs.readFile(oldPath, 'utf8');
    target.path = join(f.root, 'relocated-settings.json'); target.lock.path = target.path + '.lock';
    await fs.writeFile(target.path, f.sources['pi-settings'], { mode: 0o600 });
    f.runner.mockImplementation(run);
    const restarted = new ConfigVerbs(f.options);
    const request = { requestId: randomUUID(), operation: 'pi.default-move', params: {} };
    const movedResult = await restarted.apply(request, launcher);
    expect(movedResult).toMatchObject({ ok: true });
    const moved = written(movedResult);
    expect(moved.backupId.split('/')[0]).toBe(digest(target.path));
    await fs.writeFile(target.path, f.sources['pi-settings']);
    f.runner.mockImplementation(async unit => { await run(unit); return { code: 124, stdout: '' }; });
    const current = await restarted.apply({ ...request, requestId: randomUUID() }, launcher);
    if (current.ok || current.code !== 'outcome_unknown' || !('backupId' in current) || !current.backupId) throw new Error('expected an unresolved move');
    f.runner.mockImplementation(run); f.runner.mockClear();
    if (mode === 'apply') await fs.writeFile(target.path, f.sources['pi-settings']);
    const repair = { requestId: randomUUID(), operation: 'gateway.reapply-intended', params: { consumer: 'pi', target: 'pi-settings' } };
    const completed = written(await restarted.apply(repair, server));
    if (mode !== 'apply') expect(completed).toMatchObject({ unchanged: true });
    if (mode === 'undo') written(await restarted.undo({ requestId: randomUUID(), token: completed.undo }, server));
    for (const [unit] of f.runner.mock.calls) {
      const payload = JSON.parse(unit.input);
      if (payload.verb !== 'config.read') expect(payload.recoveryBackupIds).toEqual([current.backupId]);
    }
    expect(await fs.readFile(join(target.backupDir, 'files', current.backupId), 'utf8')).toBe(f.sources['pi-settings']);
    expect(await fs.readdir(oldFolder)).toEqual(oldBackups);
    expect(await fs.readFile(join(target.backupDir, 'files', unresolved.backupId), 'utf8')).toBe(oldBackup);
    expect(await fs.readFile(oldPath, 'utf8')).toBe(oldSource);
    target.path = oldPath; target.lock.path = oldLock;
    f.runner.mockClear();
    written(await restarted.apply({ ...request, requestId: randomUUID() }, launcher));
    const payload = JSON.parse(f.runner.mock.calls[0]![0].input);
    expect(payload.recoveryBackupIds).toEqual([unresolved.backupId]);
  });

  it.each(['one file', 'multiple files'] as const)('rejects aggregate reconciliation overflow across %s before consumer mutation', async scope => {
    const f = await fixture(); const count = scope === 'one file' ? 338 : 335;
    const config = await f.read('paseo-config');
    config.daemon.agentProfiles = Array.from({ length: count + 1 }, (_, index) => ({ id: `demo-${index}`, model: 'local-old/old-model' }));
    const source = JSON.stringify(config);
    await fs.writeFile(f.paths['paseo-config'], source);
    const record: MigrationTargetRecord = { moved: true, preMoveBackupSha256: digest(source), postMoveSha256: digest(source),
      keys: config.daemon.agentProfiles.slice(0, count).map((profile: { id: string }) => ({
        path: ['daemon', 'agentProfiles', { id: profile.id }, 'model'], kind: 'recorded',
        before: { exists: true, value: 'local-old/old-model' }, intended: { exists: true, value: 'local-old/old-model' },
      })) };
    await f.store.withLock(() => f.store.recordMigration({ consumer: 'pi', target: 'paseo-config', change: 'move' }, record, true));
    if (scope === 'multiple files') written(await f.apply('pi.default-move'));
    written(await f.apply('paseo.profile-move', { profile: 'demo-0' }));
    for (const role of GATEWAY_ROLES) written(await f.apply('gateway.point', { role, backend: 'demo-b' }, server));
    const before = await f.verbs.read({ view: 'gateway.state' }, server);
    if (!before.ok) throw new Error('expected a readable migration');
    expect(before.values).toHaveLength(scope === 'one file' ? 2047 : 2046);
    const migration = await f.store.migration();
    const consumer = await fs.readFile(f.paths['paseo-config'], 'utf8');
    const folder = join(f.site.targets['paseo-config']!.backupDir, 'files', digest(f.paths['paseo-config']));
    const backups = await fs.readdir(folder);
    f.runner.mockClear(); f.reload.mockClear(); f.validatePaseo.mockClear(); vi.mocked(fs.rename).mockClear();
    expect(await f.apply('paseo.profile-move', { profile: `demo-${count}` })).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(f.runner).not.toHaveBeenCalled(); expect(f.reload).not.toHaveBeenCalled(); expect(f.validatePaseo).not.toHaveBeenCalled();
    expect(fs.rename).not.toHaveBeenCalled();
    expect(await fs.readFile(f.paths['paseo-config'], 'utf8')).toBe(consumer);
    expect(await f.store.migration()).toEqual(migration);
    expect(await fs.readdir(folder)).toEqual(backups);
    expect(await f.verbs.read({ view: 'gateway.state' }, server)).toEqual(before);
    expect(await f.verbs.read({ view: 'paseo.agents' }, server)).toMatchObject({ ok: true, present: true });
  });

  it('rejects accumulated records that exceed the unit transport before a second move', async () => {
    const f = await fixture(); const config = await f.read('hermes-config');
    const value = Array.from({ length: 4 }, () => '😀'.repeat(16_000));
    config.agent = { tool_use_enforcement: value, execution_guidance: value };
    config.delegation.fallback_providers = Array.from({ length: 6 }, () => '😀'.repeat(16_000));
    config.providers = Object.fromEntries(GATEWAY_ROLES.map(role => [ROLE_PROVIDERS[role], '😀'.repeat(16_000)]));
    await fs.writeFile(f.paths['hermes-config'], JSON.stringify(config));
    written(await f.apply('hermes.prompt-keys-move', { toolUseEnforcement: true, executionGuidance: true, reasoningEcho: true }));
    const migration = await f.store.migration();
    const source = await fs.readFile(f.paths['hermes-config'], 'utf8');
    const folder = join(f.site.targets['hermes-config']!.backupDir, 'files', digest(f.paths['hermes-config']));
    const backups = await fs.readdir(folder);
    f.runner.mockClear(); vi.mocked(fs.rename).mockClear();
    expect(await f.apply('hermes.move-to-roles', moveHermes)).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(f.runner).not.toHaveBeenCalled();
    expect(await fs.readFile(f.paths['hermes-config'], 'utf8')).toBe(source);
    expect(await f.store.migration()).toEqual(migration);
    expect(await fs.readdir(folder)).toEqual(backups);
    expect(fs.rename).not.toHaveBeenCalled();
    written(await f.apply('gateway.reapply-intended', { consumer: 'hermes', target: 'hermes-config' }, server));
    written(await f.apply('gateway.restore-recorded', { consumer: 'hermes', target: 'hermes-config',
      serving: { provider: 'local-old', model: 'old-model', baseUrl: 'http://127.0.0.1:19041/v1' } }));
  });

  it.each(['request envelope', 'response envelope'] as const)('includes the %s when validating merged records', async limit => {
    const f = await fixture();
    const value = Array.from({ length: limit === 'request envelope' ? 16 : 9 }, () => 'x'.repeat(65_450));
    const record: MigrationTargetRecord = { moved: true, preMoveBackupSha256: 'a'.repeat(64), postMoveSha256: 'b'.repeat(64),
      keys: [{ path: ['agent', 'tool_use_enforcement'], kind: 'recorded',
        before: limit === 'request envelope' ? { exists: true, value } : { exists: false },
        intended: limit === 'response envelope' ? { exists: true, value } : { exists: true, value: true } }] };
    expect(Buffer.byteLength(JSON.stringify(record) + '\n')).toBeLessThan(1024 * 1024);
    if (limit === 'request envelope') expect(Buffer.byteLength(JSON.stringify(record) + '\n') + 800).toBeLessThan(1024 * 1024);
    await f.store.withLock(() => f.store.recordMigration({ consumer: 'hermes', target: 'hermes-config', change: 'move' }, record, true));
    const before = await f.store.migration();
    const validate = f.store.validateMigration.bind(f.store);
    vi.spyOn(f.store, 'validateMigration').mockImplementation((updates, check) => validate(updates, async migration => {
      expect(Buffer.byteLength(JSON.stringify(migration.consumers.hermes!['hermes-config']) + '\n')).toBeLessThan(1024 * 1024);
      await check?.(migration);
    }));
    const config = await f.read('hermes-config');
    config.agent = { tool_use_enforcement: record.keys[0]!.intended.exists ? record.keys[0]!.intended.value : undefined };
    const source = JSON.stringify(config);
    await fs.writeFile(f.paths['hermes-config'], source);
    vi.mocked(fs.rename).mockClear();
    const result = limit === 'request envelope' ? await f.apply('hermes.prompt-keys-move', {
      toolUseEnforcement: true, executionGuidance: true, reasoningEcho: true,
    }) : await f.apply('hermes.move-to-roles', moveHermes);
    expect(result).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(f.runner).not.toHaveBeenCalled();
    expect(await fs.readFile(f.paths['hermes-config'], 'utf8')).toBe(source);
    expect(await f.store.migration()).toEqual(before);
    expect(await fs.readdir(f.site.targets['hermes-config']!.backupDir)).toEqual([]);
    expect(fs.rename).not.toHaveBeenCalled();
  });

  it.each(['unchanged', 'apply', 'undo'] as const)('pins a lost-reply repair backup across restarts and %s retention until its audit is resolved', async mode => {
    const f = await fixture(); const now = Date.now(); const day = 24 * 60 * 60 * 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 31 * day);
    written(await f.apply('pi.default-move'));
    const drifted = JSON.stringify({ other: true, defaultProvider: 'outside', defaultModel: 'outside-model' });
    await fs.writeFile(f.paths['pi-settings'], drifted);
    const run = f.runner.getMockImplementation()!;
    f.runner.mockImplementation(async unit => { await run(unit); return { code: 124, stdout: '' }; });
    const request = { requestId: randomUUID(), operation: 'gateway.reapply-intended', params: { consumer: 'pi', target: 'pi-settings' } };
    const unresolved = await f.verbs.apply(request, server);
    if (unresolved.ok || unresolved.code !== 'outcome_unknown' || !('backupId' in unresolved) || !unresolved.backupId) throw new Error('expected an unresolved repair');
    const folder = join(f.site.targets['pi-settings']!.backupDir, 'files', digest(f.paths['pi-settings']));
    const backup = join(f.site.targets['pi-settings']!.backupDir, 'files', unresolved.backupId);
    expect(await fs.readFile(backup, 'utf8')).toBe(drifted);
    expect((await fs.readdir(folder)).some(name => name.endsWith('.recovery.json'))).toBe(false);
    f.runner.mockImplementation(run);
    const restarted = new ConfigVerbs(f.options);
    const completed: ReturnType<typeof written>[] = [];
    for (let index = 0; index < 12; index++) {
      clock.mockReturnValue(now + 2 * index);
      if (mode === 'apply') await fs.writeFile(f.paths['pi-settings'], drifted);
      completed.push(written(await restarted.apply({ ...request, requestId: randomUUID() }, server)));
      if (mode !== 'apply') expect(completed.at(-1)).toMatchObject({ unchanged: true });
      if (mode === 'undo') {
        clock.mockReturnValue(now + 2 * index + 1);
        completed.push(written(await restarted.undo({ requestId: randomUUID(), token: completed.at(-1)!.undo }, server)));
      }
    }
    expect(await fs.readFile(backup, 'utf8')).toBe(drifted);
    expect((await fs.readdir(folder)).sort()).toEqual([unresolved.backupId, ...completed.slice(-10).map(result => result.backupId)]
      .map(id => id.split('/')[1]!).sort());
    const pending = await f.audit.request(request.requestId);
    expect(pending!.row.result).toBe('outcome_unknown');
    await f.audit.save({ ...pending!, row: { ...pending!.row, result: 'failed' }, result: { ok: false, code: 'failed' } });
    clock.mockReturnValue(now + 24);
    written(await restarted.apply({ ...request, requestId: randomUUID() }, server));
    expect(await fs.readFile(backup, 'utf8').catch(() => undefined)).toBeUndefined();
  });

  it('bounds the combined undo context for two consumers of the same file', async () => {
    const f = await fixture(); const value = Array.from({ length: 9 }, () => '😀'.repeat(16_000));
    const record: MigrationTargetRecord = { moved: true, preMoveBackupSha256: 'a'.repeat(64), postMoveSha256: 'b'.repeat(64),
      keys: [{ path: ['agent', 'tool_use_enforcement'], kind: 'recorded', before: { exists: true, value }, intended: { exists: true, value: true } }] };
    await f.store.withLock(async () => {
      await f.store.recordMigration({ consumer: 'hermes', target: 'hermes-config', change: 'move' }, record, true);
      await f.store.recordMigration({ consumer: 'coder-mcp', target: 'hermes-config', change: 'move' }, { ...record,
        keys: [{ ...record.keys[0]!, path: ['mcp_servers', 'coder', 'args'], intended: { exists: true, value: [] } }] }, true);
    });
    const migration = await f.store.migration();
    expect(await f.apply('hermes.move-to-roles', moveHermes)).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(f.runner).not.toHaveBeenCalled();
    expect(await fs.readFile(f.paths['hermes-config'], 'utf8')).toBe(f.sources['hermes-config']);
    expect(await f.store.migration()).toEqual(migration);
    expect(await fs.readdir(f.site.targets['hermes-config']!.backupDir)).toEqual([]);
  });

  it.each(['undo', 'restore'] as const)('rejects a combined migration overflow before %s changes the consumer', async action => {
    const f = await fixture(); const config = await f.read('hermes-config');
    config.delegation.fallback_providers = Array.from({ length: 4 }, () => '😀'.repeat(16_000));
    await fs.writeFile(f.paths['hermes-config'], JSON.stringify(config));
    const moved = written(await f.apply('hermes.move-to-roles', moveHermes));
    let token = moved.undo;
    if (action === 'undo') {
      const drifted = await f.read('hermes-config');
      drifted.delegation.fallback_providers = config.delegation.fallback_providers;
      await fs.writeFile(f.paths['hermes-config'], JSON.stringify(drifted));
      token = written(await f.apply('hermes.delegation-fallbacks', { chain: [moveHermes.directFallback] }, server)).undo;
    }
    const migration = await fillMigration(f, 30);
    const source = await fs.readFile(f.paths['hermes-config'], 'utf8');
    const folder = join(f.site.targets['hermes-config']!.backupDir, 'files', digest(f.paths['hermes-config']));
    const backups = await fs.readdir(folder);
    f.runner.mockClear(); vi.mocked(fs.rename).mockClear();
    const result = action === 'undo' ? await f.verbs.undo({ requestId: randomUUID(), token }, server)
      : await f.apply('gateway.restore-recorded', { consumer: 'hermes', target: 'hermes-config',
        serving: { provider: 'local-old', model: 'old-model', baseUrl: 'http://127.0.0.1:19041/v1' } });
    expect(result).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(f.runner).not.toHaveBeenCalled();
    expect(await fs.readFile(f.paths['hermes-config'], 'utf8')).toBe(source);
    expect(await fs.readFile(migration.path, 'utf8')).toBe(migration.source);
    expect(await fs.readdir(folder)).toEqual(backups);
    expect(fs.rename).not.toHaveBeenCalled();
  });

  it('refuses a consumer change between migration validation and the owner lock', async () => {
    const f = await fixture(); const run = f.runner.getMockImplementation()!;
    const config = await f.read('pi-mcp');
    config.mcpServers.coder.args.push(...Array.from({ length: 4 }, () => '😀'.repeat(16_000)));
    const changed = JSON.stringify(config);
    f.runner.mockImplementation(async unit => {
      const input = JSON.parse(unit.input);
      expect(input.expectedSha256).toBe(digest(f.sources['pi-mcp']));
      await fs.writeFile(f.paths['pi-mcp'], changed);
      const output = await run(unit);
      expect(JSON.parse(output.stdout)).toEqual({ ok: false, code: 'precondition_changed' });
      return output;
    });
    expect(await f.apply('pi.coder-mcp-path')).toMatchObject({ ok: false, code: 'outcome_unknown' });
    expect(await fs.readFile(f.paths['pi-mcp'], 'utf8')).toBe(changed);
    expect(await fs.readdir(f.site.targets['pi-mcp']!.backupDir)).toEqual([]);
    expect(await f.store.record('coder-mcp', 'pi-mcp')).toBeUndefined();
  });

  it('rejects a combined migration byte overflow before launching or backing up the consumer', async () => {
    const f = await fixture(); const migration = await fillMigration(f);
    const config = await f.read('pi-mcp');
    config.mcpServers.coder.args.push(...Array.from({ length: 4 }, () => '😀'.repeat(16_000)));
    const source = JSON.stringify(config);
    await fs.writeFile(f.paths['pi-mcp'], source);
    vi.mocked(fs.rename).mockClear();
    expect(await f.apply('pi.coder-mcp-path')).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(f.runner).not.toHaveBeenCalled();
    expect(await fs.readFile(f.paths['pi-mcp'], 'utf8')).toBe(source);
    expect(await fs.readFile(migration.path, 'utf8')).toBe(migration.source);
    expect(await fs.readdir(f.site.targets['pi-mcp']!.backupDir)).toEqual([]);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(await f.store.record('pi', 'pi-models')).toBeDefined();
  });

  it('rejects a combined record key overflow before launching or backing up the consumer', async () => {
    const f = await fixture();
    const record: MigrationTargetRecord = { moved: true, preMoveBackupSha256: 'a'.repeat(64), postMoveSha256: 'b'.repeat(64),
      keys: Array.from({ length: MAX_OPERATION_KEYS }, (_, index) => ({ path: ['saved', String(index)], kind: 'recorded',
        before: { exists: false }, intended: { exists: false } })) };
    await fs.mkdir(f.site.targets['gateway-state']!.directory, { mode: 0o700 });
    await fs.writeFile(join(f.site.targets['gateway-state']!.directory, 'gateway-migration.json'),
      JSON.stringify({ version: 1, consumers: { 'coder-mcp': { 'pi-mcp': record } } }), { mode: 0o600 });
    const before = await f.store.migration();
    expect(await f.apply('pi.coder-mcp-path')).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(f.runner).not.toHaveBeenCalled();
    expect(await fs.readFile(f.paths['pi-mcp'], 'utf8')).toBe(f.sources['pi-mcp']);
    expect(await fs.readdir(f.site.targets['pi-mcp']!.backupDir)).toEqual([]);
    expect(await f.store.migration()).toEqual(before);
  });

  it('keeps the last ten backups after unchanged reapplications', async () => {
    const f = await fixture(); const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const results = [written(await f.apply('pi.default-move'))];
    const before = await fs.stat(f.paths['pi-settings']);
    for (let index = 1; index <= 15; index++) {
      clock.mockReturnValue(now + index);
      const result = written(await f.apply('gateway.reapply-intended', { consumer: 'pi', target: 'pi-settings' }, server));
      expect(result).toMatchObject({ unchanged: true });
      results.push(result);
    }
    const folder = join(f.site.targets['pi-settings']!.backupDir, 'files', digest(f.paths['pi-settings']));
    expect((await fs.readdir(folder)).sort()).toEqual(results.slice(-10).map(result => result.backupId.split('/')[1]!).sort());
    expect((await fs.stat(f.paths['pi-settings'])).ino).toBe(before.ino);
    written(await f.verbs.undo({ requestId: randomUUID(), token: results.at(-1)!.undo }, server));
  });

  it('expires old completed backups on unchanged reapplication and preserves unresolved recovery', async () => {
    const f = await fixture(); const now = Date.now(); const day = 24 * 60 * 60 * 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 31 * day);
    const expired = written(await f.apply('pi.default-move'));
    const folder = join(f.site.targets['pi-settings']!.backupDir, 'files', digest(f.paths['pi-settings']));
    const pinned = String(now - 32 * day).padStart(16, '0') + expired.backupId.split('/')[1]!.slice(16);
    await fs.writeFile(join(folder, pinned), 'unresolved backup', { mode: 0o600 });
    await fs.writeFile(join(folder, `${pinned}.recovery.json`), '{}\n', { mode: 0o600 });
    clock.mockReturnValue(now);
    const result = written(await f.apply('gateway.reapply-intended', { consumer: 'pi', target: 'pi-settings' }, server));
    expect(result).toMatchObject({ unchanged: true });
    expect((await fs.readdir(folder)).sort()).toEqual([pinned, `${pinned}.recovery.json`, result.backupId.split('/')[1]!].sort());
  });

  it.each([
    ['record value', ['x'.repeat(65_537)]],
    ['response bytes', Array.from({ length: 8 }, () => '😀'.repeat(20_000))],
  ] as const)('rejects oversized %s before changing or backing up the consumer', async (_limit, retained) => {
    const f = await fixture();
    const config = await f.read('pi-mcp');
    config.mcpServers.coder.args.push(...retained);
    const source = JSON.stringify(config);
    await fs.writeFile(f.paths['pi-mcp'], source);
    const result = await executeConfig({ site: f.site, caller: 'launcher', verb: 'config.apply', context: {},
      request: { requestId: randomUUID(), operation: 'pi.coder-mcp-path', params: {} } }, { lock: async (_target, work) => work() });
    expect(result.ok).toBe(false);
    expect(digest(await fs.readFile(f.paths['pi-mcp'], 'utf8'))).toBe(digest(source));
    expect(f.renames('pi-mcp')).toHaveLength(0);
    expect(await fs.readdir(f.site.targets['pi-mcp']!.backupDir)).toEqual([]);
  });

  it('moves Hermes using site addresses, records all keys and preserves the first pre-move values', async () => {
    const f = await fixture();
    written(await f.apply('hermes.prompt-keys-move', { toolUseEnforcement: ['main'], executionGuidance: true, reasoningEcho: true }));
    const first = await f.store.record('hermes', 'hermes-config');
    written(await f.apply('hermes.move-to-roles', moveHermes));
    const config = await f.read('hermes-config');
    expect(config.model).toEqual({ provider: ROLE_PROVIDERS.main, default: 'main', base_url: f.site.roleAddresses!.main, reasoning_echo: true });
    for (const role of GATEWAY_ROLES) expect(config.providers[ROLE_PROVIDERS[role]]).toEqual({ base_url: f.site.roleAddresses![role], api_key: 'unused' });
    expect(config.delegation).toEqual({ provider: ROLE_PROVIDERS.main, model: 'main', fallback_providers: [{ provider: ROLE_PROVIDERS.coder, model: 'coder' }, moveHermes.directFallback] });
    for (const task of moveHermes.helperTasks) expect(config.auxiliary[task]).toEqual({ provider: ROLE_PROVIDERS.fast, model: 'fast' });
    expect(await fs.readFile(f.paths['hermes-config'], 'utf8')).toContain('unrelated: yes # untouched');
    const record = (await f.store.record('hermes', 'hermes-config'))!;
    expect(record.preMoveBackupSha256).toBe(first!.preMoveBackupSha256);
    expect(record.keys.find(key => key.path.join('.') === 'model.provider')).toMatchObject({ kind: 'model-dependent', before: { exists: true, value: 'local-old' } });
    expect(record.keys.find(key => key.path.join('.') === 'agent.execution_guidance')).toMatchObject({ before: { exists: false }, intended: { exists: true, value: true } });
    expect(f.renames('hermes-config')).toHaveLength(2);
    const audit = await fs.readFile(join(f.options.stateDir, 'config-audit.jsonl'), 'utf8');
    for (const value of ['local-old', 'local-next', 'next-model', 'unused', 'http://']) expect(audit).not.toContain(value);
    expect(audit).not.toContain('record');
  });

  it('re-applies the latest intended choice, removes intended absent keys and writes nothing when already matched', async () => {
    const f = await fixture();
    written(await f.apply('hermes.prompt-keys-move', { toolUseEnforcement: null, executionGuidance: null, reasoningEcho: null }));
    written(await f.apply('hermes.move-to-roles', moveHermes));
    written(await f.apply('hermes.default-model', { provider: 'local-next', model: 'next-model', baseUrl: 'http://127.0.0.1:19042/v1' }, server));
    let config = await f.read('hermes-config');
    config.model.provider = 'outside'; config.model.reasoning_echo = true; config.unrelated = 'kept';
    await fs.writeFile(f.paths['hermes-config'], JSON.stringify(config));
    vi.mocked(fs.rename).mockClear();
    const reapplied = written(await f.apply('gateway.reapply-intended', { consumer: 'hermes', target: 'hermes-config' }, server));
    config = await f.read('hermes-config');
    expect(config.model).toEqual({ provider: 'local-next', default: 'next-model', base_url: 'http://127.0.0.1:19042/v1' });
    expect(config.unrelated).toBe('kept');
    expect(f.renames('hermes-config')).toHaveLength(1);
    const before = await fs.stat(f.paths['hermes-config']);
    written(await f.apply('gateway.reapply-intended', { consumer: 'hermes', target: 'hermes-config' }, server));
    expect((await fs.stat(f.paths['hermes-config'])).ino).toBe(before.ino);
    expect(f.renames('hermes-config')).toHaveLength(1);
    written(await f.verbs.undo({ requestId: randomUUID(), token: reapplied.undo }, server));
    expect((await f.read('hermes-config')).model.provider).toBe('outside');
    expect((await f.store.record('hermes', 'hermes-config'))!.keys.find(key => key.path.join('.') === 'model.provider')!.intended).toEqual({ exists: true, value: 'outside' });
  });

  it('restores Hermes by key kind in one write, including absent keys and the serving model after a switch', async () => {
    const f = await fixture();
    written(await f.apply('hermes.prompt-keys-move', { toolUseEnforcement: true, executionGuidance: true, reasoningEcho: true }));
    written(await f.apply('hermes.move-to-roles', moveHermes));
    vi.mocked(fs.rename).mockClear();
    written(await f.apply('gateway.restore-recorded', { consumer: 'hermes', target: 'hermes-config', serving: { provider: 'local-next', model: 'next-model', baseUrl: 'http://127.0.0.1:19042/v1' } }));
    const config = await f.read('hermes-config');
    expect(config.model).toEqual({ provider: 'local-next', default: 'next-model', base_url: 'http://127.0.0.1:19042/v1' });
    expect(config.delegation).toEqual({ provider: 'local-old', model: 'old-model', fallback_providers: [] });
    expect(config.agent).toEqual({}); expect(config.providers).toEqual({});
    for (const task of moveHermes.helperTasks) expect(config.auxiliary[task]).toEqual({});
    expect(f.renames('hermes-config')).toHaveLength(1);
    expect((await f.store.record('hermes', 'hermes-config'))!.moved).toBe(false);
    expect(await f.apply('gateway.restore-recorded', { consumer: 'hermes', target: 'hermes-config' })).toEqual({ ok: false, code: 'invalid_parameters' });
  });

  it.each([false, true])('adds pi contracts first and restores catalog order with keepRoleEntries=%s', async keepRoleEntries => {
    const f = await fixture(); const original = await f.read('pi-models');
    written(await f.apply('pi.catalog-roles'));
    const catalog = await f.read('pi-models');
    expect(Object.keys(catalog.providers)).toEqual([...Object.values(ROLE_PROVIDERS), 'local-old', 'local-next', 'extra']);
    for (const role of GATEWAY_ROLES) {
      expect(catalog.providers[ROLE_PROVIDERS[role]]).toMatchObject({ baseUrl: f.site.roleAddresses![role], api: 'openai-completions', models: [{
        id: role, input: mapFixture().contracts[role].input, reasoning: mapFixture().contracts[role].thinkingLevels,
        contextWindow: mapFixture().contracts[role].advertisedContext, maxTokens: mapFixture().contracts[role].maxOutputTokens,
      }] });
      expect(catalog.providers[ROLE_PROVIDERS[role]].models[0].thinkingLevelMap).toBeUndefined();
    }
    for (const name of ['local-old', 'local-next', 'extra']) expect(catalog.providers[name]).toEqual(original.providers[name]);
    expect((await f.store.record('pi', 'pi-models'))!.keys.find(key => key.kind === 'order')!.before).toEqual({ exists: true, value: ['local-old', 'local-next', 'extra'] });
    vi.mocked(fs.rename).mockClear();
    written(await f.apply('gateway.restore-recorded', { consumer: 'pi', target: 'pi-models', serving: { provider: 'local-next', model: 'next-model' }, keepRoleEntries }));
    const restored = await f.read('pi-models');
    expect(Object.keys(restored.providers)).toEqual(['local-next', 'local-old', 'extra', ...(keepRoleEntries ? Object.values(ROLE_PROVIDERS) : [])]);
    expect(restored.other).toBe(1); expect(f.renames('pi-models')).toHaveLength(1);
  });

  it('moves and restores pi defaults and the Paseo profile independently, validating and reloading Paseo', async () => {
    const f = await fixture();
    written(await f.apply('pi.default-move'));
    expect(await f.read('pi-settings')).toEqual({ other: true, defaultProvider: ROLE_PROVIDERS.main, defaultModel: 'main' });
    written(await f.apply('paseo.profile-move', { profile: 'demo' }));
    expect((await f.read('paseo-config')).daemon.agentProfiles[0].model).toBe('wayroost-coder/coder');
    written(await f.apply('gateway.restore-recorded', { consumer: 'pi', target: 'pi-settings', serving: { provider: 'local-next', model: 'next-model' } }));
    expect(await f.read('pi-settings')).toEqual({ other: true, defaultProvider: 'local-next', defaultModel: 'next-model' });
    written(await f.apply('gateway.restore-recorded', { consumer: 'pi', target: 'paseo-config' }));
    expect((await f.read('paseo-config')).daemon.agentProfiles[0].model).toBe('local-old/old-model');
    expect(f.reload).toHaveBeenCalledTimes(2);
    expect(gatewayMigrationSchema.safeParse(await f.store.migration()).success).toBe(true);
  });

  it.each([['hermes.coder-mcp-path', 'hermes-config'], ['pi.coder-mcp-path', 'pi-mcp']] as const)('moves and restores %s without a serving model', async (operation, target) => {
    const f = await fixture();
    written(await f.apply(operation));
    vi.mocked(fs.rename).mockClear();
    written(await f.apply('gateway.restore-recorded', { consumer: 'coder-mcp', target }));
    const restored = await f.read(target);
    expect((target === 'hermes-config' ? restored.mcp_servers : restored.mcpServers).coder.args).toEqual(['/home/me/demo/helper-mcp.py', '--example']);
    expect(f.renames(target)).toHaveLength(1);
  });
});

describe('Paseo approvals', () => {
  it('adds missing built-ins, preserves limits, verifies reload and undoes both policies and cloud-agent flags', async () => {
    const f = await fixture(); const before = await fs.readFile(f.paths['paseo-config'], 'utf8');
    const enabled = written(await f.apply('paseo.worker-approvals', { enabled: true }, server));
    let providers = (await f.read('paseo-config')).agents.providers;
    for (const id of ['claude', 'codex', 'copilot', 'opencode', 'pi', 'omp', 'custom']) expect(providers[id].paseoTools.disabledTools).toEqual(expect.arrayContaining(['respond_to_permission', 'set_agent_mode', 'update_agent']));
    expect(providers.pi.paseoTools.enabled).toBe(false);
    expect(providers.custom).toMatchObject({ extends: 'pi', label: 'Demo', paseoTools: { disabledTools: ['example_tool', 'respond_to_permission', 'set_agent_mode', 'update_agent'] } });
    written(await f.verbs.undo({ requestId: randomUUID(), token: enabled.undo }, server));
    expect(await fs.readFile(f.paths['paseo-config'], 'utf8')).toBe(before);
    const cloud = written(await f.apply('paseo.provider-enabled', { provider: 'codex', enabled: false }, server));
    expect((await f.read('paseo-config')).agents.providers.codex.enabled).toBe(false);
    written(await f.verbs.undo({ requestId: randomUUID(), token: cloud.undo }, server));
    const disabled = written(await f.apply('paseo.worker-approvals', { enabled: false }, server));
    providers = (await f.read('paseo-config')).agents.providers;
    expect(providers.custom.paseoTools.disabledTools).toEqual(['example_tool']);
    expect(providers.pi.paseoTools.enabled).toBe(false);
    written(await f.verbs.undo({ requestId: randomUUID(), token: disabled.undo }, server));
    expect(await fs.readFile(f.paths['paseo-config'], 'utf8')).toBe(before);
    expect(f.reload).toHaveBeenCalledTimes(6);
  });
});

describe('verified supervisor state', () => {
  it('reserves reconciliation keys for every role override before publishing a migration', async () => {
    const f = await fixture();
    const record: MigrationTargetRecord = { moved: true, preMoveBackupSha256: 'a'.repeat(64), postMoveSha256: 'b'.repeat(64),
      keys: Array.from({ length: 338 }, (_, index) => ({ path: ['saved', String(index)], kind: 'recorded',
        before: { exists: false }, intended: { exists: false } })) };
    await f.store.withLock(() => f.store.recordMigration({ consumer: 'pi', target: 'pi-models', change: 'move' }, record, true));
    const path = join(f.site.targets['gateway-state']!.directory, 'gateway-migration.json');
    const source = await fs.readFile(path, 'utf8');
    const update = { consumer: 'hermes' as const, target: 'hermes-config' as const, change: 'move' as const, record: { ...record, keys: [] } };
    vi.mocked(fs.rename).mockClear();
    await expect(f.store.validateMigration([update])).rejects.toMatchObject({ code: 'invalid_parameters' });
    await expect(f.store.withLock(() => f.store.recordMigration(update, update.record, true))).rejects.toMatchObject({ code: 'invalid_parameters' });
    expect(fs.rename).not.toHaveBeenCalled();
    expect(await fs.readFile(path, 'utf8')).toBe(source);
    for (const role of GATEWAY_ROLES) written(await f.apply('gateway.point', { role, backend: 'demo-b' }, server));
    const state = await f.verbs.read({ view: 'gateway.state' }, server);
    expect(state).toMatchObject({ ok: true, present: true });
    if (state.ok) expect(state.values).toHaveLength(2047);
  });

  it('validates intermediate migration publications when one request updates multiple consumers', async () => {
    const f = await fixture(); await fillMigration(f, 30);
    const value = Array.from({ length: 4 }, () => '😀'.repeat(16_000));
    const coder: MigrationTargetRecord = { moved: true, preMoveBackupSha256: 'c'.repeat(64), postMoveSha256: 'd'.repeat(64),
      keys: [{ path: ['mcp_servers', 'coder', 'args'], kind: 'recorded', before: { exists: false }, intended: { exists: true, value: [] } }] };
    const hermes: MigrationTargetRecord = { ...coder,
      keys: [{ path: ['delegation', 'fallback_providers'], kind: 'recorded', before: { exists: false }, intended: { exists: true, value } }] };
    await f.store.withLock(async () => {
      await f.store.recordMigration({ consumer: 'coder-mcp', target: 'hermes-config', change: 'move' }, coder, true);
      await f.store.recordMigration({ consumer: 'hermes', target: 'hermes-config', change: 'move' }, hermes, true);
      const migration = await f.store.migration();
      const before = structuredClone(migration);
      migration.consumers['coder-mcp']!['hermes-config']!.keys[0]!.intended = { exists: true, value };
      migration.consumers.hermes!['hermes-config']!.keys[0]!.intended = { exists: true, value: [] };
      expect(Buffer.byteLength(JSON.stringify(migration, null, 2) + '\n')).toBeLessThan(4 * 1024 * 1024);
      vi.mocked(fs.rename).mockClear();
      await expect(f.store.validateMigration([
        { consumer: 'coder-mcp', target: 'hermes-config', change: 'intended', record: { ...coder,
          keys: [{ ...coder.keys[0]!, intended: { exists: true, value } }] } },
        { consumer: 'hermes', target: 'hermes-config', change: 'intended', record: { ...hermes,
          keys: [{ ...hermes.keys[0]!, intended: { exists: true, value: [] } }] } },
      ])).rejects.toMatchObject({ code: 'invalid_parameters' });
      expect(fs.rename).not.toHaveBeenCalled();
      expect(await f.store.migration()).toEqual(before);
    });
  });

  it('rejects oversized combined migration output before replacing a readable state file', async () => {
    const f = await fixture(); const migration = await fillMigration(f);
    const value = Array.from({ length: 4 }, () => '😀'.repeat(16_000));
    const record: MigrationTargetRecord = { moved: true, preMoveBackupSha256: 'c'.repeat(64), postMoveSha256: 'd'.repeat(64),
      keys: [{ path: ['mcpServers', 'coder', 'args'], kind: 'recorded', before: { exists: true, value }, intended: { exists: true, value } }] };
    const prospective = await f.store.migration();
    prospective.consumers['coder-mcp'] = { 'pi-mcp': record };
    expect(JSON.stringify(prospective, null, 2).length).toBeLessThan(4 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(prospective, null, 2))).toBeGreaterThan(4 * 1024 * 1024);
    vi.mocked(fs.rename).mockClear();
    await expect(f.store.withLock(() => f.store.recordMigration({ consumer: 'coder-mcp', target: 'pi-mcp', change: 'move' }, record, true)))
      .rejects.toMatchObject({ code: 'invalid_parameters' });
    expect(fs.rename).not.toHaveBeenCalled();
    expect(await fs.readFile(migration.path, 'utf8')).toBe(migration.source);
    expect(await f.store.migration()).toEqual(gatewayMigrationSchema.parse(JSON.parse(migration.source)));
    expect(await fs.readdir(f.site.targets['gateway-state']!.directory)).toEqual(['gateway-migration.json']);
  });

  it('refuses device requests for internal operations and refuses unverified state writes', async () => {
    const f = await fixture();
    expect(await f.apply('gateway.record-override', { role: 'main', backend: 'demo-b' }, server)).toEqual({ ok: false, code: 'not_permitted' });
    expect(await f.apply('gateway.record-migration', { consumer: 'hermes', target: 'hermes-config', change: 'move' }, launcher)).toEqual({ ok: false, code: 'not_permitted' });
    expect(await fs.lstat(f.site.targets['gateway-state']!.directory).catch(() => undefined)).toBeUndefined();
    await f.store.withLock(async () => {
      await expect(f.store.recordOverride({ role: 'main', backend: 'demo-b' }, false)).rejects.toMatchObject({ code: 'verify_mismatch' });
      await expect(f.store.recordMigration({ consumer: 'hermes', target: 'hermes-config', change: 'move' }, {} as MigrationTargetRecord, false)).rejects.toMatchObject({ code: 'verify_mismatch' });
      expect(await fs.readdir(f.site.targets['gateway-state']!.directory)).toEqual([]);
      await f.store.recordOverride({ role: 'main', backend: 'demo-b' }, true);
      expect((await f.store.state()).overrides.main).toMatchObject({ backend: 'demo-b', by: 'wayroost' });
      await f.store.recordOverride({ role: 'main', backend: null }, true);
      expect((await f.store.state()).overrides).toEqual({});
      expect((await fs.stat(join(f.site.targets['gateway-state']!.directory, 'gateway-state.json'))).mode & 0o777).toBe(0o600);
    });
  });

  it.each(['lost-output', 'file-drift', 'state-write', 'bad-record', 'extra-key'] as const)('keeps an uncertain move read-only on retry after %s', async failure => {
    const f = await fixture(); const run = f.runner.getMockImplementation()!;
    f.runner.mockImplementation(async unit => {
      const output = await run(unit); const input = JSON.parse(unit.input);
      if (input.verb === 'config.apply') {
        if (failure === 'lost-output') return { code: 124, stdout: '' };
        if (failure === 'file-drift') await fs.writeFile(f.paths['hermes-config'], f.sources['hermes-config']);
        if (failure === 'bad-record') { const result = JSON.parse(output.stdout); result.record.postMoveSha256 = 'a'.repeat(64); return { ...output, stdout: JSON.stringify(result) }; }
        if (failure === 'extra-key') { const result = JSON.parse(output.stdout); result.record.keys.push({ path: ['unrelated'], kind: 'recorded', before: { exists: false }, intended: { exists: true, value: false } }); return { ...output, stdout: JSON.stringify(result) }; }
      }
      return output;
    });
    if (failure === 'state-write') vi.spyOn(f.store, 'recordMigration').mockRejectedValue(new ConfigError('verify_mismatch'));
    const request = { requestId: randomUUID(), operation: 'hermes.move-to-roles', params: moveHermes };
    const failed = await f.verbs.apply(request, launcher);
    expect(failed).toMatchObject({ ok: false, code: 'outcome_unknown', target: 'hermes-config' });
    expect(await f.store.record('hermes', 'hermes-config')).toBeUndefined();
    const calls = f.runner.mock.calls.length;
    const restarted = new ConfigVerbs(f.options);
    expect(await restarted.apply(request, launcher)).toEqual(failed);
    expect(f.runner).toHaveBeenCalledTimes(calls);
  });

  it('records nothing when Paseo reload verification fails', async () => {
    const f = await fixture(); f.reload.mockResolvedValue(false);
    expect(await f.apply('paseo.profile-move', { profile: 'demo' })).toMatchObject({ ok: false, code: 'outcome_unknown' });
    expect(await f.store.record('pi', 'paseo-config')).toBeUndefined();
  });

  it('refuses loader failures before backing up or changing any Paseo keys', async () => {
    const f = await fixture(); f.validatePaseo.mockRejectedValue(new Error('fake-loader-refusal'));
    const before = await fs.readFile(f.paths['paseo-config'], 'utf8');
    expect(await f.apply('paseo.worker-approvals', { enabled: true }, server)).toMatchObject({ ok: false, code: 'outcome_unknown' });
    expect(await fs.readFile(f.paths['paseo-config'], 'utf8')).toBe(before);
    expect(f.renames('paseo-config')).toHaveLength(0);
    expect(f.reload).not.toHaveBeenCalled();
    expect(await fs.readdir(f.site.targets['paseo-config']!.backupDir)).toEqual([]);
  });

  it('reads gateway reconciliation views without launching, locking or writing state', async () => {
    const f = await fixture();
    expect(await f.verbs.read({ view: 'gateway.state' }, server)).toEqual({ ok: true, view: 'gateway.state', present: false, values: [] });
    expect(await fs.lstat(f.site.targets['gateway-state']!.directory).catch(() => undefined)).toBeUndefined();
    written(await f.apply('hermes.move-to-roles', moveHermes));
    vi.mocked(fs.rename).mockClear(); const calls = f.runner.mock.calls.length;
    const state = await f.verbs.read({ view: 'gateway.state' }, server);
    expect(state).toMatchObject({ ok: true, present: true, values: expect.arrayContaining([{ path: ['migration', 'consumers', 'hermes', 'hermes-config', 'moved'], exists: true, value: true }]) });
    expect(await f.verbs.read({ view: 'gateway.role-map' }, launcher)).toMatchObject({ ok: true, present: true, sha256: (await f.roleMap()).sha256 });
    expect(f.runner).toHaveBeenCalledTimes(calls); expect(fs.rename).not.toHaveBeenCalled();
  });

  it('reads an absent role map from the filesystem without launching or writing', async () => {
    const f = await fixture();
    const verbs = new ConfigVerbs({ ...f.options, roleMap: undefined, gatewayUid: async () => uid });
    expect(await verbs.read({ view: 'gateway.role-map' }, server)).toEqual({ ok: true, view: 'gateway.role-map', present: false, values: [] });
    expect(f.runner).not.toHaveBeenCalled(); expect(fs.rename).not.toHaveBeenCalled();
    expect(await fs.lstat(f.site.targets['gateway-state']!.directory).catch(() => undefined)).toBeUndefined();
    const path = f.site.targets['gateway-role-map']!.path;
    vi.mocked(fs.lstat).mockImplementation(async (input, options) => {
      if (String(input) === path.slice(0, path.lastIndexOf('/'))) throw Object.assign(new Error(), { code: 'EACCES' });
      return actual.lstat(input, options);
    });
    expect(await verbs.read({ view: 'gateway.role-map' }, server)).toEqual({ ok: false, code: 'unsafe_directory' });
  });

  it('refuses missing configuration, stale hashes, invalid pairs and keys outside a catalogue request', async () => {
    const f = await fixture();
    expect(await f.verbs.apply({ requestId: randomUUID(), operation: 'hermes.move-to-roles', params: moveHermes, preconditions: { file: { sha256: 'a'.repeat(64) } } }, launcher)).toEqual(expect.objectContaining({ ok: false, code: 'outcome_unknown' }));
    expect(await f.store.record('hermes', 'hermes-config')).toBeUndefined();
    expect(await f.apply('gateway.reapply-intended', { consumer: 'pi', target: 'hermes-config' }, server)).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(await f.apply('gateway.reapply-intended', { consumer: 'hermes', target: 'hermes-config' }, server)).toMatchObject({ ok: false });
    const site: SettingsTargets = { ...f.site, roleAddresses: undefined };
    expect(() => configOperations('pi.catalog-roles', {}, 'launcher', {}, site, { roleMap: mapFixture() })).toThrow('not_configured');
    expect(await f.apply('hermes.move-to-roles', { ...moveHermes, path: '/home/me/other' })).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(await f.apply('hermes.move-to-roles', moveHermes, server)).toEqual({ ok: false, code: 'not_permitted' });
  });
});

describe('gateway pointing', () => {
  it('retains a durable backup bound to the pending audit when a repoint reply is lost', async () => {
    const f = await fixture(); const run = f.runner.getMockImplementation()!;
    const request = { requestId: randomUUID(), operation: 'gateway.point', params: { role: 'main', backend: 'demo-b' } };
    let pending: Awaited<ReturnType<ConfigAudit['request']>>;
    let sourceAtLaunch: string | undefined;
    f.runner.mockImplementation(async unit => {
      pending = await f.audit.request(request.requestId);
      sourceAtLaunch = await f.store.readBackup(pending!.row.backupId!).catch(() => undefined);
      await run(unit);
      return { code: 124, stdout: '' };
    });
    const result = await f.verbs.apply(request, server);
    expect(result).toMatchObject({ ok: false, code: 'outcome_unknown', backupId: pending!.row.backupId });
    expect(sourceAtLaunch).toBe(JSON.stringify({ role: 'main', backend: 'demo-a' }));
    expect(pending!.row).toMatchObject({ result: 'outcome_unknown', backupSha256: digest(sourceAtLaunch!) });
    expect(await f.store.readBackup(pending!.row.backupId!)).toBe(sourceAtLaunch);
    expect((await f.audit.request(request.requestId))!.row.backupSha256).toBe(digest(sourceAtLaunch!));
    expect((await f.roleMap()).map.roles.main).toBe('demo-b');
    expect((await f.store.state()).overrides).toEqual({});
    expect(await new ConfigVerbs(f.options).apply(request, server)).toEqual(result);
    expect(f.runner).toHaveBeenCalledTimes(1);
  });

  it('does not launch a repoint when its backup cannot be saved', async () => {
    const f = await fixture();
    vi.spyOn(f.store, 'backup').mockRejectedValue(new ConfigError('unsafe_directory'));
    expect(await f.apply('gateway.point', { role: 'main', backend: 'demo-b' }, server)).toEqual({ ok: false, code: 'unsafe_directory' });
    expect(f.runner).not.toHaveBeenCalled();
    expect((await f.roleMap()).map.roles.main).toBe('demo-a');
    expect((await f.store.state()).overrides).toEqual({});
  });

  it('keeps the last ten completed backups after points and undo', async () => {
    const f = await fixture(); const now = Date.now();
    const clock = vi.spyOn(Date, 'now');
    const completed: ReturnType<typeof written>[] = [];
    for (let index = 0; index < 12; index++) {
      clock.mockReturnValue(now + index);
      completed.push(written(await f.apply('gateway.point', { role: 'main', backend: index % 2 ? 'demo-a' : 'demo-b' }, server)));
    }
    clock.mockReturnValue(now + 12);
    const undone = written(await f.verbs.undo({ requestId: randomUUID(), token: completed.at(-1)!.undo }, server));
    const folder = join(f.site.targets['gateway-state']!.backupDir, undone.backupId.split('/')[0]!);
    expect((await fs.readdir(folder)).sort()).toEqual([...completed.slice(3).map(result => result.backupId.split('/')[1]!), undone.backupId.split('/')[1]!].sort());
    expect(await f.store.readBackup(undone.backupId)).toBeDefined();
  });

  it('expires completed backups after thirty days and pins unresolved backups across restarts', async () => {
    const f = await fixture(); const now = Date.now(); const day = 24 * 60 * 60 * 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 31 * day);
    const expired = written(await f.apply('gateway.point', { role: 'main', backend: 'demo-b' }, server));
    const run = f.runner.getMockImplementation()!;
    clock.mockReturnValue(now - 31 * day + 1);
    f.runner.mockImplementation(async unit => { await run(unit); return { code: 124, stdout: '' }; });
    const unresolved = await f.apply('gateway.point', { role: 'main', backend: 'demo-a' }, server);
    if (unresolved.ok || unresolved.code !== 'outcome_unknown' || !('backupId' in unresolved) || !unresolved.backupId) throw new Error('expected an unresolved point');
    f.runner.mockImplementation(run);
    clock.mockReturnValue(now - 29 * day);
    const recent = written(await f.apply('gateway.point', { role: 'main', backend: 'demo-b' }, server));
    clock.mockReturnValue(now);
    const restarted = new ConfigVerbs(f.options);
    const current = written(await restarted.apply({ requestId: randomUUID(), operation: 'gateway.point', params: { role: 'main', backend: 'demo-a' } }, server));
    const folder = join(f.site.targets['gateway-state']!.backupDir, current.backupId.split('/')[0]!);
    expect((await fs.readdir(folder)).sort()).toEqual([unresolved.backupId, recent.backupId, current.backupId].map(id => id.split('/')[1]!).sort());
    expect(await f.store.readBackup(expired.backupId).catch(() => undefined)).toBeUndefined();
    expect(await f.store.readBackup(unresolved.backupId)).toBeDefined();
  });

  it('launches a root unit with only a Unix-socket request, verifies the map, records the override and supports undo', async () => {
    const f = await fixture();
    const point = written(await f.apply('gateway.point', { role: 'main', backend: 'demo-b' }, server));
    const unit = f.runner.mock.calls[0]![0];
    expect(unit.argv).toContain('--uid=0'); expect(unit.argv).toContain('--property=RestrictAddressFamilies=AF_UNIX');
    expect(unit.argv).toContain('--property=PrivateNetwork=yes'); expect(unit.argv).toContain('--property=ReadWritePaths=');
    expect(unit.argv.slice(unit.argv.indexOf('--') + 1)).toEqual(['/opt/example/node', '/opt/example/config-gateway-entry.js']);
    expect(JSON.parse(unit.input)).toEqual({ socket: f.site.targets['gateway-role-map']!.adminSocket, role: 'main', body: { backend: 'demo-b' } });
    expect(f.send).toHaveBeenCalledExactlyOnceWith(f.site.targets['gateway-role-map']!.adminSocket, '/v1/roles/main', '{"backend":"demo-b"}');
    expect((await f.store.state()).overrides.main).toMatchObject({ backend: 'demo-b', by: 'wayroost' });
    const undo = written(await f.verbs.undo({ requestId: randomUUID(), token: point.undo }, server));
    expect((await f.roleMap()).map.roles.main).toBe('demo-a'); expect((await f.store.state()).overrides.main).toBeUndefined();
    written(await f.verbs.undo({ requestId: randomUUID(), token: undo.undo }, server));
    expect((await f.roleMap()).map.roles.main).toBe('demo-b'); expect((await f.store.state()).overrides.main!.backend).toBe('demo-b');
    const audit = await fs.readFile(join(f.options.stateDir, 'config-audit.jsonl'), 'utf8');
    expect(audit).not.toContain('demo-b'); expect(audit).not.toContain('admin.sock');
  });

  it.each(['reply', 'map', 'state'] as const)('records no override after a failed %s verification and never re-points on retry', async failure => {
    const f = await fixture(); const run = f.runner.getMockImplementation()!;
    if (failure === 'reply') f.runner.mockImplementation(async unit => { await run(unit); return { code: 0, stdout: '{"role":"coder","backend":"demo-b","applied":true}' }; });
    if (failure === 'map') f.send.mockImplementation(async () => ({ role: 'main', backend: 'demo-b', applied: true }));
    if (failure === 'state') vi.spyOn(f.store, 'recordOverride').mockRejectedValue(new ConfigError('verify_mismatch'));
    const request = { requestId: randomUUID(), operation: 'gateway.point', params: { role: 'main', backend: 'demo-b' } };
    const result = await f.verbs.apply(request, server);
    expect(result).toMatchObject({ ok: false, code: 'outcome_unknown', target: 'gateway-role-map' });
    expect((await f.store.state()).overrides).toEqual({});
    expect(await new ConfigVerbs(f.options).apply(request, server)).toEqual(result);
    expect(f.runner).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown backends, incompatible contracts and stale preconditions before launching', async () => {
    const f = await fixture();
    expect(await f.apply('gateway.point', { role: 'main', backend: 'missing' }, server)).toEqual({ ok: false, code: 'invalid_parameters' });
    const map = mapFixture(); map.backends['demo-b']!.toolCalling = false;
    f.roleMap.mockResolvedValue({ map, sha256: digest(JSON.stringify(map)) });
    expect(await f.apply('gateway.point', { role: 'main', backend: 'demo-b' }, server)).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(await f.verbs.apply({ requestId: randomUUID(), operation: 'gateway.point', params: { role: 'main', backend: 'demo-a' }, preconditions: { file: { sha256: 'a'.repeat(64) } } }, server)).toEqual({ ok: false, code: 'precondition_changed' });
    expect(f.runner).not.toHaveBeenCalled();
  });

  it('refuses untrusted unit programs and the write switch before repointing or recording', async () => {
    const f = await fixture();
    const verbs = new ConfigVerbs({ ...f.options, trust: async () => { throw new Error('fake-trust-refusal'); } });
    const request = { requestId: randomUUID(), operation: 'gateway.point', params: { role: 'main', backend: 'demo-b' } };
    expect(await verbs.apply(request, server)).toEqual({ ok: false, code: 'unsafe_target' });
    f.site.configWrites = false;
    expect(await f.verbs.apply({ ...request, requestId: randomUUID() }, server)).toEqual({ ok: false, code: 'config_writes_off' });
    expect(f.runner).not.toHaveBeenCalled(); expect((await f.store.state()).overrides).toEqual({});
  });

  it('accepts only the contract body and validates the admin answer', async () => {
    const send = vi.fn(async () => ({ role: 'main', backend: 'demo-a', applied: true }));
    const input = { socket: '/run/example/admin.sock', role: 'main', body: { backend: 'demo-a' } };
    expect(await executeGatewayPoint(input, send)).toEqual({ role: 'main', backend: 'demo-a', applied: true });
    expect(await executeGatewayPoint({ ...input, body: { backend: 'demo-a', command: 'example' } }, send)).toEqual({ ok: false, code: 'verify_mismatch' });
    expect(await executeGatewayPoint({ ...input, url: 'https://example.com' }, send)).toEqual({ ok: false, code: 'verify_mismatch' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(gatewayPointUnit(input).argv).not.toContain('sh');
  });

  it('uses socketPath without a TCP host and refuses redirects without following them', async () => {
    const { request } = await import('node:http');
    const output = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
    output.end = vi.fn(() => {
      const response = new EventEmitter() as EventEmitter & { statusCode: number; setEncoding: ReturnType<typeof vi.fn> };
      response.statusCode = 302; response.setEncoding = vi.fn();
      const callback = vi.mocked(request).mock.calls[0]![1] as (response: unknown) => void;
      callback(response); response.emit('data', '{"location":"https://example.com"}'); response.emit('end'); output.emit('close');
    });
    output.destroy = vi.fn(() => { output.emit('error', new Error()); output.emit('close'); });
    vi.mocked(request).mockReturnValue(output as unknown as ReturnType<typeof request>);
    await expect(gatewayAdminRequest('/run/example/admin.sock', '/v1/roles/main', '{"backend":"demo-a"}')).rejects.toMatchObject({ code: 'verify_mismatch' });
    expect(request).toHaveBeenCalledTimes(1);
    const options = vi.mocked(request).mock.calls[0]![0];
    expect(options).toMatchObject({ socketPath: '/run/example/admin.sock', method: 'PUT', agent: false });
    expect(options).not.toHaveProperty('hostname'); expect(options).not.toHaveProperty('port');
  });
});
