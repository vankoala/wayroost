import type { ConversationSource } from './sources.js';
import type { PhoneStatus } from '../../shared/protocol.js';
import type { BusyCounts, SupervisorApi } from './supervisor-client.js';
import type { Logger } from './hermes/adapter.js';

// "Restart when idle": the supervisor waits until no Paseo agent
// is running a turn, no Hermes turn is active and no call is up. It can't see
// those itself, so this server tells it, as counts only (never titles or
// content), about every 10 s on POST /v1/busy. Counts it hasn't heard for 60 s
// are "unknown" to the supervisor, which it treats as busy, so when this server
// can't count something it sends nothing rather than a zero it doesn't know.

/** How often the counts go to the supervisor; it calls counts older than 60 s unknown. */
export const BUSY_EVERY_MS = 10_000;

/** Where the counts come from. */
export interface BusySources {
  /**
   * An authoritative Hermes count must cover all independent backends and gateways.
   * HermesAdapter currently has no such source: its session RPC is process-local,
   * and its status endpoint normalizes invalid runtime counts to zero. An adapter
   * without a complete count stays unknown, including when it is connected.
   */
  hermes: Pick<ConversationSource, 'status'> & { activeTurns?(): Promise<number> };
  /** Paseo's list is the daemon's whole agent list, kept live by its subscription. */
  paseo: Pick<ConversationSource, 'status' | 'listConversations'>;
  /**
   * Hermes Phone, through the helper. A missing helper can't establish whether
   * the independently installed phone service has a call up: it counts as unknown.
   */
  phone?: { phone(): Promise<PhoneStatus> };
}

/** A count that is a count: a whole number, zero or more. */
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * Paseo agents running a turn: working, or stopped mid-turn waiting for an
 * approval. An adapter that isn't connected can't establish the daemon's count (null).
 */
async function countPaseo(source: BusySources['paseo']): Promise<number | null> {
  const state = source.status().state;
  if (state !== 'connected') return null;
  try {
    const rows = await source.listConversations();
    return rows.filter((row) => row.status === 'running' || row.status === 'needs_approval').length;
  } catch {
    return null;
  }
}

/** Hermes turns running anywhere, asked of Hermes itself; null when it can't say. */
async function countHermes(source: BusySources['hermes']): Promise<number | null> {
  const state = source.status().state;
  if (state !== 'connected' || !source.activeTurns) return null;
  try {
    const turns = await source.activeTurns();
    return isCount(turns) ? turns : null;
  } catch {
    return null;
  }
}

/**
 * Calls up on the phone line. None only when the helper found it off (its port
 * refused), or the line reports zero calls. A line that didn't answer, a helper
 * that can't be asked, or a status with no call count can't be counted (null).
 */
async function countCalls(phone: BusySources['phone']): Promise<number | null> {
  if (!phone) return null;
  try {
    const status = await phone.phone();
    if (!status.running) return status.off === true ? 0 : null;
    return isCount(status.activeCalls) ? status.activeCalls : null;
  } catch {
    return null;
  }
}

/**
 * The phone line to count, from the helper this server has. Missing helpers,
 * configured or not, leave the phone service's call count unknown.
 */
export function phoneSource(helper: BusySources['phone'], configured: boolean): BusySources['phone'] {
  if (helper) return helper;
  if (!configured) return undefined;
  return { phone: () => Promise.reject(new Error("the helper isn't available")) };
}

/** The counts the supervisor takes, or null when any of them can't be known right now. */
export async function countBusy(sources: BusySources): Promise<BusyCounts | null> {
  const [paseoRunning, hermesRunning, calls] = await Promise.all([
    countPaseo(sources.paseo),
    countHermes(sources.hermes),
    countCalls(sources.phone),
  ]);
  if (paseoRunning === null || hermesRunning === null || calls === null) return null;
  return { paseoRunning, hermesRunning, calls };
}

/**
 * Sends the counts now and then every `everyMs` until stop(). Stopped first on
 * shutdown, before the sources are torn down, so a half-stopped server never
 * reports zeros it can't vouch for; the supervisor then lets the last counts go
 * stale (unknown, so busy) rather than run something mid-turn.
 */
export class BusyReporter {
  private timer: ReturnType<typeof setInterval> | undefined;
  private sending = false;
  private failing = false;

  constructor(
    private readonly supervisor: Pick<SupervisorApi, 'reportBusy'>,
    private readonly count: () => Promise<BusyCounts | null>,
    private readonly log: Logger,
    private readonly everyMs = BUSY_EVERY_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.everyMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One report; a slow count or call is never overlapped by the next. */
  private async tick(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      const counts = await this.count().catch(() => null);
      // Stopped while counting: what was counted may already be half torn down.
      if (!counts || !this.timer) return;
      const taken = await this.supervisor.reportBusy(counts);
      if (taken && this.failing) this.log.info({}, 'the supervisor is taking busy counts again');
      if (!taken && !this.failing) this.log.warn({}, 'the supervisor did not take the busy counts');
      this.failing = !taken;
    } finally {
      this.sending = false;
    }
  }
}
