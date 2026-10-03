/**
 * Controls, and characters that hide or reorder text: the set shared/reveal.ts
 * shows on approvals (soft hyphen, bidi controls, zero-width and joiners,
 * invisible separators and fillers, variation selectors, BOM), plus Unicode tag
 * characters, which no screen shows but a model reads as text. It includes line
 * breaks and tabs (they're controls too). Global: use it with `replace`, never
 * with `test`.
 */
export const INVISIBLE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\u{e0000}-\u{e007f}]/gu;
