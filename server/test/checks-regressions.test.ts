import { describe, expect, it } from 'vitest';
import { fixtures, moveRecord, writtenKey, rowOf, DEMO_STATE, DEMO_ORIGINAL, DEMO_MAIN_ADDRESS, DEMO_MOVED_AT, hashOf } from './checks-fixtures.js';
import { hermesWritesPath } from '../src/checks/common.js';

const state = (keys: unknown[], moved = true) => ({ state: DEMO_STATE, migration: { version: 1, consumers: {
  hermes: { 'hermes-config': { ...moveRecord(keys), moved } },
} } });

describe('checks comparisons', () => {
  it('offers fixed catalogue recoveries for failed sockets and leftover markers', async () => {
    const rows = await fixtures({ gateway: { socketUnit: 'failed' }, sources: { drainMarker: async () => ({
      present: true, ours: true, requestedAt: 1000, drainRunning: false, unreadable: false,
    }) } }).rows();
    expect(rowOf(rows, 'gateway.socket-unit')).toMatchObject({ state: 'fail' });
    expect(rowOf(rows, 'hermes.drain-marker')).toMatchObject({ state: 'fail' });
    expect(rowOf(rows, 'gateway.socket-unit').fix).toEqual({ operation: 'gateway.socket-recover', params: {} });
    expect(rowOf(rows, 'hermes.drain-marker').fix).toEqual({ operation: 'hermes.drain-marker-remove', params: {} });
  });
  it('requires an available, present config before saying it parses', async () => {
    const absent = await fixtures({ documents: { 'hermes-config': null } }).rows();
    expect(rowOf(absent, 'hermes.reader-parse').state).toBe('fail');
    expect(rowOf(await fixtures({ sources: { readView: undefined } }).rows(), 'hermes.reader-parse').state).toBe('unknown');
  });

  it('does not compare the entire allowlist for drift', async () => {
    const rows = await fixtures({ documents: {
      'hermes-config': { command_allowlist: ['echo example', 'echo another'] },
      'gateway-state': state([writtenKey(['command_allowlist'], ['echo example', 'echo removed'], ['echo example'])]),
    } }).rows();
    expect(rowOf(rows, 'hermes.drift').state).toBe('ok');
    expect(rowOf(rows, 'hermes.drift').fix).toBeUndefined();
  });

  it('compares intended keys even when the consumer has not moved', async () => {
    const rows = await fixtures({ documents: {
      'hermes-config': { approvals: { mode: 'smart' } },
      'gateway-state': state([writtenKey(['approvals', 'mode'], 'off', 'manual')], false),
    } }).rows();
    expect(rowOf(rows, 'hermes.drift').state).toBe('warn');
  });

  it('rejects views from different versions of the same file', async () => {
    const fixture = fixtures({ documents: {
      'gateway-state': state([writtenKey(['approvals', 'mode'], 'off', 'manual')]),
    } });
    const read = fixture.sources.readView!;
    const rows = await fixture.rows({ readView: async view => ({ ...await read(view) as object,
      ...(view === 'hermes.safety' ? { sha256: hashOf('another snapshot') } : {}),
    }) });
    expect(rowOf(rows, 'hermes.drift').state).toBe('unknown');
    expect(rowOf(rows, 'hermes.stale-page').state).toBe('unknown');
  });

  it('reports a stale save in exactly one warning', async () => {
    const rows = await fixtures({ documents: {
      'hermes-config': { approvals: { mode: 'smart' }, display: { personality: 'warm' } },
      'gateway-state': state([writtenKey(['approvals', 'mode'], 'smart', 'manual'), writtenKey(['display', 'personality'], 'warm', 'focused')]),
    } }).rows();
    const warnings = rows.filter(row => ['hermes.drift', 'hermes.stale-page'].includes(row.id) && row.state === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.id).toBe('hermes.stale-page');
  });

  it('rejects a registration with a path prefix or a path in an unrelated argument', async () => {
    for (const args of [[DEMO_ORIGINAL + '.wrong'], ['/home/me/other.py', '--note=' + DEMO_ORIGINAL]]) {
      const rows = await fixtures({ documents: {
        'hermes-config': { mcp_servers: { coder: { command: 'python3', args } } },
        'pi-mcp': { mcpServers: { coder: { command: 'python3', args: [DEMO_ORIGINAL] } } },
      } }).rows();
      expect(rowOf(rows, 'coder-mcp.registrations').state).toBe('warn');
    }
  });

  it('detects a process still using the original script after a move', async () => {
    const rows = await fixtures({ documents: {
      'gateway-state': { state: DEMO_STATE, migration: { version: 1, consumers: { 'coder-mcp': {
        'pi-mcp': moveRecord([writtenKey(['mcpServers', 'coder'], 'original', 'copy')]),
      } } } },
    }, sources: { coderProcesses: async () => [{ script: 'original', startedAt: Date.parse(DEMO_MOVED_AT) - 1000 }] } }).rows();
    expect(rowOf(rows, 'coder-mcp.processes').state).toBe('warn');
  });

  it.each(['failed', 'verify_mismatch', 'consumer_refused'])('reports a failed executor result: %s', async result => {
    const rows = await fixtures({ sources: { recentChanges: async () => [{ id: 'fake-change', at: 1000, action: 'apply', result }] } }).rows();
    expect(rowOf(rows, 'supervisor.executor-run').state).toBe('fail');
    expect(rowOf(rows, 'supervisor.executor-run').details).toContain(result);
  });

  it('requires the output cap, address and thinking mapping of a static role entry', async () => {
    const contract = { input: ['text'], toolCalling: true, thinkingLevels: true, maxOutputTokens: 8192, advertisedContext: 200000 };
    const model = { id: 'main', input: ['text'], reasoning: true, contextWindow: 200000, maxTokens: 8192,
      thinkingLevelMap: { minimal: 'low', low: 'low', medium: 'medium', high: 'high' } };
    for (const entry of [
      { models: [model] },
      { baseUrl: DEMO_MAIN_ADDRESS, models: [{ ...model, input: ['text', 'image'] }] },
      { baseUrl: DEMO_MAIN_ADDRESS, models: [{ ...model, thinkingLevelMap: { ...model.thinkingLevelMap, high: 'invalid' } }] },
      { baseUrl: DEMO_MAIN_ADDRESS, models: [{ ...model, maxTokens: 1 }] },
      { baseUrl: DEMO_MAIN_ADDRESS, models: [{ ...model, maxTokens: undefined }] },
      { baseUrl: DEMO_MAIN_ADDRESS, models: [{ ...model, thinkingLevelMap: undefined }] },
    ]) {
      const rows = await fixtures({ documents: {
        'gateway-role-map': { contracts: { main: contract, coder: contract, fast: contract } }, 'pi-models': { providers: { 'wayroost-main': entry } },
      } }).rows();
      expect(rowOf(rows, 'pi.entries').state).toBe('fail');
    }
  });

  it('validates a profile provider independently of its catalogued model', async () => {
    const rows = await fixtures({ documents: { 'paseo-config': { daemon: { agentProfiles: [
      { id: 'fake-profile', provider: 'invalid-provider', model: 'demo/demo-model' },
    ] } } } }).rows();
    expect(rowOf(rows, 'paseo.profiles').state).toBe('fail');
  });
});

describe('effective consumer state', () => {
  it('uses the process start time even if the supervisor observed the state later', async () => {
    const rows = await fixtures({ sources: {
      revocations: async () => [{ entrySha256: hashOf('echo example'), revokedAt: 2000 }],
      hermesStartedAt: async () => 1000,
      supervisorStatus: async () => ({ overall: 'ok', sentence: 'Ready.', at: 4000, components: [
        { id: 'hermes-gateway', name: 'Hermes', state: 'up', since: 3000, sentence: 'Ready.', actions: [] },
      ] }),
    } }).rows();
    expect(rowOf(rows, 'allowlist.revoke-pending').state).toBe('warn');
  });

  it('counts existing agent pins when profiles have been deleted', async () => {
    const rows = await fixtures({ documents: { 'paseo-config': { daemon: { agentProfiles: [] } } }, sources: {
      paseoRuntime: async () => ({ providers: {}, agents: [
        { id: 'fake-agent-one', provider: 'pi', model: 'wayroost-main/main' },
        { id: 'fake-agent-two', provider: 'pi', model: 'demo/demo-model' },
      ] }),
    } }).rows();
    expect(rowOf(rows, 'paseo.pinned-agents').sentence).toContain('1 Paseo agent');
    expect(rowOf(rows, 'paseo.pinned-agents').details).toContain('1 on direct providers');
  });

  it('uses effective provider switches, including defaults and overrides', async () => {
    for (const enabled of [true, false]) {
      const rows = await fixtures({ documents: { 'paseo-config': { agents: { providers: { pi: {} } } } }, sources: {
        switchFlags: async () => ({ pi: true }),
        paseoRuntime: async () => ({ agents: [], providers: { pi: { enabled, models: [] } } }),
      } }).rows();
      expect(rowOf(rows, 'paseo.switch-flags').state).toBe(enabled ? 'ok' : 'warn');
    }
  });

  it('resolves a non-pi profile through its own provider catalog', async () => {
    const rows = await fixtures({ documents: { 'paseo-config': { daemon: { agentProfiles: [
      { id: 'fake-profile', provider: 'codex', model: 'example-model' },
    ] } } }, sources: { paseoRuntime: async () => ({ agents: [], providers: { codex: { enabled: true, models: ['example-model'] } } }) } }).rows();
    expect(rowOf(rows, 'paseo.profiles').state).toBe('ok');
  });

  it('compares the live phone pin and requires the main model explicitly', async () => {
    const record = { state: DEMO_STATE, migration: { version: 1, consumers: { phone: {
      'phone-bridge-dropin': moveRecord([writtenKey(['Service', 'Environment'], 'old', DEMO_MAIN_ADDRESS)]),
    } } } };
    for (const model of ['main', 'coder', 'fast']) {
      const rows = await fixtures({ documents: { 'gateway-state': record }, sources: { phone: async () => ({
        server: { ok: true, value: { activeCalls: 0, webhooks: 0, outboundCalls: 0 } },
        bridge: { ok: true, value: { activeCalls: 0, oldestCallMs: 0 } },
        pin: { ok: true, value: { address: DEMO_MAIN_ADDRESS, model } },
      }) } }).rows();
      expect(rowOf(rows, 'phone.address').state).toBe(model === 'main' ? 'ok' : 'warn');
    }
    expect(rowOf(await fixtures({ documents: { 'gateway-state': record } }).rows(), 'phone.address').state).toBe('unknown');
  });
});


it('does not offer drain recovery while the executor unit is unavailable', async () => {
  const rows = await fixtures({ sources: { drainMarker: async () => ({
    present: true, ours: true, requestedAt: 1000, drainRunning: null, unreadable: false,
  }) } }).rows();
  const row = rowOf(rows, 'hermes.drain-marker');
  expect(row.state).toBe('unknown');
  expect(row.fix).toBeUndefined();
});

it('does not count an unresolved pi model as a direct provider pin', async () => {
  const rows = await fixtures({ sources: { paseoRuntime: async () => ({
    providers: {}, agents: [{ id: 'fake-unresolved-agent', provider: 'pi', model: null }],
  }) } }).rows();
  expect(rowOf(rows, 'paseo.pinned-agents').state).toBe('unknown');
});


describe('incomplete and normalized comparisons', () => {
  it.each([
    { providers: { 'wayroost-main': { api_key: 'example-placeholder' } } },
    { providers: { 'wayroost-main': { models: [{ id: 'example-model' }] } } },
    { providers: { 'wayroost-coder': { options: { enabled: true } } } },
    { mcp_servers: { coder: { args: ['/home/me/example.py'] } } },
  ])('observes managed pins throughout whole-provider and MCP argument writes', async managed => {
    const rows = await fixtures({ documents: { 'hermes-managed': managed } }).rows();
    expect(rowOf(rows, 'hermes.managed-pins').state).toBe('fail');
    expect(JSON.stringify(rows)).not.toMatch(/example-placeholder|example-model|example.py/);
  });

  it('keeps unrelated provider entries and read-only MCP commands outside managed write conflicts', async () => {
    const rows = await fixtures({ documents: { 'hermes-managed': {
      providers: { 'example-other': { api_key: 'example-placeholder', models: [{ id: 'example-model' }] } },
      mcp_servers: { coder: { command: 'python3' } },
    } } }).rows();
    expect(rowOf(rows, 'hermes.managed-pins').state).toBe('ok');
  });

  it('reports returned pre-change absences as one stale save', async () => {
    const rows = await fixtures({ documents: {
      'hermes-config': {}, 'gateway-state': state([
        writtenKey(['agent', 'reasoning_effort'], undefined, 'high'),
        writtenKey(['display', 'personality'], undefined, 'focused'),
      ]),
    } }).rows();
    expect(rowOf(rows, 'hermes.stale-page')).toMatchObject({ state: 'warn',
      details: ['agent.reasoning_effort', 'display.personality'] });
    expect(rowOf(rows, 'hermes.drift').state).toBe('ok');
  });

  it.each([
    [{ model: { default: 'example-model' } }, {}],
    [{}, { model: { default: 'example-model' } }],
    [{ model: { default: null } }, {}],
  ])('compares Windows and WSL key presence in both directions', async (here, there) => {
    const rows = await fixtures({ documents: { 'hermes-config': here, 'windows-hermes': there } }).rows();
    expect(rowOf(rows, 'windows-hermes.models')).toMatchObject({ state: 'warn', details: ['model.default', 'windows-hermes'] });
  });

  it('accepts equal absent Windows and WSL keys', async () => {
    const rows = await fixtures({ documents: { 'hermes-config': {}, 'windows-hermes': {} } }).rows();
    expect(rowOf(rows, 'windows-hermes.models').state).toBe('ok');
  });

  it.each([
    ['high', 'high', 'ok'],
    ['high', 'low', 'warn'],
    ['high', undefined, 'warn'],
    [undefined, 'high', 'warn'],
  ])('compares reasoning effort from the WSL agents view: %s / %s', async (here, there, state) => {
    const document = (effort: unknown) => effort === undefined ? {} : { agent: { reasoning_effort: effort } };
    const rows = await fixtures({ documents: { 'hermes-config': document(here), 'windows-hermes': document(there) } }).rows();
    expect(rowOf(rows, 'windows-hermes.models').state).toBe(state);
    if (state === 'warn') expect(rowOf(rows, 'windows-hermes.models').details).toEqual(['agent.reasoning_effort', 'windows-hermes']);
  });

  it('requires matching WSL model and agents hashes before comparing Windows', async () => {
    const fixture = fixtures({ documents: { 'hermes-config': { agent: { reasoning_effort: 'high' } },
      'windows-hermes': { agent: { reasoning_effort: 'high' } } } });
    const read = fixture.sources.readView!;
    const rows = await fixture.rows({ readView: async id => {
      const value = await read(id);
      return id === 'hermes.agents' ? { ...(value as object), sha256: 'f'.repeat(64) } : value;
    } });
    expect(rowOf(rows, 'windows-hermes.models').state).toBe('unknown');
  });

  it.each(['on', 'off', 'yes', 'no', '012'])('rejects a scalar list with a YAML 1.1 non-string: %s', async token => {
    const rows = await fixtures({ documents: { 'hermes-config': { command_allowlist: `- echo revoked example\n- ${token}` } }, sources: {
      revocations: async () => [{ entrySha256: hashOf('echo revoked example'), revokedAt: 1000 }],
    } }).rows();
    expect(rowOf(rows, 'allowlist.revoke-back').state).toBe('unknown');
  });

  it('accepts quoted YAML 1.1 boolean words as allowlist strings', async () => {
    const rows = await fixtures({ documents: { 'hermes-config': { command_allowlist: '- "on"' } }, sources: {
      revocations: async () => [{ entrySha256: hashOf('on'), revokedAt: 1000 }],
    } }).rows();
    expect(rowOf(rows, 'allowlist.revoke-back').state).toBe('fail');
  });

  it('recognizes pins above and below whole-object writes with validated task names', async () => {
    expect(hermesWritesPath(['providers', 'wayroost-main', 'base_url'])).toBe(true);
    expect(hermesWritesPath(['providers'])).toBe(true);
    expect(hermesWritesPath(['auxiliary', 'compression'])).toBe(true);
    expect(hermesWritesPath(['auxiliary', 'unsupported'])).toBe(false);
    expect(hermesWritesPath(['providers', 'example-other', 'base_url'])).toBe(false);
    const rows = await fixtures({ documents: { 'hermes-managed': { providers: { 'wayroost-main': { base_url: DEMO_MAIN_ADDRESS } } } } }).rows();
    expect(rowOf(rows, 'hermes.managed-pins').state).toBe('fail');
  });
  it.each(['["echo revoked example"]', '- echo revoked example'])('finds a revoked entry in a scalar list', async command_allowlist => {
    const rows = await fixtures({ documents: { 'hermes-config': { command_allowlist } }, sources: {
      revocations: async () => [{ entrySha256: hashOf('echo revoked example'), revokedAt: 1000 }],
    } }).rows();
    expect(rowOf(rows, 'allowlist.revoke-back').state).toBe('fail');
  });

  it('preserves uncertainty for a malformed scalar list', async () => {
    const rows = await fixtures({ documents: { 'hermes-config': { command_allowlist: '[broken' } }, sources: {
      revocations: async () => [{ entrySha256: hashOf('echo revoked example'), revokedAt: 1000 }],
    } }).rows();
    expect(rowOf(rows, 'allowlist.revoke-back').state).toBe('unknown');
  });

  it('warns about the effective default approval mode', async () => {
    const rows = await fixtures({ documents: { 'hermes-config': {} } }).rows();
    expect(rowOf(rows, 'hermes.approval-mode')).toMatchObject({ state: 'warn',
      fix: { operation: 'hermes.approval-mode', params: { mode: 'manual' } } });
  });

  it('detects supported parameterized managed pins', async () => {
    const rows = await fixtures({ documents: { 'hermes-managed': { auxiliary: {
      compression: { provider: 'example-provider' }, unsupported: { model: 'example-model' },
    } } } }).rows();
    expect(rowOf(rows, 'hermes.managed-pins')).toMatchObject({ state: 'fail', details: ['auxiliary.compression.provider', 'hermes-managed'] });
  });

  it.each([{}, { main: {} }, { main: { input: ['text'], toolCalling: true, thinkingLevels: false, maxOutputTokens: 1, advertisedContext: 1 } }])(
    'requires complete valid role contracts', async contracts => {
      const rows = await fixtures({ documents: { 'gateway-role-map': { contracts } } }).rows();
      expect(rowOf(rows, 'pi.entries').state).toBe('unknown');
    });

  it.each([[{}], [null], ['example-provider'], [{ provider: '' }], [{ provider: 'example-provider', model: 1 }]])(
    'rejects malformed fallback entries', async fallback_providers => {
      const rows = await fixtures({ documents: { 'hermes-config': { fallback_providers } } }).rows();
      expect(rowOf(rows, 'fallbacks.providers').state).toBe('fail');
    });

  it('does not mistake an unrelated verification failure for failed gateway persistence', async () => {
    const rows = await fixtures({ sources: { recentChanges: async () => [{ id: 'example-change', at: 1000,
      action: 'apply', operation: 'hermes.personality', target: 'hermes-config', result: 'verify_mismatch' }] } }).rows();
    expect(rowOf(rows, 'supervisor.gateway-state').state).toBe('ok');
  });
});

describe('combined Hermes intent', () => {
  const modelKeys = [writtenKey(['model', 'provider'], 'example-provider', 'wayroost-main'),
    writtenKey(['model', 'default'], 'example-model', 'main'), writtenKey(['model', 'base_url'], 'http://127.0.0.1:19001/v1', DEMO_MAIN_ADDRESS)];
  const later = Date.parse(DEMO_MOVED_AT) + 1000;
  const direct = { provider: 'example-direct', default: 'example-new-model', base_url: 'http://127.0.0.1:19002/v1' };
  const intended = modelKeys.map(key => ({ path: key.path, before: { exists: true, value: String(key.intended.value) }, at: later, intentId: 'd'.repeat(64),
    intended: { exists: true, value: direct[key.path[1] as keyof typeof direct] } }));

  it('withholds migration reapply when it would overwrite newer model intent', async () => {
    const rows = await fixtures({ documents: { 'hermes-config': { model: direct, delegation: { model: 'example-drift' } },
      'gateway-state': state([...modelKeys, writtenKey(['delegation', 'model'], 'example-old', 'main')]),
    }, sources: { intended: async () => intended } }).rows();
    expect(rowOf(rows, 'hermes.drift').state).toBe('warn');
    expect(rowOf(rows, 'hermes.drift').fix).toBeUndefined();
    expect(rowOf(rows, 'hermes.role-addresses').fix).toBeUndefined();
  });

  it('selects the delegation intent when only delegation settings drift', async () => {
    const delegation = writtenKey(['delegation', 'model'], 'example-old', 'main');
    const rows = await fixtures({ documents: {
      'hermes-config': { model: direct, delegation: { model: 'example-external' } },
      'gateway-state': state([...modelKeys, delegation]),
    }, sources: { intended: async () => [...intended, {
      path: delegation.path, at: later, intentId: 'e'.repeat(64), before: { exists: true, value: 'main' },
      intended: { exists: true, value: 'example-delegation' },
    }] } }).rows();
    expect(rowOf(rows, 'hermes.role-addresses')).toMatchObject({ state: 'fail', details: ['delegation.model'],
      fix: { operation: 'gateway.reapply-intended', params: { intentId: 'e'.repeat(64) } } });
  });

  it('accepts a deliberate direct choice and still detects subsequent external drift', async () => {
    for (const [model, expected] of [[direct, 'ok'], [{ ...direct, default: 'example-external' }, 'fail']] as const) {
      const rows = await fixtures({ documents: { 'hermes-config': { model }, 'gateway-state': state(modelKeys) },
        sources: { intended: async () => intended } }).rows();
      expect(rowOf(rows, 'hermes.role-addresses').state).toBe(expected);
      expect(rowOf(rows, 'hermes.drift').state).toBe(expected === 'ok' ? 'ok' : 'warn');
    }
  });

  it('compares the complete provider value without returning its fields', async () => {
    const provider = { base_url: DEMO_MAIN_ADDRESS, api_key: 'example-placeholder', models: [{ id: 'main' }] };
    for (const [live, expected] of [[{ models: provider.models, api_key: provider.api_key, base_url: provider.base_url }, 'ok'],
      [{ ...provider, models: [{ id: 'example-other' }] }, 'warn'], [{ ...provider, api_key: 'example-changed' }, 'warn']] as const) {
      const rows = await fixtures({ documents: { 'hermes-config': { providers: { 'wayroost-main': live } },
        'gateway-state': state([writtenKey(['providers', 'wayroost-main'], undefined, provider)]),
      } }).rows();
      expect(rowOf(rows, 'hermes.drift').state).toBe(expected);
      expect(JSON.stringify(rows)).not.toContain('example-placeholder');
      expect(JSON.stringify(rows)).not.toContain('example-changed');
    }
  });
});


it('compares the actual admin mapping and preserves ownership uncertainty', async () => {
  const base = fixtures();
  const gateway = await base.sources.gateway!();
  if (!gateway.status?.ok) throw new Error('missing fixture status');
  const document = { roles: { main: 'example-intended', coder: null, fast: null },
    profiles: { 'example-profile/example-engine': { main: 'example-intended', coder: null, fast: null } } };
  const state = { state: { ...DEMO_STATE, profile: 'example-profile', engine: 'example-engine' } };
  for (const [backend, health, expected] of [
    ['example-actual', 'up', 'warn'], ['example-intended', 'owner_mismatch', 'fail'], ['example-intended', 'unknown', 'unknown'],
  ] as const) {
    const status = { ...gateway.status.value, draining: true, roles: { ...gateway.status.value.roles,
      main: { ...gateway.status.value.roles.main, backend, health } } };
    const rows = await fixtures({ documents: { 'gateway-role-map': document, 'gateway-state': state },
      gateway: { status: { ok: true, value: status } } }).rows();
    expect(rowOf(rows, 'gateway.backend.main').state).toBe(expected);
  }
  const rows = await fixtures({ documents: { 'gateway-role-map': document, 'gateway-state': state },
    gateway: { status: { ok: false, failure: 'failed' } } }).rows();
  expect(rowOf(rows, 'gateway.backend.main').state).toBe('unknown');
});
