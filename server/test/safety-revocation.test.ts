import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { SafetyCommandsSetting } from '../src/hermes/safety.js';
import { pendingWorkerApprovals } from '../../shared/safety.js';
import { DESKTOP_COOKIE, PHONE_COOKIE, TEST_DESKTOP, TEST_PHONE, apiHeaders, makeApp, makeConfig, makeKeys, makeToken, postHeaders } from './helpers.js';

const apps: Array<Awaited<ReturnType<typeof makeApp>>['app']> = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

it.each([
  { url: '/api/worker-approvals', kind: 'desktop', enabled: false },
  { url: '/api/safety-commands', kind: 'desktop', enabled: true },
  { url: '/api/safety-commands', kind: 'phone', enabled: true },
])('refuses a delayed $kind Safety write to $url after revocation', async ({ url, kind, enabled }) => {
  const keys = await makeKeys();
  const token = await makeToken(keys);
  const config = makeConfig();
  const safetyCommands = new SafetyCommandsSetting(config.stateDir);
  const hermesWrite = vi.spyOn(safetyCommands, 'setEnabled');
  const workerApprovals = { status: vi.fn(async () => pendingWorkerApprovals()), setEnabled: vi.fn(async () => pendingWorkerApprovals()) };
  const ctx = await makeApp(keys, { configExtra: { stateDir: config.stateDir }, safetyCommands, workerApprovals });
  apps.push(ctx.app);
  const device = kind === 'desktop' ? TEST_DESKTOP : TEST_PHONE;
  let authenticated!: (id: string | undefined) => void;
  const signedIn = new Promise<string | undefined>(resolve => { authenticated = resolve; });
  const authenticate = ctx.devices!.authenticate.bind(ctx.devices);
  vi.spyOn(ctx.devices!, 'authenticate').mockImplementation(values => {
    const result = authenticate(values);
    authenticated(result?.device.id);
    return result;
  });
  const payload = new PassThrough();
  const response = ctx.app.inject({ method: 'PUT', url, headers: postHeaders(token, { cookie: kind === 'desktop' ? DESKTOP_COOKIE : PHONE_COOKIE }), payload });
  try {
    expect(await signedIn).toBe(device.id);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/devices/${device.id}`, headers: apiHeaders(token, { origin: config.publicOrigin }) })).statusCode).toBe(200);
  } finally {
    payload.end(JSON.stringify({ enabled }));
  }
  expect((await response).statusCode).toBe(403);
  expect(workerApprovals.setEnabled).not.toHaveBeenCalled();
  expect(hermesWrite).not.toHaveBeenCalled();
  expect(safetyCommands.enabled()).toBe(false);
});
