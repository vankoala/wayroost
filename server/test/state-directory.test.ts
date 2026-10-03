import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.js';
import { FeedStore } from '../src/feed/store.js';
import { claimStateDirectory, StateDirectoryError } from '../src/state-directory.js';

const input = {
  listen: { port: 8890 },
  publicOrigin: 'https://wayroost.example.com',
  access: { teamDomain: 'https://demo.cloudflareaccess.com', aud: 'fake-audience', allowedEmails: ['you@example.com'] },
};
const dirs: string[] = [];
const children: ChildProcess[] = [];
const dir = () => {
  const path = mkdtempSync(join(tmpdir(), 'wayroost-state-test-'));
  dirs.push(path);
  return path;
};
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('state directory isolation', () => {
  it.each(['/var/lib/wayroost', '/var/lib/signalbox'])('refuses shadow sharing primary default %s', (stateDir) => {
    const primary = parseConfig({ ...input, stateDir }, { env: {} });
    expect(() => parseConfig({ ...input, role: 'shadow', stateDir: primary.stateDir }, { env: {} })).toThrow(ConfigError);
  });

  it('refuses an unmarked primary store before shadow settings can overwrite its cards', () => {
    const stateDir = dir();
    const staleShadow = new FeedStore(stateDir);
    const primary = new FeedStore(parseConfig({ ...input, stateDir }, { env: {} }).stateDir);
    primary.ingest('brief', [{ key: 'mail:fake-demo-card', kind: 'heads-up', title: 'Demo card' }]);
    const before = readFileSync(join(stateDir, 'feed.json'), 'utf8');
    let refusal: unknown;
    try {
      parseConfig({ ...input, role: 'shadow', stateDir }, { env: {} });
      staleShadow.updateSettings({ quietHours: null });
    } catch (err) {
      refusal = err;
    }
    expect(readFileSync(join(stateDir, 'feed.json'), 'utf8')).toBe(before);
    expect(new FeedStore(stateDir).all()).toHaveLength(1);
    expect(refusal).toBeInstanceOf(ConfigError);
  });

  it.each(['/var/lib/wayroost', '/var/lib/signalbox', '/etc/signalbox'])('refuses symlink aliases of %s', (target) => {
    const alias = join(dir(), 'alias');
    symlinkSync(target, alias);
    expect(() => parseConfig({ ...input, role: 'shadow', stateDir: join(alias, 'new-child') }, { env: {} })).toThrow(ConfigError);
  });

  it('uses the resolved isolated path, including a not-yet-created child', () => {
    const root = dir();
    const state = join(root, 'state');
    const alias = join(root, 'alias');
    mkdirSync(state);
    symlinkSync(state, alias);
    expect(parseConfig({ ...input, role: 'shadow', stateDir: join(alias, 'child') }, { env: {} }).stateDir).toBe(join(state, 'child'));
  });

  it('rechecks ownership at startup before a previously validated shadow can create a stale feed store', () => {
    const stateDir = dir();
    const primaryConfig = parseConfig({ ...input, stateDir }, { env: {} });
    const shadowConfig = parseConfig({ ...input, role: 'shadow', stateDir }, { env: {} });
    const primary = new FeedStore(claimStateDirectory(primaryConfig.stateDir, primaryConfig.role));
    expect(() => {
      const shadow = new FeedStore(claimStateDirectory(shadowConfig.stateDir, shadowConfig.role));
      primary.ingest('brief', [{ key: 'mail:fake-demo-card', kind: 'heads-up', title: 'Demo card' }]);
      shadow.updateSettings({ quietHours: null });
    }).toThrow(StateDirectoryError);
    primary.ingest('brief', [{ key: 'mail:fake-demo-card', kind: 'heads-up', title: 'Demo card' }]);
    expect(new FeedStore(stateDir).all()).toHaveLength(1);
    expect(() => parseConfig({ ...input, role: 'shadow', stateDir }, { env: {} })).toThrow(ConfigError);
  });

  it.each(['primary', 'shadow'] as const)('preserves %s ownership across restarts and refuses the other role', (role) => {
    const stateDir = claimStateDirectory(join(dir(), 'new-state'), role);
    const marker = join(stateDir, '.wayroost-role');
    expect(readFileSync(marker, 'utf8')).toBe(`${role}\n`);
    expect(statSync(marker).mode & 0o777).toBe(0o600);
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(claimStateDirectory(stateDir, role)).toBe(stateDir);
    expect(() => claimStateDirectory(stateDir, role === 'primary' ? 'shadow' : 'primary')).toThrow(StateDirectoryError);
    expect(readFileSync(marker, 'utf8')).toBe(`${role}\n`);
  });

  it('refuses primary-owned custom paths, aliases and new descendants', () => {
    const root = dir();
    const primary = claimStateDirectory(join(root, 'primary'), 'primary');
    const alias = join(root, 'alias');
    symlinkSync(primary, alias);
    for (const stateDir of [primary, alias, join(primary, 'new-child'), join(alias, 'new-child')]) {
      expect(() => parseConfig({ ...input, role: 'shadow', stateDir }, { env: {} })).toThrow(ConfigError);
    }
  });

  it('keeps primary cards intact when shadow changes its own settings', () => {
    const root = dir();
    const primary = new FeedStore(claimStateDirectory(join(root, 'primary'), 'primary'));
    const shadowPath = claimStateDirectory(join(root, 'shadow'), 'shadow');
    const shadow = new FeedStore(shadowPath);
    primary.ingest('brief', [{ key: 'mail:fake-demo-card', kind: 'heads-up', title: 'Demo card' }]);
    const primaryFile = join(root, 'primary', 'feed.json');
    const before = readFileSync(primaryFile, 'utf8');
    shadow.updateSettings({ quietHours: null });
    expect(readFileSync(primaryFile, 'utf8')).toBe(before);
    expect(new FeedStore(join(root, 'primary')).all()).toHaveLength(1);
    expect(parseConfig({ ...input, role: 'shadow', stateDir: shadowPath }, { env: {} }).stateDir).toBe(shadowPath);
    expect(new FeedStore(shadowPath).settings().quietHours).toBeNull();
  });

  it('adopts existing unmarked primary state without changing its contents', () => {
    const stateDir = dir();
    new FeedStore(stateDir).ingest('brief', [{ key: 'mail:fake-demo-card', kind: 'heads-up', title: 'Demo card' }]);
    const before = readFileSync(join(stateDir, 'feed.json'), 'utf8');
    expect(claimStateDirectory(stateDir, 'primary')).toBe(stateDir);
    expect(readFileSync(join(stateDir, 'feed.json'), 'utf8')).toBe(before);
    expect(new FeedStore(stateDir).all()).toHaveLength(1);
  });

  it.each(['', 'standby\n', 'primary', 'primary\nextra'])('fails closed on invalid ownership %j', (text) => {
    const stateDir = dir();
    writeFileSync(join(stateDir, '.wayroost-role'), text);
    for (const role of ['primary', 'shadow'] as const) {
      expect(() => claimStateDirectory(stateDir, role)).toThrow(StateDirectoryError);
    }
    expect(readFileSync(join(stateDir, '.wayroost-role'), 'utf8')).toBe(text);
  });

  it('refuses symlink role markers and dangling state symlinks', () => {
    const stateDir = dir();
    const target = join(dir(), 'fake-role');
    writeFileSync(target, 'shadow\n');
    symlinkSync(target, join(stateDir, '.wayroost-role'));
    expect(() => claimStateDirectory(stateDir, 'shadow')).toThrow(StateDirectoryError);
    const dangling = join(dir(), 'dangling');
    symlinkSync(join(dir(), 'missing'), dangling);
    expect(() => parseConfig({ ...input, role: 'shadow', stateDir: join(dangling, 'child') }, { env: {} })).toThrow(ConfigError);
  });

  it('atomically admits only one role when two processes claim the same empty directory', async () => {
    const stateDir = dir();
    const module = new URL('../src/state-directory.ts', import.meta.url).href;
    const script = `import { claimStateDirectory } from ${JSON.stringify(module)};
      process.once('message', ({ path, role }) => {
        try { claimStateDirectory(path, role); process.send({ role, ok: true }); }
        catch { process.send({ role, ok: false }); }
        process.disconnect();
      });
      process.send('ready');`;
    const started = await Promise.all((['primary', 'shadow'] as const).map(async (role) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      children.push(child);
      expect((await once(child, 'message'))[0]).toBe('ready');
      return { child, role };
    }));
    const results = await Promise.all(started.map(async ({ child, role }) => {
      const result = once(child, 'message');
      child.send({ path: stateDir, role });
      return (await result)[0] as { role: 'primary' | 'shadow'; ok: boolean };
    }));
    const admitted = results.filter((result) => result.ok);
    expect(admitted).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(readFileSync(join(stateDir, '.wayroost-role'), 'utf8')).toBe(`${admitted[0]!.role}\n`);
  });
});
