import { describe, expect, it } from 'vitest';
import type { SlashCommand } from '../../shared/protocol';
import {
  acceptCommand,
  acceptOption,
  clampOutput,
  commandLabel,
  filterOptions,
  findCommand,
  plainOutput,
  rankCommands,
  slashContext,
  slashMenu,
  splitCommand,
} from './slash';

const catalog: SlashCommand[] = [
  { name: 'new', kind: 'command', group: 'Session', description: 'Start a new chat', aliases: ['reset', 'clear'], action: 'new' },
  { name: 'compress', kind: 'command', group: 'Session', description: 'Compress conversation context', aliases: ['compact'] },
  { name: 'status', kind: 'command', group: 'Session', description: 'Show session, model and context info' },
  { name: 'reasoning', kind: 'command', group: 'Configuration', args: '[level]', options: ['none', 'low', 'medium', 'high', 'xhigh'] },
  { name: 'model', kind: 'command', group: 'Configuration', description: 'Switch model for this chat' },
  { name: 'plan', kind: 'skill', description: 'Write an implementation plan' },
  { name: 'code-review', kind: 'skill', description: 'Review the current diff' },
  { name: 'help', kind: 'command', description: 'List commands' },
];

const names = (query: string) => rankCommands(catalog, query).map((m) => m.command.name);

describe('slashContext', () => {
  it('opens while the cursor is in the first word', () => {
    expect(slashContext('/', 1)).toEqual({ stage: 'command', query: '', start: 0, end: 1 });
    expect(slashContext('/comp', 5)).toMatchObject({ stage: 'command', query: 'comp', end: 5 });
    // Query is what's left of the cursor; the whole word gets replaced.
    expect(slashContext('/compress now', 5)).toMatchObject({ stage: 'command', query: 'comp', end: 9 });
  });

  it('stays closed for ordinary text and paths', () => {
    expect(slashContext('hello /status', 13)).toBeNull();
    expect(slashContext('/home/me/notes.txt', 5)).toBeNull();
    expect(slashContext('/status', 0)).toBeNull();
  });

  it('moves to the first argument after a space', () => {
    expect(slashContext('/reasoning ', 11)).toEqual({ stage: 'option', name: 'reasoning', query: '', start: 11, end: 11 });
    expect(slashContext('/reasoning hi', 13)).toMatchObject({ stage: 'option', query: 'hi', start: 11, end: 13 });
    expect(slashContext('/reasoning high now', 19)).toBeNull();
    expect(slashContext('/reasoning\nhigh', 15)).toBeNull();
  });
});

describe('rankCommands', () => {
  it('ranks exact > name prefix > alias prefix > substring > description word', () => {
    // reasoning (name prefix), new via "reset" (alias prefix), compress and code-review (substring).
    expect(names('re')).toEqual(['reasoning', 'new', 'compress', 'code-review']);
    expect(rankCommands(catalog, 're').map((m) => m.rank)).toEqual([1, 2, 3, 3]);
  });

  it('matches aliases exactly and says which alias matched', () => {
    const [first] = rankCommands(catalog, 'compact');
    expect(first).toMatchObject({ rank: 0, alias: 'compact', command: { name: 'compress' } });
  });

  it('is case-insensitive and keeps catalog order for ties', () => {
    expect(names('STAT')).toEqual(['status']);
    expect(names('')).toEqual(catalog.map((c) => c.name));
  });

  it('falls back to words in the description', () => {
    expect(names('diff')).toEqual(['code-review']);
    expect(names('xyz')).toEqual([]);
  });
});

describe('slashMenu', () => {
  it('groups commands before skills, with the best match first', () => {
    const menu = slashMenu('/', 1, catalog);
    expect(menu?.stage === 'command' && menu.groups.map((g) => g.label)).toEqual(['Session', 'Configuration', 'Commands', 'Skills']);
    const plan = slashMenu('/plan', 5, catalog);
    expect(plan?.stage === 'command' && plan.groups[0]!.label).toBe('Skills');
  });

  it('filters to one command', () => {
    const menu = slashMenu('/comp', 5, catalog);
    expect(menu?.stage === 'command' && menu.groups.flatMap((g) => g.matches.map((m) => m.command.name))).toEqual(['compress']);
  });

  it('shows loose matches only when nothing closer matches', () => {
    const shown = (text: string) => {
      const menu = slashMenu(text, text.length, catalog);
      return menu?.stage === 'command' ? menu.groups.flatMap((g) => g.matches.map((m) => m.command.name)) : [];
    };
    expect(shown('/re')).toEqual(['reasoning', 'new']);
    expect(shown('/view')).toEqual(['code-review']);
  });

  it('offers argument values for known commands only', () => {
    expect(slashMenu('/reasoning ', 11, catalog)).toMatchObject({ stage: 'option', options: ['none', 'low', 'medium', 'high', 'xhigh'] });
    expect(slashMenu('/reasoning hi', 13, catalog)).toMatchObject({ options: ['high', 'xhigh'] });
    expect(slashMenu('/status ', 8, catalog)).toBeNull();
    expect(slashMenu('/zzz', 4, catalog)).toBeNull();
  });
});

describe('editing', () => {
  it('inserts the command name and a space', () => {
    const compress = findCommand(catalog, 'compress')!;
    expect(acceptCommand('/comp', { end: 5 }, compress)).toEqual({ text: '/compress ', cursor: 10 });
    expect(acceptCommand('/comp the rest', { end: 5 }, compress)).toEqual({ text: '/compress the rest', cursor: 10 });
    expect(acceptCommand('/co\nnext line', { end: 3 }, compress)).toEqual({ text: '/compress \nnext line', cursor: 10 });
  });

  it('inserts an argument value', () => {
    expect(acceptOption('/reasoning hi', { start: 11, end: 13 }, 'high')).toEqual({ text: '/reasoning high', cursor: 15 });
  });

  it('finds commands by name or alias', () => {
    expect(findCommand(catalog, 'RESET')?.name).toBe('new');
    expect(findCommand(catalog, '/status')?.name).toBe('status');
    expect(findCommand(catalog, '')).toBeUndefined();
  });

  it('splits a command from its arguments', () => {
    expect(splitCommand('/new fix the login test')).toEqual({ name: 'new', rest: 'fix the login test' });
    expect(splitCommand('/stop')).toEqual({ name: 'stop', rest: '' });
    expect(splitCommand('/home/me/file.txt what is this')).toBeNull();
    expect(splitCommand('hello')).toBeNull();
    expect(commandLabel('compress focus on tests')).toBe('/compress');
  });

  it('filters argument values by prefix, then substring', () => {
    expect(filterOptions(['low', 'high', 'xhigh', 'highest'], 'HIGH')).toEqual(['high', 'highest', 'xhigh']);
  });
});

describe('command output', () => {
  it('strips colours, escapes and control characters', () => {
    expect(plainOutput('\x1b[1;32mOK\x1b[0m done\x1b(B\x1b[m\x07')).toBe('OK done');
    expect(plainOutput('\x1b]0;title\x07\x1b]8;;https://x.example\x1b\\link\x1b]8;;\x1b\\')).toBe('link');
  });

  it('keeps what a terminal would show after carriage returns', () => {
    expect(plainOutput('Compressing 10%\rCompressing 100%\r\nDone\r\n\n')).toBe('Compressing 100%\nDone');
  });

  it('clamps long output but never hides just a line or two', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
    expect(clampOutput(lines(14))).toMatchObject({ clamped: false, lines: 14 });
    const long = clampOutput(lines(30));
    expect(long).toMatchObject({ clamped: true, lines: 30 });
    expect(long.text.split('\n')).toHaveLength(12);
    expect(clampOutput('x'.repeat(5000)).text).toHaveLength(1201);
  });
});
