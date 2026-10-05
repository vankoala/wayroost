import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, constants, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { jsonEditor } from '../src/settings/editors/json.js';
import { yamlEditor } from '../src/settings/editors/yaml.js';
import { settingsLockPath, SettingsCommitError, SettingsWriteThrough, type SettingsChange, type SettingsCoordinator, type UndoToken, type WriteThroughOptions } from '../src/settings/write-through.js';

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open), readFile: vi.fn(actual.readFile),
    unlink: vi.fn(actual.unlink), lstat: vi.fn(actual.lstat), link: vi.fn(actual.link) };
});
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const roots: string[] = [];
const coordinate: SettingsCoordinator = async (_target, operation) => operation();
// Fixtures model a trusted root even on hosts with mapped mount ownership.
beforeEach(() => {
  vi.mocked(fs.lstat).mockImplementation(async (path, options) => {
    const stat = await actual.lstat(path, options);
    if (String(path) === '/') stat.uid = typeof stat.uid === 'bigint' ? 0n : 0;
    return stat;
  });
});
const trustedRoot = `
  import filesystem from 'node:fs/promises';
  import { syncBuiltinESMExports } from 'node:module';
  const lstat = filesystem.lstat;
  filesystem.lstat = async (...args) => {
    const stat = await lstat(...args);
    if (String(args[0]) === '/') stat.uid = typeof stat.uid === 'bigint' ? 0n : 0;
    return stat;
  };
  syncBuiltinESMExports();
`;
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  vi.mocked(fs.readFile).mockReset().mockImplementation(actual.readFile);
  vi.mocked(fs.unlink).mockReset().mockImplementation(actual.unlink);
  vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat);
  vi.mocked(fs.link).mockReset().mockImplementation(actual.link);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(source = '{\n  "name": "demo-model",\n  "enabled": true\n}\n', mode = 0o600, options: Partial<WriteThroughOptions> = {}) {
  const tempDir = join(process.cwd(), '.tmp');
  mkdirSync(tempDir, { recursive: true });
  const root = mkdtempSync(join(tempDir, 'settings-'));
  roots.push(root);
  const target = join(root, 'models.json');
  writeFileSync(target, source, { mode });
  chmodSync(target, mode);
  const auditFile = join(root, 'audit', 'audit.jsonl');
  const backupDir = join(root, 'backups');
  const core = new SettingsWriteThrough({ backupDir, auditFile, coordinate, ...options });
  const stat = statSync(target);
  const change: SettingsChange = { target, editor: 'json', operations: [{ type: 'set', path: ['name'], value: 'updated-model' }],
    timing: 'now', expected: { uid: stat.uid, gid: stat.gid, mode } };
  const audit = () => readFileSync(auditFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  return { root, target, auditFile, backupDir, core, change, source, audit };
}

it('backs up exact JSON bytes, applies atomically, verifies, audits and returns an undo token', async () => {
  const f = fixture();
  const original = statSync(f.target);
  const token = await f.core.apply({ ...f.change, preconditions: [{ path: ['name'], value: 'demo-model' }, { path: ['missing'], exists: false }] });
  expect(readFileSync(f.target, 'utf8')).toBe(f.source.replace('demo-model', 'updated-model'));
  expect(readFileSync(join(f.backupDir, token.backupId), 'utf8')).toBe(f.source);
  expect(token.backupId).toMatch(/^[a-f0-9]{64}\/\d{16}-[a-f0-9]{64}-[a-f0-9-]{36}\.bak$/);
  expect(token.backupHash).toBe(createHash('sha256').update(f.source).digest('hex'));
  expect(token.writtenHash).toBe(createHash('sha256').update(readFileSync(f.target)).digest('hex'));
  const current = statSync(f.target);
  expect(current.ino).not.toBe(original.ino);
  expect([current.uid, current.gid, current.mode & 0o7777]).toEqual([original.uid, original.gid, 0o600]);
  expect(fs.rename).toHaveBeenCalledOnce();
  const [temp, target] = vi.mocked(fs.rename).mock.calls[0]!;
  expect(String(temp)).toMatch(/\/\.models\.json\.[a-f0-9-]+\.tmp$/);
  expect(String(target)).toMatch(/^\/proc\/self\/fd\/\d+\/models\.json$/);
  expect(f.audit()).toEqual([expect.objectContaining({ action: 'apply', target: f.target, backupId: token.backupId,
    operations: [{ type: 'set', path: ['name'] }], timing: 'now', result: 'success',
    beforeHash: token.backupHash, afterHash: token.writtenHash })]);
  expect(statSync(f.auditFile).mode & 0o777).toBe(0o600);
  expect(readdirSync(f.root).filter(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([]);
});

it.each(['\n', '\r\n'])('preserves a leading JSON BOM in writes, backups and undo: %j', async newline => {
  const source = `\uFEFF{${newline}\t"name": "demo-model",${newline}\t"enabled": true${newline}}${newline}`;
  const f = fixture(source);
  const token = await f.core.apply({ ...f.change, version: { hash: createHash('sha256').update(source).digest('hex') },
    preconditions: [{ path: ['name'], value: 'demo-model' }] });
  const written = Buffer.from(source.replace('demo-model', 'updated-model'));
  expect(readFileSync(f.target)).toEqual(written);
  expect(readFileSync(f.target).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  expect(readFileSync(join(f.backupDir, token.backupId))).toEqual(Buffer.from(source));
  expect(token.backupHash).toBe(createHash('sha256').update(source).digest('hex'));
  expect(token.writtenHash).toBe(createHash('sha256').update(written).digest('hex'));
  await f.core.undo(token);
  expect(readFileSync(f.target)).toEqual(Buffer.from(source));
  expect(f.audit().map(record => [record.action, record.result])).toEqual([['apply', 'success'], ['undo', 'success']]);
});

it.each([
  { folder: 'trusted config', name: 'models.json', alias: false },
  { folder: 'trusted config', name: 'models with space.json', alias: true },
  { folder: ' trusted config ', name: ' models.json ', alias: false },
  { folder: ' ', name: 'models.json', alias: false },
])('applies and undoes canonical paths containing spaces: $folder/$name, alias $alias', async ({ folder, name, alias }) => {
  const f = fixture();
  const directory = join(f.root, folder);
  mkdirSync(directory, { mode: 0o700 });
  const target = join(directory, name);
  renameSync(f.target, target);
  const directoryAlias = join(f.root, 'alias');
  if (alias) symlinkSync(directory, directoryAlias, 'dir');
  const coordinated = vi.fn();
  const core = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: f.auditFile,
    coordinate: async (target, operation) => { coordinated(target, operation); return operation(); } });
  const token = await core.apply({ ...f.change, target: alias ? join(directoryAlias, name) : target });
  expect(token.target).toBe(target);
  expect(coordinated).toHaveBeenCalledWith(target, expect.any(Function));
  expect(readFileSync(target, 'utf8')).toBe(f.source.replace('demo-model', 'updated-model'));
  expect(readFileSync(join(f.backupDir, token.backupId), 'utf8')).toBe(f.source);
  expect(statSync(target).mode & 0o7777).toBe(f.change.expected.mode);
  await core.undo(token);
  expect(readFileSync(target, 'utf8')).toBe(f.source);
  expect(f.audit().every(record => record.target === target && record.result === 'success')).toBe(true);
  const openedDirectories = vi.mocked(fs.open).mock.calls.filter(([path]) => String(path) === directory);
  expect(openedDirectories.length).toBeGreaterThan(0);
  expect(openedDirectories.every(([, flags]) => (Number(flags) & constants.O_DIRECTORY) !== 0)).toBe(true);
  expect(vi.mocked(fs.open).mock.calls.every(([, flags]) => (Number(flags) & constants.O_NOFOLLOW) !== 0)).toBe(true);
  expect(readdirSync(directory).filter(entry => entry.endsWith('.tmp') || entry.endsWith('.lock'))).toEqual([]);
});

it.each([
  ['symlink', 'symlink_target'], ['directory', 'not_regular'],
  ['unsafe-directory', 'unsafe_directory'], ['unsafe-ancestor', 'unsafe_directory'],
] as const)('keeps filesystem protections for paths containing spaces: %s', async (kind, code) => {
  const f = fixture();
  const directory = join(f.root, 'trusted config');
  mkdirSync(directory, { mode: 0o700 });
  const target = join(directory, 'models with space.json');
  if (kind === 'symlink') symlinkSync(f.target, target);
  else if (kind === 'directory') mkdirSync(target, { mode: 0o700 });
  else writeFileSync(target, f.source, { mode: 0o600 });
  if (kind === 'unsafe-directory') chmodSync(directory, 0o770);
  if (kind === 'unsafe-ancestor') chmodSync(f.root, 0o702);
  await expect(f.core.apply({ ...f.change, target })).rejects.toMatchObject({ code });
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  if (kind !== 'directory') expect(readFileSync(target, 'utf8')).toBe(f.source);
  expect(existsSync(f.backupDir)).toBe(false);
  expect(fs.rename).not.toHaveBeenCalled();
});

it('writes YAML with comments and restores its original bytes on undo', async () => {
  const source = '# Application settings\nmodel:\n  name: "demo-model" # Active model\n  endpoint: \'https://example.com\'\n  enabled: true\nlimits:\n  turns: 5 # Per conversation\n';
  const f = fixture(source);
  const token = await f.core.apply({ ...f.change, editor: 'yaml', timing: 'next-turn', operations: [
    { type: 'set', path: ['model', 'name'], value: 'updated-model' },
    { type: 'delete', path: ['model', 'enabled'] },
  ] });
  const written = readFileSync(f.target, 'utf8');
  expect(written).toContain('# Application settings');
  expect(written).toContain('name: "updated-model" # Active model');
  expect(written).toContain('endpoint: \'https://example.com\'');
  expect(written).toContain('turns: 5 # Per conversation');
  expect(written).not.toContain('enabled:');
  await f.core.undo(token);
  expect(readFileSync(f.target)).toEqual(Buffer.from(source));
  expect(f.audit().map(record => [record.action, record.result, record.timing])).toEqual([
    ['apply', 'success', 'next-turn'], ['undo', 'success', 'next-turn'],
  ]);
});

it.each(['\n', '\r\n'])('applies a YAML mapping-to-block-scalar edit with literal hash spacing and undoes exact bytes: %j', async newline => {
  const source = ['doc:', '  a: old     # comment', '  b: old', 'keep: true     # Keep comment', ''].join(newline);
  const value = 'a: old # comment\nb: old\n';
  const f = fixture(source);
  const token = await f.core.apply({ ...f.change, editor: 'yaml', operations: [{ type: 'set', path: ['doc'], value }] });
  const written = readFileSync(f.target, 'utf8');
  expect(yamlEditor.parse(written)).toEqual({ doc: value, keep: true });
  expect(written).toContain(`keep: true     # Keep comment${newline}`);
  const consumer = spawnSync('python3', ['-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
    { input: written, encoding: 'utf8' });
  expect(consumer.status, consumer.stderr).toBe(0);
  expect(JSON.parse(consumer.stdout)).toEqual({ doc: value, keep: true });
  expect(readFileSync(join(f.backupDir, token.backupId))).toEqual(Buffer.from(source));
  await f.core.undo(token);
  expect(readFileSync(f.target)).toEqual(Buffer.from(source));
  expect(f.audit().map(record => [record.action, record.result])).toEqual([['apply', 'success'], ['undo', 'success']]);
});

it.each([
  { source: 'a: 1', operations: [{ type: 'set', path: ['b'], value: 2 }], expected: { a: 1, b: 2 } },
  { source: 'items:\n- one\n- two\n', operations: [{ type: 'set', path: ['items', 2], value: 'three' }],
    expected: { items: ['one', 'two', 'three'] } },
  { source: '-\n  a: 1\n  b: 2\n', operations: [{ type: 'set', path: [0], value: 'new' }], expected: ['new'] },
] as { source: string; operations: SettingsChange['operations']; expected: unknown }[])(
  'applies YAML edits with required separators and markers and undoes exact bytes: $source', async ({ source, operations, expected }) => {
    const f = fixture(source);
    const token = await f.core.apply({ ...f.change, editor: 'yaml', operations });
    const written = readFileSync(f.target, 'utf8');
    expect(yamlEditor.parse(written)).toEqual(expected);
    const consumer = spawnSync('python3', ['-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
      { input: written, encoding: 'utf8' });
    expect(consumer.status, consumer.stderr).toBe(0);
    expect(JSON.parse(consumer.stdout)).toEqual(expected);
    expect(readFileSync(join(f.backupDir, token.backupId))).toEqual(Buffer.from(source));
    await f.core.undo(token);
    expect(readFileSync(f.target)).toEqual(Buffer.from(source));
    expect(f.audit().map(record => [record.action, record.result])).toEqual([['apply', 'success'], ['undo', 'success']]);
  });

it.each(['<<', '='])('applies reserved YAML string values readable by the consumer and undoes the exact bytes: %s', async value => {
  const source = 'value: old # Keep comment\nitems: [old]\n';
  const f = fixture(source);
  const nested = { nested: value, items: [value, { value }] };
  const token = await f.core.apply({ ...f.change, editor: 'yaml', operations: [
    { type: 'set', path: ['value'], value },
    { type: 'set', path: ['items'], value: [value, nested] },
    { type: 'set', path: ['added', 'value'], value },
  ] });
  const written = readFileSync(f.target, 'utf8');
  const consumer = spawnSync('python3', ['-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
    { input: written, encoding: 'utf8' });
  expect(consumer.status, consumer.stderr).toBe(0);
  expect(JSON.parse(consumer.stdout)).toEqual({ value, items: [value, nested], added: { value } });
  expect(written).toContain('# Keep comment');
  expect(f.audit()[0]).toMatchObject({ result: 'success', backupId: token.backupId });
  await f.core.undo(token);
  expect(readFileSync(f.target)).toEqual(Buffer.from(source));
  expect(f.audit().map(record => [record.action, record.result])).toEqual([['apply', 'success'], ['undo', 'success']]);
});

it('applies and undoes nested array changes in a models config', async () => {
  const source = '{\n    "providers": {\n        "demo": { "models": [{ "id": "demo-one", "limits": [1, 2] }, { "id": "demo-two" }] }\n    },\n    "last": true\n}\n';
  const f = fixture(source);
  const token = await f.core.apply({ ...f.change, timing: 'restart:demo-service', operations: [
    { type: 'set', path: ['providers', 'demo', 'models', 0, 'limits', 1], value: 3 },
    { type: 'delete', path: ['providers', 'demo', 'models', 1] },
  ] });
  expect(readFileSync(f.target, 'utf8')).toContain('"limits": [1, 3]');
  expect(readFileSync(f.target, 'utf8')).not.toContain('demo-two');
  await f.core.undo(token);
  expect(readFileSync(f.target, 'utf8')).toBe(source);
});

it.each(['+_', '-__', '+_0', '-_0', '+_01', '-_10', '+__7', '+_77'])(
  'writes a signed underscore string as quoted YAML and undoes the exact bytes: %s', async value => {
    const source = 'value: old # Keep comment\n';
    const f = fixture(source);
    const token = await f.core.apply({ ...f.change, editor: 'yaml', operations: [
      { type: 'set', path: ['value'], value },
      { type: 'set', path: ['added'], value: { [value]: [value] } },
    ] });
    const written = readFileSync(f.target, 'utf8');
    expect(written).toContain(`value: "${value}" # Keep comment`);
    expect(written).toContain(`"${value}":`);
    expect(yamlEditor.parse(written)).toEqual({ value, added: { [value]: [value] } });
    await f.core.undo(token);
    expect(readFileSync(f.target)).toEqual(Buffer.from(source));
    expect(f.audit().map(record => record.result)).toEqual(['success', 'success']);
  });

it.each(['+_', '-_', '+__', '-__'])(
  'refuses an unloadable signed underscore scalar before backup or replacement: %s', async scalar => {
    const f = fixture(`value: ${scalar}\nname: original\n`);
    await expect(f.core.apply({ ...f.change, editor: 'yaml' })).rejects.toMatchObject({ code: 'parse_failed' });
    expect(readFileSync(f.target, 'utf8')).toBe(f.source);
    expect(existsSync(f.backupDir)).toBe(false);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(f.audit()[0]).toMatchObject({ result: 'failure', error: 'parse_failed', backupId: null });
  });

it.each([['+_0', 0], ['-__07', -7], ['+_012', 10], ['-_10', -10]] as const)(
  'checks signed underscore integer preconditions with consumer values: %s', async (scalar, value) => {
    const f = fixture(`value: ${scalar}    # Keep spacing\nname: original\n`);
    const token = await f.core.apply({ ...f.change, editor: 'yaml', preconditions: [{ path: ['value'], value }] });
    expect(yamlEditor.parse(readFileSync(f.target, 'utf8'))).toEqual({ value, name: 'updated-model' });
    await f.core.undo(token);
    expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  });

it.each([
  { source: 'items:\n  - name: first\n    keep:    \'one\'     # Keep padding\nlast: true\n',
    operations: [{ type: 'delete', path: ['items', 0, 'name'] }], expected: { items: [{ keep: 'one' }], last: true } },
  { source: 'value: old # Keep comment\nlast: true\n',
    operations: [{ type: 'set', path: ['value'], value: { new: 1 } }], expected: { value: { new: 1 }, last: true } },
  { source: 'items: # Keep comment\n  - only\nlast: true\n',
    operations: [{ type: 'delete', path: ['items', 0] }], expected: { items: [], last: true } },
  { source: 'value:\n  only: 1\nlast: true\n',
    operations: [{ type: 'delete', path: ['value', 'only'] }], expected: { value: {}, last: true } },
] as { source: string; operations: SettingsChange['operations']; expected: unknown }[])(
  'applies YAML collection layout changes and restores exact backup bytes: $source', async ({ source, operations, expected }) => {
    const f = fixture(source);
    const token = await f.core.apply({ ...f.change, editor: 'yaml', operations });
    const written = readFileSync(f.target, 'utf8');
    expect(yamlEditor.parse(written)).toEqual(expected);
    expect(written).toContain('last: true\n');
    if (source.includes('# Keep comment')) expect(written).toContain('# Keep comment');
    await f.core.undo(token);
    expect(readFileSync(f.target)).toEqual(Buffer.from(source));
    expect(f.audit().map(record => [record.action, record.result])).toEqual([['apply', 'success'], ['undo', 'success']]);
  });

it('applies a deletion beside a nested YAML sequence and undoes the exact original bytes', async () => {
  const source = '- a:\n    items:\n    - one\n    remove: old\n';
  const f = fixture(source);
  const token = await f.core.apply({ ...f.change, editor: 'yaml', operations: [{ type: 'delete', path: [0, 'a', 'remove'] }] });
  const written = readFileSync(f.target, 'utf8');
  expect(yamlEditor.parse(written)).toEqual([{ a: { items: ['one'] } }]);
  expect(readFileSync(join(f.backupDir, token.backupId))).toEqual(Buffer.from(source));
  await f.core.undo(token);
  expect(readFileSync(f.target)).toEqual(Buffer.from(source));
  expect(f.audit().map(record => [record.action, record.result])).toEqual([['apply', 'success'], ['undo', 'success']]);
});

it('detects an outside rewrite after backup and leaves the outside bytes intact', async () => {
  const f = fixture();
  const edit = jsonEditor.edit;
  const outside = '{"name":"outside-model"}\n';
  vi.spyOn(jsonEditor, 'edit').mockImplementation((source, operations) => {
    writeFileSync(f.target, outside);
    return edit(source, operations);
  });
  await expect(f.core.apply(f.change)).rejects.toThrow('changed underneath');
  expect(readFileSync(f.target, 'utf8')).toBe(outside);
  expect(fs.rename).not.toHaveBeenCalled();
  expect(f.audit()[0]).toMatchObject({ result: 'failure', error: 'changed_underneath' });
  expect(readdirSync(f.root).filter(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([]);
});

it('detects a changed hash even when an outside writer restores the mtime', async () => {
  const f = fixture();
  const original = statSync(f.target);
  const edit = jsonEditor.edit;
  vi.spyOn(jsonEditor, 'edit').mockImplementation((source, operations) => {
    writeFileSync(f.target, source.replace('demo-model', 'same-model'));
    utimesSync(f.target, original.atime, original.mtime);
    return edit(source, operations);
  });
  await expect(f.core.apply(f.change)).rejects.toThrow('changed underneath');
  expect(readFileSync(f.target, 'utf8')).toContain('same-model');
  expect(fs.rename).not.toHaveBeenCalled();
});

it.each(['mtime', 'replacement'] as const)('allows an identical outside save with a new %s between checking and applying', async kind => {
  const f = fixture();
  const original = statSync(f.target);
  const edit = jsonEditor.edit;
  vi.spyOn(jsonEditor, 'edit').mockImplementation((source, operations) => {
    if (kind === 'replacement') {
      const replacement = join(f.root, 'outside.json');
      writeFileSync(replacement, source, { mode: 0o600 });
      renameSync(replacement, f.target);
      expect(statSync(f.target).ino).not.toBe(original.ino);
    }
    utimesSync(f.target, original.atime, new Date(original.mtimeMs + 10_000));
    return edit(source, operations);
  });
  const token = await f.core.apply(f.change);
  expect(readFileSync(f.target, 'utf8')).toBe(f.source.replace('demo-model', 'updated-model'));
  await f.core.undo(token);
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
});

it('enforces a caller-supplied content hash before making a backup', async () => {
  const f = fixture();
  const version = { mtimeNs: lstatSync(f.target, { bigint: true }).mtimeNs.toString(), hash: createHash('sha256').update(f.source).digest('hex') };
  writeFileSync(f.target, '{"name":"outside-model"}');
  await expect(f.core.apply({ ...f.change, version })).rejects.toThrow('changed underneath');
  expect(existsSync(f.backupDir)).toBe(false);
  expect(fs.rename).not.toHaveBeenCalled();
});

it.each(['mtime', 'replacement'] as const)('accepts a version after an identical outside save with a new %s', async kind => {
  const f = fixture();
  const original = lstatSync(f.target, { bigint: true });
  const version = { mtimeNs: original.mtimeNs.toString(), hash: createHash('sha256').update(f.source).digest('hex') };
  if (kind === 'replacement') {
    const replacement = join(f.root, 'outside.json');
    writeFileSync(replacement, f.source, { mode: 0o600 });
    renameSync(replacement, f.target);
    expect(lstatSync(f.target, { bigint: true }).ino).not.toBe(original.ino);
  }
  utimesSync(f.target, new Date(), new Date(Number(original.mtimeNs / 1_000_000n) + 10_000));
  const token = await f.core.apply({ ...f.change, version });
  expect(token.backupHash).toBe(version.hash);
  expect(readFileSync(f.target, 'utf8')).toBe(f.source.replace('demo-model', 'updated-model'));
});

it('accepts a content-only version', async () => {
  const f = fixture();
  await f.core.apply({ ...f.change, version: { hash: createHash('sha256').update(f.source).digest('hex') } });
  expect(readFileSync(f.target, 'utf8')).toBe(f.source.replace('demo-model', 'updated-model'));
});

it.each(['now', 'next-turn', 'next-chat', 'next-run', 'restart-when-idle:demo-service', 'restart-now:demo-service'] as const)(
  'accepts and retains the timing label through apply, undo and audit: %s', async timing => {
    const f = fixture();
    const token = await f.core.apply({ ...f.change, timing });
    expect(token.timing).toBe(timing);
    await f.core.undo(token);
    expect(readFileSync(f.target, 'utf8')).toBe(f.source);
    expect(f.audit().map(record => record.timing)).toEqual([timing, timing]);
  });

it.each(['restart-when-idle:', 'restart-now:', 'restart-now:demo service', 'restart-when-idle:demo\nservice', 'next-chat\n'])(
  'refuses a malformed timing label before mutation: %j', async timing => {
    const f = fixture();
    await expect(f.core.apply({ ...f.change, timing: timing as never })).rejects.toMatchObject({ code: 'invalid_change' });
    expect(readFileSync(f.target, 'utf8')).toBe(f.source);
    expect(fs.rename).not.toHaveBeenCalled();
  });

it('edits a YAML file containing a consumer string scalar and preserves its unedited lines', async () => {
  const source = '# Settings\nterminal:\n  cwd: +.     # Keep spacing\nname: original\n';
  const f = fixture(source);
  const token = await f.core.apply({ ...f.change, editor: 'yaml' });
  expect(readFileSync(f.target, 'utf8')).toBe(source.replace('name: original', 'name: updated-model'));
  await f.core.undo(token);
  expect(readFileSync(f.target, 'utf8')).toBe(source);
});

it('refuses a YAML plain scalar that the consumer rejects before backup or replacement', async () => {
  const f = fixture('value: ._\nname: original\n');
  await expect(f.core.apply({ ...f.change, editor: 'yaml' })).rejects.toMatchObject({ code: 'parse_failed' });
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(existsSync(f.backupDir)).toBe(false);
  expect(fs.rename).not.toHaveBeenCalled();
});

it('uses an exclusive per-target lock while allowing a different target to proceed', async () => {
  const f = fixture();
  const second = join(f.root, 'other.json');
  writeFileSync(second, f.source, { mode: 0o600 });
  const lock = settingsLockPath(f.target);
  expect(lock).toBe(`${f.target}.wayroost-settings.lock`);
  writeFileSync(lock, '', { mode: 0o600, flag: 'wx' });
  await expect(f.core.apply(f.change)).rejects.toThrow('locked by another writer');
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  await f.core.apply({ ...f.change, target: second });
  expect(readFileSync(second, 'utf8')).toContain('updated-model');
  expect(existsSync(lock)).toBe(true);
});

it('holds the exclusive lock through an atomic write and rejects a simultaneous writer', async () => {
  const f = fixture();
  let reached!: () => void;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { reached = resolve; });
  const ready = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    reached();
    await ready;
    await actual.rename(from, to);
  });
  const first = f.core.apply(f.change);
  try {
    await pending;
    expect(statSync(`${f.target}.wayroost-settings.lock`).mode & 0o777).toBe(0o600);
    const other = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: f.auditFile, coordinate });
    await expect(other.apply(f.change)).rejects.toThrow('locked by another writer');
    expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  } finally { release(); }
  await first;
  expect(readFileSync(f.target, 'utf8')).toContain('updated-model');
  expect(existsSync(`${f.target}.wayroost-settings.lock`)).toBe(false);
});

it('uses the same target lock through directory aliases and refuses a symlink lock', async () => {
  const f = fixture();
  const alias = join(f.root, 'alias');
  symlinkSync(f.root, alias, 'dir');
  const lock = `${f.target}.wayroost-settings.lock`;
  symlinkSync(f.target, lock);
  await expect(f.core.apply({ ...f.change, target: join(alias, 'models.json') })).rejects.toThrow('locked by another writer');
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(lstatSync(lock).isSymbolicLink()).toBe(true);
});

it('refuses a symlink target and leaves its referent untouched', async () => {
  const f = fixture();
  const link = join(f.root, 'linked.json');
  symlinkSync(f.target, link);
  await expect(f.core.apply({ ...f.change, target: link })).rejects.toThrow('must not be a symlink');
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(f.audit()[0]).toMatchObject({ result: 'failure', error: 'symlink_target' });
  expect(existsSync(f.backupDir)).toBe(false);
});

it.each(['{"password":"demo-private"', 'password: ["demo-private"'])('leaves malformed config untouched and omits parse contents from errors and audit: %j', async source => {
  const f = fixture(source);
  const editor = source.startsWith('{') ? 'json' : 'yaml';
  await expect(f.core.apply({ ...f.change, editor })).rejects.toThrow(`Settings file is not valid ${editor.toUpperCase()}.`);
  expect(readFileSync(f.target, 'utf8')).toBe(source);
  expect(existsSync(f.backupDir)).toBe(false);
  expect(readFileSync(f.auditFile, 'utf8')).not.toContain('demo-private');
  expect(f.audit()[0]).toMatchObject({ result: 'failure', error: 'parse_failed' });
});

it.each(['json', 'yaml'] as const)('refuses malformed UTF-8 in unrelated %s values before backup or editing', async editor => {
  for (const invalid of [[0xff], [0x80], [0xc2], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xc3, 0x41]]) {
    const f = fixture();
    const bytes = Buffer.concat([Buffer.from(editor === 'json' ? '{"name":"demo-model","note":"' : 'name: demo-model\nnote: "'),
      Buffer.from(invalid), Buffer.from(editor === 'json' ? '"}\n' : '"\n')]);
    writeFileSync(f.target, bytes);
    const before = statSync(f.target);
    await expect(f.core.apply({ ...f.change, editor, preconditions: [{ path: ['name'], value: 'demo-model' }] }))
      .rejects.toMatchObject({ name: 'SettingsWriteError', code: 'parse_failed' });
    expect(readFileSync(f.target)).toEqual(bytes);
    expect(statSync(f.target).ino).toBe(before.ino);
    expect(existsSync(f.backupDir)).toBe(false);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(f.audit()[0]).toMatchObject({ result: 'failure', error: 'parse_failed', backupId: null });
  }
});

it.each(['json', 'yaml'] as const)('preserves valid multibyte UTF-8 and a literal replacement character in %s', async editor => {
  const source = editor === 'json' ? '{"name":"demo-model","note":"café 日本語 🙂 �"}\n'
    : 'name: demo-model\nnote: "café 日本語 🙂 �"\n';
  const f = fixture(source);
  const token = await f.core.apply({ ...f.change, editor });
  expect(readFileSync(f.target, 'utf8')).toContain('café 日本語 🙂 �');
  await f.core.undo(token);
  expect(readFileSync(f.target)).toEqual(Buffer.from(source));
});

it.each(['json', 'yaml'] as const)('refuses malformed UTF-8 in a hash-matching %s undo backup', async editor => {
  const f = fixture(editor === 'json' ? '{"name":"demo-model","note":"old"}\n' : 'name: demo-model\nnote: "old"\n');
  const token = await f.core.apply({ ...f.change, editor });
  const written = readFileSync(f.target);
  const malformed = Buffer.concat([Buffer.from(editor === 'json' ? '{"name":"demo-model","note":"' : 'name: demo-model\nnote: "'),
    Buffer.from([0xff]), Buffer.from(editor === 'json' ? '"}\n' : '"\n')]);
  writeFileSync(join(f.backupDir, token.backupId), malformed);
  const names = readdirSync(join(f.backupDir, token.backupId.split('/')[0]!));
  vi.mocked(fs.rename).mockClear();
  await expect(f.core.undo({ ...token, backupHash: createHash('sha256').update(malformed).digest('hex') }))
    .rejects.toMatchObject({ code: 'parse_failed' });
  expect(readFileSync(f.target)).toEqual(written);
  expect(readFileSync(join(f.backupDir, token.backupId))).toEqual(malformed);
  expect(readdirSync(join(f.backupDir, token.backupId.split('/')[0]!))).toEqual(names);
  expect(fs.rename).not.toHaveBeenCalled();
});

it.each(['uid', 'gid', 'mode'] as const)('refuses unexpected file %s', async key => {
  const f = fixture();
  const expected = { ...f.change.expected, [key]: f.change.expected[key] + 1 };
  await expect(f.core.apply({ ...f.change, expected })).rejects.toThrow('owner or mode differs');
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(existsSync(f.backupDir)).toBe(false);
});

it('refuses missing and non-regular targets', async () => {
  const f = fixture();
  await expect(f.core.apply({ ...f.change, target: join(f.root, 'missing.json') })).rejects.toThrow('Settings target does not exist.');
  await expect(f.core.apply({ ...f.change, target: f.root })).rejects.toThrow('must be a regular file');
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
});

it.each([{ path: ['name'], value: 'stale-model' }, { path: ['name'], exists: false }, { path: ['missing'], exists: true }])('refuses a value precondition before backing up or writing: %j', async precondition => {
  const f = fixture();
  await expect(f.core.apply({ ...f.change, preconditions: [precondition] })).rejects.toThrow('no longer meets its precondition');
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(existsSync(f.backupDir)).toBe(false);
  expect(f.audit()[0]).toMatchObject({ result: 'failure', error: 'precondition_failed' });
});

it.each(['y', 'Y', 'n', 'N'].flatMap(scalar => ['write', 'precondition'].map(action => ({ scalar, action }))))(
  'refuses a YAML boolean $action when the consumer reads $scalar as a string', async ({ scalar, action }) => {
    const source = `value: ${scalar} # Keep comment\nname: original\n`;
    const f = fixture(source);
    const consumer = spawnSync('python3', ['-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
      { input: source, encoding: 'utf8' });
    expect(consumer.status, consumer.stderr).toBe(0);
    expect(JSON.parse(consumer.stdout)).toEqual({ value: scalar, name: 'original' });
    const value = /^[yY]$/.test(scalar);
    const change: SettingsChange = action === 'write'
      ? { ...f.change, editor: 'yaml', operations: [{ type: 'set', path: ['value'], value }] }
      : { ...f.change, editor: 'yaml', preconditions: [{ path: ['value'], value }] };
    await expect(f.core.apply(change)).rejects.toMatchObject({ code: 'parse_failed' });
    expect(readFileSync(f.target, 'utf8')).toBe(source);
    expect(existsSync(f.backupDir)).toBe(false);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(f.audit()).toEqual([expect.objectContaining({ result: 'failure', error: 'parse_failed', backupId: null })]);
  });

it.each([
  { source: '! on: old\n', path: ['on'], value: 'old', consumerValue: { true: 'old' } },
  { source: 'value: ! false\n', path: ['value'], value: 'false', consumerValue: { value: false } },
])('refuses a non-specific YAML tag before using a mismatched consumer precondition: $source', async ({ source, path, value, consumerValue }) => {
  const f = fixture(source);
  const consumer = spawnSync('python3', ['-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
    { input: source, encoding: 'utf8' });
  expect(consumer.status, consumer.stderr).toBe(0);
  expect(JSON.parse(consumer.stdout)).toEqual(consumerValue);
  await expect(f.core.apply({ ...f.change, editor: 'yaml', preconditions: [{ path, value }],
    operations: [{ type: 'set', path, value: 'updated' }] })).rejects.toMatchObject({
    name: 'SettingsWriteError', code: 'unsupported_yaml',
    message: "Settings file uses YAML features Wayroost won't edit automatically.",
  });
  expect(readFileSync(f.target)).toEqual(Buffer.from(source));
  expect(existsSync(f.backupDir)).toBe(false);
  expect(fs.rename).not.toHaveBeenCalled();
  expect(f.audit()).toEqual([expect.objectContaining({ result: 'failure', error: 'unsupported_yaml', backupId: null })]);
});

it.each([
  ['multiple documents', 'name: first\n---\nname: second\n'],
  ['explicit tag', 'value: !!str false\nname: original\n'],
  ['anchor', 'value: &base old\nname: original\n'],
  ['alias', 'value: *base\nname: original\n'],
  ['merge key', 'settings:\n  <<: { enabled: true }\nname: original\n'],
  ['explicit key', '? explicit\n: val\nname: original\n'],
  ['multiline explicit key', '? |-\n  first\n  second\n: val\nkeep: old\n'],
  ['nested explicit key', 'items:\n- ? explicit\n  : val\n  keep: old\n'],
  ['flow explicit key', 'settings: { ? explicit: val }\nname: original\n'],
  ['sequence key', '? [a, b]\n: old\nname: original\n'],
  ['map key', '? { item: old }\n: old\nname: original\n'],
] as const)('leaves YAML with a %s untouched before backup or rename', async (_feature, source) => {
  const f = fixture(source);
  const original = statSync(f.target);
  await expect(f.core.apply({ ...f.change, editor: 'yaml' })).rejects.toMatchObject({ name: 'SettingsWriteError', code: 'unsupported_yaml' });
  expect(readFileSync(f.target)).toEqual(Buffer.from(source));
  const current = statSync(f.target);
  expect([current.ino, current.mtimeMs, current.mode, current.uid, current.gid])
    .toEqual([original.ino, original.mtimeMs, original.mode, original.uid, original.gid]);
  expect(existsSync(f.backupDir)).toBe(false);
  expect(fs.rename).not.toHaveBeenCalled();
  expect(f.audit()).toEqual([expect.objectContaining({ result: 'failure', error: 'unsupported_yaml', backupId: null })]);
});

it('restores exact JSON bytes, owner and mode from a token used by a fresh instance', async () => {
  const f = fixture(' \n{\n\t"name": "demo-model",\n\t"amount": 1e2\n}\n ', 0o640);
  const token = await f.core.apply(f.change);
  const other = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: f.auditFile, coordinate });
  await other.undo(token);
  expect(readFileSync(f.target)).toEqual(Buffer.from(f.source));
  const stat = statSync(f.target);
  expect([stat.uid, stat.gid, stat.mode & 0o7777]).toEqual([f.change.expected.uid, f.change.expected.gid, 0o640]);
  expect(f.audit()[1]).toMatchObject({ action: 'undo', backupId: token.backupId, result: 'success' });
});

it('refuses undo after an outside change and explains why without altering it', async () => {
  const f = fixture();
  const token = await f.core.apply(f.change);
  const outside = '{"name":"outside-model","password":"demo-outside-private"}\n';
  writeFileSync(f.target, outside);
  await expect(f.core.undo(token)).rejects.toThrow('Undo refused: settings changed since this write');
  expect(readFileSync(f.target, 'utf8')).toBe(outside);
  expect(f.audit()[1]).toMatchObject({ action: 'undo', result: 'failure', error: 'undo_changed' });
  expect(readFileSync(f.auditFile, 'utf8')).not.toContain('demo-outside-private');
});

it('refuses a tampered backup and a backup id belonging to a different target', async () => {
  const f = fixture();
  const token = await f.core.apply(f.change);
  writeFileSync(join(f.backupDir, token.backupId), '{"name":"tampered"}');
  await expect(f.core.undo(token)).rejects.toThrow('no longer match the saved hash');
  await expect(f.core.undo({ ...token, backupId: '../models.json' })).rejects.toThrow('identifier is invalid');
  expect(readFileSync(f.target, 'utf8')).toContain('updated-model');
});

it.each([
  ['backupId', { password: 'demo-private-id' }],
  ['backupId', ['demo-private-id']],
  ['backupId', '../demo-private-id'],
  ['backupId', 'demo-private-id\n'],
  ['backupHash', { password: 'demo-private-id' }],
  ['writtenHash', 'demo-private-id'],
  ['editor', 'demo-private-id'],
  ['editor', ['json']],
  ['expected', { password: 'demo-private-id' }],
  ['timing', { password: 'demo-private-id' }],
  ['timing', ['now']],
  ['target', { password: 'demo-private-id' }],
  ['target', '/home/me/../demo-private-id'],
  ['target', '/home/me/demo-private-id\n'],
] as const)('rejects an invalid undo %s before using or auditing any input', async (field, value) => {
  const f = fixture();
  const token = await f.core.apply(f.change);
  const written = readFileSync(f.target);
  const audit = readFileSync(f.auditFile);
  const backups = readdirSync(join(f.backupDir, token.backupId.split('/')[0]!));
  vi.mocked(fs.open).mockClear();
  vi.mocked(fs.rename).mockClear();
  await expect(f.core.undo({ ...token, [field]: value } as unknown as UndoToken)).rejects.toMatchObject({ code: 'invalid_id' });
  expect(readFileSync(f.target)).toEqual(written);
  expect(readdirSync(join(f.backupDir, token.backupId.split('/')[0]!))).toEqual(backups);
  expect(fs.rename).not.toHaveBeenCalled();
  expect(vi.mocked(fs.open).mock.calls.every(([path]) => !String(path).endsWith('/models.json'))).toBe(true);
  if (field === 'target') {
    expect(readFileSync(f.auditFile)).toEqual(audit);
    expect(fs.open).not.toHaveBeenCalled();
  } else expect(f.audit()[1]).toEqual({ timestamp: expect.any(String), action: 'undo', target: 'invalid id', operations: [],
    backupId: null, timing: 'now', result: 'failure', error: 'invalid id' });
  expect(readFileSync(f.auditFile, 'utf8')).not.toContain('demo-private-id');
});

it.each([
  null, {}, { password: 'demo-private-id' }, 'demo-private-id',
])('rejects an incomplete undo token without echoing it: %j', async input => {
  const f = fixture();
  await expect(f.core.undo(input as unknown as UndoToken)).rejects.toMatchObject({ code: 'invalid_id' });
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(existsSync(f.backupDir)).toBe(false);
  expect(existsSync(f.auditFile)).toBe(false);
  expect(existsSync(join(f.root, 'audit'))).toBe(false);
  expect(fs.open).not.toHaveBeenCalled();
});

it.each([
  { target: { password: 'demo-private-id' } },
  { target: '/home/me/../demo-private-id' },
  { target: '/home/me/demo-private-id\n' },
  { version: { hash: { password: 'demo-private-id' }, mtimeNs: '1' } },
  { version: { hash: 'a'.repeat(64), mtimeNs: 'demo-private-id' } },
])('rejects invalid apply identifiers before copying request data into the audit: %j', async fields => {
  const f = fixture();
  await expect(f.core.apply({ ...f.change, ...fields } as unknown as SettingsChange)).rejects.toMatchObject({ code: 'invalid_id' });
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(existsSync(f.backupDir)).toBe(false);
  expect(fs.rename).not.toHaveBeenCalled();
  if ('target' in fields) {
    expect(existsSync(f.auditFile)).toBe(false);
    expect(existsSync(join(f.root, 'audit'))).toBe(false);
    expect(fs.open).not.toHaveBeenCalled();
  } else {
    expect(f.audit()).toEqual([expect.objectContaining({ action: 'apply', target: 'invalid id', backupId: null,
      operations: [], timing: 'now', error: 'invalid id' })]);
    expect(readFileSync(f.auditFile, 'utf8')).not.toContain('demo-private-id');
  }
});

it('rejects malformed backup UUIDs, trailing data and other target identities at the boundary', async () => {
  const f = fixture();
  const token = await f.core.apply(f.change);
  const written = readFileSync(f.target);
  for (const backupId of [token.backupId + '\n', token.backupId.replace(/.{36}\.bak$/, '-'.repeat(36) + '.bak'),
    '0'.repeat(64) + token.backupId.slice(64)]) {
    await expect(f.core.undo({ ...token, backupId })).rejects.toMatchObject({ code: 'invalid_id' });
  }
  expect(readFileSync(f.target)).toEqual(written);
  expect(f.audit().slice(1).every(record => record.target === 'invalid id' && record.backupId === null)).toBe(true);
});

it.each(['apply', 'undo'] as const)('preserves collision guards for invalid %s identifiers', async action => {
  const f = fixture('{"name":"demo-model"}');
  const token = action === 'undo' ? await f.core.apply(f.change) : undefined;
  const written = readFileSync(f.target);
  const metadata = statSync(f.target);
  const alias = join(f.root, 'alias');
  symlinkSync(f.root, alias, 'dir');
  const hardlink = join(f.root, 'audit-hardlink');
  linkSync(f.target, hardlink);
  for (const [auditFile, code] of [[f.target, 'storage_collision'], [join(alias, 'models.json'), 'storage_collision'],
    [hardlink, 'storage_collision']] as const) {
    const core = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile, coordinate });
    vi.mocked(fs.rename).mockClear();
    const result = action === 'apply'
      ? core.apply({ ...f.change, version: { hash: 'invalid', mtimeNs: '1' } })
      : core.undo({ ...token!, backupId: 'invalid' });
    await expect(result).rejects.toMatchObject({ code });
    expect(readFileSync(f.target)).toEqual(written);
    expect(statSync(f.target).ino).toBe(metadata.ino);
    expect(statSync(f.target).mtimeMs).toBe(metadata.mtimeMs);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(existsSync(`${f.target}.wayroost-settings.lock`)).toBe(false);
  }
});

it.each(['apply', 'undo', 'invalid-apply', 'invalid-undo'] as const)(
  'refuses an audit inside backup storage before opening an existing backup: %s', async action => {
    const f = fixture('{"name":"demo-model"}');
    const token = await f.core.apply(f.change);
    const backup = join(f.backupDir, token.backupId);
    const bytes = readFileSync(backup);
    const written = readFileSync(f.target);
    const audit = readFileSync(f.auditFile);
    const other = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: backup, coordinate });
    vi.mocked(fs.open).mockClear();
    vi.mocked(fs.rename).mockClear();
    const request = action === 'apply' ? other.apply(f.change) : action === 'undo' ? other.undo(token)
      : action === 'invalid-apply' ? other.apply({ ...f.change, version: { hash: 'invalid', mtimeNs: '1' } })
        : other.undo({ ...token, backupId: 'invalid' });
    await expect(request).rejects.toMatchObject({ code: 'storage_collision' });
    expect(readFileSync(backup)).toEqual(bytes);
    expect(readFileSync(f.target)).toEqual(written);
    expect(readFileSync(f.auditFile)).toEqual(audit);
    expect(vi.mocked(fs.open).mock.calls.some(([path]) => String(path).endsWith('/' + token.backupId.split('/')[1]))).toBe(false);
    expect(fs.rename).not.toHaveBeenCalled();
    await f.core.undo(token);
    expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  });

it.each(['same', 'audit-inside-backups', 'backups-inside-audit', 'alias', 'alias-missing'] as const)(
  'refuses overlapping canonical audit and backup directories without creating storage: %s', async kind => {
    const f = fixture();
    const storage = join(f.root, 'storage');
    mkdirSync(storage, { mode: 0o700 });
    const alias = join(f.root, 'storage-alias');
    symlinkSync(storage, alias, 'dir');
    const backupDir = kind === 'backups-inside-audit' ? join(storage, 'backups')
      : kind === 'alias-missing' ? join(storage, 'missing') : storage;
    const auditDir = kind === 'audit-inside-backups' ? join(storage, 'audit')
      : kind === 'alias' ? alias : kind === 'alias-missing' ? join(alias, 'missing', 'audit') : storage;
    const auditFile = join(auditDir, 'audit.jsonl');
    const other = new SettingsWriteThrough({ backupDir, auditFile, coordinate });
    await expect(other.apply({ ...f.change, version: { hash: 'invalid', mtimeNs: '1' } }))
      .rejects.toMatchObject({ code: 'storage_collision' });
    expect(readFileSync(f.target, 'utf8')).toBe(f.source);
    expect(readdirSync(storage)).toEqual([]);
    expect(existsSync(auditFile)).toBe(false);
    expect(fs.rename).not.toHaveBeenCalled();
  });

it.each(['Map', 'Set', 'Date', 'Uint8Array', 'class', 'Map-plain-prototype', 'Set-plain-prototype']
  .flatMap(kind => ['apply', 'undo'].map(action => ({ kind, action }))))(
  'rejects an unsupported request container before cloning or invoking a nested getter: $kind $action', async ({ kind, action }) => {
    const f = fixture();
    const token = action === 'undo' ? await f.core.apply(f.change) : undefined;
    const before = readFileSync(f.target);
    const operation = { type: 'set' as const, path: ['password'], value: 'demo-container-private' };
    const getter = vi.fn(() => { operation.path = ['name']; return 'changed'; });
    const nested = Object.defineProperty({}, 'mutate', { enumerable: true, get: getter });
    const extra = kind.startsWith('Map') ? new Map([[nested, nested]]) : kind.startsWith('Set') ? new Set([nested])
      : kind === 'Date' ? new Date(0) : kind === 'Uint8Array' ? new Uint8Array([1]) : new (class {})();
    if (kind.endsWith('-plain-prototype')) Object.setPrototypeOf(extra, Object.prototype);
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const request = token ? f.core.undo({ extra, ...token } as UndoToken)
      : f.core.apply({ extra, ...f.change, operations: [operation] } as SettingsChange);
    await expect(request).rejects.toMatchObject({ code: 'invalid_id' });
    expect(clone).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(operation.path).toEqual(['password']);
    expect(readFileSync(f.target)).toEqual(before);
    if (!token) expect(existsSync(f.backupDir)).toBe(false);
    expect(f.audit().at(-1)).toMatchObject({ operations: [], result: 'failure', error: 'invalid id' });
    expect(readFileSync(f.auditFile, 'utf8')).not.toContain('demo-container-private');
  });

it('refuses an audit naming an unresolved recovery manifest and preserves its recovery backup', async () => {
  const f = fixture('{"name":"demo-model"}', 0o600, { coordinate: async (_target, operation) => {
    await operation();
    throw new Error('demo-resume-error');
  } });
  const error = await f.core.apply(f.change).catch((cause: unknown) => cause) as { recovery: { id: string; undoToken: UndoToken } };
  const manifest = join(f.backupDir, error.recovery.id);
  const backup = join(f.backupDir, error.recovery.undoToken.backupId);
  const metadata = readFileSync(manifest);
  const bytes = readFileSync(backup);
  const other = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: manifest, coordinate });
  await expect(other.apply({ ...f.change, version: { hash: 'invalid', mtimeNs: '1' } }))
    .rejects.toMatchObject({ code: 'storage_collision' });
  expect(readFileSync(manifest)).toEqual(metadata);
  expect(readFileSync(backup)).toEqual(bytes);
  await new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: f.auditFile, coordinate }).undo(error.recovery.undoToken);
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
});

it.each(['apply', 'undo'] as const)('holds one target lock while auditing an invalid %s identifier', async action => {
  const f = fixture();
  const token = action === 'undo' ? await f.core.apply(f.change) : undefined;
  const written = readFileSync(f.target);
  const lock = `${f.target}.wayroost-settings.lock`;
  vi.mocked(fs.link).mockClear();
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path).endsWith('/audit.jsonl')) {
      const sync = file.sync.bind(file);
      vi.spyOn(file, 'sync').mockImplementation(async () => { expect(existsSync(lock)).toBe(true); await sync(); });
    }
    return file;
  });
  const result = action === 'apply' ? f.core.apply({ ...f.change, version: { hash: 'invalid', mtimeNs: '1' } })
    : f.core.undo({ ...token!, backupId: 'invalid' });
  await expect(result).rejects.toMatchObject({ code: 'invalid_id' });
  expect(readFileSync(f.target)).toEqual(written);
  expect(existsSync(lock)).toBe(false);
  expect(vi.mocked(fs.link).mock.calls.filter(([, path]) => String(path).endsWith('/models.json.wayroost-settings.lock'))).toHaveLength(1);
  expect(f.audit().at(-1)).toMatchObject({ target: 'invalid id', backupId: null, error: 'invalid id' });
});

it.each(['apply', 'undo'] as const)('leaves a colliding audit file untouched when the %s target cannot be captured', async action => {
  const f = fixture('{"name":"demo-model"}');
  const core = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: f.target, coordinate });
  const getter = vi.fn(() => f.target);
  const input = { ...f.change };
  Object.defineProperty(input, 'target', { enumerable: true, get: getter });
  const result = action === 'apply' ? core.apply(input) : core.undo(input as unknown as UndoToken);
  await expect(result).rejects.toMatchObject({ code: 'invalid_id' });
  expect(getter).not.toHaveBeenCalled();
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(existsSync(f.backupDir)).toBe(false);
  expect(fs.rename).not.toHaveBeenCalled();
  expect(fs.open).not.toHaveBeenCalled();
  expect(fs.link).not.toHaveBeenCalled();
});

it.each([
  ['apply', 'empty'], ['undo', 'empty'], ['apply', 'audit-shaped'], ['undo', 'audit-shaped'],
] as const)('leaves the %s %s config untouched when the target is invalid', async (action, format) => {
  const f = fixture();
  const target = join(f.root, 'config\tinvalid.yaml');
  const source = `${JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', action: 'apply', target: f.target,
    operations: [], backupId: null, timing: 'now', result: 'success' })}\n`;
  const coordinated = vi.fn();
  const core = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: target,
    coordinate: async (_target, operation) => { coordinated(); return operation(); } });
  const bytes = format === 'empty' ? '' : source;
  writeFileSync(target, bytes, { mode: 0o600 });
  const before = statSync(target, { bigint: true });
  vi.mocked(fs.open).mockClear();
  vi.mocked(fs.link).mockClear();
  const input = { ...f.change, target, editor: 'yaml' as const };
  const result = action === 'apply' ? core.apply(input) : core.undo(input as unknown as UndoToken);
  await expect(result).rejects.toMatchObject({ code: 'invalid_id', message: 'Settings identifier is invalid.' });
  expect(readFileSync(target, 'utf8')).toBe(bytes);
  const after = statSync(target, { bigint: true });
  expect([after.ino, after.mtimeNs, after.ctimeNs, after.mode]).toEqual([before.ino, before.mtimeNs, before.ctimeNs, before.mode]);
  expect(fs.open).not.toHaveBeenCalled();
  expect(fs.link).not.toHaveBeenCalled();
  expect(fs.rename).not.toHaveBeenCalled();
  expect(coordinated).not.toHaveBeenCalled();
  expect(existsSync(f.backupDir)).toBe(false);
});

it('leaves an incomplete audit untouched when no valid target identity is available', async () => {
  const f = fixture();
  await f.core.apply(f.change);
  const written = readFileSync(f.target);
  const partial = readFileSync(f.auditFile, 'utf8') + '{"timestamp":';
  writeFileSync(f.auditFile, partial);
  vi.mocked(fs.open).mockClear();
  await expect(f.core.undo({} as UndoToken)).rejects.toMatchObject({ code: 'invalid_id' });
  expect(readFileSync(f.target)).toEqual(written);
  expect(readFileSync(f.auditFile, 'utf8')).toBe(partial);
  expect(fs.open).not.toHaveBeenCalled();
});

it.each(['target', 'backupId', 'backupHash', 'writtenHash', 'editor', 'timing', 'expected'] as const)
  ('rejects an accessor-backed undo %s without invoking it', async field => {
    const f = fixture();
    const token = await f.core.apply(f.change);
    const written = readFileSync(f.target);
    const audit = readFileSync(f.auditFile);
    let reads = 0;
    const getter = vi.fn(() => ++reads <= 3 ? token[field] : { password: 'demo-getter-private' });
    Object.defineProperty(token, field, { enumerable: true, get: getter });
    vi.mocked(fs.open).mockClear();
    vi.mocked(fs.rename).mockClear();
    await expect(f.core.undo(token)).rejects.toMatchObject({ code: 'invalid_id' });
    expect(getter).not.toHaveBeenCalled();
    expect(readFileSync(f.target)).toEqual(written);
    expect(fs.rename).not.toHaveBeenCalled();
    if (field === 'target') {
      expect(readFileSync(f.auditFile)).toEqual(audit);
      expect(fs.open).not.toHaveBeenCalled();
    } else expect(f.audit()[1]).toEqual({ timestamp: expect.any(String), action: 'undo', target: 'invalid id', operations: [],
      backupId: null, timing: 'now', result: 'failure', error: 'invalid id' });
    expect(readFileSync(f.auditFile, 'utf8')).not.toContain('demo-getter-private');
  });

it.each(['target', 'version', 'version.hash', 'version.mtimeNs'] as const)
  ('rejects an accessor-backed apply %s without invoking it', async field => {
    const f = fixture();
    const change = { ...f.change, version: { hash: createHash('sha256').update(f.source).digest('hex'),
      mtimeNs: lstatSync(f.target, { bigint: true }).mtimeNs.toString() } };
    const object = field.startsWith('version.') ? change.version : change;
    const key = field.split('.').at(-1)!;
    const value = (object as unknown as Record<string, unknown>)[key];
    let reads = 0;
    const getter = vi.fn(() => ++reads <= 1 ? value : { password: 'demo-getter-private' });
    Object.defineProperty(object, key, { enumerable: true, get: getter });
    await expect(f.core.apply(change)).rejects.toMatchObject({ code: 'invalid_id' });
    expect(getter).not.toHaveBeenCalled();
    expect(readFileSync(f.target, 'utf8')).toBe(f.source);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(existsSync(f.backupDir)).toBe(false);
    if (field === 'target') {
      expect(existsSync(f.auditFile)).toBe(false);
      expect(fs.open).not.toHaveBeenCalled();
    } else {
      expect(f.audit()[0]).toEqual({ timestamp: expect.any(String), action: 'apply', target: 'invalid id', operations: [],
        backupId: null, timing: 'now', result: 'failure', error: 'invalid id' });
      expect(readFileSync(f.auditFile, 'utf8')).not.toContain('demo-getter-private');
    }
  });

it.each(['apply', 'undo'] as const)('rejects an invalid canonical target before %s mutation', async action => {
  const f = fixture();
  const token = action === 'undo' ? await f.core.apply(f.change) : undefined;
  const written = readFileSync(f.target);
  const directory = join(f.root, 'trusted\tconfig');
  mkdirSync(directory, { mode: 0o700 });
  const target = join(directory, 'models.json');
  renameSync(f.target, target);
  const alias = join(f.root, 'alias');
  symlinkSync(directory, alias, 'dir');
  const aliasedTarget = join(alias, 'models.json');
  vi.mocked(fs.rename).mockClear();
  const result = action === 'apply' ? f.core.apply({ ...f.change, target: aliasedTarget })
    : f.core.undo({ ...token!, target: aliasedTarget,
      backupId: createHash('sha256').update(aliasedTarget).digest('hex') + token!.backupId.slice(64) });
  await expect(result).rejects.toMatchObject({ code: 'invalid_id' });
  expect(readFileSync(target)).toEqual(written);
  expect(fs.rename).not.toHaveBeenCalled();
  if (action === 'apply') expect(existsSync(f.backupDir)).toBe(false);
  expect(f.audit().at(-1)).toEqual({ timestamp: expect.any(String), action, target: 'invalid id', operations: [],
    backupId: null, timing: 'now', result: 'failure', error: 'invalid id' });
  expect(readFileSync(f.auditFile, 'utf8')).not.toContain('trusted\\tconfig');
});

it('returns a usable canonical undo token through a valid directory alias', async () => {
  const f = fixture();
  const alias = join(f.root, 'alias');
  symlinkSync(f.root, alias, 'dir');
  const token = await f.core.apply({ ...f.change, target: join(alias, 'models.json') });
  expect(token.target).toBe(f.target);
  await f.core.undo(token);
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(f.audit().every(record => record.target === f.target && record.result === 'success')).toBe(true);
});

it.each(['apply', 'undo'] as const)('uses a stable %s snapshot after asynchronous coordination begins', async action => {
  let reached!: () => void;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { reached = resolve; });
  const ready = new Promise<void>(resolve => { release = resolve; });
  const f = fixture();
  const token = action === 'undo' ? await f.core.apply(f.change) : undefined;
  const core = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: f.auditFile,
    coordinate: async (_target, operation) => { reached(); await ready; return operation(); } });
  const input = action === 'apply' ? f.change : token!;
  const result = action === 'apply' ? core.apply(input as SettingsChange) : core.undo(input as UndoToken);
  try {
    await pending;
    input.target = '/home/me/invalid target';
    input.expected.mode = 0o777;
    if (action === 'apply') f.change.operations = [{ type: 'set', path: ['name'], value: 'demo-late-value' }];
    else token!.backupId = 'invalid';
  } finally { release(); }
  const returned = await result;
  expect(readFileSync(f.target, 'utf8')).toBe(action === 'apply' ? f.source.replace('demo-model', 'updated-model') : f.source);
  expect(f.audit().every(record => record.target === f.target && record.result === 'success')).toBe(true);
  expect(readFileSync(f.auditFile, 'utf8')).not.toContain('demo-late-value');
  if (action === 'apply') {
    await f.core.undo(returned!);
    expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  }
});

it('serializes concurrent target writes through the audit lock without creating audit leases', async () => {
  const f = fixture();
  const second = join(f.root, 'other.json');
  writeFileSync(second, f.source, { mode: 0o600 });
  let reached!: () => void;
  let contended!: () => void;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { reached = resolve; });
  const contention = new Promise<void>(resolve => { contended = resolve; });
  const ready = new Promise<void>(resolve => { release = resolve; });
  let opened = false;
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (!opened && String(path).endsWith('/audit.jsonl')) {
      opened = true;
      const sync = file.sync.bind(file);
      vi.spyOn(file, 'sync').mockImplementationOnce(async () => { reached(); await ready; await sync(); });
    }
    return file;
  });
  vi.mocked(fs.link).mockImplementation(async (source, destination) => {
    if (/\/\.wayroost-audit-\d+-\d+\.lock$/.test(String(destination)) && existsSync(destination)) contended();
    await actual.link(source, destination);
  });
  const other = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: f.auditFile, coordinate });
  const first = f.core.apply(f.change);
  let secondResult: Promise<UndoToken> | undefined;
  try {
    await pending;
    secondResult = other.apply({ ...f.change, target: second });
    await contention;
    expect(readFileSync(second, 'utf8')).toBe(f.source);
    expect(statSync(f.auditFile).nlink).toBe(1);
  } finally { release(); }
  const results = await Promise.allSettled([first, secondResult!]);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
  expect(f.audit()).toHaveLength(2);
  expect(f.audit().every(record => record.result === 'success')).toBe(true);
  expect(statSync(f.auditFile).nlink).toBe(1);
  expect(vi.mocked(fs.link).mock.calls.some(([, path]) => String(path).endsWith('.lock.file'))).toBe(false);
});

it('holds target locks through verification, audit and backup cleanup', async () => {
  const f = fixture();
  const lock = `${f.target}.wayroost-settings.lock`;
  const parse = jsonEditor.parse;
  vi.spyOn(jsonEditor, 'parse').mockImplementation(source => {
    expect(existsSync(lock)).toBe(true);
    return parse(source);
  });
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path).endsWith('/audit.jsonl')) {
      const sync = file.sync.bind(file);
      vi.spyOn(file, 'sync').mockImplementation(async () => {
        expect(existsSync(lock)).toBe(true);
        expect(statSync(f.auditFile).nlink).toBe(1);
        await sync();
      });
    }
    return file;
  });
  vi.mocked(fs.unlink).mockImplementation(async path => {
    if (String(path).endsWith('.recovery.json')) expect(existsSync(lock)).toBe(true);
    await actual.unlink(path);
  });
  const token = await f.core.apply(f.change);
  expect(existsSync(lock)).toBe(false);
  await f.core.undo(token);
  expect(existsSync(lock)).toBe(false);
  expect(vi.mocked(fs.link).mock.calls.filter(([, path]) => String(path).endsWith('/models.json.wayroost-settings.lock'))).toHaveLength(4);
  expect(vi.mocked(fs.link).mock.calls.some(([, path]) => String(path).endsWith('.lock.file'))).toBe(false);
  expect(f.audit().map(record => record.result)).toEqual(['success', 'success']);
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
});

it.each(['apply', 'undo'] as const)('refuses %s before mutation when the shared audit lock cannot be claimed', async action => {
  const f = fixture();
  const token = action === 'undo' ? await f.core.apply(f.change) : undefined;
  if (!token) {
    mkdirSync(join(f.root, 'audit'), { mode: 0o700 });
    writeFileSync(f.auditFile, '', { mode: 0o600 });
  }
  const stat = statSync(f.auditFile, { bigint: true });
  const lock = join(f.root, `.wayroost-audit-${stat.dev}-${stat.ino}.lock`);
  writeFileSync(lock, '', { mode: 0o600 });
  const target = readFileSync(f.target);
  const audit = readFileSync(f.auditFile);
  vi.mocked(fs.rename).mockClear();
  vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(10_001);
  await expect(token ? f.core.undo(token) : f.core.apply(f.change)).rejects.toMatchObject({ code: 'locked' });
  expect(readFileSync(f.target)).toEqual(target);
  expect(readFileSync(f.auditFile)).toEqual(audit);
  expect(existsSync(lock)).toBe(true);
  expect(fs.rename).not.toHaveBeenCalled();
  if (!token) expect(existsSync(f.backupDir)).toBe(false);
});

it('creates nested private backup storage and shares its audit lock across fresh instances', async () => {
  const f = fixture();
  const backupDir = join(f.root, 'private-storage', 'backups');
  const core = new SettingsWriteThrough({ backupDir, auditFile: f.auditFile, coordinate });
  const token = await core.apply(f.change);
  await new SettingsWriteThrough({ backupDir, auditFile: f.auditFile, coordinate }).undo(token);
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(f.audit().map(record => record.result)).toEqual(['success', 'success']);
  expect(readdirSync(join(f.root, 'private-storage'))).toEqual(['backups']);
});

it.each([0o600, 0o640, 0o644])('preserves target mode %i and prevents world access to backups', async mode => {
  const f = fixture(undefined, mode);
  const token = await f.core.apply(f.change);
  expect(statSync(f.target).mode & 0o7777).toBe(mode);
  expect(statSync(join(f.backupDir, token.backupId)).mode & 0o7777).toBe(mode & 0o770);
  expect(statSync(f.backupDir).mode & 0o777).toBe(0o700);
  expect(statSync(join(f.root, 'audit')).mode & 0o777).toBe(0o700);
  expect(statSync(join(f.backupDir, token.backupId, '..')).mode & 0o777).toBe(0o700);
  await f.core.undo(token);
  expect(statSync(f.target).mode & 0o7777).toBe(mode);
});

it('retains the last N backups separately for each target', async () => {
  const f = fixture(undefined, 0o600, { keepBackups: 2 });
  const other = join(f.root, 'other.json');
  writeFileSync(other, f.source, { mode: 0o600 });
  const first = await f.core.apply(f.change);
  const second = await f.core.apply({ ...f.change, operations: [{ type: 'set', path: ['name'], value: 'second-model' }] });
  const independent = await f.core.apply({ ...f.change, target: other });
  const third = await f.core.apply({ ...f.change, operations: [{ type: 'set', path: ['name'], value: 'third-model' }] });
  expect(existsSync(join(f.backupDir, first.backupId))).toBe(false);
  for (const token of [second, third, independent]) expect(existsSync(join(f.backupDir, token.backupId))).toBe(true);
  expect(readdirSync(join(f.backupDir, first.backupId.split('/')[0]!)).filter(name => name.endsWith('.bak'))).toHaveLength(2);
});

it.each([1, 10])('preserves unresolved recovery through failed retries with retention %i', async keepBackups => {
  const f = fixture(undefined, 0o600, { keepBackups });
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path).endsWith('/audit.jsonl')) vi.spyOn(file, 'sync').mockRejectedValueOnce(new Error('demo-sync-error'));
    return file;
  });
  const error: unknown = await f.core.apply(f.change).catch(cause => cause);
  expect(error).toMatchObject({ committed: true, code: 'audit_failed' });
  const recovery = (error as { recovery: { id: string; undoToken: UndoToken } }).recovery;
  vi.mocked(fs.open).mockImplementation(actual.open);
  vi.mocked(fs.rename).mockRejectedValue(new Error('demo-rename-error'));
  for (let attempt = 0; attempt <= keepBackups; attempt++) {
    await expect(f.core.apply(f.change)).rejects.toMatchObject({ code: 'io_failed' });
  }
  expect(readFileSync(join(f.backupDir, recovery.undoToken.backupId), 'utf8')).toBe(f.source);
  expect(JSON.parse(readFileSync(join(f.backupDir, recovery.id), 'utf8'))).toEqual(recovery);
  expect(readdirSync(join(f.backupDir, recovery.undoToken.backupId.split('/')[0]!))).toEqual([
    recovery.undoToken.backupId.split('/')[1], recovery.id.split('/')[1],
  ].sort());
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  await new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: f.auditFile, coordinate, keepBackups }).undo(recovery.undoToken);
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
});

it('keeps an unresolved recovery backup when a later write succeeds and prunes after recovery', async () => {
  const f = fixture(undefined, 0o600, { keepBackups: 1 });
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path).endsWith('/audit.jsonl')) vi.spyOn(file, 'sync').mockRejectedValueOnce(new Error('demo-sync-error'));
    return file;
  });
  const error: unknown = await f.core.apply(f.change).catch(cause => cause);
  expect(error).toMatchObject({ committed: true });
  const recovery = (error as { recovery: { id: string; undoToken: UndoToken } }).recovery;
  vi.mocked(fs.open).mockImplementation(actual.open);
  await f.core.apply(f.change);
  expect(existsSync(join(f.backupDir, recovery.undoToken.backupId))).toBe(true);
  expect(existsSync(join(f.backupDir, recovery.id))).toBe(true);
  expect(readdirSync(join(f.backupDir, recovery.undoToken.backupId.split('/')[0]!)).filter(name => name.endsWith('.bak'))).toHaveLength(2);
  await f.core.undo(recovery.undoToken);
  await f.core.apply(f.change);
  const directory = join(f.backupDir, recovery.undoToken.backupId.split('/')[0]!);
  expect(readdirSync(directory).filter(name => name.endsWith('.bak'))).toHaveLength(1);
  expect(existsSync(join(f.backupDir, recovery.id))).toBe(false);
});

it('preserves committed undo recovery through failed undo retries', async () => {
  const f = fixture(undefined, 0o600, { keepBackups: 1 });
  const token = await f.core.apply(f.change);
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path).endsWith('/audit.jsonl')) vi.spyOn(file, 'sync').mockRejectedValueOnce(new Error('demo-sync-error'));
    return file;
  });
  const error: unknown = await f.core.undo(token).catch(cause => cause);
  expect(error).toMatchObject({ committed: true, recovery: { action: 'undo' } });
  const recovery = (error as { recovery: { id: string; undoToken: UndoToken } }).recovery;
  vi.mocked(fs.open).mockImplementation(actual.open);
  vi.mocked(fs.rename).mockRejectedValue(new Error('demo-rename-error'));
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect(f.core.undo(recovery.undoToken)).rejects.toMatchObject({ code: 'io_failed' });
  }
  expect(existsSync(join(f.backupDir, recovery.id))).toBe(true);
  expect(readdirSync(join(f.backupDir, recovery.undoToken.backupId.split('/')[0]!)).filter(name => name.endsWith('.bak'))).toHaveLength(2);
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  await f.core.undo(recovery.undoToken);
  expect(readFileSync(f.target, 'utf8')).toBe(f.source.replace('demo-model', 'updated-model'));
});

it('omits every operation value and redaction marker from success and failure audit records', async () => {
  const f = fixture();
  const operations: SettingsChange['operations'] = [
    { type: 'set', path: ['apiKey'], value: 'demo-private-key' },
    { type: 'set', path: ['TOKEN', 'nested'], value: 'demo-private-token' },
    { type: 'set', path: ['nested'], value: { password: 'demo-private-password', safe: 'public', rows: [{ Authentication: 'demo-private-auth' }] } },
  ];
  const token = await f.core.apply({ ...f.change, operations });
  await f.core.undo(token);
  await expect(f.core.apply({ ...f.change, operations, preconditions: [{ path: ['secret'], value: 'demo-private-precondition' }] })).rejects.toThrow('precondition');
  const audit = readFileSync(f.auditFile, 'utf8');
  expect(audit).not.toContain('demo-private');
  expect(audit).not.toContain('[REDACTED]');
  expect(audit).not.toContain('public');
  expect(audit).not.toContain('Authentication');
  expect(f.audit()[0]!.operations).toEqual([
    { type: 'set', path: ['apiKey'] },
    { type: 'set', path: ['TOKEN', 'nested'] },
    { type: 'set', path: ['nested'] },
  ]);
  expect(f.audit()[2]!.operations).toEqual(f.audit()[0]!.operations);
});

it('audits hashes, timing, device and level across apply, undo and failed preconditions', async () => {
  const f = fixture();
  const context = { device: 'demo-device', level: 'project' };
  const token = await f.core.apply({ ...f.change, timing: 'restart:demo-service', ...context });
  expect(token).toMatchObject(context);
  await f.core.undo(token);
  await expect(f.core.apply({ ...f.change, ...context, preconditions: [{ path: ['name'], value: 'demo-unlogged-precondition' }] }))
    .rejects.toMatchObject({ code: 'precondition_failed' });
  expect(f.audit()).toEqual([
    expect.objectContaining({ ...context, beforeHash: token.backupHash, afterHash: token.writtenHash,
      timing: 'restart:demo-service', result: 'success', operations: [{ type: 'set', path: ['name'] }] }),
    expect.objectContaining({ ...context, beforeHash: token.writtenHash, afterHash: token.backupHash,
      timing: 'restart:demo-service', result: 'success', operations: [] }),
    expect.objectContaining({ ...context, beforeHash: token.backupHash, timing: 'now', result: 'failure',
      operations: [{ type: 'set', path: ['name'] }], error: 'precondition_failed' }),
  ]);
  expect(readFileSync(f.auditFile, 'utf8')).not.toContain('demo-unlogged-precondition');
  expect(readFileSync(f.auditFile, 'utf8')).not.toContain('updated-model');
});

it.each([
  ['set path object', { type: 'set', path: [{ password: 'demo-private-path' }], value: 'public' }],
  ['delete path object', { type: 'delete', path: [{ password: 'demo-private-path' }] }],
  ['nested path array', { type: 'set', path: [['demo-private-path']], value: 'public' }],
  ['path object', { type: 'set', path: { password: 'demo-private-path' }, value: 'public' }],
  ['path string', { type: 'set', path: 'demo-private-path', value: 'public' }],
  ['negative index', { type: 'set', path: [-1], value: 'public' }],
  ['fractional index', { type: 'set', path: [0.5], value: 'public' }],
  ['unsafe index', { type: 'set', path: [Number.MAX_SAFE_INTEGER + 1], value: 'public' }],
  ['sparse path', { type: 'set', path: Array(1), value: 'public' }],
  ['missing path', { type: 'set', value: 'public' }],
  ['invalid type', { type: 'demo-private-type', path: ['name'], value: 'public' }],
  ['type object', { type: { password: 'demo-private-type' }, path: ['name'], value: 'public' }],
  ['missing type', { path: ['name'], value: 'public' }],
  ['null operation', null],
] as const)('validates a %s before copying any operations into the audit', async (_kind, operation) => {
  const f = fixture();
  const operations = [{ type: 'set', path: ['password'], value: 'demo-private-value' }, operation] as unknown as SettingsChange['operations'];
  await expect(f.core.apply({ ...f.change, operations })).rejects.toMatchObject({ code: 'invalid_operation' });
  expect(f.audit()).toEqual([expect.objectContaining({ operations: [], result: 'failure', error: 'invalid_operation', backupId: null })]);
  expect(readFileSync(f.auditFile, 'utf8')).not.toContain('demo-private');
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(existsSync(f.backupDir)).toBe(false);
  expect(fs.rename).not.toHaveBeenCalled();
});

it.each([null, {}, 'demo-private-operations'])('rejects a non-array operation list before auditing its contents: %j', async operations => {
  const f = fixture();
  await expect(f.core.apply({ ...f.change, operations: operations as unknown as SettingsChange['operations'] }))
    .rejects.toMatchObject({ code: 'invalid_operation' });
  expect(f.audit()).toEqual([expect.objectContaining({ operations: [], result: 'failure', error: 'invalid_operation', backupId: null })]);
  expect(readFileSync(f.auditFile, 'utf8')).not.toContain('demo-private');
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(existsSync(f.backupDir)).toBe(false);
  expect(fs.rename).not.toHaveBeenCalled();
});

it('cleans up a failed atomic rename and keeps the original file', async () => {
  const f = fixture();
  vi.mocked(fs.rename).mockRejectedValueOnce(new Error('demo-private-filesystem-message'));
  await expect(f.core.apply(f.change)).rejects.toThrow('Settings file operation failed.');
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(readdirSync(f.root).filter(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([]);
  expect(readFileSync(f.auditFile, 'utf8')).not.toContain('demo-private-filesystem-message');
  expect(f.audit()[0]).toMatchObject({ result: 'failure', error: 'io_failed', backupId: expect.any(String) });
  expect(readdirSync(join(f.backupDir, createHash('sha256').update(f.target).digest('hex')))).toEqual([]);
  await f.core.apply(f.change);
});

it.each(['rename', 'replacement-sync', 'editor', 'backup-sync', 'recovery-sync'] as const)(
  'removes uncommitted backups through repeated %s failures', async fault => {
    const f = fixture(undefined, 0o600, { keepBackups: 1 });
    if (fault === 'rename') vi.mocked(fs.rename).mockRejectedValue(new Error('demo-rename-error'));
    if (fault === 'editor') vi.spyOn(jsonEditor, 'edit').mockImplementation(() => { throw new Error('demo-editor-error'); });
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const file = await actual.open(path, flags, mode);
      if ((fault === 'replacement-sync' && String(path).endsWith('.tmp'))
        || (fault === 'backup-sync' && String(path).endsWith('.bak'))
        || (fault === 'recovery-sync' && String(path).endsWith('.recovery.json'))) {
        vi.spyOn(file, 'sync').mockRejectedValueOnce(new Error('demo-sync-error'));
      }
      return file;
    });
    const directory = join(f.backupDir, createHash('sha256').update(f.target).digest('hex'));
    for (let attempt = 0; attempt < 12; attempt++) {
      await expect(f.core.apply(f.change)).rejects.toMatchObject({ code: 'io_failed' });
      expect(readFileSync(f.target, 'utf8')).toBe(f.source);
      expect(readdirSync(directory)).toEqual([]);
    }
  });

it('removes failed undo backups without deleting the original undo backup', async () => {
  const f = fixture(undefined, 0o600, { keepBackups: 1 });
  const token = await f.core.apply(f.change);
  const written = readFileSync(f.target, 'utf8');
  const directory = join(f.backupDir, token.backupId.split('/')[0]!);
  vi.mocked(fs.rename).mockRejectedValue(new Error('demo-rename-error'));
  for (let attempt = 0; attempt < 12; attempt++) {
    await expect(f.core.undo(token)).rejects.toMatchObject({ code: 'io_failed' });
    expect(readFileSync(f.target, 'utf8')).toBe(written);
    expect(readdirSync(directory)).toEqual([token.backupId.split('/')[1]]);
  }
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  await f.core.undo(token);
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
});

it('discards an uncommitted backup while holding the target lock', async () => {
  const f = fixture();
  const lock = `${f.target}.wayroost-settings.lock`;
  const removed: string[] = [];
  vi.mocked(fs.rename).mockRejectedValueOnce(new Error('demo-rename-error'));
  vi.mocked(fs.unlink).mockImplementation(async path => {
    if (String(path).endsWith('.bak') || String(path).endsWith('.recovery.json')) {
      expect(existsSync(lock)).toBe(true);
      removed.push(String(path));
    }
    await actual.unlink(path);
  });
  await expect(f.core.apply(f.change)).rejects.toMatchObject({ code: 'io_failed' });
  expect(removed).toHaveLength(2);
});

it('leaves the target untouched if syncing the replacement fails', async () => {
  const f = fixture();
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path).endsWith('.tmp')) vi.spyOn(file, 'sync').mockRejectedValueOnce(new Error('demo-sync-error'));
    return file;
  });
  await expect(f.core.apply(f.change)).rejects.toThrow('Settings file operation failed.');
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(fs.rename).not.toHaveBeenCalled();
  expect(readdirSync(f.root).filter(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([]);
});

it('re-reads and verifies after rename and reports a write that was replaced immediately', async () => {
  const f = fixture();
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    await actual.rename(from, to);
    writeFileSync(f.target, '{"name":"outside-model"}');
  });
  await expect(f.core.apply(f.change)).rejects.toThrow('could not be verified');
  expect(readFileSync(f.target, 'utf8')).toBe('{"name":"outside-model"}');
  expect(f.audit()[0]).toMatchObject({ result: 'failure', error: 'verification_failed', backupId: expect.any(String) });
});

it('rejects an editor that omits an operation before it writes', async () => {
  const f = fixture();
  vi.spyOn(jsonEditor, 'edit').mockImplementation(source => source);
  await expect(f.core.apply(f.change)).rejects.toThrow('do not contain the requested values');
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(fs.rename).not.toHaveBeenCalled();
});

it('refuses unsafe backup directories and symlinked audit files', async () => {
  const f = fixture();
  mkdirSync(f.backupDir, { mode: 0o755 });
  await expect(f.core.apply(f.change)).rejects.toThrow('require a private directory');
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  const link = join(f.root, 'audit-link');
  symlinkSync(f.target, link);
  const other = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: link, coordinate });
  await expect(other.apply(f.change)).rejects.toThrow();
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
});

it('refuses an audit path that would append records to the settings target', async () => {
  const f = fixture();
  const same = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: f.target, coordinate });
  await expect(same.apply(f.change)).rejects.toThrow('must be separate');
  mkdirSync(join(f.root, 'audit'), { mode: 0o700 });
  const link = join(f.root, 'audit', 'audit-hardlink');
  linkSync(f.target, link);
  const linked = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: link, coordinate });
  await expect(linked.apply(f.change)).rejects.toThrow('must be different files');
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
});

it.each(['', '.reap', '.reap.reap', '.owner-12345-00000000-0000-4000-8000-000000000000'])
  ('refuses audit paths in the target lock namespace before mutation: %s', async suffix => {
    const f = fixture();
    const auditFile = f.target + '.wayroost-settings.lock' + suffix;
    const core = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile, coordinate });
    await expect(core.apply(f.change)).rejects.toMatchObject({ code: 'storage_collision' });
    expect(readFileSync(f.target, 'utf8')).toBe(f.source);
    expect(existsSync(auditFile)).toBe(false);
    expect(existsSync(f.target + '.wayroost-settings.lock')).toBe(false);
    expect(existsSync(f.backupDir)).toBe(false);
    expect(fs.open).not.toHaveBeenCalled();
  });

it('refuses a colliding audit path through a directory alias before undo mutates anything', async () => {
  const f = fixture();
  const token = await f.core.apply(f.change);
  const written = readFileSync(f.target);
  const audit = readFileSync(f.auditFile);
  const alias = join(f.root, 'alias');
  symlinkSync(f.root, alias, 'dir');
  const core = new SettingsWriteThrough({ backupDir: f.backupDir,
    auditFile: join(alias, 'models.json.wayroost-settings.lock.reap'), coordinate });
  vi.mocked(fs.open).mockClear();
  await expect(core.undo(token)).rejects.toMatchObject({ code: 'storage_collision' });
  expect(readFileSync(f.target)).toEqual(written);
  expect(readFileSync(f.auditFile)).toEqual(audit);
  expect(existsSync(f.target + '.wayroost-settings.lock.reap')).toBe(false);
  expect(fs.open).not.toHaveBeenCalled();
});

it('refuses hardlinked audit aliases before either target changes or short writes begin', async () => {
  const f = fixture();
  const second = join(f.root, 'other.json');
  writeFileSync(second, f.source, { mode: 0o600 });
  mkdirSync(join(f.root, 'audit'), { mode: 0o700 });
  const previous = '{"result":"previous"}\n';
  writeFileSync(f.auditFile, previous, { mode: 0o600 });
  const alias = join(f.root, 'audit', 'audit-alias.jsonl');
  linkSync(f.auditFile, alias);
  const other = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: alias, coordinate });
  let writes = 0;
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path).endsWith('/audit.jsonl') || String(path).endsWith('/audit-alias.jsonl')) {
      const write = file.write.bind(file);
      const writer: { write(buffer: Buffer): Promise<{ bytesWritten: number; buffer: Buffer }> } = file;
      vi.spyOn(writer, 'write').mockImplementation(async buffer => {
        writes++;
        const short = await write(buffer.subarray(0, 7));
        await new Promise(resolve => setTimeout(resolve, 1));
        return short;
      });
    }
    return file;
  });
  const results = await Promise.allSettled([f.core.apply(f.change), other.apply({ ...f.change, target: second })]);
  expect(results).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'unsafe_audit' }) }),
    expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'unsafe_audit' }) })]);
  expect(writes).toBe(0);
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(readFileSync(second, 'utf8')).toBe(f.source);
  expect(readFileSync(f.auditFile, 'utf8')).toBe(previous);
  expect(readFileSync(alias, 'utf8')).toBe(previous);
  expect(existsSync(f.backupDir)).toBe(false);
  expect(fs.rename).not.toHaveBeenCalled();
});

it('refuses a hardlinked audit file before undo restores the target', async () => {
  const f = fixture();
  const token = await f.core.apply(f.change);
  const written = readFileSync(f.target);
  const audit = readFileSync(f.auditFile);
  const backups = readdirSync(join(f.backupDir, token.backupId.split('/')[0]!));
  const alias = join(f.root, 'audit', 'audit-alias.jsonl');
  linkSync(f.auditFile, alias);
  vi.mocked(fs.rename).mockClear();
  await expect(f.core.undo(token)).rejects.toMatchObject({ code: 'unsafe_audit' });
  expect(readFileSync(f.target)).toEqual(written);
  expect(readFileSync(f.auditFile)).toEqual(audit);
  expect(readdirSync(join(f.backupDir, token.backupId.split('/')[0]!))).toEqual(backups);
  expect(fs.rename).not.toHaveBeenCalled();
  unlinkSync(alias);
  await f.core.undo(token);
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
});

it('refuses to append when an audit alias appears after the target replacement', async () => {
  const f = fixture();
  const alias = join(f.root, 'audit', 'audit-alias.jsonl');
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    await actual.rename(from, to);
    linkSync(f.auditFile, alias);
  });
  const error = await f.core.apply(f.change).catch((cause: unknown) => cause) as { recovery: { undoToken: UndoToken } };
  expect(error).toMatchObject({ committed: true, code: 'audit_failed' });
  expect(readFileSync(f.target, 'utf8')).toContain('updated-model');
  expect(readFileSync(f.auditFile, 'utf8')).toBe('');
  expect(readFileSync(alias, 'utf8')).toBe('');
  unlinkSync(alias);
  await f.core.undo(error.recovery.undoToken);
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
});

it('requires a coordinator for independent config writers', () => {
  const f = fixture();
  expect(() => new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: f.auditFile } as WriteThroughOptions)).toThrow('require coordination');
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
});

it('keeps an independent writer quiescent across the final validation, rename and audit', async () => {
  let resumed!: () => void;
  const resume = new Promise<void>(resolve => { resumed = resolve; });
  let quiescent = false;
  const f = fixture(undefined, 0o600, { coordinate: async (_target, operation) => {
    quiescent = true;
    try {
      const result = await operation();
      expect(f.audit()[0]).toMatchObject({ result: 'success' });
      return result;
    } finally { quiescent = false; resumed(); }
  } });
  let reached!: () => void;
  let release!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    expect(quiescent).toBe(true);
    reached();
    await proceed;
    await actual.rename(from, to);
  });
  const apply = f.core.apply(f.change);
  await Promise.race([paused, apply]);
  const outside = '{"name":"outside-model"}\n';
  let outsideWritten = false;
  const external = (async () => { await resume; writeFileSync(f.target, outside); outsideWritten = true; })();
  try {
    await Promise.resolve();
    expect(outsideWritten).toBe(false);
    expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  } finally { release(); }
  await apply;
  await external;
  expect(readFileSync(f.target, 'utf8')).toBe(outside);
  expect(quiescent).toBe(false);
});

it('checks the opened audit descriptor against the target under its lock', async () => {
  const f = fixture();
  let heldAtAuditOpen = false;
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    if (String(path).endsWith('/audit.jsonl')) {
      heldAtAuditOpen = existsSync(`${f.target}.wayroost-settings.lock`);
      linkSync(f.target, path);
    }
    return actual.open(path, flags, mode);
  });
  await expect(f.core.apply({ ...f.change, preconditions: [{ path: ['name'], value: 'stale' }] })).rejects.toMatchObject({ code: 'storage_collision' });
  expect(heldAtAuditOpen).toBe(true);
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(fs.rename).not.toHaveBeenCalled();
});

it('refuses replacement of the audit directory before any mutation', async () => {
  const f = fixture();
  const moved = join(f.root, 'moved-audit');
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    if (String(path).endsWith('/audit.jsonl')) {
      renameSync(join(f.root, 'audit'), moved);
      mkdirSync(join(f.root, 'audit'), { mode: 0o700 });
      linkSync(f.target, f.auditFile);
    }
    return actual.open(path, flags, mode);
  });
  await expect(f.core.apply(f.change)).rejects.toMatchObject({ code: 'unsafe_directory' });
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(readFileSync(f.auditFile, 'utf8')).toBe(f.source);
  expect(fs.rename).not.toHaveBeenCalled();
});

it.each([0o702, 0o770])('refuses a target directory writable by another user: %i', async mode => {
  const f = fixture();
  chmodSync(f.root, mode);
  await expect(f.core.apply(f.change)).rejects.toMatchObject({ code: 'unsafe_directory' });
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(fs.rename).not.toHaveBeenCalled();
});

it('refuses an unsafe ancestor even when the target directory is private', async () => {
  const f = fixture();
  const nested = join(f.root, 'nested');
  mkdirSync(nested, { mode: 0o700 });
  const target = join(nested, 'models.json');
  writeFileSync(target, f.source, { mode: 0o600 });
  chmodSync(f.root, 0o770);
  await expect(f.core.apply({ ...f.change, target })).rejects.toMatchObject({ code: 'unsafe_directory' });
  expect(readFileSync(target, 'utf8')).toBe(f.source);
  expect(fs.rename).not.toHaveBeenCalled();
});

it.each(['target', 'backup', 'audit', 'root'].flatMap(path => ['owner', 'group-write', 'world-write'].map(reason => ({ path, reason }))))(
  'checks $reason on every $path directory ancestor before opening the audit', async ({ path, reason }) => {
    const f = fixture();
    const ancestor = join(f.root, 'ancestor');
    mkdirSync(ancestor, { mode: 0o700 });
    const target = path === 'target' ? join(ancestor, 'models.json') : f.target;
    if (path === 'target') renameSync(f.target, target);
    const backupDir = path === 'backup' ? join(ancestor, 'backups') : f.backupDir;
    const auditFile = path === 'audit' ? join(ancestor, 'audit', 'audit.jsonl') : f.auditFile;
    const lstat = vi.mocked(fs.lstat).getMockImplementation()!;
    vi.mocked(fs.lstat).mockImplementation(async (entry, options) => {
      const stat = await lstat(entry, options);
      if (String(entry) === (path === 'root' ? '/' : ancestor)) {
        if (reason === 'owner') stat.uid = 12345n;
        else {
          const writes = reason === 'group-write' ? 0o020 : 0o002;
          stat.mode = typeof stat.mode === 'bigint' ? stat.mode | BigInt(writes) : stat.mode | writes;
        }
      }
      return stat;
    });
    const core = new SettingsWriteThrough({ backupDir, auditFile, coordinate });
    await expect(core.apply({ ...f.change, target })).rejects.toMatchObject({ code: 'unsafe_directory' });
    expect(readFileSync(target, 'utf8')).toBe(f.source);
    expect(existsSync(auditFile)).toBe(false);
    expect(existsSync(backupDir)).toBe(false);
    expect(fs.rename).not.toHaveBeenCalled();
  });

it('detects temporary pathname substitution before replacing the target', async () => {
  const f = fixture();
  const outside = join(f.root, 'outside.json');
  writeFileSync(outside, '{"name":"outside-model"}', { mode: 0o600 });
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path).endsWith('.tmp')) {
      const sync = file.sync.bind(file);
      vi.spyOn(file, 'sync').mockImplementationOnce(async () => {
        await sync();
        unlinkSync(path);
        symlinkSync(outside, path);
      });
    }
    return file;
  });
  await expect(f.core.apply(f.change)).rejects.toThrow();
  expect(lstatSync(f.target).isSymbolicLink()).toBe(false);
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(readFileSync(outside, 'utf8')).toBe('{"name":"outside-model"}');
  expect(fs.rename).not.toHaveBeenCalled();
});

it('binds replacement to the opened directory when its pathname is moved', async () => {
  const f = fixture();
  const moved = `${f.root}-moved`;
  roots.push(moved);
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    renameSync(f.root, moved);
    mkdirSync(f.root, { mode: 0o700 });
    writeFileSync(f.target, '{"name":"outside-model"}', { mode: 0o600 });
    await actual.rename(from, to);
  });
  await expect(f.core.apply(f.change)).rejects.toMatchObject({ committed: true });
  expect(readFileSync(f.target, 'utf8')).toBe('{"name":"outside-model"}');
  expect(readFileSync(join(moved, 'models.json'), 'utf8')).toContain('updated-model');
});

it.each([
  ['apply', 'rename'], ['undo', 'rename'], ['apply', 'verification'], ['undo', 'verification'],
] as const)('refuses a moved target directory during %s %s with storage outside it', async (action, stage) => {
  const f = fixture();
  const directory = join(f.root, 'config');
  const moved = join(f.root, 'moved-config');
  mkdirSync(directory, { mode: 0o700 });
  const target = join(directory, 'models.json');
  renameSync(f.target, target);
  const change = { ...f.change, target };
  const token = action === 'undo' ? await f.core.apply(change) : undefined;
  const outside = '{"name":"outside-model"}';
  const move = () => {
    renameSync(directory, moved);
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(target, outside, { mode: 0o600 });
  };
  let renamed = false;
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    if (stage === 'rename') move();
    await actual.rename(from, to);
    renamed = true;
  });
  if (stage === 'verification') vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (renamed && String(path).endsWith('/models.json')) {
      renamed = false;
      move();
    }
    return file;
  });
  const error: unknown = await (token ? f.core.undo(token) : f.core.apply(change)).catch(cause => cause);
  expect(error).toMatchObject({ committed: true, code: stage === 'rename' ? 'unsafe_directory' : 'verification_failed' });
  expect(readFileSync(target, 'utf8')).toBe(outside);
  expect(readFileSync(join(moved, 'models.json'), 'utf8')).toBe(action === 'apply'
    ? f.source.replace('demo-model', 'updated-model') : f.source);
  expect(f.audit().at(-1)).toMatchObject({ action, target, result: 'failure',
    error: stage === 'rename' ? 'unsafe_directory' : 'verification_failed' });
  if (!(error instanceof SettingsCommitError)) throw error;
  expect(JSON.parse(readFileSync(join(f.backupDir, error.recovery.id), 'utf8'))).toEqual(error.recovery);
});

it('recovers an exclusive lock after its writer is killed', async () => {
  const f = fixture();
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    ${trustedRoot}
    import { SettingsWriteThrough } from './server/src/settings/write-through.ts';
    import { jsonEditor } from './server/src/settings/editors/json.ts';
    const [target, backupDir, auditFile, expected] = process.argv.slice(1);
    jsonEditor.edit = () => {
      process.stdout.write('locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      return '{}';
    };
    const core = new SettingsWriteThrough({ backupDir, auditFile, coordinate: async (_target, operation) => operation() });
    await core.apply({ target, editor: 'json', operations: [], timing: 'now', expected: JSON.parse(expected) });
  `, f.target, f.backupDir, f.auditFile, JSON.stringify(f.change.expected)], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  try {
    const ready = once(child.stdout, 'data');
    const event = await Promise.race([ready, exit.then(() => { throw new Error(stderr || 'Writer exited before locking.'); })]);
    expect(String(event[0])).toBe('locked');
    const owner = JSON.parse(readFileSync(`${f.target}.wayroost-settings.lock`, 'utf8')) as { pid: number };
    expect(owner.pid).toBe(child.pid);
    child.kill('SIGKILL');
    await exit;
    await f.core.apply(f.change);
    expect(readFileSync(f.target, 'utf8')).toContain('updated-model');
    expect(readdirSync(f.root).filter(name => name.includes('.lock'))).toEqual([]);
  } finally { child.kill('SIGKILL'); await exit; }
});

it('keeps a populated lock belonging to a live process', async () => {
  const f = fixture();
  writeFileSync(`${f.target}.wayroost-settings.lock`, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  await expect(f.core.apply(f.change)).rejects.toMatchObject({ code: 'locked' });
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
});

it('applies and undoes with only per-process procfs entries available', async () => {
  const f = fixture();
  vi.mocked(fs.readFile).mockImplementation((...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).startsWith('/proc/') && !/^\/proc\/\d+\/stat$/.test(String(args[0]))) {
      return Promise.reject(Object.assign(new Error('Unavailable procfs entry.'), { code: 'ENOENT' }));
    }
    return actual.readFile(...args);
  });
  const token = await f.core.apply(f.change);
  await f.core.undo(token);
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(f.audit().map(record => record.result)).toEqual(['success', 'success']);
});

it('recovers locks whose process id was reused without reclaiming a live owner', async () => {
  const f = fixture();
  const lock = `${f.target}.wayroost-settings.lock`;
  const stale = JSON.stringify({ pid: process.pid, birth: '00000000-0000-4000-8000-000000000000:1' });
  writeFileSync(lock, stale, { mode: 0o600 });
  writeFileSync(`${lock}.reap`, stale, { mode: 0o600 });
  writeFileSync(`${lock}.owner-12345-00000000-0000-4000-8000-000000000000`, stale, { mode: 0o600 });
  await f.core.apply(f.change);
  expect(readFileSync(f.target, 'utf8')).toContain('updated-model');
  expect(readdirSync(f.root).filter(name => name.includes('.lock'))).toEqual([]);
});

it('serializes simultaneous stale-lock recoverers', async () => {
  const f = fixture();
  writeFileSync(`${f.target}.wayroost-settings.lock`, JSON.stringify({ pid: process.pid, birth: 'fake-process-birth' }), { mode: 0o600 });
  const other = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: f.auditFile, coordinate });
  const results = await Promise.allSettled([f.core.apply(f.change), other.apply(f.change)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find(result => result.status === 'rejected');
  expect(rejected).toMatchObject({ reason: { code: 'locked' } });
  expect(readFileSync(f.target, 'utf8')).toContain('updated-model');
  expect(existsSync(`${f.target}.wayroost-settings.lock`)).toBe(false);
});

it.each(['write', 'partial-write', 'sync', 'directory-sync'] as const)('exposes durable recovery after a committed audit %s failure', async fault => {
  const f = fixture();
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path).endsWith('/audit.jsonl')) {
      if (fault === 'write') vi.spyOn(file, 'write').mockRejectedValueOnce(new Error('demo-private-io-error'));
      if (fault === 'partial-write') {
        const write = file.write.bind(file);
        const writer: { write(buffer: Buffer): Promise<{ bytesWritten: number; buffer: Buffer }> } = file;
        vi.spyOn(writer, 'write').mockImplementationOnce(async buffer => write(buffer.subarray(0, 7)))
          .mockRejectedValueOnce(new Error('demo-private-io-error'));
      }
      if (fault === 'sync') vi.spyOn(file, 'sync').mockRejectedValueOnce(new Error('demo-private-io-error'));
    }
    if (fault === 'directory-sync' && String(path) === join(f.root, 'audit')) {
      vi.spyOn(file, 'sync').mockRejectedValueOnce(new Error('demo-private-io-error'));
    }
    return file;
  });
  const error = await f.core.apply(f.change).catch(cause => cause as {
    committed: boolean; code: string; message: string; recovery: { id: string; action: string; undoToken: UndoToken };
  });
  expect(error).toMatchObject({ committed: true, code: 'audit_failed' });
  if (!('recovery' in error)) throw new Error('Recovery information is missing.');
  expect(error.message).not.toContain('demo-private');
  expect(readFileSync(f.target, 'utf8')).toContain('updated-model');
  const manifest = join(f.backupDir, error.recovery.id);
  expect(JSON.parse(readFileSync(manifest, 'utf8'))).toEqual(error.recovery);
  expect(statSync(manifest).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(f.backupDir, error.recovery.undoToken.backupId), 'utf8')).toBe(f.source);
  vi.mocked(fs.open).mockImplementation(actual.open);
  await new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: f.auditFile, coordinate }).undo(error.recovery.undoToken);
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
});

it('exposes committed status and recovery when syncing the target directory fails after rename', async () => {
  const f = fixture();
  let renamed = false;
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => { await actual.rename(from, to); renamed = true; });
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path) === f.root) {
      const sync = file.sync.bind(file);
      vi.spyOn(file, 'sync').mockImplementation(async () => {
        if (renamed) throw new Error('demo-directory-sync-error');
        await sync();
      });
    }
    return file;
  });
  await expect(f.core.apply(f.change)).rejects.toMatchObject({ committed: true, code: 'io_failed',
    recovery: { action: 'apply', undoToken: { target: f.target, backupHash: createHash('sha256').update(f.source).digest('hex') } } });
  expect(readFileSync(f.target, 'utf8')).toContain('updated-model');
  expect(f.audit()[0]).toMatchObject({ result: 'failure', error: 'io_failed' });
});

it('persists recovery metadata before attempting the atomic rename', async () => {
  const f = fixture();
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    const directory = join(f.backupDir, createHash('sha256').update(f.target).digest('hex'));
    const manifest = readdirSync(directory).find(name => name.endsWith('.recovery.json'))!;
    expect(JSON.parse(readFileSync(join(directory, manifest), 'utf8'))).toMatchObject({ action: 'apply', undoToken: { target: f.target } });
    expect(readFileSync(f.target, 'utf8')).toBe(f.source);
    await actual.rename(from, to);
  });
  await f.core.apply(f.change);
});

it('finishes short audit writes and appends one complete record', async () => {
  const f = fixture();
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path).endsWith('/audit.jsonl')) {
      const write = file.write.bind(file);
      const writer: { write(buffer: Buffer): Promise<{ bytesWritten: number; buffer: Buffer }> } = file;
      vi.spyOn(writer, 'write').mockImplementation(async buffer => write(buffer.subarray(0, 11)));
    }
    return file;
  });
  await f.core.apply(f.change);
  expect(f.audit()).toEqual([expect.objectContaining({ result: 'success' })]);
});

it.each(['rename', 'replace', 'move-directory'] as const)('coordinates a renamed audit inode during a short write: %s', async action => {
  const f = fixture();
  const second = join(f.root, 'other.json');
  writeFileSync(second, f.source, { mode: 0o600 });
  const destination = action === 'move-directory' ? join(f.root, 'other-private') : join(f.root, 'audit');
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  mkdirSync(join(f.root, 'audit'), { recursive: true, mode: 0o700 });
  const prefix = '{"result":"previous"}\n';
  writeFileSync(f.auditFile, prefix, { mode: 0o600 });
  const alias = join(destination, 'renamed-audit.jsonl');
  const replacement = '{"result":"replacement"}\n';
  let secondResult: Promise<unknown> | undefined;
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path).endsWith('/audit.jsonl')) {
      const write = file.write.bind(file);
      const writer: { write(buffer: Buffer): Promise<{ bytesWritten: number; buffer: Buffer }> } = file;
      vi.spyOn(writer, 'write').mockImplementationOnce(async buffer => {
        const short = await write(buffer.subarray(0, 7));
        renameSync(f.auditFile, alias);
        if (action === 'replace') writeFileSync(f.auditFile, replacement, { mode: 0o600 });
        const other = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: alias, coordinate });
        secondResult = other.apply({ ...f.change, target: second }).then(value => ({ value }), error => ({ error }));
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(readFileSync(second, 'utf8')).toBe(f.source);
        return short;
      });
    }
    return file;
  });
  const firstResult = await f.core.apply(f.change).catch((error: unknown) => error);
  const otherResult = await secondResult;
  expect(firstResult).toMatchObject({ code: 'audit_failed', committed: true });
  expect(readFileSync(f.target, 'utf8')).toContain('updated-model');
  expect(otherResult, JSON.stringify(otherResult)).toHaveProperty('value');
  const audit = readFileSync(alias, 'utf8');
  expect(audit.startsWith(prefix)).toBe(true);
  expect(audit.trim().split('\n').map(line => JSON.parse(line))).toEqual([
    { result: 'previous' }, expect.objectContaining({ target: second, result: 'success' }),
  ]);
  expect(statSync(alias).nlink).toBe(1);
  if (action === 'replace') expect(readFileSync(f.auditFile, 'utf8')).toBe(replacement);
});

it('serializes a renamed audit inode against an append in another process', async () => {
  const f = fixture();
  const second = join(f.root, 'other.json');
  writeFileSync(second, f.source, { mode: 0o600 });
  const alias = join(f.root, 'audit', 'renamed-audit.jsonl');
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path).endsWith('/audit.jsonl')) {
      const write = file.write.bind(file);
      const writer: { write(buffer: Buffer): Promise<{ bytesWritten: number; buffer: Buffer }> } = file;
      vi.spyOn(writer, 'write').mockImplementationOnce(async buffer => {
        const short = await write(buffer.subarray(0, 7));
        renameSync(f.auditFile, alias);
        child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
          ${trustedRoot}
          import { SettingsWriteThrough } from './server/src/settings/write-through.ts';
          const [target, backupDir, auditFile, expected] = process.argv.slice(1);
          const core = new SettingsWriteThrough({ backupDir, auditFile, coordinate: async (_target, operation) => {
            process.stdout.write('ready');
            return operation();
          } });
          await core.apply({ target, editor: 'json', operations: [{ type: 'set', path: ['name'], value: 'second-model' }],
            timing: 'now', expected: JSON.parse(expected) });
        `, second, f.backupDir, alias, JSON.stringify(f.change.expected)],
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
        exited = once(child, 'exit');
        let stderr = '';
        child.stderr!.on('data', chunk => { stderr += String(chunk); });
        await Promise.race([once(child.stdout!, 'data'), exited.then(() => { throw new Error(stderr || 'Writer exited before append.'); })]);
        expect(readFileSync(second, 'utf8')).toBe(f.source);
        return short;
      });
    }
    return file;
  });
  try {
    await expect(f.core.apply(f.change)).rejects.toMatchObject({ code: 'audit_failed', committed: true });
    expect(await exited).toEqual([0, null]);
    const audit = readFileSync(alias, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(audit).toEqual([expect.objectContaining({ target: second, result: 'success' })]);
    expect(statSync(alias).nlink).toBe(1);
  } finally { child?.kill('SIGKILL'); if (exited) await exited; }
});

it.each(['truncate', 'sync'] as const)('detects audit pathname replacement during %s', async stage => {
  const f = fixture();
  mkdirSync(join(f.root, 'audit'), { mode: 0o700 });
  const prefix = '{"result":"previous"}\n';
  writeFileSync(f.auditFile, stage === 'truncate' ? prefix + '{"partial":' : prefix, { mode: 0o600 });
  const alias = join(f.root, 'audit', 'renamed-audit.jsonl');
  const replacement = '{"result":"replacement"}\n';
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path).endsWith('/audit.jsonl')) {
      const replace = () => { renameSync(f.auditFile, alias); writeFileSync(f.auditFile, replacement, { mode: 0o600 }); };
      if (stage === 'truncate') {
        const truncate = file.truncate.bind(file);
        vi.spyOn(file, 'truncate').mockImplementationOnce(async length => { await truncate(length); replace(); });
      } else {
        const sync = file.sync.bind(file);
        vi.spyOn(file, 'sync').mockImplementationOnce(async () => { await sync(); replace(); });
      }
    }
    return file;
  });
  await expect(f.core.apply(f.change)).rejects.toMatchObject(stage === 'truncate'
    ? { code: 'audit_failed' } : { code: 'audit_failed', committed: true });
  if (stage === 'truncate') expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(readFileSync(f.auditFile, 'utf8')).toBe(replacement);
  const records = readFileSync(alias, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(records).toEqual(stage === 'truncate' ? [{ result: 'previous' }]
    : [{ result: 'previous' }, expect.objectContaining({ target: f.target, result: 'success' })]);
  expect(statSync(alias).nlink).toBe(1);
});

it('refuses an abandoned audit hard link without repairing the log or changing the target', async () => {
  const f = fixture();
  mkdirSync(join(f.root, 'audit'), { mode: 0o700 });
  const prefix = '{"result":"previous"}\n';
  writeFileSync(f.auditFile, prefix + '{"partial":', { mode: 0o600 });
  const stat = statSync(f.auditFile, { bigint: true });
  const lock = join(f.root, 'audit', '.wayroost-audit-' + stat.dev + '-' + stat.ino + '.lock');
  linkSync(f.auditFile, lock + '.file');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, birth: 'fake-process-birth' }), { mode: 0o600 });
  const audit = readFileSync(f.auditFile);
  await expect(f.core.apply(f.change)).rejects.toMatchObject({ code: 'unsafe_audit' });
  expect(readFileSync(f.auditFile)).toEqual(audit);
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(statSync(f.auditFile).nlink).toBe(2);
  expect(existsSync(f.backupDir)).toBe(false);
  expect(fs.rename).not.toHaveBeenCalled();
});

it('serializes short audit appends from different targets and processes', async () => {
  const f = fixture();
  const second = join(f.root, 'other.json');
  writeFileSync(second, f.source, { mode: 0o600 });
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path).endsWith('/audit.jsonl')) {
      const write = file.write.bind(file);
      const writer: { write(buffer: Buffer): Promise<{ bytesWritten: number; buffer: Buffer }> } = file;
      vi.spyOn(writer, 'write').mockImplementationOnce(async buffer => {
        const short = await write(buffer.subarray(0, 7));
        child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
          ${trustedRoot}
          import { SettingsWriteThrough } from './server/src/settings/write-through.ts';
          const [target, backupDir, auditFile, expected] = process.argv.slice(1);
          const core = new SettingsWriteThrough({ backupDir, auditFile, coordinate: async (_target, operation) => {
            process.stdout.write('ready');
            return operation();
          } });
          await core.apply({ target, editor: 'json', operations: [{ type: 'set', path: ['name'], value: 'second-model' }],
            timing: 'now', expected: JSON.parse(expected) });
        `, second, f.backupDir, f.auditFile, JSON.stringify(f.change.expected)],
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
        exited = once(child, 'exit');
        let stderr = '';
        child.stderr!.on('data', chunk => { stderr += String(chunk); });
        await Promise.race([once(child.stdout!, 'data'), exited.then(() => { throw new Error(stderr || 'Writer exited before append.'); })]);
        expect(readFileSync(second, 'utf8')).toBe(f.source);
        await new Promise(resolve => setTimeout(resolve, 100));
        return short;
      });
    }
    return file;
  });
  try {
    await f.core.apply(f.change);
    expect(await exited).toEqual([0, null]);
    expect(f.audit()).toEqual([
      expect.objectContaining({ target: f.target, result: 'success' }),
      expect.objectContaining({ target: second, result: 'success' }),
    ]);
  } finally { child?.kill('SIGKILL'); if (exited) await exited; }
});

it('repairs a failed short audit tail before appending the next complete record', async () => {
  const f = fixture();
  await f.core.apply(f.change);
  const complete = readFileSync(f.auditFile, 'utf8');
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path).endsWith('/audit.jsonl')) {
      const write = file.write.bind(file);
      const writer: { write(buffer: Buffer): Promise<{ bytesWritten: number; buffer: Buffer }> } = file;
      vi.spyOn(writer, 'write').mockImplementationOnce(async buffer => write(buffer.subarray(0, 7)))
        .mockRejectedValueOnce(new Error('demo-write-error'));
    }
    return file;
  });
  await expect(f.core.apply(f.change)).rejects.toMatchObject({ committed: true, code: 'audit_failed' });
  expect(readFileSync(f.auditFile, 'utf8')).toBe(`${complete}{"times`);
  vi.mocked(fs.open).mockImplementation(actual.open);
  await f.core.apply(f.change);
  expect(readFileSync(f.auditFile, 'utf8').startsWith(complete)).toBe(true);
  expect(f.audit()).toHaveLength(2);
  expect(f.audit().every(record => record.result === 'success')).toBe(true);
});

it.each([false, true])('repairs an incomplete audit tail spanning multiple blocks with a complete prefix: %s', async hasPrefix => {
  const f = fixture();
  let prefix = '';
  if (hasPrefix) {
    await f.core.apply(f.change);
    prefix = readFileSync(f.auditFile, 'utf8');
  } else mkdirSync(join(f.root, 'audit'), { mode: 0o700 });
  writeFileSync(f.auditFile, `${prefix}{"timestamp":"${'x'.repeat(9000)}`, { mode: 0o600 });
  await f.core.apply(f.change);
  expect(readFileSync(f.auditFile, 'utf8').startsWith(prefix)).toBe(true);
  expect(f.audit()).toHaveLength(hasPrefix ? 2 : 1);
  expect(readFileSync(f.auditFile, 'utf8')).not.toContain('x'.repeat(100));
});

it('leaves the target untouched if an incomplete audit tail cannot be repaired', async () => {
  const f = fixture();
  mkdirSync(join(f.root, 'audit'), { mode: 0o700 });
  const fragment = '{"timestamp":';
  writeFileSync(f.auditFile, fragment, { mode: 0o600 });
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path).endsWith('/audit.jsonl')) {
      vi.spyOn(file, 'truncate').mockRejectedValueOnce(new Error('demo-truncate-error'));
      vi.spyOn(file, 'write');
    }
    return file;
  });
  const error = await f.core.apply(f.change).catch(cause => cause);
  expect(error).toMatchObject({ code: 'audit_failed' });
  expect(error.committed).toBeUndefined();
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(existsSync(f.backupDir)).toBe(false);
  expect(readFileSync(f.auditFile, 'utf8')).toBe(fragment);
  expect(fs.rename).not.toHaveBeenCalled();
});

it('holds the shared audit lock until the record is synced', async () => {
  const f = fixture();
  let lock: string | undefined;
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path).endsWith('/audit.jsonl')) {
      const stat = await file.stat({ bigint: true });
      lock = join(f.root, '.wayroost-audit-' + stat.dev + '-' + stat.ino + '.lock');
      const sync = file.sync.bind(file);
      vi.spyOn(file, 'sync').mockImplementation(async () => {
        expect(existsSync(lock!)).toBe(true);
        await sync();
      });
    }
    return file;
  });
  await f.core.apply(f.change);
  expect(existsSync(lock!)).toBe(false);
  expect(f.audit()[0]).toMatchObject({ result: 'success' });
});

it('does not commit when recovery metadata cannot be synced', async () => {
  const f = fixture();
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path).endsWith('.recovery.json')) vi.spyOn(file, 'sync').mockRejectedValueOnce(new Error('demo-sync-error'));
    return file;
  });
  const error: unknown = await f.core.apply(f.change).catch(cause => cause);
  expect(error).toMatchObject({ code: 'io_failed' });
  expect(error).not.toHaveProperty('committed');
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  expect(fs.rename).not.toHaveBeenCalled();
});

it.each(['apply', 'undo'] as const)('pins durable recovery when the final %s target directory close fails', async action => {
  const f = fixture(undefined, 0o600, { keepBackups: 1 });
  const token = action === 'undo' ? await f.core.apply(f.change) : undefined;
  let targetDirectory: fs.FileHandle | undefined;
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path) === f.root && !targetDirectory) {
      targetDirectory = file;
      const close = file.close.bind(file);
      vi.spyOn(file, 'close').mockImplementation(async () => {
        await close();
        throw new Error('demo-close-error');
      });
    }
    return file;
  });
  const error: unknown = await (token ? f.core.undo(token) : f.core.apply(f.change)).catch(cause => cause);
  expect(error).toMatchObject({ committed: true, code: 'io_failed', recovery: { action } });
  if (!(error instanceof SettingsCommitError)) throw error;
  const committed = action === 'apply' ? f.source.replace('demo-model', 'updated-model') : f.source;
  const restored = action === 'apply' ? f.source : f.source.replace('demo-model', 'updated-model');
  expect(readFileSync(f.target, 'utf8')).toBe(committed);
  expect(f.audit().at(-1)).toMatchObject({ action, result: 'success' });
  const manifest = join(f.backupDir, error.recovery.id);
  const backup = join(f.backupDir, error.recovery.undoToken.backupId);
  expect(JSON.parse(readFileSync(manifest, 'utf8'))).toEqual(error.recovery);
  expect(statSync(manifest).mode & 0o777).toBe(0o600);
  expect(readFileSync(backup, 'utf8')).toBe(restored);
  vi.mocked(fs.open).mockImplementation(actual.open);
  await f.core.apply({ ...f.change, operations: [] });
  expect(JSON.parse(readFileSync(manifest, 'utf8'))).toEqual(error.recovery);
  expect(readFileSync(backup, 'utf8')).toBe(restored);
  await new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: f.auditFile, coordinate, keepBackups: 1 }).undo(error.recovery.undoToken);
  expect(readFileSync(f.target, 'utf8')).toBe(restored);
  expect(existsSync(manifest)).toBe(false);
});

it.each(['apply', 'undo'] as const)('keeps %s recovery pinned while a concurrent write finishes during a failing target close', async action => {
  const f = fixture(undefined, 0o600, { keepBackups: 1 });
  const token = action === 'undo' ? await f.core.apply(f.change) : undefined;
  let closing!: () => void;
  let resume!: () => void;
  const paused = new Promise<void>(resolve => { closing = resolve; });
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  let targetDirectory: fs.FileHandle | undefined;
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path) === f.root && !targetDirectory) {
      targetDirectory = file;
      const close = file.close.bind(file);
      vi.spyOn(file, 'close').mockImplementation(async () => {
        await close();
        closing();
        await resumed;
        throw new Error('demo-close-error');
      });
    }
    return file;
  });
  const pending = (token ? f.core.undo(token) : f.core.apply(f.change)).catch((cause: unknown) => cause);
  await paused;
  try {
    const concurrent = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: f.auditFile, coordinate, keepBackups: 1 });
    await concurrent.apply({ ...f.change, operations: [] });
  } finally { resume(); }
  const error = await pending;
  expect(error).toMatchObject({ committed: true, code: 'io_failed', recovery: { action } });
  if (!(error instanceof SettingsCommitError)) throw error;
  const restored = action === 'apply' ? f.source : f.source.replace('demo-model', 'updated-model');
  const manifest = join(f.backupDir, error.recovery.id);
  const backup = join(f.backupDir, error.recovery.undoToken.backupId);
  expect(JSON.parse(readFileSync(manifest, 'utf8'))).toEqual(error.recovery);
  expect(statSync(manifest).mode & 0o777).toBe(0o600);
  expect(readFileSync(backup, 'utf8')).toBe(restored);
  vi.mocked(fs.open).mockImplementation(actual.open);
  await new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: f.auditFile, coordinate, keepBackups: 1 }).undo(error.recovery.undoToken);
  expect(readFileSync(f.target, 'utf8')).toBe(restored);
  expect(existsSync(manifest)).toBe(false);
  expect(f.audit().map(record => record.result)).toEqual(Array(action === 'apply' ? 3 : 4).fill('success'));
});

it.each(['apply', 'undo'].flatMap(action => ['backup-directory', 'lock-descriptor'].map(stage => ({ action, stage }))))(
  'serializes $action recovery removal and retention through a failing $stage close', async ({ action, stage }) => {
    const f = fixture(undefined, 0o600, { keepBackups: 1 });
    const token = action === 'undo' ? await f.core.apply(f.change) : undefined;
    const backupDirectory = join(f.backupDir, createHash('sha256').update(f.target).digest('hex'));
    let closing!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>(resolve => { closing = resolve; });
    const resumed = new Promise<void>(resolve => { resume = resolve; });
    let removed = false;
    let failed = false;
    vi.mocked(fs.unlink).mockImplementation(async path => {
      await actual.unlink(path);
      if (String(path).endsWith('.recovery.json')) removed = true;
    });
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const file = await actual.open(path, flags, mode);
      if (stage === 'backup-directory' ? String(path) === backupDirectory
        : String(path).includes('/models.json.wayroost-settings.lock.owner-')) {
        const close = file.close.bind(file);
        vi.spyOn(file, 'close').mockImplementation(async () => {
          await close();
          if (removed && !failed) {
            failed = true;
            closing();
            await resumed;
            throw new Error('demo-close-error');
          }
        });
      }
      return file;
    });
    const pending = (token ? f.core.undo(token) : f.core.apply(f.change)).catch((cause: unknown) => cause);
    await paused;
    const concurrent = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: f.auditFile, coordinate, keepBackups: 1 });
    try {
      expect(existsSync(settingsLockPath(f.target))).toBe(true);
      await expect(concurrent.apply({ ...f.change, operations: [] })).rejects.toMatchObject({ code: 'locked' });
    } finally { resume(); }
    const error = await pending;
    expect(error).toMatchObject({ committed: true, code: 'io_failed', recovery: { action } });
    if (!(error instanceof SettingsCommitError)) throw error;
    const restored = action === 'apply' ? f.source : f.source.replace('demo-model', 'updated-model');
    const manifest = join(f.backupDir, error.recovery.id);
    const backup = join(f.backupDir, error.recovery.undoToken.backupId);
    expect(JSON.parse(readFileSync(manifest, 'utf8'))).toEqual(error.recovery);
    expect(statSync(manifest).mode & 0o777).toBe(0o600);
    expect(readFileSync(backup, 'utf8')).toBe(restored);
    expect(existsSync(settingsLockPath(f.target))).toBe(false);
    vi.mocked(fs.open).mockImplementation(actual.open);
    await concurrent.apply({ ...f.change, operations: [] });
    expect(readFileSync(backup, 'utf8')).toBe(restored);
    expect(existsSync(manifest)).toBe(true);
    await concurrent.undo(error.recovery.undoToken);
    expect(readFileSync(f.target, 'utf8')).toBe(restored);
    expect(existsSync(manifest)).toBe(false);
  });

it.each(['apply', 'undo'].flatMap(action => [
  { depth: 1, reaper: 1 }, { depth: 3, reaper: 1 }, { depth: 3, reaper: 2 }, { depth: 3, reaper: 3 },
].flatMap(({ depth, reaper }) => ['close', 'unlink'].map(stage => ({ action, depth, reaper, stage })))))(
  'pins $action recovery through a failing reaper $stage at level $reaper of $depth', async ({ action, depth, reaper, stage }) => {
    const f = fixture(undefined, 0o600, { keepBackups: 1 });
    const token = action === 'undo' ? await f.core.apply(f.change) : undefined;
    const lock = settingsLockPath(f.target);
    const reaperPath = lock + '.reap'.repeat(reaper);
    const backupDirectory = join(f.backupDir, createHash('sha256').update(f.target).digest('hex'));
    let closing!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>(resolve => { closing = resolve; });
    const resumed = new Promise<void>(resolve => { resume = resolve; });
    let targetDirectory: fs.FileHandle | undefined;
    let seeded = false;
    let failed = false;
    let saved!: { id: string; undoToken: UndoToken };
    const fail = async () => {
      failed = true;
      closing();
      await resumed;
      throw new Error('demo-reaper-cleanup-error');
    };
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const file = await actual.open(path, flags, mode);
      if (String(path) === f.root && !targetDirectory) {
        targetDirectory = file;
        const close = file.close.bind(file);
        vi.spyOn(file, 'close').mockImplementation(async () => {
          await close();
          const name = readdirSync(backupDirectory).find(name => name.endsWith('.recovery.json'))!;
          saved = JSON.parse(readFileSync(join(backupDirectory, name), 'utf8'));
          for (let level = 0; level < depth; level++) {
            writeFileSync(lock + '.reap'.repeat(level), JSON.stringify({ pid: process.pid, birth: 'fake-process-birth' }), { mode: 0o600 });
          }
          seeded = true;
        });
      }
      if (stage === 'close' && String(path).startsWith(`${reaperPath}.owner-`)) {
        const close = file.close.bind(file);
        vi.spyOn(file, 'close').mockImplementation(async () => {
          const held = existsSync(reaperPath) && lstatSync(reaperPath).ino === (await file.stat()).ino;
          await close();
          if (seeded && held && !failed) await fail();
        });
      }
      return file;
    });
    vi.mocked(fs.unlink).mockImplementation(async path => {
      if (stage === 'unlink' && seeded && String(path) === reaperPath && !failed
        && JSON.parse(readFileSync(reaperPath, 'utf8')).birth !== 'fake-process-birth') {
        try { await fail(); }
        finally { await actual.unlink(path); }
      }
      await actual.unlink(path);
    });
    const pending = (token ? f.core.undo(token) : f.core.apply(f.change)).catch((cause: unknown) => cause);
    await paused;
    const manifest = join(f.backupDir, saved.id);
    const backup = join(f.backupDir, saved.undoToken.backupId);
    const pinned = existsSync(manifest);
    const concurrent = new SettingsWriteThrough({ backupDir: f.backupDir, auditFile: f.auditFile, coordinate, keepBackups: 1 });
    let concurrentError: unknown;
    try {
      await concurrent.apply({ ...f.change, operations: [] }).catch((cause: unknown) => { concurrentError = cause; });
    } finally { resume(); }
    const error = await pending;
    expect(error).toMatchObject({ committed: true, code: 'io_failed', recovery: { action } });
    if (!(error instanceof SettingsCommitError)) throw error;
    expect(concurrentError).toBeUndefined();
    expect(pinned).toBe(true);
    expect(error.recovery).toEqual(saved);
    expect(JSON.parse(readFileSync(manifest, 'utf8'))).toEqual(saved);
    expect(statSync(manifest).mode & 0o777).toBe(0o600);
    const restored = action === 'apply' ? f.source : f.source.replace('demo-model', 'updated-model');
    expect(readFileSync(backup, 'utf8')).toBe(restored);
    vi.mocked(fs.open).mockImplementation(actual.open);
    vi.mocked(fs.unlink).mockImplementation(actual.unlink);
    await concurrent.apply({ ...f.change, operations: [] });
    expect(existsSync(manifest)).toBe(true);
    expect(readFileSync(backup, 'utf8')).toBe(restored);
    await concurrent.undo(error.recovery.undoToken);
    expect(readFileSync(f.target, 'utf8')).toBe(restored);
    expect(existsSync(manifest)).toBe(false);
    expect(readdirSync(f.root).filter(name => name.includes('.lock'))).toEqual([]);
  });

it.each(['apply', 'undo'].flatMap(action => [1, 3].map(depth => ({ action, depth }))))(
  'finishes $depth reapers before resolving successful $action recovery under the target lock', async ({ action, depth }) => {
    const f = fixture(undefined, 0o600, { keepBackups: 1 });
    const token = action === 'undo' ? await f.core.apply(f.change) : undefined;
    const lock = settingsLockPath(f.target);
    let targetDirectory: fs.FileHandle | undefined;
    let seeded = false;
    let removed = false;
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const file = await actual.open(path, flags, mode);
      if (String(path) === f.root && !targetDirectory) {
        targetDirectory = file;
        const close = file.close.bind(file);
        vi.spyOn(file, 'close').mockImplementation(async () => {
          await close();
          for (let level = 0; level < depth; level++) {
            writeFileSync(lock + '.reap'.repeat(level), JSON.stringify({ pid: process.pid, birth: 'fake-process-birth' }), { mode: 0o600 });
          }
          seeded = true;
        });
      }
      return file;
    });
    vi.mocked(fs.unlink).mockImplementation(async path => {
      if (seeded && String(path).endsWith('.recovery.json')) {
        removed = true;
        expect(existsSync(lock)).toBe(true);
        for (let level = 1; level <= depth; level++) expect(existsSync(lock + '.reap'.repeat(level))).toBe(false);
      }
      await actual.unlink(path);
    });
    await (token ? f.core.undo(token) : f.core.apply(f.change));
    expect(removed).toBe(true);
    expect(readFileSync(f.target, 'utf8')).toBe(action === 'apply' ? f.source.replace('demo-model', 'updated-model') : f.source);
    expect(readdirSync(f.root).filter(name => name.includes('.lock'))).toEqual([]);
    const directory = join(f.backupDir, createHash('sha256').update(f.target).digest('hex'));
    expect(readdirSync(directory).filter(name => name.endsWith('.recovery.json'))).toEqual([]);
    expect(f.audit().map(record => record.result)).toEqual(Array(action === 'apply' ? 1 : 2).fill('success'));
  });

it('exposes recovery if resuming independent writers fails after committing', async () => {
  const f = fixture(undefined, 0o600, { coordinate: async (_target, operation) => {
    await operation();
    throw new Error('demo-resume-error');
  } });
  await expect(f.core.apply(f.change)).rejects.toMatchObject({ committed: true, recovery: { action: 'apply' } });
  expect(readFileSync(f.target, 'utf8')).toContain('updated-model');
  expect(f.audit()[0]).toMatchObject({ result: 'success' });
});

it('provides a reverse undo token after an undo commits but its audit fails', async () => {
  const f = fixture();
  const token = await f.core.apply(f.change);
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    if (String(path).endsWith('/audit.jsonl')) vi.spyOn(file, 'sync').mockRejectedValueOnce(new Error('demo-sync-error'));
    return file;
  });
  const error = await f.core.undo(token).catch(cause => cause as { committed: boolean; recovery: { action: string; undoToken: UndoToken } });
  expect(error).toMatchObject({ committed: true, recovery: { action: 'undo' } });
  if (!error) throw new Error('Committed undo error is missing.');
  expect(readFileSync(f.target, 'utf8')).toBe(f.source);
  vi.mocked(fs.open).mockImplementation(actual.open);
  await f.core.undo(error.recovery.undoToken);
  expect(readFileSync(f.target, 'utf8')).toContain('updated-model');
});

it.each([
  ['yaml', 'id: 9007199254740993\nname: original\n'],
  ['yaml', '1: old\nname: original\n'],
  ['yaml', 'timeout: 1:59\nname: original\n'],
  ['yaml', 'id: 08\nname: original\n'],
  ['yaml', 'value: -.5\nname: original\n'],
  ['yaml', 'value: +.5\nname: original\n'],
  ['yaml', 'value: .5e3\nname: original\n'],
  ['json', '{"name":"first","name":"last"}'],
] as const)('leaves unsupported %s documents untouched before backup', async (editor, source) => {
  const f = fixture(source);
  await expect(f.core.apply({ ...f.change, editor })).rejects.toMatchObject({ code: 'parse_failed' });
  expect(readFileSync(f.target, 'utf8')).toBe(source);
  expect(existsSync(f.backupDir)).toBe(false);
  expect(fs.rename).not.toHaveBeenCalled();
});
