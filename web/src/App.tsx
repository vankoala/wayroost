import { Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { refreshList } from './api';
import { DropOverlay } from './components/Attachments';
import { ConfirmDialog, Logo, Toasts, useDelayedFlag } from './components/common';
import { ConversationView, type NewConversationRequest } from './components/ConversationView';
import { Inbox } from './components/Inbox';
import { MediaViewer } from './components/Media';
import { ForYouSheet } from './components/ForYouSheet';
import { MoreSheet, PhoneBar, Sidebar, useIsPhone } from './components/Shell';
import { NewChatSheet } from './components/NewChatSheet';
import { DevicesPage } from './components/DevicesPage';
import { PairPage } from './components/PairPage';
import { startEvents } from './events';
import {
  navigate,
  param,
  parseChatsFilter,
  parseRoute,
  schedulePath,
  settingsPath,
  usePathname,
  useUrl,
  type ChatsFilter,
  type Route,
} from './router';
import { convKey, toast, useStore } from './store';
import { HomePage } from './pages/Home';
import { SettingsPage, VoicePage } from './pages/Settings';
import { AgentsSettingsPage } from './pages/SettingsAgents';
import { ModelsSettingsPage } from './pages/SettingsModels';
import { SafetySettingsPage } from './pages/SettingsSafety';
import { ChecksSettingsPage } from './pages/SettingsChecks.js';
import { ArchivedPage, ConnectorsPage, SchedulePage, SkillsPage } from './pages/SettingsPages';
import { StatusPage, type PowerConfirmation } from './pages/StatusPage';
import { TeamPage } from './pages/TeamPage';
import { TasksPage } from './pages/TasksPage';
import { usePower } from './power';

let started = false;

function SessionExpired() {
  return (
    <div className="overlay" role="alertdialog" aria-label="Session expired">
      <div className="overlay-card">
        <Lock size={28} />
        <h2>Your secure session ended</h2>
        <p>Sign in again to keep controlling your agents.</p>
        <button type="button" className="btn btn-primary btn-block" onClick={() => location.reload()}>
          Sign in again
        </button>
      </div>
    </div>
  );
}

/** The right-hand pane of the chats page, on a screen wide enough for two columns. */
function NoConversation() {
  return (
    <section className="pane pane-conv">
      <div className="empty">
        <div>
          <Logo size={44} />
          <h2>Hermes and Paseo, in one place</h2>
          <p>Pick a conversation, or start a new one. Anything that needs your approval shows up at the top.</p>
        </div>
      </div>
    </section>
  );
}

export function App() {
  const route = parseRoute(usePathname());
  const unpaired = useStore((s) => s.unpaired);
  // Pairing comes before everything else, outside the shell: an unpaired browser
  // can't load anything. The shell lives in Main, so its hooks never run here.
  if (route.name === 'pair' || unpaired) return <PairPage />;
  return <Main route={route} />;
}

function Main({ route }: { route: Exclude<Route, { name: 'pair' }> }) {
  const url = useUrl();
  const phone = useIsPhone();
  const sessionExpired = useStore((s) => s.sessionExpired);
  usePower();
  const socket = useStore((s) => s.socket);
  const waitingCount = useStore((s) => Object.keys(s.approvals).length);
  // Quick actions only. Every place in the app is a page with its own URL, and a
  // sheet never opens another sheet.
  const [sheet, setSheet] = useState<
    ({ kind: 'new' } & NewConversationRequest) | { kind: 'for-you' | 'more' } | ({ kind: 'power-confirm' } & PowerConfirmation) | null
  >(null);
  const offline = useDelayedFlag(socket === 'closed', 1500);
  const filter: ChatsFilter = parseChatsFilter(url);
  const inStatus = route.name === 'settings' && route.page === 'status';
  const confirmationCurrent = sheet?.kind === 'power-confirm' && sheet.isCurrent();

  useEffect(() => {
    setSheet((current) => current?.kind === 'power-confirm' && (!inStatus || !current.isCurrent()) ? null : current);
  }, [inStatus, sessionExpired, confirmationCurrent]);

  useEffect(() => {
    if (started) return;
    started = true;
    startEvents();
    refreshList().catch((err: Error) => toast(err.message));
  }, []);

  // A notification about For-you cards opens it (public/sw.js sends /#for-you).
  useEffect(() => {
    const open = () => {
      if (location.hash !== '#for-you') return;
      history.replaceState(history.state, '', location.pathname + location.search);
      setSheet({ kind: 'for-you' });
    };
    open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, []);

  useEffect(() => {
    document.title = waitingCount ? `(${waitingCount}) Wayroost` : 'Wayroost';
  }, [waitingCount]);

  const openNew = (request: NewConversationRequest = {}) => setSheet({ kind: 'new', ...request });
  const activeKey = route.name === 'conversation' ? convKey(route.source, route.id) : null;
  const inChats = route.name === 'chats' || route.name === 'conversation';

  return (
    <div className={`app ${inChats ? (route.name === 'conversation' ? 'show-conv' : 'show-list') : 'app-page'}`}>
      {phone ? null : <Sidebar route={route} waiting={waitingCount} />}
      {inChats ? (
        <>
          <Inbox
            activeKey={activeKey}
            offline={offline}
            filter={filter}
            onFilter={(next) => {
              const nextUrl = new URL(url, location.origin);
              if (next === 'all') nextUrl.searchParams.delete('filter');
              else nextUrl.searchParams.set('filter', next);
              navigate(nextUrl.pathname + nextUrl.search, { replace: true });
            }}
            onNew={(cwd) => openNew(cwd ? { cwd } : {})}
            onSettings={() => navigate(settingsPath())}
            onForYou={() => setSheet({ kind: 'for-you' })}
            onSchedules={(job) => navigate(schedulePath(job ? { focus: `${job.source}:${job.id}` } : {}))}
            onNewSchedule={() => navigate(schedulePath({ startNew: true }))}
          />
          {route.name === 'conversation' ? (
            <ConversationView
              key={activeKey}
              source={route.source}
              id={route.id}
              offline={offline}
              onNew={openNew}
            />
          ) : (
            <NoConversation />
          )}
        </>
      ) : (
        <main className="page-main">
          {route.name === 'home' && <HomePage onNewTask={() => openNew()} phone={phone} />}
          {route.name === 'tasks' && <TasksPage />}
          {(route.name === 'schedule' || (route.name === 'settings' && route.page === 'schedule')) && (
            <SchedulePage focus={param(url, 'focus') ?? undefined} startNew={param(url, 'new') !== null} />
          )}
          {route.name === 'team' && <TeamPage role={param(url, 'role') ?? undefined} />}
          {route.name === 'settings' && route.page === 'status' && (
            <StatusPage onConfirm={(confirmation) => setSheet({ kind: 'power-confirm', ...confirmation })} />
          )}
          {route.name === 'settings' && route.page === 'devices' && <DevicesPage />}
          {route.name === 'settings' && route.page === 'agents' && <AgentsSettingsPage />}
          {route.name === 'settings' && route.page === 'models' && <ModelsSettingsPage />}
          {route.name === 'settings' && route.page === 'safety' && <SafetySettingsPage />}
          {route.name === 'settings' && route.page === 'checks' && <ChecksSettingsPage />}
          {route.name === 'settings' && route.page === 'voice' && <VoicePage />}
          {route.name === 'settings' && route.page === 'connectors' && <ConnectorsPage />}
          {route.name === 'settings' && route.page === 'skills' && <SkillsPage />}
          {route.name === 'settings' && route.page === 'archived' && <ArchivedPage />}
          {route.name === 'settings' && route.page === 'overview' && <SettingsPage />}
        </main>
      )}
      {phone ? (
        <PhoneBar
          route={route}
          waiting={waitingCount}
          onNewTask={() => openNew()}
          more={sheet?.kind === 'more'}
          onMore={() => setSheet({ kind: 'more' })}
        />
      ) : null}
      {sheet?.kind === 'more' && <MoreSheet onClose={() => setSheet(null)} />}
      {sheet?.kind === 'power-confirm' && inStatus && !sessionExpired && confirmationCurrent && (
        <ConfirmDialog
          title="Run this now?"
          message={sheet.message}
          confirmLabel="Run it"
          busy={false}
          onConfirm={() => {
            setSheet(null);
            if (sheet.isCurrent()) sheet.onConfirm();
          }}
          onCancel={() => {
            setSheet(null);
            sheet.onCancel();
          }}
        />
      )}
      {sheet?.kind === 'new' && (
        <NewChatSheet
          onClose={() => setSheet(null)}
          {...(sheet.cwd ? { initialCwd: sheet.cwd } : {})}
          {...(sheet.source ? { initialSource: sheet.source } : {})}
          {...(sheet.text ? { initialText: sheet.text } : {})}
        />
      )}
      {sheet?.kind === 'for-you' && (
        <ForYouSheet
          onClose={() => setSheet(null)}
          onSettings={() => {
            setSheet(null);
            navigate(settingsPath());
          }}
        />
      )}
      <MediaViewer />
      <DropOverlay />
      <Toasts />
      {sessionExpired && <SessionExpired />}
    </div>
  );
}
