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

export class Assist implements AssistApi {
  private found?: { base: string; model: string; at: number };

  private async endpoint(): Promise<{ base: string; model: string }> {
    if (this.found && Date.now() - this.found.at < CACHE_MS) return this.found;
    for (const base of CANDIDATES) {
      try {
        checkDeviceSignal();
        const res = await fetch(`${base}/models`, { signal: actionSignal(AbortSignal.timeout(PROBE_TIMEOUT_MS)) });
        if (!res.ok) continue;
        const data = (await res.json()) as { data?: { id?: unknown }[] };
        const model = data.data?.find((m) => typeof m.id === 'string')?.id;
        if (typeof model === 'string') {
          this.found = { base, model, at: Date.now() };
          return this.found;
        }
      } catch {
        // try the next one
      }
    }
    this.found = undefined;
    throw new UserFacingError("The local model isn't running, so the assistant can't write this right now.", 503);
  }

  async complete(messages: AssistMessage[], opts: { maxTokens?: number; timeoutMs?: number } = {}): Promise<string> {
    const { base, model } = await this.endpoint();
    let res: Response;
    try {
      checkDeviceSignal();
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: opts.maxTokens ?? 400,
          temperature: 0.3,
          // Short, factual writing: no reasoning trace (Qwen-family templates honour this).
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: actionSignal(AbortSignal.timeout(opts.timeoutMs ?? 60_000)),
      });
    } catch {
      this.found = undefined;
      throw new UserFacingError("The local model didn't answer in time.", 504);
    }
    if (!res.ok) throw new UserFacingError(`The local model refused (${res.status}).`, 502);
    const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new UserFacingError('The local model returned nothing.', 502);
    return text.trim();
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
