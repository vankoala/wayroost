import { DEFAULT_NOTIFICATION_RULES } from '../../shared/settings.js';
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as promises from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WAYROOST_SETTINGS_AUDIT_DIR, WAYROOST_SETTINGS_BACKUPS, WAYROOST_SETTINGS_FILE, NotificationSettingsStore } from '../src/notifications/settings.js';
import { SettingsWriteError, SettingsWriteThrough } from '../src/settings/write-through.js';
import { withDeviceSignal } from '../src/security/device-signal.js';

// Wayroost's own settings: notification rules and quiet hours in the server's state folder,
// written through the write-through core, which backs up, replaces atomically and audits.

const roots: string[] = [];
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});
const actualPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
beforeEach(() => {
  mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
  // Fixtures model a trusted root on hosts with mapped mount ownership.
  vi.mocked(promises.lstat).mockImplementation(async (path, options) => {
    const stat = await actualPromises.lstat(path, options);
    if (String(path) === '/') stat.uid = typeof stat.uid === 'bigint' ? 0n : 0;
    return stat;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateDir(): string {
  const root = mkdtempSync(join(process.cwd(), '.tmp', 'notification-settings-'));
  roots.push(root);
  return root;
}

const DEFAULTS = {
  rules: DEFAULT_NOTIFICATION_RULES.map((rule) => ({ ...rule })),
  quietHours: { start: '21:00', end: '07:00' },
  push: { approvals: true, cards: false },
} as const;

const finished = { event: 'agent-finished', source: 'paseo', delivery: 'toast' } as const;

describe('reading', () => {
  it.each(['link', 'fifo', 'large', 'writable'])('refuses an unsafe %s without reading its content', (kind) => {
    const store = new NotificationSettingsStore(stateDir());
    const text = JSON.stringify({ quietHours: null });
    if (kind === 'link') {
      const target = join(store.stateDir, 'elsewhere.json');
      writeFileSync(target, text, { mode: 0o600 });
      symlinkSync(target, store.path);
    } else if (kind === 'fifo') execFileSync('mkfifo', [store.path]);
    else writeFileSync(store.path, kind === 'large' ? ' '.repeat(256 * 1024) + text : text, { mode: 0o600 });
    if (kind === 'writable') chmodSync(store.path, 0o666);
    expect(store.settings()).toEqual(DEFAULTS);
  });
  it('says what every install starts with, without writing a file', () => {
    const state = stateDir();
    const store = new NotificationSettingsStore(state);
    expect(store.settings()).toEqual(DEFAULTS);
    expect(existsSync(join(state, WAYROOST_SETTINGS_FILE))).toBe(false);
  });

  it('reads a file another writer left behind', () => {
    const state = stateDir();
    writeFileSync(
      join(state, WAYROOST_SETTINGS_FILE),
      JSON.stringify({ rules: [finished], quietHours: null, push: { approvals: false, cards: true } }),
      { mode: 0o600 },
    );
    expect(new NotificationSettingsStore(state).settings()).toEqual({
      rules: [finished],
      quietHours: null,
      push: { approvals: false, cards: true },
    });
  });

  it('fills in what an older file doesn’t name', () => {
    const state = stateDir();
    writeFileSync(join(state, WAYROOST_SETTINGS_FILE), JSON.stringify({ quietHours: { start: '23:00', end: '06:00' } }), { mode: 0o600 });
    expect(new NotificationSettingsStore(state).settings().quietHours).toEqual({ start: '23:00', end: '06:00' });
    expect(new NotificationSettingsStore(state).settings().push).toEqual(DEFAULTS.push);
  });

  it.each([
    ['not JSON at all', 'rules = both'],
    ['a rule for an event nobody names', JSON.stringify({ rules: [{ event: 'ghost', source: '*', delivery: 'toast' }] })],
    ['a rule that sends an answer nowhere', JSON.stringify({ rules: [{ event: 'agent-needs-you', source: '*', delivery: 'neither' }] })],
    ['the same rule twice', JSON.stringify({ rules: [finished, finished] })],
    ['a time that isn’t one', JSON.stringify({ quietHours: { start: '25:00', end: '07:00' } })],
    ['a key it does not know', JSON.stringify({ push: { approvals: true }, extra: 1 })],
  ])('routes as the defaults when the file is %s', (_what, text) => {
    const state = stateDir();
    writeFileSync(join(state, WAYROOST_SETTINGS_FILE), text, { mode: 0o600 });
    expect(new NotificationSettingsStore(state).settings()).toEqual(DEFAULTS);
  });
});

describe('writing', () => {
  it('does not expose a settings file when preparing its initial bytes fails', async () => {
    const store = new NotificationSettingsStore(stateDir());
    const existing = { quietHours: null, push: { approvals: false, cards: true } };
    const sync = vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('Disk unavailable.'); });
    syncBuiltinESMExports();
    try {
      await expect(store.initialize(existing)).rejects.toThrow('Disk unavailable.');
      expect(existsSync(store.path)).toBe(false);
      expect(readdirSync(store.stateDir)).toEqual([]);
      expect(store.settings()).toEqual({ ...DEFAULTS, ...existing });
    } finally {
      sync.mockRestore();
      syncBuiltinESMExports();
    }
    await store.initialize(existing);
    expect(store.settings()).toEqual({ ...DEFAULTS, ...existing });
  });

  it('retains legacy preferences and retries after initialization fails', async () => {
    const state = stateDir();
    const existing = { quietHours: { start: '23:00', end: '06:30' }, push: { approvals: false, cards: true } };
    const store = new NotificationSettingsStore(state);
    vi.spyOn(SettingsWriteThrough.prototype, 'apply').mockRejectedValueOnce(new Error('Write refused.'));
    await expect(store.initialize(existing)).rejects.toThrow('Write refused.');
    expect(existsSync(store.path)).toBe(false);
    expect(store.settings()).toEqual({ ...DEFAULTS, ...existing });
    const restarted = new NotificationSettingsStore(state);
    await restarted.initialize(existing);
    expect(restarted.settings()).toEqual({ ...DEFAULTS, ...existing });
    expect(JSON.parse(readFileSync(store.path, 'utf8'))).toEqual({ ...DEFAULTS, ...existing });
  });

  it('preserves a replacement committed before initialization reports failure', async () => {
    const store = new NotificationSettingsStore(stateDir());
    const existing = { quietHours: null, push: { approvals: false, cards: true } };
    const apply = SettingsWriteThrough.prototype.apply;
    vi.spyOn(SettingsWriteThrough.prototype, 'apply').mockImplementationOnce(async function (this: SettingsWriteThrough, ...args) {
      await apply.apply(this, args);
      throw new Error('Audit unavailable.');
    });
    await expect(store.initialize(existing)).rejects.toThrow('Audit unavailable.');
    expect(new NotificationSettingsStore(store.stateDir).settings()).toEqual({ ...DEFAULTS, ...existing });
    expect(existsSync(store.path)).toBe(true);
  });

  it('rechecks device authorization immediately before the replacement commits', async () => {
    const store = new NotificationSettingsStore(stateDir());
    await store.change({ rules: [finished] });
    const before = readFileSync(store.path, 'utf8');
    const device = new AbortController();
    const apply = SettingsWriteThrough.prototype.apply;
    let checks = 0;
    vi.spyOn(SettingsWriteThrough.prototype, 'apply').mockImplementation(function (this: SettingsWriteThrough, change, authorize) {
      return apply.call(this, change, () => {
        if (++checks === 3) device.abort();
        authorize?.();
      });
    });
    await expect(withDeviceSignal(device.signal, () => store.change({ quietHours: null }))).rejects.toMatchObject({ status: 403 });
    expect(checks).toBe(3);
    expect(readFileSync(store.path, 'utf8')).toBe(before);
  });

  it('migrates existing feed preferences once without replacing newer settings', async () => {
    const state = stateDir();
    const existing = { quietHours: { start: '23:00', end: '06:30' }, push: { approvals: false, cards: true } };
    const store = new NotificationSettingsStore(state);
    await store.initialize(existing);
    expect(store.settings()).toEqual({ ...DEFAULTS, ...existing });
    expect(new NotificationSettingsStore(state).settings()).toEqual(store.settings());
    await store.change({ quietHours: null });
    await store.initialize(existing);
    expect(store.settings().quietHours).toBeNull();
  });
  it('rejects a queued change when its device is revoked', async () => {
    const store = new NotificationSettingsStore(stateDir());
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const apply = vi.spyOn(SettingsWriteThrough.prototype, 'apply');
    apply.mockImplementationOnce(async () => { await waiting; return {} as never; });
    const first = store.change({ quietHours: null });
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    const device = new AbortController();
    const queued = withDeviceSignal(device.signal, () => store.change({ rules: [finished] }));
    const rejected = expect(queued).rejects.toMatchObject({ status: 403 });
    device.abort(); release();
    await first; await rejected;
    expect(apply).toHaveBeenCalledOnce();
    expect(store.settings().rules).toEqual(DEFAULTS.rules);
  });

  it.each([
    { rules: [{ event: 'unknown', source: '*', delivery: 'toast' }] },
    { rules: [{ event: 'agent-needs-you', source: '*', delivery: 'neither' }] },
    { quietHours: { start: '25:00', end: '07:00' } },
    { push: { approvals: 'yes', cards: false } },
  ])('preserves valid JSON with invalid notification settings: %j', async (invalid) => {
    const store = new NotificationSettingsStore(stateDir());
    const bytes = JSON.stringify(invalid);
    writeFileSync(store.path, bytes, { mode: 0o600 });
    await expect(store.change({ quietHours: null })).rejects.toThrow(SettingsWriteError);
    expect(readFileSync(store.path, 'utf8')).toBe(bytes);
  });
  it('keeps every key, its own mode, and says what it wrote', async () => {
    const store = new NotificationSettingsStore(stateDir());
    const change = await store.change({
      rules: [finished],
      quietHours: { start: '23:30', end: '06:30' },
      push: { approvals: false, cards: true },
    });
    expect(change.changed).toBe(true);
    expect(change.settings).toEqual({
      rules: [finished],
      quietHours: { start: '23:30', end: '06:30' },
      push: { approvals: false, cards: true },
    });
    expect(store.settings()).toEqual(change.settings);
    expect(JSON.parse(readFileSync(store.path, 'utf8'))).toEqual(change.settings);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });

  it('writes a file a settings page can read back as its own body', async () => {
    const store = new NotificationSettingsStore(stateDir());
    await store.change({ rules: [finished], quietHours: null, push: { approvals: true, cards: true } });
    const onDisk = JSON.parse(readFileSync(store.path, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(onDisk).sort()).toEqual(['push', 'quietHours', 'rules']);
  });

  it('touches nothing when the file already says exactly this', async () => {
    const store = new NotificationSettingsStore(stateDir());
    await store.change({ rules: [finished] });
    const before = { bytes: readFileSync(store.path), mtime: statSync(store.path).mtimeMs, inode: statSync(store.path).ino };
    const again = await store.change({ rules: [finished] });
    expect(again.changed).toBe(false);
    expect(again.undo).toBeUndefined();
    expect(readFileSync(store.path)).toEqual(before.bytes);
    expect(statSync(store.path).mtimeMs).toBe(before.mtime);
    // The unchanged write still reports the settings it was asked to keep.
    expect(again.settings.rules).toEqual([finished]);
  });

  it('changes one key and leaves the others as they were', async () => {
    const store = new NotificationSettingsStore(stateDir());
    await store.change({ push: { approvals: false, cards: true } });
    await store.change({ quietHours: null });
    expect(store.settings()).toEqual({ ...DEFAULTS, push: { approvals: false, cards: true }, quietHours: null });
  });

  it('refuses a rule that would switch off an agent waiting on an answer', async () => {
    const store = new NotificationSettingsStore(stateDir());
    await expect(store.change({ rules: [{ event: 'agent-needs-you', source: '*', delivery: 'neither' }] })).rejects.toThrow();
    expect(store.settings()).toEqual(DEFAULTS);
    expect(existsSync(store.path)).toBe(false);
  });

  it.each([
    ['a time that isn’t one', { quietHours: { start: '9pm', end: '07:00' } }],
    ['an unknown switch', { push: { approvals: true, cards: true, locks: true } as never }],
    ['a source nobody names', { rules: [{ event: 'agent-finished', source: 'slack', delivery: 'toast' } as never] }],
  ])('refuses %s and writes nothing', async (_what, input) => {
    const store = new NotificationSettingsStore(stateDir());
    await expect(store.change(input)).rejects.toThrow();
    expect(existsSync(store.path)).toBe(false);
  });

  it('keeps two writes to different keys from losing each other', async () => {
    const store = new NotificationSettingsStore(stateDir());
    await Promise.all([
      store.change({ rules: [finished] }),
      store.change({ quietHours: { start: '22:00', end: '06:00' } }),
    ]);
    expect(store.settings()).toEqual({
      rules: [finished],
      quietHours: { start: '22:00', end: '06:00' },
      push: DEFAULTS.push,
    });
  });

  it('will not write over a file that isn’t a plain file', async () => {
    const state = stateDir();
    const store = new NotificationSettingsStore(state);
    mkdirSync(join(state, WAYROOST_SETTINGS_FILE));
    await expect(store.change({ rules: [finished] })).rejects.toThrow(SettingsWriteError);
  });

  it('will not write through a link planted at its name', async () => {
    const state = stateDir();
    const store = new NotificationSettingsStore(state);
    await store.change({ rules: [finished] });
    const aside = join(state, 'elsewhere.json');
    const written = readFileSync(store.path, 'utf8');
    rmSync(store.path);
    writeFileSync(aside, written, { mode: 0o600 });
    symlinkSync(aside, store.path);
    await expect(store.change({ quietHours: null })).rejects.toThrow(SettingsWriteError);
    expect(readFileSync(aside, 'utf8')).toBe(written);
  });

  it('keeps a file it cannot parse as it is, rather than replacing it', async () => {
    const state = stateDir();
    const store = new NotificationSettingsStore(state);
    writeFileSync(store.path, 'not json', { mode: 0o600 });
    await expect(store.change({ rules: [finished] })).rejects.toThrow(SettingsWriteError);
    expect(readFileSync(store.path, 'utf8')).toBe('not json');
  });

  it('keeps the owner and mode another writer gave the file', async () => {
    const state = stateDir();
    const store = new NotificationSettingsStore(state);
    await store.change({ rules: [finished] });
    chmodSync(store.path, 0o640);
    await store.change({ quietHours: null });
    expect(statSync(store.path).mode & 0o777).toBe(0o640);
  });
});

describe('through the write-through core', () => {
  it('backs up the bytes it replaced, audits the change, and undoes it', async () => {
    const state = stateDir();
    const store = new NotificationSettingsStore(state);
    const first = await store.change({ rules: [finished] });
    const before = readFileSync(store.path, 'utf8');

    const second = await store.change({ quietHours: null }, { device: 'dv_aaaaaaaaaaaaaaaaaaaaaaaa', level: 'anywhere' });
    expect(second.changed).toBe(true);
    expect(store.settings().quietHours).toBeNull();

    const backupId = second.undo!.backupId;
    expect(readFileSync(join(state, WAYROOST_SETTINGS_BACKUPS, backupId), 'utf8')).toBe(before);
    const audit = readFileSync(join(state, WAYROOST_SETTINGS_AUDIT_DIR, 'settings.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({
      action: 'apply',
      target: store.path,
      backupId,
      operations: [{ type: 'set', path: ['quietHours'] }],
      timing: 'now',
      result: 'success',
      device: 'dv_aaaaaaaaaaaaaaaaaaaaaaaa',
      level: 'anywhere',
    });

    await store.undo(second.undo!);
    expect(store.settings().quietHours).toEqual(DEFAULTS.quietHours);
    expect(readFileSync(store.path, 'utf8')).toBe(before);
    expect(auditLines(state)).toHaveLength(3);
    expect(auditLines(state)[2]).toMatchObject({ action: 'undo', result: 'success' });
  });

  it('keeps its backups and audit in their own folders, out of each other’s way', async () => {
    const state = stateDir();
    const store = new NotificationSettingsStore(state);
    await store.change({ rules: [finished] });
    expect(readdirSync(join(state, WAYROOST_SETTINGS_BACKUPS))).toHaveLength(1);
    expect(readdirSync(join(state, WAYROOST_SETTINGS_AUDIT_DIR))).toEqual(['settings.jsonl']);
    expect(lstatSync(join(state, WAYROOST_SETTINGS_BACKUPS)).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(state, WAYROOST_SETTINGS_AUDIT_DIR)).mode & 0o777).toBe(0o700);
    // Only the file the change names is written; the lock it took is gone.
    expect(readdirSync(state).sort()).toEqual([WAYROOST_SETTINGS_AUDIT_DIR, WAYROOST_SETTINGS_BACKUPS, WAYROOST_SETTINGS_FILE].sort());
  });
});

function auditLines(state: string): Record<string, unknown>[] {
  const path = join(state, WAYROOST_SETTINGS_AUDIT_DIR, 'settings.jsonl');
  return existsSync(path)
    ? readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
}
