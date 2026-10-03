import {
  BellRing,
  CalendarClock,
  Check,
  Clock,
  Info,
  LoaderCircle,
  MessageSquare,
  Reply,
  Send,
  Sparkles,
  ThumbsDown,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { FeedAction, FeedCard, FeedKind, FeedSource } from '../../../shared/protocol';
import { api } from '../api';
import { shortTime } from '../format';
import { backLabel, sortCards } from '../feed';
import { conversationPath, navigate } from '../router';
import { toast, useStore } from '../store';
import { Sheet } from './common';

const KIND_ICONS: Record<FeedKind, ReactNode> = {
  reply: <Reply size={16} />,
  prepare: <CalendarClock size={16} />,
  reminder: <BellRing size={16} />,
  'heads-up': <Info size={16} />,
  warning: <TriangleAlert size={16} />,
};

const SOURCE_LABELS: Record<FeedSource, string> = {
  brief: 'Morning brief',
  scout: 'Daytime check',
  agent: 'From an agent',
};

/** For you: what Hermes' 7am brief and daytime checks found for you, to act on in a tap. */
export function ForYouSheet({ onClose, onSettings }: { onClose: () => void; onSettings: () => void }) {
  const feed = useStore((s) => s.feed);
  const cards = useMemo(() => sortCards(Object.values(feed ?? {})), [feed]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  // Opening For you counts as seeing what's new.
  useEffect(() => {
    if (feed && Object.values(feed).some((c) => c.status === 'new')) api.feedSeen().catch(() => {});
    // Only on open: later arrivals stay marked new until the next visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (card: FeedCard, action: FeedAction) => {
    setBusy(`${card.id}:${action}`);
    try {
      const result = await api.feedAction(card.id, action);
      // Acting on another card leaves an open "Do it" box alone.
      setConfirming((open) => (open === card.id ? null : open));
      if (action === 'do' && result.chat) {
        onClose();
        navigate(conversationPath(result.chat.source, result.chat.id));
      } else if (action === 'later' && result.card.laterUntil) {
        toast(backLabel(result.card.laterUntil), 'info');
      } else if (action === 'less' && card.topic) {
        toast(`Fewer like this: ${card.topic}`, 'info');
      }
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const footer = (
    <button type="button" className="link-btn" onClick={onSettings}>
      How often Hermes speaks up, quiet hours and notifications: Settings
    </button>
  );

  return (
    <Sheet title="For you" onClose={onClose} footer={footer}>
      {feed === null ? (
        <div className="feed-empty">
          <Sparkles size={22} />
          <p>For you isn't turned on for this Wayroost.</p>
        </div>
      ) : cards.length === 0 ? (
        <div className="feed-empty">
          <Sparkles size={22} />
          <p>
            <strong>Nothing right now.</strong>
            <br />
            Hermes adds things here from your 7am brief and its daytime checks: replies to send, things to prepare,
            promises coming due.
          </p>
        </div>
      ) : (
        <ul className="feed-list">
          {cards.map((card) => {
            const working = (action: FeedAction) => busy === `${card.id}:${action}`;
            const disabled = busy !== null;
            return (
              <li key={card.id} className={`feed-card kind-${card.kind}${card.status === 'new' ? ' is-new' : ''}`}>
                <div className="feed-card-head">
                  <span className="feed-kind" aria-hidden="true">
                    {KIND_ICONS[card.kind]}
                  </span>
                  <span className="feed-meta">
                    {SOURCE_LABELS[card.source]} · {shortTime(card.createdAt)}
                  </span>
                  <button
                    type="button"
                    className="icon-btn feed-dismiss"
                    aria-label="Dismiss"
                    onClick={() => act(card, 'dismiss')}
                    disabled={disabled}
                  >
                    {working('dismiss') ? <LoaderCircle size={15} className="spin" /> : <X size={16} />}
                  </button>
                </div>
                <div className="feed-title">{card.title}</div>
                {card.detail && <p className="feed-detail">{card.detail}</p>}
                {confirming === card.id && card.action ? (
                  <div className="feed-confirm">
                    <div className="feed-confirm-label">Hermes will get:</div>
                    <blockquote>{card.action}</blockquote>
                    <div className="feed-actions">
                      <button type="button" className="btn btn-primary" onClick={() => act(card, 'do')} disabled={disabled}>
                        {working('do') ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />} Send to Hermes
                      </button>
                      <button type="button" className="btn btn-secondary" onClick={() => setConfirming(null)} disabled={disabled}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="feed-actions">
                    {card.chat ? (
                      // Already handed to Hermes (a reminder stays up until Done): go back to that chat.
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => {
                          onClose();
                          navigate(conversationPath(card.chat!.source, card.chat!.id));
                        }}
                        disabled={disabled}
                      >
                        <MessageSquare size={15} /> Open chat
                      </button>
                    ) : (
                      card.action && (
                        <button type="button" className="btn btn-primary" onClick={() => setConfirming(card.id)} disabled={disabled}>
                          Do it
                        </button>
                      )
                    )}
                    {card.kind === 'reminder' && (
                      <button type="button" className="btn btn-secondary" onClick={() => act(card, 'done')} disabled={disabled}>
                        {working('done') ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} Done
                      </button>
                    )}
                    <button type="button" className="btn btn-secondary" onClick={() => act(card, 'later')} disabled={disabled}>
                      {working('later') ? <LoaderCircle size={15} className="spin" /> : <Clock size={15} />} Not now
                    </button>
                    {card.topic && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => act(card, 'less')}
                        disabled={disabled}
                        title={`Fewer cards about: ${card.topic}`}
                      >
                        {working('less') ? <LoaderCircle size={15} className="spin" /> : <ThumbsDown size={15} />} Less like this
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
