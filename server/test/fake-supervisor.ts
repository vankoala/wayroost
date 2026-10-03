import type {
  ActionDetail,
  ActionRequest,
  ActionSummary,
  BusyError,
  ComponentStatus,
  SupervisorEvent,
  SupervisorStatus,
} from '../../shared/supervisor.js';
import type { BusyCounts, SupervisorApi, SupervisorStreamHandlers } from '../src/supervisor-client.js';

// The supervisor as the server sees it: a snapshot we can change, an action list
// that records what was asked, and a stream the test pushes events down. A test
// can also hold an answer open with gate(), which is how a reply that arrives
// late — after the event stream has moved on — gets tested.

/** A promise the test resolves when it wants the fake's answer to land. */
export function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function mainModel(overrides: Partial<ComponentStatus> = {}): ComponentStatus {
  return {
    id: 'main-model',
    name: 'Main model',
    state: 'up',
    sentence: 'Main model is answering.',
    busy: false,
    actions: ['restart', 'stop', 'switch-model'],
    model: {
      live: 'main-model',
      profiles: [
        { id: 'main-model', name: 'Main model', loadSeconds: 420, gpus: [0] },
        { id: 'balanced', name: 'Balanced model', loadSeconds: 240, gpus: [0] },
      ],
    },
    details: { port: '19001', gpus: '0' },
    ...overrides,
  };
}

export function demoStatus(overrides: Partial<SupervisorStatus> = {}): SupervisorStatus {
  return {
    overall: 'ok',
    sentence: 'Everything is running.',
    components: [mainModel(), { id: 'paseo', name: 'Agent workspace', state: 'up', sentence: 'The agent workspace is running.', actions: ['restart'] }],
    at: 1_700_000_000_000,
    ...overrides,
  };
}

export function actionSummary(request: ActionRequest, overrides: Partial<ActionSummary> = {}): ActionSummary {
  return {
    id: 'act-demo-1',
    verb: request.verb,
    target: request.target,
    ...(request.profile ? { profile: request.profile } : {}),
    state: 'queued',
    caller: 'demo-key',
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export class FakeSupervisor implements SupervisorApi {
  /** What it would answer to GET /v1/status; null stands for "not running". */
  snapshot: SupervisorStatus | null = demoStatus();
  /** Set to make every action answer 409 instead of taking it. */
  busy: BusyError | undefined;
  /** Set to make act() fail the way a dead socket does. */
  failing: Error | undefined;
  readonly acted: ActionRequest[] = [];
  detail: ActionDetail | null = null;
  /** When set, status() answers with this instead of the snapshot: hold it to make the reply late. */
  statusGate: Promise<SupervisorStatus | null> | null = null;
  /** When set, act() answers with this: hold it so the reply lands after the stream. */
  actGate: Promise<ActionSummary | BusyError> | null = null;
  /** What act() answers when it isn't failing, busy or gated. */
  result: ActionSummary | null = null;
  private readonly handlers: SupervisorStreamHandlers[] = [];

  async status(): Promise<SupervisorStatus | null> {
    if (this.statusGate) return this.statusGate;
    return this.snapshot;
  }

  events(handlers: SupervisorStreamHandlers): () => void {
    this.handlers.push(handlers);
    return () => {
      const at = this.handlers.indexOf(handlers);
      if (at >= 0) this.handlers.splice(at, 1);
    };
  }

  async act(request: ActionRequest): Promise<ActionSummary | BusyError> {
    if (this.failing) throw this.failing;
    this.acted.push(request);
    if (this.busy) return this.busy;
    if (this.actGate) return this.actGate;
    return this.result ?? actionSummary(request);
  }

  async action(id: string): Promise<ActionDetail | null> {
    return this.detail && this.detail.id === id ? this.detail : null;
  }

  /** Every set of busy counts it was told, oldest first. */
  readonly reported: BusyCounts[] = [];
  /** Set to false to make it refuse the counts. */
  takesCounts = true;

  async reportBusy(counts: BusyCounts): Promise<boolean> {
    this.reported.push({ ...counts });
    return this.takesCounts;
  }

  // ---- what the test drives ----

  /** The supervisor sends an event on its stream. */
  push(event: SupervisorEvent): void {
    for (const handler of [...this.handlers]) handler.event(structuredClone(event));
  }

  /** The stream dropped: the client is supposed to redial. */
  lose(): void {
    for (const handler of [...this.handlers]) handler.lost();
  }
}
