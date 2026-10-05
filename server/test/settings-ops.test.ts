import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProviderOverridesSchema } from '@getpaseo/protocol/provider-config';
import { CONSUMER_TARGETS, GATEWAY_CONSUMERS, migrationTargetRecordSchema } from '../../shared/gateway.js';
import { MAX_OPERATION_KEYS, OPERATION_ID, changeResultSchema, formatKeyPath, isSecretKeyName, preconditionsSchema, recentChangeSchema, settingsAuditRecordSchema, timingSchema } from '../../shared/settings.js';
import { configAuditRowSchema, configReadResultSchema, configWriteResultSchema } from '../../shared/supervisor-config.js';
import { BUILTIN_PROVIDER_IDS } from '../src/paseo/safety-config.js';
import {
  CATALOGUE_VERSION, HERMES_OVERLAY_TIMING, OPERATION_IDS, PASEO_BUILTIN_PROVIDERS, READ_VIEWS, READ_VIEW_IDS, SETTINGS_OPERATIONS, operationKeyNames, operationKeys,
  operationSpec, operationTarget, operationTiming, parseOperation, publicKeyNames, readViewKeys, readViewValues, type OperationId, type OperationSpec,
} from '../../shared/settings-ops.js';
import { OWNER_FILE_TARGETS, READ_ONLY_TARGETS, ROOT_TARGETS, TARGET_IDS } from '../../shared/settings-targets.js';

const sha = 'e'.repeat(64);
const ROLE_URL = 'http://127.0.0.1:19031/v1';
const DIRECT_URL = 'http://127.0.0.1:19041/v1';

/** One valid request per operation; the test below checks that it covers the whole catalogue. */
const SAMPLES: Record<OperationId, Record<string, unknown>> = {
  'hermes.reasoning-effort': { effort: 'high' },
  'hermes.personality': { personality: 'concise' },
  'hermes.delegation-limits': { maxConcurrentChildren: 4, maxIterations: 100 },
  'paseo.provider-enabled': { provider: 'codex', enabled: false },
  'paseo.profile-model': { profile: 'demo-coder', model: 'wayroost-coder/coder' },
  'paseo.routing-note': { text: 'Send coding work to the coder.\n\tKeep it short.' },
  'hermes.default-model': { provider: 'wayroost-main', model: 'main', baseUrl: ROLE_URL },
  'hermes.delegation-model': { provider: 'demo-local', model: 'demo-model' },
  'hermes.delegation-fallbacks': { chain: [{ provider: 'wayroost-coder', model: 'coder' }, { provider: 'demo-local', model: 'demo-coder' }] },
  'hermes.main-fallbacks': { chain: [] },
  'hermes.helper-model': { task: 'compression', provider: 'wayroost-fast', model: 'fast' },
  'gateway.point': { role: 'main', backend: 'demo-main' },
  'gateway.credential': { provider: 'demo-cloud', action: 'set' },
  'hermes.approval-mode': { mode: 'manual' },
  'hermes.revoke-always': { entrySha256: sha },
  'hermes.skill-staging': { enabled: true },
  'paseo.worker-approvals': { enabled: true },
  'wayroost.safety-commands': { enabled: false },
  'wayroost.notifications': { push: { approvals: true, cards: false }, quietHours: { start: '21:00', end: '07:00' } },
  'hermes.prompt-keys-move': { toolUseEnforcement: ['demo', 'main'], executionGuidance: 'auto', reasoningEcho: false },
  'hermes.move-to-roles': { helperTasks: ['compression', 'title_generation'], directFallback: { provider: 'demo-local', model: 'demo-coder' } },
  'hermes.coder-mcp-path': {},
  'pi.coder-mcp-path': {},
  'pi.catalog-roles': {},
  'pi.default-move': {},
  'paseo.profile-move': { profile: 'demo-coder' },
  'gateway.restore-recorded': { consumer: 'hermes', target: 'hermes-config', serving: { provider: 'demo-local', model: 'demo-model', baseUrl: DIRECT_URL } },
  'gateway.reapply-intended': { consumer: 'pi', target: 'paseo-config' },
  'settings.accept-current': { change: 'ch_' + 'a'.repeat(24), target: 'hermes-config' },
  'gateway.socket-recover': {},
  'hermes.drain-marker-remove': {},
  'gateway.record-override': { role: 'coder', backend: null },
  'gateway.record-migration': { consumer: 'coder-mcp', target: 'pi-mcp', change: 'move' },
};

const entries = Object.entries(SETTINGS_OPERATIONS) as [OperationId, OperationSpec][];
const literalSegments = (spec: OperationSpec) => spec.keys === 'recorded' ? [] : spec.keys.flat().filter(segment => typeof segment === 'string') as string[];

describe('the catalogue', () => {
  it('has a sample for every operation, and each sample parses', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...OPERATION_IDS].sort());
    for (const [id, spec] of entries) expect(spec.params.safeParse(SAMPLES[id]).success, id).toBe(true);
    expect(CATALOGUE_VERSION).toBeGreaterThan(0);
  });

  it('names operations in one form, with a title and at least one caller', () => {
    for (const [id, spec] of entries) {
      expect(id).toMatch(OPERATION_ID);
      expect(spec.title.length).toBeGreaterThan(0);
      expect(spec.callers.length).toBeGreaterThan(0);
    }
  });

  it('carries the entries the gateway work depends on', () => {
    expect(SETTINGS_OPERATIONS['gateway.point']).toMatchObject({ target: 'gateway-role-map', records: 'override', lasts: 'until-next-switch', callers: ['server'] });
    expect(SETTINGS_OPERATIONS['pi.catalog-roles']).toMatchObject({ target: 'pi-models', consumer: 'pi', records: 'move' });
    expect(SETTINGS_OPERATIONS['pi.coder-mcp-path']).toMatchObject({ target: 'pi-mcp', consumer: 'coder-mcp', records: 'move' });
    expect(SETTINGS_OPERATIONS['gateway.record-override']).toMatchObject({ target: 'gateway-state', callers: ['supervisor'] });
    expect(SETTINGS_OPERATIONS['gateway.record-migration']).toMatchObject({ target: 'gateway-state', callers: ['supervisor'] });
  });

  it('refuses any parameter an operation does not declare', () => {
    for (const [id, spec] of entries) {
      expect(spec.params.safeParse({ ...SAMPLES[id], path: '/home/me/.demo/config.yaml' }).success, id).toBe(false);
      expect(spec.params.safeParse({ ...SAMPLES[id], command: 'id' }).success, id).toBe(false);
    }
  });

  it('writes only writable targets, owner files as their owner and the rest as root', () => {
    const writable = new Set<string>([...OWNER_FILE_TARGETS, ...ROOT_TARGETS]);
    for (const [id, spec] of entries) {
      const target = operationTarget(spec, SAMPLES[id]);
      expect(TARGET_IDS).toContain(target);
      expect(writable.has(target), id).toBe(true);
      expect((READ_ONLY_TARGETS as readonly string[]).includes(target), id).toBe(false);
    }
    expect(SETTINGS_OPERATIONS['gateway.credential'].verb).toBe('credential.write');
    expect(entries.filter(([, spec]) => spec.verb === 'credential.write').map(([id]) => id)).toEqual(['gateway.credential']);
  });

  it('keeps the supervisor\'s own records to the supervisor', () => {
    for (const [id, spec] of entries) {
      const internal = (spec.callers as readonly string[]).includes('supervisor');
      expect(internal, id).toBe(spec.target === 'gateway-state');
      if (internal) expect(spec.callers, id).toEqual(['supervisor']);
    }
  });

  it('ties every moved key to its consumer\'s files', () => {
    for (const [id, spec] of entries) {
      if (spec.records === 'move' || spec.records === 'intended') {
        expect(spec.consumer, id).toBeDefined();
        expect(CONSUMER_TARGETS[spec.consumer!], id).toContain(operationTarget(spec, SAMPLES[id]));
      }
      if (spec.records === 'move') expect(spec.callers, id).toEqual(['launcher']);
    }
  });

  it('never names a secret-looking key', () => {
    for (const [id, spec] of entries) for (const segment of literalSegments(spec)) expect(isSecretKeyName(segment), `${id}: ${segment}`).toBe(false);
  });

  it('resolves keys and timing for every sample', async () => {
    for (const [id, spec] of entries) {
      const names = await operationKeyNames(spec, SAMPLES[id]);
      if (spec.keys === 'recorded') expect(names).toBe('recorded');
      else if (spec.recovery || id === 'settings.accept-current') expect(names, id).toEqual([]);
      else expect((names as string[]).length, id).toBeGreaterThan(0);
      const changedKeys = spec.keys === 'recorded' ? [['model', 'default']] : undefined;
      const timing = await operationTiming(spec, SAMPLES[id], changedKeys);
      expect(timing.length, id).toBeGreaterThan(0);
      expect(timingSchema.safeParse(timing).success, id).toBe(true);
      expect(settingsAuditRecordSchema.safeParse({ id: 'ch_0123456789abcdef01234567', at: 1, action: 'apply', operation: id,
        target: operationTarget(spec, SAMPLES[id]), keys: names === 'recorded' ? [] : names, level: 'pc-only',
        timing: timing.map(note => note.label), result: 'ok' }).success, id).toBe(true);
    }
  });

  it('expands array parameters and finds Paseo profiles by id', async () => {
    expect(await operationKeyNames(SETTINGS_OPERATIONS['hermes.move-to-roles'], SAMPLES['hermes.move-to-roles']))
      .toEqual(expect.arrayContaining(['auxiliary.compression.provider', 'auxiliary.title_generation.model', 'providers.wayroost-main', 'model.base_url']));
    expect(operationKeys(SETTINGS_OPERATIONS['paseo.profile-model'], SAMPLES['paseo.profile-model']))
      .toEqual([['daemon', 'agentProfiles', { id: 'demo-coder' }, 'model']]);
    expect(await operationKeyNames(SETTINGS_OPERATIONS['paseo.provider-enabled'], SAMPLES['paseo.provider-enabled'])).toEqual(['agents.providers.codex.enabled']);
    expect(() => operationKeys(SETTINGS_OPERATIONS['hermes.helper-model'], {})).toThrow();
  });

  it('has a timing for every consumer file the recorded-state operations can name', async () => {
    for (const id of ['gateway.restore-recorded', 'gateway.reapply-intended'] as const) {
      for (const consumer of GATEWAY_CONSUMERS.filter(name => name !== 'phone')) {
        for (const target of CONSUMER_TARGETS[consumer]) {
          expect((await operationTiming(SETTINGS_OPERATIONS[id], { consumer, target }, [['model', 'default']])).length, `${id} ${consumer}/${target}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it.each(['gateway.restore-recorded', 'gateway.reapply-intended'] as const)('resolves %s timing from each changed Hermes key', async id => {
    const spec = SETTINGS_OPERATIONS[id];
    const params = { consumer: 'hermes', target: 'hermes-config' };
    for (const path of [['agent', 'tool_use_enforcement'], ['agent', 'execution_guidance'], ['model', 'reasoning_echo']]) {
      expect(await operationTiming(spec, params, [path])).toEqual([
        { surface: 'messaging', label: 'next-chat', keys: [path.join('.')] },
        { surface: 'api', label: 'next-chat', keys: [path.join('.')] },
        { surface: 'app-chats', label: 'next-chat', keys: [path.join('.')] },
        { surface: 'jobs', label: 'next-run', keys: [path.join('.')] },
      ]);
    }
    for (const key of ['provider', 'model', 'fallback_providers', 'max_concurrent_children', 'max_iterations']) {
      expect(await operationTiming(spec, params, [['delegation', key]])).toEqual([{ label: 'now', keys: [`delegation.${key}`] }]);
    }
    const mixed = await operationTiming(spec, params, [['model', 'provider'], ['model', 'base_url'], ['agent', 'execution_guidance'], ['delegation', 'model']]);
    expect(mixed).toEqual(expect.arrayContaining([
      { surface: 'app-chats', label: 'next-turn', keys: ['model.provider', 'model.base_url'], when: 'model-or-provider-changed' },
      { surface: 'app-chats', label: 'next-chat', keys: ['agent.execution_guidance'] },
      { label: 'now', keys: ['delegation.model'] },
    ]));
    expect(mixed.some(note => note.when === 'base-url-only')).toBe(false);
    const baseOnly = await operationTiming(spec, params, [['model', 'base_url']]);
    expect(baseOnly).toContainEqual({ surface: 'app-chats', label: 'next-chat', keys: ['model.base_url'], when: 'base-url-only' });
    expect(baseOnly.some(note => note.when === 'model-or-provider-changed')).toBe(false);
    expect(await operationTiming(spec, params, [['auxiliary', 'compression', 'model']])).toEqual([{ label: 'next-turn', keys: ['auxiliary.compression.model'] }]);
    expect(await operationTiming(spec, params, [['providers', 'wayroost-main']])).toEqual([
      { surface: 'messaging', label: 'next-turn', keys: ['providers.wayroost-main'] },
      { surface: 'api', label: 'next-turn', keys: ['providers.wayroost-main'] },
      { surface: 'app-chats', label: 'next-chat', keys: ['providers.wayroost-main'] },
      { surface: 'jobs', label: 'next-run', keys: ['providers.wayroost-main'] },
    ]);
    expect(timingSchema.safeParse(mixed).success).toBe(true);
    await expect(operationTiming(spec, params)).rejects.toThrow();
    await expect(operationTiming(spec, params, [])).rejects.toThrow();
    await expect(operationTiming(spec, params, [['unknown']])).rejects.toThrow();
  });

  it('writes and reads back notification rules with the existing preferences', async () => {
    const params = { ...SAMPLES['wayroost.notifications'], rules: [
      { event: 'agent-finished', source: 'hermes', delivery: 'neither' },
      { event: 'settings-applied', source: '*', delivery: 'toast' },
      { event: 'settings-failed', source: '*', delivery: 'both' },
      { event: 'mismatch-warning', source: 'supervisor', delivery: 'push' },
      { event: 'security-card', source: 'scout', delivery: 'neither' },
    ] };
    expect(parseOperation('wayroost.notifications', params, 'server')).toMatchObject({ ok: true, params });
    expect(await operationKeyNames(SETTINGS_OPERATIONS['wayroost.notifications'], params)).toEqual(['push', 'quietHours', 'rules']);
    expect(READ_VIEWS['wayroost.settings'].keys).toContainEqual(['rules']);
  });

  it('refuses provider changes whose complete read view exceeds the limit', () => {
    const providers = Object.fromEntries(Array.from({ length: 1025 }, (_, index) => [`demo-${index}`, { extends: 'pi', label: `Demo ${index}` }]));
    expect(ProviderOverridesSchema.safeParse(providers).success).toBe(true);
    const current = { agents: { providers } };
    expect(() => readViewKeys(READ_VIEWS['paseo.agents'], current)).toThrow('Too many read keys.');
    expect(() => operationKeys(SETTINGS_OPERATIONS['paseo.worker-approvals'], { enabled: true }, current)).toThrow('Too many read keys.');
    expect(Object.keys(providers)).toHaveLength(1025);
  });

  it('counts profile fields and missing built-ins before returning provider keys', () => {
    const count = Math.floor((MAX_OPERATION_KEYS - 1) / 3) - PASEO_BUILTIN_PROVIDERS.length;
    const providers = Object.fromEntries(Array.from({ length: count }, (_, index) => [`demo-${index}`, { extends: 'pi', label: `Demo ${index}` }]));
    const current = { agents: { providers }, daemon: { agentProfiles: [{ id: 'demo-profile', name: 'Demo', provider: 'pi' }] } };
    const before = structuredClone(current);
    expect(() => operationKeys(SETTINGS_OPERATIONS['paseo.worker-approvals'], { enabled: true }, current)).toThrow('Too many read keys.');
    expect(current).toEqual(before);
  });

  it.each([59, Math.floor((MAX_OPERATION_KEYS - 1) / 3) - PASEO_BUILTIN_PROVIDERS.length])('supports %s custom providers through complete reads, write results, preconditions, pages and both audits', async count => {
    const providers = Object.fromEntries(Array.from({ length: count }, (_, index) => [`demo-${index}`, { extends: 'pi', label: `Demo ${index}` }]));
    const keys = await operationKeyNames(SETTINGS_OPERATIONS['paseo.worker-approvals'], { enabled: true }, { agents: { providers } }) as string[];
    expect(keys).toHaveLength(count + PASEO_BUILTIN_PROVIDERS.length);
    const projected = { agents: { providers: { ...providers, ...Object.fromEntries(PASEO_BUILTIN_PROVIDERS.map(id => [id, {}])) } } };
    const readKeys = readViewKeys(READ_VIEWS['paseo.agents'], projected);
    expect(readKeys).toHaveLength(3 * keys.length + 1);
    expect(configReadResultSchema.safeParse({ ok: true, view: 'paseo.agents', present: true, sha256: sha,
      values: readKeys.map(path => ({ path, exists: false })) }).success).toBe(true);
    const common = { operation: 'paseo.worker-approvals', target: 'paseo-config', keys };
    const undo = { operation: common.operation, target: common.target, backupId: 'demo.bak', backupSha256: sha, writtenSha256: sha };
    expect(configWriteResultSchema.safeParse({ ...common, ok: true, backupId: 'demo.bak', backupSha256: sha, writtenSha256: sha, undo }).success).toBe(true);
    expect(preconditionsSchema.safeParse({ keys: keys.map((_, key) => ({ key, exists: false })) }).success).toBe(true);
    const change = { ...common, id: 'ch_0123456789abcdef01234567', timing: [{ label: 'next-chat' }], effective: 'pending', undoable: true };
    expect(changeResultSchema.safeParse(change).success).toBe(true);
    expect(recentChangeSchema.safeParse({ ...common, id: change.id, at: 1, action: 'apply', level: 'anywhere', timing: change.timing, result: 'ok', undoable: true }).success).toBe(true);
    expect(settingsAuditRecordSchema.safeParse({ ...common, id: change.id, at: 1, action: 'apply', level: 'anywhere', timing: ['next-chat'], result: 'ok' }).success).toBe(true);
    expect(configAuditRowSchema.safeParse({ ...common, id: '01234567-89ab-4cde-8fab-0123456789ab', time: '2026-01-02T03:04:05.000Z', caller: 'server', verb: 'config.apply', result: 'ok' }).success).toBe(true);
  });

  it.each([0, 1, 7])('allows a complete read at capacity with %s profiles and refuses the next provider', profileCount => {
    const count = Math.floor((MAX_OPERATION_KEYS - 4 * profileCount - 1) / 3) - PASEO_BUILTIN_PROVIDERS.length;
    const providers = Object.fromEntries(Array.from({ length: count }, (_, index) => [`demo-${index}`, { extends: 'pi', label: `Demo ${index}` }]));
    const agentProfiles = Array.from({ length: profileCount }, (_, index) => ({ id: `demo-profile-${index}`, name: 'Demo', provider: 'pi' }));
    const current = { agents: { providers }, daemon: { agentProfiles } };
    const spec = SETTINGS_OPERATIONS['paseo.worker-approvals'];
    expect(operationKeys(spec, { enabled: true }, current)).toHaveLength(count + PASEO_BUILTIN_PROVIDERS.length);
    const projected = { ...current, agents: { providers: { ...providers, ...Object.fromEntries(PASEO_BUILTIN_PROVIDERS.map(id => [id, {}])) } } };
    const paths = readViewKeys(READ_VIEWS['paseo.agents'], projected);
    expect(paths).toHaveLength(3 * (count + PASEO_BUILTIN_PROVIDERS.length) + 4 * profileCount + 1);
    expect(configReadResultSchema.safeParse({ ok: true, view: 'paseo.agents', present: true, sha256: sha,
      values: paths.map(path => ({ path, exists: false })) }).success).toBe(true);
    expect(() => operationKeys(spec, { enabled: true }, { ...current,
      agents: { providers: { ...providers, 'demo-extra': { extends: 'pi', label: 'Extra' } } } })).toThrow('Too many read keys.');
    expect(() => operationKeys(spec, { enabled: true }, { ...current,
      daemon: { agentProfiles: [...agentProfiles, { id: 'demo-extra', name: 'Extra', provider: 'pi' }] } })).toThrow('Too many read keys.');
  });

  it('counts a new provider entry when enabling an agent', () => {
    const providers = Object.fromEntries(Array.from({ length: Math.floor((MAX_OPERATION_KEYS - 1) / 3) }, (_, index) =>
      [`demo-${index}`, { extends: 'pi', label: `Demo ${index}` }]));
    const current = { agents: { providers } };
    expect(readViewKeys(READ_VIEWS['paseo.agents'], current)).toHaveLength(MAX_OPERATION_KEYS - 1);
    expect(() => operationKeys(SETTINGS_OPERATIONS['paseo.provider-enabled'], { provider: 'hermes', enabled: true }, current)).toThrow('Too many read keys.');
    expect(Object.hasOwn(current.agents.providers, 'hermes')).toBe(false);
  });

  it('refuses expansion and every key-bearing contract beyond the shared limit', async () => {
    const spec = SETTINGS_OPERATIONS['paseo.worker-approvals'];
    const providers = Object.fromEntries(Array.from({ length: MAX_OPERATION_KEYS - PASEO_BUILTIN_PROVIDERS.length + 1 }, (_, index) => [`demo-${index}`, { extends: 'pi', label: `Demo ${index}` }]));
    const current = { agents: { providers } };
    expect(() => operationKeys(spec, { enabled: true }, current)).toThrow('Too many operation keys.');
    await expect(operationKeyNames(spec, { enabled: true }, current)).rejects.toThrow('Too many operation keys.');
    expect(Object.keys(current.agents.providers)).toHaveLength(MAX_OPERATION_KEYS - PASEO_BUILTIN_PROVIDERS.length + 1);
    const keys = Array.from({ length: MAX_OPERATION_KEYS + 1 }, (_, index) => `agents.providers.demo-${index}.paseoTools`);
    const common = { operation: 'paseo.worker-approvals', target: 'paseo-config', keys };
    const undo = { operation: common.operation, target: common.target, backupId: 'demo.bak', backupSha256: sha, writtenSha256: sha };
    expect(configWriteResultSchema.safeParse({ ...common, ok: true, backupId: undo.backupId, backupSha256: sha, writtenSha256: sha, undo }).success).toBe(false);
    expect(preconditionsSchema.safeParse({ keys: keys.map((_, key) => ({ key, exists: false })) }).success).toBe(false);
    expect(preconditionsSchema.safeParse({ keys: [{ key: MAX_OPERATION_KEYS, exists: false }] }).success).toBe(false);
    const id = 'ch_0123456789abcdef01234567';
    expect(changeResultSchema.safeParse({ ...common, id, timing: [{ label: 'next-chat' }], effective: 'pending', undoable: true }).success).toBe(false);
    expect(recentChangeSchema.safeParse({ ...common, id, at: 1, action: 'apply', level: 'anywhere', timing: [{ label: 'next-chat' }], result: 'ok', undoable: true }).success).toBe(false);
    expect(settingsAuditRecordSchema.safeParse({ ...common, id, at: 1, action: 'apply', level: 'anywhere', timing: ['next-chat'], result: 'ok' }).success).toBe(false);
    expect(configAuditRowSchema.safeParse({ ...common, id: '01234567-89ab-4cde-8fab-0123456789ab', time: '2026-01-02T03:04:05.000Z', caller: 'server', verb: 'config.apply', result: 'ok' }).success).toBe(false);
    expect(timingSchema.safeParse([{ label: 'next-chat', keys }]).success).toBe(false);
    const recorded = keys.map((_, index) => ({ path: ['providers', `demo-${index}`], kind: 'recorded', before: { exists: false }, intended: { exists: false } }));
    const migration = { moved: false, preMoveBackupSha256: sha, postMoveSha256: sha };
    expect(migrationTargetRecordSchema.safeParse({ ...migration, keys: recorded.slice(0, MAX_OPERATION_KEYS) }).success).toBe(true);
    expect(migrationTargetRecordSchema.safeParse({ ...migration, keys: recorded }).success).toBe(false);
  });

  it('rejects expanded provider paths that cannot be read back or audited before returning keys', async () => {
    const spec = SETTINGS_OPERATIONS['paseo.worker-approvals'];
    const name = 'demo-'.padEnd(129, 'x');
    const providers = { [name]: { extends: 'pi', label: 'Demo provider' } };
    const current = { agents: { providers } };
    expect(() => operationKeys(spec, { enabled: true }, current)).toThrow('Invalid operation keys.');
    await expect(operationKeyNames(spec, { enabled: true }, current)).rejects.toThrow('Invalid operation keys.');
    expect(current.agents.providers).toEqual(providers);
  });

  it('labels process refreshes and session approvals when revoking an entry', async () => {
    expect(await operationTiming(SETTINGS_OPERATIONS['hermes.revoke-always'], SAMPLES['hermes.revoke-always'])).toEqual([
      { surface: 'app-chats', label: 'next-chat', refresh: 'next-app-chat-build', sessionApproval: 'until-session-ends' },
      { surface: 'messaging', label: 'restart-when-idle:hermes', refresh: 'next-always-answer', sessionApproval: 'until-session-ends' },
      { surface: 'api', label: 'restart-when-idle:hermes', refresh: 'next-always-answer', sessionApproval: 'until-session-ends' },
      { surface: 'jobs', label: 'next-run', sessionApproval: 'until-session-ends' }]);
    expect(await operationTiming(SETTINGS_OPERATIONS['hermes.personality'], {})).toEqual(HERMES_OVERLAY_TIMING);
    expect(await operationTiming(SETTINGS_OPERATIONS['gateway.credential'], {})).toEqual([{ label: 'restart-when-idle:gateway' }]);
    expect(await operationTiming(SETTINGS_OPERATIONS['hermes.coder-mcp-path'], {})).toEqual([
      { surface: 'messaging', label: 'restart-when-idle:hermes' }, { surface: 'app-chats', label: 'restart-now:dashboard' }]);
  });

  it('applies per-use settings now and describes each surface separately', async () => {
    for (const id of ['hermes.approval-mode', 'hermes.skill-staging', 'hermes.delegation-limits', 'hermes.delegation-model', 'hermes.delegation-fallbacks'] as const) {
      expect(await operationTiming(SETTINGS_OPERATIONS[id], SAMPLES[id]), id).toEqual([{ label: 'now' }]);
    }
    expect(await operationTiming(SETTINGS_OPERATIONS['hermes.reasoning-effort'], {})).toEqual([
      { surface: 'messaging', label: 'next-turn' }, { surface: 'api', label: 'next-turn' },
      { surface: 'app-chats', label: 'next-chat' }, { surface: 'jobs', label: 'next-run' },
    ]);
    expect(HERMES_OVERLAY_TIMING).toEqual([
      { surface: 'messaging', label: 'next-turn' }, { surface: 'api', label: 'not-used' },
      { surface: 'app-chats', label: 'next-chat' }, { surface: 'jobs', label: 'not-used' },
    ]);
    expect(await operationTiming(SETTINGS_OPERATIONS['hermes.default-model'], {})).toEqual([
      { surface: 'messaging', label: 'next-turn' }, { surface: 'api', label: 'next-turn' },
      { surface: 'app-chats', label: 'next-turn', keys: ['model.default', 'model.provider', 'model.base_url'], when: 'model-or-provider-changed' },
      { surface: 'app-chats', label: 'next-chat', keys: ['model.base_url'], when: 'base-url-only' },
      { surface: 'jobs', label: 'next-run' },
    ]);
  });

  it('resolves tools for existing providers and every missing built-in without authorising siblings', async () => {
    expect(PASEO_BUILTIN_PROVIDERS).toEqual(BUILTIN_PROVIDER_IDS);
    const spec = SETTINGS_OPERATIONS['paseo.worker-approvals'];
    const current = { agents: { providers: { 'demo-custom': { label: 'Demo', enabled: true }, claude: {} } } };
    const names = await operationKeyNames(spec, { enabled: true }, current,
      { scopes: ['settings', 'pc-settings'], listener: 'local', pcOnlyWrites: true });
    expect(names).toEqual([...PASEO_BUILTIN_PROVIDERS, 'demo-custom'].map(id => `agents.providers.${id}.paseoTools`));
    expect(await operationKeyNames(spec, { enabled: true })).toEqual(PASEO_BUILTIN_PROVIDERS.map(id => `agents.providers.${id}.paseoTools`));
    expect(names).not.toContain('agents.providers.demo-custom.enabled');
    expect(names).not.toContain('agents.providers.demo-custom.label');
    expect(current.agents.providers.claude).toEqual({});
  });
});

describe('parameters carry data, never paths, commands or hosts', () => {
  const refuses = (id: OperationId, patch: Record<string, unknown>) =>
    expect(SETTINGS_OPERATIONS[id].params.safeParse({ ...SAMPLES[id], ...patch }).success, JSON.stringify(patch)).toBe(false);

  it('refuses odd provider and model names', () => {
    for (const provider of ['../demo', 'demo provider', '-flag', '', 'a'.repeat(65)]) refuses('hermes.delegation-model', { provider });
    for (const model of ['demo model', '$(id)', 'demo;id', '`id`', '"quoted"', '']) refuses('hermes.delegation-model', { model });
    refuses('paseo.profile-model', { model: 'no-provider' });
    refuses('hermes.personality', { personality: '../../etc/passwd' });
  });

  it('keeps Hermes\' model address on loopback', () => {
    for (const baseUrl of ['http://example.com/v1', 'file:///etc/passwd', 'http://user:pass@127.0.0.1:19031/v1', 'http://127.0.0.1:19031/v1?x=1', 'http://127.0.0.1:19031/%2e%2e/v1']) {
      refuses('hermes.default-model', { baseUrl });
    }
  });

  it('identifies an "always" entry by its hash, never its text', () => {
    refuses('hermes.revoke-always', { entrySha256: 'git push --force*' });
    refuses('hermes.revoke-always', { entrySha256: 'E'.repeat(64) });
  });

  it('takes a routing note as plain text', () => {
    refuses('paseo.routing-note', { text: `hidden${String.fromCharCode(0x202e)}text` });
    refuses('paseo.routing-note', { text: `bell${String.fromCharCode(7)}` });
    refuses('paseo.routing-note', { text: 'x'.repeat(4001) });
    expect(SETTINGS_OPERATIONS['paseo.routing-note'].params.safeParse({ text: '' }).success).toBe(true);
  });

  it('lists each helper task once, from the known set', () => {
    refuses('hermes.move-to-roles', { helperTasks: ['compression', 'compression'] });
    refuses('hermes.move-to-roles', { helperTasks: ['vision'] });
    refuses('hermes.move-to-roles', { helperTasks: [] });
    refuses('hermes.helper-model', { task: 'vision' });
  });

  it('asks for the serving model exactly where a file has model-dependent keys', () => {
    const restore = (params: Record<string, unknown>) => SETTINGS_OPERATIONS['gateway.restore-recorded'].params.safeParse(params).success;
    const serving = { provider: 'demo-local', model: 'demo-model' };
    expect(restore({ consumer: 'hermes', target: 'hermes-config', serving })).toBe(false);
    expect(restore({ consumer: 'hermes', target: 'hermes-config' })).toBe(false);
    expect(restore({ consumer: 'pi', target: 'pi-settings', serving })).toBe(true);
    expect(restore({ consumer: 'pi', target: 'pi-models', serving, keepRoleEntries: true })).toBe(true);
    expect(restore({ consumer: 'pi', target: 'paseo-config' })).toBe(true);
    expect(restore({ consumer: 'pi', target: 'paseo-config', serving })).toBe(false);
    expect(restore({ consumer: 'coder-mcp', target: 'hermes-config' })).toBe(true);
    expect(restore({ consumer: 'coder-mcp', target: 'hermes-config', serving: { ...serving, baseUrl: DIRECT_URL } })).toBe(false);
    expect(restore({ consumer: 'pi', target: 'pi-settings', serving, keepRoleEntries: true })).toBe(false);
    expect(restore({ consumer: 'hermes', target: 'pi-mcp' })).toBe(false);
    expect(restore({ consumer: 'phone', target: 'hermes-config' })).toBe(false);
  });
});

describe('who may ask for an operation', () => {
  it('lets each caller reach its own operations only', () => {
    expect(parseOperation('hermes.approval-mode', { mode: 'manual' }, 'server')).toMatchObject({ ok: true, operation: 'hermes.approval-mode' });
    expect(parseOperation('hermes.approval-mode', { mode: 'manual' }, 'launcher')).toEqual({ ok: false, code: 'not_permitted' });
    expect(parseOperation('gateway.restore-recorded', SAMPLES['gateway.restore-recorded'], 'server')).toEqual({ ok: false, code: 'not_permitted' });
    expect(parseOperation('gateway.reapply-intended', SAMPLES['gateway.reapply-intended'], 'server')).toMatchObject({ ok: true });
    expect(parseOperation('gateway.reapply-intended', SAMPLES['gateway.reapply-intended'], 'launcher')).toMatchObject({ ok: true });
    expect(parseOperation('gateway.record-override', SAMPLES['gateway.record-override'], 'server')).toEqual({ ok: false, code: 'not_permitted' });
    expect(parseOperation('gateway.record-override', SAMPLES['gateway.record-override'], 'launcher')).toEqual({ ok: false, code: 'not_permitted' });
  });

  it('answers unknown operations and bad parameters with a code only', () => {
    for (const id of ['hermes.unknown', '__proto__', 'constructor', 'toString', 42, undefined]) {
      expect(parseOperation(id, {}, 'server')).toEqual({ ok: false, code: 'unknown_operation' });
    }
    expect(operationSpec('hasOwnProperty')).toBeUndefined();
    expect(parseOperation('hermes.approval-mode', { mode: 'yolo' }, 'server')).toEqual({ ok: false, code: 'invalid_parameters' });
    expect(parseOperation('hermes.approval-mode', 'mode=manual', 'server')).toEqual({ ok: false, code: 'invalid_parameters' });
    const smuggled = JSON.parse('{"mode": "manual", "__proto__": {"mode": "off"}}');
    expect(parseOperation('hermes.approval-mode', smuggled, 'server')).toEqual({ ok: false, code: 'invalid_parameters' });
  });

  it('fills defaults', () => {
    const parsed = parseOperation('gateway.restore-recorded', SAMPLES['gateway.restore-recorded'], 'launcher');
    expect(parsed.ok && parsed.params.keepRoleEntries).toBe(false);
  });
});

describe('read views', () => {
  const views = Object.entries(READ_VIEWS) as [string, { target: string; keys: readonly (readonly string[])[]; namesOnly?: boolean; order?: unknown }][];

  it('read known targets through named keys, never a whole consumer file', () => {
    expect(READ_VIEW_IDS.length).toBe(views.length);
    for (const [id, view] of views) {
      expect(TARGET_IDS, id).toContain(view.target);
      for (const key of view.keys) {
        expect(key.length, id).toBeGreaterThan(0);
        for (const segment of key) if (segment !== '*') expect(isSecretKeyName(segment), `${id}: ${segment}`).toBe(false);
        if (key.length === 1 && key[0] === '*') expect(view.namesOnly, id).toBe(true);
      }
    }
  });

  it('lists pinned keys by name only and pi\'s providers in their order', () => {
    expect(READ_VIEWS['hermes.managed']).toMatchObject({ target: 'hermes-managed', namesOnly: true });
    expect(READ_VIEWS['pi.models'].order).toEqual([['providers']]);
  });

  it('expands every provider and profile field, including absent leaves, without exposing secret names', () => {
    const current = { agents: { providers: { 'demo-provider': {}, 'api-key': {} } },
      daemon: { agentProfiles: [{ id: 'demo-profile', name: 'Demo', provider: 'pi' }] } };
    expect(readViewKeys(READ_VIEWS['paseo.agents'], current)).toEqual([
      ['agents', 'providers', 'demo-provider', 'enabled'], ['agents', 'providers', 'demo-provider', 'paseoTools', 'enabled'],
      ['agents', 'providers', 'demo-provider', 'paseoTools', 'disabledTools'],
      ['daemon', 'agentProfiles', 0, 'id'], ['daemon', 'agentProfiles', 0, 'name'],
      ['daemon', 'agentProfiles', 0, 'provider'], ['daemon', 'agentProfiles', 0, 'model'], ['daemon', 'appendSystemPrompt'],
    ]);
  });

  it('allows exactly the read limit and rejects one more value', () => {
    const view = { target: 'paseo-config' as const, keys: [['entries', '*']] };
    const entries = Array.from({ length: MAX_OPERATION_KEYS }, () => false);
    const paths = readViewKeys(view, { entries });
    expect(paths).toHaveLength(MAX_OPERATION_KEYS);
    const result = { ok: true, view: 'paseo.agents', present: true, sha256: sha, values: paths.map(path => ({ path, exists: true, value: false })) };
    expect(configReadResultSchema.safeParse(result).success).toBe(true);
    expect(() => readViewKeys(view, { entries: [...entries, false] })).toThrow('Too many read keys.');
    expect(configReadResultSchema.safeParse({ ...result, values: [...result.values, { path: ['entries', MAX_OPERATION_KEYS], exists: true, value: false }] }).success).toBe(false);
  });

  it('can read back every key a server operation writes in a consumer file', async () => {
    const readable = views.flatMap(([, view]) => view.keys.map(key => `${view.target}:${key.join('.')}`));
    const matches = (target: string, name: string) => readable.some(entry => {
      const [viewTarget, pattern] = entry.split(':') as [string, string];
      if (viewTarget !== target) return false;
      const parts = pattern.split('.');
      const wanted = name.split('.');
      return parts.length >= wanted.length && wanted.every((part, index) => parts[index] === '*' || parts[index] === part);
    });
    for (const [id, spec] of entries) {
      if (!(spec.callers as readonly string[]).includes('server') || spec.keys === 'recorded') continue;
      const target = operationTarget(spec, SAMPLES[id]);
      if (!(OWNER_FILE_TARGETS as readonly string[]).includes(target)) continue;
      for (const name of await operationKeyNames(spec, SAMPLES[id]) as string[]) {
        if (name.includes('[id=')) continue;
        expect(matches(target, name), `${id}: ${name}`).toBe(true);
      }
    }
  });

  const pc = { scopes: ['settings', 'pc-settings'] as const, listener: 'local' as const, pcOnlyWrites: true };
  const phone = { scopes: ['settings'] as const, listener: 'main' as const, pcOnlyWrites: true };
  const digest = (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return { sha256: createHash('sha256').update(text).digest('hex'), length: Buffer.byteLength(text) };
  };
  const identity = (name: string) => `sha256:${digest(name).sha256}`;

  it('digests dynamic provider names in change results and recent changes by default', async () => {
    const name = 'demo-private-provider-0123456789';
    const providers = { [name]: { extends: 'pi', label: 'Demo' } };
    expect(ProviderOverridesSchema.safeParse(providers).success).toBe(true);
    const spec = SETTINGS_OPERATIONS['paseo.worker-approvals'];
    const current = { agents: { providers } };
    const keys = await operationKeyNames(spec, { enabled: true }, current);
    expect(keys).toContain(`agents.providers["${identity(name)}"].paseoTools`);
    expect(JSON.stringify(keys)).not.toContain(name);
    const common = { operation: 'paseo.worker-approvals', target: 'paseo-config', keys, id: 'ch_0123456789abcdef01234567',
      timing: [{ label: 'next-chat' }], undoable: true };
    const change = changeResultSchema.parse({ ...common, effective: 'pending' });
    const recent = recentChangeSchema.parse({ ...common, at: 1, action: 'apply', level: 'anywhere', result: 'ok' });
    expect(JSON.stringify([change, recent])).not.toContain(name);
  });

  it('returns raw operation identities only to confirmed PC callers', async () => {
    const name = 'demo-private-profile';
    const spec = SETTINGS_OPERATIONS['paseo.profile-model'];
    const params = { profile: name, model: 'demo-local/demo-model' };
    for (const caller of [phone, { ...pc, listener: 'main' as const }, { ...pc, pcOnlyWrites: false },
      { ...phone, listener: 'local' as const }, { scopes: [] }, { scopes: phone.scopes }]) {
      expect(await operationKeyNames(spec, params, undefined, caller)).toEqual([`daemon.agentProfiles[id="${identity(name)}"].model`]);
    }
    expect(await operationKeyNames(spec, params, undefined, pc)).toEqual([`daemon.agentProfiles[id="${name}"].model`]);
  });

  it('uses the same identity projection for reads and recorded change metadata', async () => {
    const name = 'demo.private-provider';
    const current = { agents: { providers: { [name]: { enabled: false } } } };
    const paths = [['agents', 'providers', name, 'enabled']] as const;
    const rows = await readViewValues('paseo.agents', current, phone);
    const names = await publicKeyNames('paseo-config', paths, phone);
    expect(names).toEqual([formatKeyPath(rows.find(row => row.exists)!.path)]);
    expect(names).toEqual([`agents.providers["${identity(name)}"].enabled`]);
    expect(await publicKeyNames('paseo-config', paths, pc)).toEqual(paths.map(formatKeyPath));
    expect(paths[0][2]).toBe(name);
    expect(await publicKeyNames('paseo-config', paths)).toEqual(names);
    expect(await operationKeyNames(SETTINGS_OPERATIONS['gateway.reapply-intended'], SAMPLES['gateway.reapply-intended'])).toBe('recorded');
  });

  it('digests recorded provider identities in timing metadata outside confirmed PC access', async () => {
    const name = 'demo-private-provider';
    const spec = SETTINGS_OPERATIONS['gateway.reapply-intended'];
    const params = { consumer: 'hermes', target: 'hermes-config' };
    const paths = [['providers', name]] as const;
    const timing = await operationTiming(spec, params, paths);
    expect(timing).toHaveLength(4);
    expect(timing.every(note => note.keys?.[0] === `providers["${identity(name)}"]`)).toBe(true);
    expect(JSON.stringify(timing)).not.toContain(name);
    expect((await operationTiming(spec, params, paths, pc)).every(note => note.keys?.[0] === `providers.${name}`)).toBe(true);
  });

  it('preserves only fixed key names at their exact target and prefix', async () => {
    expect(await publicKeyNames('gateway-role-map', [['contracts', 'main', 'toolCalling'], ['backends', 'main', 'toolCalling']]))
      .toEqual(['contracts.main.toolCalling', `backends["${identity('main')}"].toolCalling`]);
    expect(await publicKeyNames('paseo-config', [['agents', 'providers', 'pi', 'paseoTools'], ['daemon', 'agentProfiles', 0, 'model']]))
      .toEqual(['agents.providers.pi.paseoTools', 'daemon.agentProfiles[0].model']);
    expect(await publicKeyNames('gateway-credentials', [['demo-private-provider']]))
      .toEqual([`["${identity('demo-private-provider')}"]`]);
    expect(await publicKeyNames('paseo-config', [['futureField', 'main']]))
      .toEqual([`["${identity('futureField')}"]["${identity('main')}"]`]);
  });

  it('refuses invalid public key paths and metadata beyond the shared limits', async () => {
    await expect(publicKeyNames('paseo-config', [['__proto__']])).rejects.toThrow('Invalid public keys.');
    await expect(publicKeyNames('paseo-config', Array.from({ length: MAX_OPERATION_KEYS + 1 }, () => ['daemon', 'appendSystemPrompt'])))
      .rejects.toThrow('Invalid public keys.');
    await expect(publicKeyNames('paseo-config', [Array.from({ length: 12 }, () => 'demo')])).rejects.toThrow('Invalid public keys.');
  });

  it('digests custom provider identities for every caller outside confirmed PC access', async () => {
    const name = 'demo-private-provider-0123456789';
    const providers = { [name]: { extends: 'pi', label: 'Demo', enabled: false, paseoTools: { enabled: false } } };
    expect(ProviderOverridesSchema.safeParse(providers).success).toBe(true);
    const current = { agents: { providers } };
    for (const caller of [phone, { ...pc, listener: 'main' as const }, { ...pc, pcOnlyWrites: false }, { ...phone, listener: 'local' as const }, { scopes: phone.scopes }]) {
      const rows = await readViewValues('paseo.agents', current, caller);
      expect(rows).toContainEqual({ path: ['agents', 'providers', identity(name), 'enabled'], exists: true, value: false });
      expect(rows.some(row => row.path.includes(identity(name)) && !row.exists)).toBe(true);
      expect(JSON.stringify(rows)).not.toContain(name);
      expect(configReadResultSchema.safeParse({ ok: true, view: 'paseo.agents', present: true, sha256: sha, values: rows }).success).toBe(true);
    }
    expect(await readViewValues('paseo.agents', current, pc)).toContainEqual({ path: ['agents', 'providers', name, 'enabled'], exists: true, value: false });
    expect(await readViewValues('paseo.agents', current, phone)).toEqual(await readViewValues('paseo.agents', current, phone));
  });

  it('keeps fixed role names literal only at their allowlisted wildcard prefix', async () => {
    const current = { contracts: { main: { toolCalling: true } }, backends: { main: { toolCalling: true } }, profiles: { main: { main: 'demo-backend' } } };
    const rows = await readViewValues('gateway.role-map', current, phone);
    expect(rows).toContainEqual({ path: ['contracts', 'main', 'toolCalling'], exists: true, value: true });
    expect(rows).toContainEqual({ path: ['backends', identity('main'), 'toolCalling'], exists: true, value: true });
    expect(rows).toContainEqual({ path: ['profiles', identity('main'), 'main'], exists: true, value: digest('demo-backend') });
  });

  it.each([
    ['hermes.models', { providers: { 'demo-private-name': { base_url: 'http://127.0.0.1:19041/v1' } } }, ['providers', 'demo-private-name', 'base_url']],
    ['hermes.managed', { providers: { 'demo-private-name': { base_url: 'http://127.0.0.1:19041/v1' } } }, ['providers', 'demo-private-name', 'base_url']],
    ['hermes.models', { auxiliary: { 'demo-private-name': { model: 'demo-model' } } }, ['auxiliary', 'demo-private-name', 'model']],
    ['pi.models', { providers: { 'demo-private-name': { models: [{ contextWindow: 1024 }] } } }, ['providers', 'demo-private-name', 'models', 0, 'contextWindow']],
    ['gateway.role-map', { backends: { 'demo-private-name': { toolCalling: true } } }, ['backends', 'demo-private-name', 'toolCalling']],
    ['gateway.role-map', { profiles: { 'demo-private-name': { main: 'demo-backend' } } }, ['profiles', 'demo-private-name', 'main']],
    ['gateway.role-map', { contracts: { 'demo-private-name': { toolCalling: true } } }, ['contracts', 'demo-private-name', 'toolCalling']],
    ['gateway.state', { state: { overrides: { 'demo-private-name': { by: 'launcher' } } } }, ['state', 'overrides', 'demo-private-name', 'by']],
    ['gateway.state', { migration: { consumers: { 'demo-private-name': { 'demo-private-target': { keys: [{ kind: 'recorded' }] } } } } },
      ['migration', 'consumers', 'demo-private-name', 'demo-private-target', 'keys', 0, 'kind']],
  ] as const)('digests all dynamic object identities in %s, including managed names', async (view, current, path) => {
    const publicPath = path.map(segment => typeof segment === 'string' && segment.startsWith('demo-private-') ? identity(segment) : segment);
    const rows = await readViewValues(view, current, phone);
    expect(rows).toContainEqual(expect.objectContaining({ path: publicPath, exists: true }));
    expect(JSON.stringify(rows)).not.toContain('demo-private-');
    expect(await readViewValues(view, current, pc)).toContainEqual(expect.objectContaining({ path, exists: true }));
    expect(configReadResultSchema.safeParse({ ok: true, view, present: true, sha256: sha, values: rows }).success).toBe(true);
  });

  it('projects consumer-valid tools policies as explicit fields and digests disabled tool names off the PC', async () => {
    for (const paseoTools of [{ enabled: false }, { disabledTools: ['demo-secret-tool'] }, { enabled: true, disabledTools: [] }, {}]) {
      const providers = { pi: { paseoTools } };
      expect(ProviderOverridesSchema.safeParse(providers).success).toBe(true);
      const current = { agents: { providers } };
      for (const caller of [pc, phone]) {
        const rows = await readViewValues('paseo.agents', current, caller);
        expect(rows).toContainEqual('enabled' in paseoTools
          ? { path: ['agents', 'providers', 'pi', 'paseoTools', 'enabled'], exists: true, value: paseoTools.enabled }
          : { path: ['agents', 'providers', 'pi', 'paseoTools', 'enabled'], exists: false });
        expect(rows).toContainEqual('disabledTools' in paseoTools
          ? { path: ['agents', 'providers', 'pi', 'paseoTools', 'disabledTools'], exists: true,
            value: caller === pc ? paseoTools.disabledTools : digest(paseoTools.disabledTools) }
          : { path: ['agents', 'providers', 'pi', 'paseoTools', 'disabledTools'], exists: false });
        expect(rows.some(row => row.path.length === 4 && row.path[3] === 'paseoTools')).toBe(false);
      }
    }
    const current = { agents: { providers: { pi: { paseoTools: { enabled: false, disabledTools: ['demo-secret-tool'], futureField: 'demo-secret' } } } } };
    for (const caller of [pc, phone]) {
      const rows = await readViewValues('paseo.agents', current, caller);
      expect(rows.some(row => row.path.includes('futureField'))).toBe(false);
      if (caller === phone) expect(JSON.stringify(rows)).not.toContain('demo-secret');
    }
  });

  it('returns backend URL paths and routing notes only on the confirmed PC listener', async () => {
    const baseUrl = 'https://api.example.com/demo-secret-path/v1';
    const text = 'demo secret café';
    const gateway = { backends: { 'demo-cloud': { baseUrl, toolCalling: true, headers: { Authorization: 'demo-secret' }, extra: text } } };
    const paseo = { agents: { providers: { pi: { enabled: true, env: { DEMO: text } } } }, daemon: { appendSystemPrompt: text } };
    for (const caller of [phone, { ...pc, listener: 'main' as const }, { ...pc, pcOnlyWrites: false }, { scopes: phone.scopes }]) {
      const urls = await readViewValues('gateway.role-map', gateway, caller);
      expect(urls).toContainEqual({ path: ['backends', identity('demo-cloud'), 'baseUrl'], exists: true, value: digest(baseUrl) });
      expect(urls).toContainEqual({ path: ['backends', identity('demo-cloud'), 'toolCalling'], exists: true, value: true });
      const notes = await readViewValues('paseo.agents', paseo, caller);
      expect(notes).toContainEqual({ path: ['daemon', 'appendSystemPrompt'], exists: true, value: digest(text) });
      expect(notes).toContainEqual({ path: ['agents', 'providers', 'pi', 'enabled'], exists: true, value: true });
      expect(JSON.stringify([urls, notes])).not.toContain('demo-secret');
    }
    const urls = await readViewValues('gateway.role-map', gateway, pc);
    expect(urls).toContainEqual({ path: ['backends', 'demo-cloud', 'baseUrl'], exists: true, value: baseUrl });
    expect(urls.some(row => row.path.includes('headers') || row.path.includes('extra'))).toBe(false);
    expect(await readViewValues('paseo.agents', paseo, pc)).toContainEqual({ path: ['daemon', 'appendSystemPrompt'], exists: true, value: text });
    await expect(readViewValues('paseo.agents', paseo, { ...pc, scopes: [] })).rejects.toThrow('Read not permitted.');
    await expect(readViewValues('constructor' as 'paseo.agents', paseo, pc)).rejects.toThrow('Read not permitted.');
  });

  it.each([
    ['hermes.safety', { command_allowlist: ['demo-secret'] }, ['command_allowlist'], ['demo-secret']],
    ['hermes.coder-mcp', { mcp_servers: { coder: { command: 'demo-secret', args: ['demo-secret'] } } }, ['mcp_servers', 'coder', 'args'], ['demo-secret']],
    ['pi.mcp', { mcpServers: { coder: { command: 'demo-secret', args: ['demo-secret'] } } }, ['mcpServers', 'coder', 'command'], 'demo-secret'],
    ['claude.permissions', { permissions: { allow: ['demo-secret'] } }, ['permissions', 'allow'], ['demo-secret']],
    ['opencode.permissions', { permission: { bash: { 'demo-secret': 'allow' } } }, ['permission'], { bash: { 'demo-secret': 'allow' } }],
    ['hermes.agents', { display: { personality: 'demo-secret' } }, ['display', 'personality'], 'demo-secret'],
    ['pi.settings', { defaultModel: 'demo-secret' }, ['defaultModel'], 'demo-secret'],
  ] as const)('digests free text in %s for a phone and returns it on the PC', async (view, current, path, value) => {
    expect(await readViewValues(view, current, phone)).toContainEqual({ path, exists: true, value: digest(value) });
    expect(await readViewValues(view, current, pc)).toContainEqual({ path, exists: true, value });
  });

  it('digests invalid safe-field shapes and omits unknown nested fields for every caller', async () => {
    const value = { note: 'demo-secret', enabled: true };
    const current = { agents: { providers: { pi: { enabled: value, paseoTools: { enabled: true }, futureField: 'demo-secret' } } } };
    const result = await readViewValues('paseo.agents', current, phone);
    expect(result).toContainEqual({ path: ['agents', 'providers', 'pi', 'enabled'], exists: true, value: digest(value) });
    expect(JSON.stringify(result)).not.toContain('demo-secret');
    for (const caller of [pc, phone]) {
      const rows = await readViewValues('paseo.agents', current, caller);
      expect(rows.some(row => row.path.includes('futureField'))).toBe(false);
      expect(rows).toContainEqual({ path: ['agents', 'providers', 'pi', 'enabled'], exists: true, value: digest(value) });
      const settings = await readViewValues('wayroost.settings', { push: { approvals: true, extra: 'demo-secret' }, rules: [], quietHours: null }, caller);
      expect(settings).toContainEqual({ path: ['push', 'approvals'], exists: true, value: true });
      expect(settings).toContainEqual({ path: ['push', 'cards'], exists: false });
      expect(settings).toContainEqual({ path: ['rules'], exists: true, value: [] });
      expect(JSON.stringify(settings)).not.toContain('demo-secret');
    }
  });

  it('validates safe strings and objects and returns an independent snapshot', async () => {
    const secret = 'demo-secret';
    expect(await readViewValues('codex.approvals', { approval_policy: secret, sandbox_mode: 'read-only' }, phone)).toEqual([
      { path: ['approval_policy'], exists: true, value: digest(secret) }, { path: ['sandbox_mode'], exists: true, value: 'read-only' },
    ]);
    const quietHours = { start: '21:00', end: '07:00', extra: secret };
    for (const caller of [pc, phone]) {
      expect(await readViewValues('wayroost.settings', { quietHours }, caller)).toContainEqual({ path: ['quietHours'], exists: true, value: digest(quietHours) });
    }
    const current = { rules: [{ event: 'agent-finished', source: 'hermes', delivery: 'toast' }], quietHours: { start: '21:00', end: '07:00' } };
    const rows = await readViewValues('wayroost.settings', current, phone);
    current.rules[0]!.delivery = secret;
    current.quietHours.start = secret;
    expect(JSON.stringify(rows)).not.toContain(secret);
    await expect(readViewValues('paseo.agents', { daemon: { appendSystemPrompt: undefined } }, phone)).rejects.toThrow('Invalid read value.');
  });

  it('keeps complete pi provider comparisons private and stable for every caller', async () => {
    const provider = { baseUrl: 'https://example.com/models', apiKey: 'invented-api-key',
      models: [{ id: 'example-model', headers: { 'x-example': 'invented-header' } }] };
    const current = { providers: { example: provider }, unrelated: 'invented-unrelated-value' };
    for (const caller of [pc, phone]) {
      const rows = await readViewValues('pi.providers', current, caller);
      expect(rows).toHaveLength(1);
      const held = rows[0]!;
      expect(held).toMatchObject({ exists: true, value: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), length: expect.any(Number) } });
      if (!held.exists) throw new Error('expected provider comparison');
      expect(JSON.stringify(rows)).not.toMatch(/invented-(?:api-key|header|unrelated-value)/);
      expect(await readViewValues('pi.providers', { providers: { example: held.value } }, caller)).toEqual(rows);
      for (const changed of [{ ...provider, apiKey: 'invented-other-key' },
        { ...provider, models: [{ id: 'example-model', headers: { 'x-example': 'invented-other-header' } }] }]) {
        const row = (await readViewValues('pi.providers', { providers: { example: changed } }, caller))[0]!;
        if (!row.exists) throw new Error('expected provider comparison');
        expect(row.value).not.toEqual(held.value);
      }
    }
    expect(await readViewValues('pi.providers', { providers: {} }, pc)).toEqual([]);
  });
  it('keeps nested migration values private for every caller', async () => {
    const value = { nested: [{ apiKey: 'invented-api-key-123' }], model: 'example-model' };
    const state = { migration: { version: 1, consumers: { hermes: { 'hermes-config': { keys: [
      { path: ['providers', 'example'], kind: 'recorded', before: { exists: true, value }, intended: { exists: true, value } },
    ] } } } } };
    for (const caller of [pc, phone]) {
      const rows = await readViewValues('gateway.state', state, caller);
      expect(JSON.stringify(rows)).not.toContain('invented-api-key-123');
      const values = rows.filter(row => row.path.at(-1) === 'value');
      expect(values).toHaveLength(2);
      expect(values.every(row => row.exists && row.value && typeof row.value === 'object' && 'sha256' in row.value)).toBe(true);
      expect(await readViewValues('gateway.state', state, caller)).toEqual(rows);
      const projected = { migration: { version: 1, consumers: { hermes: { 'hermes-config': { keys: [
        { path: ['providers', 'example'], kind: 'recorded', before: { exists: true, value: values[0]!.exists && values[0]!.value },
          intended: { exists: true, value: values[1]!.exists && values[1]!.value } },
      ] } } } } };
      expect(await readViewValues('gateway.state', projected, caller)).toEqual(rows);
    }
  });

  it('exposes only names of allowlisted managed fields, and never a whole state object', async () => {
    const managed = await readViewValues('hermes.managed', { agent: { reasoning_effort: 'demo-secret' }, extra: 'demo-secret' }, phone);
    expect(managed).toContainEqual({ path: ['agent', 'reasoning_effort'], exists: true });
    expect(JSON.stringify(managed)).not.toContain('demo-secret');
    expect(managed.some(row => row.path.includes('extra'))).toBe(false);
    const state = { state: { version: 1, profile: 'demo-secret', futureField: 'demo-secret' }, migration: { version: 1 } };
    for (const caller of [pc, phone]) {
      const rows = await readViewValues('gateway.state', state, caller);
      expect(rows.some(row => row.path.length === 1 || row.path.includes('futureField'))).toBe(false);
      expect(rows).toContainEqual({ path: ['state', 'profile'], exists: true, value: caller === pc ? 'demo-secret' : digest('demo-secret') });
    }
  });
});


it.each(['approve', 'deny'])('shows the actual cron mode %s to a settings caller', async mode => {
  const values = await readViewValues('hermes.safety', { approvals: { mode: 'smart', cron_mode: mode } }, { scopes: ['settings'] });
  expect(values).toContainEqual({ path: ['approvals', 'cron_mode'], exists: true, value: mode });
});
it.each(['smart', 'manual', 'yolo', 'unexpected'])('hides an invalid cron mode %s', async mode => {
  const values = await readViewValues('hermes.safety', { approvals: { cron_mode: mode } }, { scopes: ['settings'] });
  expect(values.find(value => value.path.join('.') === 'approvals.cron_mode')).toMatchObject({ value: { sha256: expect.any(String) } });
});
