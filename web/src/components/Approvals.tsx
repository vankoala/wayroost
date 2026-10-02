import {
  ArrowUp,
  Check,
  ChevronDown,
  Eye,
  KeyRound,
  LoaderCircle,
  Lock,
  MessageCircleQuestionMark,
  ShieldAlert,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Approval, ApprovalAnswer, ApprovalOption } from '../../../shared/protocol';
import { api } from '../api';
import { preview, revealDetail } from '../reveal';
import { approvalKey, setState, toast } from '../store';

// Cards for what an agent is blocked on. However long the request, a card
// keeps to its share of the screen: its text scrolls inside it and its buttons
// stay pinned to its bottom edge, so Stop and the message box stay in reach.

/** Taps that land in the first moments of a new card were meant for the previous one. */
const ARM_DELAY_MS = 750;
/** Details longer than this must be expanded before anything can be allowed. */
const LONG_LINES = 8;
const LONG_CHARS = 600;
/** Titles longer than this start folded to a few lines. */
const LONG_TITLE = 110;

function dropLocally(approval: Approval) {
  const key = approvalKey(approval);
  setState((s) => {
    if (!(key in s.approvals)) return s;
    const approvals = { ...s.approvals };
    delete approvals[key];
    return { ...s, approvals };
  });
}

function useArmed(): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return armed;
}

function useRespond(approval: Approval) {
  const [busy, setBusy] = useState<string | null>(null);
  const respond = async (answer: ApprovalAnswer, busyKey: string) => {
    if (busy) return;
    setBusy(busyKey);
    try {
      await api.respond(approval, answer);
      navigator.vibrate?.(12);
      dropLocally(approval);
    } catch (err) {
      toast((err as Error).message);
      setBusy(null);
    }
  };
  return { busy, respond };
}

function optionClass(option: ApprovalOption): string {
  switch (option.kind) {
    case 'allow':
      return 'btn btn-approve';
    case 'deny':
      return 'btn btn-danger';
    default:
      return 'btn btn-secondary';
  }
}

function ApprovalHead({ icon, title, of }: { icon: ReactNode; title: string; of?: string | undefined }) {
  const [open, setOpen] = useState(false);
  const long = title.length > LONG_TITLE || title.split('\n').length > 2;
  return (
    <>
      <div className="approval-head">
        {icon}
        <span className={`grow approval-title${long && !open ? ' folded' : ''}`}>{title}</span>
        {of && <span className="of">{of}</span>}
      </div>
      {long && (
        <button type="button" className="link-btn approval-more" onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : 'Show more'} <ChevronDown size={14} className={open ? 'flip' : ''} />
        </button>
      )}
    </>
  );
}

/** A command, diff or question text, with invisible tricks made visible; long ones fold to head and tail. */
function useDetail(approval: Approval) {
  const [expanded, setExpanded] = useState(false);
  const revealed = useMemo(() => (approval.detail ? revealDetail(approval.detail) : null), [approval.detail]);
  const long = Boolean(
    revealed && (revealed.text.split('\n').length > LONG_LINES || revealed.text.length > LONG_CHARS),
  );
  return { revealed, long, expanded, setExpanded, needsReview: long && !expanded, truncated: Boolean(approval.detailTruncated) };
}

function Detail({
  state,
  counts,
  hint,
  truncatedHint,
}: {
  state: ReturnType<typeof useDetail>;
  /** Show its size: a payload hidden in a long command shows up there too. */
  counts?: boolean;
  /** Said while it's folded and must be opened before going ahead. */
  hint?: string;
  truncatedHint?: string;
}) {
  const { revealed, long, expanded, setExpanded, needsReview, truncated } = state;
  if (!revealed) return null;
  return (
    <>
      <pre className={needsReview ? 'collapsed' : undefined}>{needsReview ? preview(revealed.text).text : revealed.text}</pre>
      {(counts || long) && (
        <div className="approval-meta">
          <span>
            {counts &&
              `${revealed.lines.toLocaleString()} ${revealed.lines === 1 ? 'line' : 'lines'} · ${revealed.chars.toLocaleString()} characters`}
          </span>
          {long && (
            <button type="button" className="link-btn" onClick={() => setExpanded((e) => !e)}>
              {expanded ? 'Show less' : 'Show everything'} <ChevronDown size={14} className={expanded ? 'flip' : ''} />
            </button>
          )}
        </div>
      )}
      {revealed.unusual && (
        <p className="approval-warn">
          <TriangleAlert size={14} /> Hidden characters or padding were made visible (⟨…⟩). Read carefully.
        </p>
      )}
      {truncated && truncatedHint && (
        <p className="approval-warn">
          <TriangleAlert size={14} /> {truncatedHint}
        </p>
      )}
      {needsReview && !truncated && hint && (
        <p className="approval-hint">
          <Eye size={14} /> {hint}
        </p>
      )}
    </>
  );
}

function PermissionCard({ approval, total }: { approval: Approval; total: number }) {
  const { busy, respond } = useRespond(approval);
  const armed = useArmed();
  const detail = useDetail(approval);

  const primary = approval.options.filter((o) => o.kind === 'allow' || o.kind === 'deny');
  // Deny on the left, allow on the right (thumb side).
  primary.sort((a, b) => (a.kind === 'deny' ? -1 : b.kind === 'deny' ? 1 : 0));
  const secondary = approval.options.filter((o) => o.kind !== 'allow' && o.kind !== 'deny');

  const button = (option: ApprovalOption) => {
    const allowing = option.kind !== 'deny';
    const disabled = busy !== null || !armed || (allowing && (detail.needsReview || detail.truncated));
    return (
      <button
        key={option.id}
        type="button"
        className={optionClass(option)}
        disabled={disabled}
        onClick={() => respond({ optionId: option.id }, option.id)}
      >
        {busy === option.id ? (
          <LoaderCircle size={16} className="spin" />
        ) : option.kind === 'deny' ? (
          <X size={16} />
        ) : option.kind === 'allow' ? (
          <Check size={16} />
        ) : null}
        {option.label}
      </button>
    );
  };

  return (
    <div className="approval" role="alert">
      <ApprovalHead icon={<ShieldAlert size={18} />} title={approval.title} of={total > 1 ? `1 of ${total}` : undefined} />
      <Detail
        state={detail}
        counts
        hint="Open the full command to enable approving."
        truncatedHint="Too long to show in full here. Deny it, or review it on your PC."
      />
      <div className="approval-foot">
        <div className="approval-actions">{primary.map(button)}</div>
        {secondary.length > 0 && <div className="approval-actions">{secondary.map(button)}</div>}
      </div>
    </div>
  );
}

function QuestionCard({ approval, total }: { approval: Approval; total: number }) {
  const { busy, respond } = useRespond(approval);
  const armed = useArmed();
  const detail = useDetail(approval);
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const multi = Boolean(approval.multiSelect);
  const choices = approval.options.filter((o) => o.kind === 'choice');
  const dismiss = approval.options.find((o) => o.kind === 'deny');
  const locked = busy !== null || !armed;

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const submit = () => {
    const typed = text.trim();
    if (multi) {
      if (!picked.length && !typed) return;
      void respond({ ...(picked.length ? { optionIds: picked } : {}), ...(typed ? { text: typed } : {}) }, 'submit');
    } else if (typed) {
      void respond({ text: typed }, 'submit');
    }
  };

  return (
    <div className="approval" role="alert">
      <ApprovalHead
        icon={<MessageCircleQuestionMark size={18} />}
        title={approval.title}
        of={approval.progress ?? (total > 1 ? `1 of ${total}` : undefined)}
      />
      <Detail state={detail} />
      <div className="approval-foot">
        {choices.length > 0 && (
          <div className="pick-row">
            {choices.map((option) =>
              multi ? (
                <button
                  key={option.id}
                  type="button"
                  className="chip"
                  aria-pressed={picked.includes(option.id)}
                  disabled={locked}
                  onClick={() => toggle(option.id)}
                >
                  {option.label}
                </button>
              ) : (
                <button
                  key={option.id}
                  type="button"
                  className="chip"
                  disabled={locked}
                  onClick={() => respond({ optionId: option.id }, option.id)}
                >
                  {busy === option.id && <LoaderCircle size={14} className="spin" />}
                  {option.label}
                </button>
              ),
            )}
          </div>
        )}
        {(approval.allowText || multi) && (
          <div className="composer-box">
            {approval.allowText ? (
              <textarea
                rows={1}
                value={text}
                placeholder={choices.length ? 'Or type an answer…' : 'Type your answer…'}
                onChange={(e) => setText(e.target.value)}
                aria-label="Answer"
              />
            ) : (
              <span className="grow muted">{picked.length ? `${picked.length} selected` : 'Pick one or more'}</span>
            )}
            <button
              type="button"
              className="send-btn"
              aria-label="Send answer"
              disabled={locked || (!text.trim() && !(multi && picked.length))}
              onClick={submit}
            >
              {busy === 'submit' ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={20} strokeWidth={2.5} />}
            </button>
          </div>
        )}
        {dismiss && (
          <div className="approval-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={locked}
              onClick={() => respond({ optionId: dismiss.id }, dismiss.id)}
            >
              {busy === dismiss.id ? <LoaderCircle size={16} className="spin" /> : <X size={16} />}
              {dismiss.label}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A password, code or login Hermes asks for (sudo, a vault, 2FA). What's typed
 * lives only in this card's state and its fields, goes straight to the server
 * in the answer, and is cleared as soon as that request finishes.
 */
function SecretCard({ approval, total }: { approval: Approval; total: number }) {
  const armed = useArmed();
  const detail = useDetail(approval);
  const [identifier, setIdentifier] = useState('');
  const [value, setValue] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'send' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const input = approval.secret?.input ?? 'password';
  const login = input === 'login';
  const decline = approval.options.find((o) => o.kind === 'deny');
  const locked = busy !== null || !armed;
  const filled = login ? identifier.trim().length > 0 && value.length > 0 : value.length > 0;
  const canSend = filled && !locked && !detail.needsReview && !detail.truncated;
  const what = login
    ? 'this login'
    : input === 'code'
      ? 'this code'
      : /\bsudo\b/i.test(approval.title)
        ? 'your sudo password'
        : 'your password';

  const answer = async (reply: ApprovalAnswer, key: 'send' | 'decline') => {
    setBusy(key);
    setError(null);
    try {
      await api.respond(approval, reply);
      navigator.vibrate?.(12);
      dropLocally(approval);
    } catch (err) {
      setError((err as Error).message);
      setConfirming(false);
    } finally {
      // Whatever happened, nothing typed here outlives the request.
      setIdentifier('');
      setValue('');
      setBusy(null);
    }
  };

  const send = () => {
    if (!canSend) return;
    if (approval.secret?.confirm && !confirming) setConfirming(true);
    else void answer(login ? { login: { identifier: identifier.trim(), password: value } } : { text: value }, 'send');
  };
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    send();
  };
  const masked = (label: string, autoComplete: string, numeric = false) => (
    <input
      type="password"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onEnter}
      placeholder={label}
      aria-label={label}
      autoComplete={autoComplete}
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      {...(numeric ? { inputMode: 'numeric' as const } : {})}
      disabled={busy !== null}
    />
  );
  const declineButton = (
    <button
      type="button"
      className="btn btn-danger"
      disabled={locked}
      onClick={() => void answer({ optionId: decline?.id ?? '__decline' }, 'decline')}
    >
      {busy === 'decline' ? <LoaderCircle size={16} className="spin" /> : <X size={16} />}
      {decline?.label ?? 'Decline'}
    </button>
  );

  return (
    <div className={`approval approval-secret${login ? ' approval-login' : ''}`} role="alert">
      <ApprovalHead icon={<KeyRound size={18} />} title={approval.title} of={total > 1 ? `1 of ${total}` : undefined} />
      <Detail
        state={detail}
        counts
        hint="Open the full command before sending anything."
        truncatedHint="Too long to show in full here. Decline it, or answer on your PC."
      />
      {login && !confirming && (
        <div className="secret-fields">
          <label className="secret-field">
            <span>Username or email</span>
            <input
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              onKeyDown={onEnter}
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy !== null}
            />
          </label>
          <label className="secret-field">
            <span>Password</span>
            {masked('Password', 'new-password')}
          </label>
        </div>
      )}
      <p className="approval-hint secret-note">
        <Lock size={14} /> Sent through your Cloudflare tunnel (TLS ends at Cloudflare) straight to Hermes; not stored.
      </p>

      <div className="approval-foot">
        {confirming ? (
          <div className="secret-confirm">
            <strong>
              Send {what} to {approval.detail ? 'run this command' : 'Hermes'}?
            </strong>
            <div className="approval-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)} disabled={locked}>
                Back
              </button>
              <button type="button" className="btn btn-approve" onClick={send} disabled={locked}>
                {busy === 'send' ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}
                Confirm
              </button>
            </div>
          </div>
        ) : login ? (
          <div className="approval-actions">
            {declineButton}
            <button type="button" className="btn btn-approve" disabled={!canSend} onClick={send}>
              {busy === 'send' ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}
              Send
            </button>
          </div>
        ) : (
          <>
            <div className="composer-box secret-box">
              {input === 'code' ? masked('Code', 'one-time-code', true) : masked('Password', 'off')}
              <button type="button" className="send-btn" aria-label="Send" disabled={!canSend} onClick={send}>
                {busy === 'send' ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={20} strokeWidth={2.5} />}
              </button>
            </div>
          </>
        )}
        {error && (
          <p className="approval-warn" role="status">
            <TriangleAlert size={14} /> {error}
          </p>
        )}
        {!login && !confirming && <div className="approval-actions">{declineButton}</div>}
      </div>
    </div>
  );
}

export function ApprovalDock({ approvals }: { approvals: Approval[] }) {
  const current = approvals[0];
  if (!current) return null;
  return (
    <div className="approval-dock">
      {current.kind === 'permission' ? (
        <PermissionCard key={current.id} approval={current} total={approvals.length} />
      ) : current.kind === 'secret' ? (
        <SecretCard key={current.id} approval={current} total={approvals.length} />
      ) : (
        <QuestionCard key={current.id} approval={current} total={approvals.length} />
      )}
    </div>
  );
}
