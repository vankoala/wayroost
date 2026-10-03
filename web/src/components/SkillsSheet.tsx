import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Download,
  FileText,
  LoaderCircle,
  RefreshCw,
  Search,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  MarketPreview,
  MarketSkill,
  SkillAppState,
  SkillEvent,
  SkillInfo,
  SkillList,
  SkillScan,
} from '../../../shared/skills';
import { shortTime } from '../format';
import { skillsApi } from '../skillsApi';
import { toast, useStore } from '../store';
import { ConfirmDialog, Sheet } from './common';
import '../skills.css';

// Settings → Skills: every agent's skills on this PC in one list, kept the same everywhere.
// The shared folder is the source: what's in it reaches every app (the helper copies it to
// the apps that don't read it). A copy changed inside one app waits for a decision here.
// The marketplace is Hermes' skills hub; an install there is shared with every app.

type View = 'skills' | 'news' | 'market';
type Filter = 'all' | 'shared' | 'attention' | 'app-only';

const POLL_MS = 60_000;
// Rows drawn at once: Chrome stops painting a sheet whose list grows to tens of thousands of pixels.
const PAGE = 30;
const rank = (s: SkillInfo) => (needsAttention(s) ? 0 : s.origin === 'shared' ? 1 : 2);

const APP_STATE: Record<SkillAppState, { label: string; tone: string }> = {
  yes: { label: 'Has it', tone: 'ok' },
  updating: { label: 'Updating', tone: 'warn' },
  edited: { label: 'Changed in this app', tone: 'warn' },
  missing: { label: "Doesn't have it", tone: 'none' },
  off: { label: 'Switched off', tone: 'off' },
  'other-platform': { label: 'For another OS', tone: 'off' },
};

const ORIGIN_LABEL: Record<SkillInfo['origin'], string> = {
  shared: 'Shared',
  'hermes-hub': 'Hermes · from the hub',
  'hermes-bundled': 'Hermes · built in',
  'hermes-made': 'Hermes · made by Hermes',
  'claude-account': 'Claude account',
  app: 'One app only',
};

const EVENT_TEXT: Record<SkillEvent['kind'], string> = {
  added: 'New',
  changed: 'Changed',
  removed: 'Removed',
  synced: 'Copied the shared version to',
  shared: 'Shared with every app, from',
  reverted: 'Put the shared version back in',
  failed: "Couldn't update",
};

const needsAttention = (s: SkillInfo) => Object.values(s.apps).includes('edited');

export function SkillsSheet({ onClose, as = 'sheet' }: { onClose: () => void; as?: 'sheet' | 'page' }) {
  const version = useStore((s) => s.skillsVersion);
  const [data, setData] = useState<SkillList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('skills');
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () =>
      skillsApi.list().then(
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
  }, [version]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      setData(await skillsApi.refresh());
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const attention = data?.skills.filter(needsAttention).length ?? 0;
  const installing = data?.installs.filter((i) => i.state === 'installing' || i.state === 'sharing').length ?? 0;

  return (
    <Sheet title="Skills" onClose={onClose} wide as={as}>
      <p className="muted connector-note">
        Skills every agent on this PC can use: Hermes, pi, Claude Code, Codex and OpenCode, here and on Windows (Paseo's agents
        are these apps). Shared skills reach every app within seconds.
      </p>
      <div className="skills-chips skills-views" role="tablist">
        {(
          [
            ['skills', 'Skills', attention],
            ['news', "What's new", 0],
            ['market', 'Marketplace', installing],
          ] as const
        ).map(([id, label, count]) => (
          <button key={id} type="button" role="tab" className="skills-chip" aria-pressed={view === id} aria-selected={view === id} onClick={() => setView(id)}>
            {label}
            {count > 0 && <span className="count">{count}</span>}
          </button>
        ))}
        <button type="button" className="skills-chip" onClick={refresh} disabled={refreshing} aria-label="Check the folders again">
          <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
        </button>
      </div>
      {error ? (
        <p className="error-text">{error}</p>
      ) : !data ? (
        <p className="muted">
          <LoaderCircle size={14} className="spin" /> Reading every app's skills…
        </p>
      ) : view === 'skills' ? (
        <SkillsView data={data} onData={setData} />
      ) : view === 'news' ? (
        <NewsView data={data} />
      ) : (
        <MarketView data={data} />
      )}
    </Sheet>
  );
}

// ---- the list --------------------------------------------------------------------

function SkillsView({ data, onData }: { data: SkillList; onData: (d: SkillList) => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>(() => (data.skills.some(needsAttention) ? 'attention' : 'all'));
  const [app, setApp] = useState<string>('any');
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [query, filter, app]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.skills.filter((s) => {
      if (q && !s.name.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q)) return false;
      if (filter === 'shared' && s.origin !== 'shared') return false;
      if (filter === 'attention' && !needsAttention(s)) return false;
      if (filter === 'app-only' && s.origin === 'shared') return false;
      if (app !== 'any' && !['yes', 'updating', 'edited'].includes(s.apps[app] ?? 'missing')) return false;
      return true;
    }).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [data.skills, query, filter, app]);

  const counts = {
    all: data.skills.length,
    shared: data.skills.filter((s) => s.origin === 'shared').length,
    attention: data.skills.filter(needsAttention).length,
    'app-only': data.skills.filter((s) => s.origin !== 'shared').length,
  };

  return (
    <>
      {counts.attention > 0 && (
        <div className="group">
          <div className="kv">
            <TriangleAlert size={18} />
            <div className="grow">
              <div>
                {counts.attention === 1 ? 'A skill was' : `${counts.attention} skills were`} changed inside one app
              </div>
              <div className="muted">Use that version everywhere, or put the shared one back. Nothing spreads until you choose.</div>
            </div>
          </div>
        </div>
      )}
      <label className="skills-search">
        <Search size={16} />
        <input type="search" placeholder="Find a skill" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a skill" />
      </label>
      <div className="skills-chips skills-filters">
        {(
          [
            ['all', 'All'],
            ['shared', 'Shared'],
            ['attention', 'Needs a look'],
            ['app-only', 'In one app'],
          ] as const
        ).map(([id, label]) =>
          id === 'attention' && counts.attention === 0 && filter !== 'attention' ? null : (
            <button key={id} type="button" className="skills-chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label} <span className="skills-count">{counts[id]}</span>
            </button>
          ),
        )}
        <select className="skills-app-select" value={app} onChange={(e) => setApp(e.target.value)} aria-label="Only skills this app has">
          <option value="any">Any app</option>
          {data.apps.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </div>
      {shown.length === 0 ? (
        <p className="muted">No skills match.</p>
      ) : (
        <div className="group skills-list">
          {shown.slice(0, limit).map((s) => (
            <SkillRow key={s.name} skill={s} data={data} open={open === s.name} onToggle={() => setOpen(open === s.name ? null : s.name)} onData={onData} />
          ))}
        </div>
      )}
      {shown.length > limit && (
        <button type="button" className="btn btn-secondary skills-more" onClick={() => setLimit(limit + PAGE)}>
          Show more ({shown.length - limit} left)
        </button>
      )}
      <p className="muted skills-foot">
        Checked {shortTime(data.checkedAt)}. A new or removed skill reaches Hermes' always-on parts (WhatsApp, scheduled jobs,
        Conduit) after their next restart; edits to a skill reach them at once.
      </p>
    </>
  );
}

/** One line under each row; the per-app badges show when the row is open (fewer shapes to draw). */
function AppSummary({ skill, data }: { skill: SkillInfo; data: SkillList }) {
  const has = data.apps.filter((a) => ['yes', 'updating', 'edited'].includes(skill.apps[a.id] ?? 'missing'));
  const edited = data.apps.filter((a) => skill.apps[a.id] === 'edited');
  const missing = data.apps.filter((a) => (skill.apps[a.id] ?? 'missing') === 'missing');
  const otherOs = data.apps.some((a) => skill.apps[a.id] === 'other-platform');
  const text =
    has.length === data.apps.length
      ? `In all ${data.apps.length} apps`
      : has.length === 0
        ? 'In no app yet'
        : has.length <= 2
          ? `Only in ${has.map((a) => a.label).join(' and ')}`
          : `In ${has.length} of ${data.apps.length} apps${missing.length ? ` · not in ${missing.map((a) => a.label).join(', ')}` : ''}${otherOs ? ' · Linux only, so not on Windows' : ''}`;
  return (
    <div className="skill-summary">
      {text}
      {edited.length > 0 && <span className="skill-summary-warn"> · changed in {edited.map((a) => a.label).join(', ')}</span>}
    </div>
  );
}

function AppPills({ skill, data }: { skill: SkillInfo; data: SkillList }) {
  return (
    <div className="skill-apps" aria-label="Which apps have it">
      {data.apps.map((a) => {
        const state = skill.apps[a.id] ?? 'missing';
        return (
          <span key={a.id} className={`skill-app ${APP_STATE[state].tone}`} title={`${a.label}: ${APP_STATE[state].label}`}>
            {state === 'edited' && <CircleAlert size={11} />}
            {a.label}
          </span>
        );
      })}
    </div>
  );
}

function SkillRow({
  skill,
  data,
  open,
  onToggle,
  onData,
}: {
  skill: SkillInfo;
  data: SkillList;
  open: boolean;
  onToggle: () => void;
  onData: (d: SkillList) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [scan, setScan] = useState<{ place: string; result: SkillScan } | null>(null);
  const [viewing, setViewing] = useState<{ place: string; text: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const shared = skill.origin === 'shared';
  const placeLabel = (id: string) => data.places.find((p) => p.id === id)?.label ?? id;
  const edited = Object.entries(skill.places).filter(([, c]) => c.state === 'edited').map(([p]) => p);
  // Where "Share with every app" takes it from: the app's own copy.
  const sharePlace = shared ? null : Object.keys(skill.places).find((p) => data.places.find((x) => x.id === p)?.mode !== 'readonly') ?? null;

  const run = async (key: string, what: () => Promise<void>) => {
    setBusy(key);
    try {
      await what();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const share = (place: string, confirm = false) =>
    run(`share:${place}`, async () => {
      const result = await skillsApi.share(place, skill.name, confirm);
      if (!result.shared) {
        setScan({ place, result: result.scan });
        return;
      }
      setScan(null);
      toast(`${skill.name} is now shared with every app`, 'info');
      onData(await skillsApi.list());
    });

  const view = (place: string) =>
    run(`view:${place}`, async () => {
      const { text } = await skillsApi.content(place, skill.name);
      setViewing({ place, text });
    });

  const mirrors = data.places.filter((p) => p.mode === 'mirror' && p.exists);

  return (
    <div className={`skill-row${open ? ' open' : ''}`}>
      <button type="button" className="skill-head" onClick={onToggle} aria-expanded={open}>
        <div className="skill-title">
          <span className="skill-name">{skill.name}</span>
          <span className={`skill-origin ${skill.origin}`}>{ORIGIN_LABEL[skill.origin]}</span>
          {needsAttention(skill) && <CircleAlert size={14} className="warn-icon" aria-label="Needs a look" />}
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
        {skill.description && <div className="muted skill-desc">{skill.description}</div>}
        <AppSummary skill={skill} data={data} />
      </button>
      {open && (
        <div className="skill-detail">
          <AppPills skill={skill} data={data} />
          {skill.platforms.length > 0 && <p className="muted">Only for {skill.platforms.join(', ')}.</p>}
          {edited.length > 0 && (
            <div className="skill-edited">
              {edited.map((p) => (
                <div key={p} className="kv">
                  <TriangleAlert size={16} />
                  <div className="grow">
                    <div>Changed in {placeLabel(p)}</div>
                    <div className="muted">The other apps still have the shared version.</div>
                  </div>
                  <div className="skill-actions">
                    <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => view(p)}>
                      <FileText size={16} /> View
                    </button>
                    <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => share(p)}>
                      {busy === `share:${p}` ? <LoaderCircle size={16} className="spin" /> : <Share2 size={16} />} Use everywhere
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy !== null}
                      onClick={() =>
                        run(`take:${p}`, async () => {
                          onData(await skillsApi.takeShared(p, skill.name));
                          toast(`Put the shared ${skill.name} back in ${placeLabel(p)}`, 'info');
                        })
                      }
                    >
                      <Undo2 size={16} /> Put shared back
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <dl className="skill-copies">
            {Object.entries(skill.places).map(([p, c]) => (
              <div key={p} className="skill-copy">
                <dt>{placeLabel(p)}</dt>
                <dd>
                  {
                    {
                      source: 'The shared copy',
                      same: 'Same as shared',
                      behind: 'Updating…',
                      edited: 'Changed here',
                      linked: 'A link (left alone)',
                      own: 'Its own skill',
                    }[c.state]
                  }{' '}
                  · {shortTime(c.updatedAt)}{' '}
                  <button type="button" className="link-btn" onClick={() => view(p)} disabled={busy !== null}>
                    view
                  </button>
                </dd>
              </div>
            ))}
          </dl>
          {shared && mirrors.length > 0 && (
            <div className="skill-switches">
              <div className="muted">Copies for apps that don't read the shared folder:</div>
              {mirrors.map((p) => {
                const otherOs = skill.platforms.length > 0 && !skill.platforms.some((x) => (p.windows ? /^win/i : /^linux$/i).test(x));
                const on = !skill.excluded.includes(p.id);
                return (
                  <div key={p.id} className="kv">
                    <div className="grow">
                      <div>{p.label}</div>
                      {otherOs && <div className="muted">This skill is for another OS.</div>}
                    </div>
                    {busy === `ex:${p.id}` && <LoaderCircle size={16} className="spin" />}
                    <button
                      type="button"
                      role="switch"
                      className="switch"
                      aria-checked={on && !otherOs}
                      aria-label={`${skill.name} in ${p.label}`}
                      disabled={busy !== null || otherOs}
                      onClick={() => run(`ex:${p.id}`, async () => onData(await skillsApi.setExcluded(skill.name, p.id, on)))}
                    />
                  </div>
                );
              })}
            </div>
          )}
          <div className="confirm-actions skill-actions">
            {!shared && sharePlace && (
              <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => share(sharePlace)}>
                {busy === `share:${sharePlace}` ? <LoaderCircle size={16} className="spin" /> : <Share2 size={16} />} Share with every app
              </button>
            )}
            {shared && (
              <button type="button" className="btn btn-secondary danger" disabled={busy !== null} onClick={() => setRemoving(true)}>
                <Trash2 size={16} /> Remove from every app
              </button>
            )}
          </div>
          {!shared && skill.origin === 'claude-account' && (
            <p className="muted">From your claude.ai account: the Claude desktop app keeps it, so it can't be shared from here.</p>
          )}
          {scan && (
            <ScanResult
              scan={scan.result}
              busy={busy !== null}
              confirmLabel="Share anyway"
              onConfirm={() => share(scan.place, true)}
              onCancel={() => setScan(null)}
            />
          )}
          {viewing && (
            <div className="skill-view">
              <div className="kv">
                <div className="grow muted">SKILL.md in {placeLabel(viewing.place)}</div>
                <button type="button" className="link-btn" onClick={() => setViewing(null)}>
                  close
                </button>
              </div>
              <pre>{viewing.text}</pre>
            </div>
          )}
        </div>
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove ${skill.name} from every app?`}
          message="It leaves the shared folder and the copies made from it. A copy someone changed inside an app stays. A backup is kept on the PC."
          confirmLabel="Remove"
          danger
          busy={busy === 'remove'}
          onCancel={() => setRemoving(false)}
          onConfirm={() =>
            void run('remove', async () => {
              onData(await skillsApi.remove(skill.name));
              toast(`Removed ${skill.name}`, 'info');
            }).then(() => setRemoving(false))
          }
        />
      )}
    </div>
  );
}

function ScanResult({
  scan,
  busy,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  scan: SkillScan;
  busy: boolean;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const blocked = scan.verdict === 'dangerous' || scan.policy === 'block';
  return (
    <div className={`skill-scan ${blocked ? 'bad' : 'warn'}`}>
      <div className="kv">
        <ShieldAlert size={18} />
        <div className="grow">
          <div>{blocked ? 'The security scan blocked this skill' : 'The security scan wants you to look first'}</div>
          <div className="muted">
            Skills are instructions your agents follow. {scan.summary ?? `Verdict: ${scan.verdict}.`}
          </div>
        </div>
      </div>
      {scan.findings.length > 0 && (
        <ul className="skill-findings">
          {scan.findings.map((f, i) => (
            <li key={i}>
              <span className={`sev ${f.severity}`}>{f.severity}</span> {f.description}{' '}
              <span className="muted">
                {f.file}
                {f.line ? `:${f.line}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="confirm-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {!blocked && (
          <button type="button" className="btn btn-secondary danger" onClick={onConfirm} disabled={busy}>
            {busy && <LoaderCircle size={16} className="spin" />} {confirmLabel}
          </button>
        )}
      </div>
    </div>
  );
}

// ---- what's new --------------------------------------------------------------------

function NewsView({ data }: { data: SkillList }) {
  const placeLabel = (id?: string) => (id ? (data.places.find((p) => p.id === id)?.label ?? id) : '');
  if (data.events.length === 0) return <p className="muted">Nothing new since Wayroost started watching the skill folders.</p>;
  return (
    <div className="group skills-news">
      {data.events.map((e, i) => (
        <div key={`${e.at}-${i}`} className="kv">
          <div className={`dot ${e.kind === 'failed' ? 'bad' : e.kind === 'removed' ? '' : e.kind === 'added' || e.kind === 'shared' ? 'ok' : 'warn'}`} />
          <div className="grow">
            <div>
              <strong>{e.name}</strong>{' '}
              <span className="muted">
                {EVENT_TEXT[e.kind].toLowerCase()} {e.kind === 'synced' || e.kind === 'shared' || e.kind === 'reverted' ? '' : 'in '}
                {placeLabel(e.place)}
              </span>
            </div>
            {e.detail && <div className="muted">{e.detail}</div>}
          </div>
          <span className="muted skills-when">{shortTime(e.at)}</span>
        </div>
      ))}
    </div>
  );
}

// ---- marketplace -------------------------------------------------------------------

function MarketView({ data }: { data: SkillList }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MarketSkill[] | null>(null);
  const [timedOut, setTimedOut] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<MarketSkill | null>(null);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    setPicked(null);
    try {
      const found = await skillsApi.search(query.trim());
      setResults(found.results);
      setTimedOut(found.timedOut);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const installs = data.installs;
  return (
    <>
      <p className="muted">
        Searches Hermes' skills hub: skills.sh, GitHub (including Anthropic's and OpenAI's skill collections), ClawHub, LobeHub and
        Nous' official catalog. Every install is security-scanned, then shared with every app.
      </p>
      <form className="skills-search" onSubmit={search}>
        <Search size={16} />
        <input type="search" placeholder="Search the marketplace" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the marketplace" />
        <button type="submit" className="btn btn-secondary" disabled={searching || !query.trim()}>
          {searching ? <LoaderCircle size={16} className="spin" /> : 'Search'}
        </button>
      </form>
      {installs.length > 0 && (
        <div className="group">
          {installs.map((i) => (
            <div key={i.identifier} className="kv">
              {i.state === 'done' ? (
                <ShieldCheck size={18} />
              ) : i.state === 'failed' ? (
                <CircleAlert size={18} />
              ) : (
                <LoaderCircle size={18} className="spin" />
              )}
              <div className="grow">
                <div>{i.name}</div>
                <div className={i.state === 'failed' ? 'error-text' : 'muted'}>
                  {i.state === 'installing'
                    ? 'Hermes is installing it…'
                    : i.state === 'sharing'
                      ? 'Sharing it with every app…'
                      : i.state === 'done'
                        ? 'Installed for every app'
                        : i.error}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      {timedOut.length > 0 && <p className="muted">No answer in time from: {timedOut.join(', ')}.</p>}
      {results && results.length === 0 && <p className="muted">Nothing found.</p>}
      {results && results.length > 0 && !picked && (
        <div className="group skills-list">
          {results.map((r) => {
            const have = data.skills.some((s) => s.name === r.name && s.origin === 'shared');
            return (
              <button key={r.identifier} type="button" className="skill-head market-row" onClick={() => setPicked(r)}>
                <div className="skill-title">
                  <span className="skill-name">{r.name}</span>
                  <span className="skill-origin">{r.source}</span>
                  <span className={`skill-trust ${r.trust}`}>{r.trust}</span>
                  {(r.installed || have) && <span className="skill-origin shared">You have it</span>}
                </div>
                {r.description && <div className="muted skill-desc">{r.description}</div>}
                <div className="muted market-id">{r.identifier}</div>
              </button>
            );
          })}
        </div>
      )}
      {picked && <MarketDetail skill={picked} data={data} onBack={() => setPicked(null)} />}
    </>
  );
}

function MarketDetail({ skill, data, onBack }: { skill: MarketSkill; data: SkillList; onBack: () => void }) {
  const [preview, setPreview] = useState<MarketPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState<SkillScan | null>(null);
  const job = data.installs.find((i) => i.identifier === skill.identifier);

  useEffect(() => {
    let live = true;
    skillsApi.preview(skill.identifier).then(
      (p) => live && setPreview(p),
      (err) => live && setError((err as Error).message),
    );
    return () => {
      live = false;
    };
  }, [skill.identifier]);

  const install = async (confirm: boolean) => {
    setBusy(true);
    try {
      const result = await skillsApi.install(skill.identifier, confirm);
      if (!result.started) setScan(result.scan);
      else {
        setScan(null);
        toast(`Installing ${skill.name} for every app`, 'info');
      }
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const working = job?.state === 'installing' || job?.state === 'sharing';
  return (
    <div className="market-detail">
      <button type="button" className="link-btn" onClick={onBack}>
        ← Back to results
      </button>
      <h3>{skill.name}</h3>
      <p className="muted">
        {skill.source} · <span className={`skill-trust ${skill.trust}`}>{skill.trust}</span>
        {skill.repo ? ` · ${skill.repo}` : ''}
      </p>
      {skill.description && <p>{skill.description}</p>}
      <div className="confirm-actions skill-actions">
        <button type="button" className="btn btn-primary" disabled={busy || working || job?.state === 'done'} onClick={() => install(false)}>
          {busy || working ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}{' '}
          {job?.state === 'done' ? 'Installed for every app' : working ? 'Installing…' : 'Scan and install for every app'}
        </button>
      </div>
      {job?.state === 'failed' && <p className="error-text">{job.error}</p>}
      {scan && (
        <ScanResult scan={scan} busy={busy} confirmLabel="Install anyway" onConfirm={() => install(true)} onCancel={() => setScan(null)} />
      )}
      {error ? (
        <p className="error-text">{error}</p>
      ) : !preview ? (
        <p className="muted">
          <LoaderCircle size={14} className="spin" /> Fetching the skill…
        </p>
      ) : (
        <div className="skill-view">
          <div className="muted">
            {preview.files.length} file{preview.files.length === 1 ? '' : 's'}: {preview.files.slice(0, 12).join(', ')}
            {preview.files.length > 12 ? '…' : ''}
          </div>
          <pre>{preview.skillMd || '(no SKILL.md)'}</pre>
        </div>
      )}
    </div>
  );
}
