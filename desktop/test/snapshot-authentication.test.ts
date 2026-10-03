import { describe, expect, it } from 'vitest';
import type { Approval, ConversationSummary } from '../../shared/protocol.js';
import { approvalKey, toastCanAllow } from '../src/approvals.js';
import { approval, deferred, fixture, identity, json, snapshot } from './authentication-fixture.js';

const conversation: ConversationSummary = { source: 'paseo', id: 'demo-chat', title: 'Demo task', status: 'idle',
  updatedAt: 0, pendingApprovals: 1, agentLabel: 'Coder', project: { path: '/home/me/demo', name: 'Demo' } };

describe('approval snapshot authentication', () => {
  it('accepts valid nested conversation metadata and every offered option kind', async () => {
    const gate = await fixture();
    try {
      const item: Approval = { ...approval, secret: { input: 'code', confirm: true }, detailKind: 'command',
        filePath: '/home/me/demo', allowText: false, multiSelect: false, progress: 'Demo request', detailTruncated: false,
        options: ['allow', 'allow_session', 'allow_always', 'deny', 'choice'].map((kind, index) => ({
          id: `demo-option-${index}`, label: 'Demo option', kind: kind as Approval['options'][number]['kind'],
        })) };
      const parent = { source: 'hermes' as const, id: 'demo-parent' };
      const metadata: ConversationSummary = { ...conversation, subtitle: 'Demo', preview: 'Demo task', subagent: false, hermesInPaseo: false,
        parent, aliases: [parent], startedBy: { ...parent, title: 'Demo parent' } };
      gate.fetch.mockResolvedValueOnce(json({ role: 'primary', notifications: true, conversations: [metadata], approvals: [item], statuses: [{ source: 'hermes', state: 'connected', message: 'Demo ready' }] }));
      await gate.client.refresh();
      expect(gate.client.authenticationState).toBe('verified');
      expect(gate.client.conversations.get('paseo/demo-chat')).toEqual(metadata);
      expect(gate.handlers.notify).toHaveBeenCalledWith(item);
    } finally { gate.client.stop(); }
  });

  const malformed = [
    ['null option', { ...approval, options: [null] }],
    ['primitive option', { ...approval, options: ['once'] }],
    ['missing option id', { ...approval, options: [{ label: 'Allow once', kind: 'allow' }] }],
    ['invalid option label', { ...approval, options: [{ id: 'once', label: {}, kind: 'allow' }] }],
    ['unknown option kind', { ...approval, options: [{ id: 'once', label: 'Allow once', kind: 'demo-unknown' }] }],
    ['invalid title', { ...approval, title: {} }],
    ['invalid detail', { ...approval, detail: {} }],
    ['invalid creation time', { ...approval, createdAt: null }],
    ['unknown approval kind', { ...approval, kind: 'demo-unknown' }],
    ['invalid secret', { ...approval, secret: { input: 'demo-unknown' } }],
    ['invalid truncation flag', { ...approval, detailTruncated: 'false' }],
    ['unknown detail kind', { ...approval, detailKind: 'demo-unknown' }],
    ['invalid file path', { ...approval, filePath: {} }],
  ] as const;
  it.each(malformed)('rejects a %s before applying any of the snapshot', async (_name, invalid) => {
    const gate = await fixture();
    try {
      gate.handlers.notify.mockImplementation((item) => { const ticket = gate.tickets.issue(item); toastCanAllow(item); return ticket; });
      await gate.client.refresh();
      const ticket = gate.handlers.notify.mock.results[0]!.value;
      const fresh = { ...approval, id: 'demo-new-approval' };
      gate.fetch.mockResolvedValueOnce(json({ ...snapshot, conversations: [conversation], approvals: [approval, fresh, { ...invalid, id: 'demo-invalid-approval' }] }));
      await expect(gate.client.refresh()).rejects.toThrow();
      expect(gate.client.authenticationState).toBe('unverified');
      expect(gate.client.approvals.size).toBe(0); expect(gate.client.conversations.size).toBe(0);
      expect(gate.handlers.notify).toHaveBeenCalledTimes(1);
      expect(gate.tickets.take(ticket)).toBeUndefined();
      const calls = gate.fetch.mock.calls.length;
      await expect(gate.client.allowOnce(approvalKey(approval))).rejects.toThrow();
      expect(gate.fetch).toHaveBeenCalledTimes(calls);
      const check = deferred<Response>(); gate.fetch.mockImplementationOnce(() => check.promise);
      const verifying = gate.client.revalidateAuthentication(gate.client.pairingGeneration);
      expect(gate.client.authenticationBlocked).toBe(true);
      check.resolve(json(identity)); await verifying;
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });

  it.each([
    ['agent label', { ...conversation, agentLabel: {} }],
    ['project name', { ...conversation, project: { path: '/home/me/demo', name: {} } }],
    ['project path', { ...conversation, project: { path: {}, name: 'Demo' } }],
    ['parent', { ...conversation, parent: null }],
    ['aliases', { ...conversation, aliases: [null] }],
    ['started by', { ...conversation, startedBy: { source: 'paseo', id: 'demo-parent', title: {} } }],
  ])('rejects malformed conversation %s before publishing approvals', async (_name, invalid) => {
    const gate = await fixture();
    try {
      gate.fetch.mockResolvedValueOnce(json({ ...snapshot, conversations: [invalid] }));
      await expect(gate.client.refresh()).rejects.toThrow();
      expect(gate.handlers.notify).not.toHaveBeenCalled();
      expect(gate.client.authenticationState).toBe('unverified');
      expect(gate.client.conversations.size).toBe(0);
    } finally { gate.client.stop(); }
  });

  it.each(['notify', 'changed', 'answered'] as const)('keeps authentication when presentation of a valid snapshot throws in %s', async (handler) => {
    const gate = await fixture();
    try {
      await gate.client.refresh();
      const oldTicket = gate.handlers.notify.mock.results[0]!.value;
      let newTicket: string | undefined;
      if (handler === 'notify') gate.handlers.notify.mockImplementationOnce((item) => {
        newTicket = gate.tickets.issue(item); throw new Error('Demo notification failure');
      });
      else gate.handlers[handler].mockImplementationOnce(() => { throw new Error('Demo presentation failure'); });
      gate.fetch.mockResolvedValueOnce(json({ ...snapshot, approvals: [approval, { ...approval, id: 'demo-new-approval' }] }));
      await expect(gate.client.refresh()).rejects.toThrow('Demo');
      expect(gate.client.authenticationState).toBe('verified');
      expect(gate.client.approvals.size).toBe(2);
      expect(gate.tickets.take(oldTicket)).toEqual({ key: approvalKey(approval), id: approval.id, createdAt: approval.createdAt });
      if (newTicket) expect(gate.tickets.take(newTicket)).toMatchObject({ id: 'demo-new-approval' });
      expect(gate.handlers.paired).not.toHaveBeenCalled();
    } finally { gate.client.stop(); }
  });

  it('suspends malformed direct approval updates before invoking presentation', async () => {
    const gate = await fixture();
    try {
      gate.client.receive({ type: 'approval_upsert', approval: { ...approval, options: [null] } as unknown as Approval });
      expect(gate.client.authenticationState).toBe('unverified');
      expect(gate.handlers.notify).not.toHaveBeenCalled();
      expect(gate.client.approvals.size).toBe(0);
    } finally { gate.client.stop(); }
  });

  it('keeps a retired snapshot failure from suspending a freshly checked session in the same generation', async () => {
    const gate = await fixture();
    try {
      const body = deferred<unknown>(); const reading = deferred<void>();
      gate.fetch.mockResolvedValueOnce({ status: 200, ok: true, json: () => { reading.resolve(); return body.promise; } } as Response);
      const pending = gate.client.refresh().catch((error: unknown) => error); await reading.promise;
      gate.client.suspend(0); await gate.client.revalidateAuthentication(0);
      expect(gate.client.authenticationState).toBe('verified');
      body.resolve({ ...snapshot, approvals: [{ ...approval, options: [null] }] });
      expect(await pending).toBeInstanceOf(Error);
      expect(gate.client.authenticationState).toBe('verified');
    } finally { gate.client.stop(); }
  });
});
