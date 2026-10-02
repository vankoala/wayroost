import type { ConversationSummary, Source } from '../../shared/protocol';

// Groups the inbox by project folder, and nests every chat under whatever
// started it, across Hermes and Paseo: a thread's lane is its root's backend.
// Which project a chat belongs to follows the project bridge's rule
// (server/src/bridge/project.ts, ProjectIndex), so agents and the phone agree
// on what a project holds; only sub-agents follow their parent instead.

export const NO_PROJECT = '__none__';

/** An absolute folder in canonical form (no trailing slash, no "." or ".." parts), or null. */
export function canonicalFolder(path: string | undefined): string | null {
  if (!path?.startsWith('/') || path.length > 4096 || path.includes('\0')) return null;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** Folders that hold everything rather than one project: never a project. */
export const isBareFolder = (path: string) =>
  path === '/' || path === '/home' || path === '/root' || /^\/home\/[^/]+$/.test(path);

export interface SubagentEntry {
  conversation: ConversationSummary;
  /** Set when another sub-agent ran it, not the chat it's folded under. */
  parentTitle?: string;
}

export interface ThreadChild {
  conversation: ConversationSummary;
  /** The chat that started it, when that isn't the thread's root. */
  parentTitle?: string;
  /** Sub-agents it ran (and theirs), folded under it. */
  subagents: SubagentEntry[];
}

export interface ThreadNode {
  conversation: ConversationSummary;
  /** Sub-agents the root ran (and theirs), folded under it. */
  subagents: SubagentEntry[];
  /** Chats started, directly or further down, by this thread. */
  children: ThreadChild[];
}

export interface ProjectGroup {
  key: string;
  name: string;
  path: string | null;
  /** Threads whose root is a Hermes chat… */
  hermes: ThreadNode[];
  /** …and those whose root is a Paseo agent. */
  paseo: ThreadNode[];
  /** Every chat the group shows, sub-agents included (folded or not). */
  members: ConversationSummary[];
  /** Its chats by their own backend, and its sub-agents apart. */
  counts: { hermes: number; paseo: number; subagents: number };
  attention: number;
  running: number;
  updatedAt: number;
}

const within = (path: string, root: string) => path === root || path.startsWith(root === '/' ? '/' : `${root}/`);

export const chatKey = (ref: { source: Source; id: string }) => `${ref.source}:${ref.id}`;

/** Every chat by `source:id`, and by the other ids it's known by (earlier ids, its Hermes session). */
export function chatIndex(conversations: readonly ConversationSummary[]): Map<string, ConversationSummary> {
  const index = new Map<string, ConversationSummary>();
  for (const c of conversations) index.set(chatKey(c), c);
  for (const c of conversations) {
    for (const alias of c.aliases ?? []) if (!index.has(chatKey(alias))) index.set(chatKey(alias), c);
  }
  return index;
}

/** The listed chat that started this one, if any. */
export function parentOf(
  c: ConversationSummary,
  index: ReadonlyMap<string, ConversationSummary>,
): ConversationSummary | undefined {
  const parent = c.parent ? index.get(chatKey(c.parent)) : undefined;
  return parent === c ? undefined : parent;
}

const isWorking = (c: ConversationSummary) => c.status === 'running' || c.status === 'needs_approval';

/**
 * The project roots: the folders of the listed Paseo agents (Paseo knows git
 * roots; Hermes only knows its working folder). Sub-agents never make one.
 */
export function paseoProjectRoots(conversations: readonly ConversationSummary[]): string[] {
  const roots = new Set<string>();
  for (const c of conversations) {
    if (c.subagent || c.source !== 'paseo') continue;
    const folder = canonicalFolder(c.project?.path);
    if (folder && !isBareFolder(folder)) roots.add(folder);
  }
  return [...roots];
}

/**
 * A chat and every chat started under it, deepest first. Sub-agent runs are
 * left out: they go with the chat that ran them.
 */
export function threadFamily(
  root: ConversationSummary,
  conversations: readonly ConversationSummary[],
): ConversationSummary[] {
  const index = chatIndex(conversations);
  const kids = new Map<string, ConversationSummary[]>();
  for (const c of conversations) {
    if (c.subagent) continue;
    const parent = parentOf(c, index);
    if (parent) kids.set(chatKey(parent), [...(kids.get(chatKey(parent)) ?? []), c]);
  }
  const family: ConversationSummary[] = [];
  const seen = new Set<string>();
  const visit = (c: ConversationSummary) => {
    if (seen.has(chatKey(c))) return;
    seen.add(chatKey(c));
    for (const child of kids.get(chatKey(c)) ?? []) visit(child);
    family.push(c);
  };
  visit(root);
  return family;
}

export function groupByProject(
  conversations: ConversationSummary[],
  needsYou: (c: ConversationSummary) => boolean,
): ProjectGroup[] {
  // Each chat's folder; a chat in a folder that holds everything has none.
  const folders = new Map<ConversationSummary, string>();
  // A folder is named after its Paseo project first, else its first Hermes chat.
  const names = new Map<string, string>();
  for (const c of conversations) {
    const folder = canonicalFolder(c.project?.path);
    if (!folder || isBareFolder(folder)) continue;
    folders.set(c, folder);
    // Sub-agents go with their parent; as in the bridge, their folders never make a project.
    if (c.subagent) continue;
    const name = c.project?.name.trim();
    if (name && (c.source === 'paseo' || !names.has(folder))) names.set(folder, name);
  }
  const paseoRoots = paseoProjectRoots(conversations).sort((a, b) => b.length - a.length);
  // The longest Paseo root holding the folder, else the folder itself. (The
  // bridge then tries the longest Hermes chat folder holding it, which for a
  // chat is always its own folder: nested Hermes folders stay separate.)
  const projectOf = (folder: string) => paseoRoots.find((root) => within(folder, root)) ?? folder;
  const ownProject = (c: ConversationSummary) => {
    const folder = folders.get(c);
    return folder ? projectOf(folder) : NO_PROJECT;
  };

  // Where each chat sits: under what started it, or at the top of a thread.
  // A chat nests only under a parent in its own project; a sub-agent always
  // goes with its parent. A loop in the links is cut where it closes.
  const index = chatIndex(conversations);
  const up = new Map<ConversationSummary, ConversationSummary | null>();
  const placed = new Map<ConversationSummary, string>();
  const resolving = new Set<ConversationSummary>();
  const place = (c: ConversationSummary): string => {
    const done = placed.get(c);
    if (done !== undefined) return done;
    if (resolving.has(c)) {
      up.set(c, null);
      placed.set(c, ownProject(c));
      return ownProject(c);
    }
    resolving.add(c);
    const parent = parentOf(c, index);
    let under: ConversationSummary | null = null;
    let project = ownProject(c);
    if (parent) {
      const parentProject = place(parent);
      if (c.subagent) {
        under = parent;
        project = parentProject;
      } else if (parentProject === project) {
        under = parent;
      }
    }
    resolving.delete(c);
    if (!up.has(c)) up.set(c, under);
    if (!placed.has(c)) placed.set(c, project);
    return placed.get(c)!;
  };
  for (const c of conversations) place(c);

  const childrenOf = new Map<ConversationSummary, ConversationSummary[]>();
  for (const c of conversations) {
    const parent = up.get(c);
    if (parent) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), c]);
  }

  const rank = (c: ConversationSummary) => (needsYou(c) ? 0 : c.status === 'running' ? 1 : 2);
  const byImportance = (a: ConversationSummary, b: ConversationSummary) =>
    rank(a) - rank(b) || b.updatedAt - a.updatedAt;
  const bySubagentOrder = (a: SubagentEntry, b: SubagentEntry) =>
    Number(isWorking(b.conversation)) - Number(isWorking(a.conversation)) || b.conversation.updatedAt - a.conversation.updatedAt;

  /** A thread: its root, the chats under it (flattened), and each one's sub-agents. */
  const thread = (root: ConversationSummary) => {
    const node: ThreadNode = { conversation: root, subagents: [], children: [] };
    const members: ConversationSummary[] = [root];
    const visit = (parent: ConversationSummary, owner: { subagents: SubagentEntry[] }) => {
      for (const child of childrenOf.get(parent) ?? []) {
        members.push(child);
        if (child.subagent) {
          owner.subagents.push({ conversation: child, ...(parent.subagent ? { parentTitle: parent.title } : {}) });
          visit(child, owner);
        } else {
          const entry: ThreadChild = { conversation: child, subagents: [], ...(parent !== root ? { parentTitle: parent.title } : {}) };
          node.children.push(entry);
          visit(child, entry);
        }
      }
    };
    visit(root, node);
    node.children.sort((a, b) => byImportance(a.conversation, b.conversation));
    node.subagents.sort(bySubagentOrder);
    for (const child of node.children) child.subagents.sort(bySubagentOrder);
    return { node, members };
  };

  const groups = new Map<string, ProjectGroup>();
  const order = new Map<ThreadNode, { rank: number; updatedAt: number }>();
  for (const root of conversations) {
    if (up.get(root)) continue;
    const { node, members } = thread(root);
    // A sub-agent whose parent isn't listed only shows while it (or its own) works.
    if (root.subagent && !members.some(isWorking)) continue;
    const key = placed.get(root)!;
    let group = groups.get(key);
    if (!group) {
      const path = key === NO_PROJECT ? null : key;
      group = {
        key,
        name: path ? (names.get(path) ?? path.split('/').pop() ?? path) : 'Other chats',
        path,
        hermes: [],
        paseo: [],
        members: [],
        counts: { hermes: 0, paseo: 0, subagents: 0 },
        attention: 0,
        running: 0,
        updatedAt: 0,
      };
      groups.set(key, group);
    }
    group[root.source].push(node);
    for (const m of members) {
      group.members.push(m);
      if (m.subagent) group.counts.subagents += 1;
      else group.counts[m.source] += 1;
      if (needsYou(m)) group.attention += 1;
      if (m.status === 'running') group.running += 1;
      group.updatedAt = Math.max(group.updatedAt, m.updatedAt);
    }
    // A thread ranks by its most urgent member, then its newest update.
    order.set(node, {
      rank: Math.min(...members.map(rank)),
      updatedAt: Math.max(...members.map((m) => m.updatedAt)),
    });
  }

  const byThread = (a: ThreadNode, b: ThreadNode) => {
    const x = order.get(a)!;
    const y = order.get(b)!;
    return x.rank - y.rank || y.updatedAt - x.updatedAt;
  };
  for (const group of groups.values()) {
    group.hermes.sort(byThread);
    group.paseo.sort(byThread);
  }

  return [...groups.values()].sort(
    (a, b) =>
      Number(a.key === NO_PROJECT) - Number(b.key === NO_PROJECT) ||
      Number(b.attention > 0) - Number(a.attention > 0) ||
      Number(b.running > 0) - Number(a.running > 0) ||
      b.updatedAt - a.updatedAt,
  );
}
