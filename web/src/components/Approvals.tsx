import { ArrowUp, Check, ChevronDown, Eye, LoaderCircle, Lock, TriangleAlert, X } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Approval, ApprovalAnswer, ApprovalOption, ConversationSummary } from '../../../shared/protocol';
import { api } from '../api';
import {
  alwaysLabel,
  arrangeOptions,
  askedAt,
  buttonLabel,
  describeApproval,
  visible,
  type ApprovalCopy,
  type TitlePart,
} from '../../../shared/approval-card';
import { orderForLink } from '../approvalLink';
import { preview, revealDetail } from '../../../shared/reveal';
import { useHash } from '../router';
import { approvalKey, convKey, setState, toast, useStore } from '../store';
import '../approval.css';
import { RoleTile } from './RoleTile';

// The approval card, one component for every kind of
// request: a header strip saying who is asking, a plain title, what happens,
// why and what a "no" means, then the buttons. However long the request, a
// card keeps to its share of the screen: its text scrolls inside it and its
// buttons stay pinned to its bottom edge, so Stop and the message box stay in
// reach.

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

function useConversation(approval: Approval): ConversationSummary | undefined {
  return useStore((s) => s.conversations[convKey(approval.source, approval.conversationId)]);
}

function Title({ parts }: { parts: TitlePart[] }) {
  return <>{parts.map((part, i) => (typeof part === 'string' ? part : <code key={i}>{part.code}</code>))}</>;
}

/** Text that may be very long (a request's own title, a question): folds to a few lines. */
function Folding({ text, className = '' }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_TITLE || text.split('\n').length > 2;
  return (
    <>
      <span className={`approval-title ${className}${long && !open ? ' folded' : ''}`}>{text}</span>
      {long && (
        <button
          type="button"
          className="link-btn approval-more"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Show less' : 'Show more'} <ChevronDown size={14} className={open ? 'flip' : ''} aria-hidden="true" />
        </button>
      )}
    </>
  );
}

/** The header strip: who is asking, when, in which task, and that it needs you. */
function Strip({ copy, approval, of }: { copy: ApprovalCopy; approval: Approval; of?: string | undefined }) {
  const full = new Date(approval.createdAt).toLocaleString();
  return (
    <div className="approval-strip">
      <RoleTile role={copy.role} size={32} state="needs" />
      <div className="approval-who">
        <strong>{copy.role.name} is asking</strong>
        <span className="approval-when">
          <time dateTime={new Date(approval.createdAt).toISOString()} title={full}>
            {askedAt(approval.createdAt)}
          </time>
          {copy.task && <> · {copy.task}</>}
        </span>
      </div>
      {of && <span className="approval-of">{of}</span>}
      <span className="need-tag">Needs you</span>
    </div>
  );
}

function Rows({ copy, approval, children }: { copy: ApprovalCopy; approval: Approval; children?: ReactNode }) {
  // The request's own words, unless the title above already is them.
  const said = revealDetail(approval.title).text;
  const own = said.trim() !== copy.titleText.trim() ? said : null;
  return (
    <dl className="approval-rows">
      <div className="approval-row">
        <dt>What happens</dt>
        <dd>
          <p>{copy.whatHappens}</p>
          {children}
        </dd>
      </div>
      <div className="approval-row">
        <dt>Why</dt>
        <dd>
          <p>{copy.why}</p>
          {own && (
            <p className="approval-request">
              <span className="approval-request-label">The request: </span>
              <Folding text={own} />
            </p>
          )}
        </dd>
      </div>
      <div className="approval-row">
        <dt>If you say no</dt>
        <dd>
          <p>{copy.ifNo}</p>
        </dd>
      </div>
    </dl>
  );
}

/** Risk and engine words, one level down. */
function Details({ copy, approval }: { copy: ApprovalCopy; approval: Approval }) {
  return (
    <details className="approval-details">
      <summary>
        Details <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <dl>
        <div>
          <dt>Risk</dt>
          <dd>
            <span className={`risk-level risk-${copy.risk.level.toLowerCase()}`}>{copy.risk.level}</span> ·{' '}
            {copy.risk.touches}
            {copy.risk.reason && <p className="approval-fine">{copy.risk.reason}</p>}
          </dd>
        </div>
        <div>
          <dt>Asked by</dt>
          <dd>{copy.engine}</dd>
        </div>
        <div>
          <dt>Asked at</dt>
          <dd>{new Date(approval.createdAt).toLocaleString()}</dd>
        </div>
      </dl>
      <p className="approval-fine">
        The risk is a rough guide read from the request itself, not a check of what will happen.
      </p>
    </details>
  );
}

/** The card's frame: strip, title, then whatever the kind of request needs. */
function Card({
  approval,
  copy,
  of,
  className = '',
  children,
  foot,
}: {
  approval: Approval;
  copy: ApprovalCopy;
  of?: string | undefined;
  className?: string;
  children: ReactNode;
  /** Buttons and answer fields: pinned to the card's bottom edge. */
  foot: ReactNode;
}) {
  const titleId = useId();
  return (
    <div className={`approval approval-card ${className}`} role="alert" aria-labelledby={titleId}>
      <Strip copy={copy} approval={approval} of={of} />
      <div className="approval-body">
        <h3 className="approval-display" id={titleId}>
          {copy.kind === 'question' ? <Folding text={copy.titleText} /> : <Title parts={copy.title} />}
        </h3>
        {children}
      </div>
      <div className="approval-foot">{foot}</div>
    </div>
  );
}

/** A command, diff or question text, with invisible tricks made visible; long ones fold to head and tail. */
function useDetail(approval: Approval) {
  const [expanded, setExpanded] = useState(false);
  const revealed = useMemo(() => (approval.detail ? revealDetail(approval.detail) : null), [approval.detail]);
  const long = Boolean(
    revealed && (revealed.text.split('\n').length > LONG_LINES || revealed.text.length > LONG_CHARS),
  );
  return {
    revealed,
    long,
    expanded,
    setExpanded,
    needsReview: long && !expanded,
    truncated: Boolean(approval.detailTruncated),
  };
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
      <pre className={needsReview ? 'collapsed' : undefined}>
        {needsReview ? preview(revealed.text).text : revealed.text}
      </pre>
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
  const conversation = useConversation(approval);
  const copy = useMemo(() => describeApproval(approval, conversation), [approval, conversation]);
  const { allow, deny, always, more } = useMemo(() => arrangeOptions(approval.options), [approval.options]);
  const [remember, setRemember] = useState(false);
  const reviewed = !detail.needsReview && !detail.truncated;

  // Allowing waits for the card to arm and for a long command to be read; saying no only for the card.
  const locked = (option: ApprovalOption) => busy !== null || !armed || (option.kind !== 'deny' && !reviewed);
  const icon = (option: ApprovalOption) =>
    busy === option.id ? (
      <LoaderCircle size={16} className="spin" aria-hidden="true" />
    ) : option.kind === 'deny' ? (
      <X size={16} aria-hidden="true" />
    ) : option.kind === 'choice' ? null : (
      <Check size={16} aria-hidden="true" />
    );
  // The checkbox turns "Allow once" into the backend's own "always" choice.
  const chosen = remember && always ? always : allow;

  return (
    <Card
      approval={approval}
      copy={copy}
      of={total > 1 ? `1 of ${total}` : undefined}
      foot={
        <>
          {always && (
            <label className="approval-always">
              <input
                type="checkbox"
                checked={remember}
                disabled={busy !== null}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>{alwaysLabel(approval, always, copy.kind)}</span>
            </label>
          )}
          <div className="approval-actions">
            {/* Saying no on the left, allowing on the right (thumb side). */}
            {deny && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={locked(deny)}
                onClick={() => respond({ optionId: deny.id }, deny.id)}
              >
                {icon(deny)}
                {buttonLabel(deny)}
              </button>
            )}
            {chosen && (
              <button
                type="button"
                className="btn btn-approve"
                disabled={locked(chosen)}
                onClick={() => respond({ optionId: chosen.id }, chosen.id)}
              >
                {icon(chosen)}
                {chosen === always ? 'Allow from now on' : buttonLabel(chosen)}
              </button>
            )}
          </div>
          {more.length > 0 && (
            <details className="approval-choices">
              <summary>
                More choices <ChevronDown size={14} aria-hidden="true" />
              </summary>
              <div className="approval-actions">
                {more.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className="btn btn-secondary"
                    disabled={locked(option)}
                    onClick={() => respond({ optionId: option.id }, option.id)}
                  >
                    {icon(option)}
                    {visible(option.label)}
                  </button>
                ))}
              </div>
            </details>
          )}
        </>
      }
    >
      <Rows copy={copy} approval={approval}>
        <Detail
          state={detail}
          counts
          hint="Open the full command to enable allowing."
          truncatedHint="Too long to show in full here. Say no, or review it on your PC."
        />
      </Rows>
      <Details copy={copy} approval={approval} />
    </Card>
  );
}

function QuestionCard({ approval, total }: { approval: Approval; total: number }) {
  const { busy, respond } = useRespond(approval);
  const armed = useArmed();
  const detail = useDetail(approval);
  const conversation = useConversation(approval);
  const copy = useMemo(() => describeApproval(approval, conversation), [approval, conversation]);
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
    <Card
      approval={approval}
      copy={copy}
      className="approval-question"
      of={approval.progress ?? (total > 1 ? `1 of ${total}` : undefined)}
      foot={
        <>
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
                    {visible(option.label)}
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
                    {visible(option.label)}
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
                {busy === 'submit' ? (
                  <LoaderCircle size={18} className="spin" />
                ) : (
                  <ArrowUp size={20} strokeWidth={2.5} />
                )}
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
                {visible(dismiss.label)}
              </button>
            </div>
          )}
        </>
      }
    >
      <Rows copy={copy} approval={approval}>
        <Detail state={detail} />
      </Rows>
      <Details copy={copy} approval={approval} />
    </Card>
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
  const conversation = useConversation(approval);
  const copy = useMemo(() => describeApproval(approval, conversation), [approval, conversation]);
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
      {decline ? visible(decline.label) : 'Decline'}
    </button>
  );

  const body = (
    <>
      <Rows copy={copy} approval={approval}>
        <Detail
          state={detail}
          counts
          hint="Open the full command before sending anything."
          truncatedHint="Too long to show in full here. Decline it, or answer on your PC."
        />
      </Rows>
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
      <Details copy={copy} approval={approval} />
    </>
  );

  const foot = (
    <>
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
    </>
  );

  return (
    <Card
      approval={approval}
      copy={copy}
      className={`approval-secret${login ? ' approval-login' : ''}`}
      of={total > 1 ? `1 of ${total}` : undefined}
      foot={foot}
    >
      {body}
    </Card>
  );
}

export function ApprovalDock({ approvals: waiting }: { approvals: Approval[] }) {
  // A desktop toast's Open names its approval in the hash; show that card first.
  const hash = useHash();
  const approvals = useMemo(() => orderForLink(waiting, hash), [waiting, hash]);
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

/**
 * The inbox's "needs you" strip: the oldest waiting request as the top of its
 * card (who, what, when), and how many more are waiting. Opens its chat, where
 * the full card answers it.
 */
export function ApprovalBanner({ approvals, onOpen }: { approvals: Approval[]; onOpen: () => void }) {
  const first = approvals[0];
  const conversation = useStore((s) =>
    first ? s.conversations[convKey(first.source, first.conversationId)] : undefined,
  );
  const copy = useMemo(() => (first ? describeApproval(first, conversation) : null), [first, conversation]);
  if (!first || !copy) return null;
  const count = approvals.length === 1 ? '1 request needs you' : `${approvals.length} requests need you`;
  return (
    <button type="button" className="approval-banner" onClick={onOpen}>
      <RoleTile role={copy.role} size={32} state="needs" />
      <span className="approval-banner-text">
        <span className="approval-banner-who">
          <strong>{copy.role.name} is asking</strong> · {askedAt(first.createdAt)}
        </span>
        <span className="approval-banner-title">
          <Title parts={copy.title} />
        </span>
        <span className="approval-banner-meta">{copy.task ? `${count} · ${copy.task}` : count}</span>
      </span>
      <span className="need-tag">Needs you</span>
    </button>
  );
}
