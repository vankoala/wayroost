import assert from 'node:assert/strict';
import { createServer, request, Agent } from 'node:http';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.getuid(), 0);
assert.equal(process.env.CI, 'true');
const systemctl = (...args) => execFileSync('systemctl', args, { encoding: 'utf8' }).trim();
const state = '/var/lib/private/wayroost-gateway';
const adminSocket = '/run/wayroost-gateway/admin.sock';
const root = '/usr/lib/wayroost-gateway';
const backendPort = 8894;
const credentials = new Map([
  ['example-main', 'obviously-fake-main-key'], ['example-coder', 'obviously-fake-coder-key'],
  ['example-fast', 'obviously-fake-fast-key'],
]);
const servedModels = new Map([
  ['example-main-model', credentials.get('example-main')], ['example-coder-model', credentials.get('example-coder')],
  ['example-fast-model', credentials.get('example-fast')],
]);
let calls = 0;
const backend = createServer((input, output) => {
  const chunks = [];
  input.on('data', chunk => chunks.push(chunk));
  input.on('end', () => {
    calls++;
    let status = 200; let body;
    if (input.method === 'GET') body = { data: [...servedModels.keys()].map(id => ({ id })) };
    else {
      try {
        const requestBody = JSON.parse(Buffer.concat(chunks).toString());
        if (!servedModels.has(requestBody.model)) status = 404;
        else {
          const key = servedModels.get(requestBody.model);
          if (input.headers.authorization !== (key ? `Bearer ${key}` : undefined)) status = 401;
        }
      } catch { status = 400; }
      body = status === 200 ? { choices: [{ message: { content: 'fake result' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }
        : { error: { message: status === 401 ? 'Authentication required' : 'Unsupported backend request' } };
    }
    output.writeHead(status, { 'content-type': 'application/json' });
    output.end(JSON.stringify(body));
  });
});
await new Promise(resolve => backend.listen(backendPort, '127.0.0.1', resolve));
const closeBackend = () => new Promise(resolve => { backend.close(resolve); backend.closeAllConnections(); });
const agent = new Agent({ keepAlive: true, maxSockets: 4 });

function call(path, { admin = false, method = 'GET', body, port = 18010, upload = false, pooled = agent, headers = {} } = {}) {
  let finish;
  const started = performance.now();
  const result = new Promise((resolve, reject) => {
    const encoded = body === undefined ? '' : JSON.stringify(body);
    const options = { path, method, agent: admin ? false : pooled, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded), ...headers },
      ...(admin ? { socketPath: adminSocket } : { hostname: '127.0.0.1', port }) };
    const client = request(options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString(), latencyMs: performance.now() - started }));
    });
    client.setTimeout(3000, () => client.destroy(new Error('Consumer deadline exceeded.')));
    client.on('error', reject);
    finish = () => client.end(upload ? encoded.slice(1) : encoded);
    if (upload) { client.flushHeaders(); client.write(encoded.slice(0, 1)); } else finish();
  });
  return { result, finish: () => finish() };
}
async function healthy() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await call('/healthz').result).status === 200) return; } catch {}
    await delay(100);
  }
  throw new Error('Gateway did not become healthy.');
}
async function waitNewPid(previous) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const current = systemctl('show', 'wayroost-gateway.service', '-p', 'MainPID', '--value');
    if (current !== '0' && current !== previous) { await healthy(); return; }
    await delay(50);
  }
  throw new Error('Gateway did not restart.');
}
async function repoint(backend) {
  const response = await call('/v1/roles/main', { admin: true, method: 'PUT', body: { backend } }).result;
  assert.equal(response.status, 200, response.body);
}
function bound() {
  const sockets = execFileSync('ss', ['-ltn'], { encoding: 'utf8' });
  for (const port of [18010, 18011, 18012]) assert.match(sockets, new RegExp(`127\\.0\\.0\\.1:${port}\\s`));
  assert.equal(systemctl('is-active', 'wayroost-gateway.socket'), 'active');
}

let foreign;
try {
  await mkdir(root, { recursive: true, mode: 0o755 });
  for (const name of ['index.js', 'seed.js']) await copyFile(`dist/gateway/${name}`, `${root}/${name}`);
  if (process.execPath !== '/usr/bin/node') await copyFile(process.execPath, '/usr/bin/node');
  const map = JSON.parse(await readFile('gateway/role-map.default.json', 'utf8'));
  for (const [id, backend] of Object.entries(map.backends)) { backend.baseUrl = `http://127.0.0.1:${backendPort}/v1`; backend.listenerUid = 0; backend.provider = id; }
  await writeFile(`${root}/role-map.default.json`, `${JSON.stringify(map)}\n`, { mode: 0o644 });
  const credentialRoot = `${root}/credentials`;
  const dropIn = '/etc/systemd/system/wayroost-gateway.service.d';
  await mkdir(credentialRoot, { mode: 0o700 }); await mkdir(dropIn, { recursive: true, mode: 0o755 });
  for (const [provider, key] of credentials) await writeFile(`${credentialRoot}/${provider}`, key, { mode: 0o600 });
  await writeFile(`${dropIn}/credentials.conf`, '[Service]\n' + [...credentials.keys()].map(provider => `LoadCredential=${provider}:${credentialRoot}/${provider}\n`).join(''), { mode: 0o644 });
  for (const name of ['service', 'socket']) await copyFile(`deploy/wayroost-gateway.${name}`, `/etc/systemd/system/wayroost-gateway.${name}`);
  execFileSync('systemd-analyze', ['verify', '/etc/systemd/system/wayroost-gateway.service', '/etc/systemd/system/wayroost-gateway.socket']);
  systemctl('daemon-reload'); systemctl('start', 'wayroost-gateway.socket', 'wayroost-gateway.service');
  await healthy(); bound();
  const unauthenticated = await call('/v1/chat/completions', { method: 'POST', port: backendPort, body: { model: 'example-main-model' } }).result;
  assert.equal(unauthenticated.status, 401);
  const unknown = await call('/v1/chat/completions', { method: 'POST', port: backendPort, body: { model: 'unknown-model' }, headers: { authorization: 'Bearer obviously-fake-main-key' } }).result;
  assert.equal(unknown.status, 404);
  for (const [id, role, port] of [['example-main', 'main', 18010], ['example-coder', 'coder', 18011], ['example-fast', 'fast', 18012]]) {
    if (role === 'main') await repoint(id);
    const response = await call('/v1/chat/completions', { method: 'POST', port, body: { model: role, messages: [{ role: 'user', content: 'fake input' }] }, headers: { authorization: 'Bearer obviously-fake-consumer-key' } }).result;
    assert.equal(response.status, 200, response.body);
  }
  console.log('PASS: authenticated packaged backends, served names and rejection of unknown models');
  const seeded = await stat(`${state}/role-map.json`);
  assert.notEqual(seeded.uid, 0); assert.equal(seeded.mode & 0o777, 0o600);
  await repoint('example-main'); systemctl('restart', 'wayroost-gateway.service'); await healthy();
  const models = JSON.parse((await call('/v1/models').result).body);
  assert.equal(models.data[0].context_length, 32768);
  assert.equal(JSON.parse(await readFile(`${state}/role-map.json`, 'utf8')).roles.main, 'example-main');
  console.log('PASS: dynamic-user seeding, resolved state path, repoint and restart');

  for (let attempt = 0; attempt < 7; attempt++) {
    const previous = systemctl('show', 'wayroost-gateway.service', '-p', 'MainPID', '--value');
    systemctl('kill', '--kill-whom=main', '--signal=KILL', 'wayroost-gateway.service');
    bound(); await waitNewPid(previous); bound();
  }
  assert.equal(systemctl('show', 'wayroost-gateway.service', '-p', 'StartLimitIntervalUSec', '--value'), '0');
  console.log('PASS: repeated crashes leave all role ports bound and the socket active');

  const body = { model: 'main', messages: [{ role: 'user', content: 'fake upload' }] };
  const warm = await call('/v1/chat/completions', { method: 'POST', body }).result;
  assert.equal(warm.headers.connection, 'close');
  const upload = call('/v1/chat/completions', { method: 'POST', body, upload: true });
  for (let attempt = 0; attempt < 30; attempt++) {
    const status = JSON.parse((await call('/v1/status', { admin: true }).result).body);
    if (status.roles.main.openConnections >= 1) break;
    await delay(10);
    if (attempt === 29) throw new Error('Upload was not counted from accept.');
  }
  const previous = systemctl('show', 'wayroost-gateway.service', '-p', 'MainPID', '--value');
  const drain = call('/v1/drain', { admin: true, method: 'POST' });
  const during = await call('/v1/chat/completions', { method: 'POST', body }).result;
  assert.equal(during.status, 200);
  assert.equal(systemctl('show', 'wayroost-gateway.service', '-p', 'MainPID', '--value'), previous);
  upload.finish(); assert.equal((await upload.result).status, 200);
  assert.equal(JSON.parse((await drain.result).body).status, 'drained');
  // New requests arrive while the old process exits; PID 1 holds their listening sockets.
  const after = await Promise.all(Array.from({ length: 8 }, () => call('/v1/chat/completions', { method: 'POST', body }).result));
  assert(after.every(value => value.status === 200 && value.headers.connection === 'close'));
  assert(after.every(value => value.latencyMs < 3000));
  await waitNewPid(previous); bound();
  console.log('PASS: pooled clients, incomplete upload and queued requests finish across drain-restart within 3 seconds');

  await closeBackend();
  const foreignScript = `const http=require('node:http');let bytes=0;const server=http.createServer((req,res)=>{process.stdout.write('REQUEST\\n');req.resume();res.end('unexpected')});server.on('connection',socket=>socket.on('data',data=>{bytes+=data.length;process.stdout.write('BYTES:'+data.length+'\\n')}));server.listen(${backendPort},'127.0.0.1',()=>process.stdout.write('READY\\n'));process.on('SIGTERM',()=>{server.close();server.closeAllConnections()});`;
  foreign = spawn('/usr/bin/node', ['-e', foreignScript], { uid: 65534, gid: 65534, stdio: ['ignore', 'pipe', 'pipe'] });
  let foreignOutput = '';
  foreign.stdout.on('data', data => { foreignOutput += data; });
  for (let attempt = 0; !foreignOutput.includes('READY'); attempt++) { assert(attempt < 100); await delay(20); }
  await assert.rejects(call('/v1/chat/completions', { method: 'POST', body }).result);
  await delay(100); assert.equal(foreignOutput, 'READY\n');
  console.log('PASS: another UID receives no HTTP bytes, credentials or request');
  const summary = JSON.parse((await call('/v1/usage/summary', { admin: true, method: 'POST', body: { windows: [{ id: 'today', since: 0 }] } }).result).body);
  assert.equal(summary.ok, true); assert(summary.windows[0].rows.some(row => row.errors >= 1)); assert(calls > 0);
  const status = JSON.parse((await call('/v1/status', { admin: true }).result).body);
  assert.equal(status.roles.main.health, 'owner_mismatch'); assert.equal(status.roles.main.backendPort, backendPort);
} finally {
  agent.destroy(); foreign?.kill();
  systemctl('stop', 'wayroost-gateway.service', 'wayroost-gateway.socket');
  if (backend.listening) await closeBackend();
}
