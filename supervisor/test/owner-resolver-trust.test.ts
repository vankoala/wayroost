import { execFile, type ChildProcess } from 'node:child_process';
import type { Stats } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ACL_PROBE_SCRIPT, trustedDirectory, trustedExecutable, trustedOwnerDirectory, trustedOwnerExecutable } from '../src/trust.js';
import { resolveHermesConfig, type HermesResolverCommand } from '../src/config-hermes.js';
import { settingsTargetsSchema } from '../../shared/settings-targets.js';
import { READ_VIEWS } from '../../shared/settings-ops.js';

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), lstat: vi.fn(), open: vi.fn(), readFile: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: vi.fn() }));
const owner = 1234;
const path = '/home/me/.hermes/installs/example/hermes_cli/config.py';
const python = '/home/me/.hermes/installs/example/python';
const venv = '/home/me/.hermes/installs/example/environments/example-hash/venv';
const venvConfig = `${venv}/pyvenv.cfg`;
const sitePackages = `${venv}/lib/python3.14/site-packages`;
const nodes = new Map<string, { uid: number; mode: number; gid?: number; nlink?: number; kind?: 'link' | 'file' }>();
beforeEach(() => {
  vi.spyOn(process, 'getuid').mockReturnValue(owner);
  nodes.clear();
  vi.mocked(execFile).mockImplementation((...args) => {
    (args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void)(null, 'no-acl\n', '');
    return {} as ChildProcess;
  });
  nodes.set('/usr', { uid: 0, mode: 0o755 });
  nodes.set('/usr/bin', { uid: 0, mode: 0o755 });
  nodes.set('/usr/bin/python3', { uid: 0, mode: 0o755, kind: 'file' });
  for (const [at, uid, mode] of [
    ['/', 0, 0o755], ['/home', 0, 0o755], ['/home/me', owner, 0o750],
    ['/home/me/.hermes', owner, 0o700], ['/home/me/.hermes/installs', owner, 0o775],
    ['/home/me/.hermes/installs/example', owner, 0o775], ['/home/me/.hermes/installs/example/hermes_cli', owner, 0o775],
  ] as const) nodes.set(at, { uid, mode });
  nodes.set(path, { uid: owner, mode: 0o644, kind: 'file' });
  nodes.set(python, { uid: owner, mode: 0o755, kind: 'file' });
  for (const at of ['/home/me/.hermes/installs/example/environments', '/home/me/.hermes/installs/example/environments/example-hash'])
    nodes.set(at, { uid: owner, mode: 0o775 });
  for (const at of [venv, `${venv}/lib`, `${venv}/lib/python3.14`]) nodes.set(at, { uid: owner, mode: 0o777 });
  nodes.set(sitePackages, { uid: owner, mode: 0o755 });
  nodes.set(venvConfig, { uid: owner, mode: 0o600, kind: 'file' });
  vi.mocked(open).mockImplementation(async at => {
    if (String(at) !== venvConfig) throw new Error('missing');
    const contents = Buffer.from('home = /home/me/.hermes/installs/example\nversion_info = 3.14.0\n');
    return {
      stat: async () => ({ isFile: () => true, size: contents.length }),
      read: async (buffer: Buffer) => ({ bytesRead: contents.copy(buffer), buffer }),
      close: async () => {},
    } as unknown as Awaited<ReturnType<typeof open>>;
  });
  vi.mocked(lstat).mockImplementation(async at => {
    const node = nodes.get(String(at));
    if (!node) throw new Error('missing');
    return { uid: node.uid, mode: node.mode, gid: node.gid ?? owner, nlink: node.nlink ?? 1, isSymbolicLink: () => node.kind === 'link',
      isDirectory: () => !node.kind, isFile: () => node.kind === 'file' } as Stats;
  });
});
afterEach(() => vi.restoreAllMocks());

it.each([path, python])('accepts private-group writable code with multiple links at %s', async file => {
  Object.assign(nodes.get(file)!, { mode: 0o664, nlink: 2 });
  const groupLookup = vi.fn(async () => true);
  await expect(trustedOwnerExecutable(file, owner, groupLookup)).resolves.toBe(file);
  expect(groupLookup).toHaveBeenCalledExactlyOnceWith(owner, owner);
});

it.each([path, python].flatMap(file => [
  { file, mode: 0o666, groups: 'me:x:1234:\n', accounts: 'me:x:1234:1234::/home/me:/bin/sh\n', reason: 'world writable' },
  { file, mode: 0o664, groups: 'me:x:1234:me,other\n', accounts: 'me:x:1234:1234::/home/me:/bin/sh\n', reason: 'shared members' },
  { file, mode: 0o664, groups: 'me:x:1234:\n', accounts: 'me:x:1234:1234::/home/me:/bin/sh\nother:x:4321:1234::/home/other:/bin/sh\n', reason: 'shared primary group' },
  { file, mode: 0o664, groups: '', accounts: 'me:x:1234:1234::/home/me:/bin/sh\n', reason: 'missing group' },
  { file, mode: 0o664, groups: 'me:x:1234:\n', accounts: 'me:x:1234:1234::/home/me:/bin/sh\n', reason: 'access ACL grants another user write', acl: true },
]))('refuses $reason for multiply-linked $file', async ({ file, mode, groups, accounts, ...shape }) => {
  Object.assign(nodes.get(file)!, { mode, nlink: 2 });
  vi.mocked(readFile).mockImplementation(async at => String(at) === '/etc/group' ? groups : accounts);
  if ('acl' in shape) vi.mocked(execFile).mockImplementation((...args) => {
    (args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void)(null, 'acl\n', '');
    return {} as ChildProcess;
  });
  await expect(trustedOwnerExecutable(file, owner)).rejects.toThrow();
});

it.each(['', 'me'])('resolves the owner private group with member list %s from account files', async members => {
  Object.assign(nodes.get(path)!, { mode: 0o664, nlink: 2 });
  vi.mocked(readFile).mockImplementation(async at => String(at) === '/etc/group' ? `me:x:1234:${members}\n`
    : 'root:x:0:0::/root:/bin/sh\nme:x:1234:1234::/home/me:/bin/sh\n');
  await expect(trustedOwnerExecutable(path, owner)).resolves.toBe(path);
});

it('fails closed when account files cannot be resolved', async () => {
  Object.assign(nodes.get(path)!, { mode: 0o664 });
  vi.mocked(readFile).mockRejectedValue(new Error('unavailable'));
  await expect(trustedOwnerExecutable(path, owner)).rejects.toThrow();
});

it('accepts a 0750 home, private Hermes folder and writable install directories', async () => {
  expect(await trustedOwnerExecutable(path, owner)).toBe(path);
  nodes.get('/home/me/.hermes/installs')!.mode = 0o777;
  expect(await trustedOwnerExecutable(path, owner)).toBe(path);
  nodes.get('/home/me/.hermes')!.uid = 0;
  nodes.get(path)!.uid = 0;
  expect(await trustedOwnerExecutable(path, owner)).toBe(path);
});

it.each([
  ['open ancestor', '/home/me/.hermes', { mode: 0o750 }],
  ['writable ancestor before closure', '/home/me', { mode: 0o775 }],
  ['foreign ancestor', '/home/me', { uid: 4321 }],
  ['foreign directory below closure', '/home/me/.hermes/installs/example', { uid: 4321 }],
  ['foreign source', path, { uid: 4321 }],
  ['directory symlink', '/home/me/.hermes/installs', { kind: 'link' as const }],
  ['source symlink', path, { kind: 'link' as const }],
])('refuses %s', async (_name, at, patch) => {
  Object.assign(nodes.get(at)!, patch);
  await expect(trustedOwnerExecutable(path, owner)).rejects.toThrow();
});

it('refuses another running identity, root, parent traversal and non-files', async () => {
  await expect(trustedOwnerExecutable(path, 4321)).rejects.toThrow();
  vi.mocked(process.getuid!).mockReturnValue(0);
  await expect(trustedOwnerExecutable(path, owner)).rejects.toThrow();
  await expect(trustedOwnerExecutable(path, 0)).rejects.toThrow();
  vi.mocked(process.getuid!).mockReturnValue(owner);
  await expect(trustedOwnerExecutable('/home/me/.hermes/../config.py', owner)).rejects.toThrow();
  nodes.get(path)!.kind = undefined;
  await expect(trustedOwnerExecutable(path, owner)).rejects.toThrow();
});

it('keeps root-run executable trust strict even under a closed owner ancestor', async () => {
  await expect(trustedExecutable(path)).rejects.toThrow('someone other than root');
});

function resolverSite() {
  return settingsTargetsSchema.parse({ version: 1, targets: { 'hermes-config': {
    path: '/home/me/.hermes/config.yaml', runAs: { user: 'me', uid: owner }, mode: 0o600, format: 'yaml',
    backupDir: '/home/me/.hermes/backups', auditDir: '/home/me/.hermes/audit',
    lock: { kind: 'file', path: '/home/me/.hermes/config.yaml.wayroost-settings.lock' },
    resolver: { python, modulePath: '/home/me/.hermes/installs/example' },
  } } });
}

function venvResolverSite() {
  const site = resolverSite();
  site.targets['hermes-config']!.resolver!.venv = venv;
  return site;
}

it('walks the venv, metadata, lib, version directory and site-packages behind the closed ancestor', async () => {
  const run = vi.fn<HermesResolverCommand>(async () => '{"ok":true,"document":{}}');
  await expect(resolveHermesConfig(venvResolverSite(), READ_VIEWS['hermes.safety'], run)).resolves.toEqual({});
  expect(run).toHaveBeenCalledOnce();
  expect(vi.mocked(lstat).mock.calls.map(([at]) => at)).toEqual(expect.arrayContaining([
    python, path, venv, venvConfig, `${venv}/lib`, `${venv}/lib/python3.14`, sitePackages,
  ]));
  expect(run.mock.calls[0]![1]).toEqual(['-c', expect.any(String), '/home/me/.hermes/installs/example', '/home/me/.hermes/config.yaml',
    JSON.stringify(READ_VIEWS['hermes.safety'].keys), 'false', venv, python, sitePackages]);
});

it.each([venv, venvConfig, `${venv}/lib`, `${venv}/lib/python3.14`, sitePackages].flatMap(at => [
  { at, reason: 'symlink', patch: { kind: 'link' as const } },
  { at, reason: 'foreign owner', patch: { uid: 4321 } },
  { at, reason: 'wrong type', patch: { kind: at === venvConfig ? undefined : 'file' as const } },
]))('refuses venv $reason at $at before launching the resolver', async ({ at, patch }) => {
  Object.assign(nodes.get(at)!, patch);
  const run = vi.fn(async () => '{"ok":true,"document":{}}');
  await expect(resolveHermesConfig(venvResolverSite(), READ_VIEWS['hermes.safety'], run)).rejects.toMatchObject({ code: 'unavailable' });
  expect(run).not.toHaveBeenCalled();
});

it.each([venvConfig, sitePackages])('refuses missing venv path %s before launching the resolver', async at => {
  nodes.delete(at);
  const run = vi.fn(async () => '{"ok":true,"document":{}}');
  await expect(resolveHermesConfig(venvResolverSite(), READ_VIEWS['hermes.safety'], run)).rejects.toMatchObject({ code: 'unavailable' });
  expect(run).not.toHaveBeenCalled();
});

it.each([venvConfig, sitePackages].flatMap(at => [
  { at, reason: 'world writable', mode: 0o777 },
  { at, reason: 'group writable with a foreign group', mode: 0o775 },
  { at, reason: 'access ACL', mode: 0o755 },
]))('applies the code-file rule to $at: $reason', async ({ at, reason, mode }) => {
  Object.assign(nodes.get(at)!, { mode, gid: 4321 });
  vi.mocked(readFile).mockImplementation(async file => String(file) === '/etc/group' ? 'foreign:x:4321:other\n'
    : 'me:x:1234:1234::/home/me:/bin/sh\nother:x:4321:4321::/home/other:/bin/sh\n');
  if (reason === 'access ACL') vi.mocked(execFile).mockImplementation((...args) => {
    (args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void)(null, 'acl\n', '');
    return {} as ChildProcess;
  });
  const run = vi.fn(async () => '{"ok":true,"document":{}}');
  await expect(resolveHermesConfig(venvResolverSite(), READ_VIEWS['hermes.safety'], run)).rejects.toMatchObject({ code: 'unavailable' });
  expect(run).not.toHaveBeenCalled();
});

it('accepts private-group writable metadata and site-packages with the code-file ACL checks', async () => {
  nodes.get(venvConfig)!.mode = 0o660;
  nodes.get(sitePackages)!.mode = 0o770;
  vi.mocked(readFile).mockImplementation(async at => String(at) === '/etc/group' ? 'me:x:1234:me\n' : 'me:x:1234:1234::/home/me:/bin/sh\n');
  const run = vi.fn(async () => '{"ok":true,"document":{}}');
  await expect(resolveHermesConfig(venvResolverSite(), READ_VIEWS['hermes.safety'], run)).resolves.toEqual({});
  expect(vi.mocked(execFile).mock.calls.map(args => (args[1] as string[]).at(-1))).toEqual(expect.arrayContaining([venvConfig, sitePackages]));
});

it('requires a closed ancestor for the dependency directory and keeps the root directory walk strict', async () => {
  nodes.get('/home/me/.hermes')!.mode = 0o750;
  await expect(trustedOwnerDirectory(sitePackages, owner)).rejects.toThrow();
  for (const node of nodes.values()) Object.assign(node, { uid: 0, mode: node.kind ? 0o644 : 0o755 });
  vi.mocked(process.getuid!).mockReturnValue(0);
  await expect(trustedDirectory(sitePackages)).resolves.toBe(sitePackages);
  nodes.get(`${venv}/lib`)!.mode = 0o775;
  await expect(trustedDirectory(sitePackages)).rejects.toThrow('someone other than root');
});

it('validates both interpreter and source behind the closed ancestor before invoking the owner resolver', async () => {
  const run = vi.fn(async () => '{"ok":true,"document":{}}');
  await expect(resolveHermesConfig(resolverSite(), READ_VIEWS['hermes.safety'], run)).resolves.toEqual({});
  expect(run).toHaveBeenCalledOnce();
  expect(vi.mocked(lstat).mock.calls.map(([at]) => at)).toEqual(expect.arrayContaining([python, path]));
  nodes.get('/home/me/.hermes/installs/example')!.mode = 0o777;
  await expect(resolveHermesConfig(resolverSite(), READ_VIEWS['hermes.safety'], run)).resolves.toEqual({});
});

it.each([
  ['open closure', '/home/me/.hermes', { mode: 0o750 }],
  ['open writable ancestor', '/home/me', { mode: 0o777 }],
  ['foreign ancestor', '/home/me', { uid: 4321 }],
  ['foreign install', '/home/me/.hermes/installs/example', { uid: 4321 }],
  ['foreign interpreter', python, { uid: 4321 }],
  ['foreign source', path, { uid: 4321 }],
  ['linked install', '/home/me/.hermes/installs', { kind: 'link' as const }],
  ['linked interpreter', python, { kind: 'link' as const }],
  ['linked source', path, { kind: 'link' as const }],
])('refuses %s inside the owner resolver before invoking the interpreter', async (_name, at, patch) => {
  Object.assign(nodes.get(at)!, patch);
  const run = vi.fn(async () => '{"ok":true,"document":{}}');
  await expect(resolveHermesConfig(resolverSite(), READ_VIEWS['hermes.safety'], run)).rejects.toMatchObject({ code: 'unavailable' });
  expect(run).not.toHaveBeenCalled();
});

it('keeps resolver trust strict when the resolver itself runs as root', async () => {
  vi.mocked(process.getuid!).mockReturnValue(0);
  const run = vi.fn(async () => '{"ok":true,"document":{}}');
  await expect(resolveHermesConfig(resolverSite(), READ_VIEWS['hermes.safety'], run)).rejects.toMatchObject({ code: 'unavailable' });
  expect(run).not.toHaveBeenCalled();
});

it('checks access ACLs with an isolated root-trusted interpreter and literal argv', async () => {
  await expect(trustedOwnerExecutable(path, owner)).resolves.toBe(path);
  expect(execFile).toHaveBeenCalledExactlyOnceWith('/usr/bin/python3', [
    '-I', '-c', expect.stringContaining('os.listxattr(sys.argv[1], follow_symlinks=False)'), path,
  ], expect.objectContaining({ timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 1024, cwd: '/' }), expect.any(Function));
});

it.each([
  { name: 'error', error: new Error('unavailable'), stdout: '', stderr: '' },
  { name: 'timeout', error: Object.assign(new Error('timeout'), { killed: true }), stdout: 'no-acl\n', stderr: '' },
  { name: 'unexpected output', error: null, stdout: 'unknown\n', stderr: '' },
  { name: 'empty output', error: null, stdout: '', stderr: '' },
  { name: 'stderr output', error: null, stdout: 'no-acl\n', stderr: 'warning' },
])('fails closed on ACL probe $name', async ({ error, stdout, stderr }) => {
  vi.mocked(execFile).mockImplementation((...args) => {
    (args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void)(error, stdout, stderr);
    return {} as ChildProcess;
  });
  await expect(trustedOwnerExecutable(path, owner)).rejects.toThrow();
});

it('refuses to run an ACL probe through an untrusted system interpreter', async () => {
  nodes.get('/usr/bin/python3')!.mode = 0o777;
  await expect(trustedOwnerExecutable(path, owner)).rejects.toThrow();
  expect(execFile).not.toHaveBeenCalled();
});

it.each([0o600, 0o640, 0o650, 0o664])('uses the injectable ACL check only with group access for mode %s', async mode => {
  nodes.get(path)!.mode = mode;
  const acl = vi.fn(async () => true);
  await expect(trustedOwnerExecutable(path, owner, async () => true, acl)).resolves.toBe(path);
  expect(acl).toHaveBeenCalledTimes(mode === 0o600 ? 0 : 1);
  expect(execFile).not.toHaveBeenCalled();
});

it.each([false, undefined])('fails closed when an injected ACL check returns %s', async answer => {
  const acl = vi.fn(async () => answer as boolean);
  await expect(trustedOwnerExecutable(path, owner, async () => true, acl)).rejects.toThrow();
  expect(acl).toHaveBeenCalledExactlyOnceWith(path);
});

it('fails closed when the injected ACL check throws', async () => {
  await expect(trustedOwnerExecutable(path, owner, async () => true, async () => { throw new Error('unavailable'); })).rejects.toThrow();
});

it.skipIf(process.platform !== 'linux')('the real ACL probe refuses every system ACL name and nothing else', async () => {
  const { execFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const classify = (names: string[]) => execFileSync('/usr/bin/python3', ['-I', '-c',
    `import os, sys\nnames = ${JSON.stringify(names)}\nos.listxattr = lambda path, follow_symlinks=True: names\nexec(sys.argv[2])`,
    '/nonexistent', ACL_PROBE_SCRIPT], { encoding: 'utf8' });
  for (const names of [['system.posix_acl_access'], ['system.nfs4_acl'], ['system.richacl'], ['user.note', 'system.posix_acl_default']]) {
    expect(classify(names)).toBe('acl\n');
  }
  for (const names of [[], ['user.note'], ['security.selinux'], ['trusted.acl-like']]) expect(classify(names)).toBe('no-acl\n');
});
