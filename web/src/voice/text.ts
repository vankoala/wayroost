import { VOICE_SPEAK_MAX_CHARS } from '../../../shared/protocol';

// Turning an agent's reply into speech-sized pieces, as it streams.
//
// Sentence rules ported from an earlier, tested text-stream splitter
// (with its tests): a boundary is ". ! ?" (maybe closed by a quote or bracket) followed by
// whitespace, or a newline before a blank line or a bullet. Boundaries never fall
// inside quotes, brackets or `code`, or after a known abbreviation, and decimals
// like 1.5 never qualify. While a reply is still streaming, only a boundary that
// more text can't undo counts, so nothing is read before its sentence is done.

const ABBREVIATIONS = new Set(
  (
    'Mr. Mrs. Ms. Dr. Prof. Sr. Jr. St. Rd. Ave. Blvd. Inc. Ltd. Corp. ' +
    'U.S. U.K. e.g. i.e. vs. etc. ' +
    'Jan. Feb. Mar. Apr. Jun. Jul. Aug. Sep. Oct. Nov. Dec.'
  )
    .toLowerCase()
    .split(' '),
);

/** Longest piece sent to be read aloud at once; longer sentences split at a comma or space. */
export const MAX_CHUNK = 240;
const TERMINALS = '.!?';
const CLOSERS = '"\'”’)]';
const BULLETS = ['-', '*', '•', '∙'];
const SOFT_BREAKS = [',', ';', '—'];
const PAIRS = new Map([
  ['(', ')'],
  ['[', ']'],
  ['“', '”'],
]);
const CLOSING = new Set(PAIRS.values());

const WORD = /[\p{L}\p{N}]/u;
const LETTER = /\p{L}/u;
const LOWER = /^\p{Ll}/u;
const SPACE = /\s/;

export const hasWord = (s: string): boolean => WORD.test(s);

/** mask[i] is true when position i is inside a quote, bracket or code span. */
function nestingMask(text: string, streaming: boolean): boolean[] {
  const n = text.length;
  const mask = new Array<boolean>(n).fill(false);
  const stack: Array<[string, number]> = [];
  let openFrom = n;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (c === '`') {
      let j = i;
      while (j < n && text[j] === '`') j += 1;
      const run = text.slice(i, j);
      let k = text.indexOf(run, j);
      // a longer backtick run is not the matching fence
      while (k !== -1 && k + run.length < n && text[k + run.length] === '`') k = text.indexOf(run, k + run.length + 1);
      if (k === -1) {
        if (streaming) {
          openFrom = Math.min(openFrom, i);
          break;
        }
        i = j;
        continue;
      }
      for (let p = i; p < k + run.length; p += 1) mask[p] = true;
      i = k + run.length;
      continue;
    }
    if (c === '"') {
      if (stack.length && stack[stack.length - 1]![0] === '"') {
        const [, start] = stack.pop()!;
        for (let p = start; p <= i; p += 1) mask[p] = true;
      } else {
        stack.push(['"', i]);
      }
    } else if (PAIRS.has(c)) {
      stack.push([PAIRS.get(c)!, i]);
    } else if (CLOSING.has(c)) {
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        if (stack[depth]![0] === c) {
          const start = stack[depth]![1];
          stack.length = depth;
          for (let p = start; p <= i; p += 1) mask[p] = true;
          break;
        }
      }
    }
    i += 1;
  }
  if (streaming) {
    // An opener that hasn't closed yet may still close: everything from it waits.
    if (stack.length) openFrom = Math.min(openFrom, stack[0]![1]);
    for (let p = openFrom; p < n; p += 1) mask[p] = true;
  }
  return mask;
}

function isAbbreviation(text: string, dot: number): boolean {
  let start = dot;
  while (start > 0 && (LETTER.test(text[start - 1]!) || text[start - 1] === '.')) start -= 1;
  return ABBREVIATIONS.has(text.slice(start, dot + 1).toLowerCase());
}

/** Index of the ". ! ?" that ends a sentence right before position i, or -1. */
function terminalEnd(text: string, i: number): number {
  let j = i - 1;
  while (j >= 0 && CLOSERS.includes(text[j]!)) j -= 1;
  if (j < 0 || !TERMINALS.includes(text[j]!)) return -1;
  return j;
}

function isBulletLine(line: string): boolean {
  const s = line.replace(/^[ \t]+/, '');
  return BULLETS.some((b) => s.startsWith(b) && s.length > b.length && (s[b.length] === ' ' || s[b.length] === '\t'));
}

/** Cut positions (exclusive ends of pieces), in order. While streaming, the end of the text is never one. */
function boundaries(text: string, streaming: boolean): number[] {
  const n = text.length;
  const mask = nestingMask(text, streaming);
  const cuts: number[] = [];
  for (let i = 1; i <= n; i += 1) {
    const atEnd = i === n;
    if (atEnd && streaming) break;
    if (!atEnd && (!SPACE.test(text[i]!) || mask[i])) continue;
    const t = terminalEnd(text, i);
    if (t >= 0 && !(text[t] === '.' && isAbbreviation(text, t))) {
      if (t === i - 1) {
        cuts.push(i);
        continue;
      }
      // "(a pinch. Or two.) now" keeps going: a closed quote or bracket only
      // ends the sentence when the next word doesn't start lower-case.
      const next = text.slice(i).trimStart();
      if ((next && !LOWER.test(next)) || (!next && !streaming)) {
        cuts.push(i);
        continue;
      }
    }
    // A newline before a blank line or a bullet.
    if (!atEnd && text[i] === '\n') {
      const nl = text.indexOf('\n', i + 1);
      if (nl === -1) {
        const next = text.slice(i + 1);
        if (streaming) {
          if (isBulletLine(next)) cuts.push(i);
          continue;
        }
        if (!next.trim() || isBulletLine(next)) cuts.push(i);
        continue;
      }
      const next = text.slice(i + 1, nl);
      if (!next.trim() || isBulletLine(next)) cuts.push(i);
    }
  }
  return cuts;
}

/** Break a piece longer than MAX_CHUNK at a comma-like break, else at a space, else hard. */
export function forceSplit(chunk: string): string[] {
  const out: string[] = [];
  let rest = chunk;
  while (rest.length > MAX_CHUNK) {
    const window = rest.slice(0, MAX_CHUNK);
    const soft = Math.max(...SOFT_BREAKS.map((ch) => window.lastIndexOf(ch)));
    const space = window.lastIndexOf(' ');
    let cut = -1;
    for (const candidate of [soft > 0 ? soft + 1 : -1, space > 0 ? space : -1, MAX_CHUNK]) {
      if (candidate <= 0) continue;
      if (hasWord(rest.slice(0, candidate).trim()) && hasWord(rest.slice(candidate).trim())) {
        cut = candidate;
        break;
      }
    }
    if (cut === -1) break;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  out.push(rest);
  return out;
}

/**
 * A finished reply cut into pieces, in order. A piece with no letter or digit
 * joins a neighbour. `force: false` leaves long pieces whole.
 */
export function splitSentences(text: string, force = true): string[] {
  if (!hasWord(text)) return [];
  const spans: Array<[number, number]> = [];
  let start = 0;
  for (const cut of boundaries(text, false)) {
    if (text.slice(start, cut).trim()) spans.push([start, cut]);
    start = cut;
  }
  if (text.slice(start).trim()) spans.push([start, text.length]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && (!hasWord(text.slice(span[0], span[1])) || !hasWord(text.slice(last[0], last[1])))) last[1] = span[1];
    else merged.push([span[0], span[1]]);
  }
  return merged.flatMap(([a, b]) => (force ? forceSplit(text.slice(a, b).trim()) : [text.slice(a, b).trim()])).filter(Boolean);
}

/**
 * Split a still-streaming reply into [ready, rest]: `ready` ends at the last
 * boundary later text can't undo; ready + rest is always the whole buffer.
 */
export function completeSentences(buffer: string): [string, string] {
  if (!buffer) return ['', buffer];
  const cuts = boundaries(buffer, true);
  for (let k = cuts.length - 1; k >= 0; k -= 1) {
    const cut = cuts[k]!;
    if (hasWord(buffer.slice(0, cut))) return [buffer.slice(0, cut), buffer.slice(cut)];
  }
  return ['', buffer];
}

// ---- Markdown to what is worth saying ------------------------------------------

const FENCE = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(\n[ \t]*\2[^\n]*(?=\n|$)|$)/g;

/**
 * What to say for a piece of Markdown: code blocks, tables, images and HTML are
 * skipped, links say their text, bare addresses say "a link", long paths say
 * their last part, and formatting marks go. Empty when nothing is left to say.
 */
export function speakable(markdown: string): string {
  let s = markdown.replace(/\r/g, '');
  s = s.replace(FENCE, '$1');
  s = s
    .split('\n')
    .filter((line) => !/^\s*\|/.test(line)) // table rows
    .join('\n');
  s = s.replace(/<[^>\n]{1,200}>/g, ' ');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1');
  s = s.replace(/\bhttps?:\/\/[^\s)>\]]+/g, 'a link');
  s = s.replace(/`{1,2}([^`\n]+)`{1,2}/g, '$1');
  // /a/b/c.ts or ~/x/y: the last part says enough.
  s = s.replace(/(^|[\s(])(?:~|\.{1,2})?(?:\/[\w.@+-]+){2,}\/?/g, (whole, lead: string) => {
    const parts = whole.trim().replace(/\/$/, '').split('/');
    return `${lead}${parts[parts.length - 1]}`;
  });
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s*>\s?/gm, '');
  s = s.replace(/^\s*(?:[-*+•∙]|\d{1,3}[.)])\s+/gm, '');
  s = s.replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, '');
  s = s.replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2');
  s = s.replace(/(^|[\s(])[*_](?=\S)([^*_\n]*?\S)[*_](?=[\s).,!?:;]|$)/g, '$1$2');
  s = s.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '');
  s = s.replace(/\s+/g, ' ').trim();
  return hasWord(s) ? s : '';
}

/**
 * Finished Markdown as the pieces to read aloud: cut at sentences first (so a
 * code block stays in one piece and is dropped whole), then made speakable,
 * then long pieces split.
 */
export function speechPieces(markdown: string): string[] {
  return splitSentences(markdown, false)
    .map(speakable)
    .filter(Boolean)
    .flatMap(forceSplit)
    // forceSplit can give up on odd text; never end on half of a surrogate pair.
    .map((piece) => piece.slice(0, VOICE_SPEAK_MAX_CHARS).replace(/[\uD800-\uDBFF]$/, ''));
}
