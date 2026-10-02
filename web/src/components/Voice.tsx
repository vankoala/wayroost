import { Check, LoaderCircle, Mic, Square, Volume2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { speakable } from '../voice/text';
import {
  armCancel,
  canListen,
  cancelListening,
  finishListening,
  getVoiceUi,
  readMessage,
  setListeningMode,
  startListening,
  stopReading,
  useReadingMessage,
  useVoiceStatus,
  useVoiceUi,
} from '../voice';

/** A press shorter than this is a tap: record until the next tap. Longer is hold-to-talk. */
const HOLD_MS = 350;
/** Holding and sliding this far away cancels. */
const CANCEL_PX = 80;

/** The mic in the message box: hold to talk, or tap to start and tap again to finish. */
export function VoiceButton({
  conversationKey,
  disabled,
  onText,
}: {
  conversationKey: string;
  disabled?: boolean;
  onText: (text: string) => void;
}) {
  const voice = useVoiceUi();
  const press = useRef<{ x: number; y: number; at: number; pointer: number } | null>(null);
  const mine = voice.key === conversationKey;
  const recording = mine && (voice.phase === 'starting' || voice.phase === 'listening');
  const writing = mine && voice.phase === 'transcribing';

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    if (recording) {
      finishListening(); // the second tap of tap-to-talk
      return;
    }
    if (writing) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { x: e.clientX, y: e.clientY, at: Date.now(), pointer: e.pointerId };
    startListening(conversationKey, 'hold', onText);
  };

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.pointer !== e.pointerId) return;
    armCancel(Math.hypot(e.clientX - p.x, e.clientY - p.y) > CANCEL_PX);
  };

  const onPointerUp = (e: PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.pointer !== e.pointerId) return;
    press.current = null;
    const ui = getVoiceUi();
    if (Date.now() - p.at < HOLD_MS && !ui.cancelArmed) {
      // A quick tap: keep recording until the next tap.
      setListeningMode('toggle');
      return;
    }
    finishListening();
  };

  const onPointerCancel = (e: PointerEvent<HTMLButtonElement>) => {
    if (press.current?.pointer !== e.pointerId) return;
    press.current = null;
    cancelListening();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (e.repeat || disabled) return;
    if (recording) finishListening();
    else if (!writing) startListening(conversationKey, 'toggle', onText);
  };

  const label = recording
    ? voice.mode === 'toggle'
      ? 'Finish recording'
      : 'Recording: let go to finish'
    : 'Talk: hold to record, or tap to start';

  return (
    <button
      type="button"
      className={`voice-btn${recording ? ' recording' : ''}${recording && voice.cancelArmed ? ' cancel' : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={recording}
      disabled={disabled || writing}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {writing ? (
        <LoaderCircle size={18} className="spin" />
      ) : recording && voice.mode === 'toggle' ? (
        <Check size={19} strokeWidth={2.75} />
      ) : (
        <Mic size={19} />
      )}
    </button>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/** What voice is doing for this conversation, above the message box. */
export function VoiceBar({ conversationKey }: { conversationKey: string }) {
  const voice = useVoiceUi();
  const [now, setNow] = useState(() => Date.now());
  const listening = voice.phase === 'listening' && voice.key === conversationKey;
  useEffect(() => {
    if (!listening) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [listening]);

  if (voice.key !== conversationKey || voice.phase === 'idle') return null;

  if (voice.phase === 'starting' || voice.phase === 'transcribing') {
    return (
      <div className="voice-bar" role="status">
        <LoaderCircle size={15} className="spin" />
        <span className="grow">{voice.phase === 'starting' ? 'Starting the microphone…' : 'Writing down what you said…'}</span>
      </div>
    );
  }

  if (voice.phase === 'listening') {
    const seconds = Math.max(0, Math.floor((now - voice.startedAt) / 1000));
    const hint = voice.cancelArmed ? 'Let go to cancel' : voice.mode === 'hold' ? 'Slide away to cancel' : 'Tap ✓ to finish';
    return (
      <div className={`voice-bar listening${voice.cancelArmed ? ' cancel' : ''}`} role="status">
        <span className="voice-dot" aria-hidden="true" />
        <span className="voice-time">
          {Math.floor(seconds / 60)}:{pad(seconds % 60)}
        </span>
        <span className="voice-level" aria-hidden="true">
          <span style={{ transform: `scaleX(${Math.max(0.04, voice.level)})` }} />
        </span>
        <span className="grow voice-hint">{hint}</span>
        {voice.mode === 'toggle' && (
          <button type="button" className="voice-bar-btn" onClick={cancelListening}>
            Cancel
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="voice-bar reading" role="status">
      <Volume2 size={15} className={voice.speaking ? 'voice-speaking' : undefined} />
      <span className="grow">{voice.speaking ? 'Reading the reply aloud' : 'Will read the reply aloud'}</span>
      <button type="button" className="voice-bar-btn" onClick={stopReading}>
        <Square size={11} fill="currentColor" /> Stop
      </button>
    </div>
  );
}

/** Under a finished reply: hear it, or stop hearing it. */
export function ListenButton({ conversationKey, id, text }: { conversationKey: string; id: string; text: string }) {
  const status = useVoiceStatus();
  const worthSaying = useMemo(() => Boolean(speakable(text)), [text]);
  const reading = useReadingMessage(conversationKey) === id;
  if (!canListen(status) || !worthSaying) return null;
  return (
    <button
      type="button"
      className="msg-listen"
      onClick={() => (reading ? stopReading() : readMessage(conversationKey, text, id))}
      aria-pressed={reading}
      aria-label={reading ? 'Stop reading this reply' : 'Listen to this reply'}
    >
      {reading ? <Square size={10} fill="currentColor" /> : <Volume2 size={14} />}
      {reading ? 'Stop' : 'Listen'}
    </button>
  );
}
