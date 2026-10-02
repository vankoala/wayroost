import { Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { refreshList } from './api';
import { DropOverlay } from './components/Attachments';
import { Logo, Toasts, useDelayedFlag } from './components/common';
import { ConversationView, type NewConversationRequest } from './components/ConversationView';
import { Inbox } from './components/Inbox';
import { MediaViewer } from './components/Media';
import { ArchivedSheet } from './components/ArchivedSheet';
import { ConnectorsSheet } from './components/ConnectorsSheet';
import { SchedulesSheet } from './components/SchedulesSheet';
import { ForYouSheet } from './components/ForYouSheet';
import { SkillsSheet } from './components/SkillsSheet';
import { NewConversationSheet } from './components/NewConversationSheet';
import { SettingsSheet } from './components/SettingsSheet';
import { startEvents } from './events';
import { parseRoute, usePathname } from './router';
import { convKey, toast, useStore } from './store';

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

export function App() {
  const route = parseRoute(usePathname());
  const sessionExpired = useStore((s) => s.sessionExpired);
  const socket = useStore((s) => s.socket);
  const waitingCount = useStore((s) => Object.keys(s.approvals).length);
  const [sheet, setSheet] = useState<
    | ({ kind: 'new' } & NewConversationRequest)
    | { kind: 'settings' }
    | { kind: 'archived' }
    | { kind: 'connectors' }
    | { kind: 'schedules'; focus?: string; startNew?: boolean }
    | { kind: 'foryou' }
    | { kind: 'skills' }
    | null
  >(null);
  const offline = useDelayedFlag(socket === 'closed', 1500);

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
      setSheet({ kind: 'foryou' });
    };
    open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, []);

  useEffect(() => {
    document.title = waitingCount ? `(${waitingCount}) Signalbox` : 'Signalbox';
  }, [waitingCount]);

  const activeKey = route.name === 'conversation' ? convKey(route.source, route.id) : null;

  return (
    <div className={`app ${route.name === 'conversation' ? 'show-conv' : 'show-list'}`}>
      <Inbox
        activeKey={activeKey}
        offline={offline}
        onNew={(cwd) => setSheet({ kind: 'new', ...(cwd ? { cwd } : {}) })}
        onSettings={() => setSheet({ kind: 'settings' })}
        onForYou={() => setSheet({ kind: 'foryou' })}
        onSchedules={(job) => setSheet({ kind: 'schedules', ...(job ? { focus: `${job.source}:${job.id}` } : {}) })}
        onNewSchedule={() => setSheet({ kind: 'schedules', startNew: true })}
      />
      {route.name === 'conversation' ? (
        <ConversationView
          key={activeKey}
          source={route.source}
          id={route.id}
          offline={offline}
          onNew={(request) => setSheet({ kind: 'new', ...request })}
        />
      ) : (
        <section className="pane pane-conv">
          <div className="empty">
            <div>
              <Logo size={44} />
              <h2>Hermes and Paseo, in one place</h2>
              <p>Pick a conversation, or start a new one. Anything that needs your approval shows up at the top.</p>
            </div>
          </div>
        </section>
      )}
      {sheet?.kind === 'new' && (
        <NewConversationSheet
          onClose={() => setSheet(null)}
          {...(sheet.cwd ? { initialCwd: sheet.cwd } : {})}
          {...(sheet.source ? { initialSource: sheet.source } : {})}
          {...(sheet.text ? { initialText: sheet.text } : {})}
        />
      )}
      {sheet?.kind === 'settings' && (
        <SettingsSheet
          onClose={() => setSheet(null)}
          onArchived={() => setSheet({ kind: 'archived' })}
          onConnectors={() => setSheet({ kind: 'connectors' })}
          onSchedules={() => setSheet({ kind: 'schedules' })}
          onSkills={() => setSheet({ kind: 'skills' })}
        />
      )}
      {sheet?.kind === 'archived' && <ArchivedSheet onClose={() => setSheet({ kind: 'settings' })} />}
      {sheet?.kind === 'connectors' && <ConnectorsSheet onClose={() => setSheet({ kind: 'settings' })} />}
      {sheet?.kind === 'schedules' && (
        <SchedulesSheet focus={sheet.focus} startNew={sheet.startNew} onClose={() => setSheet(null)} />
      )}
      {sheet?.kind === 'foryou' && (
        <ForYouSheet onClose={() => setSheet(null)} onSettings={() => setSheet({ kind: 'settings' })} />
      )}
      {sheet?.kind === 'skills' && <SkillsSheet onClose={() => setSheet({ kind: 'settings' })} />}
      <MediaViewer />
      <DropOverlay />
      <Toasts />
      {sessionExpired && <SessionExpired />}
    </div>
  );
}
