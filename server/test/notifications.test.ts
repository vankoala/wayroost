import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as promises from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Approval, DevicePresence, PresenceState, ServerEvent } from '../../shared/protocol.js';
import { DEFAULT_NOTIFICATION_RULES, type NotificationEvent, type NotificationRule } from '../../shared/settings.js';
import { BackgroundGate } from '../src/background.js';
import { EventHub } from '../src/hub.js';
import { Feed } from '../src/feed/service.js';
import { FeedStore, type CardInput } from '../src/feed/store.js';
import type { PushSender } from '../src/feed/push.js';
import { NotificationSettingsStore, WAYROOST_SETTINGS_FILE } from '../src/notifications/settings.js';
import { createNotificationServices, Notifications } from '../src/notifications/service.js';
import { SettingsWriteThrough } from '../src/settings/write-through.js';
import { HermesAdapter } from '../src/hermes/adapter.js';
import { HermesGateway, type GatewayEvent } from '../src/hermes/gateway.js';
import { PaseoAdapter } from '../src/paseo/adapter.js';
import type { SecretStore } from '../src/secrets.js';

// Notifications: an alert goes where the rules, the PC's presence and the clock say. The app shows what
// the owner allowed and nothing more; quiet hours hold a card, never an agent waiting on you.

const quietLog = { info() {}, warn() {}, error() {} };
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

const at = (iso: string): (() => number) => () => new Date(iso).getTime();
const NOON = at('2026-10-02T12:00:00Z');
const NIGHT = at('2026-10-02T22:30:00Z');

/** The desktop's own report, stamped by the clock the test runs on. */
function desktop(state: PresenceState, now: () => number, agoMs = 0): DevicePresence[] {
  return [{ device: 'dv_desktop', kind: 'desktop', state, at: now() - agoMs }];
}

/** A desktop that reported two minutes ago and hasn't been heard from since. */
function absent(now: () => number, agoMs = 0): DevicePresence[] {
  return desktop('active', now, 121_000 + agoMs);
}

const clockOf = (options: { now?: () => number }): (() => number) => options.now ?? Date.now;

const approval = (id: string): Approval => ({
  id,
  source: 'hermes',
  conversationId: 'conv-9',
  kind: 'permission',
  title: 'Run a shell command',
  detail: 'rm -rf ~/secret-project',
  options: [],
  createdAt: 1_700_000_000_000,
});

const card = (key: string, extra: Partial<CardInput> = {}): CardInput => ({
  key,
  kind: 'reply',
  title: `About ${key}`,
  action: 'Draft a short reply',
  topic: 'book club',
  ...extra,
});

const rule = (
  event: NotificationEvent,
  source: NotificationRule['source'],
  delivery: NotificationRule['delivery'],
): NotificationRule => ({ event, source, delivery });

interface Fixture {
  state: string;
  hub: EventHub;
  events: ServerEvent[];
  readonly toasts: Array<{ event: string; source: string; title: string; body?: string; url: string; at: number }>;
  pushes: Array<Record<string, unknown>>;
  settings: NotificationSettingsStore;
  notifications: Notifications;
  feed: Feed;
  saved: () => Record<string, unknown>;
}

function fixture(options: { now?: () => number; zone?: string; presence?: PresenceState | 'absent' } = {}): Fixture {
  mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
  const state = mkdtempSync(join(process.cwd(), '.tmp', 'notification-service-'));
  roots.push(state);
  const hub = new EventHub();
  const events: ServerEvent[] = [];
  hub.observe((event) => events.push(event));
  const pushes: Array<Record<string, unknown>> = [];
  const push = {
    devices: () => 2,
    send: async (message: Record<string, unknown>) => (pushes.push(message), { sent: 1, failed: 0, removed: 0 }),
  } as unknown as PushSender;
  const settings = new NotificationSettingsStore(state);
  const feedStore = new FeedStore(state, options.now);
  const feed = new Feed({
    background: new BackgroundGate('primary'),
    store: feedStore,
    hub,
    hermes: { createConversation: async () => ({ id: 'chat-1' }) },
    push,
    log: quietLog,
    ...(options.now ? { now: options.now } : {}),
    timeZone: options.zone ?? 'UTC',
  });
  const notifications = new Notifications({
    settings,
    hub,
    push,
    feed,
    background: new BackgroundGate('primary'),
    log: quietLog,
    ...(options.now ? { now: options.now } : {}),
    timeZone: options.zone ?? 'UTC',
    claimPush: (key) => feedStore.markNotified(key),
  });
  feed.useRouting(notifications);
  const now = clockOf(options);
  notifications.bindPresence(() =>
    options.presence === undefined ? desktop('active', now) : options.presence === 'absent' ? absent(now) : desktop(options.presence, now),
  );
  return {
    state,
    hub,
    events,
    get toasts() {
      return events.flatMap((event) => (event.type === 'notification' ? [event.notification] : []));
    },
    pushes,
    settings,
    notifications,
    feed,
    saved: () => JSON.parse(readFileSync(join(state, WAYROOST_SETTINGS_FILE), 'utf8')) as Record<string, unknown>,
  };
}

async function hermesTurn(t: Fixture) {
  const listeners = vi.spyOn(HermesGateway.prototype, 'on');
  const adapter = new HermesAdapter('https://example.com', t.hub, { readHermes: () => null } as unknown as SecretStore,
    quietLog, { background: new BackgroundGate('primary') });
  const gateway = listeners.mock.instances.at(-1)! as HermesGateway;
  gateway.state = 'ready';
  vi.spyOn(gateway, 'call').mockResolvedValue({ session_id: 'demo-runtime', stored_session_id: 'demo-chat' });
  await adapter.createConversation('Demo task');
  return {
    adapter,
    event: (type: string, payload: GatewayEvent['payload'] = {}) => gateway.emit('event', {
      type, session_id: 'demo-runtime', payload,
    }),
  };
}

async function paseoTurn(t: Fixture) {
  const agent = { id: 'demo-paseo', provider: 'hermes', cwd: '/home/me/code/app', title: 'Demo task', status: 'idle',
    updatedAt: '2026-10-02T12:00:00Z', pendingPermissions: [], labels: {}, capabilities: { supportsStreaming: true } };
  const handlers = new Map<string, (message: { payload: unknown }) => void>();
  let connected = (_state: { status: string }) => {};
  const subscriptions: Array<{ events: string[]; update: (message: { type: string; payload: unknown }) => void }> = [];
  const client = {
    subscribeConnectionStatus: (handler: typeof connected) => { connected = handler; return () => {}; },
    on: (type: string, handler: (message: { payload: unknown }) => void) => {
      handlers.set(type, handler); return () => { handlers.delete(type); };
    },
    connect: async () => connected({ status: 'connected' }),
    close: async () => {},
    getLastServerInfoMessage: () => null,
    getProvidersSnapshot: async () => ({ entries: [] }),
    observeAgents: () => ({ ready: Promise.resolve({ entries: [{ agent, project: null }], pageInfo: { hasMore: false } }),
      release: async () => {} }),
    observeEvents: (events: string[]) => {
      const subscription = { events, update: (_message: { type: string; payload: unknown }) => {} };
      subscriptions.push(subscription);
      return { ready: Promise.resolve({}), release: async () => {},
        subscribe: (observer: { update: typeof subscription.update }) => {
          subscription.update = observer.update; return () => { subscription.update = () => {}; };
        } };
    },
  };
  const adapter = new PaseoAdapter('wss://example.com', t.hub, quietLog, 'demo-client', () => client as never, new BackgroundGate('primary'));
  adapter.start();
  await expect.poll(() => adapter.status().state).toBe('connected');
  return {
    adapter,
    status: (status: string, extra: object = {}) => handlers.get('agent_update')?.({ payload: { kind: 'upsert', agent: { ...agent, status, ...extra } } }),
    outcome: (reason: 'finished' | 'error' | 'permission', timestamp = agent.updatedAt) => {
      for (const subscription of subscriptions) if (subscription.events.includes('agent_attention_required')) {
        subscription.update({ type: 'agent_attention_required',
          payload: { agentId: agent.id, reason, timestamp, shouldNotify: false } });
      }
    },
  };
}

describe('Paseo turn outcomes', () => {
  it('does not announce an idle reload as task completion', async () => {
    const t = fixture({ now: NOON, presence: 'idle' });
    const turn = await paseoTurn(t);
    try {
      turn.status('initializing');
      turn.status('idle');
      expect(t.toasts).toEqual([]);
      expect(t.pushes).toEqual([]);
    } finally { turn.adapter.stop(); }
  });

  it('waits for completion even after a running turn becomes idle', async () => {
    const t = fixture({ now: NOON, presence: 'idle' });
    const turn = await paseoTurn(t);
    try {
      turn.status('running', { activeTurn: { turnId: 'demo-turn', startedAt: '2026-10-02T12:00:00Z' } });
      turn.status('idle', { activeTurn: null });
      expect(t.toasts).toEqual([]);
      expect(t.pushes).toEqual([]);
      turn.outcome('finished');
      turn.outcome('finished');
      turn.status('idle');
      expect(t.toasts).toMatchObject([{ event: 'agent-finished', source: 'paseo', url: '/c/paseo/demo-paseo' }]);
      expect(t.toasts).toHaveLength(1);
      expect(t.pushes).toHaveLength(1);
      turn.outcome('finished', '2026-10-02T12:01:00Z');
      expect(t.toasts).toHaveLength(2);
    } finally { turn.adapter.stop(); }
  });

  it('does not announce a stopped turn or a permission event as success', async () => {
    const t = fixture({ now: NOON, presence: 'idle' });
    const turn = await paseoTurn(t);
    try {
      turn.status('running');
      turn.outcome('permission');
      turn.status('idle');
      expect(t.toasts).toEqual([]);
      expect(t.pushes).toEqual([]);
    } finally { turn.adapter.stop(); }
  });

  it('routes a completed turn before its idle summary arrives', async () => {
    const t = fixture({ now: NOON, presence: 'idle' });
    const turn = await paseoTurn(t);
    try {
      turn.status('running');
      turn.outcome('finished');
      expect(t.events.filter((event) => event.type === 'conversation_upsert').at(-1))
        .toMatchObject({ turnOutcome: 'complete', conversation: { status: 'running' } });
      turn.status('idle');
      expect(t.toasts.map((toast) => toast.event)).toEqual(['agent-finished']);
      expect(t.pushes).toHaveLength(1);
    } finally { turn.adapter.stop(); }
  });

  it('routes failures once using the failure rule and suppresses disabled completions', async () => {
    const t = fixture({ now: NOON });
    await t.notifications.update({ rules: [rule('agent-error', 'paseo', 'push'), rule('agent-finished', 'paseo', 'neither')] });
    const turn = await paseoTurn(t);
    try {
      turn.status('error');
      expect(t.pushes).toEqual([]);
      turn.outcome('error');
      turn.outcome('error');
      turn.status('idle');
      turn.outcome('finished', '2026-10-02T12:01:00Z');
      expect(t.toasts).toEqual([]);
      expect(t.pushes.map((push) => push.title)).toEqual(['An agent failed']);
    } finally { turn.adapter.stop(); }
  });
});

describe('a running conversation continues under a new id', () => {
  it.each([
    ['error', 'agent-error'], ['complete', 'agent-finished'], ['ok', 'agent-finished'], ['interrupted', undefined],
  ] as const)('routes the actual Hermes %s turn outcome', async (status, expected) => {
    const t = fixture({ now: NOON });
    const turn = await hermesTurn(t);
    try {
      turn.event('message.start');
      turn.event('message.complete', { text: '', status, error: 'Demo failure.' });
      expect(t.toasts.map((toast) => toast.event)).toEqual(expected ? [expected] : []);
      turn.event('session.info', { running: false });
      expect(t.toasts.map((toast) => toast.event)).toEqual(expected ? [expected] : []);
    } finally { turn.adapter.stop(); }
  });

  it('uses the outcome even when an idle summary arrived before completion', async () => {
    const t = fixture({ now: NOON });
    vi.spyOn(Date, 'now').mockImplementation(NOON);
    const turn = await hermesTurn(t);
    try {
      turn.event('message.start');
      turn.event('session.info', { running: false });
      expect(t.toasts).toEqual([]);
      turn.event('message.complete', { text: '', status: 'error', error: 'Demo failure.' });
      expect(t.toasts.map((toast) => toast.event)).toEqual(['agent-error']);
      expect(t.events.filter((event) => event.type === 'conversation_upsert').at(-1))
        .toMatchObject({ turnOutcome: 'error', conversation: { status: 'idle' } });
    } finally { turn.adapter.stop(); }
  });

  it('uses separate failure and completion rules for actual Hermes turns', async () => {
    const t = fixture({ now: NOON });
    await t.notifications.update({ rules: [rule('agent-error', 'hermes', 'push'), rule('agent-finished', 'hermes', 'neither')] });
    const turn = await hermesTurn(t);
    try {
      turn.event('message.start');
      turn.event('message.complete', { text: '', status: 'error', error: 'Demo failure.' });
      expect(t.pushes.map((push) => push.title)).toEqual(['An agent failed']);
      expect(t.toasts).toEqual([]);
      turn.event('message.start');
      turn.event('message.complete', { text: 'Done.', status: 'complete' });
      expect(t.pushes).toHaveLength(1);
      expect(t.toasts).toEqual([]);
    } finally { turn.adapter.stop(); }
  });

  it.each([
    [true, 'complete', 'agent-finished'], [false, 'complete', 'agent-finished'],
    [true, 'error', 'agent-error'], [false, 'error', 'agent-error'],
  ] as const)('holds alerts during Hermes compression with running=%s until %s at the new id', async (running, status, expected) => {
    const t = fixture({ now: NOON });
    const turn = await hermesTurn(t);
    try {
      turn.event('message.start');
      turn.event('session.info', { running, stored_session_id: 'demo-continuation' });
      turn.event('session.info', { running, stored_session_id: 'demo-continuation-2' });
      expect(t.toasts).toEqual([]);
      turn.event('message.complete', { text: 'Done.', status });
      expect(t.toasts).toMatchObject([{ event: expected, url: '/c/hermes/demo-continuation-2' }]);
      expect(t.toasts).toHaveLength(1);
    } finally { turn.adapter.stop(); }
  });

  it('transfers pending status and ignores later summaries for the retired id', () => {
    const t = fixture({ now: NOON });
    const conversation = { source: 'paseo' as const, id: 'demo-old', title: 'Demo task', status: 'needs_approval' as const,
      updatedAt: 1, pendingApprovals: 1 };
    t.hub.publish({ type: 'conversation_upsert', conversation });
    t.hub.publish({ type: 'conversation_moved', source: 'paseo', from: conversation.id, to: 'demo-new' });
    t.hub.publish({ type: 'conversation_upsert', conversation: { ...conversation, status: 'idle', pendingApprovals: 0 } });
    t.hub.publish({ type: 'conversation_upsert', conversation: { ...conversation, status: 'running', pendingApprovals: 0 } });
    t.hub.publish({ type: 'conversation_upsert', conversation: { ...conversation, status: 'idle', pendingApprovals: 0 } });
    expect(t.toasts).toEqual([]);
    t.hub.publish({ type: 'conversation_upsert', turnOutcome: 'complete', conversation: { ...conversation, id: 'demo-new', status: 'idle', pendingApprovals: 0 } });
    expect(t.toasts).toMatchObject([{ event: 'agent-finished', url: '/c/paseo/demo-new' }]);
  });
});

describe('the desktop in front of an alert', () => {
  it('shows an alert the rules send to the app while someone is at the screen', () => {
    const t = fixture({ now: NOON });
    const decision = t.notifications.alert({ event: 'agent-finished', source: 'hermes', title: 'Hermes is done', body: 'The report is ready', url: '/c/hermes/conv-9', tag: 'finished-hermes' });
    expect(decision).toMatchObject({ toast: true, push: false, presence: 'active' });
    expect(t.toasts).toEqual([{ event: 'agent-finished', source: 'hermes', title: 'Hermes is done', body: 'The report is ready', url: '/c/hermes/conv-9', at: NOON() }]);
    expect(t.pushes).toEqual([]);
  });

  it.each(['idle', 'locked'] as const)('lets the phone take an alert when the desktop is %s', (state) => {
    const t = fixture({ now: NOON, presence: state });
    const decision = t.notifications.alert({ event: 'agent-finished', source: 'hermes', title: 'Hermes is done', url: '/c/hermes/conv-9', tag: 'x' });
    expect([decision.toast, decision.push]).toEqual([true, true]);
    expect(t.pushes).toHaveLength(1);
  });

  it('sends to the phone alone once the desktop has been gone two minutes', async () => {
    const t = fixture({ now: NOON });
    expect(t.notifications.currentPresence()).toBe('active');
    t.notifications.bindPresence(() => desktop('active', NOON, 119_000));
    expect(t.notifications.decide('agent-finished', 'hermes').toast).toBe(true);
    t.notifications.bindPresence(() => desktop('active', NOON, 120_000));
    expect(t.notifications.decide('agent-finished', 'hermes')).toMatchObject({ presence: 'gone', toast: false, push: true });
    await t.notifications.update({ rules: [rule('agent-finished', 'hermes', 'toast')] });
    t.notifications.alert({ event: 'agent-finished', source: 'hermes', title: 'Hermes is done', url: '/x', tag: 'x' });
    // The rule said the app, and nobody is at the app: the phone takes it, and nothing shows.
    expect(t.toasts).toEqual([]);
    expect(t.pushes.map((p) => p.title)).toEqual(['Hermes is done']);
  });

  it('keeps an agent waiting on an answer in the app even with no desktop at all', () => {
    const t = fixture({ now: NOON, presence: 'absent' });
    const decision = t.notifications.alert({ event: 'agent-needs-you', source: 'hermes', title: 'Hermes needs you', body: 'Run a shell command', url: '/c/hermes/conv-9', tag: 'approval-hermes-conv-9', urgent: true });
    expect(decision).toMatchObject({ toast: true, push: true, needsYou: true, presence: 'gone' });
    expect(t.toasts).toHaveLength(1);
    expect(t.pushes).toHaveLength(1);
  });

  it('follows each rule as written, and nothing else', async () => {
    const t = fixture({ now: NOON });
    await t.notifications.update({
      rules: [rule('agent-finished', 'hermes', 'push'), rule('agent-error', 'paseo', 'neither'), rule('settings-applied', '*', 'both')],
    });
    expect(t.notifications.decide('agent-finished', 'hermes')).toMatchObject({ delivery: 'push', toast: false, push: true });
    expect(t.notifications.decide('agent-finished', 'paseo')).toMatchObject({ delivery: 'neither', toast: false, push: false });
    expect(t.notifications.decide('agent-error', 'hermes')).toMatchObject({ delivery: 'neither', toast: false, push: false });
    expect(t.notifications.decide('settings-applied', 'paseo')).toMatchObject({ delivery: 'both', toast: true, push: false });
    expect(t.notifications.decide('settings-applied', 'hermes')).toMatchObject({ toast: true, push: false });
  });
});

describe('an approval asks the phone by the rules, not on every upsert', () => {
  it.each(['sender', 'recipients'])('does not claim delivery without a push %s, so a restart can deliver it', (missing) => {
    const t = fixture({ now: NOON, presence: 'idle' });
    const claim = vi.spyOn(FeedStore.prototype, 'markNotified');
    const push = {
      devices: () => 0,
      send: vi.fn(async () => ({ sent: 1, failed: 0, removed: 0 })),
    } as unknown as PushSender;
    const firstHub = new EventHub();
    const first = new Notifications({ settings: t.settings, hub: firstHub, log: quietLog, now: NOON, background: new BackgroundGate('primary'),
      ...(missing === 'recipients' ? { push } : {}),
      claimPush: (key) => new FeedStore(t.state).markNotified(key) });
    first.bindPresence(() => desktop('idle', NOON));
    firstHub.publish({ type: 'approval_upsert', approval: approval('a1') });
    expect(claim).not.toHaveBeenCalled();
    expect(push.send).not.toHaveBeenCalled();
    t.hub.publish({ type: 'approval_upsert', approval: approval('a1') });
    expect(t.pushes).toHaveLength(1);
    expect(claim).toHaveBeenCalledOnce();
  });

  it('keeps the mandatory toast when persistent phone deduplication fails', () => {
    const t = fixture({ now: NOON, presence: 'idle' });
    t.feed.start();
    vi.spyOn(FeedStore.prototype, 'markNotified').mockImplementation(() => { throw new Error('Disk write failed.'); });
    t.hub.publish({ type: 'approval_upsert', approval: approval('a1') });
    t.hub.publish({ type: 'approval_upsert', approval: approval('a1') });
    expect(t.toasts).toHaveLength(1);
    expect(t.toasts[0]).toMatchObject({ event: 'agent-needs-you' });
    expect(t.pushes).toEqual([]);
    t.feed.stop();
  });

  it('does not persist a phone deduplication claim for an active desktop toast', () => {
    const t = fixture({ now: NOON });
    const claim = vi.spyOn(FeedStore.prototype, 'markNotified');
    t.hub.publish({ type: 'approval_upsert', approval: approval('a1') });
    expect(t.toasts).toHaveLength(1); expect(t.pushes).toEqual([]); expect(claim).not.toHaveBeenCalled();
  });
  it('says it once per approval, on the phone and on the desktop', () => {
    const t = fixture({ now: NOON, presence: 'idle' });
    t.feed.start();
    t.hub.publish({ type: 'approval_upsert', approval: approval('a1') });
    t.hub.publish({ type: 'approval_upsert', approval: approval('a1') });
    expect(t.pushes).toEqual([
      { title: 'Hermes needs you', body: 'Run a shell command', url: '/c/hermes/conv-9', tag: 'approval-hermes-conv-9', ttl: 3600, urgency: 'high', topic: 'approvals' },
    ]);
    expect(t.toasts.map((toast) => [toast.event, toast.source, toast.url])).toEqual([['agent-needs-you', 'hermes', '/c/hermes/conv-9']]);
    // What the command is stays off the alert.
    expect(JSON.stringify([t.pushes, t.toasts])).not.toContain('secret-project');
    t.hub.publish({ type: 'approval_upsert', approval: approval('a2') });
    expect(t.pushes).toHaveLength(2);
    t.feed.stop();
  });

  it.each([
    ['a rule that keeps it in the app', { rules: [rule('agent-needs-you', '*', 'toast')] }],
    ['a rule that names this agent', { rules: [rule('agent-needs-you', 'paseo', 'both'), rule('agent-needs-you', 'hermes', 'toast')] }],
    ['the phone’s own switch over approvals', { push: { approvals: false, cards: false } }],
  ])('sends nothing to the phone with %s', async (_what, input) => {
    const t = fixture({ now: NOON });
    await t.notifications.update(input);
    t.feed.start();
    t.hub.publish({ type: 'approval_upsert', approval: approval('a1') });
    expect(t.pushes).toEqual([]);
    // The desktop still hears about it: an answer can never go missing.
    expect(t.toasts).toHaveLength(1);
    t.feed.stop();
  });

  it('rings the phone at night, quiet hours or not', async () => {
    const t = fixture({ now: NIGHT, presence: 'idle' });
    await t.notifications.update({ rules: [rule('agent-needs-you', '*', 'both')] });
    t.feed.start();
    t.hub.publish({ type: 'approval_upsert', approval: approval('a1') });
    expect(t.pushes).toHaveLength(1);
    expect(t.toasts).toHaveLength(1);
    t.feed.stop();
  });

  it('delivers approvals independently of the feed lifecycle', () => {
    const t = fixture({ now: NOON, presence: 'idle' });
    t.hub.publish({ type: 'approval_upsert', approval: approval('a1') });
    expect(t.pushes).toHaveLength(1);
    expect(t.toasts).toHaveLength(1);
  });
});

describe('a card follows its rule, the desktop and the hours', () => {
  it('keeps cards off the phone as every install starts', () => {
    const t = fixture({ now: NOON });
    t.feed.ingest('brief', [card('mail:a')]);
    expect(t.pushes).toEqual([]);
    expect(t.toasts).toEqual([]);
  });

  it('rings the phone when the For-you switch says so, with no rule written', async () => {
    const t = fixture({ now: NOON });
    await t.feed.updateSettings({ push: { cards: true } });
    t.feed.ingest('brief', [card('mail:a')]);
    expect(t.pushes.map((p) => [p.title, p.body, p.url, p.topic])).toEqual([['For you', 'About mail:a', '/#for-you', 'foryou']]);
    // A card no rule mentions doesn’t interrupt the screen.
    expect(t.toasts).toEqual([]);
  });

  it('shows a card on the desktop when a rule says so, and rings only if the card switch agrees', async () => {
    const t = fixture({ now: NOON, presence: 'idle' });
    await t.notifications.update({ rules: [rule('feed-card', '*', 'both')] });
    t.feed.ingest('brief', [card('mail:a'), card('mail:b')]);
    expect(t.toasts).toEqual([{ event: 'feed-card', source: 'brief', title: 'For you', body: '2 new · About mail:a', url: '/#for-you', at: NOON() }]);
    expect(t.pushes).toEqual([]);
    await t.notifications.update({ push: { approvals: true, cards: true } });
    t.feed.ingest('brief', [card('mail:c')]);
    expect(t.pushes).toHaveLength(1);
  });

  it('holds a card in the quiet hours and lets an answer through', async () => {
    const t = fixture({ now: NIGHT, presence: 'idle' });
    await t.notifications.update({ rules: [rule('feed-card', '*', 'both')], push: { approvals: true, cards: true } });
    t.feed.ingest('brief', [card('mail:a')]);
    expect(t.pushes).toEqual([]);
    expect(t.toasts).toHaveLength(1);
    t.feed.start();
    t.hub.publish({ type: 'approval_upsert', approval: approval('a1') });
    expect(t.pushes).toHaveLength(1);
  });

  it('holds a security card too, and nothing else', async () => {
    const t = fixture({ now: NIGHT, presence: 'idle' });
    await t.notifications.update({ rules: [rule('security-card', '*', 'both'), rule('mismatch-warning', '*', 'both')], push: { approvals: true, cards: true } });
    t.notifications.alert({ event: 'security-card', source: 'supervisor', title: 'A command needs a yes', url: '/status', tag: 's' });
    t.notifications.alert({ event: 'mismatch-warning', source: 'hermes', title: 'A model looks wrong', url: '/status', tag: 'm' });
    expect(t.pushes.map((p) => p.title)).toEqual(['A model looks wrong']);
    expect(t.toasts.map((toast) => toast.event)).toEqual(['security-card', 'mismatch-warning']);
  });

  it('says nothing at all when the rule is nowhere', async () => {
    const t = fixture({ now: NOON, presence: 'idle' });
    await t.notifications.update({ rules: [rule('feed-card', 'brief', 'neither')], push: { approvals: true, cards: true } });
    t.feed.ingest('brief', [card('mail:a')]);
    expect(t.notifications.decide('feed-card', 'brief')).toMatchObject({ delivery: 'neither', toast: false, push: false });
    expect(t.pushes).toEqual([]);
    expect(t.toasts).toEqual([]);
  });

  it('rings once for a card, however often it is rewritten', async () => {
    const t = fixture({ now: NOON });
    await t.notifications.update({ rules: [rule('feed-card', '*', 'push')], push: { approvals: true, cards: true } });
    t.feed.ingest('brief', [card('mail:a')]);
    t.feed.ingest('brief', [card('mail:a', { title: 'Rewritten' })]);
    expect(t.pushes).toHaveLength(1);
  });
});

describe('a switch at either end is the same switch', () => {
  it('keeps legacy routing during a failed migration and retries on restart', async () => {
    const t = fixture({ now: NOON });
    const previous = { quietHours: { start: '23:00', end: '06:30' }, push: { approvals: false, cards: true } };
    new FeedStore(t.state).updateSettings(previous);
    vi.spyOn(SettingsWriteThrough.prototype, 'apply').mockRejectedValueOnce(new Error('Write refused.'));
    const start = (hub: EventHub) => createNotificationServices({ stateDir: t.state, feedEnabled: true, hub,
      log: quietLog, background: new BackgroundGate('primary'), now: NOON,
      hermes: { createConversation: async () => ({ id: 'demo-chat' }) } });
    const first = await start(new EventHub());
    expect(first.notifications.settings()).toMatchObject(previous);
    expect(first.feed!.settings()).toMatchObject(previous);
    const restarted = await start(new EventHub());
    expect(restarted.notifications.settings()).toMatchObject(previous);
    expect(restarted.feed!.settings()).toMatchObject(previous);
  });

  it('wires upgrades and snoozing through the production services with the owner’s zone', async () => {
    const t = fixture({ now: NOON });
    const previous = { quietHours: { start: '22:30', end: '06:30' }, push: { approvals: false, cards: true } };
    new FeedStore(t.state).updateSettings(previous);
    const { notifications, feed } = await createNotificationServices({
      stateDir: t.state, feedEnabled: true, hub: new EventHub(), log: quietLog, background: new BackgroundGate('primary'),
      hermes: { createConversation: async () => ({ id: 'demo-chat' }) }, now: at('2026-10-02T20:30:00Z'), timeZone: 'Europe/Berlin',
    });
    expect(notifications.settings()).toMatchObject(previous);
    expect(feed!.settings()).toMatchObject(previous);
    expect(new NotificationSettingsStore(t.state).settings()).toMatchObject(previous);
    expect(new Date(feed!.laterUntil()).toISOString()).toBe('2026-10-03T04:30:00.000Z');
    expect(feed!.quiet(feed!.laterUntil())).toBe(false);
  });

  it('wires approvals in production with Feed disabled and preserves the migrated phone switch', async () => {
    const t = fixture({ now: NOON });
    new FeedStore(t.state).updateSettings({ push: { approvals: false, cards: true } });
    const hub = new EventHub();
    const events: ServerEvent[] = [];
    hub.observe((event) => events.push(event));
    const { notifications, feed } = await createNotificationServices({ stateDir: t.state, feedEnabled: false, hub,
      log: quietLog, background: new BackgroundGate('primary'), hermes: { createConversation: async () => ({ id: 'demo-chat' }) } });
    hub.publish({ type: 'approval_upsert', approval: approval('demo-approval') });
    expect(feed).toBeUndefined();
    expect(notifications.settings().push.approvals).toBe(false);
    expect(events.filter((event) => event.type === 'notification')).toHaveLength(1);
  });
  it('keeps feed preferences unchanged when the authoritative write is refused', async () => {
    const t = fixture({ now: NOON });
    const before = structuredClone(t.feed.settings());
    vi.spyOn(t.settings, 'change').mockRejectedValue(new Error('Write refused.'));
    await expect(t.feed.updateSettings({ quietHours: null, push: { approvals: false, cards: true } })).rejects.toThrow('Write refused.');
    expect(t.feed.settings()).toEqual(before);
  });

  it('reads authoritative preferences even when synchronizing the feed copy fails', async () => {
    const t = fixture({ now: NOON });
    vi.spyOn(FeedStore.prototype, 'updateSettings').mockImplementation(() => { throw new Error('Disk write failed.'); });
    await t.notifications.update({ quietHours: null, push: { approvals: false, cards: true } });
    expect(t.feed.settings()).toMatchObject({ quietHours: null, push: { approvals: false, cards: true } });
    await t.feed.updateSettings({ quietHours: { start: '23:00', end: '06:00' } });
    expect(t.feed.preferences().quietHours).toEqual({ start: '23:00', end: '06:00' });
  });

  it('snoozes through the owner’s quiet hours in a different time zone', () => {
    const t = fixture({ now: at('2026-10-02T20:30:00Z'), zone: 'Europe/Berlin' });
    const until = t.feed.laterUntil();
    expect(new Date(until).toISOString()).toBe('2026-10-03T05:00:00.000Z');
    expect(t.feed.quiet(until)).toBe(false);
    expect(t.feed.quiet(until - 15 * 60_000)).toBe(true);
  });
  it('writes the hours once, and every reader says the same', async () => {
    const t = fixture();
    await t.notifications.update({ quietHours: { start: '22:30', end: '06:00' } });
    expect(t.feed.settings().quietHours).toEqual({ start: '22:30', end: '06:00' });
    expect(t.saved().quietHours).toEqual({ start: '22:30', end: '06:00' });
    expect(JSON.parse(readFileSync(join(t.state, 'feed.json'), 'utf8')).settings.quietHours).toEqual({ start: '22:30', end: '06:00' });
  });

  it('takes the hours from the For-you page and reads them back in the rules', async () => {
    const t = fixture({ now: at('2026-10-02T20:30:00Z'), presence: 'idle' });
    await t.feed.updateSettings({ push: { cards: true } });
    await t.feed.updateSettings({ quietHours: { start: '20:00', end: '07:30' } });
    expect(t.notifications.settings().quietHours).toEqual({ start: '20:00', end: '07:30' });
    expect(t.notifications.decide('feed-card', 'brief').quiet).toBe(true);
    await t.feed.updateSettings({ quietHours: null });
    expect(t.notifications.settings().quietHours).toBeNull();
    expect(t.notifications.decide('feed-card', 'brief').quiet).toBe(false);
  });

  it('keeps the card and approval switches in step both ways', async () => {
    const t = fixture();
    await t.feed.updateSettings({ push: { cards: true } });
    expect(t.notifications.settings().push).toEqual({ approvals: true, cards: true });
    await t.notifications.update({ push: { approvals: false, cards: false } });
    expect(t.feed.settings().push).toEqual({ approvals: false, cards: false });
    // Rules written in Wayroost's file decide the app's half; the switches decide the phone's.
    await t.notifications.update({ rules: [rule('feed-card', '*', 'both')] });
    expect(t.notifications.decide('feed-card', 'brief')).toMatchObject({ toast: true, push: false, switchedOff: true });
    expect(t.saved().push).toEqual({ approvals: false, cards: false });
  });

  it('says in the settings what this server can do', () => {
    const t = fixture({ presence: 'locked' });
    expect(t.notifications.settings()).toEqual({
      rules: DEFAULT_NOTIFICATION_RULES.map((rule) => ({ ...rule })),
      quietHours: { start: '21:00', end: '07:00' },
      push: { approvals: true, cards: false },
      pushAvailable: true,
      pushDevices: 2,
      presence: 'locked',
      timeZoneConfigured: true,
    });
  });

  it('has no phone to ring, and says so', () => {
    const state = mkdtempSync(join(process.cwd(), '.tmp', 'notification-no-push-'));
    roots.push(state);
    const hub = new EventHub();
    const shown: ServerEvent[] = [];
    hub.observe((event) => shown.push(event));
    const notifications = new Notifications({ settings: new NotificationSettingsStore(state), hub, log: quietLog, now: NOON });
    notifications.bindPresence(() => desktop('idle', NOON));
    notifications.alert({ event: 'agent-needs-you', source: 'hermes', title: 'Hermes needs you', url: '/c/hermes/conv-9', tag: 'x' });
    expect(notifications.settings()).toMatchObject({ pushAvailable: false, pushDevices: 0, timeZoneConfigured: false });
    // The app still hears about it; only the phone is missing.
    expect(shown.map((event) => event.type)).toEqual(['notification']);
  });

  it('reads the hours in the owner’s zone, not this machine’s', async () => {
    // 20:30 UTC is 22:30 in Berlin.
    const berlin = fixture({ now: at('2026-10-02T20:30:00Z'), zone: 'Europe/Berlin', presence: 'idle' });
    await berlin.notifications.update({ rules: [rule('feed-card', '*', 'both')], push: { approvals: true, cards: true } });
    expect(berlin.notifications.decide('feed-card', 'brief').quiet).toBe(true);
    const utc = fixture({ now: at('2026-10-02T20:30:00Z'), zone: 'UTC', presence: 'idle' });
    await utc.notifications.update({ rules: [rule('feed-card', '*', 'both')], push: { approvals: true, cards: true } });
    expect(utc.notifications.decide('feed-card', 'brief').quiet).toBe(false);
  });

  it('changes nothing on disk for a setting that already says this', async () => {
    const t = fixture();
    await t.notifications.update({ rules: [rule('agent-finished', 'paseo', 'toast')] });
    const before = readFileSync(t.settings.path, 'utf8');
    const view = await t.notifications.update({ rules: [rule('agent-finished', 'paseo', 'toast')] });
    expect(readFileSync(t.settings.path, 'utf8')).toBe(before);
    expect(view.rules).toEqual([{ event: 'agent-finished', source: 'paseo', delivery: 'toast' }]);
  });
});
