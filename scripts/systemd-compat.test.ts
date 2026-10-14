import { hostPaths } from '../server/test/host-path-fixture.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Keep this list in sync with the deployment guide's systemd 249 allowlist.
const allowedSpecifiers = ['%n', '%%'];
const templates = readdirSync('deploy', { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile())
  .map(entry => join(entry.parentPath, entry.name))
  .flatMap(path => {
    const text = readFileSync(path, 'utf8');
    if (/\.(?:service|socket|conf)(?:\.(?:in|template))?$/.test(path)
      || (!path.endsWith('.sh') && /^\s*\[(?:Unit|Service|Socket|Install)\]/m.test(text))) return [{ path, text }];
    // Drop-ins embedded in installer heredocs are unit templates too.
    const heredocs = [...text.matchAll(/<<-?\s*['"]?([A-Za-z_][A-Za-z_0-9]*)['"]?[^\n]*\n([\s\S]*?)\n\s*\1(?:\n|$)/g)]
      .filter(match => /^\s*\[(?:Unit|Service|Socket|Install)\]/m.test(match[2]!))
      .map((match, index) => ({ path: `${path}:heredoc-${index + 1}`, text: match[2]! }));
    // Installers also insert individual directives into existing units.
    const directives = path.endsWith('.sh')
      ? [...text.matchAll(/\b[A-Z][a-z][A-Za-z]*=[^'"`\n]*/g)]
        .map((match, index) => ({ path: `${path}:directive-${index + 1}`, text: match[0] }))
      : [];
    return [...heredocs, ...directives];
  });

it('uses only the documented systemd 249 specifiers in every deployment unit and drop-in', () => {
  expect(templates.some(({ path }) => path === 'deploy/wayroost-server.service')).toBe(true);
  expect(templates.some(({ path }) => path.startsWith('deploy/setup-helper.sh:'))).toBe(true);
  expect(templates.some(({ path }) => path.startsWith('deploy/setup-speech.sh:'))).toBe(true);
  const used = new Set<string>();
  for (const { path, text } of templates) {
    expect(text, path).not.toContain('%d');
    for (const match of text.matchAll(/%[\s\S]?/g)) {
      expect(allowedSpecifiers, `${path}: ${match[0]}`).toContain(match[0]);
      used.add(match[0]);
    }
  }
  expect([...used].sort()).toEqual(['%n']);
  const docs = readFileSync('deploy/README.md', 'utf8');
  for (const specifier of allowedSpecifiers) expect(docs).toContain(`\`${specifier}\``);
  expect(docs).toContain('systemd 249 or newer');
});

it.each([
  ['wayroost-server.service', 'WAYROOST_CONFIG', 'config.json'],
  ['wayroost-server.service', 'SIGNALBOX_CONFIG', 'config.json'],
  ['wayroost-paseo-safety.service', 'WAYROOST_SAFETY_CONFIG', 'safety-helper.json'],
])('keeps %s %s credentials scoped to the actual unit name', (unit, variable, credential) => {
  const text = readFileSync(`deploy/${unit}`, 'utf8');
  const value = text.match(new RegExp(`^Environment=${variable}=(.*)$`, 'm'))?.[1];
  expect(value).toBe(`${hostPaths.credentials}/%n/${credential}`);
  for (const name of [unit, 'demo-renamed.service', 'demo-worker@example.service']) {
    expect(value!.replaceAll('%n', name)).toBe(`${hostPaths.credentials}/${name}/${credential}`);
  }
});
