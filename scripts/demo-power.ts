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
