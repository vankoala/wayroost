import { describe, expect, it } from 'vitest';
import { approvalKey } from '../src/approvals.js';
import { approval, fixture } from './authentication-fixture.js';

const invalid = [
  ['null option', JSON.stringify({ type: 'approval_upsert', approval: { ...approval, options: [null] } })],
  ['missing approval', JSON.stringify({ type: 'approval_upsert' })],
  ['missing removal identity', JSON.stringify({ type: 'approval_removed' })],
  ['invalid removal source', JSON.stringify({ type: 'approval_removed', source: 'demo-unknown', conversationId: 'demo-chat', approvalId: 'demo-approval' })],
  ['invalid removal id', JSON.stringify({ type: 'approval_removed', source: 'hermes', conversationId: null, approvalId: 'demo-approval' })],
  ['null envelope', 'null'],
  ['array envelope', '[]'],
  ['missing type', '{}'],
  ['invalid JSON', '{'],
] as const;

describe('native socket payloads', () => {
  it.each(invalid)('drops a %s without applying it or starting a refresh, then suspends repeated invalid payloads', async (_name, data) => {
    const gate = await fixture();
    try {
      await gate.client.refresh();
      const ticket = gate.handlers.notify.mock.results[0]!.value;
      const calls = gate.fetch.mock.calls.length;
      const socket = gate.sockets[0]!;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        socket.onmessage?.({ data });
        await Promise.resolve();
        expect(gate.fetch).toHaveBeenCalledTimes(calls);
        expect(gate.client.authenticationState).toBe('verified');
        expect(gate.client.approvals.get(approvalKey(approval))).toEqual(approval);
      }
      socket.onmessage?.({ data });
      expect(gate.client.authenticationState).toBe('unverified');
      expect(gate.client.approvals.size).toBe(0);
      expect(gate.tickets.take(ticket)).toBeUndefined();
      await expect(gate.client.allowOnce(approvalKey(approval))).rejects.toThrow();
      expect(gate.fetch).toHaveBeenCalledTimes(calls);
    } finally { gate.client.stop(); }
  });

  it('uses valid updates only as refresh hints and ignores unrelated event types', async () => {
    const gate = await fixture();
    try {
      const socket = gate.sockets[0]!;
      socket.onmessage?.({ data: JSON.stringify({ type: 'pong' }) });
      expect(gate.fetch).not.toHaveBeenCalled();
      socket.onmessage?.({ data: JSON.stringify({ type: 'approval_upsert', approval }) });
      await gate.client.refresh();
      expect(gate.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/conversations'), expect.anything());
      expect(gate.handlers.notify).toHaveBeenCalledTimes(1);
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it('counts invalid payloads per socket and ignores signals from a replaced socket', async () => {
    const gate = await fixture();
    try {
      const old = gate.sockets[0]!;
      old.onmessage?.({ data: '{' }); old.onmessage?.({ data: '{' });
      expect(gate.client.authenticationState).toBe('verified');
      gate.client.suspend(0); await gate.client.revalidateAuthentication(0);
      const current = gate.sockets.at(-1)!;
      old.onmessage?.({ data: '{' });
      current.onmessage?.({ data: '{' }); current.onmessage?.({ data: '{' });
      expect(gate.client.authenticationState).toBe('verified');
      current.onmessage?.({ data: '{' });
      expect(gate.client.authenticationState).toBe('unverified');
    } finally { gate.client.stop(); }
  });
});
