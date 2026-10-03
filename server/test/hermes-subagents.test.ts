import { BackgroundGate } from '../src/background.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationSummary, ServerEvent } from '../../shared/protocol.js';
import { HermesAdapter } from '../src/hermes/adapter.js';
import { sessionSummary, type HermesSessionRow } from '../src/hermes/normalize.js';
import { SUBAGENTS_PER_PARENT, isDelegateRun, resolveSubagents, subagentSummary, type SubagentEntry } from '../src/hermes/subagents.js';
import { EventHub } from '../src/hub.js';
import { SecretStore } from '../src/secrets.js';
import { UserFacingError } from '../src/sources.js';
import { FAKE_USER, FakeHermes } from './fake-hermes.js';

// Hermes delegate_task runs nested under the chat that ran them. Row shapes follow the
// dashboard's session list (hermes_cli/web_routers/sessions.py, hermes_state_sessions.py).

const STORED = FakeHermes.stored;
const AT = 1_790_490_000;
const UUID = 'e3b0c442-98fc-1c14-9afb-f4c8996fb924';

/** A list row, usable both as Signalbox's row type and as the fake's JSON. */
type Row = HermesSessionRow & Record<string, unknown>;

const chat = (id: string, extra: Partial<HermesSessionRow> = {}): Row => ({ id, source: 'desktop', title: `Chat ${id}`, last_active: AT, ...extra });
const run = (id: string, parent: string, extra: Partial<HermesSessionRow> = {}): Row => ({
  id,
  source: 'desktop',
  parent_session_id: parent,
  title: `Subagent: task ${id}`,
  last_active: AT,
  ended_at: AT,
  ...extra,
});
/** Each entry's parent, as "source:id" (null for an orphan). */
const parents = (entries: SubagentEntry[]) =>
  Object.fromEntries(entries.map((e) => [e.row.id, e.parent ? `${e.parent.source}:${e.parent.id}` : null]));

describe('which chat a sub-agent run nests under', () => {
  it('1. a listed chat', () => {
    const { entries } = resolveSubagents({ listed: [chat('P')], rows: [chat('P'), run('r1', 'P')] });
    expect(parents(entries)).toEqual({ r1: 'hermes:P' });
  });

  it('2. an earlier id of a compressed listed chat, or of one that moved', () => {
    const listed = [chat('T', { _lineage_ids: ['demo-root', 'demo-parent', 'T'], _lineage_root_id: 'demo-root' })];
    const rows = [run('a', 'demo-root'), run('b', 'demo-parent'), run('c', 'OLD')];
    const movedTo = new Map([
      ['OLD', 'MID'],
      ['MID', 'T'],
    ]);
    expect(parents(resolveSubagents({ listed, rows, movedTo }).entries)).toEqual({ a: 'hermes:T', b: 'hermes:T', c: 'hermes:T' });
  });

  it('3. another run, first match wins over later rules', () => {
    const { entries } = resolveSubagents({ listed: [chat('P')], rows: [run('outer', 'P'), run('inner', 'outer')] });
    expect(parents(entries)).toEqual({ outer: 'hermes:P', inner: 'hermes:outer' });
    // An earlier id of a listed chat beats a run that happens to have that id.
    const listed = [chat('T', { _lineage_ids: ['X', 'T'] })];
    expect(parents(resolveSubagents({ listed, rows: [run('X', 'P'), run('y', 'X')] }).entries)).toMatchObject({ y: 'hermes:T' });
  });

  it("3. folds a run's own earlier segment away when it ended in compression", () => {
    const rows = [run('S', 'P', { end_reason: 'compression', last_active: AT - 50 }), run('R', 'S', { ended_at: null })];
    const { entries } = resolveSubagents({ listed: [chat('P')], rows });
    expect(parents(entries)).toEqual({ R: 'hermes:P' });
  });

  it('3. keeps one row for a compressed run that Hermes lists twice, and nests its children by its old id', () => {
    const rows = [
      run('C2', 'C1'), // the continuation, re-admitted on its own
      run('C2', 'P', { _lineage_ids: ['C1', 'C2'], _lineage_root_id: 'C1' }), // projected from its first segment
      run('G', 'C1'), // started by the run before it was compressed
    ];
    const { entries } = resolveSubagents({ listed: [chat('P')], rows });
    expect(parents(entries)).toEqual({ C2: 'hermes:P', G: 'hermes:C2' });
    expect(entries.find((e) => e.row.id === 'C2')!.row._lineage_ids).toEqual(['C1', 'C2']);
  });

  it('4. an ACP session by its uuid, without asking for ACP sessions', () => {
    const result = resolveSubagents({ listed: [chat('P')], rows: [run('r', UUID)] });
    expect(parents(result.entries)).toEqual({ r: `hermes:${UUID}` });
    expect(result.needsAcp).toBe(false);
  });

  it('5. an ACP session under a later id, looked up only when a run needs it', () => {
    const rows = [run('r', '20260928_090000_acp002')];
    const first = resolveSubagents({ listed: [chat('P')], rows });
    expect(first).toMatchObject({ needsAcp: true, entries: [] });
    const acp = [chat('20260928_090000_acp002', { source: 'acp', _lineage_root_id: UUID, _lineage_ids: [UUID, '20260928_090000_acp002'] })];
    const second = resolveSubagents({ listed: [chat('P')], rows, acp });
    expect(parents(second.entries)).toEqual({ r: `hermes:${UUID}` });
    expect(second.needsAcp).toBe(false);
  });

  it("6. drops a run whose parent can't be found, unless it's still running", () => {
    const rows = [run('gone', 'cron_job_7'), run('live', 'cron_job_8', { ended_at: null, is_active: true })];
    const { entries } = resolveSubagents({ listed: [chat('P')], rows, acp: [] });
    expect(parents(entries)).toEqual({ live: null });
  });

  it('only takes runs: not branches, resets, listed chats or rows without a parent', () => {
    const rows = [
      chat('top'),
      run('branch', 'P', { _branched_from: 'P' }),
      run('reset', 'P', { _reset_from: 'P' }),
      run('P', 'Q'), // a listed chat, whatever its parent
      run('real', 'P'),
    ];
    expect(parents(resolveSubagents({ listed: [chat('P')], rows }).entries)).toEqual({ real: 'hermes:P' });
  });

  it(`keeps the newest ${SUBAGENTS_PER_PARENT} per parent, once each`, () => {
    const rows = Array.from({ length: 25 }, (_, i) => run(`r${i}`, 'P', { last_active: AT + i }));
    rows.push(run('r24', 'P', { last_active: AT + 24 }));
    const { entries } = resolveSubagents({ listed: [chat('P')], rows });
    expect(entries.map((e) => e.row.id)).toEqual(Array.from({ length: 20 }, (_, i) => `r${24 - i}`));
  });
});

describe('sub-agent rows', () => {
  it('reads as a read-only run of its parent', () => {
    const summary = subagentSummary({
      row: run('r', 'P', { model: 'openrouter/qwen3-coder', preview: 'Find the flaky test', ended_at: null, is_active: true, cwd: '/home/me/app' }),
      parent: { source: 'hermes', id: 'P' },
    });
    expect(summary).toEqual({
      source: 'hermes',
      id: 'r',
      title: 'task r',
      subtitle: 'Sub-agent · ~/app · qwen3-coder',
      preview: 'Find the flaky test',
      status: 'running',
      updatedAt: AT * 1000,
      pendingApprovals: 0,
      project: { path: '/home/me/app', name: 'app' },
      agentLabel: 'qwen3-coder',
      parent: { source: 'hermes', id: 'P' },
      subagent: true,
    });
    expect(subagentSummary({ row: run('r', 'P', { title: null, preview: 'Find the flaky test' }) }).title).toBe('Find the flaky test');
    expect(subagentSummary({ row: run('r', 'P', { title: null }) })).toMatchObject({ title: 'Sub-agent', subtitle: 'Sub-agent', status: 'idle' });
    // No folder of its own: the one Hermes runs such chats in.
    expect(subagentSummary({ row: run('r', 'P') }, '/home/me').subtitle).toBe('Sub-agent · ~');
  });

  it('gives a compressed chat its earlier ids, so runs named by them still find it', () => {
    const summary = sessionSummary(chat('T', { _lineage_ids: ['demo-root', 'demo-parent', 'T'] }), 'idle', 0);
    expect(summary.aliases).toEqual([
      { source: 'hermes', id: 'demo-root' },
      { source: 'hermes', id: 'demo-parent' },
    ]);
    expect(sessionSummary(chat('T'), 'idle', 0)).not.toHaveProperty('aliases');
  });

  it("tells a delegate run from its detail row's config", () => {
    expect(isDelegateRun({ id: 'r', model_config: JSON.stringify({ _delegate_from: 'P' }) })).toBe(true);
    expect(isDelegateRun({ id: 'r', model_config: { _delegate_from: 'P' } })).toBe(true);
    expect(isDelegateRun({ id: 't', model_config: JSON.stringify({ _branched_from: 'P' }) })).toBe(false);
    expect(isDelegateRun({ id: 't', model_config: 'not json' })).toBe(false);
    expect(isDelegateRun({ id: 't' })).toBe(false);
  });
});

describe('hermes sub-agents against the fake dashboard', () => {
  let fake: FakeHermes;
  let published: ServerEvent[];
  let adapter: HermesAdapter;

  beforeEach(async () => {
    fake = new FakeHermes();
    await fake.start();
    const hub = new EventHub();
    published = [];
    const publish = hub.publish.bind(hub);
    hub.publish = (event: ServerEvent) => {
      published.push(event);
      publish(event);
    };
    const stateDir = mkdtempSync(join(tmpdir(), 'sb-subagents-'));
    new SecretStore(stateDir).writeHermes(FAKE_USER);
    adapter = new HermesAdapter(fake.url, hub, new SecretStore(stateDir), { info() {}, warn() {}, error() {} }, { background: new BackgroundGate('primary') });
    fake.subagentRuns = [
      run('20260928_100000_run001', STORED, { title: 'Subagent: Find the flaky test', model: 'openrouter/qwen3-coder', is_active: true, ended_at: null }),
      run('20260928_100500_run002', UUID),
    ];
  });

  afterEach(async () => {
    adapter.stop();
    await fake.stop();
  });

  async function connect(): Promise<void> {
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');
  }
  const byId = (list: ConversationSummary[]) => Object.fromEntries(list.map((c) => [c.id, c]));
  const runQueries = () => fake.listQueries.filter((q) => q.exclude_sources === 'cron,acp,subagent');
  const acpQueries = () => fake.listQueries.filter((q) => q.source === 'acp');
  const calls = (method: string) => fake.calls.filter((c) => c.method === method);

  it('lists runs under their chats, after the chats, when Hermes shows them', async () => {
    await connect();
    const list = await adapter.listConversations();
    expect(list.map((c) => c.id)).toEqual([STORED, '20260928_100000_run001', '20260928_100500_run002']);
    expect(byId(list)['20260928_100000_run001']).toMatchObject({
      title: 'Find the flaky test',
      subtitle: 'Sub-agent · ~ · qwen3-coder',
      status: 'running',
      subagent: true,
      parent: { source: 'hermes', id: STORED },
      pendingApprovals: 0,
    });
    expect(byId(list)['20260928_100500_run002']).toMatchObject({ subagent: true, parent: { source: 'hermes', id: UUID }, status: 'idle' });
    expect(byId(list)[STORED]).not.toHaveProperty('subagent');
    // The main list keeps its own query; runs come from a second one.
    expect(fake.listQueries.map((q) => q.limit)).toEqual(['60', '100']);
    expect(acpQueries()).toEqual([]); // nobody needed the ACP list
  });

  it('shows none while sessions.show_subagents is off', async () => {
    fake.showSubagents = false;
    await connect();
    expect((await adapter.listConversations()).map((c) => c.id)).toEqual([STORED]);
  });

  it("doesn't ask a Hermes that can't list runs, and checks that once per connection", async () => {
    fake.supportsSubagents = false;
    await connect();
    await adapter.listConversations();
    await new Promise((resolve) => setTimeout(resolve, 3_100)); // past the main list's cache
    expect((await adapter.listConversations()).map((c) => c.id)).toEqual([STORED]);
    expect(runQueries()).toEqual([]);
    expect(fake.defaultsRequests).toBe(1);
  });

  it('caches the runs for a while, and lists them again when Hermes says sessions changed', async () => {
    await connect();
    await adapter.listConversations();
    await adapter.listConversations();
    expect(runQueries()).toHaveLength(1);

    fake.subagentRuns.push(run('20260928_101000_run003', STORED));
    fake.event('sessions.changed', {}, '');
    await expect
      .poll(() => published.some((e) => e.type === 'conversation_upsert' && e.conversation.id === '20260928_101000_run003'))
      .toBe(true);
    expect(runQueries()).toHaveLength(2);
  });

  it('lists a new run as soon as its chat says a sub-agent started', async () => {
    await connect();
    await adapter.getConversation(STORED); // attached to the parent
    await adapter.listConversations();

    fake.subagentRuns.push(run('20260928_102000_run004', STORED, { ended_at: null, is_active: true }));
    fake.event('subagent.start', { goal: 'Check the build', task_count: 1, task_index: 0, child_session_id: '20260928_102000_run004' });
    await expect
      .poll(() => published.find((e) => e.type === 'conversation_upsert' && e.conversation.id === '20260928_102000_run004'))
      .toMatchObject({ conversation: { subagent: true, status: 'running', parent: { source: 'hermes', id: STORED } } });
  });

  it('looks up ACP sessions only when a run needs them, and remembers them', async () => {
    fake.subagentRuns.push(run('20260928_103000_run005', '20260928_090000_acp002'));
    fake.acpSessions = [chat('20260928_090000_acp002', { source: 'acp', _lineage_root_id: UUID, _lineage_ids: [UUID, '20260928_090000_acp002'] })];
    await connect();
    const list = await adapter.listConversations();
    expect(byId(list)['20260928_103000_run005']).toMatchObject({ parent: { source: 'hermes', id: UUID } });
    expect(acpQueries()).toHaveLength(1);

    fake.event('sessions.changed', {}, '');
    await expect.poll(() => runQueries().length).toBe(2);
    await adapter.listConversations();
    expect(acpQueries()).toHaveLength(1); // still fresh
  });

  it('opens a run read-only: history over REST, never attached, every action refused', async () => {
    await connect();
    await adapter.listConversations();
    const id = '20260928_100000_run001';
    const resumes = calls('session.resume').length;

    const detail = await adapter.getConversation(id);
    expect(detail.items).toEqual([{ kind: 'assistant', id: 'm901', text: 'Found the flaky test.' }]);
    expect(detail.conversation).toMatchObject({ subagent: true });
    adapter.setWatching(id, true);
    expect(await adapter.getControls(id)).toEqual({ controls: [] });

    const refused = async (action: Promise<unknown>) => {
      const err = await action.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(UserFacingError);
      expect((err as UserFacingError).status).toBe(400);
    };
    await refused(adapter.sendMessage(id, 'Also check the lint'));
    await refused(adapter.sendMessage(id, '/status'));
    await refused(adapter.interrupt(id));
    await refused(adapter.setControl(id, { control: 'reasoning', value: 'high' }));
    await refused(adapter.listCommands(id));
    await refused(adapter.respondToApproval(id, 'srq-1', { optionId: 'once' }));

    expect(calls('session.resume')).toHaveLength(resumes);
    expect(calls('prompt.submit')).toEqual([]);
    expect(calls('session.interrupt')).toEqual([]);
    expect(calls('slash.exec')).toEqual([]);
  });

  it("treats a run it hasn't listed as read-only too, from its detail row", async () => {
    await connect();
    fake.details['20260928_104000_run006'] = {
      id: '20260928_104000_run006',
      parent_session_id: STORED,
      model_config: JSON.stringify({ _delegate_from: STORED }),
    };
    const err = await adapter.sendMessage('20260928_104000_run006', 'hi').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ status: 400 });
    expect(calls('prompt.submit')).toEqual([]);
  });

  it('nests a chat an agent started through the bridge under that chat', async () => {
    await connect();
    const { id } = await adapter.createConversation('Summarize the failing tests', '/home/me/app', [], {
      startedBy: { source: 'paseo', id: 'p1', title: 'Claude Code' },
    });
    expect(byId(await adapter.listConversations())[id]).toMatchObject({
      startedBy: { source: 'paseo', id: 'p1', title: 'Claude Code' },
      parent: { source: 'paseo', id: 'p1' },
    });
  });

  it('gives a compressed chat its earlier ids in the list', async () => {
    fake.topLevel[0]!._lineage_ids = ['20260101_100000_root00', STORED];
    fake.subagentRuns = [run('20260928_105000_run007', '20260101_100000_root00')];
    await connect();
    const list = byId(await adapter.listConversations());
    expect(list[STORED]!.aliases).toEqual([{ source: 'hermes', id: '20260101_100000_root00' }]);
    expect(list['20260928_105000_run007']).toMatchObject({ parent: { source: 'hermes', id: STORED } });
  });
});
