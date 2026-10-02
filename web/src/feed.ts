import type { FeedCard } from '../../shared/protocol';

// For you: small helpers shared by the inbox and the For-you sheet.

/** New cards first, then the ones you've seen; newest first within each. */
export function sortCards(cards: FeedCard[]): FeedCard[] {
  return [...cards].sort((a, b) => Number(b.status === 'new') - Number(a.status === 'new') || b.createdAt - a.createdAt);
}

/** "Back at 3:40 PM" / "Back tomorrow at 7:00 AM". */
export function backLabel(until: number, now = Date.now()): string {
  const at = new Date(until);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return new Date(now).toDateString() === at.toDateString() ? `Back at ${time}` : `Back tomorrow at ${time}`;
}

export function newCount(feed: Record<string, FeedCard> | null): number {
  return feed ? Object.values(feed).filter((c) => c.status === 'new').length : 0;
}
