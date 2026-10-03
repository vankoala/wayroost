import { BackgroundGate } from '../src/background.js';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  bridgeEnvelope,
  parseBridgeEnvelope,
  type Approval,
  type ControlChangeResponse,
  type ConversationDetail,
  type ConversationSummary,
  type PaseoProviderOption,
  type ServerEvent,
  type Source,
  type SourceStatus,
  type TimelineItem,
} from '../../shared/protocol.js';
import { buildApp } from '../src/app.js';
import type { Attachment } from '../src/attachments.js';
import type { ChatEntry, TranscriptItem } from '../src/bridge/format.js';
import { LOOP_NOTICE } from '../src/bridge/limits.js';
import { BRIDGE_BODY_LIMIT, buildBridgeServer } from '../src/bridge/server.js';
import {
  BRIDGE_TOOLS,
  Bridge,
  NOTES,
  NOT_IN_PROJECT,
  PAUSED_MESSAGE,
  SLASH_MESSAGE,
  WAIT_NEEDS_IDENTITY,
  type BridgeIdentity,
  type SystemMessage,
} from '../src/bridge/service.js';
import { readOrCreateBridgeToken } from '../src/bridge/token.js';
import { ConfigError, parseConfig } from '../src/config.js';
import { EventHub } from '../src/hub.js';
import { HERMES_PARENT_LABEL, PARENT_AGENT_LABEL, labelledParent } from '../src/paseo/normalize.js';
import { createAccessVerifier } from '../src/security/access.js';
import {
  UserFacingError,
  type BridgeCreateOptions,
  type CreatePaseoAgentInput,
  type HermesSource,
  type PaseoSource,
  type StartedBy,
} from '../src/sources.js';
import { FakeHermes, FakePaseo, apiHeaders, makeConfig, makeKeys, makeToken, postHeaders, type Keys } from './helpers.js';

// The project bridge against fake sources: scoping, delivery, limits, the loop
// breaker, starting chats, the kill switch, and the loopback listener's guards.
// Nothing here talks to a real Hermes or Paseo.

const APP = '/home/me/code/app';
const OTHER = '/home/me/code/other';
const T0 = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const CALLER_LABEL = 'Fix flaky login test (Claude Code)';

/** Paseo's agents as options() reports them: ready ones only, modes that switch every safeguard off left out. */
const PROVIDERS: PaseoProviderOption[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    modes: [
      { id: 'plan', label: 'Plan' },
      { id: 'default', label: 'Default' },
      { id: 'acceptEdits', label: 'Accept edits', autoApproves: true },
      { id: 'auto', label: 'Auto', autoApproves: true },
    ],
    defaultModeId: 'default',
  },
  {
    // A default that acts on its own (Signalbox never reports one, but the bridge checks anyway).
    id: 'codex',
    label: 'Codex',
    modes: [
      { id: 'auto', label: 'Auto' },
      { id: 'auto-review', label: 'Auto review', autoApproves: true },
    ],
    defaultModeId: 'auto-review',
  },
  { id: 'pi', label: 'Pi', modes: [], autoApproves: true },
];

function chat(source: Source, id: string, path: string | null, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    source,
    id,
    title: `${source} ${id}`,
    status: 'idle',
    updatedAt: T0 - HOUR,
    pendingApprovals: 0,
    ...(path ? { project: { path, name: path.split('/').pop() || path } } : {}),
    ...overrides,
  };
}

interface World {
  chats: ConversationSummary[];
  items: Map<string, TimelineItem[]>;
  providers: PaseoProviderOption[];
  sent: Array<{ chat: string; text: string }>;
  created: Array<{ chat: string; paseo?: CreatePaseoAgentInput; hermes?: { text: string; cwd?: string; options?: BridgeCreateOptions } }>;
  /** Every source method the bridge called. */
  calls: string[];
  sendError: Error | null;
  /** A chat that gets a message starts working, as a real one does. */
  busyAfterSend: boolean;
  /** Runs whenever a source lists its chats (e.g. to pause mid-call). */
  onList?: () => void;
}

function makeWorld(): World {
  return {
    chats: [
      chat('paseo', 'caller', APP, { title: 'Fix flaky login test', agentLabel: 'Claude Code' }),
      chat('paseo', 'idle', APP, { title: 'Docs', agentLabel: 'Codex' }),
      chat('paseo', 'busy', APP, { status: 'running', agentLabel: 'Claude Code' }),
      chat('paseo', 'asking', APP, { status: 'needs_approval', pendingApprovals: 1, agentLabel: 'Claude Code' }),
      chat('hermes', 'h-app', `${APP}/server`, { agentLabel: 'claude-sonnet-5' }),
      chat('paseo', 'elsewhere', OTHER),
      chat('hermes', 'h-other', OTHER),
      chat('hermes', 'h-home', null),
    ],
    items: new Map(),
    providers: PROVIDERS,
    sent: [],
    created: [],
    calls: [],
    sendError: null,
    busyAfterSend: false,
  };
}

/** Hermes and Paseo stand-ins over one shared world. */
function fakeSources(world: World): { hermes: HermesSource; paseo: PaseoSource } {
  let created = 0;
  const find = (source: Source, id: string) => world.chats.find((c) => c.source === source && c.id === id);
  const base = (source: Source) => ({
    status: (): SourceStatus => ({ source, state: 'connected' }),
    async listConversations() {
      world.calls.push(`${source}.listConversations`);
      world.onList?.();
      return world.chats.filter((c) => c.source === source).map((c) => ({ ...c }));
    },
    listApprovals(): Approval[] {
      world.calls.push(`${source}.listApprovals`);
      return [];
    },
    async getConversation(id: string): Promise<ConversationDetail> {
      world.calls.push(`${source}.getConversation`);
      const conversation = find(source, id);
      if (!conversation) throw new UserFacingError('That chat no longer exists.', 404);
      return { conversation: { ...conversation }, items: world.items.get(`${source}:${id}`) ?? [], approvals: [] };
    },
    async sendMessage(id: string, text: string) {
      world.calls.push(`${source}.sendMessage`);
      if (world.sendError) throw world.sendError;
      world.sent.push({ chat: `${source}:${id}`, text });
      const target = find(source, id);
      if (target && world.busyAfterSend) target.status = 'running';
    },
    async interrupt() {
      world.calls.push(`${source}.interrupt`);
    },
    async respondToApproval() {
      world.calls.push(`${source}.respondToApproval`);
    },
    async listCommands() {
      world.calls.push(`${source}.listCommands`);
      return [];
    },
    async getControls() {
      world.calls.push(`${source}.getControls`);
      return { controls: [] };
    },
    async setControl(): Promise<ControlChangeResponse> {
      world.calls.push(`${source}.setControl`);
      return { ok: true, controls: { controls: [] } };
    },
  });
  // New chats start working, and carry who started them (as the adapters do).
  const add = (source: Source, cwd: string, title: string, startedBy?: StartedBy, labels?: Record<string, string>) => {
    const id = `new-${++created}`;
    const parent = labelledParent(labels);
    world.chats.push({
      source,
      id,
      title,
      status: 'running',
      updatedAt: T0,
      pendingApprovals: 0,
      project: { path: cwd, name: cwd.split('/').pop()! },
      ...(startedBy ? { startedBy } : {}),
      ...(parent ? { parent } : {}),
    });
    return id;
  };
  const hermes: HermesSource = {
    ...base('hermes'),
    async createConversation(text: string, cwd?: string, _attachments?: Attachment[], options?: BridgeCreateOptions) {
      world.calls.push('hermes.createConversation');
      const id = add('hermes', cwd ?? '/', options?.title ?? 'New chat', options?.startedBy);
      world.created.push({ chat: `hermes:${id}`, hermes: { text, ...(cwd ? { cwd } : {}), ...(options ? { options } : {}) } });
      return { id };
    },
    async listNewChatCommands() {
      return [];
    },
    async newChatOptions() {
      return { models: [], defaultModel: null };
    },
    async setCredentials() {
      return { source: 'hermes', state: 'connected' };
    },
    async clearCredentials() {
      return { source: 'hermes', state: 'connected' };
    },
  };
  const paseo: PaseoSource = {
    ...base('paseo'),
    async options() {
      world.calls.push('paseo.options');
      return { providers: world.providers, workspaces: [] };
    },
    async folderStatus() {
      return 'exists' as const;
    },
    async createFolder(path: string) {
      return path;
    },
    async createConversation(input: CreatePaseoAgentInput) {
      world.calls.push('paseo.createConversation');
      const id = add('paseo', input.cwd, input.title ?? 'Untitled agent', input.startedBy, input.labels);
      world.created.push({ chat: `paseo:${id}`, paseo: input });
      return id;
    },
  };
  return { hermes, paseo };
}

interface LogLine {
  level: string;
  obj: Record<string, unknown>;
  msg?: string;
}

function recordingLog() {
  const lines: LogLine[] = [];
  const at = (level: string) => (obj: object, msg?: string) => lines.push({ level, obj: { ...obj } as Record<string, unknown>, msg });
  return { lines, log: { info: at('info'), warn: at('warn'), error: at('error') } };
}

function setup(options: { busyAfterSend?: boolean } = {}) {
  const world = makeWorld();
  world.busyAfterSend = options.busyAfterSend ?? false;
  let now = T0;
  const hub = new EventHub();
  const events: ServerEvent[] = [];
  const browser = hub.add(
    { readyState: 1, bufferedAmount: 0, send: (p: string) => events.push(JSON.parse(p)), terminate() {} } as never,
    'owner@example.com',
  );
  const { lines, log } = recordingLog();
  const sources = fakeSources(world);
  const bridge = new Bridge({ background: new BackgroundGate('primary'), sources, hub, log, port: 19012, now: () => now, pollMs: 0 });
  const from = (identity: BridgeIdentity) => ({
    call: (tool: string, args: object = {}) => bridge.call(tool, args, identity),
  });
  return {
    world,
    sources,
    bridge,
    events,
    logs: lines,
    from,
    /** The Paseo agent "Fix flaky login test", working in APP. */
    caller: from({ paseoAgent: 'caller', cwd: APP }),
    watch: (source: Source, id: string) => hub.subscribe(browser, source, id),
    advance: (ms: number) => {
      now += ms;
    },
    set: (id: string, patch: Partial<ConversationSummary>) => Object.assign(world.chats.find((c) => c.id === id)!, patch),
    texts: () => world.sent.map((s) => parseBridgeEnvelope(s.text)?.text ?? s.text),
  };
}

async function refused(promise: Promise<unknown>, status: number, message?: string | RegExp) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'expected a refusal').toBeInstanceOf(UserFacingError);
  expect((err as UserFacingError).status).toBe(status);
  if (message !== undefined) expect((err as UserFacingError).message).toMatch(message);
}

type ListResult = {
  project: { path: string; name: string };
  you?: { chat: string; title: string };
  chats: ChatEntry[];
  more_not_listed?: number;
  note?: string;
};

/** Let pending promise chains (the fakes are all in memory) run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));
type ReadResult = { chat: string; title: string; agent: string; status: string; items: TranscriptItem[]; older_items_not_shown?: number };

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('bridge: list_chats and project scoping', () => {
  it("lists the other chats in the caller's project, across Hermes and Paseo", async () => {
    const { caller } = setup();
    const result = (await caller.call('list_chats')) as ListResult;
    expect(result.project).toEqual({ path: APP, name: 'app' });
    expect(result.chats.map((c) => c.chat).sort()).toEqual(['hermes:h-app', 'paseo:asking', 'paseo:busy', 'paseo:idle']);
    const byId = new Map(result.chats.map((c) => [c.chat, c]));
    expect(byId.get('paseo:busy')!.status).toBe('working');
    expect(byId.get('paseo:asking')!.status).toBe('needs_approval');
    expect(byId.get('hermes:h-app')).toMatchObject({ backend: 'hermes', agent: 'Hermes (claude-sonnet-5)', status: 'idle' });
    expect(byId.get('paseo:idle')).toMatchObject({ backend: 'paseo', agent: 'Codex', title: 'Docs', updated: new Date(T0 - HOUR).toISOString() });
  });

  it('resolves other callers from their folder or the project they name, and never trusts claimed ids', async () => {
    const { from } = setup();
    const deep = (await from({ cwd: `${APP}/server/src` }).call('list_chats')) as ListResult;
    expect(deep.project.path).toBe(APP);
    // It can't be told apart from the chats, so none is left out.
    expect(deep.chats.map((c) => c.chat)).toContain('paseo:caller');

    const named = (await from({ cwd: '/home/me' }).call('list_chats', { project: `${OTHER}/` })) as ListResult;
    expect(named.project.path).toBe(OTHER);
    expect(named.chats.map((c) => c.chat).sort()).toEqual(['hermes:h-other', 'paseo:elsewhere']);

    // An agent id Paseo doesn't know is just an unverified caller.
    const stranger = (await from({ paseoAgent: 'no-such-agent', cwd: APP }).call('list_chats')) as ListResult;
    expect(stranger.chats.map((c) => c.chat)).toContain('paseo:caller');
    // Nor can a chat id be claimed through the arguments.
    await refused(from({ cwd: APP }).call('list_chats', { caller: 'paseo:caller' }), 400, /Unrecognized key/);
  });

  it("uses a Paseo agent's own project, whatever it names", async () => {
    const { caller } = setup();
    expect(((await caller.call('list_chats', { project: OTHER })) as ListResult).project.path).toBe(APP);
  });

  it('refuses to work outside a project folder', async () => {
    const { from, caller, set } = setup();
    for (const identity of [{}, { cwd: '/' }, { cwd: '/home/me' }, { cwd: '/root' }, { cwd: 'relative/dir' }]) {
      await refused(from(identity).call('list_chats'), 400, 'Run this from a project folder.');
    }
    await refused(from({ cwd: APP }).call('list_chats', { project: '/home/me' }), 400, 'Run this from a project folder.');
    await refused(from({ cwd: APP }).call('list_chats', { project: 'code/app' }), 400, /absolute/);
    // A Paseo agent working in a home folder can't pick another project.
    set('caller', { project: { path: '/home/me', name: 'me' } });
    await refused(caller.call('list_chats', { project: APP }), 400, 'Run this from a project folder.');
  });

  it('lists at most 50 chats, most recent first', async () => {
    const { caller, world } = setup();
    for (let i = 0; i < 60; i++) world.chats.push(chat('paseo', `extra-${i}`, APP, { updatedAt: T0 + i }));
    const result = (await caller.call('list_chats')) as ListResult;
    expect(result.chats).toHaveLength(50);
    expect(result.chats[0]!.chat).toBe('paseo:extra-59');
    expect(result.more_not_listed).toBe(14);
  });
});

describe('bridge: read_chat', () => {
  it('reads a chat in the project: the newest items, oldest first', async () => {
    const { caller, world } = setup();
    const items: TimelineItem[] = [
      { kind: 'user', id: 'u1', text: 'Why does the login test flake?' },
      { kind: 'reasoning', id: 'r1', text: 'hidden reasoning' },
      { kind: 'tool', id: 't1', name: 'terminal', summary: 'npm test', status: 'done', output: 'ok' },
      { kind: 'assistant', id: 'a1', text: 'A race in the session setup.' },
      { kind: 'user', id: 'u2', text: bridgeEnvelope('Docs (Codex)', 'Is the fix in?') },
    ];
    world.items.set('hermes:h-app', items);
    const result = (await caller.call('read_chat', { chat: 'hermes:h-app', limit: 3 })) as ReadResult;
    expect(result).toEqual({
      chat: 'hermes:h-app',
      title: 'hermes h-app',
      agent: 'Hermes (claude-sonnet-5)',
      status: 'idle',
      items: [
        { role: 'tool', text: '[tool] terminal: npm test (done)' },
        { role: 'assistant', text: 'A race in the session setup.' },
        { role: 'agent', from: 'Docs (Codex)', text: 'Is the fix in?' },
      ],
      older_items_not_shown: 1,
    });
    expect(JSON.stringify(result)).not.toContain('hidden reasoning');

    world.items.set('paseo:idle', Array.from({ length: 30 }, (_, i) => ({ kind: 'assistant' as const, id: `a${i}`, text: `reply ${i}` })));
    const defaults = (await caller.call('read_chat', { chat: 'paseo:idle' })) as ReadResult;
    expect(defaults.items).toHaveLength(20);
    expect(defaults.items.at(-1)!.text).toBe('reply 29');
    await refused(caller.call('read_chat', { chat: 'paseo:idle', limit: 51 }), 400);
    await refused(caller.call('read_chat', { chat: 'paseo:idle', limit: 0 }), 400);
  });

  it("refuses chats outside the project without opening them", async () => {
    const { caller, world } = setup();
    for (const target of ['paseo:elsewhere', 'hermes:h-other', 'hermes:h-home', 'paseo:no-such-agent']) {
      await refused(caller.call('read_chat', { chat: target }), 403, NOT_IN_PROJECT);
    }
    await refused(caller.call('read_chat', { chat: 'shell:rm -rf' }), 400);
    await refused(caller.call('read_chat', { chat: 'paseo:../../etc' }), 400);
    expect(world.calls.filter((c) => c.endsWith('getConversation'))).toEqual([]);
  });
});

describe('bridge: send_message', () => {
  it("delivers to an idle chat right away, in the envelope, signed with the caller's title and agent", async () => {
    const { caller, world, set } = setup();
    expect(await caller.call('send_message', { chat: 'paseo:idle', text: 'Please update the docs' })).toEqual({
      delivered: 'now',
      note: "Delivered. They'll see your reply address; use wait_for_reply to wait for their answer.",
    });
    expect(world.sent).toEqual([{ chat: 'paseo:idle', text: bridgeEnvelope(CALLER_LABEL, 'Please update the docs', 'paseo:caller') }]);
    expect(parseBridgeEnvelope(world.sent[0]!.text)).toEqual({
      sender: CALLER_LABEL,
      text: 'Please update the docs',
      replyTo: 'paseo:caller',
    });

    // Across backends, and to a chat that stopped on an error.
    set('h-app', { status: 'error' });
    expect(await caller.call('send_message', { chat: 'hermes:h-app', text: 'Try again?' })).toMatchObject({ delivered: 'now' });
    expect(world.sent[1]).toEqual({ chat: 'hermes:h-app', text: bridgeEnvelope(CALLER_LABEL, 'Try again?', 'paseo:caller') });
  });

  it('signs unverified callers by their folder, or as a Hermes chat, with no reply address', async () => {
    const { from, world } = setup();
    expect(await from({ cwd: `${APP}/server` }).call('send_message', { chat: 'paseo:idle', text: 'a' })).toEqual({
      delivered: 'now',
      note: "Delivered. Wayroost couldn't identify your chat, so they can't reply to you through the bridge.",
    });
    await from({ cwd: `${APP}/server` }).call('send_message', { chat: 'hermes:h-app', text: 'b', backend_hint: 'hermes' });
    await from({ cwd: '/home/me' }).call('send_message', { chat: 'paseo:caller', text: 'c', project: APP });
    expect(world.sent.map((s) => parseBridgeEnvelope(s.text)!.sender)).toEqual(['An agent in server', 'A Hermes chat in server', 'An agent']);
    expect(world.sent.every((s) => !parseBridgeEnvelope(s.text)!.replyTo && !s.text.includes('To reply'))).toBe(true);
  });

  it("refuses slash commands, the caller's own chat and chats in other projects", async () => {
    const { caller, world } = setup();
    for (const text of ['/status', '  /model gpt-5', '/home/me/notes.md is out of date']) {
      await refused(caller.call('send_message', { chat: 'paseo:idle', text }), 400, SLASH_MESSAGE);
    }
    await refused(caller.call('send_message', { chat: 'paseo:caller', text: 'hi' }), 400, /your own chat/);
    await refused(caller.call('send_message', { chat: 'paseo:elsewhere', text: 'hi' }), 403, NOT_IN_PROJECT);
    await refused(caller.call('send_message', { chat: 'paseo:idle', text: '   ' }), 400);
    await refused(caller.call('send_message', { chat: 'paseo:idle', text: 'x'.repeat(8001) }), 400);
    expect(world.sent).toEqual([]);
  });

  it('waits while a chat works or waits on the user, and delivers one message each time it becomes idle', async () => {
    const { caller, bridge, world, set, texts } = setup({ busyAfterSend: true });
    expect(await caller.call('send_message', { chat: 'paseo:busy', text: 'one' })).toMatchObject({ delivered: 'queued', position: 1 });
    expect(await caller.call('send_message', { chat: 'paseo:busy', text: 'two' })).toMatchObject({ delivered: 'queued', position: 2 });
    expect(await caller.call('send_message', { chat: 'paseo:asking', text: 'three' })).toMatchObject({ delivered: 'queued', position: 1 });
    await bridge.deliverQueued();
    expect(world.sent).toEqual([]);

    set('busy', { status: 'idle' });
    await bridge.deliverQueued();
    expect(texts()).toEqual(['one']);
    // It's working on "one" now: "two" waits.
    await bridge.deliverQueued();
    expect(texts()).toEqual(['one']);
    set('busy', { status: 'idle' });
    await bridge.deliverQueued();
    expect(texts()).toEqual(['one', 'two']);

    // Never while approvals are pending, whatever the status says.
    set('asking', { status: 'idle', pendingApprovals: 1 });
    await bridge.deliverQueued();
    expect(texts()).toEqual(['one', 'two']);
    set('asking', { pendingApprovals: 0 });
    await bridge.deliverQueued();
    expect(texts()).toEqual(['one', 'two', 'three']);
    expect(world.calls.filter((c) => /interrupt|respondToApproval/.test(c))).toEqual([]);
  });

  it('gives a chat time to start working after a delivery before sending the next', async () => {
    const { caller, from, bridge, texts, advance } = setup();
    expect(await caller.call('send_message', { chat: 'paseo:idle', text: 'one' })).toMatchObject({ delivered: 'now' });
    // Still reported idle (status lags): the next message waits instead of steering the new turn.
    expect(await from({ cwd: APP }).call('send_message', { chat: 'paseo:idle', text: 'two' })).toMatchObject({ delivered: 'queued', position: 1 });
    await bridge.deliverQueued();
    expect(texts()).toEqual(['one']);
    advance(10_000);
    await bridge.deliverQueued();
    expect(texts()).toEqual(['one', 'two']);
  });

  it.each(['503', 'ECONNRESET'] as const)('keeps ordinary messages and their send attempts through a readiness lookup outage: %s', async (kind) => {
    const { caller, bridge, set, world, texts } = setup();
    await caller.call('send_message', { chat: 'paseo:busy', text: 'Demo queued message' });
    set('busy', { status: 'idle' });
    const source = Reflect.get(bridge, 'options').sources.paseo as PaseoSource;
    const list = source.listConversations.bind(source);
    source.listConversations = async () => {
      throw kind === '503' ? new UserFacingError('Demo lookup unavailable', 503)
        : Object.assign(new Error('Demo reset'), { code: 'ECONNRESET' });
    };
    for (let i = 0; i < 8; i++) await bridge.tick();
    expect(world.sent).toEqual([]);
    expect((Reflect.get(bridge, 'queues') as Map<string, unknown[]>).get('paseo:busy')).toHaveLength(1);
    source.listConversations = list;
    // Two real send failures still leave the third attempt available.
    world.sendError = new UserFacingError('Demo send rejected', 502);
    await bridge.tick(); await bridge.tick();
    expect((Reflect.get(bridge, 'queues') as Map<string, unknown[]>).get('paseo:busy')).toHaveLength(1);
    world.sendError = null;
    await bridge.tick();
    expect(texts()).toEqual(['Demo queued message']);
    bridge.stop();
  });

  it('keeps ordinary messages through readiness holds in the guarded send without spending attempts', async () => {
    const { caller, bridge, sources, set, texts } = setup();
    set('h-app', { status: 'running' });
    await caller.call('send_message', { chat: 'hermes:h-app', text: 'Demo queued message' });
    set('h-app', { status: 'idle' });
    let holding = true;
    sources.hermes.sendMessageWhenIdle = async (id, text, beforeSubmit) => {
      await beforeSubmit?.();
      if (holding) throw new UserFacingError('Demo recipient readiness is unknown', 503);
      await sources.hermes.sendMessage(id, text);
    };
    for (let i = 0; i < 8; i++) await bridge.tick();
    expect(texts()).toEqual([]);
    expect((Reflect.get(bridge, 'queues') as Map<string, Array<{ attempts: number }>>).get('hermes:h-app')?.[0]?.attempts).toBe(0);
    holding = false;
    await bridge.tick();
    expect(texts()).toEqual(['Demo queued message']);
    bridge.stop();
  });

  it('checks the continuation settling window before delivering a retargeted ordinary message', async () => {
    const { caller, bridge, sources, world, set, advance, texts } = setup();
    set('h-app', { status: 'running' });
    await caller.call('send_message', { chat: 'hermes:h-app', text: 'Demo queued message' });
    world.chats.push(chat('hermes', 'demo-continuation', APP));
    await caller.call('send_message', { chat: 'hermes:demo-continuation', text: 'Demo current activity' });
    sources.hermes.resolveChat = (id) => id === 'h-app' ? 'demo-continuation' : id;
    await bridge.tick(); await bridge.tick();
    expect(texts()).toEqual(['Demo current activity']);
    advance(11_000);
    await bridge.tick();
    expect(texts()).toEqual(['Demo current activity', 'Demo queued message']);
    expect(world.sent.map((m) => m.chat)).toEqual(['hermes:demo-continuation', 'hermes:demo-continuation']);
    bridge.stop();
  });

  it('does not also hand an ordinary message to a wait while its adapter is sending it', async () => {
    const { caller, bridge, sources, set, texts } = setup();
    set('h-app', { status: 'running' });
    await caller.call('send_message', { chat: 'hermes:h-app', text: 'Demo queued message' });
    set('h-app', { status: 'idle' });
    let release!: () => void;
    let started!: () => void;
    const sending = new Promise<void>((resolve) => { started = resolve; });
    const response = new Promise<void>((resolve) => { release = resolve; });
    const send = sources.hermes.sendMessage.bind(sources.hermes);
    sources.hermes.sendMessage = async (id, text) => { started(); await response; await send(id, text); };
    const delivery = bridge.tick();
    await sending;
    const hangUp = new AbortController();
    const wait = bridge.call('wait_for_reply', { chat: 'paseo:caller' }, { hermesSession: 'h-app', cwd: APP },
      { signal: hangUp.signal }).catch(() => 'hung up');
    try {
      await expect.poll(() => bridge.activeWaits).toBe(1);
      release();
      await delivery;
      expect(texts()).toEqual(['Demo queued message']);
      expect(bridge.activeWaits).toBe(1);
      hangUp.abort();
      expect(await wait).toBe('hung up');
    } finally { release(); hangUp.abort(); bridge.stop(); }
  });

  it('keeps at most 5 messages waiting for one chat', async () => {
    const { from } = setup();
    for (let i = 1; i <= 5; i++) {
      expect(await from({ cwd: `${APP}/part${i}` }).call('send_message', { chat: 'paseo:busy', text: `m${i}` })).toEqual({
        delivered: 'queued',
        position: i,
        note: `They're busy, so your message waits (number ${i} in line) and goes out when they're idle.`,
      });
    }
    await refused(from({ cwd: `${APP}/part6` }).call('send_message', { chat: 'paseo:busy', text: 'm6' }), 429, /5 messages waiting/);
  });

  it('drops messages that waited over an hour, and gives up on chats that are gone', async () => {
    const { caller, bridge, world, set, advance, texts, logs } = setup();
    await caller.call('send_message', { chat: 'paseo:busy', text: 'stale' });
    advance(HOUR + MIN);
    set('busy', { status: 'idle' });
    await bridge.deliverQueued();
    expect(world.sent).toEqual([]);
    expect(logs.some((l) => l.msg === 'bridge dropped messages that waited over an hour')).toBe(true);

    // A transient failure is retried; a chat that's gone is given up on.
    set('busy', { status: 'running' });
    await caller.call('send_message', { chat: 'paseo:busy', text: 'retry me' });
    set('busy', { status: 'idle' });
    world.sendError = new UserFacingError('Paseo is reconnecting. Try again in a moment.', 503);
    await bridge.deliverQueued();
    world.sendError = null;
    await bridge.deliverQueued();
    expect(texts()).toEqual(['retry me']);

    set('busy', { status: 'running' });
    advance(MIN);
    await caller.call('send_message', { chat: 'paseo:busy', text: 'lost' });
    set('busy', { status: 'idle' });
    world.sendError = new UserFacingError('That Paseo agent no longer exists.', 404);
    await bridge.deliverQueued();
    world.sendError = null;
    await bridge.deliverQueued();
    expect(texts()).toEqual(['retry me']);
  });
});

describe('bridge: rate limits and the loop breaker', () => {
  it('limits one pair to 4 messages per 10 minutes', async () => {
    const { caller, advance } = setup();
    for (let i = 0; i < 4; i++) await caller.call('send_message', { chat: 'paseo:idle', text: `m${i}` });
    await refused(caller.call('send_message', { chat: 'paseo:idle', text: 'm4' }), 429, /already sent that chat 4 messages/);
    advance(10 * MIN);
    await caller.call('send_message', { chat: 'paseo:idle', text: 'm5' });
  });

  it('limits a chat to receiving 6 messages per 10 minutes', async () => {
    const { from } = setup();
    for (let i = 0; i < 6; i++) await from({ cwd: `${APP}/part${i}` }).call('send_message', { chat: 'paseo:idle', text: `m${i}` });
    await refused(from({ cwd: `${APP}/part9` }).call('send_message', { chat: 'paseo:idle', text: 'm6' }), 429, /already received 6 messages/);
  });

  it('limits a caller to 12 messages per 10 minutes', async () => {
    const { caller, world } = setup();
    for (let i = 0; i < 13; i++) world.chats.push(chat('paseo', `t${i}`, APP));
    for (let i = 0; i < 12; i++) await caller.call('send_message', { chat: `paseo:t${i}`, text: 'hi' });
    await refused(caller.call('send_message', { chat: 'paseo:t12', text: 'hi' }), 429, /already sent 12 messages/);
  });

  it('limits everyone together to 60 messages per hour', async () => {
    const { from, world, advance } = setup();
    for (let i = 0; i < 11; i++) world.chats.push(chat('paseo', `t${i}`, APP));
    // Ten minutes apart, so no 10-minute limit applies.
    for (let batch = 0; batch < 6; batch++) {
      if (batch) advance(10 * MIN);
      for (let i = 0; i < 10; i++) {
        await from({ cwd: `${APP}/part${i}` }).call('send_message', { chat: `paseo:t${(i + batch) % 10}`, text: 'hi' });
      }
    }
    await refused(from({ cwd: `${APP}/part10` }).call('send_message', { chat: 'paseo:t10', text: 'hi' }), 429, /60 messages/);
    advance(10 * MIN);
    await from({ cwd: `${APP}/part10` }).call('send_message', { chat: 'paseo:t10', text: 'hi' });
  });

  it('pauses two chats that keep messaging each other, and says so in both timelines', async () => {
    const { caller, from, bridge, world, events, watch, set, advance, texts } = setup();
    const docs = from({ paseoAgent: 'idle', cwd: APP });
    watch('paseo', 'caller');
    watch('paseo', 'idle');
    for (let i = 0; i < 3; i++) {
      if (i === 2) set('caller', { status: 'running' }); // the last reply has to wait
      await caller.call('send_message', { chat: 'paseo:idle', text: `ping ${i}` });
      await docs.call('send_message', { chat: 'paseo:caller', text: `pong ${i}` });
      advance(MIN);
    }
    expect(texts()).toEqual(['ping 0', 'pong 0', 'ping 1', 'pong 1', 'ping 2']);

    await refused(caller.call('send_message', { chat: 'paseo:idle', text: 'ping 3' }), 429, LOOP_NOTICE);
    const notices = events.flatMap((e) =>
      e.type === 'items_upsert' ? e.items.filter((i) => i.kind === 'notice').map((i) => [e.conversationId, (i as { text: string }).text]) : [],
    );
    expect(notices).toEqual([
      ['caller', LOOP_NOTICE],
      ['idle', LOOP_NOTICE],
    ]);
    await refused(docs.call('send_message', { chat: 'paseo:caller', text: 'pong 3' }), 429, /paused messages between these chats/);

    // The reply that was waiting is dropped too; other chats aren't affected.
    set('caller', { status: 'idle' });
    await bridge.deliverQueued();
    expect(texts()).not.toContain('pong 2');
    expect(await caller.call('send_message', { chat: 'hermes:h-app', text: 'hi' })).toMatchObject({ delivered: 'now' });

    advance(30 * MIN);
    expect(await caller.call('send_message', { chat: 'paseo:idle', text: 'ping 4' })).toMatchObject({ delivered: 'now' });
    expect(world.calls.filter((c) => /interrupt/.test(c))).toEqual([]);
  });
});

describe('bridge: start_chat', () => {
  it('starts a Paseo agent in a mode that asks, in the project root, nested under the caller', async () => {
    const { caller, world } = setup();
    const text = 'Write an e2e test for the login flow\nUse the fixtures in test/e2e.';
    expect(await caller.call('start_chat', { backend: 'paseo', agent: 'claude', text })).toEqual({
      chat: 'paseo:new-1',
      title: 'Write an e2e test for the login flow',
      note: 'Started. It sees your message and your reply address; use wait_for_reply to wait for its answer.',
    });
    const input = world.created[0]!.paseo!;
    expect(input).toEqual({
      providerId: 'claude',
      cwd: APP,
      modeId: 'default',
      text: bridgeEnvelope(CALLER_LABEL, text, 'paseo:caller'),
      title: 'Write an e2e test for the login flow',
      labels: { [PARENT_AGENT_LABEL]: 'caller' },
      startedBy: { source: 'paseo', id: 'caller', title: 'Fix flaky login test' },
    });
    expect(input).not.toHaveProperty('acknowledgeAutoApprove');

    await caller.call('start_chat', { backend: 'paseo', agent: 'codex', mode: 'auto', text: 'Review it', title: 'Review the e2e test' });
    expect(world.created[1]!.paseo).toMatchObject({ providerId: 'codex', modeId: 'auto', title: 'Review the e2e test' });

    // The new chats show who started them, and nest under it.
    const list = (await caller.call('list_chats')) as ListResult;
    expect(list.chats.find((c) => c.chat === 'paseo:new-1')!.started_by).toEqual({ chat: 'paseo:caller', title: 'Fix flaky login test' });
    expect(world.chats.find((c) => c.id === 'new-1')!.parent).toEqual({ source: 'paseo', id: 'caller' });
  });

  it("refuses agents that don't ask before acting, and modes that don't", async () => {
    const { caller, world } = setup();
    const start = (args: object) => caller.call('start_chat', { backend: 'paseo', text: 'Do the thing', ...args });
    await refused(start({ agent: 'pi' }), 403, "Pi doesn't ask before acting, so agents can't start it; ask the user.");
    await refused(start({ agent: 'claude', mode: 'acceptEdits' }), 403, /only start Claude Code in a mode that asks before acting\. Modes that ask first: plan, default\./);
    await refused(start({ agent: 'claude', mode: 'bypassPermissions' }), 403, /mode that asks before acting/);
    await refused(start({ agent: 'codex' }), 403, /Codex's default mode doesn't ask before acting/);
    await refused(start({ agent: 'cursor' }), 400, /cursor isn't available in Paseo right now\. Agents that can be started: claude, codex\./);
    await refused(start({}), 400, /Say which Paseo agent to start/);
    await refused(start({ agent: 'claude', text: '/review' }), 400, SLASH_MESSAGE);
    await refused(caller.call('start_chat', { backend: 'hermes', agent: 'claude', text: 'x' }), 400, /only for Paseo/);
    await refused(caller.call('start_chat', { backend: 'hermes', text: 'x', acknowledgeAutoApprove: true }), 400, /Unrecognized key/);
    expect(world.created).toEqual([]);
  });

  it('starts Hermes chats in the project root with the same envelope; unverified callers get no parent', async () => {
    const { from, world } = setup();
    const agent = from({ cwd: `${APP}/server` });
    expect(await agent.call('start_chat', { backend: 'hermes', text: 'Summarize the logs', title: 'Log summary' })).toEqual({
      chat: 'hermes:new-1',
      title: 'Log summary',
      note: 'Started.',
    });
    expect(world.created[0]!.hermes).toEqual({
      text: bridgeEnvelope('An agent in server', 'Summarize the logs'),
      cwd: APP,
      options: { title: 'Log summary' },
    });
    await agent.call('start_chat', { backend: 'paseo', agent: 'claude', text: 'Fix the flake' });
    expect(world.created[1]!.paseo).not.toHaveProperty('labels');
    expect(world.created[1]!.paseo).not.toHaveProperty('startedBy');
  });

  it('allows 3 agent-started chats per project per hour, 2 of them working at once', async () => {
    const { caller, from, world, set, advance } = setup();
    const start = () => caller.call('start_chat', { backend: 'hermes', text: 'A task' });
    await start();
    await start();
    await refused(start(), 429, /2 chats that agents started in this project are still working/);
    set('new-1', { status: 'idle' });
    await start();
    set('new-2', { status: 'idle' });
    set('new-3', { status: 'idle' });
    await refused(start(), 429, /already started 3 chats in this project in the last hour/);
    // Other projects have their own caps.
    await from({ cwd: OTHER }).call('start_chat', { backend: 'hermes', text: 'Elsewhere' });

    advance(HOUR);
    await start();
    // A chat just started counts as working even before it's listed.
    world.chats = world.chats.filter((c) => c.id !== 'new-5');
    await start();
    await refused(start(), 429, /still working/);
    advance(2 * MIN);
    set('new-6', { status: 'idle' });
    await start();
  });
});

describe('bridge: the kill switch and activity counts', () => {
  it('refuses every tool while paused, holds waiting messages, and counts the last hour', async () => {
    const { caller, bridge, world, set, advance, texts } = setup();
    await caller.call('send_message', { chat: 'paseo:idle', text: 'now' });
    await caller.call('send_message', { chat: 'paseo:busy', text: 'later' });
    await caller.call('start_chat', { backend: 'hermes', text: 'new chat' });
    expect(bridge.status()).toEqual({ enabled: true, paused: false, port: 19012, recent: { sent: 1, queued: 1, started: 1 } });

    expect(bridge.setPaused(true)).toMatchObject({ paused: true });
    const calls: Array<[string, object]> = [
      ['list_chats', {}],
      ['read_chat', { chat: 'paseo:idle' }],
      ['send_message', { chat: 'paseo:idle', text: 'hi' }],
      ['start_chat', { backend: 'hermes', text: 'hi' }],
      ['anything_else', {}],
    ];
    for (const [tool, args] of calls) await refused(caller.call(tool, args), 503, PAUSED_MESSAGE);
    set('busy', { status: 'idle' });
    await bridge.deliverQueued();
    expect(texts()).toEqual(['now']);

    expect(bridge.setPaused(false)).toMatchObject({ paused: false });
    await bridge.deliverQueued();
    expect(texts()).toEqual(['now', 'later']);
    expect(bridge.status().recent).toEqual({ sent: 2, queued: 1, started: 1 });
    expect(world.calls.filter((c) => c.endsWith('createConversation'))).toHaveLength(1);

    advance(HOUR);
    expect(bridge.status().recent).toEqual({ sent: 0, queued: 0, started: 0 });
  });

  it('stops a call that was already under way when the user pauses', async () => {
    const { caller, bridge, world } = setup();
    world.onList = () => bridge.setPaused(true);
    await refused(caller.call('send_message', { chat: 'paseo:idle', text: 'hi' }), 503, PAUSED_MESSAGE);
    bridge.setPaused(false);
    await refused(caller.call('start_chat', { backend: 'paseo', agent: 'claude', text: 'hi' }), 503, PAUSED_MESSAGE);
    expect(world.sent).toEqual([]);
    expect(world.created).toEqual([]);
  });
});

describe('bridge: no approval surface', () => {
  it('offers exactly five tools and never touches approvals, modes, models or interrupts', async () => {
    const { caller, bridge, world, set } = setup();
    expect([...BRIDGE_TOOLS]).toEqual(['list_chats', 'read_chat', 'send_message', 'start_chat', 'wait_for_reply']);
    for (const tool of ['respond_to_approval', 'list_approvals', 'approve', 'set_mode', 'set_model', 'interrupt', 'run_command']) {
      await refused(caller.call(tool, {}), 404);
    }

    // Every tool, including against a chat that's waiting on the user.
    await caller.call('list_chats');
    const read = (await caller.call('read_chat', { chat: 'paseo:asking' })) as ReadResult;
    expect(read).not.toHaveProperty('approvals');
    expect(await caller.call('send_message', { chat: 'paseo:asking', text: 'Go ahead' })).toMatchObject({ delivered: 'queued' });
    await caller.call('start_chat', { backend: 'paseo', agent: 'claude', text: 'Help out' });
    set('asking', { status: 'idle', pendingApprovals: 0 });
    await bridge.deliverQueued();

    expect(world.calls.filter((c) => /respondToApproval|listApprovals|interrupt|setControl|getControls|listCommands/.test(c))).toEqual([]);
    expect(world.created.every((c) => !c.paseo || !('acknowledgeAutoApprove' in c.paseo))).toBe(true);
  });

  it('logs every call without message text, titles or folders', async () => {
    const { caller, from, bridge, set, logs } = setup();
    await caller.call('send_message', { chat: 'paseo:idle', text: 'TOP-SECRET-TEXT' });
    await caller.call('send_message', { chat: 'paseo:busy', text: 'TOP-SECRET-TEXT' });
    await refused(caller.call('send_message', { chat: 'paseo:elsewhere', text: 'TOP-SECRET-TEXT' }), 403);
    await from({ cwd: `${APP}/server` }).call('list_chats');
    set('busy', { status: 'idle' });
    await bridge.deliverQueued();

    expect(logs.filter((l) => l.msg === 'bridge call').map((l) => l.obj)).toEqual([
      { tool: 'send_message', caller: 'paseo:caller', target: 'paseo:idle', outcome: 'delivered' },
      { tool: 'send_message', caller: 'paseo:caller', target: 'paseo:busy', outcome: 'queued' },
      { tool: 'send_message', caller: 'paseo:caller', target: 'paseo:elsewhere', outcome: 'refused 403' },
      { tool: 'list_chats', caller: 'unverified', outcome: 'ok' },
    ]);
    const all = JSON.stringify(logs);
    for (const secret of ['TOP-SECRET', 'Fix flaky login test', '/home/me']) expect(all).not.toContain(secret);
  });
});

// ---- v2: Hermes callers, reply addresses, waiting for answers ----------------------------

describe('bridge: identified Hermes callers', () => {
  it('treats a Hermes chat Signalbox knows as the caller, and anything else as unidentified', async () => {
    const { from, world } = setup();
    const hermes = from({ hermesSession: 'h-app', cwd: '/home/me' });
    const list = (await hermes.call('list_chats')) as ListResult;
    // Its own project (the Paseo root above its folder), whatever its cwd says.
    expect(list.project.path).toBe(APP);
    expect(list.you).toEqual({ chat: 'hermes:h-app', title: 'hermes h-app' });
    expect(list.chats.map((c) => c.chat)).not.toContain('hermes:h-app');
    expect(list).not.toHaveProperty('note');

    await hermes.call('send_message', { chat: 'paseo:idle', text: 'From Hermes' });
    expect(parseBridgeEnvelope(world.sent[0]!.text)).toEqual({
      sender: 'hermes h-app (Hermes)',
      text: 'From Hermes',
      replyTo: 'hermes:h-app',
    });

    // A session id Signalbox doesn't know is only a claim: unidentified, no reply address.
    const spoof = from({ hermesSession: '20260101_000000_nope', cwd: APP });
    const anonymous = (await spoof.call('list_chats')) as ListResult;
    expect(anonymous).not.toHaveProperty('you');
    expect(anonymous.note).toBe(NOTES.anonymous);
    await spoof.call('send_message', { chat: 'hermes:h-app', text: 'Hi' });
    expect(parseBridgeEnvelope(world.sent[1]!.text)).toEqual({ sender: 'An agent in app', text: 'Hi' });
    await refused(spoof.call('wait_for_reply', { chat: 'paseo:idle' }), 400, WAIT_NEEDS_IDENTITY);
    // Nor can arguments claim a session.
    await refused(from({ cwd: APP }).call('list_chats', { hermes_session: 'h-app' }), 400, /Unrecognized key/);

    // The Paseo id is checked first; a Hermes chat elsewhere brings its own project.
    const both = (await from({ paseoAgent: 'caller', hermesSession: 'h-app' }).call('list_chats')) as ListResult;
    expect(both.you).toEqual({ chat: 'paseo:caller', title: 'Fix flaky login test' });
    expect(((await from({ hermesSession: 'h-other' }).call('list_chats')) as ListResult).project.path).toBe(OTHER);
  });

  it('records what a Hermes chat starts, and breaks Hermes–Paseo loops', async () => {
    const { from, world, events, watch, advance } = setup();
    const hermes = from({ hermesSession: 'h-app' });
    await hermes.call('start_chat', { backend: 'paseo', agent: 'claude', text: 'Profile the build' });
    expect(world.created[0]!.paseo).toMatchObject({
      text: bridgeEnvelope('hermes h-app (Hermes)', 'Profile the build', 'hermes:h-app'),
      startedBy: { source: 'hermes', id: 'h-app', title: 'hermes h-app' },
    });
    // Paseo's parent label is for Paseo parents only (it makes Paseo treat the agent as delegated);
    // a Hermes starter gets Signalbox's own, and the agent nests under it.
    expect(world.created[0]!.paseo!.labels).toEqual({ [HERMES_PARENT_LABEL]: 'h-app' });
    expect(world.chats.find((c) => c.id === 'new-1')!.parent).toEqual({ source: 'hermes', id: 'h-app' });

    const docs = from({ paseoAgent: 'idle', cwd: APP });
    watch('hermes', 'h-app');
    watch('paseo', 'idle');
    for (let i = 0; i < 3; i++) {
      await hermes.call('send_message', { chat: 'paseo:idle', text: `ping ${i}` });
      await docs.call('send_message', { chat: 'hermes:h-app', text: `pong ${i}` });
      advance(MIN);
    }
    await refused(hermes.call('send_message', { chat: 'paseo:idle', text: 'ping 3' }), 429, LOOP_NOTICE);
    const notices = events.flatMap((e) =>
      e.type === 'items_upsert' ? e.items.filter((i) => i.kind === 'notice').map((i) => `${e.source}:${e.conversationId}`) : [],
    );
    expect(notices).toEqual(['hermes:h-app', 'paseo:idle']);
  });
});

describe('bridge: sub-agents', () => {
  /** Sub-agents as the adapters list them: Claude Code Task runs, and Hermes delegate_task runs. */
  const addSubagents = (world: World) =>
    world.chats.push(
      chat('paseo', 'caller:toolu_1', APP, { title: 'Explore', subagent: true, parent: { source: 'paseo', id: 'caller' } }),
      chat('hermes', 'h-child', `${APP}/server`, { title: 'Read the logs', subagent: true, parent: { source: 'hermes', id: 'h-app' } }),
      chat('hermes', 'h-grandchild', `${APP}/server`, { subagent: true, parent: { source: 'hermes', id: 'h-child' } }),
      // In folders none of the other chats work in.
      chat('paseo', 'caller:toolu_2', `${APP}/packages/ui`, { subagent: true, parent: { source: 'paseo', id: 'caller' } }),
      chat('hermes', 'h-stray', '/srv/tools', { subagent: true, parent: { source: 'hermes', id: 'h-gone' } }),
    );

  it("never lists, reads, messages or waits on them, and their folders don't make projects", async () => {
    const { caller, from, world } = setup();
    addSubagents(world);
    const list = (await caller.call('list_chats')) as ListResult;
    expect(list.chats.map((c) => c.chat).sort()).toEqual(['hermes:h-app', 'paseo:asking', 'paseo:busy', 'paseo:idle']);
    for (const chat of ['paseo:caller:toolu_1', 'hermes:h-child']) {
      await refused(caller.call('read_chat', { chat }), 403, NOT_IN_PROJECT);
      await refused(caller.call('send_message', { chat, text: 'Hi' }), 403, NOT_IN_PROJECT);
      await refused(caller.call('wait_for_reply', { chat }), 403, NOT_IN_PROJECT);
    }
    expect(world.calls.filter((c) => /getConversation|sendMessage/.test(c))).toEqual([]);
    expect(((await from({ cwd: `${APP}/packages/ui/src` }).call('list_chats')) as ListResult).project.path).toBe(APP);
    expect(((await from({ cwd: '/srv/tools/bin' }).call('list_chats')) as ListResult).project.path).toBe('/srv/tools/bin');
  });

  it('counts a sub-agent that calls in as the chat that runs it', async () => {
    const { from, world } = setup();
    addSubagents(world);
    // A Hermes delegate_task run, and one that it ran in turn: the Hermes chat at the top.
    for (const hermesSession of ['h-child', 'h-grandchild']) {
      const list = (await from({ hermesSession }).call('list_chats')) as ListResult;
      expect(list.you, hermesSession).toEqual({ chat: 'hermes:h-app', title: 'hermes h-app' });
      expect(list.project.path).toBe(APP);
    }
    await from({ hermesSession: 'h-child' }).call('send_message', { chat: 'paseo:idle', text: 'Found it' });
    expect(parseBridgeEnvelope(world.sent[0]!.text)).toEqual({ sender: 'hermes h-app (Hermes)', text: 'Found it', replyTo: 'hermes:h-app' });
    // What it starts is started by (and nests under) that chat.
    await from({ hermesSession: 'h-grandchild' }).call('start_chat', { backend: 'paseo', agent: 'claude', text: 'Profile it' });
    expect(world.created[0]!.paseo).toMatchObject({
      labels: { [HERMES_PARENT_LABEL]: 'h-app' },
      startedBy: { source: 'hermes', id: 'h-app', title: 'hermes h-app' },
    });
    // A Claude Code Task run, by its row id.
    expect(((await from({ paseoAgent: 'caller:toolu_1', cwd: APP }).call('list_chats')) as ListResult).you?.chat).toBe('paseo:caller');
  });

  it("finds the chat that runs one by the other ids it's known by, and places none it can't follow", async () => {
    const { from, world } = setup();
    world.chats.push(
      // Hermes in Paseo: Hermes knows it by its ACP session.
      chat('paseo', 'hermes-agent', APP, { title: 'Release notes', agentLabel: 'Hermes', aliases: [{ source: 'hermes', id: 'acp-1' }] }),
      chat('hermes', 'h-acp-child', APP, { subagent: true, parent: { source: 'hermes', id: 'acp-1' } }),
      chat('hermes', 'h-orphan', APP, { subagent: true, parent: { source: 'hermes', id: 'h-gone' } }),
      chat('hermes', 'h-loop-a', APP, { subagent: true, parent: { source: 'hermes', id: 'h-loop-b' } }),
      chat('hermes', 'h-loop-b', APP, { subagent: true, parent: { source: 'hermes', id: 'h-loop-a' } }),
      chat('hermes', 'h-no-parent', APP, { subagent: true }),
    );
    expect(((await from({ hermesSession: 'h-acp-child' }).call('list_chats')) as ListResult).you).toEqual({
      chat: 'paseo:hermes-agent',
      title: 'Release notes',
    });
    for (const hermesSession of ['h-orphan', 'h-loop-a', 'h-no-parent']) {
      const anonymous = from({ hermesSession, cwd: APP });
      const list = (await anonymous.call('list_chats')) as ListResult;
      expect(list, hermesSession).not.toHaveProperty('you');
      expect(list.note).toBe(NOTES.anonymous);
      await refused(anonymous.call('wait_for_reply', { chat: 'paseo:idle' }), 400, WAIT_NEEDS_IDENTITY);
    }
  });
});

describe('bridge: wait_for_reply', () => {
  it('needs an identified caller, a chat in the project that is not its own, and a sane timeout', async () => {
    const { caller, from } = setup();
    await refused(from({ cwd: APP }).call('wait_for_reply', { chat: 'paseo:idle' }), 400, WAIT_NEEDS_IDENTITY);
    await refused(caller.call('wait_for_reply', { chat: 'paseo:elsewhere' }), 403, NOT_IN_PROJECT);
    await refused(caller.call('wait_for_reply', { chat: 'paseo:caller' }), 400, /your own chat/);
    await refused(caller.call('wait_for_reply', { chat: 'paseo:idle', timeout_seconds: 121 }), 400);
    await refused(caller.call('wait_for_reply', { chat: 'paseo:idle', timeout_seconds: 0 }), 400);
  });

  it('hands the reply to the waiting chat and does not also deliver it', async () => {
    const { caller, from, bridge, world, logs } = setup();
    await caller.call('send_message', { chat: 'paseo:idle', text: 'Can you check the docs?' });
    const docs = from({ paseoAgent: 'idle', cwd: APP });
    const waiting = caller.call('wait_for_reply', { chat: 'paseo:idle' });
    await expect.poll(() => bridge.activeWaits).toBe(1);

    expect(await docs.call('send_message', { chat: 'paseo:caller', text: 'Docs look fine.' })).toEqual({
      delivered: 'now',
      note: NOTES.handedOver,
    });
    expect(await waiting).toEqual({ from: 'paseo:idle', kind: 'reply', text: 'Docs look fine.' });
    expect(bridge.activeWaits).toBe(0);
    // Once: to the wait, not also to the chat.
    await bridge.tick();
    expect(world.sent.map((s) => s.chat)).toEqual(['paseo:idle']);
    expect(logs.filter((l) => l.msg === 'bridge call').map((l) => l.obj.outcome)).toEqual(['delivered', 'handed over', 'reply']);

    // With nobody waiting, the next answer reaches the chat as before, with the sender's reply address.
    expect(await docs.call('send_message', { chat: 'paseo:caller', text: 'One more thing.' })).toMatchObject({ delivered: 'now' });
    expect(world.sent.at(-1)).toEqual({ chat: 'paseo:caller', text: bridgeEnvelope('Docs (Codex)', 'One more thing.', 'paseo:idle') });
  });

  it('takes an answer that was already waiting for the caller, instead of delivering it later', async () => {
    const { caller, from, bridge, world, set } = setup();
    set('caller', { status: 'running' });
    const docs = from({ paseoAgent: 'idle', cwd: APP });
    expect(await docs.call('send_message', { chat: 'paseo:caller', text: 'Here is the answer.' })).toMatchObject({
      delivered: 'queued',
      position: 1,
    });
    expect(await caller.call('wait_for_reply', { chat: 'paseo:idle' })).toEqual({
      from: 'paseo:idle',
      kind: 'reply',
      text: 'Here is the answer.',
    });
    set('caller', { status: 'idle' });
    await bridge.tick();
    expect(world.sent).toEqual([]);
  });

  it('says when the chat finishes working, with its latest message', async () => {
    const { caller, bridge, world, set } = setup();
    world.items.set('paseo:idle', [
      { kind: 'assistant', id: 'a1', text: 'Old answer' },
      { kind: 'assistant', id: 'a2', text: 'y'.repeat(3000) },
      { kind: 'reasoning', id: 'r1', text: 'thinking' },
    ]);
    await caller.call('send_message', { chat: 'paseo:idle', text: 'Please summarize' });
    let result: unknown;
    const waiting = caller.call('wait_for_reply', { chat: 'paseo:idle' }).then((r) => (result = r));
    await expect.poll(() => bridge.activeWaits).toBe(1);
    // Still reported idle right after the delivery: not taken as done.
    await bridge.tick();
    await flush();
    expect(result).toBeUndefined();
    set('idle', { status: 'running' });
    await bridge.tick();
    set('idle', { status: 'idle' });
    await bridge.tick();
    await waiting;
    expect(result).toEqual({ from: 'paseo:idle', kind: 'finished', last_message: `${'y'.repeat(1999)}…`, note: NOTES.finished });
  });

  it("doesn't pass off an answer from before the caller's message as its latest", async () => {
    const { caller, bridge, world, set } = setup();
    const own = bridgeEnvelope('Caller (Claude Code)', 'Please summarize', 'paseo:caller');
    world.items.set('paseo:idle', [
      { kind: 'assistant', id: 'a1', text: 'Old answer' },
      { kind: 'user', id: 'u1', text: own },
    ]);
    await caller.call('send_message', { chat: 'paseo:idle', text: 'Please summarize' });
    const waiting = caller.call('wait_for_reply', { chat: 'paseo:idle' });
    await expect.poll(() => bridge.activeWaits).toBe(1);
    set('idle', { status: 'running' });
    await bridge.tick();
    set('idle', { status: 'idle' });
    await bridge.tick();
    expect(await waiting).toMatchObject({ kind: 'finished', last_message: '', note: NOTES.finishedSilent });

    // What it wrote after the caller's message is its answer.
    world.items.set('paseo:idle', [...world.items.get('paseo:idle')!, { kind: 'assistant', id: 'a2', text: 'Summary.' }]);
    const again = caller.call('wait_for_reply', { chat: 'paseo:idle' });
    await expect.poll(() => bridge.activeWaits).toBe(1);
    set('idle', { status: 'running' });
    await bridge.tick();
    set('idle', { status: 'idle' });
    await bridge.tick();
    expect(await again).toMatchObject({ kind: 'finished', last_message: 'Summary.', note: NOTES.finished });
  });

  it('counts a quick turn it never saw as finished', async () => {
    const { caller, bridge, world, set, advance } = setup();
    // Its activity time moved past our message.
    await caller.call('send_message', { chat: 'paseo:idle', text: 'Quick one' });
    const first = caller.call('wait_for_reply', { chat: 'paseo:idle' });
    await expect.poll(() => bridge.activeWaits).toBe(1);
    set('idle', { updatedAt: T0 + 2_000 });
    await bridge.tick();
    expect(await first).toMatchObject({ kind: 'finished', last_message: '', note: NOTES.finishedSilent });

    // Or it stayed idle well after our message reached it.
    world.items.set('hermes:h-app', [{ kind: 'assistant', id: 'a1', text: 'Done.' }]);
    await caller.call('send_message', { chat: 'hermes:h-app', text: 'Another' });
    const second = caller.call('wait_for_reply', { chat: 'hermes:h-app' });
    await expect.poll(() => bridge.activeWaits).toBe(1);
    await bridge.tick();
    expect(bridge.activeWaits).toBe(1);
    advance(10_000);
    await bridge.tick();
    expect(await second).toMatchObject({ from: 'hermes:h-app', kind: 'finished', last_message: 'Done.' });
  });

  it("waits for the chat to answer the caller's own queued message, not just to finish what it was doing", async () => {
    const { caller, bridge, set, texts } = setup();
    await caller.call('send_message', { chat: 'paseo:busy', text: 'After you finish' });
    let result: unknown;
    const waiting = caller.call('wait_for_reply', { chat: 'paseo:busy' }).then((r) => (result = r));
    await expect.poll(() => bridge.activeWaits).toBe(1);
    set('busy', { status: 'idle' });
    await bridge.tick(); // delivers our message; it's still reported idle
    expect(texts()).toEqual(['After you finish']);
    await flush();
    expect(result).toBeUndefined();
    set('busy', { status: 'running' });
    await bridge.tick();
    set('busy', { status: 'idle' });
    await bridge.tick();
    await waiting;
    expect(result).toMatchObject({ from: 'paseo:busy', kind: 'finished' });
  });

  it('times out with the chat status and says to call again (45 s by default)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { caller, bridge } = setup();
      let result: unknown;
      const waiting = caller.call('wait_for_reply', { chat: 'paseo:busy' }).then((r) => (result = r));
      await vi.advanceTimersByTimeAsync(44_000);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      await waiting;
      expect(result).toEqual({ from: 'paseo:busy', kind: 'timed_out', status: 'working', note: NOTES.timedOut('working') });
      expect(bridge.activeWaits).toBe(0);

      const asking = caller.call('wait_for_reply', { chat: 'paseo:asking', timeout_seconds: 5 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await asking).toMatchObject({ kind: 'timed_out', status: 'needs_approval', note: expect.stringMatching(/approve/) });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one wait per caller: a new one replaces the old', async () => {
    const { caller, from, bridge } = setup();
    const first = caller.call('wait_for_reply', { chat: 'paseo:idle' }).then(
      () => null,
      (e: unknown) => e,
    );
    await expect.poll(() => bridge.activeWaits).toBe(1);
    const second = caller.call('wait_for_reply', { chat: 'paseo:busy' });
    const replaced = await first;
    expect(replaced).toBeInstanceOf(UserFacingError);
    expect((replaced as UserFacingError).status).toBe(409);
    await expect.poll(() => bridge.activeWaits).toBe(1);
    await from({ paseoAgent: 'busy', cwd: APP }).call('send_message', { chat: 'paseo:caller', text: 'Still here' });
    expect(await second).toEqual({ from: 'paseo:busy', kind: 'reply', text: 'Still here' });
  });

  it('ends waits when the user pauses, and refuses new ones', async () => {
    const { caller, bridge } = setup();
    const waiting = caller.call('wait_for_reply', { chat: 'paseo:idle' }).then(
      () => null,
      (e: unknown) => e,
    );
    await expect.poll(() => bridge.activeWaits).toBe(1);
    bridge.setPaused(true);
    const ended = await waiting;
    expect(ended).toBeInstanceOf(UserFacingError);
    expect(ended).toMatchObject({ status: 503, message: PAUSED_MESSAGE });
    await refused(caller.call('wait_for_reply', { chat: 'paseo:idle' }), 503, PAUSED_MESSAGE);
  });

  it('drops the wait of a caller that hung up, so a later reply reaches its chat', async () => {
    const { bridge, from, world } = setup();
    const hangUp = new AbortController();
    const waiting = bridge
      .call('wait_for_reply', { chat: 'paseo:idle' }, { paseoAgent: 'caller', cwd: APP }, { signal: hangUp.signal })
      .then(
        () => null,
        (e: unknown) => e,
      );
    await expect.poll(() => bridge.activeWaits).toBe(1);
    hangUp.abort();
    expect(await waiting).toMatchObject({ status: 499 });
    expect(bridge.activeWaits).toBe(0);
    expect(await from({ paseoAgent: 'idle', cwd: APP }).call('send_message', { chat: 'paseo:caller', text: 'Late answer' })).toMatchObject({
      delivered: 'now',
      note: NOTES.sent,
    });
    expect(world.sent.map((s) => s.chat)).toEqual(['paseo:caller']);
  });
});

// ---- the loopback listener -------------------------------------------------------

const TOKEN = randomBytes(32).toString('base64url');
const PORT = 19012;

function stubBridge(answer: (tool: string) => unknown = () => ({ hello: 'world' })) {
  const seen: Array<{ tool: string; args: unknown; identity: BridgeIdentity }> = [];
  return {
    seen,
    call: async (tool: string, args: unknown, identity: BridgeIdentity = {}) => {
      seen.push({ tool, args, identity });
      return answer(tool);
    },
  };
}

async function listener(bridge = stubBridge()) {
  const { lines, log } = recordingLog();
  const app = await buildBridgeServer({ background: new BackgroundGate('primary'), bridge, token: TOKEN, port: PORT, log });
  cleanups.push(() => app.close());
  const post = (tool: string, body: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: `/bridge/v1/${tool}`,
      headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
      payload: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { app, post, logs: lines, seen: bridge.seen };
}

describe('bridge listener', () => {
  it('requires the bearer token and never logs it', async () => {
    const { app, post, logs, seen } = await listener();
    const wrong = 'not-the-token-0123456789abcdefghijklmnop';
    for (const authorization of ['', `Bearer ${wrong}`, `Basic ${TOKEN}`, `Bearer ${TOKEN}x`, 'Bearer']) {
      const res = await post('list_chats', {}, { authorization });
      expect(res.statusCode, authorization).toBe(401);
      expect(res.json()).toEqual({ ok: false, error: "Wayroost didn't accept the bridge token." });
    }
    const noAuth = await app.inject({
      method: 'POST',
      url: '/bridge/v1/list_chats',
      headers: { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(noAuth.statusCode).toBe(401);
    expect(seen).toEqual([]);

    const ok = await post('list_chats', {});
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, result: { hello: 'world' } });
    expect(ok.headers['cache-control']).toBe('no-store');

    expect(logs.filter((l) => l.msg === 'bridge request denied').map((l) => l.obj.reason)).toContain('wrong token');
    const all = JSON.stringify(logs);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(wrong);
  });

  it('refuses browsers (any Origin) and any Host but its own loopback address', async () => {
    const { post, seen } = await listener();
    for (const origin of ['https://evil.example', 'null', `http://127.0.0.1:${PORT}`]) {
      const res = await post('list_chats', {}, { origin });
      expect(res.statusCode, origin).toBe(403);
      expect(res.json().ok).toBe(false);
    }
    for (const host of ['evil.example', `evil.example:${PORT}`, '127.0.0.1:9999', `[::1]:${PORT}`, '127.0.0.1']) {
      expect((await post('list_chats', {}, { host })).statusCode, host).toBe(421);
    }
    expect(seen).toEqual([]);
    expect((await post('list_chats', {}, { host: `LOCALHOST:${PORT}` })).statusCode).toBe(200);
  });

  it('takes JSON up to 64 KB and answers { ok, result | error } with a matching status', async () => {
    const bridge = stubBridge((tool) => {
      if (tool === 'read_chat') throw new UserFacingError(NOT_IN_PROJECT, 403);
      if (tool === 'start_chat') throw new Error('kaboom with details');
      return { fine: true };
    });
    const { app, post, logs } = await listener(bridge);
    const big = await post('send_message', { chat: 'paseo:x', text: 'x'.repeat(BRIDGE_BODY_LIMIT) });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toEqual({ ok: false, error: 'Request too large (the limit is 64 KB).' });
    expect((await post('list_chats', 'hi', { 'content-type': 'text/plain' })).statusCode).toBe(415);
    expect((await post('list_chats', '{nope', {})).statusCode).toBe(400);

    const unknown = await post('respond_to_approval', {});
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ ok: false, error: 'Unknown tool.' });
    const get = await app.inject({ url: '/bridge/v1/list_chats', headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` } });
    expect(get.statusCode).toBe(404);

    const refusedRes = await post('read_chat', { chat: 'paseo:x' });
    expect(refusedRes.statusCode).toBe(403);
    expect(refusedRes.json()).toEqual({ ok: false, error: NOT_IN_PROJECT });
    const broken = await post('start_chat', {});
    expect(broken.statusCode).toBe(500);
    expect(broken.json()).toEqual({ ok: false, error: 'Something went wrong in Wayroost.' });
    expect(logs.some((l) => l.msg === 'bridge request failed')).toBe(true);
    expect(bridge.seen.map((s) => s.tool)).toEqual(['read_chat', 'start_chat']);
  });

  it("passes the caller's Paseo agent, Hermes session and folder through", async () => {
    const { post, seen } = await listener();
    await post('list_chats', { project: APP }, { 'x-bridge-paseo-agent': 'agent-1', 'x-bridge-cwd': APP });
    await post('list_chats', {}, { 'x-bridge-paseo-agent': '', 'x-bridge-cwd': encodeURIComponent(`${APP}/my dir`) });
    await post('list_chats', {}, { 'x-bridge-paseo-agent': '../../etc', 'x-bridge-cwd': Buffer.from('/home/me/café', 'utf8').toString('latin1') });
    await post('wait_for_reply', { chat: 'paseo:x' }, { 'x-bridge-hermes-session': '20260101_120000_abc123' });
    await post('list_chats', {}, { 'x-bridge-hermes-session': '../x' });
    expect(seen.map(({ tool, args, identity }) => ({ tool, args, identity }))).toEqual([
      { tool: 'list_chats', args: { project: APP }, identity: { paseoAgent: 'agent-1', cwd: APP } },
      { tool: 'list_chats', args: {}, identity: { cwd: `${APP}/my dir` } },
      { tool: 'list_chats', args: {}, identity: { cwd: '/home/me/café' } },
      { tool: 'wait_for_reply', args: { chat: 'paseo:x' }, identity: { hermesSession: '20260101_120000_abc123' } },
      { tool: 'list_chats', args: {}, identity: {} },
    ]);
  });

  it('holds wait_for_reply open over TCP until the answer, and drops it when the caller hangs up', async () => {
    const port = await freePort();
    const world = makeWorld();
    const bridge = new Bridge({ background: new BackgroundGate('primary'), sources: fakeSources(world), hub: new EventHub(), log: recordingLog().log, port, pollMs: 0 });
    const app = await buildBridgeServer({ background: new BackgroundGate('primary'), bridge, token: TOKEN, port, log: recordingLog().log });
    cleanups.push(() => app.close());
    await app.listen({ host: '127.0.0.1', port });
    const call = (tool: string, body: object, agent: string, signal?: AbortSignal) =>
      fetch(`http://127.0.0.1:${port}/bridge/v1/${tool}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'x-bridge-paseo-agent': agent, 'x-bridge-cwd': APP },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });

    const waiting = call('wait_for_reply', { chat: 'paseo:idle', timeout_seconds: 20 }, 'caller');
    await expect.poll(() => bridge.activeWaits).toBe(1);
    const reply = await call('send_message', { chat: 'paseo:caller', text: 'Docs updated.' }, 'idle');
    expect(await reply.json()).toEqual({ ok: true, result: { delivered: 'now', note: NOTES.handedOver } });
    expect(await (await waiting).json()).toEqual({ ok: true, result: { from: 'paseo:idle', kind: 'reply', text: 'Docs updated.' } });

    const hangUp = new AbortController();
    const abandoned = call('wait_for_reply', { chat: 'paseo:idle', timeout_seconds: 20 }, 'caller', hangUp.signal).catch(() => 'hung up');
    await expect.poll(() => bridge.activeWaits).toBe(1);
    hangUp.abort();
    expect(await abandoned).toBe('hung up');
    await expect.poll(() => bridge.activeWaits).toBe(0);
    const later = await call('send_message', { chat: 'paseo:caller', text: 'And the changelog.' }, 'idle');
    expect(((await later.json()) as { result: unknown }).result).toMatchObject({ delivered: 'now' });
    expect(world.sent.map((s) => s.chat)).toEqual(['paseo:caller']);
  });

  it("works over TCP with Node's fetch, end to end", async () => {
    const port = await freePort();
    const world = makeWorld();
    const bridge = new Bridge({ background: new BackgroundGate('primary'), sources: fakeSources(world), hub: new EventHub(), log: recordingLog().log, port, pollMs: 0 });
    const app = await buildBridgeServer({ background: new BackgroundGate('primary'), bridge, token: TOKEN, port, log: recordingLog().log });
    cleanups.push(() => app.close());
    await app.listen({ host: '127.0.0.1', port });

    const call = (tool: string, body: object, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}/bridge/v1/${tool}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'x-bridge-paseo-agent': 'caller',
          'x-bridge-cwd': APP,
          ...headers,
        },
        body: JSON.stringify(body),
      });
    const res = await call('send_message', { chat: 'paseo:idle', text: 'Over the wire' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, result: { delivered: 'now' } });
    expect(world.sent).toEqual([{ chat: 'paseo:idle', text: bridgeEnvelope(CALLER_LABEL, 'Over the wire', 'paseo:caller') }]);

    const outside = await call('read_chat', { chat: 'paseo:elsewhere' });
    expect(outside.status).toBe(403);
    expect(await outside.json()).toEqual({ ok: false, error: NOT_IN_PROJECT });
    expect((await call('list_chats', {}, { origin: 'https://evil.example' })).status).toBe(403);
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// ---- the app's kill switch route ------------------------------------------------------

describe('app: /api/bridge', () => {
  let keys: Keys;
  let accessToken: string;
  beforeAll(async () => {
    keys = await makeKeys();
    accessToken = await makeToken(keys);
  });

  async function app(withBridge: boolean) {
    const config = makeConfig();
    const hub = new EventHub();
    const bridge = new Bridge({ background: new BackgroundGate('primary'), sources: fakeSources(makeWorld()), hub, log: recordingLog().log, port: PORT, pollMs: 0 });
    const instance = await buildApp({
      config,
      verifier: createAccessVerifier({ ...config.access!, keySource: keys.keySource }),
      hub,
      sources: { hermes: new FakeHermes(), paseo: new FakePaseo() },
      logger: false,
      ...(withBridge ? { bridge } : {}),
    });
    cleanups.push(() => instance.close());
    const put = (body: unknown, headers = postHeaders(accessToken)) =>
      instance.inject({ method: 'PUT', url: '/api/bridge', headers, payload: JSON.stringify(body) });
    return { instance, bridge, put };
  }

  it('is behind Cloudflare Access and the API rules, and flips the kill switch', async () => {
    const { instance, bridge, put } = await app(true);
    const host = apiHeaders(accessToken).host!;
    expect((await instance.inject({ url: '/api/bridge', headers: { host, 'x-signalbox-request': '1' } })).statusCode).toBe(401);
    const get = await instance.inject({ url: '/api/bridge', headers: apiHeaders(accessToken) });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ enabled: true, paused: false, port: PORT, recent: { sent: 0, queued: 0, started: 0 } });

    const { origin: _origin, ...noOrigin } = postHeaders(accessToken);
    expect((await put({ paused: true }, noOrigin)).statusCode).toBe(403);
    expect((await put({ paused: true }, postHeaders(accessToken, { origin: 'https://evil.example' }))).statusCode).toBe(403);
    expect((await put({ paused: 'yes' })).statusCode).toBe(400);
    expect((await put({ paused: true, port: 1 })).statusCode).toBe(400);
    expect(bridge.status().paused).toBe(false);

    const paused = await put({ paused: true });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ enabled: true, paused: true });
    expect(bridge.status().paused).toBe(true);
    expect((await put({ paused: false })).json()).toMatchObject({ paused: false });
  });

  it('reports the bridge as off when the config leaves it off', async () => {
    const { instance, put } = await app(false);
    const get = await instance.inject({ url: '/api/bridge', headers: apiHeaders(accessToken) });
    expect(get.json()).toEqual({ enabled: false, paused: false, recent: { sent: 0, queued: 0, started: 0 } });
    const res = await put({ paused: true });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'The Wayroost bridge is turned off in the server config.' });
  });
});

// ---- config and token ---------------------------------------------------------------------

describe('bridge config and token', () => {
  const valid = {
    publicOrigin: 'https://wayroost.example.com',
    access: { teamDomain: 'https://myteam.cloudflareaccess.com', aud: 'abc123', allowedEmails: ['me@example.com'] },
    stateDir: '/var/lib/signalbox',
  };

  it('is off by default on port 19012, and validated strictly', () => {
    expect(parseConfig(valid).bridge).toEqual({ enabled: false, port: 19012 });
    expect(parseConfig({ ...valid, bridge: { enabled: true } }).bridge).toEqual({ enabled: true, port: 19012 });
    expect(parseConfig({ ...valid, bridge: { enabled: true, port: 9000 } }).bridge).toEqual({ enabled: true, port: 9000 });
    const bad = [
      { bridge: { enabled: true, port: 19010 } }, // the app's own port
      { listen: { host: '127.0.0.1', port: 9000 }, bridge: { enabled: true, port: 9000 } },
      { bridge: { enabled: true, port: 19011 } }, // cloudflared metrics
      { bridge: { enabled: 'yes' } },
      { bridge: { enabled: true, host: '0.0.0.0' } },
      { bridge: { port: 70000 } },
    ];
    for (const patch of bad) expect(() => parseConfig({ ...valid, ...patch }), JSON.stringify(patch)).toThrow(ConfigError);
  });

  it('creates a private random token once and keeps it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-bridge-'));
    const token = readOrCreateBridgeToken(dir, new BackgroundGate('primary'));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const file = join(dir, 'bridge-token');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe(token);
    expect(readOrCreateBridgeToken(dir, new BackgroundGate('primary'))).toBe(token);

    chmodSync(file, 0o644);
    expect(readOrCreateBridgeToken(dir, new BackgroundGate('primary'))).toBe(token);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    writeFileSync(file, 'short');
    expect(() => readOrCreateBridgeToken(dir, new BackgroundGate('primary'))).toThrow(/usable bridge token/);
  });
});

describe('messages from Signalbox itself (the task log)', () => {
  function system(key: string, target: { source: Source; id: string }, extra: Partial<SystemMessage> = {}) {
    const outcome = { delivered: [] as number[], dropped: [] as string[] };
    const message: SystemMessage = {
      key,
      target,
      sender: 'Signalbox task log',
      text: `[Worker update] ${key}`,
      delivered: (at) => outcome.delivered.push(at),
      dropped: (reason) => outcome.dropped.push(reason),
      ...extra,
    };
    return { message, outcome };
  }

  it('removes an acknowledged system entry after an equal-time update sorts ahead of it', async () => {
    const { bridge, sources, world, advance } = setup();
    const high = system('task:demo-z:finished#1', { source: 'hermes', id: 'h-app' });
    const low = system('task:demo-a:finished#1', { source: 'hermes', id: 'h-app' });
    let release!: () => void;
    let started!: () => void;
    const acknowledgement = new Promise<void>((resolve) => { release = resolve; });
    const submission = new Promise<void>((resolve) => { started = resolve; });
    const send = sources.hermes.sendMessage.bind(sources.hermes);
    sources.hermes.sendMessage = async (id, text) => {
      await send(id, text);
      if (world.sent.length === 1) { started(); await acknowledgement; }
    };
    try {
      bridge.deliverSystem(high.message);
      const delivery = bridge.tick();
      await submission;
      bridge.deliverSystem(low.message);
      release();
      await delivery;
      for (let i = 0; i < 3; i++) { advance(11_000); await bridge.tick(); }
      expect(world.sent.map((m) => m.text)).toEqual([
        bridgeEnvelope(high.message.sender, high.message.text), bridgeEnvelope(low.message.sender, low.message.text),
      ]);
      expect(high.outcome).toEqual({ delivered: [T0], dropped: [] });
      expect(low.outcome).toEqual({ delivered: [T0 + 11_000], dropped: [] });
    } finally { release(); bridge.stop(); }
  });

  it('preserves a replacement with the same system key when the earlier send is acknowledged', async () => {
    const { bridge, sources, world, advance } = setup();
    const original = system('task:demo:finished#1', { source: 'hermes', id: 'h-app' }, { text: '[Worker update] Demo original' });
    const replacement = system(original.message.key, original.message.target, { text: '[Worker update] Demo replacement' });
    let release!: () => void;
    let started!: () => void;
    const acknowledgement = new Promise<void>((resolve) => { release = resolve; });
    const submission = new Promise<void>((resolve) => { started = resolve; });
    const send = sources.hermes.sendMessage.bind(sources.hermes);
    sources.hermes.sendMessage = async (id, text) => {
      await send(id, text);
      if (world.sent.length === 1) { started(); await acknowledgement; }
    };
    try {
      bridge.deliverSystem(original.message);
      const delivery = bridge.tick();
      await submission;
      expect(bridge.withdrawSystem(original.message.key)).toBe(true);
      bridge.deliverSystem(replacement.message);
      release();
      await delivery;
      expect(replacement.outcome).toEqual({ delivered: [], dropped: [] });
      advance(11_000);
      await bridge.tick();
      expect(world.sent.map((m) => m.text)).toEqual([
        bridgeEnvelope(original.message.sender, original.message.text), bridgeEnvelope(replacement.message.sender, replacement.message.text),
      ]);
      expect(original.outcome).toEqual({ delivered: [T0], dropped: ['withdrawn'] });
      expect(replacement.outcome).toEqual({ delivered: [T0 + 11_000], dropped: [] });
    } finally { release(); bridge.stop(); }
  });

  it.each([502, 504])('charges repeated permanent %s failures instead of holding forever', async (status) => {
    const { bridge, world } = setup();
    const { message, outcome } = system('task:demo:finished#1', { source: 'hermes', id: 'h-app' });
    bridge.deliverSystem(message);
    world.sendError = new UserFacingError('Demo permanent RPC failure', status);
    for (let i = 0; i < 20; i++) await bridge.tick();
    expect(outcome).toEqual({ delivered: [], dropped: ['failed'] });
    bridge.stop();
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'])('preserves a queued update during a connection-level %s failure', async (code) => {
    const { bridge, world } = setup();
    const { message, outcome } = system('task:demo:finished#1', { source: 'hermes', id: 'h-app' });
    bridge.deliverSystem(message);
    world.sendError = Object.assign(new Error('Demo connection unavailable'), { code });
    for (let i = 0; i < 20; i++) await bridge.tick();
    expect(outcome).toEqual({ delivered: [], dropped: [] });
    world.sendError = null;
    await bridge.tick();
    expect(outcome).toEqual({ delivered: [T0], dropped: [] });
    bridge.stop();
  });

  it('holds unknown readiness without spending permanent attempts or sending to an older chat', async () => {
    const world = makeWorld();
    const sources = fakeSources(world);
    sources.hermes.listConversations = async () => [];
    sources.hermes.resolveChat = () => 'demo-current';
    const bridge = new Bridge({ sources, hub: new EventHub(), log: recordingLog().log, now: () => T0, pollMs: 0 });
    const { message, outcome } = system('task:demo:finished#1', { source: 'hermes', id: 'h-app' });
    bridge.deliverSystem(message);
    for (let i = 0; i < 20; i++) await bridge.tick();
    expect(world.sent).toEqual([]);
    expect(outcome).toEqual({ delivered: [], dropped: [] });
    bridge.stop();
  });

  it.each([503])('keeps a system update through repeated transient %s errors', async (status) => {
    const { bridge, world } = setup();
    const { message, outcome } = system('task:demo:finished#1', { source: 'hermes', id: 'h-app' });
    bridge.deliverSystem(message);
    world.sendError = new UserFacingError('Demo connection is temporarily unavailable', status);
    for (let i = 0; i < 20; i++) await bridge.tick();
    expect(outcome).toEqual({ delivered: [], dropped: [] });
    world.sendError = null;
    await bridge.tick();
    expect(outcome).toEqual({ delivered: [T0], dropped: [] });
    expect(world.sent).toHaveLength(1);
  });

  it('holds a system update if the source disconnects during evidence lookup', async () => {
    const world = makeWorld();
    const sources = fakeSources(world);
    let connected = true;
    sources.hermes.status = () => ({ source: 'hermes', state: connected ? 'connected' : 'disconnected' });
    const bridge = new Bridge({ sources, hub: new EventHub(), log: recordingLog().log, now: () => T0, pollMs: 0 });
    const { message, outcome } = system('task:demo:finished#1', { source: 'hermes', id: 'h-app' }, {
      stillWanted: async () => { connected = false; return true; },
    });
    bridge.deliverSystem(message);
    await bridge.tick();
    expect(world.sent).toEqual([]);
    expect(outcome).toEqual({ delivered: [], dropped: [] });
    connected = true;
    message.stillWanted = async () => true;
    await bridge.tick();
    expect(outcome.delivered).toEqual([T0]);
  });

  it('waits for the chat to be idle and settled, then delivers once, signed by Signalbox', async () => {
    const { bridge, world, set } = setup();
    set('h-app', { status: 'running' });
    const { message, outcome } = system('task:w1:finished#1', { source: 'hermes', id: 'h-app' });
    expect(bridge.deliverSystem(message)).toBe('queued');
    expect(bridge.deliverSystem(message)).toBe('already queued');
    await bridge.tick();
    expect(world.sent).toEqual([]);
    set('h-app', { status: 'idle' });
    await bridge.tick();
    expect(world.sent).toEqual([{ chat: 'hermes:h-app', text: bridgeEnvelope('Signalbox task log', '[Worker update] task:w1:finished#1') }]);
    expect(parseBridgeEnvelope(world.sent[0]!.text)).toEqual({ sender: 'Signalbox task log', text: '[Worker update] task:w1:finished#1' });
    expect(outcome).toEqual({ delivered: [T0], dropped: [] });
    await bridge.tick();
    expect(world.sent).toHaveLength(1);
    // Not agents' activity: Settings' counts leave it out.
    expect(bridge.status().recent).toEqual({ sent: 0, queued: 0, started: 0 });
  });

  it("never holds back an agent's message or uses up its queue limit", async () => {
    const { bridge, world, caller, set } = setup();
    set('idle', { status: 'running' });
    for (let i = 1; i <= 6; i++) bridge.deliverSystem(system(`task:w${i}:finished#1`, { source: 'paseo', id: 'idle' }).message);
    // Five agents' messages may still wait, as before.
    for (let i = 0; i < 4; i++) await caller.call('send_message', { chat: 'paseo:idle', text: `queued ${i}` });
    set('idle', { status: 'idle' });
    // Idle again: an agent's message goes out now, not behind Signalbox's.
    const fresh = setup();
    fresh.bridge.deliverSystem(system('task:x:finished#1', { source: 'paseo', id: 'idle' }).message);
    expect(await fresh.caller.call('send_message', { chat: 'paseo:idle', text: 'now' })).toMatchObject({ delivered: 'now' });
    expect(world.sent).toEqual([]);
  });

  it('keeps at most ten of its own messages waiting for one chat', async () => {
    const { bridge, set } = setup();
    set('h-app', { status: 'running' });
    for (let i = 1; i <= 10; i++) expect(bridge.deliverSystem(system(`task:w${i}:finished#1`, { source: 'hermes', id: 'h-app' }).message)).toBe('queued');
    expect(bridge.deliverSystem(system('task:w11:finished#1', { source: 'hermes', id: 'h-app' }).message)).toBe('full');
  });

  it('holds while paused and goes out once resumed', async () => {
    const { bridge, world } = setup();
    bridge.setPaused(true);
    const { message, outcome } = system('task:w1:finished#1', { source: 'hermes', id: 'h-app' });
    bridge.deliverSystem(message);
    await bridge.tick();
    expect(world.sent).toEqual([]);
    bridge.setPaused(false);
    await bridge.tick();
    expect(world.sent).toHaveLength(1);
    expect(outcome.delivered).toHaveLength(1);
  });

  it.each([
    { status: 'running' as const, pendingApprovals: 0 },
    { status: 'needs_approval' as const, pendingApprovals: 1 },
    { status: 'idle' as const, pendingApprovals: 1 },
  ])('rechecks readiness after evidence lookup: %j', async (state) => {
    const { bridge, world, set } = setup();
    const { message, outcome } = system('task:demo:finished#1', { source: 'hermes', id: 'h-app' }, {
      stillWanted: async () => {
        set('h-app', state);
        return true;
      },
    });
    bridge.deliverSystem(message);
    await bridge.tick();
    expect(world.sent).toEqual([]);
    expect(outcome).toEqual({ delivered: [], dropped: [] });
    message.stillWanted = async () => true;
    set('h-app', { status: 'idle', pendingApprovals: 0 });
    await bridge.tick();
    expect(outcome.delivered).toEqual([T0]);
  });

  it('rechecks the delivery reservation after another message goes out during evidence lookup', async () => {
    const { bridge, world, caller, advance } = setup();
    const { message, outcome } = system('task:demo:finished#1', { source: 'paseo', id: 'idle' }, {
      stillWanted: async () => {
        await caller.call('send_message', { chat: 'paseo:idle', text: 'Check the docs' });
        return true;
      },
    });
    bridge.deliverSystem(message);
    await bridge.tick();
    expect(world.sent).toHaveLength(1);
    expect(outcome.delivered).toEqual([]);
    message.stillWanted = async () => true;
    advance(11_000);
    await bridge.tick();
    expect(outcome.delivered).toEqual([T0 + 11_000]);
  });

  it('checks the continuation delivery reservation when a system message is retargeted', async () => {
    const { bridge, world, caller, advance } = setup();
    let target: SystemMessage['target'] = { source: 'hermes', id: 'h-app' };
    const { message, outcome } = system('task:demo:compressed#1', target, {
      resolveTarget: async () => target,
      stillWanted: async () => {
        target = { source: 'paseo', id: 'idle' };
        await caller.call('send_message', { chat: 'paseo:idle', text: 'Demo activity' });
        return true;
      },
    });
    bridge.deliverSystem(message);
    await bridge.tick();
    message.stillWanted = async () => true;
    await bridge.tick();
    expect(world.sent).toHaveLength(1);
    expect(outcome.delivered).toEqual([]);
    advance(11_000);
    await bridge.tick();
    expect(world.sent).toHaveLength(2);
    expect(outcome.delivered).toEqual([T0 + 11_000]);
  });

  it.each([1, 2])('follows reported compression during readiness lookup %s without a target resolver', async (lookup) => {
    const world = makeWorld();
    const sources = fakeSources(world);
    const old = world.chats.find((c) => c.id === 'h-app')!;
    const continuation = chat('hermes', 'demo-continuation', APP, {
      aliases: [{ source: 'hermes', id: old.id }], status: 'needs_approval', pendingApprovals: 1,
    });
    let current = old.id;
    sources.hermes.resolveChat = () => current;
    sources.hermes.summaryOf = () => world.chats.find((c) => c.id === current);
    let listings = 0;
    world.onList = () => {
      if (++listings === lookup) { current = continuation.id; world.chats.splice(world.chats.indexOf(old), 1, continuation); }
    };
    const bridge = new Bridge({ sources, hub: new EventHub(), log: recordingLog().log, now: () => T0, pollMs: 0 });
    const { message, outcome } = system('task:demo:compressed#1', old, { stillWanted: async () => true });
    bridge.deliverSystem(message);
    await bridge.tick();
    expect(message.target).toEqual({ source: 'hermes', id: continuation.id });
    await bridge.tick();
    expect(world.sent).toEqual([]);
    expect(outcome).toEqual({ delivered: [], dropped: [] });
    continuation.status = 'idle';
    continuation.pendingApprovals = 0;
    await bridge.tick();
    await bridge.tick();
    expect(world.sent.map((m) => m.chat)).toEqual(['hermes:demo-continuation']);
    expect(outcome).toEqual({ delivered: [T0], dropped: [] });
    bridge.stop();
  });

  it('checks destination settling after compression during the final readiness lookup', async () => {
    const { bridge, world, sources, caller, advance } = setup();
    const old = world.chats.find((c) => c.id === 'h-app')!;
    sources.hermes.summaryOf = () => old;
    const continuation = chat('hermes', 'demo-continuation', APP);
    world.chats.push(continuation);
    await caller.call('send_message', { chat: 'hermes:demo-continuation', text: 'Demo activity' });
    let target: SystemMessage['target'] = { source: 'hermes', id: 'h-app' };
    let listings = 0;
    world.onList = () => {
      if (++listings !== 2) return;
      continuation.aliases = [target];
      world.chats.splice(world.chats.findIndex((c) => c.id === target.id), 1);
      target = { source: 'hermes', id: continuation.id };
    };
    const { message, outcome } = system('task:demo:compressed#1', target, {
      resolveTarget: async () => target, stillWanted: async () => true,
    });
    bridge.deliverSystem(message);
    await bridge.tick();
    await bridge.tick();
    expect(world.sent).toHaveLength(1);
    expect(outcome).toEqual({ delivered: [], dropped: [] });
    advance(11_000);
    await bridge.tick();
    expect(world.sent.map((m) => m.chat)).toEqual(['hermes:demo-continuation', 'hermes:demo-continuation']);
    expect(outcome).toEqual({ delivered: [T0 + 11_000], dropped: [] });
  });

  it('records the delivery time after a slow evidence lookup and send', async () => {
    const { bridge, advance } = setup();
    const { message, outcome } = system('task:demo:finished#1', { source: 'hermes', id: 'h-app' }, {
      stillWanted: async () => {
        advance(MIN);
        return true;
      },
    });
    bridge.deliverSystem(message);
    await bridge.tick();
    expect(outcome.delivered).toEqual([T0 + 2 * MIN]);
  });

  it('does not acknowledge a launch when its provenance could not be saved', async () => {
    const { bridge, from, world } = setup();
    bridge.watch({ started: () => { throw new Error('Task ledger write failed'); } });
    await expect(from({ hermesSession: 'h-app' }).call('start_chat', {
      backend: 'paseo', agent: 'claude', text: 'Profile the build',
    })).rejects.toThrow('Task ledger write failed');
    expect(world.created).toHaveLength(1);
  });

  it('is never handed to a wait_for_reply, and rate limits and the loop breaker leave it alone', async () => {
    const { bridge, world, from, set, advance } = setup();
    // The caller is busy in its wait; the update for it waits too.
    set('caller', { status: 'running' });
    const { message, outcome } = system('task:w1:finished#1', { source: 'paseo', id: 'caller' });
    bridge.deliverSystem(message);
    const wait = from({ paseoAgent: 'caller', cwd: APP }).call('wait_for_reply', { chat: 'paseo:idle', timeout_seconds: 120 });
    await vi.waitFor(() => expect(bridge.activeWaits).toBe(1));
    await bridge.tick();
    expect(bridge.activeWaits).toBe(1); // still waiting: the update wasn't taken as an answer
    bridge.setPaused(true); // ends the wait
    await refused(wait, 503, PAUSED_MESSAGE);
    bridge.setPaused(false);
    set('caller', { status: 'idle' });
    await bridge.tick();
    expect(world.sent.map((s) => s.chat)).toEqual(['paseo:caller']);
    expect(outcome.delivered).toHaveLength(1);
    // Many more for the same chat: agents' per-target limit (6 / 10 min) doesn't count them.
    for (let i = 2; i <= 8; i++) bridge.deliverSystem(system(`task:w${i}:finished#1`, { source: 'paseo', id: 'idle' }).message);
    for (let i = 2; i <= 8; i++) {
      await bridge.tick();
      advance(11_000); // one at a time: each settles before the next
    }
    expect(world.sent.filter((s) => s.chat === 'paseo:idle')).toHaveLength(7);
  });

  it('reaches an older chat the recent list leaves out, through summaryOf', async () => {
    const world = makeWorld();
    const sources = fakeSources(world);
    sources.hermes.summaryOf = (id) => (id === 'h-old' ? chat('hermes', 'h-old', APP) : undefined);
    const bridge = new Bridge({ sources, hub: new EventHub(), log: recordingLog().log, now: () => T0, pollMs: 0 });
    const { message, outcome } = system('task:w1:finished#1', { source: 'hermes', id: 'h-old' });
    bridge.deliverSystem(message);
    await bridge.tick();
    expect(world.sent.map((s) => s.chat)).toEqual(['hermes:h-old']);
    expect(outcome.delivered).toEqual([T0]);
  });

  it('reports permanent drops and keeps system news beyond the ordinary queue expiry', async () => {
    const { bridge, world, advance, set } = setup();
    const withdrawn = system('task:a:needs-approval#1', { source: 'hermes', id: 'h-app' });
    set('h-app', { status: 'running' });
    bridge.deliverSystem(withdrawn.message);
    expect(bridge.withdrawSystem('task:a:needs-approval#1')).toBe(true);
    expect(bridge.withdrawSystem('task:a:needs-approval#1')).toBe(false);
    expect(withdrawn.outcome.dropped).toEqual(['withdrawn']);

    const unwanted = system('task:b:finished#1', { source: 'paseo', id: 'idle' }, { stillWanted: async () => false });
    bridge.deliverSystem(unwanted.message);
    await bridge.tick();
    expect(unwanted.outcome).toEqual({ delivered: [], dropped: ['unwanted'] });

    const gone = system('task:c:finished#1', { source: 'paseo', id: 'idle' });
    world.sendError = new UserFacingError('That chat no longer exists.', 404);
    bridge.deliverSystem(gone.message);
    advance(11_000);
    await bridge.tick();
    expect(gone.outcome.dropped).toEqual(['gone']);
    world.sendError = null;

    const late = system('task:d:finished#1', { source: 'hermes', id: 'h-app' });
    bridge.deliverSystem(late.message);
    advance(HOUR + 1);
    await bridge.tick();
    expect(late.outcome.dropped).toEqual([]);
    set('h-app', { status: 'idle' });
    await bridge.tick();
    expect(late.outcome.delivered).toEqual([T0 + 11_000 + HOUR + 1]);
    expect(world.sent).toHaveLength(1);
  });

  it('tells its watchers what a chat started and which waits came back', async () => {
    const { bridge, from, set } = setup();
    const started: Array<{ agent: string; by: string }> = [];
    const waited: Array<{ caller: string; target: string; kind: string }> = [];
    bridge.watch({
      started: (agent, by) => started.push({ agent: `${agent.source}:${agent.id}`, by: `${by.source}:${by.id}` }),
      waited: (caller, target, kind) => waited.push({ caller, target, kind }),
    });
    const hermes = from({ hermesSession: 'h-app' });
    await hermes.call('start_chat', { backend: 'paseo', agent: 'claude', text: 'Profile the build' });
    expect(started).toEqual([{ agent: 'paseo:new-1', by: 'hermes:h-app' }]);

    const wait = hermes.call('wait_for_reply', { chat: 'paseo:new-1', timeout_seconds: 120 });
    await vi.waitFor(() => expect(bridge.activeWaits).toBe(1));
    await bridge.tick();
    set('new-1', { status: 'idle', updatedAt: T0 + MIN });
    await bridge.tick();
    expect(((await wait) as { kind: string }).kind).toBe('finished');
    expect(waited).toEqual([{ caller: 'hermes:h-app', target: 'paseo:new-1', kind: 'finished' }]);
  });
});
