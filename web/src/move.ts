import type { ConversationSummary } from '../../shared/protocol';
import { canonicalFolder, isBareFolder, type ProjectFolder } from './projects';

export const CHAT_DRAG_TYPE = 'application/x-wayroost-hermes-chat';
export const COLLAPSED_PROJECTS = 'signalbox:collapsed-projects';
export const EXPANDED_PROJECTS = 'wayroost:expanded-projects';
export const FOLDER_MOVED = 'wayroost:folder-moved';

/** Removal observations live only as long as their move requests. */
export const pendingMoves = new Set<{ key: string; removed: boolean }>();

export function moveDisabledReason(c: ConversationSummary): string | null {
  if (c.source !== 'hermes' || c.subagent) return 'Only Hermes chats can be moved; sub-agents follow their parent.';
  if (c.status === 'running' || c.status === 'needs_approval' || c.pendingApprovals > 0) {
    return 'Wait until this chat finishes working and has no pending approval.';
  }
  return null;
}

export function validMoveFolder(path: string): boolean {
  return canonicalFolder(path) === path && !path.includes('..') && !isBareFolder(path);
}

/** The same folders, names and order as Projects, including collapsed descendants. */
export function moveFolders(tree: readonly ProjectFolder[], depth = 0): Array<{ path: string; name: string; depth: number }> {
  return tree.flatMap((f) => f.path ? [{ path: f.path, name: f.name, depth }, ...moveFolders(f.children, depth + 1)] : []);
}

/** Only our in-app chat drag can claim a folder header; files keep their attachment flow. */
export function canDropChat(types: readonly string[], c: ConversationSummary | undefined, path: string | null): boolean {
  return types.includes(CHAT_DRAG_TYPE) && !types.includes('Files') && !!c && !moveDisabledReason(c) &&
    !!path && validMoveFolder(path) && canonicalFolder(c.project?.path) !== path;
}

/** Remember the destination and all ancestors as open, even when Projects is unmounted. */
export function revealMovedFolder(path: string): void {
  try {
    const closed = new Set<string>(JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS) ?? '[]'));
    const opened = new Set<string>(JSON.parse(localStorage.getItem(EXPANDED_PROJECTS) ?? '[]'));
    let at = path;
    while (at && at !== '/') {
      closed.delete(at);
      opened.add(at);
      at = at.slice(0, at.lastIndexOf('/'));
    }
    localStorage.setItem(COLLAPSED_PROJECTS, JSON.stringify([...closed]));
    localStorage.setItem(EXPANDED_PROJECTS, JSON.stringify([...opened]));
  } catch {
    // Convenience only, like the existing collapse preferences.
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(FOLDER_MOVED));
}
