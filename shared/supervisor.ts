// Contract between the supervisor (root, inside the engine room) and its callers:
// the Wayroost server over a Unix socket, and the desktop app's rescue path over
// 127.0.0.1. The supervisor runs fixed verbs on registry targets only; it never
// takes a command line, a path or a shell string from a caller.

/** Every action the supervisor accepts. update and rollback come with M4. */
export type SupervisorVerb = 'start' | 'stop' | 'restart' | 'hold' | 'release' | 'switch-model' | 'diagnostics';
export const SUPERVISOR_VERBS: readonly SupervisorVerb[] = ['start', 'stop', 'restart', 'hold', 'release', 'switch-model', 'diagnostics'];

/** What a phone may ask for, always with a confirm tap (the server enforces the tap). */
export const PHONE_VERBS: readonly SupervisorVerb[] = ['restart', 'switch-model'];

/** What the desktop's rescue key may do when the server is down. */
export const RESCUE_ACTIONS: readonly { verb: SupervisorVerb; target: string }[] = [{ verb: 'restart', target: 'wayroost-server' }];

/** Registry ids. Site-only extras from components.local.json keep the same shape with their own ids. */
export type ComponentId =
  | 'main-model'
  | 'coder'
  | 'paseo'
  | 'hermes-dashboard'
  | 'hermes-gateway'
  | 'wayroost-server'
  | 'signalbox'
  | 'signalbox-tunnel'
  | 'helper'
  | 'speech'
  | 'phone'
  | 'keepalive'
  | (string & {});

export type ComponentState =
  | 'up' // healthy
  | 'starting' // started, health not answering yet (a model loading)
  | 'down' // not running, and nothing is bringing it up
  | 'held' // a hold stops the keepers from restarting it
  | 'failing'; // restarts keep failing; the supervisor has given up for now

export interface ComponentStatus {
  id: ComponentId;
  /** Plain name for people: "Main model", "Phone line", "Remote access". */
  name: string;
  state: ComponentState;
  /** One plain sentence: "Main model is answering." / "Loading Balanced model, about 4 min left." */
  sentence: string;
  /** Epoch ms when it entered this state, when known. */
  since?: number;
  /** True when it's mid-turn or mid-call, so "restart when idle" waits for it. */
  busy?: boolean;
  /** The verbs that make sense for it right now (the UI shows the first as the main action). */
  actions: SupervisorVerb[];
  /** For main-model only: the profile that's live and the ones it can switch to. */
  model?: { live: string | null; profiles: ModelProfile[] };
  /** Under "Details" only: ports, unit names, GPU. Never secrets, never log contents. */
  details?: Record<string, string>;
}

export interface ModelProfile {
  /** "main-model", "balanced", … the same names launch.sh takes. */
  id: string;
  name: string;
  /** Rough cold-start time, for "about 7 min" in the confirm sheet. */
  loadSeconds?: number;
  /** GPUs it needs, by index; a switch stops whatever else holds them. */
  gpus: number[];
}

export interface SupervisorStatus {
  /** One line for the status block: green, needs attention, or down. */
  overall: 'ok' | 'attention' | 'down';
  sentence: string;
  components: ComponentStatus[];
  /**
   * Components whose commands come from config (launch/coder scripts, hold dir)
   * while that config is unset. They are not probed and take no actions.
   */
  notSetUp?: { id: ComponentId; name: string; sentence: string }[];
  /**
   * Whole-PC busy from the counts the server pushes to POST /v1/busy.
   * "unknown" means no fresh push (<60 s old); "when idle" treats it as busy.
   */
  busy?: 'idle' | 'busy' | 'unknown';
  /** The lifecycle action that's running, if any (only one runs at a time). */
  running?: ActionSummary;
  /** Epoch ms of this snapshot. */
  at: number;
}

export type ActionWhen = 'now' | 'idle';

export interface ActionRequest {
  verb: SupervisorVerb;
  target: ComponentId;
  /** For switch-model: the profile id. Checked against the registry. */
  profile?: string;
  /** "idle" waits until nothing is mid-turn or mid-call (at most 30 min), then asks. */
  when?: ActionWhen;
}

export type ActionState = 'queued' | 'waiting-for-idle' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ActionSummary {
  id: string;
  verb: SupervisorVerb;
  target: ComponentId;
  profile?: string;
  state: ActionState;
  /** Who asked: the key's name and, through the server, the device. */
  caller: string;
  startedAt: number;
  endedAt?: number;
}

export interface ActionDetail extends ActionSummary {
  /** Progress lines as the action prints them ("Main model loading…"). Infra output only. */
  lines: string[];
  /** Plain result: "Switched to the balanced model." / "The model didn't answer within 10 min." */
  result?: string;
}

/** Server-Sent Events on GET /v1/events. */
export type SupervisorEvent =
  | { type: 'status'; status: SupervisorStatus }
  | { type: 'action'; action: ActionSummary }
  | { type: 'line'; actionId: string; line: string };

/** 409 body when a lifecycle action is already running. */
export interface BusyError {
  error: 'busy';
  message: string;
  running: ActionSummary;
}

/** Routes, for both sides to share. */
export const SUPERVISOR_ROUTES = {
  status: '/v1/status',
  events: '/v1/events',
  actions: '/v1/actions',
  action: (id: string) => `/v1/actions/${encodeURIComponent(id)}`,
  /** Server key only: { paseoRunning, hermesRunning, calls }, pushed every ~10 s. */
  busy: '/v1/busy',
} as const;

/** Default places; the live install may override them in /etc/wayroost/supervisor.json. */
export const SUPERVISOR_DEFAULTS = {
  socket: '/run/wayroost/supervisor.sock',
  rescueHost: '127.0.0.1',
  rescuePort: 8880,
  /** Development and tests use the 8890–8899 block and never the live ports. */
  devRescuePort: 8898,
} as const;
