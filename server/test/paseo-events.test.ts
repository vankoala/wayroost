import { DaemonClient, type ConnectionState } from '@getpaseo/client/internal/daemon-client';
import type { SessionOutboundMessage } from '@getpaseo/protocol/messages';
import { describe, expect, it, vi } from 'vitest';
import { EventHub } from '../src/hub.js';
import { PaseoAdapter } from '../src/paseo/adapter.js';
import { BackgroundGate } from '../src/background.js';

const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

/** Keep the real SDK ownership lifecycle; replace only its transport RPCs. */
function eventDaemon() {
  const client = new DaemonClient({ url: 'ws://127.0.0.1:8892', clientId: 'fake-events', logger: quietLog });
  const internals = client as unknown as {
    owned: { restore(): void; disconnected(): void; receive(message: SessionOutboundMessage): void };
    updateConnectionState(state: ConnectionState): void;
    sendCorrelatedRequest(options: {
      message: { type: string; events?: string[] };
      selectPayload(payload: object): unknown;
    }): Promise<unknown>;
    sendCorrelatedSessionRequest(): Promise<unknown>;
  };
  let attempt = 0;
  let sequence = 0;
  let fail = false;
  let pending: (() => void) | undefined;
  let hold = false;
  const observations: Array<ReturnType<DaemonClient['observeEvents']>> = [];
  const observeEvents = client.observeEvents.bind(client);
  vi.spyOn(client, 'observeEvents').mockImplementation((events, options) => {
    const subscription = observeEvents(events, options);
    if (events.includes('agent_permission_resolved')) observations.push(subscription);
    return subscription;
  });
  vi.spyOn(internals, 'sendCorrelatedRequest').mockImplementation(async ({ message, selectPayload }) => {
    if (message.events?.includes('agent_permission_resolved')) {
      attempt += 1;
      if (hold) await new Promise<void>((resolve) => { pending = resolve; });
      if (fail) return selectPayload({ error: 'fake event subscription refused', requestId: 'fake-request' });
    }
    return selectPayload({ subscriptionId: `fake-events-${++sequence}`, requestId: 'fake-request',
      ...(message.type === 'fetch_agents_request' ? agents : {}),
    });
  });
  vi.spyOn(internals, 'sendCorrelatedSessionRequest').mockResolvedValue({});
  const agents = { entries: [{ agent: {
    id: 'fake-agent', provider: 'claude', cwd: '/home/me/code/app', title: 'Fake agent', status: 'idle',
    updatedAt: '2026-09-27T00:00:00Z', pendingPermissions: [], labels: {}, capabilities: { supportsStreaming: true },
  }, project: null }], pageInfo: { hasMore: false, nextCursor: null } };
  vi.spyOn(client, 'getProvidersSnapshot').mockResolvedValue({
    entries: [], requestId: 'fake-providers', cwd: '/home/me', generatedAt: '2026-09-27T00:00:00Z',
  });
  const connect = () => {
    internals.updateConnectionState({ status: 'connected' });
    internals.owned.restore();
  };
  const disconnect = () => {
    internals.owned.disconnected();
    internals.updateConnectionState({ status: 'disconnected' });
  };
  vi.spyOn(client, 'connect').mockImplementation(async () => connect());
  const adapter = new PaseoAdapter('ws://127.0.0.1:8892', new EventHub(), quietLog, 'fake-events-adapter', () => client, new BackgroundGate('primary'));
  const emitRecoveredEvents = async () => {
    const subscriptionId = observations.at(-1)?.subscriptionId;
    internals.owned.receive({
      type: 'agent_permission_request',
      payload: { subscriptionId, agentId: 'fake-agent', request: {
        id: 'fake-permission', provider: 'hermes', name: 'Read', kind: 'tool', title: 'Read file',
        detail: { type: 'unknown' }, actions: [{ id: 'deny', label: 'Deny', behavior: 'deny' }],
      } },
    } as SessionOutboundMessage);
    expect(adapter.listApprovals().map((a) => a.id)).toContain('fake-permission');
    internals.owned.receive({
      type: 'agent_permission_resolved',
      payload: { subscriptionId, agentId: 'fake-agent', requestId: 'fake-permission' },
    } as SessionOutboundMessage);
    expect(adapter.listApprovals()).toEqual([]);
    internals.owned.receive({
      type: 'agent.provider_subagents.update',
      payload: { subscriptionId, kind: 'upsert', subagent: {
        id: 'fake-subagent', parentAgentId: 'fake-agent', provider: 'claude', title: 'Explore', status: 'running',
        createdAt: '2026-09-27T00:00:01Z', updatedAt: '2026-09-27T00:00:01Z',
      } },
    } as SessionOutboundMessage);
    expect((await adapter.listConversations()).map((c) => c.id)).toContain('fake-agent:fake-subagent');
    internals.owned.receive({
      type: 'agent.provider_subagents.update',
      payload: { subscriptionId, kind: 'remove', parentAgentId: 'fake-agent', subagentId: 'fake-subagent' },
    } as SessionOutboundMessage);
    expect((await adapter.listConversations()).map((c) => c.id)).not.toContain('fake-agent:fake-subagent');
  };
  return {
    adapter, observations, connect, disconnect, emitRecoveredEvents,
    fail: (value: boolean) => { fail = value; },
    hold: () => { hold = true; },
    resume: () => { hold = false; pending?.(); },
    attempts: () => attempt,
  };
}

describe('Paseo SDK event recovery', () => {
  it('recreates ownership after initial establishment fails', async () => {
    const daemon = eventDaemon();
    daemon.fail(true);
    daemon.adapter.start();
    await expect.poll(() => daemon.adapter.status().state).toBe('error');
    await expect.poll(() => daemon.observations[0]?.subscriptionId).toBe(null);
    daemon.disconnect();
    daemon.fail(false);
    daemon.connect();
    await expect.poll(() => daemon.adapter.status().state).toBe('connected');
    expect(daemon.observations).toHaveLength(2);
    expect(daemon.observations[1]?.subscriptionId).toBeTruthy();
    await daemon.emitRecoveredEvents();
    daemon.adapter.stop();
  });

  it('awaits fresh event establishment on reconnect instead of the old ready promise', async () => {
    const daemon = eventDaemon();
    daemon.adapter.start();
    await expect.poll(() => daemon.adapter.status().state).toBe('connected');
    daemon.disconnect();
    daemon.hold();
    daemon.connect();
    await expect.poll(() => daemon.attempts()).toBe(2);
    await new Promise((resolve) => setImmediate(resolve));
    expect(daemon.adapter.status().state).not.toBe('connected');
    daemon.resume();
    await expect.poll(() => daemon.adapter.status().state).toBe('connected');
    expect(daemon.observations).toHaveLength(2);
    await daemon.emitRecoveredEvents();
    daemon.adapter.stop();
  });

  it('recreates ownership after restoration fails and another connection succeeds', async () => {
    const daemon = eventDaemon();
    daemon.adapter.start();
    await expect.poll(() => daemon.adapter.status().state).toBe('connected');
    daemon.disconnect();
    daemon.fail(true);
    daemon.connect();
    await expect.poll(() => daemon.adapter.status().state).toBe('error');
    daemon.disconnect();
    daemon.fail(false);
    daemon.connect();
    await expect.poll(() => daemon.adapter.status().state).toBe('connected');
    expect(daemon.observations.at(-1)?.subscriptionId).toBeTruthy();
    await daemon.emitRecoveredEvents();
    daemon.adapter.stop();
  });
});
