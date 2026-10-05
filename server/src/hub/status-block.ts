// The forced status report a task renders: a fixed-shape block built only
// from the task's own fields. The agent supplies no free text; its strings
// are cleaned of invisible characters and capped.

import { INVISIBLE } from '../../../shared/invisible.js';

export const TASK_STATES = ['running', 'blocked', 'waiting', 'done', 'failed', 'cancelled'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const NEXT_STEPS = ['continue work', 'wait for a reply', 'unblock the worker', 'report back', 'stop'] as const;
export type NextStep = (typeof NEXT_STEPS)[number];

export type StatusTask = {
  id: string;
  title: string;
  state: TaskState;
  criteriaMet: number;
  criteriaTotal: number;
  /** Epoch millis when the task started. */
  startedAt: number;
  /** Epoch millis of "now"; the block is a pure function of these numbers. */
  now: number;
  deadline?: number;
  lastEventAt?: number;
  owedCount: number;
  nextStep: NextStep;
};

const MAX_ID = 80;
const MAX_TITLE = 80;

/** Strip the characters that hide or reorder text, then cap the length. */
function clean(text: string, max: number): string {
  return [...text.replace(INVISIBLE, '').replace(/[\u2028\u2029]/gu, '')].slice(0, max).join('');
}

function fixedValue<T extends string>(text: string, values: readonly T[], fallback: T): T {
  const cleaned = clean(text, 80);
  return values.find((value) => value === cleaned) ?? fallback;
}

function count(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${String(rest).padStart(2, '0')}m` : `${rest}m`;
}

/**
 * Render the status block. Same task in, same block out. A state or next
 * step outside the fixed lists falls back to a listed value, so the block
 * never carries agent-supplied free text.
 */
export function statusBlock(task: StatusTask): string {
  const state = fixedValue(task.state, TASK_STATES, 'running');
  const nextStep = fixedValue(task.nextStep, NEXT_STEPS, 'continue work');
  const remaining =
    task.deadline === undefined ? 'n/a' : task.deadline > task.now ? formatDuration(task.deadline - task.now) : 'overdue';
  const lastEvent = task.lastEventAt === undefined ? 'none' : `${formatDuration(task.now - task.lastEventAt)} ago`;
  return [
    `Task: ${clean(task.id, MAX_ID)}`,
    `Title: ${clean(task.title, MAX_TITLE)}`,
    `State: ${state}`,
    `Criteria: ${count(task.criteriaMet)}/${count(task.criteriaTotal)} met`,
    `Elapsed: ${formatDuration(task.now - task.startedAt)}`,
    `Remaining: ${remaining}`,
    `Last event: ${lastEvent}`,
    `Owed: ${count(task.owedCount)}`,
    `Next step: ${nextStep}`,
  ].join('\n');
}
