import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { checkFuses } = require('../scripts/check-fuses.cjs') as { checkFuses(exe: string, wanted: Record<string, boolean>): Promise<string[]> };
const wanted = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { build: { electronFuses: Record<string, boolean> } }).build.electronFuses;
const dir = mkdtempSync(join(tmpdir(), 'wayroost-fuses-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
/** A stand-in executable: Electron's fuse sentinel, wire version 1, then the wire ('0'/'1' per fuse). */
function fakeExe(name: string, wire: string, integrity: boolean) {
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat([Buffer.from('MZ demo '), Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, wire.length]), Buffer.from(wire),
    integrity ? Buffer.from('ELECTRONASAR', 'utf16le') : Buffer.alloc(0)]));
  return path;
}
describe('Electron fuses', () => {
  it('configures the production fuses', () => {
    expect(wanted).toEqual({
      runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true,
    });
  });
  it('passes a binary flipped as configured and fails Electron\'s defaults', async () => {
    // Wire order: RunAsNode, CookieEncryption, NODE_OPTIONS, inspect args, ASAR integrity, only ASAR, V8 snapshot, file privileges.
    expect(await checkFuses(fakeExe('flipped.exe', '00001101', true), wanted)).toEqual([]);
    expect(await checkFuses(fakeExe('stock.exe', '10110001', false), wanted)).toEqual([
      'runAsNode: expected disabled, found enabled',
      'enableNodeOptionsEnvironmentVariable: expected disabled, found enabled',
      'enableNodeCliInspectArguments: expected disabled, found enabled',
      'enableEmbeddedAsarIntegrityValidation: expected enabled, found disabled',
      'onlyLoadAppFromAsar: expected enabled, found disabled',
      'ASAR integrity resource missing',
    ]);
    expect(await checkFuses(fakeExe('no-integrity.exe', '00001101', false), wanted)).toEqual(['ASAR integrity resource missing']);
  });
});
