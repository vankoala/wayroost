// One ok case and one failing case for every other row the engine produces. The
// fixtures stand in for the settings reads and this PC's own probes, so nothing here
// reaches a live gateway, phone or supervisor.
import { describe, expect, it } from 'vitest';
import {
  DEMO_AT, DEMO_CODER_ADDRESS, DEMO_FAST_ADDRESS, DEMO_MAIN_ADDRESS, DEMO_ORIGINAL, DEMO_COPY, DEMO_STATE,
  fixtures, hashOf, moveRecord, rowOf, writtenKey,
} from './checks-fixtures.js';
import type { FixtureInput } from './checks-fixtures.js';
import type { ComponentStatus, SupervisorStatus } from '../../shared/supervisor.js';
import { PASEO_BUILTIN_PROVIDERS } from '../../shared/settings-ops.js';
import type { TargetId } from '../../shared/settings.js';
import type { DrainMarkerSnapshot } from '../src/checks/snapshot.js';

/** A supervisor whose gateway started at a given time, and nothing else moved. */
function supervisorWith(components: ComponentStatus[]): FixtureInput {
  const status: SupervisorStatus = { overall: 'ok', sentence: 'Up.', components, at: DEMO_AT };
  return { sources: { supervisorStatus: async () => status } };
}

const gatewayUp = (since: number): ComponentStatus =>
  ({ id: 'hermes-gateway', name: 'Hermes', state: 'up', sentence: 'Answering.', since, actions: [] });

const hermesMoved = (input: FixtureInput = {}): FixtureInput => ({
  ...input,
  documents: {
    ...input.documents,
    'gateway-state': {
      state: DEMO_STATE,
      migration: { version: 1, consumers: { hermes: { 'hermes-config': moveRecord([writtenKey(['model', 'default'], 'demo-model', 'main')]) } } },
      ...input.documents?.['gateway-state'],
    },
  },
});

describe("Hermes' own config", () => {
  it('says the file parses, and fails when the reader cannot parse it', async () => {
    expect(rowOf(await fixtures().rows(), 'hermes.reader-parse').state).toBe('ok');
    const broken = rowOf(await fixtures({ refusals: { 'hermes.models': 'parse_failed' } }).rows(), 'hermes.reader-parse');
    expect(broken.state).toBe('fail');
    expect(broken.priority).toBe('high');
    expect(broken.sentence).toMatch(/can't be parsed/);
  });

  it('compares the default model with the provider entry it names', async () => {
    expect(rowOf(await fixtures().rows(), 'hermes.model-provider').state).toBe('ok');
    const noEntry = await fixtures({
      documents: { 'hermes-config': { model: { provider: 'demo-local', default: 'demo-model', base_url: DEMO_MAIN_ADDRESS } } },
    }).rows();
    expect(rowOf(noEntry, 'hermes.model-provider').state).toBe('fail');
    const otherAddress = await fixtures({
      documents: { 'hermes-config': {
        model: { provider: 'demo-local', default: 'demo-model', base_url: 'http://127.0.0.1:19999/v1' },
        providers: { 'demo-local': { base_url: DEMO_MAIN_ADDRESS } },
      } },
    }).rows();
    expect(rowOf(otherAddress, 'hermes.model-provider').state).toBe('fail');
    const absent = await fixtures({ documents: { 'hermes-config': null } }).rows();
    expect(rowOf(absent, 'hermes.model-provider').sentence).toMatch(/no default model set/);
  });

  it('warns off a mode that stops asking, and offers manual as the fix', async () => {
    expect(rowOf(await fixtures().rows(), 'hermes.approval-mode').state).toBe('ok');
    for (const mode of ['smart', 'off']) {
      const row = rowOf(await fixtures({
        documents: { 'hermes-config': { model: { provider: 'demo-local', default: 'demo-model' }, approvals: { mode, cron_mode: 'approve' } } },
      }).rows(), 'hermes.approval-mode');
      expect(row.state).toBe('warn');
      expect(row.fix).toEqual({ operation: 'hermes.approval-mode', params: { mode: 'manual' } });
      expect(row.details).toContain('approvals.cron_mode');
    }
  });

  it('names the scheduled-job exception when manual mode lets cron approve', async () => {
    const approves = rowOf(await fixtures({
      documents: { 'hermes-config': { model: { provider: 'demo-local', default: 'demo-model' }, approvals: { mode: 'manual', cron_mode: 'approve' } } },
    }).rows(), 'hermes.approval-mode');
    expect(approves.state).toBe('warn');
    expect(approves.sentence).toMatch(/Scheduled jobs are an exception/);
    expect(approves.details).toContain('approvals.cron_mode');
    const denies = rowOf(await fixtures({
      documents: { 'hermes-config': { model: { provider: 'demo-local', default: 'demo-model' }, approvals: { mode: 'manual', cron_mode: 'deny' } } },
    }).rows(), 'hermes.approval-mode');
    expect(denies.state).toBe('ok');
    expect(denies.details).toEqual([]);
  });

  it('reads the managed layer only to say whether it pins a written key', async () => {
    expect(rowOf(await fixtures().rows(), 'hermes.managed-pins').sentence).toMatch(/no managed Hermes layer/);
    const pinsWritten = await fixtures({ documents: { 'hermes-managed': { model: { provider: 'demo-local', default: 'demo-model' } } } }).rows();
    const pinned = rowOf(pinsWritten, 'hermes.managed-pins');
    expect(pinned.state).toBe('fail');
    expect(pinned.details).toContain('model.default');
    const pinsOther = await fixtures({ documents: { 'hermes-managed': { terminal: { backend: 'demo' } } } }).rows();
    expect(rowOf(pinsOther, 'hermes.managed-pins').state).toBe('ok');
  });
});

describe("revoked 'always' answers", () => {
  const revokedAt = DEMO_AT - 60_000;

  it('is pending until the gateway started after the revoke', async () => {
    expect(rowOf(await fixtures().rows(), 'allowlist.revoke-pending').state).toBe('ok');
    const rows = await fixtures({
      sources: {
        ...supervisorWith([gatewayUp(revokedAt - 1000)]).sources,
        hermesStartedAt: async () => revokedAt - 1000,
        revocations: async () => [{ revokedAt }],
      },
    } as FixtureInput).rows();
    const pending = rowOf(rows, 'allowlist.revoke-pending');
    expect(pending.state).toBe('warn');
    expect(pending.fix).toEqual({ restart: { component: 'hermes', when: 'idle' } });
    const after = await fixtures({
      sources: {
        ...supervisorWith([gatewayUp(revokedAt + 1000)]).sources,
        hermesStartedAt: async () => revokedAt + 1000,
        revocations: async () => [{ revokedAt }],
      },
    } as FixtureInput).rows();
    expect(rowOf(after, 'allowlist.revoke-pending').state).toBe('ok');
  });

  it('is unknown when nothing says when the gateway started', async () => {
    const rows = await fixtures({ sources: { revocations: async () => [{ revokedAt }] } } as FixtureInput).rows();
    expect(rowOf(rows, 'allowlist.revoke-pending').state).toBe('unknown');
  });

  it('names a revoked entry that came back, and not one Hermes added itself', async () => {
    expect(rowOf(await fixtures().rows(), 'allowlist.revoke-back').state).toBe('ok');
    const byTimeOnly = await fixtures({ sources: { revocations: async () => [{ revokedAt }] } }).rows();
    expect(rowOf(byTimeOnly, 'allowlist.revoke-back').state).toBe('unknown');

    const rows = await fixtures({
      documents: { 'hermes-config': {
        model: { provider: 'demo-local', default: 'demo-model' },
        command_allowlist: ['echo example', 'rm -rf /tmp/demo'],
      } },
      sources: { revocations: async () => [{ entrySha256: hashOf('echo example'), revokedAt }] },
    }).rows();
    const back = rowOf(rows, 'allowlist.revoke-back');
    expect(back.state).toBe('fail');
    expect(back.priority).toBe('high');
    expect(back.details).toEqual([hashOf('echo example')]);
    expect(back.fix).toEqual({ operation: 'hermes.revoke-always', params: { entrySha256: hashOf('echo example') } });

    const addedItself = await fixtures({
      documents: { 'hermes-config': { model: { provider: 'demo-local', default: 'demo-model' }, command_allowlist: ['rm -rf /tmp/demo'] } },
      sources: { revocations: async () => [{ entrySha256: hashOf('echo example'), revokedAt }] },
    }).rows();
    expect(rowOf(addedItself, 'allowlist.revoke-back').state).toBe('ok');
  });
});

describe('the Windows Hermes app', () => {
  it('is quiet when there is no such file, and says so when it differs', async () => {
    expect(rowOf(await fixtures().rows(), 'windows-hermes.models').sentence).toMatch(/no Windows Hermes file/);
    const same = await fixtures({ documents: {
      'windows-hermes': { model: { provider: 'demo-local', default: 'demo-model', base_url: 'http://127.0.0.1:19001/v1' } },
    } }).rows();
    expect(rowOf(same, 'windows-hermes.models').state).toBe('ok');
    const different = await fixtures({ documents: {
      'windows-hermes': { model: { provider: 'demo-local', default: 'other-model' } },
    } }).rows();
    const row = rowOf(different, 'windows-hermes.models');
    expect(row.state).toBe('warn');
    expect(row.details).toContain('model.default');
    expect(row.sentence).toMatch(/frozen/);
  });
});

describe('pi', () => {
  const movedPi = (providers: Record<string, unknown>, settings?: Record<string, unknown>): FixtureInput => ({
    documents: {
      'pi-models': { providers },
      ...(settings ? { 'pi-settings': settings } : {}),
      'gateway-state': { state: DEMO_STATE, migration: { version: 1, consumers: { pi: {
        'pi-models': moveRecord([writtenKey(['defaultProvider'], 'demo', 'wayroost-main')]),
        'pi-settings': moveRecord([writtenKey(['defaultProvider'], 'demo', 'wayroost-main')]),
      } } } },
    },
  });

  it('wants the main role first in the catalog once pi is moved', async () => {
    expect(rowOf(await fixtures().rows(), 'pi.role-order').state).toBe('ok');
    // On roles but not moved: the entries are there with nothing pinning them.
    const unMoved = await fixtures({ documents: {
      'pi-models': { providers: { 'wayroost-main': { models: [{ id: 'main' }] } } },
    } }).rows();
    expect(rowOf(unMoved, 'pi.role-order').state).toBe('warn');
    // Moved, with the main role first: what a move leaves behind.
    const first = await fixtures(movedPi({ 'wayroost-main': { models: [{ id: 'main' }] }, demo: { models: [{ id: 'demo-model' }] } })).rows();
    expect(rowOf(first, 'pi.role-order').state).toBe('ok');
    // Moved, with something else first: new agents start somewhere else.
    const notFirst = await fixtures(movedPi({ demo: { models: [{ id: 'demo-model' }] }, 'wayroost-main': { models: [{ id: 'main' }] } })).rows();
    const row = rowOf(notFirst, 'pi.role-order');
    expect(row.state).toBe('fail');
    expect(row.fix).toEqual({ operation: 'gateway.reapply-intended', params: { consumer: 'pi', target: 'pi-models' } });
  });

  it('checks the default against the role pi was moved onto', async () => {
    expect(rowOf(await fixtures().rows(), 'pi.default').state).toBe('ok');
    const good = await fixtures({ ...movedPi({}), documents: { ...movedPi({}).documents, 'pi-settings': { defaultProvider: 'wayroost-main', defaultModel: 'main' } } }).rows();
    expect(rowOf(good, 'pi.default').state).toBe('ok');
    const bad = await fixtures(movedPi({}, { defaultProvider: 'demo', defaultModel: 'demo-model' })).rows();
    expect(rowOf(bad, 'pi.default').state).toBe('fail');
  });

  it('compares each role entry with its contract, not with one backend', async () => {
    expect(rowOf(await fixtures().rows(), 'pi.entries').state).toBe('unknown');
    const contract = { input: ['text', 'image'], toolCalling: true, thinkingLevels: true, maxOutputTokens: 8192, advertisedContext: 200000 };
    const contracts = { main: contract, coder: contract, fast: contract };
    const entry = { baseUrl: DEMO_MAIN_ADDRESS, models: [{ id: 'main', contextWindow: 200000, maxTokens: 8192, input: ['text', 'image'], reasoning: true, thinkingLevelMap: { minimal: 'low', low: 'low', medium: 'medium', high: 'high' } }] };
    const providers = { 'wayroost-main': entry, 'wayroost-coder': { ...entry, baseUrl: DEMO_CODER_ADDRESS, models: [{ ...entry.models[0], id: 'coder' }] },
      'wayroost-fast': { ...entry, baseUrl: DEMO_FAST_ADDRESS, models: [{ ...entry.models[0], id: 'fast' }] } };
    const good = await fixtures({ documents: { 'gateway-role-map': { roles: { main: 'demo-backend' }, contracts }, 'pi-models': { providers } } }).rows();
    expect(rowOf(good, 'pi.entries').state).toBe('ok');
    const wrongWindow = await fixtures({ documents: {
      'gateway-role-map': { roles: { main: 'demo-backend' }, contracts },
      'pi-models': { providers: { ...providers, 'wayroost-main': { ...entry, models: [{ ...entry.models[0], contextWindow: 1000 }] } } },
    } }).rows();
    const row = rowOf(wrongWindow, 'pi.entries');
    expect(row.state).toBe('fail');
    expect(row.details).toEqual(['main: window']);
    const missing = await fixtures({ documents: { 'gateway-role-map': { roles: { main: 'demo-backend' }, contracts }, 'pi-models': { providers: { ...providers, 'wayroost-main': undefined } } } }).rows();
    expect(rowOf(missing, 'pi.entries').details).toEqual(['main: no entry']);
  });
});

describe('Paseo', () => {
  const profile = (id: string, model: string) => ({ id, model, provider: 'pi' });

  it('wants a profile model the catalog has', async () => {
    expect(rowOf(await fixtures().rows(), 'paseo.profiles').sentence).toMatch(/no profiles/);
    const good = await fixtures({ documents: {
      'paseo-config': { agents: { providers: {} }, daemon: { agentProfiles: [profile('worker', 'demo/demo-model')] } },
    } }).rows();
    expect(rowOf(good, 'paseo.profiles').state).toBe('ok');
    const bad = await fixtures({ documents: {
      'paseo-config': { agents: { providers: {} }, daemon: { agentProfiles: [profile('worker', 'demo/no-such-model')] } },
    } }).rows();
    const row = rowOf(bad, 'paseo.profiles');
    expect(row.state).toBe('fail');
    expect(row.details).toEqual([`sha256:${hashOf('worker')}`]);
  });

  it('counts existing agents by where their model resolves', async () => {
    const direct = await fixtures({ documents: {
      'paseo-config': { agents: { providers: {} }, daemon: { agentProfiles: [profile('worker', 'demo/demo-model')] } },
    } }).rows();
    expect(rowOf(direct, 'paseo.pinned-agents').state).toBe('ok');
    const onRoles = await fixtures({ sources: { paseoRuntime: async () => ({ providers: {}, agents: [{ id: 'worker', provider: 'pi', model: 'wayroost-main/main' }] }) }, documents: {
      'paseo-config': { agents: { providers: {} }, daemon: { agentProfiles: [profile('worker', 'wayroost-main/main')] } },
      'gateway-state': { state: DEMO_STATE },
    } }).rows();
    const row = rowOf(onRoles, 'paseo.pinned-agents');
    expect(row.state).toBe('warn');
    expect(row.sentence).toMatch(/no consumer is recorded as moved/);
  });

  it('wants the switch file and the effective switches to agree', async () => {
    expect(rowOf(await fixtures().rows(), 'paseo.switch-flags').sentence).toMatch(/no provider switches/);
    const known = PASEO_BUILTIN_PROVIDERS[0]!;
    const input = (enabled: boolean) => ({
      documents: { 'paseo-config': { agents: { providers: { [known]: { enabled } } }, daemon: { agentProfiles: [] } } },
      sources: { switchFlags: async () => ({ [known]: !enabled }) },
    });
    const different = rowOf(await fixtures(input(false) as never).rows(), 'paseo.switch-flags');
    expect(different.state).toBe('warn');
    expect(different.details).toEqual([known]);
    const same = rowOf(await fixtures({
      documents: { 'paseo-config': { agents: { providers: { [known]: { enabled: true } } }, daemon: { agentProfiles: [] } } },
      sources: { switchFlags: async () => ({ [known]: true }) },
    }).rows(), 'paseo.switch-flags');
    expect(same.state).toBe('ok');
  });
});

describe('the model gateway', () => {
  it('fails when a role address answers nothing', async () => {
    expect(rowOf(await fixtures().rows(), 'gateway.health').state).toBe('ok');
    const row = rowOf(await fixtures({ gateway: { healthz: { main: true, coder: false, fast: true } } }).rows(), 'gateway.health');
    expect(row.state).toBe('fail');
    expect(row.details).toContain('coder role');
    expect(row.fix).toEqual({ restart: { component: 'gateway', when: 'now' } });
  });

  it('names a socket unit that failed and the ports it no longer holds', async () => {
    expect(rowOf(await fixtures().rows(), 'gateway.socket-unit').state).toBe('ok');
    const failed = rowOf(await fixtures({ gateway: { socketUnit: 'failed' } }).rows(), 'gateway.socket-unit');
    expect(failed.state).toBe('fail');
    expect(failed.priority).toBe('high');
    expect(failed.details).toContain('reset-failed on both units');
    expect(failed.fix).toEqual({ operation: 'gateway.socket-recover', params: {} });
    const dropped = rowOf(await fixtures({ gateway: { listeningPorts: [18010, 18011] } }).rows(), 'gateway.socket-unit');
    expect(dropped.state).toBe('fail');
    expect(dropped.sentence).toMatch(/2 of the 3 role ports/);
  });

  it('compares each role with the live profile row', async () => {
    const map = (profileRow: Record<string, unknown>, roles: Record<string, unknown>, state: Record<string, unknown> = DEMO_STATE) => ({
      documents: { 'gateway-role-map': { roles, backends: { 'demo-backend': { baseUrl: 'http://127.0.0.1:19100/v1' } }, profiles: { 'balanced/fast': profileRow }, contracts: {} },
                   'gateway-state': { state: { ...DEMO_STATE, ...state }, migration: { version: 1, consumers: {} } } },
    });
    const nothingUp = rowOf(await fixtures().rows(), 'gateway.backend.main');
    expect(nothingUp.state).toBe('ok');
    expect(nothingUp.sentence).toMatch(/No model profile is recorded as up/);

    const serving = await fixtures(map({ main: 'demo-backend', coder: null, fast: null }, { main: 'demo-backend', coder: null, fast: null },
      { profile: 'balanced', engine: 'fast' })).rows();
    expect(rowOf(serving, 'gateway.backend.main').state).toBe('ok');
    expect(rowOf(serving, 'gateway.backend.coder').sentence).toMatch(/unmapped, as its profile row leaves it/);

    const other = rowOf(await fixtures(map({ main: 'demo-backend', coder: null, fast: null }, { main: 'other-backend', coder: null, fast: null },
      { profile: 'balanced', engine: 'fast' })).rows(), 'gateway.backend.main');
    expect(other.state).toBe('warn');
    expect(other.fix).toEqual({ operation: 'gateway.point', params: { role: 'main', backend: 'demo-backend' } });

    const unmapped = rowOf(await fixtures(map({ main: 'demo-backend', coder: null, fast: null }, { main: null, coder: null, fast: null },
      { profile: 'balanced', engine: 'fast' })).rows(), 'gateway.backend.main');
    expect(unmapped.state).toBe('fail');
    expect(unmapped.fix).toEqual({ operation: 'gateway.point', params: { role: 'main', backend: 'demo-backend' } });

    const down = rowOf(await fixtures({
      ...map({ main: 'demo-backend', coder: null, fast: null }, { main: 'demo-backend', coder: null, fast: null }, { profile: 'balanced', engine: 'fast' }),
      gateway: { roles: { main: { health: 'down' }, coder: { health: 'up' }, fast: { health: 'up' } } },
    }).rows(), 'gateway.backend.main');
    expect(down.state).toBe('warn');
    expect(down.sentence).toMatch(/backend is not answering/);

    const mismatch = rowOf(await fixtures({
      ...map({ main: 'demo-backend', coder: null, fast: null }, { main: 'demo-backend', coder: null, fast: null }, { profile: 'balanced', engine: 'fast' }),
      gateway: { roles: { main: { health: 'owner_mismatch' }, coder: { health: 'up' }, fast: { health: 'up' } } },
    }).rows(), 'gateway.backend.main');
    expect(mismatch.state).toBe('fail');
    expect(mismatch.sentence).toMatch(/Someone other than the expected owner/);
  });
});

describe('fallback chains', () => {
  it('wants every entry to name a provider Hermes has', async () => {
    expect(rowOf(await fixtures().rows(), 'fallbacks.providers').state).toBe('ok');
    const row = rowOf(await fixtures({ documents: {
      'hermes-config': {
        model: { provider: 'demo-local', default: 'demo-model' },
        providers: { 'demo-local': { base_url: DEMO_MAIN_ADDRESS } },
        fallback_providers: [{ provider: 'gone-now' }],
      },
    } }).rows(), 'fallbacks.providers');
    expect(row.state).toBe('fail');
    expect(row.details).toEqual(['fallback_providers']);
  });

  it('wants one delegation fallback direct while Hermes runs on roles', async () => {
    expect(rowOf(await fixtures().rows(), 'fallbacks.direct-delegation').state).toBe('ok');
    const onRoles = (chain: unknown[]) => fixtures({
      documents: {
        'hermes-config': { delegation: { fallback_providers: chain } },
        'gateway-state': { state: DEMO_STATE, migration: { version: 1, consumers: { hermes: { 'hermes-config': moveRecord([writtenKey(['model', 'default'], 'demo-model', 'main')]) } } } },
      },
    });
    expect(rowOf(await onRoles([{ provider: 'wayroost-main' }]).rows(), 'fallbacks.direct-delegation').state).toBe('warn');
    expect(rowOf(await onRoles([{ provider: 'wayroost-main' }, { provider: 'demo-local' }]).rows(), 'fallbacks.direct-delegation').state).toBe('ok');
  });
});

describe('the coder MCP', () => {
  const registrations = (hermesScript: string, piScript: string): Partial<Record<TargetId, Record<string, unknown>>> => ({
    'hermes-config': { model: { provider: 'demo-local', default: 'demo-model' }, mcp_servers: { coder: { command: 'python3', args: [hermesScript] } } },
    'pi-mcp': { mcpServers: { coder: { command: 'python3', args: [piScript] } } },
  });

  it('names which script each registration points at', async () => {
    expect(rowOf(await fixtures().rows(), 'coder-mcp.registrations').state).toBe('warn');
    const noFacts = rowOf(await fixtures({ deployment: { coderMcp: undefined } }).rows(), 'coder-mcp.registrations');
    expect(noFacts.state).toBe('unknown');
    const original = await fixtures({ documents: registrations(DEMO_ORIGINAL, DEMO_ORIGINAL) }).rows();
    expect(rowOf(original, 'coder-mcp.registrations').state).toBe('ok');
    const movedOn = await fixtures({
      documents: {
        ...registrations(DEMO_COPY, DEMO_COPY),
        'gateway-state': { state: DEMO_STATE, migration: { version: 1, consumers: { 'coder-mcp': { 'pi-mcp': moveRecord([writtenKey(['mcpServers', 'coder'], 'x', 'y')]) } } } },
      },
    }).rows();
    expect(rowOf(movedOn, 'coder-mcp.registrations').state).toBe('ok');
    const stale = await fixtures({
      documents: {
        ...registrations(DEMO_ORIGINAL, DEMO_ORIGINAL),
        'gateway-state': { state: DEMO_STATE, migration: { version: 1, consumers: { 'coder-mcp': { 'hermes-config': moveRecord([writtenKey(['mcp_servers', 'coder'], 'x', 'y')]) } } } },
      },
    }).rows();
    const row = rowOf(stale, 'coder-mcp.registrations');
    expect(row.state).toBe('warn');
    expect(row.details).toContain('the gateway copy');
  });

  it('counts a process that started before the move', async () => {
    expect(rowOf(await fixtures().rows(), 'coder-mcp.processes').state).toBe('ok');
    const day = 86_400_000;
    const processes = (startedAt: number, script: 'gateway-copy' | 'original') => ({
      sources: { coderProcesses: async () => [{ startedAt, script }] },
    });
    const notMoved = rowOf(await fixtures({
      ...processes(DEMO_AT - 2 * day, 'gateway-copy'),
      documents: { 'gateway-state': { state: DEMO_STATE, migration: { version: 1, consumers: {} } } },
    }).rows(), 'coder-mcp.processes');
    expect(notMoved.state).toBe('warn');
    expect(notMoved.sentence).toMatch(/moved back/);

    const movedAt = Date.parse('2026-10-04T09:00:00Z');
    const moved = (startedAt: number) => fixtures({
      ...processes(startedAt, 'gateway-copy'),
      documents: { 'gateway-state': { state: DEMO_STATE, migration: { version: 1, consumers: { 'coder-mcp': { 'pi-mcp': moveRecord([writtenKey(['mcpServers', 'coder'], 'x', 'y')], '2026-10-04T09:00:00Z') } } } } },
    });
    expect(rowOf(await moved(movedAt - 2 * day).rows(), 'coder-mcp.processes').state).toBe('warn');
    const after = rowOf(await moved(movedAt + day).rows(), 'coder-mcp.processes');
    expect(after.state).toBe('ok');
    expect(after.details).toEqual(['1 running from it']);
  });
});

describe('the phone line', () => {
  const pinRecord = (intended: unknown) => ({
    sources: { phone: async () => ({
      server: { ok: true as const, value: { activeCalls: 0, webhooks: 0, outboundCalls: 0 } },
      bridge: { ok: true as const, value: { activeCalls: 0, oldestCallMs: 0 } },
      pin: { ok: true as const, value: { address: String(intended).startsWith('http') ? String(intended) : DEMO_MAIN_ADDRESS,
        model: String(intended).startsWith('http') ? 'main' : String(intended) } },
    }) },
    documents: { 'gateway-state': { state: DEMO_STATE, migration: { version: 1, consumers: { phone: {
      'phone-bridge-dropin': moveRecord([writtenKey(['Service', 'Environment'], 'http://127.0.0.1:18001', intended)], '2026-10-04T09:00:00Z'),
    } } } } },
  });

  it('wants the pin to name the main role', async () => {
    expect(rowOf(await fixtures().rows(), 'phone.address').state).toBe('ok');
    expect(rowOf(await fixtures(pinRecord(DEMO_MAIN_ADDRESS)).rows(), 'phone.address').state).toBe('ok');
    expect(rowOf(await fixtures(pinRecord('http://127.0.0.1:19999')).rows(), 'phone.address').state).toBe('fail');
    expect(rowOf(await fixtures(pinRecord('some-model-name')).rows(), 'phone.address').state).toBe('warn');
    const noAddress = await fixtures({ ...pinRecord(DEMO_MAIN_ADDRESS), deployment: { roleAddresses: { coder: DEMO_CODER_ADDRESS, fast: DEMO_FAST_ADDRESS } } }).rows();
    expect(rowOf(noAddress, 'phone.address').state).toBe('unknown');
  });

  it('is quiet only when neither counter says a call is up', async () => {
    const phone = (activeCalls: number) => ({ sources: { phone: async () => ({
      quietForMs: 120_000,
      server: { ok: true as const, value: { activeCalls, webhooks: 0, outboundCalls: 0 } },
      bridge: { ok: true as const, value: { activeCalls, oldestCallMs: 0 } },
    }) } });
    expect(rowOf(await fixtures(phone(0)).rows(), 'phone.quiet').state).toBe('ok');
    const up = rowOf(await fixtures(phone(1)).rows(), 'phone.quiet');
    expect(up.state).toBe('warn');
    expect(up.sentence).toMatch(/restart of the bridge waits/);
    const silent = rowOf(await fixtures({ sources: { phone: async () => ({
      server: { ok: false as const, failure: 'failed' as const }, bridge: { ok: true as const, value: { activeCalls: 0, oldestCallMs: 0 } } }) } }).rows(), 'phone.quiet');
    expect(silent.state).toBe('unknown');
  });

  it('names a bridge count the phone server has not agreed to for ten minutes', async () => {
    const counts = (bridgeCalls: number, excessForMs: number) => ({ sources: { phone: async () => ({
      excessForMs,
      server: { ok: true as const, value: { activeCalls: 0, webhooks: 0, outboundCalls: 0 } },
      bridge: { ok: true as const, value: { activeCalls: bridgeCalls, oldestCallMs: 0 } },
    }) } });
    expect(rowOf(await fixtures(counts(0, 0)).rows(), 'phone.stale-count').state).toBe('ok');
    expect(rowOf(await fixtures(counts(1, 60_000)).rows(), 'phone.stale-count').sentence).toMatch(/not been observed/);
    const stale = rowOf(await fixtures(counts(1, 11 * 60_000)).rows(), 'phone.stale-count');
    expect(stale.state).toBe('warn');
    expect(stale.details).toEqual(['1 above', 'held for 11 min']);
  });
});

describe('the storage rule and the supervisor', () => {
  it('names the targets the walk refused', async () => {
    expect(rowOf(await fixtures().rows(), 'directories.walk').state).toBe('ok');
    const refused = rowOf(await fixtures({ sources: { directoryRule: async () => ({ passed: ['hermes-config'], refused: ['paseo-config'] }) } }).rows(), 'directories.walk');
    expect(refused.state).toBe('fail');
    expect(refused.details).toEqual(['paseo-config']);
  });

  it('says whether the supervisor takes settings changes', async () => {
    expect(rowOf(await fixtures().rows(), 'supervisor.config-verbs').state).toBe('ok');
    const noVerbs = rowOf(await fixtures(supervisorWith([]) as FixtureInput).rows(), 'supervisor.config-verbs');
    expect(noVerbs.state).toBe('fail');
    const stale = rowOf(await fixtures({
      sources: { supervisorStatus: async () => ({
        overall: 'ok', sentence: 'Up.', components: [], at: DEMO_AT,
        configVerbs: { version: 1, configWrites: false, verbs: [], catalogue: 0 },
      }) },
      deployment: { supervisor: { configWrites: true, statusOnly: false } },
    }).rows(), 'supervisor.config-verbs');
    expect(stale.state).toBe('warn');
    expect(stale.details).toContain('configWrites off');
  });

  it('names a change that never confirmed', async () => {
    expect(rowOf(await fixtures().rows(), 'supervisor.executor-run').sentence).toMatch(/No settings change/);
    const row = rowOf(await fixtures({
      sources: { recentChanges: async () => [{ id: 'change-one', at: DEMO_AT - 1000, action: 'apply', operation: 'hermes.approval-mode', target: 'hermes-config', result: 'outcome_unknown' }] },
    }).rows(), 'supervisor.executor-run');
    expect(row.state).toBe('warn');
    expect(row.details).toEqual(['change-one']);
  });

  it('wants a move recorded with its keys', async () => {
    expect(rowOf(await fixtures().rows(), 'supervisor.gateway-state').state).toBe('ok');
    const empty = await fixtures({
      documents: { 'gateway-state': { state: DEMO_STATE, migration: { version: 1, consumers: { hermes: { 'hermes-config': moveRecord([]) } } } } },
    }).rows();
    expect(rowOf(empty, 'supervisor.gateway-state').state).toBe('fail');
    const mismatch = await fixtures({
      persistenceFailures: ['ch_' + 'a'.repeat(24)],
    }).rows();
    const row = rowOf(mismatch, 'supervisor.gateway-state');
    expect(row.state).toBe('warn');
    expect(row.details).toEqual(['ch_' + 'a'.repeat(24)]);
  });

  it('catches a drain marker Wayroost left behind', async () => {
    const marker = (value: DrainMarkerSnapshot) => ({ sources: { drainMarker: async () => value } });
    expect(rowOf(await fixtures().rows(), 'hermes.drain-marker').state).toBe('ok');
    expect(rowOf(await fixtures(marker({ present: true, ours: false, requestedAt: DEMO_AT, drainRunning: true, unreadable: false })).rows(), 'hermes.drain-marker').sentence).toMatch(/Something else is draining/);
    expect(rowOf(await fixtures(marker({ present: true, ours: true, requestedAt: DEMO_AT - 60_000, drainRunning: true, unreadable: false })).rows(), 'hermes.drain-marker').state).toBe('ok');
    const leftover = rowOf(await fixtures(marker({ present: true, ours: true, requestedAt: DEMO_AT - 5 * 60_000, drainRunning: false, unreadable: false })).rows(), 'hermes.drain-marker');
    expect(leftover.state).toBe('fail');
    expect(leftover.priority).toBe('high');
    expect(leftover.details).toEqual(['requested 5 min ago']);
    expect(leftover.fix).toEqual({ operation: 'hermes.drain-marker-remove', params: {} });
    expect(rowOf(await fixtures(marker({ present: true, ours: false, requestedAt: 0, drainRunning: false, unreadable: true })).rows(), 'hermes.drain-marker').state).toBe('warn');
  });
});
