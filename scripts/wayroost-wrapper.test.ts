import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// `sudo wayroost pair` / `pair-desktop` (deploy/wayroost.sh), rendered the way
// the installer renders it, but with invented paths: a stand-in for node that prints what it was
// given, and a stand-in for id. Nothing here reads /etc or talks to a server.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function wrapper(uid: number, tlsOutput?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'wayroost-wrapper-'));
  dirs.push(dir);
  const node = join(dir, 'fake-node');
  writeFileSync(node, tlsOutput === undefined ? '#!/bin/sh\necho "fake-node $*"\n' : `#!/bin/sh\nprintf '%s\\n' '${tlsOutput}'\n`);
  const id = join(dir, 'fake-id');
  writeFileSync(id, `#!/bin/sh\necho ${uid}\n`);
  chmodSync(node, 0o755);
  chmodSync(id, 0o755);
  const systemctl = join(dir, 'fake-systemctl');
  writeFileSync(systemctl, '#!/bin/sh\necho "fake-systemctl $*"\n'); chmodSync(systemctl, 0o755);
  const script = join(dir, 'wayroost');
  writeFileSync(script, readFileSync('deploy/wayroost.sh', 'utf8')
    .replaceAll('@NODE@', node)
    .replaceAll('@PAIR_CODE@', '/srv/demo/dist/server/pair-code.js')
    .replaceAll('@CONFIG@', '/srv/demo/etc/config.json')
    .replaceAll('/usr/bin/systemctl', systemctl)
    .replaceAll('@ID@', id));
  chmodSync(script, 0o755);
  return (...args: string[]) => spawnSync(script, args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
}

describe('the wayroost wrapper', () => {
  it('asks for a phone code or a desktop code, with the installed config, explicitly', () => {
    const run = wrapper(0);
    expect(run('pair')).toMatchObject({ status: 0, stdout: 'fake-node /srv/demo/dist/server/pair-code.js --phone --config /srv/demo/etc/config.json\n' });
    expect(run('pair-desktop')).toMatchObject({ status: 0, stdout: 'fake-node /srv/demo/dist/server/pair-code.js --desktop --config /srv/demo/etc/config.json\n' });
    expect(run('fingerprints')).toMatchObject({ status: 0, stdout: 'fake-node /srv/demo/dist/server/tls-certificates.js fingerprints\n' });
  });

  it('takes nothing else from its caller', () => {
    const run = wrapper(0);
    for (const args of [[], ['pair', '--config', '/srv/other.json'], ['--phone'], ['pair-phone'], ['pair', 'pair-desktop'], ['rotate-tls', 'demo-unknown'], ['rotate-tls', 'server', 'extra']]) {
      const result = run(...args);
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Usage: sudo wayroost pair');
    }
  });

  it('refuses anyone but root before running anything', () => {
    const result = wrapper(1000)('pair');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Run this as root: sudo wayroost pair');
    const rotation = wrapper(1000)('rotate-tls', 'server');
    expect(rotation.status).toBe(1);
    expect(rotation.stdout).toBe('');
    expect(rotation.stderr).toContain('Run certificate rotation as root.');
    expect(wrapper(1000)('fingerprints').status).toBe(1);
  });

  it('refuses a rotation tool that silently succeeds before invoking systemctl', () => {
    for (const output of ['', 'demo-unconfirmed-output']) {
      const result = wrapper(0, output)('rotate-tls', 'server');
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('no service was restarted');
    }
    const output = 'server fingerprint: sha256/' + Buffer.alloc(32, 1).toString('base64');
    const confirmed = wrapper(0, output)('rotate-tls', 'server');
    expect(confirmed.status).toBe(0);
    expect(confirmed.stdout).toBe(`${output}\nfake-systemctl restart wayroost-server.service\n`);
  });

  it('leaves no placeholder for the installer to miss', () => {
    const template = readFileSync('deploy/wayroost.sh', 'utf8');
    expect(template.match(/@[A-Z_]+@/g)?.sort()).toEqual(['@CONFIG@', '@ID@', '@NODE@', '@PAIR_CODE@']);
    const installer = readFileSync('deploy/install-wayroost-server.sh', 'utf8');
    for (const placeholder of ['@NODE@', '@PAIR_CODE@', '@CONFIG@', '@ID@']) expect(installer).toContain(`WRAPPER//${placeholder}/`);
  });
});

it('uses a trusted privileged shell before startup files can execute', () => {
  expect(readFileSync('deploy/wayroost.sh', 'utf8').split('\n')[0]).toBe('#!/bin/bash -p');
});

it.each([0, 1000])('ignores caller startup files, PATH hijacks and Node code-loading environment for uid %i', (uid) => {
  const dir = mkdtempSync(join(tmpdir(), 'wayroost-wrapper-env-'));
  dirs.push(dir);
  const startup = join(dir, 'startup');
  writeFileSync(startup, 'echo fake-startup-executed\n');
  const bash = join(dir, 'bash');
  writeFileSync(bash, '#!/bin/sh\necho fake-path-executed\n');
  chmodSync(bash, 0o755);
  const injected = join(dir, 'inject.cjs');
  writeFileSync(injected, "console.log('fake-node-options-executed');");
  const pair = join(dir, 'pair.cjs');
  writeFileSync(pair, 'console.log(JSON.stringify(process.env));');
  const id = join(dir, 'id');
  writeFileSync(id, `#!/bin/sh\necho ${uid}\n`);
  chmodSync(id, 0o755);
  const script = join(dir, 'wrapper');
  writeFileSync(script, readFileSync('deploy/wayroost.sh', 'utf8').replaceAll('@NODE@', process.execPath)
    .replaceAll('@PAIR_CODE@', pair).replaceAll('@CONFIG@', '/srv/demo/config.json').replaceAll('@ID@', id));
  chmodSync(script, 0o755);
  const result = spawnSync(script, ['pair'], { encoding: 'utf8', env: {
    PATH: dir, BASH_ENV: startup, ENV: startup, NODE_OPTIONS: `--require=${injected}`,
    NODE_PATH: dir, HOME: '/home/me', WAYROOST_CONFIG: '/srv/other/config.json', FAKE_CALLER_VALUE: 'fake-value',
  } });
  expect(result.status).toBe(uid === 0 ? 0 : 1);
  expect(result.stdout).not.toContain('executed');
  if (uid === 0) expect(JSON.parse(result.stdout)).toEqual({ PATH: '/usr/bin:/bin' });
  else expect(result.stdout).toBe('');
});
