import { ArrowRight, BellRing, CheckCircle2, LoaderCircle, Plus, Sparkles } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { chatsPath } from '../router';
import { PLACEHOLDER_CAPTION, dateLine, greeting, homeSummary, needsCaption, workingCaption } from '../homeText';
import { useStore } from '../store';
import { Link } from '../components/common';
import { StatusBlock } from '../components/StatusBlock';
import { TeamRowBlock } from '../components/TeamRowBlock';

/**
 * Home: the date, a greeting, one line of what's happening and four
 * tiles that open their own filtered page. On a phone the team row and the status
 * block live here too, since they left the sidebar.
 */
export function HomePage({ onNewTask, phone }: { onNewTask: () => void; phone: boolean }) {
  const conversations = useStore((s) => s.conversations);
  const approvals = useStore((s) => s.approvals);
  const list = useMemo(() => Object.values(conversations), [conversations]);
  const waiting = useMemo(() => Object.values(approvals), [approvals]);
  const running = list.filter((c) => c.status === 'running');

  return (
    <section className="page page-home" aria-label="Home">
      <header className="home-head">
        <p className="home-date">{dateLine()}</p>
        <h1>{greeting()}</h1>
        <p className="home-summary">{homeSummary({ needsYou: waiting.length, working: running.length })}</p>
        <button type="button" className="btn btn-primary home-new" onClick={onNewTask}>
          <Plus size={18} aria-hidden="true" />
          New task
        </button>
      </header>

      <div className="home-tiles">
        <HomeTile
          tone="needs"
          icon={<BellRing size={18} aria-hidden="true" />}
          label="Needs you"
          count={waiting.length}
          caption={needsCaption(waiting)}
          to={chatsPath('attention')}
        />
        <HomeTile
          tone="working"
          icon={<LoaderCircle size={18} aria-hidden="true" />}
          label="Working now"
          count={running.length}
          caption={workingCaption(running.length)}
          to={chatsPath('working')}
        />
        <HomeTile
          tone="done"
          icon={<CheckCircle2 size={18} aria-hidden="true" />}
          label="Done today"
          count={null}
          caption={PLACEHOLDER_CAPTION}
          to="/tasks"
        />
        <HomeTile
          tone="coming"
          icon={<Sparkles size={18} aria-hidden="true" />}
          label="Coming up"
          count={null}
          caption={PLACEHOLDER_CAPTION}
          to="/schedule"
        />
      </div>

      {phone && (
        <div className="home-mobile">
          <div className="home-team">
            <p className="side-label">Your team</p>
            <TeamRowBlock size={32} />
          </div>
          <StatusBlock />
        </div>
      )}

      <p className="trust-banner">
        <Sparkles size={18} aria-hidden="true" />
        <span>
          <strong>Runs on your PC by design.</strong> Chats and files are stored on this PC. Cloud agents send
          prompts and task data to their configured providers. Connectors can share data with services you connect.
        </span>
      </p>
    </section>
  );
}

/** A tile that opens its page: icon + label + arrow, a big number, one caption line. */
function HomeTile({
  tone,
  icon,
  label,
  count,
  caption,
  to,
}: {
  tone: 'needs' | 'working' | 'done' | 'coming';
  icon: ReactNode;
  label: string;
  /** null until the tile has data. */
  count: number | null;
  caption: string;
  to: string;
}) {
  return (
    <Link to={to} className={`home-tile tile-${tone}`} aria-label={`${label}: ${count ?? 'nothing yet'}. ${caption}`}>
      <span className="tile-top">
        {icon}
        <span className="tile-label">{label}</span>
        <ArrowRight size={16} aria-hidden="true" />
      </span>
      <span className="tile-count">{count === null ? '—' : count}</span>
      <span className="tile-caption">{caption}</span>
    </Link>
  );
}
