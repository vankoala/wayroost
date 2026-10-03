import { describe, expect, it } from 'vitest';
import { assertReadable, composite, contrastRatio } from './contrast.js';

const white = 'rgb(255, 255, 255)';

describe('contrastRatio', () => {
  it('measures the WCAG extremes', () => {
    expect(contrastRatio('rgb(0, 0, 0)', white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBe(1);
  });

  it('reads color(srgb ...) as well as rgb()', () => {
    expect(contrastRatio('color(srgb 0 0 0)', 'color(srgb 1 1 1)')).toBeCloseTo(21, 5);
  });
});

describe('composite', () => {
  it('blends a translucent wash with the opaque layer under it', () => {
    expect(composite(['rgba(0, 0, 0, 0.5)', white])).toBe('color(srgb 0.5 0.5 0.5)');
  });

  it('refuses a translucent bottom layer', () => {
    expect(() => composite(['rgba(0, 0, 0, 0.5)'])).toThrow(/bottom layer must be opaque/);
  });
});

describe('assertReadable', () => {
  it('fails text the same colour as its background', () => {
    expect(() => assertReadable('same colour', white, [white])).toThrow('same colour contrast 1.00:1 is below WCAG AA (4.5:1)');
  });

  it('fails just below 4.5:1 and passes just above it', () => {
    expect(() => assertReadable('#777', 'rgb(119, 119, 119)', [white])).toThrow(/4\.48:1 is below WCAG AA/);
    expect(assertReadable('#767676', 'rgb(118, 118, 118)', [white])).toBeCloseTo(4.54, 2);
  });

  it('judges the text against the blended background, not the opaque layer alone', () => {
    // #767676 passes on white, but not once a 10% black wash darkens what is behind it.
    expect(() => assertReadable('on a wash', 'rgb(118, 118, 118)', ['rgba(0, 0, 0, 0.1)', white])).toThrow(/below WCAG AA/);
  });

  it('blends translucent text with what is under it', () => {
    // Black at 50% on white is mid-grey: about 3.98:1.
    expect(() => assertReadable('half-black', 'rgba(0, 0, 0, 0.5)', [white])).toThrow(/3\.9\d:1/);
  });
});
