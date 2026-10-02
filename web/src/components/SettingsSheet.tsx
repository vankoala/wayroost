import {
  Activity,
  Archive,
  AudioLines,
  BookOpen,
  CalendarClock,
  ChevronRight,
  Cloud,
  Eye,
  EyeOff,
  Clock,
  Gauge,
  Info,
  KeyRound,
  LoaderCircle,
  Lock,
  LogOut,
  MicOff,
  Pause,
  Play,
  Phone,
  PlugZap,
  Reply,
  RotateCcw,
  Send,
  ShieldCheck,
  Timer,
  TriangleAlert,
  Volume2,
  Waypoints,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import {
  SOURCES,
  WHATSAPP_FRESH_HOURS,
  WHATSAPP_RETURN_MINUTES,
  type BridgeStatus,
  type CleanupPreview,
  type CloudAgent,
  type CloudAgentId,
  type PhoneStatus,
  type SafetyCommandsStatus,
  type SourceStatus,
  type WhatsAppRouting,
} from '../../../shared/protocol';
import { api, refreshList, reportTidy } from '../api';
import { setState, toast, useStore } from '../store';
import { readMessage, setVoiceSettings, setVoiceStatus, SPEEDS, useVoiceSettings, useVoiceStatus } from '../voice';
import { ConfirmDialog, SOURCE_NAMES, Sheet, SourceAvatar, statusLabel, statusTone, useEnabledSources } from './common';
import { ForYouSettings } from './ForYouSettings';

function applyStatus(status: SourceStatus) {
  setState((s) => ({ ...s, statuses: { ...s.statuses, [status.source]: status } }));
}

function HermesSignIn() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { status } = await api.setHermesCredentials(username.trim(), password);
      applyStatus(status);
      setPassword('');
      toast('Hermes connected', 'info');
      setTimeout(() => refreshList().catch(() => {}), 1500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="group form-group" onSubmit={submit}>
      <label className="field">
        <span>Hermes dashboard username</span>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>
      <label className="field">
        <span>Password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        <small>Checked with Hermes, then kept only on your PC. It is never sent to your phone again.</small>
      </label>
      {error && <p className="error-text">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy || !username.trim() || !password}>
        {busy ? <LoaderCircle size={18} className="spin" /> : <KeyRound size={16} />}
        Connect Hermes
      </button>
    </form>
  );
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The project bridge's state and kill switch. Hidden where the server doesn't offer it. */
function BridgeSettings() {
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.bridge().then(
      (status) => {
        if (live) setBridge(status);
      },
      () => {}, // an older server without the bridge: no section
    );
    return () => {
      live = false;
    };
  }, []);

  if (!bridge) return null;

  const toggle = async () => {
    setBusy(true);
    try {
      setBridge(await api.setBridgePaused(!bridge.paused));
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const { sent, queued, started } = bridge.recent;
  const state = !bridge.enabled ? 'Off in the server config' : bridge.paused ? 'Paused' : 'On';
  const tone = !bridge.enabled ? 'off' : bridge.paused ? 'warn' : 'ok';
  return (
    <>
      <div className="group-title">Project bridge</div>
      <div className="group bridge-settings">
        <div className="kv">
          <Waypoints size={18} />
          <div className="grow">
            <div className="bridge-state">
              <span className={`dot ${tone}`} aria-hidden="true" /> {state}
            </div>
            <div className="muted">
              Lets agents in the same project read and message each other's chats. Approvals always come to you.
            </div>
          </div>
          {bridge.enabled && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={toggle}
              disabled={busy}
              aria-pressed={bridge.paused}
            >
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : bridge.paused ? (
                <Play size={16} />
              ) : (
                <Pause size={16} />
              )}
              {bridge.paused ? 'Resume' : 'Pause'}
            </button>
          )}
        </div>
        {bridge.enabled ? (
          <div className="kv">
            <Activity size={18} />
            <div className="grow">
              <div>Last hour</div>
              <div className="muted">
                {count(sent, 'message sent', 'messages sent')} · {queued} queued · {count(started, 'chat started', 'chats started')}
              </div>
            </div>
          </div>
        ) : (
          <div className="kv">
            <Info size={18} />
            <div className="grow muted">
              To turn it on, set <code>"bridge": {'{ "enabled": true }'}</code> in the server config and restart
              Signalbox. See docs/configuration.md.
            </div>
          </div>
        )}
      </div>
    </>
  );
}

const CLOUD_STATE: Record<CloudAgent['state'], string> = {
  ready: 'On',
  off: 'Off',
  unavailable: "On, but Paseo can't run it (not installed or signed out)",
  loading: 'On · Paseo is checking it',
  error: 'On · Paseo reported a problem',
};

/**
 * Which agents on cloud models may be started at all. Paseo keeps the switch,
 * so it holds everywhere. Hidden where the server can't switch them.
 */
function CloudAgentsSettings() {
  const [agents, setAgents] = useState<CloudAgent[] | null>(null);
  const [busy, setBusy] = useState<CloudAgentId | null>(null);

  useEffect(() => {
    let live = true;
    api.cloudAgents().then(
      (status) => {
        if (live) setAgents(status.agents);
      },
      () => {}, // Paseo is off or reconnecting, or an older server: no section
    );
    return () => {
      live = false;
    };
  }, []);

  if (!agents?.length) return null;

  const toggle = async (agent: CloudAgent) => {
    setBusy(agent.id);
    try {
      setAgents((await api.setCloudAgent(agent.id, !agent.enabled)).agents);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="group-title">Cloud agents</div>
      <div className="group cloud-agents">
        {agents.map((agent) => (
          <div className="kv" key={agent.id}>
            <Cloud size={18} />
            <div className="grow">
              <div>{agent.label}</div>
              <div className="muted">
                {CLOUD_STATE[agent.state]}
                {agent.detail ? ` · ${agent.detail}` : ''}
              </div>
            </div>
            {busy === agent.id && <LoaderCircle size={16} className="spin" />}
            <button
              type="button"
              role="switch"
              className="switch"
              aria-checked={agent.enabled}
              aria-label={agent.label}
              onClick={() => toggle(agent)}
              disabled={busy !== null}
            />
          </div>
        ))}
        <div className="kv">
          <Info size={18} />
          <div className="grow muted">
            Agents that run on a cloud model. Off turns one off in Paseo itself: you, the Paseo app and other agents
            can't start it until you switch it back on. Agents already running aren't stopped.
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Settings → Security: whether /approve, /approvals, /yolo, /memory approval,
 * /skills approval and /debug may run from Signalbox. Turning it on asks first;
 * turning it off doesn't. Hidden where the server has no Hermes.
 */
function SafetyCommandsSettings() {
  const [status, setStatus] = useState<SafetyCommandsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let live = true;
    api.safetyCommands().then(
      (s) => {
        if (live) setStatus(s);
      },
      () => {}, // Hermes is off, or an older server: no row
    );
    return () => {
      live = false;
    };
  }, []);

  const save = async (enabled: boolean) => {
    setBusy(true);
    try {
      setStatus(await api.setSafetyCommands(enabled));
      setConfirming(false);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <div className="kv">
        <ShieldCheck size={18} />
        <div className="grow">
          <div>Approvals are never automatic</div>
          <div className="muted">Agents wait for you before running anything that needs permission.</div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="kv">
        {status.enabled ? <TriangleAlert size={18} /> : <ShieldCheck size={18} />}
        <div className="grow">
          <div>Hermes safety commands</div>
          <div className="muted">
            {status.enabled
              ? `On: ${status.commands.join(', ')} run from here. /yolo or /approvals off stop Hermes asking before it acts.`
              : `Off: ${status.commands.join(', ')} are refused here. Agents wait for you before running anything that needs permission.`}
          </div>
        </div>
        {busy && <LoaderCircle size={16} className="spin" />}
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={status.enabled}
          aria-label="Hermes safety commands"
          onClick={() => (status.enabled ? save(false) : setConfirming(true))}
          disabled={busy}
        />
      </div>
      {confirming && (
        <ConfirmDialog
          title="Allow Hermes safety commands?"
          message={`${status.commands.join(', ')} will run from Signalbox, including from your phone. Anyone who can send a message here could then switch off Hermes' approval prompts or upload its logs. You can switch this off again at any time.`}
          confirmLabel="Allow"
          busy={busy}
          danger
          onConfirm={() => save(true)}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/** Hermes Phone: whether the line is up, and the PIN that lets calls from your cell reach Hermes. */
function PhoneSettings() {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.phone().then(
      (s) => {
        if (live) setStatus(s);
      },
      () => {}, // no helper, or an older server: no section
    );
    return () => {
      live = false;
    };
  }, []);

  if (!status) return null;
  const valid = /^\d{4,12}$/.test(draft);

  const reveal = async () => {
    if (shown !== null) return setShown(null);
    setBusy(true);
    try {
      setShown((await api.phonePin()).pin ?? '');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      setStatus(await api.setPhonePin(draft));
      setShown(null);
      setDraft('');
      toast('PIN saved.', 'info');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cell = status.ownerNumber ? `…${status.ownerNumber.slice(-4)}` : 'your cell';
  return (
    <>
      <div className="group-title">Phone</div>
      <div className="group phone-settings">
        <div className="kv">
          <Phone size={18} />
          <div className="grow">
            <div>Hermes Phone</div>
            <div className="muted">
              {!status.running ? "Not running on the PC" : status.ok ? 'Running' : 'Running, but a part is down'}
              {status.running && status.activeCalls ? ` · ${status.activeCalls} call${status.activeCalls > 1 ? 's' : ''} now` : ''}
            </div>
          </div>
          <span className={`dot ${status.running && status.ok ? 'ok' : 'bad'}`} aria-hidden="true" />
        </div>
        <div className="kv">
          <KeyRound size={18} />
          <div className="grow">
            <div>PIN</div>
            <div className="muted">
              {!status.pinSet
                ? 'Not set: calls from your cell only reach the basic assistant'
                : shown !== null
                  ? <span className="pin-value">{shown}</span>
                  : '••••'}
            </div>
          </div>
          {status.pinSet && (
            <button type="button" className="btn btn-secondary" onClick={reveal} disabled={busy}
              aria-label={shown !== null ? 'Hide PIN' : 'Show PIN'}>
              {busy ? <LoaderCircle size={16} className="spin" /> : shown !== null ? <EyeOff size={16} /> : <Eye size={16} />}
              {shown !== null ? 'Hide' : 'Show'}
            </button>
          )}
        </div>
        <form className="kv" onSubmit={save}>
          <label className="field grow">
            <span>{status.pinSet ? 'Change PIN' : 'Set a PIN'}</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              placeholder={status.pinSet ? 'New PIN (4–12 digits)' : 'Choose a PIN (4–12 digits)'}
              value={draft}
              onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 12))}
              aria-label="New PIN"
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || !valid}>
            {status.pinSet ? 'Change' : 'Set PIN'}
          </button>
        </form>
        <div className="kv">
          <Info size={18} />
          <div className="grow muted">
            Call your Hermes Phone number from {cell}, then say or key the PIN (# to finish) to talk to Hermes. Anyone else reaches
            the basic assistant. The PIN is kept in the encrypted vault on your PC.
          </div>
        </div>
      </div>
    </>
  );
}

const minutesLabel = (m: number) => (m < 60 ? `${m} min` : `${m / 60} h`);

/** The whatsapp-routing Hermes plugin: where WhatsApp replies go, and when the chat starts fresh. */
function WhatsAppSettings() {
  const [wa, setWa] = useState<WhatsAppRouting | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.whatsappRouting().then(
      (status) => {
        if (live) setWa(status);
      },
      () => {}, // no helper, Hermes off, or an older server: no section
    );
    return () => {
      live = false;
    };
  }, []);

  if (!wa?.installed) return null;

  const save = async (change: Partial<Omit<WhatsAppRouting, 'installed' | 'active'>>) => {
    setBusy(true);
    try {
      const { replyRouting, returnMinutes, freshAfterHours } = { ...wa, ...change };
      setWa(await api.setWhatsappRouting({ replyRouting, returnMinutes, freshAfterHours }));
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="group-title">WhatsApp</div>
      <div className="group whatsapp-routing">
        {!wa.active && (
          <div className="kv">
            <TriangleAlert size={18} />
            <div className="grow">
              <div>Hermes isn't loading the WhatsApp plugin</div>
              <div className="muted">
                Add whatsapp-routing under plugins.enabled in ~/.hermes/config.yaml and restart Hermes. Until then these
                choices are saved but do nothing.
              </div>
            </div>
          </div>
        )}
        <div className="kv">
          <Reply size={18} />
          <div className="grow">
            <div>Replies go back to the chat that messaged you</div>
            <div className="muted">When another Hermes chat sends you a WhatsApp message, quote-reply to it</div>
          </div>
          {busy && <LoaderCircle size={16} className="spin" />}
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={wa.replyRouting}
            aria-label="Replies go back to the chat that messaged you"
            onClick={() => save({ replyRouting: !wa.replyRouting })}
            disabled={busy}
          />
        </div>
        <div className="kv">
          <Timer size={18} />
          <div className="grow">
            <div>Back to your WhatsApp chat after</div>
            <div className="muted">This long without a message in that chat</div>
          </div>
          <select
            value={wa.returnMinutes}
            onChange={(e) => save({ returnMinutes: Number(e.target.value) })}
            disabled={busy || !wa.replyRouting}
            aria-label="Back to your WhatsApp chat after"
          >
            {WHATSAPP_RETURN_MINUTES.map((m) => (
              <option key={m} value={m}>
                {minutesLabel(m)}
              </option>
            ))}
          </select>
        </div>
        <div className="kv">
          <RotateCcw size={18} />
          <div className="grow">
            <div>Start a fresh WhatsApp chat</div>
            <div className="muted">After this long without any activity</div>
          </div>
          <select
            value={wa.freshAfterHours}
            onChange={(e) => save({ freshAfterHours: Number(e.target.value) })}
            disabled={busy}
            aria-label="Start a fresh WhatsApp chat"
          >
            {WHATSAPP_FRESH_HOURS.map((h) => (
              <option key={h} value={h}>
                {h === 0 ? 'Never' : `${h} h`}
              </option>
            ))}
          </select>
        </div>
        <div className="kv">
          <Info size={18} />
          <div className="grow muted">
            Changes apply to your next WhatsApp message, with no restart. Earlier chats stay in Hermes: send /resume in
            WhatsApp to go back to one.
          </div>
        </div>
      </div>
    </>
  );
}

const IDLE_CHOICES = [7, 14, 30, 90];

/** Archived threads, and archiving every thread idle for a while in one go. */
function TidySettings({ onArchived }: { onArchived: () => void }) {
  const [days, setDays] = useState(14);
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [counted, setCounted] = useState(0); // bump to count again

  useEffect(() => {
    let live = true;
    setPreview(null);
    setError(null);
    api.cleanupPreview(days).then(
      (p) => {
        if (live) setPreview(p);
      },
      (err) => {
        if (live) setError((err as Error).message);
      },
    );
    return () => {
      live = false;
    };
  }, [days, counted]);

  const archiveIdle = async () => {
    setBusy(true);
    try {
      const result = await api.cleanup(days);
      reportTidy('archived', [], result);
      setConfirm(false);
      await refreshList().catch(() => {});
      setCounted((n) => n + 1);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const n = preview?.count ?? 0;
  return (
    <>
      <div className="group-title">Tidy up</div>
      <div className="group tidy-settings">
        <div className="kv">
          <Archive size={18} />
          <div className="grow">
            <div>Archived threads</div>
            <div className="muted">See, restore or delete what you archived</div>
          </div>
          <button type="button" className="btn btn-secondary" onClick={onArchived}>
            View
          </button>
        </div>
        <div className="kv">
          <Clock size={18} />
          <div className="grow">
            <label className="tidy-days">
              Archive threads idle for more than{' '}
              <select value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={busy}>
                {IDLE_CHOICES.map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
            </label>
            <div className="muted">
              {error ?? (preview ? `${count(n, 'thread', 'threads')} in Hermes and Paseo` : 'Counting…')}
            </div>
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => setConfirm(true)} disabled={busy || n === 0}>
            Archive
          </button>
        </div>
      </div>
      {confirm && (
        <ConfirmDialog
          title={`Archive ${count(n, 'thread', 'threads')}?`}
          message={`Every Hermes chat and Paseo agent idle for more than ${days} days, except any that are working. You can restore them any time from Archived threads, and a Paseo agent also comes back if it gets a new message.`}
          confirmLabel="Archive"
          busy={busy}
          onConfirm={archiveIdle}
          onCancel={() => setConfirm(false)}
        />
      )}
    </>
  );
}

const VOICE_KINDS: Record<string, string> = {
  af: 'American, female',
  am: 'American, male',
  bf: 'British, female',
  bm: 'British, male',
};

/** "af_heart" → "Heart (American, female)". */
export function voiceLabel(voice: string): string {
  const [kind = '', name = voice] = voice.split('_');
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}${VOICE_KINDS[kind] ? ` (${VOICE_KINDS[kind]})` : ''}`;
}

/** A short line in a voice, so it can be heard right here in Settings. */
function sampleLine(voice: string): string {
  return `Hi, I'm ${voiceLabel(voice).replace(/ \(.*\)$/, '')}. This is how I'll sound.`;
}

/** Voice mode's choices. The voice applies everywhere (every device, and Hermes Phone's calls);
 *  the rest is for this device. Hidden unless the server has voice mode on. */
function VoiceSettings() {
  const status = useVoiceStatus();
  const settings = useVoiceSettings();
  const [saving, setSaving] = useState(false);
  if (!status?.enabled) return null;
  const voice = status.defaultVoice;

  const choose = async (next: string) => {
    if (next === voice) return readMessage('settings', sampleLine(next));
    setSaving(true);
    try {
      const result = await api.setVoice(next);
      setVoiceStatus(result);
      readMessage('settings', sampleLine(next));
      if (result.calls === 'failed') toast(`Saved here, but calls keep their voice: ${result.callsMessage ?? "the phone line didn't take it."}`);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <div className="group-title">Voice</div>
      <div className="group">
        {!status.available && (
          <div className="kv">
            <MicOff size={18} />
            <div className="grow">
              <div>Voice is unavailable</div>
              <div className="muted">The speech service on your PC isn't answering.</div>
            </div>
          </div>
        )}
        <div className="kv">
          <Volume2 size={18} />
          <div className="grow">
            <div>Read replies aloud</div>
            <div className="muted">After you speak a message</div>
          </div>
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={settings.readReplies}
            aria-label="Read replies aloud"
            onClick={() => setVoiceSettings({ readReplies: !settings.readReplies })}
          />
        </div>
        <div className="kv">
          <Send size={18} />
          <div className="grow">
            <div>Send what you say right away</div>
            <div className="muted">Off: it goes in the message box first, to check</div>
          </div>
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={settings.autoSend}
            aria-label="Send what you say right away"
            onClick={() => setVoiceSettings({ autoSend: !settings.autoSend })}
          />
        </div>
        {status.available && (
          <>
            <div className="kv">
              <AudioLines size={18} />
              <div className="grow">
                <div>Voice</div>
              </div>
              <select value={voice} onChange={(e) => void choose(e.target.value)} disabled={saving} aria-label="Voice">
                {status.voices.map((v) => (
                  <option key={v} value={v}>
                    {voiceLabel(v)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => readMessage('settings', sampleLine(voice))}
                disabled={saving}
                aria-label="Play this voice"
              >
                {saving ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}
              </button>
            </div>
            <div className="kv">
              <Gauge size={18} />
              <div className="grow">
                <div>Speed</div>
              </div>
              <select value={settings.speed} onChange={(e) => setVoiceSettings({ speed: Number(e.target.value) })} aria-label="Speed">
                {SPEEDS.map((speed) => (
                  <option key={speed} value={speed}>
                    {speed === 1 ? 'Normal' : `${speed}×`}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
        <div className="kv">
          <Info size={18} />
          <div className="grow muted">
            Hold the mic in a chat to talk, or tap it to start and tap again to finish. Speech is turned into text and back
            on your PC: nothing goes anywhere else, and nothing is kept. Picking a voice plays it; the voice applies everywhere
            (Signalbox on all your devices, and phone and car calls from the next call). The other choices are for this device.
          </div>
          {status.available && (
            <button type="button" className="btn btn-secondary" onClick={() => readMessage('settings', 'This is how replies will sound.')}>
              Try it
            </button>
          )}
        </div>
      </div>
    </>
  );
}

export function SettingsSheet({
  onClose,
  onArchived,
  onConnectors,
  onSchedules,
  onSkills,
}: {
  onClose: () => void;
  onArchived: () => void;
  onConnectors: () => void;
  onSchedules: () => void;
  onSkills: () => void;
}) {
  const email = useStore((s) => s.email);
  const statuses = useStore((s) => s.statuses);
  const [disconnecting, setDisconnecting] = useState(false);
  const enabled = useEnabledSources();
  const hermes = statuses.hermes;

  const disconnectHermes = async () => {
    setDisconnecting(true);
    try {
      const { status } = await api.clearHermesCredentials();
      applyStatus(status);
      refreshList().catch(() => {});
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <Sheet title="Settings" onClose={onClose}>
      <div className="group-title">Connections</div>
      <div className="group">
        {SOURCES.filter((source) => enabled.includes(source)).map((source) => {
          const status = statuses[source];
          return (
            <div className="kv" key={source}>
              <SourceAvatar source={source} small />
              <div className="grow">
                <div>{SOURCE_NAMES[source]}</div>
                <div className="muted">{status.message ?? statusLabel(status.state)}</div>
              </div>
              <span className={`dot ${statusTone(status.state)}`} aria-label={statusLabel(status.state)} />
            </div>
          );
        })}
        {enabled.includes('hermes') && (
          <button type="button" className="kv settings-link" onClick={onConnectors}>
            <PlugZap size={18} />
            <div className="grow">
              <div>Connectors</div>
              <div className="muted">Let Hermes use Gmail, Notion, Todoist and more</div>
            </div>
            <ChevronRight size={18} />
          </button>
        )}
        {enabled.includes('hermes') && (
          <button type="button" className="kv settings-link" onClick={onSchedules}>
            <CalendarClock size={18} />
            <div className="grow">
              <div>Scheduled jobs</div>
              <div className="muted">What Hermes runs on a schedule, and how each run went</div>
            </div>
            <ChevronRight size={18} />
          </button>
        )}
        <button type="button" className="kv settings-link" onClick={onSkills}>
          <BookOpen size={18} />
          <div className="grow">
            <div>Skills</div>
            <div className="muted">Every agent's skills, kept the same everywhere, plus the marketplace</div>
          </div>
          <ChevronRight size={18} />
        </button>
      </div>

      {enabled.includes('hermes') && <div className="group-title">Hermes sign-in</div>}
      {!enabled.includes('hermes') ? null : hermes.state === 'needs_credentials' ? (
        <HermesSignIn />
      ) : (
        <div className="group">
          <div className="kv">
            <KeyRound size={18} />
            <div className="grow">
              <div>Signed in to the Hermes dashboard</div>
              <div className="muted">Stored privately on your PC</div>
            </div>
            <button type="button" className="btn btn-secondary" onClick={disconnectHermes} disabled={disconnecting}>
              {disconnecting && <LoaderCircle size={16} className="spin" />}
              Sign out
            </button>
          </div>
        </div>
      )}

      {enabled.includes('hermes') && <ForYouSettings />}

      {enabled.includes('paseo') && <CloudAgentsSettings />}

      {enabled.includes('hermes') && <WhatsAppSettings />}

      <PhoneSettings />

      <VoiceSettings />

      {enabled.length > 0 && <TidySettings onArchived={onArchived} />}

      <BridgeSettings />

      <div className="group-title">Security</div>
      <div className="group">
        <div className="kv">
          <Lock size={18} />
          <div className="grow">
            <div>Cloudflare Access</div>
            <div className="muted">{email ?? 'Signed in'}</div>
          </div>
          <a className="btn btn-secondary" href="/cdn-cgi/access/logout">
            <LogOut size={16} /> Sign out
          </a>
        </div>
        {enabled.includes('hermes') ? (
          <SafetyCommandsSettings />
        ) : (
          <div className="kv">
            <ShieldCheck size={18} />
            <div className="grow">
              <div>Approvals are never automatic</div>
              <div className="muted">Agents wait for you before running anything that needs permission.</div>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
