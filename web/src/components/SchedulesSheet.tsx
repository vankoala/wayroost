import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  ScheduleDraft,
  ScheduleJob,
  ScheduleList,
  ScheduleRun,
  ScheduleSource,
  ScheduleToolLevel,
} from '../../../shared/protocol';
import { api } from '../api';
import { inTime, shortTime } from '../format';
import { conversationPath, navigate } from '../router';
import { toast, useStore } from '../store';
import { ConfirmDialog, Sheet } from './common';
import { initialTools, toolsCaution, toolsLabel, ToolsField } from './ToolsField';

// Settings → Scheduled jobs: Hermes' cron jobs. Hermes keeps and runs them; this page lists
// them live (Hermes' cron.changed event plus a slow poll), runs, pauses, edits and deletes
// them, and shows each job's recent runs. An agent run is a Hermes session: tap it to read it.

const POLL_MS = 30_000;
const STATE_LABEL: Record<ScheduleJob['state'], string> = {
  active: 'Active',
  paused: 'Paused',
  running: 'Running now',
  error: 'Last run failed',
  done: 'Finished',
};
const STATE_TONE: Record<ScheduleJob['state'], string> = { active: 'ok', paused: '', running: 'warn', error: 'bad', done: '' };
const EXAMPLES = ['every day at 8am', '0 9 * * 1-5', 'every 2h', 'every monday 9am', 'in 30m'];
const PASEO_EXAMPLES = ['0 9 * * 1-5', 'every 15m', 'every 2h'];
const SOURCE_LABEL: Record<ScheduleSource, string> = { hermes: 'Hermes', paseo: 'Paseo' };
const keyOf = (job: ScheduleJob) => `${job.source}:${job.id}`;

export function SchedulesSheet({
  onClose,
  focus,
  startNew = false,
}: {
  onClose: () => void;
  focus?: string;
  /** Open straight into the AI job builder. */
  startNew?: boolean;
}) {
  const version = useStore((s) => s.schedulesVersion);
  const [data, setData] = useState<ScheduleList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  const [open, setOpen] = useState<string | null>(focus ?? null);
  const focused = useRef(false);

  // Opened from the home page at one job: scroll it into view once the list is in.
  useEffect(() => {
    if (!focus || focused.current || !data) return;
    focused.current = true;
    requestAnimationFrame(() => document.getElementById(`job-${focus}`)?.scrollIntoView({ block: 'center' }));
  }, [focus, data]);
  const [editing, setEditing] = useState<ScheduleJob | 'new' | null>(startNew ? 'new' : null);
  const [deleting, setDeleting] = useState<ScheduleJob | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      api.schedules().then(
        (d) => {
          if (live) {
            setData(d);
            setError(null);
          }
        },
        (err) => {
          if (live) setError((err as Error).message);
        },
      );
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [loads, version]);

  const act = async (job: ScheduleJob, what: () => Promise<ScheduleList>, done?: string) => {
    setBusy(keyOf(job));
    try {
      setData(await what());
      if (done) toast(done, 'info');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const stale = data?.schedulerAgeS !== undefined && data.schedulerAgeS > 180;
  return (
    <Sheet title="Scheduled jobs" onClose={onClose}>
      <p className="muted connector-note">
        Jobs Hermes and Paseo run on a schedule. Results go where each job says; every run is also kept here.
      </p>
      {data?.unavailable?.map((u) => (
        <p key={u.source} className="muted">
          <TriangleAlert size={14} /> {SOURCE_LABEL[u.source]} jobs can't be shown right now: {u.reason}
        </p>
      ))}
      {stale && (
        <div className="group">
          <div className="kv">
            <TriangleAlert size={18} />
            <div className="grow">
              <div>Hermes' scheduler isn't ticking</div>
              <div className="muted">
                Last tick {Math.round(data!.schedulerAgeS! / 60)} min ago. Jobs won't run until the Hermes gateway is back.
              </div>
            </div>
          </div>
        </div>
      )}
      {error ? (
        <p className="error-text">{error}</p>
      ) : !data ? (
        <p className="muted">
          <LoaderCircle size={14} className="spin" /> Loading…
        </p>
      ) : (
        <>
          {data.jobs.length === 0 && <p className="muted">No scheduled jobs yet.</p>}
          {data.jobs.length > 0 && (
            <div className="group schedules">
              {data.jobs.map((job) => (
                <JobRow
                  key={keyOf(job)}
                  job={job}
                  open={open === keyOf(job)}
                  busy={busy === keyOf(job)}
                  anyBusy={busy !== null}
                  onToggle={() => setOpen(open === keyOf(job) ? null : keyOf(job))}
                  onPause={() => act(job, () => api.pauseSchedule(job.source, job.id, job.state !== 'paused'))}
                  onRun={() => act(job, () => api.runSchedule(job.source, job.id), `Running "${job.name}" now`)}
                  onEdit={() => {
                    setOpen(keyOf(job));
                    setEditing(job);
                  }}
                  editForm={
                    editing !== null && editing !== 'new' && keyOf(editing) === keyOf(job) ? (
                      <JobForm
                        job={editing}
                        targets={data.targets}
                        onCancel={() => setEditing(null)}
                        onSaved={(list) => {
                          setData(list);
                          setEditing(null);
                          toast('Saved', 'info');
                        }}
                      />
                    ) : undefined
                  }
                  onDelete={() => setDeleting(job)}
                  onOpenRun={(run) => {
                    onClose();
                    navigate(conversationPath(run.source, run.id));
                  }}
                />
              ))}
            </div>
          )}
          {editing === null && (
            <button type="button" className="btn btn-secondary trigger-add" onClick={() => setEditing('new')}>
              <Plus size={16} /> New scheduled job
            </button>
          )}
          {editing === 'new' && (
            <JobBuilder
              targets={data.targets}
              onCancel={() => setEditing(null)}
              onSaved={(list) => {
                setData(list);
                setEditing(null);
                toast('Scheduled', 'info');
              }}
            />
          )}
        </>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete "${deleting.name}"?`}
          message={`${SOURCE_LABEL[deleting.source]} stops running it. Past runs stay in your ${SOURCE_LABEL[deleting.source]} chats.`}
          confirmLabel="Delete"
          danger
          busy={busy === keyOf(deleting)}
          onCancel={() => setDeleting(null)}
          onConfirm={() =>
            void act(deleting, () => api.deleteSchedule(deleting.source, deleting.id), 'Deleted').then(() => {
              setDeleting(null);
              setLoads((n) => n + 1);
            })
          }
        />
      )}
    </Sheet>
  );
}

function JobRow({
  job,
  open,
  busy,
  anyBusy,
  onToggle,
  onPause,
  onRun,
  onEdit,
  onDelete,
  onOpenRun,
  editForm,
}: {
  job: ScheduleJob;
  open: boolean;
  busy: boolean;
  anyBusy: boolean;
  onToggle: () => void;
  onPause: () => void;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenRun: (run: NonNullable<ScheduleRun['open']>) => void;
  /** The edit form, shown in place of the details while this job is being edited. */
  editForm?: ReactNode;
}) {
  const Icon = job.trigger ? Zap : CalendarClock;
  const when =
    job.state === 'running'
      ? 'running now'
      : job.state === 'paused'
        ? 'paused'
        : job.nextRunAt
          ? `next ${inTime(job.nextRunAt)}`
          : job.state === 'done'
            ? 'finished'
            : 'not scheduled';
  return (
    <div className={`schedule-job${open ? ' open' : ''}`} id={`job-${job.source}:${job.id}`}>
      <div className="kv">
        <Icon size={18} />
        <button type="button" className="grow schedule-head" onClick={onToggle} aria-expanded={open}>
          <div>
            {job.title} <span className={`source-badge ${job.source}`}>{SOURCE_LABEL[job.source]}</span>{' '}
            {job.tools?.full && <span className="source-badge tools-full">Full access</span>}{' '}
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </div>
          <div className="muted">
            {job.schedule} · {when}
            {job.lastRunAt ? ` · last ${shortTime(job.lastRunAt)}` : ''}
          </div>
          {job.state === 'error' && job.lastError && (
            <div className="error-text">
              <CircleAlert size={12} /> {job.lastError}
              {job.failureStreak > 1 ? ` (${job.failureStreak} in a row)` : ''}
            </div>
          )}
        </button>
        {busy ? (
          <LoaderCircle size={16} className="spin" />
        ) : (
          <span className={`dot ${STATE_TONE[job.state]}`} aria-label={STATE_LABEL[job.state]} />
        )}
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={job.state !== 'paused' && job.state !== 'done'}
          aria-label={`${job.name} on`}
          onClick={onPause}
          disabled={anyBusy || job.state === 'done' || job.state === 'running'}
        />
      </div>
      {open && editForm && <div className="schedule-detail editing">{editForm}</div>}
      {open && !editForm && (
        <div className="schedule-detail">
          {job.idea ? (
            <p className="schedule-idea">{job.idea}</p>
          ) : (
            job.prompt && <p className="schedule-idea muted">Writing a one-line summary…</p>
          )}
          <dl className="schedule-facts">
            <dt>Status</dt>
            <dd>{STATE_LABEL[job.state]}</dd>
            <dt>When</dt>
            <dd>
              {job.schedule}
              {job.nextRunAt && job.state !== 'paused' ? ` · next ${inTime(job.nextRunAt)}` : ''}
            </dd>
            {job.createdAt && (
              <>
                <dt>Created</dt>
                <dd>{new Date(job.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</dd>
              </>
            )}
            {job.title !== job.name && (
              <>
                <dt>Name in {SOURCE_LABEL[job.source]}</dt>
                <dd>
                  <code>{job.name}</code>
                </dd>
              </>
            )}
            {job.target && (
              <>
                <dt>Runs in</dt>
                <dd>{job.target}</dd>
              </>
            )}
            <dt>Sends results to</dt>
            <dd>{job.deliverLabel}</dd>
            <dt>Runs so far</dt>
            <dd>{job.runs}</dd>
            {job.skills.length > 0 && (
              <>
                <dt>Skills</dt>
                <dd>{job.skills.join(', ')}</dd>
              </>
            )}
            {job.tools && (
              <>
                <dt>Can use</dt>
                <dd className={toolsCaution(job.tools) ? 'tools-full-text' : undefined}>
                  {toolsCaution(job.tools) && <TriangleAlert size={12} />} {toolsLabel(job.tools)}
                </dd>
              </>
            )}
          </dl>
          {job.prompt && (
            <details className="schedule-instructions">
              <summary>Instructions</summary>
              <p className="schedule-prompt">{job.prompt}</p>
            </details>
          )}
          {job.trigger && <p className="muted">A mail trigger: edit it under Connectors.</p>}
          <div className="confirm-actions schedule-actions">
            <button type="button" className="btn btn-secondary" onClick={onRun} disabled={anyBusy || job.state === 'running'}>
              <Play size={16} /> Run now
            </button>
            {!job.trigger && (
              <>
                <button type="button" className="btn btn-secondary" onClick={onEdit} disabled={anyBusy}>
                  <Pencil size={16} /> Edit
                </button>
                <button type="button" className="btn btn-secondary danger" onClick={onDelete} disabled={anyBusy}>
                  <Trash2 size={16} /> Delete
                </button>
              </>
            )}
          </div>
          <Runs job={job} onOpen={onOpenRun} />
        </div>
      )}
    </div>
  );
}

function Runs({ job, onOpen }: { job: ScheduleJob; onOpen: (run: NonNullable<ScheduleRun['open']>) => void }) {
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.scheduleRuns(job.source, job.id).then(
      (d) => live && setRuns(d.runs),
      (err) => live && setError((err as Error).message),
    );
    return () => {
      live = false;
    };
  }, [job.source, job.id, job.lastRunAt, job.state]);

  return (
    <div className="schedule-runs">
      <div className="group-title">Recent runs</div>
      {error ? (
        <p className="error-text">{error}</p>
      ) : !runs ? (
        <p className="muted">
          <LoaderCircle size={14} className="spin" /> Loading…
        </p>
      ) : runs.length === 0 ? (
        <p className="muted">No runs yet.</p>
      ) : (
        <ul className="run-list">
          {runs.map((r) => {
            const when = r.startedAt ? new Date(r.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Run';
            const took = r.startedAt && r.endedAt ? Math.max(1, Math.round((r.endedAt - r.startedAt) / 1000)) : null;
            const body = (
              <>
                <div>
                  {when}
                  {r.running ? ' · running' : took !== null ? ` · ${took < 120 ? `${took}s` : `${Math.round(took / 60)} min`}` : ''}
                  {r.status === 'failed' ? ' · failed' : ''}
                </div>
                {r.error ? (
                  <div className="error-text run-preview">{r.error}</div>
                ) : (
                  (r.preview || r.title) && <div className="muted run-preview">{r.preview || r.title}</div>
                )}
              </>
            );
            return (
              <li key={r.id}>
                {r.open ? (
                  <button type="button" className="run-item" onClick={() => onOpen(r.open!)}>
                    <MessageSquare size={14} />
                    <div className="grow">{body}</div>
                    <ChevronRight size={14} />
                  </button>
                ) : (
                  <div className="run-item">
                    <div className="grow">{body}</div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function JobForm({
  job,
  draft,
  targets,
  onCancel,
  onRedraft,
  onSaved,
}: {
  job: ScheduleJob | null;
  /** The AI builder's suggestion to review (new jobs only). */
  draft?: ScheduleDraft;
  targets: ScheduleList['targets'];
  onCancel: () => void;
  onRedraft?: () => void;
  onSaved: (list: ScheduleList, created: boolean) => void;
}) {
  const [name, setName] = useState(job?.name ?? draft?.name ?? '');
  const [prompt, setPrompt] = useState(job?.prompt ?? draft?.prompt ?? '');
  const [schedule, setSchedule] = useState(job?.scheduleInput ?? draft?.schedule ?? '');
  const [deliver, setDeliver] = useState(
    job?.deliver ?? draft?.deliver ?? targets.find((t) => t.id !== 'local')?.id ?? 'local',
  );
  const [skills, setSkills] = useState<string[]>(draft?.skills.map((k) => k.name) ?? []);
  // What it can use: a job's own level (or "keep" for one the levels don't cover); new jobs
  // start at the builder's pick, else Nothing. Saved only when changed.
  const startTools = initialTools(job?.tools, draft?.tools ?? 'none');
  const [tools, setTools] = useState<ScheduleToolLevel | 'keep'>(startTools);
  const formRef = useRef<HTMLFormElement>(null);

  // On a phone the form can open below the fold: bring it into view.
  useEffect(() => {
    formRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input = { name: name.trim(), prompt: prompt.trim(), schedule: schedule.trim(), deliver };
      if (job) {
        const changes: Parameters<typeof api.updateSchedule>[2] = Object.fromEntries(
          Object.entries(input).filter(([k, v]) => v !== { name: job.name, prompt: job.prompt ?? '', schedule: job.scheduleInput, deliver: job.deliver }[k]),
        );
        if (showTools && tools !== 'keep' && tools !== startTools) changes.tools = tools;
        onSaved(Object.keys(changes).length ? await api.updateSchedule(job.source, job.id, changes) : await api.schedules(), false);
      } else {
        onSaved(
          await api.createSchedule({
            ...input,
            tools: tools === 'keep' ? 'none' : tools,
            ...(skills.length ? { skills } : {}),
            ...(draft?.idea ? { idea: draft.idea } : {}),
          }),
          true,
        );
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ready = name.trim() && prompt.trim().length >= 3 && schedule.trim().length >= 2;
  const paseo = job?.source === 'paseo';
  const showTools = !paseo && (job ? Boolean(job.tools) : true);   // script-only jobs have no agent
  const examples = paseo ? PASEO_EXAMPLES : EXAMPLES;
  const deliverOptions = targets.some((t) => t.id === deliver)
    ? targets
    : [...targets, { id: deliver, label: job && deliver === job.deliver ? job.deliverLabel : deliver }];
  return (
    <form ref={formRef} className="group form-group trigger-form schedule-form" onSubmit={submit}>
      {draft && (
        <div className="schedule-draft-head">
          <Sparkles size={16} />
          <span className="grow">
            <strong>Drafted for you</strong> — check it over, change anything, then schedule it.
            {draft.idea && <span className="muted schedule-draft-idea">{draft.idea}</span>}
          </span>
        </div>
      )}
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning briefing" maxLength={80} />
      </label>
      <label className="field">
        <span>Hermes should</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          maxLength={4000}
          placeholder="Check my calendar and the weather and send me a two-line summary of the day."
        />
      </label>
      <label className="field">
        <span>When</span>
        <input
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
          placeholder="every day at 8am"
          maxLength={100}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <small>
          {paseo ? 'A cron line, or every N minutes / hours.' : 'Plain words or a cron line.'} Try:{' '}
          {examples.map((ex, i) => (
            <span key={ex}>
              {i > 0 && ', '}
              <button type="button" className="link-btn" onClick={() => setSchedule(ex)}>
                {ex}
              </button>
            </span>
          ))}
        </small>
      </label>
      {!paseo && (
        <label className="field">
          <span>Send results to</span>
          <select value={deliver} onChange={(e) => setDeliver(e.target.value)}>
            {deliverOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {showTools && (
        <ToolsField
          name={`tools-${job ? `${job.source}-${job.id}` : 'new'}`}
          value={tools}
          onChange={setTools}
          {...(job?.tools ? { current: job.tools } : {})}
          {...(draft?.toolsWhy && tools === draft.tools ? { suggestion: draft.toolsWhy } : {})}
        />
      )}
      {draft && draft.skills.length > 0 && (
        <fieldset className="schedule-skills">
          <legend>Suggested skills — Hermes loads these on each run</legend>
          {draft.skills.map((k) => (
            <label key={k.name} className="schedule-skill">
              <input
                type="checkbox"
                checked={skills.includes(k.name)}
                onChange={(e) =>
                  setSkills((cur) => (e.target.checked ? [...cur, k.name] : cur.filter((n) => n !== k.name)))
                }
              />
              <span>
                <code>{k.name}</code>
                {k.why && <span className="muted"> — {k.why}</span>}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {draft?.notes && <p className="muted schedule-draft-notes">Check: {draft.notes}</p>}
      {error && <p className="error-text">{error}</p>}
      <div className="confirm-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {onRedraft && (
          <button type="button" className="btn btn-secondary" onClick={onRedraft} disabled={busy}>
            Describe again
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy || !ready}>
          {busy && <LoaderCircle size={16} className="spin" />}
          {job ? 'Save' : 'Schedule it'}
        </button>
      </div>
    </form>
  );
}

/**
 * New job: describe it in plain words, let the local model draft it (name, instructions,
 * schedule, where results go, and Hermes skills that would help, each with why), then review,
 * tick the skills to keep, and create it. "Fill it in yourself" skips the AI.
 */
function JobBuilder({
  targets,
  onCancel,
  onSaved,
}: {
  targets: ScheduleList['targets'];
  onCancel: () => void;
  onSaved: (list: ScheduleList) => void;
}) {
  const [goal, setGoal] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [manual, setManual] = useState(false);
  const builderRef = useRef<HTMLFormElement>(null);

  // The builder sits below the job list: bring it into view (on a phone it's off screen).
  useEffect(() => {
    builderRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);

  const makeDraft = async (e?: FormEvent) => {
    e?.preventDefault();
    setDrafting(true);
    setError(null);
    try {
      setDraft(await api.draftSchedule(goal.trim()));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDrafting(false);
    }
  };

  if (draft || manual) {
    return (
      <JobForm
        job={null}
        draft={draft ?? undefined}
        targets={targets}
        onCancel={onCancel}
        onRedraft={draft ? () => setDraft(null) : undefined}
        onSaved={(list) => onSaved(list)}
      />
    );
  }
  return (
    <form ref={builderRef} className="group form-group trigger-form schedule-builder" onSubmit={makeDraft}>
      <label className="field">
        <span>What should Hermes do, and when?</span>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={4}
          maxLength={2000}
          placeholder="Every weekday at 7am, check my train line and message me on WhatsApp only if it's delayed."
        />
        <small>The assistant drafts the job and suggests skills; you review everything before it's created.</small>
      </label>
      {error && <p className="error-text">{error}</p>}
      <div className="confirm-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={drafting}>
          Cancel
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => setManual(true)} disabled={drafting}>
          Fill it in yourself
        </button>
        <button type="submit" className="btn btn-primary" disabled={drafting || goal.trim().length < 8}>
          {drafting ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}
          Draft it
        </button>
      </div>
    </form>
  );
}
