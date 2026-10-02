import { useScheduleOverview } from '../scheduleData';
import { ScheduledView } from './ScheduledView';
import { CalendarClock, FolderTree, KeyRound, List, Plus, Search, Settings, ShieldAlert, Sparkles, WifiOff } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { ConversationSummary } from '../../../shared/protocol';
import { oneLine } from '../format';
import { chatIndex, groupByProject, parentOf } from '../projects';
import { conversationPath, navigate } from '../router';
import { convKey, useStore } from '../store';
import { ConversationRow } from './ConversationRow';
import { newCount, sortCards } from '../feed';
import { Logo, SOURCE_NAMES, SourceAvatar, statusLabel, statusTone, useEnabledSources } from './common';
import { ProjectList } from './ProjectList';

type Filter = 'all' | 'attention' | 'hermes' | 'paseo';
type View = 'recent' | 'projects' | 'scheduled';

const VIEW_KEY = 'signalbox:inbox-view';

function readView(): View {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    return saved === 'projects' || saved === 'scheduled' ? saved : 'recent';
  } catch {
    return 'recent';
  }
}

export function Inbox({
  activeKey,
  offline,
  onNew,
  onSettings,
  onForYou,
  onSchedules,
  onNewSchedule,
}: {
  activeKey: string | null;
  offline: boolean;
  onNew: (cwd?: string) => void;
  onSettings: () => void;
  /** Open For you (Hermes' pulse cards). */
  onForYou: () => void;
  /** Open Scheduled jobs, optionally at one job. */
  onSchedules: (job?: { source: string; id: string }) => void;
  /** Start the AI job builder. */
  onNewSchedule: () => void;
}) {
  const scheduleOverview = useScheduleOverview();
  const failedJobs = scheduleOverview?.failed.length ?? 0;
  const runningJobs = scheduleOverview?.running.length ?? 0;
  const conversations = useStore((s) => s.conversations);
  const approvals = useStore((s) => s.approvals);
  const statuses = useStore((s) => s.statuses);
  const listLoaded = useStore((s) => s.listLoaded);
  const feed = useStore((s) => s.feed);
  const fresh = newCount(feed);
  const firstFresh = useMemo(() => sortCards(Object.values(feed ?? {})).find((c) => c.status === 'new'), [feed]);
  const enabled = useEnabledSources();
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setViewState] = useState<View>(readView);
  const [query, setQuery] = useState('');

  const setView = (next: View) => {
    setViewState(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // convenience only
    }
  };

  const waiting = useMemo(
    () => Object.values(approvals).sort((a, b) => a.createdAt - b.createdAt),
    [approvals],
  );
  const waitingKeys = useMemo(() => new Set(waiting.map((a) => convKey(a.source, a.conversationId))), [waiting]);
  const needsYou = useCallback(
    (c: ConversationSummary) => waitingKeys.has(convKey(c.source, c.id)) || c.status === 'needs_approval',
    [waitingKeys],
  );

  const all = useMemo(() => Object.values(conversations), [conversations]);
  // Every chat by any id it's known by, to find what started each one.
  const index = useMemo(() => chatIndex(all), [all]);

  const filtered = useMemo(() => {
    let items = all;
    if (filter === 'hermes' || filter === 'paseo') items = items.filter((c) => c.source === filter);
    if (filter === 'attention') items = items.filter((c) => needsYou(c) || c.status === 'error');
    const q = query.trim().toLowerCase();
    if (q) {
      items = items.filter((c) =>
        `${c.title} ${c.subtitle ?? ''} ${c.preview ?? ''} ${c.project?.name ?? ''}`.toLowerCase().includes(q),
      );
    }
    return items;
  }, [all, needsYou, filter, query]);

  const recent = useMemo(() => {
    const rank = (c: ConversationSummary) => (needsYou(c) ? 0 : c.status === 'running' ? 1 : 2);
    // Sub-agents show here while they work; a search finds the rest.
    const shown = query.trim() ? filtered : filtered.filter((c) => !c.subagent || c.status === 'running');
    return [...shown].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
  }, [filtered, needsYou, query]);

  const groups = useMemo(() => groupByProject(filtered, needsYou), [filtered, needsYou]);

  const attentionCount = useMemo(() => all.filter(needsYou).length, [all, needsYou]);

  const chips: Array<{ id: Filter; label: string; count?: number }> = [
    { id: 'all', label: 'All' },
    { id: 'attention', label: 'Needs you', count: attentionCount },
    // Source filters only make sense when both are running.
    ...(enabled.length > 1 ? enabled.map((s) => ({ id: s as Filter, label: SOURCE_NAMES[s] })) : []),
  ];

  const openFirstWaiting = () => {
    const first = waiting[0];
    if (first) navigate(conversationPath(first.source, first.conversationId));
  };

  return (
    <section className="pane pane-list" aria-label="Conversations">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <span>Signalbox</span>
        </div>
        <button type="button" className="status-dots" onClick={onSettings} aria-label="Connection status">
          {enabled.map((s) => (
            <span
              key={s}
              className={`dot ${statusTone(statuses[s].state)}`}
              title={`${SOURCE_NAMES[s]}: ${statusLabel(statuses[s].state)}`}
            />
          ))}
        </button>
        <button type="button" className="icon-btn desktop-only" onClick={() => onNew()} aria-label="New conversation">
          <Plus size={22} />
        </button>
        {feed !== null && (
          <button
            type="button"
            className="icon-btn foryou-btn"
            onClick={onForYou}
            aria-label={fresh ? `For you, ${fresh} new` : 'For you'}
            title="For you"
          >
            <Sparkles size={20} />
            {fresh > 0 && <span className="badge">{fresh > 9 ? '9+' : fresh}</span>}
          </button>
        )}
        <button type="button" className="icon-btn" onClick={onSettings} aria-label="Settings">
          <Settings size={20} />
        </button>
      </header>

      {offline && (
        <div className="banner">
          <WifiOff size={14} /> Reconnecting…
        </div>
      )}

      <div className="inbox-tools">
        <div className="view-toggle view-tabs" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'recent'}
            aria-pressed={view === 'recent'}
            onClick={() => setView('recent')}
            title="Most recent first"
          >
            <List size={16} /> Recent
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'projects'}
            aria-pressed={view === 'projects'}
            onClick={() => setView('projects')}
            title="Grouped by project folder"
          >
            <FolderTree size={16} /> Projects
          </button>
          {scheduleOverview && scheduleOverview.total > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={view === 'scheduled'}
              aria-pressed={view === 'scheduled'}
              onClick={() => setView('scheduled')}
              title="What Hermes and Paseo run on a schedule"
              aria-label={failedJobs ? `Scheduled, ${failedJobs} failed` : 'Scheduled'}
            >
              <CalendarClock size={16} /> Scheduled
              {failedJobs > 0 ? (
                <span className="tab-badge failed">{failedJobs}</span>
              ) : runningJobs > 0 ? (
                <span className="tab-badge running" aria-hidden="true" />
              ) : null}
            </button>
          )}
        </div>
        <label className="search">
          <Search size={17} aria-hidden="true" />
          <input
            type="search"
            placeholder={view === 'scheduled' ? 'Search scheduled jobs' : 'Search'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={view === 'scheduled' ? 'Search scheduled jobs' : 'Search conversations'}
          />
        </label>
        {view !== 'scheduled' && (
          <div className="chips" role="toolbar" aria-label="Filter">
            {chips.map((chip) => (
              <button
                key={chip.id}
                type="button"
                className="chip"
                aria-pressed={filter === chip.id}
                onClick={() => setFilter(chip.id)}
              >
                {chip.label}
                {chip.count ? <span className="count">{chip.count}</span> : null}
              </button>
            ))}
          </div>
        )}
      </div>

      {waiting.length > 0 && filter !== 'attention' && (
        <button type="button" className="attention" onClick={openFirstWaiting}>
          <ShieldAlert size={20} />
          <span className="grow">
            <strong>{waiting.length === 1 ? '1 request needs you' : `${waiting.length} requests need you`}</strong>
            <br />
            <span className="muted">{oneLine(waiting[0]!.title, 60)}</span>
          </span>
        </button>
      )}

      {firstFresh && filter !== 'attention' && (
        <button type="button" className="attention foryou-strip" onClick={onForYou}>
          <Sparkles size={20} />
          <span className="grow">
            <strong>{fresh === 1 ? '1 new thing for you' : `${fresh} new things for you`}</strong>
            <br />
            <span className="muted">{oneLine(firstFresh.title, 60)}</span>
          </span>
        </button>
      )}

      {statuses.hermes.state === 'needs_credentials' && (
        <div className="connect-card">
          <SourceAvatar source="hermes" />
          <div className="grow">
            <strong>Connect Hermes</strong>
            <p>Sign in with your dashboard username and password.</p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={onSettings}>
            <KeyRound size={16} /> Sign in
          </button>
        </div>
      )}

      {view === 'scheduled' && (
        <div className="list">
          <ScheduledView overview={scheduleOverview} query={query} onOpenJob={onSchedules} onNewJob={onNewSchedule} />
        </div>
      )}
      <div className={`list${view === 'scheduled' ? ' hidden' : ''}`}>
        {!listLoaded && [0, 1, 2, 3].map((i) => <div key={i} className="skeleton" />)}
        {listLoaded && filtered.length === 0 && (
          <div className="empty">
            <div>
              <h2>{query || filter !== 'all' ? 'Nothing matches' : 'No conversations yet'}</h2>
              <p>
                {query || filter !== 'all'
                  ? 'Try a different search or filter.'
                  : 'Start a chat with Hermes or launch a Paseo agent.'}
              </p>
            </div>
          </div>
        )}
        {view === 'recent' &&
          recent.map((c) => {
            const parentTitle = parentOf(c, index)?.title;
            return (
              <ConversationRow
                key={convKey(c.source, c.id)}
                c={c}
                active={convKey(c.source, c.id) === activeKey}
                needsYou={needsYou(c)}
                {...(parentTitle ? { from: parentTitle } : {})}
              />
            );
          })}
        {view === 'projects' && (
          <ProjectList
            groups={groups}
            activeKey={activeKey}
            needsYou={needsYou}
            onNewIn={(path) => onNew(path ?? undefined)}
          />
        )}
      </div>

      <button
        type="button"
        className="fab mobile-only"
        onClick={() => (view === 'scheduled' ? onNewSchedule() : onNew())}
        aria-label={view === 'scheduled' ? 'New scheduled job' : 'New conversation'}
      >
        <Plus size={22} strokeWidth={2.4} /> New
      </button>
    </section>
  );
}
