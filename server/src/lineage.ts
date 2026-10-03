import { checkDeviceSignal } from './security/device-signal.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ConversationSummary, Source } from '../../shared/protocol.js';
import type { Logger } from './hermes/adapter.js';
import type { StartedBy } from './sources.js';
import type { BackgroundGate } from './background.js';

// Who started what, for the runs neither backend links by itself: Hermes chats an
// agent started from a shell (`hermes chat --oneshot`), `claude -p` runs, and the
// Hermes chats the bridge started for another agent (Paseo keeps those links in
// labels; Hermes has nowhere to put them). Reports arrive through the bridge from the
// Hermes plugin and the Claude Code hook. Kept in the state directory, so the links
// survive a restart.

/** A launcher named in a child's environment: PASEO_AGENT_ID, HERMES_SESSION_ID, SIGNALBOX_LAUNCHER=claude:<id>. */
export interface Candidate {
  kind: 'paseo' | 'hermes' | 'claude';
  id: string;
}

type Parent = NonNullable<ConversationSummary['parent']>;

const CandidateSchema = z.object({
  kind: z.enum(['paseo', 'hermes', 'claude']),
  id: z.string().regex(/^[A-Za-z0-9][\w.:@+-]{0,199}$/),
});
const LaunchSchema = z.object({ candidates: z.array(CandidateSchema).max(6), startedAt: z.number(), reportedAt: z.number() });
const RunSchema = z.object({
  candidates: z.array(CandidateSchema).max(6),
  cwd: z.string().max(4096).optional(),
  entrypoint: z.string().max(40).optional(),
  task: z.string().max(4000).optional(),
  final: z.string().max(16000).optional(),
  status: z.enum(['running', 'done', 'error']),
  startedAt: z.number(),
  updatedAt: z.number(),
});
const StartedBySchema = z.object({ source: z.enum(['hermes', 'paseo']), id: z.string().max(200), title: z.string().max(400), at: z.number() });
const FileSchema = z.object({
  version: z.literal(1),
  launches: z.record(z.string(), LaunchSchema),
  runs: z.record(z.string(), RunSchema),
  startedBy: z.record(z.string(), StartedBySchema),
});

export type LaunchRecord = z.infer<typeof LaunchSchema>;
export type RunRecord = z.infer<typeof RunSchema>;
type LineageFile = z.infer<typeof FileSchema>;

const FILE = 'lineage.json';
const MAX_LAUNCHES = 3000;
const MAX_RUNS = 2000;
const MAX_STARTED_BY = 1000;
const MAX_AGE_MS = 30 * 24 * 3600_000;
/** A launcher's clock may run a little ahead of the child's report. */
const START_SLACK_MS = 5_000;
/** A run that never said it ended (killed, crashed) stops counting as running after this. */
const RUN_STALE_MS = 6 * 3600_000;

/** A `claude -p` run's conversation id. Runs are listed with the Paseo agents, like Claude Code Task sub-agents. */
export const runRowId = (sessionId: string): string => `crun:${sessionId}`;
export const isRunRowId = (id: string): boolean => id.startsWith('crun:');
export const runSessionId = (rowId: string): string => rowId.slice('crun:'.length);

/** Where a launcher is listed: a Claude run shows as a Paseo-side row. */
export function candidateRef(c: Candidate): Parent {
  return c.kind === 'claude' ? { source: 'paseo', id: runRowId(c.id) } : { source: c.kind, id: c.id };
}

export type StartLookup = (id: string) => number | undefined;
export type LineageChange = { kind: 'launch'; hermesId: string } | { kind: 'run'; sessionId: string };

export class Lineage {
  private data: LineageFile = { version: 1, launches: {}, runs: {}, startedBy: {} };
  private readonly lookups: Partial<Record<Source, StartLookup>> = {};
  /** The Paseo agent whose own Claude session this is, if any (Paseo's Claude agents fire the hook too). */
  private claudeOwner: (sessionId: string) => string | undefined = () => undefined;
  private readonly listeners = new Set<(change: LineageChange) => void>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly dir: string | null,
    private readonly log: Logger | undefined,
    private readonly now: () => number = Date.now,
    private readonly background: BackgroundGate,
  ) {
    if (!dir) return;
    try {
      this.data = FileSchema.parse(JSON.parse(readFileSync(join(dir, FILE), 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log?.warn({ err: String(err) }, 'lineage file unreadable; starting empty');
    }
  }

  /** How a backend tells when one of its conversations started (epoch ms), for choosing the nearest launcher. */
  setStartLookup(source: Source, lookup: StartLookup): void {
    this.lookups[source] = lookup;
  }

  /** Paseo's own Claude agents are that agent, not a run: resolve their session to the agent. */
  setClaudeOwner(owner: (sessionId: string) => string | undefined): void {
    this.claudeOwner = owner;
  }

  onChange(listener: (change: LineageChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- reports ---------------------------------------------------------------

  /** A Hermes chat started by an agent from a shell, with the launchers its environment named. */
  noteLaunch(hermesId: string, candidates: Candidate[], startedAt: number): void {
    if (!this.background.run(() => true) || !candidates.length) return;
    this.data.launches[hermesId] = { candidates, startedAt, reportedAt: this.now() };
    this.changed({ kind: 'launch', hermesId });
  }

  /** One event of a Claude Code run: its start (with its launchers), its task, or its end with the final answer. */
  noteRun(sessionId: string, event: 'start' | 'prompt' | 'stop' | 'end', fields: Partial<Omit<RunRecord, 'status' | 'updatedAt'>> & { error?: boolean }): void {
    if (!this.background.run(() => true)) return;
    const at = this.now();
    const existing = this.data.runs[sessionId];
    if (!existing && event !== 'start' && !fields.candidates?.length) return; // never saw it start with a launcher
    const run: RunRecord = existing ?? { candidates: [], status: 'running', startedAt: fields.startedAt ?? at, updatedAt: at };
    if (fields.candidates?.length && !run.candidates.length) run.candidates = fields.candidates;
    if (fields.cwd && !run.cwd) run.cwd = fields.cwd;
    if (fields.entrypoint && !run.entrypoint) run.entrypoint = fields.entrypoint;
    if (fields.task && !run.task) run.task = fields.task; // the first prompt is the task
    if (fields.final) run.final = fields.final;
    if (event === 'start' || event === 'prompt') run.status = 'running';
    if (event === 'stop' || event === 'end') run.status = fields.error ? 'error' : 'done';
    run.updatedAt = at;
    this.data.runs[sessionId] = run;
    this.changed({ kind: 'run', sessionId });
  }

  /** The chat the bridge started this one for (persisted; Hermes has nowhere to keep it). */
  startedBy(key: string): StartedBy | undefined {
    const entry = this.data.startedBy[key];
    return entry ? { source: entry.source, id: entry.id, title: entry.title } : undefined;
  }

  setStartedBy(key: string, value: StartedBy): void {
    if (!this.background.run(() => true)) return;
    this.data.startedBy[key] = { ...value, at: this.now() };
    this.scheduleSave();
  }

  // ---- reading ---------------------------------------------------------------

  /** The launch record of a Hermes chat under any of its ids (a compressed chat keeps its earlier ids as aliases). */
  launchOf(ids: string[]): LaunchRecord | undefined {
    for (const id of ids) {
      const launch = this.data.launches[id];
      if (launch) return launch;
    }
    return undefined;
  }

  runs(): Array<[string, RunRecord]> {
    return Object.entries(this.data.runs);
  }

  run(sessionId: string): RunRecord | undefined {
    return this.data.runs[sessionId];
  }

  /** Running, unless it never reported an end and has been silent for hours. */
  runStatus(run: RunRecord): RunRecord['status'] {
    return run.status === 'running' && this.now() - run.updatedAt > RUN_STALE_MS ? 'done' : run.status;
  }

  /**
   * The nearest launcher among the ones the environment named. A child inherits
   * its ancestors' variables too, and every ancestor started before it, so the
   * most recently started known launcher that began no later than the child is
   * the nearest one. With none known, the first one named.
   */
  parentOf(candidates: Candidate[], childStartedAt: number): Parent | undefined {
    if (!candidates.length) return undefined;
    // A Claude session that is a Paseo agent's own stands for that agent.
    const resolved = candidates.map((c): Candidate => {
      const agent = c.kind === 'claude' ? this.claudeOwner(c.id) : undefined;
      return agent ? { kind: 'paseo', id: agent } : c;
    });
    let best: { c: Candidate; at: number } | undefined;
    for (const c of resolved) {
      const at = this.startOf(c);
      if (at === undefined || at > childStartedAt + START_SLACK_MS) continue;
      if (!best || at > best.at) best = { c, at };
    }
    return candidateRef(best?.c ?? resolved[0]!);
  }

  private startOf(c: Candidate): number | undefined {
    if (c.kind === 'claude') return this.data.runs[c.id]?.startedAt;
    return this.lookups[c.kind]?.(c.id);
  }

  // ---- storage ---------------------------------------------------------------

  private changed(change: LineageChange): void {
    this.scheduleSave();
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        this.log?.warn({ err: String(err) }, 'lineage listener failed');
      }
    }
  }

  private scheduleSave(): void {
    if (!this.dir || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, 500);
    this.saveTimer.unref?.();
  }

  /** Write now (also used at shutdown and by tests). Oldest entries go first when a table is full. */
  save(): void {
    if (!this.background.run(() => true) || !this.dir) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const cutoff = this.now() - MAX_AGE_MS;
    const trim = <T>(table: Record<string, T>, max: number, at: (v: T) => number) =>
      Object.fromEntries(
        Object.entries(table)
          .filter(([, v]) => at(v) >= cutoff)
          .sort(([, a], [, b]) => at(b) - at(a))
          .slice(0, max),
      );
    this.data = {
      version: 1,
      launches: trim(this.data.launches, MAX_LAUNCHES, (v) => v.reportedAt),
      runs: trim(this.data.runs, MAX_RUNS, (v) => v.updatedAt),
      startedBy: trim(this.data.startedBy, MAX_STARTED_BY, (v) => v.at),
    };
    try {
      checkDeviceSignal();
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const path = join(this.dir, FILE);
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      renameSync(tmp, path);
    } catch (err) {
      this.log?.warn({ err: String(err) }, 'could not save the lineage file');
    }
  }
}
