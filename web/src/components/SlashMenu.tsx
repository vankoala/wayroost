import { LoaderCircle } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes,
} from 'react';
import type { CommandCatalog } from '../../../shared/protocol';
import { acceptCommand, acceptOption, slashContext, slashMenu, type CommandMatch } from '../slash';

// The "/" menu for a message box: commands and skills while the first word is
// typed, then known values for the command's argument. Focus never leaves the
// text box, so the phone keyboard stays up; rows are picked by tap, Enter or Tab.

type Row = { kind: 'command'; match: CommandMatch } | { kind: 'option'; value: string };

export interface SlashMenuControls {
  /** Spread onto the textarea: combobox semantics, cursor and focus tracking. */
  inputProps: TextareaHTMLAttributes<HTMLTextAreaElement>;
  /** Call from the textarea's onChange so the menu follows the cursor. */
  track: (el: HTMLTextAreaElement) => void;
  /** Call first from the textarea's onKeyDown; true when the menu used the key. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** The open menu, or null. */
  menu: ReactNode;
}

// Taps on the menu mustn't take focus from the text box.
const keepFocus = (e: MouseEvent) => e.preventDefault();

function CommandRow({ match }: { match: CommandMatch }) {
  const { command, alias } = match;
  return (
    <>
      <span className="slash-line">
        <span className="slash-name">/{command.name}</span>
        {command.args && <span className="slash-args">{command.args}</span>}
        {alias && <span className="slash-alias">/{alias}</span>}
      </span>
      {command.description && <span className="slash-desc">{command.description}</span>}
    </>
  );
}

export function useSlashMenu({
  text,
  setText,
  inputRef,
  load,
}: {
  text: string;
  setText: (text: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** Fetches the catalog; null turns the menu off. Keep it stable (useCallback). */
  load: (() => Promise<CommandCatalog>) | null;
}): SlashMenuControls {
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (index: number) => `${id}-opt-${index}`;
  const [cursor, setCursor] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CommandCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState({ key: '', index: -1 });
  const placeCursor = useRef<number | null>(null);
  const reveal = useRef(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const listRef = useRef<HTMLDivElement>(null);

  // Fetch the catalog (or take it from the cache) each time a "/" is started.
  const wanted = Boolean(load) && focused && text.startsWith('/');
  useEffect(() => {
    if (!wanted || !load) return;
    let live = true;
    load().then(
      (loaded) => {
        if (!live) return;
        setCatalog(loaded);
        setFailed(false);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [wanted, load]);

  useEffect(() => () => clearTimeout(blurTimer.current), []);

  // Closed with Esc (or completed): stays closed until the text changes.
  if (dismissed !== null && dismissed !== text) setDismissed(null);
  const ctx = load && focused && dismissed === null ? slashContext(text, cursor) : null;
  const menu = ctx && catalog ? slashMenu(text, cursor, catalog.commands) : null;
  const loading = ctx?.stage === 'command' && !catalog && !failed;
  const rows: Row[] = !menu
    ? []
    : menu.stage === 'command'
      ? menu.groups.flatMap((g) => g.matches.map((match) => ({ kind: 'command' as const, match })))
      : menu.options.map((value) => ({ kind: 'option' as const, value }));
  const menuKey = menu ? `${menu.stage}:${menu.start}:${menu.query}:${rows.length}` : '';
  // Reopening starts from the top again.
  if (!menu && active.key) setActive({ key: '', index: -1 });
  // Commands start on the first row; argument values only once something is
  // typed, so Enter still sends a bare "/reasoning".
  const initial = menu?.stage === 'option' && !menu.query ? -1 : 0;
  const index = !menu ? -1 : active.key === menuKey ? Math.min(active.index, rows.length - 1) : initial;

  // New results start at the top; arrow keys keep the picked row in view.
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [menuKey]);
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = index >= 0 ? document.getElementById(optionId(index)) : null;
    if (!reveal.current || !list || !row) return;
    reveal.current = false;
    const r = row.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    if (r.top < l.top) list.scrollTop -= l.top - r.top + 6;
    else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom + 6;
  });
  // Put the cursor where an accepted row left it.
  useLayoutEffect(() => {
    const at = placeCursor.current;
    if (at === null) return;
    placeCursor.current = null;
    inputRef.current?.setSelectionRange(at, at);
  });

  const accept = (at: number) => {
    const row = rows[at];
    if (!menu || !row) return;
    const edit =
      row.kind === 'command' ? acceptCommand(text, menu, row.match.command) : acceptOption(text, menu, row.value);
    placeCursor.current = edit.cursor;
    setCursor(edit.cursor);
    setText(edit.text);
    // A value completes the command: stay closed until something else is typed.
    if (row.kind === 'option') setDismissed(edit.text);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!(menu || loading) || e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // close the menu, not the sheet around it
      setDismissed(text);
      return true;
    }
    if (!rows.length || e.shiftKey) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = index < 0 ? (step > 0 ? 0 : rows.length - 1) : (index + step + rows.length) % rows.length;
      reveal.current = true;
      setActive({ key: menuKey, index: next });
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const pick = index >= 0 ? index : e.key === 'Tab' ? 0 : -1;
      if (pick < 0) return false; // nothing picked: Enter does what it always does
      e.preventDefault();
      accept(pick);
      return true;
    }
    return false;
  };

  const expanded = Boolean(menu);
  const inputProps: TextareaHTMLAttributes<HTMLTextAreaElement> = {
    ...(load
      ? {
          role: 'combobox',
          'aria-autocomplete': 'list' as const,
          'aria-expanded': expanded,
          ...(expanded ? { 'aria-controls': listId } : {}),
          ...(expanded && index >= 0 ? { 'aria-activedescendant': optionId(index) } : {}),
        }
      : {}),
    onSelect: (e) => setCursor(e.currentTarget.selectionStart),
    onFocus: () => {
      clearTimeout(blurTimer.current);
      setFocused(true);
    },
    // Late, so a tap on a row that blurs the box on some phones still lands.
    onBlur: () => {
      blurTimer.current = setTimeout(() => setFocused(false), 150);
    },
  };

  let next = 0;
  const option = (key: string, content: ReactNode, className = 'slash-row') => {
    const at = next++;
    return (
      <div
        key={key}
        id={optionId(at)}
        role="option"
        aria-selected={at === index}
        className={className}
        onClick={() => accept(at)}
        onMouseMove={() => {
          if (at !== index) setActive({ key: menuKey, index: at });
        }}
      >
        {content}
      </div>
    );
  };

  let element: ReactNode = null;
  if (menu) {
    element = (
      <div
        ref={listRef}
        id={listId}
        className="slash-menu"
        role="listbox"
        aria-label={menu.stage === 'command' ? 'Commands' : `Values for /${menu.command.name}`}
        onMouseDown={keepFocus}
      >
        {menu.stage === 'command' ? (
          menu.groups.map((group, g) => (
            <div key={group.label} role="group" aria-labelledby={`${id}-g${g}`}>
              <div className="slash-group" id={`${id}-g${g}`} role="presentation">
                {group.label}
              </div>
              {group.matches.map((match) =>
                option(`${match.order}:${match.command.name}`, <CommandRow match={match} />),
              )}
            </div>
          ))
        ) : (
          <div role="group" aria-labelledby={`${id}-g0`}>
            <div className="slash-group slash-for" id={`${id}-g0`} role="presentation">
              <span className="slash-name">/{menu.command.name}</span>
              {menu.command.args && <span className="slash-args">{menu.command.args}</span>}
            </div>
            {menu.options.map((value, i) =>
              option(`${i}:${value}`, <span className="slash-name">{value}</span>, 'slash-row slash-value'),
            )}
          </div>
        )}
      </div>
    );
  } else if (loading) {
    element = (
      <div className="slash-menu" role="status" onMouseDown={keepFocus}>
        <div className="slash-loading">
          <LoaderCircle size={15} className="spin" /> Loading commands…
        </div>
      </div>
    );
  }

  return { inputProps, track: (el) => setCursor(el.selectionStart), onKeyDown, menu: element };
}
