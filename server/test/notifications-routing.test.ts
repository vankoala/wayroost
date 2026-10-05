import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_EVENTS,
  type NotificationDelivery,
  type NotificationEvent,
  type NotificationRule,
  type NotificationSource,
} from '../../shared/settings.js';
import type { DevicePresence, PresenceState } from '../../shared/protocol.js';
import { decideNotification, desktopPresence, inQuietHours, phonePushAllowed } from '../src/notifications/routing.js';
import type { NotificationSettings } from '../src/notifications/settings.js';

// Where one alert goes: the rule written for it, whoever is at the PC, and the clock.

const NOW = 1_700_000_000_000;
/** A morning in UTC; every local-time case names its zone so the machine's own doesn't matter. */
const DAY = Date.UTC(2024, 0, 15);
const at = (hhmm: string): number => DAY + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))) * 60_000;

const settings = (over: Partial<NotificationSettings> = {}): NotificationSettings => ({
  rules: [],
  quietHours: null,
  push: { approvals: true, cards: true },
  ...over,
});
const rule = (event: NotificationEvent, source: NotificationSource | '*', delivery: NotificationDelivery): NotificationRule =>
  ({ event, source, delivery });
const report = (kind: DevicePresence['kind'], state: PresenceState, ageMs: number): DevicePresence => ({
  device: `dv_${kind}`,
  kind,
  state,
  at: NOW - ageMs,
});

const DESKTOP_STATES: PresenceState[] = ['active', 'idle', 'locked'];

describe('the desktop in front of the alerts', () => {
  it('is gone until it reports', () => {
    expect(desktopPresence([], NOW)).toBe('gone');
  });

  it.each(DESKTOP_STATES)('reports a desktop saying %s 10 seconds ago', (state) => {
    expect(desktopPresence([report('desktop', state, 10_000)], NOW)).toBe(state);
  });

  it('ignores what a phone says: it says nothing about anyone at the PC', () => {
    expect(desktopPresence([report('phone', 'active', 1_000)], NOW)).toBe('gone');
  });

  it('takes the newest desktop when more than one reports', () => {
    const reports = [report('desktop', 'active', 1_000), report('desktop', 'locked', 100)];
    expect(desktopPresence(reports, NOW)).toBe('locked');
  });

  it('stops believing a report two minutes after it was made', () => {
    expect(desktopPresence([report('desktop', 'active', 119_999)], NOW)).toBe('active');
    expect(desktopPresence([report('desktop', 'active', 120_000)], NOW)).toBe('gone');
  });
});


describe('quiet hours', () => {
  it('hold nothing when they are off or a full circle', () => {
    expect(inQuietHours(null, at('23:00'), 'UTC')).toBe(false);
    expect(inQuietHours({ start: '22:00', end: '22:00' }, at('23:00'), 'UTC')).toBe(false);
  });

  it.each([
    ['22:30', true], ['03:00', true], ['21:00', true], ['06:59', true],
    ['20:59', false], ['07:00', false], ['12:00', false], ['17:30', false],
  ])('hours from 9pm to 7am hold %s in UTC: %s', (hhmm, quiet) => {
    expect(inQuietHours({ start: '21:00', end: '07:00' }, at(hhmm), 'UTC')).toBe(quiet);
  });

  it.each([
    ['09:00', true], ['16:59', true], ['12:00', true],
    ['08:59', false], ['17:00', false], ['22:00', false], ['03:00', false],
  ])('hours from 9am to 5pm hold %s in UTC: %s', (hhmm, quiet) => {
    expect(inQuietHours({ start: '09:00', end: '17:00' }, at(hhmm), 'UTC')).toBe(quiet);
  });

  // 20:30 UTC is 22:30 in Berlin.
  const INSTANT = Date.UTC(2024, 6, 1, 20, 30);
  it.each([
    ['22:00', '23:00', 'Europe/Berlin', true],
    ['22:00', '23:00', 'UTC', false],
    ['21:00', '07:00', 'UTC', false],
    ['21:00', '07:00', 'Europe/Berlin', true],
    // UTC and the configured owner clock straddle the start of quiet hours.
    ['21:00', '07:00', 'UTC', false],
  ])('hours from %s to %s are read in %s: %s', (start, end, timeZone, quiet) => {
    expect(inQuietHours({ start, end }, INSTANT, timeZone)).toBe(quiet);
  });
});

describe('the phone switches', () => {
  it('keep approvals and cards off, and say nothing about anything else', () => {
    expect(phonePushAllowed('agent-needs-you', settings({ push: { approvals: false, cards: true } }))).toBe(false);
    expect(phonePushAllowed('feed-card', settings({ push: { approvals: true, cards: false } }))).toBe(false);
    expect(phonePushAllowed('security-card', settings({ push: { approvals: true, cards: false } }))).toBe(false);
    expect(phonePushAllowed('agent-finished', settings({ push: { approvals: false, cards: false } }))).toBe(true);
    expect(phonePushAllowed('mismatch-warning', settings({ push: { approvals: false, cards: false } }))).toBe(true);
    expect(phonePushAllowed('agent-needs-you', settings())).toBe(true);
  });
});

describe('one alert, every rule', () => {
  const table: Array<[NotificationEvent, NotificationDelivery, boolean, boolean]> = [];
  for (const event of NOTIFICATION_EVENTS) {
    for (const delivery of ['toast', 'push', 'both', 'neither'] as NotificationDelivery[]) {
      // An agent waiting on an answer always keeps the app: a rule that says the phone
      // alone still reaches it, and one that says nowhere leaves the app showing it.
      const needsAnswer = event === 'agent-needs-you';
      // An agent waiting on an answer always keeps the app: a rule that says the phone
      // alone also reaches it, and one that says nowhere leaves the app showing it.
      const effect: NotificationDelivery = !needsAnswer
        ? delivery
        : delivery === 'neither' ? 'toast' : delivery === 'push' ? 'both' : delivery;
      const toast = effect === 'toast' || effect === 'both';
      const push = effect === 'push';
      table.push([event, delivery, toast, push]);
    }
  }

  it.each(table)('%s with a rule of %s reaches the app: %s and the phone: %s', (event, delivery, toast, push) => {
    const decision = decideNotification(event, 'hermes', settings({ rules: [rule(event, '*', delivery)] }), 'active', at('12:00'), 'UTC');
    expect([decision.toast, decision.push]).toEqual([toast, push]);
    expect(decision.quiet).toBe(false);
    expect(decision.switchedOff).toBe(false);
    expect(decision.needsYou).toBe(event === 'agent-needs-you');
  });

  it('says what the rules picked, before presence and quiet hours had their say', () => {
    const decided = decideNotification('agent-finished', 'hermes', settings({ rules: [rule('agent-finished', '*', 'toast')] }), 'gone', at('12:00'), 'UTC');
    expect(decided.delivery).toBe('toast');
    expect(decided.toast).toBe(false);
    expect(decided.push).toBe(true);
  });

  it('goes nowhere at all when nothing is asked for', () => {
    const decided = decideNotification('agent-error', 'paseo', settings(), 'active', at('12:00'), 'UTC');
    expect(decided).toMatchObject({ toast: false, push: false, delivery: 'neither', quiet: false });
  });

  it('reaches you by default when an agent waits, with no rules written', () => {
    const decided = decideNotification('agent-needs-you', 'paseo', settings(), 'active', at('12:00'), 'UTC');
    expect([decided.toast, decided.push, decided.delivery]).toEqual([true, false, 'both']);
  });

  it.each(['hermes', 'paseo', 'brief', 'scout', 'agent', 'supervisor'] as NotificationSource[])(
    'lets a rule for %s answer for that source alone', (source) => {
      const rules = [rule('agent-finished', '*', 'neither'), rule('agent-finished', source, 'both')];
      const picked = decideNotification('agent-finished', source, settings({ rules }), 'active', at('12:00'), 'UTC');
      expect([picked.toast, picked.push]).toEqual([true, false]);
      const other = NOTIFICATION_EVENTS.length > 0 && ['hermes', 'paseo', 'brief', 'scout', 'agent', 'supervisor'].find((one) => one !== source)!;
      const untouched = decideNotification('agent-finished', other as NotificationSource, settings({ rules }), 'active', at('12:00'), 'UTC');
      expect([untouched.toast, untouched.push]).toEqual([false, false]);
    },
  );
});

describe('who is at the PC', () => {
  it('keeps default approvals off the phone while the desktop is active', () => {
    const decided = decideNotification('agent-needs-you', 'hermes', settings(), 'active', at('12:00'), 'UTC');
    expect([decided.toast, decided.push]).toEqual([true, false]);
  });

  it('keeps the legacy card switch for a source no rule matches', () => {
    const rules = [rule('feed-card', 'brief', 'neither')];
    expect(decideNotification('feed-card', 'brief', settings({ rules }), 'active', at('12:00'), 'UTC').push).toBe(false);
    expect(decideNotification('feed-card', 'scout', settings({ rules }), 'active', at('12:00'), 'UTC').push).toBe(true);
    rules.push(rule('feed-card', '*', 'neither'));
    expect(decideNotification('feed-card', 'scout', settings({ rules }), 'active', at('12:00'), 'UTC').push).toBe(false);
  });
  const toastOnly = settings({ rules: [rule('agent-finished', '*', 'toast')] });

  it('stops at the app while the desktop is active', () => {
    const decided = decideNotification('agent-finished', 'hermes', toastOnly, 'active', at('12:00'), 'UTC');
    expect([decided.toast, decided.push]).toEqual([true, false]);
  });

  it.each(DESKTOP_STATES.filter((state) => state !== 'active'))(
    'adds the phone when the desktop says %s, and shows the toast as well', (state) => {
      const decided = decideNotification('agent-finished', 'hermes', toastOnly, state, at('12:00'), 'UTC');
      expect([decided.toast, decided.push]).toEqual([true, true]);
    },
  );

  it('uses the phone alone once the desktop has stopped reporting', () => {
    const decided = decideNotification('agent-finished', 'hermes', toastOnly, 'gone', at('12:00'), 'UTC');
    expect([decided.toast, decided.push]).toEqual([false, true]);
  });

  it('never lets the phone switches add a push that was switched off', () => {
    const off = settings({ rules: [rule('agent-finished', '*', 'toast')], push: { approvals: true, cards: true } });
    const decided = decideNotification('feed-card', 'brief', settings({ rules: [rule('feed-card', '*', 'toast')], push: { approvals: true, cards: false } }), 'idle', at('12:00'), 'UTC');
    expect([decided.toast, decided.push, decided.switchedOff]).toEqual([true, false, true]);
    expect(decideNotification('agent-finished', 'hermes', off, 'locked', at('12:00'), 'UTC').push).toBe(true);
  });

  it('keeps an alert that waits on a person in the app even with no desktop there', () => {
    const off = settings({ rules: [rule('agent-needs-you', '*', 'neither')], push: { approvals: false, cards: false } });
    const decided = decideNotification('agent-needs-you', 'hermes', off, 'gone', at('12:00'), 'UTC');
    expect([decided.toast, decided.push]).toEqual([true, false]);

    const allowed = settings({ rules: [rule('agent-needs-you', '*', 'neither')] });
    const withPhone = decideNotification('agent-needs-you', 'hermes', allowed, 'gone', at('12:00'), 'UTC');
    expect([withPhone.toast, withPhone.push]).toEqual([true, true]);
  });

  it('says the phone was switched out of an alert the rules wanted to send', () => {
    const decided = decideNotification('agent-needs-you', 'hermes', settings({ push: { approvals: false, cards: true } }), 'active', at('12:00'), 'UTC');
    expect([decided.toast, decided.push, decided.switchedOff]).toEqual([true, false, true]);
  });
});

describe('quiet hours over the alerts', () => {
  const quiet = { start: '21:00', end: '07:00' };

  it('hold a For-you card and a security card', () => {
    for (const event of ['feed-card', 'security-card'] as NotificationEvent[]) {
      const decided = decideNotification(event, 'brief', settings({ rules: [rule(event, '*', 'both')], quietHours: quiet }), 'idle', at('22:30'), 'UTC');
      expect([event, decided.toast, decided.push, decided.quiet]).toEqual([event, true, false, true]);
    }
  });

  it('hold a card whose push the desktop away for would have added', () => {
    const decided = decideNotification('feed-card', 'scout', settings({ rules: [rule('feed-card', '*', 'toast')], quietHours: quiet }), 'idle', at('22:30'), 'UTC');
    expect([decided.toast, decided.push, decided.quiet]).toEqual([true, false, true]);
  });

  it('never hold one that waits on a person', () => {
    const decided = decideNotification('agent-needs-you', 'hermes', settings({ rules: [rule('agent-needs-you', '*', 'both')], quietHours: quiet }), 'idle', at('22:30'), 'UTC');
    expect([decided.toast, decided.push, decided.quiet]).toEqual([true, true, false]);
  });

  it('never hold a run that finished or failed, or a change or a warning', () => {
    for (const event of ['agent-finished', 'agent-error', 'settings-applied', 'settings-failed', 'mismatch-warning', 'stack-status'] as NotificationEvent[]) {
      const decided = decideNotification(event, 'hermes', settings({ rules: [rule(event, '*', 'both')], quietHours: quiet }), 'idle', at('03:00'), 'UTC');
      expect([event, decided.push, decided.quiet]).toEqual([event, true, false]);
    }
  });

  it('let everything through outside them, and when they are off', () => {
    const inside = decideNotification('feed-card', 'brief', settings({ rules: [rule('feed-card', '*', 'push')], quietHours: quiet }), 'active', at('07:00'), 'UTC');
    expect([inside.push, inside.quiet]).toEqual([true, false]);
    const off = decideNotification('feed-card', 'brief', settings({ rules: [rule('feed-card', '*', 'push')] }), 'active', at('22:30'), 'UTC');
    expect([off.push, off.quiet]).toEqual([true, false]);
  });

  it('are read in the owner’s zone, not this machine’s', () => {
    const rules = [rule('feed-card', '*', 'both')];
    const instant = Date.UTC(2024, 6, 1, 20, 30); // 20:30 UTC is 22:30 in Berlin.
    const clock = (timeZone: string) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);
    expect(clock('Europe/Berlin')).toBe('22:30');
    expect(clock('UTC')).toBe('20:30');
    const atHome = decideNotification('feed-card', 'brief', settings({ rules, quietHours: { start: '21:00', end: '07:00' } }), 'idle', instant, 'Europe/Berlin');
    const elsewhere = decideNotification('feed-card', 'brief', settings({ rules, quietHours: { start: '21:00', end: '07:00' } }), 'idle', instant, 'UTC');
    expect([atHome.push, atHome.quiet]).toEqual([false, true]);
    expect([elsewhere.push, elsewhere.quiet]).toEqual([true, false]);
  });
});
