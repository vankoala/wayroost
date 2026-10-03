import { spawn } from 'node:child_process';
import type { Component, Profile, Probe } from './registry.js';
import { LINE_LENGTH } from './output.js';
import { trustedExecutable, type Trust } from './trust.js';
export interface RunOptions {
  /**
   * Ends the local wait: the child's whole process group is sent SIGTERM, then SIGKILL
   * after KILL_GRACE_MS, and run() settles within CLEANUP_LIMIT_MS even if a descendant
   * that left the group still holds its output. It never stops a transient unit, whose
   * processes belong to systemd, not to the systemd-run client.
   * Once aborted, nothing more is spawned: run() rejects with the signal's reason instead.
   */
  signal?: AbortSignal;
  /**
   * Called after the runner's own checks, with nothing awaited between it and the spawn.
   * Throwing refuses the command: it never starts, and run() rejects with that error.
   */
  beforeSpawn?: () => void;
}
/** How long an aborted command's process group has to end on SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 500;
/** The longest an aborted run() waits for its output to close before settling anyway. */
export const CLEANUP_LIMIT_MS = 1500;
export interface Exec {
  run(argv: readonly string[], line?: (line: string) => void, options?: RunOptions): Promise<number>;
}
/**
 * Spawns argv as the supervisor (root). Every command passes `trust` first, probes
 * included: a health, busy or installed probe runs as root just like an action.
 */
export function spawnExec(trust: Trust): Exec {
  return { async run(argv, line, { signal, beforeSpawn } = {}) {
    signal?.throwIfAborted();
    const command = await trust(argv[0]!);
    // The ownership walk takes time: a deadline or shutdown may have passed during it.
    beforeSpawn?.();
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      // Its own process group, so an abort reaches what a shell probe started too: a
      // descendant left behind would keep the pipes, and with them this wait, open.
      const child = spawn(command, argv.slice(1), { shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let cleanupTimer: NodeJS.Timeout | undefined;
      const group = (name: NodeJS.Signals) => {
        try { if (child.pid !== undefined) process.kill(-child.pid, name); } catch { /* already gone */ }
      };
      // For `systemd-run --wait` this is what a supervisor restart does anyway: the client
      // exits and the action keeps running in its own unit, to be reconciled at startup.
      const abort = () => {
        group('SIGTERM');
        // Redirected descendants can remain after the parent closes: keep escalation alive.
        setTimeout(() => group('SIGKILL'), KILL_GRACE_MS);
        // A descendant that moved to its own session can outlive both signals: stop reading.
        cleanupTimer = setTimeout(() => {
          child.stdout.destroy(); child.stderr.destroy();
          resolve(child.exitCode ?? 1);
        }, CLEANUP_LIMIT_MS);
      };
      signal?.addEventListener('abort', abort, { once: true });
      child.on('close', () => { signal?.removeEventListener('abort', abort); clearTimeout(cleanupTimer); });
      for (const stream of [child.stdout, child.stderr]) {
        let pending = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
          pending += chunk;
          let index: number;
          while ((index = pending.indexOf('\n')) >= 0) { line?.(pending.slice(0, index).replace(/\r$/, '')); pending = pending.slice(index + 1); }
          while (pending.length > LINE_LENGTH) { line?.(pending.slice(0, LINE_LENGTH)); pending = pending.slice(LINE_LENGTH); }
        });
        stream.on('end', () => { if (pending) line?.(pending); });
      }
      child.on('error', reject);
      child.on('close', code => resolve(code ?? 1));
    });
  } };
}
/** The production runner: nothing runs unless only root can change it. */
export const realExec: Exec = spawnExec(trustedExecutable);
/** The probe's own timeout, ended early by `signal` (a shutdown or deadline) when given. */
const httpSignal = (timeoutMs: number, signal?: AbortSignal): AbortSignal =>
  signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs);
/**
 * `signal` ends the probe (its command's process group is ended, its request aborted) and stops
 * one that has not started yet; an ended probe answers like a failed one.
 */
export async function probe(value: Probe, exec: Exec, busy = false, signal?: AbortSignal): Promise<boolean> {
  if (value.kind === 'none') return false;
  try {
    if (value.kind === 'unit') {
      let matched = false;
      const code = value.expect === undefined ? await exec.run(value.command, undefined, { signal })
        : await exec.run(value.command, line => { if (line.trim() === value.expect) matched = true; }, { signal });
      // A command ended by the signal exits non-zero, which is no answer (not "not busy").
      signal?.throwIfAborted();
      return code === 0 && (value.expect === undefined || matched);
    }
    const response = await fetch(value.url, { signal: httpSignal(value.timeoutMs, signal) });
    if (!response.ok) { await response.body?.cancel(); return busy; }
    if (!busy) { await response.body?.cancel(); return true; }
    const data: unknown = await response.json();
    const field = data && typeof data === 'object' && value.busyField
      ? (data as Record<string, unknown>)[value.busyField] : undefined;
    if (typeof field === 'boolean') return field;
    if (typeof field === 'number' && Number.isSafeInteger(field) && field >= 0) return field > 0;
    return true;
  } catch { return busy; }
}
export type Installation = 'installed' | 'absent' | 'unknown';
/**
 * Whether an optional component is installed. Only an explicit answer is "absent": a
 * `not-found` LoadState, or a 404 from an HTTP probe. A query that fails (an unavailable
 * user manager, a refused command, a server error) or answers anything else (a masked
 * or unloadable unit) is unknown, and an unknown component stays in status.
 * `signal` (a shutdown or a departed client) ends the query; an ended query is unknown.
 */
export async function installation(value: Probe, exec: Exec, signal?: AbortSignal): Promise<Installation> {
  if (value.kind === 'none') return 'absent';
  try {
    if (value.kind === 'unit') {
      // Without `expect`, the exit code is the command's own answer.
      if (value.expect === undefined) {
        const code = await exec.run(value.command, undefined, { signal });
        // A command ended by the signal is no answer, never "absent".
        signal?.throwIfAborted();
        return code === 0 ? 'installed' : 'absent';
      }
      let matched = false;
      let missing = false;
      const code = await exec.run(value.command, line => {
        if (line.trim() === value.expect) matched = true;
        else if (value.absent !== undefined && line.trim() === value.absent) missing = true;
      }, { signal });
      signal?.throwIfAborted();
      if (code !== 0) return 'unknown';
      return matched ? 'installed' : missing ? 'absent' : 'unknown';
    }
    const response = await fetch(value.url, { signal: httpSignal(value.timeoutMs, signal) });
    await response.body?.cancel();
    return response.ok ? 'installed' : response.status === 404 ? 'absent' : 'unknown';
  } catch { return 'unknown'; }
}
/** The live profile is the first one whose health answers; none answering means down or starting. */
export async function liveProfile(entry: Component, exec: Exec, signal?: AbortSignal): Promise<Profile | undefined> {
  for (const profile of entry.profiles ?? []) {
    if (await probe(profile.health, exec, false, signal)) return profile;
    signal?.throwIfAborted();
  }
  return undefined;
}
