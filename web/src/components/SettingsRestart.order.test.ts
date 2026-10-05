import { describe, expect, it } from 'vitest';
import type { DrainRestartRun } from '../../../shared/supervisor-config.js';
import { supersedes } from './SettingsRestart.js';

const runA: DrainRestartRun = { id: '00000000-0000-4000-8000-00000000000a', component: 'hermes', when: 'idle', state: 'waiting', startedAt: 10, attempts: 0, probeAttempts: 0, busy: [], protocol: 1 };
const runB: DrainRestartRun = { ...runA, id: '00000000-0000-4000-8000-00000000000b', startedAt: 20 };
const ended = (run: DrainRestartRun): DrainRestartRun => ({ ...run, state: 'done', outcome: 'restarted', endedAt: run.startedAt + 1 });

describe('which observed restart run a control shows', () => {
  it('takes a later run from any source, even before the older run was seen to end', () => {
    for (const source of ['snapshot', 'poll', 'request'] as const) {
      expect(supersedes(runA, runB, source)).toBe(true);
      expect(supersedes(runA, ended(runB), source)).toBe(true);
    }
  });
  it('never lets an older run replace a later one (a delayed request answer)', () => {
    for (const source of ['snapshot', 'poll', 'request'] as const) expect(supersedes(ended(runB), runA, source)).toBe(false);
    expect(supersedes(runB, runA, 'request')).toBe(false);
  });
  it('never takes the end away from a run, and moves a running run only on a fresh poll or its end', () => {
    for (const source of ['snapshot', 'poll', 'request'] as const) expect(supersedes(ended(runA), runA, source)).toBe(false);
    expect(supersedes(runA, { ...runA, state: 'draining' }, 'poll')).toBe(true);
    expect(supersedes({ ...runA, state: 'draining' }, runA, 'request')).toBe(false);
    expect(supersedes({ ...runA, state: 'draining' }, runA, 'snapshot')).toBe(false);
    expect(supersedes(runA, ended(runA), 'snapshot')).toBe(true);
    expect(supersedes(undefined, runA, 'snapshot')).toBe(true);
  });
});
