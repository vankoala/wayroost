import { DaemonClient, type ConnectionState, type DaemonClientConfig, type DaemonTransport } from '@getpaseo/client/internal/daemon-client';
import { decodeFileTransferFrame, FileTransferOpcode } from '@getpaseo/protocol/binary-frames/file-transfer';
import type { SessionOutboundMessage } from '@getpaseo/protocol/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundGate } from '../src/background.js';
import { EventHub } from '../src/hub.js';
import { PaseoAdapter } from '../src/paseo/adapter.js';
import { deviceSignal, withDeviceSignal } from '../src/security/device-signal.js';

const quietLog = { debug() {}, info() {}, warn() {}, error() {} };
const adapters: PaseoAdapter[] = [];
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

/** Real SDK dispatch, uploads and recovery; only the wire is in memory. */
function setup() {
  const frames: Array<string | Uint8Array | ArrayBuffer> = [];
  let sent: (frame: string | Uint8Array | ArrayBuffer) => void = () => {};
  const transport: DaemonTransport = {
    send(frame) { frames.push(frame); sent(frame); }, close() {},
    onOpen: () => () => {}, onClose: () => () => {}, onError: () => () => {}, onMessage: () => () => {},
  };
  const client = new DaemonClient({ url: 'ws://127.0.0.1:8890', clientId: 'demo-revocation', logger: quietLog,
    transportFactory: () => transport, reconnect: { enabled: false } });
  const sdk = client as unknown as {
    config: DaemonClientConfig; transport: DaemonTransport; waiters: Set<unknown>; pendingSendQueue: unknown[];
    shouldReconnect: boolean;
    updateConnectionState(state: ConnectionState): void; flushPendingSendQueue(): void;
    resolveWaiters(message: SessionOutboundMessage): void; clearWaiters(error: Error): void;
    lastServerInfoMessage: { features: { creationLifecycle: boolean } };
    creations: { operations: Map<string, unknown>; reconnect(): void };
    owned: { restore(): void; receive(message: SessionOutboundMessage): void };
    scheduleReconnect(...args: unknown[]): void;
    attemptConnect(): void;
  };
  vi.spyOn(client, 'connect').mockImplementation(async () => {
    sdk.transport = sdk.config.transportFactory!({ url: 'ws://127.0.0.1:8890' });
    sdk.updateConnectionState({ status: 'connected' });
    sdk.owned.restore();
  });
  const adapter = new PaseoAdapter('ws://127.0.0.1:8890', new EventHub(), quietLog, 'demo-revocation', () => client, new BackgroundGate('shadow'));
  vi.spyOn(adapter as unknown as { bootstrap(): Promise<void> }, 'bootstrap').mockResolvedValue();
  adapters.push(adapter); adapter.start();
  adapter['statusValue'] = { source: 'paseo', state: 'connected' };
  const messages = () => frames.filter((frame): frame is string => typeof frame === 'string')
    .map(frame => (JSON.parse(frame) as { message: Record<string, unknown> }).message);
  const reply = (type: string, requestId: unknown, payload: Record<string, unknown> = {}) =>
    sdk.resolveWaiters({ type, payload: { requestId, ...payload } } as SessionOutboundMessage);
  return { adapter, client, sdk, frames, messages, reply, onSend: (handler: typeof sent) => { sent = handler; } };
}

describe('Paseo device authorization at the transport boundary', () => {
  it.each(['begin', 'first chunk', 'last chunk'])('stops a real SDK upload revoked after %s', async stage => {
    vi.useFakeTimers();
    const ctx = setup();
    const device = new AbortController();
    let chunks = 0;
    ctx.onSend(frame => {
      if (typeof frame === 'string') return;
      const decoded = decodeFileTransferFrame(frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame);
      if (decoded?.opcode === FileTransferOpcode.FileChunk) chunks += 1;
      if ((stage === 'begin' && decoded?.opcode === FileTransferOpcode.FileBegin)
        || (stage === 'first chunk' && chunks === 1) || (stage === 'last chunk' && chunks === 3)) device.abort();
    });
    const pending = withDeviceSignal(device.signal, () => ctx.adapter.sendMessage('demo-agent', 'Demo message', [
      { name: 'demo.txt', kind: 'text', mimeType: 'text/plain', bytes: Buffer.alloc(300_000, 'x') },
    ]));
    const rejected = expect(pending).rejects.toMatchObject({ status: 403 });
    await vi.advanceTimersByTimeAsync(25); await rejected;
    const opcodes = ctx.frames.filter(frame => typeof frame !== 'string')
      .map(frame => decodeFileTransferFrame(frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame)?.opcode);
    expect(chunks).toBe(stage === 'begin' ? 0 : stage === 'first chunk' ? 1 : 3);
    expect(opcodes).not.toContain(FileTransferOpcode.FileEnd);
    expect(ctx.messages().map(message => message.type)).toEqual(['file.upload.request']);
    expect(ctx.sdk.waiters.size).toBe(0);
  });

  it('cancels queued sends while retaining another device and background work', async () => {
    const ctx = setup();
    ctx.sdk.updateConnectionState({ status: 'connecting', attempt: 1 });
    const revoked = new AbortController(); const other = new AbortController();
    const cancelled = withDeviceSignal(revoked.signal, () => ctx.adapter.sendMessage('demo-revoked', 'Demo message'));
    const rejected = expect(cancelled).rejects.toMatchObject({ status: 403 });
    const allowed = withDeviceSignal(other.signal, () => ctx.adapter.sendMessage('demo-other', 'Demo message'));
    const background = ctx.client.sendAgentMessage('demo-background', 'Demo message');
    await Promise.resolve(); await Promise.resolve();
    revoked.abort(); await rejected;
    ctx.sdk.updateConnectionState({ status: 'connected' }); ctx.sdk.flushPendingSendQueue();
    await Promise.resolve(); await Promise.resolve();
    const messages = ctx.messages();
    for (const message of messages) ctx.reply('send_agent_message_response', message.requestId, { accepted: true });
    await Promise.all([allowed, background]);
    expect(messages.map(message => message.agentId).sort()).toEqual(['demo-background', 'demo-other']);
    expect(ctx.sdk.waiters.size).toBe(0); expect(ctx.sdk.pendingSendQueue).toHaveLength(0);
  });

  it('cancels SDK reply waiters immediately on revocation', async () => {
    const ctx = setup(); const device = new AbortController();
    const pending = withDeviceSignal(device.signal, () => ctx.adapter.interrupt('demo-agent'));
    device.abort(); await expect(pending).rejects.toMatchObject({ status: 403 });
    expect(ctx.sdk.waiters.size).toBe(0);
  });

  it('completes a real upload for an authorized device', async () => {
    const ctx = setup(); const device = new AbortController();
    let uploadId: unknown;
    ctx.onSend(frame => {
      if (typeof frame === 'string') {
        const message = (JSON.parse(frame) as { message: Record<string, unknown> }).message;
        expect(deviceSignal()).toBe(device.signal);
        if (message.type === 'file.upload.request') uploadId = message.requestId;
        if (message.type === 'send_agent_message_request') ctx.reply('send_agent_message_response', message.requestId, { accepted: true });
      } else if (decodeFileTransferFrame(frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame)?.opcode === FileTransferOpcode.FileEnd) {
        ctx.reply('file.upload.response', uploadId, { file: { type: 'file', mimeType: 'text/plain', path: '/home/me/demo.txt' } });
      }
    });
    await withDeviceSignal(device.signal, () => ctx.adapter.sendMessage('demo-agent', 'Demo message', [
      { name: 'demo.txt', kind: 'text', mimeType: 'text/plain', bytes: Buffer.alloc(300_000, 'x') },
    ]));
    expect(ctx.messages().map(message => message.type)).toEqual(['file.upload.request', 'send_agent_message_request']);
    expect(ctx.sdk.waiters.size).toBe(0);
  });

  it('rechecks a queued action after reconnection and before its resumed send', async () => {
    const ctx = setup(); const device = new AbortController();
    ctx.sdk.updateConnectionState({ status: 'connecting', attempt: 1 });
    const pending = withDeviceSignal(device.signal, () => ctx.adapter.sendMessage('demo-agent', 'Demo message'));
    const rejected = expect(pending).rejects.toMatchObject({ status: 403 });
    await Promise.resolve(); await Promise.resolve();
    ctx.sdk.updateConnectionState({ status: 'connected' });
    device.abort(); ctx.sdk.flushPendingSendQueue();
    await rejected;
    expect(ctx.frames).toHaveLength(0); expect(ctx.sdk.waiters.size).toBe(0);
  });

  it('keeps the SDK queue deadline and never sends an expired action on later reconnection', async () => {
    vi.useFakeTimers();
    const ctx = setup(); const device = new AbortController();
    ctx.sdk.updateConnectionState({ status: 'connecting', attempt: 1 });
    const pending = withDeviceSignal(device.signal, () => ctx.adapter.sendMessage('demo-agent', 'Demo message'));
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const outcome = pending.catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toMatchObject({ message: expect.stringMatching(/[Tt]ime.*out/) });
    ctx.sdk.updateConnectionState({ status: 'connected' }); ctx.sdk.flushPendingSendQueue();
    await Promise.resolve();
    expect(ctx.frames).toHaveLength(0); expect(ctx.sdk.waiters.size).toBe(0);
  });

  it('retains device authorization across real creation retries and retires recovery on revocation', async () => {
    const ctx = setup(); const device = new AbortController();
    ctx.sdk.lastServerInfoMessage = { features: { creationLifecycle: true } };
    ctx.adapter['providers'] = [{ id: 'demo-provider', label: 'Demo provider', modes: [] }];
    const scopes: Array<AbortSignal | undefined> = [];
    ctx.onSend(() => { scopes.push(deviceSignal()); });
    const pending = withDeviceSignal(device.signal, () => ctx.adapter.createConversation({
      providerId: 'demo-provider', cwd: '/home/me/demo', text: 'Demo message', acknowledgeAutoApprove: true,
    }));
    const rejected = expect(pending).rejects.toMatchObject({ status: 403 });
    await Promise.resolve(); await Promise.resolve();
    ctx.sdk.clearWaiters(Object.assign(new Error('Demo connection loss'), { code: 'DAEMON_CONNECTION_LOST' }));
    await Promise.resolve(); await Promise.resolve();
    ctx.sdk.creations.reconnect();
    const recovery = ctx.messages().at(-1)!;
    expect(recovery.type).toBe('creation.subscribe.request');
    ctx.reply('creation.subscribe.response', recovery.requestId, { subscriptionId: 'demo-recovery', snapshot: null });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(ctx.messages().map(message => message.type)).toEqual(['agent.create.request', 'creation.subscribe.request', 'agent.create.request']);
    expect(scopes).toEqual([device.signal, device.signal, device.signal]);
    const count = ctx.frames.length;
    device.abort(); await rejected;
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(ctx.frames).toHaveLength(count);
    expect(ctx.sdk.creations.operations.size).toBe(0); expect(ctx.sdk.waiters.size).toBe(0);
  });

  it('keeps the shared SDK reconnect timer outside the triggering device context', async () => {
    const ctx = setup(); const device = new AbortController();
    const scopes: Array<AbortSignal | undefined> = [];
    ctx.sdk.shouldReconnect = true;
    ctx.sdk.config.reconnect = { enabled: true, baseDelayMs: 10, maxDelayMs: 10 };
    vi.spyOn(ctx.sdk, 'attemptConnect').mockImplementation(() => { scopes.push(deviceSignal()); });
    withDeviceSignal(device.signal, () => ctx.sdk.scheduleReconnect({ reason: 'Demo transport failure' }));
    device.abort();
    await expect.poll(() => scopes).toEqual([undefined]);
  });

  it('never replays a revoked creation after a connection loss', async () => {
    const ctx = setup(); const device = new AbortController();
    ctx.sdk.lastServerInfoMessage = { features: { creationLifecycle: true } };
    ctx.adapter['providers'] = [{ id: 'demo-provider', label: 'Demo provider', modes: [] }];
    const pending = withDeviceSignal(device.signal, () => ctx.adapter.createConversation({
      providerId: 'demo-provider', cwd: '/home/me/demo', text: 'Demo message', acknowledgeAutoApprove: true,
    }));
    const rejected = expect(pending).rejects.toMatchObject({ status: 403 });
    await Promise.resolve(); await Promise.resolve();
    expect(ctx.messages().map(message => message.type)).toEqual(['agent.create.request']);
    ctx.sdk.clearWaiters(Object.assign(new Error('Demo connection loss'), { code: 'DAEMON_CONNECTION_LOST' }));
    await Promise.resolve(); await Promise.resolve();
    device.abort(); await rejected;
    ctx.sdk.creations.reconnect(); await Promise.resolve();
    expect(ctx.messages().map(message => message.type)).toEqual(['agent.create.request']);
    expect(ctx.sdk.creations.operations.size).toBe(0); expect(ctx.sdk.waiters.size).toBe(0);
  });
});
