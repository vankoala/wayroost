import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChecksState, type IntentFact } from '../src/checks/state.js';
import type { SettingsAuditEntry } from '../src/settings/audit.js';
import { SettingsAudit } from '../src/settings/audit.js';
import { randomUUID } from 'node:crypto';
import { fixtures, rowOf, DEMO_MOVED_AT, DEMO_STATE, moveRecord, writtenKey, hashOf } from './checks-fixtures.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() { const root = await mkdtemp(join(tmpdir(), 'wayroost-checks-state-')); roots.push(root); return root; }
const entry = (id: string, at: number, patch: Partial<SettingsAuditEntry> = {}): SettingsAuditEntry => ({
  id, at, action: 'apply', operation: 'hermes.personality', target: 'hermes-config', keys: ['display.personality'],
  level: 'anywhere', timing: ['next-turn'], notes: [{ label: 'next-turn' }], result: 'ok', ...patch,
});
const fact = (id: string, value: string, at: number): IntentFact => ({ id, target: 'hermes-config', operation: 'hermes.personality',
  params: { personality: value }, confirmedAt: at, keys: [{ path: ['display', 'personality'],
    before: { exists: true, value: 'previous' }, intended: { exists: true, value } }],
});

describe('bounded durable intent', () => {
  it('keeps a checkpoint boundary fixed when an earlier timer completes after later changes', async () => {
    const root = await temporary(); const state = new ChecksState(root); const audit = new SettingsAudit(root);
    const timer = 'ch_' + '1'.repeat(24); const later = 'ch_' + '2'.repeat(24);
    const modeFact = (id: string, mode: string): IntentFact => ({ id, target: 'hermes-config', operation: 'hermes.approval-mode',
      params: { mode }, keys: [{ path: ['approvals', 'mode'], before: { exists: true, value: 'smart' }, intended: { exists: true, value: mode } }] });
    try {
      await state.record(modeFact(timer, 'manual'));
      const pending = entry(timer, 1, { operation: 'hermes.approval-mode', result: 'outcome_unknown', runId: randomUUID(), keys: ['approvals.mode'] });
      audit.record(pending, pending.notes);
      for (let i = 0; i < 255; i++) await state.record(fact(`example-filler-${i}`, 'focused', 2));
      await state.record(fact('example-checkpoint', 'focused', 2), audit.entries());
      const checkpoint = JSON.parse(await readFile(join(root, 'settings-checks-state.json'), 'utf8')).checkpoint;
      expect(checkpoint.through).toBe(timer);
      await state.record({ ...modeFact(later, 'off'), confirmedAt: 2 });
      const subsequent = entry(later, 2, { operation: 'hermes.approval-mode', keys: ['approvals.mode'] }); audit.record(subsequent, subsequent.notes);
      expect((await state.effective(audit.entries())).intended.find(key => key.path.join('.') === 'approvals.mode')?.intended.value).toBe('off');
      await state.confirm(timer, 3); audit.record({ ...pending, result: 'ok' }, pending.notes);
      expect(audit.entries().map(item => item.id)).toEqual([timer, later]);
      expect(audit.recent()[0]!.id).toBe(timer);
      const effective = (await new ChecksState(root).effective(audit.entries())).intended.find(key => key.path.join('.') === 'approvals.mode')!;
      expect(effective).toMatchObject({ intended: { value: 'manual' }, factId: timer, at: 3 });
      expect(await state.reapply(effective.intentId!, audit.entries())).toMatchObject({ params: { mode: 'manual' } });
      await state.record(fact('example-next-checkpoint', 'focused', 4), audit.entries());
      expect((await state.effective(audit.entries())).intended.find(key => key.path.join('.') === 'approvals.mode')?.intended.value).toBe('manual');
    } finally { audit.close(); }
  });
  it('restores revocation evidence and its confirmation time when undoing an undo', async () => {
    const root = await temporary(); const state = new ChecksState(root);
    const entrySha256 = hashOf('echo example');
    const revoke: IntentFact = { id: 'example-revoke', target: 'hermes-config', operation: 'hermes.revoke-always',
      entrySha256, confirmedAt: 1000, keys: [] };
    await state.record(revoke);
    const history = [entry(revoke.id, 900, { operation: revoke.operation })];
    let previous = revoke.id;
    for (const [index, at] of [2000, 3000, 4000, 5000].entries()) {
      const id = `example-undo-${index}`;
      await state.confirmUndo(id, previous, at, history);
      history.push(entry(id, at - 100, { action: 'undo', undoOf: previous, operation: revoke.operation }));
      const effective = await new ChecksState(root).effective(history);
      expect(effective.revocations).toEqual(index % 2 ? [{ entrySha256, revokedAt: at }] : []);
      if (index % 2) {
        const rows = await fixtures({ documents: { 'hermes-config': { command_allowlist: ['echo example'] } },
          sources: { revocations: async () => effective.revocations, hermesStartedAt: async () => at - 1 } }).rows();
        expect(rowOf(rows, 'allowlist.revoke-pending').state).toBe('warn');
        expect(rowOf(rows, 'allowlist.revoke-back').state).toBe('fail');
      }
      previous = id;
    }
  });

  it('resolves legacy revocation undo chains without stored effective flags', async () => {
    const root = await temporary(); const state = new ChecksState(root);
    const entrySha256 = hashOf('echo example');
    const history: SettingsAuditEntry[] = [];
    for (let index = 0; index < 3; index++) {
      const id = `example-legacy-${index}`;
      const undoOf = index ? `example-legacy-${index - 1}` : undefined;
      await state.record({ id, target: 'hermes-config', operation: 'hermes.revoke-always', keys: [], entrySha256,
        confirmedAt: 1000 + index, ...(undoOf ? { undoOf } : {}) });
      history.push(entry(id, 1000 + index, { operation: 'hermes.revoke-always', ...(undoOf ? { action: 'undo', undoOf } : {}) }));
    }
    expect((await state.effective(history)).revocations).toEqual([{ entrySha256, revokedAt: 1002 }]);
    for (let index = 0; index < 265; index++) {
      const item = fact(`example-unrelated-${index}`, 'focused', 2000 + index);
      await state.record(item, history); history.push(entry(item.id, 2000 + index));
    }
    const reopened = new ChecksState(root);
    expect((await reopened.effective(history)).revocations).toEqual([{ entrySha256, revokedAt: 1002 }]);
    await reopened.confirmUndo('example-undo-after-compaction', 'example-legacy-2', 3000, history);
    history.push(entry('example-undo-after-compaction', 3000, { action: 'undo', undoOf: 'example-legacy-2', operation: 'hermes.revoke-always' }));
    expect((await reopened.effective(history)).revocations).toEqual([]);
  });

  it('keeps missing successful revocation undo evidence unavailable', async () => {
    const root = await temporary();
    await expect(new ChecksState(root).effective([entry('example-undo', 1000, {
      action: 'undo', undoOf: 'example-missing', operation: 'hermes.revoke-always',
    })])).rejects.toThrow('unavailable');
  });

  it('restores an undone absence by a typed deletion through its original operation', async () => {
    const root = await temporary(); const state = new ChecksState(root);
    const item: IntentFact = { id: 'example-effort', target: 'hermes-config', operation: 'hermes.reasoning-effort',
      params: { effort: 'high' }, confirmedAt: 1000, keys: [{ path: ['agent', 'reasoning_effort'],
        before: { exists: false }, intended: { exists: true, value: 'high' } }] };
    await state.record(item);
    const history = [entry(item.id, 1000, { operation: item.operation })];
    await state.confirmUndo('example-undo-effort', item.id, 2000, history);
    history.push(entry('example-undo-effort', 2000, { action: 'undo', undoOf: item.id, operation: item.operation }));
    const effective = (await state.effective(history)).intended;
    expect(effective[0]!.intended).toEqual({ exists: false });
    expect(effective[0]!.intentId).toMatch(/^[a-f0-9]{64}$/);
    expect(await new ChecksState(root).reapply(effective[0]!.intentId!, history)).toMatchObject({
      operation: 'hermes.reasoning-effort', params: { effort: null }, paths: [['agent', 'reasoning_effort']],
    });
    const rows = await fixtures({ documents: { 'hermes-config': { agent: { reasoning_effort: 'low' } } },
      sources: { intended: async () => effective } }).rows();
    expect(rowOf(rows, 'hermes.drift')).toMatchObject({ state: 'warn' });
    expect(rowOf(rows, 'hermes.drift').fix).toEqual({ operation: 'gateway.reapply-intended',
      params: { consumer: 'hermes', target: 'hermes-config', intentId: effective[0]!.intentId } });
  });
  it('compacts old history before the 4097th fact and preserves effective state and recent undo', async () => {
    const root = await temporary(); const state = new ChecksState(root);
    const facts = Array.from({ length: 4095 }, (_, index) => ({ id: `example-${index}`, target: 'wayroost-settings', keys: [] }));
    const current = fact('example-current', 'focused', 5000);
    const entries = facts.map((item, index) => entry(item.id, index, { target: item.target }));
    entries.push(entry(current.id, 5000));
    await writeFile(join(root, 'settings-checks-state.json'), JSON.stringify({ version: 1, facts: [...facts, current] }));
    const next = fact('example-next', 'concise', 6000);
    await state.record(next, entries);
    entries.push(entry(next.id, 6000));
    expect((await state.effective(entries)).intended[0]!.intended.value).toBe('concise');
    const saved = JSON.parse(await readFile(join(root, 'settings-checks-state.json'), 'utf8'));
    expect(saved.facts.length).toBeLessThan(32);
    expect(saved.checkpoint.through).toBe(current.id);
    await state.confirmUndo('example-undo', next.id, 7000, entries);
    entries.push(entry('example-undo', 6500, { action: 'undo', undoOf: next.id }));
    const restored = (await new ChecksState(root).effective(entries)).intended[0]!;
    expect(restored.intended.value).toBe('previous'); expect(restored.at).toBe(7000);
  });

  it('compacts by bytes before retained history fills the state file', async () => {
    const root = await temporary(); const state = new ChecksState(root);
    const facts = Array.from({ length: 120 }, (_, index) => ({ ...fact(`example-${index}`, 'x'.repeat(2000), index),
      keys: [{ path: ['display', 'personality'], before: { exists: true, value: 'y'.repeat(2000) }, intended: { exists: true, value: 'x'.repeat(2000) } }] }));
    await writeFile(join(root, 'settings-checks-state.json'), JSON.stringify({ version: 1, facts }));
    const entries = facts.map((item, index) => entry(item.id, index));
    await state.record(fact('example-next', 'focused', 1000), entries);
    const bytes = await readFile(join(root, 'settings-checks-state.json'));
    expect(bytes.length).toBeLessThan(100_000);
    expect((await state.effective([...entries, entry('example-next', 1000)])).intended[0]!.intended.value).toBe('focused');
  });

  it('does not accumulate unrelated or failed apply attempts', async () => {
    const root = await temporary(); const state = new ChecksState(root);
    for (let index = 0; index < 4100; index++) await state.record({ id: `example-${index}`, target: 'wayroost-settings', keys: [] });
    await expect(readFile(join(root, 'settings-checks-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const history: SettingsAuditEntry[] = [];
    for (let index = 0; index < 300; index++) {
      const item = fact(`example-failed-${index}`, 'focused', index);
      await state.record(item, history); history.push(entry(item.id, index, { result: 'failed' }));
    }
    expect((await state.effective(history)).intended).toEqual([]);
    expect(JSON.parse(await readFile(join(root, 'settings-checks-state.json'), 'utf8')).facts.length).toBeLessThan(256);
  });

  it('resolves an intent recorded before operation metadata was stored', async () => {
    const root = await temporary(); const state = new ChecksState(root);
    const legacy = fact('example-legacy', 'focused', 1000);
    delete legacy.operation; delete legacy.params;
    await state.record(legacy);
    const entries = [entry(legacy.id, 1000)];
    const keys = (await state.effective(entries)).intended;
    expect(await state.reapply(keys[0]!.intentId!, entries)).toMatchObject({ operation: 'hermes.personality', params: { personality: 'focused' } });
  });

  it('gives a newer gateway move precedence over an older effective undo', async () => {
    const root = await temporary(); const state = new ChecksState(root);
    const movedAt = Date.parse(DEMO_MOVED_AT);
    const item: IntentFact = { id: 'example-model', target: 'hermes-config', confirmedAt: movedAt - 3000,
      keys: [{ path: ['model', 'default'], before: { exists: true, value: 'previous' }, intended: { exists: true, value: 'intermediate' } }] };
    await state.record(item);
    const entries = [entry(item.id, movedAt - 4000, { operation: 'hermes.default-model' })];
    await state.confirmUndo('example-undo', item.id, movedAt - 1000, entries);
    entries.push(entry('example-undo', movedAt - 2000, { action: 'undo', undoOf: item.id, operation: 'hermes.default-model' }));
    const intended = (await state.effective(entries)).intended;
    expect(intended[0]!.at).toBe(movedAt - 1000);
    const rows = await fixtures({ documents: { 'hermes-config': { model: { default: 'main' } }, 'gateway-state': {
      state: DEMO_STATE, migration: { version: 1, consumers: { hermes: { 'hermes-config': moveRecord([writtenKey(['model', 'default'], 'previous', 'main')]) } } },
    } }, sources: { intended: async () => intended } }).rows();
    expect(rowOf(rows, 'hermes.drift').state).toBe('ok');
  });
});
