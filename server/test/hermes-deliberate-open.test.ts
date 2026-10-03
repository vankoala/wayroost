import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { BackgroundGate } from '../src/background.js';
import { HermesAdapter } from '../src/hermes/adapter.js';
import type { HermesGateway } from '../src/hermes/gateway.js';
import { EventHub } from '../src/hub.js';
import { SecretStore } from '../src/secrets.js';

it.each(['live', 'omitted', 'disconnected'] as const)('a deliberate shadow open joins a superseding %s poll', async latest => {
  const root = mkdtempSync(join(tmpdir(), 'wayroost-open-test-'));
  const adapter = new HermesAdapter('http://127.0.0.1:8897', new EventHub(), new SecretStore(root),
    { info() {}, warn() {}, error() {} }, { background: new BackgroundGate('shadow') });
  const gateway = Reflect.get(adapter, 'gateway') as HermesGateway;
  gateway.state = 'ready';
  const auth = Reflect.get(adapter, 'auth');
  vi.spyOn(auth, 'hasCredentials').mockReturnValue(true);
  vi.spyOn(auth, 'json').mockImplementation(async () => ({ id: 'demo-open-chat', messages: [] }));
  const polls: Array<(result: unknown) => void> = [];
  const call = vi.fn(async (method: string) => {
    if (method === 'session.active_list') return new Promise(resolve => { polls.push(resolve); });
    return method === 'session.resume' ? { session_id: 'demo-open-runtime', status: 'idle', open_requests: [] } : {};
  });
  Reflect.set(gateway, 'call', call);
  const refresh = () => (Reflect.get(adapter, 'refreshActive') as () => Promise<unknown>).call(adapter);
  const live = { sessions: [{ id: 'demo-open-runtime', session_key: 'demo-open-chat', status: 'waiting' }] };
  try {
    const open = adapter.getConversation('demo-open-chat', true);
    expect(polls).toHaveLength(1);
    const background = refresh();
    expect(polls).toHaveLength(2);
    // The open's live result is invalidated while the newest poll is pending.
    polls[0]!(live);
    await Promise.resolve();
    if (latest === 'disconnected') gateway.state = 'closed';
    polls[1]!(latest === 'omitted' ? { sessions: [] } : live);
    await background;
    expect(await open).toMatchObject({ needsOpen: latest !== 'live' });
    expect(call.mock.calls.filter(([method]) => method === 'session.resume')).toHaveLength(latest === 'live' ? 1 : 0);
    // Neither a subscription nor a background poll may inherit the open intent.
    if (latest === 'live') gateway.emit('event', { type: 'session.reclaimed', session_id: 'demo-open-runtime', payload: {} });
    gateway.state = 'ready';
    adapter.setWatching('demo-open-chat', true);
    const unattended = refresh();
    polls.at(-1)!(live);
    await unattended;
    expect(call.mock.calls.filter(([method]) => method === 'session.resume')).toHaveLength(latest === 'live' ? 1 : 0);
  } finally { adapter.stop(); rmSync(root, { recursive: true, force: true }); }
});

it.each(['pending-live', 'finished-live', 'settled-read', 'omitted', 'disconnected', 'failed-attachment', 'failed-read'] as const)(
  'a deliberate shadow open retries membership after an unrelated attachment: %s', async latest => {
    const root = mkdtempSync(join(tmpdir(), 'wayroost-open-test-'));
    const hub = new EventHub();
    const adapter = new HermesAdapter('http://127.0.0.1:8897', hub, new SecretStore(root),
      { info() {}, warn() {}, error() {} }, { background: new BackgroundGate('shadow') });
    const gateway = Reflect.get(adapter, 'gateway') as HermesGateway;
    gateway.state = 'ready';
    const auth = Reflect.get(adapter, 'auth');
    vi.spyOn(auth, 'hasCredentials').mockReturnValue(true);
    vi.spyOn(auth, 'json').mockImplementation(async () => ({ id: 'demo-open-chat', messages: [] }));
    const polls: Array<{ resolve: (result: unknown) => void; reject: (error: Error) => void }> = [];
    let resumeOther!: (result: unknown) => void;
    let failOther!: (error: Error) => void;
    const call = vi.fn(async (method: string, params?: { session_id?: string }) => {
      if (method === 'session.active_list') return new Promise((resolve, reject) => { polls.push({ resolve, reject }); });
      if (method === 'session.resume' && params?.session_id === 'demo-other-chat') {
        return new Promise((resolve, reject) => { resumeOther = resolve; failOther = reject; });
      }
      return method === 'session.resume' ? { session_id: 'demo-open-runtime', status: 'idle', open_requests: [] } : {};
    });
    Reflect.set(gateway, 'call', call);
    const live = { sessions: [{ id: 'demo-open-runtime', session_key: 'demo-open-chat', status: 'waiting' }] };
    try {
      const open = adapter.getConversation('demo-open-chat', true);
      expect(polls).toHaveLength(1);
      const attachOther = () => (Reflect.get(adapter, 'ensureAttached') as (id: string) => Promise<string>).call(adapter, 'demo-other-chat');
      let other: Promise<string> | undefined;
      if (latest === 'settled-read') {
        // A live result can become stale just as its status is published.
        hub.observe(event => {
          if (!other && event.type === 'conversation_upsert' && event.conversation.id === 'demo-open-chat') other = attachOther();
        });
        polls[0]!.resolve(live);
        await expect.poll(() => other !== undefined).toBe(true);
      } else other = attachOther();
      const otherResult = other!.catch(() => undefined);
      await expect.poll(() => call.mock.calls.some(([method, params]) => method === 'session.resume' && params?.session_id === 'demo-other-chat')).toBe(true);
      if (latest === 'finished-live') {
        resumeOther({ session_id: 'demo-other-runtime', status: 'idle', open_requests: [] });
        await otherResult;
      }
      polls[0]!.resolve(live);
      await Promise.resolve();
      if (latest !== 'finished-live') {
        if (latest === 'disconnected') gateway.state = 'closed';
        if (latest === 'failed-attachment') failOther(new Error('demo attachment failure'));
        else resumeOther({ session_id: 'demo-other-runtime', status: 'idle', open_requests: [] });
        await otherResult;
      }
      if (latest !== 'disconnected') {
        await expect.poll(() => polls.length).toBe(2);
        if (latest === 'failed-read') polls[1]!.reject(new Error('demo activity read failure'));
        else polls[1]!.resolve(latest === 'omitted' ? { sessions: [] } : live);
      }
      const attached = ['pending-live', 'finished-live', 'settled-read', 'failed-attachment'].includes(latest);
      expect(await open).toMatchObject({ needsOpen: !attached });
      expect(call.mock.calls.filter(([method, params]) => method === 'session.resume' && params?.session_id === 'demo-open-chat')).toHaveLength(attached ? 1 : 0);
      // Opening a chat never enables later unattended shadow attachments.
      if (attached) gateway.emit('event', { type: 'session.reclaimed', session_id: 'demo-open-runtime', payload: {} });
      gateway.state = 'ready';
      adapter.setWatching('demo-open-chat', true);
      const refresh = (Reflect.get(adapter, 'refreshActive') as () => Promise<unknown>).call(adapter);
      polls.at(-1)!.resolve(live);
      await refresh;
      expect(call.mock.calls.filter(([method, params]) => method === 'session.resume' && params?.session_id === 'demo-open-chat')).toHaveLength(attached ? 1 : 0);
    } finally { adapter.stop(); rmSync(root, { recursive: true, force: true }); }
  },
);
