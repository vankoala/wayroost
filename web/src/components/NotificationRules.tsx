import { BellRing, LoaderCircle, Moon, Plus, ShieldAlert, Smartphone, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { NotificationSettingsView } from '../../../shared/protocol';
import type {
  NotificationDelivery,
  NotificationEvent,
  NotificationRule,
  NotificationSource,
} from '../../../shared/settings';
import { SettingsTiming } from './SettingsTiming';
import { api, serializeNotificationSettingsSave } from '../api.js';
import { disablePush, enablePush, pushState, type PushState } from '../push';
import { toast } from '../store';

/**
 * Settings → Notifications: which alerts reach the app on this PC, which reach the phone,
 * and which wait. Rules are written per event, for every source or for one of them; a rule
 * for one source answers for that source alone. What isn't covered by a rule goes the way it
 * always has: an agent waiting on you reaches you, and For-you cards follow the card switch.
 */

const EVENTS: Array<{ id: NotificationEvent; label: string; help: string }> = [
  { id: 'agent-needs-you', label: 'An agent needs you', help: 'A permission to allow or a question to answer. Never switched off.' },
  { id: 'agent-finished', label: 'An agent finished', help: 'A run you started has an answer for you.' },
  { id: 'agent-error', label: 'An agent failed', help: 'A run ended with an error or stopped short.' },
  { id: 'feed-card', label: 'For-you card', help: 'A new card from the morning brief or a daytime check.' },
  { id: 'security-card', label: 'Security card', help: 'A sign-in, a device or a permission worth a look.' },
  { id: 'settings-applied', label: 'A change applied', help: 'Something Settings changed took effect.' },
  { id: 'settings-failed', label: 'A change failed', help: 'A change Settings tried did not take effect.' },
  { id: 'mismatch-warning', label: 'A mismatch found', help: 'Two settings that should agree no longer do.' },
  { id: 'stack-status', label: 'This PC', help: 'A service on this PC started or stopped answering.' },
];

const DELIVERIES: Array<{ id: NotificationDelivery; label: string }> = [
  { id: 'both', label: 'The app and the phone' },
  { id: 'toast', label: 'The app only' },
  { id: 'push', label: 'The phone only' },
  { id: 'neither', label: 'Nowhere' },
];

const SOURCES: Array<{ id: NotificationSource | '*'; label: string }> = [
  { id: '*', label: 'Every source' },
  { id: 'hermes', label: 'Hermes' },
  { id: 'paseo', label: 'Paseo' },
  { id: 'brief', label: 'The morning brief' },
  { id: 'scout', label: 'A daytime check' },
  { id: 'agent', label: 'An agent' },
  { id: 'supervisor', label: 'This PC' },
];

const PRESENCE_LINE: Record<NotificationSettingsView['presence'], string> = {
  active: 'You are at this PC, so an alert the app can show stops there.',
  idle: 'The desktop says you stepped away: those alerts go to the phone too.',
  locked: 'The desktop says the screen is locked: those alerts go to the phone too.',
  gone: 'No report from this PC for two minutes: alerts go to the phone instead.',
};

const TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const DEFAULT_QUIET = { start: '21:00', end: '07:00' };
const PUSH_HELP: Record<PushState, string> = {
  'needs-install': 'On iPhone, add Wayroost to your Home Screen first (Share, then Add to Home Screen), and turn this on there.',
  unsupported: "This browser can't show notifications.",
  denied: 'Blocked for this site in the browser settings. Allow notifications there, then come back.',
  off: 'Turn on notifications for this device to receive phone alerts.',
  on: 'This device gets notifications.',
};

/** One row of the editor: a rule being built, or one as stored. */
interface Draft {
  event: NotificationEvent;
  source: NotificationSource | '*';
  delivery: NotificationDelivery;
}

interface RuleDraft extends Draft {
  saved: Draft | null;
}

interface Editor {
  view: NotificationSettingsView | null;
  drafts: RuleDraft[];
}

const sameRule = (a: Draft, b: Draft): boolean => a.event === b.event && a.source === b.source;
const sameDraft = (a: Draft, b: Draft): boolean => sameRule(a, b) && a.delivery === b.delivery;
const asDraft = (rule: Draft): RuleDraft => ({ ...rule, saved: rule });

/** A fresh page's rows, exactly as stored, including an explicitly empty list. */
function draftsFrom(view: NotificationSettingsView): Draft[] {
  return view.rules.map((rule: NotificationRule) => ({ event: rule.event, source: rule.source, delivery: rule.delivery }));
}

/** Refresh untouched rows and keep edits, additions and removals until they are saved. */
function refreshEditor(current: Editor, view: NotificationSettingsView): Editor {
  const rules = draftsFrom(view);
  if (!current.view) return { view, drafts: rules.map(asDraft) };
  const removed = draftsFrom(current.view).filter((rule) =>
    !current.drafts.some((draft) => draft.saved && sameRule(draft.saved, rule)));
  const drafts = rules.filter((rule) => !removed.some((other) => sameRule(rule, other))).map((rule) => {
    const draft = current.drafts.find((other) => other.saved && sameRule(other.saved, rule));
    return draft?.saved && !sameDraft(draft, draft.saved) ? { ...draft, saved: rule } : asDraft(rule);
  });
  for (const draft of current.drafts) {
    const saved = draft.saved;
    if (!saved || (!rules.some((rule) => sameRule(saved, rule)) && !sameDraft(draft, saved))) {
      drafts.push({ ...draft, saved: null });
    }
  }
  return { view, drafts };
}

export function NotificationRules() {
  const [{ view, drafts }, setEditor] = useState<Editor>({ view: null, drafts: [] });
  const [busy, setBusy] = useState(false);
  const [push, setPush] = useState<PushState | null>(null);
  // Reads keep their generation; saves invalidate reads before and during the write.
  const settingsGeneration = useRef(0);

  useEffect(() => {
    let live = true;
    const generation = ++settingsGeneration.current;
    void api.notificationSettings().then(
      (settings) => {
        if (!live || generation !== settingsGeneration.current) return;
        setEditor((current) => refreshEditor(current, settings));
      },
      () => {}, // Notifications aren't set up here: no section
    );
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!view?.pushAvailable) return;
    let live = true;
    void pushState().then(async (state) => {
      if (!live) return;
      setPush(state);
      if (state === 'on') {
        const generation = ++settingsGeneration.current;
        const settings = await api.notificationSettings();
        if (live && generation === settingsGeneration.current) setEditor((current) => refreshEditor(current, settings));
      }
    }).catch(() => { if (live) setPush('unsupported'); });
    return () => { live = false; };
  }, [view?.pushAvailable]);

  if (!view) return null;

  const rules = drafts.map(({ event, source, delivery }) => ({ event, source, delivery }));
  const dirty = JSON.stringify(rules) !== JSON.stringify(draftsFrom(view));
  const duplicated = drafts.some((draft) => drafts.filter((other) => sameRule(draft, other)).length > 1);

  const change = (index: number, patch: Partial<Draft>): void =>
    setEditor((current) => ({
      ...current,
      drafts: current.drafts.map((draft, at) => {
        if (at !== index) return draft;
        const next = { ...draft, ...patch };
        if (next.event === 'agent-needs-you') {
          if (next.delivery === 'push') next.delivery = 'both';
          if (next.delivery === 'neither') next.delivery = 'toast';
        }
        return next;
      }),
    }));

  const save = async (): Promise<void> => {
    setBusy(true);
    ++settingsGeneration.current;
    try {
      const next = await serializeNotificationSettingsSave(() => api.setNotificationSettings({
        rules,
      }));
      ++settingsGeneration.current;
      setEditor({ view: next, drafts: draftsFrom(next).map(asDraft) });
      toast('Saved.', 'info');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveShared = async (patch: { quietHours: Partial<NonNullable<NotificationSettingsView['quietHours']>> | null } | { push: Partial<NotificationSettingsView['push']> }): Promise<void> => {
    setBusy(true);
    ++settingsGeneration.current;
    try {
      const next = await serializeNotificationSettingsSave(async () => {
        const body = 'push' in patch
          ? { push: { ...(await api.notificationSettings()).push, ...patch.push } }
          : { quietHours: patch.quietHours ? { ...((await api.notificationSettings()).quietHours ?? DEFAULT_QUIET), ...patch.quietHours } : null };
        return api.setNotificationSettings(body);
      });
      ++settingsGeneration.current;
      setEditor((current) => refreshEditor(current, next));
    } catch (err) {
      toast((err as Error).message);
    } finally { setBusy(false); }
  };

  const togglePhone = async (): Promise<void> => {
    setBusy(true);
    try {
      const next = push === 'on' ? await disablePush() : await enablePush();
      setPush(next);
      if (next === 'denied') toast('Notifications are blocked for this site in the browser settings.');
      const generation = ++settingsGeneration.current;
      const settings = await api.notificationSettings();
      if (generation === settingsGeneration.current) setEditor((current) => refreshEditor(current, settings));
    } catch (err) {
      toast((err as Error).message);
    } finally { setBusy(false); }
  };

  const testPhone = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.pushTest();
      toast('Sent. It should show up in a few seconds.', 'info');
    } catch (err) {
      toast((err as Error).message);
    } finally { setBusy(false); }
  };

  const quiet = view.quietHours;
  const times = [...new Set([...TIMES, ...(quiet ? [quiet.start, quiet.end] : [])])].sort();

  return (
    <>
      <div className="group-title">Notification rules</div>
      <div className="group notification-rules">
        <div className="kv">
          <BellRing size={18} />
          <div className="grow">
            <div>{PRESENCE_LINE[view.presence]}</div>
            <div className="muted">
              {view.pushAvailable
                ? `${view.pushDevices === 0 ? 'No device' : `${view.pushDevices} ${view.pushDevices === 1 ? 'device' : 'devices'}`} can be pushed to.`
                : 'Wayroost needs an https address to reach a phone.'}
            </div>
            {view.timeZoneConfigured && <div className="muted">Quiet hours are read in the time zone this PC's settings name.</div>}
          </div>
        </div>
        <div className="kv">
          <Moon size={18} />
          <div className="grow">
            <div>Quiet hours</div>
            <div className="muted">Card alerts wait during quiet hours. Approvals and questions always reach you.</div>
            <SettingsTiming timing="next-alert" />
          </div>
          <button type="button" role="switch" className="switch" aria-checked={Boolean(quiet)} aria-label="Quiet hours"
            disabled={busy} onClick={() => void saveShared({ quietHours: quiet ? null : DEFAULT_QUIET })} />
        </div>
        {quiet && (
          <div className="kv quiet-times">
            <SettingsTiming timing="next-alert" />
            <span className="muted">From</span>
            <select value={quiet.start} aria-label="Quiet hours start" disabled={busy}
              onChange={(e) => void saveShared({ quietHours: { start: e.target.value } })}>
              {times.map((time) => <option key={time} value={time}>{time}</option>)}
            </select>
            <span className="muted">to</span>
            <select value={quiet.end} aria-label="Quiet hours end" disabled={busy}
              onChange={(e) => void saveShared({ quietHours: { end: e.target.value } })}>
              {times.map((time) => <option key={time} value={time}>{time}</option>)}
            </select>
          </div>
        )}
        {view.pushAvailable && push && (
          <div className="kv">
            <Smartphone size={18} />
            <div className="grow">
              <div>Notifications on this device</div>
              <div className="muted">{PUSH_HELP[push]}</div>
              <SettingsTiming timing="now" />
            </div>
            {(push === 'on' || push === 'off') && (
              <button type="button" role="switch" className="switch" aria-checked={push === 'on'}
                aria-label="Notifications on this device" disabled={busy} onClick={() => void togglePhone()} />
            )}
          </div>
        )}
        {view.pushAvailable && (
          <>
            <div className="kv">
              <ShieldAlert size={18} />
              <div className="grow">
                <div>Phone alerts when an agent needs you</div>
                <div className="muted">Approvals and questions bypass quiet hours and always reach the app.</div>
                <SettingsTiming timing="next-alert" />
              </div>
              <button type="button" role="switch" className="switch" aria-checked={view.push.approvals}
                aria-label="Notify when an agent needs you" disabled={busy}
                onClick={() => void saveShared({ push: { approvals: !view.push.approvals } })} />
            </div>
            <div className="kv">
              <Sparkles size={18} />
              <div className="grow">
                <div>Phone alerts for new For-you cards</div>
                <div className="muted">Cards follow their notification rule and quiet hours.</div>
                <SettingsTiming timing="next-alert" />
              </div>
              <button type="button" role="switch" className="switch" aria-checked={view.push.cards}
                aria-label="Notify about new For-you cards" disabled={busy}
                onClick={() => void saveShared({ push: { cards: !view.push.cards } })} />
            </div>
            {view.pushDevices > 0 && (
              <div className="kv">
                <BellRing size={18} />
                <div className="grow muted">Check that phone notifications arrive.</div>
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void testPhone()}>Send a test</button>
              </div>
            )}
          </>
        )}
        {drafts.map((draft, index) => {
          const needsYou = draft.event === 'agent-needs-you';
          return (
            <div className="kv" key={`${draft.event}-${draft.source}-${index}`}>
              <div className="grow">
                <select
                  value={draft.event}
                  onChange={(e) => change(index, { event: e.target.value as NotificationEvent })}
                  disabled={busy}
                  aria-label={`Alert ${index + 1}`}
                >
                  {EVENTS.map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
                <div className="muted">{EVENTS.find((item) => item.id === draft.event)?.help}</div>
              </div>
              <select
                value={draft.source}
                onChange={(e) => change(index, { source: e.target.value as NotificationSource | '*' })}
                disabled={busy}
                aria-label={`Alert ${index + 1} source`}
              >
                {SOURCES.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
              <select
                value={draft.delivery}
                onChange={(e) => change(index, { delivery: e.target.value as NotificationDelivery })}
                disabled={busy}
                aria-label={`Alert ${index + 1} delivery`}
              >
                {/* An answer can't be switched off, so the choices that would are gone. */}
                {DELIVERIES.filter((item) => !needsYou || item.id === 'toast' || item.id === 'both').map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setEditor((current) => ({ ...current, drafts: current.drafts.filter((_, at) => at !== index) }))}
                disabled={busy}
                aria-label={`Remove alert ${index + 1}`}
              >
                <Trash2 size={16} />
              </button>
              <SettingsTiming timing="next-alert" />
            </div>
          );
        })}
        <div className="kv">
          <div className="grow muted">
            An agent waiting on you always reaches the app. Alerts the app would show go to the phone when nobody is at the keyboard.
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setEditor((current) => ({ ...current, drafts: [...current.drafts, { event: 'agent-finished', source: '*', delivery: 'toast', saved: null }] }))}
            disabled={busy}
            aria-label="Add a rule"
          >
            <Plus size={16} />
          </button>
          {busy && <LoaderCircle size={16} className="spin" />}
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={busy || !dirty || duplicated}
            aria-label="Save notification rules"
          >
            {duplicated ? 'Same rule twice' : 'Save'}
          </button>
        </div>
      </div>
    </>
  );
}
