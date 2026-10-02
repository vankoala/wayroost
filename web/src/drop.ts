import { useEffect, useRef, useSyncExternalStore } from 'react';
import { toast } from './store';

// Files dragged onto the page go to whatever takes them: the new-chat sheet while it's open, otherwise
// the open chat's message box. Anywhere else the drop is refused, so a stray drop never makes the
// browser open the file in place of Signalbox.

export interface DropTarget {
  /** Shown across the page while files are dragged over it. */
  label: string;
  /** Why files can't be taken right now (a read-only chat, a full message), or null. */
  refusal: string | null;
  take: (files: File[]) => void;
}

/** What the page shows while files are dragged over it. */
export interface DropHint {
  text: string;
  refused: boolean;
}

/** The parts of a DragEvent used here. */
interface DragLike {
  dataTransfer: Pick<DataTransfer, 'types' | 'items' | 'files' | 'dropEffect'> | null;
  preventDefault(): void;
}

// Mounted targets, oldest first: the newest one takes the files.
const targets: Array<{ current: DropTarget }> = [];
let hint: DropHint | null = null;
const watchers = new Set<() => void>();
let fade: ReturnType<typeof setTimeout> | undefined;

function setHint(next: DropHint | null) {
  if (next?.text === hint?.text && next?.refused === hint?.refused) return;
  hint = next;
  watchers.forEach((w) => w());
}

function carriesFiles(e: DragLike): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

function destination(): { target?: DropTarget; refusal: string | null } {
  const target = targets.at(-1)?.current;
  return { target, refusal: target ? target.refusal : 'Open a chat to attach files.' };
}

/** The dropped files, leaving out folders (browsers hand a folder over as a file that can't be read). */
export function droppedFiles(data: Pick<DataTransfer, 'items' | 'files'>): { files: File[]; folders: number } {
  const items = Array.from(data.items ?? []);
  if (!items.length) return { files: Array.from(data.files ?? []), folders: 0 };
  const files: File[] = [];
  let folders = 0;
  for (const item of items) {
    if (item.kind !== 'file') continue;
    if (item.webkitGetAsEntry?.()?.isDirectory) {
      folders += 1;
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return { files, folders };
}

export function onDragOver(e: DragLike): void {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  const { target, refusal } = destination();
  if (e.dataTransfer) e.dataTransfer.dropEffect = refusal ? 'none' : 'copy';
  setHint({ text: refusal ?? target!.label, refused: Boolean(refusal) });
  // dragleave is unreliable across child elements: the hint goes once dragover stops coming.
  clearTimeout(fade);
  fade = setTimeout(() => setHint(null), 250);
}

export function onDrop(e: DragLike): void {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  clearTimeout(fade);
  setHint(null);
  const { target, refusal } = destination();
  if (!target || refusal || !e.dataTransfer) return;
  const { files, folders } = droppedFiles(e.dataTransfer);
  if (folders) toast(`${folders === 1 ? 'A folder' : 'Folders'} can't be attached. Drop the files inside instead.`);
  if (files.length) target.take(files);
}

/** Once, at startup. */
export function guardFileDrops(): void {
  window.addEventListener('dragenter', onDragOver);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('drop', onDrop);
}

/** Files dropped on the page go to `entry.current` until the returned function is called. */
export function registerDropTarget(entry: { current: DropTarget }): () => void {
  targets.push(entry);
  return () => {
    const at = targets.indexOf(entry);
    if (at >= 0) targets.splice(at, 1);
  };
}

/** While mounted, files dropped anywhere on the page come here (the newest mounted place wins). */
export function useFileDrop(target: DropTarget): void {
  const entry = useRef(target);
  useEffect(() => {
    entry.current = target;
  });
  useEffect(() => registerDropTarget(entry), []);
}

export function useDropHint(): DropHint | null {
  return useSyncExternalStore(
    (watch) => {
      watchers.add(watch);
      return () => watchers.delete(watch);
    },
    () => hint,
  );
}
