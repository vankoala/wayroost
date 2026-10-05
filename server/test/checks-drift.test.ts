// The drift rows: what counts as drift and what doesn't. Drift is a value the
// consumer's reader finds different from the value Wayroost last wrote — never a
// content hash, never a modification time. A stale page's save is one signature:
// several keys back at what they held before the change.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEMO_MAIN_ADDRESS, DEMO_MOVED_AT, DEMO_STATE, fixtures, hashOf, moveRecord, rowOf, writtenKey,
} from './checks-fixtures.js';

const REAPPLY = { operation: 'gateway.reapply-intended', params: { consumer: 'hermes', target: 'hermes-config' } };

/** Hermes moved onto roles, with these keys recorded as written and these live values. */
function movedHermes(
  keys: Record<string, { before?: unknown; intended: unknown }>,
  live: Record<string, unknown>,
  input: Parameters<typeof fixtures>[0] = {},
) {
  return fixtures({
    ...input,
    documents: {
      ...input.documents,
      'hermes-config': {
        model: { provider: 'demo-local', default: 'demo-model', base_url: 'http://127.0.0.1:19001/v1' },
        providers: { 'demo-local': { base_url: 'http://127.0.0.1:19001/v1' } },
        approvals: { mode: 'manual' },
        display: { personality: 'warm' },
        ...live,
        ...input.documents?.['hermes-config'],
      },
      'gateway-state': {
        state: DEMO_STATE,
        migration: {
          version: 1,
          consumers: {
            hermes: {
              'hermes-config': moveRecord(Object.entries(keys).map(([name, entry]) => writtenKey(name.split('.'), entry.before, entry.intended))),
            },
          },
        },
        ...input.documents?.['gateway-state'],
      },
    },
  });
}

/** The two keys Wayroost wrote, as a record. */
const WRITTEN = { 'approvals.mode': { before: 'smart', intended: 'manual' }, 'display.personality': { before: 'warm', intended: 'focused' } };

describe('hermes.drift compares values, and only values', () => {
  it('is quiet while every written key holds what Wayroost wrote', async () => {
    const rows = await movedHermes(WRITTEN, { approvals: { mode: 'manual' }, display: { personality: 'focused' } }).rows();
    expect(rowOf(rows, 'hermes.drift').state).toBe('ok');
    expect(rowOf(rows, 'hermes.stale-page').state).toBe('ok');
  });

  it('warns when a written key holds a different value, and names the key, not its values', async () => {
    const rows = await movedHermes(WRITTEN, { approvals: { mode: 'off' }, display: { personality: 'focused' } }).rows();
    const drift = rowOf(rows, 'hermes.drift');
    expect(drift.state).toBe('warn');
    expect(drift.sentence).toContain('a different value');
    expect(drift.details ?? []).toEqual(['approvals.mode']);
    expect(`${drift.sentence} ${(drift.details ?? []).join(' ')}`).not.toMatch(/manual|"off"/);
    expect(drift.fix).toEqual(REAPPLY);
  });

  it('says the page was stale when several keys are back at their older values', async () => {
    const rows = await movedHermes(WRITTEN, { approvals: { mode: 'smart' }, display: { personality: 'warm' } }).rows();
    expect(rowOf(rows, 'hermes.drift').state).toBe('ok');
    const stale = rowOf(rows, 'hermes.stale-page');
    expect(stale.state).toBe('warn');
    expect(stale.details ?? []).toEqual(['approvals.mode', 'display.personality']);
    expect(stale.fix).toEqual(REAPPLY);
  });

  it('is not drift when the content hash moved and every value stayed', async () => {
    const base = movedHermes(WRITTEN, { approvals: { mode: 'manual' }, display: { personality: 'focused' } });
    const readView = base.sources.readView!;
    const rows = await base.rows({
      readView: async view => ({ ...await readView(view) as object, sha256: hashOf('a different file holding the same values') }),
    });
    expect(rowOf(rows, 'hermes.drift').state).toBe('ok');
    expect(rowOf(rows, 'hermes.stale-page').state).toBe('ok');
  });

  it('is not drift when only the modification time moved', async () => {
    // Touching a file preserves its content hash.
    // The reader hands out no mtime at all, so no check can compare one.
    const dir = mkdtempSync(join(tmpdir(), 'wayroost-checks-mtime-'));
    try {
      const file = join(dir, 'config.yaml');
      writeFileSync(file, 'approvals:\n  mode: manual\n');
      const before = readFileSync(file, 'utf8');
      utimesSync(file, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
      const after = readFileSync(file, 'utf8');
      expect(createHash('sha256').update(after).digest('hex')).toBe(createHash('sha256').update(before).digest('hex'));
      const rows = await movedHermes({ 'approvals.mode': { before: 'smart', intended: 'manual' } }, { approvals: { mode: 'manual' } }).rows();
      expect(rowOf(rows, 'hermes.drift').state).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats an empty personality as the absence Hermes means by it', async () => {
    // Wayroost wrote the key away; Hermes keeps the group with an empty string.
    const quiet = await movedHermes({ 'display.personality': { before: 'warm', intended: undefined } }, { display: { personality: '' } }).rows();
    expect(rowOf(quiet, 'hermes.drift').state).toBe('ok');
    // A real value where the record says absent is drift.
    const loud = await movedHermes({ 'display.personality': { before: 'warm', intended: undefined } }, { display: { personality: 'warm' } }).rows();
    expect(rowOf(loud, 'hermes.drift').state).toBe('warn');
  });

  it('is unknown when the effective settings cannot be read', async () => {
    const rows = await fixtures({ refusals: { 'hermes.models': 'parse_failed' } }).rows();
    expect(rowOf(rows, 'hermes.drift').state).toBe('unknown');
    expect(rowOf(rows, 'hermes.stale-page').state).toBe('unknown');
  });
});

describe('hermes.role-addresses', () => {
  /** A moved Hermes whose model block holds exactly these values. */
  const withModel = (model: Record<string, unknown>, input: Parameters<typeof fixtures>[0] = {}) => movedHermes(
    {
      'model.provider': { before: 'demo-local', intended: 'wayroost-main' },
      'model.default': { before: 'demo-model', intended: 'main' },
      'model.base_url': { before: 'http://127.0.0.1:19001/v1', intended: DEMO_MAIN_ADDRESS },
    },
    { model: { provider: 'wayroost-main', default: 'main', base_url: DEMO_MAIN_ADDRESS, ...model } },
    input,
  );

  it('is quiet while the move is not in place', async () => {
    expect(rowOf(await fixtures().rows(), 'hermes.role-addresses').state).toBe('ok');
  });

  it('is quiet when a moved Hermes points where the roles say', async () => {
    expect(rowOf(await withModel({}).rows(), 'hermes.role-addresses').state).toBe('ok');
  });

  it('warns when Hermes points at roles although nothing pins it', async () => {
    const rows = await fixtures({
      documents: { 'hermes-config': { model: { provider: 'wayroost-main', default: 'main', base_url: DEMO_MAIN_ADDRESS } } },
    }).rows();
    const row = rowOf(rows, 'hermes.role-addresses');
    expect(row.state).toBe('warn');
    expect(row.sentence).toMatch(/not recorded as moved/);
  });

  it('fails when a moved Hermes key names another role, with re-apply as the fix', async () => {
    const row = rowOf(await withModel({ provider: 'wayroost-fast', default: 'coder', base_url: 'http://127.0.0.1:19999/v1' }).rows(), 'hermes.role-addresses');
    expect(row.state).toBe('fail');
    expect(row.details ?? []).toEqual(['model.provider', 'model.default', 'model.base_url']);
    expect(row.fix).toEqual(REAPPLY);
  });

  it('is unknown when this PC states no role address', async () => {
    const rows = await withModel({}, { deployment: { roleAddresses: undefined } }).rows();
    expect(rowOf(rows, 'hermes.role-addresses').state).toBe('unknown');
    expect(rowOf(rows, 'gateway.socket-unit').state).toBe('unknown');
  });

  it('is unknown when Hermes settings cannot be read', async () => {
    const rows = await fixtures({ refusals: { 'hermes.models': 'not_configured' } }).rows();
    expect(rowOf(rows, 'hermes.role-addresses').state).toBe('unknown');
  });
});
