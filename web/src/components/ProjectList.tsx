import { Archive, ChevronDown, ChevronRight, Feather, Folder, Plus, SquareTerminal } from 'lucide-react';
import { Fragment, useState } from 'react';
import type { ConversationSummary, Source } from '../../../shared/protocol';
import { api, dropThreads, reportTidy } from '../api';
import { homeRelative } from '../format';
import {
  NO_PROJECT,
  chatKey,
  paseoProjectRoots,
  type ProjectGroup,
  type SubagentEntry,
  type ThreadNode,
} from '../projects';
import { convKey, toast, useStore } from '../store';
import { ConfirmDialog } from './common';
import { ConversationRow } from './ConversationRow';

const COLLAPSED_KEY = 'signalbox:collapsed-projects';
const OPEN_SUBAGENTS_KEY = 'signalbox:open-subagents';

function readSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function writeSet(key: string, values: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...values]));
  } catch {
    // convenience only
  }
}

/** A set of ids kept in localStorage, and a toggle for it. */
function useStoredSet(key: string): [Set<string>, (id: string) => void] {
  const [values, setValues] = useState(() => readSet(key));
  const toggle = (id: string) =>
    setValues((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeSet(key, next);
      return next;
    });
  return [values, toggle];
}

function count(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** What "Archive folder" will do, in the words of the confirm dialog. */
function archiveMessage(g: ProjectGroup): string {
  const threads = g.members.filter((m) => !m.subagent);
  const working = threads.filter((m) => m.status === 'running' || m.status === 'needs_approval').length;
  const what = g.path
    ? `Archives its ${count(threads.length, 'thread', 'threads')}, and any older Hermes chats there. The folder comes back as soon as something new starts in it.`
    : `Archives these ${count(threads.length, 'thread', 'threads')}.`;
  const busy = working ? ` ${count(working, 'thread is', 'threads are')} still working and will be archived too.` : '';
  return `${what}${busy} You can restore them from Settings → Archived threads.`;
}

const LANE_ICONS: Record<Source, typeof Feather> = { hermes: Feather, paseo: SquareTerminal };
const LANE_NAMES: Record<Source, string> = { hermes: 'Hermes', paseo: 'Paseo' };

export function ProjectList({
  groups,
  activeKey,
  needsYou,
  onNewIn,
}: {
  groups: ProjectGroup[];
  activeKey: string | null;
  needsYou: (c: ConversationSummary) => boolean;
  onNewIn: (path: string | null) => void;
}) {
  const [collapsed, toggleProject] = useStoredSet(COLLAPSED_KEY);
  const conversations = useStore((s) => s.conversations);
  // "Archive folder": every thread it shows (sub-agent runs go with theirs).
  const [archiving, setArchiving] = useState<ProjectGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const archiveFolder = async (g: ProjectGroup) => {
    const threads = g.members.filter((m) => !m.subagent).map((m) => ({ source: m.source, id: m.id }));
    // Also the older Hermes chats there that the inbox doesn't list, placed as this view places them.
    const folder = g.path ? { path: g.path, paseoRoots: paseoProjectRoots(Object.values(conversations)) } : undefined;
    setBusy(true);
    try {
      dropThreads(reportTidy('archived', threads, await api.archiveThreads(threads, folder)));
      setArchiving(null);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Sub-agents start folded; which chats' sub-agents are open is remembered.
  const [openSubagents, toggleSubagents] = useStoredSet(OPEN_SUBAGENTS_KEY);

  const row = (c: ConversationSummary, extra: { nested?: boolean; from?: string } = {}) => (
    <ConversationRow
      key={convKey(c.source, c.id)}
      c={c}
      compact
      active={convKey(c.source, c.id) === activeKey}
      needsYou={needsYou(c)}
      {...extra}
    />
  );

  const subagents = (owner: ConversationSummary, list: SubagentEntry[]) => {
    if (!list.length) return null;
    const key = chatKey(owner);
    const open = openSubagents.has(key);
    const working = list.filter((e) => e.conversation.status === 'running').length;
    return (
      <div className="subagents">
        <button type="button" className="subagents-toggle" aria-expanded={open} onClick={() => toggleSubagents(key)}>
          <ChevronRight size={15} className={`chev${open ? ' open' : ''}`} />
          {count(list.length, 'sub-agent', 'sub-agents')}
          {working > 0 && <span className="subagents-working"> · {working} working</span>}
        </button>
        {open && (
          <div className="subagents-list">
            {list.map((e) => row(e.conversation, { nested: true, ...(e.parentTitle ? { from: e.parentTitle } : {}) }))}
          </div>
        )}
      </div>
    );
  };

  const thread = (node: ThreadNode) => (
    <div key={chatKey(node.conversation)} className="thread">
      {row(node.conversation)}
      {subagents(node.conversation, node.subagents)}
      {node.children.length > 0 && (
        <div className="thread-children" aria-label={`Started by ${node.conversation.title}`}>
          {node.children.map((child) => (
            <Fragment key={chatKey(child.conversation)}>
              {row(child.conversation, { nested: true, ...(child.parentTitle ? { from: child.parentTitle } : {}) })}
              {subagents(child.conversation, child.subagents)}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );

  const lane = (source: Source, threads: ThreadNode[]) => {
    if (!threads.length) return null;
    const Icon = LANE_ICONS[source];
    const rows = threads.reduce((n, t) => n + 1 + t.children.length, 0);
    const subs = threads.reduce((n, t) => n + t.subagents.length + t.children.reduce((m, c) => m + c.subagents.length, 0), 0);
    return (
      <div className={`lane lane-${source}`}>
        <div className="lane-head">
          <Icon size={13} /> {LANE_NAMES[source]} <span className="lane-count">{rows}</span>
          {subs > 0 && <span className="lane-subs">· {count(subs, 'sub-agent', 'sub-agents')}</span>}
        </div>
        {threads.map(thread)}
      </div>
    );
  };

  return (
    <>
      {groups.map((g) => {
        const open = !collapsed.has(g.key);
        // Each chat counts for its own backend, whichever lane it's nested in.
        const counts = [
          g.counts.hermes ? count(g.counts.hermes, 'Hermes chat', 'Hermes chats') : '',
          g.counts.paseo ? count(g.counts.paseo, 'Paseo agent', 'Paseo agents') : '',
          g.counts.subagents ? count(g.counts.subagents, 'sub-agent', 'sub-agents') : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <section key={g.key} className="project" aria-label={g.name}>
            <div className="project-head">
              <button type="button" className="project-toggle" aria-expanded={open} onClick={() => toggleProject(g.key)}>
                <span className="project-icon">
                  <Folder size={18} />
                </span>
                <span className="grow">
                  <span className="project-name">{g.name}</span>
                  <span className="project-path">
                    {g.path ? `${homeRelative(g.path)} · ` : ''}
                    {counts}
                  </span>
                </span>
                {g.attention > 0 && <span className="pill approval">{g.attention}</span>}
                <ChevronDown size={18} className={`chev${open ? '' : ' closed'}`} />
              </button>
              {g.key !== NO_PROJECT && (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`New conversation in ${g.name}`}
                  onClick={() => onNewIn(g.path)}
                >
                  <Plus size={20} />
                </button>
              )}
              <button type="button" className="icon-btn" aria-label={`Archive ${g.name}`} onClick={() => setArchiving(g)}>
                <Archive size={18} />
              </button>
            </div>
            {open && lane('hermes', g.hermes)}
            {open && lane('paseo', g.paseo)}
          </section>
        );
      })}
      {archiving && (
        <ConfirmDialog
          title={`Archive ${archiving.name}?`}
          message={archiveMessage(archiving)}
          confirmLabel="Archive"
          busy={busy}
          onConfirm={() => archiveFolder(archiving)}
          onCancel={() => setArchiving(null)}
        />
      )}
    </>
  );
}
