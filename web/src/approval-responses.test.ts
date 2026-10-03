import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Approval, ConversationSummary } from '../../shared/protocol';

const approval: Approval = { id: 'demo-approval', source: 'hermes', conversationId: 'demo-chat', kind: 'permission',
  title: 'Run the demo check.', options: [{ id: 'once', label: 'Allow once', kind: 'allow' }], createdAt: 0 };
const conversation: ConversationSummary = { id: 'demo-chat', source: 'hermes', title: 'Demo task', status: 'idle', updatedAt: 0, pendingApprovals: 1 };
const list = { conversations: [conversation], approvals: [approval], statuses: [] };
const detail = { conversation, items: [], approvals: [approval] };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

async function fixture() {
  let publish!: (state: 'verified' | 'unverified' | 'unpaired') => void;
  const anomaly = vi.fn(() => publish('unverified'));
  vi.stubGlobal('window', { wayroostTray: { anomaly, onAuthentication: (listener: typeof publish) => { publish = listener; listener('verified'); } } });
  const store = await import('./store');
  store.setState((state) => ({ ...state, approvals: { demo: approval }, listLoaded: true }));
  const api = await import('./api');
  return { ...store, ...api, anomaly, publish };
}

describe('renderer approval responses', () => {
  const invalid = [
    ['null conversations', { ...list, conversations: null }],
    ['null approvals', { ...list, approvals: null }],
    ['invalid option', { ...list, approvals: [{ ...approval, options: [null] }] }],
    ['invalid metadata', { ...list, conversations: [{ ...conversation, project: { path: '/home/me/demo', name: {} } }] }],
    ['invalid status', { ...list, statuses: [null] }],
  ] as const;
  it.each(invalid)('reports %s before replacing list state', async (_name, data) => {
    const gate = await fixture();
    const fetch = vi.fn(async () => Response.json(data)); vi.stubGlobal('fetch', fetch);
    await expect(gate.refreshList()).rejects.toThrow();
    expect(gate.anomaly).toHaveBeenCalledTimes(1);
    expect(gate.getState()).toMatchObject({ approvals: {}, listLoaded: false, sessionExpired: true });
    await expect(gate.api.respond(approval, { optionId: 'once' })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['null approvals', { ...detail, approvals: null }],
    ['invalid option', { ...detail, approvals: [{ ...approval, options: [null] }] }],
    ['null conversation', { ...detail, conversation: null }],
    ['null items', { ...detail, items: null }],
  ])('reports conversation %s before applying approvals', async (_name, data) => {
    const gate = await fixture(); vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
    await gate.loadConversation('hermes', 'demo-chat');
    expect(gate.anomaly).toHaveBeenCalledTimes(1);
    expect(gate.getState()).toMatchObject({ approvals: {}, details: {}, sessionExpired: true });
  });

  it.each(['list', 'conversation'])('reports a %s application failure for the current generation', async (path) => {
    const gate = await fixture();
    const listener = vi.fn().mockImplementationOnce(() => { throw new Error('Demo presentation failure.'); });
    let unsubscribe = () => {};
    vi.stubGlobal('fetch', vi.fn(async () => {
      unsubscribe = gate.onStoreChange(listener);
      return Response.json(path === 'list' ? list : detail);
    }));
    try {
      if (path === 'list') await expect(gate.refreshList()).rejects.toThrow('Demo presentation failure.');
      else await gate.loadConversation('hermes', 'demo-chat');
      expect(gate.anomaly).toHaveBeenCalledTimes(1);
      expect(gate.getState()).toMatchObject({ approvals: {}, details: {}, sessionExpired: true });
    } finally { unsubscribe(); }
  });

  it.each(['list', 'conversation'])('does not report a retired %s response failure against verified recovery', async (path) => {
    const gate = await fixture();
    let resolve!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    const pending = (path === 'list' ? gate.refreshList() : gate.loadConversation('hermes', 'demo-chat')).catch(() => {});
    gate.publish('unverified'); gate.publish('verified');
    resolve(Response.json(path === 'list' ? { ...list, conversations: null } : { ...detail, approvals: null }));
    await pending;
    expect(gate.anomaly).not.toHaveBeenCalled();
    expect(gate.getState()).toMatchObject({ approvals: {}, details: {}, sessionExpired: false });
  });

  it('accepts valid list and conversation approval responses', async () => {
    const gate = await fixture();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(list)).mockResolvedValueOnce(Response.json(detail)));
    await gate.refreshList(); await gate.loadConversation('hermes', 'demo-chat');
    expect(gate.getState().approvals['hermes:demo-chat:demo-approval']).toEqual(approval);
    expect(gate.getState().details['hermes:demo-chat']).toMatchObject({ status: 'ready', items: [] });
    expect(gate.anomaly).not.toHaveBeenCalled();
  });
});
