import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { SUPERVISOR_VERBS } from '../../shared/supervisor.js';
import type { ActionDetail, ActionRequest, ActionSummary, SupervisorEvent } from '../../shared/supervisor.js';
import { NOT_SET_UP_SENTENCE, isReady, restartsLiveProfile, type Component } from './registry.js';
import type { Config } from './config.js';
import { BusyTracker } from './busy.js';
import type { Exec } from './probes.js';
import { liveProfile, probe } from './probes.js';
import { collectDiagnostics } from './diagnostics.js';
import { audit, auditedIds } from './audit.js';
import { trustedExecutable, type Trust } from './trust.js';
import { HISTORY_SIZE, LINE_LENGTH, OutputTail, retainLine } from './output.js';

const requestSchema = z.object({ verb: z.enum(SUPERVISOR_VERBS), target: z.string(), profile: z.string().optional(), when: z.enum(['now', 'idle']).default('now') }).strict();
const recordSchema = requestSchema.extend({
  id: z.string().regex(/^[a-z0-9-]+$/), caller: z.string(), startedAt: z.number(), endedAt: z.number().optional(),
  state: z.enum(['queued', 'waiting-for-idle', 'running', 'done', 'failed', 'cancelled']), result: z.string().optional(),
});
const unitActive = (state: string): boolean => state !== 'inactive' && state !== 'failed';
const idleMessage = 'The team stayed busy too long. Try again when it is idle.';
export function summary(action: ActionSummary): ActionSummary {
  const { id, verb, target, profile, state, caller, startedAt, endedAt } = action;
  return { id, verb, target, ...(profile ? { profile } : {}), state, caller, startedAt, ...(endedAt ? { endedAt } : {}) };
}
export class RequestError extends Error { readonly status = 400; }
export class StatusOnlyError extends Error {
  readonly status = 403;
  constructor() { super('The supervisor is in status-only mode. Actions are disabled.'); }
}
/** Shutdown began before the action launched anything; it is recorded as cancelled. */
class CancelledError extends Error { constructor() { super('The supervisor stopped before the action started.'); } }
export class BusyError extends Error {
  readonly status = 409;
  constructor(readonly running: ActionSummary) { super('Another action is running. Wait until it finishes.'); }
}
export class Actions extends EventEmitter {
  readonly records = new Map<string, ActionDetail>();
  private readonly active = new Map<string, ActionDetail>();
  private initialization?: Promise<void>;
  private stopped = false;
  private readonly monitors = new Set<Promise<void>>();
  /** Aborted by close(): wakes idle waits so nothing launches after shutdown begins. */
  private readonly shutdown = new AbortController();
  /** One per action that has not launched yet; close() waits for each to launch or be recorded. */
  private readonly prelaunch = new Set<Promise<void>>();
  /** Every execute(); close() ends their local waits (never the action units) and waits for them. */
  private readonly executions = new Set<Promise<void>>();
  get running(): ActionDetail | undefined { return this.active.values().next().value; }
  readonly busy: BusyTracker;
  /** `signal` aborts once the wait no longer needs the answer: its probes are ended. */
  private readonly idleBusy: (signal: AbortSignal) => Promise<boolean>;
  constructor(readonly registry: Component[], readonly exec: Exec, readonly config: Config,
    isBusy?: (signal: AbortSignal) => Promise<boolean>, private readonly trust: Trust = trustedExecutable) {
    super();
    this.busy = new BusyTracker(config.busyStaleMs);
    this.idleBusy = isBusy ?? (async signal =>
      (await Promise.all(registry.filter(isReady).map(entry => probe(entry.busy, exec, true, signal)))).some(Boolean) || this.busy.state() !== 'idle');
  }
  initialize(): Promise<void> { return this.initialization ??= this.reconcile(); }
  private path(id: string, extension = 'json'): string { return join(this.config.stateDir, 'actions', id + '.' + extension); }
  private async persist(action: ActionDetail): Promise<void> {
    const { lines: _lines, ...metadata } = action;
    const file = await open(this.path(action.id, 'tmp'), 'w', 0o600);
    try { await file.writeFile(JSON.stringify(metadata)); await file.sync(); }
    finally { await file.close(); }
    await rename(this.path(action.id, 'tmp'), this.path(action.id));
    const directory = await open(join(this.config.stateDir, 'actions'), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  private trim(): void {
    const completed = [...this.records.values()].filter(action => !this.active.has(action.id)).sort((a, b) => b.startedAt - a.startedAt);
    for (const action of completed.slice(HISTORY_SIZE)) this.records.delete(action.id);
  }
  private async load(id: string): Promise<ActionDetail | undefined> {
    if (!/^[a-z0-9-]+$/.test(id)) return undefined;
    try { return { ...recordSchema.parse(JSON.parse(await readFile(this.path(id), 'utf8'))), lines: [] }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async get(id: string): Promise<ActionDetail | undefined> {
    const retained = this.records.get(id);
    if (retained && (!retained.endedAt || retained.lines.length)) return retained;
    const action = retained ?? await this.load(id);
    if (!action) return undefined;
    try {
      const file = await open(this.path(id, 'log'), 'r');
      try {
        const size = (await file.stat()).size;
        const buffer = Buffer.alloc(Math.min(65536, size));
        await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
        for (const line of buffer.toString('utf8').split('\n').filter(Boolean)) retainLine(action, line);
      } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return action;
  }
  private async reconcile(): Promise<void> {
    await mkdir(join(this.config.stateDir, 'actions'), { recursive: true, mode: 0o700 });
    const units = await this.activeUnits();
    // Read once: checking each completed record against the whole log would grow quadratically.
    const audited = await auditedIds(this.config.stateDir);
    for (const name of await readdir(join(this.config.stateDir, 'actions'))) {
      if (!/^[a-z0-9-]+\.json$/.test(name)) continue;
      const action = (await this.load(name.slice(0, -5)))!;
      this.records.set(action.id, action);
      if (units.has(action.id)) { action.state = 'running'; this.active.set(action.id, action); }
      else if (!action.endedAt) {
        await this.complete(action, new Error('The supervisor restarted before the action outcome was recorded.'));
        await this.resetFailed(action.id);
      }
      else await audit(this.config.stateDir, action, audited);
      this.trim();
    }
    for (const id of units) {
      let action = this.active.get(id);
      if (!action) {
        action = { id, verb: 'restart', target: 'unknown-component', caller: 'unknown', state: 'running', startedAt: Date.now(), lines: [] };
        this.active.set(id, action); this.records.set(id, action);
      }
      await this.persist(action);
      this.watch(action);
    }
  }
  /**
   * A systemctl query that shutdown ends: the runner is told through the signal, and the
   * wait ends with a CancelledError even if the command never settles.
   */
  private query(argv: readonly string[], line?: (line: string) => void): Promise<number> {
    return this.beforeDeadline(signal => this.exec.run(argv, line, { signal }));
  }
  /** `cancellable`: shutdown ends the listing with a CancelledError (never at startup). */
  private async activeUnits(cancellable = false): Promise<Set<string>> {
    const units = new Set<string>();
    const argv = ['systemctl', 'list-units', '--all', '--plain', '--no-legend', '--no-pager', 'wayroost-act-*.service'];
    const line = (text: string) => {
      const match = /^\s*(wayroost-act-([a-z0-9-]+)\.service)\s+\S+\s+(\S+)/.exec(text);
      if (match && unitActive(match[3]!)) units.add(match[2]!);
    };
    const code = await (cancellable ? this.query(argv, line) : this.exec.run(argv, line));
    if (code !== 0) throw new Error('The running actions could not be checked. Actions remain disabled.');
    return units;
  }
  private watch(action: ActionDetail): void {
    const monitor = this.monitor(action).catch(() => {
      // Failed storage or probing keeps the lock; never assume the unit stopped.
      action.result = 'The running action could not be checked. Actions remain locked.';
    });
    this.monitors.add(monitor);
    void monitor.then(() => this.monitors.delete(monitor));
  }
  validate(input: unknown): ActionRequest {
    if (this.config.statusOnly) throw new StatusOnlyError();
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) throw new RequestError('Choose a known action and provide only its allowed fields.');
    const request = parsed.data;
    const entry = this.registry.find(entry => entry.id === request.target);
    if (!entry) throw new RequestError('That component is not known.');
    if (request.profile && (request.verb !== 'switch-model' || !entry.profiles?.some(profile => profile.id === request.profile))) throw new RequestError('That model profile is not available.');
    if (!isReady(entry)) throw new RequestError(NOT_SET_UP_SENTENCE);
    if (request.verb === 'switch-model') {
      const profile = entry.profiles?.find(p => p.id === request.profile);
      if (!profile) throw new RequestError('Choose an available model profile.');
      if (!profile.argv) throw new RequestError(NOT_SET_UP_SENTENCE);
    }
    if ((request.verb === 'hold' || request.verb === 'release') && !entry.holdFile) throw new RequestError('This component cannot be held.');
    if (['start', 'stop', 'restart'].includes(request.verb) && !entry[request.verb as 'start' | 'stop' | 'restart'] &&
      !(request.verb === 'restart' && restartsLiveProfile(entry)))
      throw new RequestError('This action is not available for this component.');
    return request;
  }
  start(request: ActionRequest, caller: string): Promise<ActionDetail> {
    request = this.validate(request);
    if (this.running) throw new BusyError(summary(this.running));
    return this.accept(request, caller);
  }
  private async accept(request: ActionRequest, caller: string): Promise<ActionDetail> {
    await this.initialize();
    if (this.stopped) throw new RequestError('The supervisor is shutting down.');
    if (this.running) throw new BusyError(summary(this.running));
    const action: ActionDetail = { id: randomUUID(), ...request, caller, state: 'queued', startedAt: Date.now(), lines: [] };
    this.active.set(action.id, action); this.records.set(action.id, action);
    let launching!: () => void;
    const prelaunch = new Promise<void>(resolve => { launching = resolve; });
    this.prelaunch.add(prelaunch); void prelaunch.then(() => this.prelaunch.delete(prelaunch));
    try { await this.persist(action); }
    catch (error) { this.active.delete(action.id); this.records.delete(action.id); launching(); throw error; }
    this.emitEvent({ type: 'action', action: summary(action) });
    const execution = this.execute(action, request, launching).catch(() => {
      action.result = 'The action record could not be saved. Actions remain locked.';
    }).finally(launching);
    this.executions.add(execution); void execution.then(() => this.executions.delete(execution));
    return action;
  }
  emitEvent(event: SupervisorEvent): void { this.emit('event', structuredClone(event)); }
  private tail(action: ActionDetail): OutputTail {
    return new OutputTail(this.path(action.id, 'log'), line => {
      this.emitEvent({ type: 'line', actionId: action.id, line: retainLine(action, line) });
    });
  }
  private async idle(): Promise<number> {
    const deadline = Date.now() + this.config.idleLimitMs;
    const signal = this.shutdown.signal;
    while (true) {
      if (this.stopped) throw new CancelledError();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(idleMessage);
      // The deadline and shutdown reach the probes themselves, not just this wait.
      const busy = await this.beforeDeadline(probing => this.idleBusy(probing), deadline);
      if (this.stopped) throw new CancelledError();
      if (Date.now() >= deadline) throw new Error(idleMessage);
      if (!busy) return deadline;
      try { await delay(Math.min(this.config.pollMs, deadline - Date.now()), undefined, { signal }); }
      catch (error) { if (signal.aborted) throw new CancelledError(); throw error; }
    }
  }
  /**
   * Settles with `work`, or fails once the idle deadline (if any) passes or shutdown begins.
   * Either way `work`'s signal is aborted when this settles, so its commands and requests
   * end instead of outliving the wait. Work is never started after shutdown began.
   */
  private async beforeDeadline<T>(work: (signal: AbortSignal) => Promise<T>, deadline?: number): Promise<T> {
    const shutdown = this.shutdown.signal;
    if (shutdown.aborted) throw new CancelledError();
    if (deadline !== undefined && Date.now() >= deadline) throw new Error(idleMessage);
    const ending = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const ended = new Promise<never>((_resolve, reject) => {
      if (deadline !== undefined) timer = setTimeout(() => reject(new Error(idleMessage)), Math.max(0, deadline - Date.now()));
      onAbort = () => reject(new CancelledError());
      shutdown.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const running = work(ending.signal);
      // The losing branch keeps running until it sees the abort; its rejection must not go unhandled.
      running.catch(() => {});
      return await Promise.race([running, ended]);
    } finally {
      clearTimeout(timer); if (onAbort) shutdown.removeEventListener('abort', onAbort);
      ending.abort(new CancelledError());
    }
  }
  private async execute(action: ActionDetail, request: ActionRequest, launching: () => void): Promise<void> {
    let error: unknown;
    let launched = false;
    /** Set when the runner's last check refused systemd-run: nothing was spawned. */
    let refused: unknown;
    try {
      let idleDeadline: number | undefined;
      if (request.when === 'idle') {
        action.state = 'waiting-for-idle'; await this.persist(action);
        this.emitEvent({ type: 'action', action: summary(action) });
        idleDeadline = await this.idle();
      }
      action.state = 'running'; await this.persist(action);
      if (idleDeadline !== undefined && Date.now() >= idleDeadline) throw new Error(idleMessage);
      this.emitEvent({ type: 'action', action: summary(action) });
      if (this.stopped) throw new CancelledError();
      if (request.verb === 'diagnostics') {
        // Its systemctl queries and probes must not hold shutdown either; nothing has launched yet.
        action.result = JSON.stringify(await this.beforeDeadline(signal => collectDiagnostics(this.registry, this.exec, signal)));
      }
      else {
        const entry = this.registry.find(entry => entry.id === request.target)!;
        const log = this.path(action.id, 'log');
        // Probing the live profile, the ownership walk and the log file all take time:
        // after an idle wait they must finish before the deadline, like the wait itself.
        const prepare = async (signal: AbortSignal): Promise<string[]> => {
          let argv: string[];
          switch (request.verb) {
            case 'switch-model': argv = entry.profiles!.find(profile => profile.id === request.profile)!.argv!; break;
            case 'hold': case 'release': argv = [process.execPath, fileURLToPath(new URL('./hold.js', import.meta.url)), request.verb, entry.holdFile!]; break;
            case 'restart':
              if (restartsLiveProfile(entry)) {
                // Restart re-runs the live profile; it must never switch to the default one.
                const live = await liveProfile(entry, this.exec, signal);
                if (!live) throw new Error('The model is not answering, so there is no live model to restart. Use Start instead.');
                if (!live.argv) throw new Error('The live model cannot be restarted on this PC.');
                argv = live.argv;
              } else argv = entry.restart!;
              break;
            default: argv = entry[request.verb as 'start' | 'stop']!;
          }
          // Checked at every launch: the launcher can change after install, and root runs it.
          argv = [await this.trust(argv[0]!), ...argv.slice(1)];
          const file = await open(log, 'a', 0o600); await file.close();
          return argv;
        };
        // Shutdown ends it too (as a cancel: nothing has launched), ending a hung live-profile probe.
        const argv = await this.beforeDeadline(prepare, idleDeadline);
        const tail = this.tail(action);
        let writes = Promise.resolve();
        let logError: unknown;
        let queuedBytes = 0;
        const launchable = (): void => {
          if (this.stopped) throw new CancelledError();
          if (idleDeadline !== undefined && Date.now() >= idleDeadline) throw new Error(idleMessage);
        };
        // Checked here for any runner, and again by a runner that awaits before spawning.
        launchable();
        launched = true; launching();
        // CollectMode=inactive (not --collect) keeps a failed unit loaded, so its Result can
        // still be read after a supervisor restart; reset-failed unloads it once recorded.
        // KillMode=process: a launcher may leave its server running in the background
        // (launch-vllm.sh uses nohup … &) and exit once it answers. With the default
        // control-group mode systemd would kill that server as soon as the launcher exits.
        const command = this.exec.run(['systemd-run', '--unit=wayroost-act-' + action.id, '--property=CollectMode=inactive',
          '--property=KillMode=process', '--wait', '--quiet',
          '--property=StandardOutput=append:' + log, '--property=StandardError=append:' + log, '--', ...argv], line => {
          if (logError) return;
          line = line.slice(0, LINE_LENGTH);
          const bytes = Buffer.byteLength(line) + 1;
          if (queuedBytes + bytes > 65536) { logError = new Error('The action log could not be saved. Check the state folder.'); return; }
          queuedBytes += bytes;
          // Handle every rejection as it is queued, even while the command runs.
          writes = writes.then(async () => { if (!logError) await appendFile(log, line + '\n'); })
            .catch(() => { logError = new Error('The action log could not be saved. Check the state folder.'); })
            .finally(() => { queuedBytes -= bytes; });
        }, { signal: this.shutdown.signal, beforeSpawn: () => {
          // The runner checks systemd-run itself before spawning it, so check again at the
          // spawn: nothing awaits between this and the launch. A refusal launched nothing.
          try { launchable(); } catch (reason) { refused = reason; throw reason; }
        } });
        let settled = false;
        let commandError: unknown;
        let code = 1;
        void command.then(value => { code = value; settled = true; }, reason => { commandError = reason; settled = true; });
        const signal = this.shutdown.signal;
        while (!settled && !signal.aborted) {
          try { await tail.read(); } catch { logError = new Error('The action log could not be read. Check the state folder.'); }
          try { await delay(Math.min(this.config.pollMs, 100), undefined, { signal }); } catch { /* shutdown */ }
        }
        // Shutdown: stop polling and leave the unit running; the next start reconciles it.
        if (!settled) return;
        await writes;
        while (await tail.read(true)) {}
        if (commandError) throw commandError;
        if (logError) throw logError;
        if (code !== 0) throw new Error('The action could not finish. Check the component and try again.');
      }
    } catch (reason) { error = reason; }
    if (refused !== undefined && error === refused) launched = false;
    if (launched && error && !this.stopped) {
      let stillActive = true;
      try { stillActive = (await this.activeUnits(true)).has(action.id); } catch {}
      if (stillActive) { this.watch(action); return; }
    }
    // Nothing launched: record the outcome even during shutdown (a cancel, not a lost action).
    if (!launched || !this.stopped) {
      await this.complete(action, error);
      if (launched && action.state === 'failed') await this.resetFailed(action.id);
    }
  }
  /** Best effort: unload a failed action unit after its outcome is recorded. */
  private async resetFailed(id: string): Promise<void> {
    try { await this.query(['systemctl', 'reset-failed', 'wayroost-act-' + id + '.service']); } catch {}
  }
  private async complete(action: ActionDetail, error?: unknown): Promise<void> {
    action.state = error instanceof CancelledError ? 'cancelled' : error ? 'failed' : 'done';
    action.result = error ? error instanceof Error && error.message.startsWith('The ') ? error.message
      : 'The action could not finish. Check the component and try again.' : action.result ?? 'The action finished.';
    action.endedAt = Date.now();
    await this.persist(action);
    try { await audit(this.config.stateDir, action); }
    catch { action.state = 'failed'; action.result = 'The audit record could not be saved. Check the state folder.'; await this.persist(action); }
    this.active.delete(action.id); this.trim();
    this.emitEvent({ type: 'action', action: summary(action) });
  }
  private async monitor(action: ActionDetail): Promise<void> {
    const tail = this.tail(action);
    while (!this.stopped) {
      try { await tail.read(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const properties = new Map<string, string>();
      let code: number;
      // Shutdown ends a blocked query and leaves the action running, for the next start to reconcile.
      try {
        code = await this.query(['systemctl', 'show', 'wayroost-act-' + action.id + '.service', '--property=LoadState',
          '--property=InvocationID', '--property=ActiveState', '--property=Result', '--property=ExecMainStatus'], line => {
          const at = line.indexOf('='); if (at >= 0) properties.set(line.slice(0, at), line.slice(at + 1));
        });
      } catch (error) { if (error instanceof CancelledError) return; throw error; }
      if (this.stopped) return;
      // An unloaded unit still answers `show` with exit 0 and default values
      // (LoadState=not-found, Result=success, ExecMainStatus=0): never read those as an outcome.
      const loaded = code === 0 && properties.get('LoadState') === 'loaded' && Boolean(properties.get('InvocationID'));
      if (!loaded) {
        // A successful listing distinguishes a unit that is gone (its outcome is
        // unknown) from a failed connection to the manager.
        let units: Set<string> | undefined;
        try { units = await this.activeUnits(true); } catch {}
        if (this.stopped) return;
        if (units && !units.has(action.id)) {
          await this.complete(action, new Error('The action stopped before its outcome could be recovered.'));
          return;
        }
      } else if (!unitActive(properties.get('ActiveState') ?? '')) {
        try { while (await tail.read(true)) {} } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const success = properties.get('Result') === 'success' && properties.get('ExecMainStatus') === '0';
        await this.complete(action, success ? undefined : new Error('The action could not finish. Check the component and try again.'));
        if (!success) await this.resetFailed(action.id);
        return;
      }
      try { await delay(Math.min(this.config.pollMs, 100), undefined, { signal: this.shutdown.signal }); } catch { /* shutdown */ }
    }
  }
  /** Ends every local wait and poll; running action units are left to the next start's reconcile. */
  async close(): Promise<void> {
    this.stopped = true; this.shutdown.abort();
    await Promise.all([...this.monitors, ...this.prelaunch, ...this.executions]);
  }
}
