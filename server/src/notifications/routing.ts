import {
  DESKTOP_GONE_MS,
  isAgentNeedsYouEvent,
  isQuietHeldEvent,
  notificationDelivery,
  type NotificationDelivery,
  type NotificationEvent,
  type NotificationSource,
} from '../../../shared/settings.js';
import type { DevicePresence, PresenceState } from '../../../shared/protocol.js';
import type { NotificationSettings } from './settings.js';

// Where one alert goes. The rule written for its event and source picks the intent, the
// PC's presence decides whether anyone is at the screen to see it, and quiet hours hold the
// push of an alert that can wait. Reading the route changes nothing a person set up.

/**
 * The latest report from the PC's own desktop app. A phone's report says nothing about
 * anyone sitting at the PC, and no report at all in the last two minutes means the desktop
 * isn't there to show a toast.
 */
export function desktopPresence(reports: readonly DevicePresence[], now: number): PresenceState | 'gone' {
  const latest = reports
    .filter((report) => report.kind === 'desktop' && now - report.at < DESKTOP_GONE_MS)
    .reduce<DevicePresence | undefined>((newest, report) => (!newest || report.at > newest.at ? report : newest), undefined);
  return latest?.state ?? 'gone';
}

function localTime(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(at);
}

/**
 * Whether `at` falls in quiet hours, read in the owner's time zone (this machine's when the
 * site file names none). Hours that run past midnight hold the evening and the early morning;
 * a span that starts and ends at the same time holds nothing.
 */
export function inQuietHours(hours: NotificationSettings['quietHours'], at: number, timeZone?: string): boolean {
  if (!hours || hours.start === hours.end) return false;
  const time = localTime(at, timeZone);
  return hours.start < hours.end ? time >= hours.start && time < hours.end : time >= hours.start || time < hours.end;
}

/**
 * Whether this alert may go to the phone at all: the phone's switch over approvals, and
 * the For-you feed's own switch over the cards it holds.
 */
export function phonePushAllowed(event: NotificationEvent, settings: NotificationSettings): boolean {
  if (isAgentNeedsYouEvent(event)) return settings.push.approvals;
  return isQuietHeldEvent(event) ? settings.push.cards : true;
}

/** Where one alert goes, as decided from the settings, the PC's presence and the clock. */
export interface NotificationDecision {
  event: NotificationEvent;
  source: NotificationSource;
  /** The app on the PC shows this one. */
  toast: boolean;
  /** The phone gets this one as a push. */
  push: boolean;
  /** What the rules allowed before presence and quiet hours had their say. */
  delivery: NotificationDelivery;
  /** Quiet hours held the push. */
  quiet: boolean;
  /** A switch kept the phone out of this alert. */
  switchedOff: boolean;
  presence: PresenceState | 'gone';
  /** An agent is waiting on a person: this alert can never go missing. */
  needsYou: boolean;
}

/**
 * One alert's route. The rule says the app, the phone, both or nowhere, and an agent waiting
 * on an answer always keeps the app. A toast for a desktop that is idle or locked also reaches
 * the phone, and one for a desktop that has stopped reporting reaches it instead. Quiet hours
 * hold the push of a card alert, never one that waits on a person.
 */
export function decideNotification(
  event: NotificationEvent,
  source: NotificationSource,
  settings: NotificationSettings,
  presence: PresenceState | 'gone',
  at: number,
  timeZone?: string,
): NotificationDecision {
  const needsYou = isAgentNeedsYouEvent(event);
  let delivery = notificationDelivery(event, source, settings.rules);
  // Before there were rules the For-you page had one switch over its cards. With nothing
  // written for this event that switch still says whether the phone hears about a new card.
  if (event === 'feed-card' && settings.push.cards && !settings.rules.some((rule) => rule.event === event && (rule.source === source || rule.source === '*'))) delivery = 'push';
  const allowed = phonePushAllowed(event, settings);
  let toast = delivery === 'toast' || delivery === 'both';
  let push = (delivery === 'push' || delivery === 'both') && allowed;

  if (toast && presence === 'active') push = false;

  if (toast && presence !== 'active') {
    // Nobody is looking at the screen: let the phone take it too.
    if (allowed) push = true;
    // With no desktop reporting at all, a toast would show for nobody. One that
    // waits on a person keeps it: it must reach the app wherever that is open.
    if (presence === 'gone' && !needsYou) toast = false;
  }

  const quiet = push && isQuietHeldEvent(event) && inQuietHours(settings.quietHours, at, timeZone);
  if (quiet) push = false;
  return {
    event,
    source,
    toast,
    push,
    delivery,
    quiet,
    switchedOff: !allowed && (delivery === 'push' || delivery === 'both' || presence !== 'active'),
    presence,
    needsYou,
  };
}
