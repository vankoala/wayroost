import { execFile, execFileSync } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settingsTargetsSchema } from '../../shared/settings-targets.js';
import { READ_VIEWS } from '../../shared/settings-ops.js';
import { resolveHermesConfig, type HermesResolverCommand } from '../src/config-hermes.js';

// Pinned from Hermes' _HERMES_HOME_SUBDIRS source pattern. Fixtures initialize these
// before importing Hermes; the resolver may re-ensure them but cannot create them.
const HOME_SUBDIRS = ['cron', 'sessions', 'logs', 'logs/curator', 'memories', 'pairing', 'hooks', 'image_cache', 'audio_cache', 'skills'];
const LEGACY_SOUL = 'Example legacy soul template.';
const roots: string[] = [];
const python = await realpath('/usr/bin/python3');
const version = execFileSync(python, ['-I', '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' }).trim();
type Interpreter = { python: string; version: string };
async function optionalInterpreter(): Promise<Interpreter | undefined> {
  if (!process.env.HERMES_TEST_PYTHON) return undefined;
  try {
    const python = await realpath(process.env.HERMES_TEST_PYTHON);
    const version = execFileSync(python, ['-I', '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8', timeout: 3000 }).trim();
    const [major = 0, minor = 0] = version.split('.').map(Number);
    if (major > 3 || major === 3 && minor >= 13) return { python, version };
  } catch { /* An optional interpreter may not be installed on this machine. */ }
  return undefined;
}
const newerInterpreter = await optionalInterpreter();
const allowFixturePaths = async (path: string) => path;
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(includeSystemSitePackages = false, interpreter: Interpreter = { python, version }) {
  const { python, version } = interpreter;
  const root = await mkdtemp(join(tmpdir(), 'hermes-venv-example-')); roots.push(root);
  const home = join(root, 'home');
  await mkdir(home, { mode: 0o700 });
  for (const subdir of HOME_SUBDIRS) await mkdir(join(home, subdir), { recursive: true, mode: 0o700 });
  await writeFile(join(home, 'SOUL.md'), 'Example initialized soul.\n', { mode: 0o600 });
  const path = join(home, 'config.yaml'); await writeFile(path, 'agent: {reasoning_effort: high}\n', { mode: 0o600 });
  const modulePath = join(root, 'source');
  const venv = join(root, 'environments', 'example-hash', 'venv');
  const sitePackages = join(venv, 'lib', `python${version}`, 'site-packages');
  await mkdir(join(modulePath, 'hermes_cli'), { recursive: true });
  await mkdir(join(sitePackages, 'dependencies'), { recursive: true });
  const cfg = join(venv, 'pyvenv.cfg');
  const cfgText = `home = ${dirname(python)}\nimplementation = CPython\nversion_info = ${version}.0\ninclude-system-site-packages = ${includeSystemSitePackages}\n`;
  await writeFile(cfg, cfgText, { mode: 0o600 });
  await writeFile(join(sitePackages, 'dependencies', 'example_dependency.py'), 'EFFORT = "high"\n');
  await writeFile(join(sitePackages, 'example_pth.py'), 'ready = False\n');
  await writeFile(join(sitePackages, 'example.pth'), 'dependencies\nimport example_pth; example_pth.ready = True\n');
  await writeFile(join(modulePath, 'pm.py'), 'raise RuntimeError("dependency activation must not run")\n');
  await writeFile(join(modulePath, 'hermes_cli', '__init__.py'), '');
  await writeFile(join(modulePath, 'hermes_cli', 'config_backups.py'), 'def backup_config(*args, **kwargs):\n    raise RuntimeError("backup must not run")\n');
  await writeFile(join(modulePath, 'hermes_cli', 'env_loader.py'), 'def load_hermes_dotenv(**kwargs):\n    pass\n');
  const configFile = join(modulePath, 'hermes_cli', 'config.py');
  await writeFile(configFile, `
import os, sys
from pathlib import Path
site_paths = [entry for entry in sys.path if Path(entry).name in {"site-packages", "dist-packages"}]
assert site_paths[0] == ${JSON.stringify(sitePackages)}
${includeSystemSitePackages ? '' : 'assert len(site_paths) == 1'}
import example_dependency, example_pth
assert example_pth.ready
class FailedConfigRead(dict):
    pass
def get_config_path():
    return Path(os.environ["HERMES_HOME"]) / "config.yaml"
def _cached_read(parse, directory):
    return parse(directory, parents=True, exist_ok=True) or {}
def _secure_dir(directory):
    # Also exercise a mkdir observed as a reader callback: its caught EEXIST
    # must not poison the successful read.
    _cached_read(Path.mkdir, directory)
    directory.chmod(int(os.environ.get("HERMES_HOME_MODE", "700"), 8))
def ensure_hermes_home():
    home = get_config_path().parent
    _secure_dir(home)
    for subdir in ${JSON.stringify(HOME_SUBDIRS)}:
        _secure_dir(home / subdir)
    soul = home / "SOUL.md"
    if not soul.exists() or soul.read_text() == ${JSON.stringify(LEGACY_SOUL)}:
        soul.write_text("Example default soul.")
def load_config():
    ensure_hermes_home()
    return {"agent": {"reasoning_effort": example_dependency.EFFORT}}
load_config()
`);
  const site = settingsTargetsSchema.parse({ version: 1, targets: { 'hermes-config': {
    path, runAs: { user: 'example', uid: process.getuid!() || 1234 }, format: 'yaml',
    backupDir: join(root, 'backups'), auditDir: join(root, 'audit'),
    lock: { kind: 'file', path: join(root, 'settings.lock') }, resolver: { python, modulePath, venv },
  } } });
  return { root, home, modulePath, venv, sitePackages, cfg, cfgText, configFile, site };
}

async function snapshot(root: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    const info = await lstat(path);
    entries.push([name, info.mode, info.mtimeMs, info.isDirectory() ? await snapshot(path) : await readFile(path, 'utf8')]);
  }
  return entries;
}

function withSetup(setup: string, verify = ''): HermesResolverCommand {
  return (python, args, hermesHome, environment, startupHome) => new Promise((resolve, reject) => {
    execFile(python, ['-c', setup + args[1] + verify, ...args.slice(2)], {
      timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, cwd: '/',
      env: { ...environment, PATH: '/usr/bin:/bin', HERMES_HOME: hermesHome, HOME: startupHome ?? hermesHome, PYTHONDONTWRITEBYTECODE: '1', LANG: 'C.UTF-8' },
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

it('imports a dependency only through the configured venv, processes .pth code and leaves the initialized fixture unchanged', async () => {
  const f = await fixture();
  for (const subdir of ['', ...HOME_SUBDIRS]) expect((await lstat(join(f.home, subdir))).mode & 0o777).toBe(0o700);
  expect(await readFile(join(f.home, 'SOUL.md'), 'utf8')).not.toBe(LEGACY_SOUL);
  const before = await snapshot(f.root);
  delete f.site.targets['hermes-config']!.resolver!.venv;
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], undefined, allowFixturePaths)).rejects.toMatchObject({ code: 'unavailable' });
  f.site.targets['hermes-config']!.resolver!.venv = f.venv;
  const trust = vi.fn(allowFixturePaths);
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], undefined, trust)).resolves.toEqual({ agent: { reasoning_effort: 'high' } });
  expect(trust.mock.calls.map(([path]) => path)).toEqual([python, f.configFile, f.cfg, f.sitePackages]);
  expect(await snapshot(f.root)).toEqual(before);
});

it('allows Hermes to import pm definitions without activating dependencies', async () => {
  const f = await fixture();
  await rm(join(f.modulePath, 'pm.py'));
  await mkdir(join(f.modulePath, 'pm'));
  await writeFile(join(f.modulePath, 'pm', '__init__.py'), '');
  await writeFile(join(f.modulePath, 'pm', 'environments.py'), 'def activate_dependencies():\n    raise RuntimeError("dependency activation must not run")\n');
  await writeFile(join(f.modulePath, 'pm', 'paths.py'), 'EXAMPLE_PATH = "/home/me/example"\n');
  await writeFile(join(f.modulePath, 'pm', 'extras.py'), 'EXAMPLE_EXTRA = "example"\n');
  await writeFile(f.configFile, 'from pm.environments import activate_dependencies\nfrom pm.paths import EXAMPLE_PATH\nfrom pm.extras import EXAMPLE_EXTRA\n' + await readFile(f.configFile, 'utf8'));
  const before = await snapshot(f.root);
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], undefined, allowFixturePaths)).resolves.toEqual({ agent: { reasoning_effort: 'high' } });
  expect(await snapshot(f.root)).toEqual(before);
});

it('keeps resolving an existing previous environment until re-pointed or removed', async () => {
  const f = await fixture();
  const nextVenv = join(f.root, 'environments', 'next-example-hash', 'venv');
  await cp(f.venv, nextVenv, { recursive: true });
  await writeFile(join(nextVenv, 'lib', `python${version}`, 'site-packages', 'dependencies', 'example_dependency.py'), 'EFFORT = "low"\n');
  await writeFile(f.configFile, (await readFile(f.configFile, 'utf8')).replace(JSON.stringify(f.sitePackages), 'sys.argv[7]'));
  const before = await snapshot(f.root);
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], undefined, allowFixturePaths)).resolves.toEqual({ agent: { reasoning_effort: 'high' } });
  f.site.targets['hermes-config']!.resolver!.venv = nextVenv;
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], undefined, allowFixturePaths)).resolves.toEqual({ agent: { reasoning_effort: 'low' } });
  expect(await snapshot(f.root)).toEqual(before);
  f.site.targets['hermes-config']!.resolver!.venv = f.venv;
  await rm(f.venv, { recursive: true });
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], undefined, allowFixturePaths)).rejects.toMatchObject({ code: 'unavailable' });
});

it.each([false, true])('gives venv dependencies precedence with include-system-site-packages=%s', async includeSystemSitePackages => {
  const f = await fixture(includeSystemSitePackages);
  const interpreterPackages = [join(f.root, 'interpreter', 'site-packages'), join(f.root, 'interpreter', 'dist-packages')];
  for (const directory of interpreterPackages) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'example_dependency.py'), 'EFFORT = "low"\n');
  }
  const run = withSetup(`
import sys
from pathlib import Path
sys.path[:0] = ${JSON.stringify(interpreterPackages)}
example_system_paths = [entry for entry in sys.path if Path(entry).name in {"site-packages", "dist-packages"}]
`, `
assert sys.path[0:2] == [sys.argv[1], sys.argv[7]]
assert [entry for entry in sys.path if Path(entry).name in {"site-packages", "dist-packages"}] == [sys.argv[7]${includeSystemSitePackages ? ', *example_system_paths' : ''}]
`);
  const before = await snapshot(f.root);
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], run, allowFixturePaths)).resolves.toEqual({ agent: { reasoning_effort: 'high' } });
  expect(await snapshot(f.root)).toEqual(before);
});

const invalidMetadataCharacters = ['\0', '\t', '\r', '\x0b', '\x0c', '\x1c', '\x1d', '\x1e', '\x1f', '\x85', '\u200b', '\u200e', '\u2066', '\ufeff'];
it.each(invalidMetadataCharacters.map(character => ({ character, code: character.codePointAt(0)!.toString(16) })))
('rejects control or format character U+$code in both metadata readers', async ({ character }) => {
  const f = await fixture();
  const invalidText = `${f.cfgText}# example${character}comment\n`;
  await writeFile(f.cfg, invalidText);
  const neverRun = vi.fn(async () => '{"ok":true,"document":{}}');
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], neverRun, allowFixturePaths)).rejects.toMatchObject({ code: 'unavailable' });
  expect(neverRun).not.toHaveBeenCalled();
  await writeFile(f.cfg, f.cfgText);
  const run: HermesResolverCommand = async (...args) => {
    await writeFile(f.cfg, invalidText);
    return withSetup('')(...args);
  };
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], run, allowFixturePaths)).rejects.toMatchObject({ code: 'unavailable' });
});

it('rejects a leading BOM instead of silently dropping it during the metadata preflight', async () => {
  const f = await fixture();
  await writeFile(f.cfg, `\ufeff${f.cfgText}`);
  const run = vi.fn(async () => '{"ok":true,"document":{}}');
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], run, allowFixturePaths)).rejects.toMatchObject({ code: 'unavailable' });
  expect(run).not.toHaveBeenCalled();
});

it('refuses to import a site-packages directory different from the one walked by Node', async () => {
  const f = await fixture();
  const walked = join(f.venv, 'lib', 'python99.1', 'site-packages');
  await mkdir(walked, { recursive: true, mode: 0o700 });
  await chmod(f.sitePackages, 0o777);
  await writeFile(f.cfg, f.cfgText.replace(`${version}.0`, '99.1.0'));
  const trust = vi.fn(async (path: string) => {
    if (path === f.sitePackages) throw new Error('untrusted dependency directory');
    return path;
  });
  const run = vi.fn<HermesResolverCommand>(async (...args) => {
    await writeFile(f.cfg, f.cfgText);
    return withSetup('')(...args);
  });
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], run, trust)).rejects.toMatchObject({ code: 'unavailable' });
  expect(trust).toHaveBeenCalledWith(walked);
  expect(trust).not.toHaveBeenCalledWith(f.sitePackages);
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]![1].at(-1)).toBe(walked);
});

it.each(['home', 'version', 'missing config', 'linked config', 'linked site-packages', 'oversized config', 'duplicate version', 'malformed version'] as const)
('fails closed for a venv with %s', async problem => {
  const f = await fixture();
  if (problem === 'home') await writeFile(f.cfg, f.cfgText.replace(dirname(python), '/opt/example/other/bin'));
  if (problem === 'version') {
    const otherVersion = '99.1';
    await mkdir(join(f.venv, 'lib', `python${otherVersion}`, 'site-packages'), { recursive: true });
    await writeFile(f.cfg, f.cfgText.replace(`${version}.0`, `${otherVersion}.0`));
  }
  if (problem === 'missing config') await rm(f.cfg);
  if (problem === 'linked config') {
    const other = join(f.root, 'other.cfg'); await writeFile(other, f.cfgText);
    await rm(f.cfg); await symlink(other, f.cfg);
  }
  if (problem === 'linked site-packages') {
    const other = join(f.root, 'other-packages'); await mkdir(other);
    await rm(f.sitePackages, { recursive: true }); await symlink(other, f.sitePackages);
  }
  if (problem === 'oversized config') await writeFile(f.cfg, f.cfgText + '#'.repeat(16_385));
  if (problem === 'duplicate version') await writeFile(f.cfg, f.cfgText + `version_info = ${version}.0\n`);
  if (problem === 'malformed version') await writeFile(f.cfg, f.cfgText.replace(`${version}.0`, 'unknown'));
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], undefined, allowFixturePaths)).rejects.toMatchObject({ code: 'unavailable' });
});

it.each(HOME_SUBDIRS)('refuses to initialize a missing Hermes home directory: %s', async subdir => {
  const f = await fixture();
  await rm(join(f.home, subdir), { recursive: true });
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], undefined, allowFixturePaths)).rejects.toMatchObject({ code: 'unavailable' });
  await expect(lstat(join(f.home, subdir))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['', ...HOME_SUBDIRS])('refuses to change an uninitialized home directory mode: %s', async subdir => {
  const f = await fixture();
  await chmod(join(f.home, subdir), 0o775);
  const before = await snapshot(f.root);
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], undefined, allowFixturePaths)).rejects.toMatchObject({ code: 'unavailable' });
  expect(await snapshot(f.root)).toEqual(before);
});

it.each(['missing', 'legacy template'])('refuses to initialize a %s SOUL.md', async problem => {
  const f = await fixture();
  const soul = join(f.home, 'SOUL.md');
  if (problem === 'missing') await rm(soul);
  else await writeFile(soul, LEGACY_SOUL);
  const before = await snapshot(f.root);
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], undefined, allowFixturePaths)).rejects.toMatchObject({ code: 'unavailable' });
  expect(await snapshot(f.root)).toEqual(before);
});

it('tolerates an initialized home at the configured HERMES_HOME_MODE', async () => {
  const f = await fixture();
  for (const subdir of ['', ...HOME_SUBDIRS]) await chmod(join(f.home, subdir), 0o750);
  f.site.targets['hermes-config']!.resolver!.environment = { HERMES_HOME_MODE: '750' };
  const before = await snapshot(f.root);
  await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], undefined, allowFixturePaths)).resolves.toEqual({ agent: { reasoning_effort: 'high' } });
  expect(await snapshot(f.root)).toEqual(before);
});

describe.each([
  { name: `Python ${version}`, interpreter: { python, version }, skip: false },
  { name: newerInterpreter ? `Python ${newerInterpreter.version}` : 'Python >=3.13 (skipped: set HERMES_TEST_PYTHON to an available Python >=3.13 interpreter)',
    interpreter: newerInterpreter ?? { python, version }, skip: !newerInterpreter },
])('$name .pth guard', ({ interpreter, skip }) => {
  const test = it.skipIf(skip);

  test('uses the bounded site reader during addsitedir and restores it without changing import readers', async () => {
    const f = await fixture(false, interpreter);
    const run = withSetup(`
import _io, io, site
original_site_io = site.io
original_site_open_code = site.io.open_code
original_io_open_code = io.open_code
original_import_open_code = _io.open_code
original_addsitedir = site.addsitedir
def guarded_addsitedir(directory):
    assert site.io is not original_site_io
    assert site.io.open_code is not original_site_open_code
    assert site.io.open_code is SiteIO.open_code
    assert site.io.StringIO is original_site_io.StringIO
    assert io.open_code is original_io_open_code
    assert _io.open_code is original_import_open_code
    return original_addsitedir(directory)
site.addsitedir = guarded_addsitedir
    `, `
assert site.io is original_site_io
assert site.io.open_code is original_site_open_code
assert io.open_code is original_io_open_code
assert _io.open_code is original_import_open_code
    `);
    const before = await snapshot(f.root);
    await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], run, allowFixturePaths)).resolves.toEqual({ agent: { reasoning_effort: 'high' } });
    expect(await snapshot(f.root)).toEqual(before);
  });

  test.each(['flock', 'lockf'] as const)('refuses a swallowed fcntl.%s attempt through a read-only file descriptor', async operation => {
    const f = await fixture(false, interpreter);
    await writeFile(join(f.sitePackages, 'example_lock.py'), `
import fcntl, os
fd = os.open(os.path.join(os.environ["HERMES_HOME"], "config.yaml"), os.O_RDONLY)
try:
    try:
        fcntl.${operation}(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
    except PermissionError:
        pass
finally:
    os.close(fd)
    `);
    await writeFile(join(f.sitePackages, 'extra.pth'), 'import example_lock\n');
    const before = await snapshot(f.root);
    await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], undefined, allowFixturePaths)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await snapshot(f.root)).toEqual(before);
  });

  test.each(['raise ValueError("example broken pth")', 'open("example-write", "w").write("denied")'])
  ('fails closed for swallowed .pth failures: %s', async operation => {
    const f = await fixture(false, interpreter);
    await writeFile(join(f.sitePackages, 'broken.pth'), `import os; ${operation}\n`);
    const before = await snapshot(f.root);
    await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], undefined, allowFixturePaths)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await snapshot(f.root)).toEqual(before);
  });

  test.each(['symlink', 'directory', 'oversized file'] as const)('refuses a .pth %s', async problem => {
    const f = await fixture(false, interpreter);
    const path = join(f.sitePackages, 'extra.pth');
    if (problem === 'symlink') {
      const other = join(f.root, 'other.pth'); await writeFile(other, '# example dependency path\n');
      await symlink(other, path);
    }
    if (problem === 'directory') await mkdir(path);
    if (problem === 'oversized file') await writeFile(path, '#' + 'x'.repeat(1024 * 1024));
    await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], undefined, allowFixturePaths)).rejects.toMatchObject({ code: 'unavailable' });
  });

  test.each(['permission', 'missing', 'open I/O', 'stat I/O', 'stream I/O', 'vanished before open'] as const)
  ('fails closed when site swallows a .pth %s error', async problem => {
    const f = await fixture(false, interpreter);
    await writeFile(join(f.sitePackages, 'extra.pth'), '# example dependency path\n');
    const run = withSetup(`
import io, os, site, sys
fault_path = os.path.join(sys.argv[5], "lib", "python%d.%d" % sys.version_info[:2], "site-packages", "extra.pth")
original_open, original_fdopen = os.open, os.fdopen
original_addsitedir = site.addsitedir
original_lstat, original_fstat = os.lstat, os.fstat
fault_fd = None
class FailedRead(io.BufferedReader):
    def read(self, *args, **kwargs):
        raise OSError(5, "example stream failure")
    read1 = read
def fail_open():
    raise ${problem === 'permission' ? 'PermissionError(13, "example unreadable file")' : problem === 'missing' ? 'FileNotFoundError(2, "example vanished file")' : 'OSError(5, "example open failure")'}
def injected_open(path, *args, **kwargs):
    global fault_fd
    # Python 3.10's site.addpackage never calls lstat, so the vanished file
    # must also surface where the guard opens it.
    if os.fsdecode(path) == fault_path and ${problem === 'vanished before open' ? 'True' : 'False'}:
        raise FileNotFoundError(2, "example vanished file")
    fd = original_open(path, *args, **kwargs)
    if os.fsdecode(path) == fault_path:
        fault_fd = fd
    return fd
def injected_fdopen(fd, *args, **kwargs):
    stream = original_fdopen(fd, *args, **kwargs)
    return FailedRead(stream) if fd == fault_fd and ${problem === 'stream I/O' ? 'True' : 'False'} else stream
def injected_addsitedir(directory):
    original_open_code = site.io.open_code
    def injected_open_code(path):
        if os.fsdecode(path) == fault_path and ${['permission', 'missing', 'open I/O'].includes(problem) ? 'True' : 'False'}:
            fail_open()
        return original_open_code(path)
    site.io.open_code = injected_open_code
    try:
        return original_addsitedir(directory)
    finally:
        site.io.open_code = original_open_code
def injected_lstat(path, *args, **kwargs):
    if os.fsdecode(path) == fault_path and ${problem === 'vanished before open' ? 'True' : 'False'}:
        raise FileNotFoundError(2, "example vanished file")
    return original_lstat(path, *args, **kwargs)
def injected_fstat(fd):
    if fd == fault_fd and ${problem === 'stat I/O' ? 'True' : 'False'}:
        raise OSError(5, "example metadata failure")
    return original_fstat(fd)
os.open, os.fdopen = injected_open, injected_fdopen
site.addsitedir = injected_addsitedir
os.lstat, os.fstat = injected_lstat, injected_fstat
    `);
    const before = await snapshot(f.root);
    await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], run, allowFixturePaths)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await snapshot(f.root)).toEqual(before);
  });

  test('accepts a .pth file at the read limit', async () => {
    const f = await fixture(false, interpreter);
    await writeFile(join(f.sitePackages, 'extra.pth'), '#'.padEnd(1024 * 1024, 'x'));
    await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], undefined, allowFixturePaths)).resolves.toEqual({ agent: { reasoning_effort: 'high' } });
  });

  test('refuses a .pth file that exceeds the limit after stat', async () => {
    const f = await fixture(false, interpreter);
    await writeFile(join(f.sitePackages, 'extra.pth'), '#'.padEnd(2 * 1024 * 1024, 'x'));
    const run = withSetup(`
import os, types
original_fstat = os.fstat
def stale_fstat(fd):
    info = original_fstat(fd)
    return types.SimpleNamespace(st_mode=info.st_mode, st_size=0)
os.fstat = stale_fstat
    `);
    await expect(resolveHermesConfig(f.site, READ_VIEWS['hermes.agents'], run, allowFixturePaths)).rejects.toMatchObject({ code: 'unavailable' });
  });
});
