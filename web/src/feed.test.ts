import { describe, expect, it } from 'vitest';
import type { FeedCard } from '../../shared/protocol';
import { backLabel, newCount, sortCards } from './feed';

const card = (id: string, status: FeedCard['status'], createdAt: number): FeedCard => ({
  id,
  key: `mail:${id}`,
  source: 'brief',
  kind: 'reply',
  title: id,
  createdAt,
  updatedAt: createdAt,
  status,
});

describe('For you helpers', () => {
  it('puts new cards first, newest first within each group', () => {
    const sorted = sortCards([card('old-seen', 'seen', 1), card('new-old', 'new', 2), card('seen-new', 'seen', 5), card('new-new', 'new', 4)]);
    expect(sorted.map((c) => c.id)).toEqual(['new-new', 'new-old', 'seen-new', 'old-seen']);
  });

  it('counts only new cards, and nothing when For you is off', () => {
    expect(newCount({ a: card('a', 'new', 1), b: card('b', 'seen', 1) })).toBe(1);
    expect(newCount(null)).toBe(0);
  });

  it('says when a put-off card comes back', () => {
    const now = new Date(2026, 9, 2, 12, 0).getTime();
    expect(backLabel(new Date(2026, 9, 2, 15, 0).getTime(), now)).toMatch(/^Back at 3:00/);
    expect(backLabel(new Date(2026, 9, 3, 7, 0).getTime(), now)).toMatch(/^Back tomorrow at 7:00/);
  });
});
