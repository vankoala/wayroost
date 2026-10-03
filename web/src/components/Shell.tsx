import { CalendarClock, ListTodo, MessageSquare, MoreHorizontal, Plus, Settings, Users, House } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { Route } from '../router';
import { navigate, settingsPath } from '../router';
import { Logo, Sheet, Link } from './common';
import { StatusBlock } from './StatusBlock';
import { TeamRowBlock } from './TeamRowBlock';

// The shell: a 210 px sidebar on a desktop screen, a bottom bar below 720 px.
// Both are built once and only one is ever in the document, so a tap or a Tab key
// can never land on a hidden copy of the same control.

/** Below this width the sidebar becomes a bottom bar. */
export const PHONE_QUERY = '(max-width: 719px)';

export function useIsPhone(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const query = window.matchMedia(PHONE_QUERY);
      query.addEventListener('change', listener);
      return () => query.removeEventListener('change', listener);
    },
    () => window.matchMedia(PHONE_QUERY).matches,
  );
}

type IconType = LucideIcon;

interface NavItem {
  to: string;
  label: string;
  icon: IconType;
  /** Which route lights this row. A thread keeps Chats lit. */
  names: Route['name'][];
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', icon: House, names: ['home'] },
  { to: '/chats', label: 'Chats', icon: MessageSquare, names: ['chats', 'conversation'] },
  { to: '/tasks', label: 'Tasks', icon: ListTodo, names: ['tasks'] },
  { to: '/schedule', label: 'Schedule', icon: CalendarClock, names: ['schedule'] },
  { to: '/team', label: 'Team', icon: Users, names: ['team'] },
];

const SETTINGS_ITEM: NavItem = { to: settingsPath(), label: 'Settings', icon: Settings, names: ['settings'] };

function navActive(item: NavItem, route: Route): boolean {
  // A thread keeps "Chats" lit; every page under /settings keeps "Settings" lit.
  return item.names.includes(route.name);
}

function NavRow({ item, active, badge }: { item: NavItem; active: boolean; badge?: number }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      className={`nav-row${active ? ' active' : ''}`}
      aria-current={active ? 'page' : undefined}
      aria-label={badge ? `${item.label}, ${badge} waiting for you` : item.label}
    >
      <Icon size={17} strokeWidth={2} aria-hidden="true" />
      <span className="nav-label">{item.label}</span>
      {badge ? <span className="nav-count">{badge > 9 ? '9+' : badge}</span> : null}
    </Link>
  );
}

/** The desktop sidebar: wordmark, nav, the team row, and the status block pinned at the bottom. */
export function Sidebar({ route, waiting }: { route: Route; waiting: number }) {
  return (
    <aside className="sidebar">
      <Link to="/" className="wordmark" aria-label="Wayroost home">
        <Logo size={26} />
        <span>Wayroost</span>
      </Link>
      <nav className="side-nav" aria-label="Places">
        {NAV_ITEMS.map((item) => (
          <NavRow
            key={item.to}
            item={item}
            active={navActive(item, route)}
            {...(item.to === '/chats' && waiting ? { badge: waiting } : {})}
          />
        ))}
        <span className="side-rule" aria-hidden="true" />
        <NavRow item={SETTINGS_ITEM} active={navActive(SETTINGS_ITEM, route)} />
      </nav>
      <div className="side-team">
        <p className="side-label">Your team</p>
        <TeamRowBlock size={28} />
      </div>
      <div className="side-foot">
        <StatusBlock />
      </div>
    </aside>
  );
}

/** The phone bottom bar: Home, Chats, + (New task), Tasks, More (Schedule, Team, Settings). */
export function PhoneBar({
  route,
  waiting,
  onNewTask,
  more,
  onMore,
}: {
  route: Route;
  waiting: number;
  onNewTask: () => void;
  more: boolean;
  onMore: () => void;
}) {
  const tab = (item: NavItem) => (
    <NavRow
      item={item}
      active={navActive(item, route)}
      {...(item.to === '/chats' && waiting ? { badge: waiting } : {})}
    />
  );
  return (
    <>
      <nav className="tabbar" aria-label="Places">
        {tab(NAV_ITEMS[0]!)}
        {tab(NAV_ITEMS[1]!)}
        <button type="button" className="tab tab-new" onClick={onNewTask} aria-label="New task">
          <Plus size={22} strokeWidth={2.6} aria-hidden="true" />
        </button>
        {tab(NAV_ITEMS[2]!)}
        <button
          type="button"
          className="tab"
          onClick={onMore}
          aria-expanded={more}
          aria-label="More places"
        >
          <MoreHorizontal size={17} strokeWidth={2} aria-hidden="true" />
          <span className="nav-label">More</span>
        </button>
      </nav>
    </>
  );
}

/** More shares the App's quick-action slot with New task and For you. */
export function MoreSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="More" onClose={onClose}>
      <div className="group">
        {[NAV_ITEMS[3]!, NAV_ITEMS[4]!, SETTINGS_ITEM].map((item) => (
          <button
            key={item.to}
            type="button"
            className="kv settings-link"
            onClick={() => {
              onClose();
              navigate(item.to);
            }}
          >
            <item.icon size={18} aria-hidden="true" />
            <span className="grow">{item.label}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}
