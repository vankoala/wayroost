import { DaemonClient, type ConnectionState } from '@getpaseo/client/internal/daemon-client';
import type { SessionOutboundMessage } from '@getpaseo/protocol/messages';
import { describe, expect, it, vi } from 'vitest';
import { EventHub } from '../src/hub.js';
import { PaseoAdapter } from '../src/paseo/adapter.js';
import { BackgroundGate } from '../src/background.js';

const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

/** Use actual SDK ownership and reconnects; replace only transport RPCs. */
function fixture() {
  const client = new DaemonClient({ url: 'ws://127.0.0.1:8892', clientId: 'fake-list', logger: quietLog });
  const internals = client as unknown as {
    owned: { restore(): void; disconnected(): void; receive(message: SessionOutboundMessage): void };
    updateConnectionState(state: ConnectionState): void;
    sendCorrelatedRequest(options: {
      message: { type: string };
      selectPayload(payload: object): unknown;
    }): Promise<unknown>;
    sendCorrelatedSessionRequest(options: { message: { subscriptionId: string } }): Promise<unknown>;
  };
  const observations: Array<ReturnType<DaemonClient['observeAgents']>> = [];
  const observeAgents = client.observeAgents.bind(client);
  vi.spyOn(client, 'observeAgents').mockImplementation((options) => {
    const observation = observeAgents(options);
    observations.push(observation);
    return observation;
  });
  let hold = true;
  let sequence = 0;
  const pending: Array<() => void> = [];
  const released: string[] = [];
  vi.spyOn(internals, 'sendCorrelatedRequest').mockImplementation(async ({ message, selectPayload }) => {
    const subscriptionId = `fake-subscription-${++sequence}`;
    if (message.type === 'fetch_agents_request') {
      if (hold) await new Promise<void>((resolve) => pending.push(resolve));
      return selectPayload({ subscriptionId, requestId: 'fake-request', entries: [], pageInfo: { hasMore: false, nextCursor: null } });
    }
    return selectPayload({ subscriptionId, requestId: 'fake-request' });
  });
  vi.spyOn(internals, 'sendCorrelatedSessionRequest').mockImplementation(async ({ message }) => {
    released.push(message.subscriptionId);
    return {};
  });
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
  vi.spyOn(client, 'close').mockResolvedValue();
  const adapter = new PaseoAdapter('ws://127.0.0.1:8892', new EventHub(), quietLog, 'fake-list-adapter', () => client, new BackgroundGate('primary'));
  return {
    adapter, observations, released, pending, connect, disconnect,
    hold: (value: boolean) => { hold = value; },
    active: () => observations.filter((observation) => observation.subscriptionId !== null),
  };
}

describe('Paseo SDK agent-list ownership', () => {
  it.each([1, 3])('releases unfinished ownership through %i interrupted establishments', async (interruptions) => {
    const daemon = fixture();
    daemon.adapter.start();
    for (let attempt = 1; attempt <= interruptions; attempt += 1) {
      await expect.poll(() => daemon.pending.length).toBe(attempt);
      daemon.disconnect();
      daemon.connect();
    }
    daemon.hold(false);
    await expect.poll(() => daemon.adapter.status().state).toBe('connected');
    const current = daemon.observations.at(-1);
    for (const resolve of daemon.pending) resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(daemon.observations).toHaveLength(interruptions + 1);
    expect(daemon.active()).toEqual([current]);
    const currentId = current!.subscriptionId;
    daemon.adapter.stop();
    await expect.poll(() => daemon.active()).toEqual([]);
    expect(daemon.released).toContain(currentId);
  });

  it('releases an unfinished list when stopped before ready', async () => {
    const daemon = fixture();
    daemon.adapter.start();
    await expect.poll(() => daemon.pending.length).toBe(1);
    daemon.adapter.stop();
    daemon.hold(false);
    for (const resolve of daemon.pending) resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(daemon.active()).toEqual([]);
    daemon.adapter.start();
    await expect.poll(() => daemon.adapter.status().state).toBe('connected');
    expect(daemon.active()).toHaveLength(1);
    daemon.adapter.stop();
    await expect.poll(() => daemon.active()).toEqual([]);
  });
});
