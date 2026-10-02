import { Feather, LoaderCircle, SquareTerminal, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Source, SourceState } from '../../../shared/protocol';
import { useStore } from '../store';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog focus: moves focus in (unless a child already took it), keeps Tab
 * inside, and hands focus back to where it was when the dialog closes.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, initial?: RefObject<HTMLElement | null>): void {
  // Read while rendering, before any autoFocus inside the dialog moves it.
  const [previous] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    if (!root.contains(document.activeElement)) (initial?.current ?? root).focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented) return; // e.g. Tab picked a "/" command
      const active = document.activeElement;
      // A dialog opened on top of this one handles its own keys.
      if (active instanceof Element && !root.contains(active) && active.closest('[aria-modal="true"]')) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      const first = items[0];
      const last = items[items.length - 1];
      const outside = !root.contains(active); // e.g. the focused element was just replaced
      if (!first || !last) {
        e.preventDefault();
      } else if (e.shiftKey && (outside || active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous?.isConnected && previous !== document.body) previous.focus({ preventScroll: true });
    };
  }, [ref, initial, previous]);
}

export const SOURCE_NAMES: Record<Source, string> = { hermes: 'Hermes', paseo: 'Paseo' };

/** Sources this Signalbox runs (one may be turned off in the config). */
export function useEnabledSources(): Source[] {
  const statuses = useStore((s) => s.statuses);
  return (['hermes', 'paseo'] as const).filter((s) => statuses[s].state !== 'disabled');
}

export function Logo({ size = 28 }: { size?: number }) {
  // A railway signal head: one lamp per agent runtime (amber Hermes, teal Paseo).
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2a3243" />
          <stop offset="1" stopColor="#0e1117" />
        </linearGradient>
        <radialGradient id={`${id}a`} cx="0.4" cy="0.35" r="0.7">
          <stop offset="0" stopColor="#ffe3a3" />
          <stop offset="0.55" stopColor="#f2b54a" />
          <stop offset="1" stopColor="#b8780f" />
        </radialGradient>
        <radialGradient id={`${id}t`} cx="0.4" cy="0.35" r="0.7">
          <stop offset="0" stopColor="#b4fbec" />
          <stop offset="0.55" stopColor="#35c9b0" />
          <stop offset="1" stopColor="#0d8f7c" />
        </radialGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id}bg)`} />
      <rect x="10" y="4.5" width="12" height="23" rx="6" fill="#05070b" />
      <circle cx="16" cy="10.6" r="3.8" fill={`url(#${id}a)`} />
      <circle cx="16" cy="21.4" r="3.8" fill={`url(#${id}t)`} />
    </svg>
  );
}

export function SourceAvatar({
  source,
  small,
  live,
  linked,
}: {
  source: Source;
  small?: boolean;
  live?: boolean;
  /** A Hermes session running inside Paseo: Paseo avatar with a Hermes badge. */
  linked?: boolean;
}) {
  const Icon = source === 'hermes' ? Feather : SquareTerminal;
  return (
    <div
      className={`avatar ${source}${small ? ' sm' : ''}`}
      title={linked ? 'Hermes, running in Paseo' : SOURCE_NAMES[source]}
    >
      <Icon size={small ? 17 : 20} strokeWidth={2.2} aria-hidden="true" />
      {linked && (
        <span className="avatar-badge" aria-hidden="true">
          <Feather size={small ? 9 : 10} strokeWidth={2.6} />
        </span>
      )}
      {live && <span className="live" aria-label="working" />}
    </div>
  );
}

export function statusTone(state: SourceState): 'ok' | 'warn' | 'bad' {
  if (state === 'connected' || state === 'disabled') return 'ok';
  if (state === 'connecting') return 'warn';
  return 'bad';
}

export function statusLabel(state: SourceState): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'disconnected':
      return 'Offline';
    case 'needs_credentials':
      return 'Sign-in needed';
    case 'error':
      return 'Error';
    case 'disabled':
      return 'Turned off';
  }
}

/** True once `value` has stayed true for `delayMs` (avoids flashing banners). */
export function useDelayedFlag(value: boolean, delayMs: number): boolean {
  const [flag, setFlag] = useState(false);
  useEffect(() => {
    if (!value) {
      setFlag(false);
      return;
    }
    const timer = setTimeout(() => setFlag(true), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return flag;
}

export function Sheet({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Wider on a desktop screen, for a grid of cards. */
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={wide ? 'sheet sheet-wide' : 'sheet'} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="sheet-grip mobile-only" />
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** A yes/no question on top of everything else (e.g. "this model is expensive"). */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busy,
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  busy: boolean;
  /** Saying yes can't be undone (e.g. delete). */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();
  // Starts on Cancel: saying yes should be a deliberate second tap.
  useFocusTrap(ref, cancel);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div
        ref={ref}
        className="overlay-card confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation(); // answer this question, not close what's behind it
          if (!busy) onCancel();
        }}
      >
        <h2 id={titleId}>{title}</h2>
        <p id={messageId}>{message}</p>
        <div className="confirm-actions">
          <button ref={cancel} type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={busy}>
            {busy && <LoaderCircle size={16} className="spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
