import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BackgroundGate } from '../src/background.js';
import { HelperClient } from '../src/connectors/helper.js';
import { HermesAdapter } from '../src/hermes/adapter.js';
import { HermesGateway } from '../src/hermes/gateway.js';
import { EventHub } from '../src/hub.js';
import { Lineage } from '../src/lineage.js';
import { PaseoAdapter } from '../src/paseo/adapter.js';
import { readOrCreateClientId, SecretStore } from '../src/secrets.js';
import { TaskRelay, type TaskRelayDeps } from '../src/tasks/relay.js';

// Typecheck must catch accidental removal of role/gate arguments from startup.
function constructorContract() {
  // @ts-expect-error The server role is required.
  new BackgroundGate();
  // @ts-expect-error Hermes options must include the shared gate.
  new HermesAdapter('', null as never, null as never, null as never);
  // @ts-expect-error Hermes options must require their background gate too.
  new HermesAdapter('', null as never, null as never, null as never, {});
  // @ts-expect-error The gateway gate is required.
  new HermesGateway('', null as never);
  // @ts-expect-error The Paseo gate is required.
  new PaseoAdapter('', null as never, null as never, 'fake-client');
  // @ts-expect-error The Lineage gate is required.
  new Lineage(null, undefined, Date.now);
  // @ts-expect-error The helper role is required.
  new HelperClient(8896, 'fake-token');
  // @ts-expect-error The completion relay's gate is required.
  new TaskRelay({} as Omit<TaskRelayDeps, 'background'>);
}
void constructorContract;

it('an absent or invalid runtime role suppresses work, delivery and default state creation', () => {
  for (const role of [undefined, 'Shadow', 'primary\n']) {
    const gate = new BackgroundGate(role as never);
    expect(gate.role).toBe('shadow');
    expect(gate.run(() => { throw new Error('acted'); })).toBeUndefined();
    expect(() => gate.require()).toThrow('shadow');
  }
  const state = mkdtempSync(join(tmpdir(), 'wayroost-gate-contract-'));
  readOrCreateClientId(state);
  expect(readdirSync(state)).toEqual([]);
});

it('keeps Hermes chat moves in memory in shadow, where no completion relay reads them', () => {
  const quiet = { info() {}, warn() {}, error() {} };
  for (const role of ['shadow', 'primary'] as const) {
    const stateDir = mkdtempSync(join(tmpdir(), 'wayroost-gate-contract-'));
    const adapter = new HermesAdapter('http://127.0.0.1:9', new EventHub(), new SecretStore(stateDir), quiet, { background: new BackgroundGate(role), stateDir });
    adapter.chatIdentity.record('demo-chat-a', 'demo-chat-b');
    expect(adapter.resolveChat('demo-chat-a')).toBe('demo-chat-b');
    expect(readdirSync(stateDir)).toEqual(role === 'primary' ? ['hermes-chat-moves.json'] : []);
  }
});
