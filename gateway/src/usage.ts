import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { usageEvent, requestAdjustmentsSchema, REQUEST_ADJUSTMENTS, type RequestAdjustments, type UsageEventInput, type UsageEvent } from '../../shared/usage.js';
import { usageRowSchema, usageSummaryRequestSchema, type UsageRow, type UsageSummaryRequest, type UsageSummaryResult } from '../../shared/supervisor-config.js';
import type { GatewayRole } from '../../shared/gateway.js';
import { TrustedDirectory, ownedPrivately, CREDENTIAL_EXPOSED } from './directory.js';

const CAP = 64 * 1024;
const DAY = 86_400_000;
const fields = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const;
const count = z.number().int().nonnegative();
const eventSchema = z.object({ role: z.enum(['main', 'coder', 'fast']), backendModel: z.string().max(256), status: z.enum(['ok', 'error']),
  adjustments: requestAdjustmentsSchema.optional(),
  inputTokens: count.optional(), cacheReadTokens: count.optional(), cacheWriteTokens: count.optional(), outputTokens: count.optional(),
  latencyMs: z.number().nonnegative().optional(), estimatedCostUsd: z.number().nonnegative().optional(), reportedCostUsd: z.number().nonnegative().optional() }).strict();
const recordSchema = z.object({ at: count, backend: z.string().nullable(), event: eventSchema }).strict();
type Record = z.infer<typeof recordSchema>;
const dailySchema = z.object({ day: count, through: count, rows: z.array(usageRowSchema) }).strict();

/** Copy only finite, nonnegative metadata from an engine's usage object. */
export function tokenUsage(value: unknown): Partial<UsageEventInput> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const usage = value as { [key: string]: unknown };
  const result: Partial<UsageEventInput> = {};
  const number = (...values: unknown[]) => values.find(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) as number | undefined;
  const details = usage.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
  const inputDetails = usage.input_tokens_details as { cached_tokens?: unknown } | undefined;
  const cached = number(usage.cache_read_input_tokens, usage.cached_tokens, details?.cached_tokens, inputDetails?.cached_tokens);
  const input = number(usage.input_tokens, usage.prompt_tokens);
  if (input !== undefined) result.inputTokens = Math.max(0, input - (usage.cache_read_input_tokens === undefined && (usage.prompt_tokens !== undefined || inputDetails !== undefined) ? cached ?? 0 : 0));
  if (cached !== undefined) result.cacheReadTokens = cached;
  const write = number(usage.cache_creation_input_tokens, usage.cache_write_tokens);
  if (write !== undefined) result.cacheWriteTokens = write;
  const output = number(usage.output_tokens, usage.completion_tokens);
  if (output !== undefined) result.outputTokens = output;
  const cost = number(usage.cost, usage.cost_usd, usage.total_cost);
  if (cost !== undefined) result.reportedCostUsd = cost;
  return result;
}

/** A JSON scanner keeps bounded top-level usage and failure metadata, skipping response content. */
class UsageScanner {
  private depth = 0;
  private quoted = false;
  private escaped = false;
  private readingKey = false;
  private readingValue = false;
  private readingLiteral = false;
  private expectingKey = true;
  private field = '';
  private token = '';
  private tokenBytes = 0;
  private droppingToken = false;
  private capture = '';
  private captureDepth = 0;
  private captureBytes = 0;
  private dropping = false;
  constructor(private readonly found: (value: unknown) => void, private readonly failed: () => void) {}
  private appendToken(character: string): void {
    if (this.droppingToken) return;
    this.tokenBytes += Buffer.byteLength(character);
    if (this.tokenBytes > 64) { this.token = ''; this.droppingToken = true; }
    else this.token += character;
  }
  private finishToken(): void {
    if (!this.droppingToken) {
      try {
        const value: unknown = JSON.parse(this.token);
        if (this.readingKey) this.field = typeof value === 'string' && ['usage', 'status', 'error', 'object', 'type'].includes(value) ? value : '';
        else if (this.field === 'status' && value === 'failed' || this.field === 'error' && value
          || this.field === 'object' && value === 'error' || this.field === 'type' && (value === 'error' || value === 'response.failed')) this.failed();
      } catch {}
    }
    if (!this.readingKey) this.field = '';
    this.token = ''; this.tokenBytes = 0; this.droppingToken = false;
    this.readingKey = false; this.readingValue = false; this.readingLiteral = false;
  }
  feed(text: string): void {
    for (const character of text) {
      if (this.captureDepth) {
        if (!this.dropping) {
          this.captureBytes += Buffer.byteLength(character);
          if (this.captureBytes > CAP) { this.capture = ''; this.dropping = true; }
          else this.capture += character;
        }
      }
      if (this.quoted) {
        if (this.readingKey || this.readingValue) this.appendToken(character);
        if (this.escaped) this.escaped = false;
        else if (character === '\\') this.escaped = true;
        else if (character === '"') {
          this.quoted = false;
          if (this.readingKey || this.readingValue) this.finishToken();
        }
        continue;
      }
      if (this.readingLiteral) {
        if (character === ',' || character === '}' || character === ']') this.finishToken();
        else { this.appendToken(character); continue; }
      }
      if (character === '"') {
        this.quoted = true; this.readingKey = this.depth === 1 && this.expectingKey;
        this.readingValue = this.depth === 1 && !this.expectingKey && this.field !== '' && this.field !== 'usage';
        if (this.readingKey || this.readingValue) this.appendToken(character);
      }
      else if (character === '{' || character === '[') {
        if (this.depth === 1 && this.field === 'error') this.failed();
        if (this.depth === 1 && this.field === 'usage' && character === '{') {
          this.captureDepth = this.depth + 1; this.capture = '{'; this.captureBytes = 1; this.dropping = false;
        }
        this.field = ''; this.depth++;
      } else if (character === '}' || character === ']') {
        if (this.captureDepth === this.depth) {
          if (!this.dropping) { try { this.found(JSON.parse(this.capture)); } catch {} }
          this.capture = ''; this.captureDepth = 0; this.dropping = false;
        }
        this.depth--;
      } else if (character === ',') { this.field = ''; if (this.depth === 1) this.expectingKey = true; }
      else if (character === ':') { if (this.depth === 1) this.expectingKey = false; }
      else if (!/\s/.test(character) && this.depth === 1 && this.field && this.field !== 'usage') {
        this.readingLiteral = true; this.appendToken(character);
      }
    }
  }
  clear(): void { this.capture = ''; this.token = ''; this.field = ''; }
}

/** Response bytes pass through unchanged; only bounded usage metadata survives. */
export class UsageTap extends Transform {
  usage: Partial<UsageEventInput> = {};
  failed = false;
  private readonly decoder = new StringDecoder('utf8');
  private readonly scanner = new UsageScanner(value => { this.usage = tokenUsage(value); }, () => { this.failed = true; });
  private line = '';
  private droppedLine = false;
  private lineBytes = 0;
  private event = '';
  private eventBytes = 0;
  private droppedEvent = false;
  private eventType = '';
  constructor(private readonly sse: boolean) { super(); }
  private inspectEvent(): void {
    if (this.eventType === 'error' || this.eventType === 'response.failed') this.failed = true;
    if (this.droppedEvent || !this.event) return;
    try {
      const value = JSON.parse(this.event);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      if (value.error || value.object === 'error' || value.type === 'error' || value.type === 'response.failed') this.failed = true;
      if (value.type === 'response.completed' || value.type === 'response.failed') {
        if (value.response?.error || value.response?.status === 'failed') this.failed = true;
        if (value.type === 'response.completed' && value.response?.usage) this.usage = tokenUsage(value.response.usage);
      }
      if (value.usage) this.usage = tokenUsage(value.usage);
    } catch {}
  }
  private inspect(text: string): void {
    if (!this.sse) { this.scanner.feed(text); return; }
    for (const character of text) {
      if (character !== '\n') {
        this.lineBytes += Buffer.byteLength(character);
        if (this.lineBytes > CAP) { this.line = ''; this.droppedLine = true; }
        if (!this.droppedLine) this.line += character;
        continue;
      }
      const line = this.line.replace(/\r$/, '');
      if (this.droppedLine) this.droppedEvent = true;
      else if (!line) {
        this.inspectEvent();
        this.event = ''; this.eventBytes = 0; this.droppedEvent = false; this.eventType = '';
      } else if (line.startsWith('event:')) {
        this.eventType = line.slice(6).trim().slice(0, 64);
      } else if (line.startsWith('data:') && !this.droppedEvent) {
        const data = line.slice(5).replace(/^ /, '');
        this.eventBytes += Buffer.byteLength(data) + 1;
        if (this.eventBytes > CAP) { this.event = ''; this.droppedEvent = true; }
        else this.event += `${data}\n`;
      }
      this.line = ''; this.lineBytes = 0; this.droppedLine = false;
    }
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.inspect(this.decoder.write(chunk)); this.push(chunk); callback();
  }
  override _flush(callback: (error?: Error | null) => void): void {
    this.inspect(this.decoder.end());
    if (this.sse) this.inspect('\n\n');
    this.scanner.clear(); this.line = ''; this.event = ''; this.eventType = ''; callback();
  }
}

function row(role: GatewayRole, backend: string | null, backendModel: string): UsageRow {
  return { role, backend, backendModel, requests: 0, errors: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
}
function merge(rows: Map<string, UsageRow>, value: UsageRow): void {
  const key = JSON.stringify([value.role, value.backend, value.backendModel]);
  const target = rows.get(key) ?? row(value.role, value.backend, value.backendModel);
  for (const field of [...fields, 'requests', 'errors', 'estimatedCostUsd'] as const) target[field] += value[field];
  for (const name of REQUEST_ADJUSTMENTS) {
    const count = value.adjustments?.[name];
    if (count) (target.adjustments ??= {})[name] = (target.adjustments[name] ?? 0) + count;
  }
  rows.set(key, target);
}
function eventRow(record: Record): UsageRow {
  const value = row(record.event.role, record.backend, record.event.backendModel);
  value.requests = 1; value.errors = record.event.status === 'error' ? 1 : 0;
  for (const field of fields) value[field] = record.event[field] ?? 0;
  value.estimatedCostUsd = record.event.reportedCostUsd ?? record.event.estimatedCostUsd ?? 0;
  if (record.event.adjustments) value.adjustments = { ...record.event.adjustments };
  return value;
}

/** Private JSONL storage retains raw metadata for 35 days, then daily totals. */
export class UsageStore {
  private records: Record[] = [];
  private daily = new Map<number, Map<string, UsageRow>>();
  private dailyThrough = new Map<number, number>();
  private queue: Promise<void> = Promise.resolve();
  private lastDay = -1;
  private maintenance?: NodeJS.Timeout;
  private stopped = false;
  private repairAppend = false;
  private constructor(private readonly directory: TrustedDirectory, private readonly now: () => number) {}

  static async open(directory: TrustedDirectory, now = Date.now): Promise<UsageStore> {
    const store = new UsageStore(directory, now);
    await store.load('usage.daily.jsonl', line => {
      const value = dailySchema.parse(JSON.parse(line));
      const rows = store.daily.get(value.day) ?? new Map<string, UsageRow>();
      for (const row of value.rows) merge(rows, row);
      store.daily.set(value.day, rows);
      store.dailyThrough.set(value.day, value.through);
    });
    await store.load('usage.jsonl', line => {
      const record = recordSchema.parse(JSON.parse(line));
      if (record.at > (store.dailyThrough.get(Math.floor(record.at / DAY) * DAY) ?? -1)) store.records.push(record);
    });
    await store.compact();
    store.maintenance = setInterval(() => { void store.serialize(() => store.compact()).catch(() => {}); }, DAY);
    store.maintenance.unref();
    return store;
  }

  private async load(name: string, consume: (line: string) => void): Promise<void> {
    await this.directory.assertValid();
    let file;
    try { file = await open(this.directory.entry(name), (name === 'usage.jsonl' ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
      const stats = await file.stat();
      if (!stats.isFile() || !ownedPrivately(stats, CREDENTIAL_EXPOSED)) throw new Error('Usage file is not private.');
      const decoder = new StringDecoder('utf8');
      let pending = ''; let through = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        pending += decoder.write(chunk);
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline);
          if (line) consume(line);
          through += Buffer.byteLength(line) + 1;
          pending = pending.slice(newline + 1);
        }
      }
      pending += decoder.end();
      if (pending) {
        try { consume(pending); }
        catch (error) {
          if (name !== 'usage.jsonl') throw error;
          // An interrupted append may leave a final record without its newline.
          await file.truncate(through); await file.sync();
        }
      }
    } finally { await file.close(); }
    await this.directory.assertValid();
  }

  private async replace(name: string, lines: string[]): Promise<void> {
    const temporary = `${name}.${randomUUID()}.tmp`;
    await this.directory.assertValid();
    const file = await open(this.directory.entry(temporary), 'wx', 0o600);
    try {
      await file.writeFile(lines.length ? `${lines.join('\n')}\n` : ''); await file.sync();
      await this.directory.assertValid();
      await rename(this.directory.entry(temporary), this.directory.entry(name));
    } finally { await file.close(); await unlink(this.directory.entry(temporary)).catch(() => {}); }
  }

  private async compact(): Promise<void> {
    const now = this.now(); const day = Math.floor(now / DAY) * DAY;
    if (day === this.lastDay) return;
    const recent: Record[] = [];
    const daily = new Map([...this.daily].map(([day, rows]) => [day, new Map([...rows].map(([key, value]) => [key,
      { ...value, ...(value.adjustments ? { adjustments: { ...value.adjustments } } : {}) }]))]));
    const through = new Map(this.dailyThrough);
    for (const record of this.records) {
      if (record.at >= now - 35 * DAY) recent.push(record);
      else {
        const at = Math.floor(record.at / DAY) * DAY;
        const rows = daily.get(at) ?? new Map<string, UsageRow>();
        merge(rows, eventRow(record)); daily.set(at, rows);
        through.set(at, Math.max(record.at, through.get(at) ?? 0));
      }
    }
    // Publish totals first, then remove their raw records from memory even if the raw-log replacement fails.
    await this.replace('usage.daily.jsonl', [...daily].map(([day, rows]) => JSON.stringify({ day, through: through.get(day), rows: [...rows.values()] })));
    this.daily = daily; this.dailyThrough = through; this.records = recent;
    await this.replace('usage.jsonl', recent.map(record => JSON.stringify(record)));
    this.lastDay = day;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  record(backend: string | null, event: UsageEvent): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Usage store is closed.'));
    return this.serialize(async () => {
      await this.compact();
      if (this.repairAppend) {
        await this.replace('usage.jsonl', this.records.map(record => JSON.stringify(record)));
        this.repairAppend = false;
      }
      const record = recordSchema.parse({ at: this.now(), backend, event: usageEvent(event) });
      if (event.estimatedCostUsd !== undefined) record.event.estimatedCostUsd = event.estimatedCostUsd;
      await this.directory.assertValid();
      const file = await open(this.directory.entry('usage.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        if (!ownedPrivately(await file.stat(), CREDENTIAL_EXPOSED)) throw new Error('Usage file is not private.');
        try { await file.writeFile(`${JSON.stringify(record)}\n`); await file.sync(); }
        catch (error) { this.repairAppend = true; throw error; }
      } finally { await file.close(); }
      this.records.push(record);
    });
  }

  async summary(input: UsageSummaryRequest): Promise<UsageSummaryResult> {
    const request = usageSummaryRequestSchema.parse(input);
    await this.queue;
    return { ok: true, generatedAt: this.now(), windows: request.windows.map(window => {
      const rows = new Map<string, UsageRow>();
      for (const [day, totals] of this.daily) if (day >= window.since) for (const value of totals.values()) merge(rows, value);
      for (const record of this.records) if (record.at >= window.since) merge(rows, eventRow(record));
      return { ...window, rows: [...rows.values()].slice(0, 512) };
    }) };
  }
  async adjustments(role: GatewayRole): Promise<RequestAdjustments> {
    await this.queue;
    const result: RequestAdjustments = { reasoning_effort_dropped: 0 };
    const add = (value: { role: string; adjustments?: RequestAdjustments }) => {
      if (value.role === role) for (const name of REQUEST_ADJUSTMENTS) result[name] = (result[name] ?? 0) + (value.adjustments?.[name] ?? 0);
    };
    for (const record of this.records) add(record.event);
    for (const rows of this.daily.values()) for (const value of rows.values()) add(value);
    return result;
  }
  async close(): Promise<void> { this.stopped = true; clearInterval(this.maintenance); await this.queue; }
}
