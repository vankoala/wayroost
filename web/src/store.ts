import { useSyncExternalStore } from 'react';
import type { Rollout } from '../../shared/rollout.js';
import type {
  Approval,
  DeviceInfo,
  FeedCard,
  AttachmentRef,
  CommandResult,
  ConversationSummary,
  ServerEvent,
  Source,
  SourceStatus,
  TimelineItem,
} from '../../shared/protocol';
import { moveDraft } from './drafts';
import { movePreviews } from './previews';
import { conversationPath, navigate, parseChatsFilter, parseRoute } from './router';

declare global {
  interface Window {
    wayroostTray?: { update(event: unknown): void; anomaly?(): void; socketClosed?(code: number): void;
      beginSpeech?(): Promise<string | undefined>; cancelSpeech?(id: string): Promise<boolean>; endSpeech?(id: string): void;
      onAuthentication?(listener: (state: 'verified' | 'unverified' | 'unpaired') => void): void };
  }
}

// A tiny global store (no dependencies). Selectors must return existing
// references — derive sorted/filtered lists with useMemo in components.

export const convKey = (source: Source, id: string) => `${source}:${id}`;
export const approvalKey = (a: Pick<Approval, 'source' | 'conversationId' | 'id'>) =>
  `${a.source}:${a.conversationId}:${a.id}`;

export interface DetailState {
  needsOpen?: boolean;
  status: 'loading' | 'ready' | 'error';
  items: TimelineItem[];
  error?: string;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'error' | 'info';
}

export type SocketState = 'connecting' | 'open' | 'closed';

/** An image open in the full-screen viewer. */
export interface ViewerImage {
  /** The signed link it came from. */
  src: string;
  /** Its blob: URL. */
  url: string;
  name: string;
}

export interface AppState {
  rollout?: import('../../shared/rollout.js').Rollout;
  /** Bumped when Hermes' scheduled jobs change, so an open Scheduled-jobs page refetches. */
  schedulesVersion: number;
  /** For you: cards to show (new and seen), by id; null until loaded or when it's turned off. */
  feed: Record<string, FeedCard> | null;
  /** Bumped when a skill folder changes, so an open Skills page refetches. */
  skillsVersion: number;
  /** Bumped when a settings change lands (applied, undone or failed), so open settings pages refetch. */
  settingsVersion: number;
  /** Bumped when model usage moves on, so usage pills read their summary again. */
  usageVersion: number;
  /** The Cloudflare Access identity, when the app is reached through Access. */
  email?: string;
  /** This browser's paired device, from /api/me or the socket greeting. */
  device?: DeviceInfo;
  sessionExpired: boolean;
  /** This browser isn't a paired device (or was revoked): only the pairing page can help. */
  unpaired: boolean;
  socket: SocketState;
  statuses: Record<Source, SourceStatus>;
  listLoaded: boolean;
  conversations: Record<string, ConversationSummary>;
  approvals: Record<string, Approval>;
  details: Record<string, DetailState>;
  /** Text to put in a conversation's message box (e.g. after /undo), by conversation key. */
  prefills: Record<string, string>;
  viewer: ViewerImage | null;
  toasts: Toast[];
}

const initialState: AppState = {
  sessionExpired: false,
  unpaired: false,
  schedulesVersion: 0,
  feed: null,
  skillsVersion: 0,
  settingsVersion: 0,
  usageVersion: 0,
  socket: 'connecting',
  statuses: {
    hermes: { source: 'hermes', state: 'connecting' },
    paseo: { source: 'paseo', state: 'connecting' },
  },
  listLoaded: false,
  conversations: {},
  approvals: {},
  details: {},
  prefills: {},
  viewer: null,
  toasts: [],
};

let state = initialState;
let authenticationGeneration = 0;
const rolloutGenerations: Record<keyof Rollout, number> = { settingsPages: 0, revokes: 0, chatFirst: 0 };
let nativeAuthentication = false;
let applyingNativeAuthentication = false;
const listeners = new Set<() => void>();

export function getAuthenticationGeneration(): number { return authenticationGeneration; }
export function authenticationBlocked(): boolean { return state.unpaired || state.sessionExpired; }

export function getRolloutGeneration(key: keyof Rollout): number { return rolloutGenerations[key]; }

/** A closed rollout cannot resume work captured before it, even after reopening. */
export function captureRollout(...keys: (keyof Rollout)[]): { still(): boolean } {
  const captured = keys.map(key => [key, getRolloutGeneration(key)] as const);
  return { still: () => captured.every(([key, generation]) => state.rollout?.[key] === true && getRolloutGeneration(key) === generation) };
}

export function getState(): AppState {
  return state;
}

export function setState(update: (s: AppState) => AppState): void {
  const next = update(state);
  if (nativeAuthentication && !applyingNativeAuthentication && (next.unpaired !== state.unpaired || next.sessionExpired !== state.sessionExpired)) return;
  if (next === state) return;
  const authenticationChanged = next.unpaired !== state.unpaired || next.sessionExpired !== state.sessionExpired;
  // Late requests, socket events and UI callbacks cannot repopulate a suspended generation.
  if (authenticationBlocked() && !authenticationChanged) return;
  if (authenticationChanged) authenticationGeneration += 1;
  for (const key of Object.keys(rolloutGenerations) as (keyof Rollout)[]) {
    if (state.rollout?.[key] === true && next.rollout?.[key] !== true) rolloutGenerations[key] += 1;
  }
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called after every state change (outside React). Returns the unsubscribe function. */
export function onStoreChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

// ---- Toasts ----------------------------------------------------------------

function suspendAuthentication(): boolean {
  if (state.sessionExpired || state.unpaired) return false;
  pendingDeltas.clear(); early.clear(); moves.clear();
  setState((s) => ({ ...initialState, socket: s.socket, sessionExpired: true }));
  return true;
}

/** The sign-in died (an expired Access cookie): show "sign in again" once. */
export function markSignedOut(): void {
  if (nativeAuthentication) { window.wayroostTray?.anomaly?.(); return; }
  suspendAuthentication();
}

/**
 * The server doesn't know this browser as a paired device (never paired, or
 * revoked): only the pairing page can help. Everything this device had loaded
 * (chats, approvals, cards) goes with it.
 */
export function markUnpaired(): void {
  if (nativeAuthentication) { window.wayroostTray?.anomaly?.(); return; }
  if (state.unpaired) return;
  pendingDeltas.clear(); early.clear(); moves.clear();
  setState((s) => (s.unpaired ? s : { ...initialState, socket: s.socket, unpaired: true }));
}

let toastSeq = 0;
export function toast(text: string, tone: Toast['tone'] = 'error'): void {
  if (authenticationBlocked()) return;
  const id = ++toastSeq;
  setState((s) => ({ ...s, toasts: [...s.toasts.slice(-2), { id, text, tone }] }));
  setTimeout(() => setState((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) })), 4500);
}

export function openViewer(image: ViewerImage): void {
  setState((s) => ({ ...s, viewer: image }));
}

export function closeViewer(): void {
  setState((s) => (s.viewer ? { ...s, viewer: null } : s));
}

// ---- Timeline helpers ------------------------------------------------------

export const PENDING_PREFIX = 'pending-';
let pendingSeq = 0;

function addPendingItem(key: string, make: (id: string) => TimelineItem): string {
  const id = `${PENDING_PREFIX}${++pendingSeq}`;
  setState((s) => {
    const detail = s.details[key];
    if (!detail) return s;
    return { ...s, details: { ...s.details, [key]: { ...detail, items: [...detail.items, make(id)] } } };
  });
  return id;
}

/** Show a sent message immediately; the server's copy replaces it when it arrives. */
export function addPendingUserMessage(key: string, text: string, attachments: AttachmentRef[] = []): string {
  return addPendingItem(key, (id) => ({
    kind: 'user',
    id,
    text,
    at: Date.now(),
    ...(attachments.length ? { attachments } : {}),
  }));
}

/** A "Running /status…" row until the server answers. */
export function addPendingCommand(key: string, command: string): string {
  return addPendingItem(key, (id) => ({ kind: 'command', id, command, output: '', running: true, at: Date.now() }));
}

export function removeItem(key: string, id: string): void {
  setState((s) => {
    const detail = s.details[key];
    if (!detail) return s;
    return { ...s, details: { ...s.details, [key]: { ...detail, items: detail.items.filter((i) => i.id !== id) } } };
  });
}

const commandName = (text: string) => (text.trim().split(/\s/, 1)[0] ?? '').replace(/^\//, '').toLowerCase();
const fileNames = (files: AttachmentRef[] = []) => files.map((f) => f.name).join('\n');

/** Does `item`, just arrived from the server, stand in for the optimistic `pending` one? */
function confirms(item: TimelineItem, pending: TimelineItem): boolean {
  if (pending.kind === 'user' && item.kind === 'user') {
    const sameText = item.text.trim() === pending.text.trim();
    const sent = pending.attachments ?? [];
    if (!sent.length) return sameText;
    const got = item.attachments ?? [];
    if (got.length === sent.length && fileNames(got) === fileNames(sent)) return true;
    // Same text, with the files renamed by the server or not listed.
    return sameText && (got.length === sent.length || got.length === 0);
  }
  if (pending.kind === 'command') {
    // Its output, or the message a skill sent ("/plan fix login").
    const name = commandName(pending.command);
    if (item.kind === 'command') return commandName(item.command) === name;
    return item.kind === 'user' && item.text.trimStart().startsWith('/') && commandName(item.text) === name;
  }
  return false;
}

function upsertItems(items: TimelineItem[], incoming: TimelineItem[]): TimelineItem[] {
  // Each new message or command output replaces its optimistic stand-in (oldest first).
  if (incoming.some((i) => i.kind === 'user' || i.kind === 'command')) {
    const known = new Set(items.map((i) => i.id));
    for (const item of incoming) {
      if (known.has(item.id) || (item.kind !== 'user' && item.kind !== 'command')) continue;
      const stand = items.findIndex((i) => i.id.startsWith(PENDING_PREFIX) && confirms(item, i));
      if (stand !== -1) items = items.filter((_, at) => at !== stand);
    }
  }
  const next = items.slice();
  const index = new Map(next.map((item, i) => [item.id, i]));
  for (const item of incoming) {
    const at = index.get(item.id);
    if (at === undefined) {
      index.set(item.id, next.length);
      next.push(item);
    } else {
      next[at] = item;
    }
  }
  return next;
}

function appendText(items: TimelineItem[], itemId: string, delta: string): TimelineItem[] {
  const at = items.findIndex((item) => item.id === itemId);
  if (at === -1) {
    return [...items, { kind: 'assistant', id: itemId, text: delta, streaming: true }];
  }
  const item = items[at]!;
  const next = items.slice();
  switch (item.kind) {
    case 'assistant':
    case 'reasoning':
      next[at] = { ...item, text: item.text + delta, streaming: true };
      return next;
    case 'tool':
      next[at] = { ...item, output: (item.output ?? '') + delta };
      return next;
    case 'command':
      next[at] = { ...item, output: item.output + delta };
      return next;
    case 'user':
    case 'notice':
      return items;
  }
}

// Streaming deltas arrive many times per second; apply them once per frame.
const pendingDeltas = new Map<string, { conv: string; itemId: string; text: string }>();
let frameRequested = false;

function flushDeltas() {
  frameRequested = false;
  if (pendingDeltas.size === 0) return;
  const batch = [...pendingDeltas.values()];
  pendingDeltas.clear();
  setState((s) => {
    const details = { ...s.details };
    for (const { conv, itemId, text } of batch) {
      const detail = details[conv];
      if (!detail || detail.status !== 'ready') continue;
      details[conv] = { ...detail, items: appendText(detail.items, itemId, text) };
    }
    return { ...s, details };
  });
}

function queueDelta(conv: string, itemId: string, text: string) {
  const key = `${conv}\u0000${itemId}`;
  const existing = pendingDeltas.get(key);
  if (existing) existing.text += text;
  else pendingDeltas.set(key, { conv, itemId, text });
  if (!frameRequested) {
    frameRequested = true;
    if (typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible') {
      requestAnimationFrame(flushDeltas);
    } else {
      setTimeout(flushDeltas, 50);
    }
  }
}

// ---- Command results -------------------------------------------------------

// Conversations that continue under a new id: "source:from" → to.
const moves = new Map<string, string>();

/** A conversation's id now; it moves when Hermes compresses its context. */
export function currentId(source: Source, id: string): string {
  for (let hops = 0; hops < 10; hops++) {
    const to = moves.get(convKey(source, id));
    if (!to) break;
    id = to;
  }
  return id;
}

// Items for timelines that weren't loaded yet when they arrived.
const early = new Map<string, TimelineItem[]>();

/** Add items the server answered a request with (e.g. "/" command output) to a conversation. */
export function upsertConversationItems(source: Source, id: string, items: TimelineItem[]): void {
  if (authenticationBlocked()) return;
  if (!items.length) return;
  const conversationId = currentId(source, id);
  const key = convKey(source, conversationId);
  if (state.details[key]?.status === 'ready') {
    applyEvent({ type: 'items_upsert', source, conversationId, items });
  } else {
    early.set(key, [...(early.get(key) ?? []), ...items]);
  }
}

/** A freshly loaded timeline plus any early items it doesn't have (the server's copy wins). */
export function withEarlyItems(key: string, items: TimelineItem[]): TimelineItem[] {
  const extra = early.get(key);
  if (!extra) return items;
  early.delete(key);
  const ids = new Set(items.map((i) => i.id));
  return upsertItems(items, extra.filter((i) => !ids.has(i.id)));
}

export function setPrefill(source: Source, id: string, text: string): void {
  const key = convKey(source, currentId(source, id));
  setState((s) => ({ ...s, prefills: { ...s.prefills, [key]: text } }));
}

export function clearPrefill(key: string): void {
  setState((s) => {
    if (!(key in s.prefills)) return s;
    const prefills = { ...s.prefills };
    delete prefills[key];
    return { ...s, prefills };
  });
}

/** Show what a "/" command produced, and put back any text it returned. */
export function applyCommandResult(source: Source, id: string, result: CommandResult): void {
  upsertConversationItems(source, id, result.items);
  if (result.prefill) setPrefill(source, id, result.prefill);
}

function moveConversation(source: Source, fromId: string, toId: string): void {
  const from = convKey(source, fromId);
  const to = convKey(source, toId);
  moves.set(from, toId);
  moveDraft(from, to);
  movePreviews(from, to);
  const waiting = early.get(from);
  if (waiting) {
    early.delete(from);
    early.set(to, [...(early.get(to) ?? []), ...waiting]);
  }
  setState((s) => {
    const prefills = { ...s.prefills };
    if (from in prefills) {
      prefills[to] ??= prefills[from]!;
      delete prefills[from];
    }
    // Optimistic items belong to the old id; the server's copies turn up under the new one.
    const detail = s.details[from];
    const details = detail
      ? { ...s.details, [from]: { ...detail, items: detail.items.filter((i) => !i.id.startsWith(PENDING_PREFIX)) } }
      : s.details;
    return { ...s, prefills, details };
  });
  // Follow it without leaving the dead id in history.
  const route = parseRoute(location.pathname);
  if (route.name === 'conversation' && route.source === source && route.id === fromId) {
    navigate(conversationPath(source, toId, parseChatsFilter(location.pathname + location.search)), { replace: true });
  }
}

// ---- Server events ---------------------------------------------------------

export function applyEvent(event: ServerEvent): void {
  if (authenticationBlocked()) return;
  switch (event.type) {
    case 'hello':
      setState((s) => ({
        ...s,
        ...(event.email ? { email: event.email } : {}),
        device: event.device,
        statuses: Object.fromEntries(event.statuses.map((st) => [st.source, st])) as AppState['statuses'],
      }));
      return;
    case 'source_status':
      setState((s) => ({ ...s, statuses: { ...s.statuses, [event.status.source]: event.status } }));
      return;
    case 'schedules_changed':
      setState((s) => ({ ...s, schedulesVersion: s.schedulesVersion + 1 }));
      return;
    case 'feed_upsert':
      setState((s) => {
        if (!s.feed) return s;
        const feed = { ...s.feed };
        const { card } = event;
        if (card.status === 'new' || card.status === 'seen') feed[card.id] = card;
        else delete feed[card.id];
        return { ...s, feed };
      });
      return;
    case 'feed_removed':
      setState((s) => {
        if (!s.feed || !(event.id in s.feed)) return s;
        const feed = { ...s.feed };
        delete feed[event.id];
        return { ...s, feed };
      });
      return;
    case 'skills_changed':
      setState((s) => ({ ...s, skillsVersion: s.skillsVersion + 1 }));
      return;
    case 'conversation_upsert': {
      const key = convKey(event.conversation.source, event.conversation.id);
      setState((s) => ({ ...s, conversations: { ...s.conversations, [key]: event.conversation } }));
      return;
    }
    case 'conversation_removed': {
      const key = convKey(event.source, event.id);
      setState((s) => {
        if (!(key in s.conversations)) return s;
        const conversations = { ...s.conversations };
        delete conversations[key];
        return { ...s, conversations };
      });
      return;
    }
    case 'conversation_moved':
      moveConversation(event.source, event.from, event.to);
      return;
    case 'notification': {
      // An agent waiting on an answer must reach the open app on every paired device.
      const { title, body } = event.notification;
      if (state.device && (state.device.kind === 'desktop' || event.notification.event === 'agent-needs-you')) toast(body ? `${title} · ${body}` : title, 'info');
      return;
    }
    case 'items_upsert': {
      flushDeltas(); // keep ordering: pending text lands before replacements
      const key = convKey(event.source, event.conversationId);
      setState((s) => {
        const detail = s.details[key];
        if (!detail || detail.status !== 'ready') return s;
        return { ...s, details: { ...s.details, [key]: { ...detail, items: upsertItems(detail.items, event.items) } } };
      });
      return;
    }
    case 'items_replace': {
      pendingDeltas.clear();
      const key = convKey(event.source, event.conversationId);
      setState((s) => {
        const detail = s.details[key];
        if (!detail) return s;
        return { ...s, details: { ...s.details, [key]: { ...detail, status: 'ready', items: event.items } } };
      });
      return;
    }
    case 'text_delta':
      queueDelta(convKey(event.source, event.conversationId), event.itemId, event.delta);
      return;
    case 'approval_upsert':
      setState((s) => ({ ...s, approvals: { ...s.approvals, [approvalKey(event.approval)]: event.approval } }));
      return;
    case 'approval_removed': {
      const key = approvalKey({ source: event.source, conversationId: event.conversationId, id: event.approvalId });
      setState((s) => {
        if (!(key in s.approvals)) return s;
        const approvals = { ...s.approvals };
        delete approvals[key];
        return { ...s, approvals };
      });
      return;
    }
    case 'settings_changed':
      setState((s) => ({ ...s, settingsVersion: s.settingsVersion + 1 }));
      return;
    case 'usage_changed':
      setState((s) => ({ ...s, usageVersion: s.usageVersion + 1 }));
      return;
    case 'voice': // handled by the voice module (events.ts routes it there)
    case 'pong':
      return;
  }
}

if (typeof window !== 'undefined' && window.wayroostTray?.onAuthentication) {
  nativeAuthentication = true;
  window.wayroostTray.onAuthentication((authentication) => {
    const unpaired = authentication === 'unpaired';
    const sessionExpired = authentication === 'unverified';
    if (state.unpaired === unpaired && state.sessionExpired === sessionExpired) return;
    pendingDeltas.clear(); early.clear(); moves.clear();
    applyingNativeAuthentication = true;
    try { setState(() => ({ ...initialState, unpaired, sessionExpired })); }
    finally { applyingNativeAuthentication = false; }
  });
}
