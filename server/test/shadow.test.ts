import { createECDH } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Approval, ConversationSummary } from '../../shared/protocol.js';
import { BackgroundGate, type ServerRole } from '../src/background.js';
import { buildBridgeServer } from '../src/bridge/server.js';
import { Bridge } from '../src/bridge/service.js';
import { readOrCreateBridgeToken } from '../src/bridge/token.js';
import { Connectors } from '../src/connectors/service.js';
import { PushSender } from '../src/feed/push.js';
import { Feed } from '../src/feed/service.js';
import { FeedStore } from '../src/feed/store.js';
import { EventHub } from '../src/hub.js';
import { Devices } from '../src/devices.js';
import { seedDevices, TEST_PHONE } from './helpers.js';
import { SafetyCommandsSetting } from '../src/hermes/safety.js';
import { Lineage } from '../src/lineage.js';
import { AgentTimelineMirror, type MirrorSink } from '../src/paseo/mirror.js';
import { Schedules } from '../src/schedules.js';
import { readOrCreateClientId } from '../src/secrets.js';
import { VoiceSetting } from '../src/voice-setting.js';

const quiet = { info() {}, warn() {}, error() {} };
const dir = () => mkdtempSync(join(tmpdir(), 'wayroost-shadow-test-'));
const roles: ServerRole[] = ['shadow', 'primary'];
const card = { key: 'mail:fake-card', kind: 'reply' as const, title: 'Demo mail', action: 'Draft a reply' };
const approval: Approval = {
  source: 'hermes', conversationId: 'fake-chat', id: 'fake-approval',
  kind: 'permission', title: 'Demo request', createdAt: 0,
  options: [{ id: 'once', label: 'Allow once', kind: 'allow' }],
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(roles)('%s background effects', (role) => {
  const background = new BackgroundGate(role);
  const on = role === 'primary';

  function feedFixture() {
    const state = dir();
    const store = new FeedStore(state);
    const hub = new EventHub();
    const schedules = { list: vi.fn(async () => ({ jobs: [] })), update: vi.fn(), setPaused: vi.fn() };
    const push = { devices: () => 1, send: vi.fn(async () => ({ sent: 1 })), add: vi.fn(() => 1), remove: vi.fn(() => 0) };
    const hermes = { createConversation: vi.fn(async () => ({ id: 'fake-created-chat' })) };
    const feed = new Feed({ background, store, hub, schedules: schedules as never, push: push as never, hermes, log: quiet });
    return { state, store, hub, schedules, push, hermes, feed };
  }

  it('gates feed startup pulse discovery', async () => {
    const { feed, schedules } = feedFixture();
    feed.start();
    await Promise.resolve();
    expect(schedules.list).toHaveBeenCalledTimes(on ? 1 : 0);
    feed.stop();
  });

  it('gates feed wake and prune interval writes', async () => {
    vi.useFakeTimers();
    const { feed, store } = feedFixture();
    const wake = vi.spyOn(store, 'wakeLater');
    const prune = vi.spyOn(store, 'prune');
    feed.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wake).toHaveBeenCalledTimes(on ? 1 : 0);
    expect(prune).toHaveBeenCalledTimes(on ? 1 : 0);
    feed.stop();
  });

  it('gates approval pushes before notified state is written and still publishes to the browser', () => {
    const { feed, store, hub, push } = feedFixture();
    const notified = vi.spyOn(store, 'markNotified');
    const send = vi.fn();
    hub.add({ readyState: 1, bufferedAmount: 0, send } as never, 'you@example.com');
    feed.start();
    hub.publish({ type: 'approval_upsert', approval });
    expect(notified).toHaveBeenCalledTimes(on ? 1 : 0);
    expect(push.send).toHaveBeenCalledTimes(on ? 1 : 0);
    expect(send).toHaveBeenCalledWith(expect.stringContaining('fake-approval'));
    feed.stop();
  });

  it('gates pulse ingestion writes and events', () => {
    const { feed, store, hub, state } = feedFixture();
    const publish = vi.spyOn(hub, 'publish');
    expect(feed.ingest('agent', [card])).toEqual({ created: on ? 1 : 0, updated: 0 });
    expect(store.all()).toHaveLength(on ? 1 : 0);
    expect(existsSync(join(state, 'feed.json'))).toBe(on);
    expect(publish).toHaveBeenCalledTimes(on ? 1 : 0);
  });

  it('gates card pushes', () => {
    const { feed, store, push } = feedFixture();
    store.updateSettings({ quietHours: null, push: { cards: true, approvals: true } });
    feed.ingest('brief', [card]);
    expect(push.send).toHaveBeenCalledTimes(on ? 1 : 0);
  });

  it('keeps requested feed actions, subscriptions and the test notification working', async () => {
    const { feed, store, push, hermes } = feedFixture();
    const item = store.ingest('brief', [card]).created[0]!;
    expect((await feed.act(item.id, 'do')).chat?.id).toBe('fake-created-chat');
    expect(hermes.createConversation).toHaveBeenCalledOnce();
    feed.addDevice({ endpoint: 'https://fcm.googleapis.com/fake-device', keys: { p256dh: 'fake', auth: 'fake' } }, TEST_PHONE.id);
    feed.removeDevice('https://fcm.googleapis.com/fake-device', TEST_PHONE.id);
    expect(push.add).toHaveBeenCalledOnce();
    expect(push.remove).toHaveBeenCalledOnce();
    expect(await feed.testPush()).toEqual({ sent: 1 });
    expect(push.send).toHaveBeenCalledWith(expect.objectContaining({ title: 'Wayroost' }), expect.any(Number), true);
  });

  it.each(['feed', 'voice', 'safety'])('creates missing state only when %s settings are requested', async (setting) => {
    const state = join(dir(), 'fresh-state');
    if (setting === 'feed') {
      const store = new FeedStore(state);
      const feed = new Feed({ background, store, hub: new EventHub(), hermes: { createConversation: vi.fn() }, log: quiet });
      expect(existsSync(state)).toBe(false);
      await feed.updateSettings({ quietHours: null });
      expect(JSON.parse(readFileSync(join(state, 'feed.json'), 'utf8')).settings.quietHours).toBeNull();
    } else if (setting === 'voice') {
      const voice = new VoiceSetting(state);
      expect(existsSync(state)).toBe(false);
      expect(voice.setVoice('af_demo')).toBe('af_demo');
      expect(new VoiceSetting(state).voice()).toBe('af_demo');
    } else {
      const safety = new SafetyCommandsSetting(state);
      expect(existsSync(state)).toBe(false);
      expect(safety.setEnabled(true)).toBe(true);
      expect(new SafetyCommandsSetting(state).enabled()).toBe(true);
    }
  });

  it('gates schedule idea model calls and cache writes, including repeated listings', async () => {
    const stateDir = dir();
    const complete = vi.fn(async () => 'Check the demo job.');
    const changed = vi.fn();
    const dashboard = { fetch: async (path: string) => Response.json(path === '/api/cron/jobs'
      ? [{ id: 'fake-job', name: 'Demo job', prompt: 'Describe the demo job', schedule: { expr: '0 9 * * *' }, enabled: true }]
      : {}) };
    const schedules = new Schedules({ background, dashboard: () => dashboard, assist: { complete }, stateDir, onChanged: changed, log: quiet });
    expect((await schedules.list()).jobs).toHaveLength(1);
    await schedules.list();
    await new Promise((resolve) => setImmediate(resolve));
    expect(complete).toHaveBeenCalledTimes(on ? 1 : 0);
    expect(changed).toHaveBeenCalledTimes(on ? 1 : 0);
    expect(existsSync(join(stateDir, 'schedule-ideas.json'))).toBe(on);
  });

  it('gates implicit connector live probes while keeping connector listing', async () => {
    const fetch = vi.fn(async (path: string) => Response.json(path === '/api/mcp/servers'
      ? { servers: [{ name: 'notion', enabled: true }] } : { ok: true }));
    const connectors = new Connectors({ background, dashboard: () => ({ fetch }), dashboardUrl: 'http://127.0.0.1:8892', publicOrigin: 'https://wayroost.example.com', log: quiet });
    expect((await connectors.list()).connectors.length).toBeGreaterThan(0);
    expect(fetch.mock.calls.filter(([path]) => path.endsWith('/test'))).toHaveLength(on ? 1 : 0);
  });

  it('keeps requested schedule creation and run-now working', async () => {
    const stateDir = dir();
    const fetch = vi.fn(async (path: string) => Response.json(path === '/api/cron/jobs'
      ? [{ id: 'fake-job', name: 'Demo job', prompt: 'Check the demo job' }] : {}));
    const schedules = new Schedules({ background, dashboard: () => ({ fetch }), stateDir, log: quiet });
    await schedules.create({ name: 'Demo job', prompt: 'Check the demo job', schedule: '0 9 * * *', deliver: 'local', idea: 'Requested demo idea' });
    await schedules.runNow('hermes', 'fake-job');
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetch).toHaveBeenCalledWith('/api/cron/jobs', expect.objectContaining({ method: 'POST' }));
    expect(fetch).toHaveBeenCalledWith('/api/cron/jobs/fake-job/trigger', expect.objectContaining({ method: 'POST' }));
    expect(existsSync(join(stateDir, 'schedule-ideas.json'))).toBe(true);
  });

  it('refuses shadow trigger creation before any helper or Hermes call', async () => {
    const putTrigger = vi.fn(async () => ({ role: 'primary' as const, workdir: '/home/me/code/fake-trigger', script: 'signalbox_mail_trigger.py' }));
    const fetch = vi.fn(async (path: string) => Response.json(path === '/api/cron/delivery-targets' ? { targets: [{ id: 'local' }] } : {}));
    const connectors = new Connectors({ background, dashboard: () => ({ fetch }), dashboardUrl: 'http://127.0.0.1:8892', publicOrigin: 'https://wayroost.example.com', helper: { putTrigger } as never, log: quiet });
    const request = connectors.createTrigger({ name: 'Demo trigger', query: 'label:demo', action: 'Describe the demo mail', every: 15, deliver: 'local' });
    if (on) {
      await request;
      expect(putTrigger).toHaveBeenCalledWith(expect.any(String), 'label:demo', role);
      expect(fetch).toHaveBeenCalledWith('/api/cron/jobs', expect.objectContaining({ method: 'POST' }));
    } else {
      await expect(request).rejects.toThrow('shadow');
      expect(putTrigger).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('gates bridge token startup writes', () => {
    const state = dir();
    if (on) expect(readOrCreateBridgeToken(state, background)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    else expect(() => readOrCreateBridgeToken(state, background)).toThrow('shadow mode');
    expect(existsSync(join(state, 'bridge-token'))).toBe(on);
  });

  it('gates construction of the bridge listener and pulse routes', async () => {
    const build = () => buildBridgeServer({ background, bridge: { call: vi.fn() }, token: 'fake-token-for-shadow-test-only', port: 8893, log: quiet });
    if (on) {
      const server = await build();
      expect(server.hasRoute({ method: 'POST', url: '/bridge/v1/:tool' })).toBe(true);
      await server.close();
    } else await expect(build()).rejects.toThrow('shadow mode');
  });

  function bridgeFixture() {
    const chats: ConversationSummary[] = ['fake-caller', 'fake-target'].map((id) => ({
      source: 'hermes', id, title: 'Demo chat', status: 'idle', updatedAt: 0, pendingApprovals: 0,
      project: { path: '/home/me/code/app', name: 'app' },
    }));
    const source = { status: () => ({ source: 'hermes', state: 'connected' }), listConversations: vi.fn(async () => chats), sendMessage: vi.fn(async () => {}),
      getConversation: vi.fn(async (id: string) => ({ conversation: chats.find((c) => c.id === id)!, items: [], approvals: [] })) };
    const info = vi.fn();
    const hub = new EventHub();
    const bridge = new Bridge({ background, sources: { hermes: source, paseo: { listConversations: async () => [] } } as never,
      hub, log: { ...quiet, info } });
    const identity = { hermesSession: 'fake-caller' };
    return { bridge, source, info, identity, chats, hub };
  }

  it.each(['list_chats', 'read_chat', 'send_message', 'start_chat', 'wait_for_reply', 'note_launch', 'note_run'])
    ('gates bridge %s before agent side effects', async (tool) => {
      const { bridge, source, info } = bridgeFixture();
      if (!on) {
        await expect(bridge.call(tool, {})).rejects.toThrow('shadow mode');
        expect(source.listConversations).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
      } else {
        // Primary reaches the existing dispatcher; invalid arguments retain its existing errors.
        await expect(bridge.call(tool, {})).rejects.toThrow(/Invalid arguments|project|Launch reports are off/i);
      }
      bridge.stop();
    });

  it('gates bridge queued delivery polling and call logging', async () => {
    vi.useFakeTimers();
    const { bridge, source, info, identity, chats } = bridgeFixture();
    chats[1]!.status = 'running';
    const args = { chat: 'hermes:fake-target', text: 'Demo message' };
    if (on) {
      expect(await bridge.call('send_message', args, identity)).toMatchObject({ delivered: 'queued' });
      expect(vi.getTimerCount()).toBe(1);
      chats[1]!.status = 'idle';
      await vi.advanceTimersByTimeAsync(3_000);
      expect(source.sendMessage).toHaveBeenCalledOnce();
      expect(info).toHaveBeenCalled();
    } else {
      await expect(bridge.call('send_message', args, identity)).rejects.toThrow('shadow mode');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(vi.getTimerCount()).toBe(0);
      expect(source.sendMessage).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
    }
    bridge.stop();
  });

  it('gates bridge wait timeout timers', async () => {
    vi.useFakeTimers();
    const { bridge, identity } = bridgeFixture();
    const waiting = bridge.call('wait_for_reply', { chat: 'hermes:fake-target', timeout_seconds: 1 }, identity);
    if (on) {
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(bridge.activeWaits).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await waiting).toMatchObject({ kind: 'timed_out' });
    } else {
      await expect(waiting).rejects.toThrow('shadow mode');
      expect(vi.getTimerCount()).toBe(0);
    }
    bridge.stop();
  });

  it('gates bridge loop-breaker notices', async () => {
    const { bridge, identity, chats, hub } = bridgeFixture();
    const publish = vi.spyOn(hub, 'publish');
    for (const chat of chats) chat.status = 'running';
    for (let i = 0; i < 3; i++) {
      const forward = bridge.call('send_message', { chat: 'hermes:fake-target', text: 'Demo message' }, identity);
      const reverse = () => bridge.call('send_message', { chat: 'hermes:fake-caller', text: 'Demo reply' }, { hermesSession: 'fake-target' });
      if (on) { await forward; await reverse(); }
      else { await expect(forward).rejects.toThrow('shadow mode'); await expect(reverse()).rejects.toThrow('shadow mode'); }
    }
    await expect(bridge.call('send_message', { chat: 'hermes:fake-target', text: 'Demo loop' }, identity))
      .rejects.toThrow(on ? /loop/ : 'shadow mode');
    expect(publish).toHaveBeenCalledTimes(on ? 2 : 0);
    bridge.stop();
  });

  it('gates delayed lineage report writes and the shutdown save', async () => {
    vi.useFakeTimers();
    const state = dir();
    const lineage = new Lineage(state, quiet, Date.now, background);
    lineage.noteLaunch('fake-child', [{ kind: 'hermes', id: 'fake-parent' }], Date.now());
    lineage.noteRun('fake-run', 'start', { candidates: [{ kind: 'hermes', id: 'fake-parent' }], task: 'Demo task' });
    lineage.setStartedBy('hermes:fake-child', { source: 'hermes', id: 'fake-parent', title: 'Demo parent' });
    expect(vi.getTimerCount()).toBe(on ? 1 : 0);
    await vi.advanceTimersByTimeAsync(500);
    expect(existsSync(join(state, 'lineage.json'))).toBe(on);
    lineage.save();
    expect(existsSync(join(state, 'lineage.json'))).toBe(on);
    expect(lineage.runs()).toHaveLength(on ? 1 : 0);
  });

  it('gates client id startup writes while keeping a usable connection id', () => {
    const state = dir();
    expect(readOrCreateClientId(state, background)).toMatch(/^cid_/);
    expect(existsSync(join(state, 'paseo-client-id'))).toBe(on);
  });

  it('gates VAPID initialization and repair writes', () => {
    const state = dir();
    new PushSender(state, 'https://wayroost.example.com', quiet, vi.fn(), background);
    expect(existsSync(join(state, 'push.json'))).toBe(on);
    writeFileSync(join(state, 'push.json'), 'unusable fake state');
    new PushSender(state, 'https://wayroost.example.com', quiet, vi.fn(), background);
    expect(existsSync(join(state, 'push.json.bad'))).toBe(on);
    if (!on) expect(readFileSync(join(state, 'push.json'), 'utf8')).toBe('unusable fake state');
  });

  it('gates Web Push posts and dead subscription removal', async () => {
    const state = dir();
    seedDevices(state);
    const fetch = vi.fn(async () => new Response(null, { status: 410 }));
    const push = new PushSender(state, 'https://wayroost.example.com', quiet, fetch as never, background);
    push.bindDevices(new Devices(state));
    const browser = createECDH('prime256v1');
    browser.generateKeys();
    push.add({ endpoint: 'https://fcm.googleapis.com/fake-device', keys: { p256dh: browser.getPublicKey().toString('base64url'), auth: Buffer.alloc(16).toString('base64url') } }, TEST_PHONE.id);
    const before = readFileSync(join(state, 'push.json'), 'utf8');
    const result = await push.send({ title: 'Wayroost', body: 'Demo', url: '/', tag: 'fake-tag', ttl: 60, urgency: 'normal' });
    expect(fetch).toHaveBeenCalledTimes(on ? 1 : 0);
    expect(result.removed).toBe(on ? 1 : 0);
    expect(push.devices()).toBe(on ? 0 : 1);
    if (!on) expect(readFileSync(join(state, 'push.json'), 'utf8')).toBe(before);
  });

  const sink: MirrorSink = { reset() {}, upsert() {}, append() {}, status() {}, failure() {} };
  function mirrorFixture() {
    const fetchAgentTimeline = vi.fn(async () => ({
      agent: null, epoch: 'fake-epoch', reset: false, entries: [],
      window: { nextSeq: 2 }, startCursor: { seq: 1 }, endCursor: { seq: 1 },
    }));
    // Since the 0.9.2 client a mirror owns its timeline subscription; the fake confirms it at once.
    const subscribeAgentTimeline = () => Object.assign(() => {}, { ready: Promise.resolve() });
    const mirror = new AgentTimelineMirror({ fetchAgentTimeline, subscribeAgentTimeline } as never, 'fake-agent', sink, background);
    return { mirror, fetchAgentTimeline };
  }

  it('gates Paseo reconnect timeline catch-up that could resume an agent', async () => {
    const { mirror, fetchAgentTimeline } = mirrorFixture();
    await mirror.loadTail(); // a person opened this chat
    fetchAgentTimeline.mockClear();
    await mirror.catchUp();
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(on ? 1 : 0);
    if (!on) {
      expect(mirror.loaded).toBe(false);
      await mirror.loadTail(); // the next page request can repair the missing history
      expect(mirror.loaded).toBe(true);
      expect(fetchAgentTimeline).toHaveBeenCalledOnce();
    }
  });

  it.each(['gap', 'epoch'])('gates Paseo %s timeline reloads', async (kind) => {
    const { mirror, fetchAgentTimeline } = mirrorFixture();
    await mirror.loadTail();
    fetchAgentTimeline.mockClear();
    mirror.handleLive({ agentId: 'fake-agent', epoch: kind === 'epoch' ? 'fake-new-epoch' : 'fake-epoch', seq: 5,
      timestamp: new Date(0).toISOString(), event: { type: 'timeline', item: { type: 'user_message', text: 'Demo row' }, turnId: 'fake-turn' } } as never);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(on ? 1 : 0);
    if (!on) expect(mirror.rows.at(-1)?.item).toMatchObject({ text: 'Demo row' });
  });

  it('keeps explicit timeline loads working', async () => {
    const { mirror, fetchAgentTimeline } = mirrorFixture();
    await mirror.loadTail();
    expect(fetchAgentTimeline).toHaveBeenCalledOnce();
    expect(mirror.loaded).toBe(true);
  });

  it('starts without creating any state when background work is suppressed', () => {
    const state = dir();
    readOrCreateClientId(state, background);
    new PushSender(state, 'https://wayroost.example.com', quiet, vi.fn(), background);
    const lineage = new Lineage(state, quiet, Date.now, background);
    lineage.save();
    expect(readdirSync(state).length).toBe(on ? 3 : 0);
  });
});
