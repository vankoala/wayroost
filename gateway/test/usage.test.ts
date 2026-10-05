import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageStore, UsageTap, tokenUsage } from '../src/usage.js';
import { usageEvent, toOtelAttributes } from '../../shared/usage.js';
import { TrustedDirectory } from '../src/directory.js';
import { directoryMetadata } from './filesystem-fixture.js';

vi.mock('node:fs/promises', { spy: true });

describe('bounded usage capture', () => {
  async function tap(sse: boolean, chunks: string[]) {
    const stream = new UsageTap(sse); const output: Buffer[] = [];
    stream.on('data', chunk => output.push(chunk));
    const done = new Promise(resolve => stream.on('end', resolve));
    for (const chunk of chunks) stream.write(Buffer.from(chunk)); stream.end(); await done;
    expect(Buffer.concat(output).toString()).toBe(chunks.join(''));
    return stream.usage;
  }
  it('extracts usage after a large completion without retaining its content', async () => {
    const body = JSON.stringify({ choices: [{ message: { content: 'fake private completion '.repeat(10000) } }], usage: { prompt_tokens: 20, completion_tokens: 3 } });
    const chunks = Array.from({ length: Math.ceil(body.length / 73) }, (_, index) => body.slice(index * 73, (index + 1) * 73));
    const usage = await tap(false, chunks);
    expect(usage).toEqual({ inputTokens: 20, outputTokens: 3 }); expect(JSON.stringify(usage)).not.toContain('completion');
  });
  it('handles split UTF-8 SSE, CRLF and multiple data lines, drops oversized events and keeps later usage', async () => {
    const body = 'data: {"choices":[{"delta":{"content":"fake private text"}}]}\r\n\r\n'
      + `data: {"choices":["${'x'.repeat(70000)}"],"usage":{"prompt_tokens":999}}\n\n`
      + 'data: {"usage":\r\ndata: {"prompt_tokens":10,"completion_tokens":2}}\r\n\r\ndata: [DONE]\n\n';
    const usage = await tap(true, [body.slice(0, 19), body.slice(19, 65000), body.slice(65000)]);
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });
  it('caps UTF-8 usage objects by bytes and leaves no content on the tap after completion', async () => {
    const usage = await tap(true, ['data: {"usage":{"prompt_tokens":999,"extra":"' + '🦆'.repeat(20000) + '"}}\n\n']);
    expect(usage).toEqual({});
    const stream = new UsageTap(false); stream.resume();
    const ended = new Promise(resolve => stream.once('end', resolve));
    stream.end('{"usage":{"input_tokens":3},"content":"fake private trailing text"}'); await ended;
    expect(JSON.stringify(stream)).not.toContain('fake private trailing text');
  });
  it('does not mistake quoted message text or nested usage for metadata', async () => {
    const usage = await tap(false, [JSON.stringify({ content: '\"usage\": {\"prompt_tokens\":999}', details: { usage: { prompt_tokens: 999 } } })]);
    expect(usage).toEqual({});
  });
  it.each([
    '{"status":"failed","error":null}', '{"error":{"code":"server_error"}}', '{"object":"error"}', '{"type":"response.failed"}',
    '{"sta\\u0074us":"fa\\u0069led"}',
  ])('recognizes top-level JSON failure metadata split at every byte %#', async metadata => {
    const body = '{"usage":{"input_tokens":10,"output_tokens":2},"output":"' + '🦆'.repeat(20000) + '",' + metadata.slice(1);
    const bytes = Buffer.from(body); const stream = new UsageTap(false); const output: Buffer[] = [];
    stream.on('data', chunk => output.push(chunk)); const ended = new Promise(resolve => stream.once('end', resolve));
    for (const byte of bytes) stream.write(Buffer.from([byte])); stream.end(); await ended;
    expect(Buffer.concat(output)).toEqual(bytes); expect(stream.failed).toBe(true);
    expect(JSON.stringify(stream)).not.toContain('🦆');
  });
  it('recognizes oversized error objects without retaining their content', async () => {
    const body = JSON.stringify({ error: { message: 'Fake failure text '.repeat(10000) }, usage: { input_tokens: 3 } });
    const stream = new UsageTap(false); stream.resume(); const ended = new Promise(resolve => stream.once('end', resolve));
    for (let offset = 0; offset < body.length; offset += 73) stream.write(body.slice(offset, offset + 73)); stream.end(); await ended;
    expect(stream.failed).toBe(true); expect(JSON.stringify(stream)).not.toContain('Fake failure text');
  });
  it('ignores null errors, quoted failure text, nested metadata and long metadata lookalikes', async () => {
    const body = JSON.stringify({ status: 'completed', error: null, output: [{ status: 'failed', error: { message: 'Fake error' } }],
      content: '\"status\":\"failed\",\"error\":{}', ['status' + 'x'.repeat(100)]: 'failed', type: 'error' + 'x'.repeat(100), usage: { input_tokens: 3 } });
    const stream = new UsageTap(false); stream.resume(); const ended = new Promise(resolve => stream.once('end', resolve));
    for (let offset = 0; offset < body.length; offset += 3) stream.write(body.slice(offset, offset + 3)); stream.end(); await ended;
    expect(stream.failed).toBe(false); expect(stream.usage).toEqual({ inputTokens: 3 });
  });
  it('captures only the Responses completion envelope within the SSE size limit', async () => {
    const body = 'event: response.completed\ndata: {"type":"response.completed",\ndata: "response":{"usage":{"input_tokens":10,"output_tokens":2}}}\n\n';
    expect(await tap(true, [body.slice(0, 81), body.slice(81)])).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(await tap(true, ['data: {"type":"response.output_text.delta","response":{"usage":{"input_tokens":999}}}\n\n'])).toEqual({});
    expect(await tap(true, ['data: {"type":"response.completed","response":{"usage":{"input_tokens":999,"extra":"' + 'x'.repeat(70000) + '"}}}\n\n'])).toEqual({});
  });
  it('separates Responses and chat cached tokens while retaining Anthropic input semantics', () => {
    expect(tokenUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 5 })).toEqual({ inputTokens: 20, cacheReadTokens: 80, outputTokens: 5 });
    expect(tokenUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } })).toEqual({ inputTokens: 20, cacheReadTokens: 80 });
    expect(tokenUsage({ input_tokens: 100, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 })).toEqual({ inputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 20 });
    expect(tokenUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: Infinity } })).toEqual({ inputTokens: 100 });
    const event = usageEvent({ role: 'main', backendModel: 'demo', status: 'ok', ...tokenUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 5 }) },
      { inputPerMillionUsd: 2, cacheReadPerMillionUsd: 0.5, outputPerMillionUsd: 4 });
    expect(event.estimatedCostUsd).toBe(0.0001);
  });
  it('keeps missing counts missing and provider cost wins over estimates', () => {
    expect(tokenUsage({ prompt_tokens: NaN, completion_tokens: -1, cost: Infinity })).toEqual({});
    const event = usageEvent({ role: 'main', backendModel: 'demo', status: 'ok', ...tokenUsage({ input_tokens: 100, cache_read_input_tokens: 10, cache_creation_input_tokens: 20, output_tokens: 5, cost: 0.1 }) },
      { inputPerMillionUsd: 2, outputPerMillionUsd: 4 });
    expect(event.reportedCostUsd).toBe(0.1); expect(event.estimatedCostUsd).toBeUndefined();
    expect(toOtelAttributes(event)).toMatchObject({ 'gen_ai.request.model': 'demo', 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 5 });
    expect(usageEvent({ role: 'main', backendModel: 'demo', status: 'ok', inputTokens: 100 }, { inputPerMillionUsd: 2 }).estimatedCostUsd).toBe(0.0002);
    expect(usageEvent({ role: 'main', backendModel: 'demo', status: 'error' }, { inputPerMillionUsd: 2 })).not.toHaveProperty('inputTokens');
  });
});

describe('usage retention and summaries', () => {
  let path: string;
  let directory: TrustedDirectory;
  let store: UsageStore;
  beforeEach(async () => {
    const root = join(process.cwd(), 'gateway/.test-tmp'); await mkdir(root, { recursive: true, mode: 0o700 });
    path = await mkdtemp(join(root, 'usage-')); await directoryMetadata(); directory = await TrustedDirectory.open(path);
  });
  afterEach(async () => { await store?.close(); await directory.close(); vi.restoreAllMocks(); vi.useRealTimers(); await rm(path, { recursive: true, force: true }); });
  it('persists priced successes, errors and unknown usage without inventing counts', async () => {
    store = await UsageStore.open(directory);
    await store.record('demo-a', usageEvent({ role: 'main', backendModel: 'demo', inputTokens: 100, outputTokens: 50, status: 'ok' }, { inputPerMillionUsd: 2, outputPerMillionUsd: 4 }));
    await store.record('demo-a', usageEvent({ role: 'main', backendModel: 'demo', status: 'error' }));
    await store.close(); store = await UsageStore.open(directory);
    const summary = await store.summary({ windows: [{ id: 'week', since: 0 }] });
    expect(summary).toMatchObject({ ok: true, windows: [{ rows: [{ requests: 2, errors: 1, inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.0004 }] }] });
    const raw = (await readFile(join(path, 'usage.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(raw[1].event).not.toHaveProperty('inputTokens');
  });
  it.each(['{"at":', '{"at":123,"event":{"backendModel":"🦆'])('recovers a torn final usage append and continues recording %#', async tail => {
    const first = { at: Date.now(), backend: 'demo-a', event: { role: 'main', backendModel: 'demo', status: 'ok', inputTokens: 3 } };
    await writeFile(join(path, 'usage.jsonl'), `${JSON.stringify(first)}\n${tail}`, { mode: 0o600 });
    store = await UsageStore.open(directory);
    await store.record('demo-a', usageEvent({ role: 'main', backendModel: 'demo', status: 'ok', inputTokens: 4 }));
    await store.close(); store = await UsageStore.open(directory);
    expect(await store.summary({ windows: [{ id: 'week', since: 0 }] })).toMatchObject({ windows: [{ rows: [{ requests: 2, inputTokens: 7 }] }] });
    const raw = (await readFile(join(path, 'usage.jsonl'), 'utf8')).trim().split('\n');
    expect(raw).toHaveLength(2); for (const line of raw) expect(() => JSON.parse(line)).not.toThrow();
  });
  it('recovers a partial write left by an interrupted append', async () => {
    store = await UsageStore.open(directory);
    await store.record('demo-a', usageEvent({ role: 'main', backendModel: 'demo', status: 'ok', inputTokens: 3 }));
    const actualOpen = vi.mocked(open).getMockImplementation()!;
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await actualOpen(...args);
      if (String(args[0]).endsWith('/usage.jsonl')) {
        const write = file.writeFile.bind(file);
        vi.spyOn(file, 'writeFile').mockImplementationOnce(async data => {
          await write(String(data).slice(0, 17)); throw Object.assign(new Error('Write interrupted'), { code: 'ENOSPC' });
        });
      }
      return file;
    });
    await expect(store.record('demo-a', usageEvent({ role: 'main', backendModel: 'demo', status: 'ok', inputTokens: 9 }))).rejects.toThrow('Write interrupted');
    vi.mocked(open).mockImplementation(actualOpen);
    await store.close(); store = await UsageStore.open(directory);
    expect(await store.summary({ windows: [{ id: 'week', since: 0 }] })).toMatchObject({ windows: [{ rows: [{ requests: 1, inputTokens: 3 }] }] });
  });
  it('repairs a failed append before another request writes to the same log', async () => {
    store = await UsageStore.open(directory);
    await store.record('demo-a', usageEvent({ role: 'main', backendModel: 'demo', status: 'ok', inputTokens: 3 }));
    const actualOpen = vi.mocked(open).getMockImplementation()!;
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await actualOpen(...args);
      if (String(args[0]).endsWith('/usage.jsonl')) {
        const write = file.writeFile.bind(file);
        vi.spyOn(file, 'writeFile').mockImplementationOnce(async data => {
          await write(String(data).slice(0, 17)); throw new Error('Write interrupted');
        });
      }
      return file;
    });
    await expect(store.record('demo-a', usageEvent({ role: 'main', backendModel: 'demo', status: 'ok', inputTokens: 9 }))).rejects.toThrow('Write interrupted');
    vi.mocked(open).mockImplementation(actualOpen);
    await store.record('demo-a', usageEvent({ role: 'main', backendModel: 'demo', status: 'ok', inputTokens: 4 }));
    await store.close(); store = await UsageStore.open(directory);
    expect(await store.summary({ windows: [{ id: 'week', since: 0 }] })).toMatchObject({ windows: [{ rows: [{ requests: 2, inputTokens: 7 }] }] });
  });
  it('rejects malformed complete records rather than hiding earlier corruption', async () => {
    await writeFile(join(path, 'usage.jsonl'), '{"at":\n', { mode: 0o600 });
    await expect(UsageStore.open(directory)).rejects.toThrow();
  });
  it.each(['usage.daily.jsonl', 'usage.jsonl'])('retries compaction after a failed %s replacement without duplicate totals', async name => {
    const day = 86400000; let now = 100 * day;
    store = await UsageStore.open(directory, () => now);
    await store.record('demo-a', usageEvent({ role: 'main', backendModel: 'demo', status: 'ok', inputTokens: 3 }));
    now += 40 * day;
    const actualRename = vi.mocked(rename).getMockImplementation();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let failed = false;
    vi.mocked(rename).mockImplementation(async (source, destination) => {
      if (!failed && String(destination).endsWith(`/${name}`)) { failed = true; throw new Error('Replacement interrupted'); }
      return actual.rename(source, destination);
    });
    const event = usageEvent({ role: 'main', backendModel: 'demo', status: 'error' });
    await expect(store.record('demo-a', event)).rejects.toThrow('Replacement interrupted');
    expect(await store.summary({ windows: [{ id: 'week', since: 0 }] })).toMatchObject({ windows: [{ rows: [{ requests: 1, errors: 0, inputTokens: 3 }] }] });
    await store.record('demo-a', event);
    expect(await store.summary({ windows: [{ id: 'week', since: 0 }] })).toMatchObject({ windows: [{ rows: [{ requests: 2, errors: 1, inputTokens: 3 }] }] });
    vi.mocked(rename).mockImplementation(actualRename ?? actual.rename);
    await store.close(); store = await UsageStore.open(directory, () => now);
    expect(await store.summary({ windows: [{ id: 'week', since: 0 }] })).toMatchObject({ windows: [{ rows: [{ requests: 2, errors: 1, inputTokens: 3 }] }] });
  });
  it('expires raw events through serialized maintenance while idle and stops its timer on close', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const day = 86400000; let now = 100 * day;
    store = await UsageStore.open(directory, () => now);
    await store.record('demo-a', usageEvent({ role: 'main', backendModel: 'demo', status: 'ok', inputTokens: 3 }));
    now += 40 * day;
    await vi.advanceTimersByTimeAsync(day);
    const summary = await store.summary({ windows: [{ id: 'week', since: 0 }] });
    expect(await readFile(join(path, 'usage.jsonl'), 'utf8')).toBe('');
    expect(await readFile(join(path, 'usage.daily.jsonl'), 'utf8')).toContain('"inputTokens":3');
    expect(summary).toMatchObject({ windows: [{ rows: [{ requests: 1, inputTokens: 3 }] }] });
    expect(vi.getTimerCount()).toBe(1); await store.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it('rolls raw events older than 35 days into daily totals without double counting after a crash', async () => {
    const day = 86400000; const now = 100 * day;
    const old = { at: 60 * day, backend: 'demo-a', event: { role: 'main', backendModel: 'demo', status: 'ok', inputTokens: 3, estimatedCostUsd: 0 } };
    const recent = { ...old, at: 90 * day };
    await writeFile(join(path, 'usage.jsonl'), `${JSON.stringify(old)}\n${JSON.stringify(recent)}\n`, { mode: 0o600 });
    store = await UsageStore.open(directory, () => now);
    expect((await readFile(join(path, 'usage.jsonl'), 'utf8'))).not.toContain(String(old.at));
    expect(await readFile(join(path, 'usage.daily.jsonl'), 'utf8')).toContain('"inputTokens":3');
    await store.close();
    await writeFile(join(path, 'usage.jsonl'), `${JSON.stringify(old)}\n${JSON.stringify(recent)}\n`, { mode: 0o600 });
    store = await UsageStore.open(directory, () => now);
    expect(await store.summary({ windows: [{ id: 'week', since: 0 }] })).toMatchObject({ windows: [{ rows: [{ requests: 2, inputTokens: 6 }] }] });
  });
});
