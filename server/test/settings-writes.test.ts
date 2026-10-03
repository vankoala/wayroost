import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { BackgroundGate } from '../src/background.js';
import { Bridge } from '../src/bridge/service.js';
import { WorkerUpdatesSetting } from '../src/tasks/setting.js';
import { SafetyCommandsSetting } from '../src/hermes/safety.js';
import { DESKTOP_COOKIE, PHONE_COOKIE, TEST_DESKTOP, FakeHermes, FakePaseo, apiHeaders, makeApp, makeConfig, makeKeys, makeToken, postHeaders } from './helpers.js';
import { EventHub } from '../src/hub.js';

const apps: Array<Awaited<ReturnType<typeof makeApp>>['app']> = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

async function fixture() {
  const keys = await makeKeys();
  const token = await makeToken(keys);
  const config = makeConfig();
  const bridge = new Bridge({ background: new BackgroundGate('shadow'), sources: { hermes: new FakeHermes(), paseo: new FakePaseo() }, hub: new EventHub(),
    log: { info() {}, warn() {}, error() {} }, pollMs: 0 });
  const workerUpdates = new WorkerUpdatesSetting(config.stateDir);
  const safetyCommands = new SafetyCommandsSetting(config.stateDir);
  const app = await makeApp(keys, { configExtra: { stateDir: config.stateDir }, bridge, workerUpdates, safetyCommands });
  apps.push(app.app);
  const mutations = [vi.spyOn(bridge, 'setPaused'), vi.spyOn(workerUpdates, 'update'),
    vi.spyOn(safetyCommands, 'setEnabled'), vi.spyOn(app.paseo, 'setCloudAgentEnabled')];
  return { ...app, token, mutations };
}

const writes = [
  { url: '/api/bridge', body: { paused: true } },
  { url: '/api/worker-updates', body: { enabled: false } },
  { url: '/api/worker-updates', body: { defaultMinutes: 30 } },
  { url: '/api/safety-commands', body: { enabled: true } },
  { url: '/api/cloud-agents/codex', body: { enabled: false } },
];

it.each(writes)('requires a paired desktop for $url writes', async ({ url, body }) => {
  const t = await fixture();
  expect((await t.app.inject({ method: 'PUT', url, headers: postHeaders(t.token, { cookie: PHONE_COOKIE }), payload: body })).statusCode).toBe(403);
  for (const mutation of t.mutations) expect(mutation).not.toHaveBeenCalled();
  expect((await t.app.inject({ method: 'PUT', url, headers: postHeaders(t.token, { cookie: DESKTOP_COOKIE }), payload: body })).statusCode).toBe(200);
  expect(t.mutations.reduce((count, mutation) => count + mutation.mock.calls.length, 0)).toBe(1);
});

it.each(writes)('rechecks a desktop revoked while the $url body is pending', async ({ url, body }) => {
  const t = await fixture();
  let authenticated!: (id: string | undefined) => void;
  const signedIn = new Promise<string | undefined>(resolve => { authenticated = resolve; });
  const authenticate = t.devices!.authenticate.bind(t.devices);
  vi.spyOn(t.devices!, 'authenticate').mockImplementation(values => {
    const result = authenticate(values);
    authenticated(result?.device.id);
    return result;
  });
  const payload = new PassThrough();
  const response = t.app.inject({ method: 'PUT', url, headers: postHeaders(t.token, { cookie: DESKTOP_COOKIE }), payload });
  try {
    expect(await signedIn).toBe(TEST_DESKTOP.id);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/devices/${TEST_DESKTOP.id}`,
      headers: apiHeaders(t.token, { origin: t.config.publicOrigin }) })).statusCode).toBe(200);
  } finally { payload.end(JSON.stringify(body)); }
  expect((await response).statusCode).toBe(403);
  for (const mutation of t.mutations) expect(mutation).not.toHaveBeenCalled();
});
