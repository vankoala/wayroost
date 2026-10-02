import { WS_CLOSE_REAUTH, WS_CLOSE_SESSION_EXPIRED, type ServerEvent, type Source, type VoiceEvent } from '../../shared/protocol';
import { loadConversation, loadFeed, refreshList } from './api';
import { applyEvent, setState } from './store';

// One WebSocket for live updates. It reconnects with backoff, resyncs the
// inbox and the open conversation after every reconnect (events may have been
// missed), and reconnects immediately when the phone brings the tab back.

const PING_MS = 25_000; // under Cloudflare's 100s idle timeout
const MAX_BACKOFF_MS = 15_000;

let socket: WebSocket | null = null;
let attempts = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let watching: { source: Source; id: string } | null = null;
let stopped = false;
let voiceListener: ((event: VoiceEvent | { type: 'socket_closed' }) => void) | null = null;

function send(message: object) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

// ---- Voice mode: audio goes up this same socket --------------------------------

/** Voice events for this page (and a note when the socket drops mid-recording). */
export function onVoiceEvent(listener: typeof voiceListener): void {
  voiceListener = listener;
}

export function socketOpen(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}

export function sendVoiceControl(message: { type: 'voice_start' | 'voice_cancel'; run: number }): boolean {
  if (!socketOpen()) return false;
  socket!.send(JSON.stringify(message));
  return true;
}

/** A binary frame: the run number, then 16 kHz 16-bit PCM (or nothing, to end the run). */
export function sendVoiceAudio(run: number, pcm?: ArrayBuffer): boolean {
  if (!socketOpen()) return false;
  const frame = new Uint8Array(1 + (pcm?.byteLength ?? 0));
  frame[0] = run;
  if (pcm) frame.set(new Uint8Array(pcm), 1);
  socket!.send(frame);
  return true;
}

function scheduleReconnect() {
  if (stopped || retryTimer) return;
  const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempts) * (0.75 + Math.random() * 0.5);
  attempts += 1;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    connect();
  }, delay);
}

export function connect(): void {
  if (stopped || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  setState((s) => ({ ...s, socket: 'connecting' }));
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const ws = new WebSocket(url);
  socket = ws;

  ws.onopen = () => {
    attempts = 0;
    setState((s) => ({ ...s, socket: 'open' }));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: 'ping' }), PING_MS);
    if (watching) {
      send({ type: 'subscribe', source: watching.source, conversationId: watching.id });
      void loadConversation(watching.source, watching.id);
    }
    refreshList().catch(() => {});
    void loadFeed();
  };

  ws.onmessage = (message) => {
    try {
      const event = JSON.parse(String(message.data)) as ServerEvent;
      if (event.type === 'voice') voiceListener?.(event);
      else applyEvent(event);
    } catch {
      // Ignore malformed frames.
    }
  };

  ws.onclose = (event) => {
    if (socket !== ws) return;
    socket = null;
    voiceListener?.({ type: 'socket_closed' });
    clearInterval(pingTimer);
    setState((s) => ({ ...s, socket: 'closed' }));
    if (event.code === WS_CLOSE_SESSION_EXPIRED) {
      setState((s) => ({ ...s, sessionExpired: true }));
      return;
    }
    if (event.code === WS_CLOSE_REAUTH) {
      // Routine re-authentication: reconnect through Cloudflare Access right away.
      attempts = 0;
      connect();
      return;
    }
    scheduleReconnect();
  };
}

export function watchConversation(source: Source, id: string): void {
  if (watching && (watching.source !== source || watching.id !== id)) {
    send({ type: 'unsubscribe', source: watching.source, conversationId: watching.id });
  }
  watching = { source, id };
  send({ type: 'subscribe', source, conversationId: id });
}

export function unwatchConversation(source: Source, id: string): void {
  if (watching?.source === source && watching.id === id) {
    send({ type: 'unsubscribe', source, conversationId: id });
    watching = null;
  }
}

export function startEvents(): void {
  stopped = false;
  connect();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
      attempts = 0;
      connect();
    }
  });
  window.addEventListener('online', () => {
    attempts = 0;
    connect();
  });
}
