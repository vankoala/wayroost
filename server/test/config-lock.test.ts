import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withPaseoConfigLock } from '../src/paseo/config-lock.js';

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, accessSync: vi.fn(actual.accessSync) };
});
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const roots: string[] = [];
afterEach(() => {
  vi.mocked(fs.accessSync).mockReset().mockImplementation(actual.accessSync);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'wayroost-config-lock-'));
  roots.push(root);
  const path = join(root, 'demo-config.json');
  fs.writeFileSync(path, JSON.stringify({ owner: 'demo-original' }));
  return { root, path, lock: `${path}.wayroost.lock` };
}

it('serializes a cooperating config writer in another process and preserves both edits', async () => {
  const f = fixture();
  let child: ReturnType<typeof spawn> | undefined;
  let output = '';
  let errors = '';
  let completed: Promise<void> | undefined;
  try {
    await withPaseoConfigLock(f.path, f.root, async () => {
      const script = `
        import { readFileSync, writeFileSync } from 'node:fs';
        import { withPaseoConfigLock } from './server/src/paseo/config-lock.ts';
        process.stdout.write('waiting\\n');
        await withPaseoConfigLock(process.argv[1], process.argv[2], async () => {
          const config = JSON.parse(readFileSync(process.argv[1], 'utf8'));
          writeFileSync(process.argv[1], JSON.stringify({ ...config, owner: 'demo-edit' }));
          process.stdout.write('written\\n');
        });
      `;
      child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, f.path, f.root], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout!.on('data', chunk => { output += String(chunk); });
      child.stderr!.on('data', chunk => { errors += String(chunk); });
      completed = new Promise<void>((resolve, reject) => {
        child!.once('error', reject);
        child!.once('exit', code => code === 0 ? resolve() : reject(new Error(errors || `Writer exited ${code}.`)));
      });
      void completed.catch(() => {});
      await vi.waitFor(() => expect(output).toBe('waiting\n'), { timeout: 5_000 });
      expect(spawnSync('/usr/bin/flock', ['--nonblock', f.lock, '/bin/true']).status).toBe(1);
      fs.writeFileSync(f.path, JSON.stringify({ owner: 'demo-original', policy: 'demo-policy' }));
    });
    await completed;
    expect(output).toBe('waiting\nwritten\n');
    expect(JSON.parse(fs.readFileSync(f.path, 'utf8'))).toEqual({ owner: 'demo-edit', policy: 'demo-policy' });
    expect(spawnSync('/usr/bin/flock', ['--nonblock', f.lock, '/bin/true']).status).toBe(0);
    expect(fs.statSync(f.lock).mode & 0o777).toBe(0o600);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await completed?.catch(() => {});
  }
});

it('releases the shared lock when the writer throws', async () => {
  const f = fixture();
  await expect(withPaseoConfigLock(f.path, f.root, async () => { throw new Error('demo-failed-write'); })).rejects.toThrow('demo-failed-write');
  expect(spawnSync('/usr/bin/flock', ['--nonblock', f.lock, '/bin/true']).status).toBe(0);
  expect(await withPaseoConfigLock(f.path, f.root, async () => 'demo-recovered')).toBe('demo-recovered');
});

it('uses the same adjacent lock through config directory aliases', async () => {
  const f = fixture();
  const alias = join(f.root, 'demo-alias');
  fs.symlinkSync(f.root, alias, 'dir');
  await withPaseoConfigLock(join(alias, 'demo-config.json'), f.root, async () => {
    expect(spawnSync('/usr/bin/flock', ['--nonblock', f.lock, '/bin/true']).status).toBe(1);
  });
});

it('uses a stable state-directory lock if the config directory is not writable', async () => {
  const f = fixture();
  vi.mocked(fs.accessSync).mockImplementation(() => { throw Object.assign(new Error('demo-read-only'), { code: 'EACCES' }); });
  await withPaseoConfigLock(f.path, f.root, async () => {
    const locks = fs.readdirSync(f.root).filter(name => name.endsWith('.lock'));
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatch(/^paseo-config-[a-f0-9]+\.lock$/);
    expect(spawnSync('/usr/bin/flock', ['--nonblock', join(f.root, locks[0]!), '/bin/true']).status).toBe(1);
  });
  expect(fs.existsSync(f.lock)).toBe(false);
});

it('refuses a symlink lock without invoking the writer', async () => {
  const f = fixture();
  fs.symlinkSync(f.path, f.lock);
  const writer = vi.fn(async () => {});
  await expect(withPaseoConfigLock(f.path, f.root, writer)).rejects.toThrow();
  expect(writer).not.toHaveBeenCalled();
  expect(fs.readFileSync(f.path, 'utf8')).toBe(JSON.stringify({ owner: 'demo-original' }));
});

it('cancels a lock waiter and never runs its writer after the holder releases', async () => {
  const f = fixture();
  const controller = new AbortController();
  const writer = vi.fn(async () => 'written');
  let outcome: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await withPaseoConfigLock(f.path, f.root, async () => {
      outcome = withPaseoConfigLock(f.path, f.root, writer, controller.signal).catch(error => error);
      controller.abort();
      const result = await Promise.race([
        outcome,
        new Promise(resolve => { timer = setTimeout(() => resolve('not cancelled'), 1000); }),
      ]);
      expect(result).toMatchObject({ name: 'AbortError' });
      expect(writer).not.toHaveBeenCalled();
    });
  } finally { clearTimeout(timer); await outcome; }
  expect(writer).not.toHaveBeenCalled();
  expect(spawnSync('/usr/bin/flock', ['--nonblock', f.lock, '/bin/true']).status).toBe(0);
});
