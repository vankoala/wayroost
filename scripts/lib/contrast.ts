// Colour contrast for the UI check: computed CSS colours in, WCAG contrast ratios out. Kept apart
// from ui-check.ts so the arithmetic and the pass/fail rule have their own tests.

/** WCAG AA for normal-size text. */
export const MIN_TEXT_RATIO = 4.5;

/** [r, g, b, alpha], each 0..1, from a computed colour: rgb()/rgba(), or color(srgb ...) for color-mix() results. */
export function parseColour(colour: string): [number, number, number, number] {
  const n = '(-?[\\d.]+(?:e-?\\d+)?)';
  const rgb = new RegExp(`^rgba?\\(${n}, ${n}, ${n}(?:, ${n})?\\)$`).exec(colour);
  if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255, rgb[4] === undefined ? 1 : Number(rgb[4])];
  const srgb = new RegExp(`^color\\(srgb ${n} ${n} ${n}(?: / ${n})?\\)$`).exec(colour);
  if (srgb) return [Number(srgb[1]), Number(srgb[2]), Number(srgb[3]), srgb[4] === undefined ? 1 : Number(srgb[4])];
  throw new Error(`Expected a computed sRGB colour, got ${colour}`);
}

export function contrastRatio(foreground: string, background: string): number {
  const luminance = (colour: string) => {
    const [r, g, b, alpha] = parseColour(colour);
    if (alpha !== 1) throw new Error(`Expected an opaque computed sRGB colour, got ${colour}`);
    const channels = [r, g, b].map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * What the eye sees: `layers` painted over each other, the bottom (opaque) one last in the list,
 * as an opaque color(srgb ...). A translucent wash such as color-mix(..., transparent) blends with
 * what is under it.
 */
export function composite(layers: string[]): string {
  let [r, g, b] = [0, 0, 0];
  for (const [i, layer] of [...layers].reverse().entries()) {
    const [lr, lg, lb, alpha] = parseColour(layer);
    if (i === 0 && alpha !== 1) throw new Error(`The bottom layer must be opaque, got ${layer}`);
    [r, g, b] = [lr * alpha + r * (1 - alpha), lg * alpha + g * (1 - alpha), lb * alpha + b * (1 - alpha)];
  }
  return `color(srgb ${r} ${g} ${b})`;
}

/**
 * The contrast of text in `colour` painted on `backgrounds` (innermost first, the last one opaque),
 * once translucent layers are blended. Throws when it is below WCAG AA, so the UI check fails;
 * returns the ratio for the log.
 */
export function assertReadable(what: string, colour: string, backgrounds: string[]): number {
  const ratio = contrastRatio(composite([colour, ...backgrounds]), composite(backgrounds));
  if (!(ratio >= MIN_TEXT_RATIO)) {
    throw new Error(`${what} contrast ${ratio.toFixed(2)}:1 is below WCAG AA (${MIN_TEXT_RATIO}:1)`);
  }
  return ratio;
}
