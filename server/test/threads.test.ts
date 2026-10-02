import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '../../shared/protocol.js';
import { HermesAdapter } from '../src/hermes/adapter.js';
import { EventHub } from '../src/hub.js';
import { PaseoAdapter } from '../src/paseo/adapter.js';
import { SecretStore } from '../src/secrets.js';
import { FAKE_USER, FakeHermes } from './fake-hermes.js';
import { ORIGIN, apiHeaders, makeApp, makeKeys, makeToken, postHeaders, type Keys } from './helpers.js';

const quietLog = { info() {}, warn() {}, error() {} };
const DAY = 86_400_000;

// ---- the routes -------------------------------------------------------------------------

describe('app: tidying up threads', () => {
  let keys: Keys;
  let token: string;
  beforeAll(async () => {
    keys = await makeKeys();
    token = await makeToken(keys);
  });

  type App = Awaited<ReturnType<typeof makeApp>>['app'];
  const post = (app: App, url: string, body: unknown, headers = postHeaders(token)) =>
    app.inject({ method: 'POST', url, headers, payload: JSON.stringify(body) });

  it('archives each thread in its own backend; only Hermes sweeps the folder', async () => {
    const { app, hermes, paseo } = await makeApp(keys);
    const res = await post(app, '/api/threads/archive', {
      threads: [
        { source: 'hermes', id: 'h1' },
        { source: 'paseo', id: 'p1' },
        { source: 'paseo', id: 'p2' },
        { source: 'paseo', id: 'p1' },
      ],
      folder: { path: '/home/me/code/app', paseoRoots: ['/home/me/code/app'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ done: 3, failed: [] });
    expect(hermes.tidying.calls).toEqual(['archive:h1@/home/me/code/app|/home/me/code/app']);
    // Paseo lists every agent it has, so it only archives the ones named (once each).
    expect(paseo.tidying.calls).toEqual(['archive:p1,p2']);
    await app.close();
  });

  it('archiving just a folder still sweeps Hermes', async () => {
    const { app, hermes, paseo } = await makeApp(keys);
    const res = await post(app, '/api/threads/archive', { threads: [], folder: { path: '/home/me/x', paseoRoots: [] } });
    expect(res.statusCode).toBe(200);
    expect(hermes.tidying.calls).toEqual(['archive:@/home/me/x|']);
    expect(paseo.tidying.calls).toEqual([]);
    await app.close();
  });

  it('says which threads failed and why, and counts the rest', async () => {
    const { app } = await makeApp(keys);
    const res = await post(app, '/api/threads/delete', {
      threads: [
        { source: 'paseo', id: 'p1' },
        { source: 'paseo', id: 'broken-1' },
        { source: 'hermes', id: 'h1' },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ done: 2, failed: [{ source: 'paseo', id: 'broken-1', error: 'it broke' }] });
    await app.close();
  });

  it('restores and deletes through the backends', async () => {
    const { app, hermes, paseo } = await makeApp(keys);
    expect((await post(app, '/api/threads/restore', { threads: [{ source: 'hermes', id: 'h9' }] })).statusCode).toBe(200);
    expect((await post(app, '/api/threads/delete', { threads: [{ source: 'paseo', id: 'p9' }] })).statusCode).toBe(200);
    expect(hermes.tidying.calls).toEqual(['restore:h9']);
    expect(paseo.tidying.calls).toEqual(['delete:p9']);
    await app.close();
  });

  it('refuses requests that name nothing, a bad thread or a relative folder', async () => {
    const { app, hermes, paseo } = await makeApp(keys);
    const bad = [
      ['/api/threads/archive', { threads: [] }],
      ['/api/threads/archive', { threads: [{ source: 'slack', id: 'x' }] }],
      ['/api/threads/archive', { threads: [{ source: 'hermes', id: '../etc' }] }],
      ['/api/threads/archive', { threads: [], folder: { path: 'code/app', paseoRoots: [] } }],
      ['/api/threads/restore', { threads: [] }],
      ['/api/threads/delete', { threads: Array.from({ length: 501 }, (_, i) => ({ source: 'paseo', id: `p${i}` })) }],
      ['/api/threads/delete', { threads: [{ source: 'paseo', id: 'p1' }], everything: true }],
    ] as const;
    for (const [url, body] of bad) expect((await post(app, url, body)).statusCode, `${url} ${JSON.stringify(body).slice(0, 60)}`).toBe(400);
    expect([...hermes.tidying.calls, ...paseo.tidying.calls]).toEqual([]);
    await app.close();
  });

  it('holds every change to the same sign-in and cross-site rules', async () => {
    const { app, paseo } = await makeApp(keys);
    const host = new URL(ORIGIN).host;
    const body = { threads: [{ source: 'paseo', id: 'p1' }] };
    expect((await post(app, '/api/threads/delete', body, { host, origin: ORIGIN, 'content-type': 'application/json' })).statusCode).toBe(401);
    const crossSite: Record<string, string> = { ...postHeaders(token), origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
    delete crossSite['x-signalbox-request'];
    expect((await post(app, '/api/threads/delete', body, crossSite)).statusCode).toBe(403);
    expect((await post(app, '/api/cleanup', { idleDays: 1 }, crossSite)).statusCode).toBe(403);
    expect(paseo.tidying.calls).toEqual([]);
    await app.close();
  });

  it('lists what both backends archived, newest first', async () => {
    const { app, hermes, paseo } = await makeApp(keys);
    hermes.tidying.archivedRows = [{ source: 'hermes', id: 'h1', title: 'Old chat', updatedAt: 100 }];
    paseo.tidying.archivedRows = [
      { source: 'paseo', id: 'p1', title: 'Newer agent', updatedAt: 300, folder: '~/code/app' },
      { source: 'paseo', id: 'p2', title: 'Middle agent', updatedAt: 200 },
    ];
    const res = await app.inject({ url: '/api/threads/archived', headers: apiHeaders(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().threads.map((t: { id: string }) => t.id)).toEqual(['p1', 'p2', 'h1']);
    await app.close();
  });

  it('counts, then archives, the threads idle for the chosen days', async () => {
    const { app, hermes, paseo } = await makeApp(keys);
    hermes.tidying.idle = ['h1', 'h2'];
    paseo.tidying.idle = ['p1'];
    const t0 = Date.now();
    const preview = await app.inject({ url: '/api/cleanup?idleDays=14', headers: apiHeaders(token) });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ idleDays: 14, count: 3 });
    // "Idle for 14 days" means last active before now minus 14 days.
    expect(Math.abs(hermes.tidying.idleBefore[0]! - (t0 - 14 * DAY))).toBeLessThan(5_000);

    const res = await post(app, '/api/cleanup', { idleDays: 14 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ done: 3, failed: [] });
    expect(hermes.tidying.calls).toEqual(['archive:h1,h2']);
    expect(paseo.tidying.calls).toEqual(['archive:p1']);
    await app.close();
  });

  it('does nothing when nothing is idle, and refuses a nonsense number of days', async () => {
    const { app, hermes, paseo } = await makeApp(keys);
    const res = await post(app, '/api/cleanup', { idleDays: 30 });
    expect(res.json()).toEqual({ done: 0, failed: [] });
    expect([...hermes.tidying.calls, ...paseo.tidying.calls]).toEqual([]);
    expect((await app.inject({ url: '/api/cleanup?idleDays=0', headers: apiHeaders(token) })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/cleanup?idleDays=soon', headers: apiHeaders(token) })).statusCode).toBe(400);
    expect((await post(app, '/api/cleanup', { idleDays: 1.5 })).statusCode).toBe(400);
    await app.close();
  });
});

// ---- Hermes, against the fake dashboard -----------------------------------------------------

describe('hermes: archive, restore, delete, idle', () => {
  let fake: FakeHermes;
  let events: ServerEvent[];
  let adapter: HermesAdapter;

  const chat = (id: string, cwd: string, lastActiveDaysAgo: number, extra: object = {}) => ({
    id,
    source: 'desktop',
    title: `Chat ${id}`,
    started_at: Math.floor((Date.now() - (lastActiveDaysAgo + 1) * DAY) / 1000),
    last_active: Math.floor((Date.now() - lastActiveDaysAgo * DAY) / 1000),
    message_count: 3,
    cwd,
    ...extra,
  });

  beforeEach(async () => {
    fake = new FakeHermes();
    await fake.start();
    const hub = new EventHub();
    events = [];
    hub.add({ readyState: 1, bufferedAmount: 0, send: (p: string) => events.push(JSON.parse(p)), terminate() {} } as never, 'x');
    const stateDir = mkdtempSync(join(tmpdir(), 'sb-tidy-'));
    new SecretStore(stateDir).writeHermes(FAKE_USER);
    adapter = new HermesAdapter(fake.url, hub, new SecretStore(stateDir), quietLog);
  });

  afterEach(async () => {
    adapter.stop();
    await fake.stop();
  });

  const connect = async () => {
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');
  };
  const removed = () => events.filter((e) => e.type === 'conversation_removed').map((e) => (e as { id: string }).id);

  it("archives in Hermes, drops the chat from the inbox now, and doesn't list it again", async () => {
    fake.topLevel = [chat('a', '/home/me/proj', 1), chat('b', '/home/me/proj', 2)];
    await connect();
    expect((await adapter.listConversations()).map((c) => c.id)).toEqual(['a', 'b']);

    expect(await adapter.archiveThreads(['a'])).toEqual({ done: 1, failed: [] });
    expect(fake.patches).toEqual([{ id: 'a', body: { archived: true } }]);
    expect(removed()).toContain('a');
    expect((await adapter.listConversations()).map((c) => c.id)).toEqual(['b']);
  });

  it('with a folder, also archives the older chats Hermes has there, placed as the Projects view does', async () => {
    fake.topLevel = [
      chat('listed', '/home/me/proj', 1),
      chat('older', '/home/me/proj', 40),
      chat('nested', '/home/me/proj/sub', 50),
      chat('elsewhere', '/home/me/other', 60),
      chat('lookalike', '/home/me/project2', 60),
    ];
    await connect();
    // No Paseo project holds /home/me/proj/sub, so it's a project of its own.
    await adapter.archiveThreads(['listed'], { path: '/home/me/proj', paseoRoots: [] });
    expect([...fake.archived].sort()).toEqual(['listed', 'older']);

    // With /home/me/proj a Paseo project root, its subfolders belong to it.
    await adapter.archiveThreads([], { path: '/home/me/proj', paseoRoots: ['/home/me/proj', '/home/me/other'] });
    expect([...fake.archived].sort()).toEqual(['listed', 'nested', 'older']);
  });

  it('restores: un-archives in Hermes and shows it again', async () => {
    fake.topLevel = [chat('a', '/home/me/proj', 1)];
    await connect();
    await adapter.archiveThreads(['a']);
    expect(await adapter.restoreThreads(['a'])).toEqual({ done: 1, failed: [] });
    expect(fake.patches.at(-1)).toEqual({ id: 'a', body: { archived: false } });
    await expect.poll(async () => (await adapter.listConversations()).map((c) => c.id)).toEqual(['a']);
  });

  it("deletes the chat's whole compression lineage, hiding it first", async () => {
    fake.topLevel = [chat('tip', '/home/me/proj', 1, { _lineage_ids: ['root', 'middle', 'tip'] })];
    await connect();
    await adapter.listConversations();
    expect(await adapter.deleteThreads(['tip'])).toEqual({ done: 1, failed: [] });
    expect(fake.patches).toEqual([{ id: 'tip', body: { archived: true } }]);
    expect(fake.deletes).toEqual(['tip', 'root', 'middle']);
    expect(removed()).toContain('tip');
  });

  it('lists archived chats with their folder', async () => {
    fake.topLevel = [chat('a', '/home/me/proj', 3), chat('b', '/home/me/other', 1)];
    fake.archived.add('a');
    await connect();
    const archived = await adapter.listArchived(50);
    expect(archived).toEqual([
      expect.objectContaining({ source: 'hermes', id: 'a', title: 'Chat a', folder: '~/proj' }),
    ]);
    expect(fake.listQueries.at(-1)).toMatchObject({ archived: 'only' });
  });

  it('finds every idle chat, a page at a time, not just the ones the inbox lists', async () => {
    fake.topLevel = [
      ...Array.from({ length: 130 }, (_, i) => chat(`old${i}`, '/home/me/proj', 30 + i)),
      chat('fresh', '/home/me/proj', 1),
    ];
    await connect();
    const idle = await adapter.idleThreads(Date.now() - 14 * DAY);
    expect(idle).toHaveLength(130);
    expect(idle).not.toContain('fresh');
    const pages = fake.listQueries.filter((q) => q.offset !== undefined);
    expect(pages.map((q) => q.offset)).toEqual(['0', '100']);
    expect(pages.every((q) => q.archived === 'exclude')).toBe(true);
  });
});

// ---- Paseo, against a small fake client ---------------------------------------------------------

function fakePaseo() {
  const old = new Date(Date.now() - 40 * DAY).toISOString();
  const recent = new Date(Date.now() - DAY).toISOString();
  const agent = (id: string, overrides: object = {}) => ({
    id,
    provider: 'claude',
    cwd: '/home/me/code/app',
    title: `Agent ${id}`,
    status: 'idle',
    createdAt: old,
    updatedAt: old,
    lastUserMessageAt: old,
    pendingPermissions: [],
    labels: {},
    capabilities: { supportsStreaming: true },
    ...overrides,
  });
  const listed = [
    agent('parent'),
    agent('child', { labels: { 'paseo.parent-agent-id': 'parent' } }),
    agent('busy', { status: 'running' }),
    agent('fresh', { lastUserMessageAt: recent, updatedAt: recent }),
  ];
  const archived = [agent('gone', { archivedAt: old, updatedAt: old })];
  const calls: string[] = [];
  let statusListener: ((s: { status: string }) => void) | undefined;
  const client = {
    subscribeConnectionStatus: (l: (s: { status: string }) => void) => {
      statusListener = l;
      return () => {};
    },
    on: () => () => {},
    connect: async () => statusListener?.({ status: 'connected' }),
    close: async () => {},
    getLastServerInfoMessage: () => null,
    getProvidersSnapshot: async () => ({ requestId: 'p', entries: [] }),
    fetchAgents: async (options: { filter?: { includeArchived?: boolean } }) => ({
      entries: [...listed, ...(options.filter?.includeArchived ? archived : [])].map((a) => ({ agent: a, project: null })),
      pageInfo: { hasMore: false, nextCursor: null },
    }),
    fetchAgent: async ({ agentId }: { agentId: string }) => {
      const found = archived.find((a) => a.id === agentId);
      return found ? { agent: { ...found, archivedAt: null }, project: null } : null;
    },
    archiveAgent: async (id: string) => {
      if (id.includes('broken')) throw new Error('Agent not found');
      calls.push(`archive:${id}`);
      return { archivedAt: new Date().toISOString() };
    },
    deleteAgent: async (id: string) => {
      calls.push(`delete:${id}`);
    },
    refreshAgent: async (id: string) => {
      calls.push(`refresh:${id}`);
      return {};
    },
  };
  return { client, calls };
}

describe('paseo: archive, restore, delete, idle', () => {
  let events: ServerEvent[];
  const connected = async () => {
    const daemon = fakePaseo();
    const hub = new EventHub();
    events = [];
    hub.add({ readyState: 1, bufferedAmount: 0, send: (p: string) => events.push(JSON.parse(p)), terminate() {} } as never, 'x');
    const adapter = new PaseoAdapter('ws://127.0.0.1:6777', hub, quietLog, 'cid_test', () => daemon.client as never);
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');
    return { adapter, daemon };
  };

  it('archives children before their parent, drops them from the inbox, and reports failures', async () => {
    const { adapter, daemon } = await connected();
    const result = await adapter.archiveThreads(['parent', 'child', 'broken-9']);
    expect(daemon.calls).toEqual(['archive:child', 'archive:parent']);
    expect(result).toEqual({ done: 2, failed: [{ source: 'paseo', id: 'broken-9', error: 'Agent not found' }] });
    const gone = events.filter((e) => e.type === 'conversation_removed').map((e) => (e as { id: string }).id);
    expect(gone).toEqual(expect.arrayContaining(['parent', 'child']));
    expect((await adapter.listConversations()).map((c) => c.id).sort()).toEqual(['busy', 'fresh']);
  });

  it('restores by having Paseo reload the agent, and shows it again', async () => {
    const { adapter, daemon } = await connected();
    expect(await adapter.restoreThreads(['gone'])).toEqual({ done: 1, failed: [] });
    expect(daemon.calls).toEqual(['refresh:gone']);
    expect((await adapter.listConversations()).map((c) => c.id)).toContain('gone');
  });

  it('deletes for good', async () => {
    const { adapter, daemon } = await connected();
    await adapter.deleteThreads(['fresh']);
    expect(daemon.calls).toEqual(['delete:fresh']);
    expect((await adapter.listConversations()).map((c) => c.id)).not.toContain('fresh');
  });

  it('lists only archived agents', async () => {
    const { adapter } = await connected();
    expect(await adapter.listArchived(50)).toEqual([
      expect.objectContaining({ source: 'paseo', id: 'gone', title: 'Agent gone', folder: '~/code/app' }),
    ]);
  });

  it('counts as idle only agents quiet since the cutoff, never working ones', async () => {
    const { adapter } = await connected();
    expect((await adapter.idleThreads(Date.now() - 14 * DAY)).sort()).toEqual(['child', 'parent']);
  });
});
