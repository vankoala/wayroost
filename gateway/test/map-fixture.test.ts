import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { demoMap } from './map-fixture.js';

it('uses invented profile names', () => {
  expect(Object.keys(demoMap().profiles)).toEqual(['example/sglang', 'example/profile']);
});

it('requires explicit cutover value carryover', () => {
  const instructions = readFileSync(new URL('../../docs/shadow-cutover.md', import.meta.url), 'utf8');
  expect(instructions).toContain('one-time operator action');
  expect(instructions).toMatch(/enabling the switch\s+never copies them/);
});
