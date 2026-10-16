import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { BackgroundGate } from '../src/background.js';
import { Bridge } from '../src/bridge/service.js';
import { EventHub } from '../src/hub.js';
import { Lineage } from '../src/lineage.js';
import { FakeHermes, FakePaseo } from './helpers.js';

const io = vi.hoisted(() => ({ fault: '' as '' | 'EROFS' | 'ENOSPC' | 'file sync' | 'directory sync', dir: '' }));
vi.mock('node:fs', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const failWrite = (path: unknown) => {
    if ((io.fault === 'EROFS' || io.fault === 'ENOSPC') && String(path).startsWith(`${io.dir}/lineage`)) {
      throw Object.assign(new Error('Fixture write failed'), { code: io.fault });
    }
  };
  return { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      if (String(args[1]).includes('w')) failWrite(args[0]);
      return fs.openSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => { failWrite(args[0]); return fs.writeFileSync(...args); },
    fsyncSync: (fd: number) => {
      if (io.fault === (fs.fstatSync(fd).isDirectory() ? 'directory sync' : 'file sync')) {
        throw Object.assign(new Error('Fixture sync failed'), { code: 'EIO' });
      }
      return fs.fsyncSync(fd);
    },
  };
});

const roots: string[] = [];
const lineages: Lineage[] = [];
const background = new BackgroundGate('primary');
const log = { info() {}, warn: vi.fn(), error() {} };
const candidates = [{ kind: 'hermes' as const, id: 'fake-chat' }];
const T = 1_800_000_000_000;
let baseline: typeof Lineage;
let baselineDir: string;
beforeAll(async () => {
  const root = resolve('.tmp');
  mkdirSync(root, { recursive: true });
  baselineDir = mkdtempSync(join(root, 'lineage-baseline-'));
  const file = 'server/src/lineage.ts';
  const content = execFileSync('git', ['show', `cc55e34:${file}`], { encoding: 'utf8' })
    .replace(/(from\s+['"])(\.[^'"]+)(['"])/g, (_match, before: string, specifier: string, after: string) =>
      `${before}${resolve(dirname(file), specifier).replace(/\.js$/, '.ts')}${after}`);
  const path = join(baselineDir, 'lineage.ts');
  writeFileSync(path, content);
  baseline = (await import(/* @vite-ignore */ path)).Lineage;
});
afterAll(() => { if (baselineDir) rmSync(baselineDir, { recursive: true, force: true }); });
afterEach(() => {
  io.fault = ''; io.dir = '';
  for (const lineage of lineages.splice(0)) lineage.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
  log.warn.mockClear();
});

function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'wayroost-lineage-'));
  roots.push(dir);
  return dir;
}
function setup(dir = directory()) {
  const lineage = new Lineage(dir, log, () => T, background);
  lineages.push(lineage);
  const bridge = new Bridge({ stateDir: dir, lineage, background, log, hub: new EventHub(), pollMs: 0,
    sources: { hermes: new FakeHermes(), paseo: new FakePaseo() } });
  return { dir, lineage, bridge, hold: bridge.maintenanceHold(dir) };
}
const saved = (dir: string) => JSON.parse(readFileSync(join(dir, 'lineage.json'), 'utf8'));

it.each(['EROFS', 'ENOSPC', 'file sync', 'directory sync'] as const)(
  'preserves unheld startup and debounce timing with %s storage against the baseline', (fault) => {
    vi.useFakeTimers();
    for (const Version of [baseline, Lineage]) {
      const dir = directory();
      io.dir = dir; io.fault = fault;
      let lineage!: Lineage;
      expect(() => { lineage = new Version(dir, log, () => T, background); }).not.toThrow();
      if (Version === Lineage) lineages.push(lineage);
      lineage.noteRun('fake-run', 'start', { candidates });
      expect(existsSync(join(dir, 'lineage.json'))).toBe(false);
      vi.advanceTimersByTime(499);
      expect(existsSync(join(dir, 'lineage.json'))).toBe(false);
      vi.advanceTimersByTime(1);
      if (Version === Lineage || fault === 'EROFS' || fault === 'ENOSPC') expect(log.warn).toHaveBeenCalled();
      if (Version === Lineage) expect(lineage.unavailable).toBe(true);
      io.fault = '';
    }
  });

it('flushes the pending unheld run before acknowledging a hold, including a repeated hold', () => {
  const f = setup();
  f.lineage.noteRun('fake-first', 'start', { candidates });
  expect(existsSync(join(f.dir, 'lineage.json'))).toBe(false);
  f.hold.set(true);
  expect(saved(f.dir).runs['fake-first'].status).toBe('running');
  expect(existsSync(join(f.dir, 'lineage-quiet-active.json'))).toBe(false);
  const save = vi.spyOn(f.lineage, 'save');
  f.hold.set(true);
  expect(save).toHaveBeenCalledOnce();
});

it('connects a hold created after the bridge and loads a held restart before reports', async () => {
  const dir = directory();
  const lineage = new Lineage(dir, log, () => T, background);
  lineages.push(lineage);
  const bridge = new Bridge({ lineage, background, log, hub: new EventHub(), pollMs: 0,
    sources: { hermes: new FakeHermes(), paseo: new FakePaseo() } });
  lineage.noteRun('fake-first', 'start', { candidates });
  bridge.maintenanceHold(dir).set(true);
  expect(saved(dir).runs['fake-first'].status).toBe('running');
  lineage.close();
  const restored = setup(dir);
  await restored.bridge.call('note_run', { session: '00000000-0000-4000-8000-000000000055', event: 'start' });
  expect(saved(dir).runs['00000000-0000-4000-8000-000000000055'].status).toBe('running');
});

it.each(['start', 'prompt', 'stop', 'end'] as const)('writes a held %s report before acknowledging it', async (event) => {
  const f = setup();
  f.hold.set(true);
  const session = '00000000-0000-4000-8000-000000000055';
  await f.bridge.call('note_run', { session, event, candidates: [{ kind: 'hermes', id: '20260101_000000_abcdef' }] });
  expect(saved(f.dir).runs[session].status).toBe(event === 'start' || event === 'prompt' ? 'running' : 'done');
  f.hold.set(false);
  f.lineage.noteRun('fake-later', 'start', { candidates });
  expect(saved(f.dir).runs['fake-later']).toBeUndefined();
});

it('keeps a failed hold flush unknown until a complete save succeeds', () => {
  const f = setup();
  f.lineage.noteRun('fake-run', 'start', { candidates });
  io.dir = f.dir; io.fault = 'ENOSPC';
  expect(() => f.hold.set(true)).not.toThrow();
  expect(f.lineage.unavailable).toBe(true);
  io.fault = '';
  f.hold.set(true);
  expect(f.lineage.unavailable).toBe(false);
  expect(saved(f.dir).runs['fake-run'].status).toBe('running');
});

it.each(['EROFS', 'ENOSPC', 'file sync', 'directory sync'] as const)(
  'preserves startup after a damaged load when its marker has a %s failure', (fault) => {
    for (const Version of [baseline, Lineage]) {
      const dir = directory();
      writeFileSync(join(dir, 'lineage.json'), '{');
      io.dir = dir; io.fault = fault;
      let lineage!: Lineage;
      expect(() => { lineage = new Version(dir, log, () => T, background); }).not.toThrow();
      expect(lineage.runs()).toEqual([]);
      if (Version === Lineage) {
        lineages.push(lineage);
        expect(lineage.unavailable).toBe(true);
        io.fault = '';
        lineage.save();
        expect(lineage.unavailable).toBe(true);
        expect(existsSync(join(dir, 'lineage-quiet.json'))).toBe(true);
        const restored = new Lineage(dir, log, () => T, background);
        lineages.push(restored);
        expect(restored.unavailable).toBe(true);
      }
      io.fault = '';
    }
  });
