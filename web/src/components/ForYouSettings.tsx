import { BellRing, Gauge, Info, LoaderCircle, Moon, ShieldAlert, Smartphone, Sparkles, ThumbsDown, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FeedSettings, ProactivityLevel } from '../../../shared/protocol';
import { api } from '../api';
import { disablePush, enablePush, pushState, type PushState } from '../push';
import { toast } from '../store';

const LEVELS: Array<{ id: ProactivityLevel; label: string; help: string }> = [
  { id: 'off', label: 'Off', help: 'No brief and no daytime checks' },
  { id: 'low', label: 'Brief only', help: 'The 7am brief, nothing during the day' },
  { id: 'normal', label: 'Normal', help: 'The 7am brief, and a check every 2 hours from 10 to 8' },
  { id: 'high', label: 'Often', help: 'The 7am brief, and a check every hour from 9 to 9' },
];

/** Times for quiet hours, every half hour. */
const TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const DEFAULT_QUIET = { start: '21:00', end: '07:00' };

const timeLabel = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

const PUSH_HELP: Record<PushState, string> = {
  'needs-install': 'On iPhone, add Signalbox to your Home Screen first (Share, then Add to Home Screen), and turn this on there.',
  unsupported: "This browser can't show notifications.",
  denied: 'Blocked for this site in the browser settings. Allow notifications there, then come back.',
  off: 'When an agent waits on you, and (if you like) new For-you cards.',
  on: 'This device gets notifications.',
};

/** Settings → For you: how often Hermes speaks up, quiet hours, phone notifications, turned-down topics. */
export function ForYouSettings() {
  const [settings, setSettings] = useState<FeedSettings | null>(null);
  const [push, setPush] = useState<PushState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.feed().then(
      (list) => {
        if (live) setSettings(list.settings);
      },
      () => {}, // For you is off here: no section
    );
    pushState().then(
      (state) => {
        if (live) setPush(state);
      },
      () => {
        if (live) setPush('unsupported');
      },
    );
    return () => {
      live = false;
    };
  }, []);

  if (!settings) return null;

  const save = async (key: string, patch: Parameters<typeof api.feedSettings>[0]) => {
    setBusy(key);
    try {
      setSettings(await api.feedSettings(patch));
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const togglePhone = async () => {
    setBusy('phone');
    try {
      const next = push === 'on' ? await disablePush() : await enablePush();
      setPush(next);
      if (next === 'denied') toast('Notifications are blocked for this site in the browser settings.');
      setSettings((await api.feed()).settings);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    try {
      await api.pushTest();
      toast('Sent. It should show up in a few seconds.', 'info');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const level = LEVELS.find((l) => l.id === settings.level) ?? LEVELS[2]!;
  const quiet = settings.quietHours;
  const spinner = (key: string) => busy === key && <LoaderCircle size={16} className="spin" />;

  return (
    <>
      <div className="group-title">For you</div>
      <div className="group foryou-settings">
        <div className="kv">
          <Gauge size={18} />
          <div className="grow">
            <div>How often Hermes speaks up</div>
            <div className="muted">{level.help}</div>
          </div>
          {spinner('level')}
          <select
            value={settings.level}
            onChange={(e) => save('level', { level: e.target.value as ProactivityLevel })}
            disabled={busy !== null || !settings.pulseFound}
            aria-label="How often Hermes speaks up"
          >
            {LEVELS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        {!settings.pulseFound && (
          <div className="kv">
            <Info size={18} />
            <div className="grow muted">
              Hermes' pulse jobs (pulse-morning-brief and pulse-scout) weren't found, so this can't change yet.
            </div>
          </div>
        )}

        <div className="kv">
          <Moon size={18} />
          <div className="grow">
            <div>Quiet hours</div>
            <div className="muted">
              {quiet
                ? `No For-you notifications from ${timeLabel(quiet.start)} to ${timeLabel(quiet.end)}`
                : 'For-you notifications any time'}
            </div>
          </div>
          {spinner('quiet')}
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={Boolean(quiet)}
            aria-label="Quiet hours"
            disabled={busy !== null}
            onClick={() => save('quiet', { quietHours: quiet ? null : DEFAULT_QUIET })}
          />
        </div>
        {quiet && (
          <div className="kv quiet-times">
            <span className="muted">From</span>
            <select
              value={quiet.start}
              onChange={(e) => save('quiet', { quietHours: { ...quiet, start: e.target.value } })}
              disabled={busy !== null}
              aria-label="Quiet hours start"
            >
              {TIMES.map((t) => (
                <option key={t} value={t}>
                  {timeLabel(t)}
                </option>
              ))}
            </select>
            <span className="muted">to</span>
            <select
              value={quiet.end}
              onChange={(e) => save('quiet', { quietHours: { ...quiet, end: e.target.value } })}
              disabled={busy !== null}
              aria-label="Quiet hours end"
            >
              {TIMES.map((t) => (
                <option key={t} value={t}>
                  {timeLabel(t)}
                </option>
              ))}
            </select>
          </div>
        )}

        {settings.pushAvailable && push && (
          <div className="kv">
            <Smartphone size={18} />
            <div className="grow">
              <div>Notifications on this device</div>
              <div className="muted">{PUSH_HELP[push]}</div>
            </div>
            {spinner('phone')}
            {(push === 'on' || push === 'off') && (
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={push === 'on'}
                aria-label="Notifications on this device"
                disabled={busy !== null}
                onClick={togglePhone}
              />
            )}
          </div>
        )}
        {settings.pushAvailable && settings.pushDevices > 0 && (
          <>
            <div className="kv">
              <ShieldAlert size={18} />
              <div className="grow">
                <div>When an agent needs you</div>
                <div className="muted">
                  Approvals and questions, quiet hours or not. The command itself is never in the notification.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={settings.push.approvals}
                aria-label="Notify when an agent needs you"
                disabled={busy !== null}
                onClick={() => save('approvals', { push: { approvals: !settings.push.approvals } })}
              />
            </div>
            <div className="kv">
              <Sparkles size={18} />
              <div className="grow">
                <div>New For-you cards</div>
                <div className="muted">The brief already comes on WhatsApp, so this starts off.</div>
              </div>
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={settings.push.cards}
                aria-label="Notify about new For-you cards"
                disabled={busy !== null}
                onClick={() => save('cards', { push: { cards: !settings.push.cards } })}
              />
            </div>
            <div className="kv">
              <BellRing size={18} />
              <div className="grow muted">
                {settings.pushDevices === 1 ? '1 device gets notifications.' : `${settings.pushDevices} devices get notifications.`}
              </div>
              <button type="button" className="btn btn-secondary" onClick={test} disabled={busy !== null}>
                {spinner('test')} Send a test
              </button>
            </div>
          </>
        )}

        {settings.lessLike.length > 0 && (
          <div className="kv less-like">
            <ThumbsDown size={18} />
            <div className="grow">
              <div>Less like this</div>
              <div className="muted">Hermes skips these topics. Tap × to bring one back.</div>
              <div className="less-like-list">
                {settings.lessLike.map((l) => (
                  <span key={l.topic} className="less-like-chip" title={`For example: ${l.example}`}>
                    {l.topic}
                    <button
                      type="button"
                      aria-label={`Bring back ${l.topic}`}
                      disabled={busy !== null}
                      onClick={() => save('less', { removeLessLike: l.topic })}
                    >
                      <X size={13} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
