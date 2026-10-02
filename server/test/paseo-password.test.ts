import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPaseoPassword } from '../src/paseo/adapter.js';

// The Paseo daemon's password reaches Signalbox as a systemd credential (LoadCredential=paseo-password:…).

describe('readPaseoPassword', () => {
  const saved = process.env.CREDENTIALS_DIRECTORY;
  afterEach(() => {
    if (saved === undefined) delete process.env.CREDENTIALS_DIRECTORY;
    else process.env.CREDENTIALS_DIRECTORY = saved;
  });

  it('reads the credential, trimmed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'creds-'));
    writeFileSync(join(dir, 'paseo-password'), 'correct-horse-battery\n');
    process.env.CREDENTIALS_DIRECTORY = dir;
    expect(readPaseoPassword()).toBe('correct-horse-battery');
  });

  it('is none without systemd credentials, without the file, or for an empty one', () => {
    delete process.env.CREDENTIALS_DIRECTORY;
    expect(readPaseoPassword()).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), 'creds-'));
    process.env.CREDENTIALS_DIRECTORY = dir;
    expect(readPaseoPassword()).toBeUndefined();
    writeFileSync(join(dir, 'paseo-password'), ' \n');
    expect(readPaseoPassword()).toBeUndefined();
  });
});
