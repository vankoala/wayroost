import { Brain, Check, ChevronDown, LoaderCircle, Search, ShieldCheck, Sparkles, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ControlChange,
  ControlId,
  ControlOption,
  ConversationControl,
  ConversationControls,
  ConversationStatus,
  Source,
} from '../../../shared/protocol';
import { api } from '../api';
import { FILTER_ABOVE, chipText, contextShare, formatTokens, pickerGroups, selectedOption } from '../controls';
import { toast } from '../store';
import { ConfirmDialog, Sheet } from './common';

// Model, reasoning and mode for the open conversation, as chips above the
// message box, plus how full the context window is. A setting only changes
// once the backend says it did; the chips then show what it sent back.

const ICONS: Record<ControlId, typeof Sparkles> = { model: Sparkles, reasoning: Brain, mode: ShieldCheck };

type Extra = Pick<ControlChange, 'acknowledgeAutoApprove' | 'confirm'>;

function ContextRing({ context }: { context: NonNullable<ConversationControls['context']> }) {
  const share = contextShare(context);
  const radius = 7;
  const around = 2 * Math.PI * radius;
  const tone = share >= 90 ? ' full' : share >= 70 ? ' warn' : '';
  const detail = `${formatTokens(context.used)} of ${formatTokens(context.max)} tokens`;
  return (
    <button
      type="button"
      className={`context-ring${tone}`}
      aria-label={`Context: ${share}% used, ${detail}`}
      onClick={() => toast(`${detail} (${share}%)`, 'info')}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle className="track" cx="9" cy="9" r={radius} />
        <circle
          className="bar"
          cx="9"
          cy="9"
          r={radius}
          strokeDasharray={`${(share / 100) * around} ${around}`}
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span>{share}%</span>
    </button>
  );
}

function ControlChip({ control, onOpen }: { control: ConversationControl; onOpen: () => void }) {
  const text = chipText(control);
  const auto = Boolean(selectedOption(control)?.autoApproves);
  const Icon = auto ? Zap : ICONS[control.id];
  return (
    <button
      type="button"
      className={`control-chip${auto ? ' auto' : ''}`}
      aria-haspopup="dialog"
      aria-label={text === control.label ? control.label : `${control.label}: ${text}`}
      aria-disabled={control.disabledReason ? true : undefined}
      title={control.disabledReason}
      onClick={() => (control.disabledReason ? toast(control.disabledReason, 'info') : onOpen())}
    >
      <Icon size={14} aria-hidden="true" />
      <span className="value">{text}</span>
      <ChevronDown size={14} className="chev" aria-hidden="true" />
    </button>
  );
}

function ControlPicker({
  control,
  busy,
  onChoose,
  onClose,
}: {
  control: ConversationControl;
  /** Option being applied. */
  busy: string | null;
  onChoose: (option: ControlOption, extra: Extra) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState('');
  const [consent, setConsent] = useState<ControlOption | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  // Phones: don't pop the keyboard over the list just for opening it.
  const touch = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);
  const groups = useMemo(() => pickerGroups(control.options, filter), [control.options, filter]);

  const pick = (option: ControlOption) => {
    if (busy) return;
    if (option.id === control.value) onClose();
    else if (option.autoApproves) {
      setAcknowledged(false);
      setConsent(option);
    } else onChoose(option, {});
  };

  if (consent) {
    return (
      <Sheet
        title={control.label}
        onClose={onClose}
        footer={
          <div className="pick-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setConsent(null)} disabled={busy !== null}>
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!acknowledged || busy !== null}
              onClick={() => onChoose(consent, { acknowledgeAutoApprove: true })}
            >
              {busy && <LoaderCircle size={18} className="spin" />}
              {control.id === 'mode' ? 'Switch mode' : 'Switch'}
            </button>
          </div>
        }
      >
        <div className="consent-pick">
          <Zap size={18} className="auto-mark" aria-hidden="true" />
          <div>
            <strong>{consent.label}</strong>
            {consent.description && <p>{consent.description}</p>}
          </div>
        </div>
        <button
          type="button"
          role="checkbox"
          className="ack"
          aria-checked={acknowledged}
          onClick={() => setAcknowledged((a) => !a)}
          autoFocus
        >
          <span className="box">{acknowledged && <Check size={14} strokeWidth={3} />}</span>
          <span>
            {control.id === 'mode' ? 'This mode' : 'This setting'} lets the agent act without asking you first. I
            understand.
          </span>
        </button>
      </Sheet>
    );
  }

  return (
    <Sheet title={control.label} onClose={onClose}>
      <p className="pick-hint">Changes this conversation only.</p>
      {control.options.length > FILTER_ABOVE && (
        <label className="search pick-filter">
          <Search size={17} aria-hidden="true" />
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter"
            aria-label={`Filter ${control.label.toLowerCase()} options`}
            autoFocus={!touch}
          />
        </label>
      )}
      {groups.map((group) => (
        <div key={group.label ?? ''} className="pick-group" role="radiogroup" aria-label={group.label ?? control.label}>
          {group.label && (
            <div className="pick-group-label" aria-hidden="true">
              {group.label}
            </div>
          )}
          {group.options.map((option) => {
            const current = option.id === control.value;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={current}
                className="pick-option"
                disabled={busy !== null && busy !== option.id}
                onClick={() => pick(option)}
              >
                <span className="grow">
                  <span className="pick-label">
                    {option.autoApproves && <Zap size={14} className="auto-mark" aria-label="acts without asking" />}
                    {option.label}
                  </span>
                  {option.description && <span className="pick-desc">{option.description}</span>}
                </span>
                {busy === option.id ? (
                  <LoaderCircle size={18} className="spin" />
                ) : current ? (
                  <Check size={18} strokeWidth={2.6} className="pick-check" />
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
      {groups.length === 0 && <p className="muted pick-none">Nothing matches “{filter.trim()}”.</p>}
    </Sheet>
  );
}

export function ControlsStrip({ source, id, status }: { source: Source; id: string; status?: ConversationStatus }) {
  const [data, setData] = useState<ConversationControls | null>(null);
  const [open, setOpen] = useState<ControlId | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ control: ConversationControl; option: ControlOption; message: string; extra: Extra } | null>(null);
  // Only the newest answer counts (a change can land while a fetch is on its way).
  const seq = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++seq.current;
    api.controls(source, id).then(
      (next) => {
        if (mine === seq.current) setData(next);
      },
      () => {}, // no chips is fine; the conversation still works
    );
  }, [source, id]);

  useEffect(refresh, [refresh]);

  // A finished turn changes what the context ring shows.
  const previous = useRef(status);
  useEffect(() => {
    if (previous.current === 'running' && (status === 'idle' || status === 'error')) refresh();
    previous.current = status;
  }, [status, refresh]);

  const choose = async (control: ConversationControl, option: ControlOption, extra: Extra) => {
    setBusy(option.id);
    try {
      const res = await api.setControl(source, id, { control: control.id, value: option.id, ...extra });
      if (!res.ok) {
        setConfirm({ control, option, message: res.confirm, extra });
        return;
      }
      seq.current += 1;
      setData(res.controls);
      setConfirm(null);
      setOpen(null);
      if (res.notice) toast(res.notice, 'info');
    } catch (err) {
      setConfirm(null);
      toast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!data || (!data.controls.length && !data.context)) return null;
  const control = data.controls.find((c) => c.id === open);

  return (
    <div className="controls-strip">
      <div className="controls-row">
        <div className="control-chips" role="group" aria-label="Conversation settings">
          {data.controls.map((c) => (
            <ControlChip key={c.id} control={c} onOpen={() => setOpen(c.id)} />
          ))}
        </div>
        {data.context && <ContextRing context={data.context} />}
      </div>
      {control && (
        <ControlPicker
          control={control}
          busy={busy}
          onChoose={(option, extra) => void choose(control, option, extra)}
          onClose={() => setOpen(null)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={`Switch to ${confirm.option.label}?`}
          message={confirm.message}
          confirmLabel="Switch"
          busy={busy !== null}
          onConfirm={() => void choose(confirm.control, confirm.option, { ...confirm.extra, confirm: true })}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
