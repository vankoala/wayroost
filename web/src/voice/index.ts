import { useEffect, useSyncExternalStore } from 'react';
import { VOICE_MAX_SECONDS, type TimelineItem, type VoiceStatus } from '../../../shared/protocol';
import { api, speakAudio } from '../api';
import { onVoiceEvent, sendVoiceAudio, sendVoiceControl, socketOpen } from '../events';
import { getState, onStoreChange, toast } from '../store';
import { audioContext, MicCapture, micSupported, Player } from './audio';
import { ReplyReader, type ReaderOutput } from './reader';

// Voice mode: hold the mic (or tap it) to speak a message, and hear the reply.
// What you say streams to Signalbox over the live socket and comes back as
// text for the message box; replies are read aloud by the speech service on
// your PC. One recording or one reading at a time, for one conversation.

export type VoicePhase = 'idle' | 'starting' | 'listening' | 'transcribing' | 'reading';

export interface VoiceUi {
  phase: VoicePhase;
  /** The conversation (store key) the mic or the reading belongs to. */
  key: string | null;
  /** Hold to talk, or tap to start and tap again to send. */
  mode: 'hold' | 'toggle';
  /** Microphone level, 0 to 1. */
  level: number;
  startedAt: number;
  /** Holding: letting go now throws the recording away. */
  cancelArmed: boolean;
  /** Reading: audio is playing (rather than waiting for the agent). */
  speaking: boolean;
  /** Reading one message (its Listen button): which one. */
  message: string | null;
}

const IDLE: VoiceUi = {
  phase: 'idle',
  key: null,
  mode: 'hold',
  level: 0,
  startedAt: 0,
  cancelArmed: false,
  speaking: false,
  message: null,
};

let ui: VoiceUi = IDLE;
const listeners = new Set<() => void>();

function set(patch: Partial<VoiceUi>): void {
  ui = { ...ui, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useVoiceUi(): VoiceUi {
  return useSyncExternalStore(subscribe, () => ui);
}

export function getVoiceUi(): VoiceUi {
  return ui;
}

/** The message in conversation `key` being read through its Listen button, if any. */
export function useReadingMessage(key: string): string | null {
  return useSyncExternalStore(subscribe, () => (ui.phase === 'reading' && ui.key === key ? ui.message : null));
}

// ---- Settings (this device only) ------------------------------------------------

export interface VoiceSettings {
  /** Send what you said straight away, instead of putting it in the message box. */
  autoSend: boolean;
  /** Read the reply aloud after you speak a message. */
  readReplies: boolean;
  /** Kokoro voice name; empty for the server's default. */
  voice: string;
  speed: number;
}

const SETTINGS_KEY = 'signalbox.voice';
const DEFAULT_SETTINGS: VoiceSettings = { autoSend: false, readReplies: true, voice: '', speed: 1 };
export const SPEEDS = [0.9, 1, 1.15, 1.3];

function loadSettings(): VoiceSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<VoiceSettings>;
    return {
      autoSend: typeof raw.autoSend === 'boolean' ? raw.autoSend : DEFAULT_SETTINGS.autoSend,
      readReplies: typeof raw.readReplies === 'boolean' ? raw.readReplies : DEFAULT_SETTINGS.readReplies,
      voice: typeof raw.voice === 'string' && /^[a-z]{2}_[a-z]{2,20}$/.test(raw.voice) ? raw.voice : '',
      speed: typeof raw.speed === 'number' && SPEEDS.includes(raw.speed) ? raw.speed : 1,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let settings = loadSettings();
const settingsListeners = new Set<() => void>();

export function setVoiceSettings(patch: Partial<VoiceSettings>): void {
  settings = { ...settings, ...patch };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private mode: settings last until the page closes.
  }
  for (const listener of settingsListeners) listener();
}

export function useVoiceSettings(): VoiceSettings {
  return useSyncExternalStore(
    (listener) => {
      settingsListeners.add(listener);
      return () => {
        settingsListeners.delete(listener);
      };
    },
    () => settings,
  );
}

export function getVoiceSettings(): VoiceSettings {
  return settings;
}

// ---- Is voice mode on? --------------------------------------------------------------

let status: VoiceStatus | null = null;
let checking = false;
let lastCheck = 0;
const statusListeners = new Set<() => void>();

function checkStatus(): void {
  if (checking || Date.now() - lastCheck < 60_000) return;
  checking = true;
  lastCheck = Date.now();
  api.voice().then(
    (next) => {
      status = next;
      checking = false;
      for (const listener of statusListeners) listener();
    },
    () => {
      checking = false;
    },
  );
}

/** Settings → Voice saved a new shared voice: use it here at once (other devices pick it up on
 *  their next check, and the server reads in it whenever a device names no voice). */
export function setVoiceStatus(next: VoiceStatus): void {
  status = next;
  lastCheck = Date.now();
  for (const listener of statusListeners) listener();
}

/** Voice mode's server side: null until known. Rechecked now and then while it's unavailable. */
export function useVoiceStatus(): VoiceStatus | null {
  const value = useSyncExternalStore(
    (listener) => {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    () => status,
  );
  useEffect(() => {
    if (!status || (status.enabled && !status.available)) checkStatus();
  });
  return value;
}

/** The mic can be offered: voice mode is on, the speech service answers, and this browser can record. */
export function canSpeak(value: VoiceStatus | null): boolean {
  return Boolean(value?.enabled && value.available && micSupported());
}

/** Replies can be read aloud here. */
export function canListen(value: VoiceStatus | null): boolean {
  return Boolean(value?.enabled && value.available && typeof AudioContext === 'function');
}

// ---- Recording ---------------------------------------------------------------------

let run = 0;
let capture: MicCapture | null = null;
let stopWhenStarted = false;
let deliver: ((text: string) => void) | null = null;
let waitingFor = 0;
let maxTimer: ReturnType<typeof setTimeout> | undefined;
let replyTimer: ReturnType<typeof setTimeout> | undefined;

const recording = () => ui.phase === 'starting' || ui.phase === 'listening' || ui.phase === 'transcribing';

function micProblem(err: unknown): string {
  switch ((err as { name?: string } | null)?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'The microphone is blocked. Allow it for this site in your browser settings.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone found.';
    case 'NotReadableError':
      return 'The microphone is busy in another app.';
    default:
      return "Couldn't start the microphone.";
  }
}

function reset(): void {
  clearTimeout(maxTimer);
  clearTimeout(replyTimer);
  capture?.release();
  capture = null;
  stopWhenStarted = false;
  deliver = null;
  waitingFor = 0;
}

function fail(message: string): void {
  if (recording()) sendVoiceControl({ type: 'voice_cancel', run });
  reset();
  set(IDLE);
  toast(message);
}

onVoiceEvent((event) => {
  if (event.type === 'socket_closed') {
    if (recording()) fail('The connection dropped. Try again.');
    return;
  }
  if (!recording() || event.run !== run || event.stage === 'stt-start') return;
  if (event.stage === 'error') {
    fail(event.message);
    return;
  }
  if (event.run !== waitingFor) return;
  const give = deliver;
  reset();
  set(IDLE);
  const text = event.text.trim();
  if (!text) toast("Didn't catch that. Try again.", 'info');
  else give?.(text);
});

/**
 * Start recording a message for conversation `key`. Call it straight from the
 * press or tap: browsers only allow audio that a gesture started. `onText` gets
 * what you said once it's written down.
 */
export function startListening(key: string, mode: VoiceUi['mode'], onText: (text: string) => void): void {
  if (recording()) return;
  stopReading();
  const ctx = audioContext();
  if (!socketOpen()) {
    toast('Not connected to Signalbox yet. Try again in a moment.');
    return;
  }
  reset();
  run = (run % 255) + 1;
  const id = run;
  deliver = onText;
  set({ phase: 'starting', key, mode, level: 0, startedAt: Date.now(), cancelArmed: false, speaking: false });
  sendVoiceControl({ type: 'voice_start', run: id });
  const mic = new MicCapture();
  capture = mic;
  mic
    .start(
      ctx,
      (pcm) => {
        if (run === id && capture === mic) sendVoiceAudio(id, pcm);
      },
      (level) => {
        if (capture === mic && ui.phase === 'listening') set({ level: Math.min(1, level * 5) });
      },
    )
    .then(
      () => {
        if (capture !== mic) {
          mic.release(); // cancelled while the mic was starting
          return;
        }
        set({ phase: 'listening', startedAt: Date.now() });
        maxTimer = setTimeout(finishListening, (VOICE_MAX_SECONDS - 2) * 1000);
        if (stopWhenStarted) finishListening();
      },
      (err: unknown) => {
        mic.release();
        if (capture === mic) fail(micProblem(err));
      },
    );
}

/** Let go (or tap again): send what was recorded to be written down. */
export function finishListening(): void {
  if (ui.phase === 'starting') {
    stopWhenStarted = true;
    return;
  }
  if (ui.phase !== 'listening' || !capture) return;
  if (ui.cancelArmed) {
    cancelListening();
    return;
  }
  clearTimeout(maxTimer);
  const mic = capture;
  const id = run;
  set({ phase: 'transcribing', level: 0 });
  void mic.stop().then(() => {
    if (capture !== mic || ui.phase !== 'transcribing') return;
    capture = null;
    if (!sendVoiceAudio(id)) {
      fail('The connection dropped. Try again.');
      return;
    }
    waitingFor = id;
    // Longer than the server's own 30 s limit, so its error arrives first.
    replyTimer = setTimeout(() => fail("Didn't hear back in time. Try again."), 35_000);
  });
}

/** Throw the recording away. */
export function cancelListening(): void {
  if (recording()) sendVoiceControl({ type: 'voice_cancel', run });
  reset();
  if (recording()) set(IDLE);
}

/** A quick tap started the recording: keep going until the next tap. */
export function setListeningMode(mode: VoiceUi['mode']): void {
  if ((ui.phase === 'starting' || ui.phase === 'listening') && ui.mode !== mode) set({ mode });
}

/** Holding the mic and sliding away: letting go will cancel. */
export function armCancel(armed: boolean): void {
  if ((ui.phase === 'listening' || ui.phase === 'starting') && ui.cancelArmed !== armed) set({ cancelArmed: armed });
}

// ---- Reading aloud ----------------------------------------------------------------

const player = new Player();
player.onChange = () => {
  if (ui.phase === 'reading' && ui.speaking !== player.pending() > 0) set({ speaking: player.pending() > 0 });
};

const output: ReaderOutput = {
  // The voice is the shared one (Settings → Voice applies everywhere): the server picks it.
  speak: (text) => speakAudio(text, undefined, settings.speed),
  play: (audio) => player.play(audio),
  pending: () => player.pending(),
  changed: () => player.changed(),
};

let reader: ReplyReader | null = null;
let unfollow: (() => void) | null = null;
let safety: ReturnType<typeof setTimeout> | undefined;

function startReader(key: string, message: string | null = null): ReplyReader {
  stopReading();
  const current = new ReplyReader(output, (error) => {
    if (reader !== current) return;
    stopReading();
    if (error) toast(error);
  });
  reader = current;
  set({ phase: 'reading', key, speaking: false, level: 0, cancelArmed: false, message });
  // Nobody wants a reader waiting forever on an agent that went quiet.
  safety = setTimeout(stopReading, 20 * 60_000);
  return current;
}

/**
 * Read the agent's reply in conversation `key` aloud as it arrives, until the
 * turn is over. Call right after sending a spoken message, with the items the
 * conversation had before it went (those are never read).
 */
export function readReplies(key: string, before: readonly TimelineItem[] = []): void {
  if (recording()) return;
  audioContext();
  const current = startReader(key);
  current.skip(before);
  const feed = () => {
    const state = getState();
    const detail = state.details[key];
    if (!detail || detail.status !== 'ready') return;
    const working = ['running', 'needs_approval'].includes(state.conversations[key]?.status ?? '');
    current.update(detail.items, working);
  };
  unfollow = onStoreChange(feed);
  feed();
}

/** Read one message aloud (its Listen button); `id` names it while it's read. */
export function readMessage(key: string, text: string, id = 'listen'): void {
  if (recording()) return;
  audioContext();
  startReader(key, id).update([{ kind: 'assistant', id, text }], false);
}

export function stopReading(): void {
  clearTimeout(safety);
  unfollow?.();
  unfollow = null;
  reader?.stop();
  reader = null;
  player.stop();
  if (ui.phase === 'reading') set(IDLE);
}

/** The conversation's page is going away: stop anything voice is doing for it. */
export function leaveConversation(key: string): void {
  if (ui.key !== key) return;
  if (recording()) cancelListening();
  stopReading();
}
