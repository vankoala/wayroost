import { SLASH_COMMAND_RE, type SlashCommand } from '../../shared/protocol';

// The "/" menu in the message box: what to offer for the text and cursor
// position, how matches rank, and what accepting a row inserts. Also cleans
// up command output for display. No DOM or React here.

/** Where the cursor is in a "/" command: still typing its name, or its first argument. */
export type SlashContext =
  | { stage: 'command'; query: string; start: number; end: number }
  | { stage: 'option'; name: string; query: string; start: number; end: number };

export interface CommandMatch {
  command: SlashCommand;
  /** 0 exact name or alias, 1 name prefix, 2 alias prefix, 3 name substring, 4 description word. */
  rank: number;
  /** The alias that matched, when the name didn't. */
  alias?: string;
  /** Position in the catalog, for a stable order. */
  order: number;
}

export interface CommandGroup {
  label: string;
  matches: CommandMatch[];
}

export type SlashMenu =
  | (Extract<SlashContext, { stage: 'command' }> & { groups: CommandGroup[] })
  | (Extract<SlashContext, { stage: 'option' }> & { command: SlashCommand; options: string[] });

const tokenEnd = (text: string, from = 0) => {
  const at = text.slice(from).search(/\s/);
  return at === -1 ? text.length : from + at;
};

export function slashContext(text: string, cursor: number): SlashContext | null {
  if (!text.startsWith('/') || cursor < 1) return null;
  const nameEnd = tokenEnd(text);
  if (cursor <= nameEnd) {
    const name = text.slice(1, nameEnd);
    // "/home/me/notes.txt" is a path, not a command.
    if (name.includes('/')) return null;
    return { stage: 'command', query: text.slice(1, cursor), start: 0, end: nameEnd };
  }
  // First argument, on the same line as the name.
  const gap = /^[ \t]+/.exec(text.slice(nameEnd))?.[0].length ?? 0;
  const argStart = nameEnd + gap;
  if (!gap || cursor < argStart) return null;
  const argEnd = tokenEnd(text, argStart);
  if (cursor > argEnd) return null;
  return { stage: 'option', name: text.slice(1, nameEnd), query: text.slice(argStart, cursor), start: argStart, end: argEnd };
}

function matchCommand(command: SlashCommand, q: string): Pick<CommandMatch, 'rank' | 'alias'> | null {
  if (!q) return { rank: 0 };
  const name = command.name.toLowerCase();
  const aliases = command.aliases ?? [];
  const alias = (test: (a: string) => boolean) => aliases.find((a) => test(a.toLowerCase()));
  if (name === q) return { rank: 0 };
  let hit = alias((a) => a === q);
  if (hit) return { rank: 0, alias: hit };
  if (name.startsWith(q)) return { rank: 1 };
  hit = alias((a) => a.startsWith(q));
  if (hit) return { rank: 2, alias: hit };
  if (name.includes(q)) return { rank: 3 };
  const words = (command.description ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u);
  if (words.some((w) => w.startsWith(q))) return { rank: 4 };
  return null;
}

/** Commands matching what was typed after "/", best first; ties keep catalog order. */
export function rankCommands(commands: SlashCommand[], query: string): CommandMatch[] {
  const q = query.toLowerCase();
  const matches: CommandMatch[] = [];
  commands.forEach((command, order) => {
    const match = matchCommand(command, q);
    if (match) matches.push({ command, order, ...match });
  });
  return matches.sort((a, b) => a.rank - b.rank || a.order - b.order);
}

export const groupLabel = (command: SlashCommand) =>
  command.group ?? (command.kind === 'skill' ? 'Skills' : 'Commands');

/**
 * Sections for the menu: the group holding the best match comes first, then
 * groups of commands before groups of skills, then catalog order.
 */
export function groupMatches(matches: CommandMatch[]): CommandGroup[] {
  const groups = new Map<string, CommandGroup & { best: number; skills: boolean; first: number }>();
  for (const match of matches) {
    const label = groupLabel(match.command);
    let group = groups.get(label);
    if (!group) {
      group = { label, matches: [], best: match.rank, skills: true, first: match.order };
      groups.set(label, group);
    }
    group.matches.push(match);
    group.best = Math.min(group.best, match.rank);
    group.first = Math.min(group.first, match.order);
    if (match.command.kind === 'command') group.skills = false;
  }
  return [...groups.values()]
    .sort((a, b) => a.best - b.best || Number(a.skills) - Number(b.skills) || a.first - b.first)
    .map(({ label, matches: m }) => ({ label, matches: m }));
}

/** Argument values: prefix matches first, then values containing the text. */
export function filterOptions(options: string[], query: string): string[] {
  const q = query.toLowerCase();
  if (!q) return options;
  const starts = options.filter((o) => o.toLowerCase().startsWith(q));
  const contains = options.filter((o) => !o.toLowerCase().startsWith(q) && o.toLowerCase().includes(q));
  return [...starts, ...contains];
}

/** The catalog entry a typed name (or alias) refers to. */
export function findCommand(commands: SlashCommand[], name: string): SlashCommand | undefined {
  const n = name.replace(/^\//, '').toLowerCase();
  if (!n) return undefined;
  return (
    commands.find((c) => c.name.toLowerCase() === n) ??
    commands.find((c) => c.aliases?.some((a) => a.toLowerCase() === n))
  );
}

/** What the menu offers for this text and cursor, or null when it should stay closed. */
export function slashMenu(text: string, cursor: number, commands: SlashCommand[]): SlashMenu | null {
  const ctx = slashContext(text, cursor);
  if (!ctx) return null;
  if (ctx.stage === 'command') {
    const matches = rankCommands(commands, ctx.query);
    // Loose matches (inside a name, or in a description) only when nothing closer matches.
    const close = matches.filter((m) => m.rank <= 2);
    const shown = close.length ? close : matches;
    return shown.length ? { ...ctx, groups: groupMatches(shown) } : null;
  }
  const command = findCommand(commands, ctx.name);
  if (!command?.options?.length) return null;
  const options = filterOptions(command.options, ctx.query);
  return options.length ? { ...ctx, command, options } : null;
}

export interface Edit {
  text: string;
  cursor: number;
}

/** "/comp" → "/compress " with the cursor after the space; text after the name is kept. */
export function acceptCommand(text: string, menu: { end: number }, command: SlashCommand): Edit {
  const head = `/${command.name}`;
  const rest = text.slice(menu.end);
  return { text: /^[ \t]/.test(rest) ? head + rest : `${head} ${rest}`, cursor: head.length + 1 };
}

/** "/reasoning hi" → "/reasoning high". */
export function acceptOption(text: string, menu: { start: number; end: number }, option: string): Edit {
  return { text: text.slice(0, menu.start) + option + text.slice(menu.end), cursor: menu.start + option.length };
}

/** "/new fix login" → { name: 'new', rest: 'fix login' }; null when the text isn't a command. */
export function splitCommand(text: string): { name: string; rest: string } | null {
  if (!SLASH_COMMAND_RE.test(text)) return null;
  const end = tokenEnd(text);
  return { name: text.slice(1, end), rest: text.slice(end).trim() };
}

/** "/compress focus" or "compress" → "/compress". */
export function commandLabel(command: string): string {
  const name = command.trim().split(/\s/, 1)[0] ?? '';
  return name.startsWith('/') ? name : `/${name}`;
}

// ---- Command output ---------------------------------------------------------

// CSI (colours, cursor moves), OSC (titles, links), DCS-style strings, other
// escapes such as "ESC(B", and 8-bit CSI.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[ -/]*[0-~]|\x9b[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** Terminal output as plain text: no colour codes, no carriage-return overdraws, no control characters. */
export function plainOutput(text: string): string {
  return text
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.replace(/\r+$/, '');
      return trimmed.slice(trimmed.lastIndexOf('\r') + 1);
    })
    .join('\n')
    .replace(CONTROL, '')
    .replace(/\s+$/, '');
}

export const OUTPUT_LINES = 12;
const OUTPUT_CHARS = 1200;

/** The start of a long output; `lines` is the full line count. Never hides just a line or two. */
export function clampOutput(text: string, maxLines = OUTPUT_LINES): { text: string; clamped: boolean; lines: number } {
  const lines = text.split('\n');
  let shown = lines.length > maxLines + 2 ? lines.slice(0, maxLines).join('\n') : text;
  if (shown.length > OUTPUT_CHARS + 300) shown = `${shown.slice(0, OUTPUT_CHARS)}…`;
  return { text: shown, clamped: shown !== text, lines: lines.length };
}
