import { z } from 'zod';
import { HERMES_DRAIN_PROTOCOL, drainExecutorStateSchema, drainIdlePair, drainRestartOutcomeSchema, drainRestartRunSchema,
  type DrainRestartRun } from '../../shared/supervisor-config.js';
import type { GatewayReading } from './drain-readers.js';

export type DrainState = z.infer<typeof drainExecutorStateSchema>;
export type DrainOutcome = z.infer<typeof drainRestartOutcomeSchema>;
export const drainProgressSchema = z.object({ progress: z.object({
  state: z.enum(['waiting', 'probing', 'draining', 'restarting', 'clearing', 'verifying']).optional(),
  attempts: drainRestartRunSchema.shape.attempts.optional(),
  probeAttempts: drainRestartRunSchema.shape.probeAttempts.unwrap().optional(),
  busy: drainRestartRunSchema.shape.busy.optional(),
  lastRelease: drainRestartRunSchema.shape.lastRelease,
}).strict() }).strict();
export interface DrainIO {
  now(): number;
  sleep(ms: number): Promise<void>;
  active(unit: 'gateway' | 'executor'): Promise<boolean>;
  gateway(): Promise<GatewayReading | undefined>;
  phone(timeoutMs: number): Promise<boolean>;
  phoneReleaseReason?(): 'call-started' | 'phone-unavailable';
  cron(): Promise<boolean>;
  background(): Promise<boolean>;
  marker(): Promise<{ principal?: unknown; requested_at?: unknown } | null>;
  publishMarker(requestedAt: string): Promise<boolean>;
  removeMarker(requestedAt: unknown): Promise<void>;
  recoverMarkers?(): Promise<void>;
  save(state: DrainState): Promise<void>;
  load(): Promise<DrainState | null>;
  deleteState(): Promise<void>;
  stop(timeoutMs?: number): Promise<void>;
  start(noBlock?: boolean): Promise<void>;
}
const timing = HERMES_DRAIN_PROTOCOL.timing;
const owns = (marker: Awaited<ReturnType<DrainIO['marker']>>, at: unknown) => at !== null && marker?.principal === 'wayroost' && marker.requested_at === at;

async function clearMarker(io: DrainIO, at: unknown): Promise<void> {
  const until = io.now() + timing.verifyDeadlineSeconds * 1000;
  const drainUntil = typeof at === 'string' ? Date.parse(at) + timing.drainLimitSeconds * 1000 : NaN;
  let retries = 0;
  for (;;) {
    let recoveryError: unknown;
    try { await io.recoverMarkers?.(); } catch (error) { recoveryError = error; }
    let marker = await io.marker();
    if (owns(marker, at)) {
      try { await io.removeMarker(at); } catch {}
      try { await io.recoverMarkers?.(); recoveryError = undefined; } catch (error) { recoveryError = error; }
      marker = await io.marker();
    }
    if (!owns(marker, at)) {
      if (recoveryError !== undefined) throw recoveryError;
      return;
    }
    if (++retries >= 150 || io.now() >= until) throw recoveryError ?? new Error();
    const pause = Number.isFinite(drainUntil) ? Math.min(1000, Math.max(0, drainUntil - io.now())) : 1000;
    if (pause > 0) await io.sleep(pause);
  }
}

/** The stop intent is durable before systemctl, so interruption still requires a start. */
export async function cleanupDrain(io: DrainIO): Promise<void> {
  const state = await io.load();
  let recoveryError: unknown;
  try { await clearMarker(io, state?.marker_requested_at ?? null); } catch (error) { recoveryError = error; }
  if (state?.stopped_gateway && !state.started_gateway) {
    const marker = await io.marker();
    const cleared = marker === null || typeof marker.principal === 'string' && (marker.principal !== 'wayroost'
      || typeof marker.requested_at === 'string' && marker.requested_at !== state.marker_requested_at);
    if (!cleared) throw recoveryError ?? new Error();
    await io.start(true);
    await io.save({ ...state, started_gateway: true });
  }
  if (recoveryError !== undefined) throw recoveryError;
  if (state) await io.deleteState();
}

export async function sweepDrain(io: DrainIO): Promise<void> {
  if (await io.active('executor')) return;
  await cleanupDrain(io);
  const marker = await io.marker();
  if (marker?.principal === 'wayroost') {
    if (marker.requested_at === null) await io.removeMarker(null);
    else await clearMarker(io, marker.requested_at);
  }
}

export async function executeHermesDrain(io: DrainIO, when: 'idle' | 'now' = 'idle',
  update: (patch: Partial<DrainRestartRun>) => void = () => {}): Promise<DrainOutcome> {
  if (!await io.active('gateway')) return { outcome: 'not_running' };
  const previous = await io.load();
  if (previous) throw new Error();
  const state: DrainState = { phase: 'waiting', marker_requested_at: null, stopped_gateway: false, started_gateway: false };
  const overall = io.now() + timing.overallLimitSeconds * 1000;
  let unchangedAt = io.now();
  let lastCount: number | undefined;
  let attempts = 0;
  let probes = 0;
  let before: GatewayReading | undefined;
  const observe = (reading: GatewayReading | undefined) => {
    if (reading?.count !== lastCount) { lastCount = reading?.count; unchangedAt = io.now(); }
  };
  const save = async (phase: DrainState['phase']) => { state.phase = phase; await io.save({ ...state }); };
  const pause = async (ms: number) => { await io.sleep(Math.max(0, Math.min(ms, overall - io.now()))); };
  const release = async (reason: NonNullable<DrainRestartRun['lastRelease']>) => {
    await clearMarker(io, state.marker_requested_at);
    state.marker_requested_at = null;
    await save('waiting');
    update({ state: 'waiting', lastRelease: reason });
  };
  try {
    await save('waiting');
    if (await io.marker()) return { outcome: 'foreign_drain' };
    if (when === 'idle') {
      let ready = false;
      while (io.now() < overall && !ready) {
        if (await io.marker()) return { outcome: 'foreign_drain' };
        before = await io.gateway();
        observe(before);
        const phone = await io.phone(Math.min(timing.phoneTimeoutSeconds * 1000, overall - io.now()));
        const phoneBusy = io.phoneReleaseReason?.() === 'call-started' ? 'call' as const : 'phone-unavailable' as const;
        const cron = await io.cron();
        const background = await io.background();
        const valid = before && ['running', 'degraded'].includes(before.state) && before.count !== undefined;
        const probe = valid && before?.count! > 0 && io.now() - unchangedAt >= timing.staleCountProbeSeconds * 1000;
        if (!phone || !cron || !background || !valid || before?.count !== 0 && !probe) {
          update({ busy: [...(!phone ? [phoneBusy] : []), ...(!cron ? ['cron-unknown' as const] : []),
            ...(!background ? ['background-unknown' as const] : []), ...(!valid ? ['agents-unknown' as const] : before?.count ? ['agents-running' as const] : [])] });
          await pause(timing.waitPollSeconds * 1000);
          continue;
        }
        if (io.now() >= overall) break;
        state.marker_requested_at = new Date(io.now()).toISOString();
        attempts++; if (probe) probes++;
        await save(probe ? 'probing' : 'draining');
        update({ state: probe ? 'probing' : 'draining', attempts, probeAttempts: probes, busy: [] });
        if (!await io.publishMarker(state.marker_requested_at)) return { outcome: 'foreign_drain' };
        const requested = state.marker_requested_at;
        const requestedMs = Date.parse(requested);
        const deadline = Math.min(overall, requestedMs + timing.drainLimitSeconds * 1000);
        // File polling continues while the phone's bounded health request is in flight.
        let phoneReading: boolean | undefined;
        let phonePending = false;
        const phoneFailed = () => phoneReading === false;
        const pollPhone = () => {
          if (phonePending || phoneReading !== undefined) return;
          phonePending = true;
          void io.phone(Math.max(1, Math.min(timing.phoneTimeoutSeconds * 1000, deadline - io.now()))).then(
            clear => { phoneReading = clear; phonePending = false; },
            () => { phoneReading = false; phonePending = false; });
        };
        pollPhone();
        let entry: GatewayReading | undefined;
        let cancelled = false;
        while (io.now() <= requestedMs + timing.engageDeadlineSeconds * 1000) {
          if (!owns(await io.marker(), requested)) return { outcome: 'marker_lost' };
          if (phoneFailed()) { await release(io.phoneReleaseReason?.() ?? 'call-started'); cancelled = true; break; }
          const reading = await io.gateway();
          observe(reading);
          if (reading?.state === 'draining' && reading.updatedAt && Date.parse(reading.updatedAt) > requestedMs) { entry = reading; break; }
          if (io.now() >= requestedMs + timing.engageDeadlineSeconds * 1000) break;
          await io.sleep(1000);
        }
        if (cancelled) { await pause(timing.waitPollSeconds * 1000); continue; }
        if (!entry) return { outcome: 'drain_not_engaged' };
        if (!entry.workKnown || entry.chat) { await release('chat-at-entry'); await pause(timing.waitPollSeconds * 1000); continue; }
        let idle: unknown;
        while (io.now() < deadline) {
          pollPhone();
          if (!owns(await io.marker(), requested)) return { outcome: 'marker_lost' };
          if (phoneFailed()) {
            await release(io.phoneReleaseReason?.() ?? 'call-started'); cancelled = true; break;
          }
          if (io.now() >= deadline) break;
          const reading = await io.gateway();
          observe(reading);
          const fresh = reading?.state === 'draining' && reading.updatedAt && Date.parse(reading.updatedAt) > requestedMs;
          const backgroundClear = await io.background();
          if (!owns(await io.marker(), requested)) return { outcome: 'marker_lost' };
          if (phoneFailed()) { await release(io.phoneReleaseReason?.() ?? 'call-started'); cancelled = true; break; }
          if (fresh && reading.count === 0 && backgroundClear) {
            if (phoneReading === true) {
              const current = { state: 'draining', updatedAt: reading.updatedAt, readAt: io.now(), activeAgents: '0',
                backgroundClear: true, phoneClear: true, markerOwned: true };
              if (idle && drainIdlePair(idle, current, requested)) { ready = true; break; }
              if (!idle) idle = current;
            }
          } else idle = undefined;
          if (phoneReading === true) phoneReading = undefined;
          await io.sleep(Math.min(1000, deadline - io.now()));
        }
        if (ready) break;
        if (!cancelled) { await release('drain-timeout'); await pause(timing.retrySeconds * 1000); }
        else await pause(timing.waitPollSeconds * 1000);
      }
      if (!ready) return { outcome: 'still_busy' };
    } else before = await io.gateway();
    if (state.marker_requested_at && !owns(await io.marker(), state.marker_requested_at)) return { outcome: 'marker_lost' };
    update({ state: 'restarting' });
    state.stopped_gateway = true;
    await save('stopping');
    const stopBudget = state.marker_requested_at ? Date.parse(state.marker_requested_at) + timing.drainLimitSeconds * 1000 - io.now() : 150_000;
    if (stopBudget <= 0) return { outcome: 'restart_unverified' };
    await io.stop(Math.min(150_000, stopBudget));
    update({ state: 'clearing' });
    await clearMarker(io, state.marker_requested_at);
    if (await io.marker()) return { outcome: 'marker_lost' };
    await save('cleared');
    await save('starting');
    const until = io.now() + timing.verifyDeadlineSeconds * 1000;
    await io.start();
    state.started_gateway = true;
    await save('verifying');
    update({ state: 'verifying' });
    while (io.now() <= until) {
      const reading = await io.gateway();
      if (before?.pid && before.startTime && reading?.pid && reading.startTime && reading.pid !== before.pid && reading.startTime !== before.startTime
        && ['running', 'degraded'].includes(reading.state) && !await io.marker()) return { outcome: 'restarted' };
      if (io.now() >= until) break;
      await io.sleep(Math.min(1000, until - io.now()));
    }
    return { outcome: 'restart_unverified' };
  } catch { return { outcome: 'restart_unverified' }; }
  finally { await cleanupDrain(io); }
}
