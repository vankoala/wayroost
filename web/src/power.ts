// The Status & power data path: GET /api/power, which answers with
// the server's PowerStatus envelope (the supervisor's snapshot only while it is
// answering, the server's own sentence and the devices' presence), POST
// /api/power/actions, the action records, and the live power events on the
// socket. Plus the plain-word labels the status block and the Status & power page
// show.

import { useCallback, useEffect, useState } from 'react';
import { REQUEST_MARKER_HEADER, type DeviceInfo, type DevicePresence, type MeResponse, type PowerStatus, type ServerEvent } from '../../shared/protocol';
import type {
  ActionDetail,
  ActionRequest,
  ActionSummary,
  ComponentState,
  ComponentStatus,
  SupervisorStatus,
  SupervisorVerb,
} from '../../shared/supervisor';
import { ApiError, beginAuthenticatedRequest, checkAuthentication, checkAuthenticationGeneration, reportAuthenticationAnomaly } from './authentication';
import { getState, onStoreChange, setState } from './store';

/** Answered by the server when this device must confirm a power action (a phone tap). */
export interface PowerConfirm {
  /** Single-use token, bound to this device and this exact request. */
  confirm: string;
  /** One plain sentence of what will happen, e.g. "Switch to Balanced model? About 4 min without the main model." */
  summary: string;
}

/** An action request; `confirm` is the single-use token a phone answers with. */
export type PowerRequest = ActionRequest & { confirm?: string };

export type ActResult =
  | { kind: 'queued'; action: ActionSummary }
  /** The device has to confirm: show the sheet, then resend with the token. */
  | { kind: 'confirm'; confirm: PowerConfirm }
  /** Another lifecycle action is running: the server's words, and that action when it named it. */
  | { kind: 'busy'; running?: ActionSummary; message: string }
  | { kind: 'error'; message: string };

export interface Power {
  /** The supervisor's latest snapshot, only while the server says it is answering. */
  status: SupervisorStatus | null;
  /** No status to act on: the server didn't answer, refused, or says the supervisor isn't running. */
  unavailable: boolean;
  /** True once the first request finished, one way or another. */
  loaded: boolean;
  /** The server's one plain line ("The supervisor isn't running."), when it answered. */
  sentence: string | null;
  /** The latest report from each paired device, newest first. */
  presence: DevicePresence[];
  /** The newest running fetched action, otherwise the most recent undismissed result. */
  action: ActionSummary | null;
  result: string | null;
  lines: string[];
  /** Completed actions remain visible when another device starts a successor. */
  completed: ActionDetail[];
  refresh: () => void;
  act: (request: PowerRequest) => Promise<ActResult>;
  actionGuard: () => () => boolean;
  dismiss: (actionId: string) => void;
}

const POLL_MS = 5_000;
/** While an action runs, the page and the block follow it closely. */
const POLL_ACTIVE_MS = 1_200;

interface Snapshot {
  status: SupervisorStatus | null;
  unavailable: boolean;
  loaded: boolean;
  sentence: string | null;
  presence: DevicePresence[];
  action: ActionSummary | null;
  result: string | null;
  lines: string[];
  completed: ActionDetail[];
}

/** Nothing to show: no answer, or an answer that isn't a status. Old status never lingers. */
const NO_ANSWER: Omit<Snapshot, 'loaded'> = { status: null, unavailable: true, sentence: null, presence: [], action: null, result: null, lines: [], completed: [] };

let snapshot: Snapshot = { ...NO_ANSWER, unavailable: false, loaded: false };
const listeners = new Set<() => void>();
let watchers = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let sessionGeneration = 0;
let statusRequest = 0;
let statusDirty = false;
let availabilityGeneration = 0;
interface ActionRecord {
  detail: ActionDetail | null;
  request: number;
  pending: number;
  dirty: boolean;
  final: boolean;
  dismissed: boolean;
}
const actionMemory = new Map<string, ActionRecord>();
const actionReads = new Map<string, Promise<string[]>>();

function validDevice(device: DeviceInfo | undefined): device is DeviceInfo {
  return !!device && typeof device.id === 'string' && device.id.length > 0 && (device.kind === 'desktop' || device.kind === 'phone');
}

function signedOut(): boolean {
  const state = getState();
  return state.unpaired || state.sessionExpired;
}

function identified(): boolean {
  return !signedOut() && validDevice(getState().device);
}

let identity = getState().device;
let authLost = signedOut();
let socketState = getState().socket;
onStoreChange(() => {
  const next = getState().device;
  const lost = signedOut();
  const nextSocket = getState().socket;
  const reopened = socketState !== 'open' && nextSocket === 'open';
  socketState = nextSocket;
  if (identity?.id === next?.id && identity?.kind === next?.kind && authLost === lost) {
    if (reopened) recover();
    return;
  }
  identity = next;
  authLost = lost;
  sessionGeneration += 1;
  statusRequest += 1;
  statusDirty = false;
  inFlight = null;
  actionReads.clear();
  actionMemory.clear();
  stopPolling();
  publish({ ...NO_ANSWER, loaded: lost });
  if (!lost && watchers > 0 && !document.hidden) void load().finally(schedule);
});

function publish(next: Snapshot): void {
  if (!!snapshot.status !== !!next.status || snapshot.unavailable !== next.unavailable) availabilityGeneration += 1;
  snapshot = next;
  for (const listener of listeners) listener();
}

/** A confirmation belongs to one paired identity and one uninterrupted period of availability. */
function powerActionGuard(): () => boolean {
  const session = sessionGeneration;
  const availability = availabilityGeneration;
  return () => session === sessionGeneration && availability === availabilityGeneration && identified() && !!snapshot.status && !snapshot.unavailable;
}

/** The envelope as the page uses it: the supervisor's snapshot only while it is answering. */
function fromPower(power: PowerStatus): Pick<Snapshot, 'status' | 'unavailable' | 'loaded' | 'sentence' | 'presence'> {
  const status = power.running && power.status ? power.status : null;
  return {
    status,
    unavailable: status === null,
    loaded: true,
    sentence: typeof power.sentence === 'string' ? power.sentence : null,
    presence: Array.isArray(power.presence) ? power.presence : [],
  };
}

export function terminalAction(action: ActionSummary): boolean {
  return action.state === 'done' || action.state === 'failed' || action.state === 'cancelled';
}

// Match the supervisor's bounded action output.
const OUTPUT_LINES = 200;
const LINE_LENGTH = 4096;
const boundedLines = (lines: unknown[]): string[] => lines
  .filter((line): line is string => typeof line === 'string')
  .slice(-OUTPUT_LINES).map((line) => line.slice(0, LINE_LENGTH));

function publishActions(): void {
  const records = [...actionMemory.values()];
  const running = records.flatMap((record) => record.detail && !terminalAction(record.detail) ? [record.detail] : [])
    .sort((a, b) => b.startedAt - a.startedAt);
  const completed = records.flatMap((record) => record.detail && terminalAction(record.detail) && !record.dismissed ? [record.detail] : [])
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  const candidates = running.length ? running : completed;
  const latest = candidates[0];
  const selected = candidates.find((action) => action.id === snapshot.action?.id);
  const time = (action: ActionDetail) => running.length ? action.startedAt : (action.endedAt ?? action.startedAt);
  // Equal timestamps do not displace the action already selected.
  const current = selected && latest && time(selected) === time(latest) ? selected : latest;
  publish({
    ...snapshot,
    action: current ?? null,
    result: current?.result ?? null,
    lines: current?.lines ?? [],
    completed,
  });
}

function trackAction(actionId: string): ActionRecord {
  let record = actionMemory.get(actionId);
  if (!record) {
    record = { detail: null, request: 0, pending: 0, dirty: true, final: false, dismissed: false };
    actionMemory.set(actionId, record);
  }
  return record;
}

/** Events name records to read; their state and output never enter the cache. */
function refetchAction(actionId: string, terminal = false): void {
  const record = trackAction(actionId);
  // New hints invalidate pending data and share one follow-up read.
  record.request += 1;
  record.dirty = true;
  record.final = false;
  if (!document.hidden) void readAction(actionId, terminal);
}

function pollActions(): void {
  if (!identified() || document.hidden) return;
  for (const [id, record] of actionMemory) {
    if (record.dirty || !record.final) void readAction(id);
  }
}

/** Recovery invalidates every pending read, including records still cached as running. */
function recover(): void {
  if (signedOut()) return;
  statusRequest += 1;
  statusDirty = true;
  inFlight = null;
  for (const [id, record] of actionMemory) {
    record.request += 1;
    if (record.dismissed) continue;
    record.dirty = true;
    record.final = false;
    if (!document.hidden) void readAction(id, true);
  }
  if (!document.hidden) void load().finally(schedule);
}

function applyPower(power: PowerStatus): void {
  const wasUnavailable = snapshot.loaded && snapshot.unavailable;
  publish({ ...snapshot, ...fromPower(power) });
  if (snapshot.status?.running) trackAction(snapshot.status.running.id);
  if (wasUnavailable && !snapshot.unavailable) recover();
  pollActions();
}

/**
 * A power response, read through the same sign-in classifier as every other API call: a device
 * the server doesn't know goes back to pairing, an ended Access session asks to sign in again,
 * and on the desktop main decides. Sign-in trouble or a retired generation throws.
 */
async function readAuthenticated(res: Response, generation: number, invalidIdentity?: () => void): Promise<unknown> {
  await checkAuthentication(res, generation, !!invalidIdentity);
  const data: unknown = await res.json().catch(() => {
    if (invalidIdentity && res.ok) {
      checkAuthenticationGeneration(generation);
      invalidIdentity();
      throw new ApiError('Invalid identity response.', 'network');
    }
    return {};
  });
  checkAuthenticationGeneration(generation);
  return data;
}

/** A stale answer, read to the end and dropped: an unread body stays held open in the browser. */
async function discard(res: Response): Promise<void> {
  await res.arrayBuffer().catch(() => {});
}

function stopPolling(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

function schedule(): void {
  stopPolling();
  if (watchers === 0 || document.hidden || signedOut()) return;
  const delay = snapshot.action && !terminalAction(snapshot.action) ? POLL_ACTIVE_MS : POLL_MS;
  timer = setTimeout(() => {
    if (document.hidden) stopPolling();
    else void load().finally(schedule);
  }, delay);
}

function onVisibilityChange(): void {
  if (document.hidden) stopPolling();
  else recover();
}

/** One request for the whole app: the sidebar block and the status page share the answer. */
export async function load(): Promise<void> {
  if (signedOut()) return;
  if (inFlight) return inFlight;
  const session = sessionGeneration;
  const request = ++statusRequest;
  statusDirty = false;
  const task = (async () => {
    let generation: number | undefined;
    let identityPending = false;
    try {
      generation = beginAuthenticatedRequest();
      if (!identified()) {
        identityPending = true;
        const res = await fetch('/api/me', {
          headers: { [REQUEST_MARKER_HEADER]: '1' }, credentials: 'same-origin', cache: 'no-store', redirect: 'manual',
        });
        identityPending = false;
        if (session !== sessionGeneration) return discard(res);
        const data = (await readAuthenticated(res, generation, () => {
          if (session === sessionGeneration && request === statusRequest) reportAuthenticationAnomaly(generation!);
        })) as MeResponse & { error?: string };
        if (session !== sessionGeneration || request !== statusRequest) return;
        if (!res.ok || !validDevice(data?.device)) {
          if (res.ok) reportAuthenticationAnomaly(generation);
          publish({ ...NO_ANSWER, loaded: true });
          return;
        }
        setState((s) => ({ ...s, device: data.device }));
        return load();
      }
      const res = await fetch('/api/power', {
        headers: { [REQUEST_MARKER_HEADER]: '1' },
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'manual',
      });
      if (session !== sessionGeneration) return discard(res);
      const data = (await readAuthenticated(res, generation)) as PowerStatus & { error?: string };
      if (session !== sessionGeneration || request !== statusRequest) return;
      if (!res.ok || typeof data.running !== 'boolean') {
        // A refusal (403: this browser isn't a paired device) or a server that
        // can't answer: no controls, and no old snapshot pretending to be current.
        publish({ ...snapshot, status: null, unavailable: true, loaded: true, presence: [], sentence: res.ok ? null : (data.error ?? null) });
        return;
      }
      applyPower(data);
    } catch {
      if (identityPending && generation !== undefined && session === sessionGeneration && request === statusRequest) reportAuthenticationAnomaly(generation);
      if (session === sessionGeneration && request === statusRequest) {
        publish({ ...snapshot, status: null, unavailable: true, loaded: true, sentence: null, presence: [] });
      }
    } finally {
      if (session === sessionGeneration) pollActions();
    }
  })();
  inFlight = task;
  try { await task; }
  finally {
    if (inFlight === task) {
      inFlight = null;
      if (session === sessionGeneration && statusDirty && !document.hidden) void load().finally(schedule);
    }
  }
}

/** The server's power events (power_status, power_action, power_line), from the event socket. */
export function applyPowerEvent(event: ServerEvent): void {
  if (!identified()) return;
  if (event.type === 'power_status') {
    // Socket snapshots are hints too; only the newest HTTP read sets status.
    statusDirty = true;
    if (!document.hidden) void load().finally(schedule);
  } else if (event.type === 'power_action') {
    refetchAction(event.action.id, terminalAction(event.action));
    schedule();
  } else if (event.type === 'power_line') {
    refetchAction(event.actionId);
    schedule();
  }
}

/** Ask for a lifecycle action. A 202 with a token means this device still has to confirm it. */
export async function act(request: PowerRequest): Promise<ActResult> {
  if (!identified()) return { kind: 'error', message: 'Wait for this device to sign in.' };
  const current = powerActionGuard();
  if (!current()) return { kind: 'error', message: 'Status isn’t available. Try again when the supervisor is answering.' };
  const session = sessionGeneration;
  const changed = { kind: 'error', message: 'This device’s sign-in changed.' } as const;
  let res: Response;
  let data: {
    error?: string;
    message?: string;
    confirm?: unknown;
    summary?: unknown;
    action?: ActionSummary;
    running?: ActionSummary;
  };
  let generation: number | undefined;
  try {
    generation = beginAuthenticatedRequest();
    res = await fetch('/api/power/actions', {
      method: 'POST',
      headers: { [REQUEST_MARKER_HEADER]: '1', 'content-type': 'application/json' },
      body: JSON.stringify(request),
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'manual',
    });
    if (session !== sessionGeneration) {
      await discard(res);
      return changed;
    }
    data = (await readAuthenticated(res, generation)) as typeof data;
  } catch (error) {
    return { kind: 'error', message: error instanceof ApiError ? error.message : "Can't reach Wayroost. Check your connection." };
  }
  if (session !== sessionGeneration) return changed;
  if (res.status === 409) {
    if (data.running) refetchAction(data.running.id);
    return {
      kind: 'busy',
      message: data.message ?? 'Something else is being restarted or switched right now.',
      ...(data.running ? { running: data.running } : {}),
    };
  }
  if (!res.ok) return { kind: 'error', message: data.error ?? `Couldn’t do that (${res.status}).` };
  if (typeof data.confirm === 'string') {
    if (!current()) return { kind: 'error', message: 'Status changed. Ask for this action again.' };
    return { kind: 'confirm', confirm: { confirm: data.confirm, summary: typeof data.summary === 'string' ? data.summary : '' } };
  }
  if (data.action && typeof data.action.id === 'string') {
    refetchAction(data.action.id);
    void load();
    return { kind: 'queued', action: data.action };
  }
  return { kind: 'error', message: 'The server didn’t say what it started.' };
}

/** Lines an action has printed so far (GET /api/power/actions/:id), as many as the supervisor keeps. */
export async function actionLines(actionId: string): Promise<string[]> {
  return readAction(actionId);
}

async function readAction(actionId: string, terminal = false): Promise<string[]> {
  if (!identified()) return [];
  const record = trackAction(actionId);
  const pending = actionReads.get(actionId);
  // A terminal hint can overtake progress, with at most two reads per ID.
  if (pending && (!terminal || record.pending >= 2)) return pending;
  const session = sessionGeneration;
  const request = ++record.request;
  record.pending += 1;
  record.dirty = false;
  const task = (async () => {
    let generation: number | undefined;
    try {
      generation = beginAuthenticatedRequest();
      const res = await fetch(`/api/power/actions/${encodeURIComponent(actionId)}`, {
        headers: { [REQUEST_MARKER_HEADER]: '1' },
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'manual',
      });
      if (session !== sessionGeneration) {
        await discard(res);
        return [];
      }
      const data = (await readAuthenticated(res, generation)) as ActionDetail & { error?: string };
      if (session !== sessionGeneration) return [];
      if (record !== actionMemory.get(actionId) || request !== record.request) return actionMemory.get(actionId)?.detail?.lines ?? [];
      if (!res.ok) return [];
      const lines = Array.isArray(data.lines) ? boundedLines(data.lines) : [];
      if (data.id === actionId && (terminalAction(data) || ['queued', 'waiting-for-idle', 'running'].includes(data.state))) {
        const { result, ...detail } = data;
        record.detail = { ...detail, lines, ...(typeof result === 'string' ? { result } : {}) };
        record.final = terminalAction(data) && typeof result === 'string' && Array.isArray(data.lines);
        publishActions();
        schedule();
      }
      return lines;
    } catch {
      return [];
    }
  })();
  actionReads.set(actionId, task);
  try { return await task; }
  finally {
    record.pending -= 1;
    if (actionReads.get(actionId) === task) {
      actionReads.delete(actionId);
      if (session === sessionGeneration && record === actionMemory.get(actionId) && record.dirty && !document.hidden) void readAction(actionId);
    }
  }
}

function dismissAction(actionId: string): void {
  const record = actionMemory.get(actionId);
  if (!record?.detail || !terminalAction(record.detail)) return;
  record.dismissed = true;
  publishActions();
}

/** The latest snapshot without subscribing (tests, toasts). */
export function powerSnapshot(): SupervisorStatus | null {
  return snapshot.status;
}

/** Watch the power status; polls while at least one component is showing it. */
export function usePower(): Power {
  const [state, setState] = useState<Snapshot>(snapshot);

  useEffect(() => {
    const listener = () => setState(snapshot);
    listeners.add(listener);
    watchers += 1;
    if (watchers === 1) document.addEventListener('visibilitychange', onVisibilityChange);
    if (!snapshot.loaded && !document.hidden) void load().finally(schedule);
    else schedule();
    return () => {
      listeners.delete(listener);
      watchers -= 1;
      setState(snapshot);
      if (watchers === 0) {
        stopPolling();
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, []);

  const refresh = useCallback(() => {
    recover();
  }, []);

  return {
    status: state.status,
    unavailable: state.unavailable,
    loaded: state.loaded,
    sentence: state.sentence,
    presence: state.presence,
    action: state.action,
    result: state.result,
    lines: state.lines,
    completed: state.completed,
    refresh,
    act,
    actionGuard: powerActionGuard,
    dismiss: dismissAction,
  };
}

// ---- Plain words --------------------------------------

/** The chip on a Status & power card. */
export const STATE_CHIP: Record<ComponentState, { label: string; tone: 'ok' | 'need' | 'bad' }> = {
  up: { label: 'Running', tone: 'ok' },
  starting: { label: 'Starting', tone: 'need' },
  down: { label: 'Stopped', tone: 'bad' },
  held: { label: 'Held', tone: 'need' },
  failing: { label: 'Keeps failing', tone: 'bad' },
};

/** The colour of the sidebar's status block. */
export function overallTone(overall: SupervisorStatus['overall']): 'ok' | 'need' | 'bad' {
  return overall === 'ok' ? 'ok' : overall === 'attention' ? 'need' : 'bad';
}

export const UNAVAILABLE_LINE = 'Status isn’t available yet';

const ACTION_LABELS: Record<SupervisorVerb, string> = {
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
  hold: 'Hold',
  release: 'Release',
  'switch-model': 'Switch model',
  diagnostics: 'Run diagnostics',
};

/** What a button for that verb says. Labels say exactly what happens. */
export function actionLabel(verb: SupervisorVerb): string {
  return ACTION_LABELS[verb];
}

/** The one main button of a card: the first action the supervisor offered. */
export function mainAction(component: ComponentStatus): SupervisorVerb | null {
  return component.actions[0] ?? null;
}

/** Restart and Switch model can wait until nothing is mid-turn. */
export function offersTiming(verb: SupervisorVerb): boolean {
  return verb === 'restart' || verb === 'switch-model';
}

/** Profiles a model switch could pick: everything the live one isn't already. */
export function switchProfiles(component: ComponentStatus): NonNullable<ComponentStatus['model']>['profiles'] {
  const live = component.model?.live ?? null;
  return (component.model?.profiles ?? []).filter((p) => p.id !== live);
}

/** A short name for the running action, for the attention banner. */
export function runningLine(action: ActionSummary): string {
  const label = actionLabel(action.verb);
  if (action.state === 'queued') return `${label} queued…`;
  if (action.state === 'waiting-for-idle') return `${label}: waiting for a quiet moment…`;
  if (action.state === 'running') return `${label}…`;
  if (action.state === 'done') return `${label} finished.`;
  if (action.state === 'failed') return `${label} didn’t finish.`;
  return `${label} cancelled.`;
}

/**
 * The small second line of the status block: the model that's answering, and
 * whether the outside can reach the PC. Written from the snapshot, never invented.
 */
export function powerDetailLines(status: SupervisorStatus): string[] {
  const lines: string[] = [];
  const model = status.components.find((c) => c.id === 'main-model');
  const live = model?.model?.live;
  if (model && live) {
    const profile = model.model?.profiles.find((p) => p.id === live);
    lines.push(`Main model: ${profile?.name ?? live}`);
  } else if (model) {
    lines.push(`${model.name}: not answering`);
  }
  const remote = status.components.find((c) => c.id.includes('tunnel') || c.id.includes('relay'));
  if (remote) {
    const word = remote.state === 'up' ? 'on' : remote.state === 'starting' ? 'starting' : 'off';
    lines.push(`${remote.name}: ${word}`);
  }
  return lines;
}

/** What a "Not set up" row says on its chip: nothing to act on until the PC is configured. */
export const NOT_SET_UP_CHIP = 'Not set up';

/** Whether anything is mid-turn, as the supervisor last heard (what "When idle" waits on). */
export function busyLine(busy: SupervisorStatus['busy']): string | null {
  if (busy === 'idle') return 'Nothing is mid-turn right now.';
  if (busy === 'busy') return 'Something is mid-turn right now, so “When idle” waits.';
  if (busy === 'unknown') return 'Wayroost can’t tell whether anything is mid-turn, so “When idle” waits.';
  return null;
}
