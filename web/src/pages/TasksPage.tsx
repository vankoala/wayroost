import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TaskSummary } from '../../../shared/protocol';
import { api } from '../api';
import { Link, Page } from '../components/common';
import { shortTime } from '../format';
import { chatIndex } from '../projects';
import { conversationPath } from '../router';
import { convKey, useStore } from '../store';

const roles: Record<TaskSummary['role'], string> = {
  manager: 'Manager', 'coder-lead': 'Coder', worker: 'Worker', reviewer: 'Reviewer', agent: 'Agent',
};
const states: Record<TaskSummary['status'], string> = {
  running: 'Working', 'needs-approval': 'Needs you', finished: 'Finished', failed: 'Failed', stopped: 'Stopped',
};

/** Tasks: the ledger of workers a chat started, and whether that chat heard how they ended. */
export function TasksPage() {
  const approvals = useStore((s) => s.approvals);
  const conversations = useStore((s) => s.conversations);
  const chats = chatIndex(Object.values(conversations));
  const waiting = Object.values(approvals).length;
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let live = true;
    setBusy(true);
    api.capabilities().then(async capabilities => {
      if (!live) return null;
      setAvailable(capabilities.tasks);
      if (!capabilities.tasks) { setTasks(null); setError(null); return null; }
      return api.tasks();
    }).then(
      (list) => { if (live && list) { setTasks(list.tasks); setError(null); } },
      (err: Error) => { if (live) setError(err.message); },
    ).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [refresh]);

  return (
    <Page
      className="page-tasks"
      title="Tasks"
      actions={
        <button type="button" className="icon-btn" onClick={() => setRefresh((n) => n + 1)} disabled={busy} aria-label="Refresh tasks">
          <RefreshCw size={18} />
        </button>
      }
    >
      <p className="page-lead">See what your workers are doing and whether their chats received an update.</p>
      {waiting > 0 && (
        <div className="task-row">
          <div className="grow">
            <div>{waiting} request{waiting === 1 ? '' : 's'} waiting for you</div>
            <p className="muted">Answer them in the chat they came from.</p>
          </div>
          <Link to="/chats?filter=attention" className="btn btn-secondary">
            Open
          </Link>
        </div>
      )}
      {error && <p className="error-text" role="alert">{error} Use Refresh tasks to try again.</p>}
      {!available && <p className="page-note" role="status">Tasks need the bridge, Hermes and Paseo.</p>}
      {tasks === null && busy && <p role="status">Loading tasks…</p>}
      {tasks?.length === 0 && <p className="page-note">No worker tasks yet. Tasks appear when a chat starts a worker.</p>}
      <div className="task-list">
        {tasks?.map((task) => {
          const chat = chats.get(convKey('hermes', task.chat));
          const path = conversationPath('hermes', chat?.id ?? task.chat);
          return (
            <article className="task-card" key={task.id}>
              <div className="task-heading">
                <h2>{task.title}</h2>
                <span className={task.status === 'needs-approval' ? 'error-text' : 'muted'}>{states[task.status]}</span>
              </div>
              <p className="muted">{roles[task.role]} · <time dateTime={new Date(task.updatedAt).toISOString()} title={new Date(task.updatedAt).toLocaleString()}>{shortTime(task.updatedAt)}</time></p>
              {task.overdue && <p className="error-text">Overdue · the worker has passed its time box.</p>}
              {!task.verified && <p className="error-text task-link-reason">{task.linkReason || 'Not linked: the worker’s launch has not been verified.'}</p>}
              <Link to={path}>Open launching chat{chat ? `: ${chat.title}` : ''}</Link>
              {task.relays.length > 0 && (
                <ul className="task-deliveries" aria-label="Worker updates">
                  {task.relays.map((relay) => (
                    <li key={relay.id}>
                      <span>{relay.kind === 'overdue' ? 'Overdue notice' : 'Worker update'}: </span>
                      {relay.deliveredAt !== undefined ? <span>Delivered · {shortTime(relay.deliveredAt)}</span>
                        : relay.skipped ? <span className={relay.skipped === 'not delivered' || relay.skipped === 'chat gone' ? 'error-text' : 'muted'}>
                            {relay.skipped === 'not delivered' ? 'Not delivered: repeated delivery failures. Open the launching chat to follow up.' : relay.skipped}
                          </span>
                        : relay.held ? <span className="task-held">{relay.held} The update will be checked again.</span>
                        : <span className="muted">Waiting to deliver when the chat is ready.</span>}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}
      </div>
    </Page>
  );
}
