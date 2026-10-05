// The Checks engine's test fixtures: every source the page reads, with defaults
// that answer "nothing is moved and everything lines up", so each test overrides
// only the one fact its check looks at. Documents stand in for the supervisor's
// config.read answers; the shapes come from shared/settings-ops.ts, and the rows are
// built the same way production builds them, through the collector.
import { createHash } from 'node:crypto';
import { CATALOGUE_VERSION, READ_VIEWS, readViewKeys, readViewValues, type ReadViewId } from '../../shared/settings-ops.js';
import { GATEWAY_ROLES } from '../../shared/gateway.js';
import { CONFIG_VERBS } from '../../shared/supervisor-config.js';
import type { ConfigReadResult } from '../../shared/supervisor-config.js';
import type { SettingsErrorCode, TargetId } from '../../shared/settings.js';
import { settingsCheckRowSchema } from '../../shared/settings-checks.js';
import type { SettingsCheckRow } from '../../shared/settings-checks.js';
import { collectSnapshot, type CheckSnapshot, type ChecksDeployment, type ChecksSources } from '../src/checks/snapshot.js';
import { CHECK_VIEWS, runChecks } from '../src/checks/engine.js';

export const DEMO_MOVED_AT = '2026-10-04T09:00:00Z';
export const DEMO_STATE = { version: 1, profile: null, engine: null, broughtUpAt: null, overrides: {} };
export const DEMO_AT = 1_800_000_000_000;
export const DEMO_MAIN_PORT = 18010;
export const DEMO_CODER_PORT = 18011;
export const DEMO_FAST_PORT = 18012;
export const DEMO_MAIN_ADDRESS = `http://127.0.0.1:${DEMO_MAIN_PORT}`;
export const DEMO_CODER_ADDRESS = `http://127.0.0.1:${DEMO_CODER_PORT}`;
export const DEMO_FAST_ADDRESS = `http://127.0.0.1:${DEMO_FAST_PORT}`;
export const DEMO_ORIGINAL = '/home/me/demo/helper-mcp.py';
export const DEMO_COPY = '/demo/gateway-copy/helper-mcp.py';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** A target's migration record: not moved and empty, or moved with these keys. */
export const moveRecord = (keys: readonly unknown[], movedAt: string | null = DEMO_MOVED_AT) => ({
  moved: movedAt !== null,
  ...(movedAt === null ? {} : { movedAt }),
  preMoveBackupSha256: digest('demo-backup'),
  postMoveSha256: digest('demo-after'),
  keys,
});

/** One recorded key: what it held before, and what Wayroost wrote. */
export const writtenKey = (path: readonly string[], before: unknown, intended: unknown) => ({
  path: [...path],
  kind: 'recorded',
  before: before === undefined ? { exists: false } : { exists: true, value: before },
  intended: intended === undefined ? { exists: false } : { exists: true, value: intended },
});

const CONFIG_YAML = [
  'model:',
  '  provider: demo-local',
  '  default: demo-model',
  '  base_url: http://127.0.0.1:19001/v1',
  'providers:',
  '  demo-local:',
  '    base_url: http://127.0.0.1:19001/v1',
  'approvals:',
  '  mode: manual',
  'command_allowlist:',
  '- echo example',
  '',
].join('\n');

const defaultDocuments = (): Partial<Record<TargetId, Record<string, unknown> | null>> => ({
  'hermes-config': {
    model: { provider: 'demo-local', default: 'demo-model', base_url: 'http://127.0.0.1:19001/v1' },
    providers: { 'demo-local': { base_url: 'http://127.0.0.1:19001/v1' } },
    approvals: { mode: 'manual' },
    command_allowlist: ['echo example'],
    delegation: { child_timeout_seconds: 700 },
  },
  'gateway-state': { state: DEMO_STATE, migration: { version: 1, consumers: {} } },
  'gateway-role-map': { roles: { main: 'demo-main', coder: null, fast: null }, backends: {}, profiles: {} },
  'pi-settings': { defaultProvider: 'demo', defaultModel: 'demo-model' },
  'pi-models': { providers: { demo: { baseUrl: DEMO_MAIN_ADDRESS + '/v1', models: [{ id: 'demo-model' }] } } },
  'pi-mcp': { mcpServers: { coder: { command: 'python3', args: [DEMO_ORIGINAL] } } },
  'paseo-config': { agents: { providers: { demo: { enabled: true } } }, daemon: { agentProfiles: [] } },
  'hermes-managed': null,
  'windows-hermes': null,
  'wayroost-settings': { locale: 'en' },
});

/** The values of a document, in the shape the view's read keys answer. */
async function viewResult(view: ReadViewId, document: Record<string, unknown> | null): Promise<ConfigReadResult> {
  const spec = READ_VIEWS[view];
  if (document === null) {
    return { ok: true, view, present: false, values: [] };
  }
  const valueOf = (path: readonly (string | number | { id: string })[]): unknown => {
    let current: unknown = document;
    for (const segment of path) {
      if (typeof segment === 'object' || current === null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[String(segment)];
    }
    return current;
  };
  return {
    ok: true, view, present: true, sha256: digest(JSON.stringify(document)),
    values: view === 'hermes.providers' || view === 'gateway.state' ? (await readViewValues(view, document, { scopes: ['settings', 'pc-settings'], listener: 'local', pcOnlyWrites: true }))
      .map(value => ({ ...value, path: [...value.path] })) : readViewKeys(spec, document).map(path => {
      const value = valueOf(path);
      return value === undefined
        ? { path: [...path], exists: false as const }
        : { path: [...path], exists: true as const, value: value as never };
    }),
  };
}

export interface FixtureInput {
  at?: number;
  /** A document per target; null means that file is not there. */
  documents?: Partial<Record<TargetId, Record<string, unknown> | null>>;
  /** Views the settings read cannot answer. */
  refusals?: Partial<Record<ReadViewId, SettingsErrorCode>>;
  gateway?: Partial<NonNullable<ChecksSources['gateway']> extends () => Promise<infer T> ? T : never>;
  sources?: Partial<ChecksSources>;
  deployment?: Partial<ChecksDeployment>;
  persistenceFailures?: string[];
}

/** Everything the checks page reads, with the all-clean defaults. */
export function fixtures(input: FixtureInput = {}) {
  const at = input.at ?? DEMO_AT;
  const documents = { ...defaultDocuments(), ...input.documents };
  const documentsFor = (target: TargetId) => documents[target] ?? null;
  const socketUnitState = input.gateway?.socketUnit ?? 'active';
  const sources: ChecksSources = {
    readView: async view => {
      const refusal = input.refusals?.[view];
      if (refusal !== undefined) return { ok: false, code: refusal };
      return viewResult(view, documentsFor(READ_VIEWS[view].target));
    },
    supervisorStatus: async () => ({
      overall: 'ok', sentence: 'Everything on this PC is up.', components: [], at,
      configVerbs: { version: 1, configWrites: true, verbs: [...CONFIG_VERBS], catalogue: CATALOGUE_VERSION,
        gatewayPersistence: { ok: true, failedChanges: input.persistenceFailures ?? [] } },
    }),
    gateway: async () => ({
      status: { ok: true, value: { draining: false, roles: Object.fromEntries(GATEWAY_ROLES.map(role => [role, {
        backend: (documents['gateway-role-map']?.roles as Record<string, string | null> | undefined)?.[role] ?? null,
        backendModel: null, contextLength: null, backendPort: null, inFlight: 0, openConnections: 0,
        contract: { input: ['text'], toolCalling: true, thinkingLevels: false, maxOutputTokens: 8192, advertisedContext: 200000 },
        health: input.gateway?.roles?.[role].health ?? 'up',
      }])) as never } },
      healthz: { main: true, coder: true, fast: true },
      socketUnit: socketUnitState,
      listeningPorts: [DEMO_MAIN_PORT, DEMO_CODER_PORT, DEMO_FAST_PORT],
      listeners: { ok: true, value: { unit: 'example.socket', socketUnit: socketUnitState, roles: {
        main: { address: DEMO_MAIN_ADDRESS, state: 'held' }, coder: { address: DEMO_CODER_ADDRESS, state: 'held' },
        fast: { address: DEMO_FAST_ADDRESS, state: 'held' },
      } } },
      roles: { main: { health: 'up' }, coder: { health: 'up' }, fast: { health: 'up' } },
      draining: false,
      ...input.gateway,
    }),
    paseoRuntime: async () => {
      const config = documents['paseo-config'];
      const agents = config?.agents as { providers?: Record<string, { enabled?: boolean }> } | undefined;
      return { agents: [], providers: Object.fromEntries(Object.entries(agents?.providers ?? {}).map(([id, entry]) => [id, { enabled: entry.enabled ?? true, models: [] }])) };
    },
    phone: async () => ({ quietForMs: 120_000, excessForMs: 0, server: { ok: true, value: { activeCalls: 0, webhooks: 0, outboundCalls: 0 } }, bridge: { ok: true, value: { activeCalls: 0, oldestCallMs: 0 } } }),
    coderProcesses: async () => [],
    drainMarker: async () => ({ present: false, ours: false, requestedAt: 0, drainRunning: false, unreadable: false }),
    directoryRule: async () => ({ passed: ['hermes-config'], refused: [] }),
    switchFlags: async () => ({}),
    revocations: async () => [],
    recentChanges: async () => [],
    ...input.sources,
  };
  const deployment: ChecksDeployment = {
    roleAddresses: { main: DEMO_MAIN_ADDRESS, coder: DEMO_CODER_ADDRESS, fast: DEMO_FAST_ADDRESS },
    coderMcp: { original: DEMO_ORIGINAL, gatewayCopy: DEMO_COPY },
    ...input.deployment,
  };
  return {
    at,
    documents,
    sources,
    deployment,
    /** A snapshot the way the collector builds one, with the fixture's answers. */
    async snapshot(extra: Partial<ChecksSources> = {}): Promise<CheckSnapshot> {
      return collectSnapshot({ ...sources, ...extra }, deployment, { now: () => at, views: CHECK_VIEWS });
    },
    /** The rows for the fixture's state. */
    async rows(extra: Partial<ChecksSources> = {}): Promise<SettingsCheckRow[]> {
      const rows = runChecks(await this.snapshot(extra));
      for (const row of rows) {
        // Every row the engine produces must satisfy the contract on its own.
        settingsCheckRowSchema.parse(row);
      }
      return rows;
    },
  };
}

export function rowOf(rows: readonly SettingsCheckRow[], id: string): SettingsCheckRow {
  const row = rows.find(candidate => candidate.id === id);
  if (!row) throw new Error(`no row with id ${id}`);
  return row;
}

/** The ids of every row a check with this prefix produced. */
export function rowsOf(rows: readonly SettingsCheckRow[], prefix: string): SettingsCheckRow[] {
  return rows.filter(row => row.id.startsWith(prefix));
}

export const demoHash = digest;
export const hashOf = digest;
export { CONFIG_YAML };
