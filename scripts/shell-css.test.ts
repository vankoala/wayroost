import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps complete shadow definitions in tokens, including the role badge ring', () => {
  const shell = readFileSync('web/src/shell.css', 'utf8');
  const tokens = readFileSync('web/src/tokens.css', 'utf8');
  const shadows = [...shell.matchAll(/box-shadow:\s*([^;]+);/g)].map((m) => m[1]!);
  expect(shadows.length).toBeGreaterThan(0);
  for (const shadow of shadows) {
    expect(shadow).toMatch(/^(none|var\(--[\w-]+\))$/);
    if (shadow !== 'none') expect(tokens).toContain(`${shadow.slice(4, -1)}:`);
  }
});
