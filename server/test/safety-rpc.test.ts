import { request, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { pendingWorkerApprovals } from '../../shared/safety.js';
import { SafetyHelperClient, startSafetyRpc } from '../src/paseo/safety-rpc.js';
import { WorkerApprovalsSetting, type SafetyDaemon } from '../src/paseo/safety-setting.js';
import { waitWithAbort } from '../src/paseo/abort.js';
import { withDeviceSignal } from '../src/security/device-signal.js';
import { apiHeaders, makeApp, makeKeys, makeToken, postHeaders, TEST_DESKTOP } from './helpers.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function path() {
  const root = mkdtempSync(join(tmpdir(), 'wayroost-safety-rpc-'));
  roots.push(root);
  return join(root, 'helper.sock');
}
function send(socketPath: string, route: string, body: string, key = 'obviously-fake-helper-key') {
  return new Promise<number>((resolve, reject) => {
    const req = request({ socketPath, path: route, method: 'PUT', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    req.on('error', reject);
    req.end(body);
  });
}

it('authenticates the fixed-target RPC, bounds writes, and returns only setting status', async () => {
  const socket = path();
  const setting = { status: vi.fn(async () => pendingWorkerApprovals()), setEnabled: vi.fn(async (enabled: boolean) => ({ ...pendingWorkerApprovals(), enabled })) };
  servers.push(await startSafetyRpc(socket, 'obviously-fake-helper-key', setting));
  expect(statSync(socket).mode & 0o777).toBe(0o660);
  expect(await send(socket, '/setting', '{"enabled":false}', 'obviously-fake-wrong-key')).toBe(401);
  expect(await send(socket, '/setting', '{"enabled":false,"path":"/home/me/other"}')).toBe(400);
  expect(await send(socket, '/execute', '{"enabled":false}')).toBe(404);
  expect(await send(socket, '/setting', 'x'.repeat(129))).toBe(413);
  expect(setting.setEnabled).not.toHaveBeenCalled();
  const client = new SafetyHelperClient(socket, 'obviously-fake-helper-key');
  expect(await client.status()).toEqual(pendingWorkerApprovals());
  expect(await client.setEnabled(false)).toMatchObject({ enabled: false });
  expect(setting.setEnabled).toHaveBeenCalledWith(false, expect.any(AbortSignal), expect.any(Function));
});

it('reports an unavailable helper accurately and refuses to pretend a write succeeded', async () => {
  const client = new SafetyHelperClient(path(), 'obviously-fake-helper-key');
  expect(await client.status()).toMatchObject({ enabled: true, application: 'pending', reload: 'pending' });
  await expect(client.setEnabled(false)).rejects.toMatchObject({ status: 424 });
});

it('marks a cached status unconfirmed after an ambiguous write and unavailable verification', async () => {
  const socket = path();
  let enabled = true;
  const setting = {
    status: vi.fn(async () => ({ ...pendingWorkerApprovals(), enabled, choiceConfirmed: true, config: 'written' as const, reload: 'applied' as const })),
    setEnabled: vi.fn(async (next: boolean) => { enabled = next; throw new Error('demo-lost-response'); }),
  };
  servers.push(await startSafetyRpc(socket, 'obviously-fake-helper-key', setting));
  const client = new SafetyHelperClient(socket, 'obviously-fake-helper-key');
  expect(await client.status()).toMatchObject({ enabled: true, config: 'written' });
  await expect(client.setEnabled(false)).rejects.toMatchObject({ status: 424 });
  expect(enabled).toBe(false);
  setting.status.mockRejectedValueOnce(new Error('demo-helper-unavailable'));
  expect(await client.status()).toMatchObject({ choiceConfirmed: false, config: 'pending', reload: 'pending', application: 'pending' });
  expect(await client.status()).toMatchObject({ enabled: false, config: 'written' });
});

it('keeps owner errors and secrets out of RPC and API responses', async () => {
  const socket = path();
  const setting = { status: vi.fn(async () => { throw new Error('/home/me/obviously-fake-secret'); }), setEnabled: vi.fn(async () => { throw new Error('obviously-fake-secret'); }) };
  servers.push(await startSafetyRpc(socket, 'obviously-fake-helper-key', setting));
  const client = new SafetyHelperClient(socket, 'obviously-fake-helper-key');
  expect(JSON.stringify(await client.status())).not.toContain('obviously-fake-secret');
  await expect(client.setEnabled(false)).rejects.toThrow('could not save');
});

it('authenticates and restricts cloud switches to a fixed provider id and boolean', async () => {
  const socket = path();
  const setting = {
    status: vi.fn(async () => pendingWorkerApprovals()),
    setEnabled: vi.fn(async () => pendingWorkerApprovals()),
    setCloudAgentEnabled: vi.fn(async () => {}),
  };
  servers.push(await startSafetyRpc(socket, 'obviously-fake-helper-key', setting));
  expect(await send(socket, '/cloud-agent', '{"id":"codex","enabled":false}', 'obviously-fake-wrong-key')).toBe(401);
  expect(await send(socket, '/cloud-agent', '{"id":"demo-plugin","enabled":false}')).toBe(400);
  expect(await send(socket, '/cloud-agent', '{"id":"codex","enabled":false,"path":"/home/me/other"}')).toBe(400);
  expect(await send(socket, '/cloud-agent', '{"id":"codex","enabled":"false"}')).toBe(400);
  expect(setting.setCloudAgentEnabled).not.toHaveBeenCalled();
  const client = new SafetyHelperClient(socket, 'obviously-fake-helper-key');
  await client.setCloudAgentEnabled('codex', false);
  expect(setting.setCloudAgentEnabled).toHaveBeenCalledWith('codex', false, expect.any(AbortSignal), expect.any(Function));
  setting.setCloudAgentEnabled.mockRejectedValueOnce(new Error('obviously-fake-secret'));
  await expect(client.setCloudAgentEnabled('codex', true)).rejects.toMatchObject({ status: 424 });
});

it.each(['discovery', 'queued setting', 'queued cloud'])('cancels writes during %s before disconnect without changing saved policy', async stage => {
  const socket = path();
  const root = dirname(socket);
  const configPath = join(root, 'paseo-test.json');
  const statePath = join(root, 'worker-approvals.json');
  writeFileSync(configPath, JSON.stringify({ agents: { providers: { pi: {} } } }));
  const daemon: SafetyDaemon = {
    providers: vi.fn(async () => ['pi']),
    effectiveProviders: vi.fn(async () => JSON.parse(readFileSync(configPath, 'utf8')).agents.providers),
    reload: vi.fn(async () => ({ appliedPaths: ['agents.providers'], restartRequiredPaths: [], overrideControlledPaths: [] })),
  };
  const setting = new WorkerApprovalsSetting(configPath, root, daemon);
  await setting.setEnabled(true);
  const beforeConfig = readFileSync(configPath);
  const beforeState = readFileSync(statePath);
  let release!: (providers: string[]) => void;
  const gate = new Promise<string[]>(resolve => { release = resolve; });
  vi.mocked(daemon.providers).mockImplementationOnce(() => gate);
  let finished!: () => void;
  const settled = new Promise<void>(resolve => { finished = resolve; });
  if (stage === 'queued cloud') {
    const original = setting.setCloudAgentEnabled.bind(setting);
    vi.spyOn(setting, 'setCloudAgentEnabled').mockImplementation((...args) => original(...args).finally(finished));
  } else {
    const original = setting.setEnabled.bind(setting);
    vi.spyOn(setting, 'setEnabled').mockImplementation((...args) => original(...args).finally(finished));
  }
  const server = await startSafetyRpc(socket, 'obviously-fake-helper-key', setting);
  servers.push(server);
  let disconnected = false;
  server.on('connection', socket => socket.once('close', () => { disconnected = true; }));
  const client = new SafetyHelperClient(socket, 'obviously-fake-helper-key');
  const controller = new AbortController();
  const transport = new AbortController();
  const blocker = stage === 'discovery' ? undefined : setting.reconcile();
  const result = withDeviceSignal(controller.signal, () => stage === 'queued cloud'
    ? client.setCloudAgentEnabled('codex', false, transport.signal) : client.setEnabled(false, transport.signal)).catch(error => error);
  try {
    await vi.waitFor(() => expect(daemon.providers).toHaveBeenCalledTimes(2));
    if (stage === 'queued cloud') await vi.waitFor(() => expect(setting.setCloudAgentEnabled).toHaveBeenCalled());
    else await vi.waitFor(() => expect(setting.setEnabled).toHaveBeenCalled());
    controller.abort();
    expect(disconnected).toBe(false);
    release(['pi']);
    expect(await result).toMatchObject({ status: 424 });
  } finally { release(['pi']); }
  await blocker;
  await settled;
  expect(readFileSync(configPath)).toEqual(beforeConfig);
  expect(readFileSync(statePath)).toEqual(beforeState);
  expect(await client.setEnabled(false)).toMatchObject({ enabled: false, config: 'written' });
});

it.each(['discovery', 'reload', 'cloud reload'])('acknowledges cancellation during %s before persisting device revocation', async stage => {
  const socket = path();
  const root = dirname(socket);
  const configPath = join(root, 'paseo-test.json');
  const statePath = join(root, 'worker-approvals.json');
  writeFileSync(configPath, JSON.stringify({ agents: { providers: { pi: {}, codex: { enabled: true } } } }));
  const daemon: SafetyDaemon = {
    providers: vi.fn(async () => ['pi', 'codex']),
    effectiveProviders: vi.fn(async () => JSON.parse(readFileSync(configPath, 'utf8')).agents.providers),
    reload: vi.fn(async () => ({ appliedPaths: ['agents.providers'], restartRequiredPaths: [], overrideControlledPaths: [] })),
  };
  const setting = new WorkerApprovalsSetting(configPath, root, daemon);
  await setting.setEnabled(true);
  servers.push(await startSafetyRpc(socket, 'obviously-fake-helper-key', setting));
  const client = new SafetyHelperClient(socket, 'obviously-fake-helper-key');
  const keys = await makeKeys();
  const token = await makeToken(keys);
  const { app, config, devices } = await makeApp(keys, { workerApprovals: client });
  roots.push(config.stateDir);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  if (stage === 'discovery') vi.mocked(daemon.providers).mockImplementationOnce(async () => { entered(); await gate; return ['pi', 'codex']; });
  else vi.mocked(daemon.reload).mockImplementationOnce(async () => {
    entered();
    await gate;
    return { appliedPaths: ['agents.providers'], restartRequiredPaths: [], overrideControlledPaths: [] };
  });
  const owner = devices!.signal(TEST_DESKTOP.id);
  const result = stage === 'cloud reload'
    ? withDeviceSignal(owner, () => client.setCloudAgentEnabled('codex', false)).catch(error => error)
    : withDeviceSignal(owner, () => client.setEnabled(false)).catch(error => error);
  try {
    await started;
    const beforeConfig = readFileSync(configPath);
    const beforeState = readFileSync(statePath);
    const cancel = client.cancelPending.bind(client);
    vi.spyOn(client, 'cancelPending').mockImplementation(signal => {
      const pending = cancel(signal);
      // Complete discovery while the cancellation message is still in transit.
      if (stage === 'discovery') release();
      expect(devices!.get(TEST_DESKTOP.id)).toBeDefined();
      return pending;
    });
    const revoked = await app.inject({ method: 'DELETE', url: `/api/devices/${TEST_DESKTOP.id}`, headers: apiHeaders(token, { origin: 'https://wayroost.example.com' }) });
    expect(revoked.statusCode).toBe(200);
    expect(devices!.get(TEST_DESKTOP.id)).toBeUndefined();
    expect(owner.aborted).toBe(true);
    expect(JSON.parse(readFileSync(join(config.stateDir, 'devices.json'), 'utf8')).devices).not.toContainEqual(expect.objectContaining({ id: TEST_DESKTOP.id }));
    release();
    expect(await result).toMatchObject({ status: 424 });
    // Drain uncancellable daemon replies and the helper's queue after revocation.
    await setting.status();
    expect(readFileSync(configPath)).toEqual(beforeConfig);
    expect(readFileSync(statePath)).toEqual(beforeState);
  } finally { release(); await result; await app.close(); }
});

it('keeps a pairing when the helper cannot acknowledge cancellation and releases the write barrier for retry', async () => {
  const socket = path();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const setting = {
    status: async () => pendingWorkerApprovals(),
    setEnabled: vi.fn(async (_enabled: boolean, signal?: AbortSignal, authorize?: () => Promise<void>) => {
      entered();
      await waitWithAbort(gate, signal);
      await authorize?.();
      return pendingWorkerApprovals();
    }),
  };
  const server = await startSafetyRpc(socket, 'obviously-fake-helper-key', setting);
  servers.push(server);
  const refuse = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    if (req.url === '/cancel') res.destroy();
  };
  server.on('request', refuse);
  const client = new SafetyHelperClient(socket, 'obviously-fake-helper-key');
  const keys = await makeKeys();
  const token = await makeToken(keys);
  const { app, config, devices } = await makeApp(keys, { workerApprovals: client });
  roots.push(config.stateDir);
  devices!.touch(TEST_DESKTOP.id);
  const before = readFileSync(join(config.stateDir, 'devices.json'));
  const signal = devices!.signal(TEST_DESKTOP.id);
  const result = withDeviceSignal(signal, () => client.setEnabled(false)).catch(error => error);
  try {
    await started;
    expect((await app.inject({ method: 'DELETE', url: `/api/devices/${TEST_DESKTOP.id}`, headers: apiHeaders(token, { origin: 'https://wayroost.example.com' }) })).statusCode).toBe(424);
    expect(devices!.get(TEST_DESKTOP.id)).toBeDefined();
    expect(signal.aborted).toBe(false);
    expect(readFileSync(join(config.stateDir, 'devices.json'))).toEqual(before);
    server.off('request', refuse);
    const unblock = await client.cancelPending(signal);
    await expect(withDeviceSignal(signal, () => client.setEnabled(false))).rejects.toMatchObject({ status: 424 });
    expect(setting.setEnabled).toHaveBeenCalledOnce();
    unblock();
    release();
    expect(await withDeviceSignal(signal, () => client.setEnabled(true))).toMatchObject({ enabled: true });
    expect((await app.inject({ method: 'DELETE', url: `/api/devices/${TEST_DESKTOP.id}`, headers: apiHeaders(token, { origin: 'https://wayroost.example.com' }) })).statusCode).toBe(200);
  } finally { server.off('request', refuse); release(); await result; await app.close(); }
});
