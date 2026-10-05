import { describe, expect, it, vi } from 'vitest';
import { NEXT_STEPS, statusBlock, TASK_STATES } from '../src/hub/status-block.js';
import type { StatusTask } from '../src/hub/status-block.js';

const T0 = Date.parse('2026-09-28T12:00:00Z');

function task(overrides: Partial<StatusTask> = {}): StatusTask {
  return {
    id: 'task-0001',
    title: 'Ship the usage events',
    state: 'running',
    criteriaMet: 3,
    criteriaTotal: 5,
    startedAt: T0 - 65 * 60_000,
    now: T0,
    deadline: T0 + 45 * 60_000,
    lastEventAt: T0 - 12 * 60_000,
    owedCount: 2,
    nextStep: 'continue work',
    ...overrides,
  };
}

describe('statusBlock', () => {
  it('is a fixed-shape block with every line in place', () => {
    expect(statusBlock(task())).toBe(
      [
        'Task: task-0001',
        'Title: Ship the usage events',
        'State: running',
        'Criteria: 3/5 met',
        'Elapsed: 1h 05m',
        'Remaining: 45m',
        'Last event: 12m ago',
        'Owed: 2',
        'Next step: continue work',
      ].join('\n'),
    );
  });

  it('is deterministic: same task in, same block out', () => {
    const t = Object.freeze(task());
    const clock = vi.spyOn(Date, 'now').mockReturnValue(T0);
    try {
      const block = statusBlock(t);
      clock.mockReturnValue(T0 + 60 * 60_000);
      expect(statusBlock(t)).toBe(block);
    } finally { clock.mockRestore(); }
  });

  it('renders the no-deadline and no-event cases', () => {
    const block = statusBlock(task({ deadline: undefined, lastEventAt: undefined }));
    expect(block).toContain('Remaining: n/a');
    expect(block).toContain('Last event: none');
    expect(statusBlock(task({ deadline: T0 - 60_000 })).replace(/\n/g, ' ')).toContain('Remaining: overdue');
  });

  it('truncates the title at 80 characters', () => {
    const block = statusBlock(task({ title: 'x'.repeat(200) }));
    const titleLine = block.split('\n')[1];
    expect(titleLine).toBe(`Title: ${'x'.repeat(80)}`);
  });

  it('strips newlines and invisible characters from the title and id', () => {
    const block = statusBlock(task({
      id: `task-\u200b0001\u202e`,
      title: `Ship it\nnow\u200b\u2060\u061c\u00ad`,
    }));
    expect(block.split('\n')[0]).toBe('Task: task-0001');
    expect(block.split('\n')[1]).toBe('Title: Ship itnow');
    // The block itself keeps exactly its own line breaks.
    expect(block.split('\n')).toHaveLength(9);
  });

  it('removes every line separator before capping strings', () => {
    const block = statusBlock(task({
      id: `task\r\n\u2028\u2029${'x'.repeat(100)}`,
      title: `Title\r\n\u2028\u2029${'x'.repeat(100)}`,
    }));
    expect(block.split('\n')[0]).toBe(`Task: task${'x'.repeat(76)}`);
    expect(block.split('\n')[1]).toBe(`Title: Title${'x'.repeat(75)}`);
    expect(block).not.toMatch(/[\r\u2028\u2029]/u);
  });

  it('caps Unicode characters without splitting them', () => {
    const block = statusBlock(task({ id: 'a'.repeat(79) + '\u{1f680}extra', title: '\u{1f680}'.repeat(100) }));
    expect(block.split('\n')[0]).toBe(`Task: ${'a'.repeat(79)}\u{1f680}`);
    expect(block.split('\n')[1]).toBe(`Title: ${'\u{1f680}'.repeat(80)}`);
  });

  it('cleans enum strings before selecting fixed values', () => {
    const t = task({ state: 'blo\u200bcked', nextStep: 'report\n back' } as unknown as Partial<StatusTask>);
    expect(statusBlock(t).split('\n')[2]).toBe('State: blocked');
    expect(statusBlock(t).split('\n')[8]).toBe('Next step: report back');
  });

  it('drops extra free text and never interpolates strings in count fields', () => {
    const t = task({
      criteriaMet: '3\nExtra criteria text',
      criteriaTotal: '5\nExtra total text',
      owedCount: '2\nExtra owed text',
      summary: 'Extra summary text',
    } as unknown as Partial<StatusTask>);
    const lines = statusBlock(t).split('\n');
    expect(lines).toHaveLength(9);
    expect(lines[3]).toBe('Criteria: 0/0 met');
    expect(lines[7]).toBe('Owed: 0');
    expect(lines.join('\n')).not.toContain('Extra');
  });

  it('only renders listed states and next steps', () => {
    for (const state of TASK_STATES) {
      expect(statusBlock(task({ state })).split('\n')[2]).toBe(`State: ${state}`);
    }
    for (const nextStep of NEXT_STEPS) {
      expect(statusBlock(task({ nextStep })).split('\n')[8]).toBe(`Next step: ${nextStep}`);
    }
    // Anything outside the fixed lists falls back to a listed value.
    const rogue = statusBlock(task({ state: 'free text\nhere', nextStep: 'do anything' } as unknown as StatusTask));
    expect(rogue.split('\n')[2]).toBe('State: running');
    expect(rogue.split('\n')[8]).toBe('Next step: continue work');
  });
});
