// A stand-in supervisor for the demo and the UI check. It implements the same
// SupervisorApi the server's real client does (server/src/supervisor-client.ts),
// so the demo runs the production power routes in front of it: GET /api/power,
// POST /api/power/actions with a phone's confirm tap, action records and the
// live power events. Only the supervisor side is pretend.
//
// Everything here is demo data: fake names, fake ports, the demo chats. Nothing real
// is read, and nothing is started.
import type {
  ActionDetail,
  ActionRequest,
  ActionSummary,
  BusyError,
  ComponentStatus,
  ComponentState,
  SupervisorStatus,
} from '../shared/supervisor.js';
import type { BusyCounts, SupervisorApi, SupervisorStreamHandlers } from '../server/src/supervisor-client.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { READ_VIEWS, operationKeys, operationTarget, parseOperation, readViewKeys } from '../shared/settings-ops.js';
import { formatKeyPath, type KeyPath, type SettingValue } from '../shared/settings.js';
import type {
  ConfigApplyRequest, ConfigReadRequest, ConfigReadResult, ConfigUndoRequest, ConfigWriteResult, CredentialTestRequest, CredentialWriteRequest,
  credentialTestResultSchema, credentialWriteResultSchema, UsageSummaryRequest, usageSummaryResultSchema,
} from '../shared/supervisor-config.js';

/** One lifecycle action at a time, like the supervisor. */
const RUN_MS = 9_000;
const LINE_MS = 900;
/** A "when idle" action waits this long for the demo PC to go quiet. */
const IDLE_WAIT_MS = 2_500;

interface DemoOptions {
  /** Plain progress lines for the action; infra output only. */
  lines?: (verb: string, target: string, profile?: string) => string[];
  /** How long the demo action takes. */
  runMs?: number;
}

function seconds(seconds: number): string {
  return `about ${seconds}s`;
}

/** The demo PC. Six things running, one held, one still loading a model. */
function demoComponents(now: number): ComponentStatus[] {
  const up = (
    id: string,
    name: string,
    sentence: string,
    actions: ComponentStatus['actions'],
    details: Record<string, string>,
    extra: Partial<ComponentStatus> = {},
  ): ComponentStatus => ({
    id,
    name,
    state: 'up',
    sentence,
    since: now - 3 * 60 * 60 * 1000,
    actions,
    details,
    ...extra,
  });

  return [
    up(
      'main-model',
      'Main model',
      'Main model is answering.',
      ['switch-model', 'restart', 'hold'],
      { Port: '19001', Unit: 'demo-main-model.service', GPU: '0' },
      {
        busy: true,
        model: {
          live: 'main-model',
          profiles: [
            { id: 'main-model', name: 'Main model', loadSeconds: 420, gpus: [0] },
            { id: 'balanced', name: 'Balanced model', loadSeconds: 240, gpus: [0] },
            { id: 'large', name: 'Large model', loadSeconds: 300, gpus: [0] },
          ],
        },
      },
    ),
    up('coder', 'Second model', 'The second model is answering.', ['restart', 'stop'], {
      Port: '19005',
      Unit: 'demo-coder.service',
      GPU: '1',
    }),
    up('paseo', 'Coding agents', 'Paseo is running 3 agents.', ['restart', 'hold'], {
      Port: '19007',
      Unit: 'paseo.service',
    }),
    up('hermes-gateway', 'Assistant', 'Hermes is answering chats.', ['restart'], {
      Unit: 'demo-gateway.service',
    }),
    up('hermes-dashboard', 'Assistant dashboard', 'The dashboard is up.', ['restart'], {
      Port: '19006',
      Unit: 'demo-dashboard.service',
    }),
    up('wayroost-server', 'Wayroost server', 'Wayroost is up on this PC.', ['restart'], {
      Port: '19010',
      Unit: 'wayroost-server.service',
    }),
    up('signalbox-tunnel', 'Remote access', 'Your phone can reach this PC.', ['restart'], {
      Tunnel: 'wayroost',
      Unit: 'cloudflared.service',
    }),
    up('helper', 'Connectors helper', 'The helper is ready.', ['restart'], { Port: '19011' }),
    {
      id: 'speech',
      name: 'Voice replies',
      state: 'held',
      sentence: 'You held this one, so nothing is restarting it.',
      since: now - 40 * 60 * 1000,
      actions: ['release', 'restart'],
      details: { Unit: 'speech.service' },
    } satisfies ComponentStatus,
    up('phone', 'Phone line', 'Calls reach Hermes.', ['restart'], { Line: 'Demo line' }),
    up('keepalive', 'Keeps running', 'The keepers are watching the services.', ['stop'], {
      Unit: 'demo-keeper.service',
    }),
  ];
}

/** Green / terracotta / red for the status block. */
function overallOf(components: readonly ComponentStatus[]): SupervisorStatus['overall'] {
  const bad: ComponentState[] = ['down', 'failing'];
  if (components.some((c) => bad.includes(c.state))) return 'down';
  if (components.some((c) => c.state === 'starting' || c.state === 'held')) return 'attention';
  return 'ok';
}

/** Plain words for a verb, the same ones the app's buttons use. */
const SAY: Record<string, string> = {
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
  hold: 'Hold',
  release: 'Release',
  'switch-model': 'Switch model',
  diagnostics: 'Diagnostics',
};

function sentenceFor(components: readonly ComponentStatus[], running: ActionSummary | undefined): string {
  if (running) {
    const name = components.find((c) => c.id === running.target)?.name ?? 'something';
    return `${SAY[running.verb] ?? running.verb} ${name} — this page will follow it.`;
  }
  const overall = overallOf(components);
  if (overall === 'ok') return 'Everything is running.';
  if (overall === 'down') {
    const broken = components.find((c) => c.state === 'down' || c.state === 'failing');
    return `${broken?.name ?? 'Something'} is down.`;
  }
  const held = components.filter((c) => c.state === 'held' || c.state === 'starting');
  return `${held.length === 1 ? 'One thing' : `${held.length} things`} needs a look.`;
}

/** What a finished action leaves behind: a different state, or a different model. */
function afterAction(component: ComponentStatus, verb: string, actions: ComponentStatus['actions'], profile?: string): ComponentStatus {
  if (verb === 'switch-model' && component.model) {
    const name = component.model.profiles.find((p) => p.id === profile)?.name ?? profile ?? 'the other model';
    return { ...component, model: { ...component.model, live: profile ?? component.model.live }, sentence: `${name} is answering.` };
  }
  if (verb === 'hold') {
    return {
      ...component, state: 'held', actions: ['release', ...actions.filter((action) => action === 'restart')],
      sentence: 'You held this one, so nothing is restarting it.',
    };
  }
  if (verb === 'release') return { ...component, state: 'up', actions, sentence: 'It is running again.' };
  if (verb === 'stop') return { ...component, state: 'down', actions: ['start'], sentence: 'It is stopped, and nothing is bringing it up.' };
  if (verb === 'start') return { ...component, state: 'up', actions, since: Date.now(), sentence: 'It is running again.' };
  return { ...component, state: 'up', actions, since: Date.now() };
}

/** The record without its lines, as action events and snapshots carry it. */
function summaryOf(detail: ActionDetail): ActionSummary {
  const { lines: _lines, result: _result, ...summary } = detail;
  return summary;
}

/**
 * The demo PC's supervisor, in memory. Actions run on timers and report the way the
 * real one does: an action event for each change of state, a line event for each
 * progress line, and a status snapshot when something changes.
 */
export class DemoSupervisor implements SupervisorApi {
  private readonly runMs: number;
  private readonly lineMaker: (verb: string, target: string, profile?: string) => string[];
  private components: ComponentStatus[] = demoComponents(Date.now());
  /** What each component offers once it is running again. */
  private readonly runningActions = new Map<string, ComponentStatus['actions']>();
  private running: ActionDetail | null = null;
  private readonly actions = new Map<string, ActionDetail>();
  private readonly watchers = new Set<SupervisorStreamHandlers>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private sequence = 0;
  /** The last counts the server pushed, for anyone curious. */
  lastBusy: BusyCounts | null = null;

  constructor(options: DemoOptions = {}) {
    this.runMs = options.runMs ?? RUN_MS;
    this.lineMaker = options.lines ?? ((verb, target, profile) => this.defaultLines(verb, target, profile));
    this.rememberActions();
  }

  /** The snapshot as the supervisor would send it now. */
  snapshot(): SupervisorStatus {
    return {
      overall: overallOf(this.components),
      sentence: sentenceFor(this.components, this.running ?? undefined),
      components: this.components,
      ...(this.running ? { running: summaryOf(this.running) } : {}),
      // As on a real PC today: nobody can vouch that nothing is mid-turn.
      busy: 'unknown',
      at: Date.now(),
    };
  }

  async status(): Promise<SupervisorStatus> {
    return this.snapshot();
  }

  events(handlers: SupervisorStreamHandlers): () => void {
    this.watchers.add(handlers);
    // Like the real stream: a snapshot as soon as it opens.
    this.later(0, () => {
      if (this.watchers.has(handlers)) handlers.event({ type: 'status', status: this.snapshot() });
    });
    return () => this.watchers.delete(handlers);
  }

  async act(request: ActionRequest): Promise<ActionSummary | BusyError> {
    if (this.running) {
      return {
        error: 'busy',
        message: `Something else is running: ${this.running.verb} ${this.running.target}.`,
        running: summaryOf(this.running),
      };
    }
    return summaryOf(this.begin(request));
  }

  async action(id: string): Promise<ActionDetail | null> {
    return this.actions.get(id) ?? null;
  }

  async reportBusy(counts: BusyCounts): Promise<boolean> {
    this.lastBusy = counts;
    return true;
  }

  // ---- Settings: the config verbs the settings pipeline calls -----------------
  // Demo documents stand in for the files on a real PC, so the settings pages,
  // apply, undo, keys and usage all run the production routes in the UI check.

  readonly documents: Record<string, Record<string, unknown>> = {
    'hermes-config': {
      model: { provider: 'anthropic', default: 'example-main-model', base_url: '' },
      fallback_providers: [],
      agent: { reasoning_effort: 'medium' },
      display: { personality: '' },
      delegation: { model: 'example-main-model', provider: 'anthropic', max_concurrent_children: 2, max_iterations: 30, fallback_providers: [] },
      auxiliary: { compression: { provider: 'anthropic', model: 'example-tiny-model' } },
      approvals: { mode: 'smart', cron_mode: 'deny' },
      command_allowlist: ['git status', 'sed -n 1,40p *'],
      skills: { write_approval: false },
      memory: { write_approval: true },
    },
    'paseo-config': {
      agents: { providers: {
        claude: { enabled: true }, codex: { enabled: false }, hermes: { enabled: true, paseoTools: { enabled: true } },
      } },
      daemon: { agentProfiles: { 'paseo-coder': { id: 'paseo-coder', name: 'Coder', provider: 'pi', model: 'pi/example-coder-model' } } },
    },
    'gateway-role-map': {
      roles: { main: 'anthropic-main', coder: 'pi-coder', fast: 'anthropic-fast' },
      backends: {
        'anthropic-main': { provider: 'anthropic', servedName: 'example-main-model', contextLength: 1000000, maxOutputTokens: 64000, input: ['text', 'image'], toolCalling: true, thinkingLevels: true },
        'anthropic-fast': { provider: 'anthropic', servedName: 'example-tiny-model', contextLength: 200000, maxOutputTokens: 8000, input: ['text'], toolCalling: true, thinkingLevels: false },
        'pi-coder': { provider: 'openrouter', servedName: 'example-coder-model', contextLength: 131072, maxOutputTokens: 16000, input: ['text'], toolCalling: true, thinkingLevels: true },
      },
      contracts: {
        main: { input: ['text', 'image'], toolCalling: true, thinkingLevels: true, maxOutputTokens: 64000, advertisedContext: 1000000 },
        coder: { input: ['text'], toolCalling: true, thinkingLevels: true, maxOutputTokens: 16000, advertisedContext: 131072 },
        fast: { input: ['text'], toolCalling: true, thinkingLevels: false, maxOutputTokens: 8000, advertisedContext: 200000 },
      },
    },
    'gateway-state': { state: { version: 1, profile: 'demo', engine: 'demo', broughtUpAt: 0 }, migration: { version: 1 } },
    'gateway-credentials': { anthropic: 'stored-key' },
    'codex-config': { approval_policy: 'on-request', sandbox_mode: 'workspace-write' },
    'claude-settings': { permissions: { defaultMode: 'acceptEdits' } },
    'opencode-config': { permission: {} },
    'wayroost-settings': { safetyCommandsEnabled: false, push: { approvals: true, cards: false }, quietHours: null, rules: [] },
  };
  /** Set when a section read reports the managed-keys file; the demo PC has none. */
  private readonly backups = new Map<string, { target: string; document: Record<string, unknown> }>();

  async configRead(request: ConfigReadRequest): Promise<ConfigReadResult> {
    const spec = READ_VIEWS[request.view];
    const document = this.documents[spec.target];
    if (document === undefined) return { ok: true, view: request.view, present: false, values: [] };
    const values = readViewKeys(spec, document).map((path) => {
      const found = valueFromDocument(document, path);
      return found === undefined ? { path: [...path], exists: false as const } : { path: [...path], exists: true as const, value: found as never };
    });
    return { ok: true, view: request.view, present: true, sha256: shaOf(document), values };
  }

  async configApply(request: ConfigApplyRequest): Promise<ConfigWriteResult> {
    const parsed = parseOperation(request.operation, request.params, 'server');
    if (!parsed.ok) return { ok: false, code: parsed.code };
    const target = operationTarget(parsed.spec, parsed.params as Readonly<Record<string, unknown>>);
    const document = this.documents[target] ?? {};
    const before = structuredClone(document);
    if (request.preconditions && 'file' in request.preconditions && request.preconditions.file.sha256 !== shaOf(document)) return { ok: false, code: 'precondition_changed' };
    const params = parsed.params as Record<string, unknown>;
    const paths = operationKeys(parsed.spec, params as never, document);
    if (paths === 'recorded') return { ok: false, code: 'not_configured' };
    const values = appliedValues(request.operation, params);
    if (request.operation === 'hermes.revoke-always') {
      const allowlist = (document.command_allowlist ?? []) as unknown[];
      document.command_allowlist = allowlist.filter((entry) => shaOf(entry) !== (params.entrySha256 as string) && shaText(String(entry)) !== (params.entrySha256 as string));
    } else {
      paths.forEach((path, index) => setInDocument(document, path, (values[index] ?? params.enabled) as SettingValue | undefined));
    }
    this.documents[target] = document;
    const backupId = `demo-backup-${this.backups.size + 1}`;
    this.backups.set(backupId, { target, document: before });
    const token = { operation: request.operation, target, backupId, backupSha256: shaOf(before), writtenSha256: shaOf(document) };
    return { ok: true, keys: paths.map(formatKeyPath), ...token, undo: token };
  }

  async configUndo(request: ConfigUndoRequest): Promise<ConfigWriteResult> {
    const backup = this.backups.get(request.token.backupId);
    if (!backup || shaOf(backup.document) !== request.token.backupSha256) return { ok: false, code: 'backup_mismatch' };
    const current = this.documents[request.token.target] ?? {};
    if (shaOf(current) !== request.token.writtenSha256) return { ok: false, code: 'undo_changed' };
    const before = structuredClone(current);
    this.documents[request.token.target] = structuredClone(backup.document);
    const backupId = `demo-backup-${this.backups.size + 1}`;
    this.backups.set(backupId, { target: request.token.target, document: before });
    const token = { operation: request.token.operation, target: request.token.target, backupId, backupSha256: shaOf(before), writtenSha256: shaOf(backup.document) };
    return { ok: true, keys: [], ...token, undo: token };
  }

  async credentialWrite(request: CredentialWriteRequest): Promise<z.infer<typeof credentialWriteResultSchema>> {
    const keys = this.documents['gateway-credentials'] ?? {};
    if (request.action === 'remove') delete keys[request.provider];
    else keys[request.provider] = 'stored-key';
    this.documents['gateway-credentials'] = keys;
    return { ok: true, provider: request.provider, timing: 'restart-when-idle:gateway' };
  }

  async credentialTest(request: CredentialTestRequest): Promise<z.infer<typeof credentialTestResultSchema>> {
    const stored = this.documents['gateway-credentials']?.[request.provider] !== undefined;
    return stored
      ? { ok: true, provider: request.provider, backend: request.backend }
      : { ok: false, code: 'credential_missing' };
  }

  async usageSummary(request: UsageSummaryRequest): Promise<z.infer<typeof usageSummaryResultSchema>> {
    const rows = (scale: number) => [
      { role: 'main' as const, backend: 'anthropic-main', backendModel: 'example-main-model', requests: 42 * scale, errors: 1, inputTokens: 12_400 * scale, cacheReadTokens: 41_000 * scale, cacheWriteTokens: 2_100 * scale, outputTokens: 5_300 * scale, estimatedCostUsd: 0.42 * scale },
      { role: 'coder' as const, backend: 'pi-coder', backendModel: 'example-coder-model', requests: 18 * scale, errors: 0, inputTokens: 8_200 * scale, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 3_900 * scale, estimatedCostUsd: 0.04 * scale },
      { role: 'fast' as const, backend: 'anthropic-fast', backendModel: 'example-tiny-model', requests: 96 * scale, errors: 2, inputTokens: 6_100 * scale, cacheReadTokens: 12_000 * scale, cacheWriteTokens: 900 * scale, outputTokens: 2_400 * scale, estimatedCostUsd: 0.09 * scale },
    ];
    return { ok: true, generatedAt: Date.now(), windows: request.windows.map((window) => ({ id: window.id, since: window.since, rows: rows(window.id === 'week' ? 6 : 1) })) };
  }

  /** Back to the demo's starting state, with nothing running and no timers left. */
  reset(): void {
    this.stop();
    this.components = demoComponents(Date.now());
    this.rememberActions();
    this.running = null;
    this.actions.clear();
    this.publishStatus();
  }

  /** Cancel every timer (the app is closing). */
  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private rememberActions(): void {
    this.runningActions.clear();
    for (const component of this.components) {
      this.runningActions.set(component.id, component.state === 'held' ? ['restart', 'hold'] : component.actions);
    }
  }

  private emit(event: Parameters<SupervisorStreamHandlers['event']>[0]): void {
    for (const watcher of this.watchers) watcher.event(event);
  }

  private publishStatus(): void {
    this.emit({ type: 'status', status: this.snapshot() });
  }

  private update(detail: ActionDetail): void {
    this.actions.set(detail.id, detail);
    if (this.running?.id === detail.id) this.running = detail;
  }

  private later(ms: number, what: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      what();
    }, ms);
    this.timers.add(timer);
  }

  private defaultLines(verb: string, target: string, profile?: string): string[] {
    if (verb === 'switch-model') {
      const name = this.components.find((c) => c.id === target)?.model?.profiles.find((p) => p.id === profile)?.name ?? profile;
      return ['Taking the lock…', 'Stopping Main model…', `${name} loading…`, 'Weights on the GPU…', 'Health check passed.', `Switched to ${name}.`];
    }
    if (verb === 'hold') return ['Hold file written.', 'Keepers will leave it alone.'];
    if (verb === 'release') return ['Hold file removed.'];
    return ['Stopping the unit…', 'Starting the unit…', 'Health check passed.'];
  }

  private begin(request: ActionRequest): ActionDetail {
    const { verb, target, profile, when } = request;
    const id = `demo-action-${++this.sequence}`;
    const started: ActionDetail = {
      id,
      verb,
      target,
      ...(profile ? { profile } : {}),
      state: when === 'idle' ? 'waiting-for-idle' : 'queued',
      caller: 'demo',
      startedAt: Date.now(),
      lines: [],
    };
    this.running = started;
    this.actions.set(id, started);
    this.emit({ type: 'action', action: summaryOf(started) });
    this.publishStatus();

    let step = 0;
    const scripted = this.lineMaker(verb, target, profile);
    if (when === 'idle') {
      // The demo PC is busy for a moment: waiting-for-idle is what the phone is told about.
      this.later(IDLE_WAIT_MS, () => {
        if (this.running?.id !== id) return;
        this.update({ ...this.running, state: 'running' });
        this.emit({ type: 'action', action: summaryOf(this.running) });
      });
    }
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = setInterval(() => {
      const current = this.running;
      if (current?.id !== id || current.state === 'waiting-for-idle') return;
      const next = scripted[step];
      if (!next) return;
      step += 1;
      const wasRunning = current.state === 'running';
      this.update({ ...current, lines: [...current.lines, next], state: 'running' });
      if (!wasRunning) this.emit({ type: 'action', action: summaryOf(this.running!) });
      this.emit({ type: 'line', actionId: id, line: next });
    }, LINE_MS);
    this.later(this.runMs, () => {
      const current = this.running;
      if (current?.id !== id) return;
      if (this.ticker) clearInterval(this.ticker);
      this.ticker = null;
      const done: ActionDetail = { ...current, state: 'done', endedAt: Date.now(), lines: scripted.slice(), result: 'Done.' };
      this.actions.set(id, done);
      this.running = null;
      this.components = this.components.map((c) =>
        c.id === target ? afterAction(c, verb, this.runningActions.get(c.id) ?? c.actions, profile) : c,
      );
      this.emit({ type: 'action', action: summaryOf(done) });
      this.publishStatus();
    });
    return started;
  }
}

/** Used by the report and by anyone reading the demo: the fake states it shows. */
export const DEMO_STATES: ComponentState[] = ['up', 'starting', 'down', 'held', 'failing'];
export const demoSeconds = seconds;

// ---- Demo config verbs: helpers --------------------------------------------

function shaText(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function shaOf(value: unknown): string {
  return shaText(JSON.stringify(value, (_key, inner) => (inner instanceof Map || inner instanceof Set ? undefined : inner)) ?? 'undefined');
}
function valueFromDocument(document: unknown, path: KeyPath): unknown {
  let current = document;
  for (const segment of path) {
    if (!current || typeof current !== 'object') return undefined;
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = (current as unknown[])[segment];
    } else if (typeof segment === 'object') {
      current = Array.isArray(current) ? (current as { id?: string }[]).find((entry) => entry && entry.id === segment.id) : undefined;
    } else {
      if (!Object.hasOwn(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}
function setInDocument(document: Record<string, unknown>, path: KeyPath, value: SettingValue | undefined): void {
  let current: Record<string | number, unknown> = document;
  for (const [index, segment] of path.entries()) {
    const last = index === path.length - 1;
    if (typeof segment === 'number' || typeof segment === 'object') return;
    if (last) {
      if (value === undefined) delete current[segment];
      else current[segment] = value;
      return;
    }
    const next = current[segment];
    if (next && typeof next === 'object') { current = next as Record<string | number, unknown>; continue; }
    const created: Record<string | number, unknown> = {};
    current[segment] = created;
    current = created;
  }
}

/** The values each operation writes, in key order. Mirrors what the real supervisor derives from params. */
function appliedValues(operation: string, params: Record<string, unknown>): unknown[] {
  const table: Record<string, unknown[]> = {
    'hermes.reasoning-effort': [params.effort],
    'hermes.personality': [params.personality],
    'hermes.delegation-limits': [params.maxConcurrentChildren, params.maxIterations],
    'hermes.approval-mode': [params.mode],
    'hermes.skill-staging': [params.enabled],
    'paseo.provider-enabled': [params.enabled],
    'paseo.routing-note': [params.text],
    'paseo.profile-model': [params.model],
    'hermes.default-model': [params.provider, params.model, params.baseUrl],
    'hermes.delegation-model': [params.provider, params.model],
    'hermes.main-fallbacks': [params.chain],
    'hermes.delegation-fallbacks': [params.chain],
    'hermes.helper-model': [params.provider, params.model],
    'gateway.point': [params.backend],
    'wayroost.safety-commands': [params.enabled],
  };
  return table[operation] ?? [];
}
