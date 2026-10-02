import { posix } from 'node:path';
import type { ConversationSummary } from '../../../shared/protocol.js';

// Which chats count as "this project" for an agent using the bridge. It follows
// the Projects view (web/src/projects.ts, groupByProject): Paseo agents group by
// their project root (the git root; worktrees are already mapped to the main
// repository by the Paseo adapter), and a Hermes chat joins the longest Paseo
// root that contains its folder, or else stands on its own folder. A folder
// that holds everything (/, /home, a home directory, /root) is never a project.
// Sub-agents never count: the chat that runs them speaks for them (the phone
// folds them under it), so they aren't members and their folders aren't roots.

export const NOT_A_PROJECT = 'Run this from a project folder.';

export interface ProjectRef {
  path: string;
  name: string;
}

const MAX_PATH = 4096;

/** An absolute folder in canonical form (normalized, no trailing slash), or null if it isn't one. */
export function canonicalFolder(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > MAX_PATH || value.includes('\0')) {
    return null;
  }
  return posix.normalize(value).replace(/\/+$/, '') || '/';
}

/** `path` is `root` or inside it, by whole path segments. */
export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root === '/' ? '/' : `${root}/`);
}

/** Folders that hold everything rather than one project. */
export function isBareFolder(path: string): boolean {
  return path === '/' || path === '/home' || path === '/root' || /^\/home\/[^/]+$/.test(path);
}

function folderName(path: string): string {
  return path.split('/').pop() || path;
}

/** The project folders the Projects view knows, longest first, per source. */
export class ProjectIndex {
  private readonly paseoRoots: string[];
  private readonly hermesRoots: string[];
  private readonly names = new Map<string, string>();
  private readonly paths = new Map<ConversationSummary, string>();

  constructor(readonly conversations: readonly ConversationSummary[]) {
    const paseo = new Set<string>();
    const hermes = new Set<string>();
    for (const c of conversations) {
      const path = c.subagent ? null : canonicalFolder(c.project?.path);
      if (!path) continue;
      this.paths.set(c, path);
      if (isBareFolder(path)) continue;
      (c.source === 'paseo' ? paseo : hermes).add(path);
      // The Projects view names a folder after its Paseo project first.
      const name = c.project?.name?.trim();
      if (name && (c.source === 'paseo' || !this.names.has(path))) this.names.set(path, name);
    }
    const longestFirst = (set: Set<string>) => [...set].sort((a, b) => b.length - a.length);
    this.paseoRoots = longestFirst(paseo);
    this.hermesRoots = longestFirst(hermes);
  }

  /**
   * The project a folder belongs to: the longest Paseo root that is it or holds
   * it, else the longest Hermes chat folder that is it or holds it, else the
   * folder itself.
   */
  rootOf(folder: string): string {
    return (
      this.paseoRoots.find((root) => within(folder, root)) ??
      this.hermesRoots.find((root) => within(folder, root)) ??
      folder
    );
  }

  /** The project for a starting folder, or null when it isn't a project folder. */
  resolve(start: string | null | undefined): ProjectRef | null {
    const folder = canonicalFolder(start);
    if (!folder || isBareFolder(folder)) return null;
    const path = this.rootOf(folder);
    if (isBareFolder(path)) return null;
    return { path, name: this.names.get(path) ?? folderName(path) };
  }

  /** Chats the Projects view shows in the project at `root`. */
  members(root: string): ConversationSummary[] {
    return this.conversations.filter((c) => {
      const path = this.paths.get(c);
      return path !== undefined && !isBareFolder(path) && this.rootOf(path) === root;
    });
  }
}
