import { SLASH_COMMAND_RE, type SlashCommand } from '../../../shared/protocol.js';
import { oneLine } from '../text.js';

// "/" commands for Hermes. The catalog is the gateway's `commands.catalog`,
// the same data the Hermes desktop app's composer uses
// (hermes-agent tui_gateway/methods_tools.py); this module decides what the
// phone is offered and what it may run.

/** `commands.catalog` result. */
export interface HermesCatalog {
  /** Every `[key, description]`, including skills (which have no category). */
  pairs?: unknown;
  /** `/cmd` → known argument values. */
  sub?: Record<string, unknown>;
  /** Lowercase `/alias` → `/canonical`. */
  canon?: Record<string, unknown>;
  /** `/cmd` → desktop metadata; `desktop` is null when the desktop app offers it. */
  commands?: Record<string, { argument_mode?: unknown; desktop?: unknown } | undefined>;
  categories?: Array<{ name?: unknown; pairs?: unknown }>;
  skills?: Record<string, { usage?: unknown; origin?: unknown } | undefined>;
  warning?: unknown;
}

/** What `slash.exec` / `command.dispatch` return. */
export interface DispatchResult {
  type?: unknown;
  output?: unknown;
  message?: unknown;
  notice?: unknown;
  display?: unknown;
  warning?: unknown;
  target?: unknown;
  command?: unknown;
  name?: unknown;
}

export interface ParsedCommand {
  /** Lowercased, without the slash. */
  name: string;
  /** Everything after the name, inner whitespace and newlines kept. */
  arg: string;
}

export function parseSlash(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!SLASH_COMMAND_RE.test(trimmed)) return null;
  const match = /^\/([^\s/]*)\s*([\s\S]*)$/.exec(trimmed);
  const name = match?.[1]?.toLowerCase() ?? '';
  return name ? { name, arg: match?.[2]?.trim() ?? '' } : null;
}

export function commandLabel(cmd: ParsedCommand): string {
  return oneLine(`/${cmd.name}${cmd.arg ? ` ${cmd.arg}` : ''}`, 200);
}

// Commands that switch safeguards off, answer approvals away from the card that
// shows what's being approved, or upload logs. Refused from the web unless
// Settings → Security → "Hermes safety commands" is on (off by default). Same
// rule as Paseo's "turns everything off" modes.
const BLOCKED: Record<string, { reason: string; args?: RegExp }> = {
  yolo: { reason: 'it turns off approval prompts' },
  approvals: { reason: 'it changes when Hermes asks before acting', args: /\S/ },
  approve: { reason: 'approvals are answered on their card, which shows exactly what will run' },
  debug: { reason: 'it uploads your logs to a shareable link' },
  memory: { reason: 'it changes the memory approval gate', args: /^approval\b/i },
  skills: { reason: 'it changes the skill approval gate', args: /^(approval|approve)\b/i },
};

/** Commands the "Hermes safety commands" setting lets through, in Settings order. */
export const SAFETY_COMMANDS = ['/approve', '/approvals', '/yolo', '/memory approval', '/skills approval', '/debug'];

/**
 * Why this command may not run from Signalbox, or null when it may.
 * `allowSafety`: the "Hermes safety commands" setting is on.
 */
export function blockedReason(cmd: ParsedCommand, allowSafety = false): string | null {
  if (allowSafety) return null;
  const rule = BLOCKED[cmd.name];
  if (!rule || (rule.args && !rule.args.test(cmd.arg))) return null;
  const shown = rule.args ? `/${cmd.name} ${cmd.arg.split(/\s/)[0]}` : `/${cmd.name}`;
  return `For safety, ${shown} can't be run from Wayroost: ${rule.reason}. Turn on Settings → Security → Hermes safety commands, or use the Hermes desktop app or terminal.`;
}

export function canonicalName(name: string, catalog: HermesCatalog | undefined): string {
  const target = catalog?.canon?.[`/${name}`];
  return typeof target === 'string' ? target.replace(/^\//, '').toLowerCase() : name;
}

// Terminal-only or desktop-window features that make no sense on a phone. The
// catalog's `desktop` field already hides most; these slip through it.
const WEB_HIDDEN = new Set([
  'redraw', 'prompt', 'statusbar', 'battery', 'skin', 'indicator', 'voice', 'wake', 'palette',
  'copy', 'paste', 'image', 'pet', 'pets', 'hatch', 'journey', 'quit', 'exit', 'mouse', 'density',
  'details', 'logs', 'resume', 'sessions', 'switch', 'profile', 'sethome', 'topic', 'start',
]);
const NEW_CHAT = new Set(['new', 'reset', 'clear']);

function pairsOf(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((pair) =>
    Array.isArray(pair) && typeof pair[0] === 'string' ? [[pair[0], typeof pair[1] === 'string' ? pair[1] : ''] as [string, string]] : [],
  );
}

/** "Set a title (usage: /title [name])" → description and argument hint. */
export function splitUsage(text: string): { description: string; args: string } {
  const match = /^([\s\S]*?)\s*\(usage: \/\S+\s*([^)]*)\)\s*$/.exec(text);
  return match
    ? { description: oneLine(match[1]!, 200), args: match[2]!.trim() }
    : { description: oneLine(text, 200), args: '' };
}

/** The catalog as the phone's "/" menu shows it: commands by section, then skills by use. */
export function catalogCommands(
  catalog: HermesCatalog,
  options: { newChat?: boolean; allowSafety?: boolean } = {},
): SlashCommand[] {
  const meta = catalog.commands ?? {};
  const aliasesOf = new Map<string, string[]>();
  for (const [alias, target] of Object.entries(catalog.canon ?? {})) {
    if (typeof target !== 'string' || alias.toLowerCase() === target.toLowerCase()) continue;
    const key = target.toLowerCase();
    aliasesOf.set(key, [...(aliasesOf.get(key) ?? []), alias.replace(/^\//, '')]);
  }

  const out: SlashCommand[] = [];
  const seen = new Set<string>();
  const add = (key: string, rawDescription: string, group: string, kind: SlashCommand['kind']) => {
    if (!key.startsWith('/')) return;
    const name = key.slice(1);
    const lower = name.toLowerCase();
    if (!name || /\s/.test(name) || seen.has(lower)) return;
    seen.add(lower);
    if (kind === 'command') {
      const desktop = meta[key]?.desktop;
      if (desktop !== null && desktop !== undefined) return; // the desktop app doesn't offer it either
      if (WEB_HIDDEN.has(lower) || (lower in BLOCKED && !options.allowSafety)) return;
      if (options.newChat && (NEW_CHAT.has(lower) || lower === 'stop')) return;
    }
    const { description, args } = splitUsage(rawDescription);
    const values = catalog.sub?.[key];
    const choices = Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string' && !v.startsWith('-')) : [];
    const aliases = aliasesOf.get(key.toLowerCase());
    out.push({
      name,
      kind,
      ...(description ? { description } : {}),
      ...(args ? { args } : {}),
      ...(choices.length ? { options: choices } : {}),
      group,
      ...(aliases?.length ? { aliases } : {}),
      ...(NEW_CHAT.has(lower) ? { action: 'new' as const } : {}),
    });
  };

  for (const category of catalog.categories ?? []) {
    const group = typeof category.name === 'string' && category.name ? category.name : 'Commands';
    for (const [key, description] of pairsOf(category.pairs)) add(key, description, group, 'command');
  }

  // Skills only appear in the flat list. Most used first, like the desktop app.
  const skills = catalog.skills ?? {};
  const usage = (key: string) => {
    const value = skills[key]?.usage;
    return typeof value === 'number' ? value : 0;
  };
  const skillRows = pairsOf(catalog.pairs)
    .filter(([key]) => key in skills)
    .sort((a, b) => usage(b[0]) - usage(a[0]) || a[0].localeCompare(b[0]));
  for (const [key, description] of skillRows) add(key, description, 'Skills', 'skill');
  return out;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;

/** Command output as plain text: no terminal colour codes or stray control characters. */
export function plainOutput(text: string): string {
  return (
    text
      .replace(ANSI, '')
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .trimEnd()
  );
}
