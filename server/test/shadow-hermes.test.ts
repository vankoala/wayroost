import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackgroundGate, type ServerRole } from '../src/background.js';
import { HermesAdapter } from '../src/hermes/adapter.js';
import { EventHub } from '../src/hub.js';
import { SecretStore } from '../src/secrets.js';
import { FAKE_USER, FakeHermes } from './fake-hermes.js';

const quiet = { info() {}, warn() {}, error() {} };
const roles: ServerRole[] = ['shadow', 'primary'];

describe.each(roles)('%s Hermes unattended work', (role) => {
  let fake: FakeHermes;
  let adapter: HermesAdapter;
  const on = role === 'primary';

  beforeEach(async () => {
    fake = new FakeHermes();
    await fake.start();
    const state = mkdtempSync(join(tmpdir(), 'wayroost-shadow-hermes-'));
    const secrets = new SecretStore(state);
    secrets.writeHermes(FAKE_USER);
    const hub = new EventHub();
    hub.add({ readyState: 1, bufferedAmount: 0, send() {}, terminate() {} } as never, 'you@example.com');
    const background = new BackgroundGate(role);
    adapter = new HermesAdapter(fake.url, hub, secrets, quiet, { background, activePollMs: 25 });
    expect((adapter as unknown as { gateway: { background: unknown } }).gateway.background).toBe(background);
  });

  afterEach(async () => {
    adapter.stop();
    await fake.stop();
  });

  const calls = (method: string) => fake.calls.filter((c) => c.method === method);
  async function connect() {
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');
    await expect.poll(() => calls('session.active_list').length).toBeGreaterThan(0);
  }
  const waiting = () => fake.openRequests.push({ id: 'fake-request', method: 'approval', params: { command: 'pwd', choices: ['once', 'deny'] } });

  it('gates approval-routing capabilities on connect', async () => {
    await connect();
    expect(calls('client.capabilities')).toHaveLength(on ? 1 : 0);
    await adapter.getConversation(FakeHermes.stored, true);
    expect(calls('client.capabilities')).toHaveLength(1); // the person opened a live chat
  });

  it('gates automatic waiting-session resumes on startup', async () => {
    waiting();
    await connect();
    await expect.poll(() => calls('session.active_list').length).toBeGreaterThan(2);
    expect(calls('session.resume')).toHaveLength(on ? 1 : 0);
  });

  it('gates automatic waiting-session resumes from active polling', async () => {
    await connect();
    const before = calls('session.active_list').length;
    waiting();
    await expect.poll(() => calls('session.active_list').length).toBeGreaterThan(before + 2);
    expect(calls('session.resume')).toHaveLength(on ? 1 : 0);
  });

  it('gates session-reclaimed listener resumes', async () => {
    await connect();
    await adapter.getConversation(FakeHermes.stored, true);
    expect(calls('session.resume')).toHaveLength(1);
    adapter.setWatching(FakeHermes.stored, true);
    const before = calls('session.active_list').length;
    fake.event('session.reclaimed');
    await expect.poll(() => calls('session.active_list').length).toBeGreaterThan(before + 2);
    expect(calls('session.resume')).toHaveLength(on ? 2 : 1);
  });

  it('gates unattended crash-rerun cancellation with its automatic attach', async () => {
    waiting();
    fake.handlers['session.resume'] = () => ({ session_id: FakeHermes.runtime, auto_continue: { attempt: 1 }, open_requests: [] });
    await connect();
    await expect.poll(() => calls('session.active_list').length).toBeGreaterThan(2);
    expect(calls('session.interrupt')).toHaveLength(on ? 1 : 0);
  });

  it('keeps shadow reads, subscriptions, controls and commands inert before and after reclaim', async () => {
    if (on) return;
    fake.handlers['session.resume'] = () => ({ session_id: FakeHermes.runtime, auto_continue: { attempt: 1 }, open_requests: [] });
    fake.handlers['model.options'] = () => ({ providers: [] });
    await connect();
    const read = async (acted: number) => {
      adapter.setWatching(FakeHermes.stored, true);
      expect(await adapter.getConversation(FakeHermes.stored)).toMatchObject({ needsOpen: true });
      await adapter.getControls(FakeHermes.stored);
      await adapter.listCommands(FakeHermes.stored);
      expect(calls('session.resume')).toHaveLength(acted);
      expect(calls('client.capabilities')).toHaveLength(acted ? 1 : 0);
      expect(calls('session.interrupt')).toHaveLength(acted);
    };
    await read(0);
    await adapter.getConversation(FakeHermes.stored, true);
    expect(calls('session.resume')).toHaveLength(1);
    expect(calls('session.interrupt')).toHaveLength(1);
    const before = calls('session.active_list').length;
    fake.event('session.reclaimed');
    await expect.poll(() => calls('session.active_list').length).toBeGreaterThan(before + 2);
    await read(1);
    await adapter.getConversation(FakeHermes.stored, true);
    expect(calls('session.resume')).toHaveLength(2);
    expect(calls('client.capabilities')).toHaveLength(1);
    expect(calls('session.interrupt')).toHaveLength(2);
  });

  it('keeps requested messages, approval answers and interrupts working', async () => {
    await connect();
    await adapter.sendMessage(FakeHermes.stored, 'Demo request');
    expect(calls('prompt.submit').at(-1)?.params.text).toBe('Demo request');
    fake.serverRequest('fake-permission', 'approval', { command: 'pwd', choices: ['once', 'deny'] });
    await expect.poll(() => adapter.listApprovals().length).toBeGreaterThan(0);
    const approval = adapter.listApprovals().find((a) => a.id === 'fake-permission')!;
    await adapter.respondToApproval(FakeHermes.stored, approval.id, { optionId: 'once' });
    await expect.poll(() => fake.responses.some((r) => r.id === 'fake-permission')).toBe(true);
    await adapter.interrupt(FakeHermes.stored);
    expect(calls('session.interrupt')).toHaveLength(1);
  });
});
