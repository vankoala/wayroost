import { checkDeviceSignal, actionSignal } from './security/device-signal.js';
import { wayroostEnv } from './environment.js';
import { UserFacingError } from './sources.js';

// A small helper for the few places Signalbox writes text itself (Scheduled jobs: a job's
// one-line "idea", and the AI job builder). It calls the local model directly through its
// OpenAI-compatible API on 127.0.0.1 — nothing leaves the PC. Configure local
// API bases with WAYROOST_ASSIST_URLS; it remembers the one that answers.

const CANDIDATES = (wayroostEnv('ASSIST_URLS') ?? 'http://127.0.0.1:19001/v1')
  .split(',')
  .map((u) => u.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const PROBE_TIMEOUT_MS = 3_000;
const CACHE_MS = 60_000;

export interface AssistMessage {
  role: 'system' | 'user';
  content: string;
}

export interface AssistApi {
  complete(messages: AssistMessage[], opts?: { maxTokens?: number; timeoutMs?: number }): Promise<string>;
}

/** One address that lists a model, with its place in the list so a retry can go on to the next. */
interface Endpoint {
  base: string;
  model: string;
  index: number;
}

/** The connection died before the model said anything; a different address may be the live one. */
class AssistNoAnswer extends Error {}

/** How the node and undici errors spell a connection that died: refused, reset, closed under us. */
const CLOSED_FIRST = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
];

/**
 * Whether a request failed on the way to the model, rather than the model taking too long
 * (our own deadline) or answering with an error of its own. Only the first is worth another address.
 */
function connectionFailed(err: unknown): boolean {
  const seen: unknown[] = [err];
  for (let i = 0; i < seen.length; i += 1) {
    const step = seen[i] as { name?: string; code?: string; errno?: string; message?: string; cause?: unknown } | null;
    if (!step || typeof step !== 'object') continue;
    const text = `${step.name ?? ''} ${step.code ?? ''} ${step.errno ?? ''} ${step.message ?? ''}`;
    if (CLOSED_FIRST.some((code) => text.includes(code))) return true;
    if (/socket hang up|other side closed|connection (?:refused|closed|reset)|target socket failed/i.test(text)) return true;
    if (step.cause !== undefined) seen.push(step.cause);
  }
  return false;
}

export class Assist implements AssistApi {
  private found?: { ep: Endpoint; at: number };

  private async endpoint(): Promise<Endpoint> {
    if (this.found && Date.now() - this.found.at < CACHE_MS) return this.found.ep;
    const ep = await this.probe(0);
    this.found = { ep, at: Date.now() };
    return ep;
  }

  /** The first address from `from` on that lists a model. A retried write starts after the one that fell silent. */
  private async probe(from: number): Promise<Endpoint> {
    for (let index = from; index < CANDIDATES.length; index += 1) {
      const base = CANDIDATES[index]!;
      try {
        checkDeviceSignal();
        const res = await fetch(`${base}/models`, { signal: actionSignal(AbortSignal.timeout(PROBE_TIMEOUT_MS)) });
        if (!res.ok) continue;
        const data = (await res.json()) as { data?: { id?: unknown }[] };
        const model = data.data?.find((m) => typeof m.id === 'string')?.id;
        if (typeof model === 'string') return { base, model, index };
      } catch (err) {
        if (err instanceof UserFacingError) throw err; // the device was revoked while we were asking
        // try the next one
      }
    }
    this.found = undefined;
    throw new UserFacingError("The local model isn't running, so the assistant can't write this right now.", 503);
  }

  /** One completion against one address. Whatever it says stands; only silence asks for a retry. */
  private async ask(
    ep: Endpoint,
    messages: AssistMessage[],
    opts: { maxTokens?: number; timeoutMs?: number },
  ): Promise<string> {
    let res: Response;
    try {
      checkDeviceSignal();
      res = await fetch(`${ep.base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ep.model,
          messages,
          max_tokens: opts.maxTokens ?? 400,
          temperature: 0.3,
          // Short, factual writing: no reasoning trace (Qwen-family templates honour this).
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: actionSignal(AbortSignal.timeout(opts.timeoutMs ?? 60_000)),
      });
    } catch (err) {
      if (err instanceof UserFacingError) throw err; // revoked mid-flight: the person needs to know that
      if (connectionFailed(err)) throw new AssistNoAnswer();
      throw new UserFacingError("The local model didn't answer in time.", 504);
    }
    if (!res.ok) throw new UserFacingError(`The local model refused (${res.status}).`, 502);
    let data: unknown;
    try {
      data = await res.json();
    } catch (err) {
      // The answer broke off on the way. The model was there, so this is reported, not retried.
      const half = 'The local model stopped answering halfway through.';
      throw new UserFacingError(connectionFailed(err) ? half : "The local model didn't answer in time.", 504);
    }
    const text = (data as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new UserFacingError('The local model returned nothing.', 502);
    return text.trim();
  }

  async complete(messages: AssistMessage[], opts: { maxTokens?: number; timeoutMs?: number } = {}): Promise<string> {
    const ep = await this.endpoint();
    try {
      return await this.ask(ep, messages, opts);
    } catch (err) {
      // A model that closed the connection before saying anything is not necessarily the model that is
      // running: a second local server can be up where the first one just went away. Try the rest once.
      if (!(err instanceof AssistNoAnswer)) throw err;
      this.found = undefined;
      let next: Endpoint;
      try {
        next = await this.probe(ep.index + 1);
      } catch {
        throw new UserFacingError("The local model stopped answering, and no other address took over.", 504);
      }
      let text: string;
      try {
        text = await this.ask(next, messages, opts);
      } catch (retryErr) {
        if (retryErr instanceof AssistNoAnswer) {
          throw new UserFacingError("The local model stopped answering, and no other address took over.", 504);
        }
        throw retryErr;
      }
      this.found = { ep: next, at: Date.now() };
      return text;
    }
  }
}

/** The first JSON object in a model reply (models sometimes wrap it in prose or fences). */
export function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new UserFacingError('The assistant gave an unreadable draft. Try again.', 502);
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new UserFacingError('The assistant gave an unreadable draft. Try again.', 502);
}
