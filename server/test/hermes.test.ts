import { BackgroundGate } from '../src/background.js';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent, TimelineItem } from '../../shared/protocol.js';
import { transcript } from '../src/bridge/format.js';
import { parseSessionCookies } from '../src/hermes/auth.js';
import { HermesAdapter } from '../src/hermes/adapter.js';
import { clarifyAnswer, clarifyQuestions, messagesToItems, permissionApproval } from '../src/hermes/normalize.js';
import { EventHub } from '../src/hub.js';
import { SecretStore } from '../src/secrets.js';
import { UserFacingError } from '../src/sources.js';
import { FAKE_USER, FakeHermes } from './fake-hermes.js';

const quietLog = { info() {}, warn() {}, error() {} };

describe('hermes normalization', () => {
  it('parses quoted and prefixed session cookies', () => {
    expect(
      parseSessionCookies([
        'hermes_session_at="eyJhIjoxfQ=="; HttpOnly; Path=/',
        '__Host-hermes_session_rt=abc; Secure; Path=/',
        'other=1',
      ]),
    ).toEqual({ access: 'eyJhIjoxfQ==', refresh: 'abc' });
  });

  it('turns stored rows into a readable timeline', () => {
    const items = messagesToItems([
      { id: 1, role: 'user', content: 'Hi\n@image:/tmp/a.png' },
      {
        id: 2,
        role: 'assistant',
        content: '',
        reasoning: 'thinking',
        tool_calls: [{ id: 'c1', function: { name: 'terminal', arguments: '{"command":"rm -rf build"}' } }],
      },
      { id: 3, role: 'tool', content: '{"output":"boom","exit_code":1}', tool_call_id: 'c1' },
      { id: 4, role: 'assistant', content: 'Done' },
      { id: 5, role: 'system', content: 'x', display_kind: 'hidden' },
    ]);
    expect(items.map((i) => i.kind)).toEqual(['user', 'reasoning', 'tool', 'assistant']);
    expect(items[0]).toEqual({ kind: 'user', id: 'm1', text: 'Hi', attachments: [{ name: 'a.png', kind: 'image' }] });
    expect(items[2]).toMatchObject({ name: 'terminal', summary: 'rm -rf build', status: 'error', output: 'boom\n(exit code 1)' });
  });

  it("shows Hermes' note for a turn it re-ran after a crash as a notice, here and on the bridge", () => {
    const items = messagesToItems([
      { id: 1, role: 'user', content: 'Run the audit' },
      {
        id: 2,
        role: 'user',
        content: '[System note: Your previous turn was interrupted mid-run — the app or its backend process stopped…]\n\nRun the audit',
        display_kind: 'auto_continue',
      },
      { id: 3, role: 'assistant', content: 'Picking up where I left off.' },
    ]);
    expect(items).toEqual([
      { kind: 'user', id: 'm1', text: 'Run the audit' },
      { kind: 'notice', id: 'm2', level: 'info', text: 'Hermes resumed the interrupted turn.' },
      { kind: 'assistant', id: 'm3', text: 'Picking up where I left off.' },
    ]);
    expect(transcript(items, 10).items.map((i) => i.role)).toEqual(['user', 'notice', 'assistant']);
  });

  it('only offers the choices Hermes allows', () => {
    const a = permissionApproval('srq-1', 's1', { command: 'rm -rf /', allow_permanent: false, smart_denied: true }, 0);
    expect(a.options.map((o) => o.id)).toEqual(['once', 'deny']);
    const b = permissionApproval('srq-2', 's1', { command: 'ls', choices: ['once', 'session', 'always', 'deny', 'evil'] }, 0);
    expect(b.options.map((o) => o.id)).toEqual(['once', 'session', 'always', 'deny']);
  });

  it('marks a permission detail as the command it is, whatever the description says', () => {
    const a = permissionApproval('srq-3', 's1', { description: 'Read file', command: '/tmp/erase.sh' }, 0);
    expect(a).toMatchObject({ title: 'Read file', detail: '/tmp/erase.sh', detailKind: 'command' });
    expect(permissionApproval('srq-4', 's1', { tool_name: 'browser' }, 0).detailKind).toBeUndefined();
  });

  it('maps clarify picks to the answer strings Hermes expects', () => {
    const [single] = clarifyQuestions({ question: 'Which branch?', choices: ['main', 'dev'] });
    expect(clarifyAnswer(single!, { optionId: '1' })).toBe('dev');
    expect(clarifyAnswer(single!, { optionId: '7' })).toBeNull();
    expect(clarifyAnswer(single!, { text: ' release ' })).toBe('release');
    const [multi] = clarifyQuestions({ question: 'Which?', choices: ['a', 'b'], multi_select: true });
    expect(clarifyAnswer(multi!, { optionIds: ['0', '1'], text: 'c' })).toBe('["a","b","c"]');
    const batch = clarifyQuestions({
      questions: [
        { qid: 'q0', question: 'One?', choices: [] },
        { qid: 'q1', question: 'Two?', choices: ['x'] },
      ],
      answers: { q0: 'done' },
    });
    expect(batch.map((q) => q.qid)).toEqual(['q1']);
  });
});

describe('hermes adapter against a protocol-faithful fake dashboard', () => {
  let fake: FakeHermes;
  let hub: EventHub;
  let events: ServerEvent[];
  let adapter: HermesAdapter;
  let stateDir: string;

  beforeEach(async () => {
    fake = new FakeHermes();
    await fake.start();
    hub = new EventHub();
    events = [];
    const socket = { readyState: 1, bufferedAmount: 0, send: (p: string) => events.push(JSON.parse(p)), terminate() {} };
    const client = hub.add(socket as never, 'owner@example.com');
    hub.subscribe(client, 'hermes', FakeHermes.stored);
    stateDir = mkdtempSync(join(tmpdir(), 'sb-hermes-'));
    adapter = new HermesAdapter(fake.url, hub, new SecretStore(stateDir), quietLog, { background: new BackgroundGate('primary') });
  });

  afterEach(async () => {
    adapter.stop();
    await fake.stop();
  });

  it('asks for credentials, rejects bad ones without saving, and stores good ones privately', async () => {
    adapter.start();
    expect(adapter.status().state).toBe('needs_credentials');
    expect(await adapter.listConversations()).toEqual([]);

    await expect(adapter.setCredentials('owner', 'wrong')).rejects.toBeInstanceOf(UserFacingError);
    expect(new SecretStore(stateDir).readHermes()).toBeNull();

    await adapter.setCredentials(FAKE_USER.username, FAKE_USER.password);
    await expect.poll(() => adapter.status().state).toBe('connected');
    const mode = statSync(join(stateDir, 'hermes-credentials.json')).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(fake.calls.some((c) => c.method === 'client.capabilities' && c.params.server_requests === true)).toBe(true);
  });

  it("says in each chat's header where it works, like a Paseo agent's", async () => {
    fake.topLevel.push({ id: '20260927_090000_c0de00', source: 'tui', title: 'Tidy the repo', model: 'x/claude-opus-5', cwd: '/home/me/code/app/', message_count: 2 });
    new SecretStore(stateDir).writeHermes(FAKE_USER);
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');
    const subtitles = async () => Object.fromEntries((await adapter.listConversations()).map((c) => [c.title, c.subtitle]));
    // Its own folder; with none, the folder Hermes runs it in (home here), not the model (that can change).
    expect(await subtitles()).toEqual({ 'Tidy the repo': 'Terminal · ~/code/app', 'Fix the build': 'Desktop · ~' });
    await subtitles();
    expect(fake.workspaceRequests).toBe(1); // asked now and then, not on every listing
  });

  it("names no folder for a chat without one when Hermes can't say where it runs", async () => {
    fake.defaultCwd = null;
    new SecretStore(stateDir).writeHermes(FAKE_USER);
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');
    const [summary] = await adapter.listConversations();
    expect(summary).toMatchObject({ title: 'Fix the build', subtitle: 'Desktop' });
  });

  it('lists, opens, streams, and routes an approval back to Hermes', async () => {
    new SecretStore(stateDir).writeHermes(FAKE_USER);
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');

    const [summary] = await adapter.listConversations();
    expect(summary).toMatchObject({ id: FakeHermes.stored, title: 'Fix the build', subtitle: 'Desktop · ~' });

    const detail = await adapter.getConversation(FakeHermes.stored);
    expect(detail.items.map((i) => i.kind)).toEqual(['user', 'reasoning', 'tool', 'assistant']);
    expect(fake.calls.find((c) => c.method === 'session.resume')?.params).toMatchObject({
      session_id: FakeHermes.stored,
      omit_messages: true,
    });

    await adapter.sendMessage(FakeHermes.stored, 'Run the tests');
    expect(fake.calls.find((c) => c.method === 'prompt.submit')?.params).toEqual({
      session_id: FakeHermes.runtime,
      text: 'Run the tests',
    });

    fake.event('message.start');
    fake.event('message.delta', { text: 'Running ' });
    fake.event('message.delta', { text: 'tests…' });
    fake.event('tool.start', { tool_id: 'call_9', name: 'terminal', context: 'npm test', args: { command: 'npm test' } });
    fake.serverRequest('srq-abc', 'approval', {
      command: 'npm test',
      description: 'run tests',
      request_id: 'q-1',
      choices: ['once', 'session', 'always', 'deny'],
    });
    await expect.poll(() => adapter.listApprovals().length).toBe(1);
    const approval = adapter.listApprovals()[0]!;
    expect(approval).toMatchObject({ kind: 'permission', title: 'Run tests', detail: 'npm test' });
    expect(adapter.status().state).toBe('connected');
    expect((await adapter.listConversations())[0]!.status).toBe('needs_approval');

    await expect(
      adapter.respondToApproval(FakeHermes.stored, approval.id, { optionId: 'yolo' }),
    ).rejects.toBeInstanceOf(UserFacingError);
    await adapter.respondToApproval(FakeHermes.stored, approval.id, { optionId: 'once' });
    await expect.poll(() => fake.responses).toEqual([{ id: 'srq-abc', result: { choice: 'once' } }]);
    expect(adapter.listApprovals()).toEqual([]);

    fake.event('tool.complete', { tool_id: 'call_9', name: 'terminal', result: { output: 'ok', exit_code: 0 } });
    fake.event('message.delta', { text: ' All green.' });
    fake.event('message.complete', { text: 'All green.', status: 'complete' });
    fake.event('session.info', { running: false });

    const finished = () =>
      events.some(
        (e) => e.type === 'items_upsert' && e.items.some((i) => i.kind === 'assistant' && i.text === 'All green.'),
      );
    await expect.poll(finished).toBe(true);
    await expect
      .poll(() => events.filter((e) => e.type === 'conversation_upsert').at(-1))
      .toMatchObject({ conversation: { status: 'idle', pendingApprovals: 0 } });

    const itemEvents = events.filter((e): e is Extract<ServerEvent, { type: 'items_upsert' }> => e.type === 'items_upsert');
    const byId = new Map<string, TimelineItem>();
    for (const e of itemEvents) for (const item of e.items) byId.set(item.id, item);
    const deltas = events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta);

    expect(byId.get('m200')).toMatchObject({ kind: 'user', text: 'Run the tests' });
    expect(byId.get('tcall_9')).toMatchObject({ kind: 'tool', status: 'done', output: 'ok' });
    const assistants = [...byId.values()].filter((i) => i.kind === 'assistant');
    expect(assistants.map((a) => (a as { text: string }).text)).toEqual(['Running tests…', 'All green.']);
    expect(assistants.every((a) => !(a as { streaming?: boolean }).streaming)).toBe(true);
    expect(deltas).toContain('tests…');
    expect(events.some((e) => e.type === 'approval_removed')).toBe(true);
  });

  it('never answers password prompts on the user’s behalf', async () => {
    new SecretStore(stateDir).writeHermes(FAKE_USER);
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');
    await adapter.getConversation(FakeHermes.stored);
    fake.serverRequest('srq-sudo', 'sudo', { command: 'apt install x' });
    await expect.poll(() => events.some((e) => e.type === 'items_upsert' && e.items[0]?.kind === 'notice')).toBe(true);
    expect(fake.responses).toEqual([]);
    expect(adapter.listApprovals()).toEqual([]);
  });
});
