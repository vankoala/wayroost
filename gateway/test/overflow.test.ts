import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { isContextOverflow } from '../src/overflow.js';

describe('context overflow classification', () => {
  it.each(['llamacpp', 'sglang', 'vllm', 'sglang-total', 'sglang-total-full'])('recognizes the %s JSON error envelope', async engine => {
    const body = await readFile(`gateway/test/fixtures/${engine}-overflow.json`, 'utf8');
    expect(isContextOverflow(body)).toBe(true);
  });
  it.each(['sglang-total', 'sglang-total-full'])('recognizes the %s SSE error envelope', async engine => {
    const body = await readFile(`gateway/test/fixtures/${engine}-overflow.sse`, 'utf8');
    expect(isContextOverflow(body, true)).toBe(true);
    expect(isContextOverflow(body.replaceAll('\n', '\r\n'), true)).toBe(true);
  });
  it('classifies only the first SSE data event after comments and empty lines', async () => {
    const body = await readFile('gateway/test/fixtures/sglang-total-overflow.sse', 'utf8');
    expect(isContextOverflow(`\n: ping\n\n: heartbeat\n\n${body}`, true)).toBe(true);
    expect(isContextOverflow(`data: {"choices":[]}\n\n${body}`, true)).toBe(false);
    expect(isContextOverflow(`data:\n\n${body}`, true)).toBe(false);
    expect(isContextOverflow(`data: malformed\n\n${body}`, true)).toBe(false);
    expect(isContextOverflow(body.trimEnd(), true)).toBe(false);
    expect(isContextOverflow(`\uFEFF${body}`, true)).toBe(true);
    expect(isContextOverflow(`\uFEFFdata: {"choices":[]}\n\n${body}`, true)).toBe(false);
  });
  it('requires a supported error envelope and its complete wording', async () => {
    for (const engine of ['llamacpp', 'sglang', 'vllm', 'sglang-total', 'sglang-total-full']) {
      const body = await readFile(`gateway/test/fixtures/${engine}-overflow.json`, 'utf8');
      const envelope = JSON.parse(body);
      const error = envelope.error ?? envelope;
      expect(isContextOverflow(error.message)).toBe(false);
      expect(isContextOverflow(body, true)).toBe(false);
      error.message += ' This is an unrelated validation error.';
      expect(isContextOverflow(JSON.stringify(envelope))).toBe(false);
    }
    expect(isContextOverflow('{"error":{"code":"context_length_exceeded","message":"Invalid input"}}')).toBe(false);
    expect(isContextOverflow('{"error":{"type":"exceed_context_size_error","message":"request exceeds context"}}')).toBe(false);
  });
  it.each(['sglang-total', 'sglang-total-full'])('requires anchored wording, numeric code and error type for %s', async engine => {
    const envelope = JSON.parse(await readFile(`gateway/test/fixtures/${engine}-overflow.json`, 'utf8'));
    for (const override of [
      { code: '400' }, { code: 500 }, { type: 'invalid_request_error' },
      { message: `Quoted: ${envelope.error.message}` }, { message: `${envelope.error.message} Extra text.` },
      { message: envelope.error.message.slice(0, -1) },
    ]) {
      const body = JSON.stringify({ error: { ...envelope.error, ...override } });
      expect(isContextOverflow(body)).toBe(false);
      expect(isContextOverflow(`event: error\ndata: ${body}\n\n`, true)).toBe(false);
    }
  });
  it('preserves validation errors with quoted or malformed overflow wording in JSON and SSE', async () => {
    const fixtures = JSON.parse(await readFile('gateway/test/fixtures/overflow-negative.json', 'utf8')) as unknown[];
    for (const fixture of fixtures) {
      const body = JSON.stringify(fixture);
      expect(isContextOverflow(body)).toBe(false);
      expect(isContextOverflow(`event: error\ndata: ${body}\n\n`, true)).toBe(false);
    }
  });
});
