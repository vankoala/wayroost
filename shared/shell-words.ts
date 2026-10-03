// Splits a shell command into the words the shell would hand a program, the
// way a POSIX shell (bash) reads quotes and escapes, without running anything.
// Only for reading a command on an approval card: expansions ($VAR, $(...),
// backticks, <(...), filename patterns) aren't evaluated, they're marked as
// unknown. Brace expansion ({a,b}, {1..3}) is left unresolved too.

export interface ShellWord {
  /** The word as the program gets it: quotes removed, escapes resolved. */
  text: string;
  /** The word exactly as written. */
  raw: string;
  /**
   * Part of it comes from shell expansion (variables, substitutions, braces,
   * filename patterns, history or unsupported tildes), so its value is unknown.
   */
  expands?: boolean;
  /** ANSI-C or locale-translated quoting, outside the approval card's supported grammar. */
  specialQuote?: boolean;
  /** A quote or escape that does not finish in the supplied text. */
  incomplete?: boolean;
  /** A control operator or redirection: ; & | ( ) < > or a line break. */
  op?: boolean;
  /**
   * A redirection (">", "2>&", "&>>", "<<"...), with its file descriptor in
   * `raw`. It doesn't end a command: the word after it is where it points,
   * and the command's own words carry on after that.
   */
  redirect?: boolean;
}

const OPERATOR = /[;&|()<>\n]/;
/** Bash's redirection operators, longest first. */
const REDIRECTION = /&>>|&>|>>|>&|>\||<<<|<<-|<<|<&|<>|>|</y;
const SIMPLE_ESCAPES: Record<string, string> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

const UTF8 = new TextEncoder();
// ignoreBOM: a leading U+FEFF is part of the word (a program named "\uFEFFnpm"
// isn't npm); the default decoder would drop it.
const FROM_UTF8 = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * A $'...' string from just after its opening quote: [its value, the index of
 * its closing quote]. As in bash, \nnn and \xHH are one byte each (\562 is
 * 0o562 & 0xff, an "r"), \u and \U a character, and the bytes are read as
 * UTF-8 at the end; a NUL byte ends the value, dropping the rest of the quote.
 */
function ansiC(text: string, start: number): [string, number] {
  const bytes: number[] = [];
  let ended = false;
  const add = (...more: number[]) => {
    for (const b of more) {
      if (ended) return;
      if (b === 0) ended = true;
      else bytes.push(b);
    }
  };
  const addText = (t: string) => add(...UTF8.encode(t));
  let i = start;
  while (i < text.length && text[i] !== "'") {
    if (text[i] !== '\\' || i + 1 >= text.length) {
      const ch = String.fromCodePoint(text.codePointAt(i)!);
      addText(ch);
      i += ch.length;
      continue;
    }
    const c = text[i + 1]!;
    i += 2;
    const digits = (pattern: RegExp, max: number): string => {
      let d = '';
      while (d.length < max && i < text.length && pattern.test(text[i]!)) d += text[i++];
      return d;
    };
    if (c in SIMPLE_ESCAPES) addText(SIMPLE_ESCAPES[c]!);
    else if (/[0-7]/.test(c)) add(parseInt(c + digits(/[0-7]/, 2), 8) & 0xff);
    else if (c === 'x') {
      const hex = digits(/[0-9a-fA-F]/, 2);
      if (hex) add(parseInt(hex, 16));
      else addText('\\x');
    } else if (c === 'u' || c === 'U') {
      const hex = digits(/[0-9a-fA-F]/, c === 'u' ? 4 : 8);
      const code = hex ? parseInt(hex, 16) : NaN;
      if (code === 0) add(0);
      else addText(Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : `\\${c}${hex}`);
    } else if (c === 'c' && i < text.length) {
      const x = text[i++]!;
      add(x === '?' ? 0x7f : x.toUpperCase().charCodeAt(0) & 0x1f);
    } else addText(`\\${c}`);
  }
  return [FROM_UTF8.decode(new Uint8Array(bytes)), i];
}

/** The index just past a $(...), ${...}, $[...] or `...` at `start`, nesting counted. */
function expansionEnd(text: string, start: number): number {
  if (text[start] === '`') {
    let i = start + 1;
    while (i < text.length && text[i] !== '`') i += text[i] === '\\' ? 2 : 1;
    return Math.min(i + 1, text.length);
  }
  const open = text[start + 1]!;
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i + 1;
  }
  return text.length;
}

/** Unquoted brace, history and unsupported tilde syntax stays unresolved. */
function unresolvedWord(word: string, plain: boolean[]): boolean {
  let brace = false;
  let separator = false;
  for (let i = 0; i < word.length; i++) {
    if (!plain[i]) continue;
    const c = word[i];
    if (c === '!' || (c === '~' && !(i === 0 && (word.length === 1 || word[1] === '/')))) return true;
    // Bash can treat an early } as literal ({a}b,c}). Conservatively retain
    // any opening brace for a later separator and unquoted closing brace.
    if (c === '{') brace = true;
    else if (brace && (c === ',' || (c === '.' && word[i + 1] === '.' && plain[i + 1]))) separator = true;
    else if (c === '}' && separator) return true;
  }
  return false;
}

/** Whether a $ at `i` starts an expansion rather than standing for itself. */
const expandsAt = (text: string, i: number) => /[A-Za-z0-9_{(\[@*#?!$-]/.test(text[i + 1] ?? '');

/** Filename patterns need directory contents; quoted or escaped syntax stays literal. */
function filenamePattern(word: string, plain: boolean[]): boolean {
  let first = -1;
  for (let i = 0; i < word.length; i++) {
    if (!plain[i]) continue;
    const c = word[i];
    if (c === '*' || c === '?') return true;
    if (c === '[' && first < 0) {
      first = i + 1;
      if (plain[first] && (word[first] === '!' || word[first] === '^')) first++;
    } else if (c === ']' && first >= 0 && i > first) {
      // A ] just after [ or its negation is an element, not the closing ].
      return true;
    }
  }
  return false;
}

/** The words and operators of a command, in order. An unclosed quote runs to the end. */
export function shellWords(text: string): ShellWord[] {
  const out: ShellWord[] = [];
  let word = '';
  // For each character of `word`: written unquoted and unescaped (only those
  // can be brace or filename pattern syntax).
  let plain: boolean[] = [];
  let start = -1;
  let expands = false;
  let specialQuote = false;
  let incomplete = false;
  const begin = (i: number) => {
    if (start < 0) start = i;
  };
  const add = (t: string, unquoted = false) => {
    word += t;
    for (let k = 0; k < t.length; k++) plain.push(unquoted);
  };
  const end = (i: number) => {
    if (start >= 0) {
      const raw = text.slice(start, i);
      const syntax = { ...(specialQuote ? { specialQuote: true } : {}), ...(incomplete ? { incomplete: true } : {}) };
      expands ||= filenamePattern(word, plain) || unresolvedWord(word, plain);
      out.push({ text: word, raw, ...(expands ? { expands: true } : {}), ...syntax });
    }
    word = '';
    plain = [];
    start = -1;
    expands = false;
    specialQuote = false;
    incomplete = false;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\\') {
      if (text[i + 1] === '\n') {
        // A line continuation joins the lines; it isn't a character.
        i += 2;
        continue;
      }
      begin(i);
      if (i + 1 >= text.length) incomplete = true;
      add(text[i + 1] ?? '');
      i += 2;
    } else if (c === "'") {
      begin(i);
      const close = text.indexOf("'", i + 1);
      const stop = close < 0 ? text.length : close;
      if (close < 0) incomplete = true;
      add(text.slice(i + 1, stop));
      i = stop + 1;
    } else if (c === '$' && text[i + 1] === "'") {
      begin(i);
      const [value, stop] = ansiC(text, i + 2);
      specialQuote = true;
      if (stop >= text.length) incomplete = true;
      add(value);
      i = stop + 1;
    } else if (c === '"' || (c === '$' && text[i + 1] === '"')) {
      begin(i);
      if (c === '$') specialQuote = true;
      i += c === '$' ? 2 : 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && /[\\"$`\n]/.test(text[i + 1] ?? '')) {
          if (text[i + 1] !== '\n') add(text[i + 1]!);
          i += 2;
        } else if ((text[i] === '$' && expandsAt(text, i)) || text[i] === '`') {
          expands = true;
          const stop = /[({\[]/.test(text[i + 1] ?? '') || text[i] === '`' ? expansionEnd(text, i) : i + 1;
          add(text.slice(i, stop));
          i = stop;
        } else add(text[i++]!);
      }
      if (i >= text.length) incomplete = true;
      i++;
    } else if (c === '$' || c === '`') {
      begin(i);
      expands = true;
      const stop = /[({\[]/.test(text[i + 1] ?? '') || c === '`' ? expansionEnd(text, i) : i + 1;
      add(text.slice(i, stop));
      i = stop;
    } else if ('@!+*?'.includes(c) && text[i + 1] === '(') {
      // Extended filename patterns depend on shell options and directory contents.
      begin(i);
      expands = true;
      const stop = expansionEnd(text, i);
      add(text.slice(i, stop));
      i = stop;
    } else if ((c === '<' || c === '>') && text[i + 1] === '(') {
      // Process substitution: a word (a /dev/fd path) whose command runs first.
      begin(i);
      expands = true;
      const stop = expansionEnd(text, i);
      add(text.slice(i, stop));
      i = stop;
    } else if (c === '<' || c === '>' || (c === '&' && text[i + 1] === '>')) {
      REDIRECTION.lastIndex = i;
      const op = REDIRECTION.exec(text)![0];
      // Digits right before it ("2>") are the file descriptor, not a word.
      const fd = start >= 0 && /^\d+$/.test(text.slice(start, i)) ? text.slice(start, i) : '';
      if (fd) {
        word = '';
        plain = [];
        start = -1;
      } else end(i);
      out.push({ text: op, raw: fd + op, op: true, redirect: true });
      i += op.length;
    } else if (c === '#' && start < 0) {
      // A comment runs to the end of the line.
      while (i < text.length && text[i] !== '\n') i++;
    } else if (OPERATOR.test(c)) {
      end(i);
      out.push({ text: c, raw: c, op: true });
      i++;
    } else if (c === ' ' || c === '\t') {
      // Only a space or a tab separates words. Bash keeps every other kind of
      // space (a no-break space, \v, \f) inside the word: "npm\u00A0test" is
      // one program's name.
      end(i);
      i++;
    } else {
      begin(i);
      add(c, true);
      i++;
    }
  }
  end(text.length);
  return out;
}
