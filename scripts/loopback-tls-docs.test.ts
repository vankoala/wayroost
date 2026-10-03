import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it.each(['SECURITY.md', 'deploy/README.md', 'docs/configuration.md'])('documents credential retirement after TLS key compromise in %s', path => {
  const text = readFileSync(path, 'utf8');
  expect(text).toContain('suspected key compromise');
  expect(text).toMatch(/revoke every old desktop device/);
  expect(text).toContain('desktop-rescue');
  expect(text).toContain('supervisor-keys.json');
  expect(text).toMatch(/preserving the (separate )?server entry/);
  expect(text).toContain('sudo wayroost fingerprints');
  expect(text.replace(/\n/g, ' ')).toContain('Never take a fingerprint from the live listener');
});
