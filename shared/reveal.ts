// Make an approval's command/diff impossible to disguise: invisible and
// direction-changing characters become visible markers, and long runs of
// blank lines or spaces (used to push a payload out of view) are collapsed
// into a visible note.

// C0/C1 controls (except tab/newline), soft hyphen, bidi controls, zero-width
// and joiner characters, invisible separators, variation selectors, BOM.
const INVISIBLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb]/g;

export interface RevealedDetail {
  /** Safe-to-display text. */
  text: string;
  /** Line and character counts of the original. */
  lines: number;
  chars: number;
  /** Something was made visible or collapsed; worth a closer look. */
  unusual: boolean;
}

export function revealDetail(original: string): RevealedDetail {
  let unusual = false;
  let text = original.replace(/\r\n?/g, '\n');
  text = text.replace(INVISIBLE, (ch) => {
    unusual = true;
    return `⟨U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`;
  });
  text = text.replace(/\n(?:[ \t]*\n){3,}/g, (run) => {
    unusual = true;
    return `\n⟨${run.split('\n').length - 2} blank lines⟩\n`;
  });
  text = text.replace(/[ \t]{24,}/g, (run) => {
    unusual = true;
    return ` ⟨${run.length} spaces⟩ `;
  });
  return { text, lines: original.split('\n').length, chars: original.length, unusual };
}

/** Head and tail of a long text, so an appended payload is visible even when collapsed. */
export function preview(text: string, head = 5, tail = 3): { text: string; hiddenLines: number } {
  const lines = text.split('\n');
  if (lines.length <= head + tail + 1) return { text, hiddenLines: 0 };
  const hidden = lines.length - head - tail;
  return {
    text: [...lines.slice(0, head), `⋯ ${hidden} more lines ⋯`, ...lines.slice(-tail)].join('\n'),
    hiddenLines: hidden,
  };
}
