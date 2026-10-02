import { ArrowUp, LoaderCircle, Square } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Source, TimelineItem } from '../../../shared/protocol';
import { api } from '../api';
import { attachmentRefs, releasePreview, toUpload, type PendingAttachment } from '../attach';
import { conversationCommands } from '../commands';
import { noteDraft, readDraft, saveDraft } from '../drafts';
import { forgetPreviews, keepPreviews } from '../previews';
import { findCommand, splitCommand } from '../slash';
import {
  addPendingCommand,
  addPendingUserMessage,
  applyCommandResult,
  clearPrefill,
  convKey,
  getState,
  removeItem,
  toast,
  useStore,
} from '../store';
import { useFileDrop } from '../drop';
import { canSpeak, getVoiceSettings, getVoiceUi, leaveConversation, readReplies, stopReading, useVoiceStatus } from '../voice';
import { audioContext } from '../voice/audio';
import { AttachButton, AttachmentChips, dropRefusal, useFileAdder } from './Attachments';
import { useSlashMenu } from './SlashMenu';
import { VoiceBar, VoiceButton } from './Voice';

export function Composer({
  source,
  id,
  running,
  disabledReason,
  onNew,
}: {
  source: Source;
  id: string;
  running: boolean;
  disabledReason?: string;
  /** "/new": open the new-conversation sheet, with any text typed after the command. */
  onNew: (text: string) => void;
}) {
  const key = convKey(source, id);
  const [text, setText] = useState(() => readDraft(key));
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Phones: Return adds a line and the button sends. Keyboards: Enter sends.
  const touch = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);
  const load = useCallback(() => conversationCommands(source, id), [source, id]);
  const slash = useSlashMenu({ text, setText, inputRef: ref, load: disabledReason ? null : load });
  const prefill = useStore((s) => s.prefills[key]);
  const adder = useFileAdder(attachments, setAttachments);
  // Voice: the mic shows when voice mode is on and this browser can record.
  const voiceStatus = useVoiceStatus();
  const mic = canSpeak(voiceStatus) && !disabledReason;
  /** The box holds what you said (not typed), so the reply gets read aloud. */
  const spoken = useRef(false);
  useEffect(() => () => leaveConversation(key), [key]);
  // What's in the composer now: a transcript arrives a moment after the press
  // that asked for it, and the box may have changed meanwhile.
  const latest = useRef({ text, attachments, sending });
  useEffect(() => {
    latest.current = { text, attachments, sending };
  });
  useFileDrop({
    label: 'Drop to attach to your next message',
    refusal: dropRefusal(adder, disabledReason ? "Files can't be added to this chat." : null),
    take: (files) => void adder.add(files),
  });

  useEffect(() => {
    noteDraft(key, text);
    const timer = setTimeout(() => saveDraft(key, text), 300);
    return () => clearTimeout(timer);
  }, [key, text]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [text]);

  // Text a command handed back (e.g. /undo), unless something new was typed meanwhile.
  useEffect(() => {
    if (prefill === undefined) return;
    clearPrefill(key);
    setText((current) => (current.trim() ? current : prefill));
    ref.current?.focus();
  }, [key, prefill]);

  // Thumbnails of files still in the box hold memory; free them when it goes away.
  const mounted = useRef(true);
  const unsent = useRef(attachments);
  useEffect(() => {
    unsent.current = attachments;
  }, [attachments]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      unsent.current.forEach(releasePreview);
    };
  }, []);

  // A send failed: put the text and files back, keeping anything added meanwhile.
  const restore = (value: string, files: PendingAttachment[], err: unknown) => {
    toast((err as Error).message);
    if (!mounted.current) {
      if (value) saveDraft(key, value);
      files.forEach(releasePreview);
      return;
    }
    setText((current) => (!value ? current : current.trim() ? `${value}\n${current}` : value));
    if (files.length) setAttachments((current) => [...files, ...current]);
  };

  /** Hermes runs "/" text itself: show a running row instead of a message bubble. */
  const runCommand = async (value: string) => {
    const pendingId = addPendingCommand(key, value);
    try {
      const res = await api.send(source, id, value);
      if (res.command) applyCommandResult(source, id, res.command);
    } catch (err) {
      restore(value, [], err);
    } finally {
      removeItem(key, pendingId);
    }
  };

  /** Sends a message; true when it went (as a message, not a command). */
  const sendMessage = async (value: string, files: PendingAttachment[]): Promise<boolean> => {
    const before = getState().details[key]?.items.map((i) => i.id) ?? [];
    const pendingId = addPendingUserMessage(key, value, attachmentRefs(files));
    keepPreviews(key, pendingId, files, before);
    try {
      const res = await api.send(source, id, value, toUpload(files));
      if (res.command) {
        // Run as a command after all: there's no message to show.
        removeItem(key, pendingId);
        applyCommandResult(source, id, res.command);
        return false;
      }
      return true;
    } catch (err) {
      removeItem(key, pendingId);
      forgetPreviews(key, pendingId);
      restore(value, files, err);
      return false;
    }
  };

  /**
   * After a message goes: read the reply aloud if you said it, else stop reading
   * the last one. `before` is the conversation as it was before the message.
   */
  const afterSend = (sent: boolean, wasSpoken: boolean, before: readonly TimelineItem[]) => {
    if (sent && wasSpoken && getVoiceSettings().readReplies) readReplies(key, before);
    else if (sent && getVoiceUi().key === key) stopReading();
  };

  /**
   * What you said, written down: into the box, or straight out with "send right
   * away" when the box is empty. Text starting with "/" always goes in the box,
   * so a command never runs without you seeing it.
   */
  const onVoiceText = (said: string) => {
    const now = latest.current;
    if (getVoiceSettings().autoSend && !now.sending && !now.attachments.length && !now.text.trim() && !said.startsWith('/')) {
      setSending(true);
      const before = getState().details[key]?.items ?? [];
      void sendMessage(said, [])
        .then((sent) => afterSend(sent, true, before))
        .finally(() => setSending(false));
      return;
    }
    spoken.current = true;
    setText((current) => (current.trim() ? `${current.trimEnd()} ${said}` : said));
    if (!touch) ref.current?.focus();
  };

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await api.interrupt(source, id);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setStopping(false);
    }
  };

  const send = async () => {
    const value = text.trim();
    if ((!value && !attachments.length) || sending || disabledReason) return;
    const files = attachments;
    const wasSpoken = spoken.current;
    spoken.current = false;
    // Phones only play audio a tap started: unlock it now for the reply.
    if (wasSpoken && getVoiceSettings().readReplies) audioContext();
    setSending(true);
    setText('');
    saveDraft(key, '');
    try {
      const typed = splitCommand(value);
      const catalog = typed ? await load().catch(() => null) : null;
      const command = typed && catalog ? findCommand(catalog.commands, typed.name) : undefined;
      if (typed && command?.action) {
        // Done by the app rather than sent. Attached files stay for the next message.
        if (command.action === 'new') onNew(typed.rest);
        else {
          setText(typed.rest);
          await stop();
        }
        return;
      }
      setAttachments([]);
      if (typed && catalog?.runner === 'signalbox' && !files.length) await runCommand(value);
      else {
        const before = getState().details[key]?.items ?? [];
        afterSend(await sendMessage(value, files), wasSpoken, before);
      }
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash.onKeyDown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const hasText = text.trim().length > 0 || attachments.length > 0;

  return (
    <div className="composer">
      {slash.menu}
      <VoiceBar conversationKey={key} />
      <AttachmentChips attachments={attachments} onChange={setAttachments} />
      <div className="composer-box">
        <AttachButton adder={adder} disabled={Boolean(disabledReason)} />
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (!e.target.value.trim()) spoken.current = false;
            slash.track(e.target);
          }}
          onKeyDown={onKeyDown}
          placeholder={disabledReason ?? (running ? 'Send a follow-up…' : 'Message, or / for commands')}
          disabled={Boolean(disabledReason)}
          aria-label="Message"
          {...slash.inputProps}
        />
        {mic && <VoiceButton conversationKey={key} disabled={sending} onText={onVoiceText} />}
        {running && (
          <button type="button" className="stop-btn" onClick={stop} disabled={stopping} aria-label="Stop">
            {stopping ? <LoaderCircle size={16} className="spin" /> : <Square size={13} fill="currentColor" />}
          </button>
        )}
        {((!running && !mic) || hasText) && (
          <button
            type="button"
            className="send-btn"
            onClick={send}
            disabled={!hasText || sending || Boolean(disabledReason)}
            aria-label="Send"
          >
            {sending ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={20} strokeWidth={2.5} />}
          </button>
        )}
      </div>
    </div>
  );
}
