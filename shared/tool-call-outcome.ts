// What the loop guard is told about each tool call: no content. The tool's name,
// a hash of its canonical arguments, whether it worked, and for a failure a hash
// of its error class. Whoever reports the call (the pi extension, the Hermes
// plugin) computes both hashes, so neither arguments nor error text ever reach
// the guard or its memory. Equal hashes mean "the same call" and "the same
// failure"; that's all the guard needs to spot a circle.
import { z } from 'zod';

/**
 * The arguments' hash: SHA-256, lowercase hex, of the UTF-8 text
 * `json:` + the arguments as canonical JSON (object keys sorted by code unit,
 * no whitespace) when parsing succeeds and nesting is at most MAX_ARGS_DEPTH
 * levels deep, otherwise `raw:` +
 * the text with each run of whitespace turned into one space and the ends trimmed.
 */
export const ARGS_HASH = /^[a-f0-9]{64}$/;
/**
 * The error class's hash: SHA-256, lowercase hex, of the error text's first
 * line, lower-cased, with every whole word of 8 or more hex digits (0x prefix
 * allowed) and every whole run of decimal digits replaced by `<value>`. A
 * failure with no text has the hash of the empty text.
 */
export const ERROR_CLASS_HASH = /^[a-f0-9]{64}$/;
/** Tool names as harnesses report them: "read", "mcp_demo_lookup", "demo.tool". */
export const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** A fixed limit, so the same arguments hash the same way whatever the stack size. */
export const MAX_ARGS_DEPTH = 64;

const canonicalJson = (value: unknown, depth = 0): string => {
  if (depth > MAX_ARGS_DEPTH) throw new RangeError('arguments nested too deeply');
  if (Array.isArray(value)) return '[' + value.map(item => canonicalJson(item, depth + 1)).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(record[key], depth + 1)).join(',') + '}';
  }
  return JSON.stringify(value);
};

async function hash(text: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The same canonical arguments hash in browsers, extensions and server-side reporters. */
export function hashToolArguments(text: string): Promise<string> {
  let canonical: string;
  try { canonical = canonicalJson(JSON.parse(text)); }
  catch { return hash('raw:' + text.replace(/\s+/g, ' ').trim()); }
  return hash('json:' + canonical);
}

/** Error text is normalised and hashed locally; only this digest leaves the reporter. */
export function hashToolErrorClass(text: string = ''): Promise<string> {
  const line = text.split(/\r\n|\r|\n/, 1)[0]!.toLowerCase()
    .replace(/\b(?:0x)?[a-f0-9]{8,}\b/g, '<value>').replace(/\b[0-9]+\b/g, '<value>');
  return hash(line);
}

export const toolCallOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({
    agentId: z.string().regex(AGENT_ID),
    tool: z.string().regex(TOOL_NAME),
    argsHash: z.string().regex(ARGS_HASH),
    ok: z.literal(true),
    /** Some reporters include a class on success; if present it is still a digest. */
    errorClass: z.string().regex(ERROR_CLASS_HASH).optional(),
    /** Epoch milliseconds, from the reporter. */
    at: z.number(),
  }).strict(),
  z.object({
    agentId: z.string().regex(AGENT_ID),
    tool: z.string().regex(TOOL_NAME),
    argsHash: z.string().regex(ARGS_HASH),
    ok: z.literal(false),
    errorClass: z.string().regex(ERROR_CLASS_HASH),
    at: z.number(),
  }).strict(),
]);
export type ToolCallOutcome = z.infer<typeof toolCallOutcomeSchema>;
