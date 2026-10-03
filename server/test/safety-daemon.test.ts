import { afterEach, expect, it, vi } from 'vitest';
import { createSafetyDaemon } from '../src/paseo/safety-daemon.js';

const fake = vi.hoisted(() => {
  function freshClient() {
    let disposed = false;
    return {
      connect: vi.fn(async () => { if (disposed) throw new Error('Client permanently disposed.'); }),
      close: vi.fn(async () => { disposed = true; }),
      getProvidersSnapshot: vi.fn(async () => ({ entries: [{ provider: 'demo-plugin' }] })),
      getDaemonConfig: vi.fn(async () => ({ config: { providers: { pi: { paseoTools: { disabledTools: ['update_agent'] } } } } })),
      reloadDaemonConfig: vi.fn(async () => ({ appliedPaths: ['agents.providers'], restartRequiredPaths: [], overrideControlledPaths: [] })),
    };
  }
  return { freshClient, createClient: vi.fn(freshClient), clients: [] as ReturnType<typeof freshClient>[] };
});
vi.mock('@getpaseo/client/internal/daemon-client', () => ({ DaemonClient: vi.fn(function () {
  const client = fake.createClient();
  fake.clients.push(client);
  return client;
}) }));
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
afterEach(() => { vi.clearAllMocks(); fake.createClient.mockReset().mockImplementation(fake.freshClient); fake.clients.splice(0); });

it('uses a fresh authenticated client for discovery, reload, effective config and later reconciliation after permanent disposal', async () => {
  const daemon = createSafetyDaemon('ws://127.0.0.1:8896', 'obviously-fake-paseo-password');
  expect(await daemon.providers()).toEqual(['demo-plugin']);
  expect(await daemon.reload()).toMatchObject({ appliedPaths: ['agents.providers'] });
  expect(await daemon.effectiveProviders()).toEqual({ pi: { paseoTools: { disabledTools: ['update_agent'] } } });
  expect(await daemon.providers()).toEqual(['demo-plugin']);
  expect(await daemon.reload()).toMatchObject({ appliedPaths: ['agents.providers'] });
  expect(await daemon.effectiveProviders()).toEqual({ pi: { paseoTools: { disabledTools: ['update_agent'] } } });
  expect(DaemonClient).toHaveBeenCalledTimes(6);
  for (const [options] of vi.mocked(DaemonClient).mock.calls) {
    expect(options).toMatchObject({ password: 'obviously-fake-paseo-password', url: 'ws://127.0.0.1:8896/ws', appVersion: '0.9.2', reconnect: { enabled: false } });
  }
  expect(new Set(fake.clients).size).toBe(6);
  for (const client of fake.clients) {
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    await expect(client.connect()).rejects.toThrow('permanently disposed');
  }
  expect(fake.clients[0]!.getProvidersSnapshot).toHaveBeenCalledOnce();
  expect(fake.clients[1]!.reloadDaemonConfig).toHaveBeenCalledOnce();
  expect(fake.clients[2]!.getDaemonConfig).toHaveBeenCalledOnce();
});

it('closes on authentication errors and timeouts, then recovers with fresh clients', async () => {
  const refused = fake.freshClient();
  refused.connect.mockRejectedValueOnce(new Error('obviously-fake-auth-refusal'));
  fake.createClient.mockReturnValueOnce(refused);
  const daemon = createSafetyDaemon('ws://127.0.0.1:8896');
  await expect(daemon.providers()).rejects.toThrow('auth-refusal');
  expect(refused.close).toHaveBeenCalledOnce();
  const stalled = fake.freshClient();
  stalled.reloadDaemonConfig.mockImplementationOnce(() => new Promise(() => {}));
  fake.createClient.mockReturnValueOnce(stalled);
  vi.useFakeTimers();
  try {
    const result = daemon.reload().then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toMatchObject({ message: expect.stringContaining('timed out') });
    expect(stalled.close).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
  expect(await daemon.providers()).toEqual(['demo-plugin']);
  expect(await daemon.reload()).toMatchObject({ appliedPaths: ['agents.providers'] });
  expect(DaemonClient).toHaveBeenCalledTimes(4);
  for (const client of fake.clients) expect(client.close).toHaveBeenCalledOnce();
});

it('closes failed effective-config reads and retries with a fresh authenticated client', async () => {
  const refused = fake.freshClient();
  refused.getDaemonConfig.mockRejectedValueOnce(new Error('obviously-fake-config-refusal'));
  fake.createClient.mockReturnValueOnce(refused);
  const daemon = createSafetyDaemon('ws://127.0.0.1:8896', 'obviously-fake-paseo-password');
  await expect(daemon.effectiveProviders()).rejects.toThrow('config-refusal');
  expect(refused.close).toHaveBeenCalledOnce();
  expect(await daemon.effectiveProviders()).toEqual({ pi: { paseoTools: { disabledTools: ['update_agent'] } } });
  expect(DaemonClient).toHaveBeenCalledTimes(2);
  for (const client of fake.clients) expect(client.close).toHaveBeenCalledOnce();
});
