import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const text = [...new Set(paths)].filter(path => existsSync(resolve(root, path))).flatMap(path => {
  const data = readFileSync(resolve(root, path));
  return data.includes(0) ? [] : [{ path, body: data.toString('utf8') }];
});
const fixtures = text.filter(({ path }) => /(?:\.test\.ts|\/test_[^/]+\.py)$/.test(path));

it('describes optional host command wrappers without naming a private guard CLI', () => {
  // Hermes' public skills scanner is an upstream feature.
  const cli = /\b(?!skills-guard\b)[a-z]+-guard\b/;
  expect(text.filter(({ body }) => cli.test(body)).map(({ path }) => path)).toEqual([]);
});

it('names tests after behavior without priority prefixes', () => {
  expect(fixtures.filter(({ body }) => /\(\s*['"`]P[0-9]+\s/.test(body)).map(({ path }) => path)).toEqual([]);
});

it('documents operator procedures without private numbered rollout references', () => {
  const references = /\b(?:live|rollout)\s+steps?\b|\bapproved\s+(?:live|rollout)\b|\bstep\s+[A-E]\b/i;
  expect(text.filter(({ body }) => references.test(body)).map(({ path }) => path)).toEqual([]);
});

it('uses obvious demo identities for short Paseo agent fixtures', () => {
  const shortId = /["']PASEO_AGENT_ID["']\s*:\s*["'][a-f\d]{8}["']/i;
  expect(fixtures.filter(({ body }) => shortId.test(body)).map(({ path }) => path)).toEqual([]);
});

it('uses obvious placeholders instead of provider key prefixes in fixtures', () => {
  expect(fixtures.filter(({ body }) => /\bsk-[a-z\d]/i.test(body)).map(({ path }) => path)).toEqual([]);
});

it('generates hex bearer credentials instead of committing fixed values in fixtures', () => {
  expect(fixtures.filter(({ body }) => /["'`][a-f\d]{64}["'`]/i.test(body)).map(({ path }) => path)).toEqual([]);
});

it('attributes the Web Push standards vector beside its test inputs', () => {
  const feed = readFileSync(resolve(root, 'server/test/feed.test.ts'), 'utf8');
  expect(/\/\/[^\n]*RFC 8291 Appendix A/.test(feed)).toBe(true);
});
