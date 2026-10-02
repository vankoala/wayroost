// Drives bridge/signalbox-bridge.mjs (the stdio MCP server agents start) over
// stdin/stdout against a small fake of Signalbox's bridge listener.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER = join(ROOT, 'bridge', 'signalbox-bridge.mjs');
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const TOKEN = randomBytes(32).toString('base64url');

/** A JSON-RPC message; the tests check it field by field. */
type Message = Record<string, any>;

// ---- a fake Signalbox bridge listener -------------------------------------------------

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
  /** The wrapper hung up before an answer was sent. */
  aborted: boolean;
}
interface Answer {
  status: number;
  json?: unknown;
  raw?: string;
}
type Handler = (tool: string, body: any, req: http.IncomingMessage) => Answer | Promise<Answer>;

interface Fake {
  port: number;
  url: string;
  seen: Seen[];
  close(): Promise<void>;
}

async function fakeServer(handler: Handler): Promise<Fake> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      const entry: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, aborted: false };
      seen.push(entry);
      res.on('close', () => {
        if (!res.writableFinished) entry.aborted = true;
      });
      void (async () => {
        const answer = await handler((req.url ?? '').replace(/^\/bridge\/v1\//, ''), body, req);
        if (res.destroyed) return;
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(answer.raw ?? JSON.stringify(answer.json));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const ok = (result: unknown): Answer => ({ status: 200, json: { ok: true, result } });
const refused = (status: number, error: string): Answer => ({ status, json: { ok: false, error } });

// ---- an MCP client on the wrapper's stdio ---------------------------------------------

class Client {
  readonly child: ChildProcessWithoutNullStreams;
  /** Every line the wrapper wrote to stdout. */
  readonly lines: string[] = [];
  stderr = '';
  private buffer = '';
  private readonly waiting = new Map<unknown, (message: Message) => void>();
  private nextId = 1;

  constructor(env: Record<string, string>, cwd?: string) {
    this.child = spawn(process.execPath, [WRAPPER], { env, cwd, stdio: 'pipe' });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (let nl = this.buffer.indexOf('\n'); nl >= 0; nl = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        this.lines.push(line);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // reported by checkOutput()
        }
        for (const message of (Array.isArray(parsed) ? parsed : [parsed]) as Message[]) {
          const resolve = this.waiting.get(message?.id);
          if (resolve) {
            this.waiting.delete(message.id);
            resolve(message);
          }
        }
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
  }

  write(line: string): void {
    this.child.stdin.write(`${line}\n`);
  }

  notify(method: string, params?: unknown): void {
    this.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }));
  }

  /** Resolves with the response that carries this id. */
  response(id: unknown): Promise<Message> {
    return new Promise((resolve) => this.waiting.set(id, resolve));
  }

  request(method: string, params?: unknown, id: unknown = this.nextId++): Promise<Message> {
    const answer = this.response(id);
    this.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
    return answer;
  }

  initialize(protocolVersion: unknown = '2025-06-18', clientName = 'vitest'): Promise<Message> {
    return this.request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: clientName, version: '1' } });
  }

  /** tools/call's result. */
  async call(name: string, args?: unknown): Promise<Message> {
    const response = await this.request('tools/call', { name, ...(args === undefined ? {} : { arguments: args }) });
    expect(response.error).toBeUndefined();
    return response.result as Message;
  }

  /** Close stdin and wait for the wrapper to exit on its own. */
  async close(): Promise<number | null> {
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) await once(this.child, 'exit');
    return this.child.exitCode;
  }
}

const text = (result: Message): string => {
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe('text');
  return result.content[0].text as string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await sleep(10);
  if (!check()) throw new Error(`timed out waiting for ${what}`);
}

// ---- setup ------------------------------------------------------------------------------

let home: string;
let cwd: string;
const clients: Client[] = [];
const fakes: Fake[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'signalbox-bridge-test-'));
  mkdirSync(join(home, '.config', 'signalbox'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, '.config', 'signalbox', 'bridge-token'), TOKEN, { mode: 0o600 });
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'signalbox-bridge-cwd-')));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    expect(await client.close()).toBe(0);
    // Stdout carries protocol messages only, and the token never shows up anywhere.
    for (const line of client.lines) {
      const parsed: unknown = JSON.parse(line);
      for (const message of (Array.isArray(parsed) ? parsed : [parsed]) as Message[]) expect(message.jsonrpc).toBe('2.0');
    }
    expect(client.lines.join('\n')).not.toContain(TOKEN);
    expect(client.stderr).not.toContain(TOKEN);
  }
  for (const fake of fakes.splice(0)) await fake.close();
});

/** A clean environment: nothing from the test runner leaks in. The token comes from ~/.config by default. */
function start(env: Record<string, string> = {}, options: { cwd?: string } = {}): Client {
  const client = new Client({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...env }, options.cwd ?? cwd);
  clients.push(client);
  return client;
}

async function signalbox(handler: Handler): Promise<Fake> {
  const fake = await fakeServer(handler);
  fakes.push(fake);
  return fake;
}

// ---- tests ------------------------------------------------------------------------------

describe('signalbox-bridge.mjs over stdio', () => {
  it('answers initialize, ping and tools/list', async () => {
    const client = start({ SIGNALBOX_BRIDGE_URL: 'http://127.0.0.1:9' });
    const init = await client.initialize('2025-06-18');
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(init.result.serverInfo).toMatchObject({ name: 'signalbox', version: VERSION });
    expect(init.result.instructions).toMatch(/other AI agents/);
    expect(init.result.instructions).toMatch(/approvals always stay with the user/);

    client.notify('notifications/initialized');
    expect((await client.request('ping', undefined, 'p-1')).result).toEqual({});

    const { tools } = (await client.request('tools/list')).result as { tools: Message[] };
    expect(tools.map((t) => t.name)).toEqual(['list_chats', 'read_chat', 'send_message', 'wait_for_reply', 'start_chat']);
    const tool = (name: string) => tools.find((t) => t.name === name)!;

    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.inputSchema.properties.project.type).toBe('string');
      // The Hermes plugin's hidden argument is never advertised.
      expect(JSON.stringify(t)).not.toContain('_signalbox_caller');
      expect(typeof t.description).toBe('string');
    }
    expect(tool('list_chats').annotations).toMatchObject({ readOnlyHint: true });
    expect(tool('read_chat').annotations).toMatchObject({ readOnlyHint: true });
    expect(tool('send_message').annotations).toMatchObject({ readOnlyHint: false, openWorldHint: false });
    expect(tool('wait_for_reply').annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tool('start_chat').annotations).toMatchObject({ readOnlyHint: false, openWorldHint: false });

    expect(tool('list_chats').inputSchema.required).toBeUndefined();
    expect(tool('read_chat').inputSchema.required).toEqual(['chat']);
    expect(tool('read_chat').inputSchema.properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 50 });
    expect(tool('send_message').inputSchema.required).toEqual(['chat', 'text']);
    expect(tool('send_message').inputSchema.properties.text).toMatchObject({ minLength: 1, maxLength: 8000 });
    expect(tool('wait_for_reply').inputSchema.required).toEqual(['chat']);
    expect(tool('wait_for_reply').inputSchema.properties.timeout_seconds).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 120,
      default: 45,
    });
    expect(tool('start_chat').inputSchema.required).toEqual(['backend', 'text']);
    expect(tool('start_chat').inputSchema.properties.backend.enum).toEqual(['paseo', 'hermes']);

    // What the model needs to be told.
    expect(tool('list_chats').description).toMatch(/other AI agents/);
    const send = tool('send_message').description as string;
    expect(send).toMatch(/another AI agent/);
    expect(send).toMatch(/labelled as coming from an AI agent, not from the user/);
    expect(send).toMatch(/gets it when it finishes/);
    expect(send).toMatch(/Text starting with "\/" is refused/);
    expect(send).toMatch(/Approvals stay with the user/);
    expect(send).toMatch(/with a reply address/);
    expect(send).toMatch(/To get the answer, call wait_for_reply, or look later with read_chat/);
    expect(send).toMatch(/came with a reply address, reply with send_message to that chat/);
    const wait = tool('wait_for_reply').description as string;
    expect(wait).toMatch(/sends you a message through Signalbox or finishes its current turn/);
    expect(wait).toMatch(/If the result says timed_out, call it again/);
    expect(init.result.instructions).toMatch(/wait_for_reply/);
    expect(init.result.instructions).toMatch(/reply address, answer with send_message to that chat/);
    const startChat = tool('start_chat').description as string;
    expect(startChat).toMatch(/only modes that ask the user before acting are allowed/);
    expect(startChat).toMatch(/asks the user for its own approvals/);
  });

  it('echoes supported protocol versions and otherwise offers 2025-06-18', async () => {
    const client = start();
    for (const version of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']) {
      expect((await client.initialize(version)).result.protocolVersion).toBe(version);
    }
    for (const version of ['2026-07-28', '1999-01-01', 42, undefined]) {
      expect((await client.initialize(version)).result.protocolVersion).toBe('2025-06-18');
    }
  });

  it('forwards a tool call with the token and who is calling, and renders the result', async () => {
    const result = {
      project: { path: '/home/me/app', name: 'app' },
      chats: [
        { chat: 'paseo:abc', title: 'Fix login', backend: 'paseo', agent: 'Claude Code', status: 'idle' },
        { chat: 'hermes:42', title: 'Release notes', backend: 'hermes', agent: 'Hermes', status: 'working' },
      ],
    };
    const fake = await signalbox(() => ok(result));
    const client = start({
      SIGNALBOX_BRIDGE_URL: fake.url,
      PASEO_AGENT_ID: 'agent-123',
      PASEO_AGENT_CWD: '/home/me/app/web',
    });
    await client.initialize();
    const answer = await client.call('list_chats', { project: '/home/me/app' });

    expect(answer.isError).toBeUndefined();
    const rendered = text(answer);
    expect(JSON.parse(rendered)).toEqual(result);
    expect(rendered.split('\n')).toHaveLength(7); // one line per chat, still valid JSON

    expect(fake.seen).toHaveLength(1);
    const [req] = fake.seen;
    expect(req!.method).toBe('POST');
    expect(req!.url).toBe('/bridge/v1/list_chats');
    expect(req!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req!.headers['x-bridge-paseo-agent']).toBe('agent-123');
    expect(req!.headers['x-bridge-cwd']).toBe('/home/me/app/web');
    expect(req!.headers['content-type']).toBe('application/json');
    expect(req!.headers.host).toBe(`127.0.0.1:${fake.port}`);
    expect(req!.headers.origin).toBeUndefined();
    expect(req!.body).toEqual({ project: '/home/me/app' });
  });

  it('sends the process cwd and an empty agent id outside Paseo', async () => {
    const fake = await signalbox(() => ok({ delivered: 'now' }));
    const client = start({ SIGNALBOX_BRIDGE_URL: fake.url });
    await client.initialize();
    const answer = await client.call('send_message', { chat: 'paseo:abc', text: 'Can you rerun the tests?', backend_hint: 'hermes' });
    expect(JSON.parse(text(answer))).toEqual({ delivered: 'now' });
    expect(fake.seen[0]!.url).toBe('/bridge/v1/send_message');
    expect(fake.seen[0]!.headers['x-bridge-paseo-agent']).toBe('');
    expect(fake.seen[0]!.headers['x-bridge-cwd']).toBe(cwd);
    // Only the wrapper says whether Hermes is calling; the model can't.
    expect(fake.seen[0]!.body).toEqual({ chat: 'paseo:abc', text: 'Can you rerun the tests?' });
  });

  it('treats Hermes placeholders as unset and marks the call as coming from Hermes', async () => {
    const fake = await signalbox(() => ok({ project: { path: cwd, name: 'x' }, chats: [] }));
    const client = start({
      SIGNALBOX_BRIDGE_URL: fake.url,
      PASEO_AGENT_ID: '${PASEO_AGENT_ID}',
      PASEO_AGENT_CWD: '${PASEO_AGENT_CWD}',
    });
    await client.initialize('2025-11-25', 'mcp');
    await client.call('list_chats');
    expect(fake.seen[0]!.headers['x-bridge-paseo-agent']).toBe('');
    expect(fake.seen[0]!.headers['x-bridge-cwd']).toBe(cwd);
    expect(fake.seen[0]!.body).toEqual({ backend_hint: 'hermes' });
  });

  it('waits for a reply through Signalbox and passes its answer through', async () => {
    const replied = { from: 'paseo:abc', kind: 'reply', text: 'Done: 3 tests fixed.' };
    const timedOut = { from: 'paseo:abc', kind: 'timed_out', status: 'working', note: 'Still working. Call wait_for_reply again.' };
    const fake = await signalbox(async (_tool, body) => {
      await sleep(300); // a wait that takes a while still gets its answer
      return ok(body.timeout_seconds === 120 ? replied : timedOut);
    });
    const client = start({ SIGNALBOX_BRIDGE_URL: fake.url });
    await client.initialize();

    const answer = await client.call('wait_for_reply', { chat: 'paseo:abc', timeout_seconds: 120 });
    expect(answer.isError).toBeUndefined();
    expect(JSON.parse(text(answer))).toEqual(replied);
    expect(JSON.parse(text(await client.call('wait_for_reply', { chat: 'paseo:abc' })))).toEqual(timedOut);

    expect(fake.seen.map((s) => [s.url, s.body])).toEqual([
      ['/bridge/v1/wait_for_reply', { chat: 'paseo:abc', timeout_seconds: 120 }],
      ['/bridge/v1/wait_for_reply', { chat: 'paseo:abc' }],
    ]);
  });

  it("passes the Hermes plugin's caller id on as a header only when Hermes started the wrapper", async () => {
    const fake = await signalbox(() => ok({ delivered: 'now' }));
    const session = '20260928_101500_a1b2c3';
    const send = { chat: 'paseo:abc', text: 'Status?', _signalbox_caller: session };

    const hermes = start({ SIGNALBOX_BRIDGE_URL: fake.url, PASEO_AGENT_ID: '${PASEO_AGENT_ID}', PASEO_AGENT_CWD: '${PASEO_AGENT_CWD}' });
    await hermes.initialize('2025-11-25', 'mcp');
    await hermes.call('send_message', send);
    await hermes.call('wait_for_reply', { chat: 'paseo:abc', _signalbox_caller: session });

    // A model in any other agent can add the argument, but it goes nowhere.
    const paseo = start({ SIGNALBOX_BRIDGE_URL: fake.url, PASEO_AGENT_ID: 'agent-9' });
    await paseo.call('send_message', send);
    const plain = start({ SIGNALBOX_BRIDGE_URL: fake.url });
    await plain.initialize('2025-06-18', 'hermes-agent'); // a client name alone isn't enough
    await plain.call('send_message', send);

    expect(fake.seen.map((s) => s.headers['x-bridge-hermes-session'])).toEqual([session, session, undefined, undefined]);
    for (const seen of fake.seen) expect(seen.body).not.toHaveProperty('_signalbox_caller');
    expect(fake.seen[0]!.body).toEqual({ chat: 'paseo:abc', text: 'Status?', backend_hint: 'hermes' });
    expect(fake.seen[1]!.body).toEqual({ chat: 'paseo:abc', backend_hint: 'hermes' });
    expect(fake.seen[2]!.body).toEqual({ chat: 'paseo:abc', text: 'Status?' });

    // Under Hermes, a value that can't be a session id is dropped too.
    fake.seen.length = 0;
    for (const bad of [{ id: session }, 42, '', 'two words', 'line\nbreak', 'sessiön', 'x'.repeat(201)]) {
      await hermes.call('list_chats', { _signalbox_caller: bad });
    }
    expect(fake.seen).toHaveLength(7);
    for (const seen of fake.seen) {
      expect(seen.headers['x-bridge-hermes-session']).toBeUndefined();
      expect(seen.body).toEqual({ backend_hint: 'hermes' });
    }
  });

  it('percent-encodes a folder that is not plain ASCII', async () => {
    const fake = await signalbox(() => ok({ chats: [] }));
    const client = start({ SIGNALBOX_BRIDGE_URL: fake.url, PASEO_AGENT_CWD: '/home/me/projét 1' });
    await client.call('list_chats', {});
    expect(fake.seen[0]!.headers['x-bridge-cwd']).toBe('%2Fhome%2Fme%2Fproj%C3%A9t%201');
  });

  it("maps Signalbox's refusals to tool errors with its message", async () => {
    const fake = await signalbox((tool, body) => {
      if (tool === 'send_message') return refused(429, 'This chat has sent too many messages. Try again in a few minutes.');
      if (tool === 'read_chat') return refused(403, "That chat isn't in this project.");
      if (tool === 'start_chat') return { status: 500, raw: '<html>oops</html>' };
      return refused(503, `The user paused the Signalbox bridge. ${JSON.stringify(body)}`);
    });
    const client = start({ SIGNALBOX_BRIDGE_URL: fake.url });
    await client.initialize();

    const limited = await client.call('send_message', { chat: 'paseo:abc', text: 'hello' });
    expect(limited.isError).toBe(true);
    expect(text(limited)).toBe('This chat has sent too many messages. Try again in a few minutes.');

    const outside = await client.call('read_chat', { chat: 'hermes:1' });
    expect(outside).toMatchObject({ isError: true });
    expect(text(outside)).toBe("That chat isn't in this project.");

    const broken = await client.call('start_chat', { backend: 'hermes', text: 'hi' });
    expect(broken.isError).toBe(true);
    expect(text(broken)).toBe('Signalbox answered with HTTP 500.');

    const paused = await client.call('list_chats', {});
    expect(text(paused)).toBe('The user paused the Signalbox bridge. {}');
  });

  it('re-reads a replaced token after a 401, and otherwise explains how to fix it', async () => {
    const tokenFile = join(home, 'rotating-token');
    const oldToken = randomBytes(32).toString('base64url');
    const newToken = randomBytes(32).toString('base64url');
    writeFileSync(tokenFile, `${oldToken}\n`, { mode: 0o600 });
    const fake = await signalbox((_tool, _body, req) =>
      req.headers.authorization === `Bearer ${newToken}` ? ok({ chats: [] }) : refused(401, "Signalbox didn't accept the bridge token."),
    );
    const client = start({ SIGNALBOX_BRIDGE_URL: fake.url, SIGNALBOX_BRIDGE_TOKEN_FILE: tokenFile });

    const denied = await client.call('list_chats', {});
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/^Signalbox didn't accept the bridge token\. .*setup-bridge\.sh/);
    expect(fake.seen).toHaveLength(1);

    writeFileSync(tokenFile, newToken);
    const accepted = await client.call('list_chats', {});
    expect(accepted.isError).toBeUndefined();
    expect(fake.seen.slice(1).map((s) => s.headers.authorization)).toEqual([`Bearer ${oldToken}`, `Bearer ${newToken}`]);
    for (const secret of [oldToken, newToken]) {
      expect(client.stderr).not.toContain(secret);
      expect(client.lines.join('\n')).not.toContain(secret);
    }
  });

  it("says the bridge isn't set up when there is no token, without calling Signalbox", async () => {
    const fake = await signalbox(() => ok({}));
    writeFileSync(join(home, 'junk-token'), 'not a token\n');
    for (const tokenFile of [join(home, 'no-such-token'), join(home, 'junk-token')]) {
      const client = start({ SIGNALBOX_BRIDGE_URL: fake.url, SIGNALBOX_BRIDGE_TOKEN_FILE: tokenFile });
      await client.initialize();
      // The tools are still listed, so the model can tell the user what's wrong.
      expect((await client.request('tools/list')).result.tools).toHaveLength(5);
      const answer = await client.call('list_chats', {});
      expect(answer.isError).toBe(true);
      expect(text(answer)).toMatch(/^The Signalbox bridge isn't set up on this machine .*setup-bridge\.sh/);
      expect(text(answer)).toContain(tokenFile);
      expect(client.stderr).toMatch(/isn't set up/);
    }
    // The default location, when HOME has no token either.
    const empty = mkdtempSync(join(tmpdir(), 'signalbox-bridge-empty-'));
    try {
      const client = start({ SIGNALBOX_BRIDGE_URL: fake.url, HOME: empty });
      expect(text(await client.call('send_message', { chat: 'paseo:a', text: 'hi' }))).toMatch(
        /no token in ~\/\.config\/signalbox\/bridge-token/,
      );
      await client.close();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    expect(fake.seen).toHaveLength(0);
  });

  it('refuses a bridge URL that is not on this machine', async () => {
    const fake = await signalbox(() => ok({ chats: [] }));
    const refusedUrls: Array<[string, RegExp]> = [
      ['http://192.0.2.10:8792', /must point at this machine .*not 192\.0\.2\.10/],
      ['http://example.com:8792', /must point at this machine .*not example\.com/],
      [`http://127.0.0.1.example.com:${fake.port}`, /must point at this machine/],
      [`https://127.0.0.1:${fake.port}`, /must be an http:\/\/ address/],
      [`http://me:secret@127.0.0.1:${fake.port}`, /can't carry a user name or password/],
      ['not a url', /isn't a valid URL/],
    ];
    for (const [url, message] of refusedUrls) {
      const client = start({ SIGNALBOX_BRIDGE_URL: url });
      const answer = await client.call('list_chats', {});
      expect(answer.isError).toBe(true);
      expect(text(answer)).toMatch(message);
    }
    expect(fake.seen).toHaveLength(0);

    // Loopback names are fine; the Host header names the port the server checks.
    const local = start({ SIGNALBOX_BRIDGE_URL: `http://localhost:${fake.port}` });
    expect((await local.call('list_chats', {})).isError).toBeUndefined();
    expect(fake.seen[0]!.headers.host).toBe(`localhost:${fake.port}`);
  });

  it("says so when Signalbox isn't running", async () => {
    const fake = await fakeServer(() => ok({}));
    const port = fake.port;
    await fake.close();
    const client = start({ SIGNALBOX_BRIDGE_URL: `http://127.0.0.1:${port}` });
    const answer = await client.call('list_chats', {});
    expect(answer.isError).toBe(true);
    expect(text(answer)).toMatch(new RegExp(`^Signalbox isn't answering at http://127\\.0\\.0\\.1:${port}`));
  });

  it('never goes through a proxy, even with NODE_USE_ENV_PROXY', async () => {
    const proxied: string[] = [];
    const proxy = http.createServer((req, res) => {
      proxied.push(`${req.method} ${req.url}`);
      res.end('{}');
    });
    proxy.on('connect', (req, socket) => {
      proxied.push(`CONNECT ${req.url}`);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      const fake = await signalbox(() => ok({ chats: [] }));
      const client = start({
        SIGNALBOX_BRIDGE_URL: fake.url,
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: proxyUrl,
        http_proxy: proxyUrl,
      });
      expect((await client.call('list_chats', {})).isError).toBeUndefined();
      expect(fake.seen).toHaveLength(1);
      expect(proxied).toEqual([]);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('stops a cancelled call and sends no response for it', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = await signalbox(async () => {
      await held;
      return ok({ items: [] });
    });
    const client = start({ SIGNALBOX_BRIDGE_URL: fake.url });
    await client.initialize();
    client.write(JSON.stringify({ jsonrpc: '2.0', id: 50, method: 'tools/call', params: { name: 'read_chat', arguments: { chat: 'paseo:x' } } }));
    await until(() => fake.seen.length === 1, 'the call to reach Signalbox');
    client.notify('notifications/cancelled', { requestId: 50, reason: 'user interrupted' });
    expect((await client.request('ping', undefined, 51)).result).toEqual({});
    await until(() => fake.seen[0]!.aborted, 'the wrapper to hang up');
    release();
    await sleep(100);
    expect(client.lines.some((line) => (JSON.parse(line) as Message).id === 50)).toBe(false);
  });

  it('answers malformed and unknown requests with JSON-RPC errors', async () => {
    const client = start();
    await client.initialize();

    expect((await client.request('resources/list')).error).toMatchObject({ code: -32601 });
    expect((await client.request('tools/call', { name: 'approve_everything', arguments: {} })).error).toMatchObject({
      code: -32602,
    });
    const badArgs = await client.call('list_chats', ['not', 'an', 'object']);
    expect(badArgs.isError).toBe(true);

    const parseError = client.response(null);
    client.write('{"jsonrpc": "2.0", "id": 7, "method": ');
    expect((await parseError).error).toMatchObject({ code: -32700 });

    const invalid = client.response(9);
    client.write(JSON.stringify({ jsonrpc: '2.0', id: 9 }));
    expect((await invalid).error).toMatchObject({ code: -32600 });

    // A batch gets one array back; the notification in it gets nothing.
    const first = client.response('b1');
    client.write(
      JSON.stringify([
        { jsonrpc: '2.0', id: 'b1', method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 'b2', method: 'tools/list' },
      ]),
    );
    await first;
    const batch = JSON.parse(client.lines.at(-1)!) as Message[];
    expect(batch.map((m) => m.id)).toEqual(['b1', 'b2']);
  });

  it('hangs up on Signalbox when the client goes away, so a held wait is dropped', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = await signalbox(async () => {
      await held;
      return ok({ from: 'paseo:x', kind: 'timed_out', status: 'working' });
    });
    const client = new Client({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, SIGNALBOX_BRIDGE_URL: fake.url }, cwd);
    try {
      client.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for_reply', arguments: { chat: 'paseo:x', timeout_seconds: 120 } } }));
      await until(() => fake.seen.length === 1, 'the wait to reach Signalbox');
      expect(await client.close()).toBe(0); // well before the wait would end
      await until(() => fake.seen[0]!.aborted, 'the wrapper to hang up');
      expect(client.lines).toEqual([]);
    } finally {
      release();
    }
  });

  it('exits when the client closes stdin', async () => {
    const client = new Client({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home }, cwd);
    await client.initialize();
    expect(await client.close()).toBe(0);
  });
});
