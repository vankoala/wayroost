import type { HermesMessageRow } from '../hermes/normalize.js';

// Launch proof from Hermes' own stored tool calls and results. A label is only
// a claim: one successful `paseo run` command must print the full worker id.
// Wait results never affect completion delivery.

export interface BackgroundProcess {
  command: string;
  startedAt: number;
  /** The first recorded exit; a cached reread cannot move the launch window forward. */
  completedAt?: number;
}

export interface LaunchProof {
  /** When the launch's own tool result printed the worker's id (ms). */
  launches: number[];
}

/** The table `paseo run` prints: this header, then the new agent's row (its full id first). */
const RUN_HEADER = /^AGENT ID\s+STATUS\s+PROVIDER\s+CWD\s+TITLE$/;
const NOTICE_HEAD = '[IMPORTANT: Background process ';
/** Hermes' exit notice: "[IMPORTANT: Background process <sid> <how it ended> (exit code <n>[, SIGTERM])." */
const NOTICE = /^\[IMPORTANT: Background process (\S+) ([^\n]*?) \(exit code (-?\d+|\?)(, SIGTERM)?\)\.\n/;
const SIGTERM = new Set([-15, 143]);
/** Plain text unless a terminal asked for colours; strip them either way. */
const plain = (output: string) => output.replace(/\u001b\[[0-9;]*m/g, '').trim();

/** Hermes' marks for output it shortened at the front: the status line may be gone. */
const CUT_FRONT = /^\.\.\.\((?:first \d+ characters cut|output trimmed)/;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : '',
      )
      .join('');
  }
  return '';
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    return objectOf(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

/**
 * The row right under the table's header. Paseo prints notes (a new workspace, a
 * tip) before its table, and Hermes keeps them in the output, so the header is
 * looked for; an output with two headers is ambiguous and gives nothing.
 */
function rowUnder(text: string, header: RegExp): string | undefined {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const at = lines.flatMap((line, i) => (header.test(line) ? [i] : []));
  return at.length === 1 ? lines[at[0]! + 1] : undefined;
}

/**
 * The CLI's JSON answer, after any notes it printed first. The CLI prints a table OR JSON, never
 * both: an output with a table in it is read as the table, so JSON a worker wrote into the table
 * (its title or appended activity) never counts.
 */
function jsonOf(text: string): Record<string, unknown> | undefined {
  if (text.split('\n').some((line) => /^AGENT ID\s/.test(line.trim()))) return undefined;
  const start = text.startsWith('{') ? 0 : text.indexOf('\n{') + 1;
  return start > 0 || text.startsWith('{') ? objectOf(text.slice(start)) : undefined;
}

interface Result {
  at: number;
  command: string;
  output: string;
  /** The command ran to its end on its own (exit code 0), not killed or failed. */
  clean: boolean;
  process?: { id: string; startedAt: number };
}

/** A single launch command owns its result; shell text and help output never prove a launch. */
export function startsRun(command: string): boolean {
  const text = command.trim();
  if (!/^paseo[ \t]+run[ \t]+/.test(text)) return false;
  const tokens: string[] = [];
  let quote: "'" | '"' | undefined;
  let token = '';
  let hasToken = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote === "'") {
      if (char === quote) quote = undefined;
      else token += char;
      continue;
    }
    if (char === '\\') {
      const next = text[++i];
      if (next === undefined || /[\r\n]/.test(next)) return false;
      // Double quotes only escape these characters; other backslashes stay literal.
      token += quote === '"' && !/["\\$`]/.test(next) ? `\\${next}` : next;
      hasToken = true;
      continue;
    }
    // Expansions can execute code or change arguments, even inside double quotes.
    if (char === '$' || char === '`') return false;
    if (quote === '"') {
      if (char === quote) quote = undefined;
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
    } else if (char === ' ' || char === '\t') {
      if (hasToken) tokens.push(token);
      token = '';
      hasToken = false;
    } else {
      if (/[\r\n;&|<>#(){}*?\[\]]/.test(char)) return false;
      token += char;
      hasToken = true;
    }
  }
  if (quote) return false;
  if (hasToken) tokens.push(token);
  for (const arg of tokens.slice(2)) {
    if (arg === '--') break;
    if (/^(?:--help|--version)(?:=|$)|^-[^-]*[hVv]/.test(arg)) return false;
  }
  return tokens.length > 2 && tokens[0] === 'paseo' && tokens[1] === 'run';
}

/** The agent a `paseo run` printed: its JSON's agentId, or the first token of the row under the run table's header. */
export function printedAgent(output: string): string | undefined {
  const text = plain(output);
  if (CUT_FRONT.test(text)) return undefined;
  const json = jsonOf(text);
  if (json) return typeof json.agentId === 'string' ? json.agentId : undefined;
  return rowUnder(text, RUN_HEADER)?.split(/\s+/)[0];
}

/**
 * Hermes' exit notices in a row: a row that is one notice, or a completion row
 * (display kind "process_complete") that may open with "[IMPORTANT: N background
 * processes completed. …]" and holds one notice per paragraph.
 */
function notices(text: string, batch: boolean): string[] {
  if (!batch) return text.startsWith(NOTICE_HEAD) ? [text] : [];
  return text.split(/\n(?=\[IMPORTANT: Background process )/).filter((part) => part.startsWith(NOTICE_HEAD));
}

/**
 * A launch process's first recorded exit limits the time of cached output.
 * The notice itself never proves a launch; only a matching tool result does.
 */
function noticeCompletion(notice: string, at: number, started: ReadonlyMap<string, BackgroundProcess>): Pick<Result, 'at' | 'process'> | undefined {
  const head = NOTICE.exec(notice);
  if (!head) return undefined;
  const [, sid] = head;
  const process = started.get(sid!);
  if (!process) return undefined;
  return { at: Math.min(process.completedAt ?? at, at),
    process: { id: sid!, startedAt: process.startedAt } };
}

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  at?: number;
}

function timestampOf(row: HermesMessageRow): number | undefined {
  return typeof row.timestamp === 'number' && Number.isFinite(row.timestamp) ? Math.round(row.timestamp * 1000) : undefined;
}

function toolCalls(rows: readonly HermesMessageRow[]): Map<string, ToolCall> {
  const calls = new Map<string, ToolCall>();
  for (const row of rows) {
    if (row.role !== 'assistant') continue;
    for (const call of row.tool_calls ?? []) {
      if (call.id) calls.set(call.id, { name: call.function?.name ?? '', args: objectOf(call.function?.arguments) ?? {}, at: timestampOf(row) });
    }
  }
  return calls;
}

/** A process result must match the original terminal start and an exact wait/poll on its session id. */
function processResult(call: ToolCall, result: Record<string, unknown>, at: number, started: ReadonlyMap<string, BackgroundProcess>): Result | undefined {
  const sid = typeof call.args.session_id === 'string' ? call.args.session_id : '';
  const process = started.get(sid);
  if (!process || (call.args.action !== 'wait' && call.args.action !== 'poll') ||
      (result.session_id !== undefined && result.session_id !== sid) ||
      typeof result.command !== 'string' || result.command.trim() !== process.command.trim()) return undefined;
  if (result.status !== 'exited' && result.status !== 'already_exited') return undefined;
  // Without an original completion, already_exited proves no time for this cached output.
  if (result.status === 'already_exited' && process.completedAt === undefined) return undefined;
  const code = typeof result.exit_code === 'number' ? result.exit_code : Number.NaN;
  const output = typeof result.output === 'string' ? result.output : typeof result.output_preview === 'string' ? result.output_preview : '';
  return { at: Math.min(process.completedAt ?? at, at), command: process.command, output,
    clean: code === 0 && result.completion_reason !== 'killed' && !SIGTERM.has(code),
    process: { id: sid, startedAt: process.startedAt } };
}

/** Background launches and their first recorded completions, retained when earlier rows scroll out. */
export function backgroundStarts(rows: readonly HermesMessageRow[], known?: ReadonlyMap<string, BackgroundProcess>): Map<string, BackgroundProcess> {
  const calls = toolCalls(rows);
  const started = new Map(known);
  for (const row of rows) {
    if (row.role !== 'tool' || !row.tool_call_id) continue;
    const call = calls.get(row.tool_call_id);
    const result = objectOf(row.content);
    const command = typeof call?.args.command === 'string' ? call.args.command : '';
    if (call?.name !== 'terminal' || !startsRun(command) || !result || call.at === undefined) continue;
    const sid = typeof result.session_id === 'string' ? result.session_id : undefined;
    if (sid && (call.args.background === true || result.status === 'yielded_to_background')) {
      const earlier = started.get(sid);
      started.set(sid, { command, startedAt: call.at,
        ...(earlier?.command === command && earlier.startedAt === call.at && earlier.completedAt !== undefined
          ? { completedAt: earlier.completedAt } : {}) });
    }
  }
  const note = (result: Pick<Result, 'at' | 'process'> | undefined) => {
    if (!result?.process) return;
    const process = started.get(result.process.id)!;
    started.set(result.process.id, { ...process, completedAt: Math.min(process.completedAt ?? result.at, result.at) });
  };
  for (const row of rows) {
    const at = timestampOf(row);
    if (at === undefined) continue;
    if (row.role === 'user') {
      for (const notice of notices(textOf(row.content), row.display_kind === 'process_complete')) note(noticeCompletion(notice, at, started));
    } else if (row.role === 'tool' && row.tool_call_id) {
      const call = calls.get(row.tool_call_id);
      const result = objectOf(row.content);
      if (call?.name === 'process' && result) note(processResult(call, result, at, started));
    }
  }
  return started;
}

/**
 * Read one worker's launch proof from a chat's stored messages (order doesn't matter).
 * `known` adds background starts seen in earlier reads, whose rows may have
 * scrolled out of the latest ones by the time the process ends.
 */
export function readLaunchProof(rows: readonly HermesMessageRow[], id: string, known?: ReadonlyMap<string, BackgroundProcess>): LaunchProof {
  const proof: LaunchProof = { launches: [] };
  if (!id) return proof;
  const calls = toolCalls(rows);
  const started = backgroundStarts(rows, known);
  for (const row of rows) {
    const at = timestampOf(row);
    if (at === undefined) continue;
    if (row.role !== 'tool' || !row.tool_call_id) continue;
    const call = calls.get(row.tool_call_id);
    if (!call) continue;
    const result = objectOf(row.content);
    if (call.name === 'terminal') {
      const command = typeof call.args.command === 'string' ? call.args.command : '';
      // A background start has no launch output; only its later process tool result can prove it.
      if (!startsRun(command) || call.args.background === true || result?.status === 'yielded_to_background') continue;
      const output = typeof result?.output === 'string' ? result.output : textOf(row.content);
      if (result?.exit_code === 0 && printedAgent(output) === id) proof.launches.push(at);
    } else if (call.name === 'process' && result) {
      const completed = processResult(call, result, at, started);
      if (completed?.clean && startsRun(completed.command) && printedAgent(completed.output) === id) proof.launches.push(completed.at);
    }
  }
  return proof;
}

/** A launch result arrived within the worker's creation window. */
export function launchedHere(proof: LaunchProof, createdAt: number, windowMs: number): boolean {
  return proof.launches.some((at) => at >= createdAt - 60_000 && at <= createdAt + windowMs);
}
