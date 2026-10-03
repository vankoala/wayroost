import type { SupervisorStatus } from '../../shared/supervisor.js';
export function trayState(status: SupervisorStatus, needsYou: number) {
  return { badge: status.overall === 'down' ? '×' : status.overall === 'attention' || needsYou > 0 ? '!' : '',
    color: status.overall === 'down' ? '#a8432f' : '#b4472a', sentence: status.sentence };
}
/** The app's own view of the server: its approval socket, and whether the window could load. */
export type Link = 'connecting' | 'connected' | 'reconnecting' | 'down';
const RANK = { ok: 0, attention: 1, down: 2 } as const;
const OWN: Record<Link, Pick<SupervisorStatus, 'overall' | 'sentence'>> = {
  connected: { overall: 'ok', sentence: 'Wayroost is running.' },
  connecting: { overall: 'attention', sentence: 'Connecting to Wayroost.' },
  reconnecting: { overall: 'attention', sentence: 'Reconnecting to Wayroost.' },
  down: { overall: 'down', sentence: 'Wayroost is not answering.' },
};
/**
 * Health for the tray: the supervisor's status when the rescue listener answers, made worse (never
 * better) by what the app itself sees; without the supervisor (no rescue key yet, or it is
 * unreachable), the app's own connection alone, so a working app never shows a stale "down".
 */
export function healthStatus(supervisor: SupervisorStatus | undefined, link: Link, now = Date.now(), shadow = false): SupervisorStatus {
  const own = shadow && link === 'connected' ? { ...OWN[link], sentence: 'Wayroost is attached to a shadow. Notifications are off.' } : OWN[link];
  if (!supervisor) return { ...own, components: [], at: now };
  const result = RANK[own.overall] > RANK[supervisor.overall] ? { ...supervisor, ...own } : supervisor;
  return shadow && link === 'connected' ? { ...result, sentence: `${result.sentence} Attached to a shadow; notifications are off.` } : result;
}
