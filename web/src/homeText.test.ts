import { describe, expect, it } from 'vitest';
import type { Approval } from '../../shared/protocol';
import { dateLine, greeting, homeSummary, needsCaption, PLACEHOLDER_CAPTION, workingCaption } from './homeText';

const ask = (kind: Approval['kind']): Approval => ({
  id: `ask-${kind}`,
  source: 'hermes',
  conversationId: 'hermes-chat-1',
  kind,
  title: 'Run a shell command',
  options: [],
  createdAt: 1,
});

const at = (hour: number, minute = 0) => new Date(2026, 9, 30, hour, minute);

describe('the words on Home', () => {
  it('greets by the time of day, and never invents a name', () => {
    expect(greeting(at(7, 30))).toBe('Good morning');
    expect(greeting(at(11, 59))).toBe('Good morning');
    expect(greeting(at(12))).toBe('Good afternoon');
    expect(greeting(at(16, 59))).toBe('Good afternoon');
    expect(greeting(at(17))).toBe('Good evening');
    expect(greeting(at(23))).toBe('Good evening');
  });

  it('writes the date as a line, not a timestamp', () => {
    const line = dateLine(at(9));
    expect(line).toContain('Friday');
    expect(line).toContain('30');
    expect(line).toContain('October');
    expect(line).not.toMatch(/\d{4}|\d{1,2}:\d{2}/);
  });

  it('says where you stand, in countable words', () => {
    expect(homeSummary({ needsYou: 0, working: 0 })).toBe(
      'Nothing needs you right now. Nothing is running on its own.',
    );
    expect(homeSummary({ needsYou: 1, working: 3 })).toBe(
      'One thing needs you. Three tasks are moving on their own.',
    );
    expect(homeSummary({ needsYou: 2, working: 1 })).toBe(
      'Two things need you. One task is moving on its own.',
    );
    expect(homeSummary({ needsYou: 9, working: 0 })).toBe('9 things need you. Nothing is running on its own.');
  });

  it('names what is waiting on the Needs you tile', () => {
    expect(needsCaption([])).toBe('Nothing waiting');
    expect(needsCaption([ask('permission'), ask('question'), ask('question'), ask('secret')])).toBe(
      '1 approval, 2 questions, 1 password',
    );
  });

  it('says how much is running on the Working now tile', () => {
    expect(workingCaption(0)).toBe('Quiet at the moment');
    expect(workingCaption(1)).toBe('1 chat on their own');
    expect(workingCaption(4)).toBe('4 chats on their own');
  });

  it('has one honest caption for a tile that has no data yet', () => {
    expect(PLACEHOLDER_CAPTION).toBe('Shows here when it has data');
  });
});
