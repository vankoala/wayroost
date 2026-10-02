import { ExternalLink, LoaderCircle, Mail, Plus, RefreshCw, Trash2, TriangleAlert, Zap } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  TRIGGER_INTERVALS,
  type Connector,
  type ConnectorAccess,
  type ConnectorGroup,
  type ConnectorList,
  type ScheduleToolLevel,
  type Trigger,
  type TriggerList,
} from '../../../shared/protocol';
import { api } from '../api';
import { toast } from '../store';
import { ConfirmDialog, Sheet, useFocusTrap } from './common';
import { toolsCaution, toolsLabel, ToolsField } from './ToolsField';

const GROUPS: { id: ConnectorGroup; title: string; note?: string }[] = [
  { id: 'google', title: 'Google' },
  { id: 'everyday', title: 'Everyday apps' },
  { id: 'building', title: 'For building' },
  { id: 'elsewhere', title: 'Set up elsewhere', note: "Already working through other routes; shown so you can see they're OK." },
];

const STATE_LABEL: Record<Connector['state'], string> = {
  connected: 'Connected',
  off: 'Off',
  'needs-sign-in': 'Needs attention',
  'not-connected': 'Not connected',
  unknown: 'Unknown',
};

const ACCESS_LABEL: Record<ConnectorAccess, string> = {
  ask: 'Ask before changes',
  auto: 'Automatic',
};

const POLL_MS = 2000;
const POLL_LIMIT_MS = 10 * 60_000;

function tone(state: Connector['state']): string {
  return state === 'connected' ? 'ok' : state === 'needs-sign-in' ? 'warn' : '';
}

/** A stable colour for the letter tile, from the id (no inline styles: the CSP forbids them). */
function hue(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 8;
  return `hue-${h}`;
}

type Dialog =
  | { kind: 'connect'; connector: Connector }
  | { kind: 'google'; connector: Connector }
  | { kind: 'disconnect'; connector: Connector };

/** Settings → Connectors: the services Hermes can use for you, and mail triggers. */
export function ConnectorsSheet({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<ConnectorList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    api.connectors().then(
      (l) => {
        if (live) setList(l);
      },
      (err) => {
        if (live) setError((err as Error).message);
      },
    );
    return () => {
      live = false;
    };
  }, [loads]);

  const reload = () => setLoads((n) => n + 1);

  const act = async (connector: Connector, work: () => Promise<unknown>, done?: string) => {
    setBusy(connector.id);
    try {
      await work();
      if (done) toast(done, 'info');
      reload();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const google = list?.connectors.find((c) => c.id === 'google');

  return (
    <Sheet title="Connectors" onClose={onClose} wide>
      <p className="muted connectors-intro">
        Let Hermes use your apps. You sign in on each service's own page; the keys stay with Hermes on your PC, never
        in Signalbox or on your phone.
      </p>
      {error ? (
        <p className="error-text">{error}</p>
      ) : !list ? (
        <p className="muted archived-empty">
          <LoaderCircle size={16} className="spin" /> Checking your connectors…
        </p>
      ) : (
        <>
          {!list.hermes && <p className="connect-caution">Sign in to Hermes in Settings to connect apps.</p>}
          {GROUPS.map((group) => {
            const items = list.connectors.filter((c) => c.group === group.id);
            if (!items.length) return null;
            return (
              <section key={group.id} className="connector-section">
                <div className="group-title">{group.title}</div>
                {group.note && <p className="muted connector-note">{group.note}</p>}
                <div className="connector-grid">
                  {items.map((c) => (
                    <ConnectorCard
                      key={c.id}
                      connector={c}
                      busy={busy === c.id}
                      canAct={c.kind === 'google' ? list.helper : list.hermes}
                      onConnect={() => setDialog({ kind: c.kind === 'google' ? 'google' : 'connect', connector: c })}
                      onDisconnect={() => setDialog({ kind: 'disconnect', connector: c })}
                      onAccess={(access) =>
                        act(c, () => api.setConnectorAccess(c.id, access), `${c.name}: ${ACCESS_LABEL[access].toLowerCase()}`)
                      }
                      onCheck={() => act(c, () => api.checkConnector(c.id))}
                    />
                  ))}
                </div>
              </section>
            );
          })}
          <TriggersSection googleConnected={google?.state === 'connected'} />
          <p className="muted connectors-foot">
            Chats you start after a change see it right away. WhatsApp and scheduled jobs pick up a new connector the
            next time Hermes' gateway restarts.
          </p>
        </>
      )}

      {dialog?.kind === 'connect' && (
        <ConnectDialog
          connector={dialog.connector}
          onClose={() => setDialog(null)}
          onConnected={() => {
            setDialog(null);
            toast(`${dialog.connector.name} connected`, 'info');
            reload();
          }}
        />
      )}
      {dialog?.kind === 'google' && (
        <GoogleDialog
          connector={dialog.connector}
          onClose={() => setDialog(null)}
          onConnected={() => {
            setDialog(null);
            toast('Google connected', 'info');
            reload();
          }}
        />
      )}
      {dialog?.kind === 'disconnect' && (
        <ConfirmDialog
          title={`Disconnect ${dialog.connector.name}?`}
          message={
            dialog.connector.kind === 'google'
              ? 'Hermes signs out of Google and cancels the sign-in with Google. Mail triggers stop working until you connect again.'
              : `Hermes stops using ${dialog.connector.name}. To fully remove its access, also remove the app in ${dialog.connector.name}'s own settings.`
          }
          confirmLabel="Disconnect"
          danger
          busy={busy === dialog.connector.id}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const c = dialog.connector;
            void act(
              c,
              () => (c.kind === 'google' ? api.googleDisconnect() : api.disconnectConnector(c.id)),
              `${c.name} disconnected`,
            ).then(() => setDialog(null));
          }}
        />
      )}
    </Sheet>
  );
}

function ConnectorCard({
  connector: c,
  busy,
  canAct,
  onConnect,
  onDisconnect,
  onAccess,
  onCheck,
}: {
  connector: Connector;
  busy: boolean;
  canAct: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onAccess: (access: ConnectorAccess) => void;
  onCheck: () => void;
}) {
  const setUp = c.state === 'connected' || c.state === 'needs-sign-in' || c.state === 'off';
  const signIn = c.kind === 'sign-in';
  const actionable = c.kind !== 'status' && canAct;
  return (
    <div className={`connector-card state-${c.state}`}>
      <div className="connector-head">
        <span className={`connector-logo ${hue(c.id)}`} aria-hidden="true">
          {c.name.slice(0, 1)}
        </span>
        <div className="grow">
          <div className="connector-name">{c.name}</div>
          <div className="muted connector-blurb">{c.blurb}</div>
        </div>
      </div>
      <div className="connector-status">
        <span className={`dot ${tone(c.state)}`} aria-hidden="true" />
        <span>
          {STATE_LABEL[c.state]}
          {c.detail ? <span className="muted"> · {c.detail}</span> : null}
        </span>
      </div>
      {actionable && (
        <div className="connector-actions">
          {!setUp && (
            <button type="button" className="btn btn-primary" onClick={onConnect} disabled={busy}>
              Connect
            </button>
          )}
          {signIn && c.state === 'off' && (
            <button type="button" className="btn btn-primary" onClick={onConnect} disabled={busy}>
              Turn on
            </button>
          )}
          {c.state === 'needs-sign-in' && (
            <button type="button" className="btn btn-primary" onClick={onConnect} disabled={busy}>
              Sign in again
            </button>
          )}
          {signIn && setUp && c.access && (
            <label className="connector-access">
              <span className="visually-hidden">What Hermes may do without asking</span>
              <select value={c.access} onChange={(e) => onAccess(e.target.value as ConnectorAccess)} disabled={busy}>
                <option value="ask">{ACCESS_LABEL.ask}</option>
                <option value="auto">{ACCESS_LABEL.auto}</option>
              </select>
            </label>
          )}
          {signIn && c.state === 'connected' && (
            <button type="button" className="icon-btn" onClick={onCheck} disabled={busy} aria-label={`Check ${c.name}`}>
              {busy ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}
            </button>
          )}
          {setUp && (
            <button type="button" className="btn btn-secondary" onClick={onDisconnect} disabled={busy}>
              Disconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A dialog on top of the sheet, left-aligned and a little wider than a yes/no question. */
function Dialog({ title, onClose, busy, children }: { title: string; onClose: () => void; busy?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        ref={ref}
        className="overlay-card connector-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          if (!busy) onClose();
        }}
      >
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function CanList({ connector }: { connector: Connector }) {
  return (
    <>
      <p className="connect-lead">Hermes will be able to:</p>
      <ul className="connect-can">
        {connector.can.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {connector.caution && <p className="connect-caution">{connector.caution}</p>}
    </>
  );
}

/** Review → open the service's sign-in page → wait for it to come back. */
function ConnectDialog({ connector, onClose, onConnected }: { connector: Connector; onClose: () => void; onConnected: () => void }) {
  const [step, setStep] = useState<'review' | 'starting' | 'waiting'>('review');
  const [flow, setFlow] = useState<{ flowId: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The parent re-renders while this waits; keep the poll going across that.
  const connected = useRef(onConnected);
  connected.current = onConnected;

  useEffect(() => {
    if (!flow) return;
    let live = true;
    const started = Date.now();
    const tick = async () => {
      if (!live) return;
      try {
        const status = await api.connectFlow(flow.flowId);
        if (!live) return;
        if (status.status === 'connected') return connected.current();
        if (status.status === 'failed') {
          setError(status.error ?? 'The sign-in failed.');
          setFlow(null);
          setStep('review');
          return;
        }
      } catch {
        // a blip: keep waiting
      }
      if (Date.now() - started > POLL_LIMIT_MS) {
        setError('That took too long. Start again.');
        setFlow(null);
        setStep('review');
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    let timer = setTimeout(tick, POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [flow]);

  const start = async () => {
    setStep('starting');
    setError(null);
    try {
      const started = await api.connect(connector.id);
      if (started.done) return connected.current();
      setFlow(started);
      setStep('waiting');
    } catch (err) {
      setError((err as Error).message);
      setStep('review');
    }
  };

  const cancel = () => {
    if (flow) void api.cancelConnect(flow.flowId).catch(() => {});
    onClose();
  };

  return (
    <Dialog title={`Connect ${connector.name}`} onClose={cancel} busy={step === 'starting'}>
      {step !== 'waiting' ? (
        <>
          <CanList connector={connector} />
          <p className="muted connect-small">
            Hermes will ask you before anything that could change something. You can change that afterwards.
          </p>
          {error && <p className="error-text">{error}</p>}
          <div className="confirm-actions">
            <button type="button" className="btn btn-secondary" onClick={cancel} disabled={step === 'starting'}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={start} disabled={step === 'starting'}>
              {step === 'starting' && <LoaderCircle size={16} className="spin" />}
              Continue
            </button>
          </div>
        </>
      ) : (
        <>
          <p>Sign in on {connector.name}'s page and approve. This comes back by itself when you're done.</p>
          <a className="btn btn-primary btn-block" href={flow!.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={16} /> Open {connector.name} sign-in
          </a>
          <p className="muted connect-waiting">
            <LoaderCircle size={14} className="spin" /> Waiting for {connector.name}…
          </p>
          <button type="button" className="btn btn-secondary btn-block" onClick={cancel}>
            Cancel
          </button>
        </>
      )}
    </Dialog>
  );
}

/** Google: open the sign-in page, then paste back the address it lands on. */
function GoogleDialog({ connector, onClose, onConnected }: { connector: Connector; onClose: () => void; onConnected: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setUrl((await api.googleStart()).url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finish = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { state } = await api.googleFinish(pasted.trim());
      if (state === 'connected') onConnected();
      else setError('Google signed in, but Hermes still can’t use it. Try again.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Connect Google" onClose={onClose} busy={busy}>
      {!url ? (
        <>
          <CanList connector={connector} />
          {error && <p className="error-text">{error}</p>}
          <div className="confirm-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={start} disabled={busy}>
              {busy && <LoaderCircle size={16} className="spin" />}
              Continue
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={finish} className="connect-google">
          <ol className="connect-steps">
            <li>
              <a className="btn btn-primary btn-block" href={url} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={16} /> Open Google sign-in
              </a>
            </li>
            <li>Choose your account and allow access.</li>
            <li>
              The last page won't load ("can't connect to localhost"). That's expected: copy its whole address from the
              address bar.
            </li>
          </ol>
          <label className="field">
            <span>Paste that address</span>
            <input
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="http://localhost:1/?state=…&code=…"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
            />
          </label>
          {error && <p className="error-text">{error}</p>}
          <div className="confirm-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !pasted.trim()}>
              {busy && <LoaderCircle size={16} className="spin" />}
              Finish
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

// ---- Triggers --------------------------------------------------------------------

const EXAMPLES = ['from:bookclub.example.org', 'subject:invoice', 'from:boss@company.com is:important'];

function TriggersSection({ googleConnected }: { googleConnected: boolean }) {
  const [data, setData] = useState<TriggerList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Trigger | null>(null);

  useEffect(() => {
    let live = true;
    api.triggers().then(
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
    return () => {
      live = false;
    };
  }, [loads, googleConnected]);

  const reload = () => setLoads((n) => n + 1);
  const targetLabel = (id: string) => data?.targets.find((t) => t.id === id || id.startsWith(`${t.id}:`))?.label ?? id;

  const togglePause = async (t: Trigger) => {
    setBusy(t.id);
    try {
      await api.pauseTrigger(t.id, !t.paused);
      reload();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (t: Trigger) => {
    setBusy(t.id);
    try {
      await api.deleteTrigger(t.id);
      toast('Trigger deleted', 'info');
      setDeleting(null);
      reload();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="connector-section">
      <div className="group-title">When new mail arrives</div>
      <p className="muted connector-note">
        Hermes checks Gmail on a schedule. Only new mail that matches wakes it: then it does what you asked and tells
        you. Sign-in codes and password resets are never passed to it.
      </p>
      {error ? (
        <p className="error-text">{error}</p>
      ) : !data ? (
        <p className="muted">
          <LoaderCircle size={14} className="spin" /> Loading…
        </p>
      ) : (
        <>
          {data.triggers.length > 0 && (
            <div className="group">
              {data.triggers.map((t) => (
                <div className="kv trigger-row" key={t.id}>
                  <Zap size={18} />
                  <div className="grow">
                    <div>{t.name}</div>
                    <div className="muted">
                      <Mail size={12} /> {t.query || 'Gmail'} · every {t.every} min · {targetLabel(t.deliver)}
                    </div>
                    {t.action && <div className="muted trigger-action">{t.action}</div>}
                    {t.tools && (
                      <div className={`muted trigger-tools${toolsCaution(t.tools) ? ' tools-full-text' : ''}`}>
                        {toolsCaution(t.tools) && <TriangleAlert size={12} />} Can use: {toolsLabel(t.tools)}
                      </div>
                    )}
                    {t.lastError && <div className="error-text">Last check failed: {t.lastError}</div>}
                  </div>
                  {busy === t.id && <LoaderCircle size={16} className="spin" />}
                  <button
                    type="button"
                    role="switch"
                    className="switch"
                    aria-checked={!t.paused}
                    aria-label={`${t.name} on`}
                    onClick={() => togglePause(t)}
                    disabled={busy !== null}
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setDeleting(t)}
                    disabled={busy !== null}
                    aria-label={`Delete ${t.name}`}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {!data.ready && <p className="muted">{data.reason}</p>}
          {data.ready && !adding && (
            <button type="button" className="btn btn-secondary trigger-add" onClick={() => setAdding(true)}>
              <Plus size={16} /> New trigger
            </button>
          )}
          {data.ready && adding && (
            <TriggerForm
              targets={data.targets}
              onCancel={() => setAdding(false)}
              onCreated={() => {
                setAdding(false);
                toast('Trigger created', 'info');
                reload();
              }}
            />
          )}
        </>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete "${deleting.name}"?`}
          message="Hermes stops checking for this mail."
          confirmLabel="Delete"
          danger
          busy={busy === deleting.id}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void remove(deleting)}
        />
      )}
    </section>
  );
}

function TriggerForm({
  targets,
  onCancel,
  onCreated,
}: {
  targets: TriggerList['targets'];
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [action, setAction] = useState('');
  const [every, setEvery] = useState<number>(15);
  const [deliver, setDeliver] = useState(targets.find((t) => t.id !== 'local')?.id ?? targets[0]?.id ?? 'local');
  const [tools, setTools] = useState<ScheduleToolLevel | 'keep'>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createTrigger({
        name: name.trim(),
        query: query.trim(),
        action: action.trim(),
        every,
        deliver,
        tools: tools === 'keep' ? 'none' : tools,
      });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ready = name.trim() && query.trim() && action.trim();
  return (
    <form className="group form-group trigger-form" onSubmit={submit}>
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Book club mail" maxLength={80} />
      </label>
      <label className="field">
        <span>When new mail matches this Gmail search</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="from:bookclub.example.org"
          maxLength={500}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <small>
          Same as Gmail's search box. Try:{' '}
          {EXAMPLES.map((ex, i) => (
            <span key={ex}>
              {i > 0 && ', '}
              <button type="button" className="link-btn" onClick={() => setQuery(ex)}>
                {ex}
              </button>
            </span>
          ))}
        </small>
      </label>
      <label className="field">
        <span>Then Hermes should</span>
        <textarea
          value={action}
          onChange={(e) => setAction(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="Summarize it in two lines and tell me if it needs a reply today."
        />
      </label>
      <div className="trigger-selects">
        <label className="field">
          <span>Check every</span>
          <select value={every} onChange={(e) => setEvery(Number(e.target.value))}>
            {TRIGGER_INTERVALS.map((n) => (
              <option key={n} value={n}>
                {n === 60 ? 'hour' : `${n} minutes`}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Tell me on</span>
          <select value={deliver} onChange={(e) => setDeliver(e.target.value)}>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ToolsField name="trigger-tools" value={tools} onChange={setTools} />
      {error && <p className="error-text">{error}</p>}
      <div className="confirm-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !ready}>
          {busy && <LoaderCircle size={16} className="spin" />}
          Create trigger
        </button>
      </div>
    </form>
  );
}
