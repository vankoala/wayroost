import { checkDeviceSignal, deviceSignal } from './security/device-signal.js';
import { createHash, randomBytes } from 'node:crypto';
import { PHONE_VERBS } from '../../shared/supervisor.js';
import type {
  ActionDetail,
  ActionRequest,
  ActionState,
  ActionSummary,
  BusyError,
  SupervisorEvent,
  SupervisorStatus,
} from '../../shared/supervisor.js';
import type { PowerActionResponse, PowerStatus, PresenceState, DevicePresence } from '../../shared/protocol.js';
import type { SupervisorApi } from './supervisor-client.js';
import type { EventHub } from './hub.js';
import type { Logger } from './hermes/adapter.js';
import type { RequestDevice } from './devices.js';
import { UserFacingError } from './sources.js';

// What the Status & power page is built from. Nothing here
// is stored on disk: the snapshot is whatever the supervisor's event stream last
// said, presence is whatever each device last posted, and a phone's
// confirmation is a random token that lives until it's used or 60 seconds pass.

/** How long a phone's confirm token stays good. */
export const CONFIRM_TTL_MS = 60_000;
/** Confirmations this server will keep waiting for a second tap; the oldest goes. */
const MAX_CONFIRMS = 64;

export const SUPERVISOR_NOT_RUNNING = "The supervisor isn't running.";

/** Another lifecycle action is running, so nothing was queued; the route answers 409. */
export interface PowerBusy {
  busy: BusyError;
}

export type PowerResult = PowerActionResponse | PowerBusy;

interface Confirmation {
  /** Which device was handed the token. */
  readonly device: string;
  /** Fingerprint of the exact request it was handed for. */
  readonly request: string;
  readonly expiresAt: number;
  used: boolean;
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Same fields, same answer: a confirm token is bound to one exact request. */
function requestKey(request: ActionRequest): string {
  return hash([request.verb, request.target, request.profile ?? '', request.when ?? 'now'].join('\u0000'));
}

/** "hermes-gateway" → "Hermes gateway", for when the supervisor hasn't told us its plain name. */
function plainName(target: string): string {
  const words = target.split(/[-_]/).filter(Boolean);
  if (!words.length) return 'that';
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
}

/**
 * How far an action had got, as a number that only goes up. The supervisor's own
 * stream and the reply to the call that queued the action can arrive in either
 * order, so this is how older news is recognised as older.
 */
const STATE_RANK: Record<ActionState, number> = {
  queued: 0,
  'waiting-for-idle': 1,
  running: 2,
  done: 3,
  failed: 3,
  cancelled: 3,
};
const FINISHED = 3;
/** How many actions to remember states for; the oldest goes. */
const ACTION_MEMORY = 40;

/** 240 → "4 min", to put inside the sentence the person taps. */
function humanLoad(seconds: number): string {
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${Math.max(1, rounded)} seconds`;
  const minutes = Math.max(1, Math.round(rounded / 60));
  return minutes < 60 ? `${minutes} min` : `${Math.round((minutes / 60) * 10) / 10} hours`;
}

/**
 * One plain sentence for the phone to confirm: what it does and what it costs,
 * in the supervisor's own words where it has given us any ("Main model", the
 * profile names, their cold-start times).
 */
export function confirmSummary(request: ActionRequest, status: SupervisorStatus | null): string {
  const component = status?.components.find((c) => c.id === request.target);
  const name = component?.name ?? plainName(request.target);
  const lower = name.charAt(0).toLowerCase() + name.slice(1);
  const idle = request.when === 'idle' ? ' when things go idle' : '';
  const load = component?.model?.profiles.find((p) => p.id === request.profile)?.loadSeconds;

  switch (request.verb) {
    case 'switch-model': {
      const profile = component?.model?.profiles.find((p) => p.id === request.profile);
      const to = profile?.name ?? request.profile ?? 'the other model';
      return `Switch to ${to}${idle}? ${load ? `About ${humanLoad(load)} without the ${lower}.` : `The ${lower} will be away for a few minutes.`}`;
    }
    case 'restart':
      return `Restart the ${lower}${idle}? ${load ? `It will be away for about ${humanLoad(load)}.` : 'It stops for a moment and comes back.'}`;
    case 'start':
      return `Start the ${lower}${idle}?`;
    case 'stop':
      return `Stop the ${lower}? It stays down until something starts it again.`;
    case 'hold':
      return `Hold the ${lower}? Nothing will bring it back until it is released.`;
    case 'release':
      return `Release the ${lower}? The keepers will start it again if it is down.`;
    default:
      return `Run diagnostics on the ${lower}?`;
  }
}

export interface PowerOptions {
  /** A phone's confirm token stays good this long. */
  confirmTtlMs?: number;
  /** Tests pass a clock so they can watch a token expire. */
  now?: () => number;
}

/**
 * The supervisor's snapshot, kept warm from its event stream, plus the presence
 * reports and the confirm tokens waiting for a second tap.
 */
export class Power {
  private snapshot: SupervisorStatus | null = null;
  private signature = '';
  private live = false;
  private readonly presence = new Map<string, DevicePresence>();
  /**
   * Everything that has happened to the stream: an event taken from it, a loss, or
   * being stopped. Once it has done any of these, the answer to the status() call
   * made at start is older news: the stream is the source of truth, and a stream
   * that dropped means "not running" until it says otherwise.
   */
  private streamChanges = 0;
  /** How far each action had got as far as we have heard, newest knowledge only. */
  private readonly actionStates = new Map<string, number>();
  /** Snapshots the supervisor itself has sent, to tell whether one came in during a call. */
  private reports = 0;
  /**
   * The last snapshot the supervisor itself sent (not one patched here with an
   * action): when it took it, on its own clock, and which action it said was running.
   */
  private reported: { at: number; running: string | undefined } | undefined;
  /** Confirm tokens by hash of the token; the token itself is not kept. */
  private readonly confirms = new Map<string, Confirmation>();
  private stopStream: (() => void) | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly supervisor: SupervisorApi | undefined,
    private readonly hub: EventHub,
    private readonly log: Logger,
    options: PowerOptions = {},
  ) {
    this.ttlMs = options.confirmTtlMs ?? CONFIRM_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Watch the supervisor. Its stream sends a snapshot the moment it opens, so a
   * restart or a redial needs nothing else to catch up; the one status() call
   * here only covers the seconds before that stream is up. If it answers after the
   * stream has said anything, dropped, or been stopped, its answer is older news
   * and goes nowhere.
   */
  start(): void {
    if (!this.supervisor) return;
    const changesBefore = this.streamChanges;
    this.stopStream = this.supervisor.events({
      event: (event) => this.onEvent(event),
      lost: () => this.markLost(),
    });
    void this.supervisor.status().then((status) => {
      if (status && this.streamChanges === changesBefore) this.cache(status);
    });
  }

  stop(): void {
    this.streamChanges += 1;
    this.stopStream?.();
    this.stopStream = undefined;
  }

  /** GET /api/power. */
  view(): PowerStatus {
    const status = this.live ? this.snapshot : null;
    return {
      running: status !== null,
      ...(status ? { status } : {}),
      sentence: status ? status.sentence : SUPERVISOR_NOT_RUNNING,
      presence: [...this.presence.values()].sort((a, b) => b.at - a.at),
    };
  }

  /** The action record, with its progress lines, for a page that missed them. */
  action(id: string): Promise<ActionDetail | null> {
    return this.supervisor ? this.supervisor.action(id) : Promise.resolve(null);
  }

  /** POST /api/presence. M1 records it and shows it; nothing is routed by it yet. */
  setPresence(device: RequestDevice, state: PresenceState): void {
    checkDeviceSignal();
    const previous = this.presence.get(device.id);
    this.presence.set(device.id, { device: device.id, kind: device.kind, state, at: this.now() });
    // A device saying "active" again every few minutes shouldn't wake every page.
    if (!previous || previous.state !== state) this.hub.publish({ type: 'power_status', power: this.view() });
  }

  /** A revoked device: drop its presence and any confirm token it was handed. */
  forget(deviceId: string): void {
    for (const [key, pending] of this.confirms) if (pending.device === deviceId) this.confirms.delete(key);
    if (this.presence.delete(deviceId)) this.hub.publish({ type: 'power_status', power: this.view() });
  }

  /**
   * POST /api/power/actions. A desktop goes straight through; a phone's first
   * request gets a token and one sentence to tap, and the same request carrying
   * that token goes through.
   */
  async act(device: RequestDevice, request: ActionRequest, confirm?: string, signal = deviceSignal()): Promise<PowerResult> {
    checkDeviceSignal(signal);
    const supervisor = this.supervisor;
    if (!supervisor || !this.live) throw new UserFacingError(SUPERVISOR_NOT_RUNNING, 503);
    if (device.kind === 'phone' && !PHONE_VERBS.includes(request.verb)) {
      this.log.info({ verb: request.verb, target: request.target, kind: device.kind }, 'power action refused from this device');
      throw new UserFacingError(`That action is for the desktop; a phone can restart things and switch the model.`, 403);
    }
    if (device.kind === 'phone') {
      // The confirm tap: a phone's first request only gets the sentence back.
      if (confirm === undefined) return this.issue(device, request);
      this.spend(confirm, device, request);
    }

    const reportsBefore = this.reports;
    checkDeviceSignal(signal);
    const outcome = await supervisor.act(request);
    if ('error' in outcome) {
      this.log.info({ verb: request.verb, target: request.target, kind: device.kind }, 'power action refused: another action is running');
      return { busy: outcome };
    }
    this.log.info({ verb: request.verb, target: request.target, kind: device.kind }, 'power action queued');
    // The next snapshot will carry it too; a page shouldn't wait for that. An answer
    // with no start time is built from the request (the record couldn't be read): a
    // snapshot the supervisor sent while we waited is newer than that guess, so the
    // guess goes nowhere, and the stream that sent the snapshot tells the rest.
    if (outcome.startedAt > 0 || this.reports === reportsBefore) this.noteAction(outcome);
    return { action: outcome };
  }

  /** Hand a phone a token for this exact request, and the sentence to tap. */
  private issue(device: RequestDevice, request: ActionRequest): PowerActionResponse {
    const now = this.now();
    for (const [key, pending] of this.confirms) if (pending.expiresAt <= now) this.confirms.delete(key);
    while (this.confirms.size >= MAX_CONFIRMS) {
      const oldest = this.confirms.keys().next();
      if (oldest.done) break;
      this.confirms.delete(oldest.value);
    }
    const token = randomBytes(16).toString('hex');
    this.confirms.set(hash(token), { device: device.id, request: requestKey(request), expiresAt: now + this.ttlMs, used: false });
    this.log.info({ verb: request.verb, target: request.target, kind: device.kind }, 'power action needs a confirm tap');
    return { confirm: token, summary: confirmSummary(request, this.live ? this.snapshot : null) };
  }

  /** Check a token and burn it: one tap, one action. */
  private spend(token: string, device: RequestDevice, request: ActionRequest): void {
    const pending = this.confirms.get(hash(token));
    if (!pending || pending.expiresAt <= this.now()) throw new UserFacingError('That confirmation has expired. Ask again.', 403);
    if (pending.used) throw new UserFacingError('That confirmation was already used. Ask again.', 403);
    if (pending.device !== device.id) throw new UserFacingError('That confirmation belongs to another device.', 403);
    pending.used = true;
    if (pending.request !== requestKey(request)) throw new UserFacingError('That confirmation is for a different request. Ask again.', 403);
  }

  private onEvent(event: SupervisorEvent): void {
    this.streamChanges += 1;
    if (event.type === 'status') this.cache(event.status);
    else if (event.type === 'action') {
      this.noteAction(event.action);
      this.hub.publish({ type: 'power_action', action: event.action });
    } else this.hub.publish({ type: 'power_line', actionId: event.actionId, line: event.line });
  }

  /**
   * Keep the running action in the cache so a page that just opened sees it. Both
   * the stream and the call that queued the action report the same action, in no
   * particular order, so whatever we have heard about each one is kept and nothing
   * moves backwards: an action the stream says finished doesn't come back because
   * a slow reply calls it queued, and one that finished isn't shown as running.
   *
   * The stream can also miss an action's end (it dropped, and the supervisor's
   * snapshot on reconnecting is all it says about the gap). Only one action runs
   * at a time and a snapshot shows it as running from the moment it is queued
   * until it ends, so a snapshot the supervisor took after an action started that
   * shows something else running, or nothing, means that action had ended by then.
   * Both times are the supervisor's own clock; an equal time proves nothing.
   *
   * A record with no start time (0: the supervisor didn't give one, or the record
   * couldn't be read and was built from the request) can't be placed against a
   * snapshot, so it proves nothing either way: it never ends anything, and it
   * never replaces what we have already heard about the action at the same stage.
   */
  private noteAction(action: ActionSummary): void {
    const reported = this.reported;
    const timed = action.startedAt > 0;
    const endedBySnapshot =
      timed && reported !== undefined && reported.at > action.startedAt && reported.running !== action.id;
    const rank = endedBySnapshot ? FINISHED : STATE_RANK[action.state];
    const heard = this.actionStates.get(action.id);
    if (heard !== undefined && (heard > rank || (!timed && heard === rank))) return;
    this.actionStates.set(action.id, rank);
    if (this.actionStates.size > ACTION_MEMORY) {
      const oldest = this.actionStates.keys().next();
      if (!oldest.done) this.actionStates.delete(oldest.value);
    }

    const snapshot = this.snapshot;
    if (!snapshot || !this.live) return;
    if (rank === FINISHED) {
      if (snapshot.running?.id === action.id) this.cache({ ...snapshot, running: undefined, at: this.now() }, false);
      return;
    }
    if (snapshot.running?.id === action.id && STATE_RANK[snapshot.running.state] >= rank) return;
    this.cache({ ...snapshot, running: action, at: this.now() }, false);
  }

  /**
   * Cache a snapshot and push it, but only when it says something new.
   * `fromSupervisor` is false for a snapshot patched here with an action.
   */
  private cache(status: SupervisorStatus, fromSupervisor = true): void {
    if (fromSupervisor) {
      this.reported = { at: status.at, running: status.running?.id };
      this.reports += 1;
    }
    const signature = summarize(status);
    const changed = signature !== this.signature || !this.live;
    if (!this.live) this.log.info({}, 'the supervisor is answering');
    this.snapshot = status;
    this.signature = signature;
    this.live = true;
    if (changed) this.hub.publish({ type: 'power_status', power: this.view() });
  }

  private markLost(): void {
    // Counted even when nothing was live yet: a startup answer still in the air
    // must not bring back a supervisor whose stream has just failed.
    this.streamChanges += 1;
    if (!this.live) return;
    this.live = false;
    this.signature = '';
    this.log.warn({}, 'the supervisor stopped answering');
    this.hub.publish({ type: 'power_status', power: this.view() });
  }
}

/**
 * A snapshot as one string, for "would a page show anything differently?". All of
 * it counts — the plain names, the details, the profiles a model can switch to and
 * what they cost, the whole running action — except the snapshot's own timestamp,
 * which moves on every poll and says nothing on its own.
 */
function summarize(status: SupervisorStatus): string {
  const { at: _at, ...shown } = status;
  return JSON.stringify(shown);
}
