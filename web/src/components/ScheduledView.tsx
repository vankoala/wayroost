import { CalendarClock, ChevronDown, ChevronRight, LoaderCircle, MessageSquare, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ScheduleJob, ScheduleOverview, ScheduleResult } from '../../../shared/protocol';
import { inTime, shortTime } from '../format';
import { conversationPath, navigate } from '../router';
import { useScheduleList } from '../scheduleData';

// The home page's Scheduled tab: what Hermes and Paseo run on a schedule. Sections fold
// (remembered on this device): running now, failed recently, next up, recent results, and
// every job. A job opens its details and actions; a result opens the run as a chat.

const OPEN_KEY = 'signalbox.scheduled.open';
type Section = 'running' | 'failed' | 'next' | 'recent' | 'all';

function readOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

function matches(query: string, ...texts: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  return !q || texts.some((t) => t?.toLowerCase().includes(q));
}

export function ScheduledView({
  overview,
  query,
  onOpenJob,
  onNewJob,
}: {
  overview: ScheduleOverview | null;
  query: string;
  onOpenJob: (job?: { source: string; id: string }) => void;
  onNewJob: () => void;
}) {
  const list = useScheduleList(true);
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen);
  const isOpen = (key: Section, fallback: boolean) => open[key] ?? fallback;
  const toggle = (key: Section, fallback: boolean) =>
    setOpen((prev) => {
      const next = { ...prev, [key]: !(prev[key] ?? fallback) };
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        // private mode: just not remembered
      }
      return next;
    });

  if (!overview) {
    return (
      <div className="scheduled-view">
        <p className="muted scheduled-note">
          <LoaderCircle size={14} className="spin" /> Loading scheduled jobs…
        </p>
      </div>
    );
  }

  const jobFilter = (j: ScheduleJob) => matches(query, j.title, j.name, j.idea, j.schedule);
  const running = overview.running.filter(jobFilter);
  const failed = overview.failed.filter(jobFilter);
  const next = overview.next.filter(jobFilter);
  const recent = overview.recent.filter((r) => matches(query, r.title, r.run.preview, r.run.title));
  const all = (list?.jobs ?? []).filter(jobFilter);

  const section = (key: Section, title: string, count: number, body: ReactNode, fallback = true) =>
    count > 0 && (
      <div className={`scheduled-section ${key}`} key={key}>
        <button
          type="button"
          className="scheduled-section-head"
          aria-expanded={isOpen(key, fallback)}
          onClick={() => toggle(key, fallback)}
        >
          {isOpen(key, fallback) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="grow">{title}</span>
          <span className="count">{count}</span>
        </button>
        {isOpen(key, fallback) && <ul className="scheduled-list">{body}</ul>}
      </div>
    );

  const jobItem = (job: ScheduleJob, detail: ReactNode) => (
    <li key={`${job.source}:${job.id}`}>
      <button type="button" className="scheduled-item" onClick={() => onOpenJob(job)}>
        <span className="grow">
          <span className="scheduled-title">{job.title}</span>
          <span className="muted"> · {detail}</span>
          {job.idea && <span className="muted scheduled-idea">{job.idea}</span>}
        </span>
        <ChevronRight size={14} />
      </button>
    </li>
  );

  const resultItem = (r: ScheduleResult) => {
    const when = r.run.endedAt ?? r.run.startedAt;
    const failedRun = r.run.status === 'failed';
    const inner = (
      <span className="grow">
        <span className="scheduled-title">{r.title}</span>
        <span className="muted"> · {when ? shortTime(when) : ''}</span>
        {failedRun && <span className="error-text scheduled-idea">{r.run.error ?? 'Failed'}</span>}
        {!failedRun && (r.run.preview || r.run.title) && (
          <span className="muted scheduled-idea">{r.run.preview || r.run.title}</span>
        )}
      </span>
    );
    return (
      <li key={`${r.source}:${r.jobId}:${r.run.id}`}>
        {r.run.open ? (
          <button
            type="button"
            className="scheduled-item"
            onClick={() => navigate(conversationPath(r.run.open!.source, r.run.open!.id))}
          >
            <MessageSquare size={14} />
            {inner}
            <ChevronRight size={14} />
          </button>
        ) : (
          <div className="scheduled-item">{inner}</div>
        )}
      </li>
    );
  };

  const when = (j: ScheduleJob) =>
    j.state === 'paused' ? 'paused' : j.state === 'done' ? 'finished' : j.nextRunAt ? inTime(j.nextRunAt) : j.schedule;
  const nothing = !running.length && !failed.length && !next.length && !recent.length && !all.length;

  return (
    <div className="scheduled-view">
      <div className="scheduled-view-head">
        <CalendarClock size={18} />
        <span className="grow muted">
          {overview.total} scheduled job{overview.total === 1 ? '' : 's'}
        </span>
        <button type="button" className="btn btn-secondary" onClick={onNewJob}>
          <Plus size={16} /> New job
        </button>
      </div>
      {section('running', 'Running now', running.length, running.map((j) => jobItem(j, 'started just now')))}
      {section(
        'failed',
        'Failed recently',
        failed.length,
        failed.map((j) => jobItem(j, `${j.lastRunAt ? shortTime(j.lastRunAt) : 'last run'}${j.lastError ? `: ${j.lastError}` : ''}`)),
      )}
      {section('next', 'Next up', next.length, next.map((j) => jobItem(j, inTime(j.nextRunAt!))))}
      {section('recent', 'Recent results', recent.length, recent.map(resultItem))}
      {section('all', 'All jobs', all.length, all.map((j) => jobItem(j, when(j))), false)}
      {nothing && <p className="muted scheduled-note">{query ? 'No jobs match.' : 'No scheduled jobs yet.'}</p>}
      {overview.unavailable?.map((u) => (
        <p key={u.source} className="muted scheduled-note">
          {u.source === 'paseo' ? 'Paseo' : 'Hermes'} jobs unavailable: {u.reason}
        </p>
      ))}
    </div>
  );
}
