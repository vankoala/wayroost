import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_ARGS_DEPTH, hashToolArguments, hashToolErrorClass, toolCallOutcomeSchema } from '../../shared/tool-call-outcome.js';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const ok = { agentId: 'demo-agent', tool: 'read', argsHash: sha256('json:{"path":"notes.md"}'), ok: true, at: 1_700_000_000_000 };
const failed = { ...ok, ok: false, errorClass: sha256('file not found: notes.md') };

describe('a tool call outcome', () => {
  it('takes a tool name, hashes and ok, with an error class hash for a failure', () => {
    expect(toolCallOutcomeSchema.safeParse(ok).success).toBe(true);
    expect(toolCallOutcomeSchema.safeParse(failed).success).toBe(true);
    expect(toolCallOutcomeSchema.safeParse({ ...failed, errorClass: sha256('') }).success).toBe(true);
  });

  it.each([
    ['argsJson', '{"path":"notes.md"}'],
    ['args', { path: 'notes.md' }],
    ['errorText', 'file not found: notes.md'],
    ['result', 'secret output'],
  ])('refuses content in %s', (field, value) => {
    expect(toolCallOutcomeSchema.safeParse({ ...failed, [field]: value }).success).toBe(false);
  });

  it('takes hashes only, not text, in both hash fields', () => {
    expect(toolCallOutcomeSchema.safeParse({ ...ok, argsHash: '{"path":"notes.md"}' }).success).toBe(false);
    expect(toolCallOutcomeSchema.safeParse({ ...failed, errorClass: 'file not found: <value>' }).success).toBe(false);
    expect(toolCallOutcomeSchema.safeParse({ ...ok, argsHash: sha256('x').toUpperCase() }).success).toBe(false);
  });

  it('requires a digest on failures and allows reporters to include one on success', () => {
    expect(toolCallOutcomeSchema.safeParse({ ...ok, errorClass: sha256('') }).success).toBe(true);
    expect(toolCallOutcomeSchema.safeParse({ ...ok, errorClass: 'normalised error text' }).success).toBe(false);
    const { errorClass: _errorClass, ...withoutClass } = failed;
    expect(toolCallOutcomeSchema.safeParse(withoutClass).success).toBe(false);
  });

  it('hashes canonical JSON with sorted keys at every depth', async () => {
    const expected = '18078357412644c03d2c806b244e9579d' + '3daa1415c69334c8512bcf02b71145f';
    expect(await hashToolArguments('{"b":{"y":3,"x":2},"a":1}')).toBe(expected);
    expect(await hashToolArguments(' { "a": 1, "b": { "x": 2, "y": 3 } } ')).toBe(expected);
    expect(await hashToolArguments('{"2":"two","a":1,"10":"ten"}'))
      .toBe('1961cc696b53917ce963a2c6df065173' + 'a296ac74bbe041c3a3706d4b580e3521');
    expect(await hashToolArguments('[3,1,2]')).toBe('b47b49c278693e7bc708c145c79624eae' + 'edbd94325951b58942f794788573918');
    expect(await hashToolArguments('[1,2,3]')).not.toBe(await hashToolArguments('[3,1,2]'));
  });

  it('normalises raw arguments and separates them from JSON strings', async () => {
    expect(await hashToolArguments(' read\n\t notes.md ')).toBe('71e9675964337d06c70be4c4edc4d82e' + '74564ddcc9c2bf6e2e4953f55353d14d');
    expect(await hashToolArguments('null broken')).toBe('5ab536ccd4247bb62d3cf72658083f3de' + '0869058c10ee7d2ad6795ce223ff9ab');
    expect(await hashToolArguments('"read notes.md"')).toBe('b63e6857f9101be3b3e7e42df9455ca9' + '7a62ba0974c68126ee9b2c727ca0be90');
  });

  it('hashes nesting past the fixed depth limit as raw text, whatever the stack size', async () => {
    const deep = '{"payload":' + '['.repeat(4_096) + '0' + ']'.repeat(4_096) + '}';
    expect(() => JSON.parse(deep)).not.toThrow();
    expect(await hashToolArguments(deep)).toBe(sha256('raw:' + deep));
    expect(await hashToolArguments(' \n\t' + deep + ' \n')).toBe(sha256('raw:' + deep));
    // Exactly at the limit still canonicalises; one level more falls back.
    const atLimit = '['.repeat(MAX_ARGS_DEPTH) + '0' + ']'.repeat(MAX_ARGS_DEPTH);
    expect(await hashToolArguments(atLimit)).toBe(sha256('json:' + atLimit));
    const overLimit = '['.repeat(MAX_ARGS_DEPTH + 2) + '0' + ']'.repeat(MAX_ARGS_DEPTH + 2);
    expect(await hashToolArguments(overLimit)).toBe(sha256('raw:' + overLimit));
  });

  it('hashes only the normalised first error line with stable vectors', async () => {
    const expected = '1e69fa432bbb13d7edc4d20a11374954a' + 'a81b4bef0562fd754d7d34df19f6995';
    expect(await hashToolErrorClass('FAILED at 0xDEADBEEF with code 42\r\nprivate second line')).toBe(expected);
    expect(await hashToolErrorClass('failed at abcdef12 with code 99')).toBe(expected);
    expect(await hashToolErrorClass()).toBe('e3b0c44298fc1c149afbf4c8996fb924' + '27ae41e4649b934ca495991b7852b855');
    expect(await hashToolErrorClass('failed at abc123 with code a42')).not.toBe(expected);
    expect(toolCallOutcomeSchema.safeParse({ ...failed, errorClass: await hashToolErrorClass('demo failure') }).success).toBe(true);
  });

  it('refuses odd names and times', () => {
    expect(toolCallOutcomeSchema.safeParse({ ...ok, tool: 'read file' }).success).toBe(false);
    expect(toolCallOutcomeSchema.safeParse({ ...ok, tool: '' }).success).toBe(false);
    expect(toolCallOutcomeSchema.safeParse({ ...ok, agentId: '../demo' }).success).toBe(false);
    expect(toolCallOutcomeSchema.safeParse({ ...ok, at: Number.NaN }).success).toBe(false);
    expect(toolCallOutcomeSchema.safeParse({ ...ok, at: Number.POSITIVE_INFINITY }).success).toBe(false);
  });
});
