import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('uses reserved domains for mail examples and omits email contacts from dependency notices', () => {
  expect(readFileSync('web/src/components/ConnectorsSheet.tsx', 'utf8')).toContain('from:boss@example.com is:important');
  expect(readFileSync('server/test/connectors.test.ts', 'utf8')).toContain("query: 'from:bank.example.com'");
  const lock = JSON.parse(readFileSync('desktop/package-lock.json', 'utf8'));
  for (const entry of Object.values(lock.packages) as { deprecated?: string }[])
    expect(entry.deprecated ?? '').not.toMatch(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
});

it('keeps source comments self-contained without bare section-sign citations', () => {
  const scan = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'release', 'assets'].includes(entry.name)) continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (/\.(?:ts|tsx|css|md|yml)$/.test(file)) {
        const text = readFileSync(file, 'utf8');
        expect(text, file).not.toContain('\u00a7');
      }
    }
  };
  for (const path of ['server', 'supervisor', 'shared', 'web', 'scripts', 'desktop', 'deploy', 'docs', '.github']) scan(path);
});
