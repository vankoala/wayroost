import { FileCode, File as FileIcon, FileText, ImageIcon, LoaderCircle, Paperclip, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AttachmentRef } from '../../../shared/protocol';
import {
  ACCEPT,
  MAX_ATTACHMENTS,
  attachmentKind,
  formatSize,
  prepareFile,
  releasePreview,
  type PendingAttachment,
} from '../attach';
import { useDropHint } from '../drop';
import { toast } from '../store';

const KIND_ICONS = { image: ImageIcon, pdf: FileText, text: FileCode, file: FileIcon } as const;

export function FileKindIcon({ kind, size }: { kind: AttachmentRef['kind']; size: number }) {
  const Icon = KIND_ICONS[kind] ?? FileIcon;
  return <Icon size={size} aria-hidden="true" />;
}

export interface FileAdder {
  add: (files: File[]) => Promise<void>;
  /** Still getting files ready (photos are shrunk first). */
  busy: boolean;
  full: boolean;
}

/** Adds picked or dropped files to a message's attachments, up to the limit. */
export function useFileAdder(attachments: PendingAttachment[], onChange: (next: PendingAttachment[]) => void): FileAdder {
  const [busy, setBusy] = useState(false);
  // Shrinking photos takes a moment: add to the list as it is by then.
  const latest = useRef(attachments);
  useEffect(() => {
    latest.current = attachments;
  }, [attachments]);

  const add = async (files: File[]) => {
    if (!files.length) return;
    const room = MAX_ATTACHMENTS - latest.current.length;
    if (room <= 0) {
      toast(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      return;
    }
    setBusy(true);
    const added: PendingAttachment[] = [];
    for (const file of files.slice(0, room)) {
      try {
        added.push(await prepareFile(file));
      } catch (err) {
        toast((err as Error).message);
      }
    }
    if (files.length > room) toast(`Only ${MAX_ATTACHMENTS} files per message.`);
    onChange([...latest.current, ...added]);
    setBusy(false);
  };
  return { add, busy, full: attachments.length >= MAX_ATTACHMENTS };
}

/** Paperclip button + hidden picker. On phones this offers camera, photos and files. */
export function AttachButton({ adder, disabled }: { adder: FileAdder; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="attach-btn"
        aria-label="Attach photos or files"
        disabled={disabled || adder.busy || adder.full}
        onClick={() => input.current?.click()}
      >
        {adder.busy ? <LoaderCircle size={18} className="spin" /> : <Paperclip size={19} />}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          void adder.add(files);
        }}
      />
    </>
  );
}

/** Why dropped files can't be taken right now, or null. */
export function dropRefusal(adder: FileAdder, closed?: string | null): string | null {
  if (closed) return closed;
  if (adder.busy) return 'Still getting the last files ready…';
  if (adder.full) return `Up to ${MAX_ATTACHMENTS} files per message.`;
  return null;
}

/** Across the page while files are dragged over it: where they'll go, or why they can't. */
export function DropOverlay() {
  const hint = useDropHint();
  if (!hint) return null;
  return (
    <div className={`drop-overlay${hint.refused ? ' refused' : ''}`} role="status">
      <div className="drop-card">
        <Paperclip size={18} aria-hidden="true" />
        {hint.text}
      </div>
    </div>
  );
}

export function AttachmentChips({
  attachments,
  onChange,
}: {
  attachments: PendingAttachment[];
  onChange: (next: PendingAttachment[]) => void;
}) {
  if (!attachments.length) return null;
  const remove = (a: PendingAttachment) => {
    releasePreview(a);
    onChange(attachments.filter((x) => x.id !== a.id));
  };
  return (
    <div className="attach-chips">
      {attachments.map((a) => (
        <div key={a.id} className="attach-chip" title={a.name}>
          {a.previewUrl ? (
            <img src={a.previewUrl} alt="" className="attach-thumb" />
          ) : (
            <span className="attach-icon">
              <FileKindIcon kind={attachmentKind(a.mimeType, a.name)} size={18} />
            </span>
          )}
          <span className="attach-meta">
            <span className="attach-name">{a.name}</span>
            <span className="attach-size">{formatSize(a.size)}</span>
          </span>
          <button type="button" className="attach-remove" aria-label={`Remove ${a.name}`} onClick={() => remove(a)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
