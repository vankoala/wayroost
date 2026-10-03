// The words on Home. Written from counts the app already
// has — never from a model — so the summary cannot say something that isn't true.

import type { Approval } from '../../shared/protocol';

/** "Good morning" with no name: the app is yours, and it knows it. */
export function greeting(at: Date = new Date()): string {
  const hour = at.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** "Tuesday, 30 September" — the date above the greeting, in the browser's language. */
export function dateLine(at: Date = new Date()): string {
  return at.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five'];
const word = (n: number) => WORDS[n] ?? String(n);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * One line that says where you stand: "Two things need you. Three tasks are moving on their own."
 */
export function homeSummary(counts: { needsYou: number; working: number }): string {
  const parts: string[] = [];
  parts.push(
    counts.needsYou === 0
      ? 'Nothing needs you right now.'
      : `${word(counts.needsYou)} ${counts.needsYou === 1 ? 'thing needs' : 'things need'} you.`,
  );
  parts.push(
    counts.working === 0
      ? 'Nothing is running on its own.'
      : `${word(counts.working)} ${counts.working === 1 ? 'task is moving on its own.' : 'tasks are moving on their own.'}`,
  );
  return parts.join(' ');
}

/** Tile caption for Needs you: what kind of things are waiting ("1 approval, 1 question"). */
export function needsCaption(approvals: readonly Approval[]): string {
  if (approvals.length === 0) return 'Nothing waiting';
  const kinds = [
    ['permission', 'approval', 'approvals'],
    ['question', 'question', 'questions'],
    ['secret', 'password', 'passwords'],
  ] as const;
  const parts: string[] = [];
  for (const [kind, one, many] of kinds) {
    const n = approvals.filter((a) => a.kind === kind).length;
    if (n) parts.push(plural(n, one, many));
  }
  return parts.join(', ');
}

/** Tile caption for Working now. */
export function workingCaption(running: number): string {
  return running === 0 ? 'Quiet at the moment' : `${plural(running, 'chat', 'chats')} on their own`;
}

/** Caption for a tile that has no data yet. */
export const PLACEHOLDER_CAPTION = 'Shows here when it has data';
