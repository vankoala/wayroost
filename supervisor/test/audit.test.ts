import { afterEach, expect, it, vi } from 'vitest';
import * as fsSync from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Actions } from '../src/actions.js';
import { audit, auditedIds } from '../src/audit.js';
import { configSchema } from '../src/config.js';
import type { Component } from '../src/registry.js';
import type { ActionDetail } from '../../shared/supervisor.js';
import { trustAny } from './fixtures.js';

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof fsSync>();
  return { ...original, createReadStream: vi.fn(original.createReadStream) };
});

const folders: string[] = [];
afterEach(async () => { vi.mocked(fsSync.createReadStream).mockClear(); await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
const demo: Component = { id: 'demo', name: 'Demo', health: { kind: 'none' }, busy: { kind: 'none' }, gpus: [], start: ['demo', 'start'], restart: ['demo', 'restart'] };

it('startup reads the audit log once, however many completed records it reconciles', async () => {
  const folder = await mkdtemp(join(process.cwd(), '.supervisor-audit-')); folders.push(folder);
  await mkdir(join(folder, 'actions'));
  const records = Array.from({ length: 50 }, (_, index) => ({ id: 'obviously-fake-audited-' + index, verb: 'restart', target: 'demo', caller: 'demo', state: 'done', startedAt: index + 1, endedAt: index + 2 }));
  for (const record of records) await writeFile(join(folder, 'actions', record.id + '.json'), JSON.stringify(record));
  // Every record but the last is already audited; the last one's audit line was lost.
  await writeFile(join(folder, 'audit.jsonl'), records.slice(0, -1).map(record => JSON.stringify({ id: record.id })).join('\n') + '\n');
  const config = configSchema.parse({ development: true, stateDir: folder, socket: join(folder, 'socket'), statusOnly: false, pollMs: 2 });
  const actions = new Actions([demo], { async run() { return 0; } }, config, undefined, trustAny);
  await actions.initialize(); await actions.close();
  const auditReads = vi.mocked(fsSync.createReadStream).mock.calls.filter(([path]) => String(path).endsWith('audit.jsonl'));
  expect(auditReads).toHaveLength(1);
  const rows = (await readFile(join(folder, 'audit.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row) as { id: string });
  expect(rows.map(row => row.id)).toEqual(records.map(record => record.id));
  // A second startup appends nothing more.
  const again = new Actions([demo], { async run() { return 0; } }, config, undefined, trustAny);
  await again.initialize(); await again.close();
  expect((await readFile(join(folder, 'audit.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(records.length);
});

it.each(['partial-first', 'partial-last', 'complete-last', 'large-partial-last', 'interrupted-action'] as const)
('startup repairs an interrupted audit tail (%s) and repeated recovery adds no duplicates', async tail => {
  const folder = await mkdtemp(join(process.cwd(), '.supervisor-audit-')); folders.push(folder);
  await mkdir(join(folder, 'actions'));
  const records: ActionDetail[] = ['first', 'second', 'third'].map((name, index) => ({ id: 'obviously-fake-' + name, verb: 'restart', target: 'demo',
    caller: 'Démo', state: 'done', startedAt: index + 1, endedAt: index + 2, lines: [] }));
  if (tail === 'interrupted-action') { records[1]!.state = 'running'; delete records[1]!.endedAt; }
  for (const { lines: _lines, ...record } of records) await writeFile(join(folder, 'actions', record.id + '.json'), JSON.stringify(record));
  const prefix = tail === 'partial-first' ? '' : JSON.stringify({ id: records[0]!.id, caller: 'Démo' }) + '\n';
  const final = tail === 'complete-last' ? JSON.stringify({ id: records[1]!.id })
    : '{"id":"' + records[1]!.id + '","caller":"' + (tail === 'large-partial-last' ? 'x'.repeat(131072) : 'Démo');
  await writeFile(join(folder, 'audit.jsonl'), prefix + final);
  const config = configSchema.parse({ development: true, stateDir: folder, socket: join(folder, 'socket'), statusOnly: false, pollMs: 2 });
  const initialize = async () => {
    const actions = new Actions([demo], { async run() { return 0; } }, config, undefined, trustAny);
    try { await actions.initialize(); } finally { await actions.close(); }
  };
  await initialize();
  const recovered = await readFile(join(folder, 'audit.jsonl'), 'utf8');
  const rows = recovered.trimEnd().split('\n').map(row => JSON.parse(row) as { id: string; outcome?: string });
  expect(rows.map(row => row.id).sort()).toEqual(records.map(record => record.id).sort());
  expect(recovered.startsWith(prefix)).toBe(true);
  expect(recovered.endsWith('\n')).toBe(true);
  if (tail === 'interrupted-action') expect(rows.find(row => row.id === records[1]!.id)?.outcome).toBe('failed');
  expect(await auditedIds(folder)).toEqual(new Set(records.map(record => record.id)));
  await initialize();
  expect(await readFile(join(folder, 'audit.jsonl'), 'utf8')).toBe(recovered);
});

it('a normal action append repairs a partial audit tail before writing its record', async () => {
  const folder = await mkdtemp(join(process.cwd(), '.supervisor-audit-')); folders.push(folder);
  const action: ActionDetail = { id: 'obviously-fake-completed', verb: 'restart', target: 'demo', caller: 'demo', state: 'done', startedAt: 1, endedAt: 2, lines: [] };
  await writeFile(join(folder, 'audit.jsonl'), '{"id":"obviously-fake-incomplete');
  await audit(folder, action); await audit(folder, action);
  expect(JSON.parse(await readFile(join(folder, 'audit.jsonl'), 'utf8'))).toMatchObject({ id: action.id, outcome: 'done' });
  expect(await auditedIds(folder)).toEqual(new Set([action.id]));
});
