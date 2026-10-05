import { WorkerApprovalsStatus } from '../../../shared/safety.js';
import { LoaderCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type { SettingsApplyResponse, SettingsErrorCode, SettingsLevel, SettingsSection, Timing } from '../../../shared/settings.js';
import type { CloudAgent, CloudAgentsStatus, DeviceInfo } from '../../../shared/protocol.js';
import { api } from '../api.js';
import { toast, useStore } from '../store.js';
import { setState as setStoreState } from '../store.js';
import { READ_VIEWS, operationKeys, operationSpec, operationTarget, undoLevel, type ReadViewId } from '../../../shared/settings-ops.js';
import { useFocusTrap } from './common.js';
import { changeToastText, describeApplyResponse, failedOutcome, isSettingsSectionPayload, LEVEL_LABEL, LEVEL_TIP, settingsErrorText, timingSentence, type ApplyOutcome, type RecentChange, type RowAccess, type SettingsSectionPayload } from '../settingsModel.js';

/** The level a row carries, beside its title: who may change it, and from where. */
export function LevelChip({ level }: { level: SettingsLevel }) {
  return <span className="level-chip" data-level={level} title={LEVEL_TIP[level]}>{LEVEL_LABEL[level]}</span>;
}

/** When a change takes effect, in the same words before the change and after it. */
export function TimingNotes({ timing }: { timing: Timing }) {
  return <small className="setting-timing">{timingSentence(timing)}</small>;
}

/** A value this device may see only as a digest: the value itself lives on the PC. */
export function HiddenNote({ text = 'The exact value is shown on the PC.' }: { text?: string }) {
  return <div className="muted">{text}</div>;
}

/** One row: title with its level, a line of help, its timing, and the control. */
export function SettingRow({
  icon,
  title,
  help,
  level,
  timing,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  help?: ReactNode;
  level?: SettingsLevel;
  timing?: Timing;
  children?: ReactNode;
}) {
  return (
    <div className="kv">
      {icon}
      <div className="grow">
        <div>
          {title}
          {level ? <>&nbsp;<LevelChip level={level} /></> : null}
        </div>
        {help ? <div className="muted">{help}</div> : null}
        {timing ? <TimingNotes timing={timing} /> : null}
      </div>
      {children ? <div className="setting-control">{children}</div> : null}
    </div>
  );
}

/** A read-only row's answer when the file or the read didn't give one. */
export function NoDataLine({ code }: { code?: SettingsErrorCode }) {
  return <div className="muted">{settingsErrorText(code ?? 'unavailable')}</div>;
}

/**
 * A settings section as this device sees it. A refusal is a body with a fixed
 * code, not a thrown error: the page words it. Reads again when any change
 * lands anywhere (the server says which sections moved).
 */
export interface SettingsReadState {
  status: 'loading' | 'ready' | 'error';
  message?: string;
  refreshing?: boolean;
  reload: () => void;
}

export interface SectionState extends SettingsReadState {
  payload?: SettingsSectionPayload;
}

export interface SettingsStatusState<T> extends SettingsReadState {
  value?: T;
}

interface SettingsReadGuard {
  sections: Partial<Record<SettingsSection, SectionState>>;
  readOnly: boolean;
  refreshing: boolean;
  permits: (body: SettingsChangeBody) => boolean;
}

const SettingsReadContext = createContext<SettingsReadGuard | null>(null);
const SettingsSourceContext = createContext<Partial<Record<SettingsSection, SectionState>>>({});

/** Share a section snapshot across controls with different read dependencies. */
export function SettingsSectionSource({ section, children }: { section: SettingsSection; children: ReactNode }) {
  const sources = useContext(SettingsSourceContext);
  const state = useSettingsSectionRead(section);
  return <SettingsSourceContext.Provider value={{ ...sources, [section]: state }}>{children}</SettingsSourceContext.Provider>;
}

export function useSettingsReadOnly(): boolean {
  return useContext(SettingsReadContext)?.readOnly ?? false;
}

export function useSettingsRefreshing(): boolean {
  return useContext(SettingsReadContext)?.refreshing ?? false;
}

export function useSettingsSection(section: SettingsSection): SectionState {
  const guard = useContext(SettingsReadContext);
  const sources = useContext(SettingsSourceContext);
  const shared = guard?.sections[section] ?? sources[section];
  const state = useSettingsSectionRead(section, !shared);
  return shared ?? state;
}

function useSettingsSectionRead(section: SettingsSection, enabled = true): SectionState {
  const version = useStore((s) => s.settingsVersion);
  const [state, setState] = useState<Omit<SectionState, 'reload'>>({ status: 'loading' });
  const seq = useRef(0);
  const reload = useCallback(() => {
    const mine = ++seq.current;
    // Keep loaded editors mounted while a new snapshot is requested.
    setState((current) => ({ ...current, refreshing: true }));
    const failed = (message: string) => {
      if (mine !== seq.current) return;
      setState(current => current.payload
        ? { status: 'error', payload: current.payload, message: `Could not refresh settings. Showing previously loaded values. ${message}` }
        : { status: 'error', message });
    };
    api.settingsSection(section).then(
      (payload) => {
        if (mine !== seq.current) return;
        if (payload && typeof payload === 'object' && 'status' in payload && payload.status === 'refused') {
          failed(settingsErrorText((payload as { code?: SettingsErrorCode }).code));
          return;
        }
        if (!isSettingsSectionPayload(payload, section)) {
          failed(settingsErrorText('unavailable'));
          return;
        }
        setState({ status: 'ready', payload });
      },
      (error: unknown) => {
        failed(error instanceof Error ? error.message : 'This PC did not answer.');
      },
    );
  }, [section]);
  useEffect(() => { if (enabled) reload(); return () => { ++seq.current; }; }, [reload, version, enabled]);
  return { ...state, reload };
}

/** Dependent status reads follow settings changes and ignore superseded responses. */
export function useSettingsStatus<T>(read: () => Promise<unknown>, validate: (value: unknown) => value is T, refreshVersion = 0): SettingsStatusState<T> {
  const version = useStore(s => s.settingsVersion);
  const [state, setState] = useState<Omit<SettingsStatusState<T>, 'reload'>>({ status: 'loading' });
  const seq = useRef(0);
  const reload = useCallback(() => {
    const mine = ++seq.current;
    setState(current => ({ ...current, refreshing: true }));
    const failed = (message: string) => {
      if (mine === seq.current) setState({ status: 'error', message });
    };
    read().then(value => {
      if (mine !== seq.current) return;
      if (value && typeof value === 'object' && 'status' in value && value.status === 'refused') {
        failed(settingsErrorText((value as { code?: SettingsErrorCode }).code));
      } else if (!validate(value)) {
        failed(settingsErrorText('unavailable'));
      } else {
        setState({ status: 'ready', value });
      }
    }, (error: unknown) => failed(error instanceof Error ? error.message : 'This PC did not answer.'));
  }, [read, validate]);
  useEffect(() => { reload(); return () => { ++seq.current; }; }, [reload, version, refreshVersion]);
  return { ...state, reload };
}

function isCloudAgentsStatus(value: unknown): value is CloudAgentsStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<CloudAgentsStatus>;
  return Array.isArray(status.agents) && status.agents.every(value => {
    if (!value || typeof value !== 'object') return false;
    const agent = value as Partial<CloudAgent>;
    return typeof agent.id === 'string' && typeof agent.label === 'string' && typeof agent.enabled === 'boolean'
      && typeof agent.state === 'string' && ['ready', 'off', 'unavailable', 'loading', 'error'].includes(agent.state)
      && (agent.detail === undefined || typeof agent.detail === 'string');
  });
}

export function useSettingsCloudAgents(): SettingsStatusState<CloudAgentsStatus> {
  return useSettingsStatus(api.cloudAgents, isCloudAgentsStatus);
}

/** Undo controls and held requests use the same device-specific restoration access. */
export function accessForUndo(change: RecentChange, device: DeviceInfo | undefined): RowAccess {
  const spec = operationSpec(change.operation);
  const level = spec ? undoLevel(spec) : 'pc-only';
  return change.undoAccess ?? (level === 'pc-only' || !device?.scopes.includes('settings') ? 'read-only'
    : level === 'confirm' && !device.scopes.includes('pc-settings') ? 'confirm' : 'editable');
}

/** A failed read locks its dependent controls, drops their drafts and cancels their held changes. */
export function SettingsSectionGuard({ section, views = [], dependency, reads = [], legacyOperation, children }: {
  section: SettingsSection;
  views?: readonly ReadViewId[];
  dependency?: { section: SettingsSection; views: readonly ReadViewId[] };
  reads?: readonly SettingsReadState[];
  legacyOperation?: string;
  children: ReactNode;
}) {
  const device = useStore(s => s.device);
  const sources = useContext(SettingsSourceContext);
  const own = useSettingsSectionRead(section, !sources[section]);
  const ownDependent = useSettingsSectionRead(dependency?.section ?? section, !!dependency && !sources[dependency.section]);
  const state = sources[section] ?? own;
  const dependent = dependency ? sources[dependency.section] ?? ownDependent : ownDependent;
  const failedView = (read: SectionState, required: readonly ReadViewId[]) => read.status === 'ready'
    ? required.find(view => !viewReady(read.payload, view)) : undefined;
  const usesLegacyWriter = state.payload?.operations?.find(info => info.operation === legacyOperation)?.writer === 'legacy';
  const missing = usesLegacyWriter ? undefined : failedView(state, views);
  const dependentMissing = dependency && !usesLegacyWriter ? failedView(dependent, dependency.views) : undefined;
  const failed = state.status === 'error' || !!missing || !!dependency && !usesLegacyWriter && (dependent.status === 'error' || !!dependentMissing)
    || reads.some(read => read.status === 'error');
  const readOnly = failed || state.status !== 'ready' || !!state.refreshing
    || !!dependency && !usesLegacyWriter && (dependent.status !== 'ready' || !!dependent.refreshing)
    || reads.some(read => read.status !== 'ready' || read.refreshing);
  const refreshing = !failed && (!!state.refreshing || !!dependency && !usesLegacyWriter && !!dependent.refreshing || reads.some(read => read.refreshing));
  const previous = useRef<SettingsSectionPayload | undefined>(undefined);
  const previousDependent = useRef<SettingsSectionPayload | undefined>(undefined);
  if (state.status === 'ready' && !missing) previous.current = state.payload;
  if (dependency && dependent.status === 'ready' && !dependentMissing) previousDependent.current = dependent.payload;
  const [reset, setReset] = useState({ failed, generation: 0 });
  if (reset.failed !== failed) setReset({ failed, generation: reset.generation + (failed ? 1 : 0) });
  const display = (read: SectionState, payload: SettingsSectionPayload | undefined): SectionState => payload
    ? { status: 'ready', payload, reload: read.reload } : read;
  const sections: SettingsReadGuard['sections'] = { [section]: display(state, previous.current ?? state.payload) };
  if (dependency) sections[dependency.section] = display(dependent, previousDependent.current ?? dependent.payload);
  const managed = (dependency?.section === 'safety' ? dependent : state).payload?.views?.find(view => view.view === 'hermes.managed');
  const permits = (body: SettingsChangeBody): boolean => {
    if (readOnly) return false;
    if (!('operation' in body)) {
      const change = state.payload?.changes?.find(entry => entry.id === body.change);
      return !!change?.undoable && accessForUndo(change, device) !== 'read-only';
    }
    const info = state.payload?.operations?.find(entry => entry.operation === body.operation);
    const spec = operationSpec(body.operation);
    const rule = spec?.level;
    const access = rule && 'byParam' in rule ? info?.accessByValue?.[String(body.params[rule.byParam])] ?? info?.access : info?.access;
    if (access === 'read-only' || !access) return false;
    if (body.operation === 'settings.accept-current' || !spec || spec.recovery || operationTarget(spec, body.params) !== 'hermes-config') return true;
    if (!managed?.ok) return false;
    const keys = operationKeys(spec, body.params);
    return keys === 'recorded' || !managed.values?.some(entry => entry.exists && keys.some(key =>
      key.every((part, index) => JSON.stringify(part) === JSON.stringify(entry.path[index]))
      || entry.path.every((part, index) => JSON.stringify(part) === JSON.stringify(key[index]))));
  };
  return <SettingsReadContext.Provider value={{ sections, readOnly, refreshing, permits }}>
    <SettingsReadNotice state={state} view={missing} />
    {dependency && !usesLegacyWriter && <SettingsReadNotice state={dependent} view={dependentMissing} />}
    {reads.map((read, index) => <SettingsReadNotice key={index} state={read} />)}
    {failed && <div className="group"><div className="kv"><div className="grow muted">This section is read-only until its settings can be read.</div></div></div>}
    {reset.generation > 0 && <div className="group"><div className="kv" role="status"><div className="grow muted">Your unsaved changes here were discarded because the settings couldn't be read</div></div></div>}
    <fieldset key={reset.generation} disabled={readOnly} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      {children}
    </fieldset>
  </SettingsReadContext.Provider>;
}

export function viewReady(payload: SettingsSectionPayload | undefined, view: string): boolean {
  return payload?.views?.some((entry) => entry.view === view && entry.ok) ?? false;
}

/** Keep editors on their last readable view while the current read reports its failure. */
export function useSettingsView(state: SectionState, view: ReadViewId): SettingsSectionPayload | undefined {
  const previous = useRef<SettingsSectionPayload | undefined>(undefined);
  const readable = viewReady(state.payload, view);
  useEffect(() => {
    if (readable) previous.current = state.payload;
  }, [state.payload, readable]);
  return readable ? state.payload : previous.current;
}

export function SettingsReadNotice({ state, view }: { state: SectionState; view?: string }) {
  const result = state.payload?.views?.find((entry) => entry.view === view);
  if (state.status === 'ready' && !state.message && !state.refreshing && (!view || result?.ok)) return null;
  const error = state.message ?? (view && state.status === 'ready' && !result?.ok ? settingsErrorText(result?.code ?? 'unavailable') : undefined);
  return <div className="group"><div className="kv" role="status">
    <div className="grow muted">{error ?? (state.status === 'loading' || state.refreshing ? 'Reading settings…' : settingsErrorText(result?.code ?? 'unavailable'))}</div>
    {state.status !== 'loading' && !state.refreshing && <button type="button" className="btn btn-secondary" onClick={state.reload}>Retry</button>}
  </div></div>;
}

/** Refresh clean fields from saved values while keeping edits that have not been saved. */
export function useSettingsDraft<T>(saved: T): [T, Dispatch<SetStateAction<T>>] {
  const [draft, setDraft] = useState(saved);
  const previous = useRef(saved);
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    const before = previous.current;
    previous.current = saved;
    setDraft(current => JSON.stringify(current) === JSON.stringify(before) ? saved : current);
  }, [savedKey]);
  return [draft, setDraft];
}

/** What the section says about one operation, when it lists it. */
export function useOperationAccess(payload: SettingsSectionPayload | undefined, operation: string): RowAccess {
  const info = payload?.operations?.find((candidate) => candidate.operation === operation);
  return info?.access ?? 'read-only';
}

/** The access one operation gets for a particular parameter value. */
export function accessForValue(payload: SettingsSectionPayload | undefined, operation: string, value: string): RowAccess {
  const info = payload?.operations?.find((candidate) => candidate.operation === operation);
  return info?.accessByValue?.[value] ?? info?.access ?? 'read-only';
}

/**
 * A change from a row: send the request; when the answer asks for a confirm
 * code, hold it until the owner taps through the prompt, then send the same
 * request again with the code. Applied changes toast their timing again and
 * refetch (the server also publishes settings_changed).
 */
export type SettingsChangeBody = { operation: string; params: Record<string, unknown>; expected?: unknown } | { change: string };

interface PendingConfirm {
  key: string;
  sequence: number;
  requestOrder: number;
  body: SettingsChangeBody;
  onApplied?: () => void;
  owner: number;
  code: string;
  summary: string;
  expiresAt: number;
}

export interface SettingsChangeRunner {
  busy: string | null;
  pending: PendingConfirm | null;
  run: (key: string, body: SettingsChangeBody, sourceView?: ReadViewId, onApplied?: () => void) => Promise<ApplyOutcome>;
  confirmNow: () => Promise<ApplyOutcome>;
  dismiss: () => void;
}

// One held confirmation at a time, shared across every row on the page: a
// second change replaces the held request, and only the row that holds it
// shows the prompt.
let pendingConfirm: PendingConfirm | null = null;
const confirmListeners = new Set<() => void>();
let confirmSeq = 0;
let requestOrder = 0;
function setPendingConfirm(next: PendingConfirm | null): void {
  pendingConfirm = next;
  for (const notify of confirmListeners) notify();
}
function usePendingConfirm(): PendingConfirm | null {
  return useSyncExternalStore(
    (notify) => { confirmListeners.add(notify); return () => { confirmListeners.delete(notify); }; },
    () => pendingConfirm,
  );
}

export function useSettingsChange(payload?: SettingsSectionPayload, onApplied?: () => void): SettingsChangeRunner {
  const guard = useContext(SettingsReadContext);
  const currentGuard = useRef(guard);
  currentGuard.current = guard;
  const [busy, setBusy] = useState<string | null>(null);
  const sequences = useRef(new Map<string, number>());
  const busyOrder = useRef(0);
  const owner = useRef(++confirmSeq);
  const pending = usePendingConfirm();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (pendingConfirm?.owner === owner.current) setPendingConfirm(null);
    };
  }, []);
  const allowed = (body: SettingsChangeBody) => live.current && (currentGuard.current?.permits(body) ?? true);
  const explainUnavailableUndo = (body: SettingsChangeBody) => {
    if (live.current && 'change' in body && !currentGuard.current?.readOnly) toast('Undo is no longer available for this change.', 'info');
  };
  useEffect(() => {
    if (pendingConfirm?.owner === owner.current && !allowed(pendingConfirm.body) && !guard?.readOnly) {
      const body = pendingConfirm.body;
      setPendingConfirm(null);
      explainUnavailableUndo(body);
    }
  });

  const send = (body: SettingsChangeBody, confirm?: string): Promise<ApplyOutcome> => {
    const legacy = 'operation' in body && payload?.operations?.find(info => 'operation' in body && info.operation === body.operation)?.writer === 'legacy';
    if (legacy && 'operation' in body) {
      const call = body.operation === 'wayroost.safety-commands' ? api.setSafetyCommands(Boolean(body.params.enabled))
        : body.operation === 'paseo.worker-approvals' ? api.setWorkerApprovals(Boolean(body.params.enabled))
        : api.setCloudAgent(body.params.provider as 'claude' | 'codex' | 'opencode', Boolean(body.params.enabled));
      return call.then(raw => {
        const valid = body.operation === 'paseo.worker-approvals' ? WorkerApprovalsStatus.safeParse(raw).success
          : body.operation === 'paseo.provider-enabled' ? isCloudAgentsStatus(raw)
          : !!raw && typeof raw === 'object' && 'enabled' in raw && typeof raw.enabled === 'boolean' && 'commands' in raw && Array.isArray(raw.commands);
        if (!valid) return { kind: 'refused' as const, code: 'unavailable' as const, message: settingsErrorText('unavailable') };
        setStoreState(s => ({ ...s, settingsVersion: s.settingsVersion + 1 }));
        return { kind: 'legacy-applied' as const };
      }, failedOutcome);
    }
    const request: Promise<SettingsApplyResponse> = 'operation' in body
      ? api.settingsApply({ ...body, ...(confirm ? { confirm } : {}) })
      : api.settingsUndo({ ...body, ...(confirm ? { confirm } : {}) });
    return request.then(describeApplyResponse, (error: unknown) => failedOutcome(error));
  };

  type HeldRequest = Omit<PendingConfirm, 'code' | 'summary' | 'expiresAt' | 'owner'>;
  const current = (held: HeldRequest) => live.current && sequences.current.get(held.key) === held.sequence;
  const start = (key: string) => {
    const sequence = (sequences.current.get(key) ?? 0) + 1;
    sequences.current.set(key, sequence);
    const order = ++requestOrder;
    busyOrder.current = order;
    setBusy(key);
    return { key, sequence, requestOrder: order };
  };
  const settle = (outcome: ApplyOutcome, held: HeldRequest): ApplyOutcome => {
    // A superseded response cannot update its row or the shared confirmation.
    if (!current(held)) return outcome;
    if (busyOrder.current === held.requestOrder) setBusy(null);
    if (outcome.kind === 'confirm') {
      if (held.requestOrder === requestOrder) {
        // Hold the latest prompt through a refresh; recheck access when reads settle.
        if (allowed(held.body) || live.current && currentGuard.current?.refreshing) setPendingConfirm({ ...held, owner: owner.current, code: outcome.code, summary: outcome.summary, expiresAt: outcome.expiresAt });
        else explainUnavailableUndo(held.body);
      }
    } else if (pendingConfirm?.owner === owner.current && pendingConfirm.requestOrder === held.requestOrder) {
      setPendingConfirm(null);
    }
    if (outcome.kind === 'legacy-applied') { held.onApplied?.(); onApplied?.(); }
    if (outcome.kind === 'applied') {
      toast(changeToastText(outcome.change), 'info');
      held.onApplied?.();
    }
    if (outcome.kind === 'applied' || outcome.kind === 'refused' && outcome.change) {
      setStoreState((s) => ({ ...s, settingsVersion: s.settingsVersion + 1 }));
      onApplied?.();
    }
    if (outcome.kind === 'refused') toast(outcome.message);
    return outcome;
  };

  const run = async (key: string, body: SettingsChangeBody, sourceView?: ReadViewId, onApplied?: () => void): Promise<ApplyOutcome> => {
    if (!allowed(body)) return { kind: 'refused', code: 'unavailable', message: settingsErrorText('unavailable') };
    const order = start(key);
    if (pendingConfirm) setPendingConfirm(null);
    if ('operation' in body && payload?.operations?.find(info => 'operation' in body && info.operation === body.operation)?.writer !== 'legacy' && body.expected === undefined && body.operation !== 'settings.accept-current' && !operationSpec(body.operation)?.recovery && operationSpec(body.operation)?.keys !== 'recorded') {
      const spec = operationSpec(body.operation);
      const target = spec && operationTarget(spec, body.params);
      const candidates = payload?.views?.filter((entry) => entry.view && Object.hasOwn(READ_VIEWS, entry.view)
        && READ_VIEWS[entry.view as keyof typeof READ_VIEWS].target === target && entry.ok);
      const view = sourceView ? candidates?.find(entry => entry.view === sourceView) : candidates?.[0];
      if (!sourceView && candidates?.some(entry => entry.present !== view?.present || entry.sha256 !== view?.sha256)) {
        return settle({ kind: 'refused', code: 'precondition_changed', message: settingsErrorText('precondition_changed') }, { ...order, body });
      }
      if (!view || view.present && !view.sha256) {
        return settle({ kind: 'refused', code: 'unavailable', message: settingsErrorText('unavailable') }, { ...order, body });
      }
      const paths = spec ? operationKeys(spec, body.params) : [];
      body = { ...body, expected: view.present ? { file: { sha256: view.sha256 } }
        : { keys: paths === 'recorded' ? [] : paths.map((_path, index) => ({ key: index, exists: false })) } };
    }
    const outcome = await send(body);
    return settle(outcome, { ...order, body, onApplied });
  };

  const confirmNow = async (): Promise<ApplyOutcome> => {
    const held = pendingConfirm?.owner === owner.current ? pendingConfirm : null;
    if (!held || !current(held) || !allowed(held.body)) {
      if (pendingConfirm?.owner === owner.current) setPendingConfirm(null);
      if (held) explainUnavailableUndo(held.body);
      return { kind: 'refused', code: 'confirm_invalid', message: settingsErrorText('confirm_invalid') };
    }
    const next = { ...held, ...start(held.key) };
    setPendingConfirm(next);
    const outcome = await send(held.body, held.code);
    return settle(outcome, next);
  };

  return {
    busy,
    // Only the row that holds the request shows the prompt and can confirm it.
    pending: pending && pending.owner === owner.current ? pending : null,
    run,
    confirmNow,
    dismiss: () => {
      if (pendingConfirm?.owner !== owner.current) return;
      sequences.current.set(pendingConfirm.key, pendingConfirm.sequence + 1);
      setPendingConfirm(null);
    },
  };
}

/**
 * The confirmation a phone sees for a Confirm-level change: what is about to
 * happen, the one-time code bound to this exact request, and its short life.
 */
export function SettingsConfirmPrompt({
  pending,
  busy,
  disabled = false,
  onConfirm,
  onCancel,
}: {
  pending: { code?: string; summary: string; expiresAt?: number } | null;
  busy: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return pending ? <SettingsConfirmDialog pending={pending} busy={busy} disabled={disabled} onConfirm={onConfirm} onCancel={onCancel} /> : null;
}

function SettingsConfirmDialog({ pending, busy, disabled, onConfirm, onCancel }: {
  pending: { code?: string; summary: string; expiresAt?: number };
  busy: boolean;
  disabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useFocusTrap(ref, cancel);
  const [, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (pending.expiresAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pending]);
  const secondsLeft = pending.expiresAt === undefined ? undefined : Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000));
  const expired = secondsLeft === 0;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div ref={ref} className="overlay-card confirm-card" role="alertdialog" aria-modal="true" aria-label="Confirm this change" tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          if (!busy) onCancel();
        }}>
        <h2>Confirm this change</h2>
        <p>{pending.summary}</p>
        {pending.code && <p className="muted">
          One-time code <code className="confirm-code">{pending.code}</code>
          {expired ? ' — expired; nothing was changed.' : ` — valid for ${secondsLeft}s. It binds to this request, this device and the file as it stands.`}
        </p>}
        <div className="confirm-actions">
          <button ref={cancel} type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || disabled || expired} onClick={onConfirm}>
            {busy ? <LoaderCircle size={16} className="spin" /> : null} Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
