import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostPaths } from '../server/test/host-path-fixture.js';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const runtimeFiles = ['signalbox-bridge.mjs', 'signalbox-claude-hook.py', 'signalbox-helper.py', 'signalbox_mail_trigger.py', 'signalbox_skills.py', 'wayroost_runtime.py'];
type Installer = 'runtime' | 'helper' | 'server';
const scripts: Record<Installer, string> = { runtime: 'install-wayroost-runtime.sh', helper: 'setup-wayroost-helper.sh', server: 'install-wayroost-server.sh' };

function fixture() {
  mkdirSync('.tmp', { recursive: true });
  const folder = mkdtempSync(join(process.cwd(), '.tmp/primary-install-'));
  folders.push(folder);
  const root = join(folder, 'root');
  const binaries = join(folder, 'bin');
  const calls = join(folder, 'calls');
  mkdirSync(root);
  mkdirSync(binaries);
  writeFileSync(calls, '');
  writeFileSync(join(binaries, 'systemctl'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$TEST_CALLS"
[[ "$1" == --root ]] || exit 91
fake_root="$2"; shift 2
case "$1" in
  is-enabled)
    if [[ -L "$fake_root/etc/systemd/system/multi-user.target.wants/$2" ]]; then echo enabled; exit 0; fi
    for unit_directory in /etc/systemd/system /run/systemd/system /usr/local/lib/systemd/system /usr/lib/systemd/system; do
      if [[ -f "$fake_root$unit_directory/$2" ]]; then echo disabled; exit 1; fi
    done
    printf 'Failed to get unit file state for %s: No such file or directory\\n' "$2" >&2; exit 1 ;;
  enable|disable) exit 92 ;;
  daemon-reload) [[ "$FAIL_RELOAD" != 1 ]] ;;
  start|restart) : ;;
  *) exit 92 ;;
esac
`, { mode: 0o755 });
  for (const command of ['npm', 'npx', 'pnpm', 'yarn', 'systemd-run']) {
    writeFileSync(join(binaries, command), `#!/usr/bin/env bash
set -euo pipefail
printf '${command}\\n' >> "$TEST_CALLS"
exit 93
`, { mode: 0o755 });
  }
  const prepared = (kind: 'runtime' | 'server') => {
    const directory = join(folder, kind);
    const contents: Record<string, string> = kind === 'runtime'
      ? Object.fromEntries(runtimeFiles.map(name => [`bin/${name}`, `# prepared ${name}\n`]))
      : { 'dist/server/index.js': 'export {};\n', 'dist/web/index.html': '<!doctype html>\n',
        'package.json': '{"type":"module","dependencies":{"fake-dependency":"1.0.0"}}\n',
        'node_modules/fake-dependency/index.js': 'export {};\n' };
    for (const [name, data] of Object.entries(contents)) {
      const file = join(directory, name);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, data);
    }
    const manifest = Object.entries(contents).sort(([a], [b]) => a.localeCompare(b)).map(([name, data]) => `${hash(data)}  ${name}\n`).join('');
    writeFileSync(join(directory, 'SHA256SUMS'), manifest);
    return ['--from', directory, '--manifest-sha256', hash(manifest)];
  };
  const runtime = prepared('runtime');
  const server = prepared('server');
  const sourceConfig = join(folder, 'primary.json');
  writeFileSync(sourceConfig, `{"role":"primary","stateDir":"${hostPaths.primaryState}","helper":{"enabled":true},"publicOrigin":"https://example.com"}\n`);
  const defaults: Record<Installer, string[]> = {
    runtime: [...runtime, '--role', 'primary'],
    helper: ['--owner', 'demo-owner', '--home', '/home/me'],
    server: [...server, '--primary'],
  };
  const argumentsFor = (kind: Installer, mode: string, options: string[] = []) => [
    `deploy/${scripts[kind]}`, '--mode', mode, '--root', root, '--receipts', '/var/lib/wayroost-install/receipts', '--receipt', kind,
    ...(mode === 'verify' || mode === 'reverse' ? [] : defaults[kind]), ...options,
  ];
  const environmentFor = (environment: Record<string, string> = {}) => ({ ...process.env, PATH: `${binaries}:${process.env.PATH}`, TEST_CALLS: calls, FAIL_RELOAD: '0', ...environment });
  const invoke = (kind: Installer, mode: string, options: string[] = [], environment: Record<string, string> = {}) => spawnSync('bash', argumentsFor(kind, mode, options), { encoding: 'utf8', env: environmentFor(environment) });
  const receipt = (kind: Installer) => join(root, `var/lib/wayroost-install/receipts/${kind}.json`);
  const target = (kind: Installer) => join(root, kind === 'helper' ? 'etc/systemd/system/wayroost-helper.service'
    : kind === 'runtime' ? 'opt/wayroost/runtime/bin/signalbox-helper.py' : 'opt/wayroost/server/dist/server/index.js');
  const success = (kind: Installer, mode: string, options: string[] = []) => {
    const result = invoke(kind, mode, options);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return result.stdout;
  };
  return { folder, root, binaries, calls, runtime, server, defaults, sourceConfig, invoke, receipt, target, success, argumentsFor, environmentFor };
}

function pythonShim(f: ReturnType<typeof fixture>, changes: Array<[string, string]>, setup = '') {
  writeFileSync(join(f.binaries, 'python3'), `#!/usr/bin/python3
import os, sys, time
from pathlib import Path
sys.argv = sys.argv[1:]
script = sys.stdin.read()
${setup}
${changes.map(([before, after]) => `script = script.replace(${JSON.stringify(before)}, ${JSON.stringify(after)})`).join('\n')}
exec(compile(script, '<stdin>', 'exec'))
`, { mode: 0o755 });
}

function pythonFunctions(code: string, args: string[] = []) {
  const source = readFileSync('deploy/wayroost-lib.sh', 'utf8').split("<<'PY'\n")[1]!.split('\ntry:\n')[0]!;
  return spawnSync('/usr/bin/python3', ['-c', source + '\n' + code, ...args], { encoding: 'utf8' });
}

async function waitForFile(path: string) {
  for (let count = 0; count < 500; count++) {
    if (existsSync(path)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('The subprocess did not reach its publication boundary.');
}

describe('receipted publication', () => {
  it('rejects every C0 control and DEL before forming a path identity', () => {
    const result = pythonFunctions(`
for code in [*range(32), 127]:
    try:
        absolute('/srv/demo' + chr(code) + 'runtime')
    except DeploymentError:
        continue
    raise AssertionError('A control character was accepted.')
`);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each((['runtime', 'helper', 'server'] as const).flatMap(kind =>
    ['\v', '\x1b', '\x7f'].map(character => ({ kind, character }))))
  ('refuses control characters in $kind paths: $character', ({ kind, character }) => {
    const f = fixture();
    const result = f.invoke(kind, 'forward', ['--prefix', `/srv/demo${character}runtime`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Paths must be absolute, without parent traversal or control characters.');
    expect(result.stdout).toBe('');
    expect(existsSync(f.receipt(kind))).toBe(false);
    expect(readFileSync(f.calls, 'utf8')).toBe('');
  });

  it.each<Installer>(['runtime', 'helper', 'server'])('ignores unrelated %s paths during receipt-only operations', kind => {
    const f = fixture();
    mkdirSync(join(f.root, 'etc'));
    f.success(kind, 'forward', ['--prefix', '/srv/runtime']);
    const outside = join(f.folder, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(f.root, 'opt'));
    symlinkSync(outside, join(f.root, 'home'));
    mkdirSync(join(f.root, 'etc'), { recursive: true });
    symlinkSync(outside, join(f.root, 'etc/wayroost'));
    const ignored = ['--prefix', '/opt/input', ...(kind === 'helper'
      ? ['--home', '/home/me', '--hermes-home', '/home/me/.hermes', '--token-file', `${hostPaths.config}/helper.token`,
        '--drop-ins', join(f.root, 'opt/input'), '--writable-path', '/home/me/.agents/skills']
      : ['--from', join(f.root, 'opt/input'), ...(kind === 'server'
        ? ['--publish-config', '--config-source', join(f.root, 'opt/input'), '--config-path', `${hostPaths.config}/config.json`] : [])]),
      ...(kind === 'runtime' ? [] : ['--unit-dir', '/opt/units'])];
    f.success(kind, 'verify');
    f.success(kind, 'verify', ignored);
    f.success(kind, 'reverse', ignored);
    f.success(kind, 'verify', ignored);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(f.root, 'srv'))).toBe(false);
  });

  it('keeps independent publications reversible when a second receipt store uses the first undo directory', () => {
    const f = fixture();
    f.success('runtime', 'forward');
    const flags = ['--prefix', '/srv/server', '--receipts', '/var/lib/wayroost-install/receipts-undo'];
    f.success('server', 'forward', flags);
    f.success('runtime', 'verify');
    f.success('runtime', 'reverse');
    f.success('server', 'verify', flags);
    f.success('server', 'reverse', flags);
    expect(existsSync(join(f.root, 'opt'))).toBe(false);
    expect(existsSync(join(f.root, 'srv'))).toBe(false);
  });

  it('requires a later overlapping publication to be reversed before the earlier receipt', () => {
    const f = fixture();
    f.success('runtime', 'forward');
    const source = f.runtime[1]!;
    writeFileSync(join(source, 'bin/signalbox-helper.py'), '# changed runtime\n');
    const manifest = runtimeFiles.map(name => `${hash(readFileSync(join(source, 'bin', name)))}  bin/${name}\n`).join('');
    writeFileSync(join(source, 'SHA256SUMS'), manifest);
    const store = ['--receipts', '/var/lib/wayroost-install/receipts-undo', '--receipt', 'second'];
    f.success('runtime', 'forward', [...store, '--manifest-sha256', hash(manifest)]);
    const refused = f.invoke('runtime', 'reverse');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('Current path does not match the receipt; refusing changes.');
    expect(readFileSync(f.target('runtime'), 'utf8')).toBe('# changed runtime\n');
    f.success('runtime', 'reverse', store);
    f.success('runtime', 'verify');
    f.success('runtime', 'reverse');
    expect(existsSync(join(f.root, 'opt'))).toBe(false);
  });

  it('canonicalizes a double-slash server prefix before recording fresh directories and config', () => {
    const f = fixture();
    const flags = ['--prefix', '//opt//wayroost/./server/', '--publish-config', '--config-source', f.sourceConfig,
      '--config-path', '/opt/wayroost/server/primary.json'];
    f.success('server', 'forward', flags);
    const receipt = JSON.parse(readFileSync(f.receipt('server'), 'utf8'));
    f.success('server', 'forward', flags);
    f.success('server', 'verify');
    f.success('server', 'reverse');
    expect(receipt.intent.prefix).toBe(join(f.root, 'opt/wayroost/server'));
    const paths = receipt.paths.map((entry: { path: string }) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.every((path: string) => !path.startsWith('//') && !path.includes('/./'))).toBe(true);
    expect(existsSync(join(f.root, 'opt'))).toBe(false);
  });

  it('reverses earlier receipts with aliased directory identities without removing unrelated files', () => {
    const f = fixture();
    f.success('server', 'forward', ['--publish-config', '--config-source', f.sourceConfig,
      '--config-path', '/opt/wayroost/server/primary.json']);
    const receipt = JSON.parse(readFileSync(f.receipt('server'), 'utf8'));
    receipt.root = '/' + receipt.root;
    receipt.intent.prefix = '/' + receipt.intent.prefix;
    const directories = [];
    for (const entry of receipt.paths) {
      if (entry.new.kind !== 'directory') continue;
      directories.push({ ...entry, path: '/' + entry.path });
      entry.path = '/' + entry.path;
      if (entry.temporary) entry.temporary = '/' + entry.temporary;
    }
    receipt.paths = [...directories, ...receipt.paths];
    writeFileSync(f.receipt('server'), JSON.stringify(receipt));
    f.success('server', 'verify');
    const extra = join(f.root, 'opt/wayroost/server/extra');
    writeFileSync(extra, 'retained\n');
    const refused = f.invoke('server', 'reverse');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('Unreceipted files prevent reversal.');
    expect(readFileSync(extra, 'utf8')).toBe('retained\n');
    rmSync(extra);
    f.success('server', 'reverse');
    f.success('server', 'verify');
    expect(existsSync(join(f.root, 'opt'))).toBe(false);
    const reversed = JSON.parse(readFileSync(f.receipt('server'), 'utf8'));
    expect(reversed.root).toBe(f.root);
    expect(reversed.paths.every((entry: { path: string }) => !entry.path.startsWith('//'))).toBe(true);
    expect(new Set(reversed.paths.map((entry: { path: string }) => entry.path)).size).toBe(reversed.paths.length);
  });

  it.each(['verify', 'reverse'])('refuses a conflicting path alias in a receipt before %s mutation', mode => {
    const f = fixture();
    f.success('runtime', 'forward');
    const receipt = JSON.parse(readFileSync(f.receipt('runtime'), 'utf8'));
    const original = receipt.paths.find((entry: { path: string }) => entry.path === f.target('runtime'));
    receipt.paths.push({ ...original, path: '/' + original.path });
    writeFileSync(f.receipt('runtime'), JSON.stringify(receipt));
    const published = readFileSync(f.target('runtime'));
    const journal = readFileSync(f.receipt('runtime'));
    const result = f.invoke('runtime', mode);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Receipt contains conflicting path identities.');
    expect(readFileSync(f.target('runtime'))).toEqual(published);
    expect(readFileSync(f.receipt('runtime'))).toEqual(journal);
  });

  it.each<Installer>(['runtime', 'helper', 'server'])('uses the recorded %s prefix with a receipt store beneath the default prefix', kind => {
    const f = fixture();
    const store = kind === 'server' ? '/opt/wayroost/server/receipts' : '/opt/wayroost/runtime/receipts';
    const flags = ['--prefix', '/srv/runtime', '--receipts', store];
    f.success(kind, 'forward', flags);
    f.success(kind, 'forward', flags);
    f.success(kind, 'verify', ['--receipts', store]);
    f.success(kind, 'verify', ['--receipts', store, '--prefix', store]);
    f.success(kind, 'reverse', ['--receipts', store, '--prefix', store]);
    f.success(kind, 'verify', ['--receipts', store]);
    expect(existsSync(join(f.root, 'srv'))).toBe(false);
    expect(existsSync(join(f.root, store, `${kind}.json`))).toBe(true);
  });

  it.each(['runtime', 'helper', 'server'] as const)('normalizes %s path arguments and accepts equivalent spellings on retry', kind => {
    const f = fixture();
    const flags = ['--prefix', '//srv//./runtime/', '--receipts', '//var//lib/./wayroost-install/receipts/',
      ...(kind === 'helper' ? ['--home', '//home//./me/', '--hermes-home', '//home/me/./.hermes/', '--token-file', '//etc//wayroost/./helper.token/'] : []),
      ...(kind === 'server' ? ['--publish-unit', '--publish-config', '--config-source', f.sourceConfig,
        '--config-path', '//etc//wayroost/./config.json/'] : [])];
    f.success(kind, 'forward', flags);
    const receipt = JSON.parse(readFileSync(f.receipt(kind), 'utf8'));
    expect(receipt.intent.prefix).toBe(join(f.root, 'srv/runtime'));
    expect(receipt.paths.map((entry: { path: string }) => entry.path).every((path: string) => !path.startsWith('//'))).toBe(true);
    if (kind !== 'runtime') {
      const unit = readFileSync(join(f.root, `etc/systemd/system/wayroost-${kind}.service`), 'utf8');
      expect(unit).not.toContain('//');
      expect(unit).not.toContain('/./');
    }
    f.success(kind, 'forward', [...flags, '--prefix', '/srv/runtime']);
    f.success(kind, 'verify');
    f.success(kind, 'reverse');
  });

  it.each((['runtime', 'helper', 'server'] as const).flatMap(kind =>
    ['--prefix', '--receipts', ...(kind === 'helper' ? ['--home', '--hermes-home', '--token-file', '--writable-path', '--drop-ins']
      : ['--from', ...(kind === 'server' ? ['--config-path', '--config-source'] : [])])]
      .map(option => ({ kind, option }))))('refuses symlinked ancestors while parsing $kind $option', ({ kind, option }) => {
    const f = fixture();
    const host = ['--from', '--config-source', '--drop-ins'].includes(option);
    const directory = host ? f.folder : f.root;
    mkdirSync(join(directory, 'outside'));
    symlinkSync(join(directory, 'outside'), join(directory, 'linked'));
    const value = host ? join(directory, 'linked/input') : '//linked/./input/';
    for (const mode of option === '--receipts' ? ['plan', 'forward', 'verify', 'reverse'] : ['plan', 'forward']) {
      const result = f.invoke(kind, mode, [option, value]);
      expect(result.status, mode + result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('Refusing a symlink in a deployment path.');
      expect(result.stdout).toBe('');
    }
    expect(existsSync(f.target(kind))).toBe(false);
    expect(existsSync(f.receipt(kind))).toBe(false);
    expect(readFileSync(f.calls, 'utf8')).toBe('');
    expect(readdirSync(join(directory, 'outside'))).toEqual([]);
  });

  it.each<Installer>(['runtime', 'helper', 'server'])('verifies and reverses an existing %s receipt with a double-slash fake root', kind => {
    const f = fixture();
    const root = '/' + f.root;
    const options = ['--root', root];
    f.success(kind, 'forward', options);
    expect(JSON.parse(readFileSync(f.receipt(kind), 'utf8')).root).toBe(f.root);
    f.success(kind, 'verify', options);
    f.success(kind, 'reverse', options);
    f.success(kind, 'verify', options);
    expect(existsSync(f.target(kind))).toBe(false);
  });

  it.each((['runtime', 'helper', 'server'] as const).flatMap(kind =>
    ['plan', 'forward'].map(mode => ({ kind, mode }))))('rejects filesystem-root prefix aliases before any $kind $mode mutation', ({ kind, mode }) => {
    const f = fixture();
    pythonShim(f, [['def trusted_file(path):', 'def trusted_file(path):\n    return']], `
os.geteuid = lambda: 0
if os.environ.get('SIMULATE_PRODUCTION') == '1':
    index = sys.argv.index('--root')
    del sys.argv[index:index + 2]
def refuse_mkdir(*args, **kwargs):
    raise ValueError('Unexpected filesystem mutation.')
Path.mkdir = refuse_mkdir
`);
    for (const fakeRoot of [true, false]) {
      for (const prefix of ['/', '//', '///', '/.', '//.', '////.']) {
        const result = f.invoke(kind, mode, ['--prefix', prefix], { SIMULATE_PRODUCTION: fakeRoot ? '0' : '1' });
        expect(result.status, `${fakeRoot}: ${prefix}`).toBe(1);
        expect(result.stderr, `${fakeRoot}: ${prefix}`).toContain('The installation prefix must not be /.');
        expect(result.stdout).toBe('');
      }
    }
    expect(readdirSync(f.root)).toEqual([]);
    expect(readFileSync(f.calls, 'utf8')).toBe('');
  });

  it.each((['runtime', 'helper', 'server'] as const).flatMap(kind =>
    ['plan', 'forward', 'verify', 'reverse'].map(mode => ({ kind, mode }))))('rejects filesystem-root aliases before any $kind $mode mutation', ({ kind, mode }) => {
    const f = fixture();
    const linkedRoot = join(f.folder, 'filesystem-root');
    symlinkSync('/', linkedRoot);
    pythonShim(f, [], "def refuse_mkdir(*args, **kwargs):\n    raise ValueError('Unexpected filesystem mutation.')\nPath.mkdir = refuse_mkdir");
    for (const root of ['/', '//', '///', '/.', '//.', '////.', linkedRoot]) {
      const result = f.invoke(kind, mode, ['--root', root]);
      expect(result.status, root).toBe(1);
      expect(result.stderr, root).toContain('--root requires an existing fake-root directory, not /.');
      expect(result.stdout).toBe('');
    }
    expect(readdirSync(f.root)).toEqual([]);
    expect(readFileSync(f.calls, 'utf8')).toBe('');
  });

  it.each((['helper', 'server'] as const).flatMap(kind =>
    (kind === 'helper' ? ['--prefix', '--home', '--hermes-home', '--token-file'] : ['--prefix', '--config-path'])
      .flatMap(option => ['plan', 'forward'].flatMap(mode => ["demo'path", "demo'quoted'path"].map(name => ({ kind, option, mode, name }))))))('rejects apostrophes in $kind $option during $mode: $name', ({ kind, option, mode, name }) => {
    const f = fixture();
    const flags = kind === 'server' ? ['--publish-unit', '--publish-config', '--config-source', f.sourceConfig] : [];
    const result = f.invoke(kind, mode, [...flags, option, `/opt/wayroost/${name}`]);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('Unit paths cannot contain whitespace or systemd delimiters.');
    expect(result.stdout).toBe('');
    expect(existsSync(f.receipt(kind))).toBe(false);
    expect(existsSync(f.target(kind))).toBe(false);
    expect(existsSync(join(f.root, 'opt'))).toBe(false);
    expect(existsSync(join(f.root, 'etc'))).toBe(false);
    expect(readFileSync(f.calls, 'utf8')).toBe('');
  });

  it.each<Installer>(['runtime', 'helper', 'server'])('plans, publishes, verifies and reverses %s without implicit service actions', kind => {
    const f = fixture();
    const path = f.target(kind);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'original bytes\n', { mode: 0o640 });
    const owner = { uid: statSync(path).uid, gid: statSync(path).gid };
    const before = readFileSync(path);
    f.success(kind, 'plan');
    expect(readFileSync(path)).toEqual(before);
    f.success(kind, 'forward');
    f.success(kind, 'forward');
    f.success(kind, 'verify');
    const receipt = JSON.parse(readFileSync(f.receipt(kind), 'utf8'));
    expect(receipt.status).toBe('applied');
    expect(receipt.paths.find((entry: { path: string }) => entry.path === path)).toMatchObject({
      old: { hash: hash(before), mode: '0640', owner }, new: { hash: hash(readFileSync(path)), owner },
    });
    expect(statSync(f.receipt(kind)).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.receipt(kind), '..')).mode & 0o777).toBe(0o700);
    f.success(kind, 'reverse');
    f.success(kind, 'reverse');
    f.success(kind, 'verify');
    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readFileSync(f.calls, 'utf8')).not.toMatch(/\b(start|stop|restart|enable|disable|npm|npx|pnpm|yarn|systemd-run)\b/);
  });

  it.each<Installer>(['runtime', 'helper', 'server'])('removes only newly published %s files and rejects a hand edit before reverse', kind => {
    const f = fixture();
    f.success(kind, 'forward');
    const path = f.target(kind);
    const published = readFileSync(path);
    writeFileSync(path, 'hand edit\n');
    expect(f.invoke(kind, 'verify').status).toBe(1);
    expect(f.invoke(kind, 'reverse').status).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe('hand edit\n');
    writeFileSync(path, published);
    f.success(kind, 'reverse');
    expect(existsSync(path)).toBe(false);
  });

  it.each((['runtime', 'helper', 'server'] as const).flatMap(kind => [false, true].flatMap(restore =>
    ['bytes', 'mode'].map(edit => ({ kind, restore, edit })))))('refuses a $kind edit after reverse preflight: restore=$restore, edit=$edit', ({ kind, restore, edit }) => {
    const f = fixture();
    const path = f.target(kind);
    if (restore) {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, 'original bytes\n', { mode: 0o640 });
    }
    f.success(kind, 'forward');
    const published = readFileSync(path);
    const mutation = edit === 'bytes' ? ".write_text('concurrent edit\\n')" : '.chmod(0o600)';
    const boundary = "receipt['status'] = 'reversing'\n            save()";
    pythonShim(f, [[boundary, boundary + `\n            Path(${JSON.stringify(path)})${mutation}`]]);
    const result = f.invoke(kind, 'reverse');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Publication changed after preflight; refusing reversal.');
    expect(readFileSync(path)).toEqual(edit === 'bytes' ? Buffer.from('concurrent edit\n') : published);
    if (edit === 'mode') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(f.receipt(kind), 'utf8')).status).toBe('reversing');
  });

  it('refuses an enablement link changed after reverse preflight', () => {
    const f = fixture();
    f.success('helper', 'forward', ['--enable']);
    const path = join(f.root, 'etc/systemd/system/multi-user.target.wants/wayroost-helper.service');
    const boundary = "receipt['status'] = 'reversing'\n            save()";
    pythonShim(f, [[boundary, boundary + `\n            Path(${JSON.stringify(path)}).unlink()\n            os.symlink('../edited.service', ${JSON.stringify(path)})`]]);
    const result = f.invoke('helper', 'reverse', ['--enable']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Publication changed after preflight; refusing reversal.');
    expect(readlinkSync(path)).toBe('../edited.service');
    expect(existsSync(f.target('helper'))).toBe(true);
  });

  it.each<Installer>(['runtime', 'helper', 'server'])('rejects legacy %s destinations and escaping symlinks', kind => {
    const f = fixture();
    const option = kind === 'helper' ? '--unit-dir' : '--prefix';
    for (const path of ['/opt/signalbox', hostPaths.legacyConfig, '/opt/signalbox/bin', '/opt/signalbox-speech',
      `${hostPaths.privateState}/signalbox`, '/etc/systemd/system/signalbox-helper.service.d', 'relative', '/srv/../opt/signalbox']) {
      expect(f.invoke(kind, 'forward', [option, path]).status).toBe(1);
    }
    mkdirSync(join(f.root, 'opt'), { recursive: true });
    mkdirSync(join(f.folder, 'outside'));
    symlinkSync(join(f.folder, 'outside'), join(f.root, 'opt/escape'));
    expect(f.invoke(kind, 'forward', [option, '/opt/escape/new']).status).toBe(1);
    expect(readdirSync(join(f.folder, 'outside'))).toEqual([]);
    expect(readFileSync(f.calls, 'utf8')).toBe('');
  });

  it('requires an explicit runtime role and publishes every runtime file under bin', () => {
    const f = fixture();
    f.defaults.runtime = f.runtime;
    expect(f.invoke('runtime', 'forward').status).toBe(1);
    f.success('runtime', 'forward', ['--role', 'shadow']);
    for (const name of runtimeFiles) expect(existsSync(join(f.root, 'opt/wayroost/runtime/bin', name))).toBe(true);
    expect(JSON.parse(readFileSync(join(f.root, 'opt/wayroost/runtime/bin/wayroost-role.json'), 'utf8'))).toEqual({ role: 'shadow' });
    expect(readFileSync(f.calls, 'utf8')).toBe('');
    expect(f.invoke('runtime', 'forward', ['--start']).status).toBe(2);
  });

  it.each(['runtime', 'server'] as const)('checks every prepared %s hash and rejects missing or unsealed dependencies', kind => {
    const f = fixture();
    const source = join(f.folder, kind);
    const path = join(source, kind === 'runtime' ? 'bin/signalbox-helper.py' : 'node_modules/fake-dependency/index.js');
    const original = readFileSync(path);
    writeFileSync(path, 'changed');
    expect(f.invoke(kind, 'forward').status).toBe(1);
    writeFileSync(path, original);
    writeFileSync(join(source, 'unhashed'), 'extra');
    expect(f.invoke(kind, 'forward').status).toBe(1);
    rmSync(join(source, 'unhashed'));
    expect(f.invoke(kind, 'forward', ['--manifest-sha256', '0'.repeat(64)]).status).toBe(1);
    rmSync(path);
    expect(f.invoke(kind, 'forward').status).toBe(1);
    expect(existsSync(f.target(kind))).toBe(false);
    expect(readFileSync(f.calls, 'utf8')).toBe('');
  });

  it.each((['runtime', 'server'] as const).flatMap(kind => ['plan', 'forward'].map(mode => ({ kind, mode }))))
  ('refuses control characters in hashed $kind paths before $mode publication', ({ kind, mode }) => {
    const f = fixture();
    const source = join(f.folder, kind);
    const name = kind === 'runtime' ? 'bin/dependency\tmodule.py' : 'dist/server/dependency\tmodule.js';
    const data = 'prepared dependency\n';
    writeFileSync(join(source, name), data);
    const manifest = readFileSync(join(source, 'SHA256SUMS'), 'utf8') + `${hash(data)}  ${name}\n`;
    writeFileSync(join(source, 'SHA256SUMS'), manifest);
    const result = f.invoke(kind, mode, ['--manifest-sha256', hash(manifest)]);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('Paths must be absolute, without parent traversal or control characters.');
    expect(result.stdout).toBe('');
    expect(existsSync(f.receipt(kind))).toBe(false);
    expect(existsSync(join(f.root, 'opt'))).toBe(false);
    expect(readFileSync(f.calls, 'utf8')).toBe('');
  });

  it.each((['helper', 'server'] as const).flatMap(kind => ['plan', 'forward'].map(mode => ({ kind, mode }))))
  ('refuses unsupported unit directories before $kind $mode publication', ({ kind, mode }) => {
    const f = fixture();
    const flags = kind === 'server' ? ['--publish-unit'] : [];
    for (const directory of ['/srv/fixture-units', '/etc/systemd/system/nested', '/etc/systemd/user', '/usr/share/systemd/system']) {
      const result = f.invoke(kind, mode, [...flags, '--unit-dir', directory]);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('Unit directory must be a supported systemd load path.');
      expect(result.stdout).toBe('');
      expect(existsSync(f.receipt(kind))).toBe(false);
      for (const name of ['opt', 'etc', 'srv', 'usr']) expect(existsSync(join(f.root, name))).toBe(false);
      expect(readFileSync(f.calls, 'utf8')).toBe('');
    }
  });

  it.each((['helper', 'server'] as const).flatMap(kind =>
    ['/etc/systemd/system', '/run/systemd/system', '/usr/local/lib/systemd/system', '/usr/lib/systemd/system']
      .flatMap(directory => [false, true].map(enable => ({ kind, directory, enable })))))
  ('publishes discoverable $kind units in $directory, enable=$enable', ({ kind, directory, enable }) => {
    const f = fixture();
    const name = `wayroost-${kind}.service`;
    const path = join(f.root, directory, name);
    const link = join(f.root, 'etc/systemd/system/multi-user.target.wants', name);
    const flags = ['--unit-dir', directory, ...(kind === 'server' ? ['--publish-unit'] : []), ...(enable ? ['--enable'] : [])];
    f.success(kind, 'forward', flags);
    f.success(kind, 'forward', flags);
    f.success(kind, 'verify');
    const receipt = JSON.parse(readFileSync(f.receipt(kind), 'utf8'));
    expect(receipt.units).toEqual([{ name, old: 'not-found', new: enable ? 'enabled' : 'disabled' }]);
    expect(existsSync(path)).toBe(true);
    if (enable) {
      const target = directory === '/etc/systemd/system' ? `../${name}` : `${directory}/${name}`;
      expect(readlinkSync(link)).toBe(target);
      expect(receipt.paths.find((entry: { path: string }) => entry.path === link))
        .toMatchObject({ old: null, new: { kind: 'symlink', target: path, hash: hash(path) } });
    } else expect(existsSync(link)).toBe(false);
    if (existsSync('/usr/bin/systemctl')) {
      const query = spawnSync('/usr/bin/systemctl', ['--root', f.root, 'is-enabled', name], { encoding: 'utf8' });
      expect(query.stderr).toBe('');
      expect(query.status).toBe(enable ? 0 : 1);
      expect(query.stdout.trim()).toBe(enable ? 'enabled' : 'disabled');
    }
    f.success(kind, 'reverse', enable ? ['--enable'] : []);
    f.success(kind, 'verify');
    expect(existsSync(path)).toBe(false);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(f.calls, 'utf8')).not.toMatch(/\b(start|stop|restart|enable|disable)\b/);
  });

  it.each((['helper', 'server'] as const).flatMap(kind => ['plan', 'forward'].map(mode => ({ kind, mode }))))
  ('rejects a higher-priority unit before $kind $mode publication', ({ kind, mode }) => {
    const f = fixture();
    const name = `wayroost-${kind}.service`;
    const higher = join(f.root, 'etc/systemd/system', name);
    mkdirSync(join(higher, '..'), { recursive: true });
    writeFileSync(higher, 'original unit\n');
    const flags = ['--unit-dir', '/usr/lib/systemd/system', ...(kind === 'server' ? ['--publish-unit'] : [])];
    const result = f.invoke(kind, mode, flags);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('Unit destination is shadowed by a higher-priority systemd unit.');
    expect(result.stdout).toBe('');
    expect(readFileSync(higher, 'utf8')).toBe('original unit\n');
    expect(existsSync(join(f.root, 'usr'))).toBe(false);
    expect(existsSync(join(f.root, 'opt'))).toBe(false);
    expect(existsSync(join(f.root, 'var'))).toBe(false);
    expect(readFileSync(f.calls, 'utf8')).toBe('');
  });

  it.each((['helper', 'server'] as const).flatMap(kind =>
    ['forward', 'verify', 'reverse'].map(mode => ({ kind, mode }))))
  ('refuses $kind $mode when a published unit becomes shadowed', ({ kind, mode }) => {
    const f = fixture();
    const flags = ['--unit-dir', '/usr/lib/systemd/system', ...(kind === 'server' ? ['--publish-unit'] : [])];
    f.success(kind, 'forward', flags);
    const published = join(f.root, 'usr/lib/systemd/system', `wayroost-${kind}.service`);
    const before = readFileSync(published);
    const journal = readFileSync(f.receipt(kind));
    const higher = join(f.root, 'etc/systemd/system', `wayroost-${kind}.service`);
    mkdirSync(join(higher, '..'), { recursive: true });
    writeFileSync(higher, 'replacement unit\n');
    writeFileSync(f.calls, '');
    const result = f.invoke(kind, mode, mode === 'forward' ? flags : []);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('Unit destination is shadowed by a higher-priority systemd unit.');
    expect(readFileSync(published)).toEqual(before);
    expect(readFileSync(f.receipt(kind))).toEqual(journal);
    expect(readFileSync(f.calls, 'utf8')).toBe('');
    rmSync(higher);
    f.success(kind, 'verify');
    f.success(kind, 'reverse');
  });

  it.each(['regular', 'mask', 'broken'] as const)('rejects a higher-priority %s generated unit', kind => {
    const f = fixture();
    const higher = join(f.root, 'run/systemd/generator.early/wayroost-helper.service');
    mkdirSync(join(higher, '..'), { recursive: true });
    if (kind === 'regular') writeFileSync(higher, 'generated unit\n');
    else symlinkSync(kind === 'mask' ? '/dev/null' : '/absent-unit.service', higher);
    const result = f.invoke('helper', 'forward');
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('Unit destination is shadowed by a higher-priority systemd unit.');
    expect(existsSync(f.target('helper'))).toBe(false);
    expect(existsSync(join(f.root, 'var'))).toBe(false);
    expect(readFileSync(f.calls, 'utf8')).toBe('');
  });

  it.each(['helper', 'server'] as const)('refuses %s activation if its unit becomes shadowed during reload', kind => {
    const f = fixture();
    const command = join(f.binaries, 'systemctl');
    writeFileSync(command, readFileSync(command, 'utf8').replace('daemon-reload) [[ "$FAIL_RELOAD" != 1 ]] ;;',
      `daemon-reload) mkdir -p "$fake_root/etc/systemd/system"; printf 'concurrent unit\\n' > "$fake_root/etc/systemd/system/wayroost-${kind}.service" ;;`));
    const result = f.invoke(kind, 'forward', ['--unit-dir', '/usr/lib/systemd/system',
      ...(kind === 'helper' ? ['--start'] : ['--publish-unit', '--restart'])]);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('Unit destination is shadowed by a higher-priority systemd unit.');
    expect(readFileSync(f.calls, 'utf8')).toContain('daemon-reload');
    expect(readFileSync(f.calls, 'utf8')).not.toMatch(/\b(start|restart)\b/);
    expect(JSON.parse(readFileSync(f.receipt(kind), 'utf8')).status).toBe('applying');
    expect(JSON.parse(readFileSync(f.receipt(kind), 'utf8')).actionsDone).toBe(false);
  });

  it.each(['plan', 'forward'])('reserves receipt, undo, pending and lock paths before server %s publication', mode => {
    for (const config of [`${hostPaths.config}/config.json`, `${hostPaths.config}/.config.pending`,
      '/etc/wayroost-undo/config/0', '/var/lib/wayroost-install/.deployment.lock',
      '//var/lib/wayroost-install/.deployment.lock', hostPaths.config, '/etc/wayroost-undo']) {
      const f = fixture();
      const result = f.invoke('server', mode, ['--publish-config', '--config-source', f.sourceConfig,
        '--config-path', config, '--receipts', hostPaths.config, '--receipt', 'config']);
      expect(result.status, config + result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('Publication overlaps transaction storage.');
      expect(result.stdout).toBe('');
      expect(readdirSync(f.root)).toEqual([]);
      expect(readFileSync(f.calls, 'utf8')).toBe('');
    }
  });

  it.each<Installer>(['runtime', 'helper', 'server'])('reserves the undo directory from the %s prefix', kind => {
    const f = fixture();
    const result = f.invoke(kind, 'forward', ['--prefix', '//var/lib/wayroost-install/receipts-undo']);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('Publication overlaps transaction storage.');
    expect(readdirSync(f.root)).toEqual([]);
    expect(readFileSync(f.calls, 'utf8')).toBe('');
  });

  it.each(['helper', 'server'] as const)('reserves %s unit and enablement destinations from receipt storage', kind => {
    for (const receipts of ['/usr/lib/systemd/system', '/etc/systemd/system/multi-user.target.wants']) {
      const f = fixture();
      const result = f.invoke(kind, 'forward', ['--unit-dir', '/usr/lib/systemd/system', '--enable',
        '--receipts', receipts, ...(kind === 'server' ? ['--publish-unit'] : [])]);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('Publication overlaps transaction storage.');
      expect(readdirSync(f.root)).toEqual([]);
      expect(readFileSync(f.calls, 'utf8')).toBe('');
    }
  });

  it('retains the held deployment lock inode and bytes on a refused collision', () => {
    const f = fixture();
    const lock = join(f.root, 'var/lib/wayroost-install/.deployment.lock');
    mkdirSync(join(lock, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(lock, 'lock sentinel\n', { mode: 0o600 });
    const inode = statSync(lock).ino;
    const result = f.invoke('server', 'forward', ['--publish-config', '--config-source', f.sourceConfig,
      '--config-path', '/var/lib/wayroost-install/.deployment.lock']);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('Publication overlaps transaction storage.');
    expect(statSync(lock).ino).toBe(inode);
    expect(readFileSync(lock, 'utf8')).toBe('lock sentinel\n');
    expect(existsSync(f.receipt('server'))).toBe(false);
    expect(existsSync(f.target('server'))).toBe(false);
  });

  it('reserves transaction temporary names from config publication', () => {
    const f = fixture();
    const result = f.invoke('server', 'forward', ['--publish-config', '--config-source', f.sourceConfig,
      '--config-path', '/opt/wayroost/server/.wayroost-' + 'a'.repeat(32)]);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('Publication overlaps transaction storage.');
    expect(readdirSync(f.root)).toEqual([]);
  });

  it.each(['verify', 'reverse'])('refuses a receipted transaction-storage collision before %s recovery', mode => {
    const f = fixture();
    f.success('server', 'forward');
    const journal = JSON.parse(readFileSync(f.receipt('server'), 'utf8'));
    const lock = join(f.root, 'var/lib/wayroost-install/.deployment.lock');
    const info = statSync(lock);
    journal.paths.push({ path: lock, old: null, new: { kind: 'file', hash: hash(readFileSync(lock)),
      mode: '0600', owner: { uid: info.uid, gid: info.gid } }, enablement: null });
    writeFileSync(f.receipt('server'), JSON.stringify(journal));
    const pending = join(f.root, 'var/lib/wayroost-install/receipts/.server.pending');
    writeFileSync(pending, 'pending sentinel\n', { mode: 0o600 });
    const before = readFileSync(f.receipt('server'));
    const result = f.invoke('server', mode);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('Publication overlaps transaction storage.');
    expect(statSync(lock).ino).toBe(info.ino);
    expect(readFileSync(f.receipt('server'))).toEqual(before);
    expect(readFileSync(pending, 'utf8')).toBe('pending sentinel\n');
    expect(existsSync(f.target('server'))).toBe(true);
  });

  it.each(['plan', 'forward'])('rejects aliased production publications before %s writes', mode => {
    for (const aliasedPrefix of [true, false]) {
      const f = fixture();
      const prefix = join(f.root, 'opt/wayroost/server');
      pythonShim(f, [
        ['elif os.geteuid() != 0:', 'elif False:'],
        ['fake_root = bool(args.root)', 'fake_root = True'],
        ['def trusted_file(path):', 'def trusted_file(path):\n    return'],
        ["argument_root = None if name in ['source', 'config_source', 'drop_ins'] else root",
          `argument_root = Path(${JSON.stringify(f.root)}) if name == 'unit_dir' else None`],
        ['logical = protected(Path(value), inspect=False)',
          `logical = protected(Path(value), inspect=False)\n        if str(logical) in ['/var/lib/wayroost-install', '/etc/systemd/system']:\n            logical = Path(${JSON.stringify(f.root)}) / logical.relative_to('/')`],
      ], "index = sys.argv.index('--root')\ndel sys.argv[index:index + 2]");
      const result = f.invoke('server', mode, ['--prefix', (aliasedPrefix ? '/' : '') + prefix,
        '--receipts', join(f.root, 'receipts'), '--publish-config', '--config-source', f.sourceConfig,
        '--config-path', (aliasedPrefix ? '' : '/') + join(prefix, 'package.json')]);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('Publication paths overlap.');
      expect(result.stdout).toBe('');
      expect(existsSync(join(prefix, 'package.json'))).toBe(false);
      expect(existsSync(join(f.root, 'receipts/server.json'))).toBe(false);
      expect(readFileSync(f.calls, 'utf8')).toBe('');
    }
  });

  it('resumes an interrupted file publication using the original undo copy', () => {
    const f = fixture();
    const path = f.target('runtime');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'original bytes\n', { mode: 0o640 });
    writeFileSync(join(f.binaries, 'python3'), `#!/usr/bin/env bash
set -euo pipefail
shift
exec /usr/bin/python3 -c 'import sys; script = sys.stdin.read(); script = script.replace("os.replace(temporary, path)", "os.replace(temporary, path)\\n        if str(path).endswith(\\"/signalbox-helper.py\\"): os._exit(77)"); exec(compile(script, "<stdin>", "exec"))' "$@"
`, { mode: 0o755 });
    expect(f.invoke('runtime', 'forward').status).toBe(77);
    expect(JSON.parse(readFileSync(f.receipt('runtime'), 'utf8')).status).toBe('applying');
    expect(readFileSync(path, 'utf8')).not.toBe('original bytes\n');
    f.success('runtime', 'forward');
    f.success('runtime', 'verify');
    rmSync(join(f.binaries, 'python3'));
    f.success('runtime', 'reverse');
    expect(readFileSync(path, 'utf8')).toBe('original bytes\n');
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it('refuses unreceipted additions, metadata edits, changed inputs and symlinked receipt storage', () => {
    const f = fixture();
    f.success('runtime', 'forward');
    writeFileSync(join(f.root, 'opt/wayroost/runtime/bin/extra'), 'retained');
    expect(f.invoke('runtime', 'reverse').status).toBe(1);
    expect(existsSync(f.target('runtime'))).toBe(true);
    rmSync(join(f.root, 'opt/wayroost/runtime/bin/extra'));
    chmodSync(f.target('runtime'), 0o777);
    expect(f.invoke('runtime', 'reverse').status).toBe(1);
    chmodSync(f.target('runtime'), 0o755);
    expect(f.invoke('runtime', 'forward', ['--role', 'shadow']).status).toBe(1);
    f.success('runtime', 'reverse');
    rmSync(join(f.root, 'var/lib/wayroost-install/receipts'), { recursive: true });
    symlinkSync(f.folder, join(f.root, 'var/lib/wayroost-install/receipts'));
    expect(f.invoke('runtime', 'forward').status).toBe(1);
  });

  it.each((['helper', 'server'] as const).flatMap(kind =>
    (kind === 'helper' ? ['--prefix', '--home', '--hermes-home', '--token-file'] : ['--prefix', '--config-path'])
      .flatMap(option => ['plan', 'forward'].flatMap(mode => ['$MISSING', '${MISSING}', '$$'].map(name => ({ kind, option, mode, name }))))))
  ('rejects dollar signs in $kind $option during $mode: $name', ({ kind, option, mode, name }) => {
    const f = fixture();
    const flags = kind === 'server' ? ['--publish-unit'] : [];
    const result = f.invoke(kind, mode, [...flags, option, `/opt/wayroost/${name}/demo`]);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('Unit paths cannot contain whitespace or systemd delimiters.');
    expect(result.stdout).toBe('');
    expect(existsSync(f.receipt(kind))).toBe(false);
    expect(existsSync(f.target(kind))).toBe(false);
    expect(existsSync(join(f.root, 'opt'))).toBe(false);
    expect(existsSync(join(f.root, 'etc'))).toBe(false);
    expect(readFileSync(f.calls, 'utf8')).toBe('');
  });
});

describe('owner helper', () => {
  it('uses the selected helper home for its Linux skill directories', () => {
    const f = fixture();
    const home = '/home/me-selected';
    const options = ['--home', home];
    f.success('helper', 'forward', options);
    f.success('helper', 'forward', options);
    const unit = readFileSync(f.target('helper'), 'utf8');
    const result = pythonFunctions(`
sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[3])
from signalbox_skills import from_env
from wayroost_runtime import BackgroundGate
root = Path(sys.argv[2])
os.environ.clear()
os.environ['HOME'] = str(root / 'home/me-passwd')
for line in Path(sys.argv[1]).read_text().splitlines():
    if line.startswith('Environment='):
        for word in systemd_words(line.partition('=')[2]):
            key, _, value = word.partition('=')
            os.environ[key] = str(root / value.lstrip('/')) if key in ['HOME', 'HERMES_HOME'] else value
skills = from_env(Path(os.environ['HERMES_HOME']), background=BackgroundGate(role='primary'))
print(json.dumps({key: str(place.path) for key, place in skills.places.items()}))
`, [f.target('helper'), f.root, join(process.cwd(), 'helper')]);
    expect(result.status, result.stderr).toBe(0);
    const places = JSON.parse(result.stdout);
    for (const [key, suffix] of Object.entries({ shared: '.agents/skills', claude: '.claude/skills',
      codex: '.codex/skills', pi: '.pi/agent/skills', opencode: '.config/opencode/skills' })) {
      expect(places[key]).toBe(join(f.root, home, suffix));
      expect(unit).toContain(`-${home}/${suffix}`);
    }
    expect(places.hermes).toBe(join(f.root, home, '.hermes/skills'));
    expect(unit).toContain(`Environment=HOME=${home}\n`);
    f.success('helper', 'verify');
    f.success('helper', 'reverse');
  });

  it('refuses to import a HOME that overrides the selected helper home', () => {
    const f = fixture();
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    writeFileSync(join(source, '20-home.conf'), '[Service]\nEnvironment=HOME=/home/me-other\n');
    for (const mode of ['plan', 'forward']) {
      const result = f.invoke('helper', mode, ['--drop-ins', source, '--allow-environment', 'HOME']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Environment allowlist contains an invalid or installer-controlled key.');
      expect(existsSync(f.target('helper'))).toBe(false);
      expect(existsSync(f.receipt('helper'))).toBe(false);
      expect(readFileSync(f.calls, 'utf8')).toBe('');
    }
  });

  it('publishes and starts a helper with a protected runtime at a custom prefix', () => {
    const f = fixture();
    const prefix = '/opt/wayroost/demo-runtime';
    f.success('runtime', 'forward', ['--prefix', prefix]);
    const path = join(f.root, prefix, 'bin/signalbox-helper.py');
    const before = readFileSync(path);
    mkdirSync(join(f.root, prefix, 'bin/dependency'));
    writeFileSync(join(f.root, prefix, 'bin/dependency/module.py'), '# prepared dependency\n');
    pythonShim(f, [['if not root:\n                    helper_runtime(prefix)', 'helper_runtime(prefix)']], `
original_lstat = Path.lstat
def runtime_lstat(path, *args, **kwargs):
    info = list(original_lstat(path, *args, **kwargs))
    info[4] = 0
    if not path.is_relative_to(Path(${JSON.stringify(f.root)})): info[0] &= ~0o022
    return os.stat_result(info)
Path.lstat = runtime_lstat
`);
    const options = ['--prefix', prefix, '--start'];
    f.success('helper', 'plan', options);
    f.success('helper', 'forward', options);
    f.success('helper', 'forward', options);
    expect(readFileSync(f.target('helper'), 'utf8')).toContain(`ExecStart=/usr/bin/python3 ${prefix}/bin/signalbox-helper.py`);
    expect(readFileSync(f.calls, 'utf8').match(/ start wayroost-helper.service/g)).toHaveLength(1);
    f.success('helper', 'verify');
    f.success('helper', 'reverse');
    expect(readFileSync(path)).toEqual(before);
  });

  it.each(['plan', 'forward'].flatMap(mode => [
    'bin/signalbox-helper.py', 'bin/signalbox_skills.py', 'bin/wayroost_runtime.py',
    'bin/signalbox_mail_trigger.py', 'bin/wayroost-role.json', 'bin/extra/module.py',
    'bin/extra', 'bin', '.', '..',
  ].flatMap(path => ['owner', 'writable', 'link'].map(edit => ({ mode, path, edit })))))
  ('refuses an untrusted helper runtime before publication or activation: $mode, $path, $edit', ({ mode, path, edit }) => {
    const f = fixture();
    f.success('runtime', 'forward');
    writeFileSync(f.calls, '');
    const prefix = join(f.root, 'opt/wayroost/runtime');
    mkdirSync(join(prefix, 'bin/extra'));
    writeFileSync(join(prefix, 'bin/extra/module.py'), '# prepared dependency\n');
    const changed = join(prefix, path);
    if (edit === 'writable') chmodSync(changed, statSync(changed).mode | 0o020);
    if (edit === 'link') {
      const outside = join(f.folder, 'outside-runtime');
      if (statSync(changed).isDirectory()) mkdirSync(outside);
      else writeFileSync(outside, '# outside runtime\n');
      rmSync(changed, { recursive: true });
      symlinkSync(outside, changed);
    }
    pythonShim(f, [['if not root:\n                    helper_runtime(prefix)', 'helper_runtime(prefix)']], `
original_lstat = Path.lstat
def runtime_lstat(path, *args, **kwargs):
    info = list(original_lstat(path, *args, **kwargs))
    info[4] = 1001 if str(path) == ${JSON.stringify(edit === 'owner' ? changed : '')} else 0
    if not path.is_relative_to(Path(${JSON.stringify(f.root)})): info[0] &= ~0o022
    return os.stat_result(info)
Path.lstat = runtime_lstat
`);
    const result = f.invoke('helper', mode, ['--start']);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(existsSync(f.target('helper'))).toBe(false);
    expect(existsSync(f.receipt('helper'))).toBe(false);
    expect(readFileSync(f.calls, 'utf8')).toBe('');
  });

  it.each(['signalbox-helper.py', 'signalbox_skills.py', 'wayroost_runtime.py', 'signalbox_mail_trigger.py', 'wayroost-role.json']
    .flatMap(name => ['missing', 'directory'].map(edit => ({ name, edit }))))
  ('requires regular helper runtime inputs before activation: $name, $edit', ({ name, edit }) => {
    const f = fixture();
    f.success('runtime', 'forward');
    writeFileSync(f.calls, '');
    const path = join(f.root, 'opt/wayroost/runtime/bin', name);
    rmSync(path);
    if (edit === 'directory') mkdirSync(path);
    pythonShim(f, [['if not root:\n                    helper_runtime(prefix)', 'helper_runtime(prefix)']], `
original_lstat = Path.lstat
def runtime_lstat(path, *args, **kwargs):
    info = list(original_lstat(path, *args, **kwargs))
    info[4] = 0
    if not path.is_relative_to(Path(${JSON.stringify(f.root)})): info[0] &= ~0o022
    return os.stat_result(info)
Path.lstat = runtime_lstat
`);
    const result = f.invoke('helper', 'forward', ['--start']);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(existsSync(f.target('helper'))).toBe(false);
    expect(existsSync(f.receipt('helper'))).toBe(false);
    expect(readFileSync(f.calls, 'utf8')).toBe('');
  });

  it('rechecks the protected helper runtime immediately before starting and can resume after repair', () => {
    const f = fixture();
    f.success('runtime', 'forward');
    writeFileSync(f.calls, '');
    const path = join(f.root, 'opt/wayroost/runtime/bin/signalbox_skills.py');
    pythonShim(f, [
      ['if not root:\n                    helper_runtime(prefix)', 'helper_runtime(prefix)'],
      ["if getattr(args, 'start', False):", `if getattr(args, 'start', False):\n                Path(${JSON.stringify(path)}).chmod(0o666)`],
    ], `
original_lstat = Path.lstat
def runtime_lstat(path, *args, **kwargs):
    info = list(original_lstat(path, *args, **kwargs))
    info[4] = 0
    if not path.is_relative_to(Path(${JSON.stringify(f.root)})): info[0] &= ~0o022
    return os.stat_result(info)
Path.lstat = runtime_lstat
`);
    const result = f.invoke('helper', 'forward', ['--start']);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(readFileSync(f.calls, 'utf8')).not.toMatch(/ start /);
    expect(JSON.parse(readFileSync(f.receipt('helper'), 'utf8')).status).toBe('applying');
    chmodSync(path, 0o644);
    rmSync(join(f.binaries, 'python3'));
    f.success('helper', 'forward', ['--start']);
    f.success('helper', 'forward', ['--start']);
    expect(readFileSync(f.calls, 'utf8').match(/ start wayroost-helper.service/g)).toHaveLength(1);
  });

  it.each([
    { option: '--prefix', directive: 'ExecStart=/usr/bin/python3 ', suffix: '/bin/signalbox-helper.py' },
    { option: '--home', directive: 'ReadWritePaths=-', suffix: '/.agents/skills' },
    { option: '--hermes-home', directive: 'Environment=HERMES_HOME=', suffix: '' },
    { option: '--token-file', directive: 'LoadCredential=token:', suffix: '' },
  ])('preserves literal template markers supplied in $option', ({ option, directive, suffix }) => {
    const f = fixture();
    const value = '/opt/wayroost/@USER@/@HOME@/@HERMES_HOME@/@TOKEN@/@RUNTIME@/@PORT@/demo';
    f.success('helper', 'forward', [option, value]);
    f.success('helper', 'forward', [option, value]);
    const unit = readFileSync(f.target('helper'), 'utf8');
    expect(unit).toContain(directive + value + suffix);
    if (option === '--prefix') expect(unit).toContain(`Environment=WAYROOST_HELPER_ROLE_CONFIG=${value}/bin/wayroost-role.json`);
    f.success('helper', 'verify');
    f.success('helper', 'reverse');
  });

  it.each(['plan', 'forward'].flatMap(mode => ['protected', 'legacy', 'file-owner', 'parent-owner',
    'file-writable', 'parent-writable', 'file-link', 'parent-link', 'directory', 'missing'].map(source => ({ mode, source }))))
  ('checks credential source metadata without reading bytes: $mode, $source', ({ mode, source }) => {
    const f = fixture();
    const logical = `${source === 'legacy' ? hostPaths.legacyConfig : hostPaths.config}/helper.token`;
    const token = join(f.root, logical);
    const directory = join(token, '..');
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    writeFileSync(token, 'sentinel-credential-bytes', { mode: 0o600 });
    const untrusted = source === 'file-owner' ? token : source === 'parent-owner' ? directory : '';
    if (source === 'file-writable') chmodSync(token, 0o620);
    if (source === 'parent-writable') chmodSync(directory, 0o775);
    if (source === 'file-link') {
      rmSync(token);
      symlinkSync('unreadable-source', token);
    }
    if (source === 'parent-link') {
      rmSync(directory, { recursive: true });
      symlinkSync('../unreadable-directory', directory);
    }
    if (source === 'directory') {
      rmSync(token);
      mkdirSync(token, { mode: 0o700 });
    }
    if (source === 'missing') rmSync(token);
    pythonShim(f, [['if not root:\n                    credential_source(token)', 'credential_source(root / token.relative_to("/"))']], `
original_lstat = Path.lstat
def credential_lstat(path, *args, **kwargs):
    info = list(original_lstat(path, *args, **kwargs))
    info[4] = 1001 if str(path) == ${JSON.stringify(untrusted)} else 0
    if not path.is_relative_to(Path(${JSON.stringify(f.root)})): info[0] &= ~0o022
    return os.stat_result(info)
Path.lstat = credential_lstat
original_open = Path.open
def credential_open(path, *args, **kwargs):
    if path.is_relative_to(Path(${JSON.stringify(directory)})):
        raise AssertionError('Credential bytes must not be opened.')
    return original_open(path, *args, **kwargs)
Path.open = credential_open
`);
    const result = f.invoke('helper', mode, ['--token-file', logical]);
    const allowed = source === 'protected' || source === 'legacy';
    expect(result.status, result.stderr).toBe(allowed ? 0 : 1);
    expect(result.stdout + result.stderr).not.toContain('sentinel-credential-bytes');
    if (allowed) {
      expect(readFileSync(f.receipt('helper'), 'utf8')).not.toContain('sentinel-credential-bytes');
      if (mode === 'forward') expect(readFileSync(f.target('helper'), 'utf8')).toContain(`LoadCredential=token:${logical}`);
    } else {
      expect(result.stderr).toContain(['file-link', 'parent-link'].includes(source)
        ? 'Refusing a symlink in a deployment path.' : 'Credential source');
      expect(existsSync(f.target('helper'))).toBe(false);
      expect(existsSync(f.receipt('helper'))).toBe(false);
      expect(readFileSync(f.calls, 'utf8')).toBe('');
    }
  });

  it('renders an owner unit with loopback port, credential path and the original sandbox controls', () => {
    const f = fixture();
    f.success('helper', 'forward', ['--port', '18893', '--token-file', `${hostPaths.config}/owner-token`]);
    const unit = readFileSync(f.target('helper'), 'utf8');
    expect(unit).toContain('User=demo-owner');
    expect(unit).toContain('Environment=WAYROOST_HELPER_PORT=18893');
    expect(unit).toContain(`LoadCredential=token:${hostPaths.config}/owner-token`);
    expect(unit).toContain('ExecStart=/usr/bin/python3 /opt/wayroost/runtime/bin/signalbox-helper.py');
    expect(unit).toContain('Environment=WAYROOST_HELPER_ROLE_CONFIG=/opt/wayroost/runtime/bin/wayroost-role.json');
    expect(unit).not.toContain('@');
    for (const line of readFileSync('deploy/signalbox-helper.service', 'utf8').split('\n')) {
      if (/^(NoNewPrivileges|Protect[A-Za-z]*|Private[A-Za-z]*|Restrict[A-Za-z]*|LockPersonality|CapabilityBoundingSet|AmbientCapabilities|MemoryMax|TasksMax)=/.test(line)) expect(unit).toContain(line);
    }
    expect(readFileSync('helper/signalbox-helper.py', 'utf8')).toContain('HOST = "127.0.0.1"');
  });

  it('translates only allowlisted Environment keys and never outputs values in any mode or receipt', () => {
    const f = fixture();
    const source = join(f.root, 'etc/systemd/system/signalbox-helper.service.d');
    mkdirSync(source, { recursive: true });
    const sentinel = 'sentinel-private-environment-value';
    const file = join(source, '20-extra.conf');
    const original = `[Service]\nEnvironment="SIGNALBOX_SHOP_CDP=${sentinel}" "IGNORED_KEY=ignored-value"\nExecStart=/bin/false\n[Unit]\nEnvironment=IGNORED_KEY=other\n`;
    writeFileSync(file, original);
    const options = ['--drop-ins', source, '--allow-environment', 'SIGNALBOX_SHOP_CDP'];
    for (const mode of ['plan', 'forward', 'verify', 'reverse']) {
      const result = f.invoke('helper', mode, mode === 'plan' || mode === 'forward' ? options : []);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout + result.stderr + readFileSync(f.receipt('helper'), 'utf8')).not.toContain(sentinel);
      expect(readFileSync(file, 'utf8')).toBe(original);
      if (mode === 'forward') {
        const translated = readFileSync(join(f.root, 'etc/systemd/system/wayroost-helper.service.d/50-imported-environment.conf'), 'utf8');
        expect(translated).toContain(`SIGNALBOX_SHOP_CDP=${sentinel}`);
        expect(translated).not.toMatch(/IGNORED_KEY|ExecStart/);
        expect(JSON.parse(readFileSync(f.receipt('helper'), 'utf8')).intent.environment).toEqual([{ key: 'SIGNALBOX_SHOP_CDP', hash: hash(sentinel) }]);
      }
    }
    for (const key of ['WAYROOST_HELPER_ROLE_CONFIG', 'WAYROOST_CONFIG', 'SIGNALBOX_CONFIG']) {
      expect(f.invoke('helper', 'forward', ['--drop-ins', source, '--allow-environment', key]).status).toBe(1);
    }
  });

  it('documents the shopping Environment key consumed by the helper', () => {
    const guide = readFileSync('docs/primary-install.md', 'utf8');
    const keys = guide.match(/--allow-environment ([A-Z_,]+)/)![1]!.split(',');
    expect(keys).toContain('SIGNALBOX_SHOP_CDP');
    expect(readFileSync('helper/signalbox-helper.py', 'utf8')).toContain('SHOP_CDP = env("SHOP_CDP", "")');
  });

  it('enables and starts only by explicit flags, and resumes a failed reload without losing the receipt', () => {
    const f = fixture();
    const options = ['--enable', '--start'];
    expect(f.invoke('helper', 'forward', options, { FAIL_RELOAD: '1' }).status).toBe(1);
    f.success('helper', 'forward', options);
    f.success('helper', 'forward', options);
    f.success('helper', 'verify');
    const calls = readFileSync(f.calls, 'utf8');
    expect(calls.match(/ start wayroost-helper.service/g)).toHaveLength(1);
    const link = join(f.root, 'etc/systemd/system/multi-user.target.wants/wayroost-helper.service');
    expect(readlinkSync(link)).toBe('../wayroost-helper.service');
    expect(JSON.parse(readFileSync(f.receipt('helper'), 'utf8')).paths.find((entry: { path: string }) => entry.path === link))
      .toMatchObject({ old: null, new: { kind: 'symlink', hash: hash(f.target('helper')) }, enablement: { old: 'not-found', new: 'enabled' } });
    expect(calls).not.toMatch(/\b(stop|restart)\b|signalbox/);
    expect(f.invoke('helper', 'reverse').status).toBe(1);
    expect(f.invoke('helper', 'reverse', ['--enable'], { FAIL_RELOAD: '1' }).status).toBe(1);
    f.success('helper', 'reverse', ['--enable']);
    expect(existsSync(f.target('helper'))).toBe(false);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(f.calls, 'utf8')).not.toMatch(/\b(enable|disable)\b/);
  });

  it.each([
    { kind: 'helper' as const, flags: ['--enable'], expected: 'enable', absent: 'start|restart|stop' },
    { kind: 'helper' as const, flags: ['--start'], expected: 'start', absent: 'enable|restart|stop' },
    { kind: 'server' as const, flags: ['--enable', '--publish-unit'], expected: 'enable', absent: 'start|restart|stop' },
  ])('performs only the requested $expected action for $kind', ({ kind, flags, expected, absent }) => {
    const f = fixture();
    f.success(kind, 'forward', flags);
    if (expected === 'enable') expect(lstatSync(join(f.root, `etc/systemd/system/multi-user.target.wants/wayroost-${kind}.service`)).isSymbolicLink()).toBe(true);
    else expect(readFileSync(f.calls, 'utf8')).toContain(` ${expected} wayroost-${kind}.service`);
    expect(readFileSync(f.calls, 'utf8')).not.toMatch(new RegExp(`\\b(${absent})\\b`));
  });

  it('refuses an edited enablement link and restores a pre-existing link verbatim', () => {
    const f = fixture();
    const link = join(f.root, 'etc/systemd/system/multi-user.target.wants/wayroost-helper.service');
    mkdirSync(join(link, '..'), { recursive: true });
    writeFileSync(f.target('helper'), '[Service]\nUser=demo-owner\n');
    symlinkSync('/etc/systemd/system/wayroost-helper.service', link);
    f.success('helper', 'forward', ['--enable']);
    expect(readlinkSync(link)).toBe('../wayroost-helper.service');
    rmSync(link);
    symlinkSync('../other.service', link);
    expect(f.invoke('helper', 'reverse', ['--enable']).status).toBe(1);
    expect(readlinkSync(link)).toBe('../other.service');
    rmSync(link);
    symlinkSync('../wayroost-helper.service', link);
    f.success('helper', 'reverse', ['--enable']);
    expect(readlinkSync(link)).toBe('/etc/systemd/system/wayroost-helper.service');
    f.success('helper', 'verify');
  });

  it.each((['helper', 'server'] as const).flatMap(kind => [
    { directory: '/usr/lib/systemd/system', spelling: 'slashes' },
    { directory: '/usr/lib/systemd/system', spelling: 'dot' },
    { directory: '/etc/systemd/system', spelling: 'relative' },
  ].flatMap(row => [false, true].map(existing => ({ kind, ...row, existing })))))
  ('accepts equivalent $kind enablement targets: $spelling, existing=$existing', ({ kind, directory, spelling, existing }) => {
    const f = fixture();
    const name = `wayroost-${kind}.service`;
    const unit = join(f.root, directory, name);
    const link = join(f.root, 'etc/systemd/system/multi-user.target.wants', name);
    const alias = spelling === 'slashes' ? `//usr//lib/systemd/system/${name}`
      : spelling === 'dot' ? `/usr/lib/./systemd/system/${name}` : `..//./${name}`;
    const flags = ['--enable', '--unit-dir', directory, ...(kind === 'server' ? ['--publish-unit'] : [])];
    if (existing) {
      mkdirSync(join(unit, '..'), { recursive: true });
      mkdirSync(join(link, '..'), { recursive: true });
      writeFileSync(unit, '[Service]\n');
      symlinkSync(alias, link);
    }
    f.success(kind, 'forward', flags);
    expect(readlinkSync(link)).toBe(directory === '/etc/systemd/system' ? `../${name}` : `${directory}/${name}`);
    const receipt = JSON.parse(readFileSync(f.receipt(kind), 'utf8'));
    expect(receipt.paths.find((entry: { path: string }) => entry.path === link).new)
      .toMatchObject({ target: unit, hash: hash(unit) });
    rmSync(link);
    symlinkSync(alias, link);
    f.success(kind, 'forward', flags);
    f.success(kind, 'verify');
    f.success(kind, 'reverse', ['--enable']);
    if (existing) expect(readlinkSync(link)).toBe(alias);
    else expect(existsSync(link)).toBe(false);
    f.success(kind, 'verify');
  });

  it.each(['helper', 'server'] as const)('refuses a genuinely different %s enablement target before publication', kind => {
    const f = fixture();
    const name = `wayroost-${kind}.service`;
    const link = join(f.root, 'etc/systemd/system/multi-user.target.wants', name);
    mkdirSync(join(link, '..'), { recursive: true });
    symlinkSync(`/etc/systemd/system/${name}`, link);
    const result = f.invoke(kind, 'forward', ['--enable', '--unit-dir', '/usr/lib/systemd/system',
      ...(kind === 'server' ? ['--publish-unit'] : [])]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Existing enablement link points outside the unit directory.');
    expect(readlinkSync(link)).toBe(`/etc/systemd/system/${name}`);
    expect(existsSync(join(f.root, 'usr'))).toBe(false);
    expect(existsSync(f.receipt(kind))).toBe(false);
  });

  it('refuses an enablement target that traverses a symlink before a parent component', () => {
    const f = fixture();
    const directory = join(f.root, 'etc/systemd/system');
    const link = join(directory, 'multi-user.target.wants/wayroost-helper.service');
    mkdirSync(join(link, '..'), { recursive: true });
    const outside = join(f.folder, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(directory, 'linked'));
    const spelling = '../linked/../wayroost-helper.service';
    symlinkSync(spelling, link);
    const result = f.invoke('helper', 'forward', ['--enable']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing a symlink in a deployment path.');
    expect(readlinkSync(link)).toBe(spelling);
    expect(existsSync(f.target('helper'))).toBe(false);
    expect(existsSync(f.receipt('helper'))).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  it.each(['helper', 'server'] as const)('normalizes an aliased %s unit directory before load-path validation', kind => {
    const f = fixture();
    const flags = ['--unit-dir', '//usr//lib/./systemd//system/', '--enable', ...(kind === 'server' ? ['--publish-unit'] : [])];
    f.success(kind, 'forward', flags);
    f.success(kind, 'forward', [...flags, '--unit-dir', '/usr/lib/systemd/system']);
    f.success(kind, 'verify');
    const receipt = JSON.parse(readFileSync(f.receipt(kind), 'utf8'));
    expect(receipt.paths.some((entry: { path: string }) => entry.path === join(f.root, `usr/lib/systemd/system/wayroost-${kind}.service`))).toBe(true);
    f.success(kind, 'reverse', ['--enable']);
  });

  it('normalizes earlier enablement metadata while retaining the original link spelling for undo', () => {
    const f = fixture();
    const link = join(f.root, 'etc/systemd/system/multi-user.target.wants/wayroost-helper.service');
    const original = '//etc//systemd/./system/wayroost-helper.service';
    mkdirSync(join(link, '..'), { recursive: true });
    writeFileSync(f.target('helper'), '[Service]\n');
    symlinkSync(original, link);
    f.success('helper', 'forward', ['--enable']);
    const receipt = JSON.parse(readFileSync(f.receipt('helper'), 'utf8'));
    const entry = receipt.paths.find((entry: { path: string }) => entry.path === link);
    delete entry.oldTarget;
    entry.old.target = original;
    entry.old.hash = hash(original);
    entry.new.target = '../wayroost-helper.service';
    entry.new.hash = hash(entry.new.target);
    writeFileSync(f.receipt('helper'), JSON.stringify(receipt));
    f.success('helper', 'verify');
    f.success('helper', 'forward', ['--enable']);
    f.success('helper', 'reverse', ['--enable']);
    expect(readlinkSync(link)).toBe(original);
    f.success('helper', 'verify');
    const reversed = JSON.parse(readFileSync(f.receipt('helper'), 'utf8')).paths.find((entry: { path: string }) => entry.path === link);
    expect(reversed.old).toMatchObject({ target: f.target('helper'), hash: hash(f.target('helper')) });
    expect(reversed.oldTarget).toBe(original);
  });
});

describe('server modes', () => {
  it.each([
    { name: 'blank line', input: `SupplementaryGroups=wayroost\\\n\nLoadCredential=extra:${hostPaths.config}/demo.key`,
      expected: ['SupplementaryGroups=wayroost', `LoadCredential=extra:${hostPaths.config}/demo.key`] },
    { name: 'whitespace-only line', input: `SupplementaryGroups=wayroost\\\n \t \nLoadCredential=extra:${hostPaths.config}/demo.key`,
      expected: ['SupplementaryGroups=wayroost', `LoadCredential=extra:${hostPaths.config}/demo.key`] },
    { name: 'indented quoted line', input: `LoadCredential="extra:${hostPaths.config}/sentinel\\\n  key"`,
      expected: [`LoadCredential="extra:${hostPaths.config}/sentinel   key"`] },
    { name: 'escaped trailing backslash', input: `LoadCredential=extra:${hostPaths.config}/sentinel\\\\\nLoadCredential=other:${hostPaths.config}/demo.key`,
      expected: [`LoadCredential=extra:${hostPaths.config}/sentinel\\\\`, `LoadCredential=other:${hostPaths.config}/demo.key`] },
  ])('preserves server wiring through a $name', ({ input, expected }) => {
    const f = fixture();
    const path = join(f.root, 'etc/systemd/system/wayroost-server.service');
    mkdirSync(join(path, '..'), { recursive: true });
    const original = `[Service]\nExecStart=/usr/bin/node /opt/wayroost/server/dist/server/index.js\n${input}\n`;
    writeFileSync(path, original);
    const flags = ['--publish-unit'];
    f.success('server', 'forward', flags);
    const lines = readFileSync(path, 'utf8').split('\n').map(line => line.trim());
    for (const line of expected) expect(lines).toContain(line);
    f.success('server', 'forward', flags);
    f.success('server', 'verify');
    f.success('server', 'reverse');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it.each(['primary', 'shadow'].flatMap(role => ['plain', 'quoted'].flatMap(syntax =>
    [false, true].map(interrupted => ({ role, syntax, interrupted })))))
  ('preserves Node directive text in credential sources: $role, $syntax, interrupted=$interrupted', ({ role, syntax, interrupted }) => {
    const f = fixture();
    f.defaults.server = [...f.server, '--role', role];
    const node = '/usr/local/bin/node';
    const source = `${hostPaths.config}/ExecStart=/usr/bin/node key`;
    const credential = `LoadCredential=${syntax === 'quoted' ? `"extra:${source}"` : `extra:${source}`}`;
    const path = join(f.root, 'etc/systemd/system/wayroost-server.service');
    mkdirSync(join(path, '..'), { recursive: true });
    const original = `[Service]\nExecStart=${node} /opt/wayroost/server/dist/server/index.js\n${credential}\n`;
    writeFileSync(path, original);
    const flags = ['--publish-unit', '--prefix', '/opt/wayroost/demo-server'];
    const first = f.invoke('server', 'forward', flags, interrupted ? { FAIL_RELOAD: '1' } : {});
    expect(first.status, first.stderr).toBe(interrupted ? 1 : 0);
    const unit = readFileSync(path, 'utf8');
    expect(unit).toContain(`ExecStart=${node} /opt/wayroost/demo-server/dist/server/index.js\n`);
    expect(unit).toContain(credential + '\n');
    f.success('server', 'forward', flags);
    f.success('server', 'forward', flags);
    expect(readFileSync(path, 'utf8')).toBe(unit);
    f.success('server', 'verify');
    f.success('server', 'reverse');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it.each(['primary', 'shadow'].flatMap(role => ['(shadow)', 'WAYROOST_ROLE=shadow', 'StateDirectory=wayroost-shadow', 'Restart=on-failure']
    .flatMap(marker => [false, true].map(interrupted => ({ role, marker, interrupted })))))
  ('preserves literal server paths while rendering $role: $marker, interrupted=$interrupted', ({ role, marker, interrupted }) => {
    const f = fixture();
    f.defaults.server = [...f.server, '--role', role];
    const prefix = `/opt/wayroost/${marker}/server`;
    const config = `${hostPaths.config}/${marker}/config.json`;
    const node = `/opt/demo-node/${marker}/bin/node`;
    const credential = `LoadCredential=helper-token:${hostPaths.config}/${marker}/helper.token`;
    const path = join(f.root, 'etc/systemd/system/wayroost-server.service');
    mkdirSync(join(path, '..'), { recursive: true });
    const original = `[Service]\nExecStart=${node} /opt/wayroost/server/dist/server/index.js\n${credential}\n`;
    writeFileSync(path, original);
    const options = ['--publish-unit', '--prefix', prefix, '--config-path', config];
    const first = f.invoke('server', 'forward', options, interrupted ? { FAIL_RELOAD: '1' } : {});
    expect(first.status, first.stderr).toBe(interrupted ? 1 : 0);
    const unit = readFileSync(path, 'utf8');
    expect(unit).toContain(`Description=Wayroost web app (${role})\n`);
    expect(unit).toContain(`Environment=WAYROOST_ROLE=${role}\n`);
    expect(unit).toContain(`StateDirectory=${role === 'primary' ? 'wayroost' : 'wayroost-shadow'}\n`);
    expect(unit).toContain(`ExecStart=${node} ${prefix}/dist/server/index.js\n`);
    expect(unit).toContain(`WorkingDirectory=${prefix}\n`);
    expect(unit).toContain(`LoadCredential=config.json:${config}\n`);
    expect(unit).toContain(credential + '\n');
    expect(existsSync(join(f.root, prefix, 'dist/server/index.js'))).toBe(true);
    f.success('server', 'forward', options);
    f.success('server', 'forward', options);
    expect(readFileSync(path, 'utf8')).toBe(unit);
    f.success('server', 'verify');
    f.success('server', 'reverse');
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(existsSync(join(f.root, prefix, 'dist/server/index.js'))).toBe(false);
  });

  it.each(['fresh', 'template', 'minimal', 'config-only', 'optional', 'reset'].flatMap(source =>
    [false, true].map(interrupted => ({ source, interrupted }))))('publishes identical server units on retries: $source, interrupted=$interrupted', ({ source, interrupted }) => {
    const f = fixture();
    const path = join(f.root, 'etc/systemd/system/wayroost-server.service');
    const original = source === 'template' ? readFileSync('deploy/wayroost-server.service', 'utf8')
      : source === 'config-only' ? `[Service]\nLoadCredential=config.json:${hostPaths.config}/config.json\n`
      : source === 'optional' || source === 'reset'
        ? `[Service]\n${source === 'reset' ? 'LoadCredential=\nSupplementaryGroups=\n' : ''}LoadCredential=helper-token:${hostPaths.config}/helper.token\nSupplementaryGroups=wayroost signalbox-voice\n`
        : '[Service]\n';
    if (source !== 'fresh') {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, original);
    }
    const flags = ['--publish-unit', '--config-path', '/etc/demo-wayroost/config.json'];
    const first = f.invoke('server', 'forward', flags, interrupted ? { FAIL_RELOAD: '1' } : {});
    expect(first.status, first.stderr).toBe(interrupted ? 1 : 0);
    if (interrupted) expect(first.stderr).toContain('The requested systemctl operation failed.');
    const published = readFileSync(path);
    expect(JSON.parse(readFileSync(f.receipt('server'), 'utf8')).status).toBe(interrupted ? 'applying' : 'applied');
    f.success('server', 'forward', flags);
    f.success('server', 'forward', flags);
    expect(readFileSync(path)).toEqual(published);
    expect(readFileSync(path, 'utf8')).toContain('LoadCredential=config.json:/etc/demo-wayroost/config.json');
    f.success('server', 'verify');
    f.success('server', 'reverse');
    if (source === 'fresh') expect(existsSync(path)).toBe(false);
    else expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it.each(['plain', 'quoted', 'reset'])('updates the controlled config credential while preserving optional wiring: %s', syntax => {
    const f = fixture();
    const path = join(f.root, 'etc/systemd/system/wayroost-server.service');
    mkdirSync(join(path, '..'), { recursive: true });
    const credential = syntax === 'quoted' ? `LoadCredential = "config.json:${hostPaths.config}/config.json"`
      : `LoadCredential=config.json:${hostPaths.config}/config.json`;
    const optional = `LoadCredential=helper-token:${hostPaths.config}/helper.token`;
    const original = `[Service]\n${syntax === 'reset' ? 'LoadCredential=\n' : ''}${credential}\n${optional}\nSupplementaryGroups=wayroost signalbox-voice\n`;
    writeFileSync(path, original);
    const flags = ['--publish-unit', '--publish-config', '--config-source', f.sourceConfig, '--config-path', '/etc/demo-wayroost/config.json'];
    f.success('server', 'forward', flags);
    f.success('server', 'forward', flags);
    const unit = readFileSync(path, 'utf8');
    expect(unit).toContain('LoadCredential=config.json:/etc/demo-wayroost/config.json');
    expect(unit).not.toContain(`config.json:${hostPaths.config}/config.json`);
    expect(unit.match(/LoadCredential\s*=\s*"?config\.json:/g)).toHaveLength(1);
    expect(unit).toContain(optional);
    expect(unit).toContain('SupplementaryGroups=wayroost signalbox-voice');
    expect(readFileSync(join(f.root, 'etc/demo-wayroost/config.json'))).toEqual(readFileSync(f.sourceConfig));
    f.success('server', 'verify');
    f.success('server', 'reverse');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it.each(['/usr/local/bin/node', '/opt/node22/bin/node', `/opt/demo-node/opt/wayroost/server${hostPaths.config}/config.json/bin/node`])('retains the installed server Node executable %s', executable => {
    const f = fixture();
    const path = join(f.root, 'etc/systemd/system/wayroost-server.service');
    mkdirSync(join(path, '..'), { recursive: true });
    const original = readFileSync('deploy/wayroost-server.service', 'utf8').replace('/usr/bin/node', executable);
    writeFileSync(path, original);
    const flags = ['--publish-unit', '--prefix', '/opt/wayroost/demo-server'];
    f.success('server', 'forward', flags);
    f.success('server', 'forward', flags);
    expect(readFileSync(path, 'utf8')).toContain(`ExecStart=${executable} /opt/wayroost/demo-server/dist/server/index.js`);
    f.success('server', 'verify');
    f.success('server', 'reverse');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('resolves Node from PATH when publishing a new server unit', () => {
    const f = fixture();
    writeFileSync(join(f.binaries, 'node'), '#!/usr/bin/env bash\nset -euo pipefail\nexit 94\n', { mode: 0o755 });
    f.success('server', 'forward', ['--publish-unit']);
    expect(readFileSync(join(f.root, 'etc/systemd/system/wayroost-server.service'), 'utf8'))
      .toContain(`ExecStart=${join(f.binaries, 'node')} /opt/wayroost/server/dist/server/index.js`);
    f.success('server', 'verify');
  });

  it('explains a missing Node when publishing the CLI', () => {
    const f = fixture();
    // Only the tools the installer needs, so no node is found on PATH.
    const tools = join(f.folder, 'tools');
    mkdirSync(tools);
    for (const tool of ['bash', 'python3', 'readlink', 'dirname', 'env']) symlinkSync(`/usr/bin/${tool}`, join(tools, tool));
    const result = f.invoke('server', 'plan', ['--primary'], { PATH: `${f.binaries}:${tools}` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Publishing the wayroost CLI needs Node.js 22 or newer on PATH.');
  });

  it('preserves template paths inserted into the server prefix', () => {
    const f = fixture();
    const prefix = `/opt/wayroost/demo${hostPaths.config}/config.json/server`;
    const options = ['--prefix', prefix, '--config-path', `${hostPaths.config}/demo.json`, '--publish-unit'];
    f.success('server', 'forward', options);
    f.success('server', 'forward', options);
    const unit = readFileSync(join(f.root, 'etc/systemd/system/wayroost-server.service'), 'utf8');
    expect(unit).toContain(` ${prefix}/dist/server/index.js`);
    expect(unit).toContain(`WorkingDirectory=${prefix}\n`);
    expect(unit).toContain(`LoadCredential=config.json:${hostPaths.config}/demo.json`);
    f.success('server', 'verify');
    f.success('server', 'reverse');
  });

  it.each(['installed', 'PATH'])('refuses dollar signs in the $s server Node executable', source => {
    const f = fixture();
    const executable = join(f.binaries, '${MISSING}', 'node');
    mkdirSync(join(executable, '..'));
    writeFileSync(executable, '#!/bin/sh\nexit 94\n', { mode: 0o755 });
    if (source === 'installed') {
      mkdirSync(join(f.root, 'etc/systemd/system'), { recursive: true });
      writeFileSync(join(f.root, 'etc/systemd/system/wayroost-server.service'),
        readFileSync('deploy/wayroost-server.service', 'utf8').replace('/usr/bin/node', executable));
    }
    const result = f.invoke('server', 'forward', ['--publish-unit'],
      source === 'PATH' ? { PATH: `${join(executable, '..')}:${f.environmentFor().PATH}` } : {});
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('Node executable paths cannot contain whitespace or systemd delimiters.');
    expect(existsSync(f.receipt('server'))).toBe(false);
    expect(existsSync(f.target('server'))).toBe(false);
    expect(readFileSync(f.calls, 'utf8')).not.toMatch(/ (start|restart|daemon-reload) /);
  });

  it.each(['22', '21', 'invalid'])('validates a trusted Node symlink and its reported version: %s', version => {
    const f = fixture();
    const executable = join(f.binaries, 'node-real');
    writeFileSync(executable, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
    const linked = join(f.binaries, 'node');
    symlinkSync('node-real', linked);
    const result = pythonFunctions(`
original_lstat = Path.lstat
def root_lstat(path, *args, **kwargs):
    info = list(original_lstat(path, *args, **kwargs))
    info[4] = 0
    if not stat.S_ISLNK(info[0]): info[0] &= ~0o022
    return os.stat_result(info)
Path.lstat = root_lstat
server_node(sys.argv[1])
print('PASS trusted Node version')
`, [linked]);
    expect(result.status, result.stderr).toBe(version === '22' ? 0 : 1);
    if (version === '22') expect(result.stdout.trim()).toBe('PASS trusted Node version');
    else expect(result.stderr).toContain('Node.js 22 or newer is required');
  });

  it('refuses an untrusted intermediate Node symlink directory before execution', () => {
    const f = fixture();
    const executable = join(f.binaries, 'node-real');
    const marker = join(f.folder, 'executed');
    writeFileSync(executable, '#!/usr/bin/env bash\nset -euo pipefail\ntouch "$NODE_MARKER"\necho 22\n', { mode: 0o755 });
    const intermediate = join(f.folder, 'editable');
    mkdirSync(intermediate);
    symlinkSync('../bin/node-real', join(intermediate, 'node'));
    symlinkSync('../editable/node', join(f.binaries, 'node'));
    const result = pythonFunctions(`
original_lstat = Path.lstat
def root_lstat(path, *args, **kwargs):
    info = list(original_lstat(path, *args, **kwargs))
    info[4] = 1001 if path == Path(sys.argv[2]) else 0
    if not stat.S_ISLNK(info[0]): info[0] &= ~0o022
    return os.stat_result(info)
Path.lstat = root_lstat
os.environ['NODE_MARKER'] = sys.argv[3]
server_node(sys.argv[1])
`, [join(f.binaries, 'node'), intermediate, marker]);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('root-owned and not writable by others');
    expect(existsSync(marker)).toBe(false);
  });

  it('updates artifacts while preserving a primary config and unit byte for byte', () => {
    const f = fixture();
    const config = join(f.root, 'etc/wayroost/config.json');
    const unit = join(f.root, 'etc/systemd/system/wayroost-server.service');
    mkdirSync(join(config, '..'), { recursive: true });
    mkdirSync(join(unit, '..'), { recursive: true });
    const contents = readFileSync(f.sourceConfig);
    writeFileSync(config, contents, { mode: 0o600 });
    writeFileSync(unit, '[Service]\nEnvironment=WAYROOST_ROLE=primary\n');
    f.success('server', 'forward', ['--update-artifacts']);
    f.success('server', 'verify');
    expect(readFileSync(config)).toEqual(contents);
    expect(readFileSync(unit, 'utf8')).toBe('[Service]\nEnvironment=WAYROOST_ROLE=primary\n');
    expect(readFileSync(f.calls, 'utf8')).toBe('');
    f.success('server', 'reverse');
    expect(readFileSync(config)).toEqual(contents);
    expect(existsSync(f.target('server'))).toBe(false);
  });

  it.each(['fresh', 'older'] as const)('receipts the maintenance wrapper for a %s primary installation and reverses it exactly', previous => {
    const f = fixture();
    const wrapper = join(f.root, 'usr/local/sbin/wayroost');
    const original = '#!/bin/bash -p\ncase "$1" in pair) exit 0 ;; *) exit 2 ;; esac\n';
    if (previous === 'older') {
      mkdirSync(join(wrapper, '..'), { recursive: true });
      writeFileSync(wrapper, original, { mode: 0o700 });
    }
    const options = ['--publish-unit', '--publish-config', '--config-source', f.sourceConfig];
    f.success('server', 'plan', options);
    expect(existsSync(wrapper)).toBe(previous === 'older');
    if (previous === 'older') expect(readFileSync(wrapper, 'utf8')).toBe(original);
    f.success('server', 'forward', options);
    f.success('server', 'verify');
    const contents = readFileSync(wrapper, 'utf8');
    expect(contents).toContain('hold|release|quiet)');
    expect(contents).toContain(`CONFIG='${hostPaths.config}/config.json'`);
    expect(contents).toContain("PAIR_CODE='/opt/wayroost/server/dist/server/pair-code.js'");
    expect(contents).toContain("ID='/usr/bin/id'");
    expect(contents).not.toMatch(/@(NODE|PAIR_CODE|CONFIG|ID)@/);
    expect(statSync(wrapper).mode & 0o777).toBe(0o750);
    const receipt = JSON.parse(readFileSync(f.receipt('server'), 'utf8'));
    const entry = receipt.paths.find((item: { path: string }) => item.path === wrapper);
    expect(entry.new.hash).toBe(hash(contents));
    expect(entry.old?.hash ?? null).toBe(previous === 'older' ? hash(original) : null);
    expect(readFileSync(f.calls, 'utf8')).not.toMatch(/\b(enable|start|stop|restart)\b/);
    f.success('server', 'reverse');
    f.success('server', 'verify');
    expect(existsSync(wrapper)).toBe(previous === 'older');
    if (previous === 'older') {
      expect(readFileSync(wrapper, 'utf8')).toBe(original);
      expect(statSync(wrapper).mode & 0o777).toBe(0o700);
    }
  });

  it.each([false, true])('updates the primary wrapper using selected paths without service actions; publish unit: %s', publishUnit => {
    const f = fixture();
    f.defaults.server = f.server;
    const wrapper = join(f.root, 'usr/local/sbin/wayroost');
    const original = '#!/bin/bash -p\nexit 2\n';
    mkdirSync(join(wrapper, '..'), { recursive: true });
    writeFileSync(wrapper, original, { mode: 0o740 });
    const executable = join(f.binaries, 'node');
    writeFileSync(executable, '#!/bin/sh\nexit 94\n', { mode: 0o755 });
    const unit = join(f.root, 'etc/systemd/system/wayroost-server.service');
    const originalUnit = `[Service]\nEnvironment=WAYROOST_ROLE=primary\nExecStart=/opt/installed-node/bin/node /srv/demo-server/dist/server/index.js\n`;
    mkdirSync(join(unit, '..'), { recursive: true });
    writeFileSync(unit, originalUnit);
    const config = '/etc/demo-wayroost/primary.json';
    const options = ['--update-artifacts', '--publish-cli', '--prefix', '/srv/demo-server', '--config-path', config,
      ...(publishUnit ? ['--primary', '--publish-unit'] : [])];
    f.success('server', 'forward', options);
    f.success('server', 'forward', options);
    f.success('server', 'verify');
    const contents = readFileSync(wrapper, 'utf8');
    expect(contents).toContain(`NODE='${executable}'`);
    expect(contents).toContain(`CONFIG='${config}'`);
    expect(contents).toContain("PAIR_CODE='/srv/demo-server/dist/server/pair-code.js'");
    expect(contents).toContain('hold|release|quiet)');
    if (!publishUnit) {
      expect(readFileSync(unit, 'utf8')).toBe(originalUnit);
      expect(readFileSync(f.calls, 'utf8')).toBe('');
    }
    expect(readFileSync(f.calls, 'utf8')).not.toMatch(/\b(enable|start|stop|restart)\b/);
    f.success('server', 'reverse');
    expect(readFileSync(wrapper, 'utf8')).toBe(original);
    expect(statSync(wrapper).mode & 0o777).toBe(0o740);
    expect(readFileSync(unit, 'utf8')).toBe(originalUnit);
  });

  it('refuses a wrapper edit before reversing any primary publications', () => {
    const f = fixture();
    f.success('server', 'forward');
    const wrapper = join(f.root, 'usr/local/sbin/wayroost');
    writeFileSync(wrapper, '#!/bin/bash -p\nexit 3\n');
    expect(f.invoke('server', 'verify').status).toBe(1);
    expect(f.invoke('server', 'reverse').status).toBe(1);
    expect(existsSync(f.target('server'))).toBe(true);
  });

  it.each(['primary', 'shadow', 'environment file', 'unset environment', 'command prefix', 'empty mask', 'null mask', 'unit symlink', 'drop-in symlink']
    .flatMap(installation => [false, true].map(present => ({ installation, present }))))
  ('preserves wrapper presence=$present during role-less artifact updates with $installation', ({ installation, present }) => {
    const f = fixture();
    f.defaults.server = f.server;
    const wrapper = join(f.root, 'usr/local/sbin/wayroost');
    const original = '#!/bin/bash -p\nexit 2\n';
    if (present) {
      mkdirSync(join(wrapper, '..'), { recursive: true });
      writeFileSync(wrapper, original, { mode: 0o740 });
    }
    const unit = join(f.root, 'etc/systemd/system/wayroost-server.service');
    mkdirSync(join(unit, '..'), { recursive: true });
    const directives = installation === 'shadow' ? 'Environment=WAYROOST_ROLE=shadow\n'
      : installation === 'environment file' ? 'EnvironmentFile=/etc/example/role.env\n'
      : installation === 'unset environment' ? 'UnsetEnvironment=WAYROOST_ROLE\n' : '';
    if (installation === 'environment file') {
      mkdirSync(join(f.root, 'etc/example'));
      writeFileSync(join(f.root, 'etc/example/role.env'), 'WAYROOST_ROLE=shadow\n');
    }
    const originalUnit = installation === 'empty mask' ? '' : `[Service]\nEnvironment=WAYROOST_ROLE=primary\n${directives}ExecStart=${installation === 'command prefix' ? '-' : ''}/opt/installed-node/bin/node /srv/demo-server/dist/server/index.js\n`;
    const outside = join(f.folder, 'outside-unit');
    if (installation === 'null mask') symlinkSync('/dev/null', unit);
    else if (installation === 'unit symlink') {
      writeFileSync(outside, originalUnit);
      symlinkSync(outside, unit);
    } else writeFileSync(unit, originalUnit);
    const dropIn = join(unit + '.d', '50-role.conf');
    mkdirSync(join(dropIn, '..'));
    if (installation === 'drop-in symlink') {
      writeFileSync(outside, 'Environment=WAYROOST_ROLE=shadow\n');
      symlinkSync(outside, dropIn);
    } else writeFileSync(dropIn, `[Service]\nEnvironment=WAYROOST_ROLE=primary\n${installation === 'command prefix' ? '' : 'ExecStart=/opt/override-node/bin/node /srv/demo-server/dist/server/index.js\n'}`);
    const unitBefore = lstatSync(unit);
    const dropInBefore = lstatSync(dropIn);
    const wrapperBefore = present ? statSync(wrapper) : undefined;
    for (const mode of ['plan', 'forward', 'forward', 'verify', 'reverse', 'verify']) {
      f.success('server', mode, ['--update-artifacts']);
      expect(existsSync(wrapper)).toBe(present);
      if (present) {
        expect(readFileSync(wrapper, 'utf8')).toBe(original);
        expect(statSync(wrapper)).toMatchObject({ ino: wrapperBefore!.ino, mode: wrapperBefore!.mode,
          uid: wrapperBefore!.uid, gid: wrapperBefore!.gid, mtimeMs: wrapperBefore!.mtimeMs });
      }
      expect(lstatSync(unit)).toMatchObject({ ino: unitBefore.ino, mode: unitBefore.mode });
      expect(lstatSync(dropIn)).toMatchObject({ ino: dropInBefore.ino, mode: dropInBefore.mode });
      expect(readFileSync(unit, 'utf8')).toBe(installation === 'null mask' ? '' : originalUnit);
    }
    const receipt = JSON.parse(readFileSync(f.receipt('server'), 'utf8'));
    expect(receipt.paths.some((entry: { path: string }) => entry.path === wrapper || entry.path === unit)).toBe(false);
    expect(readFileSync(f.calls, 'utf8')).toBe('');
    expect(existsSync(f.target('server'))).toBe(false);
  });

  it.each(['primary', 'flag', 'update flag'])('publishes the CLI only from invocation paths: %s', selection => {
    const f = fixture();
    f.defaults.server = f.server;
    const executable = join(f.binaries, 'node');
    writeFileSync(executable, '#!/bin/sh\nexit 94\n', { mode: 0o755 });
    const unit = join(f.root, 'etc/systemd/system/wayroost-server.service');
    mkdirSync(join(unit, '..'), { recursive: true });
    symlinkSync('/dev/null', unit);
    mkdirSync(unit + '.d');
    symlinkSync('/absent-demo.conf', join(unit + '.d', '50-node.conf'));
    const options = [...(selection === 'primary' ? ['--primary', '--publish-cli'] : selection === 'flag' ? ['--publish-cli'] : ['--update-artifacts', '--publish-cli']),
      '--prefix', '/srv/demo-server', '--config-path', '/etc/example-primary/config.json'];
    const wrapper = join(f.root, 'usr/local/sbin/wayroost');
    f.success('server', 'plan', options);
    expect(existsSync(wrapper)).toBe(false);
    f.success('server', 'forward', options);
    f.success('server', 'forward', options);
    f.success('server', 'verify');
    const contents = readFileSync(wrapper, 'utf8');
    expect(contents).toContain(`NODE='${executable}'`);
    expect(contents).toContain("PAIR_CODE='/srv/demo-server/dist/server/pair-code.js'");
    expect(contents).toContain("CONFIG='/etc/example-primary/config.json'");
    expect(contents).toContain('hold|release|quiet)');
    f.success('server', 'reverse');
    f.success('server', 'verify');
    expect(existsSync(wrapper)).toBe(false);
    expect(readlinkSync(unit)).toBe('/dev/null');
    expect(readFileSync(f.calls, 'utf8')).toBe('');
  });

  it.each(['plan', 'forward'])('refuses explicit CLI publication for a shadow in %s mode', mode => {
    const f = fixture();
    f.defaults.server = [...f.server, '--role', 'shadow'];
    const result = f.invoke('server', mode, ['--publish-cli', '--update-artifacts']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--publish-cli cannot be used with --role shadow.');
    expect(existsSync(f.receipt('server'))).toBe(false);
    expect(existsSync(f.target('server'))).toBe(false);
    expect(readFileSync(f.calls, 'utf8')).toBe('');
  });

  it.each(['unit', 'wrapper'])('refuses symlinks at the published %s path', kind => {
    const f = fixture();
    const path = join(f.root, kind === 'unit' ? 'etc/systemd/system/wayroost-server.service' : 'usr/local/sbin/wayroost');
    mkdirSync(join(path, '..'), { recursive: true });
    symlinkSync('/dev/null', path);
    const result = f.invoke('server', 'forward', kind === 'unit' ? ['--publish-unit'] : ['--publish-cli']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing a symlink in a deployment path.');
    expect(readlinkSync(path)).toBe('/dev/null');
    expect(existsSync(f.target('server'))).toBe(false);
  });

  it.each(['before', 'after'] as const)('resumes primary wrapper publication interrupted %s its atomic replacement', boundary => {
    const f = fixture();
    const wrapper = join(f.root, 'usr/local/sbin/wayroost');
    const original = '#!/bin/bash -p\nexit 2\n';
    mkdirSync(join(wrapper, '..'), { recursive: true });
    writeFileSync(wrapper, original, { mode: 0o700 });
    const replace = '        os.replace(temporary, path)';
    const interrupt = `        if path == Path(${JSON.stringify(wrapper)}): os._exit(77)`;
    pythonShim(f, [[replace, boundary === 'before' ? `${interrupt}\n${replace}` : `${replace}\n${interrupt}`]]);
    const result = f.invoke('server', 'forward');
    expect(result.status, result.stderr).toBe(77);
    expect(readFileSync(wrapper, 'utf8') === original).toBe(boundary === 'before');
    expect(JSON.parse(readFileSync(f.receipt('server'), 'utf8')).status).toBe('applying');
    rmSync(join(f.binaries, 'python3'));
    f.success('server', 'forward');
    f.success('server', 'verify');
    expect(readFileSync(wrapper, 'utf8')).toContain('hold|release|quiet)');
    f.success('server', 'reverse');
    expect(readFileSync(wrapper, 'utf8')).toBe(original);
    expect(statSync(wrapper).mode & 0o777).toBe(0o700);
  });

  it('preserves shell delimiters and template markers literally in wrapper paths', () => {
    const f = fixture();
    const executable = join(f.binaries, 'demo-@CONFIG@', 'node');
    mkdirSync(join(executable, '..'));
    writeFileSync(executable, '#!/bin/sh\nexit 94\n', { mode: 0o755 });
    const unit = join(f.root, 'etc/systemd/system/wayroost-server.service');
    mkdirSync(join(unit, '..'), { recursive: true });
    writeFileSync(unit, `[Service]\nExecStart=${executable} /srv/demo-server/dist/server/index.js\n`);
    const prefix = "/srv/demo'$(printf demo)@CONFIG@";
    const config = "/etc/demo'$(printf demo)@NODE@/primary.json";
    const options = ['--prefix', prefix, '--config-path', config];
    const resultWithPaths = f.invoke('server', 'forward', options, { PATH: `${join(executable, '..')}:${f.environmentFor().PATH}` });
    expect(resultWithPaths.status, resultWithPaths.stderr).toBe(0);
    const contents = readFileSync(join(f.root, 'usr/local/sbin/wayroost'), 'utf8');
    const assignments = contents.split('\nusage()')[0]!;
    const result = spawnSync('/bin/bash', ['-p', '-c', assignments + '\nprintf "%s\\0" "$NODE" "$PAIR_CODE" "$CONFIG" "$ID"'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split('\0')).toEqual([executable, `${prefix}/dist/server/pair-code.js`, config, '/usr/bin/id', '']);
    f.success('server', 'reverse');
  });

  it.each(['fresh', 'installed'] as const)('preserves a %s wrapper during explicit shadow publication', previous => {
    const f = fixture();
    f.defaults.server = [...f.server, '--role', 'shadow'];
    const wrapper = join(f.root, 'usr/local/sbin/wayroost');
    const original = '#!/bin/bash -p\nexit 2\n';
    if (previous === 'installed') {
      mkdirSync(join(wrapper, '..'), { recursive: true });
      writeFileSync(wrapper, original, { mode: 0o700 });
    }
    f.success('server', 'forward', ['--update-artifacts', '--publish-unit']);
    f.success('server', 'verify');
    expect(existsSync(wrapper)).toBe(previous === 'installed');
    if (previous === 'installed') expect(readFileSync(wrapper, 'utf8')).toBe(original);
    f.success('server', 'reverse');
    expect(existsSync(wrapper)).toBe(previous === 'installed');
    if (previous === 'installed') expect(readFileSync(wrapper, 'utf8')).toBe(original);
  });

  it('publishes prepared primary config and unit only by flags and restarts only when requested', () => {
    const f = fixture();
    const options = ['--publish-config', '--config-source', f.sourceConfig, '--publish-unit', '--restart'];
    f.success('server', 'plan', options);
    expect(readFileSync(f.calls, 'utf8')).not.toContain('restart');
    f.success('server', 'forward', options);
    f.success('server', 'verify');
    expect(readFileSync(join(f.root, 'etc/wayroost/config.json'))).toEqual(readFileSync(f.sourceConfig));
    const unit = readFileSync(join(f.root, 'etc/systemd/system/wayroost-server.service'), 'utf8');
    expect(unit).toContain('Environment=WAYROOST_ROLE=primary');
    expect(unit).toContain('StateDirectory=wayroost\n');
    expect(unit).not.toContain('shadow');
    expect(readFileSync(f.calls, 'utf8')).toContain('restart wayroost-server.service');
    expect(readFileSync(f.calls, 'utf8')).not.toMatch(/\b(enable|start|stop|npm)\b/);
    f.success('server', 'reverse');
    expect(existsSync(join(f.root, 'etc/wayroost/config.json'))).toBe(false);
  });

  it('requires a prepared config with matching role and accepts no implicit config publication', () => {
    const f = fixture();
    expect(f.invoke('server', 'forward', ['--config-source', f.sourceConfig]).status).toBe(1);
    expect(f.invoke('server', 'forward', ['--publish-config']).status).toBe(1);
    writeFileSync(f.sourceConfig, '{"role":"shadow"}');
    expect(f.invoke('server', 'forward', ['--publish-config', '--config-source', f.sourceConfig]).status).toBe(1);
    expect(existsSync(f.target('server'))).toBe(false);
  });

  it('keeps the original no-new-flags shadow plan, including normalization and service actions', () => {
    const f = fixture();
    mkdirSync(join(f.root, 'etc/wayroost'), { recursive: true });
    const config = join(f.root, 'etc/wayroost/config.json');
    const before = readFileSync(f.sourceConfig);
    writeFileSync(config, before);
    const result = spawnSync('bash', ['deploy/install-wayroost-server.sh', '--dry-run', '--root', f.root], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"role": "shadow"');
    expect(result.stdout).toContain('Environment=WAYROOST_ROLE=shadow');
    expect(result.stdout).toContain('systemctl enable wayroost-server.service');
    expect(result.stdout).toContain('systemctl restart wayroost-server.service');
    expect(result.stdout).toContain('ci --prefix');
    expect(readFileSync(config)).toEqual(before);
  });
});

describe('publication recovery and isolation', () => {
  it.each<Installer>(['runtime', 'helper', 'server'])('refuses a completed %s forward after a new publication is removed', kind => {
    const f = fixture();
    f.success(kind, 'forward');
    rmSync(f.target(kind));
    const result = f.invoke(kind, 'forward');
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).not.toContain('PASS');
    expect(existsSync(f.target(kind))).toBe(false);
    expect(f.invoke(kind, 'verify').status).toBe(1);
  });

  it('refuses a completed forward after its requested enablement is removed', () => {
    const f = fixture();
    f.success('helper', 'forward', ['--enable', '--start']);
    const link = join(f.root, 'etc/systemd/system/multi-user.target.wants/wayroost-helper.service');
    rmSync(link);
    const result = f.invoke('helper', 'forward', ['--enable', '--start']);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(f.calls, 'utf8').match(/ start wayroost-helper.service/g)).toHaveLength(1);
  });

  it('checks completed enablement even when no enablement link was published', () => {
    const f = fixture();
    f.success('helper', 'forward');
    const stub = join(f.binaries, 'systemctl');
    writeFileSync(stub, readFileSync(stub, 'utf8').replace('echo disabled; exit 1;', 'echo not-found; exit 4;'));
    const result = f.invoke('helper', 'forward');
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).not.toContain('PASS');
  });

  it('recovers reverse temporaries for a nondefault original group before changing ownership', () => {
    const f = fixture();
    const path = f.target('runtime');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'published bytes\n');
    const result = pythonFunctions(`
path = Path(sys.argv[1])
temporary = path.parent / ('.wayroost-' + 'b' * 32)
owner = {'uid': os.geteuid(), 'gid': os.getegid()}
original = {'kind': 'file', 'mode': '0640', 'owner': {'uid': owner['uid'], 'gid': owner['gid'] + 1}}
receipt = {'paths': [{'path': str(path), 'old': original, 'new': {'kind': 'file', 'mode': '0644', 'owner': owner},
                      'reverseTemporary': str(temporary)}]}
pid = os.fork()
if pid == 0:
    os.fchown = lambda *args: os._exit(77)
    atomic(path, b'original bytes\\n', 0o640, original['owner'], temporary)
    os._exit(78)
assert os.waitpid(pid, 0)[1] == 77 << 8
assert temporary.stat().st_gid == owner['gid']
recover_temporaries(receipt, path.parent, owner)
assert not temporary.exists()
assert path.read_bytes() == b'published bytes\\n'
print('PASS reverse creation ownership recovered')
`, [path]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('PASS reverse creation ownership recovered');
  });

  it.each(['helper', 'server'] as const)('handles an absent %s unit with empty stdout and a missing-file error', kind => {
    const f = fixture();
    const flags = kind === 'server' ? ['--publish-unit'] : [];
    f.success(kind, 'forward', flags);
    f.success(kind, 'verify');
    const receipt = JSON.parse(readFileSync(f.receipt(kind), 'utf8'));
    expect(receipt.units).toEqual([{ name: `wayroost-${kind}.service`, old: 'not-found', new: 'disabled' }]);
    f.success(kind, 'reverse');
    f.success(kind, 'verify');
    expect(existsSync(join(f.root, `etc/systemd/system/wayroost-${kind}.service`))).toBe(false);
  });

  it.each(['Permission denied', 'Failed to connect to bus: No such file or directory'])('refuses a unit query failure: %s', message => {
    const f = fixture();
    writeFileSync(join(f.binaries, 'systemctl'), `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' '${message}' >&2\nexit 1\n`, { mode: 0o755 });
    const result = f.invoke('helper', 'forward');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot determine unit enablement state');
    expect(existsSync(f.target('helper'))).toBe(false);
  });

  it.each(['install-wayroost-runtime.sh', 'setup-wayroost-helper.sh', 'install-wayroost-server.sh', 'wayroost-lib.sh', 'lib.sh', 'wayroost-helper.service', 'wayroost-server.service', 'wayroost.sh'])('requires trusted ownership and ancestors for %s', name => {
    const f = fixture();
    const directory = join(f.folder, 'installer');
    mkdirSync(directory, { mode: 0o755 });
    const file = join(directory, name);
    writeFileSync(file, '[Service]\nExecStartPre=+/bin/false\n', { mode: 0o644 });
    const check = (untrusted: string) => pythonFunctions(`
original_stat = Path.stat
def root_stat(path, *args, **kwargs):
    info = list(original_stat(path, *args, **kwargs))
    info[4] = 1 if str(path) == sys.argv[2] else 0
    return os.stat_result(info)
Path.stat = root_stat
trusted_file(Path(sys.argv[1]))
`, [file, untrusted]);
    expect(check('').status).toBe(0);
    expect(check(file).status).toBe(1);
    expect(check(directory).status).toBe(1);
    chmodSync(file, 0o666);
    expect(check('').status).toBe(1);
    chmodSync(file, 0o644);
    chmodSync(directory, 0o777);
    expect(check('').status).toBe(1);
    chmodSync(directory, 0o755);
    symlinkSync(file, join(directory, 'linked.service'));
    const linked = pythonFunctions('trusted_file(Path(sys.argv[1]))', [join(directory, 'linked.service')]);
    expect(linked.status).toBe(1);
  });

  it('preserves installed server credential and supplementary-group wiring during a primary upgrade', () => {
    const f = fixture();
    const path = join(f.root, 'etc/systemd/system/wayroost-server.service');
    mkdirSync(join(path, '..'), { recursive: true });
    const credentials = [`LoadCredential=paseo-password:${hostPaths.config}/paseo-password`,
      `LoadCredential=helper-token:${hostPaths.config}/helper.token`, `LoadCredential=safety-helper-key:${hostPaths.config}/safety-helper-key`];
    const groups = 'SupplementaryGroups = wayroost signalbox-voice wayroost-voice-cloud';
    const original = readFileSync('deploy/wayroost-server.service', 'utf8')
      .replace('Restart=on-failure', credentials.join('\n') + '\nRestart=on-failure')
      .replace('SupplementaryGroups=wayroost', groups);
    writeFileSync(path, original);
    const credentialDirectory = join(f.root, 'etc/wayroost');
    mkdirSync(credentialDirectory, { recursive: true });
    writeFileSync(join(credentialDirectory, 'paseo-password'), 'sentinel-credential-bytes', { mode: 0o000 });
    const output = f.success('server', 'forward', ['--publish-unit']);
    const unit = readFileSync(path, 'utf8');
    for (const line of [...credentials, groups]) expect(unit).toContain(line);
    expect(unit).toContain('Environment=WAYROOST_ROLE=primary');
    expect(unit).toContain('StateDirectory=wayroost\n');
    expect(unit).toContain('ProtectSystem=strict');
    expect(unit).toContain('ProtectHome=yes');
    expect(output + readFileSync(f.receipt('server'), 'utf8')).not.toContain('sentinel-credential-bytes');
    f.success('server', 'verify');
    f.success('server', 'reverse');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it.each(['helper', 'server'] as const)('refuses an editable %s template before publication', kind => {
    const f = fixture();
    const installer = join(f.folder, 'installer');
    const deploy = join(installer, 'deploy');
    mkdirSync(deploy, { recursive: true });
    if (kind === 'server') writeFileSync(join(deploy, 'wayroost.sh'), readFileSync('deploy/wayroost.sh'), { mode: 0o644 });
    writeFileSync(join(deploy, `wayroost-${kind}.service`), '[Service]\nExecStartPre=+/bin/false\n', { mode: 0o666 });
    pythonShim(f, [['if not root:\n                trusted_file(path)', 'trusted_file(path)']], `sys.argv[1] = ${JSON.stringify(installer)}`);
    const result = f.invoke(kind, 'forward', kind === 'server' ? ['--publish-unit'] : []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Installer files and their ancestors must be root-owned');
    expect(existsSync(f.target(kind))).toBe(false);
  });

  it.each(['create', 'flush'] as const)('recovers a journalled publication temporary after interruption at %s', boundary => {
    const f = fixture();
    const before = boundary === 'create' ? "with os.fdopen(handle, 'wb') as stream:" : 'stream.flush()';
    const after = boundary === 'create'
      ? `if str(path).endswith('/signalbox-helper.py'): os._exit(77)\n        ${before}`
      : `${before}\n            if str(path).endswith('/signalbox-helper.py'): os._exit(77)`;
    pythonShim(f, [[before, after]]);
    expect(f.invoke('runtime', 'forward').status).toBe(77);
    const directory = join(f.target('runtime'), '..');
    const temporary = readdirSync(directory).find(name => name.startsWith('.wayroost-'))!;
    expect(temporary).toBeDefined();
    const receipt = JSON.parse(readFileSync(f.receipt('runtime'), 'utf8'));
    expect(receipt.paths.find((entry: { path: string }) => entry.path === f.target('runtime')).temporary).toBe(join(directory, temporary));
    rmSync(join(f.binaries, 'python3'));
    f.success('runtime', 'forward');
    expect(readdirSync(directory).some(name => name.startsWith('.wayroost-'))).toBe(false);
    f.success('runtime', 'verify');
    f.success('runtime', 'reverse');
    expect(existsSync(directory)).toBe(false);
  });

  it('reverses an interrupted publication directly and refuses unidentified temporaries', () => {
    const f = fixture();
    const before = "with os.fdopen(handle, 'wb') as stream:";
    pythonShim(f, [[before, `if str(path).endswith('/signalbox-helper.py'): os._exit(77)\n        ${before}`]]);
    expect(f.invoke('runtime', 'forward').status).toBe(77);
    rmSync(join(f.binaries, 'python3'));
    const directory = join(f.target('runtime'), '..');
    const unrelated = join(directory, '.wayroost-' + 'a'.repeat(32));
    writeFileSync(unrelated, 'unrelated temporary', { mode: 0o600 });
    expect(f.invoke('runtime', 'reverse').status).toBe(1);
    expect(readFileSync(unrelated, 'utf8')).toBe('unrelated temporary');
    rmSync(unrelated);
    f.success('runtime', 'reverse');
    f.success('runtime', 'verify');
    expect(existsSync(directory)).toBe(false);
  });

  it('refuses a journalled temporary with an added hard link', () => {
    const f = fixture();
    const before = "with os.fdopen(handle, 'wb') as stream:";
    pythonShim(f, [[before, `if str(path).endswith('/signalbox-helper.py'): os._exit(77)\n        ${before}`]]);
    expect(f.invoke('runtime', 'forward').status).toBe(77);
    rmSync(join(f.binaries, 'python3'));
    const directory = join(f.target('runtime'), '..');
    const temporary = join(directory, readdirSync(directory).find(name => name.startsWith('.wayroost-'))!);
    const extraLink = join(f.folder, 'extra-link');
    linkSync(temporary, extraLink);
    expect(f.invoke('runtime', 'reverse').status).toBe(1);
    expect(existsSync(temporary)).toBe(true);
    rmSync(extraLink);
    f.success('runtime', 'reverse');
  });

  it('recovers interrupted reverse and enablement-link temporaries', () => {
    const f = fixture();
    mkdirSync(join(f.target('runtime'), '..'), { recursive: true });
    writeFileSync(f.target('runtime'), 'original bytes\n', { mode: 0o640 });
    f.success('runtime', 'forward');
    const before = "with os.fdopen(handle, 'wb') as stream:";
    pythonShim(f, [[before, `if str(path).endswith('/signalbox-helper.py'): os._exit(77)\n        ${before}`]]);
    expect(f.invoke('runtime', 'reverse').status).toBe(77);
    rmSync(join(f.binaries, 'python3'));
    f.success('runtime', 'reverse');
    expect(readFileSync(f.target('runtime'), 'utf8')).toBe('original bytes\n');
    const link = 'os.symlink(value, temporary)';
    pythonShim(f, [[link, `${link}\n        os._exit(77)`]]);
    expect(f.invoke('helper', 'forward', ['--enable']).status).toBe(77);
    rmSync(join(f.binaries, 'python3'));
    f.success('helper', 'reverse', ['--enable']);
    f.success('helper', 'verify');
  });

  it('recovers interrupted undo-copy creation before touching the original publication', () => {
    const f = fixture();
    mkdirSync(join(f.target('runtime'), '..'), { recursive: true });
    writeFileSync(f.target('runtime'), 'original bytes\n', { mode: 0o640 });
    const before = "with os.fdopen(handle, 'wb') as stream:";
    pythonShim(f, [[before, `if '/receipts-undo/' in str(path): os._exit(77)\n        ${before}`]]);
    expect(f.invoke('runtime', 'forward').status).toBe(77);
    expect(readFileSync(f.target('runtime'), 'utf8')).toBe('original bytes\n');
    const receipt = JSON.parse(readFileSync(f.receipt('runtime'), 'utf8'));
    const entry = receipt.paths.find((entry: { path: string }) => entry.path === f.target('runtime'));
    expect(existsSync(entry.backupTemporary)).toBe(true);
    rmSync(join(f.binaries, 'python3'));
    f.success('runtime', 'forward');
    expect(existsSync(entry.backupTemporary)).toBe(false);
    f.success('runtime', 'reverse');
    expect(readFileSync(f.target('runtime'), 'utf8')).toBe('original bytes\n');
  });

  it('recovers an interrupted directory publication before applying its final metadata', () => {
    const f = fixture();
    const before = 'temporary.mkdir(mode=0o700)';
    pythonShim(f, [[before, `${before}\n        if path.name == 'wayroost': os._exit(77)`]]);
    expect(f.invoke('runtime', 'forward').status).toBe(77);
    const receipt = JSON.parse(readFileSync(f.receipt('runtime'), 'utf8'));
    const entry = receipt.paths.find((entry: { path: string }) => entry.path === join(f.root, 'opt/wayroost'));
    expect(existsSync(entry.temporary)).toBe(true);
    expect(existsSync(entry.path)).toBe(false);
    rmSync(join(f.binaries, 'python3'));
    f.success('runtime', 'forward');
    expect(existsSync(entry.temporary)).toBe(false);
    f.success('runtime', 'verify');
    f.success('runtime', 'reverse');
  });

  it('serializes overlapping publications across separate receipt stores', async () => {
    const f = fixture();
    const paused = join(f.folder, 'paused');
    const release = join(f.folder, 'release');
    const secondStarted = join(f.folder, 'second-started');
    const boundary = "for entry in entries:\n            path = Path(entry['path'])";
    pythonShim(f, [[boundary, `if os.environ.get('PAUSE_PUBLICATION') == '1':\n            Path(${JSON.stringify(paused)}).touch()\n            while not Path(${JSON.stringify(release)}).exists(): time.sleep(0.01)\n        ${boundary}`]],
      `if os.environ.get('SECOND_PUBLICATION') == '1': Path(${JSON.stringify(secondStarted)}).touch()`);
    const first = spawn('bash', f.argumentsFor('runtime', 'forward'), { env: f.environmentFor({ PAUSE_PUBLICATION: '1' }), stdio: 'pipe' });
    const completed = (child: ReturnType<typeof spawn>) => new Promise<number | null>(resolve => child.once('close', resolve));
    const firstDone = completed(first);
    let second: ReturnType<typeof spawn> | undefined;
    let secondDone: Promise<number | null> | undefined;
    try {
      await waitForFile(paused);
      const source = f.runtime[1]!;
      writeFileSync(join(source, 'bin/signalbox-helper.py'), '# second publication\n');
      const manifest = runtimeFiles.map(name => `${hash(readFileSync(join(source, 'bin', name)))}  bin/${name}\n`).join('');
      writeFileSync(join(source, 'SHA256SUMS'), manifest);
      const options = ['--receipts', '/var/lib/other-receipts', '--receipt', 'second', '--manifest-sha256', hash(manifest)];
      second = spawn('bash', f.argumentsFor('runtime', 'forward', options), { env: f.environmentFor({ SECOND_PUBLICATION: '1' }), stdio: 'pipe' });
      secondDone = completed(second);
      await waitForFile(secondStarted);
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(existsSync(join(f.root, 'var/lib/other-receipts/second.json'))).toBe(false);
      expect(existsSync(f.target('runtime'))).toBe(false);
      writeFileSync(release, '');
      expect(await firstDone).toBe(0);
      expect(await secondDone).toBe(0);
      const receipt = JSON.parse(readFileSync(join(f.root, 'var/lib/other-receipts/second.json'), 'utf8'));
      const original = `# prepared signalbox-helper.py\n`;
      expect(receipt.paths.find((entry: { path: string }) => entry.path === f.target('runtime')).old.hash).toBe(hash(original));
      f.success('runtime', 'reverse', ['--receipts', '/var/lib/other-receipts', '--receipt', 'second']);
      expect(readFileSync(f.target('runtime'), 'utf8')).toBe(original);
      f.success('runtime', 'verify');
      f.success('runtime', 'reverse');
    } finally {
      writeFileSync(release, '');
      first.kill('SIGKILL');
      second?.kill('SIGKILL');
      await Promise.all([firstDone, secondDone]);
    }
  });

  it.each(['opt', 'var/lib'])('applies recorded ownership and mode to directories under a setgid parent: %s', parentPath => {
    const f = fixture();
    const parent = join(f.root, parentPath);
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, 0o2755);
    const flags = parentPath === 'var/lib' ? ['--prefix', '/var/lib/runtime'] : [];
    f.success('runtime', 'forward', flags);
    const receipt = JSON.parse(readFileSync(f.receipt('runtime'), 'utf8'));
    for (const entry of receipt.paths.filter((entry: { new: { kind: string } }) => entry.new.kind === 'directory')) {
      const info = statSync(entry.path);
      expect(info.mode & 0o7777).toBe(0o755);
      expect({ uid: info.uid, gid: info.gid }).toEqual(entry.new.owner);
    }
    f.success('runtime', 'forward', flags);
    f.success('runtime', 'verify');
    f.success('runtime', 'reverse');
    expect(statSync(parent).mode & 0o7777).toBe(0o2755);
  });

  it('writes full receipts only for meaningful transaction state transitions', () => {
    const f = fixture();
    const source = f.runtime[1]!;
    let manifest = readFileSync(join(source, 'SHA256SUMS'), 'utf8');
    for (let index = 0; index < 100; index++) {
      const name = `bin/dependency-${index}.mjs`;
      const data = 'export {};\n';
      writeFileSync(join(source, name), data);
      manifest += `${hash(data)}  ${name}\n`;
    }
    writeFileSync(join(source, 'SHA256SUMS'), manifest);
    f.defaults.runtime = ['--from', source, '--manifest-sha256', hash(manifest), '--role', 'primary'];
    const counts = join(f.folder, 'receipt-writes');
    pythonShim(f, [['def save():\n', `def save():\n            with open(${JSON.stringify(counts)}, 'a') as counter: counter.write(receipt['status'] + '\\n')\n`]]);
    f.success('runtime', 'forward');
    expect(readFileSync(counts, 'utf8').trim().split('\n')).toEqual(['applying', 'applied']);
    f.success('runtime', 'forward');
    expect(readFileSync(counts, 'utf8').trim().split('\n')).toEqual(['applying', 'applied']);
    f.success('runtime', 'verify');
    f.success('runtime', 'reverse');
    expect(readFileSync(counts, 'utf8').trim().split('\n')).toEqual(['applying', 'applied', 'reversing', 'reversed']);
  });
});

describe('systemd source syntax', () => {
  it.each([
    { name: 'one leading BOM', input: '\ufeff[Service]\n', expected: ['[Service]', ''] },
    { name: 'two leading BOMs', input: '\ufeff\ufeff[Service]\n', expected: ['\ufeff[Service]', ''] },
    { name: 'a later-line BOM', input: '[Service]\n\ufeffEnvironment=DEMO_PATH=sentinel',
      expected: ['[Service]', 'Environment=DEMO_PATH=sentinel'] },
    { name: 'a second line-leading BOM', input: '\ufeff[Service]\n\ufeffEnvironment=DEMO_PATH=sentinel',
      expected: ['[Service]', '\ufeffEnvironment=DEMO_PATH=sentinel'] },
    { name: 'a BOM before a continued hash comment', input: '\ufeff# comment\\\n[Service]\nEnvironment=DEMO_PATH=sentinel',
      expected: ['# comment [Service]', 'Environment=DEMO_PATH=sentinel'] },
    { name: 'a BOM before a continued semicolon comment', input: '\ufeff; comment\\\n[Service]\nEnvironment=DEMO_PATH=sentinel',
      expected: ['; comment [Service]', 'Environment=DEMO_PATH=sentinel'] },
    { name: 'whitespace before a BOM', input: ' \ufeff[Service]\n', expected: [' \ufeff[Service]', ''] },
  ])('limits BOM stripping for $name', ({ input, expected }) => {
    const result = pythonFunctions(`assert list(systemd_lines(${JSON.stringify(input)})) == ${JSON.stringify(expected)}`);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(['#', ';', ' \t#', '\t ;'])('passes standalone comments through unchanged: %j', comment => {
    const lines = [`${comment} sentinel\\`, 'Environment=DEMO_PATH=sentinel'];
    const result = pythonFunctions(`assert list(systemd_lines(${JSON.stringify(lines.join('\n'))})) == ${JSON.stringify(lines)}`);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each((['helper', 'server'] as const).flatMap(kind => [
    { name: 'hash comment', header: '[Service]\n', before: '# comment\\\n' },
    { name: 'semicolon comment', header: '[Service]\n', before: '; comment\\\n' },
    { name: 'indented hash comment', header: '[Service]\n', before: ' \t# comment\\\n' },
    { name: 'indented semicolon comment', header: '[Service]\n', before: '\t ; comment\\\n' },
    { name: 'first-line BOM', header: '\ufeff[Service]\n', before: '' },
  ].map(row => ({ kind, ...row }))))('preserves $kind directives after a $name', ({ kind, header, before }) => {
    const f = fixture();
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    const path = kind === 'helper' ? join(source, '20-values.conf') : join(f.root, 'etc/systemd/system/wayroost-server.service');
    mkdirSync(join(path, '..'), { recursive: true });
    const directive = kind === 'helper' ? 'Environment=DEMO_PATH=sentinel-value'
      : `LoadCredential=paseo-password:${hostPaths.config}/paseo-password`;
    const original = `${header}${before}${directive}\n`;
    writeFileSync(path, original);
    const flags = kind === 'helper' ? ['--drop-ins', source, '--allow-environment', 'DEMO_PATH'] : ['--publish-unit'];
    const output = f.success(kind, 'forward', flags);
    const receipt = readFileSync(f.receipt(kind), 'utf8');
    if (kind === 'helper') {
      const imported = join(f.root, 'etc/systemd/system/wayroost-helper.service.d/50-imported-environment.conf');
      expect(readFileSync(imported, 'utf8')).toBe('[Service]\nEnvironment="DEMO_PATH=sentinel-value"\n');
      expect(JSON.parse(receipt).intent.environment).toEqual([{ key: 'DEMO_PATH', hash: hash('sentinel-value') }]);
      expect(output + receipt).not.toContain('sentinel-value');
    } else expect(readFileSync(path, 'utf8').split('\n')).toContain(directive);
    f.success(kind, 'forward', flags);
    f.success(kind, 'verify');
    f.success(kind, 'reverse');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it.each((['helper', 'server'] as const).flatMap(kind => [
    { name: 'a BOM before a continued hash comment', header: '\ufeff# comment\\\n[Service]\n', before: '', applies: false },
    { name: 'a BOM before a continued semicolon comment', header: '\ufeff; comment\\\n[Service]\n', before: '', applies: false },
    { name: 'a later-line first BOM on a directive', header: '[Service]\n', before: '\ufeff', applies: true },
    { name: 'a later-line first BOM on a section', header: '# comment\n\ufeff[Service]\n', before: '', applies: true },
    { name: 'a second line-leading BOM', header: '\ufeff[Service]\n', before: '\ufeff', applies: false },
    { name: 'a second BOM on the same line', header: '\ufeff\ufeff[Service]\n', before: '', applies: false },
  ].map(row => ({ kind, ...row }))))('parses $kind wiring with $name', ({ kind, header, before, applies }) => {
    const f = fixture();
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    const path = kind === 'helper' ? join(source, '20-values.conf') : join(f.root, 'etc/systemd/system/wayroost-server.service');
    mkdirSync(join(path, '..'), { recursive: true });
    const directive = kind === 'helper' ? 'Environment=DEMO_PATH=sentinel-value'
      : `LoadCredential=demo-token:${hostPaths.config}/demo-token`;
    const original = `${header}${before}${directive}\n`;
    writeFileSync(path, original);
    const flags = kind === 'helper' ? ['--drop-ins', source, '--allow-environment', 'DEMO_PATH'] : ['--publish-unit'];
    const output = f.success(kind, 'forward', flags);
    const receipt = readFileSync(f.receipt(kind), 'utf8');
    if (kind === 'helper') {
      const imported = join(f.root, 'etc/systemd/system/wayroost-helper.service.d/50-imported-environment.conf');
      expect(readFileSync(imported, 'utf8')).toBe(applies ? '[Service]\nEnvironment="DEMO_PATH=sentinel-value"\n' : '[Service]\n');
      expect(JSON.parse(receipt).intent.environment).toEqual(applies ? [{ key: 'DEMO_PATH', hash: hash('sentinel-value') }] : []);
      expect(output + receipt).not.toContain('sentinel-value');
    } else expect(readFileSync(path, 'utf8').split('\n').includes(directive)).toBe(applies);
    f.success(kind, 'forward', flags);
    f.success(kind, 'verify');
    f.success(kind, 'reverse');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
});

describe('helper drop-in syntax and writable skill roots', () => {
  it.each(['\\v', '\\x1b', '\\x7f'])('refuses decoded controls in an imported writable home: %s', escaped => {
    const f = fixture();
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    writeFileSync(join(source, '30-skills.conf'), `[Service]\nEnvironment="SIGNALBOX_SKILLS_WINDOWS_HOME=/mnt/c/Users/sentinel${escaped}User"\n`);
    const result = f.invoke('helper', 'forward', ['--drop-ins', source, '--allow-environment', 'SIGNALBOX_SKILLS_WINDOWS_HOME',
      '--writable-path', '/mnt/c/Users/DemoUser/.agents/skills']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Paths must be absolute, without parent traversal or control characters.');
    expect(result.stdout + result.stderr).not.toContain('sentinel');
    expect(existsSync(f.receipt('helper'))).toBe(false);
    expect(existsSync(f.target('helper'))).toBe(false);
  });

  it.each(['\v', '\f'])('preserves control characters in Environment values without granting writable paths: %j', value => {
    const f = fixture();
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    writeFileSync(join(source, '20-values.conf'), `[Service]\nEnvironment=DEMO_CONTROL=sentinel${value}tail\n`);
    const output = f.success('helper', 'forward', ['--drop-ins', source, '--allow-environment', 'DEMO_CONTROL']);
    const receipt = readFileSync(f.receipt('helper'), 'utf8');
    expect(JSON.parse(receipt).intent.environment).toEqual([{ key: 'DEMO_CONTROL', hash: hash(`sentinel${value}tail`) }]);
    const text = readFileSync(join(f.root, 'etc/systemd/system/wayroost-helper.service.d/50-imported-environment.conf'), 'utf8');
    expect(text).toContain(`Environment="DEMO_CONTROL=sentinel${value === '\v' ? '\\v' : '\\f'}tail"`);
    expect(text).not.toContain('ReadWritePaths=');
    expect(output + receipt).not.toContain('sentinel');
  });

  it.each([
    { name: 'blank line', input: 'DEMO_FIRST=sentinel\\\n\nEnvironment=DEMO_SECOND=tail', values: { DEMO_FIRST: 'sentinel', DEMO_SECOND: 'tail' } },
    { name: 'whitespace-only line', input: 'DEMO_FIRST=sentinel\\\n \t \nEnvironment=DEMO_SECOND=tail', values: { DEMO_FIRST: 'sentinel', DEMO_SECOND: 'tail' } },
    { name: 'indented quoted line', input: '"DEMO_FIRST=sentinel\\\n  tail"', values: { DEMO_FIRST: 'sentinel   tail' } },
    { name: 'escaped trailing backslash', input: 'DEMO_FIRST=sentinel\\\\\nEnvironment=DEMO_SECOND=tail', values: { DEMO_FIRST: 'sentinel\\', DEMO_SECOND: 'tail' } },
  ])('parses helper Environment continuations through a $name', ({ input, values }) => {
    const f = fixture();
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    const original = `[Service]\nEnvironment=${input}\n`;
    writeFileSync(join(source, '20-values.conf'), original);
    const flags = ['--drop-ins', source, '--allow-environment', 'DEMO_FIRST,DEMO_SECOND'];
    const output = f.success('helper', 'forward', flags);
    const receipt = readFileSync(f.receipt('helper'), 'utf8');
    expect(JSON.parse(receipt).intent.environment).toEqual(Object.entries(values)
      .map(([key, value]) => ({ key, hash: hash(value) })));
    expect(output + receipt).not.toContain('sentinel');
    f.success('helper', 'forward', flags);
    f.success('helper', 'verify');
    f.success('helper', 'reverse');
    expect(readFileSync(join(source, '20-values.conf'), 'utf8')).toBe(original);
  });

  it.each((['helper', 'server'] as const).flatMap(kind => ['#', ';'].map(comment => ({ kind, comment }))))
  ('refuses $comment comments inside $kind continuations without exposing values', ({ kind, comment }) => {
    const f = fixture();
    const text = '[Service]\n' + (kind === 'helper' ? 'Environment=DEMO_FIRST=sentinel' : 'SupplementaryGroups=wayroost') + `\\\n  ${comment}sentinel\n`;
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    const path = kind === 'helper' ? join(source, '20-values.conf') : join(f.root, 'etc/systemd/system/wayroost-server.service');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
    const result = f.invoke(kind, 'forward', kind === 'helper'
      ? ['--drop-ins', source, '--allow-environment', 'DEMO_FIRST'] : ['--publish-unit']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Commented systemd continuations are unsupported.');
    expect(result.stdout + result.stderr).not.toContain('sentinel');
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(existsSync(f.receipt(kind))).toBe(false);
  });

  it('escapes percent signs, quotes and backslashes once in writable path directives', () => {
    const f = fixture();
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    const home = '/mnt/c/Users/Demo%User"\\folder';
    const selected = `${home}/.agents/skills`;
    const quote = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
    writeFileSync(join(source, '30-skills.conf'), `[Service]\nEnvironment="SIGNALBOX_SKILLS_WINDOWS_HOME=${quote(home)}"\n`);
    const flags = ['--drop-ins', source, '--allow-environment', 'SIGNALBOX_SKILLS_WINDOWS_HOME', '--writable-path', selected];
    const output = f.success('helper', 'forward', flags);
    const installed = readFileSync(join(f.root, 'etc/systemd/system/wayroost-helper.service.d/50-imported-environment.conf'), 'utf8');
    expect(installed).toContain(`ReadWritePaths="-${quote(selected)}"`);
    expect(output + readFileSync(f.receipt('helper'), 'utf8')).not.toContain(home);
    f.success('helper', 'verify');
    f.success('helper', 'reverse');
  });

  it.each(['plan', 'forward'])('maps a double-slash imported Windows home without exposing its value during %s', mode => {
    const f = fixture();
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    const home = '//mnt/c/Users/sentinel-private-value';
    const selected = `${home}/.agents/skills`;
    writeFileSync(join(source, '30-skills.conf'), `[Service]\nEnvironment=SIGNALBOX_SKILLS_WINDOWS_HOME=${home}\n`);
    const flags = ['--drop-ins', source, '--allow-environment', 'SIGNALBOX_SKILLS_WINDOWS_HOME', '--writable-path', selected];
    const output = f.success('helper', mode, flags);
    expect(output + readFileSync(f.receipt('helper'), 'utf8')).not.toContain(home);
    expect(JSON.parse(readFileSync(f.receipt('helper'), 'utf8')).intent.environment)
      .toEqual([{ key: 'SIGNALBOX_SKILLS_WINDOWS_HOME', hash: hash(home) }]);
    if (mode === 'forward') {
      f.success('helper', 'forward', flags);
      f.success('helper', 'verify');
      f.success('helper', 'reverse');
    }
  });

  it.each(['plan', 'forward'].flatMap(mode => ['ValueError', 'RuntimeError', 'IndexError'].map(exception => ({ mode, exception }))))
  ('redacts unexpected $exception path-validation exceptions during $mode translation', ({ mode, exception }) => {
    const f = fixture();
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    const home = '/mnt/c/Users/sentinel-private-value';
    writeFileSync(join(source, '30-skills.conf'), `[Service]\nEnvironment=SIGNALBOX_SKILLS_WINDOWS_HOME=${home}\n`);
    pythonShim(f, [['target(value, publication=False)', `raise ${exception}(value)`]]);
    const result = f.invoke('helper', mode, ['--drop-ins', source, '--allow-environment', 'SIGNALBOX_SKILLS_WINDOWS_HOME',
      '--writable-path', `${home}/.agents/skills`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Deployment failed; check paths, permissions and prepared input.');
    expect(result.stdout + result.stderr).not.toContain(home);
    expect(existsSync(f.receipt('helper'))).toBe(false);
    expect(existsSync(f.target('helper'))).toBe(false);
  });

  it.each([
    { name: 'non-breaking space', character: '\u00a0' },
    { name: 'next line', character: '\u0085' },
    { name: 'em space', character: '\u2003' },
    { name: 'line separator', character: '\u2028' },
    { name: 'paragraph separator', character: '\u2029' },
    { name: 'narrow non-breaking space', character: '\u202f' },
    { name: 'ideographic space', character: '\u3000' },
  ])('preserves literal $name in translated Environment values and skill roots', ({ character }) => {
    const f = fixture();
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    const home = `/mnt/c/Users/Demo${character}User`;
    const selected = `${home}/.agents/skills`;
    const values = { SIGNALBOX_SKILLS_WINDOWS_HOME: home, DEMO_LEADING: `${character}sentinel`,
      DEMO_TRAILING: `sentinel${character}`, DEMO_CONTINUATION: `sentinel ${character}tail` };
    const original = `[Service]\nEnvironment=SIGNALBOX_SKILLS_WINDOWS_HOME=${home}\n` +
      `Environment=DEMO_LEADING=${values.DEMO_LEADING}\nEnvironment=DEMO_TRAILING=${values.DEMO_TRAILING}\n` +
      `Environment="DEMO_CONTINUATION=sentinel\\\n${character}tail"\n`;
    const input = join(source, '30-skills.conf');
    writeFileSync(input, original);
    const flags = ['--drop-ins', source, '--allow-environment', Object.keys(values).join(','), '--writable-path', selected];
    const output = f.success('helper', 'plan', flags) + f.success('helper', 'forward', flags);
    const installed = readFileSync(join(f.root, 'etc/systemd/system/wayroost-helper.service.d/50-imported-environment.conf'), 'utf8');
    const quoted = (value: string) => value.replace(/\v/g, '\\v').replace(/\f/g, '\\f');
    for (const [key, value] of Object.entries(values)) expect(installed).toContain(`Environment="${key}=${quoted(value)}"`);
    expect(installed).toContain(`ReadWritePaths="-${quoted(selected)}"`);
    const receipt = readFileSync(f.receipt('helper'), 'utf8');
    expect(JSON.parse(receipt).intent.environment).toEqual(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, hash: hash(value) })));
    expect(output + receipt).not.toContain('sentinel');
    expect(output + receipt).not.toContain(home);
    f.success('helper', 'forward', flags);
    f.success('helper', 'verify');
    f.success('helper', 'reverse');
    expect(readFileSync(input, 'utf8')).toBe(original);
  });

  it.each([' ', '\t', '\n', '\r'])('splits systemd words at an ASCII separator: %j', separator => {
    const result = pythonFunctions('print(json.dumps(systemd_words(sys.argv[1])))',
      [`${separator}DEMO_FIRST=one${separator}"DEMO_SECOND=two"${separator}DEMO_THIRD=three${separator}`]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['DEMO_FIRST=one', 'DEMO_SECOND=two', 'DEMO_THIRD=three']);
  });

  it('refuses a non-breaking space used as a separator after a quoted assignment', () => {
    const f = fixture();
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    writeFileSync(join(source, '20-values.conf'), '[Service]\nEnvironment="DEMO_PATH=sentinel"\u00a0IGNORED_KEY=ignored\n');
    const result = f.invoke('helper', 'forward', ['--drop-ins', source, '--allow-environment', 'DEMO_PATH']);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('Unsupported systemd quoting.');
    expect(result.stdout + result.stderr).not.toContain('sentinel');
    expect(existsSync(f.target('helper'))).toBe(false);
  });

  it.each(['hex', 'octal', 'mixed'])('decodes UTF-8 byte escapes independently from Unicode escapes: %s', syntax => {
    const f = fixture();
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    const escaped = syntax === 'hex' ? String.raw`Jos\xC3\xA9` : syntax === 'octal' ? String.raw`Jos\303\251`
      : String.raw`Jos\xC3\251\u2603`;
    const value = syntax === 'mixed' ? 'José☃' : 'José';
    writeFileSync(join(source, '20-values.conf'), `[Service]\nEnvironment="DEMO_PATH=/mnt/c/Users/${escaped}"\n`);
    f.success('helper', 'forward', ['--drop-ins', source, '--allow-environment', 'DEMO_PATH']);
    const installed = join(f.root, 'etc/systemd/system/wayroost-helper.service.d/50-imported-environment.conf');
    expect(readFileSync(installed, 'utf8')).toContain(`Environment="DEMO_PATH=/mnt/c/Users/${value}"`);
    expect(JSON.parse(readFileSync(f.receipt('helper'), 'utf8')).intent.environment)
      .toEqual([{ key: 'DEMO_PATH', hash: hash(`/mnt/c/Users/${value}`) }]);
    f.success('helper', 'verify');
    f.success('helper', 'reverse');
  });

  it.each([String.raw`\xFF`, String.raw`\xC3`, String.raw`\xC3\x28`, String.raw`\400`, String.raw`\777`])('refuses invalid UTF-8 or out-of-range byte escapes: %s', escaped => {
    const f = fixture();
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    writeFileSync(join(source, '20-values.conf'), `[Service]\nEnvironment="DEMO_PATH=sentinel-value${escaped}"\n`);
    const result = f.invoke('helper', 'forward', ['--drop-ins', source, '--allow-environment', 'DEMO_PATH']);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout + result.stderr).not.toContain('sentinel-value');
    expect(existsSync(f.target('helper'))).toBe(false);
  });

  it.each(['reset', 'later-reset', 'unselected'])('replaces obsolete imports when explicit translation is empty: %s', selection => {
    const f = fixture();
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    const input = join(source, '20-values.conf');
    const sentinel = 'sentinel-obsolete-value';
    writeFileSync(input, `[Service]\nEnvironment="DEMO_PATH=${sentinel}"\n`);
    const flags = ['--drop-ins', source, '--allow-environment', 'DEMO_PATH'];
    f.success('helper', 'forward', [...flags, '--receipt', 'previous']);
    const installed = join(f.root, 'etc/systemd/system/wayroost-helper.service.d/50-imported-environment.conf');
    const previous = readFileSync(installed);
    if (selection === 'reset') writeFileSync(input, '[Service]\nEnvironment=\n');
    else if (selection === 'later-reset') writeFileSync(join(source, '30-reset.conf'), '[Service]\nEnvironment=\n');
    else writeFileSync(input, '[Service]\nEnvironment=IGNORED_KEY=ignored-value\n');
    const output = f.success('helper', 'plan', flags) + f.success('helper', 'forward', flags);
    expect(readFileSync(installed, 'utf8')).toBe('[Service]\n');
    const receipt = JSON.parse(readFileSync(f.receipt('helper'), 'utf8'));
    expect(receipt.intent.environment).toEqual([]);
    expect(receipt.paths.find((entry: { path: string }) => entry.path === installed))
      .toMatchObject({ old: { hash: hash(previous) }, new: { hash: hash('[Service]\n'), mode: '0600' } });
    expect(output + readFileSync(f.receipt('helper'), 'utf8')).not.toContain(sentinel);
    f.success('helper', 'forward', flags);
    f.success('helper', 'verify');
    f.success('helper', 'reverse');
    expect(readFileSync(installed)).toEqual(previous);
  });

  it('accepts owner-owned Windows skill references while retaining production publication checks', () => {
    const f = fixture();
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    const home = '/mnt/c/Users/Demo User';
    const selected = `${home}/.agents/skills`;
    const userHome = join(f.root, home);
    mkdirSync(join(f.root, selected), { recursive: true });
    writeFileSync(join(source, '30-skills.conf'), `[Service]\nEnvironment="SIGNALBOX_SKILLS_WINDOWS_HOME=${home}"\n`);
    const boundary = 'if inspect and os.geteuid() == 0 and not fake_root';
    pythonShim(f, [[boundary, 'if inspect'], ['info = parent.stat()', 'info = reference_stat(parent)']], `
def reference_stat(path):
    info = list(path.stat())
    if path == Path(${JSON.stringify(userHome)}) or path.is_relative_to(Path(${JSON.stringify(userHome)})):
        info[4] = 1001
        info[0] |= 0o020
    else:
        info[4] = 0
        info[0] &= ~0o022
    return os.stat_result(info)
`);
    const flags = ['--drop-ins', source, '--allow-environment', 'SIGNALBOX_SKILLS_WINDOWS_HOME', '--writable-path', selected];
    const result = f.invoke('helper', 'plan', flags);
    expect(result.status, result.stderr).toBe(0);
    expect(f.invoke('helper', 'plan', [...flags, '--unit-dir', `${home}/units`]).status).toBe(1);
    rmSync(join(f.root, selected), { recursive: true });
    mkdirSync(join(f.folder, 'outside'));
    symlinkSync(join(f.folder, 'outside'), join(f.root, selected));
    expect(f.invoke('helper', 'plan', flags).status).toBe(1);
    expect(readdirSync(join(f.folder, 'outside'))).toEqual([]);
  });

  it('allows an explicitly selected Windows Hermes skill root', () => {
    const f = fixture();
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    const home = '/mnt/c/Users/Demo User';
    const selected = `${home}/AppData/Local/hermes/skills`;
    writeFileSync(join(source, '30-skills.conf'), `[Service]\nEnvironment="SIGNALBOX_SKILLS_WINDOWS_HOME=${home}"\n`);
    const flags = ['--drop-ins', source, '--allow-environment', 'SIGNALBOX_SKILLS_WINDOWS_HOME', '--writable-path', selected];
    f.success('helper', 'forward', flags);
    expect(readFileSync(join(f.root, 'etc/systemd/system/wayroost-helper.service.d/50-imported-environment.conf'), 'utf8'))
      .toContain(`ReadWritePaths="-${selected}"`);
    expect(f.invoke('helper', 'forward', [...flags, '--writable-path', `${home}/AppData/Local/hermes`]).status).toBe(1);
    f.success('helper', 'verify');
    f.success('helper', 'reverse');
  });

  it('decodes systemd escapes and hashes effective Environment values', () => {
    const f = fixture();
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    writeFileSync(join(source, '20-values.conf'), String.raw`[Service]
Environment = "DEMO_PATH=/mnt/c/Users/Demo\sUser" 'DEMO_URL=https://example.com/a\x20b?quote=\"yes\"&slash=\\&percent=%%20'
Environment="DEMO_UNICODE=\u2603\U0001f642\040done" "DEMO_CONTROLS=line\nnext\titem"
`);
    const values = { DEMO_PATH: '/mnt/c/Users/Demo User', DEMO_URL: 'https://example.com/a b?quote="yes"&slash=\\&percent=%20',
      DEMO_UNICODE: '☃🙂 done', DEMO_CONTROLS: 'line\nnext\titem' };
    const flags = ['--drop-ins', source, '--allow-environment', Object.keys(values).join(',')];
    const output = f.success('helper', 'forward', flags);
    const receipt = JSON.parse(readFileSync(f.receipt('helper'), 'utf8'));
    expect(receipt.intent.environment).toEqual(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, hash: hash(value) })));
    const installed = join(f.root, 'etc/systemd/system/wayroost-helper.service.d/50-imported-environment.conf');
    const decoded = pythonFunctions(`
values = {}
for line in Path(sys.argv[1]).read_text().splitlines():
    if line.startswith('Environment='):
        for word in systemd_words(line[len('Environment='):]):
            key, _, value = word.partition('=')
            values[key] = value
print(json.dumps(values))
`, [installed]);
    expect(decoded.status, decoded.stderr).toBe(0);
    expect(JSON.parse(decoded.stdout)).toEqual(values);
    expect(output + readFileSync(f.receipt('helper'), 'utf8')).not.toContain(values.DEMO_PATH);
    f.success('helper', 'verify');
    f.success('helper', 'reverse');
  });

  it.each([String.raw`"DEMO_PATH=bad\q"`, String.raw`"DEMO_PATH=bad\x0"`, String.raw`"DEMO_PATH=bad\000"`,
    '"DEMO_PATH=%h"', '"DEMO_PATH=unterminated', 'DEMO_PATH="shell quoting"'])('refuses unsupported Environment syntax without printing values: %s', value => {
    const f = fixture();
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    writeFileSync(join(source, '20-values.conf'), `[Service]\nEnvironment=${value}\n`);
    const result = f.invoke('helper', 'forward', ['--drop-ins', source, '--allow-environment', 'DEMO_PATH']);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(value);
    expect(existsSync(f.target('helper'))).toBe(false);
  });

  it('publishes only explicitly selected writable Windows skill roots and retains the original drop-in', () => {
    const f = fixture();
    const source = join(f.root, 'etc/systemd/system/signalbox-helper.service.d');
    mkdirSync(source, { recursive: true });
    const home = '/mnt/c/Users/Demo User';
    const selected = `${home}/.agents/skills`;
    const unselected = `${home}/.claude/skills`;
    const original = String.raw`[Service]
Environment="SIGNALBOX_SKILLS_WINDOWS_HOME=/mnt/c/Users/Demo\sUser"
ReadWritePaths="-/mnt/c/Users/Demo User/.agents/skills" "-/mnt/c/Users/Demo User/.claude/skills"
`;
    writeFileSync(join(source, '30-skills.conf'), original);
    const flags = ['--drop-ins', source, '--allow-environment', 'SIGNALBOX_SKILLS_WINDOWS_HOME'];
    expect(f.invoke('helper', 'forward', [...flags, '--writable-path', home]).status).toBe(1);
    expect(f.invoke('helper', 'forward', [...flags, '--writable-path', '/etc']).status).toBe(1);
    const output = f.success('helper', 'forward', [...flags, '--writable-path', selected]);
    const installed = join(f.root, 'etc/systemd/system/wayroost-helper.service.d/50-imported-environment.conf');
    const text = readFileSync(installed, 'utf8');
    expect(text).toContain(`ReadWritePaths="-${selected}"`);
    expect(text).not.toContain(unselected);
    expect(readFileSync(f.target('helper'), 'utf8')).toContain('ProtectSystem=strict');
    expect(output + readFileSync(f.receipt('helper'), 'utf8')).not.toContain(home);
    expect(readFileSync(join(source, '30-skills.conf'), 'utf8')).toBe(original);
    f.success('helper', 'verify');
    f.success('helper', 'reverse');
    expect(existsSync(installed)).toBe(false);
    expect(readFileSync(join(source, '30-skills.conf'), 'utf8')).toBe(original);
  });

  it('allows writes through a filesystem sandbox only to the selected Windows skill root', context => {
    if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) context.skip();
    const f = fixture();
    const source = join(f.folder, 'drop-ins');
    mkdirSync(source);
    const home = '/mnt/c/Users/Demo User';
    const selected = `${home}/.agents/skills`;
    const unselected = `${home}/.claude/skills`;
    mkdirSync(join(f.root, selected), { recursive: true });
    mkdirSync(join(f.root, unselected), { recursive: true });
    writeFileSync(join(source, '30-skills.conf'), `[Service]\nEnvironment="SIGNALBOX_SKILLS_WINDOWS_HOME=${home}"\n`);
    f.success('helper', 'forward', ['--drop-ins', source, '--allow-environment', 'SIGNALBOX_SKILLS_WINDOWS_HOME', '--writable-path', selected]);
    const installed = join(f.root, 'etc/systemd/system/wayroost-helper.service.d/50-imported-environment.conf');
    const result = pythonFunctions(`
import ctypes
libc = ctypes.CDLL(None, use_errno=True)
if libc.syscall(444, 0, 0, 1) < 1:
    print('SKIP filesystem sandbox unavailable')
    sys.exit(0)
class Ruleset(ctypes.Structure):
    _fields_ = [('access', ctypes.c_uint64)]
class PathRule(ctypes.Structure):
    _fields_ = [('access', ctypes.c_uint64), ('parent', ctypes.c_int)]
access = (1 << 1) | (1 << 4) | (1 << 5) | (1 << 7) | (1 << 8)
ruleset = Ruleset(access)
handle = libc.syscall(444, ctypes.byref(ruleset), ctypes.sizeof(ruleset), 0)
assert handle >= 0
for line in Path(sys.argv[1]).read_text().splitlines():
    if line.startswith('ReadWritePaths='):
        for value in systemd_words(line[len('ReadWritePaths='):]):
            path = Path(sys.argv[2]) / value.lstrip('-/ ')
            directory = os.open(path, os.O_PATH | os.O_CLOEXEC)
            rule = PathRule(access, directory)
            assert libc.syscall(445, handle, 1, ctypes.byref(rule), 0) == 0
            os.close(directory)
assert libc.prctl(38, 1, 0, 0, 0) == 0
assert libc.syscall(446, handle, 0) == 0
os.close(handle)
selected = Path(sys.argv[2]) / sys.argv[3].lstrip('/') / 'demo.md'
selected.write_text('public skill fixture')
unselected = Path(sys.argv[2]) / sys.argv[4].lstrip('/') / 'demo.md'
try:
    unselected.write_text('unexpected write')
except PermissionError:
    print('PASS selected write; unselected write denied')
else:
    raise AssertionError('Unselected skill root was writable')
`, [installed, f.root, selected, unselected]);
    if (result.stdout.startsWith('SKIP')) context.skip();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('PASS selected write; unselected write denied');
    expect(readFileSync(join(f.root, selected, 'demo.md'), 'utf8')).toBe('public skill fixture');
    expect(existsSync(join(f.root, unselected, 'demo.md'))).toBe(false);
  });
});
