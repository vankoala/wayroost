import { ArrowDown, Bot, Brain, Check, ChevronDown, ChevronRight, LoaderCircle, Terminal, X } from 'lucide-react';
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { parseBridgeEnvelope, type AttachmentRef, type TimelineItem } from '../../../shared/protocol';
import { renderMarkdown } from '../markdown';
import { hydrateMedia } from '../media';
import { previewsFor } from '../previews';
import { clampOutput, commandLabel, plainOutput } from '../slash';
import { PENDING_PREFIX } from '../store';
import { FileKindIcon } from './Attachments';
import { MediaStrip, showMedia } from './Media';
import { ListenButton } from './Voice';

const NEAR_BOTTOM_PX = 120;

function MessageFiles({ files, previews }: { files: AttachmentRef[]; previews?: (string | undefined)[] }) {
  return (
    <div className="msg-files">
      {files.map((file, i) => {
        const preview = file.kind === 'image' ? previews?.[i] : undefined;
        return (
          <span key={i} className="msg-file" title={file.name}>
            {preview ? (
              <img src={preview} alt="" className="msg-file-thumb" />
            ) : (
              <span className="msg-file-icon">
                <FileKindIcon kind={file.kind} size={15} />
              </span>
            )}
            <span className="msg-file-name">{file.name}</span>
          </span>
        );
      })}
    </div>
  );
}

/** Output of a "/" command: a system line, then the text exactly as printed (never markdown). */
function CommandOutput({ item }: { item: Extract<TimelineItem, { kind: 'command' }> }) {
  const [expanded, setExpanded] = useState(false);
  const output = useMemo(() => plainOutput(item.output), [item.output]);
  const clamp = useMemo(() => clampOutput(output), [output]);
  if (item.running) {
    return (
      <div className="cmd running" role="status">
        <div className="cmd-head">
          <LoaderCircle size={13} className="spin" />
          <span>
            Running <code>{commandLabel(item.command)}</code>…
          </span>
        </div>
      </div>
    );
  }
  const command = item.command.trim().startsWith('/') ? item.command.trim() : `/${item.command.trim()}`;
  return (
    <div className={`cmd${item.error ? ' error' : ''}`}>
      <div className="cmd-head">
        {item.error ? <X size={13} strokeWidth={2.6} /> : <Terminal size={13} strokeWidth={2.4} />}
        <code>{command}</code>
      </div>
      {output && (
        <div className="cmd-body">
          <pre className="cmd-out">{expanded ? output : clamp.text}</pre>
          {clamp.clamped && (
            <button type="button" className="link-btn cmd-more" onClick={() => setExpanded((e) => !e)}>
              {expanded ? 'Show less' : `Show all · ${clamp.lines} lines`}
              <ChevronDown size={14} className={expanded ? 'flip' : ''} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** An agent's markdown, with images from your machine loaded into the placeholders the renderer left. */
function Markdown({ text, className }: { text: string; className: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = renderMarkdown(text);
  useLayoutEffect(() => hydrateMedia(ref.current), [html]);
  const onClick = (e: MouseEvent) => {
    const image = (e.target as Element).closest<HTMLElement>('.md-media.ready');
    if (image?.dataset.media) showMedia(image.dataset.media, image.dataset.alt || 'Image');
  };
  return (
    <div
      ref={ref}
      className={`md ${className}`}
      onClick={onClick}
      // Sanitized: markdown-it (no raw HTML) → DOMPurify, under a strict CSP.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function AssistantMessage({
  item,
  conversationKey,
}: {
  item: Extract<TimelineItem, { kind: 'assistant' }>;
  conversationKey: string;
}) {
  return (
    <>
      <Markdown text={item.text} className={`msg-assistant${item.streaming ? ' streaming' : ''}`} />
      {item.media?.length ? <MediaStrip media={item.media} /> : null}
      {!item.streaming && <ListenButton conversationKey={conversationKey} id={item.id} text={item.text} />}
    </>
  );
}

/** A message another agent sent through the Signalbox bridge: not from you, so not your bubble. */
function BridgedMessage({ sender, text }: { sender: string; text: string }) {
  return (
    <div className="msg-bridged">
      <div className="bridged-head">
        <Bot size={15} aria-hidden="true" />
        <span>
          From <strong>{sender}</strong> · via Wayroost
        </span>
      </div>
      <Markdown text={text} className="bridged-body" />
    </div>
  );
}

const Row = memo(function Row({
  item,
  previews,
  conversationKey,
}: {
  item: TimelineItem;
  previews?: (string | undefined)[];
  conversationKey: string;
}) {
  switch (item.kind) {
    case 'user': {
      const bridged = item.id.startsWith(PENDING_PREFIX) ? null : parseBridgeEnvelope(item.text);
      if (bridged) return <BridgedMessage sender={bridged.sender} text={bridged.text} />;
      const files = item.attachments ?? [];
      const classes = ['msg-user'];
      if (item.id.startsWith(PENDING_PREFIX)) classes.push('pending');
      if (files.length && !item.text.trim()) classes.push('files-only');
      return (
        <div className={classes.join(' ')}>
          {item.text}
          {files.length > 0 && <MessageFiles files={files} previews={previews} />}
        </div>
      );
    }
    case 'assistant':
      return <AssistantMessage item={item} conversationKey={conversationKey} />;
    case 'reasoning':
      return (
        <details className="reasoning">
          <summary>
            {item.streaming ? <LoaderCircle size={14} className="spin" /> : <Brain size={14} />}
            {item.streaming ? 'Thinking…' : 'Thought process'}
          </summary>
          <div className="body">{item.text}</div>
        </details>
      );
    case 'tool': {
      const expandable = Boolean(item.input || item.output);
      const icon =
        item.status === 'done' ? (
          <Check size={16} strokeWidth={2.6} />
        ) : item.status === 'error' ? (
          <X size={16} strokeWidth={2.6} />
        ) : (
          <LoaderCircle size={16} className="spin" />
        );
      const media = item.media ?? [];
      const card = (
        <details className={`tool${media.length ? ' has-media' : ''}`}>
          <summary aria-disabled={!expandable} onClick={expandable ? undefined : (e) => e.preventDefault()}>
            <span className={`state ${item.status}`} aria-label={item.status}>
              {icon}
            </span>
            <span className="name">{item.name}</span>
            <span className="summary-text">{item.summary ?? ''}</span>
            {expandable && <ChevronRight size={16} className="chev" />}
          </summary>
          {expandable && (
            <div className="io">
              {item.input && (
                <div>
                  <div className="io-label">Input</div>
                  <pre>{item.input}</pre>
                </div>
              )}
              {item.output && (
                <div>
                  <div className="io-label">Output</div>
                  <pre>{item.output}</pre>
                </div>
              )}
            </div>
          )}
        </details>
      );
      if (!media.length) return card;
      // The images are the useful part: shown under the card even while it's closed.
      return (
        <div className="tool-block">
          {card}
          <div className="tool-media">
            <MediaStrip media={media} />
          </div>
        </div>
      );
    }
    case 'notice':
      return <div className={`notice ${item.level}`}>{item.text}</div>;
    case 'command':
      return <CommandOutput item={item} />;
  }
});

export function Timeline({
  conversationKey,
  items,
  loading,
  error,
  running,
  onRetry,
}: {
  conversationKey: string;
  items: TimelineItem[];
  loading: boolean;
  error?: string;
  running: boolean;
  onRetry: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  // Thumbnails of photos sent from this browser.
  const previews = useMemo(() => previewsFor(conversationKey, items), [conversationKey, items]);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    stickToBottom.current = true;
    setShowJump(false);
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    stickToBottom.current = near;
    setShowJump(!near);
  };

  // Follow new output while the reader is at the bottom; never yank them down otherwise.
  const last = items[items.length - 1];
  useLayoutEffect(() => {
    if (stickToBottom.current) scrollToBottom();
  }, [items, running, scrollToBottom]);

  // Our own messages and commands always bring the view down (another agent's don't).
  const lastId = last?.id;
  useLayoutEffect(() => {
    if (last?.kind === 'command' || (last?.kind === 'user' && !parseBridgeEnvelope(last.text))) scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId]);

  const onClick = (e: MouseEvent) => {
    const button = (e.target as HTMLElement).closest('[data-copy]');
    if (!button) return;
    const code = button.closest('.md-code')?.querySelector('code')?.textContent ?? '';
    navigator.clipboard?.writeText(code).then(
      () => {
        button.textContent = 'Copied';
        setTimeout(() => (button.textContent = 'Copy'), 1500);
      },
      () => {},
    );
  };

  const streaming = last && (last.kind === 'assistant' || last.kind === 'reasoning') && last.streaming;
  const showTyping = running && !streaming;

  return (
    <div className="timeline-wrap">
      <div className="timeline" ref={scrollRef} onScroll={onScroll} onClick={onClick}>
        <div className="timeline-inner">
          {loading && items.length === 0 && (
            <>
              <div className="skeleton" />
              <div className="skeleton" />
            </>
          )}
          {error && (
            <div className="notice error">
              {error}{' '}
              <button type="button" className="md-copy" onClick={onRetry}>
                Retry
              </button>
            </div>
          )}
          {!loading && !error && items.length === 0 && <div className="notice">No messages yet. Say hello below.</div>}
          {items.map((item) => (
            <Row key={item.id} item={item} previews={previews.get(item.id)} conversationKey={conversationKey} />
          ))}
          {showTyping && (
            <div className="typing" aria-label="Working">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
      </div>
      {showJump && (
        <button type="button" className="jump" onClick={() => scrollToBottom(true)}>
          <ArrowDown size={15} /> Latest
        </button>
      )}
    </div>
  );
}
