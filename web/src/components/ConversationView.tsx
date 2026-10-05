import { Archive, Bot, ChevronLeft, CornerDownRight, CornerLeftUp, Ellipsis, Feather, SquareTerminal, Trash2, WifiOff } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Source } from '../../../shared/protocol';
import { api, dropThreads, loadConversation, reportTidy } from '../api';
import { readableBridgeText } from '../bridge';
import { chatIndex, parentOf, threadFamily } from '../projects';
import { unwatchConversation, watchConversation } from '../events';
import { chatsPath, conversationPath, goBack, navigate, parseChatsFilter, useUrl } from '../router';
import { convKey, toast, useStore } from '../store';
import { ApprovalDock } from './Approvals';
import { Composer } from './Composer';
import { ControlsStrip } from './Controls';
import { HermesInPaseoTag } from './ConversationRow';
import { ConfirmDialog, SOURCE_NAMES, Sheet, SourceAvatar } from './common';
import { Timeline } from './Timeline';

export interface NewConversationRequest {
  source?: Source;
  cwd?: string;
  text?: string;
}

export function ConversationView({
  source,
  id,
  offline,
  onNew,
}: {
  source: Source;
  id: string;
  offline: boolean;
  /** Open the new-conversation sheet ("/new"). */
  onNew: (request: NewConversationRequest) => void;
}) {
  const filter = parseChatsFilter(useUrl());
  const key = convKey(source, id);
  const conversation = useStore((s) => s.conversations[key]);
  const detail = useStore((s) => s.details[key]);
  const approvals = useStore((s) => s.approvals);
  const status = useStore((s) => s.statuses[source]);
  const conversations = useStore((s) => s.conversations);

  // What started this chat and what it started, across Hermes and Paseo (a
  // parent may be known by an earlier id, or be the Paseo agent running it).
  const index = useMemo(() => chatIndex(Object.values(conversations)), [conversations]);
  const parent = conversation ? parentOf(conversation, index) : undefined;
  // Started through the bridge before `parent` was reported: still say by whom.
  const startedBy = !conversation?.parent ? conversation?.startedBy : undefined;
  const subagent = Boolean(conversation?.subagent);
  const children = useMemo(
    () =>
      conversation
        ? Object.values(conversations)
            .filter((c) => c !== conversation && parentOf(c, index) === conversation)
            .sort((a, b) => Number(a.subagent ?? false) - Number(b.subagent ?? false) || b.updatedAt - a.updatedAt)
        : [],
    [conversations, conversation, index],
  );
  // Archive takes the chats it started along (deepest first); delete is this one only.
  const family = useMemo(
    () => (conversation ? threadFamily(conversation, Object.values(conversations)) : []),
    [conversation, conversations],
  );
  const [menu, setMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tidying, setTidying] = useState(false);
  const title = readableBridgeText(conversation?.title) ?? 'this thread';

  const archive = async () => {
    const threads = family.map((c) => ({ source: c.source, id: c.id }));
    setTidying(true);
    try {
      const gone = reportTidy('archived', threads, await api.archiveThreads(threads));
      dropThreads(gone);
      setMenu(false);
      if (gone.some((t) => t.source === source && t.id === id)) {
        navigate(chatsPath(parseChatsFilter(location.pathname + location.search)), { replace: true });
      }
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setTidying(false);
    }
  };

  const remove = async () => {
    const threads = [{ source, id }];
    setTidying(true);
    try {
      const gone = reportTidy('deleted', threads, await api.deleteThreads(threads));
      dropThreads(gone);
      setConfirmDelete(false);
      if (gone.length) navigate(chatsPath(parseChatsFilter(location.pathname + location.search)), { replace: true });
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setTidying(false);
    }
  };

  // Links to the other backend carry its icon.
  const mark = (other: Source) =>
    other === source ? null : other === 'hermes' ? <Feather size={12} aria-label="Hermes" /> : <SquareTerminal size={12} aria-label="Paseo" />;

  const waiting = useMemo(
    () =>
      Object.values(approvals)
        .filter((a) => a.source === source && a.conversationId === id)
        .sort((a, b) => a.createdAt - b.createdAt),
    [approvals, source, id],
  );

  useEffect(() => {
    watchConversation(source, id);
    void loadConversation(source, id);
    return () => unwatchConversation(source, id);
  }, [source, id]);

  const running = conversation?.status === 'running';
  // Waiting on you is still mid-turn: Stop must stay available next to the card.
  const working = running || conversation?.status === 'needs_approval' || waiting.length > 0;
  const disabledReason =
    status.state === 'needs_credentials'
      ? `Sign in to ${SOURCE_NAMES[source]} in Settings`
      : status.state !== 'connected'
        ? `${SOURCE_NAMES[source]} is offline`
        : undefined;

  return (
    <section className="pane pane-conv" aria-label="Conversation">
      <header className="topbar">
        <button type="button" className="icon-btn mobile-only" onClick={goBack} aria-label="Back">
          <ChevronLeft size={26} />
        </button>
        <div className="conv-title">
          <SourceAvatar source={source} small live={running} linked={conversation?.hermesInPaseo} />
          <div className="text">
            <div className="name">
              {readableBridgeText(conversation?.title) ?? (detail?.status === 'loading' ? 'Loading…' : 'Conversation')}
            </div>
            {/* Who is answering, named first: a chat started from the one box chose nothing, and the
                person should still be able to see which agent it went to. */}
            <div className="sub">{[SOURCE_NAMES[source], conversation?.subtitle].filter(Boolean).join(' · ')}</div>
          </div>
        </div>
        {conversation && !subagent && (
          <button type="button" className="icon-btn" aria-label="Thread actions" onClick={() => setMenu(true)}>
            <Ellipsis size={22} />
          </button>
        )}
      </header>

      {menu && (
        <Sheet title="This thread" onClose={() => !tidying && setMenu(false)}>
          <div className="group thread-actions">
            <button type="button" className="kv action-row" onClick={archive} disabled={tidying}>
              <Archive size={18} />
              <div className="grow">
                <div>Archive</div>
                <div className="muted">
                  Hides it here and in {SOURCE_NAMES[source]}.
                  {source === 'paseo'
                    ? ' It comes back if it gets a new message, or when you restore it.'
                    : ' Restore it any time from Settings → Archived threads.'}
                  {family.length > 1 &&
                    ` Also archives the ${family.length - 1} ${family.length === 2 ? 'chat' : 'chats'} it started.`}
                </div>
              </div>
            </button>
            <button
              type="button"
              className="kv action-row danger"
              onClick={() => {
                setMenu(false);
                setConfirmDelete(true);
              }}
              disabled={tidying}
            >
              <Trash2 size={18} />
              <div className="grow">
                <div>Delete…</div>
                <div className="muted">Removes it from {SOURCE_NAMES[source]} for good.</div>
              </div>
            </button>
          </div>
        </Sheet>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete this thread?"
          message={`“${title}” will be deleted from ${SOURCE_NAMES[source]} for good. This can't be undone.`}
          confirmLabel="Delete"
          danger
          busy={tidying}
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {offline && (
        <div className="banner">
          <WifiOff size={14} /> Reconnecting…
        </div>
      )}

      {(conversation?.hermesInPaseo || conversation?.parent || startedBy || children.length > 0) && (
        <nav className="links-bar" aria-label="Related threads">
          {conversation?.hermesInPaseo && <HermesInPaseoTag />}
          {conversation?.parent &&
            (parent ? (
              <button
                type="button"
                className="link-chip"
                onClick={() => navigate(conversationPath(parent.source, parent.id, filter))}
              >
                <CornerLeftUp size={13} /> Started by {mark(parent.source)}
                <strong>{readableBridgeText(parent.title)}</strong>
              </button>
            ) : (
              <span className="link-chip">
                <CornerLeftUp size={13} /> Started by another chat
              </span>
            ))}
          {startedBy && (
            <button
              type="button"
              className="link-chip"
              onClick={() => navigate(conversationPath(startedBy.source, startedBy.id, filter))}
            >
              <CornerLeftUp size={13} /> Started by {mark(startedBy.source)}
              <strong>{readableBridgeText(startedBy.title)}</strong>
            </button>
          )}
          {children.map((child) => (
            <button
              key={convKey(child.source, child.id)}
              type="button"
              className="link-chip"
              onClick={() => navigate(conversationPath(child.source, child.id, filter))}
            >
              <CornerDownRight size={13} /> {child.subagent ? 'Sub-agent: ' : child.hermesInPaseo ? 'Hermes: ' : ''}
              {mark(child.source)}
              <strong>{readableBridgeText(child.title)}</strong>
            </button>
          ))}
        </nav>
      )}

      {detail?.needsOpen && !subagent && (
        <div className="readonly-bar">
          <span>This is a shadow connection. Open the live chat to load its history and updates.</span>
          <button type="button" className="link-btn" onClick={() => void loadConversation(source, id, true)}>Open live chat</button>
        </div>
      )}

      <Timeline
        conversationKey={key}
        items={detail?.items ?? []}
        loading={!detail || detail.status === 'loading'}
        {...(detail?.error ? { error: detail.error } : {})}
        running={running && waiting.length === 0}
        onRetry={() => void loadConversation(source, id)}
      />

      <ApprovalDock approvals={waiting} />

      {subagent ? (
        // Its parent's agent runs it: nothing to type, change or stop from here.
        <div className="readonly-bar">
          <Bot size={15} aria-hidden="true" />
          <span>
            Sub-agent of{' '}
            {parent ? (
              <button type="button" className="link-btn" onClick={() => navigate(conversationPath(parent.source, parent.id, filter))}>
                {readableBridgeText(parent.title)}
              </button>
            ) : (
              'another chat'
            )}{' '}
            <span className="nowrap">· read-only</span>
          </span>
        </div>
      ) : (
        <>
          {!disabledReason && (
            <ControlsStrip source={source} id={id} {...(conversation ? { status: conversation.status } : {})} />
          )}
          <Composer
            key={key}
            source={source}
            id={id}
            running={working}
            {...(disabledReason ? { disabledReason } : {})}
            onNew={(text) =>
              onNew({
                source,
                ...(conversation?.project ? { cwd: conversation.project.path } : {}),
                ...(text ? { text } : {}),
              })
            }
          />
        </>
      )}
    </section>
  );
}
