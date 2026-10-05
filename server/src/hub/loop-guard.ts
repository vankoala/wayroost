import { createHash } from 'node:crypto';

// Watches the tool calls an agent makes and spots when it is going round in a circle:
// the same failing call over and over, the same failure many times in a short window, or
// two failures taking turns. It only reports what it sees, and never stops anything
// itself; the caller acts on the decision it gets back.

const MINUTE = 60_000;
const IDLE_MS = 60 * MINUTE;
const MAX_OUTCOMES = 200;

export type ToolCallOutcome = {
  agentId: string;
  tool: string;
  argsHash: string;
  /** Epoch milliseconds, supplied by the caller. */
  at: number;
} & ({ ok: true; errorClass?: string } | { ok: false; errorClass: string });

export type LoopGuardDecision = { kind: 'steer'; message: string } | { kind: 'stop'; reason: string };

export interface LoopGuardOptions {
  consecutiveThreshold?: number;
  windowThreshold?: number;
  windowMs?: number;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Hash argument JSON before passing an outcome to the guard. */
export function canonicalArgsHash(argsJson: string): string {
  let args: string;
  try {
    args = `json:${canonicalJson(JSON.parse(argsJson) as JsonValue)}`;
  } catch {
    // Malformed arguments can fail repeatedly too; keep them distinct from JSON strings,
    // but spacing between the words is not part of what the call asks for.
    args = `raw:${(argsJson || '').replace(/\s+/g, ' ').trim()}`;
  }
  return createHash('sha256').update(args).digest('hex');
}

/** Classify error text before passing a failed outcome to the guard. */
export function errorClass(text = ''): string {
  // Use whole numeric tokens so alphanumeric error codes keep their digits.
  // Different paths or codes count as different signatures: the guard may trip later,
  // but it must not combine unrelated failures by guessing which text is a path.
  return text.split(/[\r\n]/, 1)[0]!.toLowerCase()
    .replace(/\b(?:(?:0x)?[0-9a-f]{8,}|\d+)\b/g, '<value>');
}

/** Tool, caller-supplied argument hash, and caller-supplied error class. */
export function callSignature(outcome: Pick<ToolCallOutcome, 'tool' | 'argsHash' | 'errorClass'>): string {
  return JSON.stringify([outcome.tool, outcome.argsHash, outcome.errorClass ?? '']);
}

interface RecentOutcome {
  tool: string;
  call: string;
  signature: string | null;
  at: number;
  active: boolean;
}

interface AgentState {
  history: RecentOutcome[];
  steered: Set<string>;
  lastAt: number;
}

/** The calls an agent keeps making, named the way the agent knows them. */
function failingCalls(history: readonly RecentOutcome[], signatures: Set<string>): string {
  const tools = [...signatures].map((signature) => history.findLast((entry) => entry.signature === signature)?.tool ?? 'tool');
  return tools.length > 1 ? `${tools.join('/')} pair of calls` : `${tools[0]} call`;
}

/** Pure bookkeeping over caller-supplied outcomes; the caller acts on decisions. */
export class LoopGuard {
  private readonly agents = new Map<string, AgentState>();
  private readonly consecutiveThreshold: number;
  private readonly windowThreshold: number;
  private readonly windowMs: number;

  constructor(options: LoopGuardOptions = {}) {
    this.consecutiveThreshold = options.consecutiveThreshold ?? 3;
    this.windowThreshold = options.windowThreshold ?? 5;
    this.windowMs = options.windowMs ?? 10 * MINUTE;
    for (const threshold of [this.consecutiveThreshold, this.windowThreshold]) {
      if (!Number.isSafeInteger(threshold) || threshold < 1) throw new RangeError('Failure thresholds must be positive integers.');
    }
    if (!Number.isFinite(this.windowMs) || this.windowMs <= 0) throw new RangeError('The failure window must be positive.');
  }

  /** Null until a failure pattern trips. A trip consumes its count before counting a fresh pattern. */
  record(outcome: ToolCallOutcome): LoopGuardDecision | null {
    if (!Number.isFinite(outcome.at)) throw new RangeError('The outcome timestamp must be finite.');
    this.sweep(outcome.at);
    let state = this.agents.get(outcome.agentId);
    if (!state) {
      state = { history: [], steered: new Set(), lastAt: outcome.at };
      this.agents.set(outcome.agentId, state);
    }
    state.lastAt = Math.max(state.lastAt, outcome.at);
    const call = JSON.stringify([outcome.tool, outcome.argsHash]);
    const signature = outcome.ok ? null : callSignature(outcome);

    if (outcome.ok) {
      for (const previous of state.history) {
        if (previous.call !== call) continue;
        previous.active = false;
        if (previous.signature !== null) state.steered.delete(previous.signature);
      }
    }
    state.history.push({ tool: outcome.tool, call, signature, at: outcome.at, active: !outcome.ok });
    if (state.history.length > MAX_OUTCOMES) state.history.shift();
    const retained = new Set(state.history.map((entry) => entry.signature));
    for (const steered of state.steered) if (!retained.has(steered)) state.steered.delete(steered);
    if (signature === null) return null;

    let consecutive = 0;
    for (let i = state.history.length - 1; i >= 0; i--) {
      const previous = state.history[i]!;
      if (!previous.active || previous.signature !== signature) break;
      consecutive++;
    }
    const inWindow = state.history.filter((entry) => entry.active && entry.signature === signature &&
      entry.at > state.lastAt - this.windowMs).length;
    const alternating = this.alternating(state.history);
    if (consecutive < this.consecutiveThreshold && inWindow < this.windowThreshold && !alternating) {
      return null;
    }

    // Keep outcomes in place so resets and trips remain barriers between runs.
    const tripped = new Set([signature]);
    if (alternating) tripped.add(state.history.at(-2)!.signature!);
    const warned = [...tripped].some((entry) => state.steered.has(entry));
    for (const previous of state.history) if (previous.signature !== null && tripped.has(previous.signature)) previous.active = false;
    for (const entry of tripped) state.steered.add(entry);
    const subject = failingCalls(state.history, tripped);
    if (warned) {
      return { kind: 'stop', reason: `The ${subject} keeps failing after a request to change approach. Stop and report the problem.` };
    }
    return { kind: 'steer', message: `The ${subject} keeps failing. Change your approach or report the problem.` };
  }

  /** Also called by record; an idle guard needs no timer. */
  sweep(at: number): void {
    for (const [agentId, state] of this.agents) if (at - state.lastAt >= IDLE_MS) this.agents.delete(agentId);
  }

  private alternating(history: readonly RecentOutcome[]): boolean {
    if (history.length < 6) return false;
    const tail = history.slice(-6);
    const first = tail[0]!.signature;
    const second = tail[1]!.signature;
    if (first === null || second === null || first === second) return false;
    return tail.every((entry, i) => entry.active && entry.signature === (i % 2 === 0 ? first : second));
  }
}
