import { ArrowUp, LoaderCircle } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Source } from '../../../shared/protocol';
import { advancedWanted, rememberAdvanced } from '../newChatMode';
import { api, refreshList } from '../api';
import { releasePreview, toUpload, type PendingAttachment } from '../attach';
import { newHermesChatCommands } from '../commands';
import { useFileDrop } from '../drop';
import { keepPreviews } from '../previews';
import { conversationPath, navigate } from '../router';
import { applyCommandResult, convKey, getState, toast, useStore } from '../store';
import { canSpeak, leaveConversation, useVoiceStatus } from '../voice';
import { AttachButton, AttachmentChips, dropRefusal, useFileAdder } from './Attachments';
import { Sheet, statusLabel, useEnabledSources } from './common';
import { NewConversationSheet } from './NewConversationSheet';
import { useSlashMenu } from './SlashMenu';
import { VoiceBar, VoiceButton } from './Voice';

/**
 * Starting something new. Most of the time that's a chat, so this is one box: say the thing, tap
 * start, and Hermes takes it the way it takes anything you say to it — no model to choose, no
 * folder to name, no agent to pick. Advanced opens the sheet that has all of those in it, and this
 * device remembers which of the two you last used.
 *
 * Opened for a particular folder, or from a Paseo agent's thread, it goes straight to Advanced:
 * the box has no place to hold a folder, and losing the one you asked for would be worse than
 * showing one more screen.
 */
export function NewChatSheet({
  onClose,
  initialCwd,
  initialSource,
  initialText,
}: {
  onClose: () => void;
  /** Opened for a folder: the sheet keeps it. */
  initialCwd?: string;
  /** Opened from a conversation ("/new"): the sheet starts on its source. */
  initialSource?: Source;
  initialText?: string;
}) {
  const enabled = useEnabledSources();
  const chatFirst = useStore(s => s.rollout?.chatFirst ?? false);
  // Without Hermes there is no "just a chat" to offer, and a folder or a Paseo thread needs a sheet.
  const mustChoose = !enabled.includes('hermes') || initialSource === 'paseo' || initialCwd !== undefined;
  const [advanced, setAdvanced] = useState(() => (mustChoose ? true : advancedWanted(chatFirst)));
  // What was already typed and attached, carried over when the view changes under you.
  const [carried, setCarried] = useState<{ text: string; files: PendingAttachment[] } | null>(null);
  if (advanced) {
    return (
      <NewConversationSheet
        onClose={onClose}
        initialCwd={initialCwd}
        initialSource={initialSource}
        initialText={carried?.text ?? initialText}
        initialAttachments={carried?.files}
        onBasic={
          mustChoose
            ? undefined
            : (text, files) => {
                rememberAdvanced(false);
                setCarried({ text, files });
                setAdvanced(false);
              }
        }
      />
    );
  }
  return (
    <ChatFirstSheet
      onClose={onClose}
      initialText={carried?.text ?? initialText}
      initialAttachments={carried?.files}
      onAdvanced={(text, files) => {
        rememberAdvanced(true);
        setCarried({ text, files });
        setAdvanced(true);
      }}
    />
  );
}

/** The one box: what you want, and a start. */
function ChatFirstSheet({
  onClose,
  initialText,
  initialAttachments,
  onAdvanced,
}: {
  onClose: () => void;
  initialText?: string;
  initialAttachments?: PendingAttachment[];
  onAdvanced: (text: string, files: PendingAttachment[]) => void;
}) {
  const status = useStore((s) => s.statuses.hermes);
  const offline = status.state !== 'connected';
  const [text, setText] = useState(initialText ?? '');
  const [attachments, setAttachments] = useState<PendingAttachment[]>(initialAttachments ?? []);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const unsent = useRef(attachments);
  const prepared = useRef(new WeakSet(attachments));
  const changeAttachments = (next: PendingAttachment[]) => {
    // Preparation may finish after dismissal; only new previews still need freeing.
    for (const file of next) {
      if (!mounted.current && !prepared.current.has(file)) releasePreview(file);
      prepared.current.add(file);
    }
    if (mounted.current) {
      unsent.current = next;
      setAttachments(next);
    }
  };
  const ref = useRef<HTMLTextAreaElement>(null);
  const labelId = useId();
  const adder = useFileAdder(attachments, changeAttachments);
  // "/" commands work here too: Hermes answers them, and the chat starts with the text you typed.
  const slash = useSlashMenu({ text, setText, inputRef: ref, load: newHermesChatCommands });
  const voice = useVoiceStatus();
  const mic = canSpeak(voice) && !offline;
  /** A synthetic thread key: the voice mode transcribes into this box, not into a chat. */
  const key = useMemo(() => convKey('hermes', 'new'), []);
  useEffect(() => () => leaveConversation(key), [key]);
  useFileDrop({
    label: 'Drop to attach to the new chat',
    refusal: dropRefusal(adder, busy ? 'Starting the chat…' : null),
    take: (files) => void adder.add(files),
  });
  // Files not sent when the box goes away: free their thumbnails.
  const previewMount = useRef(0);
  const submitting = useRef(false);
  useEffect(() => {
    const mount = ++previewMount.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Let cleanup and setup replay before freeing thumbnails that may still be in use.
      queueMicrotask(() => {
        // A pending start owns its previews until the request succeeds or fails.
        if (previewMount.current === mount && !submitting.current) {
          unsent.current.forEach(releasePreview);
          unsent.current = [];
        }
      });
    };
  }, []);
  const touch = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);

  const canSubmit = !busy && !adder.busy && !offline && (text.trim().length > 0 || attachments.length > 0);

  const resetSubmission = () => {
    submitting.current = false;
    if (mounted.current) setBusy(false);
    else {
      unsent.current.forEach(releasePreview);
      unsent.current = [];
    }
  };

  const submit = async () => {
    if (!canSubmit || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    const files = attachments;
    // The person's own words and files, sent as they are: no folder, no model, nothing to confirm.
    try {
      const created = await api.createHermes({ text: text.trim(), attachments: toUpload(files) });
      const thread = convKey(created.source, created.id);
      keepPreviews(thread, null, files, getState().details[thread]?.items.map((i) => i.id) ?? []);
      unsent.current = [];
      submitting.current = false;
      if (mounted.current) {
        onClose();
        navigate(conversationPath(created.source, created.id));
      }
      if (created.command) applyCommandResult(created.source, created.id, created.command);
      if (created.notice) toast(created.notice, 'info');
      refreshList().catch(() => {});
    } catch (err) {
      toast((err as Error).message);
      resetSubmission();
    }
  };

  /** What you said, written down into the box; a "/" line stays visible before it runs. */
  const onVoiceText = (said: string) => {
    setText((current) => (current.trim() ? `${current.trimEnd()} ${said}` : said));
    if (!touch) ref.current?.focus();
  };

  return (
    <Sheet
      title="New conversation"
      onClose={onClose}
      footer={
        <div className="new-chat-foot">
          <button type="button" className="btn btn-primary btn-block" disabled={!canSubmit} onClick={submit}>
            {busy ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={18} strokeWidth={2.4} />}
            Start chat
          </button>
          <button
            type="button"
            className="link-btn advanced-toggle"
            disabled={busy || adder.busy}
            onClick={() => {
              unsent.current = [];
              onAdvanced(text, attachments);
            }}
          >
            Advanced
          </button>
        </div>
      }
    >
      {offline && (
        <p className="error-text">
          Hermes: {status.message ?? statusLabel(status.state)}
        </p>
      )}

      <div className="field">
        <span id={labelId}>Message</span>
        <div className="field-box">
          <textarea
            ref={ref}
            rows={5}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              slash.track(e.target);
            }}
            onKeyDown={slash.onKeyDown}
            placeholder="Ask Hermes anything, or type / for commands"
            autoFocus
            aria-labelledby={labelId}
            {...slash.inputProps}
          />
          <div className="field-tools">
            <AttachButton adder={adder} disabled={busy} />
            {mic && <VoiceButton conversationKey={key} disabled={busy} onText={onVoiceText} />}
            <span className="field-hint">{attachments.length ? '' : 'Photos, PDFs or text files'}</span>
          </div>
        </div>
        <VoiceBar conversationKey={key} />
        {slash.menu}
        <fieldset disabled={busy} style={{ display: 'contents' }} aria-label="Attachments">
          <AttachmentChips attachments={attachments} onChange={changeAttachments} />
        </fieldset>
      </div>

      <p className="muted new-chat-note">
        Hermes takes this in its usual folder, on the model it normally uses.
      </p>
    </Sheet>
  );
}
