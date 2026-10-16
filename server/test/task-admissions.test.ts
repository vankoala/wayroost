import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TaskAdmissions, type CompletionEvidence } from '../src/tasks/admission.js';
import type { TaskRecord } from '../src/tasks/store.js';

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const envelope = 'Fixture follow-up';
const hash = createHash('sha256').update(envelope).digest('hex');
const id = '00000000-0000-4000-8000-000000000088';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wayroost-admissions-'));
  roots.push(dir);
  const revision = {};
  const task: TaskRecord = { id, provider: 'demo', cwd: '/home/me/code/app', chat: 'fake-chat', verified: true, via: 'bridge',
    createdAt: 100, startedAt: 100, dueMinutes: 20, dueAt: 1_200_100, status: 'finished', round: 1,
    since: 100, changedAt: 200, lastSeen: 200, relays: [] };
  const admissions = new TaskAdmissions(dir);
  return { dir, task, revision, admissions };
}

it('grants only a verified receiving round its epoch without changing task metadata', async () => {
  const f = fixture();
  f.admissions.started(id, 0);
  const submitted = f.admissions.sending(f.task, 1, envelope, f.revision);
  submitted.acknowledged('fake-receiving-message');
  expect(f.admissions.quiet().reasons).toEqual(['followups_unreconciled']);
  f.task.round = 2; f.task.status = 'running';
  const before = structuredClone(f.task);
  f.admissions.observe(f.task, f.revision);
  expect(f.admissions.epoch(f.task, f.revision)).toBeUndefined();
  await f.admissions.reconcile(async () => ({ completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [{ turnId: 'fake-turn', id: 'fake-receiving-message', hash }], completed: false }), () => f.task, () => f.revision);
  expect(f.admissions.epoch(f.task, f.revision)).toBe(1);
  expect(f.task).toEqual(before);
  expect(f.admissions.quiet(f.revision).reasons).toContain('followups_unreconciled');
  const restarted = new TaskAdmissions(f.dir);
  expect(restarted.epoch(f.task, f.revision)).toBeUndefined();
  expect(restarted.quiet(f.revision).reasons).toContain('followups_unreconciled');
  await restarted.reconcile(async () => ({ completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [{ turnId: 'fake-turn', id: 'fake-receiving-message', hash }], completed: false }), () => f.task, () => f.revision);
  expect(restarted.epoch(f.task, f.revision)).toBe(1);
  f.task.round = 3;
  expect(restarted.epoch(f.task, f.revision)).toBeUndefined();
  const saved = readFileSync(join(f.dir, 'task-admissions.json'), 'utf8');
  expect(saved).not.toContain(envelope);
  expect(saved).not.toContain('/home/me');
});

it.each(['restart', 'reconnect'] as const)('revokes an identity-less launch epoch after %s', async (kind) => {
  const f = fixture();
  f.task.status = 'running';
  f.admissions.started(id, 0, undefined, f.revision);
  expect(f.admissions.epoch(f.task, f.revision)).toBeUndefined();
  const admissions = kind === 'restart' ? new TaskAdmissions(f.dir) : f.admissions;
  const revision = kind === 'restart' ? f.revision : {};
  expect(admissions.epoch(f.task, revision)).toBeUndefined();
  await admissions.reconcile(async () => ({ completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [{ turnId: 'fake-turn', id: 'fake-owner-message' }], completed: false }), () => f.task, () => revision);
  expect(admissions.epoch(f.task, revision)).toBeUndefined();
});

it.each(['matching', 'different', 'unavailable'] as const)('verifies a launch before granting its epoch with unchanged connection and %s identity', async (kind) => {
  const f = fixture();
  f.task.status = 'running';
  f.admissions.started(id, 0, 'fake-launch-message', f.revision);
  expect(f.admissions.epoch(f.task, f.revision)).toBeUndefined();
  expect(f.admissions.quiet(f.revision).reasons).toContain('followups_unreconciled');
  await f.admissions.reconcile(async () => {
    if (kind === 'unavailable') throw new Error('Fixture history unavailable');
    return { completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [{ turnId: 'fake-turn', id: kind === 'matching' ? 'fake-launch-message' : 'fake-owner-message' }], completed: false };
  }, () => f.task, () => f.revision);
  expect(f.admissions.epoch(f.task, f.revision)).toBe(kind === 'matching' ? 0 : undefined);
});

it.each(['matching', 'different', 'later', 'duplicate', 'empty', 'running', 'unknown', 'failed', 'reconnect', 'new round'] as const)(
  'requires fresh receiving-run evidence at relay time when history is %s', async (kind) => {
    const f = fixture();
    f.admissions.started(id, 0, 'fake-launch-message', f.revision);
    await f.admissions.reconcile(async () => ({ completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [{ turnId: 'fake-turn', id: 'fake-launch-message' }], completed: false }),
      () => f.task, () => f.revision);
    expect(f.admissions.epoch(f.task, f.revision)).toBe(0);
    let revision = f.revision;
    let reads = 0;
    const result = await f.admissions.relayEpoch(f.task, async () => {
      reads++;
      if (kind === 'failed') throw new Error('Fixture history unavailable');
      if (kind === 'unknown') return undefined;
      if (kind === 'reconnect') revision = {};
      if (kind === 'new round') f.task.round++;
      return { completed: kind !== 'running', completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: kind === 'empty' ? []
        : kind === 'different' ? [{ turnId: 'fake-turn', id: 'fake-owner-message' }]
          : [{ turnId: 'fake-turn', id: 'fake-launch-message' }, ...(kind === 'later' ? [{ turnId: 'fake-turn', id: 'fake-owner-message' }]
            : kind === 'duplicate' ? [{ turnId: 'fake-turn', id: 'fake-launch-message' }] : [])] };
    }, () => revision);
    expect(reads).toBe(1);
    expect(result).toBe(kind === 'matching' ? 0 : undefined);
  },
);

it.each(['missing', 'mismatch', 'restart', 'reconnect', 'unavailable revision'] as const)(
  'refuses inheritance when receiving evidence is %s', async (kind) => {
    const f = fixture();
    let admissions = f.admissions;
    const submitted = admissions.sending(f.task, 1, envelope, kind === 'unavailable revision' ? undefined : f.revision);
    submitted.acknowledged('fake-receiving-message');
    if (kind === 'restart') admissions = new TaskAdmissions(f.dir);
    const revision = kind === 'reconnect' ? {} : f.revision;
    f.task.round = 2; f.task.status = 'running';
    admissions.observe(f.task, revision);
    await admissions.reconcile(async () => kind === 'missing' ? undefined : ({
      completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [{ turnId: 'fake-turn', id: kind === 'mismatch' ? 'different-message' : 'fake-receiving-message', hash }], completed: false,
    }), () => f.task, () => revision);
    expect(admissions.epoch(f.task, revision)).toBeUndefined();
    if (kind === 'missing' || kind === 'mismatch') {
      expect(admissions.quiet().reasons).toContain('followups_unreconciled');
    }
  },
);

it('reconciles a completion during downtime without granting a future round permission', async () => {
  const f = fixture();
  f.admissions.sending(f.task, 1, envelope, f.revision).acknowledged('fake-receiving-message');
  const restarted = new TaskAdmissions(f.dir);
  expect(restarted.quiet().reasons).toContain('followups_unreconciled');
  const before = structuredClone(f.task);
  await restarted.reconcile(async () => ({ completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [{ turnId: 'fake-turn', id: 'fake-receiving-message', hash }], completed: true }), () => f.task, () => f.revision);
  expect(restarted.quiet()).toEqual({ ids: [], reasons: [] });
  expect(f.task).toEqual(before);
  f.task.round = 2;
  expect(restarted.epoch(f.task, f.revision)).toBeUndefined();
});

it('retires a failed send without granting the next owner run an epoch', () => {
  const f = fixture();
  const before = structuredClone(f.task);
  f.admissions.sending(f.task, 1, envelope, f.revision).failed();
  expect(f.task).toEqual(before);
  expect(f.admissions.quiet(f.revision)).toEqual({ ids: [], reasons: [] });
  f.task.round = 2; f.task.status = 'running';
  f.admissions.observe(f.task, f.revision);
  expect(f.admissions.epoch(f.task, f.revision)).toBeUndefined();
});

it.each([true, false])('never reads or retires an unacknowledged submission across restart: %s', async (restart) => {
  const f = fixture();
  const submitted = f.admissions.sending(f.task, 0, envelope, f.revision);
  const admissions = restart ? new TaskAdmissions(f.dir) : f.admissions;
  f.task.round = 2; f.task.status = 'running';
  admissions.observe(f.task, f.revision);
  f.task.status = 'finished';
  admissions.observe(f.task, f.revision);
  let reads = 0;
  const reconcile = () => admissions.reconcile(async () => { reads++; return { completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [], completed: true }; },
    () => f.task, () => f.revision, () => true, () => true);
  await reconcile();
  expect(reads).toBe(0);
  expect(admissions.quiet().reasons).toContain('followups_unreconciled');
  expect(JSON.parse(readFileSync(join(f.dir, 'task-admissions.json'), 'utf8')).pending).toEqual([
    expect.objectContaining({ acknowledged: false }),
  ]);
  if (!restart) {
    submitted.acknowledged('fake-message');
    await reconcile();
    expect(reads).toBe(1);
    expect(admissions.quiet()).toEqual({ ids: [], reasons: [] });
    expect(admissions.epoch(f.task, f.revision)).toBeUndefined();
  }
});

it('requires a fresh confirmation after observing the receiving round', async () => {
  const f = fixture();
  f.admissions.sending(f.task, 0, envelope, f.revision).acknowledged('fake-message');
  await f.admissions.reconcile(async () => ({ completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [{ turnId: 'fake-turn', id: 'fake-message' }], completed: false }),
    () => f.task, () => f.revision);
  f.task.round = 2; f.task.status = 'running';
  f.admissions.observe(f.task, f.revision);
  expect(f.admissions.epoch(f.task, f.revision)).toBeUndefined();
  await f.admissions.reconcile(async () => ({ completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [{ turnId: 'fake-turn', id: 'owner-message' }], completed: false }),
    () => f.task, () => f.revision);
  expect(f.admissions.epoch(f.task, f.revision)).toBeUndefined();
});

it('does not confirm from a read begun before the receiving round is observed', async () => {
  const f = fixture();
  f.admissions.sending(f.task, 0, envelope, f.revision).acknowledged('fake-message');
  await f.admissions.reconcile(async () => {
    f.task.round = 2; f.task.status = 'running';
    f.admissions.observe(f.task, f.revision);
    return { completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [{ turnId: 'fake-turn', id: 'fake-message' }], completed: false };
  }, () => f.task, () => f.revision);
  expect(f.admissions.epoch(f.task, f.revision)).toBeUndefined();
  await f.admissions.reconcile(async () => ({ completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [{ turnId: 'fake-turn', id: 'fake-message' }], completed: false }),
    () => f.task, () => f.revision);
  expect(f.admissions.epoch(f.task, f.revision)).toBe(0);
});

it('keeps failed side-record storage unknown without blocking submission callbacks or tracking', () => {
  const f = fixture();
  mkdirSync(join(f.dir, 'task-admissions.json'));
  const before = structuredClone(f.task);
  const submitted = f.admissions.sending(f.task, 1, envelope, f.revision);
  expect(() => submitted.acknowledged()).not.toThrow();
  expect(f.task).toEqual(before);
  f.task.round = 2; f.task.status = 'running';
  expect(() => f.admissions.observe(f.task, f.revision)).not.toThrow();
  expect(f.admissions.epoch(f.task, f.revision)).toBeUndefined();
  expect(f.admissions.quiet().reasons).toContain('followups_unavailable');
});

it('preserves unknown evidence across restart after rewriting an unreadable side record', () => {
  const f = fixture();
  writeFileSync(join(f.dir, 'task-admissions.json'), '{');
  const admissions = new TaskAdmissions(f.dir);
  expect(admissions.quiet().reasons).toContain('followups_unavailable');
  admissions.sending(f.task, 1, envelope, f.revision).acknowledged('fake-receiving-message');
  const restarted = new TaskAdmissions(f.dir);
  expect(restarted.quiet().reasons).toContain('followups_unavailable');
  expect(restarted.epoch(f.task, f.revision)).toBeUndefined();
});

it('revokes a saved epoch after reconnect when a later message repeats the same text', async () => {
  const f = fixture();
  f.admissions.sending(f.task, 1, envelope, f.revision).acknowledged('first-receiving-message');
  f.task.round = 2; f.task.status = 'running';
  f.admissions.observe(f.task, f.revision);
  await f.admissions.reconcile(async () => ({ completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [{ turnId: 'fake-turn', id: 'first-receiving-message', hash }], completed: false }), () => f.task, () => f.revision);
  expect(f.admissions.epoch(f.task, f.revision)).toBe(1);
  const next = {};
  expect(f.admissions.epoch(f.task, next)).toBeUndefined();
  expect(f.admissions.quiet(next).reasons).toContain('followups_unreconciled');
  await f.admissions.reconcile(async () => ({ completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [{ turnId: 'fake-turn', id: 'later-receiving-message', hash }], completed: false }), () => f.task, () => next);
  expect(f.admissions.epoch(f.task, next)).toBeUndefined();
});


it.each([undefined, 'submitted-message'])('never assigns an epoch to identical text with a different identity: %s', async (messageId) => {
  const f = fixture();
  f.admissions.sending(f.task, 0, envelope, f.revision).acknowledged(messageId);
  f.task.round = 2; f.task.status = 'running';
  f.admissions.observe(f.task, f.revision);
  await f.admissions.reconcile(async () => ({ completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [
    { turnId: 'fake-turn', id: 'submitted-message', hash }, { turnId: 'fake-turn', id: 'owner-message', hash },
  ], completed: false }), () => f.task, () => f.revision);
  expect(f.admissions.epoch(f.task, f.revision)).toBeUndefined();
  expect(f.admissions.quiet(f.revision).reasons).toEqual(['followups_unreconciled']);
});

it.each(['resolve', 'reject'] as const)('revokes all unresolved permission when a reconciliation read reconnects: %s', async (outcome) => {
  const f = fixture();
  const second = { ...f.task, id: '00000000-0000-4000-8000-000000000089' };
  f.admissions.sending(f.task, 0, envelope, f.revision).acknowledged('first-message');
  f.admissions.sending(second, 0, envelope, f.revision).acknowledged('second-message');
  let revision = f.revision;
  let reads = 0;
  await f.admissions.reconcile(async (worker) => {
    reads++;
    if (worker === id) {
      revision = {};
      if (outcome === 'reject') throw new Error('Fixture reconnect');
    }
    return { completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [{ turnId: 'fake-turn', id: worker === id ? 'first-message' : 'second-message', hash }], completed: false };
  }, (worker) => worker === id ? f.task : second, () => revision);
  expect(reads).toBe(1);
  for (const task of [f.task, second]) {
    task.round = 2; task.status = 'running';
    f.admissions.observe(task, revision);
  }
  await f.admissions.reconcile(async (worker) => ({ completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [
    { turnId: 'fake-turn', id: worker === id ? 'first-message' : 'second-message', hash },
  ], completed: false }), (worker) => worker === id ? f.task : second, () => revision);
  for (const task of [f.task, second]) expect(f.admissions.epoch(task, revision)).toBeUndefined();
});

it('never restores permission inferred from a legacy text digest', async () => {
  const f = fixture();
  writeFileSync(join(f.dir, 'task-admissions.json'), JSON.stringify({ rounds: [
    { id, round: 2, epoch: 0, hash, messageId: 'inferred-message' },
  ], pending: [] }));
  const restored = new TaskAdmissions(f.dir);
  f.task.round = 2; f.task.status = 'running';
  await restored.reconcile(async () => ({ completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [{ turnId: 'fake-turn', id: 'inferred-message', hash }], completed: false }),
    () => f.task, () => f.revision);
  expect(restored.epoch(f.task, f.revision)).toBeUndefined();
  expect(restored.quiet(f.revision).reasons).toContain('followups_unreconciled');
  f.task.status = 'finished';
  await restored.reconcile(async () => undefined, () => f.task, () => f.revision);
  expect(restored.quiet(f.revision).reasons).toContain('followups_unreconciled');
  await restored.reconcile(async () => ({ completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [], completed: true }), () => f.task, () => f.revision);
  expect(restored.quiet(f.revision)).toEqual({ ids: [], reasons: [] });
});

it.each([undefined, 'fake-message'])('requires fresh completion for an observed receiving round without an epoch: %s', async (messageId) => {
  const f = fixture();
  f.admissions.sending(f.task, undefined, envelope, f.revision).acknowledged(messageId);
  f.task.round = 2; f.task.status = 'running';
  f.admissions.observe(f.task, f.revision);
  let reads = 0;
  await f.admissions.reconcile(async () => { reads++; return undefined; }, () => f.task, () => f.revision);
  expect(reads).toBe(1);
  expect(f.admissions.quiet(f.revision).reasons).toContain('followups_unreconciled');
  f.task.status = 'finished';
  await f.admissions.reconcile(async () => ({ completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [], completed: true }), () => f.task, () => f.revision);
  expect(f.admissions.quiet(f.revision)).toEqual({ ids: [], reasons: [] });
  expect(JSON.parse(readFileSync(join(f.dir, 'task-admissions.json'), 'utf8')).pending).toEqual([]);
  expect(f.admissions.epoch(f.task, f.revision)).toBeUndefined();
});

it.each([undefined, 'fake-message'])('requires fresh completion for a restored follow-up with identity: %s', async (messageId) => {
  const f = fixture();
  f.admissions.sending(f.task, 0, envelope, f.revision).acknowledged(messageId);
  const restored = new TaskAdmissions(f.dir);
  let reads = 0;
  let evidence: CompletionEvidence | undefined;
  const read = async () => { reads++; return evidence; };
  await restored.reconcile(read, () => f.task, () => f.revision, () => false);
  expect(reads).toBe(0);
  expect(restored.quiet().reasons).toContain('followups_unreconciled');
  await restored.reconcile(read, () => f.task, () => f.revision, () => true);
  expect(reads).toBe(1);
  expect(restored.quiet().reasons).toContain('followups_unreconciled');
  evidence = { completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [], completed: false };
  await restored.reconcile(read, () => f.task, () => f.revision, () => true);
  expect(reads).toBe(2);
  expect(restored.quiet().reasons).toContain('followups_unreconciled');
  const before = structuredClone(f.task);
  evidence.completed = true;
  await restored.reconcile(read, () => f.task, () => f.revision, () => true);
  expect(reads).toBe(3);
  expect(restored.quiet()).toEqual({ ids: [], reasons: [] });
  expect(f.task).toEqual(before);
  expect(new TaskAdmissions(f.dir).quiet()).toEqual({ ids: [], reasons: [] });
  f.task.round = 2; f.task.status = 'running';
  restored.observe(f.task, f.revision);
  expect(restored.epoch(f.task, f.revision)).toBeUndefined();
});

it.each(['restart', 'reconnect'].flatMap((kind) => ['observe', 'drained'].map((path) => ({ kind, path }))))(
  'requires fresh completion after $kind before retiring a same-round follow-up through $path', async ({ kind, path }) => {
    const f = fixture();
    f.task.status = 'running';
    f.admissions.sending(f.task, 0, envelope, f.revision).acknowledged('fake-message');
    const admissions = kind === 'restart' ? new TaskAdmissions(f.dir) : f.admissions;
    const revision = {};
    f.task.status = 'finished';
    if (path === 'observe') admissions.observe(f.task, revision);
    let reads = 0;
    let completed = false;
    const reconcile = () => admissions.reconcile(async () => {
      reads++;
      return { completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [], completed };
    }, () => f.task, () => revision, () => true, () => true);
    expect(admissions.quiet().reasons).toContain('followups_unreconciled');
    await reconcile();
    expect(reads).toBe(1);
    expect(admissions.quiet().reasons).toContain('followups_unreconciled');
    expect(JSON.parse(readFileSync(join(f.dir, 'task-admissions.json'), 'utf8')).pending).toHaveLength(1);
    completed = true;
    await reconcile();
    expect(reads).toBe(2);
    expect(admissions.quiet()).toEqual({ ids: [], reasons: [] });
    expect(new TaskAdmissions(f.dir).quiet()).toEqual({ ids: [], reasons: [] });
    expect(admissions.epoch(f.task, revision)).toBeUndefined();
    await reconcile();
    expect(reads).toBe(2);
  },
);

it.each(['observe', 'drained'].flatMap((path) => [true, false].map((identity) => ({ path, identity }))))(
  'requires fresh completion for a live same-round follow-up through $path with identity: $identity', async ({ path, identity }) => {
    const f = fixture();
    f.task.status = 'running';
    f.admissions.sending(f.task, 0, envelope, f.revision).acknowledged(identity ? 'fake-message' : undefined);
    if (path === 'observe') f.admissions.observe(f.task, f.revision);
    expect(f.admissions.quiet().reasons).toContain('followups_unreconciled');
    f.task.status = 'finished';
    const before = structuredClone(f.task);
    let reads = 0;
    let evidence: CompletionEvidence | undefined;
    const reconcile = () => f.admissions.reconcile(async () => { reads++; return evidence; },
      () => f.task, () => f.revision, () => true, () => true);
    await reconcile();
    expect(reads).toBe(1);
    expect(f.admissions.quiet().reasons).toContain('followups_unreconciled');
    evidence = { completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [{ turnId: 'fake-turn', id: 'fake-message' }], completed: false };
    await reconcile();
    expect(reads).toBe(2);
    expect(f.admissions.quiet().reasons).toContain('followups_unreconciled');
    expect(f.admissions.epoch(f.task, f.revision)).toBeUndefined();
    expect(JSON.parse(readFileSync(join(f.dir, 'task-admissions.json'), 'utf8')).pending).toHaveLength(1);
    evidence.completed = true;
    await reconcile();
    expect(reads).toBe(3);
    expect(f.admissions.quiet()).toEqual({ ids: [], reasons: [] });
    expect(new TaskAdmissions(f.dir).quiet()).toEqual({ ids: [], reasons: [] });
    expect(f.task).toEqual(before);
    f.task.round++;
    f.task.status = 'running';
    f.admissions.observe(f.task, f.revision);
    expect(f.admissions.epoch(f.task, f.revision)).toBeUndefined();
    await reconcile();
    expect(reads).toBe(3);
  },
);

it.each([true, false])('requires fresh completion after a later receiving run is observed with identity: %s', async (identity) => {
  const f = fixture();
  f.task.status = 'running';
  f.admissions.sending(f.task, 0, envelope, f.revision).acknowledged(identity ? 'fake-message' : undefined);
  f.admissions.observe(f.task, f.revision);
  expect(f.admissions.quiet().reasons).toContain('followups_unreconciled');
  f.task.status = 'finished';
  f.admissions.observe(f.task, f.revision);
  f.task.round++;
  f.task.status = 'running';
  f.admissions.observe(f.task, f.revision);
  let reads = 0;
  let completed = false;
  const reconcile = () => f.admissions.reconcile(async () => {
    reads++;
    return { completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [{ turnId: 'fake-turn', id: 'fake-message' }], completed };
  }, () => f.task, () => f.revision);
  await reconcile();
  expect(f.admissions.quiet().reasons).toContain('followups_unreconciled');
  expect(reads).toBe(1);
  completed = true;
  await reconcile();
  expect(f.admissions.quiet()).toEqual({ ids: [], reasons: [] });
  expect(f.admissions.epoch(f.task, f.revision)).toBeUndefined();
  expect(reads).toBe(2);
  await reconcile();
  expect(reads).toBe(2);
});

it.each(['empty', 'unavailable'] as const)('requires fresh ended activity for a drained receiving round with %s history', async (evidence) => {
  const f = fixture();
  f.admissions.sending(f.task, 0, envelope, f.revision).acknowledged('fake-message');
  let completed = false;
  let unavailable = evidence === 'unavailable';
  const read = async () => {
    if (unavailable) throw new Error('Fixture history unavailable');
    return { completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [], completed };
  };
  const reconcile = (reconciled: boolean, drained: boolean) => f.admissions.reconcile(read,
    () => f.task, () => f.revision, () => reconciled, () => drained);
  await reconcile(true, true);
  expect(f.admissions.quiet(f.revision).reasons).toContain('followups_unreconciled');
  f.task.round = 2; f.task.status = 'running';
  f.admissions.observe(f.task, f.revision);
  await reconcile(true, false);
  expect(f.admissions.quiet(f.revision).reasons).toContain('followups_unreconciled');
  f.task.status = 'finished';
  await reconcile(false, true);
  expect(f.admissions.quiet(f.revision).reasons).toContain('followups_unreconciled');
  let reads = 0;
  const before = structuredClone(f.task);
  await f.admissions.reconcile(async () => { reads++; return read(); }, () => f.task,
    () => f.revision, () => true, () => true);
  expect(reads).toBe(1);
  expect(f.admissions.quiet(f.revision).reasons).toContain('followups_unreconciled');
  unavailable = false; completed = true;
  await reconcile(true, true);
  expect(f.task).toEqual(before);
  expect(f.admissions.quiet(f.revision)).toEqual({ ids: [], reasons: [] });
  expect(JSON.parse(readFileSync(join(f.dir, 'task-admissions.json'), 'utf8')).pending).toEqual([]);
  f.task.round = 3; f.task.status = 'running';
  f.admissions.observe(f.task, f.revision);
  expect(f.admissions.epoch(f.task, f.revision)).toBeUndefined();
  expect(new TaskAdmissions(f.dir).quiet(f.revision)).toEqual({ ids: [], reasons: [] });
});

it('requires fresh completion for an unobserved follow-up after losing its connection revision', async () => {
  const f = fixture();
  f.admissions.sending(f.task, 0, envelope, f.revision).acknowledged('fake-message');
  f.task.status = 'running';
  let reads = 0;
  const revision = {};
  const reconcile = (ready = true) => f.admissions.reconcile(async () => { reads++; return { completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [], completed: f.task.status === 'finished' }; },
    () => f.task, () => revision, () => ready);
  await reconcile();
  expect(reads).toBe(1);
  expect(f.admissions.quiet(revision).reasons).toContain('followups_unreconciled');
  f.task.status = 'finished';
  await reconcile(false);
  expect(f.admissions.quiet(revision).reasons).toContain('followups_unreconciled');
  await reconcile();
  expect(reads).toBe(2);
  expect(f.admissions.quiet(revision)).toEqual({ ids: [], reasons: [] });
  f.task.round = 2; f.task.status = 'running';
  f.admissions.observe(f.task, revision);
  expect(f.admissions.quiet(revision)).toEqual({ ids: [], reasons: [] });
  expect(f.admissions.epoch(f.task, revision)).toBeUndefined();
});

it('retires an unobserved ended follow-up by identity anywhere in history without granting an epoch', async () => {
  const f = fixture();
  f.admissions.sending(f.task, 0, envelope, f.revision).acknowledged('fake-message');
  await f.admissions.reconcile(async () => ({ completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [{ turnId: 'fake-turn', id: 'fake-message' }, { turnId: 'fake-turn', id: 'later-message' }], completed: true }),
    () => f.task, () => f.revision);
  expect(f.admissions.quiet(f.revision)).toEqual({ ids: [], reasons: [] });
  f.task.round = 2; f.task.status = 'running';
  f.admissions.observe(f.task, f.revision);
  expect(f.admissions.epoch(f.task, f.revision)).toBeUndefined();
  let reads = 0;
  await f.admissions.reconcile(async () => { reads++; return undefined; }, () => f.task, () => f.revision);
  expect(reads).toBe(0);
  expect(new TaskAdmissions(f.dir).quiet(f.revision)).toEqual({ ids: [], reasons: [] });
});

it('clears a storage failure only after every affected task ends, reconciles and saves successfully', async () => {
  const f = fixture();
  const second = { ...f.task, id: '00000000-0000-4000-8000-000000000089' };
  const path = join(f.dir, 'task-admissions.json');
  mkdirSync(path);
  f.admissions.sending(f.task, 0, envelope, f.revision).acknowledged('first-message');
  f.admissions.sending(second, 0, envelope, f.revision).acknowledged('second-message');
  f.task.round = 2; f.task.status = 'running';
  second.round = 2; second.status = 'running';
  const lookup = (worker: string) => worker === id ? f.task : second;
  const reconcile = (admissions: TaskAdmissions, ready = true) => admissions.reconcile(async (worker) => ({
    completionTurnId: 'fake-turn', subsequentTurnIds: [], messages: [], completed: ['finished', 'stopped'].includes(lookup(worker).status),
  }),
    lookup, () => f.revision, () => ready);
  f.admissions.observe(f.task, f.revision);
  f.admissions.observe(second, f.revision);
  rmSync(path, { recursive: true });
  await reconcile(f.admissions);
  const restarted = new TaskAdmissions(f.dir);
  expect(restarted.quiet().reasons).toContain('followups_unavailable');
  f.task.status = 'finished';
  await reconcile(restarted);
  expect(restarted.quiet().reasons).toContain('followups_unavailable');
  second.status = 'stopped';
  await reconcile(restarted, false);
  expect(restarted.quiet().reasons).toContain('followups_unavailable');
  rmSync(path); mkdirSync(path);
  await reconcile(restarted);
  expect(restarted.quiet().reasons).toContain('followups_unavailable');
  rmSync(path, { recursive: true });
  await reconcile(restarted);
  expect(restarted.quiet()).toEqual({ ids: [], reasons: [] });
  expect(new TaskAdmissions(f.dir).quiet()).toEqual({ ids: [], reasons: [] });
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ unavailable: false, unavailableTasks: [] });
});


it.each(['launch', 'follow-up'].flatMap((kind) => ['same turn', 'schedule turn', 'missing turn', 'mixed turns'].map((history) => ({ kind, history }))))(
  'binds a held $kind relay to its receiving run with $history', async ({ kind, history }) => {
    const f = fixture();
    const messageId = 'fake-submission';
    if (kind === 'launch') f.admissions.started(id, 0, messageId, f.revision);
    else {
      f.admissions.sending(f.task, 0, envelope, f.revision).acknowledged(messageId);
      f.task.round = 2;
    }
    f.task.status = 'running';
    f.admissions.observe(f.task, f.revision);
    const evidence = { messages: [{ id: messageId, turnId: 'fake-receiving-turn' }], completed: false,
      completionTurnId: 'fake-receiving-turn', subsequentTurnIds: ['fake-receiving-turn'] as Array<string | undefined> };
    await f.admissions.reconcile(async () => evidence, () => f.task, () => f.revision);
    expect(f.admissions.epoch(f.task, f.revision)).toBe(0);
    f.task.status = 'finished';
    evidence.completed = true;
    if (history === 'schedule turn') evidence.completionTurnId = 'fake-schedule-turn';
    if (history === 'missing turn') evidence.subsequentTurnIds = [undefined];
    if (history === 'mixed turns') evidence.subsequentTurnIds = ['fake-schedule-turn', 'fake-receiving-turn'];
    expect(await f.admissions.relayEpoch(f.task, async () => evidence, () => f.revision)).toBe(history === 'same turn' ? 0 : undefined);
  },
);

it.each(['launch', 'follow-up'])('drops a %s record when its task leaves the ledger without reading', async (kind) => {
  const f = fixture();
  if (kind === 'launch') f.admissions.started(id, 0, 'fake-message', f.revision);
  else f.admissions.sending(f.task, 0, envelope, f.revision).acknowledged('fake-message');
  let reads = 0;
  await f.admissions.reconcile(async () => { reads++; throw new Error('Fixture provider unavailable'); }, () => undefined, () => f.revision);
  expect(reads).toBe(0);
  expect(f.admissions.quiet()).toEqual({ ids: [], reasons: [] });
  expect(new TaskAdmissions(f.dir).quiet()).toEqual({ ids: [], reasons: [] });
});

it('drops a launch identity absent from the history tail after one read', async () => {
  const f = fixture();
  f.admissions.started(id, 0, 'fake-message', f.revision);
  let reads = 0;
  const reconcile = () => f.admissions.reconcile(async () => { reads++; return { messages: [], completed: false }; }, () => f.task, () => f.revision);
  await reconcile(); await reconcile();
  expect(reads).toBe(1);
  expect(f.admissions.epoch(f.task, f.revision)).toBeUndefined();
});
