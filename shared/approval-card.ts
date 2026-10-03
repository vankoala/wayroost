import type { Approval, ApprovalOption, ConversationSummary } from './protocol.js';
import { revealDetail } from './reveal.js';
import { engineOf, roleOf, type Role } from './roles.js';
import { shellWords, type ShellWord } from './shell-words.js';
import { supportedCommand } from './command-grammar.js';

// The words on an approval card, built only from what the
// request carries: its title, its command, file or diff, the options the
// backend offers, and the conversation it came from. Where the request says
// nothing (why it's needed, say), the card says something true and general
// instead of guessing.

/** What a request asks to do, as far as its data shows. */
export type ActionKind =
  'command' | 'edit' | 'write' | 'read' | 'fetch' | 'tool' | 'password' | 'code' | 'login' | 'question';

/** Plain text, or a name to show in the code face (a file, a program). */
export type TitlePart = string | { code: string };

export type RiskLevel = 'Low' | 'Medium' | 'High';

export interface Risk {
  level: RiskLevel;
  /** What it touches, in a few plain words: "deletes files", "one file: auth.ts". */
  touches: string;
  /** Why an unsupported command gets a conservative grade. */
  reason?: string;
}

export interface ApprovalCopy {
  role: Role;
  /** Engine words for Details: "Hermes · claude-sonnet-5", "Paseo · Claude Code". */
  engine: string;
  kind: ActionKind;
  title: TitlePart[];
  /** The title as one string (for labels and the inbox). */
  titleText: string;
  /** The conversation's title, when it's known. */
  task?: string;
  whatHappens: string;
  why: string;
  ifNo: string;
  risk: Risk;
}

function lines(text: string): string[] {
  return text.split('\n');
}

/**
 * Text without the spaces, tabs and line breaks around it: only what the
 * shell itself skips. String.trim() also drops a no-break space, \v, \f,
 * \r and a byte-order mark, which bash keeps as part of a word
 * ("\u00A0npm test" runs a program named "\u00A0npm").
 */
function trimBlanks(text: string): string {
  // Scanned inward from both ends: a regex for the trailing run retries from
  // every blank in the text, and 59,000 spaces before an "x" took seconds.
  const blank = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n';
  let start = 0;
  let end = text.length;
  while (start < end && blank(text[start])) start++;
  while (end > start && blank(text[end - 1])) end--;
  return text.slice(start, end);
}

/** The first line that's an actual command: no blank lines, comments or shebangs. */
function firstCommand(detail: string): string {
  return (
    lines(detail)
      .map(trimBlanks)
      .find((l) => l && !l.startsWith('#')) ?? ''
  );
}

function commandLines(detail: string): number {
  return lines(detail).filter((l) => {
    const t = trimBlanks(l);
    return t && !t.startsWith('#');
  }).length;
}

/** sudo's options that take a value: "-u root", "--user root". */
const SUDO_VALUE = /^(?:-[ugChDprtTU]|--(?:user|group|close-from|chdir|host|prompt|role|type|other-user|command-timeout))$/;

/** A shell variable assignment: NAME=value or NAME+=value, the name unquoted. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;

interface CommandWords {
  /** The program and its arguments. */
  args: ShellWord[];
  /** The variables set for it ("PATH=/tmp npm test" sets PATH). */
  assigned: string[];
}

/**
 * Words of a command's first step as the shell reads them (quotes and escapes
 * resolved), without sudo (and its options) and the variable assignments
 * before the program, which are kept by name.
 */
function words(command: string): CommandWords {
  const first = shellWords(command);
  const step = first.findIndex((w) => w.op);
  const all = step < 0 ? first : first.slice(0, step);
  const at = (i: number) => all[i]!.text;
  const assigned: string[] = [];
  let sudo = false;
  let i = 0;
  while (i < all.length) {
    // The shell takes an assignment only as written ("PATH"=x is a program);
    // sudo takes one from the word it's handed, quotes already gone.
    const name = ASSIGNMENT.exec(sudo ? at(i) : all[i]!.raw)?.[1];
    if (name) {
      assigned.push(name);
      i++;
    } else if (at(i) === 'sudo') {
      sudo = true;
      i++;
      while (i < all.length && at(i).startsWith('-')) {
        const flag = at(i++);
        if (flag === '--') break;
        if (SUDO_VALUE.test(flag)) i++;
      }
    } else break;
  }
  return { args: all.slice(i), assigned };
}

/** rm's operands: what it deletes, as written. Everything after "--" is one, even "-r". */
function rmTargets(args: ShellWord[]): string[] {
  const end = args.findIndex((a) => a.text === '--');
  return args.flatMap((a, i) => (end >= 0 && i > end) || (i !== end && !a.text.startsWith('-')) ? [a.raw] : []);
}

/**
 * Text without a run of these characters at its end. Scanned back from the
 * end: a regex for the run ("/+$") retries from each one in the text, and a
 * word of 59,000 slashes before an "x" took over a second.
 */
function trimEnd(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1]!)) end--;
  return text.slice(0, end);
}

function basename(path: string): string {
  const clean = trimEnd(path, '/\\');
  return clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')) + 1) || clean;
}

/**
 * A file's path inside a project folder ("src/a.ts"), or undefined when the
 * card can't tell it's in there: a path outside it, a relative path (relative
 * to wherever the agent is), "~" (whose home?), or one that climbs out with "..".
 */
function withinProject(path: string, root: string | undefined): string | undefined {
  if (!root || !path.startsWith('/')) return undefined;
  const base = trimEnd(root, '/');
  if (!base || !path.startsWith(`${base}/`)) return undefined;
  const rest = path.slice(base.length).replace(/^\/+/, '');
  const parts = rest.split('/');
  if (!rest || parts.some((p) => p === '..' || p === '.')) return undefined;
  return parts.filter(Boolean).join('/');
}

/** What the backend says a detail is, as the card's kind of action. */
const DETAIL_KINDS: Record<NonNullable<Approval['detailKind']>, ActionKind> = {
  command: 'command',
  edit: 'edit',
  write: 'write',
  read: 'read',
  fetch: 'fetch',
  other: 'tool',
};

export function classify(approval: Approval): ActionKind {
  if (approval.kind === 'question') return 'question';
  if (approval.kind === 'secret') return approval.secret?.input ?? 'password';
  const detail = trimBlanks(approval.detail ?? '');
  // What the backend says comes first: a title is the model's own words, and a
  // command titled "Read file" must still read as a command.
  if (detail && approval.detailKind) return DETAIL_KINDS[approval.detailKind];
  // Hermes only ever sends a command as the detail of a permission request.
  if (detail && approval.source === 'hermes') return 'command';
  // Otherwise the detail is a tool's input or the request's own description,
  // and neither says what the tool does: a description reading
  // "https://example.com" can sit on a request that runs "rm -rf". So it's a
  // tool, named by its title, never a fetch, an edit or a command by looks.
  return 'tool';
}

const PIPE_TO_SHELL = /\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/;

/**
 * Downloads something and pipes it straight into a shell, on one line. Each
 * line is searched from its first curl or wget only, so a line of many of
 * them is read once, not once per download.
 */
function downloadAndRun(text: string): boolean {
  return lines(text).some((line) => {
    const at = line.search(/\b(?:curl|wget)\b/);
    return at >= 0 && PIPE_TO_SHELL.test(line.slice(at));
  });
}

/**
 * Shell syntax that runs more than the first word shows, or somewhere else:
 * substitution ($(...), backticks, <(...)), subshells, redirection, a lone
 * carriage return. Read after fd duplications like 2>&1 are taken out.
 */
const HIDDEN_SYNTAX = /[`<>()\r]|\$\(/;

/** Programs whose real work is another command or inline code they're handed. */
const WRAPPERS =
  /^(?:ba|z|da|k|c|tc|fi)?sh$|^(?:fish|env|xargs|eval|exec|source|\.|command|builtin|nohup|time|timeout|nice|ionice|setsid|stdbuf|chroot|runuser|su|doas|flock|watch|strace|ltrace|parallel)$/;

/**
 * Variables that change which program a name runs (PATH) or load other code
 * into whatever runs (LD_PRELOAD, NODE_OPTIONS...).
 */
const CHANGES_PROGRAM = /^(?:LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_\w+|BASH_ENV|ENV|NODE_OPTIONS)$/;

/** A program in the system's own folders: /bin, /sbin, /usr/bin, /usr/sbin. */
const SYSTEM_PROGRAM = /^\/(?:usr\/)?s?bin\/[^/\\]+$/;

/** A package script named as tests: "test", "tests", "test:unit", "test:e2e". */
const TEST_SCRIPT = /^tests?(?::[\w.:-]+)?$/;

/**
 * A command with its stream joins ("2>&1", ">&2", "<&-") taken out, since
 * they only join output streams, and "&>" written as ">", which it is: a file
 * written to. Only outside quotes: "rm -rf '/srv/2>&1/x'" deletes the folder
 * named that, and its name stays as written. Digits before a join are its
 * descriptor only when they're the whole word, as in bash ("a2>&1" keeps
 * "a2"). One pass, each character looked at once: a regex tried from every
 * digit of a long run of them with no ">&" after it took seconds.
 */
function joinStreams(text: string): string {
  const out: string[] = [];
  // Where the word being read starts in `out`, and whether all of it so far
  // is unquoted digits. In a comment, quotes are only characters.
  let wordAt = 0;
  let digits = true;
  let comment = false;
  let i = 0;
  const separate = () => {
    wordAt = out.length;
    digits = true;
  };
  /** Where a complete descriptor duplication, move or closure ends, or `i` when its operand could be a file. */
  const joinEnd = (): number => {
    if ((text[i] !== '<' && text[i] !== '>') || text[i + 1] !== '&') return i;
    let end = i + 2;
    while (text[end] === ' ' || text[end] === '\t') end++;
    const start = end;
    if (text[end] === '-') end++;
    else {
      while (end < text.length && text[end]! >= '0' && text[end]! <= '9') end++;
      if (end === start) return i;
      if (text[end] === '-') end++;
    }
    // "1.log", "1foo" and "1\".log\"" are whole filenames, not a
    // descriptor followed by another argument. Keep them as written.
    return end === text.length || /[ \t\n;&|()<>]/.test(text[end]!) ? end : i;
  };
  /** Copies a quote from its opening character to its closing `close`, past what a backslash escapes. */
  const quote = (close: string, escapes: boolean) => {
    out.push(text[i++]!);
    while (i < text.length && text[i] !== close) {
      if (escapes && text[i] === '\\' && i + 1 < text.length) out.push(text[i++]!);
      out.push(text[i++]!);
    }
    if (i < text.length) out.push(text[i++]!);
    digits = false;
  };
  while (i < text.length) {
    const c = text[i]!;
    const join = joinEnd();
    if (join > i) {
      // The word before it, if all digits, was its descriptor.
      if (digits && !comment) out.length = wordAt;
      out.push(' ');
      i = join;
      separate();
    } else if (c === '&' && text[i + 1] === '>') {
      out.push('>');
      i += 2;
      separate();
    } else if (c === '\n') {
      comment = false;
      out.push(c);
      i++;
      separate();
    } else if (comment) out.push(text[i++]!);
    else if (c === '\\') {
      out.push(text.slice(i, i + 2));
      i += 2;
      digits = false;
    } else if (c === "'") quote("'", false);
    else if (c === '$' && text[i + 1] === "'") {
      out.push(text[i++]!);
      quote("'", true);
    } else if (c === '"') quote('"', true);
    else if (c === ' ' || c === '\t' || /[;&|()<>]/.test(c)) {
      out.push(text[i++]!);
      separate();
    } else {
      // A comment starts at the start of a word and runs to the end of the line.
      if (c === '#' && out.length === wordAt) comment = true;
      if (c < '0' || c > '9') digits = false;
      out.push(text[i++]!);
    }
  }
  return out.join('');
}

/**
 * "Install packages", "Delete `old-installers`", "Run `make`": what a command
 * does, in plain words. The worst thing anywhere in it decides, and anything
 * with more than one step says so, so a harmless first step can't stand in for
 * what comes after it. Where the shell could hide another command (a lone &,
 * a pipe, $(...), backticks, redirection, bash -c, env, xargs...) the title
 * stays generic and the command itself, shown below it, says the rest.
 */
function commandTitle(detail: string, reading: Reading): TitlePart[] {
  if (downloadAndRun(detail) || reading.downloadRun) return ['Download and run a script'];
  // Too much to read in full: the card can't say what it does.
  if (reading.unread) return ['Run a command'];
  const many = commandLines(detail);
  if (many > 3) return [`Run a ${many}-line script`];
  const shell = joinStreams(detail);
  const steps = shell
    .split(/\n|&&|\|\||\|&|[;&|]/)
    .map(trimBlanks)
    .filter((s) => s && !s.startsWith('#'));
  const hidden = HIDDEN_SYNTAX.test(shell);
  if (steps.length > 1) return [hidden ? 'Run several commands' : `Run ${steps.length} commands`];
  if (hidden) return ['Run a command'];
  const command = firstCommand(shell);
  const { args: all, assigned } = words(command);
  const w = all.map((word) => word.text);
  const named = w[0] ?? '';
  const program = basename(named);
  const sub = w[1] ?? '';
  // A wrapper or an unresolved program could run anything.
  if (WRAPPERS.test(program) || program.includes('$') || all[0]?.expands) return ['Run a command'];
  // With PATH set for it, "npm" is whichever npm that PATH finds first
  // ("PATH=/tmp npm test" runs /tmp/npm), and LD_PRELOAD and the like load
  // other code into any program, so a familiar name says nothing.
  if ((assigned.includes('PATH') && !/[/\\]/.test(named)) || assigned.some((v) => CHANGES_PROGRAM.test(v)))
    return ['Run a command'];
  // A program named by its path ("/tmp/npm", "./npm") is whatever that file
  // is, so it's named by the path; only the system's own folders vouch for a
  // familiar name.
  if (/[/\\]/.test(named) && !SYSTEM_PROGRAM.test(named)) return ['Run ', { code: all[0]!.raw }];
  if (/^(npm|pnpm|yarn|bun)$/.test(program)) {
    if (/^(i|install|add|ci|update|up|upgrade)$/.test(sub) || !sub) return ['Install packages'];
    if (/^(test|t)$/.test(sub)) return ['Run the tests'];
    if (/^(run|run-script)$/.test(sub) && w[2]) {
      // Only a script that's named as tests ("test", "tests", "test:unit") is
      // called tests; "latest-deploy" or "contest-cleanup" could do anything.
      return TEST_SCRIPT.test(w[2]) ? ['Run the tests'] : ['Run the ', { code: w[2] }, ' script'];
    }
    if (sub === 'publish') return ['Publish a package'];
  }
  if (
    /^(pip|pip3|uv|poetry|cargo|apt|apt-get|brew|dnf|yum|pacman|winget|gem|go)$/.test(program) &&
    /^(install|add|get)$/.test(sub)
  ) {
    return ['Install packages'];
  }
  if (/^(pytest|vitest|jest|mocha)$/.test(program) || (/^(go|cargo)$/.test(program) && sub === 'test'))
    return ['Run the tests'];
  if (program === 'rm' || program === 'rmdir' || (program === 'find' && /\s-delete\b/.test(command))) {
    // The target exactly as written: shortening /home/<name> to ~ would turn
    // another user's folder, or a wildcard over every home, into "your" home.
    const targets = program === 'find' ? [] : rmTargets(all.slice(1));
    return targets.length === 1 ? ['Delete ', { code: targets[0]! }] : ['Delete files'];
  }
  if (program === 'git') {
    if (sub === 'push') return ['Push changes to the remote'];
    if (sub === 'commit') return ['Commit changes'];
    if (/^(reset|clean|rebase)$/.test(sub)) return ['Rewrite or discard git changes'];
  }
  if (program === 'curl' || program === 'wget') return ['Download from the internet'];
  if (program === 'mv') return ['Move files'];
  if (program === 'cp') return ['Copy files'];
  if (program === 'chmod' || program === 'chown') return ['Change file permissions'];
  if (program === 'mkdir') return ['Create a folder'];
  if (program === 'systemctl' || program === 'service') return ['Change a system service'];
  if (program === 'kill' || program === 'pkill' || program === 'killall') return ['Stop a running program'];
  if (!program) return ['Run a command'];
  return ['Run ', { code: program }];
}

/**
 * A title part with invisible and direction-changing characters made visible,
 * the same way as in the request's detail: a title is cut from model-written
 * text (a path, a program, a host), and it's the largest text on the card.
 */
function shown(part: TitlePart): TitlePart {
  return typeof part === 'string' ? visible(part) : { code: visible(markSpaces(part.code)) };
}

/**
 * Every kind of space or line break but a plain space, made visible in a name
 * the title shows: "npm\u00A0test" is one program's name, and a path whose
 * folder name ends in a line break isn't the folder it looks like.
 */
function markSpaces(text: string): string {
  return text.replace(/[^\S ]/gu, (ch) => `\u27E8U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}\u27E9`);
}

const textOf = (parts: TitlePart[]) => parts.map((p) => (typeof p === 'string' ? p : p.code)).join('');

const LEVELS: RiskLevel[] = ['Low', 'Medium', 'High'];
/** The worst of two grades. Two at a time: a list as long as a request is never spread into a call. */
const worst = (a: RiskLevel | undefined, b: RiskLevel): RiskLevel =>
  a && LEVELS.indexOf(a) > LEVELS.indexOf(b) ? a : b;

/** A flag that makes rm recursive or forced: -r, -R, -f in any cluster, or --recursive/--force or a prefix rm accepts. */
function forcingRmFlag(arg: string): boolean {
  if (/^-[a-zA-Z]*[rRf]/.test(arg)) return true;
  const long = /^--([a-z-]+)(?:=|$)/.exec(arg)?.[1];
  return !!long && ('recursive'.startsWith(long) || 'force'.startsWith(long));
}

const SHELL_EXPANSION_REASON = 'The command uses shell expansion that Wayroost does not resolve.';

/**
 * The small part of shell execution this card understands. Check actual
 * command positions, not quoted mentions in arguments. Everything outside
 * it gets High: enumerating stdin aliases or guessing a function's input
 * cannot establish what sourced files, functions or interpreters will run.
 */
function executionReason(words: ShellWord[]): string | undefined {
  if (words.some((word) => word.expands)) return SHELL_EXPANSION_REASON;
  let lead = true;
  let target = false;
  let program = '';
  let args: string[] = [];
  let needsCommand = false;
  const check = () => program && !supportedCommand(program, args)
    ? 'The options or arguments are outside the command grammar recognised by the card.'
    : undefined;
  for (const word of words) {
    if (word.op) {
      if (word.redirect) {
        if (word.text.startsWith('<<')) return 'Code or input supplied by a here-document is not fully analysed.';
        target = true;
      } else {
        if (word.text === '(' || word.text === ')')
          return 'Shell groups and function definitions are not fully analysed.';
        if (target) return 'An incomplete redirection is not fully analysed.';
        const reason = check();
        if (reason) return reason;
        needsCommand = word.text === '|' || word.text === '&';
        program = '';
        args = [];
        lead = true;
        target = false;
      }
      continue;
    }
    if (word.specialQuote || word.incomplete)
      return 'Shell quoting or an incomplete word is outside the grammar recognised by the card.';
    if (target) {
      target = false;
      continue;
    }
    if (!lead) {
      args.push(word.text);
      continue;
    }
    const assigned = ASSIGNMENT.exec(word.raw)?.[1];
    if (assigned) {
      return 'The environment can change which code this command runs.';
    }
    program = basename(word.text);
    if (program === '.' || program === 'source')
      return 'The sourced file can run code the card cannot read.';
    if (word.raw === 'function' || word.raw === '{' || word.raw === '}')
      return 'Shell groups and function definitions are not fully analysed.';
    if (WRAPPERS.test(program))
      return 'This command can run other code the card cannot fully analyse.';
    if (/[/\\]/.test(word.text) && !SYSTEM_PROGRAM.test(word.text))
      return 'The program or function is outside the commands recognised by the card.';
    if (!/^(?::|true|false|echo|printf|pwd|cd|ls|cat|head|tail|wc|grep|rm|rmdir|mkdir|cp|mv|touch|chmod|chown|curl|wget|npm|pnpm|yarn|git|find)$/.test(program))
      return 'The program or function is outside the commands recognised by the card.';
    // The tracked program and its arguments are checked at the end of the
    // step. Options and operands after redirections still belong to it.
    args = [];
    needsCommand = false;
    lead = false;
  }
  if (target || needsCommand) return 'An incomplete command or redirection is not fully analysed.';
  return check();
}

/** What the shell could do with a command, read from its words at every depth. */
interface Reading {
  /**
   * A recursive or forced rm, however its flags are spelled, quoted or escaped
   * (rm -R, rm "-r", rm \-r, rm $'-r', rm --rec) and wherever they stand among
   * its arguments, before or after a redirection. An argument from an
   * expansion ($FLAGS, "$f", $(...), <(...)) could be such a flag too.
   */
  forcedRm: boolean;
  /**
   * Something piped into a shell, however the shell's name is spelled:
   * "| sh", '| "sh"', "| s\\h", "| sudo -u root bash", "| env sh".
   */
  pipedShell: boolean;
  /** A download (curl, wget) piped into a shell on the same line. */
  downloadRun: boolean;
  /** sudo, however it's spelled. */
  sudo: boolean;
  /**
   * More than the card reads in full: text nested too deeply, or more of it
   * than READ_BUDGET. What wasn't read could be anything, so it's graded as
   * the worst.
   */
  unread: boolean;
  /** Unsupported execution in the actual command, apart from quoted data read again for hazards. */
  reason?: string;
}

/** A shell, by its program's name. */
const SHELL = /^(?:ba|z|da|k|c|tc|fi)?sh$/;

/**
 * Words before a step's program: "!", "time", and the reserved words that
 * open a compound command or one of its parts ("| { sh; }", "| while read l;
 * do sh; done"). Assignments are too. Only unquoted: '"time" -p sh' runs the
 * program time, which runs sh.
 */
const BEFORE_PROGRAM = /^(?:!|\{|time|if|then|elif|else|while|until|do)$/;
/**
 * Reserved words that open a compound command, whose commands all read the
 * input it's given, and the ones that close it. After for, select and case
 * come names and patterns, not a program.
 */
const OPENS = /^(?:\{|if|while|until|for|select|case)$/;
const CLOSES = /^(?:\}|fi|done|esac)$/;
const NAMES_FOLLOW = /^(?:for|select|case)$/;

/** What a piece of text read again gets on its input: nothing, a pipe, or a pipe from a download. */
type Inherited = 0 | 1 | 2;

/** A literal absolute stdin alias, with known symlinks resolved before "." and "..", without reading any file. */
function stdinFile(path: string): boolean {
  if (!path.startsWith('/')) return false;
  const parts = path.split('/');
  const last = parts[parts.length - 1];
  // These aliases are files: a trailing slash or "/." requires a directory.
  if (!last || last === '.' || last === '..') return false;
  // /dev/fd points to /proc/self/fd; self names this process, and
  // thread-self names this process's task/<thread>. Their IDs aren't known.
  const processId = Symbol();
  const threadId = Symbol();
  const normalized: Array<string | symbol> = [];
  const stdin = () =>
    (normalized.length === 2 && normalized[0] === 'dev' && normalized[1] === 'stdin') ||
    (normalized[0] === 'proc' && normalized[1] === processId && (
      (normalized.length === 4 && normalized[2] === 'fd' && normalized[3] === '0') ||
      (normalized.length === 6 && normalized[2] === 'task' && normalized[3] === threadId &&
        normalized[4] === 'fd' && normalized[5] === '0')
    ));
  for (const part of parts) {
    // A stdin alias is a file, so no further path component can follow it.
    if (stdin()) return false;
    if (part === '..') normalized.pop();
    else if (part && part !== '.') normalized.push(part);
    if (normalized.length === 2) {
      if (normalized[0] === 'dev' && normalized[1] === 'fd')
        normalized.splice(0, 2, 'proc', processId, 'fd');
      else if (normalized[0] === 'proc' && normalized[1] === 'self') normalized[1] = processId;
      else if (normalized[0] === 'proc' && normalized[1] === 'thread-self')
        normalized.splice(1, 1, processId, 'task', threadId);
    }
  }
  return stdin();
}

/** How many characters reading a command may look at, words made from them included. */
const READ_BUDGET = 1_000_000;
/** How deep text handed on as one word is read again (bash -c "sh -c '...'"). */
const READ_DEPTH = 8;

/**
 * Reads a command's words the way the shell does; nothing is run. Text handed
 * on as one word (bash -c "rm -rf x", $(rm -rf x), a tool's JSON input) is read
 * again the same way, so a mention of a forced delete in a quoted string
 * counts as well. Each distinct piece of text is read once, and all of it
 * together at most READ_BUDGET characters, keeping nested input bounded.
 */
function readShell(command: string): Reading {
  const reading: Reading = { forcedRm: false, pipedShell: false, downloadRun: false, sudo: false, unread: false };
  // Each piece of text read so far, and whether it had a download in it.
  const seen = new Map<string, boolean>();
  let left = READ_BUDGET;
  /**
   * Reads one piece of text; whether it has a curl or wget anywhere in it.
   * `inherited`: what the commands in it read when it's an expansion run in a
   * step that's piped into ("curl ... | echo $(sh)" runs sh on the download).
   */
  const read = (text: string, depth: number, inherited: Inherited): boolean => {
    const words = shellWords(text);
    if (depth === 0) reading.reason = executionReason(words);
    left -= text.length + words.reduce((n, w) => n + w.text.length, 0);
    if (left < 0) {
      reading.unread = true;
      return false;
    }
    // One pass over the words: whether we're among an rm's options, which run
    // to the next operator or "--". Each word is looked at once, so a command
    // full of "rm" words takes no longer than any other of its length. A
    // redirection ("2>&1", "> log") doesn't end the command: the word after it
    // is only where it points, and rm's own words carry on after that.
    let options = false;
    let target = false;
    // Pipes, from the words as the shell reads them, so '| "sh"' and "| s\\h"
    // are the "| sh" they run: the operators since the last word, whether
    // this step's input is the step before's output, whether we're still
    // before its program, and whether that program runs another one (sudo,
    // env, xargs...) that could be a shell. `download`: a curl or wget so far
    // on this line; `downloads`: anywhere in the text.
    //
    // A group ("{ ...; }", "( ... )") or other compound command (if, while,
    // for, case) passes its input on to every command in it, so
    // "curl ... | { :; sh; }" runs sh on the download as "| sh" does. `groups`
    // holds, for each one open, whether its input is piped; a separator
    // inside it goes back to that rather than to no pipe at all. In a case,
    // "(" and ")" belong to its patterns.
    let joint = '';
    const groups: Array<{ piped: boolean; isCase: boolean }> = [];
    const outer = () => (groups.length ? groups[groups.length - 1]!.piped : inherited > 0);
    const inCase = () => !!groups[groups.length - 1]?.isCase;
    // Text read again starts with its own words, not commands: a separator
    // (each opened expansion is one) is where the inherited input starts.
    let piped = false;
    let lead = true;
    let wraps = false;
    // A function's name is a header, not a program; its body keeps this input.
    let functionName = false;
    let download = inherited === 2;
    let downloads = false;
    // eval joins its words with spaces and reads them as a command again, in
    // this shell and on this step's input, so "curl ... | eval '\"sh\"'" runs
    // sh on the download. `evals`: the words after it in this step, read
    // again when the step ends. `sources`: the word before was "." or source
    // (1), or the one "--" they take before the file's name (2).
    let evals: ShellWord[] | undefined;
    let evalPiped = false;
    let sources: 0 | 1 | 2 = 0;
    // `timing`: the word before was the reserved word time (1), or its "-p"
    // (2). Then come its one "-p" and one "--", unquoted, before the program:
    // "time -p sh" and "time -p -- sh" run sh, "time -p -p sh" runs "-p".
    let timing: 0 | 1 | 2 = 0;
    /** Reads a piece of this text again; whether to stop, with all that's left unread. */
    const again = (inner: string, passes: Inherited): boolean => {
      const key = `${passes}${inner}`;
      let had = seen.get(key);
      if (had === undefined) {
        seen.set(key, false);
        if (depth >= READ_DEPTH) reading.unread = true;
        else seen.set(key, (had = read(inner, depth + 1, passes)));
        if (reading.unread) return true;
      }
      // "bash -c 'curl ...' | sh" downloads on this line too.
      if (had) download = downloads = true;
      return false;
    };
    /** Reads the words an eval was given, once its step ends; whether to stop. */
    const evaluate = (): boolean => {
      // eval takes one "--" before its words as the end of its options, as
      // every builtin does: "eval -- '\"sh\"'" runs sh. A second is a word.
      const given = evals?.[0]?.text === '--' ? evals.slice(1) : evals;
      evals = undefined;
      if (!given?.length) return false;
      // Text the card can't know ("eval \"$(cat)\"") run on piped input could
      // be the input itself.
      if (evalPiped && given.some((w) => w.expands)) reading.pipedShell = true;
      // The ";" in front is where the step's input starts, as for an expansion.
      return again(` ; ${given.map((w) => w.text).join(' ')}`, evalPiped ? (download ? 2 : 1) : 0);
    };
    for (const word of words) {
      if (word.op) {
        target = !!word.redirect;
        if (!word.redirect) {
          options = false;
          joint += word.text;
        }
        continue;
      }
      if (joint) {
        if (evaluate()) return downloads;
        // "|" and "|&" pipe into the next step, across line breaks; "||",
        // "&&", ";", "&" and a line break start a step that reads the group's
        // input. "(" opens a group and ")" closes one.
        let pipe = false;
        for (let i = 0; i < joint.length; i++) {
          const c = joint[i];
          if (c === '|' && joint[i + 1] !== '|') {
            piped = pipe = true;
            if (joint[i + 1] === '&') i++;
            continue;
          }
          if (c === '\n' && pipe) continue;
          pipe = false;
          if (c === '|') i++;
          if (c === '(' && !inCase()) groups.push({ piped, isCase: false });
          else if (c === ')' && !inCase()) {
            groups.pop();
            piped = outer();
          } else if (c !== '(' && c !== ')') piped = outer();
        }
        if (!piped && joint.includes('\n')) download = false;
        joint = '';
        lead = true;
        wraps = false;
        functionName = false;
        sources = 0;
        timing = 0;
      }
      if (functionName) {
        functionName = false;
        continue;
      }
      // A word holding a space, or an expansion that runs or picks text
      // ($(...), `...`, <(...), and ${...}, whose "${x:-$(rm -rf y)}" runs its
      // command when x isn't set), is read again with each expansion opened
      // up into a step of its own. Opening ${ too means the body isn't read as
      // the same one word again and again.
      if (/\s|\$[({]|[<>]\(|`/.test(word.text)) {
        const inner = word.text.replace(/\$[({]|[<>]\(|`/g, ' ; ');
        // A command an expansion runs reads this step's input.
        const passes: Inherited = piped && /\$\(|[<>]\(|`/.test(word.text) ? (download ? 2 : 1) : 0;
        if (again(inner, passes)) return downloads;
      }
      if (target) {
        target = false;
        continue;
      }
      const name = basename(word.text);
      // A reserved word only counts unquoted and where a program would be.
      if (lead && word.raw === word.text) {
        if (word.text === 'function') {
          functionName = true;
          continue;
        }
        if (OPENS.test(word.text)) groups.push({ piped, isCase: word.text === 'case' });
        else if (CLOSES.test(word.text)) {
          groups.pop();
          lead = false;
          wraps = false;
          continue;
        }
        if (NAMES_FOLLOW.test(word.text)) {
          lead = false;
          wraps = false;
          continue;
        }
      }
      if (options) {
        if (word.text === '--') options = false;
        else if (word.expands || forcingRmFlag(word.text)) reading.forcedRm = true;
      }
      if (name === 'rm') options = true;
      if (name === 'sudo') reading.sudo = true;
      if (name === 'curl' || name === 'wget') download = downloads = true;
      if (evals) evals.push(word);
      // Whether this word could be what runs: the step's program, or a word
      // after a program that runs another one.
      let runs = wraps;
      const reserved = lead && word.raw === word.text;
      const timeOption: boolean = reserved && (word.text === '--' ? timing > 0 : word.text === '-p' && timing === 1);
      timing = reserved && word.text === 'time' ? 1 : timeOption && word.text === '-p' ? 2 : 0;
      if (lead && !timeOption && !(reserved && BEFORE_PROGRAM.test(word.text)) && !ASSIGNMENT.test(word.raw)) {
        lead = false;
        wraps = name === 'sudo' || WRAPPERS.test(name);
        runs = true;
      }
      const sourced = sources > 0;
      // ". -- /dev/stdin" reads the same file: "--" ends the options, once.
      sources = runs && (name === '.' || name === 'source') ? 1 : sources === 1 && word.text === '--' ? 2 : 0;
      if (!runs) continue;
      if (name === 'eval' && !evals) {
        evals = [];
        evalPiped = piped;
      }
      // ". /dev/stdin" runs its input as a shell does.
      if (piped && (SHELL.test(name) || (sourced && stdinFile(word.text)))) {
        reading.pipedShell = true;
        if (download) reading.downloadRun = true;
      }
    }
    evaluate();
    return downloads;
  };
  read(command, 0, 0);
  return reading;
}

/**
 * Anything in the text that could do great harm: a forced delete, root, a
 * wiped disk, code from the internet, or more than the card could read.
 */
function dangerous(text: string, reading: Reading): boolean {
  return (
    reading.forcedRm ||
    reading.pipedShell ||
    reading.sudo ||
    reading.unread ||
    /\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\bsudo\b|\bmkfs|\bdd\s+if=|\bchmod\s+-R|\bchown\s+-R|--force\b|--data\s+@|>\s*\/dev\/sd/.test(
      text,
    )
  );
}

/** A rough grade of what a request could do, from its own data; shown under Details. */
function riskOf(approval: Approval, kind: ActionKind, file?: string, reading?: Reading): Risk {
  const detail = approval.detail ?? '';
  // A security scan grades what it found; its worst finding counts too. Each
  // grade is looked for once rather than every marker collected: a title can
  // hold as many markers as the request likes.
  const title = approval.title;
  const scanned: RiskLevel | undefined = title.includes('[HIGH]')
    ? 'High'
    : title.includes('[MEDIUM]')
      ? 'Medium'
      : title.includes('[LOW]')
        ? 'Low'
        : undefined;
  switch (kind) {
    case 'command': {
      const read = reading ?? readShell(detail);
      // Known hazards retain their specific labels. Missing one is never
      // evidence of Medium: unsupported execution gets an explicit fallback.
      if (read.reason && !dangerous(detail, read))
        return { level: 'High', touches: 'not fully analysed', reason: read.reason };
      const touches =
        downloadAndRun(detail) || read.downloadRun
          ? 'runs code from the internet'
          : /\bsudo\b/.test(detail) || read.sudo
            ? 'runs as administrator'
            : read.forcedRm || /\s-delete\b|\brmdir\b/.test(detail)
              ? 'deletes files'
              : read.unread
                ? 'could do anything'
                : /\b(curl|wget|npm|pnpm|yarn|pip|git\s+(push|pull|clone))\b/.test(detail)
                  ? /\b(?:npm|pnpm|yarn)\b/.test(detail) ? 'runs project code' : 'your files and the network'
                  : 'files on your PC';
      return {
        level: worst(scanned, dangerous(detail, read) ? 'High' : 'Medium'), touches,
        ...(read.reason === SHELL_EXPANSION_REASON ? { reason: read.reason } : {}),
      };
    }
    case 'edit':
    case 'write':
      return { level: worst(scanned, 'Medium'), touches: file ? `one file: ${file}` : 'a file' };
    case 'read':
      return { level: worst(scanned, 'Low'), touches: file ? `reads ${file}` : 'reads a file' };
    case 'fetch':
      return { level: worst(scanned, 'Low'), touches: 'reads from the internet' };
    case 'password':
      return { level: 'High', touches: /\bsudo\b/i.test(approval.title) ? 'runs as administrator' : 'a password' };
    case 'code':
      return { level: 'Medium', touches: 'signs in to an account' };
    case 'login':
      return { level: 'Medium', touches: 'saves a password' };
    case 'question':
      return { level: 'Low', touches: 'only your answer' };
    default:
      // Without a structured action, even input that looks like a harmless
      // command cannot establish what the tool executes.
      return {
        level: 'High',
        touches: 'not fully analysed',
        reason: 'The tool input has no structured action the card can fully analyse.',
      };
  }
}

/**
 * Text from the request, the agent or its project, with invisible and
 * direction-changing characters made visible. Everything the card shows that
 * it didn't write itself goes through this.
 */
export function visible(text: string): string {
  return revealDetail(text).text;
}

export function describeApproval(approval: Approval, conversation?: ConversationSummary): ApprovalCopy {
  const named = roleOf(approval.source, conversation);
  // A role with no fitting name is the agent's own label.
  const role: Role = { ...named, name: visible(named.name) };
  const who = role.name;
  const kind = classify(approval);
  const detail = trimBlanks(approval.detail ?? '');
  // A command, or a tool's input that could hold one, read once for both its title and its risk.
  const reading = kind === 'command' || kind === 'tool' ? readShell(detail) : undefined;
  const project = conversation?.project?.name === undefined ? undefined : visible(conversation.project.name);
  const task = conversation?.title === undefined ? undefined : visible(conversation.title);
  // The file's whole path, as the backend gives it apart from the detail: a
  // path can hold a line break ("billing/src\n/../../../etc/sudoers"), so the
  // detail's first line could be only the start of it. Without it, the card
  // doesn't name a file.
  const target = kind === 'edit' || kind === 'write' || kind === 'read' ? (approval.filePath ?? '') : '';
  const file = target ? visible(markSpaces(basename(target))) : undefined;
  // "Edit src/a.ts in billing" only when the path is inside the project's
  // folder; anything else ("/etc/sudoers") is named by its whole path.
  const inside = target ? withinProject(target, conversation?.project?.path) : undefined;
  const fileTitle = (verb: string): TitlePart[] =>
    !target
      ? [`${verb}a file`]
      : inside !== undefined && project
        ? [verb, { code: inside }, ' in ', { code: project }]
        : [verb, { code: target }];

  let title: TitlePart[];
  let whatHappens: string;
  let ifNo: string;
  const told = `${who} is told you said no.`;
  switch (kind) {
    case 'command':
      // The chat's project isn't where a command runs (a worktree, a cd, an
      // absolute path), so neither the title nor this row names it as such.
      title = commandTitle(detail, reading!);
      whatHappens = 'Runs this on your PC:';
      ifNo = `The command doesn't run. ${told}`;
      break;
    case 'edit':
      title = fileTitle('Edit ');
      whatHappens = 'Changes this file. Lines starting with + are added, lines starting with - are removed:';
      ifNo = `The file stays as it is. ${told}`;
      break;
    case 'write':
      title = fileTitle('Write ');
      whatHappens = 'Creates this file, or replaces it if it exists:';
      ifNo = `The file stays as it is. ${told}`;
      break;
    case 'read':
      title = fileTitle('Read ');
      whatHappens = 'Reads this file. Nothing is changed:';
      ifNo = `${who} doesn't read it. ${told}`;
      break;
    case 'fetch': {
      let host = detail;
      try {
        host = new URL(detail).host;
      } catch {
        // keep the address as it is
      }
      title = ['Open ', { code: host }];
      whatHappens = 'Opens this address on the internet:';
      ifNo = `Nothing is opened. ${told}`;
      break;
    }
    case 'password': {
      const sudo = /\bsudo\b/i.test(approval.title);
      const named = approval.title.match(/asks for (.+)$/i)?.[1];
      title = sudo
        ? ['Enter your sudo password']
        : /vault/i.test(approval.title)
          ? ['Unlock the vault']
          : named && !/password|secret/i.test(named)
            ? ['Enter ', { code: named }]
            : ['Enter a password'];
      whatHappens = sudo
        ? detail
          ? `Your password goes once to ${who}, to run this as administrator:`
          : `Your password goes once to ${who}, to run something as administrator. It didn't say what.`
        : `What you type goes once to ${who}. It isn't stored or shown again.`;
      ifNo = sudo ? `Nothing is sent and nothing runs. ${told}` : `Nothing is sent. ${told}`;
      break;
    }
    case 'code':
      title = ['Enter a one-time code'];
      whatHappens = `The code goes once to ${who}, to finish signing in. It isn't stored or shown again.`;
      ifNo = `Nothing is sent. ${who} can't finish this step.`;
      break;
    case 'login':
      title = [approval.title];
      whatHappens = `Saves this login in ${who}'s vault, so it can sign in for you next time${detail ? ':' : '.'}`;
      ifNo = `Nothing is saved. ${told}`;
      break;
    case 'question':
      title = [approval.title];
      whatHappens = `Your answer goes to ${who}, which carries on with it.`;
      ifNo = `${who} carries on without your answer, or stops.`;
      break;
    default: {
      const tool = approval.title.match(/^Use (\S+)$/)?.[1];
      title = tool ? ['Use ', { code: tool }] : [approval.title];
      whatHappens = detail ? `Uses a tool with these settings:` : `Uses a tool: ${visible(approval.title)}.`;
      ifNo = `Nothing happens. ${told}`;
    }
  }

  title = title.map(shown);
  // The project is what the chat works on: context for why, not a place.
  const on = project ? ` in the ${project} project` : '';
  const why = task
    ? `${who} asked while working on “${task}”${on}.`
    : project
      ? `${who} asked while working${on}.`
      : `${who} asked before going ahead.`;

  return {
    role,
    engine: visible(engineOf(approval.source, conversation)),
    kind,
    title,
    titleText: textOf(title),
    ...(task ? { task } : {}),
    whatHappens,
    why,
    ifNo,
    risk: riskOf(approval, kind, file, reading),
  };
}

// ---- Buttons ------------------------------------------------------------------

export interface ArrangedOptions {
  /** "Allow once": the one-time allow. */
  allow?: ApprovalOption;
  /** "Don't allow". */
  deny?: ApprovalOption;
  /** The backend's "always" choice, behind the checkbox. Only when there's also a one-time allow. */
  always?: ApprovalOption;
  /** Everything else the backend offers ("Allow for this chat", more choices), under "More choices". */
  more: ApprovalOption[];
}

/**
 * Lay out a permission request's options. Nothing the backend offers is
 * dropped, and nothing stands in for a choice it doesn't offer: without a
 * one-time allow there's no "Allow once" button, and "Allow for this chat"
 * stays under More choices.
 */
export function arrangeOptions(options: ApprovalOption[]): ArrangedOptions {
  const allow = options.find((o) => o.kind === 'allow');
  const deny = options.find((o) => o.kind === 'deny');
  const always = allow?.kind === 'allow' ? options.find((o) => o.kind === 'allow_always') : undefined;
  const placed = new Set([allow, deny, always].filter(Boolean));
  return {
    ...(allow ? { allow } : {}),
    ...(deny ? { deny } : {}),
    ...(always ? { always } : {}),
    more: options.filter((o) => !placed.has(o)),
  };
}

const PLAIN_ALLOW = /^(allow|allow once|approve|yes|accept|ok|run|continue)$/i;
const PLAIN_DENY = /^(deny|reject|no|decline|don'?t allow|cancel)$/i;

/** The card's words for an option, unless the backend's own label says something more. */
export function buttonLabel(option: ApprovalOption): string {
  if (option.kind === 'allow' && PLAIN_ALLOW.test(option.label.trim())) return 'Allow once';
  if (option.kind === 'deny' && PLAIN_DENY.test(option.label.trim())) return "Don't allow";
  return visible(option.label);
}

const KIND_NOUNS: Partial<Record<ActionKind, string>> = {
  command: 'commands like this',
  edit: 'file edits',
  write: 'new files',
  read: 'file reads',
  fetch: 'web requests',
  tool: 'this tool',
};

/**
 * The words beside the "always" checkbox: what the permission really covers.
 * Hermes' "always" (allow_permanent) adds the request's pattern to its one
 * allowlist for every chat, so the card can say that. A Paseo agent's own
 * option says its own scope ("Always allow all commands in all projects"),
 * which the card can't know, so its words are kept as they are.
 */
export function alwaysLabel(approval: Approval, always: ApprovalOption, kind: ActionKind): string {
  if (approval.source === 'hermes') return `Allow ${KIND_NOUNS[kind] ?? 'this kind of request'} everywhere without asking`;
  return visible(always.label);
}

// ---- Time ---------------------------------------------------------------------

const MINUTE = 60_000;

/** "just now", "2 minutes ago", "9:41", "Yesterday", "Sep 3". */
export function askedAt(ms: number, now = Date.now()): string {
  const diff = now - ms;
  if (diff < MINUTE) return 'just now';
  if (diff < 60 * MINUTE) {
    const m = Math.floor(diff / MINUTE);
    return `${m} ${m === 1 ? 'minute' : 'minutes'} ago`;
  }
  const at = new Date(ms);
  const today = new Date(now);
  if (at.toDateString() === today.toDateString())
    return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
