import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundGate } from '../src/background.js';
import type { ServerEvent } from '../../shared/protocol.js';
import { Bridge } from '../src/bridge/service.js';
import { HermesAdapter } from '../src/hermes/adapter.js';
import { HermesAuthError } from '../src/hermes/auth.js';
import { RpcError, type HermesGateway } from '../src/hermes/gateway.js';
import { ChatIdentity } from '../src/hermes/identity.js';
import type { HermesSessionRow } from '../src/hermes/normalize.js';
import { EventHub } from '../src/hub.js';
import { SecretStore } from '../src/secrets.js';
import { hermesChats } from '../src/tasks/wire.js';
import { FakePaseo } from './helpers.js';

const OLD = 'demo-old-chat';
const CURRENT = 'demo-current-chat';
const log = { info() {}, warn() {}, error() {} };

function setup(prepareState?: (state: string) => void) {
  const state = mkdtempSync(join(tmpdir(), 'sb-hub-readiness-'));
  prepareState?.(state);
  const hub = new EventHub();
  const events: ServerEvent[] = [];
  hub.observe((event) => events.push(event));
  const warnings: Array<{ err: string; message: string }> = [];
  const recordingLog = { ...log, warn: (data: { err: string }, message: string) => warnings.push({ ...data, message }) };
  const hermes = new HermesAdapter('http://127.0.0.1:8897', hub, new SecretStore(state), recordingLog, { background: new BackgroundGate('primary'), stateDir: state });
  const gateway = Reflect.get(hermes, 'gateway') as HermesGateway;
  gateway.state = 'ready';
  Reflect.set(hermes, 'statusValue', { source: 'hermes', state: 'connected' });
  const current: HermesSessionRow = { id: CURRENT, title: 'Demo continuation', _lineage_ids: [OLD, CURRENT] };
  let listed: HermesSessionRow[] = [current];
  let unavailable = false;
  let proof = current;
  let detail: HermesSessionRow | undefined;
  Reflect.set(Reflect.get(hermes, 'auth'), 'json', async (path: string) => {
    if (path.startsWith('/api/sessions?')) return { sessions: listed };
    if (path === `/api/sessions/${CURRENT}`) {
      if (unavailable) throw new HermesAuthError('Demo lookup unavailable', 'unavailable', 503);
      return detail ?? proof;
    }
    if (path === `/api/sessions/${OLD}`) return { id: OLD };
    return {};
  });
  const calls: Array<{ method: string; id: unknown }> = [];
  let snapshot: { session_id: string; running?: boolean; status?: string; info?: Record<string, unknown>;
    open_requests?: Array<{ id: string; method: string; params: Record<string, unknown> }> } = { session_id: 'demo-runtime', running: true, status: 'waiting',
    open_requests: [{ id: 'demo-approval', method: 'approval', params: { command: 'echo demo' } }] };
  Reflect.set(gateway, 'call', async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, id: params.session_id });
    return method === 'session.resume' ? snapshot : {};
  });
  const delivered: number[] = [];
  const dropped: string[] = [];
  const bridge = new Bridge({ background: new BackgroundGate('primary'), sources: { hermes, paseo: new FakePaseo() }, hub, log, now: () => 1000, pollMs: 0 });
  const queue = (id = OLD) => bridge.deliverSystem({ key: 'task:demo:finished#1', target: { source: 'hermes', id },
    sender: 'Demo task log', text: '[Worker update] Demo finished.', stillWanted: async () => true,
    delivered: (at) => delivered.push(at), dropped: (reason) => dropped.push(reason) });
  return { hermes, gateway, bridge, calls, delivered, dropped, queue, state, events, hub, warnings,
    omit: () => { listed = []; }, unavailable: () => { unavailable = true; },
    list: (rows: HermesSessionRow[]) => { listed = rows; },
    detail: (row: HermesSessionRow) => { detail = row; },
    contradict: () => { proof = { ...current, _lineage_ids: [CURRENT] }; },
    snapshot: (change: typeof snapshot) => { snapshot = change; },
    idle: () => { snapshot = { ...snapshot, running: false, status: 'idle', open_requests: [] }; },
    close: () => { bridge.stop(); hermes.stop(); } };
}

describe('hub delivery identity and live readiness', () => {
  it.each((['invalid file', 'unreadable directory', 'uncertain lineage'] as const).flatMap((fault) =>
    (['ready', 'interval', 'settle'] as const).map((source) => ({ fault, source }))))(
    'contains $source activity errors and holds delivery with $fault', async ({ fault, source }) => {
      vi.useFakeTimers();
      const t = setup((state) => {
        const path = join(state, 'hermes-chat-moves.json');
        if (fault === 'unreadable directory') mkdirSync(path);
        else writeFileSync(path, fault === 'invalid file' ? '{' : JSON.stringify({ moves: [], uncertain: [CURRENT] }));
      });
      try {
        (Reflect.get(t.hermes, 'bind') as (id: string, runtime: string) => void).call(t.hermes, CURRENT, 'demo-runtime');
        t.gateway.emit('event', { type: 'message.start', session_id: 'demo-runtime', payload: {} });
        t.gateway.emit('request', { id: 'demo-held-approval', method: 'approval', generation: t.gateway.generation,
          params: { session_id: 'demo-runtime', command: 'echo demo' } });
        const poll = vi.spyOn(t.gateway, 'call').mockResolvedValue({
          sessions: [{ id: 'demo-runtime', session_key: CURRENT, status: 'idle' }],
        });
        if (source === 'ready') t.gateway.emit('ready', { epoch: 'demo-epoch' });
        else if (source === 'interval') {
          vi.spyOn(Reflect.get(t.hermes, 'auth'), 'hasCredentials').mockReturnValue(true);
          vi.spyOn(t.gateway, 'start').mockImplementation(() => {});
          vi.spyOn(t.hub, 'size', 'get').mockReturnValue(1);
          t.hermes.start();
        } else (Reflect.get(t.hermes, 'scheduleActiveCheck') as () => void).call(t.hermes);
        await vi.advanceTimersByTimeAsync(source === 'interval' ? 5000 : source === 'settle' ? 300 : 0);
        expect(poll).toHaveBeenCalledExactlyOnceWith('session.active_list', {}, 15_000, undefined);
        expect(t.warnings).toEqual([{ err: expect.stringMatching(/identity/), message: "couldn't confirm Hermes activity identity" }]);
        expect((Reflect.get(t.hermes, 'activeByStored') as Map<string, string>).get(CURRENT)).toBe('working');
        expect((Reflect.get(t.hermes, 'turns') as Map<string, unknown>).has(CURRENT)).toBe(true);
        expect(t.hermes.listApprovals().map((approval) => approval.id)).toEqual(['demo-held-approval']);
        expect(() => t.hermes.resolveChat(CURRENT)).toThrow(/identity/);
        t.queue(CURRENT);
        await t.bridge.tick();
        expect(poll.mock.calls.some(([method]) => method === 'prompt.submit')).toBe(false);
        expect(t.delivered).toEqual([]);
        expect(t.dropped).toEqual([]);
        if (fault === 'invalid file') expect(readFileSync(join(t.state, 'hermes-chat-moves.json'), 'utf8')).toBe('{');
        expect(() => new ChatIdentity(t.state).resolve(CURRENT)).toThrow(/identity/);
      } finally { t.close(); vi.restoreAllMocks(); vi.useRealTimers(); }
    },
  );

  it.each(['write', 'rename'] as const)('contains compression %s errors until the move is durable', async (operation) => {
    const t = setup();
    try {
      t.omit();
      await t.hermes.deliverySummary(OLD);
      t.gateway.emit('event', { type: 'message.start', session_id: 'demo-runtime', payload: {} });
      t.events.length = 0;
      const path = join(t.state, 'hermes-chat-moves.json');
      const blocked = operation === 'write' ? `${path}.tmp` : path;
      mkdirSync(blocked);
      const compression = { type: 'session.info', session_id: 'demo-runtime',
        payload: { running: false, stored_session_id: CURRENT } };
      expect(() => t.gateway.emit('event', compression)).not.toThrow();
      expect(t.warnings).toEqual([{ err: expect.any(String), message: "couldn't persist Hermes chat continuation" }]);
      expect(t.events).toEqual([]);
      expect((Reflect.get(t.hermes, 'runtimeByStored') as Map<string, string>).get(OLD)).toBe('demo-runtime');
      expect(t.hermes.listApprovals().map((approval) => approval.conversationId)).toEqual([OLD]);
      for (const id of [OLD, CURRENT]) expect(() => t.hermes.resolveChat(id)).toThrow('saved or loaded');
      Reflect.set(t.gateway, 'call', async (method: string, params: Record<string, unknown>) => {
        t.calls.push({ method, id: params.session_id });
        return method === 'session.active_list' ? { sessions: [{ id: 'demo-runtime', session_key: OLD, status: 'idle' }] } : {};
      });
      await expect((Reflect.get(t.hermes, 'refreshActive') as () => Promise<unknown>).call(t.hermes)).resolves.toBeUndefined();
      expect(t.warnings.at(-1)).toMatchObject({ message: "couldn't confirm Hermes activity identity" });
      t.queue(OLD);
      await t.bridge.tick();
      expect(t.calls.some((call) => call.method === 'prompt.submit')).toBe(false);
      expect(t.delivered).toEqual([]);
      expect(t.dropped).toEqual([]);
      rmSync(blocked, { recursive: true });
      expect(() => t.gateway.emit('event', compression)).not.toThrow();
      const reloaded = new ChatIdentity(t.state);
      expect(reloaded.resolve(OLD)).toBe(CURRENT);
      expect(reloaded.root(CURRENT)).toBe(OLD);
      expect(t.events.filter((event) => event.type === 'conversation_moved')).toEqual([
        { type: 'conversation_moved', source: 'hermes', from: OLD, to: CURRENT },
      ]);
      t.gateway.emit('event', { type: 'request.cancel', session_id: 'demo-runtime', payload: { id: 'demo-approval' } });
      for (let i = 0; i < 3; i++) await t.bridge.tick();
      expect(t.calls.filter((call) => call.method === 'prompt.submit')).toHaveLength(1);
      expect(t.delivered).toEqual([1000]);
      expect(t.dropped).toEqual([]);
    } finally { t.close(); }
  });

  it.each(['pending', 'acknowledged'] as const)('holds worker updates when an older idle poll finishes after an ordinary submission is %s', async (acknowledgement) => {
    const t = setup();
    try {
      t.omit(); t.idle();
      await t.hermes.deliverySummary(CURRENT);
      let releasePoll!: (result: unknown) => void;
      const stale = new Promise((resolve) => { releasePoll = resolve; });
      let releaseSubmit!: (result: unknown) => void;
      const submitting = new Promise((resolve) => { releaseSubmit = resolve; });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const prompts: unknown[] = [];
      Reflect.set(t.gateway, 'call', async (method: string, params: Record<string, unknown>) => {
        if (method === 'session.active_list') return stale;
        if (method === 'prompt.submit') {
          prompts.push(params.text);
          if (prompts.length === 1) { entered(); return submitting; }
        }
        return {};
      });
      const poll = (Reflect.get(t.hermes, 'refreshActive') as () => Promise<unknown>).call(t.hermes);
      const send = t.hermes.sendMessage(CURRENT, 'Demo ordinary prompt');
      await started;
      if (acknowledgement === 'acknowledged') { releaseSubmit({}); await send; }
      expect(t.hermes.summaryOf(CURRENT)).toMatchObject({ status: 'running' });
      releasePoll({ sessions: [{ id: 'demo-runtime', session_key: CURRENT, status: 'idle' }] });
      await poll;
      t.queue(CURRENT);
      await t.bridge.tick();
      expect(prompts).toEqual(['Demo ordinary prompt']);
      expect(t.delivered).toEqual([]);
      releaseSubmit({});
      await send;
      expect(t.hermes.summaryOf(CURRENT)).toMatchObject({ status: 'running' });
      await t.bridge.tick();
      expect(t.delivered).toEqual([]);
      t.gateway.emit('event', { type: 'session.info', session_id: 'demo-runtime', payload: { running: false } });
      await t.bridge.tick();
      expect(prompts).toHaveLength(2);
      expect(t.delivered).toEqual([1000]);
    } finally { t.close(); }
  });

  it.each(['idle', 'working', 'omitted'] as const)('applies only the newest issued activity poll when older reading is %s', async (older) => {
    const t = setup();
    try {
      t.omit(); t.idle();
      await t.hermes.deliverySummary(CURRENT);
      const releases: Array<(result: unknown) => void> = [];
      Reflect.set(t.gateway, 'call', async () => new Promise<unknown>((resolve) => { releases.push(resolve); }));
      const refresh = () => (Reflect.get(t.hermes, 'refreshActive') as () => Promise<unknown>).call(t.hermes);
      const first = refresh();
      const second = refresh();
      const newest = older === 'working' ? 'idle' : 'working';
      releases[1]!({ sessions: [{ id: 'demo-runtime', session_key: CURRENT, status: newest }] });
      await second;
      releases[0]!({ sessions: older === 'omitted' ? [] : [{ id: 'demo-runtime', session_key: CURRENT, status: older }] });
      await first;
      expect(t.hermes.summaryOf(CURRENT)).toMatchObject({ status: newest === 'idle' ? 'idle' : 'running' });
    } finally { t.close(); }
  });

  it.each(['message.start', 'message.delta', 'tool.start', 'session.info', 'request'] as const)(
    'keeps newer %s activity and cards when a pending poll reports idle or omits the chat', async (source) => {
      for (const omitted of [false, true]) {
        const t = setup();
        try {
          t.omit(); t.idle();
          await t.hermes.deliverySummary(CURRENT);
          t.gateway.emit('event', { type: 'message.start', session_id: 'demo-runtime', payload: {} });
          t.gateway.emit('request', { id: 'demo-new-approval', method: 'approval', generation: t.gateway.generation,
            params: { session_id: 'demo-runtime', command: 'echo demo' } });
          let release!: (result: unknown) => void;
          Reflect.set(t.gateway, 'call', async () => new Promise<unknown>((resolve) => { release = resolve; }));
          const poll = (Reflect.get(t.hermes, 'refreshActive') as () => Promise<unknown>).call(t.hermes);
          if (source === 'request') t.gateway.emit('request', { id: 'demo-new-approval', method: 'approval', generation: t.gateway.generation,
            params: { session_id: 'demo-runtime', command: 'echo demo' } });
          else t.gateway.emit('event', { type: source, session_id: 'demo-runtime',
            payload: source === 'session.info' ? { running: true } : { text: 'Demo activity', tool_id: 'demo-tool' } });
          release({ sessions: omitted ? [] : [{ id: 'demo-runtime', session_key: CURRENT, status: 'idle' }] });
          await poll;
          expect(t.hermes.summaryOf(CURRENT)).toMatchObject({ status: 'needs_approval', pendingApprovals: 1 });
          expect((Reflect.get(t.hermes, 'turns') as Map<string, unknown>).has(CURRENT)).toBe(true);
        } finally { t.close(); }
      }
    },
  );

  it('keeps a newer idle event when an older poll reports working', async () => {
    const t = setup();
    try {
      t.omit(); t.idle();
      await t.hermes.deliverySummary(CURRENT);
      let release!: (result: unknown) => void;
      Reflect.set(t.gateway, 'call', async () => new Promise<unknown>((resolve) => { release = resolve; }));
      const poll = (Reflect.get(t.hermes, 'refreshActive') as () => Promise<unknown>).call(t.hermes);
      t.gateway.emit('event', { type: 'session.info', session_id: 'demo-runtime', payload: { running: false } });
      release({ sessions: [{ id: 'demo-runtime', session_key: CURRENT, status: 'working' }] });
      await poll;
      expect(t.hermes.summaryOf(CURRENT)).toMatchObject({ status: 'idle' });
    } finally { t.close(); }
  });

  it('does not restore working when a completion event precedes the submission acknowledgement', async () => {
    const t = setup();
    try {
      t.omit(); t.idle();
      await t.hermes.deliverySummary(CURRENT);
      Reflect.set(t.gateway, 'call', async (method: string) => {
        if (method === 'prompt.submit') t.gateway.emit('event', { type: 'message.complete', session_id: 'demo-runtime',
          payload: { text: 'Demo complete', status: 'completed' } });
        return {};
      });
      await t.hermes.sendMessage(CURRENT, 'Demo ordinary prompt');
      expect(t.hermes.summaryOf(CURRENT)).toMatchObject({ status: 'idle' });
    } finally { t.close(); }
  });

  it('applies a poll to other chats while holding the chat with newer activity', async () => {
    const t = setup();
    try {
      t.omit(); t.idle();
      await t.hermes.deliverySummary(CURRENT);
      const other = 'demo-other-chat';
      (Reflect.get(t.hermes, 'bind') as (stored: string, runtime: string) => void).call(t.hermes, other, 'demo-other-runtime');
      (Reflect.get(t.hermes, 'activeByStored') as Map<string, string>).set(other, 'working');
      let release!: (result: unknown) => void;
      Reflect.set(t.gateway, 'call', async () => new Promise<unknown>((resolve) => { release = resolve; }));
      const poll = (Reflect.get(t.hermes, 'refreshActive') as () => Promise<unknown>).call(t.hermes);
      t.gateway.emit('event', { type: 'message.start', session_id: 'demo-runtime', payload: {} });
      release({ sessions: [
        { id: 'demo-runtime', session_key: CURRENT, status: 'idle' },
        { id: 'demo-other-runtime', session_key: other, status: 'idle' },
      ] });
      await poll;
      expect(t.hermes.summaryOf(CURRENT)).toMatchObject({ status: 'running' });
      expect(t.hermes.summaryOf(other)).toMatchObject({ status: 'idle' });
    } finally { t.close(); }
  });

  it.each(['demo-new-runtime', 'demo-runtime'])('holds a replacement runtime after an old activity poll: %s', async (replacement) => {
    const t = setup();
    try {
      t.omit(); t.idle();
      await t.hermes.deliverySummary(CURRENT);
      let release!: (result: unknown) => void;
      const stale = new Promise((resolve) => { release = resolve; });
      const submits: unknown[] = [];
      let polls = 0;
      Reflect.set(t.gateway, 'call', async (method: string, params: Record<string, unknown>) => {
        if (method === 'session.active_list') return ++polls === 1 ? stale
          : { sessions: [{ id: replacement, session_key: CURRENT, status: 'demo-unknown-state' }] };
        if (method === 'session.resume') return { session_id: replacement };
        if (method === 'prompt.submit') {
          submits.push(params.session_id);
          if (submits.length === 1) throw new RpcError(4001, 'Demo stale runtime');
        }
        return {};
      });
      const poll = (Reflect.get(t.hermes, 'refreshActive') as () => Promise<unknown>).call(t.hermes);
      t.queue(CURRENT);
      await t.bridge.tick();
      expect(submits).toEqual(['demo-runtime']);
      expect(t.hermes.summaryOf(CURRENT)).toBeUndefined();
      release({ sessions: [{ id: 'demo-runtime', session_key: CURRENT, status: 'idle' }] });
      await poll;
      expect(t.hermes.summaryOf(CURRENT)).toBeUndefined();
      for (let i = 0; i < 8; i++) await t.bridge.tick();
      expect(submits).toEqual(['demo-runtime']);
      expect(t.hermes.summaryOf(CURRENT)).toBeUndefined();
      expect(t.delivered).toEqual([]);
      expect(t.dropped).toEqual([]);
      t.gateway.emit('event', { type: 'session.info', session_id: replacement, payload: { running: false } });
      await t.bridge.tick();
      expect(submits).toEqual(['demo-runtime', replacement]);
      expect(t.delivered).toEqual([1000]);
    } finally { t.close(); }
  });

  it.each([
    { id: 'demo-retired-runtime', status: 'idle' },
    { status: 'idle' },
    { id: 'demo-runtime' },
  ])('holds activity readiness without matching runtime and explicit idle state: %j', async (session) => {
    const t = setup();
    try {
      t.omit(); t.snapshot({ session_id: 'demo-runtime' });
      await t.hermes.deliverySummary(CURRENT);
      (Reflect.get(t.hermes, 'activeByStored') as Map<string, string>).set(CURRENT, 'demo-unknown-state');
      Reflect.set(t.gateway, 'call', async (method: string, params: Record<string, unknown>) => {
        t.calls.push({ method, id: params.session_id });
        return method === 'session.active_list'
          ? { sessions: [{ ...session, session_key: CURRENT }] } : {};
      });
      t.queue(CURRENT);
      for (let i = 0; i < 8; i++) await t.bridge.tick();
      expect(t.calls.some((call) => call.method === 'prompt.submit')).toBe(false);
      expect(t.hermes.summaryOf(CURRENT)).toBeUndefined();
      expect(t.delivered).toEqual([]);
      expect(t.dropped).toEqual([]);
      t.gateway.emit('event', { type: 'session.info', session_id: 'demo-runtime', payload: { running: false } });
      await t.bridge.tick();
      expect(t.delivered).toEqual([1000]);
    } finally { t.close(); }
  });

  it.each([true, false])('keeps current approvals and a live turn after reattachment even if an old poll lists the chat: %s', async (listed) => {
    const t = setup();
    try {
      t.omit();
      await t.hermes.deliverySummary(CURRENT);
      t.gateway.emit('event', { type: 'message.start', session_id: 'demo-runtime', payload: {} });
      let release!: (result: unknown) => void;
      const stale = new Promise((resolve) => { release = resolve; });
      Reflect.set(t.gateway, 'call', async (method: string) => method === 'session.active_list' ? stale
        : { session_id: 'demo-new-runtime', running: true, status: 'waiting',
            open_requests: [{ id: 'demo-approval', method: 'approval', params: { command: 'echo demo' } }] });
      const poll = (Reflect.get(t.hermes, 'refreshActive') as () => Promise<unknown>).call(t.hermes);
      t.gateway.emit('event', { type: 'session.reclaimed', session_id: 'demo-runtime', payload: {} });
      await (Reflect.get(t.hermes, 'ensureAttached') as (id: string) => Promise<string>).call(t.hermes, CURRENT);
      t.events.length = 0;
      release({ sessions: listed ? [{ id: 'demo-runtime', session_key: CURRENT, status: 'idle' }] : [] });
      await poll;
      expect(t.hermes.listApprovals().map((approval) => approval.id)).toEqual(['demo-approval']);
      expect((Reflect.get(t.hermes, 'turns') as Map<string, unknown>).has(CURRENT)).toBe(true);
      expect(t.hermes.summaryOf(CURRENT)).toMatchObject({ status: 'needs_approval', pendingApprovals: 1 });
      expect(t.events).toEqual([]);
    } finally { t.close(); }
  });

  it('discards an activity response from a previous gateway connection', async () => {
    const t = setup();
    try {
      t.omit(); t.snapshot({ session_id: 'demo-runtime' });
      await t.hermes.deliverySummary(CURRENT);
      let release!: (result: unknown) => void;
      const stale = new Promise((resolve) => { release = resolve; });
      Reflect.set(t.gateway, 'call', async () => stale);
      const poll = (Reflect.get(t.hermes, 'refreshActive') as () => Promise<unknown>).call(t.hermes);
      t.gateway.generation++;
      release({ sessions: [{ id: 'demo-runtime', session_key: CURRENT, status: 'idle' }] });
      await poll;
      expect(t.hermes.summaryOf(CURRENT)).toBeUndefined();
    } finally { t.close(); }
  });

  it('holds activity readiness while an attachment snapshot is still pending', async () => {
    const t = setup();
    try {
      t.omit();
      let release!: (result: unknown) => void;
      const snapshot = new Promise((resolve) => { release = resolve; });
      Reflect.set(t.gateway, 'call', async (method: string) => method === 'session.resume' ? snapshot
        : { sessions: [{ id: 'demo-retired-runtime', session_key: CURRENT, status: 'idle' }] });
      const attachment = (Reflect.get(t.hermes, 'ensureAttached') as (id: string) => Promise<string>).call(t.hermes, CURRENT);
      await (Reflect.get(t.hermes, 'refreshActive') as () => Promise<unknown>).call(t.hermes);
      expect(t.hermes.summaryOf(CURRENT)).toBeUndefined();
      release({ session_id: 'demo-runtime' });
      await attachment;
      expect(t.hermes.summaryOf(CURRENT)).toBeUndefined();
    } finally { t.close(); }
  });

  it('accepts fresh activity readiness for the current runtime', async () => {
    const t = setup();
    try {
      t.omit(); t.snapshot({ session_id: 'demo-runtime' });
      await t.hermes.deliverySummary(CURRENT);
      Reflect.set(t.gateway, 'call', async (method: string, params: Record<string, unknown>) => {
        t.calls.push({ method, id: params.session_id });
        return method === 'session.active_list'
          ? { sessions: [{ id: 'demo-runtime', session_key: CURRENT, status: 'idle' }] } : {};
      });
      t.queue(CURRENT);
      await t.bridge.tick();
      expect(t.calls.filter((call) => call.method === 'prompt.submit')).toEqual([{ method: 'prompt.submit', id: 'demo-runtime' }]);
      expect(t.delivered).toEqual([1000]);
    } finally { t.close(); }
  });

  it('publishes an ordinary send under the continuation revealed during attachment', async () => {
    const t = setup();
    try {
      t.omit();
      t.snapshot({ session_id: 'demo-runtime', running: false, status: 'idle', info: { stored_session_id: CURRENT } });
      await t.hermes.sendMessage(OLD, 'Demo ordinary prompt');
      expect(new ChatIdentity(t.state).resolve(OLD)).toBe(CURRENT);
      expect(t.events.filter((event) => event.type === 'items_upsert')).toEqual([
        { type: 'items_upsert', source: 'hermes', conversationId: CURRENT,
          items: [expect.objectContaining({ kind: 'user', text: 'Demo ordinary prompt' })] },
      ]);
      expect(t.hermes.summaryOf(CURRENT)).toMatchObject({ status: 'running' });
      expect((Reflect.get(t.hermes, 'activeByStored') as Map<string, string>).has(OLD)).toBe(false);
      t.queue(CURRENT);
      for (let i = 0; i < 8; i++) await t.bridge.tick();
      expect(t.calls.filter((call) => call.method === 'prompt.submit')).toHaveLength(1);
      expect(t.delivered).toEqual([]);
    } finally { t.close(); }
  });

  it.each([4001, 4007])('retries an ordinary send under the current chat through a compression chain: RPC %s', async (code) => {
    const t = setup();
    try {
      t.omit();
      const final = 'demo-final-chat';
      Reflect.set(t.gateway, 'call', async (method: string, params: Record<string, unknown>) => {
        t.calls.push({ method, id: params.session_id });
        if (method === 'session.resume') return { session_id: params.session_id === OLD ? 'demo-runtime' : 'demo-new-runtime',
          running: false, status: 'idle', info: { stored_session_id: params.session_id === OLD ? CURRENT : final } };
        if (method === 'prompt.submit' && params.session_id === 'demo-runtime') throw new RpcError(code, 'Demo stale runtime');
        return { user_row_id: 123 };
      });
      await t.hermes.sendMessage(OLD, 'Demo ordinary prompt');
      expect(t.calls.filter((call) => call.method === 'session.resume')).toEqual([
        { method: 'session.resume', id: OLD }, { method: 'session.resume', id: CURRENT },
      ]);
      expect(t.calls.filter((call) => call.method === 'prompt.submit')).toEqual([
        { method: 'prompt.submit', id: 'demo-runtime' }, { method: 'prompt.submit', id: 'demo-new-runtime' },
      ]);
      expect(new ChatIdentity(t.state).resolve(OLD)).toBe(final);
      expect(t.events.filter((event) => event.type === 'items_upsert')).toEqual([
        { type: 'items_upsert', source: 'hermes', conversationId: final,
          items: [expect.objectContaining({ kind: 'user', id: 'm123', text: 'Demo ordinary prompt' })] },
      ]);
      expect(t.hermes.summaryOf(final)).toMatchObject({ status: 'running' });
      const active = Reflect.get(t.hermes, 'activeByStored') as Map<string, string>;
      expect(active.has(OLD)).toBe(false);
      expect(active.has(CURRENT)).toBe(false);
    } finally { t.close(); }
  });

  it('follows a compression arriving while an ordinary prompt is being submitted', async () => {
    const t = setup();
    try {
      t.omit(); t.idle();
      Reflect.set(t.gateway, 'call', async (method: string) => {
        if (method === 'session.resume') return { session_id: 'demo-runtime', running: false, status: 'idle' };
        if (method === 'prompt.submit') {
          t.gateway.emit('event', { type: 'session.info', session_id: 'demo-runtime',
            payload: { running: true, stored_session_id: CURRENT } });
          return { user_row_id: 123 };
        }
        return {};
      });
      await t.hermes.sendMessage(OLD, 'Demo ordinary prompt');
      expect(t.events.filter((event) => event.type === 'items_upsert')).toEqual([
        { type: 'items_upsert', source: 'hermes', conversationId: CURRENT,
          items: [expect.objectContaining({ kind: 'user', id: 'm123', text: 'Demo ordinary prompt' })] },
      ]);
      expect((Reflect.get(t.hermes, 'activeByStored') as Map<string, string>).has(OLD)).toBe(false);
    } finally { t.close(); }
  });

  it('classifies an omitted delegate before attachment and holds its update', async () => {
    const t = setup();
    try {
      t.omit(); t.idle();
      t.detail({ id: CURRENT, parent_session_id: 'demo-manager', model_config: { _delegate_from: 'demo-manager' } });
      t.queue(CURRENT);
      for (let i = 0; i < 8; i++) await t.bridge.tick();
      expect(t.calls).toEqual([]);
      expect(t.delivered).toEqual([]);
      expect(t.dropped).toEqual([]);
      await expect(t.hermes.sendMessage(CURRENT, 'Demo prompt')).rejects.toMatchObject({ status: 400 });
    } finally { t.close(); }
  });

  it('holds omitted recipients when their classification lookup is unavailable', async () => {
    const t = setup();
    try {
      t.omit(); t.idle(); t.unavailable(); t.queue(CURRENT);
      for (let i = 0; i < 8; i++) await t.bridge.tick();
      expect(t.calls).toEqual([]);
      expect(t.delivered).toEqual([]);
      expect(t.dropped).toEqual([]);
    } finally { t.close(); }
  });

  it('retargets an ordinary message through confirmed compression before checking readiness', async () => {
    const t = setup();
    try {
      t.list([{ id: OLD, cwd: '/home/me/code/app' }]);
      (Reflect.get(t.hermes, 'activeByStored') as Map<string, string>).set(OLD, 'working');
      await expect(t.bridge.call('send_message', { chat: `hermes:${OLD}`, text: 'Demo queued message' },
        { cwd: '/home/me/code/app' })).resolves.toMatchObject({ delivered: 'queued' });
      t.hermes.chatIdentity.record(OLD, CURRENT);
      t.list([{ id: CURRENT, cwd: '/home/me/code/app', _lineage_ids: [OLD, CURRENT] }]);
      Reflect.set(t.hermes, 'listCache', undefined);
      t.idle();
      for (let i = 0; i < 8; i++) await t.bridge.tick();
      expect(t.calls.filter((call) => call.method === 'prompt.submit'))
        .toEqual([{ method: 'prompt.submit', id: 'demo-runtime' }]);
      expect(t.calls).not.toContainEqual({ method: 'session.resume', id: OLD });
    } finally { t.close(); }
  });

  it('retargets an ordinary message when its attachment reports compression', async () => {
    const t = setup();
    try {
      t.list([{ id: OLD, cwd: '/home/me/code/app' }]);
      const active = Reflect.get(t.hermes, 'activeByStored') as Map<string, string>;
      active.set(OLD, 'working');
      await t.bridge.call('send_message', { chat: `hermes:${OLD}`, text: 'Demo queued message' }, { cwd: '/home/me/code/app' });
      active.set(OLD, 'idle');
      t.omit();
      Reflect.set(t.hermes, 'listCache', undefined);
      t.snapshot({ session_id: 'demo-runtime', running: false, status: 'idle', info: { stored_session_id: CURRENT } });
      for (let i = 0; i < 8; i++) await t.bridge.tick();
      expect(new ChatIdentity(t.state).resolve(OLD)).toBe(CURRENT);
      expect(t.calls.filter((call) => call.method === 'prompt.submit'))
        .toEqual([{ method: 'prompt.submit', id: 'demo-runtime' }]);
    } finally { t.close(); }
  });

  it('recovers a missed compression from authoritative lineage and persists it before delivery', async () => {
    const t = setup();
    try {
      expect(await hermesChats(t.hermes).find(OLD)).toMatchObject({ id: CURRENT });
      expect(new ChatIdentity(t.state).resolve(OLD)).toBe(CURRENT);
      t.queue();
      for (let i = 0; i < 5; i++) await t.bridge.tick();
      expect(t.calls).not.toContainEqual({ method: 'session.resume', id: OLD });
      expect(t.calls.some((call) => call.method === 'prompt.submit')).toBe(false);
      expect(t.delivered).toEqual([]);
      expect(t.dropped).toEqual([]);
    } finally { t.close(); }
  });

  it.each(['ordinary prompt', 'worker update'] as const)('reconciles a resume shortcut before delivery: %s', async (message) => {
    const t = setup();
    const middle = 'demo-middle-chat';
    try {
      t.hermes.chatIdentity.record(OLD, CURRENT);
      t.detail({ id: CURRENT, _lineage_ids: [OLD, middle, CURRENT] });
      t.list([{ id: CURRENT, _lineage_ids: [OLD, middle, CURRENT] }]);
      expect(await hermesChats(t.hermes).find(middle)).toMatchObject({ id: CURRENT });
      for (const id of [OLD, middle, CURRENT]) {
        expect(new ChatIdentity(t.state).resolve(id)).toBe(CURRENT);
        expect(new ChatIdentity(t.state).root(id)).toBe(OLD);
      }
      t.idle();
      if (message === 'ordinary prompt') await t.hermes.sendMessage(OLD, 'Demo ordinary prompt');
      else { t.queue(); for (let i = 0; i < 5; i++) await t.bridge.tick(); }
      expect(t.calls.filter((call) => call.method === 'prompt.submit'))
        .toEqual([{ method: 'prompt.submit', id: 'demo-runtime' }]);
      expect(t.calls).not.toContainEqual({ method: 'session.resume', id: OLD });
      expect(t.calls).not.toContainEqual({ method: 'session.resume', id: middle });
      expect(t.dropped).toEqual([]);
      if (message === 'worker update') {
        expect(t.delivered).toEqual([1000]);
        await t.bridge.tick();
        expect(t.delivered).toEqual([1000]);
      }
    } finally { t.close(); }
  });

  it.each(['unavailable', 'contradictory'] as const)('holds contradictory listing evidence when move proof is %s', async (kind) => {
    const t = setup();
    try {
      if (kind === 'unavailable') t.unavailable(); else t.contradict();
      t.queue();
      for (let i = 0; i < 8; i++) await t.bridge.tick();
      expect(t.calls).toEqual([]);
      expect(t.delivered).toEqual([]);
      expect(t.dropped).toEqual([]);
      expect(new ChatIdentity(t.state).resolve(OLD)).toBe(OLD);
    } finally { t.close(); }
  });

  it('holds an omitted chat whose attachment reveals running work and an approval', async () => {
    const t = setup();
    try {
      t.omit();
      const before = t.hermes.summaryOf(CURRENT);
      t.queue(CURRENT);
      for (let i = 0; i < 8; i++) await t.bridge.tick();
      expect(t.calls).toContainEqual({ method: 'session.resume', id: CURRENT });
      expect(t.hermes.summaryOf(CURRENT)).toMatchObject({ status: 'needs_approval', pendingApprovals: 1 });
      expect(t.calls.some((call) => call.method === 'prompt.submit')).toBe(false);
      expect(before).toBeUndefined();
      expect(t.delivered).toEqual([]);
      expect(t.dropped).toEqual([]);
      t.gateway.emit('event', { type: 'request.cancel', session_id: 'demo-runtime', payload: { id: 'demo-approval' } });
      t.gateway.emit('event', { type: 'session.info', session_id: 'demo-runtime', payload: { running: false } });
      await t.bridge.tick();
      expect(t.delivered).toEqual([1000]);
    } finally { t.close(); }
  });

  it.each([{}, { status: 'demo-unknown-state' }])('holds unknown attachment readiness without consuming retries: %j', async (state) => {
    const t = setup();
    try {
      t.omit();
      t.snapshot({ session_id: 'demo-runtime', ...state });
      t.queue(CURRENT);
      for (let i = 0; i < 8; i++) await t.bridge.tick();
      expect(t.calls.some((call) => call.method === 'prompt.submit')).toBe(false);
      expect(t.hermes.summaryOf(CURRENT)).toBeUndefined();
      expect(t.dropped).toEqual([]);
      t.gateway.emit('event', { type: 'session.info', session_id: 'demo-runtime', payload: { running: false } });
      await t.bridge.tick();
      expect(t.delivered).toEqual([1000]);
    } finally { t.close(); }
  });

  it('rechecks an approval arriving after final readiness and before submitting', async () => {
    const t = setup();
    try {
      t.omit(); t.idle(); t.queue(CURRENT);
      Reflect.set(t.hermes, 'requireNotSubagent', async () => {
        t.gateway.emit('request', { id: 'demo-late-approval', method: 'approval',
          params: { session_id: 'demo-runtime', command: 'echo demo' }, generation: 0 });
      });
      await t.bridge.tick();
      expect(t.calls.some((call) => call.method === 'prompt.submit')).toBe(false);
      expect(t.delivered).toEqual([]);
      expect(t.dropped).toEqual([]);
      Reflect.set(t.hermes, 'requireNotSubagent', async () => {});
      t.gateway.emit('event', { type: 'request.cancel', session_id: 'demo-runtime', payload: { id: 'demo-late-approval' } });
      await t.bridge.tick();
      expect(t.delivered).toEqual([1000]);
    } finally { t.close(); }
  });

  it('checks a new attachment snapshot again after a stale-runtime retry', async () => {
    const t = setup();
    try {
      t.omit(); t.queue(CURRENT);
      let resumes = 0;
      let submits = 0;
      Reflect.set(t.gateway, 'call', async (method: string) => {
        if (method === 'session.resume') {
          resumes++;
          return resumes === 1 ? { session_id: 'demo-runtime', running: false, status: 'idle' }
            : { session_id: 'demo-new-runtime', running: true, status: 'waiting',
                open_requests: [{ id: 'demo-retry-approval', method: 'approval', params: { command: 'echo demo' } }] };
        }
        if (method === 'prompt.submit') { submits++; throw new RpcError(4001, 'Demo stale runtime'); }
        return {};
      });
      for (let i = 0; i < 8; i++) await t.bridge.tick();
      expect(resumes).toBe(2);
      expect(submits).toBe(1);
      expect(t.hermes.summaryOf(CURRENT)).toMatchObject({ status: 'needs_approval', pendingApprovals: 1 });
      expect(t.delivered).toEqual([]);
      expect(t.dropped).toEqual([]);
    } finally { t.close(); }
  });

  it.each([4001, 4007])('holds a stale-runtime retry with no fresh readiness: RPC %s', async (code) => {
    const t = setup();
    try {
      t.omit(); t.queue(CURRENT);
      let resumes = 0;
      const submits: unknown[] = [];
      Reflect.set(t.gateway, 'call', async (method: string, params: Record<string, unknown>) => {
        if (method === 'session.resume') return ++resumes === 1
          ? { session_id: 'demo-runtime', running: false, status: 'idle' }
          : { session_id: 'demo-new-runtime' };
        if (method === 'prompt.submit') {
          submits.push(params.session_id);
          if (params.session_id === 'demo-runtime') throw new RpcError(code, 'Demo stale runtime');
        }
        return {};
      });
      for (let i = 0; i < 8; i++) await t.bridge.tick();
      expect(resumes).toBe(2);
      expect(submits).toEqual(['demo-runtime']);
      expect(t.hermes.summaryOf(CURRENT)).toBeUndefined();
      expect(t.delivered).toEqual([]);
      expect(t.dropped).toEqual([]);
      t.gateway.emit('event', { type: 'session.info', session_id: 'demo-runtime', payload: { running: false } });
      await t.bridge.tick();
      expect(submits).toEqual(['demo-runtime']);
      t.gateway.emit('event', { type: 'session.info', session_id: 'demo-new-runtime', payload: { running: false } });
      await t.bridge.tick();
      expect(submits).toEqual(['demo-runtime', 'demo-new-runtime']);
      expect(t.delivered).toEqual([1000]);
    } finally { t.close(); }
  });

  it('discards cached idle readiness when a fresh attachment has no state', async () => {
    const t = setup();
    try {
      t.omit();
      (Reflect.get(t.hermes, 'activeByStored') as Map<string, string>).set(CURRENT, 'idle');
      t.snapshot({ session_id: 'demo-runtime' });
      t.queue(CURRENT);
      for (let i = 0; i < 8; i++) await t.bridge.tick();
      expect(t.calls.some((call) => call.method === 'prompt.submit')).toBe(false);
      expect(t.delivered).toEqual([]);
      expect(t.dropped).toEqual([]);
      t.gateway.emit('event', { type: 'session.info', session_id: 'demo-runtime', payload: { running: false } });
      await t.bridge.tick();
      expect(t.delivered).toEqual([1000]);
    } finally { t.close(); }
  });

  it('retargets and persists a compression revealed by the attachment before submitting', async () => {
    const t = setup();
    try {
      t.omit();
      t.snapshot({ session_id: 'demo-runtime', running: true, status: 'waiting',
        info: { stored_session_id: CURRENT },
        open_requests: [{ id: 'demo-approval', method: 'approval', params: { command: 'echo demo' } }] });
      t.queue(OLD);
      for (let i = 0; i < 8; i++) await t.bridge.tick();
      expect(new ChatIdentity(t.state).resolve(OLD)).toBe(CURRENT);
      expect(t.calls.some((call) => call.method === 'prompt.submit')).toBe(false);
      expect(t.delivered).toEqual([]);
      t.gateway.emit('event', { type: 'request.cancel', session_id: 'demo-runtime', payload: { id: 'demo-approval' } });
      t.gateway.emit('event', { type: 'session.info', session_id: 'demo-runtime', payload: { running: false } });
      await t.bridge.tick();
      expect(t.delivered).toEqual([1000]);
    } finally { t.close(); }
  });
});
