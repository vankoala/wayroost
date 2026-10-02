import { describe, expect, it } from 'vitest';
import type { ControlOption, ConversationControl } from '../../shared/protocol';
import { chipText, contextShare, formatTokens, pickerGroups } from './controls';

const models: ControlOption[] = [
  { id: '["anthropic","claude-sonnet-5"]', label: 'claude-sonnet-5', group: 'Anthropic', description: '$3 in · $15 out per M tokens' },
  { id: '["openai","gpt-5"]', label: 'gpt-5', group: 'OpenAI', description: '$1.25 in · $10 out per M tokens' },
  { id: '["anthropic","claude-haiku-5"]', label: 'claude-haiku-5', group: 'Anthropic', description: 'Fast and cheap' },
  { id: 'local', label: 'llama-local' },
];

const control = (value: string | null, extra: Partial<ConversationControl> = {}): ConversationControl => ({
  id: 'model',
  label: 'Model',
  value,
  options: models,
  ...extra,
});

describe('chipText', () => {
  it('shows the picked option', () => {
    expect(chipText(control('["openai","gpt-5"]'))).toBe('gpt-5');
  });

  it('falls back to what the backend says is in use, then the setting name', () => {
    expect(chipText(control(null, { valueLabel: 'claude-sonnet-4' }))).toBe('claude-sonnet-4');
    expect(chipText(control('["gone","model"]', { valueLabel: 'model' }))).toBe('model');
    expect(chipText(control(null))).toBe('Model');
  });
});

describe('formatTokens', () => {
  it.each([
    [950, '950'],
    [18_200, '18.2k'],
    [42_700, '42.7k'],
    [200_000, '200k'],
    [999_999, '1M'],
    [1_048_576, '1M'],
    [2_500_000, '2.5M'],
  ])('%d → %s', (n, text) => expect(formatTokens(n)).toBe(text));
});

describe('contextShare', () => {
  it('rounds and clamps to 0–100', () => {
    expect(contextShare({ used: 42_700, max: 200_000 })).toBe(21);
    expect(contextShare({ used: 250_000, max: 200_000 })).toBe(100);
    expect(contextShare({ used: 10, max: 0 })).toBe(0);
  });
});

describe('pickerGroups', () => {
  it('keeps the backend order of sections and options', () => {
    expect(pickerGroups(models).map((g) => [g.label, g.options.map((o) => o.label)])).toEqual([
      ['Anthropic', ['claude-sonnet-5', 'claude-haiku-5']],
      ['OpenAI', ['gpt-5']],
      [null, ['llama-local']],
    ]);
  });

  it('filters on name, description and section, ignoring case', () => {
    expect(pickerGroups(models, 'HAIKU').flatMap((g) => g.options.map((o) => o.label))).toEqual(['claude-haiku-5']);
    expect(pickerGroups(models, 'cheap').flatMap((g) => g.options.map((o) => o.label))).toEqual(['claude-haiku-5']);
    expect(pickerGroups(models, 'openai').map((g) => g.label)).toEqual(['OpenAI']);
    expect(pickerGroups(models, 'nothing like it')).toEqual([]);
  });
});
