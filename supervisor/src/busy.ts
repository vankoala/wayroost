import { z } from 'zod';

/** What the Wayroost server pushes to POST /v1/busy about every 10 s: counts only, never content. */
export const busyCountsSchema = z.object({
  paseoRunning: z.number().int().nonnegative(),
  hermesRunning: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
}).strict();
export type BusyCounts = z.infer<typeof busyCountsSchema>;
export type BusyState = 'idle' | 'busy' | 'unknown';

/**
 * The last pushed counts. Busy is any count above zero. Counts older than
 * staleMs are unknown; "when idle" treats unknown as busy but never waits
 * past its own limit on it.
 */
export class BusyTracker {
  private counts?: BusyCounts;
  private at = 0;
  constructor(private readonly staleMs: number) {}
  record(counts: BusyCounts): void {
    this.counts = counts;
    this.at = Date.now();
  }
  state(now = Date.now()): BusyState {
    if (!this.counts || now - this.at > this.staleMs) return 'unknown';
    const { paseoRunning, hermesRunning, calls } = this.counts;
    return paseoRunning > 0 || hermesRunning > 0 || calls > 0 ? 'busy' : 'idle';
  }
  /** True when a fresh push names this component as mid-turn or mid-call. */
  componentBusy(id: string, now = Date.now()): boolean {
    if (this.state(now) !== 'busy' || !this.counts) return false;
    const { paseoRunning, hermesRunning, calls } = this.counts;
    return (id === 'paseo' && paseoRunning > 0)
      || ((id === 'hermes-gateway' || id === 'hermes-dashboard') && hermesRunning > 0)
      || (id === 'phone' && calls > 0);
  }
}
