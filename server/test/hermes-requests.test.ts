import { BackgroundGate } from '../src/background.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '../../shared/protocol.js';
import { HermesAdapter } from '../src/hermes/adapter.js';
import { HermesGateway } from '../src/hermes/gateway.js';
import { EventHub } from '../src/hub.js';
import { SecretStore } from '../src/secrets.js';
import { UserFacingError } from '../src/sources.js';
import { FAKE_PNG, FAKE_USER, FakeHermes } from './fake-hermes.js';

// Cards must match what Hermes still has open. Hermes keeps open requests in memory only
// (tui_gateway/server_requests.py), so a restart, or a request.cancel lost while the socket
// was down, leaves a card that nothing would ever clear unless Signalbox checks. And after a
// crash, the first cold `session.resume` makes Hermes re-run the turn it lost
// (tui_gateway/session_auto_continue.py), so Signalbox must never be the one doing that.

const STORED = FakeHermes.stored;
const RUNTIME = FakeHermes.runtime;
const quietLog = { info() {}, warn() {}, error() {} };
const SCAN = { command: 'npm audit fix --force', description: 'security scan', request_id: 'q-1', choices: ['once', 'deny'] };

describe('hermes cards stay in step with what Hermes has open', () => {
  let fake: FakeHermes;
  let hub: EventHub;
  let stateDir: string;
  let published: ServerEvent[];
  let adapter: HermesAdapter;

  beforeEach(async () => {
    fake = new FakeHermes();
    await fake.start();
    hub = new EventHub();
    published = [];
    const publish = hub.publish.bind(hub);
    hub.publish = (event: ServerEvent) => {
      published.push(event);
      publish(event);
    };
    stateDir = mkdtempSync(join(tmpdir(), 'sb-requests-'));
    new SecretStore(stateDir).writeHermes(FAKE_USER);
    adapter = new HermesAdapter(fake.url, hub, new SecretStore(stateDir), quietLog, { background: new BackgroundGate('primary') });
  });

  /** An adapter that asks which chats are live every 50 ms, with a browser connected. */
  function pollingAdapter(): void {
    adapter.stop();
    adapter = new HermesAdapter(fake.url, hub, new SecretStore(stateDir), quietLog, { background: new BackgroundGate('primary'), activePollMs: 50 });
    hub.add({ readyState: 1, bufferedAmount: 0, send() {}, terminate() {} } as never, 'owner@example.com');
  }

  afterEach(async () => {
    adapter.stop();
    await fake.stop();
    vi.restoreAllMocks();
  });

  async function connect(): Promise<void> {
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');
    await adapter.getConversation(STORED); // attaches, like opening the chat
  }

  const cards = () => adapter.listApprovals().map((a) => a.id);
  const calls = (method: string) => fake.calls.filter((c) => c.method === method);
  const removed = (approvalId: string): ServerEvent => ({ type: 'approval_removed', source: 'hermes', conversationId: STORED, approvalId });
  /** A round trip on the socket: every frame Hermes sent before it has been handled. */
  const settled = () => adapter.getControls(STORED).catch(() => undefined);
  /** A new connection after Hermes restarted or the socket dropped. */
  const reconnected = async () => {
    const connections = calls('client.capabilities').length;
    await expect.poll(() => calls('client.capabilities').length).toBeGreaterThan(connections);
    await expect.poll(() => adapter.status().state).toBe('connected');
  };

  describe('snapshots', () => {
    it("restores no card from a snapshot of a session that isn't running or waiting", async () => {
      fake.handlers['session.resume'] = () => ({
        session_id: RUNTIME,
        running: false,
        status: 'idle',
        open_requests: [{ id: 'srq-dead', method: 'approval', params: { session_id: RUNTIME, ...SCAN } }],
      });
      await connect();
      expect(cards()).toEqual([]);
      expect(published.some((e) => e.type === 'approval_upsert')).toBe(false);
    });

    it.each([
      ['a running turn', { running: true, status: 'working' }],
      ['a session waiting on background work', { running: false, status: 'waiting' }],
    ])('restores cards from %s', async (_name, state) => {
      fake.handlers['session.resume'] = () => ({
        session_id: RUNTIME,
        ...state,
        open_requests: [{ id: 'srq-live', method: 'approval', params: { session_id: RUNTIME, ...SCAN } }],
      });
      await connect();
      expect(cards()).toEqual(['srq-live']);
    });
  });

  describe('turns that end', () => {
    it('clears cards Hermes dropped without a word when the turn ends', async () => {
      await connect();
      fake.event('message.start');
      fake.serverRequest('srq-scan', 'approval', SCAN);
      await expect.poll(cards).toEqual(['srq-scan']);

      fake.forgetRequest('srq-scan'); // withdrawn, but the request.cancel never reached us
      fake.event('message.complete', { text: '', status: 'error', error: 'killed' });
      await expect.poll(cards).toEqual([]);
      expect(published).toContainEqual(removed('srq-scan'));
      expect((await adapter.listConversations())[0]).toMatchObject({ pendingApprovals: 0 });
    });

    it('clears them when the session reports it stopped running', async () => {
      await connect();
      fake.serverRequest('srq-scan', 'approval', SCAN);
      await expect.poll(cards).toEqual(['srq-scan']);

      fake.forgetRequest('srq-scan');
      fake.event('session.info', { running: false });
      await expect.poll(cards).toEqual([]);
      expect(published).toContainEqual(removed('srq-scan'));
    });

    it('keeps a card that Hermes still has open after the turn ends', async () => {
      await connect();
      fake.event('message.start');
      fake.serverRequest('srq-bg', 'approval', SCAN); // e.g. a background task asking
      await expect.poll(cards).toEqual(['srq-bg']);

      const checks = calls('session.active_list').length;
      fake.event('message.complete', { text: 'Done.', status: 'complete' });
      await expect.poll(() => calls('session.active_list').length).toBeGreaterThan(checks);
      await settled();
      expect(cards()).toEqual(['srq-bg']);
      expect(published).not.toContainEqual(removed('srq-bg'));
    });

    it('clears the cards when you stop the chat', async () => {
      await connect();
      fake.event('message.start');
      fake.serverRequest('srq-scan', 'approval', SCAN);
      fake.serverRequest('srq-ask', 'clarify', { question: 'Which branch?', choices: ['main'] });
      await expect.poll(cards).toEqual(['srq-scan', 'srq-ask']);

      await adapter.interrupt(STORED); // Hermes withdraws them with request.cancel
      await expect.poll(cards).toEqual([]);
      expect(published).toContainEqual(removed('srq-scan'));
      expect(published).toContainEqual(removed('srq-ask'));
    });

    it("clears them after a stop even when Hermes' request.cancel never comes", async () => {
      await connect();
      fake.event('message.start');
      fake.serverRequest('srq-scan', 'approval', SCAN);
      await expect.poll(cards).toEqual(['srq-scan']);
      fake.handlers['session.interrupt'] = () => {
        fake.forgetRequest('srq-scan');
        fake.running = false;
        return { status: 'interrupted' };
      };

      await adapter.interrupt(STORED);
      await expect.poll(cards).toEqual([]);
      expect(published).toContainEqual(removed('srq-scan'));
    });
  });

  describe('reconnecting', () => {
    it.each(['initial attachment', 'reconnect'])(
      'keeps ordered stream and request frames immediately after a resume reply on %s', async (connection) => {
        if (connection === 'reconnect') {
          await connect();
          adapter.setWatching(STORED, true);
        }
        const call = HermesGateway.prototype.call;
        vi.spyOn(HermesGateway.prototype, 'call').mockImplementation(function<T>(
          this: HermesGateway, method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000, signal?: AbortSignal,
        ): Promise<T> {
          const reply = call.call(this, method, params, timeoutMs, signal) as Promise<T>;
          if (method !== 'session.resume') return reply;
          return reply.then((snapshot) => {
            const runtime = (snapshot as { session_id: string }).session_id;
            // A synchronous receiver batch runs before the awaiting adapter can bind.
            this.emit('event', { type: 'message.start', session_id: runtime });
            this.emit('event', { type: 'message.delta', session_id: runtime, payload: { text: 'Demo first. ' } });
            this.emit('request', { id: 'demo-immediate-request', method: 'approval',
              params: { session_id: runtime, ...SCAN }, generation: this.generation });
            this.emit('event', { type: 'message.delta', session_id: runtime, payload: { text: 'Demo second.' } });
            this.emit('event', { type: 'request.cancel', session_id: runtime, payload: { id: 'demo-immediate-request' } });
            this.emit('event', { type: 'message.complete', session_id: runtime, payload: { text: '', status: 'ok' } });
            return snapshot;
          });
        });
        if (connection === 'reconnect') {
          fake.disconnect();
          await reconnected();
          await adapter.getConversation(STORED);
        } else await connect();
        const items = published.flatMap((event) => event.type === 'items_upsert' && event.conversationId === STORED ? event.items : []);
        expect(items).toContainEqual(expect.objectContaining({ kind: 'assistant', text: 'Demo first. Demo second.' }));
        expect(published).toContainEqual(expect.objectContaining({ type: 'approval_upsert',
          approval: expect.objectContaining({ id: 'demo-immediate-request', conversationId: STORED }) }));
        expect(published).toContainEqual(removed('demo-immediate-request'));
        expect(cards()).toEqual([]);
        expect(fake.coldResumes).toBe(0);
        expect(fake.reruns).toBe(0);
      },
    );

    it('drops cards Hermes lost in a restart, without resuming the chat', async () => {
      await connect();
      fake.event('message.start');
      fake.serverRequest('srq-scan', 'approval', SCAN);
      await expect.poll(cards).toEqual(['srq-scan']);
      const resumes = calls('session.resume').length;

      fake.restart(); // `systemctl stop` + start: nothing sends request.cancel
      await reconnected();
      await expect.poll(cards).toEqual([]);
      expect(published).toContainEqual(removed('srq-scan'));
      // A cold resume would let Hermes re-run the turn it lost; only reading is safe.
      expect(calls('session.resume')).toHaveLength(resumes);
    });

    it("doesn't cold-resume a crashed chat you have open when Hermes comes back, and drops its card", async () => {
      await connect();
      adapter.setWatching(STORED, true);
      fake.event('message.start');
      fake.serverRequest('srq-scan', 'approval', SCAN);
      await expect.poll(cards).toEqual(['srq-scan']);
      const resumes = calls('session.resume').length;

      fake.restart(); // killed mid-turn: Hermes' next cold resume of this chat would re-run it
      await reconnected();
      await expect.poll(cards).toEqual([]);
      expect(published).toContainEqual(removed('srq-scan'));
      await settled();
      expect(calls('session.resume')).toHaveLength(resumes);
      expect(fake.coldResumes).toBe(0);
      expect(fake.reruns).toBe(0);
    });

    it('stops showing a chat killed mid-turn as running, and ends its streaming reply', async () => {
      await connect();
      fake.event('message.start');
      fake.event('message.delta', { text: 'Halfway through' });
      await expect.poll(async () => (await adapter.listConversations())[0]?.status).toBe('running');

      fake.restart();
      await reconnected();
      await expect.poll(async () => (await adapter.listConversations())[0]?.status).toBe('idle');
      const last = published
        .flatMap((e) => (e.type === 'items_upsert' ? e.items : []))
        .filter((i) => i.kind === 'assistant')
        .at(-1);
      expect(last).toMatchObject({ text: 'Halfway through' });
      expect(last).not.toHaveProperty('streaming');
    });

    it('drops a card whose request.cancel was lost while the socket was down', async () => {
      await connect();
      fake.event('message.start');
      fake.serverRequest('srq-a', 'approval', SCAN);
      fake.serverRequest('srq-b', 'clarify', { question: 'Which branch?', choices: ['main'] });
      await expect.poll(cards).toEqual(['srq-a', 'srq-b']);

      fake.disconnect();
      fake.forgetRequest('srq-a'); // cancelled while we were away; the session still waits on srq-b
      await reconnected();
      await expect.poll(cards).toEqual(['srq-b']);
      expect(published).toContainEqual(removed('srq-a'));
      expect(published).not.toContainEqual(removed('srq-b'));
    });

    it("rechecks a live session's cards after a reconnect even when it shows as working", async () => {
      await connect();
      fake.event('message.start');
      // Asked by a compute-host child: Hermes mirrors it, but the session shows "working".
      fake.serverRequest('srq-host', 'approval', SCAN, { hostOwned: true });
      await expect.poll(cards).toEqual(['srq-host']);

      fake.disconnect();
      await reconnected();
      await expect.poll(() => calls('session.resume').length).toBe(2);
      await settled();
      expect(cards()).toEqual(['srq-host']);

      // Attached again, so its cancel reaches us.
      fake.event('request.cancel', { id: 'srq-host', method: 'approval', reason: 'timeout' });
      await expect.poll(cards).toEqual([]);
    });

    it('keeps a card through a dropped socket, and answers it with request.answer', async () => {
      await connect();
      fake.event('message.start');
      fake.serverRequest('srq-scan', 'approval', SCAN);
      await expect.poll(cards).toEqual(['srq-scan']);

      fake.disconnect(); // Hermes still has it open
      await reconnected();
      await expect.poll(() => calls('session.resume').length).toBe(2); // rechecked against a fresh snapshot
      await settled();
      expect(cards()).toEqual(['srq-scan']);
      expect(published).not.toContainEqual(removed('srq-scan'));

      // It arrived on the old connection, so the answer goes by request.answer, which confirms it.
      await adapter.respondToApproval(STORED, 'srq-scan', { optionId: 'deny' });
      expect(calls('request.answer').map((c) => c.params)).toEqual([{ id: 'srq-scan', result: { choice: 'deny' } }]);
      expect(fake.responses).toEqual([]);
      expect(cards()).toEqual([]);
    });
  });

  describe('never re-running a turn Hermes lost', () => {
    /** Hermes killed mid-turn and back up; Signalbox reconnected. */
    async function crashed(): Promise<void> {
      await connect();
      fake.event('message.start');
      fake.restart();
      await reconnected();
      await settled();
    }
    /** Every timeline event published for the chat, as text. */
    const streamed = () =>
      published
        .filter((e) => (e.type === 'items_upsert' || e.type === 'text_delta') && e.conversationId === STORED)
        .map((e) => JSON.stringify(e))
        .join('\n');

    it('opening a crashed chat loads its history without resuming it', async () => {
      await crashed();
      const resumes = calls('session.resume').length;
      fake.handlers['model.options'] = () => ({ providers: [], model: 'default-model', provider: 'default' });

      // Everything the phone does when you open and look at a chat.
      const detail = await adapter.getConversation(STORED);
      adapter.setWatching(STORED, true);
      const controls = await adapter.getControls(STORED);
      await adapter.listCommands(STORED);
      await adapter.interrupt(STORED); // Stop: nothing is running there
      await settled();

      expect(detail.items.map((i) => i.kind)).toEqual(['user', 'reasoning', 'tool', 'assistant']); // from the REST API
      expect(controls.controls[0]).toMatchObject({ id: 'model', valueLabel: 'claude-sonnet-5' }); // the chat's own model
      expect(calls('model.options').at(-1)!.params).not.toHaveProperty('session_id');
      expect(calls('commands.catalog').at(-1)!.params).not.toHaveProperty('session_id');
      expect(calls('session.interrupt')).toEqual([]);
      expect(calls('session.resume')).toHaveLength(resumes);
      expect(fake.coldResumes).toBe(0);
      expect(fake.reruns).toBe(0);
    });

    it("leaves sending to Hermes: the send resumes the chat, and Hermes' auto-continue stands down", async () => {
      await crashed();
      await adapter.sendMessage(STORED, 'Carry on, but skip the audit.');
      expect(fake.coldResumes).toBe(1); // your send, not Signalbox on its own
      expect(calls('prompt.submit').at(-1)!.params).toMatchObject({ text: 'Carry on, but skip the audit.' });
      expect(calls('session.interrupt')).toEqual([]); // the prompt starts first; nothing to cancel
      await new Promise((resolve) => setTimeout(resolve, 150)); // past the fake's agent build
      expect(fake.reruns).toBe(0);
    });

    const cancelled = () =>
      published.some((e) => e.type === 'items_upsert' && e.items.some((i) => i.kind === 'notice' && /cancelled/.test(i.text)));

    it("cancels Hermes' re-run when a model change is what resumes a crashed chat", async () => {
      await crashed();
      fake.handlers['model.options'] = () => ({
        providers: [{ slug: 'anthropic', name: 'Anthropic', models: ['claude-sonnet-5', 'claude-opus-5'] }],
      });
      fake.handlers['config.set'] = () => ({});
      const change = { control: 'model' as const, value: JSON.stringify(['anthropic', 'claude-opus-5']) };
      await adapter.setControl(STORED, change);

      expect(fake.coldResumes).toBe(1);
      expect(calls('session.interrupt')).toHaveLength(1); // straight after the resume
      expect(calls('config.set')).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fake.reruns).toBe(0);
      expect(cancelled()).toBe(true);
    });

    it('cancels it for a "/" command too', async () => {
      await crashed();
      await adapter.sendMessage(STORED, '/status');
      expect(calls('session.interrupt')).toHaveLength(1);
      expect(calls('slash.exec')).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fake.reruns).toBe(0);
    });

    it('cancels it before uploading the files of a send, so the re-run can never take them', async () => {
      await crashed();
      const image = { name: 'a.png', mimeType: 'image/png', kind: 'image' as const, bytes: FAKE_PNG };
      await adapter.sendMessage(STORED, 'Look at this', [image]);
      const order = fake.calls.map((c) => c.method).filter((m) => ['session.interrupt', 'image.attach_bytes', 'prompt.submit'].includes(m));
      expect(order).toEqual(['session.interrupt', 'image.attach_bytes', 'prompt.submit']);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fake.reruns).toBe(0);
    });

    it('says so when Hermes is re-running a lost turn, matched on its fields where it can be', async () => {
      await connect();
      const notices = () =>
        published.flatMap((e) => (e.type === 'items_upsert' ? e.items : [])).filter((i) => i.kind === 'notice').map((i) => (i as { text: string }).text);

      // Another client's resume re-ran it while we were attached.
      fake.event('status.update', { kind: 'process', text: 'Resuming interrupted turn…' });
      fake.event('status.update', { kind: 'process', text: 'Background process finished' }); // same kind, not a re-run
      fake.event('status.update', { kind: 'goal', text: 'Resuming the goal' });
      await settled();
      expect(notices()).toEqual(['Hermes is resuming the interrupted turn.']);
    });

    it('says so when it attaches in the middle of a re-run', async () => {
      fake.handlers['session.resume'] = () => ({
        session_id: RUNTIME,
        running: true,
        status: 'working',
        inflight: { user: '[System note: …]', assistant: 'Checking the state first', streaming: true, display_kind: 'auto_continue' },
      });
      await connect();
      expect(
        published.some((e) => e.type === 'items_upsert' && e.items.some((i) => i.kind === 'notice' && i.text === 'Hermes is resuming the interrupted turn.')),
      ).toBe(true);
    });

    it('re-attaches a live chat you have open after a reconnect, and it streams', async () => {
      await connect();
      adapter.setWatching(STORED, true);
      fake.disconnect(); // Hermes is fine; the chat stays live
      await reconnected();
      await expect.poll(() => calls('session.resume').length).toBe(2);

      await adapter.getConversation(STORED); // joins the completed attachment, including runtime binding

      fake.event('message.start');
      fake.event('message.delta', { text: 'Still here after the blip.' });
      await expect.poll(streamed).toContain('Still here after the blip.');
      expect(fake.coldResumes).toBe(0);
      expect(fake.reruns).toBe(0);
    });

    it('attaches a chat you have open once it becomes live, for example opened on the desktop', async () => {
      pollingAdapter();
      await connect();
      adapter.setWatching(STORED, true);
      fake.restart(); // no turn in flight
      await reconnected();
      await settled();
      expect(calls('session.resume')).toHaveLength(1);

      fake.live = true; // another client resumed it
      await expect.poll(() => calls('session.resume').length).toBe(2);
      await adapter.getConversation(STORED);
      fake.event('message.start');
      fake.event('message.delta', { text: 'Picked up on the desktop.' });
      await expect.poll(streamed).toContain('Picked up on the desktop.');
      expect(fake.coldResumes).toBe(0);
    });
  });

  describe('answering', () => {
    it('drops a restored card that Hermes says expired, with a clear message', async () => {
      fake.openRequests = [{ id: 'srq-scan', method: 'approval', params: SCAN }];
      await connect();
      expect(cards()).toEqual(['srq-scan']);

      fake.forgetRequest('srq-scan'); // it ended while the card was up
      const err = await adapter.respondToApproval(STORED, 'srq-scan', { optionId: 'once' }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(UserFacingError);
      expect(err).toMatchObject({ status: 410, message: 'That request already expired.' });
      expect(cards()).toEqual([]);
      expect(published).toContainEqual(removed('srq-scan'));
      // A restored request is never answered with a bare frame that nothing confirms.
      expect(fake.responses).toEqual([]);
    });

    it('answers a live request on its own connection, without the extra round trip', async () => {
      await connect();
      fake.serverRequest('srq-scan', 'approval', SCAN);
      await expect.poll(cards).toEqual(['srq-scan']);

      await adapter.respondToApproval(STORED, 'srq-scan', { optionId: 'once' });
      await expect.poll(() => fake.responses).toEqual([{ id: 'srq-scan', result: { choice: 'once' } }]);
      expect(calls('request.answer')).toEqual([]);
      expect(cards()).toEqual([]);
    });
  });
});
