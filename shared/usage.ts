// Metadata-only usage events for model requests. The prompt and completion of
// a request are never part of a usage event, so events can be stored and
// forwarded without any message content.

/** Per-million-token prices, in USD. */
export type ModelPrice = {
  inputPerMillionUsd?: number;
  cacheReadPerMillionUsd?: number;
  cacheWritePerMillionUsd?: number;
  outputPerMillionUsd?: number;
};

/**
 * What a caller reports about one model request. The type has no field for
 * prompt or completion content, and {@link usageEvent} copies fields by name,
 * so anything else attached to the object never reaches the event.
 */
export type UsageEventInput = {
  /** Which agent made the request. */
  role: string;
  backendModel: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  status: 'ok' | 'error';
  /** Cost in USD as the provider reported it; it wins over any estimate. */
  reportedCostUsd?: number;
};

export type UsageEvent = {
  role: string;
  backendModel: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  status: 'ok' | 'error';
  estimatedCostUsd?: number;
  reportedCostUsd?: number;
};

const COUNT_FIELDS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'latencyMs'] as const;

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Build one metadata-only event for a model request. Fields are copied by
 * name, so extra fields (prompt text, completions, ids) are dropped. Missing
 * counts stay missing: nothing is filled in with zero. When a price is given
 * and the request succeeded, an estimated cost is added; a cost the provider
 * reported wins, so no estimate is attached in that case.
 */
export function usageEvent(input: UsageEventInput, price?: ModelPrice): UsageEvent {
  const event: UsageEvent = { role: input.role, backendModel: input.backendModel, status: input.status };
  for (const field of COUNT_FIELDS) {
    if (finiteNumber(input[field])) event[field] = input[field];
  }
  if (input.status === 'ok' && finiteNumber(input.reportedCostUsd)) event.reportedCostUsd = input.reportedCostUsd;
  if (input.status === 'ok' && price && event.reportedCostUsd === undefined) {
    const estimate = estimateCost(input, price);
    if (estimate !== undefined) event.estimatedCostUsd = estimate;
  }
  return event;
}

/**
 * Sum of the token counts we have times their per-million prices, in USD.
 * Reported cost takes precedence. Failed requests have no cost. A missing
 * count or price is skipped; no priced counts means no estimate.
 */
export function estimateCost(
  usage: Pick<UsageEventInput, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens' | 'reportedCostUsd'>
    & Partial<Pick<UsageEventInput, 'status'>>,
  price: ModelPrice,
): number | undefined {
  if (usage.status !== undefined && usage.status !== 'ok') return undefined;
  if (finiteNumber(usage.reportedCostUsd)) return usage.reportedCostUsd;
  const parts: Array<[number | undefined, number | undefined]> = [
    [usage.inputTokens, price.inputPerMillionUsd],
    [usage.cacheReadTokens, price.cacheReadPerMillionUsd],
    [usage.cacheWriteTokens, price.cacheWritePerMillionUsd],
    [usage.outputTokens, price.outputPerMillionUsd],
  ];
  let total = 0;
  let any = false;
  for (const [tokens, perMillion] of parts) {
    if (finiteNumber(tokens) && finiteNumber(perMillion)) {
      total += (tokens * perMillion) / 1_000_000;
      any = true;
    }
  }
  return any ? total : undefined;
}

/**
 * The event as OpenTelemetry GenAI attributes. This is a local mapping only;
 * nothing here is exported to any collector.
 */
export function toOtelAttributes(event: UsageEvent): Record<string, string | number> {
  const attrs: Record<string, string | number> = { 'gen_ai.request.model': event.backendModel };
  if (event.inputTokens !== undefined) attrs['gen_ai.usage.input_tokens'] = event.inputTokens;
  if (event.outputTokens !== undefined) attrs['gen_ai.usage.output_tokens'] = event.outputTokens;
  if (event.cacheReadTokens !== undefined) attrs['gen_ai.usage.cache_read.input_tokens'] = event.cacheReadTokens;
  if (event.cacheWriteTokens !== undefined) attrs['gen_ai.usage.cache_creation.input_tokens'] = event.cacheWriteTokens;
  return attrs;
}
