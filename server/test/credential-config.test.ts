import { temporaryDirectory } from '../../tests/temporary-directory.js';
import { hostPaths } from './host-path-fixture.js';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { configPath, loadConfig } from '../src/config.js';
import { safetyHelperConfigPath } from '../src/paseo/safety-helper-config.js';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function credentials(): string {
  const folder = temporaryDirectory('wayroost-credentials-');
  folders.push(folder);
  return folder;
}

it('loads the server config credential when both config variables are unset', () => {
  const directory = credentials();
  const file = join(directory, 'config.json');
  writeFileSync(file, JSON.stringify({ origins: ['http://127.0.0.1:8881'], stateDir: join(directory, 'state') }));
  const path = configPath({ CREDENTIALS_DIRECTORY: directory });
  expect(path).toBe(file);
  expect(loadConfig(path, { env: {} }).origins[0]?.origin).toBe('http://127.0.0.1:8881');
});

it.each(['WAYROOST_CONFIG', 'SIGNALBOX_CONFIG'])('keeps explicit %s ahead of the server credential', name => {
  const directory = credentials();
  writeFileSync(join(directory, 'config.json'), '{}');
  expect(configPath({ CREDENTIALS_DIRECTORY: directory, [name]: '/home/me/explicit.json' })).toBe('/home/me/explicit.json');
  expect(configPath({ CREDENTIALS_DIRECTORY: directory, [name]: '' })).toBe('');
});

it('keeps the current config variable ahead of the legacy variable and credentials', () => {
  expect(configPath({ WAYROOST_CONFIG: '/home/me/current.json', SIGNALBOX_CONFIG: '/home/me/legacy.json',
    CREDENTIALS_DIRECTORY: 'invalid' })).toBe('/home/me/current.json');
});

it('resolves the Safety helper config credential and keeps an explicit path first', () => {
  const directory = credentials();
  const file = join(directory, 'safety-helper.json');
  writeFileSync(file, JSON.stringify({ configPath: '/home/me/demo-paseo/config.json', url: 'ws://127.0.0.1:19007' }));
  expect(safetyHelperConfigPath({ CREDENTIALS_DIRECTORY: directory })).toBe(file);
  expect(safetyHelperConfigPath({ CREDENTIALS_DIRECTORY: directory, WAYROOST_SAFETY_CONFIG: '/home/me/helper.json' }))
    .toBe('/home/me/helper.json');
  expect(safetyHelperConfigPath({ CREDENTIALS_DIRECTORY: 'invalid', WAYROOST_SAFETY_CONFIG: '/home/me/helper.json' }))
    .toBe('/home/me/helper.json');
});

it.each([
  { resolve: configPath, credential: 'config.json', fallback: `${hostPaths.config}/config.json` },
  { resolve: safetyHelperConfigPath, credential: 'safety-helper.json', fallback: `${hostPaths.config}/safety-helper.json` },
])('uses $fallback only without a config credential', ({ resolve, credential, fallback }) => {
  const directory = credentials();
  expect(resolve({})).toBe(fallback);
  expect(resolve({ CREDENTIALS_DIRECTORY: directory })).toBe(fallback);
  expect(resolve({ CREDENTIALS_DIRECTORY: join(directory, 'missing') })).toBe(fallback);
  mkdirSync(join(directory, credential));
  expect(resolve({ CREDENTIALS_DIRECTORY: directory })).toBe(fallback);
});

it.each(['', 'relative', `${hostPaths.credentials}/demo\n`])('rejects an invalid credentials directory %j', directory => {
  expect(() => configPath({ CREDENTIALS_DIRECTORY: directory })).toThrow(/CREDENTIALS_DIRECTORY/);
  expect(() => safetyHelperConfigPath({ CREDENTIALS_DIRECTORY: directory })).toThrow(/CREDENTIALS_DIRECTORY/);
});

it.each(['', 'relative'])('keeps the Safety helper absolute-path requirement for explicit %j', path => {
  expect(() => safetyHelperConfigPath({ WAYROOST_SAFETY_CONFIG: path })).toThrow(/absolute WAYROOST_SAFETY_CONFIG/);
});

it('does not hide an invalid config credential behind the default config', () => {
  const directory = credentials();
  writeFileSync(join(directory, 'config.json'), 'invalid-json');
  expect(() => loadConfig(configPath({ CREDENTIALS_DIRECTORY: directory }))).toThrow(/not valid JSON/);
});

it.each([
  { resolve: configPath, credential: 'config.json' },
  { resolve: safetyHelperConfigPath, credential: 'safety-helper.json' },
])('refuses an unresolvable $credential instead of falling back', ({ resolve, credential }) => {
  const directory = credentials();
  symlinkSync(credential, join(directory, credential));
  expect(() => resolve({ CREDENTIALS_DIRECTORY: directory })).toThrow(`Cannot inspect the systemd config credential ${credential}`);
});

it.each(['', 'relative', 'unresolvable'])('reports startup config-path failure %j as one line and exits with status 1', value => {
  let directory = value;
  if (value === 'unresolvable') {
    directory = credentials();
    symlinkSync('config.json', join(directory, 'config.json'));
  }
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    encoding: 'utf8', timeout: 10_000,
    env: { CREDENTIALS_DIRECTORY: directory, TSX_DISABLE_CACHE: '1' },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe(value === 'unresolvable'
    ? 'Cannot inspect the systemd config credential config.json\n'
    : 'CREDENTIALS_DIRECTORY must be an absolute path without control characters\n');
});
