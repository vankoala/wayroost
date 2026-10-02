import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bridgeEnvelope, type ServerEvent } from '../../shared/protocol.js';
import { HermesAdapter } from '../src/hermes/adapter.js';
import { EventHub } from '../src/hub.js';
import { PaseoAdapter } from '../src/paseo/adapter.js';
import { HERMES_PARENT_LABEL, PARENT_AGENT_LABEL } from '../src/paseo/normalize.js';
import { SecretStore } from '../src/secrets.js';
import type { StartedBy } from '../src/sources.js';
import { FAKE_USER, FakeHermes } from './fake-hermes.js';

// What the adapters do for the project bridge: remember who started a chat and
// show it on the chat's summary, title the new chat, and (Paseo) label a child
// agent with its parent. Against the protocol fakes only.

const quietLog = { info() {}, warn() {}, error() {} };
const APP = '/home/me/code/app';
const PARENT: StartedBy = { source: 'paseo', id: 'caller', title: 'Fix flaky login test' };
const SENDER = 'Fix flaky login test (Claude Code)';

function browser(hub: EventHub) {
  const events: ServerEvent[] = [];
  hub.add({ readyState: 1, bufferedAmount: 0, send: (p: string) => events.push(JSON.parse(p)), terminate() {} } as never, 'x');
  return events;
}

describe('hermes adapter: chats the bridge starts', () => {
  let fake: FakeHermes;
  let adapter: HermesAdapter;
  afterEach(async () => {
    adapter?.stop();
    await fake?.stop();
  });

  async function connected() {
    fake = new FakeHermes();
    await fake.start();
    const hub = new EventHub();
    const events = browser(hub);
    const stateDir = mkdtempSync(join(tmpdir(), 'sb-bridge-hermes-'));
    new SecretStore(stateDir).writeHermes(FAKE_USER);
    adapter = new HermesAdapter(fake.url, hub, new SecretStore(stateDir), quietLog);
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');
    return { events };
  }

  it('titles the new chat right after creating it, and shows who started it', async () => {
    const { events } = await connected();
    fake.handlers['session.title'] = (params) => ({ title: params.title });
    const envelope = bridgeEnvelope(SENDER, 'Summarize the failing tests');
    const { id } = await adapter.createConversation(envelope, APP, [], { title: 'Failing tests', startedBy: PARENT });
    expect(id).toBe('20260927_070000_aaaaaa');

    const methods = fake.calls.map((c) => c.method);
    expect(methods.indexOf('session.create')).toBeLessThan(methods.indexOf('prompt.submit'));
    expect(methods.indexOf('prompt.submit')).toBeLessThan(methods.indexOf('session.title'));
    expect(fake.calls.find((c) => c.method === 'session.create')!.params).toMatchObject({ cwd: APP });
    expect(fake.calls.find((c) => c.method === 'prompt.submit')!.params).toEqual({ session_id: 'feedbeef', text: envelope });
    expect(fake.calls.find((c) => c.method === 'session.title')!.params).toEqual({ session_id: 'feedbeef', title: 'Failing tests' });

    const summary = (await adapter.listConversations()).find((c) => c.id === id)!;
    expect(summary).toMatchObject({
      title: 'Failing tests',
      preview: `${SENDER}: Summarize the failing tests`,
      startedBy: PARENT,
      project: { path: APP, name: 'app' },
    });
    const upserts = events.filter((e) => e.type === 'conversation_upsert' && e.conversation.id === id);
    expect(upserts.at(-1)).toMatchObject({ conversation: { title: 'Failing tests', startedBy: PARENT } });

    // Chats nobody started through the bridge don't claim a parent.
    const other = (await adapter.listConversations()).find((c) => c.id === FakeHermes.stored)!;
    expect(other).not.toHaveProperty('startedBy');
  });

  it('keeps who started a chat when Hermes continues it under a new id', async () => {
    await connected();
    fake.handlers['session.title'] = (params) => ({ title: params.title });
    const { id } = await adapter.createConversation(bridgeEnvelope(SENDER, 'Go'), APP, [], { title: 'Go', startedBy: PARENT });
    fake.event('session.info', { stored_session_id: '20260927_080000_bbbbbb', running: false }, 'feedbeef');
    await expect
      .poll(async () => (await adapter.listConversations()).find((c) => c.id === '20260927_080000_bbbbbb')?.startedBy)
      .toEqual(PARENT);
    expect(id).not.toBe('20260927_080000_bbbbbb');
  });

  it("still creates the chat when Hermes won't take the title", async () => {
    await connected();
    // No session.title handler: the fake answers "unknown method".
    const { id } = await adapter.createConversation(bridgeEnvelope(SENDER, 'Check the build'), APP, [], { title: 'Build check' });
    const summary = (await adapter.listConversations()).find((c) => c.id === id)!;
    expect(summary.title).toBe(`${SENDER}: Check the build`);
    expect(summary).not.toHaveProperty('startedBy');
    expect(fake.calls.some((c) => c.method === 'session.title')).toBe(true);
  });
});

/** Just enough of Paseo's daemon client to create agents. */
function fakeDaemon() {
  let statusListener: ((s: { status: string }) => void) | undefined;
  const created: Array<Record<string, unknown>> = [];
  const agent = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    provider: 'claude',
    cwd: APP,
    title: null,
    status: 'running',
    updatedAt: '2026-09-27T00:00:00Z',
    pendingPermissions: [],
    labels: {},
    capabilities: { supportsStreaming: true },
    ...overrides,
  });
  const client = {
    subscribeConnectionStatus: (listener: (s: { status: string }) => void) => {
      statusListener = listener;
      return () => {};
    },
    on: () => () => {},
    connect: async () => statusListener?.({ status: 'connected' }),
    close: async () => {},
    fetchAgents: async () => ({
      entries: [{ agent: agent('caller', { title: 'Fix flaky login test', status: 'idle' }), project: null }],
      pageInfo: { hasMore: false, nextCursor: null },
    }),
    // An older daemon: no waiting for provider discovery, the snapshot is used as is.
    getLastServerInfoMessage: () => null,
    getProvidersSnapshot: async () => ({
      requestId: 'p',
      cwd: '/home/me',
      entries: [
        {
          provider: 'claude',
          status: 'ready',
          enabled: true,
          label: 'Claude Code',
          modes: [
            { id: 'default', label: 'Default' },
            { id: 'plan', label: 'Plan' },
          ],
        },
      ],
    }),
    fetchWorkspaces: async () => ({ entries: [] }),
    listProjects: async () => ({ projects: [] }),
    createAgent: async (options: Record<string, unknown>) => {
      created.push(options);
      return agent(`agent-${created.length}`, {
        title: options.title ?? null,
        labels: options.labels ?? {},
      });
    },
  };
  return { client, created };
}

describe('paseo adapter: agents the bridge starts', () => {
  async function connected() {
    const daemon = fakeDaemon();
    const hub = new EventHub();
    const events = browser(hub);
    const adapter = new PaseoAdapter('ws://127.0.0.1:6777', hub, quietLog, 'cid_signalbox_test', () => daemon.client as never);
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');
    return { adapter, daemon, events };
  }

  it('labels the child with its parent, titles it, and shows who started it', async () => {
    const { adapter, daemon, events } = await connected();
    const envelope = bridgeEnvelope(SENDER, 'Write the e2e test');
    const id = await adapter.createConversation({
      providerId: 'claude',
      cwd: APP,
      modeId: 'default',
      text: envelope,
      title: 'Write the e2e test',
      labels: { [PARENT_AGENT_LABEL]: 'caller' },
      startedBy: PARENT,
    });
    expect(daemon.created[0]).toMatchObject({
      provider: 'claude',
      cwd: APP,
      modeId: 'default',
      initialPrompt: envelope,
      title: 'Write the e2e test',
      labels: { [PARENT_AGENT_LABEL]: 'caller' },
    });
    expect(daemon.created[0]).not.toHaveProperty('startedBy');

    const summary = (await adapter.listConversations()).find((c) => c.id === id)!;
    expect(summary).toMatchObject({ title: 'Write the e2e test', parent: { source: 'paseo', id: 'caller' }, startedBy: PARENT });
    expect(summary).not.toHaveProperty('parentId');
    expect(events.some((e) => e.type === 'conversation_upsert' && e.conversation.id === id && e.conversation.startedBy?.id === 'caller')).toBe(
      true,
    );
    const caller = (await adapter.listConversations()).find((c) => c.id === 'caller')!;
    expect(caller).not.toHaveProperty('startedBy');
  });

  it('labels a child a Hermes chat started with its own label, and reads it back', async () => {
    const { adapter, daemon } = await connected();
    const startedBy: StartedBy = { source: 'hermes', id: '20260927_101500_ab12cd', title: 'Release notes' };
    const labels = { [HERMES_PARENT_LABEL]: startedBy.id };
    const id = await adapter.createConversation({ providerId: 'claude', cwd: APP, modeId: 'default', text: 'Go', labels, startedBy });
    expect(daemon.created[0]!.labels).toEqual(labels);
    const summary = (await adapter.listConversations()).find((c) => c.id === id)!;
    expect(summary).toMatchObject({ parent: { source: 'hermes', id: startedBy.id }, startedBy });
  });

  it('nests an agent under whoever started it even without a label, while Signalbox remembers it', async () => {
    const { adapter } = await connected();
    // Started before the bridge labelled Hermes starters: who started it stands in.
    const bare = await adapter.createConversation({ providerId: 'claude', cwd: APP, modeId: 'default', text: 'Go', startedBy: PARENT });
    expect((await adapter.listConversations()).find((c) => c.id === bare)!.parent).toEqual({ source: 'paseo', id: 'caller' });
    // A label says it first.
    const labelled = await adapter.createConversation({
      providerId: 'claude',
      cwd: APP,
      modeId: 'default',
      text: 'Go',
      labels: { [PARENT_AGENT_LABEL]: 'other-agent' },
      startedBy: PARENT,
    });
    expect((await adapter.listConversations()).find((c) => c.id === labelled)!.parent).toEqual({ source: 'paseo', id: 'other-agent' });
  });

  it('launches from the phone exactly as before: no labels or title unless given', async () => {
    const { adapter, daemon } = await connected();
    const id = await adapter.createConversation({ providerId: 'claude', cwd: APP, text: 'Hi' });
    expect(daemon.created[0]).not.toHaveProperty('labels');
    expect(daemon.created[0]).not.toHaveProperty('title');
    const summary = (await adapter.listConversations()).find((c) => c.id === id);
    expect(summary).not.toHaveProperty('startedBy');
    expect(summary).not.toHaveProperty('parent');
  });
});
