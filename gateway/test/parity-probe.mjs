import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const run = promisify(execFile);
const recorded = [];
const reservations = new Set();
const stop = new AbortController();
let directory;
let child;
let exited;
let backend;
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());

async function close(server) {
  if (!server.listening) return;
  const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}

async function free(port) {
  return await new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = available => { socket.destroy(); resolve(available); };
    socket.once('connect', () => finish(false));
    socket.once('error', error => finish(error.code === 'ECONNREFUSED'));
    socket.setTimeout(250, () => finish(false));
  });
}

async function allocate(server) {
  const start = Math.floor(Math.random() * 1000);
  for (let offset = 0; offset < 1000; offset++) {
    stop.signal.throwIfAborted();
    const port = 28000 + (start + offset) % 1000;
    if (!await free(port)) continue;
    try {
      await new Promise((resolve, reject) => {
        const failed = error => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', ready);
        server.listen(port, '127.0.0.1');
      });
      return port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('No free probe port in 28000–28999.');
}

async function http(options, body) {
  return await new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = request({ ...options, agent: false, signal: stop.signal,
      headers: { connection: 'close', ...(bytes ? { 'content-type': 'application/json' } : {}) },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    outgoing.once('error', reject);
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error('Probe request timed out.')));
    outgoing.end(bytes);
  });
}

async function stopChild() {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  let timer;
  try {
    await Promise.race([exited, new Promise((resolve, reject) => {
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Gateway did not stop cleanly.')); }, 5000);
    })]);
  } finally {
    clearTimeout(timer); await exited; child = undefined;
  }
}

async function probe(accepts, bundle, backendPort) {
  const ports = {};
  for (const role of ['main', 'coder', 'fast']) {
    const reservation = createServer(); reservations.add(reservation);
    ports[role] = await allocate(reservation);
  }
  const contract = { input: ['text'], toolCalling: true, thinkingLevels: false, maxOutputTokens: 4096, advertisedContext: 32768 };
  const map = {
    version: 2,
    contracts: { main: contract, coder: contract, fast: contract },
    backends: { example: { baseUrl: `http://127.0.0.1:${backendPort}/v1`, servedName: 'example-model', contextLength: 32768,
      maxOutputTokens: 4096, input: ['text'], toolCalling: true, thinkingLevels: false,
      acceptsReasoningEffort: accepts, listenerUid: process.getuid() } },
    profiles: { 'example/stub': { main: 'example', coder: 'example', fast: 'example' } },
    roles: { main: 'example', coder: 'example', fast: 'example' },
  };
  const config = join(directory, 'role-map.json'); const socketPath = join(directory, 'admin.sock');
  await writeFile(config, JSON.stringify(map), { mode: 0o600 });
  for (const reservation of reservations) await close(reservation);
  reservations.clear();
  const env = { ...process.env };
  for (const name of ['CREDENTIALS_DIRECTORY', 'LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES']) delete env[name];
  child = spawn(process.execPath, [bundle, '--config', config, '--socket', socketPath,
    ...Object.entries(ports).flatMap(([role, port]) => ['--listen', `${role}=${port}`]),
    '--health-timeout-ms', '1000', '--backend-timeout-ms', '3000'], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.resume();
  exited = once(child, 'exit');
  const deadline = Date.now() + 10000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Gateway exited before becoming ready.');
    try {
      const health = await http({ host: '127.0.0.1', port: ports.main, path: '/healthz' });
      assert.equal(health.status, 200); break;
    } catch (error) {
      if (Date.now() >= deadline || stop.signal.aborted) throw error;
      await delay(50, undefined, { signal: stop.signal });
    }
  }
  const admin = (path, body) => http({ socketPath, path, method: body === undefined ? 'GET' : 'POST' }, body);
  const initial = await admin('/v1/status');
  assert.equal(initial.status, 200);
  const before = initial.body.roles.main.adjustments.reasoning_effort_dropped;
  for (const effort of ['medium', 'none']) {
    const body = { model: 'main', messages: [{ role: 'system', content: 'Answer briefly.' }, { role: 'user', content: 'Reply OK.' }],
      reasoning_effort: effort, stream: false, temperature: 0.7,
      tools: [{ type: 'function', function: { name: 'example', description: 'An example tool.', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'auto' };
    const expected = { ...body, model: 'example-model' };
    if (!accepts) delete expected.reasoning_effort;
    const count = recorded.length;
    const answer = await http({ host: '127.0.0.1', port: ports.main, path: '/v1/chat/completions', method: 'POST' }, body);
    assert.equal(answer.status, 200); assert.equal(recorded.length, count + 1);
    assert.deepEqual(recorded.at(-1), expected);
    console.log(`PASS ${accepts ? 'forward' : 'drop'} reasoning_effort=${effort}: ${JSON.stringify(recorded.at(-1))}`);
  }
  const status = await admin('/v1/status'); const adjustments = accepts ? 0 : 2;
  assert.equal(status.body.roles.main.acceptsReasoningEffort, accepts);
  assert.equal(status.body.roles.main.contract.thinkingLevels, false);
  assert.equal(status.body.roles.main.adjustments.reasoning_effort_dropped, before + adjustments);
  const summary = await admin('/v1/usage/summary', { windows: [{ id: 'today', since: 0 }] });
  assert.equal(summary.status, 200);
  const rows = summary.body.windows[0].rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].adjustments?.reasoning_effort_dropped ?? 0, before + adjustments);
  console.log(`PASS ${accepts ? 'forward' : 'drop'} status and usage: reasoning_effort_dropped=${before + adjustments}`);
  await stopChild();
}

try {
  assert.equal(process.platform, 'linux', 'The gateway requires Linux.');
  const temporary = join(root, 'gateway/.test-tmp');
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  directory = await mkdtemp(join(temporary, 'parity-'));
  const bundle = join(directory, 'index.mjs');
  await run(join(root, 'node_modules/.bin/esbuild'), ['gateway/src/index.ts', '--bundle', '--platform=node', '--format=esm',
    `--outfile=${bundle}`, '--log-level=warning'], { cwd: root, signal: stop.signal });
  backend = createServer(async (incoming, response) => {
    try {
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      response.setHeader('content-type', 'application/json');
      if (incoming.method === 'GET' && incoming.url === '/v1/models') {
        response.end(JSON.stringify({ data: [{ id: 'example-model' }] })); return;
      }
      assert.equal(incoming.url, '/v1/chat/completions');
      recorded.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK.' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    } catch { response.writeHead(500); response.end('{}'); }
  });
  const backendPort = await allocate(backend);
  await probe(true, bundle, backendPort);
  await probe(false, bundle, backendPort);
  console.log('PASS request parity probe (loopback ports 28000–28999 only).');
} catch (error) {
  console.error(`FAIL request parity probe: ${error.message}`); process.exitCode = 1;
} finally {
  await stopChild().catch(error => { console.error(error.message); process.exitCode = 1; });
  for (const reservation of reservations) await close(reservation);
  if (backend) await close(backend);
  if (directory) await rm(directory, { recursive: true, force: true });
}
