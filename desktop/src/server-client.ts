import type { Session } from 'electron';
import type { Approval, ConversationSummary, ListResponse, ServerEvent } from '../../shared/protocol.js';
import { AUTHENTICATION_TIMEOUT_MS, authenticationEndpoint, authenticationError, authenticationHttpFailure, readAuthenticationBody, socketAuthenticationLoss, type AuthenticationLoss } from '../../shared/authentication.js';
import type { Presence } from './presence.js';
import { approvalKey, onceOption, toastCanAllow } from './approvals.js';
import { APP_HEADER, APP_HEADER_VALUE } from './hardening.js';
import { isApprovalEvent, isApprovalSnapshot } from '../../shared/approval-validation.js';

const UNPAIRED_IDENTITY = Symbol('unpaired identity');
/** Socket reconnects back off from one to thirty seconds; a socket that opens resets them. */
const SOCKET_RETRY_MIN_MS = 1000;
const SOCKET_RETRY_MAX_MS = 30000;

/**
 * Electron's net.WebSocket reports a refused upgrade only as close code 1006 with Chromium's reason text, never
 * as a status: "Error during WebSocket handshake: Unexpected response code: 403 (net::ERR_FAILED)", and for 401
 * "HTTP Authentication failed; no valid credentials available (net::OK)". Undefined unless the reason is one of
 * those forms.
 */
export function handshakeStatus(event: { code: number; reason?: unknown }): number | undefined {
  if (event.code !== 1006 || typeof event.reason !== 'string') return undefined;
  const status = /^Error during WebSocket handshake: Unexpected response code: (\d{3}) \(net::[A-Z_]+\)$/.exec(event.reason)?.[1];
  if (status) return Number(status);
  return /^HTTP Authentication failed; no valid credentials available \(net::[A-Z_]+\)$/.test(event.reason) ? 401 : undefined;
}
/** Chromium's transport failures: the server is down, restarting or unreachable, not refusing this desktop. */
const NETWORK_FAILURES = new Set(['CONNECTION_REFUSED', 'CONNECTION_RESET', 'CONNECTION_CLOSED', 'CONNECTION_ABORTED', 'CONNECTION_FAILED',
  'CONNECTION_TIMED_OUT', 'TIMED_OUT', 'EMPTY_RESPONSE', 'ADDRESS_UNREACHABLE', 'NETWORK_CHANGED', 'INTERNET_DISCONNECTED', 'NETWORK_IO_SUSPENDED']);
/**
 * Whether the close reason positively names a network failure: "Error in connection establishment:
 * net::ERR_CONNECTION_REFUSED", or "Connection closed before receiving a handshake response (net::ERR_EMPTY_RESPONSE)".
 * A certificate rejection (net::ERR_FAILED from the pin check) or any other error is not one.
 */
export function networkFailure(event: { code: number; reason?: unknown }): boolean {
  if (event.code !== 1006 || typeof event.reason !== 'string') return false;
  const match = /^(?:Error in connection establishment: net::ERR_([A-Z_]+)|Connection closed before receiving a handshake response \(net::ERR_([A-Z_]+)\))$/.exec(event.reason);
  const error = match?.[1] ?? match?.[2];
  return error !== undefined && NETWORK_FAILURES.has(error);
}
/** A socket close through the shared classifier: its close code, or the refused upgrade's status if it never opened. */
export function socketCloseLoss(event: { code: number; reason?: unknown }, opened: boolean): AuthenticationLoss | null {
  return socketAuthenticationLoss({ code: event.code, status: opened ? undefined : handshakeStatus(event) });
}
/**
 * What a close asks of the server client. An open socket reconnects unless it closed for authentication. A socket
 * that never opened keeps approvals only when its reason positively names a network failure or a 5xx refusal;
 * an authentication refusal, any other status, and a reason that isn't recognized (empty, or worded differently by
 * another Chromium) suspend approvals until a fresh identity check. An unknown failure fails closed.
 */
export function socketCloseAction(event: { code: number; reason?: unknown }, opened: boolean): 'reconnect' | 'suspend' {
  if (socketCloseLoss(event, opened)) return 'suspend';
  if (opened) return 'reconnect';
  const status = handshakeStatus(event);
  return networkFailure(event) || (status !== undefined && status >= 500 && status < 600) ? 'reconnect' : 'suspend';
}

export type AuthenticationState = 'verified' | 'unverified' | 'unpaired';
export class UnpairedError extends Error {
  constructor(message = 'Approvals are paused until this desktop’s sign-in is checked.') { super(message); }
}
class ServerHttpError extends Error {}
class ServerNetworkError extends Error {}
export interface DeviceRoutes { pair(code: string, name: string): Promise<unknown>; presence(state: Presence): Promise<unknown> }
export interface ApprovalHandlers {
  notify(approval: Approval): void;
  removed(key: string): void;
  changed(): void;
  authentication?(state: AuthenticationState, generation: number): void;
  answered?(): void;
  link?(open: boolean, code?: number): void;
  unpaired?(): void;
  paired?(): void;
}
export interface LiveSocket {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  close(): void;
}

/** Main owns authentication. Transport and renderer signals can only suspend it; /api/me verifies it. */
export class ServerClient implements DeviceRoutes {
  readonly approvals = new Map<string, Approval>();
  readonly conversations = new Map<string, ConversationSummary>();
  private state: AuthenticationState = 'unverified';
  private generation = 0;
  private work = new AbortController();
  private nativeWork = new AbortController();
  private snapshotWork = new AbortController();
  private pairing: { generation: number; attempt: symbol; accepted: boolean } | undefined;
  private nativePairing: { attempt: symbol; signal: AbortSignal } | undefined;
  private reauthentication: AbortSignal | undefined;
  private verification: Promise<void> | undefined;
  private recoveryRetry: ReturnType<typeof setTimeout> | undefined;
  private socketRetry: ReturnType<typeof setTimeout> | undefined;
  /** The wait before the next socket attempt; zero while the last socket opened and nothing has failed since. */
  private socketDelay = 0;
  private snapshotRetry: ReturnType<typeof setTimeout> | undefined;
  private snapshotDelay = 1000;
  private recoveryDelay = 1000;
  private verifiedOnce = false;
  /** Toasts only for a primary server that allows them; a shadow instance never notifies (its tray says so). */
  private notifications = false;
  private role: ListResponse['role'];
  /** Keys toasted while pending; forgotten once resolved or replaced, so a backend that reuses an id toasts again. */
  private readonly toasted = new Set<string>();
  /** Toasts currently shown, closed when the server stops allowing them. */
  private readonly activeToasts = new Set<string>();
  private socket: LiveSocket | undefined;
  private opener: ((url: string) => LiveSocket) | undefined;
  private stopped = false;
  private opened = false;
  private refreshing: Promise<void> | undefined;
  private snapshots: Promise<void> = Promise.resolve();
  private again = false;
  constructor(private readonly origin: string, private readonly session: Session, private readonly handlers: ApprovalHandlers, private readonly checkListener: () => void = () => {}) {}
  get shadow() { return this.role === 'shadow'; }
  get authenticationState() { return this.state; }
  get authenticationBlocked() { return this.state !== 'verified'; }
  get unpaired() { return this.state === 'unpaired'; }
  get pairingGeneration() { return this.generation; }
  get requestSignal() { return this.nativeWork.signal; }
  get snapshotSignal() { return this.snapshotWork.signal; }
  get nativePairingAttempt() { return this.nativePairing?.attempt; }
  get nativePairingSignal() { return this.nativePairing?.signal; }
  get reauthenticationSignal() { return this.reauthentication; }
  private current(generation: number, recovery = false) {
    if (generation !== this.generation || this.stopped || (this.authenticationBlocked && !recovery)) throw new UnpairedError();
  }
  private publish() {
    this.handlers.changed();
    this.handlers.authentication?.(this.state, this.generation);
  }
  private clearWork() {
    this.nativeWork.abort(new UnpairedError());
    this.nativeWork = new AbortController();
    clearTimeout(this.recoveryRetry); this.recoveryRetry = undefined;
    clearTimeout(this.socketRetry); this.socketRetry = undefined;
    this.retireSnapshots();
    const socket = this.socket;
    this.socket = undefined; this.opened = false;
    socket?.close();
    for (const key of [...this.approvals.keys(), ...this.toasted]) this.forget(key);
    this.toasted.clear(); this.activeToasts.clear(); this.conversations.clear();
    this.notifications = false; this.role = undefined;
  }
  /** Connection changes retire snapshot work without changing identity or existing approvals. */
  private retireSnapshots() {
    this.snapshotWork.abort(new UnpairedError()); this.snapshotWork = new AbortController();
    clearTimeout(this.snapshotRetry); this.snapshotRetry = undefined; this.snapshotDelay = 1000;
    this.snapshots = Promise.resolve(); this.refreshing = undefined; this.again = false;
  }
  /** Every anomaly belongs to its initiating generation; cancelled and replaced work cannot affect it. */
  suspend(generation: number) {
    if (generation !== this.generation || this.stopped || this.state === 'unpaired') return;
    const changed = this.state !== 'unverified';
    this.state = 'unverified';
    this.clearWork();
    if (changed) this.publish();
    this.scheduleVerification();
  }
  private scheduleVerification() {
    if (this.stopped || this.state !== 'unverified' || this.pairing || this.verification || this.recoveryRetry) return;
    this.recoveryRetry = setTimeout(() => {
      this.recoveryRetry = undefined;
      void this.revalidateAuthentication(this.generation);
    }, this.recoveryDelay);
    this.recoveryDelay = Math.min(this.recoveryDelay * 2, 30000);
  }
  /** Only a main-issued identity check may leave unverified. Failed checks retry with capped backoff. */
  revalidateAuthentication(generation: number): Promise<void> {
    if (generation !== this.generation || this.stopped || this.state !== 'unverified' || this.pairing) return Promise.resolve();
    if (this.verification) return this.verification;
    clearTimeout(this.recoveryRetry); this.recoveryRetry = undefined;
    const signal = AbortSignal.any([this.work.signal, this.nativeWork.signal]);
    this.reauthentication = signal;
    const run = this.verify(generation, signal).finally(() => {
      if (this.verification !== run) return;
      this.verification = undefined; this.reauthentication = undefined;
      this.scheduleVerification();
    });
    this.verification = run;
    return run;
  }
  private async verify(generation: number, signal: AbortSignal) {
    try {
      const result = await this.send('/api/me', undefined, true);
      this.current(generation, true); signal.throwIfAborted();
      if (this.pairing) return;
      if (result === UNPAIRED_IDENTITY) {
        this.state = 'unpaired'; this.clearWork(); this.publish(); this.handlers.unpaired?.(); return;
      }
      const device = result && typeof result === 'object' && 'device' in result ? result.device : undefined;
      if (!device || typeof device !== 'object' || !('id' in device) || typeof device.id !== 'string' || !device.id.trim() ||
        !('kind' in device) || device.kind !== 'desktop') return;
      const replace = this.verifiedOnce || generation > 0;
      this.state = 'verified'; this.verifiedOnce = true; this.recoveryDelay = 1000;
      this.publish();
      if (replace) this.handlers.paired?.();
      // A socket refused or failed since its last open waits out its back-off; otherwise connect now.
      if (this.socketDelay) this.retrySocket(); else this.open();
      if (replace) this.hint();
    } catch { /* Stay unverified until a fresh check succeeds. */ }
  }
  async request(path: string, body?: unknown): Promise<unknown> { return this.send(path, body); }
  private async send(path: string, body?: unknown, probe = false, snapshotSignal?: AbortSignal): Promise<unknown> {
    const generation = this.generation;
    const pair = path === '/api/pair';
    const bearing = authenticationEndpoint(path);
    let received = false;
    this.current(generation, pair || probe);
    const owner = pair ? this.nativePairing?.signal : probe ? this.reauthentication : snapshotSignal
      ? AbortSignal.any([this.nativeWork.signal, snapshotSignal]) : this.nativeWork.signal;
    if ((pair || probe) && !owner) throw new UnpairedError();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('Server request timed out.')), 10000);
    const signal = AbortSignal.any([this.work.signal, owner!, deadline.signal]);
    const abort = () => { if (!pair && !probe && (path === '/api/me' || bearing && received) && !owner!.aborted) this.suspend(generation); };
    signal.addEventListener('abort', abort, { once: true });
    let rejectAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(signal.reason);
      signal.addEventListener('abort', rejectAbort, { once: true });
      if (signal.aborted) rejectAbort();
    });
    try {
      this.checkListener();
      const response = await Promise.race([this.session.fetch(new URL(path, this.origin).href, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'include', signal,
        headers: { 'Content-Type': 'application/json', 'x-signalbox-request': '1', 'x-wayroost-request': '1', [APP_HEADER]: APP_HEADER_VALUE, Origin: this.origin },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual',
      }).catch((error: unknown) => { throw new ServerNetworkError(error instanceof Error ? error.message : 'Server unavailable.'); }), cancelled]);
      received = response.ok;
      this.current(generation, pair || probe); signal.throwIfAborted();
      if (!response.ok || response.type === 'opaqueredirect' || response.redirected) {
        if (probe && response.status === 401) {
          const data = await Promise.race([readIdentity(response), cancelled]);
          this.current(generation, true); signal.throwIfAborted();
          if (data && typeof data === 'object' && 'error' in data && data.error === 'unpaired') return UNPAIRED_IDENTITY;
        }
        let forbidden = false;
        if (response.status === 403) {
          const data: unknown = await Promise.race([readAuthenticationBody(response).catch(() => { forbidden = bearing; return undefined; }), cancelled]);
          forbidden ||= !!data && typeof data === 'object' && 'error' in data && authenticationError(data.error);
        }
        if (!pair && !probe && (authenticationHttpFailure(response.status) || forbidden || response.type === 'opaqueredirect' || response.redirected)) this.suspend(generation);
        throw new ServerHttpError(`Server request failed (${response.status}).`);
      }
      if (pair && this.nativePairing) this.acceptPairing(generation, this.nativePairing.attempt);
      const data: unknown = await Promise.race([probe ? readIdentity(response) : response.json().catch((error: unknown) => {
        if (!pair && bearing && !owner!.aborted) this.suspend(generation);
        throw error;
      }), cancelled]);
      this.current(generation, pair || probe); signal.throwIfAborted();
      return data;
    } catch (error) {
      if (!pair && !probe && path === '/api/me' && !(error instanceof ServerHttpError) && generation === this.generation && !this.stopped && !owner!.aborted) this.suspend(generation);
      if (generation !== this.generation || owner!.aborted || this.stopped) throw new UnpairedError();
      if (!received && deadline.signal.aborted) throw new ServerNetworkError('Server request timed out.');
      throw error;
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort); signal.removeEventListener('abort', rejectAbort);
    }
  }
  /** Reserve the replacement generation before its request starts, quarantining every previous signal. */
  beginPairing(generation: number, attempt: symbol): boolean {
    if (generation !== this.generation || this.stopped || (this.pairing && this.pairing.attempt !== attempt)) return false;
    if (this.pairing) return true;
    this.work.abort(new UnpairedError()); this.work = new AbortController();
    this.generation += 1; this.state = 'unverified'; this.socketDelay = 0;
    this.clearWork(); this.verification = undefined; this.reauthentication = undefined;
    this.pairing = { generation: this.generation, attempt, accepted: false };
    this.publish();
    return true;
  }
  ownsPairing(generation: number, attempt: symbol): boolean {
    return generation === this.generation && !this.stopped && this.pairing?.attempt === attempt && !this.nativePairing?.signal.aborted;
  }
  acceptPairing(generation: number, attempt: symbol) {
    if (this.ownsPairing(generation, attempt)) this.pairing!.accepted = true;
  }
  endPairing(generation: number, attempt: symbol) {
    if (this.pairing?.generation !== generation || this.pairing.attempt !== attempt) return;
    this.pairing = undefined;
    this.scheduleVerification();
  }
  /** Pairing completion permits a fresh identity check, never approval work by itself. */
  resume(generation: number) {
    if (generation !== this.generation || this.stopped) return;
    this.pairing = undefined;
    void this.revalidateAuthentication(generation);
  }
  async pair(code: string, name: string) {
    const attempt = Symbol();
    if (!this.beginPairing(this.generation, attempt)) throw new Error('Pairing is already in progress. Try again when it finishes.');
    const generation = this.generation;
    this.nativePairing = { attempt, signal: this.work.signal };
    try {
      const result = await this.request('/api/pair', { code, name });
      this.endPairing(generation, attempt);
      await this.revalidateAuthentication(generation);
      return result;
    } finally {
      this.endPairing(generation, attempt);
      if (this.nativePairing?.attempt === attempt) this.nativePairing = undefined;
    }
  }
  presence(state: Presence) { return this.request('/api/presence', { state }); }
  conversationOf(approval: Pick<Approval, 'source' | 'conversationId'>): ConversationSummary | undefined {
    return this.conversations.get(`${approval.source}/${approval.conversationId}`);
  }
  async allowOnce(key: string) {
    this.current(this.generation);
    const approval = this.approvals.get(key);
    const option = approval && onceOption(approval);
    if (!approval || !option || !toastCanAllow(approval)) throw new Error('Open this approval to answer it.');
    return this.request(`/api/conversations/${approval.source}/${encodeURIComponent(approval.conversationId)}/approvals/${encodeURIComponent(approval.id)}`, { optionId: option.id });
  }
  /** Serialized authenticated snapshots prevent an older list from replacing a newer one. */
  refresh(): Promise<void> {
    const generation = this.generation;
    const signal = this.snapshotWork.signal;
    if (this.authenticationBlocked || this.stopped) return Promise.reject(new UnpairedError());
    const run = this.snapshots.then(() => this.snapshot(generation, signal));
    this.snapshots = run.catch(() => {});
    return run;
  }
  private async snapshot(generation: number, signal: AbortSignal) {
    this.current(generation); signal.throwIfAborted();
    let validated = false;
    try {
      const list = await this.send('/api/conversations', undefined, false, signal);
      this.current(generation); signal.throwIfAborted();
      if (!isApprovalSnapshot(list)) throw new Error('Invalid approval snapshot.');
      validated = true;
      this.role = list.role;
      const allowed = list.role === 'primary' && list.notifications === true;
      if (!allowed) {
        for (const key of this.activeToasts) this.handlers.removed(key);
        this.activeToasts.clear();
        this.toasted.clear();
      }
      this.notifications = allowed;
      this.conversations.clear();
      for (const conversation of list.conversations) this.conversations.set(`${conversation.source}/${conversation.id}`, conversation);
      const current = new Set(list.approvals.map(approvalKey));
      for (const key of [...this.approvals.keys()]) if (!current.has(key)) this.forget(key);
      for (const approval of list.approvals) this.upsert(approval);
      this.handlers.changed(); this.handlers.answered?.();
    } catch (error) {
      if (!validated && !signal.aborted && !(error instanceof ServerHttpError) && !(error instanceof ServerNetworkError)) this.suspend(generation);
      throw error;
    }
  }
  receive(event: ServerEvent) {
    if (this.authenticationBlocked || this.stopped) return;
    if (event.type !== 'approval_upsert' && event.type !== 'approval_removed') return;
    if (!isApprovalEvent(event)) { this.suspend(this.generation); return; }
    if (event.type === 'approval_upsert') this.upsert(event.approval);
    else this.forget(approvalKey({ source: event.source, conversationId: event.conversationId, id: event.approvalId }));
    this.handlers.changed();
  }
  private upsert(approval: Approval) {
    const key = approvalKey(approval);
    const previous = this.approvals.get(key);
    if (previous && previous.createdAt !== approval.createdAt) this.forget(key);
    this.approvals.set(key, approval);
    if (this.notifications && !this.toasted.has(key)) {
      this.toasted.add(key); this.activeToasts.add(key); this.handlers.notify(approval);
    }
  }
  private forget(key: string) {
    const known = this.approvals.delete(key) || this.toasted.has(key);
    this.toasted.delete(key);
    this.activeToasts.delete(key);
    if (known) this.handlers.removed(key);
  }
  hint() {
    if (this.stopped || this.authenticationBlocked) return;
    if (this.refreshing) { this.again = true; return; }
    clearTimeout(this.snapshotRetry); this.snapshotRetry = undefined;
    const signal = this.snapshotWork.signal;
    const run = this.refresh().then(() => { if (!signal.aborted) this.snapshotDelay = 1000; }).catch(error => {
      if (signal.aborted || this.stopped || this.authenticationBlocked ||
        !(error instanceof ServerHttpError || error instanceof ServerNetworkError)) return;
      this.snapshotRetry = setTimeout(() => { this.snapshotRetry = undefined; this.hint(); }, this.snapshotDelay);
      this.snapshotDelay = Math.min(this.snapshotDelay * 2, 30000);
    }).finally(() => {
      if (signal.aborted || this.refreshing !== run) return;
      this.refreshing = undefined;
      if (this.again) { this.again = false; this.hint(); }
    });
    this.refreshing = run;
  }
  connect(open: (url: string) => LiveSocket) { this.opener = open; this.open(); }
  get connected() { return this.opened; }
  stop() {
    this.stopped = true; this.state = 'unverified'; this.work.abort(new UnpairedError()); this.clearWork();
    this.pairing = undefined; this.verification = undefined; this.reauthentication = undefined;
  }
  private open() {
    if (this.stopped || this.authenticationBlocked || this.socket || !this.opener) return;
    const generation = this.generation;
    const signal = this.nativeWork.signal;
    let socket: LiveSocket;
    // An unpinned listener is a pairing problem: nothing is sent, and approvals pause until a fresh check.
    try { this.checkListener(); } catch { this.suspend(generation); return; }
    try { socket = this.opener(this.origin.replace(/^http/, 'ws') + '/ws'); }
    // A socket that can't even be made is not a known network failure: it fails closed like one.
    catch { this.socketFailed(); this.suspend(generation); return; }
    this.socket = socket;
    const current = () => this.socket === socket && generation === this.generation && !signal.aborted && !this.authenticationBlocked && !this.stopped;
    let invalidPayloads = 0;
    // Isolated malformed hints are dropped; repeated failures on this socket need a fresh identity check.
    const invalid = () => { if (++invalidPayloads >= 3) this.suspend(generation); };
    socket.onopen = () => {
      if (!current()) return;
      this.socketDelay = 0;
      this.retireSnapshots(); this.opened = true; this.handlers.link?.(true); this.hint();
    };
    socket.onmessage = (event) => {
      if (!current()) return;
      try {
        const data: unknown = JSON.parse(String(event.data));
        if (!data || typeof data !== 'object' || Array.isArray(data) || !('type' in data) || typeof data.type !== 'string') {
          invalid(); return;
        }
        if (data.type === 'approval_upsert' || data.type === 'approval_removed') {
          if (!isApprovalEvent(data)) { invalid(); return; }
          this.hint();
        }
      } catch { invalid(); }
    };
    socket.onerror = () => { if (current()) this.handlers.link?.(false); };
    socket.onclose = (event) => {
      if (!current()) return;
      const opened = this.opened;
      this.handlers.link?.(false, event.code);
      this.socket = undefined; this.opened = false;
      this.socketFailed();
      // No webRequest hook sees this socket, so it classifies its own failures: an authentication close, a refused
      // upgrade or an unrecognized failure before opening suspends approvals and stops reconnecting until a fresh
      // identity check or pairing; a verified check reconnects after the back-off.
      if (socketCloseAction(event, opened) === 'suspend') this.suspend(generation);
      else { this.retireSnapshots(); this.retrySocket(); }
    };
  }
  /** Records a failed or closed socket: the next attempt waits one second, doubling up to thirty. */
  private socketFailed() {
    this.socketDelay = this.socketDelay ? Math.min(this.socketDelay * 2, SOCKET_RETRY_MAX_MS) : SOCKET_RETRY_MIN_MS;
  }
  private retrySocket() {
    if (this.stopped || this.authenticationBlocked || this.socketRetry) return;
    this.socketRetry = setTimeout(() => { this.socketRetry = undefined; this.open(); }, this.socketDelay || SOCKET_RETRY_MIN_MS);
  }
}

/** A stalled or oversized identity body cannot turn an unverified session into a verified one. */
async function readIdentity(response: Response): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reader = response.body?.getReader();
  try {
    const read = async () => {
      if (!reader) return response.json();
      let bytes = 0; let text = '';
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4096) throw new Error('Identity response too large.');
        text += decoder.decode(chunk.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode()) as unknown;
    };
    return await Promise.race([read(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Identity response timed out.')), AUTHENTICATION_TIMEOUT_MS);
    })]);
  } finally {
    clearTimeout(timer);
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
