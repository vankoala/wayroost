import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { demoMap } from './map-fixture.js';

const root = join(process.cwd(), 'gateway/.test-tmp');
await mkdir(root, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, 'cli-demo-'));
const socket = join(directory, 'admin.sock');
const config = join(directory, 'roles.json');
const map = demoMap();
for (const backend of Object.values(map.backends)) { backend.servedName = 'demo-cli-model'; backend.listenerUid = process.getuid!(); }
await writeFile(config, JSON.stringify(map), { mode: 0o600 });
let receivedModel: unknown;
const backend = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    receivedModel = JSON.parse(Buffer.concat(chunks).toString('utf8')).model;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"id":"demo-cli-result"}\n\ndata: [DONE]\n\n');
  });
});
await new Promise<void>(resolve => backend.listen(8899, '127.0.0.1', resolve));
const entry = process.argv[2] ? [process.argv[2]] : ['--import', 'tsx', 'gateway/src/index.ts'];
const child = spawn(process.execPath, [...entry, '--config', config, '--socket', socket, '--listen', 'main=8898',
  '--max-request-bytes', '4096'], {
  env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
});
const ended = once(child, 'exit');
let logs = '';
child.stdout.on('data', data => { logs += data; });
child.stderr.on('data', data => { logs += data; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('CLI exited before readiness.');
    try { ready = (await fetch('http://127.0.0.1:8898/v1/models')).status === 200; } catch {}
    if (ready) break;
    await delay(20);
  }
  assert(ready);
  const response = await fetch('http://127.0.0.1:8898/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'main', messages: [{ role: 'user', content: 'Demo CLI private prompt.' }], stream: true }),
  });
  assert.equal(await response.text(), 'data: {"id":"demo-cli-result"}\n\ndata: [DONE]\n\n');
  assert.equal(receivedModel, 'demo-cli-model');
  const oversize = await fetch('http://127.0.0.1:8898/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'main', messages: [{ role: 'user', content: 'x'.repeat(5000) }] }),
  });
  assert.equal(oversize.status, 413);
  child.kill('SIGTERM');
  const [code, signal] = await ended;
  assert.equal(code, 0); assert.equal(signal, null);
  await assert.rejects(stat(socket));
  assert(!logs.includes('Demo CLI private prompt.'));
  assert(logs.trim().split('\n').every(line => { const value = JSON.parse(line); return ['reload', 'request'].includes(value.event); }));
  process.stdout.write('PASS: CLI starts on 8898, rewrites to fake backend 8899, streams SSE, applies --max-request-bytes, logs metadata only, and exits cleanly on SIGTERM.\n');
} finally {
  if (child.exitCode === null) { child.kill('SIGTERM'); await ended; }
  await new Promise<void>(resolve => { backend.close(() => resolve()); backend.closeAllConnections(); });
  await rm(directory, { recursive: true, force: true });
}
