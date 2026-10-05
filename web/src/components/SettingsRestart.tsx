import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { drainRunResult, type DrainRestartRun } from '../../../shared/supervisor-config.js';
import type { DrainRestartComponent } from '../../../shared/settings.js';
import { api } from '../api.js';
import { settingsErrorText, settingsRestartResponseSchema, type SettingsRestartPayload } from '../settingsModel.js';
import { useStore } from '../store.js';
import { LevelChip, SettingsConfirmPrompt, TimingNotes } from './SettingsRows.js';

/**
 * Whether an observed run replaces the one a restart control shows. A different run replaces it only when it
 * started later. The same run never loses its end; while it runs, only a fresh status poll updates it, so a
 * delayed request answer or page snapshot can't move it backwards.
 */
export function supersedes(known: DrainRestartRun | undefined, incoming: DrainRestartRun, source: 'snapshot' | 'poll' | 'request'): boolean {
  if (!known) return true;
  if (incoming.id !== known.id) return incoming.startedAt > known.startedAt;
  if (known.endedAt !== undefined) return false;
  return incoming.endedAt !== undefined || source === 'poll';
}

function resultFor(run: DrainRestartRun): SettingsRestartPayload {
  const code = drainRunResult(run);
  return code === 'pending' ? { status: 'accepted', run } : code === 'ok' ? { status: 'completed', run } : { status: 'refused', code, run };
}

/** Restart choices send only the component and timing named by the server. */
export function SettingsRestart({ component, when, disabled = false, refreshing = false, disableWhileRunning = false, initialRun, onAccepted }: {
  component: DrainRestartComponent;
  when?: 'idle' | 'now';
  disabled?: boolean;
  refreshing?: boolean;
  disableWhileRunning?: boolean;
  initialRun?: DrainRestartRun;
  onAccepted?: () => void;
}) {
  const device = useStore(s => s.device);
  const hasAccess = !!device?.scopes.includes('settings');
  const unavailable = disabled || !hasAccess;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SettingsRestartPayload>();
  const [trackedRun, setTrackedRun] = useState<DrainRestartRun>();
  const trackedRef = useRef<DrainRestartRun | undefined>(undefined);
  const [readError, setReadError] = useState(false);
  const run = result && 'run' in result ? result.run : undefined;
  const currentRun = run ?? trackedRun ?? initialRun;
  trackedRef.current = run ?? trackedRun;
  const running = disableWhileRunning && (!!currentRun && currentRun.endedAt === undefined || result?.status === 'accepted' && !run);
  const readOnly = unavailable || refreshing || running;
  // Follow the tracked run to its end, whatever later requests answer (a second request may be refused as busy).
  const pollId = currentRun && currentRun.endedAt === undefined && currentRun.component === component ? currentRun.id : undefined;
  const [pending, setPending] = useState<{ when: 'idle' | 'now'; code?: string; summary: string; expiresAt?: number } | null>(null);
  const sequence = useRef(0);
  const available = useRef(!readOnly);
  available.current = !readOnly;
  const authorized = useRef(!unavailable);
  authorized.current = hasAccess;
  const accepted = useRef(onAccepted);
  accepted.current = onAccepted;
  // A different component, device or access level starts afresh; a different timing only closes an open
  // confirmation, so runs already observed stay under the one ordering rule.
  useEffect(() => {
    setPending(null);
    setBusy(false);
    setResult(undefined);
    setTrackedRun(undefined);
    trackedRef.current = undefined;
    return () => { ++sequence.current; };
  }, [component, device?.id, hasAccess]);
  useEffect(() => { setPending(null); }, [when]);
  useEffect(() => { if (unavailable) setPending(null); }, [unavailable]);

  /** Show an observed run, if it supersedes the one shown (one rule for snapshots, polls and request answers). */
  const adopt = (observed: DrainRestartRun, source: 'snapshot' | 'poll' | 'request', payload?: SettingsRestartPayload) => {
    if (observed.component !== component || !supersedes(trackedRef.current, observed, source)) return false;
    trackedRef.current = observed;
    setReadError(false);
    setTrackedRun(observed);
    setResult(payload && 'run' in payload && payload.run?.id === observed.id ? payload : resultFor(observed));
    return true;
  };
  useEffect(() => {
    if (hasAccess && initialRun) adopt(initialRun, 'snapshot');
  }, [initialRun, component, hasAccess]);
  useEffect(() => {
    if (!pollId || !hasAccess) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const parsed = settingsRestartResponseSchema.safeParse(await api.settingsRestartRun(pollId));
        if (!live) return;
        if (!parsed.success || !('run' in parsed.data) || !parsed.data.run || parsed.data.run.id !== pollId || parsed.data.run.component !== component) {
          setReadError(true);
        } else {
          adopt(parsed.data.run, 'poll', parsed.data);
          if (parsed.data.run.endedAt !== undefined) return;
        }
      } catch { if (live) setReadError(true); }
      if (live) timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { live = false; clearTimeout(timer); };
  }, [pollId, component, hasAccess]);

  const send = async (choice: 'idle' | 'now', code?: string) => {
    if (!available.current) return;
    const mine = ++sequence.current;
    setBusy(true);
    setPending(null);
    setResult(undefined);
    let answer: SettingsRestartPayload;
    try {
      const parsed = settingsRestartResponseSchema.safeParse(await api.settingsRestart(component, choice, code));
      answer = parsed.success ? parsed.data : { status: 'refused', code: 'unavailable' };
    } catch {
      answer = { status: 'refused', code: 'unavailable' };
    }
    if (mine !== sequence.current || !authorized.current) return;
    setBusy(false);
    if (answer.status === 'confirm') {
      setPending({ when: choice, code: answer.confirm, summary: answer.summary, expiresAt: answer.expiresAt });
    } else {
      // A request answer with a run follows the same rule as polls and snapshots; one without a run
      // (refused as busy, say) only reports itself and keeps the tracked run.
      if ('run' in answer && answer.run) adopt(answer.run, 'request', answer);
      else setResult(answer);
      if (answer.status === 'accepted' || answer.status === 'completed') accepted.current?.();
    }
  };
  const choose = (choice: 'idle' | 'now') => {
    if (choice === 'now') {
      setPending({ when: choice, summary: 'Restart now may interrupt active work. Continue?' });
    } else void send(choice);
  };
  return <div className="setting-stack">
    <div className="setting-inline">
      {(when ? [when] : component === 'dashboard' ? ['now'] as const : ['idle', 'now'] as const).map(choice =>
        <button key={choice} type="button" className="btn btn-secondary" disabled={readOnly || busy || pending !== null} onClick={() => choose(choice)}>
          {busy && <LoaderCircle size={16} className="spin" />}{choice === 'idle' ? 'Restart when idle' : 'Restart now'}
        </button>)}
      <LevelChip level="confirm" />
    </div>
    {running && <div className="muted">Another restart can be requested after the tracked run ends.</div>}
    {when && <TimingNotes timing={[{ label: when === 'idle' ? `restart-when-idle:${component}` : `restart-now:${component}` }]} />}
    {result && <div role="status" className="muted">
      {result.status === 'accepted' ? 'Restart accepted. ' : result.status === 'completed' ? 'Restart completed. '
        : result.status === 'refused' ? settingsErrorText(result.code) : null}
      {currentRun && <>State: {currentRun.state}.{currentRun.busy.length > 0 && <> Waiting for: {currentRun.busy.join(', ')}.</>}
        {currentRun.outcome && <> Outcome: {currentRun.outcome}.</>}{currentRun.code && <> {settingsErrorText(currentRun.code)}</>}</>}
      {result.status === 'accepted' && !run && 'The server did not report a run state.'}
      {'timing' in result && result.timing && <TimingNotes timing={result.timing} />}
      {readError && <div>The restart status could not be read. Checking again…</div>}
    </div>}
    <SettingsConfirmPrompt pending={pending} busy={busy} disabled={readOnly}
      onConfirm={() => { if (pending) void send(pending.when, pending.code); }}
      onCancel={() => { ++sequence.current; setPending(null); }} />
  </div>;
}
