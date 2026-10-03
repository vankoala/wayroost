import { BackgroundGate } from '../src/background.js';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationSummary } from '../../shared/protocol.js';
import { Bridge } from '../src/bridge/service.js';
import { HermesAdapter } from '../src/hermes/adapter.js';
import { EventHub } from '../src/hub.js';
import { Lineage, candidateRef, isRunRowId, runRowId } from '../src/lineage.js';
import { SecretStore } from '../src/secrets.js';
import { UserFacingError } from '../src/sources.js';
import { FAKE_USER, FakeHermes } from './fake-hermes.js';
import { FakeHermes as FakeHermesSource, FakePaseo } from './helpers.js';

// Who started what, for runs agents start from a shell: `hermes chat --oneshot` and
// `claude -p`. The launchers come from the child's environment (PASEO_AGENT_ID,
// HERMES_SESSION_ID, SIGNALBOX_LAUNCHER=claude:<id>); a child also inherits its
// ancestors' variables, so the nearest one has to be picked.

const quietLog = { info() {}, warn() {}, error() {} };
const PI = '0c1a0de0-0000-4000-8000-000000000002';
const RUN1 = '0c1a0de0-0000-4000-8000-000000000003';
const RUN2 = '0c1a0de0-0000-4000-8000-000000000004';
const CHAT = '20260315_101500_c0ffee';
const ONESHOT = '20260315_101700_decade';
const T = Date.parse('2026-09-28T23:00:00Z');

describe('the nearest launcher', () => {
  const lineage = new Lineage(null, quietLog, () => T, new BackgroundGate('primary'));
  const starts: Record<string, number> = { [PI]: T - 3600_000, [CHAT]: T - 7200_000 };
  lineage.setStartLookup('paseo', (id) => starts[id]);
  lineage.setStartLookup('hermes', (id) => starts[id]);
  lineage.noteRun(RUN1, 'start', { candidates: [{ kind: 'paseo', id: PI }], startedAt: T - 1800_000 });

  it('is the most recently started launcher that began before the child', () => {
    // pi -> claude -p (RUN1) -> hermes one-shot: the one-shot inherited PASEO_AGENT_ID from pi.
    const inherited = [{ kind: 'paseo' as const, id: PI }, { kind: 'claude' as const, id: RUN1 }];
    expect(lineage.parentOf(inherited, T - 1000_000)).toEqual({ source: 'paseo', id: runRowId(RUN1) });
    // Order in the report doesn't matter.
    expect(lineage.parentOf([...inherited].reverse(), T - 1000_000)).toEqual({ source: 'paseo', id: runRowId(RUN1) });
  });

  it("ignores a launcher that started after the child (a stale variable can't be newer than its child)", () => {
    expect(lineage.parentOf([{ kind: 'paseo', id: PI }, { kind: 'claude', id: RUN1 }], T - 2400_000)).toEqual({ source: 'paseo', id: PI });
  });

  it('falls back to the first named launcher when none is known', () => {
    expect(lineage.parentOf([{ kind: 'hermes', id: '20260101_000000_abcdef' }], T)).toEqual({ source: 'hermes', id: '20260101_000000_abcdef' });
    expect(lineage.parentOf([], T)).toBeUndefined();
  });

  it('lists Claude runs next to Paseo agents', () => {
    expect(candidateRef({ kind: 'claude', id: RUN2 })).toEqual({ source: 'paseo', id: `crun:${RUN2}` });
    expect(isRunRowId(`crun:${RUN2}`)).toBe(true);
    expect(isRunRowId(`${PI}:toolu_1`)).toBe(false);
  });
});

describe('Claude Code runs', () => {
  it('keeps the first prompt as the task, the latest answer, and ends as done or error', () => {
    let now = T;
    const lineage = new Lineage(null, quietLog, () => now, new BackgroundGate('primary'));
    lineage.noteRun(RUN1, 'start', { candidates: [{ kind: 'hermes', id: CHAT }], cwd: '/home/me/app', entrypoint: 'sdk-cli' });
    lineage.noteRun(RUN1, 'prompt', { task: 'Audit the repo' });
    lineage.noteRun(RUN1, 'prompt', { task: 'a later prompt is not the task' });
    lineage.noteRun(RUN1, 'stop', { final: 'Found 2 issues.' });
    expect(lineage.run(RUN1)).toMatchObject({ task: 'Audit the repo', final: 'Found 2 issues.', status: 'done', cwd: '/home/me/app' });
    lineage.noteRun(RUN2, 'start', { candidates: [{ kind: 'hermes', id: CHAT }] });
    lineage.noteRun(RUN2, 'end', { error: true });
    expect(lineage.run(RUN2)?.status).toBe('error');
  });

  it('never invents a run from an event without a launcher, and stops calling a silent run running', () => {
    let now = T;
    const lineage = new Lineage(null, quietLog, () => now, new BackgroundGate('primary'));
    lineage.noteRun(RUN1, 'stop', { final: 'orphan answer' });
    expect(lineage.run(RUN1)).toBeUndefined();
    lineage.noteRun(RUN2, 'start', { candidates: [{ kind: 'paseo', id: PI }] });
    expect(lineage.runStatus(lineage.run(RUN2)!)).toBe('running');
    now += 7 * 3600_000;
    expect(lineage.runStatus(lineage.run(RUN2)!)).toBe('done');
  });
});

describe('the lineage file', () => {
  it('survives a restart, private to the service', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-lineage-'));
    const a = new Lineage(dir, quietLog, () => T, new BackgroundGate('primary'));
    a.noteLaunch(ONESHOT, [{ kind: 'paseo', id: PI }], T - 5000);
    a.noteRun(RUN1, 'start', { candidates: [{ kind: 'paseo', id: PI }], task: 'x' });
    a.setStartedBy(`hermes:${CHAT}`, { source: 'paseo', id: PI, title: 'Manager' });
    a.save();
    expect(statSync(join(dir, 'lineage.json')).mode & 0o777).toBe(0o600);
    const b = new Lineage(dir, quietLog, () => T, new BackgroundGate('primary'));
    expect(b.launchOf([ONESHOT])?.candidates).toEqual([{ kind: 'paseo', id: PI }]);
    expect(b.run(RUN1)?.task).toBe('x');
    expect(b.startedBy(`hermes:${CHAT}`)).toEqual({ source: 'paseo', id: PI, title: 'Manager' });
  });

  it('starts empty from a damaged file instead of failing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-lineage-'));
    const a = new Lineage(dir, quietLog, () => T, new BackgroundGate('primary'));
    a.noteLaunch(ONESHOT, [{ kind: 'paseo', id: PI }], T);
    a.save();
    const path = join(dir, 'lineage.json');
    writeFileSync(path, readFileSync(path, 'utf8').slice(0, 20));
    expect(new Lineage(dir, quietLog, () => T, new BackgroundGate('primary')).launchOf([ONESHOT])).toBeUndefined();
  });
});

describe('launch reports through the bridge', () => {
  const make = () => {
    const lineage = new Lineage(null, quietLog, () => T, new BackgroundGate('primary'));
    const bridge = new Bridge({ background: new BackgroundGate('primary'), sources: { hermes: new FakeHermesSource(), paseo: new FakePaseo() }, hub: new EventHub(), log: quietLog, pollMs: 0, lineage, now: () => T });
    return { lineage, bridge };
  };

  it('records a one-shot and a Claude run', async () => {
    const { lineage, bridge } = make();
    await expect(bridge.call('note_launch', { child: ONESHOT, candidates: [{ kind: 'paseo', id: PI }], started_at: T / 1000 })).resolves.toEqual({ ok: true });
    expect(lineage.launchOf([ONESHOT])).toMatchObject({ startedAt: T });
    await bridge.call('note_run', { session: RUN1, event: 'start', candidates: [{ kind: 'hermes', id: CHAT }], cwd: '/home/me/app', entrypoint: 'sdk-cli' });
    await bridge.call('note_run', { session: RUN1, event: 'stop', final: 'done' });
    expect(lineage.run(RUN1)).toMatchObject({ status: 'done', final: 'done' });
  });

  it('refuses malformed ids, paths and unknown fields', async () => {
    const { bridge } = make();
    const refused = async (tool: string, args: unknown) => {
      const err = await bridge.call(tool, args).catch((e) => e);
      expect(err).toBeInstanceOf(UserFacingError);
      expect((err as UserFacingError).status).toBe(400);
    };
    await refused('note_launch', { child: '../skills/x', candidates: [{ kind: 'paseo', id: PI }] });
    await refused('note_launch', { child: ONESHOT, candidates: [{ kind: 'paseo', id: 'not-a-uuid' }] });
    await refused('note_launch', { child: ONESHOT, candidates: [] });
    await refused('note_run', { session: RUN1, event: 'start', cwd: 'relative/path' });
    await refused('note_run', { session: RUN1, event: 'start', extra: 1 });
  });

  it('works while the bridge is paused, and is off without a store', async () => {
    const { bridge } = make();
    bridge.setPaused(true);
    await expect(bridge.call('note_launch', { child: ONESHOT, candidates: [{ kind: 'paseo', id: PI }] })).resolves.toEqual({ ok: true });
    const bare = new Bridge({ background: new BackgroundGate('primary'), sources: { hermes: new FakeHermesSource(), paseo: new FakePaseo() }, hub: new EventHub(), log: quietLog, pollMs: 0 });
    await expect(bare.call('note_launch', { child: ONESHOT, candidates: [{ kind: 'paseo', id: PI }] })).rejects.toMatchObject({ status: 404 });
  });
});

describe('a one-shot started from a shell, against the fake dashboard', () => {
  let fake: FakeHermes;
  let adapter: HermesAdapter;
  let lineage: Lineage;

  beforeEach(async () => {
    fake = new FakeHermes();
    fake.topLevel.push({ id: ONESHOT, source: 'oneshot', title: 'Summarize the test report', cwd: '/tmp', started_at: T / 1000 - 60, last_active: T / 1000, message_count: 2 });
    await fake.start();
    const stateDir = mkdtempSync(join(tmpdir(), 'sb-lineage-hermes-'));
    new SecretStore(stateDir).writeHermes(FAKE_USER);
    lineage = new Lineage(stateDir, quietLog, undefined, new BackgroundGate('primary'));
    adapter = new HermesAdapter(fake.url, new EventHub(), new SecretStore(stateDir), quietLog, { background: new BackgroundGate('primary'), lineage });
  });

  afterEach(async () => {
    adapter.stop();
    await fake.stop();
  });

  const byId = (list: ConversationSummary[]) => Object.fromEntries(list.map((c) => [c.id, c]));

  it('folds under its launcher as a read-only run, wherever it ran', async () => {
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');
    expect(byId(await adapter.listConversations())[ONESHOT]).not.toHaveProperty('parent');
    lineage.noteLaunch(ONESHOT, [{ kind: 'paseo', id: PI }], T - 60_000);
    const row = byId(await adapter.listConversations())[ONESHOT];
    expect(row).toMatchObject({ parent: { source: 'paseo', id: PI }, subagent: true, project: { path: '/tmp' } });
    // The chat the fake always lists is untouched.
    expect(byId(await adapter.listConversations())[FakeHermes.stored]).not.toHaveProperty('subagent');
  });

  it("keeps a bridge-started chat's parent across a restart", async () => {
    lineage.setStartedBy(`hermes:${FakeHermes.stored}`, { source: 'paseo', id: PI, title: 'Manager' });
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');
    expect(byId(await adapter.listConversations())[FakeHermes.stored]).toMatchObject({ parent: { source: 'paseo', id: PI }, startedBy: { title: 'Manager' } });
  });
});

describe('launch reports over the bridge listener (HTTP)', () => {
  it('accepts note_launch and note_run with the token, and still 404s unknown tools', async () => {
    const { buildBridgeServer } = await import('../src/bridge/server.js');
    const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuv';
    const lineage = new Lineage(null, quietLog, () => T, new BackgroundGate('primary'));
    const bridge = new Bridge({ background: new BackgroundGate('primary'), sources: { hermes: new FakeHermesSource(), paseo: new FakePaseo() }, hub: new EventHub(), log: quietLog, pollMs: 0, lineage, now: () => T });
    const app = await buildBridgeServer({ background: new BackgroundGate('primary'), bridge, token: TOKEN, port: 19012, log: quietLog });
    const post = (tool: string, body: unknown, token = TOKEN) =>
      app.inject({ method: 'POST', url: `/bridge/v1/${tool}`, headers: { host: '127.0.0.1:19012', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    try {
      const launch = await post('note_launch', { child: ONESHOT, candidates: [{ kind: 'paseo', id: PI }] });
      expect(launch.statusCode).toBe(200);
      expect(lineage.launchOf([ONESHOT])?.candidates).toEqual([{ kind: 'paseo', id: PI }]);
      expect((await post('note_run', { session: RUN1, event: 'start', candidates: [{ kind: 'paseo', id: PI }] })).statusCode).toBe(200);
      expect((await post('note_run', { session: RUN1, event: 'start' }, 'wrong-token-0123456789abcdefghijklmnop')).statusCode).toBe(401);
      expect((await post('note_launch', { child: 'bad', candidates: [] })).statusCode).toBe(400);
      expect((await post('note_everything', {})).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe("Paseo's own Claude agents", () => {
  it('stand for themselves when a child names their Claude session', () => {
    const lineage = new Lineage(null, quietLog, () => T, new BackgroundGate('primary'));
    const agentId = '4f0e8a6c-1d2b-4c3a-9e8f-7a6b5c4d3e2f';
    lineage.setStartLookup('paseo', (id) => (id === agentId ? T - 600_000 : undefined));
    lineage.setClaudeOwner((sid) => (sid === RUN2 ? agentId : undefined));
    // The agent's own session fired the hook (it has PASEO_AGENT_ID of itself), and its Bash child
    // inherited SIGNALBOX_LAUNCHER=claude:<that session>.
    lineage.noteRun(RUN2, 'start', { candidates: [{ kind: 'paseo', id: agentId }], startedAt: T - 590_000 });
    expect(lineage.parentOf([{ kind: 'claude', id: RUN2 }, { kind: 'paseo', id: agentId }], T - 60_000)).toEqual({ source: 'paseo', id: agentId });
  });
});
