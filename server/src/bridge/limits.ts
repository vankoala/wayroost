// Rate limits and the loop breaker for bridge messages. Pure bookkeeping over
// timestamps; the caller passes the clock in.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Timestamps of recent events per key, forgotten once they leave the window. */
export class SlidingWindow {
  private readonly events = new Map<string, number[]>();

  constructor(readonly windowMs: number) {}

  count(key: string, now: number): number {
    return this.live(key, now).length;
  }

  add(key: string, now: number): void {
    const list = this.live(key, now);
    list.push(now);
    this.events.set(key, list);
  }

  /** Milliseconds until the oldest event in the window leaves it. */
  retryIn(key: string, now: number): number {
    const oldest = this.live(key, now)[0];
    return oldest === undefined ? 0 : Math.max(0, oldest + this.windowMs - now);
  }

  /** Forget everything that left the window (keeps memory bounded). */
  sweep(now: number): void {
    for (const key of [...this.events.keys()]) this.live(key, now);
  }

  private live(key: string, now: number): number[] {
    const list = this.events.get(key);
    if (!list) return [];
    const first = list.findIndex((t) => now - t < this.windowMs);
    if (first < 0) {
      this.events.delete(key);
      return [];
    }
    if (first > 0) list.splice(0, first);
    return list;
  }
}

export interface Refusal {
  message: string;
  /** This attempt tripped the loop breaker (publish the notices once). */
  tripped?: boolean;
}

interface Rule {
  window: SlidingWindow;
  max: number;
  key: (caller: string, target: string) => string;
  message: string;
}

const LOOP_WINDOW_MS = 10 * MINUTE;
const LOOP_THRESHOLD = 3;
export const LOOP_PAUSE_MS = 30 * MINUTE;
export const LOOP_NOTICE = 'Signalbox paused messages between these chats for 30 minutes to stop a loop.';

function minutes(ms: number): string {
  const n = Math.max(1, Math.ceil(ms / MINUTE));
  return `${n} minute${n === 1 ? '' : 's'}`;
}

const pairKey = (from: string, to: string) => `${from}>${to}`;

/**
 * Sliding-window limits on messages sent through the bridge:
 * per caller 12 / 10 min, per target 6 / 10 min, per (caller, target) 4 / 10 min,
 * and 60 / hour overall. Plus a loop breaker: once A→B and B→A have each
 * happened 3 times in 10 minutes, that pair is paused for 30 minutes.
 */
export class SendLimits {
  private readonly pairs = new SlidingWindow(LOOP_WINDOW_MS);
  private readonly rules: Rule[] = [
    {
      window: new SlidingWindow(10 * MINUTE),
      max: 12,
      key: (caller) => caller,
      message: 'This chat has already sent 12 messages through the bridge in the last 10 minutes.',
    },
    {
      window: new SlidingWindow(10 * MINUTE),
      max: 6,
      key: (_caller, target) => target,
      message: 'That chat has already received 6 messages through the bridge in the last 10 minutes.',
    },
    {
      window: this.pairs,
      max: 4,
      key: pairKey,
      message: 'You have already sent that chat 4 messages in the last 10 minutes.',
    },
    {
      window: new SlidingWindow(HOUR),
      max: 60,
      key: () => '*',
      message: 'Agents have already sent 60 messages through the bridge in the last hour.',
    },
  ];
  /** Pair (sorted "a|b") → paused until. */
  private readonly paused = new Map<string, number>();

  /** Why `caller` may not message `target` right now, or null. Trips the loop breaker when due. */
  check(caller: string, target: string, now: number): Refusal | null {
    const pair = [caller, target].sort().join('|');
    const until = this.paused.get(pair);
    if (until !== undefined && until > now) {
      return {
        message: `Signalbox paused messages between these chats to stop a loop. Try again in ${minutes(until - now)}, or ask the user.`,
      };
    }
    if (until !== undefined) this.paused.delete(pair);

    if (
      this.pairs.count(pairKey(caller, target), now) >= LOOP_THRESHOLD &&
      this.pairs.count(pairKey(target, caller), now) >= LOOP_THRESHOLD
    ) {
      this.paused.set(pair, now + LOOP_PAUSE_MS);
      return { message: `${LOOP_NOTICE} Ask the user if the conversation needs to go on.`, tripped: true };
    }

    for (const rule of this.rules) {
      const key = rule.key(caller, target);
      if (rule.window.count(key, now) >= rule.max) {
        return { message: `${rule.message} Try again in ${minutes(rule.window.retryIn(key, now))}.` };
      }
    }
    return null;
  }

  /** Count a message that was accepted (sent now or queued). */
  record(caller: string, target: string, now: number): void {
    for (const rule of this.rules) rule.window.add(rule.key(caller, target), now);
  }

  sweep(now: number): void {
    for (const rule of this.rules) rule.window.sweep(now);
    for (const [pair, until] of [...this.paused]) if (until <= now) this.paused.delete(pair);
  }
}
