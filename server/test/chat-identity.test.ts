import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatIdentity } from '../src/hermes/identity.js';

describe('durable Hermes chat identity', () => {
  it('resolves the full chain and original budget root across reloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-chat-moves-'));
    const identity = new ChatIdentity(dir);
    identity.record('demo-original', 'demo-middle');
    identity.record('demo-middle', 'demo-current');
    const reloaded = new ChatIdentity(dir);
    for (const id of ['demo-original', 'demo-middle', 'demo-current']) {
      expect(reloaded.resolve(id)).toBe('demo-current');
      expect(reloaded.root(id)).toBe('demo-original');
    }
    expect(statSync(join(dir, 'hermes-chat-moves.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'hermes-chat-moves.json'), 'utf8')).not.toContain('title');
  });

  it('does not forget an old move after more than 200 compressions', () => {
    const identity = new ChatIdentity(null);
    for (let i = 0; i < 205; i++) identity.record(`demo-chat-${i}`, `demo-chat-${i + 1}`);
    expect(identity.resolve('demo-chat-0')).toBe('demo-chat-205');
    expect(identity.root('demo-chat-205')).toBe('demo-chat-0');
  });

  it.each([false, true])('refines shortcut reports with a complete lineage across reloads: %s', (reload) => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-chat-moves-'));
    let identity = new ChatIdentity(dir);
    identity.record('demo-prefix', 'demo-original');
    identity.record('demo-original', 'demo-current');
    identity.record('demo-middle', 'demo-current');
    if (reload) identity = new ChatIdentity(dir);
    identity.recordLineage(['demo-original', 'demo-middle', 'demo-current']);
    const reloaded = new ChatIdentity(dir);
    for (const id of ['demo-prefix', 'demo-original', 'demo-middle', 'demo-current']) {
      expect(identity.resolve(id)).toBe('demo-current');
      expect(reloaded.resolve(id)).toBe('demo-current');
      expect(reloaded.root(id)).toBe('demo-prefix');
    }
    expect(JSON.parse(readFileSync(join(dir, 'hermes-chat-moves.json'), 'utf8'))).toEqual({
      moves: [['demo-prefix', 'demo-original'], ['demo-original', 'demo-middle'], ['demo-middle', 'demo-current']],
      uncertain: [],
    });
  });

  it('reconciles multiple shortcut reports before preserving later continuations and budget roots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-chat-moves-'));
    const identity = new ChatIdentity(dir);
    identity.record('demo-original', 'demo-current');
    identity.record('demo-middle', 'demo-current');
    identity.record('demo-current', 'demo-latest');
    identity.recordLineage(['demo-original', 'demo-first', 'demo-middle', 'demo-last', 'demo-current']);
    identity.recordLineage(['demo-original', 'demo-first', 'demo-middle', 'demo-last', 'demo-current']);
    identity.record('demo-original', 'demo-current');
    identity.record('demo-middle', 'demo-latest');
    const reloaded = new ChatIdentity(dir);
    for (const id of ['demo-original', 'demo-first', 'demo-middle', 'demo-last', 'demo-current', 'demo-latest']) {
      expect(reloaded.resolve(id)).toBe('demo-latest');
      expect(reloaded.root(id)).toBe('demo-original');
    }
  });

  it.each(['fork', 'reverse', 'cycle', 'merge'] as const)('holds a genuine %s without partially installing its lineage', (kind) => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-chat-moves-'));
    const identity = new ChatIdentity(dir);
    if (kind === 'fork') identity.record('demo-middle', 'demo-other');
    if (kind === 'reverse') identity.record('demo-current', 'demo-middle');
    if (kind === 'cycle') identity.record('demo-current', 'demo-original');
    if (kind === 'merge') identity.record('demo-other', 'demo-current');
    const before = [...identity.moves];
    expect(() => identity.recordLineage(['demo-original', 'demo-middle', 'demo-current'])).toThrow('uncertain');
    expect([...identity.moves]).toEqual(before);
    const reloaded = new ChatIdentity(dir);
    expect([...reloaded.moves]).toEqual(before);
    for (const id of ['demo-original', 'demo-middle', 'demo-current']) {
      expect(() => identity.resolve(id)).toThrow('uncertain');
      expect(() => reloaded.resolve(id)).toThrow('uncertain');
    }
    if (kind === 'fork' || kind === 'merge') expect(() => reloaded.resolve('demo-other')).toThrow('uncertain');
    expect(reloaded.resolve('demo-unrelated')).toBe('demo-unrelated');
  });

  it('keeps previously uncertain reports held even if a later lineage includes their endpoints', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-chat-moves-'));
    const identity = new ChatIdentity(dir);
    identity.record('demo-original', 'demo-current');
    identity.record('demo-original', 'demo-other');
    const reloaded = new ChatIdentity(dir);
    expect(() => reloaded.recordLineage(['demo-original', 'demo-middle', 'demo-current'])).toThrow('uncertain');
    for (const id of ['demo-original', 'demo-middle', 'demo-current', 'demo-other']) {
      expect(() => new ChatIdentity(dir).resolve(id)).toThrow('uncertain');
    }
  });

  it('holds a reconciled lineage until the complete update is durably saved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-chat-moves-'));
    const identity = new ChatIdentity(dir);
    identity.record('demo-original', 'demo-current');
    const path = join(dir, 'hermes-chat-moves.json');
    const before = readFileSync(path, 'utf8');
    mkdirSync(`${path}.tmp`);
    expect(() => identity.recordLineage(['demo-original', 'demo-middle', 'demo-current'])).toThrow();
    for (const id of ['demo-original', 'demo-middle', 'demo-current']) {
      expect(() => identity.resolve(id)).toThrow('saved or loaded');
    }
    expect(readFileSync(path, 'utf8')).toBe(before);
    rmSync(`${path}.tmp`, { recursive: true });
    identity.recordLineage(['demo-original', 'demo-middle', 'demo-current']);
    const reloaded = new ChatIdentity(dir);
    expect(reloaded.resolve('demo-middle')).toBe('demo-current');
    expect(reloaded.root('demo-current')).toBe('demo-original');
  });

  it.each([[], ['demo-original'], ['demo-original', 'demo-original'], ['demo-original', '../demo-current']].map((ids) => ({ ids })))(
    'rejects malformed lineage without changing its durable identity: %j', ({ ids }) => {
      const dir = mkdtempSync(join(tmpdir(), 'sb-chat-moves-'));
      const identity = new ChatIdentity(dir);
      identity.record('demo-original', 'demo-current');
      const before = readFileSync(join(dir, 'hermes-chat-moves.json'), 'utf8');
      expect(() => identity.recordLineage(ids)).toThrow('Invalid');
      expect(readFileSync(join(dir, 'hermes-chat-moves.json'), 'utf8')).toBe(before);
      expect(identity.resolve('demo-original')).toBe('demo-current');
    },
  );

  it.each(['cycle', 'conflict'] as const)('holds uncertain %s identities after reload', (kind) => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-chat-moves-'));
    const identity = new ChatIdentity(dir);
    identity.record('demo-original', 'demo-current');
    if (kind === 'cycle') identity.record('demo-current', 'demo-original');
    else identity.record('demo-original', 'demo-other');
    const reloaded = new ChatIdentity(dir);
    expect(() => reloaded.resolve('demo-original')).toThrow('uncertain');
    expect(() => reloaded.root('demo-current')).toThrow('uncertain');
    expect(reloaded.resolve('demo-unrelated')).toBe('demo-unrelated');
  });

  it.each(['{', '{"moves":[["demo-old", 7]],"uncertain":[]}'])('holds an unreadable identity file without replacing it', (text) => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-chat-moves-'));
    writeFileSync(join(dir, 'hermes-chat-moves.json'), text);
    const identity = new ChatIdentity(dir);
    expect(() => identity.resolve('demo-old')).toThrow('saved or loaded');
    expect(() => identity.record('demo-old', 'demo-new')).toThrow('loaded');
    expect(() => identity.recordLineage(['demo-old', 'demo-new'])).toThrow('loaded');
    expect(readFileSync(join(dir, 'hermes-chat-moves.json'), 'utf8')).toBe(text);
  });
});
