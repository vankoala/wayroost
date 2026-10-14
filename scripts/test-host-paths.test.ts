import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { reservedTestPaths } from '../server/test/host-path-fixture.js';

const pathFixtures = new Set(['server/test/host-path-fixture.ts']);

function fixtureImportOrder(path: string, source: string): string[] {
  const imports = [...source.matchAll(/^\s*import\s+(?:(?:type\s+)?(?:[\w$]+(?:\s*,\s*)?)?(?:\{[^}]*\}|\*\s+as\s+[\w$]+)?\s+from\s+)?(['"])([^'"\n]+)\1/gm)];
  const fixture = imports.find(statement => statement[2]!.endsWith('/state-directory-fixture.js'));
  const firstSource = imports.find(statement => statement[2]!.startsWith('../src/'));
  return fixture && firstSource && fixture.index! > firstSource.index!
    ? [`${path}: import state-directory-fixture.js before ../src/ modules`] : [];
}

function references(path: string, source: string): string[] {
  if (pathFixtures.has(path)) return [];
  const decoded = source.replace(/\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|(\/))/gi,
    (_match, point: string | undefined, unicode: string | undefined, hex: string | undefined, slash: string | undefined) =>
      slash ?? String.fromCodePoint(parseInt(point ?? unicode ?? hex!, 16)));
  const text = [source, decoded];
  return reservedTestPaths.filter(root => text.some(value => {
    let offset = value.indexOf(root);
    while (offset !== -1) {
      const next = value[offset + root.length];
      if (next === undefined || !/[\w-]/.test(next)) return true;
      offset = value.indexOf(root, offset + root.length);
    }
    return false;
  }));
}

it('keeps reserved host path literals in the explicitly isolated path fixture', () => {
  const files = ['server/test', 'scripts'].flatMap(root => readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .filter(path => /\.(?:[cm]?[jt]s|tsx)$/.test(path)
      && (root === 'server/test' || /(?:test|fixture)/.test(path))));
  expect(files).toContain('server/test/config.test.ts');
  expect(files).toContain('scripts/systemd-compat.test.ts');
  const violations = files.flatMap(path => {
    const source = readFileSync(path, 'utf8');
    const paths = [...references(path, source).map(root => `${path}: ${root}`), ...fixtureImportOrder(path, source)];
    if (/(?:host-path|state-directory)-fixture\.js/.test(source) && /\btmpdir\s*\(/.test(source)) {
      paths.push(`${path}: host temporary directory allocation`);
    }
    return paths;
  });
  expect(violations).toEqual([]);
});

it.each([
  "import { parseConfig } from '../src/config.js';",
  "import {\n  parseConfig,\n} from '../src/config.js';",
  "import '../src/config.js';",
  "import type { AppConfig } from '../src/config.js';",
])('requires fixture imports before source imports: %s', source => {
  const fixture = "import { useIsolatedStateDirectories } from './state-directory-fixture.js';";
  expect(fixtureImportOrder('server/test/demo.test.ts', `${source}\n${fixture}`)).toEqual([
    'server/test/demo.test.ts: import state-directory-fixture.js before ../src/ modules',
  ]);
  expect(fixtureImportOrder('server/test/demo.test.ts', `${fixture}\n${source}`)).toEqual([]);
  expect(fixtureImportOrder('server/test/demo.test.ts', source)).toEqual([]);
});

it.each(reservedTestPaths)('rejects direct, nested, escaped and template references to %s', root => {
  for (const source of [
    `const path = ${JSON.stringify(root)};`,
    `readFileSync(${JSON.stringify(`${root}/config.json`)});`,
    `const path = ${JSON.stringify(root).replaceAll('/', '\\u002f')};`,
    'const path = `' + root + '/${name}`;',
  ]) expect(references('server/test/demo.test.ts', source)).toContain(root);
  expect(references('scripts/nested/demo.test.ts', JSON.stringify(root))).toContain(root);
  expect(references('server/test/host-path-fixture-copy.ts', JSON.stringify(root))).toContain(root);
  expect(references('server/test/host-path-fixture.ts', JSON.stringify(root))).toEqual([]);
});

it('accepts temporary paths and distinct directory names', () => {
  expect(references('server/test/demo.test.ts', "const path = '/home/me/test-state/config.json';")).toEqual([]);
  for (const root of reservedTestPaths) expect(references('scripts/demo.test.ts', JSON.stringify(`${root}-example`))).toEqual([]);
});
