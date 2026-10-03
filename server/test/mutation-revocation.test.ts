import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BackgroundGate } from '../src/background.js';
import { HermesAdapter } from '../src/hermes/adapter.js';
import { HelperClient } from '../src/connectors/helper.js';
import { PaseoAdapter } from '../src/paseo/adapter.js';
import { RpcError } from '../src/hermes/gateway.js';
import { SecretStore } from '../src/secrets.js';
import { deviceSignal, withDeviceSignal } from '../src/security/device-signal.js';
import { makeApp, makeKeys, makeToken, postHeaders, TEST_DESKTOP, TEST_PHONE, PHONE_COOKIE, type Keys } from './helpers.js';

let keys: Keys;
let token: string;
beforeAll(async () => { keys = await makeKeys(); token = await makeToken(keys); });
const apps: Array<Awaited<ReturnType<typeof makeApp>>['app']> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const app of apps.splice(0)) await app.close(); });

async function setup() {
  const ctx = await makeApp(keys);
  apps.push(ctx.app);
  const adapter = new HermesAdapter('http://127.0.0.1:8890', ctx.hub, new SecretStore(ctx.config.stateDir),
    { info() {}, warn() {}, error() {} }, { background: new BackgroundGate('shadow') });
  vi.spyOn(adapter as unknown as { requireReady(): void }, 'requireReady').mockImplementation(() => {});
  return { ...ctx, adapter };
}

describe('device authorization follows ordinary backend mutations', () => {
  it.each(['token', 'retry token', 'response body'])('refuses an approval revoked during its real Hermes %s read', async stage => {
    const ctx = await setup();
    let tokens = 0;
    vi.spyOn(ctx.adapter['auth'], 'token').mockImplementation(async () => {
      await Promise.resolve(); tokens += 1;
      if (stage === 'token' || (stage === 'retry token' && tokens === 2)) ctx.devices!.revoke(TEST_DESKTOP.id);
      return 'obviously-fake-token';
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (stage === 'retry token') return new Response('{}', { status: 401 });
      return { ok: true, status: 200, json: async () => {
        await Promise.resolve(); ctx.devices!.revoke(TEST_DESKTOP.id); return { id: 'demo-chat' };
      } } as Response;
    });
    const respond = vi.spyOn(ctx.adapter['gateway'], 'respond').mockReturnValue(true);
    ctx.adapter['pending'].set('demo-approval', { approval: { conversationId: 'demo-chat', options: [{ id: 'once' }] },
      srq: 'demo-request', generation: 1, method: 'approval' } as never);
    vi.spyOn(ctx.hermes, 'respondToApproval').mockImplementation((...args) => ctx.adapter.respondToApproval(...args));
    const res = await ctx.app.inject({ method: 'POST', url: '/api/conversations/hermes/demo-chat/approvals/demo-approval',
      headers: postHeaders(token), payload: { optionId: 'once' } });
    expect(res.statusCode).toBe(403); expect(respond).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(stage === 'token' ? 0 : 1);
  });

  it.each(['live answer', 'restored answer', 'partial clarification'])('refuses a %s revoked during the subagent read', async mode => {
    const ctx = await setup();
    vi.spyOn(ctx.adapter as unknown as { requireNotSubagent(id: string): Promise<void> }, 'requireNotSubagent').mockImplementation(async () => {
      await Promise.resolve(); ctx.devices!.revoke(TEST_DESKTOP.id);
    });
    const respond = vi.spyOn(ctx.adapter['gateway'], 'respond').mockReturnValue(true);
    const call = vi.spyOn(ctx.adapter['gateway'], 'call').mockResolvedValue({ status: 'ok' });
    const batch = { answers: {}, remaining: new Set(['demo-first', 'demo-next']) };
    ctx.adapter['pending'].set('demo-approval', {
      approval: { id: 'demo-approval', conversationId: 'demo-chat', source: 'hermes', kind: 'permission', title: 'Demo action',
        options: [{ id: 'once', label: 'Allow once' }], createdAt: 0 },
      srq: 'demo-request', generation: mode === 'restored answer' ? null : 1,
      method: mode === 'partial clarification' ? 'clarify' : 'approval',
      ...(mode === 'partial clarification' ? { question: { qid: 'demo-first', question: 'Demo question?', choices: [], multiple: false }, batch } : {}),
    } as never);
    vi.spyOn(ctx.hermes, 'respondToApproval').mockImplementation((...args) => ctx.adapter.respondToApproval(...args));
    const res = await ctx.app.inject({ method: 'POST', url: '/api/conversations/hermes/demo-chat/approvals/demo-approval',
      headers: postHeaders(token), payload: mode === 'partial clarification' ? { text: 'Demo answer' } : { optionId: 'once' } });
    expect(res.statusCode).toBe(403);
    expect(respond).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
    expect(batch.answers).toEqual({}); expect(batch.remaining.size).toBe(2);
    expect(ctx.adapter['pending'].has('demo-approval')).toBe(true);
  });

  it.each(['subagent', 'capabilities', 'resume', 'first upload', 'last upload', 'retry'])('stops message work revoked during %s', async stage => {
    const ctx = await setup();
    const revoke = async () => { await Promise.resolve(); ctx.devices!.revoke(TEST_DESKTOP.id); };
    vi.spyOn(ctx.adapter as unknown as { requireNotSubagent(id: string): Promise<void> }, 'requireNotSubagent').mockImplementation(async () => { if (stage === 'subagent') await revoke(); });
    const capabilities = vi.spyOn(ctx.adapter['gateway'], 'enableServerRequests').mockImplementation(async () => {
      if (stage === 'capabilities') await revoke();
    });
    let uploads = 0;
    const call = vi.spyOn(ctx.adapter['gateway'], 'call').mockImplementation(async method => {
      if (method === 'session.resume') {
        if (stage === 'resume') await revoke();
        return { session_id: 'demo-runtime', running: false };
      }
      if (method === 'file.attach') {
        uploads += 1;
        if ((stage === 'first upload' && uploads === 1) || (stage === 'last upload' && uploads === 2)) await revoke();
        return { ref_text: 'Demo attachment' };
      }
      if (method === 'prompt.submit' && stage === 'retry') { await revoke(); throw new RpcError(4001, 'Demo stale runtime'); }
      return { status: 'ok' };
    });
    vi.spyOn(ctx.hermes, 'sendMessage').mockImplementation((...args) => ctx.adapter.sendMessage(...args));
    const res = await ctx.app.inject({ method: 'POST', url: '/api/conversations/hermes/demo-chat/messages', headers: postHeaders(token),
      payload: { text: 'Demo message', attachments: [1, 2].map(n => ({ name: `demo-${n}.txt`, mimeType: 'text/plain', data: Buffer.from('Demo file').toString('base64') })) } });
    expect(res.statusCode).toBe(403);
    expect(call.mock.calls.filter(([method]) => method === 'prompt.submit')).toHaveLength(stage === 'retry' ? 1 : 0);
    expect(call.mock.calls.filter(([method]) => method === 'session.resume')).toHaveLength(['subagent', 'capabilities'].includes(stage) ? 0 : 1);
    expect(uploads).toBe(['subagent', 'capabilities', 'resume'].includes(stage) ? 0 : stage === 'first upload' ? 1 : 2);
    if (stage === 'subagent') expect(capabilities).not.toHaveBeenCalled();
  });

  it('aborts every request of the revoked device before acknowledgement and preserves another device', async () => {
    const ctx = await setup();
    const signals: AbortSignal[] = [];
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const allEntered = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(ctx.hermes, 'sendMessage').mockImplementation(async () => {
      signals.push(deviceSignal()!);
      if (signals.length === 3) entered();
      await waiting;
    });
    const send = (cookie?: string) => Promise.resolve(ctx.app.inject({ method: 'POST', url: '/api/conversations/hermes/demo-chat/messages',
      headers: postHeaders(token, cookie ? { cookie } : {}), payload: { text: 'Demo message' } }));
    const pending = [send(), send(), send(PHONE_COOKIE)];
    try {
      await allEntered;
      const res = await ctx.app.inject({ method: 'DELETE', url: `/api/devices/${TEST_DESKTOP.id}`, headers: postHeaders(token), payload: {} });
      expect(res.statusCode).toBe(200);
      expect(signals.filter(signal => signal.aborted)).toHaveLength(2);
      expect(ctx.devices!.signal(TEST_PHONE.id).aborted).toBe(false);
    } finally { release(); await Promise.all(pending); }
  });

  it.each(['send', 'create'] as const)('stops Paseo %s after each awaited attachment upload', async action => {
    const ctx = await setup();
    const upload = vi.fn(async () => { await Promise.resolve(); ctx.devices!.revoke(TEST_DESKTOP.id);
      return { file: { type: 'file', path: '/home/me/demo-file' } }; });
    const send = vi.fn(async () => {}); const create = vi.fn(async () => ({ id: 'demo-agent' }));
    const adapter = new PaseoAdapter('ws://127.0.0.1:8890', ctx.hub, { info() {}, warn() {}, error() {} }, 'demo-client', undefined, new BackgroundGate('shadow'));
    adapter['client'] = { uploadFile: upload, sendAgentMessage: send, createAgent: create } as never;
    adapter['statusValue'] = { source: 'paseo', state: 'connected' };
    adapter['providers'] = [{ id: 'demo-provider', label: 'Demo provider', modes: [] }];
    const signal = ctx.devices!.signal(TEST_DESKTOP.id);
    const attachments = [1, 2].map(n => ({ name: `demo-${n}.txt`, kind: 'text' as const, mimeType: 'text/plain', bytes: Buffer.alloc(110_000, 'x') }));
    const pending = withDeviceSignal(signal, () => action === 'send' ? adapter.sendMessage('demo-agent', 'Demo message', attachments)
      : adapter.createConversation({ providerId: 'demo-provider', cwd: '/home/me/demo', text: 'Demo message', acknowledgeAutoApprove: true, attachments }));
    await expect(pending).rejects.toMatchObject({ status: 403 });
    expect(upload).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });

  it('refuses the helper mutation after revocation during its shadow-health await', async () => {
    const ctx = await setup();
    const helper = new HelperClient(8890, 'obviously-fake-helper-token', 'shadow');
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await Promise.resolve(); ctx.devices!.revoke(TEST_DESKTOP.id);
      return new Response(JSON.stringify({ role: 'shadow', roleAware: true }));
    });
    await expect(withDeviceSignal(ctx.devices!.signal(TEST_DESKTOP.id), () => helper.setPhonePin('0000'))).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('retires an outstanding Hermes RPC waiter synchronously on revocation', async () => {
    const ctx = await setup();
    const gateway = ctx.adapter['gateway'];
    const send = vi.fn();
    gateway['ws'] = { readyState: 1, send } as never;
    gateway.state = 'ready';
    const pending = gateway.call('demo.action', {}, 30_000, ctx.devices!.signal(TEST_DESKTOP.id));
    ctx.devices!.revoke(TEST_DESKTOP.id);
    await expect(pending).rejects.toMatchObject({ status: 403 });
    expect(gateway['pending'].size).toBe(0); expect(send).toHaveBeenCalledOnce();
  });

  it('retires an outstanding Paseo waiter without waiting for its backend reply', async () => {
    const ctx = await setup();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const cancel = vi.fn(() => waiting);
    const adapter = new PaseoAdapter('ws://127.0.0.1:8890', ctx.hub, { info() {}, warn() {}, error() {} }, 'demo-client', undefined, new BackgroundGate('shadow'));
    adapter['client'] = { cancelAgent: cancel } as never;
    adapter['statusValue'] = { source: 'paseo', state: 'connected' };
    const pending = withDeviceSignal(ctx.devices!.signal(TEST_DESKTOP.id), () => adapter.interrupt('demo-agent'));
    try {
      ctx.devices!.revoke(TEST_DESKTOP.id);
      await expect(pending).rejects.toMatchObject({ status: 403 });
      expect(cancel).toHaveBeenCalledOnce();
    } finally { release(); }
  });
});
