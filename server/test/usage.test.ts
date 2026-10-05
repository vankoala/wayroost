import { describe, expect, it } from 'vitest';
import { estimateCost, toOtelAttributes, usageEvent } from '../../shared/usage.js';
import type { ModelPrice, UsageEventInput } from '../../shared/usage.js';

const PRICE: ModelPrice = {
  inputPerMillionUsd: 2.5,
  cacheReadPerMillionUsd: 0.25,
  cacheWritePerMillionUsd: 1.25,
  outputPerMillionUsd: 10,
};

describe('estimateCost', () => {
  it('sums tokens times their per-million prices', () => {
    const usage = { inputTokens: 1_000_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 400_000, outputTokens: 500_000 };
    expect(estimateCost(usage, PRICE)).toBeCloseTo(2.5 + 0.5 + 0.5 + 5, 12);
  });

  it('skips counts or prices that are missing', () => {
    expect(estimateCost({ inputTokens: 1_000_000 }, { inputPerMillionUsd: 3 })).toBeCloseTo(3, 12);
    expect(estimateCost({ inputTokens: 1_000_000 }, {})).toBeUndefined();
    expect(estimateCost({}, PRICE)).toBeUndefined();
  });

  it('uses a reported cost, including zero, before token prices', () => {
    const usage = { inputTokens: 1_000_000, status: 'ok' as const, reportedCostUsd: 1.75 };
    expect(estimateCost(usage, PRICE)).toBe(1.75);
    expect(estimateCost({ ...usage, reportedCostUsd: 0 }, PRICE)).toBe(0);
  });

  it('leaves cost undefined for failed requests even with counts or a reported cost', () => {
    const usage = { inputTokens: 1_000_000, status: 'error' as const, reportedCostUsd: 1.75 };
    expect(estimateCost(usage, PRICE)).toBeUndefined();
  });
});

describe('usageEvent', () => {
  it('carries only the metadata fields', () => {
    const input: UsageEventInput = {
      role: 'worker',
      backendModel: 'example-model-1',
      inputTokens: 1200,
      cacheReadTokens: 300,
      cacheWriteTokens: 50,
      outputTokens: 400,
      latencyMs: 850,
      status: 'ok',
    };
    const event = usageEvent(input, PRICE);
    expect(event).toEqual({
      role: 'worker',
      backendModel: 'example-model-1',
      inputTokens: 1200,
      cacheReadTokens: 300,
      cacheWriteTokens: 50,
      outputTokens: 400,
      latencyMs: 850,
      status: 'ok',
      estimatedCostUsd: expect.any(Number),
    });
    // 1200 x 2.5 + 300 x 0.25 + 50 x 1.25 + 400 x 10, all per million.
    expect(event.estimatedCostUsd).toBeCloseTo(0.003 + 0.000075 + 0.0000625 + 0.004, 12);
  });

  it('drops prompt and completion content, and any other extra fields', () => {
    const input = {
      role: 'worker',
      backendModel: 'example-model-1',
      status: 'ok',
      prompt: 'the whole prompt text',
      completion: 'the whole completion text',
      sessionSecret: 'a-secret',
    } as unknown as UsageEventInput;
    const event = usageEvent(input, PRICE);
    expect(event).not.toHaveProperty('prompt');
    expect(event).not.toHaveProperty('completion');
    expect(event).not.toHaveProperty('sessionSecret');
    expect(JSON.stringify(event)).not.toContain('prompt text');
  });

  it('rejects content fields in the input type and never reads them at runtime', () => {
    const input = { role: 'worker', backendModel: 'example-model-1', status: 'ok' as const };
    // @ts-expect-error Prompt content is not a usage field.
    usageEvent({ ...input, prompt: 'example prompt' });
    // @ts-expect-error Completion content is not a usage field.
    usageEvent({ ...input, completion: 'example completion' });
    Object.defineProperties(input, {
      prompt: { get: () => { throw new Error('Prompt was read'); }, enumerable: true },
      completion: { get: () => { throw new Error('Completion was read'); }, enumerable: true },
    });
    expect(usageEvent(Object.freeze(input), PRICE)).toEqual({
      role: 'worker', backendModel: 'example-model-1', status: 'ok',
    });
  });

  it('lets a provider-reported cost win over the estimate', () => {
    const event = usageEvent(
      { role: 'worker', backendModel: 'example-model-1', inputTokens: 1_000_000, status: 'ok', reportedCostUsd: 1.75 },
      PRICE,
    );
    expect(event.reportedCostUsd).toBe(1.75);
    expect(event.estimatedCostUsd).toBeUndefined();
    expect(usageEvent({ ...event, reportedCostUsd: 0 }, PRICE)).toEqual({ ...event, reportedCostUsd: 0 });
  });

  it('never invents counts or a cost for a failed request', () => {
    const failed = usageEvent({ role: 'worker', backendModel: 'example-model-1', status: 'error' }, PRICE);
    expect(failed.inputTokens).toBeUndefined();
    expect(failed.outputTokens).toBeUndefined();
    expect(failed.estimatedCostUsd).toBeUndefined();

    // Counts that are there are copied as reported; nothing is filled in.
    const partial = usageEvent(
      { role: 'worker', backendModel: 'example-model-1', inputTokens: 90, status: 'error' },
      PRICE,
    );
    expect(partial.inputTokens).toBe(90);
    expect(partial.outputTokens).toBeUndefined();
    expect(partial.cacheReadTokens).toBeUndefined();
    expect(partial.cacheWriteTokens).toBeUndefined();
    expect(partial.estimatedCostUsd).toBeUndefined();
    expect(usageEvent({ ...partial, reportedCostUsd: 1.75 }, PRICE)).toEqual(partial);
  });
});

describe('toOtelAttributes', () => {
  it('maps to the GenAI attribute names and omits missing counts', () => {
    const event = usageEvent({
      role: 'worker',
      backendModel: 'example-model-1',
      inputTokens: 1200,
      cacheReadTokens: 300,
      cacheWriteTokens: 50,
      outputTokens: 400,
      status: 'ok',
    });
    expect(toOtelAttributes(event)).toEqual({
      'gen_ai.request.model': 'example-model-1',
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.usage.output_tokens': 400,
      'gen_ai.usage.cache_read.input_tokens': 300,
      'gen_ai.usage.cache_creation.input_tokens': 50,
    });
  });

  it('only carries the model name when no counts are present', () => {
    expect(toOtelAttributes(usageEvent({ role: 'worker', backendModel: 'example-model-1', status: 'error' }))).toEqual({
      'gen_ai.request.model': 'example-model-1',
    });
  });
});
