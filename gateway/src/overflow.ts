/** Return the first complete data event, skipping comments and events without data. */
export function firstSseData(body: string): string | undefined {
  const data: string[] = [];
  const lines = body.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  lines.pop();
  for (const line of lines) {
    if (line === '') {
      if (data.length > 0) return data.join('\n');
    } else if (line === 'data') data.push('');
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return undefined;
}

/** Only complete overflow wording from llama.cpp, SGLang or vLLM identifies an overflow. */
export function isContextOverflow(body: string, sse = false): boolean {
  const data = sse ? firstSseData(body) : body;
  if (data === undefined) return false;
  let value: unknown;
  try { value = JSON.parse(data); } catch { return false; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  const error = envelope.error ?? (envelope.object === 'error' ? envelope : undefined);
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  const fields = error as Record<string, unknown>;
  const message = fields.message;
  if (fields.code !== 400 || typeof message !== 'string') return false;
  if (fields.type === 'exceed_context_size_error') {
    return /^request \(\d+ tokens\) exceeds the available context size \(\d+ tokens\), try increasing it$/.test(message);
  }
  return fields.type === 'BadRequestError' && [
    /^The input \(\d+ tokens\) is longer than the model's context length \(\d+ tokens\)\.$/,
    /^Requested token count exceeds the model's maximum context length of \d+ tokens\. You requested a total of \d+ tokens: \d+ tokens from the input messages and \d+ tokens for the completion\.$/,
    /^This model's maximum context length is \d+ tokens\. However, your request has \d+ input tokens\. Please reduce the length of the input messages\.$/,
  ].some(pattern => pattern.test(message));
}
