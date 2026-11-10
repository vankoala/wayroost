import { deviceSignal, withDeviceSignal } from '../src/security/device-signal.js';
import { BackgroundGate } from '../src/background.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HermesAdapter } from '../src/hermes/adapter.js';
import { HermesAuth } from '../src/hermes/auth.js';
import { EventHub } from '../src/hub.js';
import { Lineage } from '../src/lineage.js';
import { SecretStore } from '../src/secrets.js';
import { FakeHermes } from './fake-hermes.js';

const quietLog = { info() {}, warn() {}, error() {} };
const AT = 1_790_490_000;
const row = (id: string, source = 'oneshot') => ({ id, source, title: `Task ${id}`, last_active: AT, ended_at: AT, is_active: false, message_count: 2, cwd: '/home/me/research' });

// Exercise the adapter's real list/cache/lineage code using the fake's HTTP
// response logic, without a gateway connection or listening socket.
describe('one-shot listing with a separate budget', () => {
  let secretsDir: string;
  let fake: FakeHermes;
  let adapter: HermesAdapter;
  let lineage: Lineage;
  let now: number;
  let failOneshots: boolean;

  beforeEach(() => {
    fake = new FakeHermes();
    now = AT * 1000;
    failOneshots = false;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(HermesAuth.prototype, 'json').mockImplementation(async (path, init) => {
      const url = new URL(path, 'http://fake.invalid');
      if (init?.method === 'PATCH') {
        const id = decodeURIComponent(url.pathname.split('/').pop()!);
        const body = JSON.parse(String(init.body));
        fake.patches.push({ id, body });
        if (body.archived) fake.archived.add(id);
        else fake.archived.delete(id);
        return {} as never;
      }
      if (url.pathname === '/api/sessions') {
        const query = Object.fromEntries(url.searchParams);
        fake.listQueries.push(query);
        if (failOneshots && query.source === 'oneshot') throw new Error('fake list unavailable');
        return structuredClone(fake.sessionList(query)) as never;
      }
      if (url.pathname === '/api/chat/workspaces') return { default_cwd: '/home/me' } as never;
      if (url.pathname === '/api/config/defaults') return { sessions: { show_subagents: false } } as never;
      throw new Error(`Unexpected fake request: ${path}`);
    });
    lineage = new Lineage(null, quietLog, () => now, new BackgroundGate('primary'));
    secretsDir = mkdtempSync(join(tmpdir(), 'wayroost-oneshot-'));
    adapter = new HermesAdapter('http://fake.invalid', new EventHub(), new SecretStore(secretsDir), quietLog, { lineage, background: new BackgroundGate('shadow') });
  });

  afterEach(() => {
    adapter.stop();
    vi.restoreAllMocks();
    rmSync(secretsDir, { recursive: true, force: true });
  });

  const queries = (source: string) => fake.listQueries.filter((q) => q.source === source);

  it('keeps 60 ordinary chats despite more than 100 newer one-shots, and lists the newest 100 runs', async () => {
    fake.topLevel = [
      ...Array.from({ length: 141 }, (_, i) => ({ ...row(`auto${i}`), last_active: AT + 141 - i })),
      ...Array.from({ length: 65 }, (_, i) => ({ ...row(`chat${i}`, 'desktop'), last_active: AT - i })),
      row('cron', 'cron'), row('acp', 'acp'),
    ];
    const list = await adapter.listConversations();
    expect(list.filter((c) => c.id.startsWith('chat'))).toHaveLength(60);
    expect(list.filter((c) => c.id.startsWith('auto'))).toHaveLength(100);
    expect(list.map((c) => c.id)).toContain('chat59');
    for (const missing of ['auto100', 'chat60', 'cron', 'acp']) expect(list.map((c) => c.id)).not.toContain(missing);
    expect(queries('oneshot')).toEqual([{ source: 'oneshot', limit: '100', order: 'recent', archived: 'exclude', min_messages: '1' }]);
    expect(fake.listQueries.find((q) => q.limit === '60')!.exclude_sources).toBe('cron,acp,oneshot');
  });

  it('de-duplicates overlapping rows and keeps launch lineage for one-shots', async () => {
    fake.topLevel = [row('chat', 'desktop'), row('auto'), row('auto')];
    lineage.noteLaunch('auto', [{ kind: 'hermes', id: 'chat' }], now - 1000);
    // Simulate an older dashboard that ignores the main query's source exclusion.
    const listResponse = fake.sessionList.bind(fake);
    vi.spyOn(fake, 'sessionList').mockImplementation((q) => q.limit === '60'
      ? { sessions: fake.topLevel, total: 3 }
      : listResponse(q));
    const list = await adapter.listConversations();
    expect(list.map((c) => c.id)).toEqual(['chat', 'auto']);
    expect(list[1]).toMatchObject({ subagent: true, parent: { source: 'hermes', id: 'chat' } });
  });

  it('caches one-shots independently for 10 seconds', async () => {
    fake.topLevel = [row('first')];
    await adapter.listConversations();
    fake.topLevel.push(row('next'));
    now += 3100;
    expect((await adapter.listConversations()).map((c) => c.id)).toEqual(['first']);
    expect(queries('oneshot')).toHaveLength(1);
    now += 7000;
    expect((await adapter.listConversations()).map((c) => c.id)).toEqual(['first', 'next']);
    expect(queries('oneshot')).toHaveLength(2);
  });

  it('lists runs even when delegate runs are disabled, and uses them as delegate parents', async () => {
    fake.topLevel = [row('auto')];
    fake.showSubagents = false;
    expect((await adapter.listConversations()).map((c) => c.id)).toEqual(['auto']);
    fake.showSubagents = true;
    fake.topLevel.push(...Array.from({ length: 140 }, (_, i) => row(`extra${i}`)));
    fake.subagentRuns = [{ ...row('delegate', 'desktop'), parent_session_id: 'auto' }];
    now += 10_100;
    expect(await adapter.listConversations()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'delegate', subagent: true, parent: { source: 'hermes', id: 'auto' } }),
    ]));
    expect(fake.listQueries.find((q) => q.exclude_sources?.includes('subagent'))!.exclude_sources).toBe('cron,acp,oneshot,subagent');
  });

  it('excludes archived and empty runs and keeps chats available if the run fetch fails', async () => {
    fake.topLevel = [row('chat', 'desktop'), row('archived'), { ...row('empty'), message_count: 0 }];
    fake.archived.add('archived');
    expect((await adapter.listConversations()).map((c) => c.id)).toEqual(['chat']);
    now += 10_100;
    failOneshots = true;
    expect((await adapter.listConversations()).map((c) => c.id)).toEqual(['chat']);
  });

  it('pages through older one-shots for tidy and folder archive, then restores without a stale cache', async () => {
    fake.topLevel = [
      ...Array.from({ length: 130 }, (_, i) => ({ ...row(`auto${i}`), last_active: AT - 30 * 86400 })),
      { ...row('nested'), cwd: '/home/me/research/sub', last_active: AT - 30 * 86400 },
      { ...row('outside'), cwd: '/home/me/outside', last_active: AT - 30 * 86400 },
    ];
    expect(await adapter.listConversations()).toHaveLength(100);
    expect(await adapter.idleThreads(now - 14 * 86400_000)).toHaveLength(132);
    expect(fake.listQueries.filter((q) => q.offset !== undefined).map((q) => q.offset)).toEqual(['0', '100']);
    expect(await adapter.archiveThreads(['auto0'], { path: '/home/me/research', paseoRoots: [] })).toEqual({ done: 130, failed: [] });
    expect(fake.archived.size).toBe(130);
    expect(fake.archived.has('auto129')).toBe(true);
    expect(fake.archived.has('nested')).toBe(false);
    expect((await adapter.listConversations()).map((c) => c.id)).not.toContain('auto0');
    expect((await adapter.listArchived(50)).map((c) => c.id)).toContain('auto0');
    await adapter.restoreThreads(['auto0']);
    expect((await adapter.listConversations()).map((c) => c.id)).toContain('auto0');
  });

  it('shares the independent fetch while each device can cancel only its own waiter', async () => {
    let release!: (rows: { sessions: ReturnType<typeof row>[] }) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<{ sessions: ReturnType<typeof row>[] }>((resolve) => { release = resolve; });
    const json = vi.mocked(HermesAuth.prototype.json).getMockImplementation()!;
    let calls = 0;
    vi.mocked(HermesAuth.prototype.json).mockImplementation(async (path, ...args) => {
      if (new URL(path, 'http://fake.invalid').searchParams.get('source') === 'oneshot') {
        calls++;
        expect(deviceSignal()).toBeUndefined();
        started();
        return await pending as never;
      }
      return json(path, ...args);
    });
    const device = new AbortController();
    const canceled = withDeviceSignal(device.signal, () => adapter.listConversations());
    const rejection = expect(canceled).rejects.toMatchObject({ status: 403 });
    await began;
    const other = adapter.listConversations();
    device.abort();
    await rejection;
    release({ sessions: [row('auto')] });
    expect((await other).map((c) => c.id)).toContain('auto');
    expect(calls).toBe(1);
  });

  it('lists active and recent unfinished one-shots as running, and crashed old runs as idle', async () => {
    fake.topLevel = [
      { ...row('external'), ended_at: AT, is_active: true, last_active: AT - 30 * 86400 },
      { ...row('recent'), ended_at: null, last_active: AT - 3600 },
      { ...row('crashed'), ended_at: null, last_active: AT - 3 * 86400 },
      row('ended'),
    ];
    expect(await adapter.listConversations()).toEqual([
      expect.objectContaining({ id: 'external', status: 'running' }),
      expect.objectContaining({ id: 'recent', status: 'running' }),
      expect.objectContaining({ id: 'crashed', status: 'idle' }),
      expect.objectContaining({ id: 'ended', status: 'idle' }),
    ]);
  });

  it.each([
    { last_active: AT - 60, started_at: AT - 86400 },
    { last_active: AT - 86400, started_at: AT - 60 },
    { last_active: null, started_at: AT - 60 },
    { last_active: Number.NaN, started_at: AT - 60 },
    { last_active: AT - 60, started_at: Number.POSITIVE_INFINITY },
  ])('bounds unfinished liveness using the freshest valid row stamp: %j', async (stamps) => {
    fake.topLevel = [{ ...row('unfinished'), ended_at: null, ...stamps }];
    expect((await adapter.listConversations())[0]?.status).toBe('running');
    // Just inside the allowance, then exactly at six hours from the freshest stamp.
    now = (AT - 60) * 1000 + 6 * 3600_000 - 1;
    expect((await adapter.listConversations())[0]?.status).toBe('running');
    now++;
    expect((await adapter.listConversations())[0]?.status).toBe('idle');
  });

  it('does not infer a live one-shot from missing or invalid activity stamps alone', async () => {
    fake.topLevel = [{ ...row('undated'), ended_at: null, last_active: null, started_at: -1 }];
    expect((await adapter.listConversations())[0]?.status).toBe('idle');
  });

  it.each(['desktop', 'tui', 'telegram'])('keeps the recent-write flag authoritative for %s listings and sweeps', async (source) => {
    fake.topLevel = [{ ...row('active-chat', source), is_active: true, last_active: AT - 30 * 86400 }];
    expect((await adapter.listConversations())[0]?.status).toBe('running');
    expect(await adapter.idleThreads(now - 86400_000)).toEqual([]);
    expect(await adapter.archiveThreads([], { path: '/home/me/research', paseoRoots: [] })).toEqual({ done: 0, failed: [] });
  });

  it.each(['tidy', 'folder archive'])('spares live one-shots and sweeps crashed runs beyond the listing window during %s', async (action) => {
    fake.topLevel = [
      ...Array.from({ length: 100 }, (_, i) => row(`recent${i}`)),
      { ...row('external'), ended_at: null, is_active: true, last_active: AT - 30 * 86400 },
      { ...row('recent-unfinished'), ended_at: null, last_active: AT - 30 * 86400, started_at: AT - 3600 },
      { ...row('crashed'), ended_at: null, is_active: false, last_active: AT - 3 * 86400 },
      { ...row('ended'), last_active: AT - 30 * 86400 },
    ];
    expect(await adapter.listConversations()).toHaveLength(100);
    if (action === 'tidy') {
      const idle = await adapter.idleThreads(now - 86400_000);
      expect(idle).toEqual(['crashed', 'ended']);
      expect(await adapter.archiveThreads(idle)).toEqual({ done: 2, failed: [] });
    } else {
      expect(await adapter.archiveThreads([], { path: '/home/me/research', paseoRoots: [] })).toEqual({ done: 102, failed: [] });
    }
    expect(fake.archived.has('ended')).toBe(true);
    expect(fake.archived.has('crashed')).toBe(true);
    expect(fake.archived.has('external')).toBe(false);
    expect(fake.archived.has('recent-unfinished')).toBe(false);
  });

  it.each(['tidy', 'folder archive'])('sweeps a finished run fetched beyond 100 rows after it was cached active: %s', async (action) => {
    fake.topLevel = [{ ...row('finished'), ended_at: null, is_active: true }];
    expect((await adapter.listConversations())[0]).toMatchObject({ id: 'finished', status: 'running' });
    Object.assign(fake.topLevel[0]!, { ended_at: AT + 60, is_active: false });
    fake.topLevel.unshift(...Array.from({ length: 100 }, (_, i) => ({ ...row(`newer${i}`), last_active: AT + 120 })));
    now += 30 * 86400_000;
    expect(adapter['rows'].get('finished')?.is_active).toBe(true);
    if (action === 'tidy') {
      const idle = await adapter.idleThreads(now - 14 * 86400_000);
      expect(idle).toContain('finished');
      // Keep it in the list cache to prove a fresh sweep row also corrects its displayed status.
      expect(adapter['summaryFor']('finished').status).toBe('idle');
      await adapter.archiveThreads(idle);
      expect(fake.archived.has('finished')).toBe(true);
    } else {
      expect(await adapter.archiveThreads([], { path: '/home/me/research', paseoRoots: [] })).toEqual({ done: 101, failed: [] });
      expect(fake.archived.has('finished')).toBe(true);
    }
  });

  it('clears cached active listing status from a fresh completed sweep row while retaining live activity and approvals', async () => {
    fake.topLevel = ['finished', 'live', 'approval'].map((id) => ({ ...row(id), ended_at: null, is_active: true }));
    expect((await adapter.listConversations()).every((c) => c.status === 'running')).toBe(true);
    for (const run of fake.topLevel) Object.assign(run, { ended_at: AT, is_active: false, last_active: AT - 30 * 86400 });
    adapter['activeByStored'].set('live', 'working');
    vi.spyOn(adapter, 'listApprovals').mockReturnValue([{ conversationId: 'approval' }] as never);
    expect(await adapter.idleThreads(now - 86400_000)).toEqual(['finished']);
    expect(await adapter.listConversations()).toEqual([
      expect.objectContaining({ id: 'finished', status: 'idle' }),
      expect.objectContaining({ id: 'live', status: 'running' }),
      expect.objectContaining({ id: 'approval', status: 'needs_approval' }),
    ]);
  });

  it('discards a one-shot response that was already in flight when its chat was archived', async () => {
    fake.topLevel = [row('chat', 'desktop'), row('auto')];
    await adapter.listConversations();
    now += 10_100;
    let release!: (value: { sessions: ReturnType<typeof row>[] }) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<{ sessions: ReturnType<typeof row>[] }>((resolve) => { release = resolve; });
    const json = vi.mocked(HermesAuth.prototype.json).getMockImplementation()!;
    vi.mocked(HermesAuth.prototype.json).mockImplementation(async (path, ...args) => {
      if (new URL(path, 'http://fake.invalid').searchParams.get('source') === 'oneshot') {
        started();
        return await pending as never;
      }
      return json(path, ...args);
    });
    const listing = adapter.listConversations();
    await began;
    expect(await adapter.archiveThreads(['auto'])).toEqual({ done: 1, failed: [] });
    release({ sessions: [row('auto')] });
    expect((await listing).map((c) => c.id)).not.toContain('auto');
  });

});
