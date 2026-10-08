import {
  Activity,
  Archive,
  Brain,
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
  ListChecks,
  LoaderCircle,
  Lock,
  LogOut,
  MicOff,
  MonitorSmartphone,
  Pause,
  Play,
  Phone,
  Palette,
  PlugZap,
  SlidersHorizontal,
  Reply,
  RotateCcw,
  Send,
  Search,
  ShieldCheck,
  Timer,
  Type,
  TriangleAlert,
  Wrench,
  Volume2,
  Waypoints,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
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
  type WorkerUpdatesStatus,
} from '../../../shared/protocol';
import type { WorkerApprovalsStatus } from '../../../shared/safety';
import { api, refreshList, reportTidy } from '../api';
import { captureRollout, getRolloutGeneration, getState, setState, toast, useStore } from '../store.js';
import { readMessage, setVoiceSettings, setVoiceStatus, SPEEDS, useVoiceSettings, useVoiceStatus } from '../voice';
import { navigate, settingsPath } from '../router';
import { ConfirmDialog, Page, SOURCE_NAMES, SourceAvatar, statusLabel, statusTone, useEnabledSources } from '../components/common';
import { ForYouSettings } from '../components/ForYouSettings';
import { NotificationRules } from '../components/NotificationRules';
import { RecentChanges } from '../components/RecentChanges';
import { currentTheme, setTheme, type Theme } from '../theme';
import { SettingsTiming } from '../components/SettingsTiming';

function applyStatus(status: SourceStatus) {
  setState((s) => ({ ...s, statuses: { ...s.statuses, [status.source]: status } }));
}

function HermesSignIn() {
  const writable = useStore(s => s.rollout?.settingsPages === true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rolloutGeneration = useStore(() => getRolloutGeneration('settingsPages'));
  useEffect(() => { setBusy(false); setError(null); }, [rolloutGeneration]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const rollout = captureRollout('settingsPages');
    if (!rollout.still() || !username.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { status } = await api.setHermesCredentials(username.trim(), password);
      if (!rollout.still()) return;
      applyStatus(status);
      setPassword('');
      toast('Hermes connected', 'info');
      setTimeout(() => { if (rollout.still()) void refreshList(rollout).catch(() => {}); }, 1500);
    } catch (err) {
      if (rollout.still()) setError((err as Error).message);
    } finally {
      if (rollout.still()) setBusy(false);
    }
  };

  return (
    <form className="group form-group" onSubmit={submit}>
      <label className="field">
        <span>Hermes dashboard username</span>
        <SettingsTiming timing="now" />
        <input
          disabled={!writable || busy}
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
        <SettingsTiming timing="now" />
        <input
          disabled={!writable || busy}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        <small>Checked with Hermes, then kept only on your PC. It is never sent to your phone again.</small>
      </label>
      {error && <p className="error-text">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={!writable || busy || !username.trim() || !password}>
        {busy ? <LoaderCircle size={18} className="spin" /> : <KeyRound size={16} />}
        Connect Hermes
      </button>
    </form>
  );
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The project bridge's state and kill switch. Hidden where the server doesn't offer it. */
function BridgeSettings() {
  const desktop = useStore((s) => s.device?.kind === 'desktop');
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
    if (!desktop) return;
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
            {!desktop && <div className="muted">Change this on a paired desktop.</div>}
            <SettingsTiming timing={bridge.enabled ? 'now' : 'restart'} />
          </div>
          {bridge.enabled && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={toggle}
              disabled={busy || !desktop}
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
          <>
            <div className="kv">
              <Activity size={18} />
              <div className="grow">
                <div>Last hour</div>
                <div className="muted">
                  {count(sent, 'message sent', 'messages sent')} · {queued} queued · {count(started, 'chat started', 'chats started')}
                </div>
              </div>
            </div>
            <WorkerUpdatesSettings />
          </>
        ) : (
          <div className="kv">
            <Info size={18} />
            <div className="grow muted">
              To turn it on, set <code>"bridge": {'{ "enabled": true }'}</code> in the server config and restart
              Wayroost. See docs/configuration.md.
            </div>
          </div>
        )}
      </div>
    </>
  );
}

const timeBoxLabel = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);

/**
 * Worker updates (the task log): whether Wayroost tells a Hermes chat about the
 * Paseo workers it started, and the time box for workers that don't set one.
 * Hidden where the server has no task log (a shadow runs none).
 */
function WorkerUpdatesSettings() {
  const desktop = useStore((s) => s.device?.kind === 'desktop');
  const [status, setStatus] = useState<WorkerUpdatesStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.workerUpdates().then(
      (s) => {
        if (live) setStatus(s);
      },
      () => {}, // no task log here (or an older server): no rows
    );
    return () => {
      live = false;
    };
  }, []);

  if (!status) return null;

  const save = async (patch: { enabled?: boolean; defaultMinutes?: number }) => {
    if (!desktop) return;
    setBusy(true);
    try {
      setStatus(await api.setWorkerUpdates(patch));
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="kv">
        <ListChecks size={18} />
        <div className="grow">
          <div>Worker updates</div>
          <div className="muted">
            {status.enabled
              ? 'When a Paseo worker that a Hermes chat started stops, waits on you or runs late, Wayroost tells that chat. Completion updates may repeat wait results. Pause holds these too.'
              : "Off: Hermes hears about its Paseo workers only through its own waits. What happens while it's off isn't sent later."}
          </div>
          {!desktop && <div className="muted">Change this on a paired desktop.</div>}
          <SettingsTiming timing="now" />
        </div>
        {busy && <LoaderCircle size={16} className="spin" />}
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={status.enabled}
          aria-label="Worker updates"
          disabled={busy || !desktop}
          onClick={() => save({ enabled: !status.enabled })}
        />
      </div>
      {status.enabled && (
        <div className="kv">
          <Timer size={18} />
          <div className="grow">
            <div>Time box</div>
            <div className="muted">
              For workers that don't set their own. A late one gets a reminder in its chat, and you get a For-you card 15 minutes later.
            </div>
            <SettingsTiming timing="now" />
          </div>
          <select
            value={status.defaultMinutes}
            onChange={(e) => save({ defaultMinutes: Number(e.target.value) })}
            disabled={busy || !desktop}
            aria-label="Time box for workers"
          >
            {status.timeBoxes.map((m) => (
              <option key={m} value={m}>
                {timeBoxLabel(m)}
              </option>
            ))}
          </select>
        </div>
      )}
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
  const writable = useStore(s => s.rollout?.settingsPages === true);
  const rolloutGeneration = useStore(() => getRolloutGeneration('settingsPages'));
  const desktop = useStore((s) => s.device?.kind === 'desktop');
  const [agents, setAgents] = useState<CloudAgent[] | null>(null);
  const [busy, setBusy] = useState<CloudAgentId | null>(null);
  useEffect(() => { setBusy(null); }, [rolloutGeneration]);

  useEffect(() => {
    let live = true;
    const rollout = captureRollout(...(writable ? ['settingsPages' as const] : []));
    api.cloudAgents().then(
      (status) => {
        if (live && rollout.still()) setAgents(status.agents);
      },
      () => {}, // Paseo is off or reconnecting, or an older server: no section
    );
    return () => {
      live = false;
    };
  }, [writable, rolloutGeneration]);

  if (!agents?.length) return null;

  const toggle = async (agent: CloudAgent) => {
    const rollout = captureRollout('settingsPages');
    if (!rollout.still() || !desktop) return;
    setBusy(agent.id);
    try {
      const next = await api.setCloudAgent(agent.id, !agent.enabled);
      if (rollout.still()) setAgents(next.agents);
    } catch (err) {
      if (rollout.still()) toast((err as Error).message);
    } finally {
      if (rollout.still()) setBusy(null);
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
              <SettingsTiming timing="next-chat" />
              {!desktop && <div className="muted">Change this on a paired desktop.</div>}
            </div>
            {busy === agent.id && <LoaderCircle size={16} className="spin" />}
            <button
              type="button"
              role="switch"
              className="switch"
              aria-checked={agent.enabled}
              aria-label={agent.label}
              onClick={() => toggle(agent)}
              disabled={busy !== null || !desktop || !writable}
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
  const writable = useStore(s => s.rollout?.settingsPages === true);
  const rolloutGeneration = useStore(() => getRolloutGeneration('settingsPages'));
  const desktop = useStore((s) => s.device?.kind === 'desktop');
  const [status, setStatus] = useState<SafetyCommandsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<ReturnType<typeof captureRollout> | null>(null);

  useEffect(() => { if (!desktop) setConfirming(null); }, [desktop]);

  useEffect(() => {
    let live = true;
    const rollout = captureRollout(...(writable ? ['settingsPages' as const] : []));
    api.safetyCommands().then(
      (s) => {
        if (live && rollout.still()) setStatus(s);
      },
      () => {}, // Hermes is off, or an older server: no row
    );
    return () => {
      live = false;
    };
  }, [writable, rolloutGeneration]);

  useEffect(() => { setConfirming(null); setBusy(false); }, [rolloutGeneration]);

  const save = async (enabled: boolean, rollout = captureRollout('settingsPages')) => {
    if (!rollout.still() || !desktop) { setConfirming(null); return; }
    setBusy(true);
    try {
      const next = await api.setSafetyCommands(enabled);
      if (!rollout.still()) return;
      setStatus(next);
      setConfirming(null);
    } catch (err) {
      if (rollout.still()) toast((err as Error).message);
    } finally {
      if (rollout.still()) setBusy(false);
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
          <SettingsTiming timing="now" />
          {!desktop && <div className="muted">Change this on a paired desktop.</div>}
        </div>
        {busy && <LoaderCircle size={16} className="spin" />}
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={status.enabled}
          aria-label="Hermes safety commands"
          onClick={() => (status.enabled ? save(false) : setConfirming(captureRollout('settingsPages')))}
          disabled={busy || !desktop || !writable}
        />
      </div>
      {confirming?.still() && desktop && (
        <ConfirmDialog
          title="Allow Hermes safety commands?"
          message={`${status.commands.join(', ')} will run from Wayroost, including from your phone. Anyone who can send a message here could then switch off Hermes' approval prompts or upload its logs. You can switch this off again at any time.`}
          confirmLabel="Allow"
          busy={busy}
          danger
          onConfirm={() => { if (confirming) void save(true, confirming); }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  );
}

/** Where "Workers' approvals come to me" stands in Paseo, in plain words. */
function workerApprovalsState(status: WorkerApprovalsStatus): string {
  if (status.config === 'pending') return `Not saved to Paseo yet. ${status.message ?? 'Apply the saved setting on a paired desktop.'}`;
  if (status.reload === 'failed') return 'Saved, but Paseo didn’t confirm it. Apply the saved setting to try again.';
  if (status.reload === 'pending') return 'Saved; waiting for Paseo to take it.';
  return 'In place for agents Paseo starts from now on.';
}

/**
 * "Workers' approvals come to me": agents may not answer other
 * agents' permission requests or switch their modes; those come to you. Separate
 * from Hermes safety commands. Only a paired desktop can change it.
 */
function WorkerApprovalsSettings() {
  const writable = useStore(s => s.rollout?.settingsPages === true);
  const rolloutGeneration = useStore(() => getRolloutGeneration('settingsPages'));
  const device = useStore((s) => s.device);
  const [status, setStatus] = useState<WorkerApprovalsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<ReturnType<typeof captureRollout> | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [choiceRead, setChoiceRead] = useState(false);
  const live = useRef(false);
  const version = useRef(0);
  const saving = useRef(false);
  const reading = useRef<number | null>(null);
  const desktop = device?.kind === 'desktop';

  const refresh = useCallback(async (force = false) => {
    if (!live.current || saving.current || (!force && reading.current !== null)) return;
    const generation = getRolloutGeneration('settingsPages');
    const rollout = captureRollout(...(getState().rollout?.settingsPages === true ? ['settingsPages' as const] : []));
    const request = ++version.current;
    reading.current = request;
    try {
      const next = await api.workerApprovals();
      if (live.current && version.current === request && rollout.still() && generation === getRolloutGeneration('settingsPages')) {
        setStatus(next);
        setConfirmed(next.config === 'written');
        setChoiceRead(next.choiceConfirmed === true);
      }
    } catch {
      if (live.current && version.current === request && rollout.still() && generation === getRolloutGeneration('settingsPages')) {
        setConfirmed(false);
        setChoiceRead(false);
        setConfirming(null);
      }
    } finally {
      if (reading.current === request) reading.current = null;
    }
  }, [writable, rolloutGeneration]);

  useEffect(() => {
    live.current = true;
    saving.current = false;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    const focus = () => void refresh();
    const visible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visible);
    return () => {
      live.current = false;
      version.current++;
      reading.current = null;
      window.clearInterval(timer);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);

  useEffect(() => { setConfirming(null); setBusy(false); }, [rolloutGeneration]);

  const save = async (enabled: boolean, rollout = captureRollout('settingsPages')) => {
    if (!rollout.still() || !desktop || saving.current) { setConfirming(null); return; }
    const generation = getRolloutGeneration('settingsPages');
    saving.current = true;
    const request = ++version.current;
    setBusy(true);
    setConfirmed(false);
    setChoiceRead(false);
    try {
      const next = await api.setWorkerApprovals(enabled);
      if (live.current && version.current === request && rollout.still() && generation === getRolloutGeneration('settingsPages')) {
        setStatus(next);
        setConfirmed(next.config === 'written');
        setChoiceRead(next.choiceConfirmed === true);
        setConfirming(null);
      }
    } catch (err) {
      if (live.current && rollout.still()) {
        toast((err as Error).message);
        setConfirming(null);
        // A failed response may follow a committed write. Verify the saved choice.
        saving.current = false;
        await refresh(true);
      }
    } finally {
      if (rollout.still()) {
        saving.current = false;
        if (live.current) setBusy(false);
      }
    }
  };

  const verified = confirmed ? status : null;
  const pendingChoice = choiceRead && status && (status.config === 'pending' || status.reload !== 'applied') ? status : null;
  const uncovered = verified?.uncoveredProviders ?? [];
  return (
    <>
      <div className="kv worker-approvals">
        {verified?.enabled ? <ShieldCheck size={18} /> : <TriangleAlert size={18} />}
        <div className="grow">
          <div>Workers&rsquo; approvals come to me</div>
          <div className="muted">
            {!verified
              ? 'The setting is not confirmed. Check again before changing it.'
              : verified.enabled
              ? 'On: an agent can’t answer another agent’s permission request or switch its mode. Those wait for you. Worker and reviewer agents never get those tools.'
              : 'Off: an agent that starts other agents can answer their permission requests and switch their modes. Worker and reviewer agents still never get those tools.'}
          </div>
          {verified && <div className="muted">{workerApprovalsState(verified)}</div>}
          {!verified && pendingChoice && <div className="muted">Saved choice: {pendingChoice.enabled ? 'On' : 'Off'}. Its policy is not confirmed.</div>}
          {!verified && status?.config === 'pending' && status.message && <div className="muted">{status.message}</div>}
          {uncovered.length > 0 && (
            <div className="muted">Not covered: {uncovered.join(', ')}. Paseo has no limit for these that Wayroost can set.</div>
          )}
          <div className="muted worker-approvals-gaps">
            Agents already running keep their old limits until they restart, and this is a guardrail in Paseo, not a
            locked door.
          </div>
          {!desktop && <div className="muted">Change this on a paired desktop.</div>}
          <SettingsTiming timing="next-chat" />
        </div>
        {busy && <LoaderCircle size={16} className="spin" />}
        {pendingChoice && <button type="button" className="btn btn-secondary" onClick={() => void save(pendingChoice.enabled)} disabled={busy || !desktop || !writable}>
          Apply saved setting
        </button>}
        {verified ? <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={verified.enabled}
          aria-label="Workers' approvals come to me"
          onClick={() => (verified.enabled ? setConfirming(captureRollout('settingsPages')) : save(true))}
          disabled={busy || !desktop || !writable}
        /> : <button type="button" className="btn btn-secondary" onClick={() => void refresh(true)} disabled={busy}>
          Check again
        </button>}
      </div>
      {confirming?.still() && (
        <ConfirmDialog
          title="Let agents answer each other?"
          message="Agents that start other agents could then answer their permission requests and switch their modes, without asking you. You can switch this back on at any time."
          confirmLabel="Turn off"
          busy={busy}
          danger
          onConfirm={() => { if (confirming) void save(false, confirming); }}
          onCancel={() => setConfirming(null)}
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
            <SettingsTiming timing="now" />
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
              <SettingsTiming timing="restart" />
            </div>
          </div>
        )}
        <div className="kv">
          <Reply size={18} />
          <div className="grow">
            <div>Replies go back to the chat that messaged you</div>
            <div className="muted">When another Hermes chat sends you a WhatsApp message, quote-reply to it</div>
            <SettingsTiming timing={wa.active ? 'now' : 'restart'} />
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
            <SettingsTiming timing={wa.active ? 'now' : 'restart'} />
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
            <SettingsTiming timing={wa.active ? 'now' : 'restart'} />
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
            <SettingsTiming timing="now" />
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

/** The app output is shared; microphone and playback preferences are per device. */
function VoiceSettings({ loadCloud = false }: { loadCloud?: boolean }) {
  const status = useVoiceStatus();
  const settings = useVoiceSettings();
  const [saving, setSaving] = useState(false);
  const [catalog, setCatalog] = useState<NonNullable<import('../../../shared/protocol').VoiceStatus['cloud']>>();
  useEffect(() => {
    if (!loadCloud || !status?.enabled || !status.canChange) return;
    let active = true;
    api.voiceCatalog().then(next => { if (active) setCatalog(next); }, () => {
      if (active) setCatalog({ available: false, voices: [], models: [], error: 'unreachable' });
    });
    return () => { active = false; };
  }, [loadCloud, status?.enabled, status?.canChange]);
  if (!status?.enabled) return null;
  const previewLocal = (next: string) => readMessage('settings', sampleLine(next), 'preview', next);
  const voice = status.defaultVoice;
  const choice = status.appReadAloud ?? { provider: 'local' as const };
  const cloud = catalog ?? status.cloud;
  const readOnly = !status.canChange;
  const saveOutput = async (next: import('../../../shared/voice').AppVoice) => {
    setSaving(true);
    try {
      setVoiceStatus(await api.setAppVoice(next));
      readMessage('settings', 'This is how replies will sound.');
    } catch (err) { toast((err as Error).message); }
    finally { setSaving(false); }
  };

  const choose = async (next: string) => {
    if (next === voice) return void previewLocal(next);
    setSaving(true);
    try {
      const result = await api.setVoice(next);
      setVoiceStatus(result);
      if (result.calls === 'failed') toast(result.callsMessage ?? 'App voice saved. The phone and car lines could not be updated.');
      void previewLocal(next);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <div className="group-title">Voice</div>
      <div className="group voice-settings">
        <div className="kv">
          <AudioLines size={18} />
          <div className="grow">
            <div>App read-aloud</div>
            <div className="muted">Choose on a paired desktop. The local voice is the fallback.</div>
            <SettingsTiming timing="now" />
          </div>
          <select aria-label="App read-aloud provider" value={choice.provider} disabled={saving || readOnly}
            onChange={e => void saveOutput(e.target.value === 'local' ? { provider: 'local' } : { provider: 'elevenlabs', voiceId: cloud?.voices[0]?.id, modelId: cloud?.models[0]?.id })}>
            <option value="local">Local voice</option>
            <option value="elevenlabs" disabled={!cloud?.available || !cloud.voices.length || !cloud.models.length}>ElevenLabs</option>
          </select>
        </div>
        <div className="kv">
          <Cloud size={18} />
          <div className="grow muted">
            <div>Text read in an ElevenLabs voice is sent to ElevenLabs.</div>
            {!cloud?.available && <div>{loadCloud ? 'Add a root-only file at /etc/wayroost/elevenlabs-api-key, then re-run the installer.' : 'Open Voice settings on a paired desktop to load the ElevenLabs picker.'}</div>}
            {cloud?.error && <div>ElevenLabs is unavailable ({cloud.error}); app read-aloud falls back to the local voice.</div>}
            {readOnly && <div>Voice choices are read-only on this device.</div>}
          </div>
        </div>
        {choice.provider === 'elevenlabs' && <>
          <div className="kv">
            <div className="grow">ElevenLabs voice <SettingsTiming timing="now" /></div>
            <select aria-label="ElevenLabs voice" value={choice.voiceId} disabled={saving || readOnly}
              onChange={e => void saveOutput({ ...choice, voiceId: e.target.value, modelId: cloud?.models.some(m => m.id === choice.modelId) ? choice.modelId : cloud?.models[0]?.id })}>
              {!cloud?.voices.some(v => v.id === choice.voiceId) && <option value={choice.voiceId} disabled>{cloud?.available ? 'Saved voice is no longer in your account' : 'Saved ElevenLabs voice'}</option>}
              {cloud?.voices.map(v => <option key={v.id} value={v.id}>{v.name} ({v.category})</option>)}
            </select>
            <button type="button" className="btn btn-secondary" aria-label="Play ElevenLabs sample"
              onClick={() => readMessage('settings', 'This is how replies will sound.')}><Play size={16} /></button>
          </div>
          <div className="kv">
            <div className="grow">ElevenLabs model <SettingsTiming timing="now" /></div>
            <select aria-label="ElevenLabs model" value={choice.modelId} disabled={saving || readOnly}
              onChange={e => void saveOutput({ ...choice, modelId: e.target.value, voiceId: cloud?.voices.some(v => v.id === choice.voiceId) ? choice.voiceId : cloud?.voices[0]?.id })}>
              {!cloud?.models.some(m => m.id === choice.modelId) && <option value={choice.modelId} disabled>{cloud?.available ? 'Saved model is no longer available' : 'Saved ElevenLabs model'}</option>}
              {cloud?.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        </>}
        {['Hermes voice notes', 'Phone line', 'Car line'].map(output => <div className="kv" key={output}>
          <div className="grow">{output}</div><div className="muted">local voice (ElevenLabs coming later)</div>
        </div>)}
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
            <SettingsTiming timing="now" />
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
            <SettingsTiming timing="now" />
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
                <div>Local voice</div>
                <SettingsTiming timing="now" />
              </div>
              <select value={voice} onChange={(e) => void choose(e.target.value)} disabled={saving || readOnly} aria-label="Voice">
                {status.voices.map((v) => (
                  <option key={v} value={v}>
                    {voiceLabel(v)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void previewLocal(voice)}
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
                <SettingsTiming timing="now" />
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
            Hold the mic in a chat to talk, or tap it to start and tap again to finish. Speech-to-text stays on your PC.
            Picking an app voice plays a sample. Microphone preferences and speed apply to this device.
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

const SETTINGS_GROUPS = {
  'Overview': [
    'connection', 'hermes', 'paseo', 'offline', 'status', 'recent', 'changes', 'undo', 'Hermes sign-in', 'Signed in to the Hermes dashboard', 'Sign out',
    'Hermes dashboard username', 'Password', 'Connect Hermes',
  ],
  'You': [
    'ways to reach me', 'whatsapp', 'phone', 'pin', 'notifications', 'for you', 'voice', 'app', 'theme',
    'Replies go back to the chat that messaged you', 'Back to your WhatsApp chat after', 'Start a fresh WhatsApp chat',
    'How often Hermes speaks up', 'Quiet hours', 'Quiet hours start', 'Quiet hours end', 'Notifications on this device',
    'When an agent needs you', 'New For-you cards', 'Send a test', 'Less like this',
    'Read replies aloud', 'Send what you say right away', 'Speed', 'Play this voice', 'Try it', 'Theme', 'Light', 'Dark', 'Text size and language',
    'Set a PIN', 'New PIN', 'Choose a PIN', 'Set PIN', 'Change PIN', 'Change', 'Show PIN', 'Hide PIN',
  ],
  'Your AI': ['agents', 'models', 'cloud', 'connectors', 'gmail', 'skills', 'memory', 'persona', 'Cloud agents', 'Memory & persona', 'safety'],
  'Work': [
    'scheduled', 'jobs', 'automation', 'chats', 'projects', 'archive', 'bridge', 'Scheduled jobs', 'Tidy up',
    'Archived threads', 'Archive threads idle for more than', 'View', 'Project bridge', 'Last hour', 'Pause', 'Resume', 'New jobs and triggers',
  ],
  'Safety & access': ['safety', 'approval', 'worker', 'cloudflare', 'access', 'devices', 'pairing', "Workers' approvals come to me", 'Hermes safety commands', 'Approvals are never automatic', 'Sign out'],
  'This PC': ['status', 'power', 'model', 'restart', 'updates', 'diagnostics', 'advanced', 'ports', 'Status & power', 'Updates & diagnostics'],
};

export function VoicePage() {
  const status = useVoiceStatus();
  return <Page className="page-settings" title="Voice">
    {status?.enabled ? <VoiceSettings loadCloud /> : <div className="group"><div className="kv">{status ? 'Local voice mode is off. Set up the speech service on this PC first.' : 'Checking local voice…'}</div></div>}
  </Page>;
}
type SettingsGroup = keyof typeof SETTINGS_GROUPS;

/** Does this belong under the current search? An empty box shows everything. */
function matches(query: string, ...texts: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  return !q || texts.some((text) => text?.toLowerCase().includes(q));
}

/** One settings group: a label, then its pages and settings. */
function Group({
  label,
  query,
  indexed,
  onIndex,
  children,
}: {
  label: SettingsGroup;
  query: string;
  indexed: Partial<Record<SettingsGroup, string[]>>;
  onIndex: (label: SettingsGroup, terms: string[]) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const visible = matches(query, label, ...SETTINGS_GROUPS[label], ...(indexed[label] ?? []));
  useEffect(() => {
    const group = ref.current;
    if (!group) return;
    // Keep control labels searchable, including names loaded after the page opens.
    const index = () => {
      const terms = [...group.querySelectorAll('input, select, button, a')].flatMap((control) => [
        control.getAttribute('aria-label'),
        control.getAttribute('placeholder'),
        control.textContent?.trim(),
        control.closest('label')?.textContent?.trim(),
      ]).filter((term): term is string => Boolean(term));
      onIndex(label, [...new Set(terms)]);
    };
    index();
    const observer = new MutationObserver(index);
    observer.observe(group, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'placeholder'] });
    return () => observer.disconnect();
  }, [label, onIndex]);
  return (
    <section ref={ref} className="settings-group" hidden={!visible}>
      <p className="side-label">{label}</p>
      {children}
    </section>
  );
}

/** A row that opens a page of its own — the same row the sheets used, now going to a URL. */
function PageRow({ icon, title, help, to }: { icon: ReactNode; title: string; help: string; to: string }) {
  return (
    <button type="button" className="kv settings-link" onClick={() => navigate(to)}>
      {icon}
      <div className="grow">
        <div>{title}</div>
        <div className="muted">{help}</div>
      </div>
      <ChevronRight size={18} aria-hidden="true" />
    </button>
  );
}

/** A page that is in the plan but has nothing to set yet; it shows where it will live. */
function LaterRow({ icon, title, help }: { icon: ReactNode; title: string; help: string }) {
  return (
    <div className="kv">
      {icon}
      <div className="grow">
        <div>{title}</div>
        <div className="muted">{help}</div>
      </div>
    </div>
  );
}

/** Theme: light, dark, or the computer's own setting. Saved on this device only. */
function ThemeSetting() {
  const [theme, setChoice] = useState<Theme>(currentTheme);
  return (
    <div className="kv">
      <Palette size={18} />
      <div className="grow">
        <div>Theme</div>
        <div className="muted">Light, dark, or follow this device</div>
        <SettingsTiming timing="now" />
      </div>
      <select
        value={theme}
        onChange={(e) => {
          const next = e.target.value as Theme;
          setTheme(next);
          setChoice(next);
        }}
        aria-label="Theme"
      >
        <option value="system">Follow this device</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </div>
  );
}

/**
 * Settings: every setting filed under its group, each place a page
 * with its own URL, and a box that filters the list. What used to be one long sheet is
 * the index page; the sheets it opened (Connectors, Skills, Scheduled jobs, Archived)
 * are pages under /settings now.
 */
export function SettingsPage() {
  const writable = useStore(s => s.rollout?.settingsPages === true);
  const email = useStore((s) => s.email);
  const device = useStore((s) => s.device);
  const statuses = useStore((s) => s.statuses);
  const [query, setQuery] = useState('');
  const [indexed, setIndexed] = useState<Partial<Record<SettingsGroup, string[]>>>({});
  const indexGroup = useCallback((label: SettingsGroup, terms: string[]) => {
    setIndexed((current) => {
      const previous = current[label];
      // Keep learned labels as controls change while their group is filtered out.
      const combined = [...new Set([...(previous ?? []), ...terms])];
      if (previous?.length === combined.length) return current;
      return { ...current, [label]: combined };
    });
  }, []);
  const [disconnecting, setDisconnecting] = useState(false);
  const rolloutGeneration = useStore(() => getRolloutGeneration('settingsPages'));
  useEffect(() => { setDisconnecting(false); }, [rolloutGeneration]);
  const enabled = useEnabledSources();
  const hermes = statuses.hermes;

  const disconnectHermes = async () => {
    const rollout = captureRollout('settingsPages');
    if (!rollout.still()) return;
    setDisconnecting(true);
    try {
      const { status } = await api.clearHermesCredentials();
      if (!rollout.still()) return;
      applyStatus(status);
      refreshList(rollout).catch(() => {});
    } catch (err) {
      if (rollout.still()) toast((err as Error).message);
    } finally {
      if (rollout.still()) setDisconnecting(false);
    }
  };

  return (
    <Page className="page-settings" title="Settings">
      <label className="search settings-search">
        <Search size={17} aria-hidden="true" />
        <input
          type="search"
          placeholder="Search settings"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search settings"
        />
      </label>

      <Group label="Overview" query={query} indexed={indexed} onIndex={indexGroup}>
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
          {enabled.length === 0 && (
            <div className="kv">
              <Info size={18} aria-hidden="true" />
              <div className="grow muted">Neither engine is switched on in the server config.</div>
            </div>
          )}
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
                <SettingsTiming timing="now" />
              </div>
              <button type="button" className="btn btn-secondary" onClick={disconnectHermes} disabled={disconnecting || !writable}>
                {disconnecting && <LoaderCircle size={16} className="spin" />}
                Sign out
              </button>
            </div>
          </div>
        )}
        <RecentChanges />
      </Group>

      <Group label="You" query={query} indexed={indexed} onIndex={indexGroup}>
        <WhatsAppSettings />
        <PhoneSettings />
        {enabled.includes('hermes') && <ForYouSettings />}
        <NotificationRules />
        <VoiceSettings />
        <div className="group">
          <PageRow icon={<AudioLines size={18} />} title="Voice settings" help="Choose the app read-aloud provider, voice and model" to={settingsPath('voice')} />
        </div>
        <div className="group-title">App</div>
        <div className="group">
          <ThemeSetting />
          <LaterRow icon={<Type size={18} />} title="Text size and language" help="Bigger text and other languages come later." />
        </div>
      </Group>

      <Group label="Your AI" query={query} indexed={indexed} onIndex={indexGroup}>
        <div className="group">
          <PageRow
            icon={<Waypoints size={18} />}
            title="Agents"
            help="How Hermes behaves, which Paseo agents may start, profiles and delegation limits"
            to={settingsPath('agents')}
          />
          <PageRow
            icon={<Gauge size={18} />}
            title="Models & accounts"
            help="What serves each role, keys, subscriptions and usage"
            to={settingsPath('models')}
          />
        </div>
        {enabled.includes('paseo') && <CloudAgentsSettings />}
        <div className="group-title">Connectors and skills</div>
        <div className="group">
          {enabled.includes('hermes') && (
            <PageRow
              icon={<PlugZap size={18} />}
              title="Connectors"
              help="Let Hermes use Gmail, Notion, Todoist and more"
              to={settingsPath('connectors')}
            />
          )}
          <PageRow
            icon={<BookOpen size={18} />}
            title="Skills"
            help="Every agent's skills, kept the same everywhere, plus the marketplace"
            to={settingsPath('skills')}
          />
          <LaterRow icon={<Brain size={18} />} title="Memory & persona" help="What the agents are told about you, and how they should behave." />
        </div>
      </Group>

      <Group label="Work" query={query} indexed={indexed} onIndex={indexGroup}>
        <div className="group">
          <PageRow
            icon={<CalendarClock size={18} />}
            title="Scheduled jobs"
            help="What Hermes and Paseo run on a schedule, and how each run went"
            to="/schedule"
          />
        </div>
        {enabled.length > 0 && <TidySettings onArchived={() => navigate(settingsPath('archived'))} />}
        <BridgeSettings />
        <div className="group-title">Automation defaults</div>
        <div className="group">
          <LaterRow icon={<SlidersHorizontal size={18} />} title="New jobs and triggers" help="Where a job sends its result and what it may touch, by default." />
        </div>
      </Group>

      <Group label="Safety & access" query={query} indexed={indexed} onIndex={indexGroup}>
        <div className="group-title">Safety</div>
        <div className="group">
          <PageRow
            icon={<ShieldCheck size={18} />}
            title="Safety"
            help="Approval mode, the always-allowed list, staging and the workers’ switch"
            to={settingsPath('safety')}
          />
          <PageRow
            icon={<ShieldCheck size={18} />}
            title="Checks"
            help="Comparisons reported by this PC and fixes for mismatches"
            to={settingsPath('checks')}
          />
        </div>
        <div className="group">
          {/* Signed in through Cloudflare Access: only then is there an Access session to end. */}
          {email && (
            <div className="kv">
              <Lock size={18} />
              <div className="grow">
                <div>Cloudflare Access</div>
                <div className="muted">{email}</div>
              </div>
              <a className="btn btn-secondary" href="/cdn-cgi/access/logout">
                <LogOut size={16} /> Sign out
              </a>
            </div>
          )}
          {enabled.includes('paseo') && <WorkerApprovalsSettings />}
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
        <div className="group-title">Devices & access</div>
        <div className="group">
          <PageRow
            icon={<MonitorSmartphone size={18} />}
            title="Devices"
            help={`${device ? `Signed in as ${device.name}. ` : ''}Pair a phone, rename or revoke devices`}
            to={settingsPath('devices')}
          />
        </div>
      </Group>

      <Group label="This PC" query={query} indexed={indexed} onIndex={indexGroup}>
        <div className="group">
          <PageRow
            icon={<Activity size={18} />}
            title="Status & power"
            help="What is running, what failed, and how to restart it"
            to={settingsPath('status')}
          />
          <LaterRow icon={<Gauge size={18} />} title="Updates & diagnostics" help="Check what version this is, and gather what went wrong." />
          <LaterRow icon={<Wrench size={18} />} title="Advanced" help="Engine names, ports and the switches an install may need." />
        </div>
      </Group>

      {query.trim() && !Object.entries(SETTINGS_GROUPS).some(([label, keywords]) => matches(query, label, ...keywords, ...(indexed[label as SettingsGroup] ?? []))) && (
        <p className="muted settings-empty">
          <Search size={14} aria-hidden="true" /> Nothing here matches that. Settings that aren&rsquo;t built yet are
          listed where they will live.
        </p>
      )}
    </Page>
  );
}
